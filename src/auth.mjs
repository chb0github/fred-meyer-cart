import fs from "fs";
import http from "http";
import { exec } from "child_process";
import { getNetrcCredentials, getConfig, TOKEN_FILE } from "./config.mjs";

const TOKEN_ENDPOINT = "https://api.kroger.com/v1/connect/oauth2/token";
const AUTH_ENDPOINT = "https://api.kroger.com/v1/connect/oauth2/authorize";

let clientTokenCache = null;

function getAuthHeader() {
  const creds = getNetrcCredentials();
  if (!creds) {
    throw new Error(
      "Missing Kroger credentials in ~/.netrc for machine api.kroger.com"
    );
  }
  return "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
}

/**
 * Fetch a Client Credentials token (for public product search & locations)
 */
export async function getClientToken() {
  if (clientTokenCache && clientTokenCache.expiresAt > Date.now() + 60000) {
    return clientTokenCache.accessToken;
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": getAuthHeader()
    },
    body: "grant_type=client_credentials&scope=product.compact"
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to obtain client token (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  clientTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000
  };
  return clientTokenCache.accessToken;
}

/**
 * Save user tokens to disk
 */
function saveTokens(tokenData) {
  const record = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + (tokenData.expires_in - 60) * 1000,
    savedAt: new Date().toISOString()
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(record, null, 2), "utf-8");
  return record;
}

/**
 * Read user tokens from disk
 */
function readSavedTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Refresh user access token using refresh_token grant
 */
async function refreshCustomerToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": getAuthHeader()
    },
    body: params.toString()
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  return saveTokens(data);
}

/**
 * Perform interactive browser login flow for customer cart authorization
 */
export async function authenticateCustomer() {
  const creds = getNetrcCredentials();
  const config = getConfig();
  const redirectUri = new URL(config.redirectUri);
  const port = parseInt(redirectUri.port, 10) || 8000;

  const authUrl = `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(
    creds.clientId
  )}&response_type=code&redirect_uri=${encodeURIComponent(
    config.redirectUri
  )}&scope=${encodeURIComponent(config.scope)}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname === redirectUri.pathname) {
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h3>Authentication Failed</h3><p>${error}</p>`);
          server.close();
          return reject(new Error(`OAuth Error: ${error}`));
        }

        if (code) {
          try {
            const tokenParams = new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: config.redirectUri
            });

            const tokenRes = await fetch(TOKEN_ENDPOINT, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": getAuthHeader()
              },
              body: tokenParams.toString()
            });

            if (!tokenRes.ok) {
              const err = await tokenRes.text();
              res.writeHead(500, { "Content-Type": "text/html" });
              res.end(`<h3>Token Exchange Failed</h3><pre>${err}</pre>`);
              server.close();
              return reject(new Error(`Token exchange failed: ${err}`));
            }

            const tokenData = await tokenRes.json();
            const saved = saveTokens(tokenData);

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                  <h2 style="color: #2e7d32;">✓ Fred Meyer Authorization Successful!</h2>
                  <p>You can now close this tab and return to your terminal.</p>
                </body>
              </html>
            `);
            server.close();
            return resolve(saved.accessToken);
          } catch (err) {
            res.writeHead(500, { "Content-Type": "text/html" });
            res.end(`<h3>Error: ${err.message}</h3>`);
            server.close();
            return reject(err);
          }
        }
      }
    });

    server.listen(port, () => {
      console.log(`\n🔑 Authorizing Fred Meyer Cart Access...`);
      console.log(`If the browser did not open automatically, open this URL:`);
      console.log(`\x1b[36m${authUrl}\x1b[0m\n`);

      // Attempt to open default browser on macOS / Linux / Windows
      if (process.platform === "darwin") {
        exec(`open "${authUrl}"`);
      } else if (process.platform === "win32") {
        exec(`start "" "${authUrl}"`);
      } else {
        exec(`xdg-open "${authUrl}"`);
      }
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Returns a valid Customer Access Token (reading cache, refreshing, or prompting login)
 */
export async function getCustomerToken(interactive = true) {
  const saved = readSavedTokens();
  if (saved) {
    if (saved.expiresAt > Date.now()) {
      return saved.accessToken;
    }
    if (saved.refreshToken) {
      console.log("Refreshing customer access token...");
      const refreshed = await refreshCustomerToken(saved.refreshToken);
      if (refreshed) {
        return refreshed.accessToken;
      }
    }
  }

  if (!interactive) {
    throw new Error("Customer authentication required. Please run: fm auth");
  }

  return await authenticateCustomer();
}
