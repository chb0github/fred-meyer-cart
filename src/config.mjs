import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
export const LOCAL_NETRC_FILE = path.join(PROJECT_ROOT, ".netrc");
export const CONFIG_FILE = path.join(PROJECT_ROOT, ".config.json");
export const TOKEN_FILE = path.join(PROJECT_ROOT, ".tokens.json");

/**
 * Parses a .netrc format file for machine api.kroger.com
 */
function parseNetrcFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const regex = /machine\s+api\.kroger\.com\s+login\s+(\S+)\s+password\s+(\S+)/;
    const match = content.match(regex);
    if (match) {
      return {
        clientId: match[1],
        clientSecret: match[2]
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Reads credentials checking in order:
 * 1. Local project .netrc (fm/.netrc)
 * 2. User home .netrc (~/.netrc)
 * 3. Environment variables (KROGER_CLIENT_ID, KROGER_CLIENT_SECRET)
 */
export function getNetrcCredentials() {
  // 1. Check local project .netrc
  const localCreds = parseNetrcFile(LOCAL_NETRC_FILE);
  if (localCreds) return localCreds;

  // 2. Check user home ~/.netrc
  const userNetrcPath = path.join(os.homedir(), ".netrc");
  const homeCreds = parseNetrcFile(userNetrcPath);
  if (homeCreds) return homeCreds;

  // 3. Check environment variables
  if (process.env.KROGER_CLIENT_ID && process.env.KROGER_CLIENT_SECRET) {
    return {
      clientId: process.env.KROGER_CLIENT_ID,
      clientSecret: process.env.KROGER_CLIENT_SECRET
    };
  }

  return null;
}

/**
 * Loads configuration or sets defaults (Issaquah Fred Meyer #70100658)
 */
export function getConfig() {
  const defaults = {
    zipCode: "98029",
    locationId: "70100658",
    storeName: "Fred Meyer - Issaquah",
    storeAddress: "6100 E Lake Sammamish Pkwy Se, Issaquah, 98029",
    redirectUri: "http://localhost:8000/callback",
    scope: "cart.basic:write product.compact profile.compact"
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

/**
 * Saves updated configuration
 */
export function saveConfig(updates) {
  const current = getConfig();
  const next = { ...current, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
