#!/usr/bin/env node
/**
 * Fred Meyer Cart — MCP (Model Context Protocol) stdio server.
 *
 * Exposes the `fm` CLI functionality as MCP tools so LLM clients
 * (LM Studio, Claude Desktop, Cursor, etc.) can search live Fred Meyer
 * inventory, price shopping lists, and manage the online pickup/delivery cart.
 *
 * Transport : newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * stdout    : reserved for protocol messages ONLY — all diagnostics go to stderr.
 * No extra dependencies: uses only Node >= 18 builtins (global fetch, readline).
 *
 * Quick manual test:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0"}}}' \
 *     | node src/mcp-server.mjs
 */

import fs from "fs";
import path from "path";
import readline from "readline";

import { getConfig, getNetrcCredentials, PROJECT_ROOT, TOKEN_FILE } from "./config.mjs";
import { getCustomerToken } from "./auth.mjs";
import { searchLocations, searchProducts, getProductById, addToCart } from "./krogerApi.mjs";
import { parseShoppingList, parseSingleItem } from "./parser.mjs";
import { matchShoppingList } from "./matcher.mjs";
import { getStagedCart, addItemsToStagedCart, clearStagedCart } from "./stagedCart.mjs";

// ---------------------------------------------------------------------------
// stdout is the protocol channel — divert any stray console output to stderr.
// (auth.mjs logs via console.log while refreshing tokens; must not corrupt NDJSON.)
// ---------------------------------------------------------------------------
for (const method of ["log", "info", "debug"]) {
  console[method] = (...args) => {
    process.stderr.write(
      args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ") + "\n"
    );
  };
}

function safeStringify(value) {
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

const SERVER_INFO = { name: "fred-meyer-cart", version: "1.0.0" };
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (newline-delimited over stdio)
// ---------------------------------------------------------------------------
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  if (id !== undefined) send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// MCP tools/call result helpers
// ---------------------------------------------------------------------------
function okText(text) {
  return { content: [{ type: "text", text }] };
}

function errText(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(data, header = "") {
  const body = JSON.stringify(data, null, 2);
  return okText(header ? `${header}\n\n${body}` : body);
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors of CLI internals)
// ---------------------------------------------------------------------------

/**
 * Accepts "today", "tomorrow", "+3 days", day names ("friday"), or MM/DD[/YY].
 * Returns a "Wed, Sep 10, 2025"-style string, or the input unchanged.
 */
function parseScheduleDate(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();
  const now = new Date();

  if (str === "today") {
    return now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  if (str === "tomorrow") {
    const tmrw = new Date(now);
    tmrw.setDate(tmrw.getDate() + 1);
    return tmrw.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  const relDaysMatch = str.match(/^(?:\+)?(\d+)\s*(?:d|days?)?$/i) || str.match(/^in\s+(\d+)\s+days?$/i);
  if (relDaysMatch && !str.includes("/")) {
    const days = parseInt(relDaysMatch[1], 10);
    const target = new Date(now);
    target.setDate(target.getDate() + days);
    return target.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const cleanDay = str.replace(/^next\s+/, "");
  const targetDayIdx = daysOfWeek.indexOf(cleanDay);
  if (targetDayIdx !== -1) {
    const currentDayIdx = now.getDay();
    let diff = targetDayIdx - currentDayIdx;
    if (diff <= 0 || str.startsWith("next ")) diff += 7;
    const target = new Date(now);
    target.setDate(target.getDate() + diff);
    return target.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    const dateObj = new Date(year, month - 1, day);
    if (!isNaN(dateObj.getTime())) {
      return dateObj.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    }
  }

  return String(input).trim();
}

/**
 * Resolve a shopping-list argument that may be a file path (relative to the
 * client's cwd OR this project root) or inline list text. The MCP server's
 * working directory is not guaranteed, so we try both locations.
 */
function resolveListInput(input) {
  const s = String(input ?? "").trim();
  if (!s) return "";
  // Multi-line input (or something very long) is treated as inline text content.
  if (s.includes("\n") || s.length > 300) return s;
  if (fs.existsSync(s)) return path.resolve(s);
  const inProject = path.join(PROJECT_ROOT, s);
  if (fs.existsSync(inProject)) return inProject;
  // Not a file anywhere — let the parser treat it as inline text.
  return s;
}

/**
 * Turn matchShoppingList() results into a readable summary + totals.
 */
function summarizeMatches(results) {
  const lines = [];
  let estTotal = 0;
  let matchedCount = 0;

  results.forEach((r, i) => {
    const qty = r.item.quantity || 1;
    if (r.matched && r.selected) {
      matchedCount++;
      const price = parseFloat(r.selected.price);
      const hasPrice = !isNaN(price);
      const subtotal = hasPrice ? price * qty : null;
      if (subtotal != null) estTotal += subtotal;
      let line = `${i + 1}. ${qty}x ${r.selected.fullName || r.item.term}`;
      if (r.selected.size) line += ` (${r.selected.size})`;
      line += hasPrice ? ` — $${price.toFixed(2)} each, subtotal $${subtotal.toFixed(2)}` : " — price N/A";
      if (r.selected.productId) line += ` [ID: ${r.selected.productId}]`;
      lines.push(line);
      if (r.item.note) lines.push(`     ↳ note: "${r.item.note}"`);
    } else {
      let line = `${i + 1}. UNMATCHED: ${qty}x ${r.item.term}`;
      if (r.error) line += ` — error: ${r.error}`;
      lines.push(line);
    }
  });

  return { estTotal, matchedCount, totalItems: results.length, lines };
}

/**
 * Lazy-load checkout.mjs so a missing Playwright install does not crash the
 * whole server at startup — only the two browser-automation tools need it.
 */
let checkoutModulePromise = null;
async function loadCheckout() {
  if (!checkoutModulePromise) {
    checkoutModulePromise = import("./checkout.mjs").catch((err) => {
      checkoutModulePromise = null; // allow retry after `npm install`
      throw new Error(
        `Browser automation unavailable (${err.message}). To enable fm_checkout / remote cart clearing run:\n  cd ${PROJECT_ROOT}\n  npm install\n  npx playwright install webkit`
      );
    });
  }
  return checkoutModulePromise;
}

/** Human-friendly instruction for restoring customer auth. */
function authHint() {
  return (
    "Fred Meyer customer login is required (or the saved token has expired and could not be refreshed). " +
    `Run this in a terminal once, then retry:\n\n  node "${path.join(PROJECT_ROOT, "src", "cli.mjs")} auth-browser"`
  );
}

function credentialsHint() {
  return (
    "No Kroger API credentials found. Add one of:\n" +
    `1) A .netrc file at ${PROJECT_ROOT}/.netrc (or ~/.netrc) containing:\n` +
    "     machine api.kroger.com login <YOUR_CLIENT_ID> password <YOUR_CLIENT_SECRET>\n" +
    "2) Environment variables KROGER_CLIENT_ID and KROGER_CLIENT_SECRET."
  );
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "fm_search_products",
    description:
      "Search live Fred Meyer (Kroger) product inventory by keyword. Returns matching products with current price, size and stock level. Read-only — does not touch the cart.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product search term, e.g. 'burrata' or 'organic milk'" },
        limit: { type: "number", minimum: 1, maximum: 25, description: "Maximum results to return (default 6)" },
        locationId: { type: "string", description: "Kroger store ID override (defaults to the configured Fred Meyer Issaquah #70100658)" }
      },
      required: ["query"]
    },
    handler: async (args) => {
      const config = getConfig();
      const limit = Math.min(25, Math.max(1, parseInt(args.limit, 10) || 6));
      const products = await searchProducts({
        term: String(args.query),
        locationId: args.locationId || config.locationId,
        limit
      });
      if (!products.length) return okText(`No Fred Meyer products found for "${args.query}".`);
      const mapped = products.map((p) => {
        const d = p.items?.[0] || {};
        return {
          productId: p.productId || p.upc,
          brand: p.brand || null,
          description: p.description || null,
          price: d.price?.regular ?? d.price?.promo ?? null,
          onPromo: Boolean(d.price?.promo),
          size: d.size || null,
          stockLevel: d.inventory?.stockLevel || "IN_STOCK"
        };
      });
      return jsonResult(mapped, `Found ${mapped.length} product(s) matching "${args.query}" at Fred Meyer.`);
    }
  },

  {
    name: "fm_get_product",
    description:
      "Look up a single Fred Meyer / Kroger product by its exact Product ID (UPC). Returns live price, size and stock. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Kroger Product ID / UPC, e.g. '0001111085402'" },
        locationId: { type: "string", description: "Kroger store ID (defaults to the configured Fred Meyer Issaquah #70100658)" }
      },
      required: ["productId"]
    },
    handler: async (args) => {
      const config = getConfig();
      const product = await getProductById(String(args.productId), args.locationId || config.locationId);
      if (!product) return okText(`No live Fred Meyer product found for ID "${args.productId}". It may be delisted or unavailable at this store.`);
      const d = product.items?.[0] || {};
      return jsonResult(
        {
          productId: product.productId || product.upc,
          brand: product.brand || null,
          description: product.description || null,
          price: d.price?.regular ?? d.price?.promo ?? null,
          onPromo: Boolean(d.price?.promo),
          size: d.size || null,
          stockLevel: d.inventory?.stockLevel || "IN_STOCK"
        },
        `Product details for ${args.productId}:`
      );
    }
  },

  {
    name: "fm_search_locations",
    description:
      "Find Fred Meyer / Kroger store location IDs near a ZIP code. Use the returned locationId with other tools to target a different store. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        zipCode: { type: "string", description: "ZIP code to search near (default '98029', Issaquah WA)" },
        limit: { type: "number", minimum: 1, maximum: 20, description: "Maximum locations to return (default 5)" }
      }
    },
    handler: async (args) => {
      const zip = String(args.zipCode || "98029");
      const limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 5));
      const locations = await searchLocations({ zipCode: zip, chain: "FRED_MEYER", limit });
      if (!locations.length) return okText(`No Fred Meyer stores found near ${zip}.`);
      const mapped = locations.map((l) => ({
        locationId: String(l.id ?? l.locationId ?? ""),
        storeNumber: l.storeNumber ?? null,
        name: l.name || (l.storeNumber != null ? `Store #${l.storeNumber}` : null),
        address: [l.address1, l.city, l.state].filter(Boolean).join(", ") || null
      }));
      return jsonResult(mapped, `${mapped.length} Fred Meyer store(s) near ${zip}. Use "locationId" in other tools:`);
    }
  },

  {
    name: "fm_match_shopping_list",
    description:
      "PRICE A SHOPPING LIST WITHOUT ORDERING. Parses a list (file path such as 'sample_list.csv'/'sample_list.txt', or inline text with one item per line, e.g. 'milk\\n2 carrots\\nRigatoni x2') and fuzzy-matches every item to live Fred Meyer products. Returns each match with current price/subtotal, an estimated total, and any unmatched items. Read-only — never modifies the cart.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Path to a CSV/TXT shopping-list file (relative paths are also resolved against this project), OR inline text with one item per line" },
        preference: {
          type: "string",
          enum: ["store-brand", "organic", "name-brand", "lowest-price"],
          description: "Matching preference: favor store brands, organic (Simple Truth), name brands, or cheapest price"
        },
        locationId: { type: "string", description: "Kroger store ID override (defaults to Fred Meyer Issaquah #70100658)" }
      },
      required: ["list"]
    },
    handler: async (args) => {
      const listInput = resolveListInput(args.list);
      if (!listInput) return errText("Please provide a shopping list — either a file path or inline text with one item per line.");
      const items = parseShoppingList(listInput);
      if (!items.length) return errText(`No items could be parsed from the provided list.`);

      const config = getConfig();
      const locationId = args.locationId || config.locationId;
      const results = await matchShoppingList(items, locationId, { prefer: args.preference });
      const summary = summarizeMatches(results);

      const header = `Matched ${summary.matchedCount}/${summary.totalItems} items at Fred Meyer (${config.storeName}). Estimated total: $${summary.estTotal.toFixed(2)}.` +
        (args.preference ? ` Preference: ${args.preference}.` : "") +
        "\n\n" + summary.lines.join("\n") +
        "\n\nNothing was ordered. To push the matched items into your online cart, call fm_cart_add with the same list.";
      return okText(header);
    }
  },

  {
    name: "fm_cart_status",
    description:
      "Show the current staged Fred Meyer cart (items added via fm_cart_add in this project), with quantities, prices and total. Read-only.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const config = getConfig();
      const cart = getStagedCart();
      if (!cart.items || cart.items.length === 0) {
        return okText("Your Fred Meyer cart is empty. Add items with fm_cart_add (a file path or inline list).");
      }
      const results = cart.items.map((item) => ({
        item: { term: item.description || item.term, quantity: item.quantity || 1, note: item.note },
        selected: {
          productId: item.productId || item.upc,
          fullName: item.description || item.term,
          price: item.price,
          size: item.size
        },
        matched: true
      }));
      const summary = summarizeMatches(results);
      return okText(
        `Staged Fred Meyer ${cart.modality || "PICKUP"} cart (${config.storeName}, store ${cart.locationId || config.locationId}) — total $${summary.estTotal.toFixed(2)}:\n\n` +
          summary.lines.join("\n") +
          (cart.updatedAt ? `\n\nLast updated: ${new Date(cart.updatedAt).toLocaleString()}` : "")
      );
    }
  },

  {
    name: "fm_auth_status",
    description:
      "Check whether the Kroger API credentials and the Fred Meyer customer login (needed to modify the cart) are currently valid. Read-only, no network calls.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const creds = getNetrcCredentials();
      if (!creds) return errText(credentialsHint());

      let loginState = `NOT LOGGED IN — run in a terminal once:\n  node "${path.join(PROJECT_ROOT, "src", "cli.mjs")} auth-browser"`;
      try {
        const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
        if (saved.expiresAt > Date.now()) {
          loginState = `valid until ${new Date(saved.expiresAt).toLocaleString()}`;
        } else if (saved.refreshToken) {
          loginState = "expired, but a refresh token is stored — cart operations will auto-refresh it";
        } else {
          loginState = `EXPIRED and cannot be refreshed — re-run in a terminal:\n  node "${path.join(PROJECT_ROOT, "src", "cli.mjs")} auth-browser"`;
        }
      } catch {
        /* no token file yet */
      }

      return okText(`API credentials: present.\nCustomer login (cart.basic:write): ${loginState}`);
    }
  },

  {
    name: "fm_cart_add",
    description:
      "ADD ITEMS TO THE ONLINE FRED MEYER CART. Matches the given items against live inventory and pushes them into your authenticated Fred Meyer account cart (PICKUP or DELIVERY). Also updates the local staged cart. Requires a one-time browser login (see fm_auth_status). Tip: preview prices first with fm_match_shopping_list.",
    inputSchema: {
      type: "object",
      properties: {
        list: { type: "string", description: "Shopping list as a file path or inline text (one item per line)" },
        items: {
          type: "array",
          items: { type: "string" },
          description: 'Or an explicit array of items, e.g. ["2 gal milk", "burrata x1", "carrots (2)"]. Use either this or "list".'
        },
        preference: {
          type: "string",
          enum: ["store-brand", "organic", "name-brand", "lowest-price"],
          description: "Matching preference for ambiguous items"
        },
        modality: { type: "string", enum: ["PICKUP", "DELIVERY"], description: "Order type (default PICKUP)" },
        locationId: { type: "string", description: "Kroger store ID override (defaults to Fred Meyer Issaquah #70100658)" }
      }
    },
    handler: async (args) => {
      const config = getConfig();
      const locationId = args.locationId || config.locationId;
      const modality = String(args.modality || "PICKUP").toUpperCase() === "DELIVERY" ? "DELIVERY" : "PICKUP";

      let itemsToMatch;
      if (Array.isArray(args.items) && args.items.length > 0) {
        itemsToMatch = args.items.map((s) => parseSingleItem(String(s)));
      } else if (args.list) {
        const listInput = resolveListInput(args.list);
        if (!listInput) return errText("Please provide items — either an 'items' array or a 'list' file path / inline text.");
        itemsToMatch = parseShoppingList(listInput);
      } else {
        return errText('Nothing to add. Provide e.g. {"items": ["milk", "2 carrots"]} or {"list": "sample_list.csv"}.');
      }

      if (!itemsToMatch.length) return errText("No items could be parsed from the provided input.");

      const matchResults = await matchShoppingList(itemsToMatch, locationId, { prefer: args.preference });
      const summary = summarizeMatches(matchResults);

      const validItems = matchResults
        .filter((r) => r.matched && r.selected)
        .map((r) => ({
          upc: r.selected.productId || r.selected.upc,
          productId: r.selected.productId || r.selected.upc,
          description: r.selected.fullName,
          price: r.selected.price,
          size: r.selected.size,
          quantity: r.item.quantity,
          note: r.item.note,
          modality
        }));

      if (validItems.length === 0) {
        return errText(`No items matched Fred Meyer inventory.\n\n${summary.lines.join("\n")}`);
      }

      // Customer auth (never interactive here — stdin belongs to the MCP client).
      let customerToken;
      try {
        customerToken = await getCustomerToken(false);
      } catch (err) {
        return errText(`${err.message}\n\n${authHint()}`);
      }

      await addToCart(validItems, customerToken); // throws with API details on failure
      addItemsToStagedCart(validItems, locationId, modality);

      const header = `Added ${validItems.length} item(s) to your online Fred Meyer ${modality} cart (${config.storeName}). Total $${summary.estTotal.toFixed(2)}.\n\n` +
        summary.lines.join("\n");
      return okText(header);
    }
  },

  {
    name: "fm_clear_cart",
    description:
      "Clear the LOCAL staged Fred Meyer cart. With alsoEmptyOnline=true it additionally empties the ONLINE Fred Meyer cart via browser automation (requires Playwright/WebKit to be installed). Use with care — remote clearing cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        alsoEmptyOnline: {
          type: "boolean",
          description: "Also empty the online Fred Meyer cart through browser automation (default false)"
        }
      }
    },
    handler: async (args) => {
      clearStagedCart();
      if (args.alsoEmptyOnline !== true) {
        return okText(
          "Local staged cart cleared. The online Fred Meyer cart was NOT touched — remove items there via the app/website, or call this tool again with alsoEmptyOnline=true (requires Playwright)."
        );
      }
      const checkout = await loadCheckout();
      await checkout.emptyCartStandalone({ headless: true });
      return okText("Local staged cart cleared and online Fred Meyer cart emptied via browser automation.");
    }
  },

  {
    name: "fm_checkout",
    description:
      "Automate the Fred Meyer order review / slot reservation in a headless browser. SAFETY: dryRun defaults to TRUE, which captures a screenshot of the order-review page WITHOUT placing the order — show that path/screenshot to the user and only call again with dryRun=false once they confirm. Requires Playwright/WebKit installed (npm install && npx playwright install webkit) and items already in the online cart.",
    inputSchema: {
      type: "object",
      properties: {
        pickupDate: { type: "string", description: 'Pickup/delivery date: "today", "tomorrow", "friday", "+3 days" or MM/DD' },
        modality: { type: "string", enum: ["PICKUP", "DELIVERY"], description: "Order type (default PICKUP)" },
        dryRun: {
          type: "boolean",
          description: "Default true = review-page screenshot only, NO order placed. Set false to actually submit the order."
        }
      }
    },
    handler: async (args) => {
      const checkout = await loadCheckout();
      const scheduleDate = parseScheduleDate(args.pickupDate || null);
      const modality = String(args.modality || "PICKUP").toUpperCase() === "DELIVERY" ? "DELIVERY" : "PICKUP";
      const dryRun = args.dryRun !== false; // safe default: never place an order unless explicitly asked

      process.stderr.write(`[fm-mcp] Starting automated checkout (${modality}, ${scheduleDate || "next available slot"}, dryRun=${dryRun}) — this can take a few minutes...\n`);
      const res = await checkout.performAutomatedCheckout({ scheduleDate, modality, dryRun, headless: true });

      let text;
      if (dryRun) {
        text = `Dry-run complete — NO order was placed.${res?.screenshot ? `\nOrder-review screenshot saved to: ${res.screenshot}` : ""}\nShow this result to the user and call fm_checkout again with dryRun=false only after they confirm.`;
      } else {
        text = `Order submission flow completed (${modality}, ${scheduleDate || "next available slot"}).${res?.screenshot ? `\nReview screenshot saved to: ${res.screenshot}` : ""}`;
      }
      return okText(text);
    }
  }
];

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------
async function handleInitialize(params) {
  const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions:
      "Fred Meyer (Kroger) grocery automation. Read-only first: use fm_match_shopping_list to price a list and fm_search_products for lookups. Mutating: fm_cart_add pushes items into the user's online cart; fm_clear_cart clears it; fm_checkout defaults to DRY RUN — never pass dryRun=false without explicit user confirmation."
  };
}

async function handleMessage(msg) {
  const id = msg && "id" in msg ? msg.id : undefined;
  const method = msg?.method;
  const params = msg?.params || {};

  switch (method) {
    case "initialize":
      return sendResult(id, await handleInitialize(params));

    case "ping":
      return sendResult(id, {});

    case "tools/list":
      return sendResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      });

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        return sendError(id, -32602, `Unknown tool: ${params?.name}`);
      }
      try {
        // Tool-level failures are reported as isError results so the LLM can read them.
        const result = await tool.handler(params.arguments || {});
        return sendResult(id, result);
      } catch (err) {
        if (!getNetrcCredentials() && /credentials|\.netrc/i.test(err.message)) {
          return sendResult(id, errText(`${err.message}\n\n${credentialsHint()}`));
        }
        process.stderr.write(`[fm-mcp] Tool ${tool.name} failed: ${err.stack || err.message}\n`);
        return sendResult(id, errText(`Tool "${tool.name}" failed: ${err.message}`));
      }
    }

    default:
      // Unknown notifications (initialized, cancelled, ...) get no response.
      if (id === undefined) return;
      return sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio loop
// ---------------------------------------------------------------------------
process.stderr.write("[fm-mcp] Fred Meyer Cart MCP server ready (stdio). Tools: " + TOOLS.map((t) => t.name).join(", ") + "\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendError(null, -32700, "Parse error: invalid JSON on stdin");
    return;
  }
  handleMessage(msg).catch((err) => {
    process.stderr.write(`[fm-mcp] Handler crash: ${err.stack || err.message}\n`);
    if (msg?.id !== undefined) sendError(msg.id, -32603, `Internal error: ${err.message}`);
  });
});

rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
