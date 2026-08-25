#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";
import { getConfig, saveConfig, getNetrcCredentials, TOKEN_FILE } from "./config.mjs";
import { authenticateCustomer, getCustomerToken } from "./auth.mjs";
import { searchLocations, searchProducts, addToCart } from "./krogerApi.mjs";
import { parseShoppingList, parseSingleItem, serializeToCsv } from "./parser.mjs";
import { matchShoppingList, matchItem } from "./matcher.mjs";
import { openBrowserLogin, performAutomatedCheckout, emptyCartStandalone } from "./checkout.mjs";
import { getStagedCart, saveStagedCart, clearStagedCart, addItemsToStagedCart } from "./stagedCart.mjs";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  red: "\x1b[31m"
};

function log(msg = "") {
  process.stderr.write(msg + "\n");
}

function outputStdout(val = "") {
  process.stdout.write(val + "\n");
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

function parseScheduleDate(input) {
  if (!input) return null;
  const str = input.trim().toLowerCase();
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

  return input;
}

function printTable(results, scheduleDate, storeName, modality = "PICKUP") {
  const modeLabel = modality === "DELIVERY" ? "Delivery" : "Pickup";
  log(`\n${ANSI.bold}Fred Meyer ${modeLabel} Cart Preview:${ANSI.reset}`);
  log(` 🏬 ${ANSI.bold}Store:${ANSI.reset} ${storeName || "Fred Meyer - Issaquah"}`);
  if (scheduleDate) {
    log(` 📅 ${ANSI.bold}Target ${modeLabel} Date:${ANSI.reset} ${ANSI.cyan}${scheduleDate}${ANSI.reset}`);
  }
  log(` 🚚 ${ANSI.bold}Modality:${ANSI.reset} ${ANSI.yellow}${modality}${ANSI.reset}\n`);

  const headers = ["#", "Qty", "Price", "Subtotal", "Product Description", "Product ID", "Size"];
  const rows = results.map((r, idx) => {
    const qty = `${r.item.quantity}x`;
    const price = r.selected?.price ? `$${parseFloat(r.selected.price).toFixed(2)}` : (r.matched ? "$0.00" : "N/A");
    const subtotal =
      r.selected?.price && !isNaN(parseFloat(r.selected.price))
        ? `$${(parseFloat(r.selected.price) * r.item.quantity).toFixed(2)}`
        : (r.matched ? "$0.00" : "N/A");
    const desc = r.selected?.fullName
      ? r.selected.fullName.length > 38
        ? r.selected.fullName.substring(0, 35) + "..."
        : r.selected.fullName
      : (r.item.term.length > 38 ? r.item.term.substring(0, 35) + "..." : r.item.term);
    const pid = r.selected?.productId || "UNMATCHED";
    const size = r.selected?.size ? `(${r.selected.size})` : "";
    return { idx: idx + 1, qty, price, subtotal, desc, pid, size, note: r.item.note, matched: r.matched };
  });

  const colWidths = {
    idx: 3,
    qty: 5,
    price: 8,
    subtotal: 9,
    desc: 40,
    pid: 14,
    size: 14
  };

  const headerLine = ` ${ANSI.bold}${headers[0].padEnd(colWidths.idx)} ${headers[1].padEnd(colWidths.qty)} ${headers[2].padEnd(colWidths.price)} ${headers[3].padEnd(colWidths.subtotal)} ${headers[4].padEnd(colWidths.desc)} ${headers[5].padEnd(colWidths.pid)} ${headers[6]}${ANSI.reset}`;
  const separator = ` ${ANSI.dim}` + "─ ".repeat(48).trim() + `${ANSI.reset}`;

  log(headerLine);
  log(separator);

  let estTotal = 0;
  for (const r of rows) {
    const numPrice = parseFloat(r.subtotal.replace("$", ""));
    if (!isNaN(numPrice)) estTotal += numPrice;

    const rowColor = r.matched ? ANSI.reset : ANSI.red;
    log(
      ` ${rowColor}${String(r.idx).padStart(2)}   ${r.qty.padEnd(colWidths.qty)} ${r.price.padStart(6)}   ${r.subtotal.padStart(8)}  ${r.desc.padEnd(colWidths.desc)} ${r.pid.padEnd(colWidths.pid)} ${r.size}${ANSI.reset}`
    );
    if (r.note) {
      log(`     ${ANSI.dim}↳ Note: "${r.note}"${ANSI.reset}`);
    }
  }

  log(separator);
  log(
    ` ${ANSI.bold}Estimated Total:${ANSI.reset} ${ANSI.green}${ANSI.bold}$${estTotal.toFixed(2)}${ANSI.reset}  ${ANSI.dim}(${results.filter(r => r.matched).length}/${results.length} items matched)${ANSI.reset}\n`
  );

  return estTotal;
}

// -------------------------------------------------------------
// Command Handlers
// -------------------------------------------------------------

/**
 * fm cart status / show
 */
function cmdCartStatus() {
  const cart = getStagedCart();
  if (!cart.items || cart.items.length === 0) {
    log(`\n🛒 ${ANSI.bold}Your Fred Meyer cart is empty.${ANSI.reset}`);
    log(`   Run ${ANSI.cyan}fm cart add --list sample_list.csv${ANSI.reset} or ${ANSI.cyan}fm cart add "milk"${ANSI.reset} to add items.\n`);
    return;
  }

  const results = cart.items.map((item) => ({
    item: { term: item.term || item.description, quantity: item.quantity || 1, note: item.note },
    selected: {
      productId: item.productId || item.upc,
      fullName: item.description || item.term,
      price: item.price,
      size: item.size
    },
    matched: true
  }));

  printTable(results, null, "Fred Meyer - Issaquah", cart.modality || "PICKUP");
  log(`🕒 Staged: ${cart.updatedAt ? new Date(cart.updatedAt).toLocaleString() : "Recently"}\n`);
}

/**
 * fm cart add [--list <file>] ["<item>"]
 */
async function cmdCartAdd(options) {
  const config = getConfig();
  const locationId = options.store || config.defaultLocationId || "70100658";
  const modality = (options.modality || (options.delivery ? "DELIVERY" : "PICKUP")).toUpperCase();

  let itemsToMatch = [];

  if (options.list) {
    const listPath = path.resolve(options.list);
    if (!fs.existsSync(listPath)) {
      log(`${ANSI.red}Error: File not found: ${listPath}${ANSI.reset}`);
      process.exit(1);
    }
    log(`🏬 Loading list from ${ANSI.bold}${path.basename(listPath)}${ANSI.reset} at Fred Meyer - Issaquah...`);
    itemsToMatch = parseShoppingList(listPath);
  } else if (options.itemString) {
    log(`🔍 Parsing item: "${options.itemString}"...`);
    itemsToMatch = [parseSingleItem(options.itemString)];
  } else {
    log(`${ANSI.red}Error: Please specify items to add. Example: fm cart add --list sample_list.csv or fm cart add "2 gal milk"${ANSI.reset}`);
    process.exit(1);
  }

  const matchResults = await matchShoppingList(itemsToMatch, locationId, {
    prefer: options.prefer,
    onProgress: (idx, total, item, sel) => {
      const pid = sel ? sel.productId : "???";
      process.stderr.write(`   Matching [${idx}/${total}]: ${item.term.padEnd(25)} [ID: ${pid}]\r`);
    }
  });
  log("");

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
    log(`${ANSI.red}No matching items found to add.${ANSI.reset}`);
    return;
  }

  printTable(matchResults, null, "Fred Meyer - Issaquah", modality);

  // Push to remote Kroger API
  log(`🚀 Pushing ${validItems.length} items to Fred Meyer online ${modality} cart...`);
  const customerToken = await getCustomerToken(true);
  await addToCart(validItems, customerToken);
  log(`${ANSI.green}✓ Success! Added ${validItems.length} items to online cart.${ANSI.reset}`);

  // Save to local staged state
  addItemsToStagedCart(validItems, locationId, modality);
  log(`${ANSI.cyan}✓ Staged in local cart state (~/.config/fm/staged_cart.json).${ANSI.reset}\n`);
}

/**
 * fm cart clear / empty
 */
async function cmdCartClear(options) {
  clearStagedCart();
  log(`🧹 Local cart state cleared.`);
  log(`🚀 Clearing online Fred Meyer cart via browser automation...`);
  await emptyCartStandalone({ headless: !options.headed });
}

/**
 * fm cart checkout [options]
 */
async function cmdCartCheckout(options) {
  const scheduleDate = parseScheduleDate(options.pickup || options.deliveryDate);
  const modality = (options.modality || (options.delivery ? "DELIVERY" : "PICKUP")).toUpperCase();

  // If a list was provided with checkout, add it first!
  if (options.list) {
    await cmdCartAdd(options);
  }

  log(`🤖 Running automated checkout (${modality}, ${scheduleDate || "next available"})...`);
  const res = await performAutomatedCheckout({
    scheduleDate,
    modality,
    dryRun: options.dryRun,
    headless: !options.headed
  });

  if (res && res.screenshot) {
    outputStdout(res.screenshot);
  }
}

/**
 * fm list show [file]
 */
async function cmdListShow(filePath) {
  const target = path.resolve(filePath || "sample_list.csv");
  if (!fs.existsSync(target)) {
    log(`${ANSI.red}File not found: ${target}${ANSI.reset}`);
    process.exit(1);
  }
  const items = parseShoppingList(target);
  if (items.length === 0) {
    log(`\n📋 ${ANSI.bold}Shopping list ${path.basename(target)} is empty.${ANSI.reset}\n`);
    return;
  }
  const matchResults = await matchShoppingList(items, "70100658", {
    onProgress: (idx, total, item, sel) => {
      const pid = sel ? sel.productId : "???";
      process.stderr.write(`   Loading [${idx}/${total}]: ${item.term.padEnd(25)} [ID: ${pid}]\r`);
    }
  });
  log("");
  printTable(matchResults, null, "Fred Meyer - Issaquah", "PICKUP");
}

/**
 * fm list add "<item>" [file]
 */
function cmdListAdd(itemStr, filePath) {
  const target = path.resolve(filePath || "sample_list.csv");
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, "item,quantity,notes,productId,price,size\n", "utf-8");
  }
  const parsed = parseSingleItem(itemStr);
  const line = `"${parsed.term.replace(/"/g, '""')}",${parsed.quantity},"${(parsed.note || "").replace(/"/g, '""')}","","",""\n`;
  fs.appendFileSync(target, line, "utf-8");
  log(`✓ Added "${itemStr}" to ${target}`);
}

/**
 * fm list clear [file]
 */
function cmdListClear(filePath) {
  const target = path.resolve(filePath || "sample_list.csv");
  fs.writeFileSync(target, "item,quantity,notes,productId,price,size\n", "utf-8");
  log(`✓ Cleared shopping list: ${target}`);
}

// -------------------------------------------------------------
// CLI Argument Parsing
// -------------------------------------------------------------

function parseCliArgs(rawArgs) {
  const options = {
    command: null,
    list: null,
    itemString: null,
    pickup: null,
    delivery: false,
    deliveryDate: null,
    modality: "PICKUP",
    checkout: false,
    headed: false,
    dryRun: false,
    store: null,
    prefer: null,
    budget: null,
    zip: "98029"
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "cart") {
      const sub = rawArgs[++i];
      if (sub === "status" || sub === "show") options.command = "cart-status";
      else if (sub === "add") options.command = "cart-add";
      else if (sub === "clear" || sub === "empty") options.command = "cart-clear";
      else if (sub === "checkout") options.command = "cart-checkout";
      else {
        options.command = "cart-status";
        i--;
      }
    } else if (arg === "list") {
      const sub = rawArgs[++i];
      if (sub === "show" || sub === "status") options.command = "list-show";
      else if (sub === "add") options.command = "list-add";
      else if (sub === "clear" || sub === "empty" || sub === "reset") options.command = "list-clear";
      else {
        options.command = "list-show";
        if (sub && !sub.startsWith("-")) options.list = sub;
      }
    } else if (arg === "--list" || arg === "-l") {
      options.list = rawArgs[++i];
    } else if (arg.startsWith("--list=")) {
      options.list = arg.split("=")[1];
    } else if (arg === "--pickup" || arg === "-p") {
      options.pickup = rawArgs[++i];
    } else if (arg.startsWith("--pickup=")) {
      options.pickup = arg.split("=")[1];
    } else if (arg === "--delivery") {
      options.delivery = true;
      options.modality = "DELIVERY";
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-")) {
        options.deliveryDate = rawArgs[++i];
      }
    } else if (arg === "--checkout" || arg === "-c") {
      options.checkout = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--dry-run" || arg === "-d") {
      options.dryRun = true;
    } else if (arg === "--store" || arg === "-s") {
      options.store = rawArgs[++i];
    } else if (["auth", "auth-browser", "help"].includes(arg)) {
      options.command = arg;
    } else if (!arg.startsWith("-")) {
      if (!options.itemString && (options.command === "cart-add" || options.command === "list-add")) {
        options.itemString = arg;
      } else if (!options.list && arg.endsWith(".csv")) {
        options.list = arg;
      }
    }
  }

  return options;
}

// -------------------------------------------------------------
// Main Entrypoint
// -------------------------------------------------------------

async function main() {
  const creds = getNetrcCredentials();
  if (!creds) {
    log(`${ANSI.red}Error: No credentials found in .netrc for machine api.kroger.com${ANSI.reset}`);
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const options = parseCliArgs(rawArgs);

  if (options.command === "cart-status") {
    cmdCartStatus();
    return;
  }
  if (options.command === "cart-add") {
    await cmdCartAdd(options);
    return;
  }
  if (options.command === "cart-clear") {
    await cmdCartClear(options);
    return;
  }
  if (options.command === "cart-checkout" || options.checkout) {
    await cmdCartCheckout(options);
    return;
  }
  if (options.command === "list-show") {
    await cmdListShow(options.list);
    return;
  }
  if (options.command === "list-add") {
    cmdListAdd(options.itemString, options.list);
    return;
  }
  if (options.command === "list-clear") {
    cmdListClear(options.list);
    return;
  }
  if (options.command === "auth-browser") {
    await openBrowserLogin();
    return;
  }
  if (options.command === "help" || rawArgs.length === 0) {
    log(`
${ANSI.bold}Fred Meyer Cart Automation CLI (fm)${ANSI.reset}

${ANSI.bold}Git-Style Cart Commands:${ANSI.reset}
  ${ANSI.cyan}fm cart status${ANSI.reset}                  View current items & total in staged cart (like git status)
  ${ANSI.cyan}fm cart add --list <file>${ANSI.reset}       Match & add all items from CSV list to cart
  ${ANSI.cyan}fm cart add "<item>"${ANSI.reset}            Add an ad-hoc single item to cart (e.g. "2 gal milk")
  ${ANSI.cyan}fm cart clear${ANSI.reset}                   Empty and purge items from online and local cart
  ${ANSI.cyan}fm cart checkout [options]${ANSI.reset}      Automate slot reservation & order review

${ANSI.bold}List Management Commands:${ANSI.reset}
  ${ANSI.cyan}fm list show [file]${ANSI.reset}             Display local CSV list with live pricing & matching
  ${ANSI.cyan}fm list add "<item>" [file]${ANSI.reset}     Append a new item to local CSV list
  ${ANSI.cyan}fm list clear [file]${ANSI.reset}            Reset CSV list back to clean template

${ANSI.bold}Checkout Options:${ANSI.reset}
  ${ANSI.cyan}--pickup <date>, -p <date>${ANSI.reset}     Schedule pickup date (e.g. tomorrow, friday, 09/10)
  ${ANSI.cyan}--delivery <date>${ANSI.reset}              Switch modality to Delivery
  ${ANSI.cyan}--dry-run, -d${ANSI.reset}                  Capture review screenshot without placing order
  ${ANSI.cyan}--headed${ANSI.reset}                       Run browser visually instead of headless mode

${ANSI.bold}Piping & Shell Examples:${ANSI.reset}
  ${ANSI.dim}fm cart checkout --pickup tomorrow --dry-run | xargs open${ANSI.reset}
  ${ANSI.dim}open $(fm cart checkout --pickup friday --dry-run)${ANSI.reset}
`);
    return;
  }

  // Fallback for one-shot flags (fm --list sample_list.csv --pickup tomorrow --checkout --dry-run)
  if (options.list) {
    if (options.checkout) {
      await cmdCartCheckout(options);
    } else {
      await cmdCartAdd(options);
    }
  }
}

main().catch((err) => {
  log(`\n${ANSI.red}Error: ${err.message}${ANSI.reset}`);
  process.exit(1);
});
