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

/**
 * All informational logging goes to stderr so stdout remains clean for piping (e.g. | xargs open)
 */
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

/**
 * Flexible date parser for relative terms ('today', 'tomorrow', 'friday', '+2d', 'in 3 days')
 * and absolute date formats ('09/10', '09/10/2026', '2026-09-10')
 */
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

  // Handle +Nd or "in N days" (e.g. "+2d", "in 3 days")
  const relDaysMatch = str.match(/^(?:\+)?(\d+)\s*(?:d|days?)?$/i) || str.match(/^in\s+(\d+)\s+days?$/i);
  if (relDaysMatch && !str.includes("/")) {
    const days = parseInt(relDaysMatch[1], 10);
    const target = new Date(now);
    target.setDate(target.getDate() + days);
    return target.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  // Handle weekdays: monday, tuesday, friday, next monday, etc.
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

  // Match MM/DD or MM-DD or MM/DD/YYYY
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

  return input.trim();
}

function printTable(results, scheduleDate = null, storeName = null, modality = "PICKUP") {
  const modeLabel = modality === "DELIVERY" ? "Delivery" : "Pickup";
  log(`\n${ANSI.bold}Fred Meyer ${modeLabel} Cart Preview:${ANSI.reset}`);
  if (storeName) {
    log(` 🏬 ${ANSI.dim}Store:${ANSI.reset} ${ANSI.cyan}${storeName}${ANSI.reset}`);
  }
  if (scheduleDate) {
    log(` 📅 ${ANSI.dim}Target ${modeLabel} Date:${ANSI.reset} ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
  }
  log(` 🚚 ${ANSI.dim}Modality:${ANSI.reset} ${ANSI.yellow}${modality}${ANSI.reset}`);
  log();
  log(
    ` ${ANSI.dim}#   Qty  Price    Subtotal  Product Description                     Product ID     Size${ANSI.reset}`
  );
  log(` ${ANSI.dim}─`.repeat(96) + ANSI.reset);

  let estTotal = 0;
  results.forEach((res, i) => {
    const num = String(i + 1).padStart(2);
    const qty = String(res.item.quantity).padStart(2);

    if (res.matched && res.selected) {
      const p = res.selected;
      const priceVal = parseFloat(p.price) || 0;
      const subtotal = priceVal * res.item.quantity;
      estTotal += subtotal;

      const priceStr = `$${(priceVal).toFixed(2)}`.padStart(7);
      const subtotalStr = `$${subtotal.toFixed(2)}`.padStart(8);
      const name = p.fullName.slice(0, 38).padEnd(38);
      const prodId = `${ANSI.cyan}${p.productId.padEnd(14)}${ANSI.reset}`;
      const size = p.size ? `(${p.size})` : "";

      log(
        ` ${ANSI.bold}${num}${ANSI.reset}  ${ANSI.cyan}${qty}x${ANSI.reset} ${priceStr}  ${ANSI.green}${subtotalStr}${ANSI.reset}  ${name}  ${prodId} ${ANSI.dim}${size}${ANSI.reset}`
      );
      if (res.item.note) {
        log(`     ${ANSI.dim}↳ Note: "${res.item.note}"${ANSI.reset}`);
      }
    } else {
      log(
        ` ${ANSI.bold}${num}${ANSI.reset}  ${ANSI.yellow}${qty}x${ANSI.reset}    --         --     ${ANSI.red}✗ "${res.item.term}" (No product found)${ANSI.reset}`
      );
    }
  });

  log(` ${ANSI.dim}─`.repeat(96) + ANSI.reset);
  log(
    ` ${ANSI.bold}Estimated Total:${ANSI.reset} ${ANSI.green}${ANSI.bold}$${estTotal.toFixed(2)}${ANSI.reset}  ${ANSI.dim}(${results.filter(r => r.matched).length}/${results.length} items matched)${ANSI.reset}\n`
  );

  return estTotal;
}

function outputJson(results, storeName, scheduleDate, modality, estTotal) {
  const output = {
    store: storeName,
    modality,
    scheduleDate: scheduleDate || null,
    totalEstimated: parseFloat(estTotal.toFixed(2)),
    matchedCount: results.filter((r) => r.matched).length,
    totalItems: results.length,
    items: results.map((r) => ({
      item: r.item.term,
      quantity: r.item.quantity,
      note: r.item.note || null,
      matched: r.matched,
      productId: r.selected?.productId || null,
      description: r.selected?.fullName || null,
      size: r.selected?.size || null,
      unitPrice: r.selected?.price ? parseFloat(r.selected.price) : null,
      subtotal: r.selected?.price ? parseFloat((parseFloat(r.selected.price) * r.item.quantity).toFixed(2)) : null
    }))
  };
  outputStdout(JSON.stringify(output, null, 2));
}

// -------------------------------------------------------------
// Interactive Mode Loop
// -------------------------------------------------------------

async function runInteractiveMode(initialResults, filePath, locationId, scheduleDate = null, storeName = null, modality = "PICKUP") {
  let results = [...initialResults];

  while (true) {
    printTable(results, scheduleDate, storeName, modality);

    const modeLabel = modality === "DELIVERY" ? "Delivery" : "Pickup";
    log(`${ANSI.bold}Actions:${ANSI.reset}`);
    log(`  ${ANSI.green}[P]${ANSI.reset} Push cart to Fred Meyer ${modeLabel}`);
    log(`  ${ANSI.cyan}[C]${ANSI.reset} Push cart & Run Automated Headless Checkout`);
    log(`  ${ANSI.cyan}[E]${ANSI.reset} Edit quantity / change name (fuzzy match) / swap product`);
    log(`  ${ANSI.cyan}[A]${ANSI.reset} Add a new item`);
    log(`  ${ANSI.yellow}[D]${ANSI.reset} Delete an item`);
    log(`  ${ANSI.yellow}[M]${ANSI.reset} Toggle Modality (${modality === "PICKUP" ? "switch to DELIVERY" : "switch to PICKUP"})`);
    log(`  ${ANSI.magenta}[S]${ANSI.reset} Save current list & Product IDs to CSV`);
    log(`  ${ANSI.dim}[Q] Quit without submitting${ANSI.reset}`);

    const choice = (await askQuestion(`\nChoose action [P/c/e/a/d/m/s/q]: `)).toUpperCase();

    if (choice === "M") {
      modality = modality === "PICKUP" ? "DELIVERY" : "PICKUP";
      log(`\n${ANSI.green}✓ Switched modality to ${modality}${ANSI.reset}`);
      continue;
    }

    if (choice === "P" || choice === "C" || choice === "") {
      const validItems = results
        .filter((r) => r.matched && r.selected)
        .map((r) => ({
          upc: r.selected.productId || r.selected.upc,
          quantity: r.item.quantity,
          modality
        }));

      if (validItems.length === 0) {
        log(`\n${ANSI.red}No matched items to add to cart.${ANSI.reset}\n`);
        continue;
      }

      log(`\n📦 Authenticating & sending items to Fred Meyer (${modality})...`);
      const customerToken = await getCustomerToken(true);
      await addToCart(validItems, customerToken);

      log(
        `\n${ANSI.green}${ANSI.bold}🎉 Success! Added ${validItems.length} items to your Fred Meyer ${modeLabel} cart!${ANSI.reset}`
      );

      if (choice === "C") {
        log("\n🚀 Starting Automated Playwright Checkout...");
        try {
          const checkoutRes = await performAutomatedCheckout({ scheduleDate, modality, dryRun: false });
          if (checkoutRes && checkoutRes.screenshot) {
            outputStdout(checkoutRes.screenshot);
          }
        } catch (err) {
          log(`${ANSI.red}Checkout error: ${err.message}${ANSI.reset}`);
        }
      } else {
        if (scheduleDate) {
          log(`📅 Target ${modeLabel} Date: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
        }
        log(
          `👉 Next Step: Open ${ANSI.cyan}https://www.fredmeyer.com/cart${ANSI.reset} to choose your ${modeLabel.toLowerCase()} window.\n`
        );
        outputStdout("https://www.fredmeyer.com/cart");
      }
      break;
    }

    if (choice === "E") {
      const itemNumStr = await askQuestion(`Enter item # to edit (1-${results.length}): `);
      const idx = parseInt(itemNumStr, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= results.length) {
        log("Invalid item number.");
        continue;
      }

      const current = results[idx];
      log(`\nEditing Item #${idx + 1}: "${current.item.term}" (Current ID: ${current.selected?.productId || "None"})`);

      const newName = await askQuestion(`Change product name/query (press Enter to keep "${current.item.term}"): `);
      if (newName.trim() !== "") {
        log(`Fuzzy matching "${newName}" against Fred Meyer inventory...`);
        const tempItem = parseSingleItem(newName);
        tempItem.quantity = current.item.quantity;
        const rematch = await matchItem(tempItem, locationId);
        if (rematch.matched) {
          results[idx] = rematch;
          log(`${ANSI.green}✓ Fuzzy matched: ${rematch.selected.fullName} ($${rematch.selected.price})${ANSI.reset}`);
          continue;
        } else {
          log(`${ANSI.red}No product found. Keeping original.${ANSI.reset}`);
        }
      }

      const newQtyStr = await askQuestion(`New quantity (press Enter to keep ${current.item.quantity}): `);
      if (newQtyStr.trim() !== "") {
        const newQty = parseInt(newQtyStr, 10);
        if (!isNaN(newQty) && newQty > 0) {
          current.item.quantity = newQty;
        }
      }

      if (current.candidates && current.candidates.length > 1) {
        log(`\nAvailable alternatives from Fred Meyer:`);
        current.candidates.forEach((c, cIdx) => {
          const isSel = c.productId === current.selected?.productId ? ` ${ANSI.green}★ [SELECTED]${ANSI.reset}` : "";
          const score = Math.round((c.fuzzyScore || 0) * 100);
          log(
            `  ${cIdx + 1}. [ID: ${ANSI.cyan}${c.productId}${ANSI.reset}] ${c.fullName} (${c.size}) - $${c.price || "N/A"} ${ANSI.dim}(Score: ${score}%)${ANSI.reset}${isSel}`
          );
        });

        const swapChoice = await askQuestion(
          `Select alternative (1-${current.candidates.length}), or "S" to search fresh query, or Enter to keep: `
        );
        const cNum = parseInt(swapChoice, 10);
        if (!isNaN(cNum) && cNum >= 1 && cNum <= current.candidates.length) {
          current.selected = current.candidates[cNum - 1];
          current.matched = true;
        } else if (swapChoice.toUpperCase() === "S") {
          const customQuery = await askQuestion(`Enter new search term: `);
          if (customQuery) {
            const tempItem = parseSingleItem(customQuery);
            tempItem.quantity = current.item.quantity;
            const rematch = await matchItem(tempItem, locationId);
            if (rematch.matched) {
              results[idx] = rematch;
            } else {
              log(`${ANSI.red}No products found for "${customQuery}".${ANSI.reset}`);
            }
          }
        }
      }
      continue;
    }

    if (choice === "A") {
      const newItemText = await askQuestion(`Enter item to add (e.g. "Sourdough bread x2" or "2 avocados"): `);
      if (newItemText.trim()) {
        const parsed = parseSingleItem(newItemText);
        log(`Fuzzy matching "${parsed.searchQuery}" at Fred Meyer...`);
        const matched = await matchItem(parsed, locationId);
        results.push(matched);
        if (matched.matched) {
          log(`${ANSI.green}✓ Added ${matched.selected.fullName} (ID: ${matched.selected.productId})${ANSI.reset}`);
        } else {
          log(`${ANSI.yellow}! Added item, but no matching Fred Meyer product found.${ANSI.reset}`);
        }
      }
      continue;
    }

    if (choice === "D") {
      const itemNumStr = await askQuestion(`Enter item # to delete (1-${results.length}): `);
      const idx = parseInt(itemNumStr, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < results.length) {
        const removed = results.splice(idx, 1);
        log(`${ANSI.yellow}✓ Removed ${removed[0]?.item?.term}${ANSI.reset}`);
      }
      continue;
    }

    if (choice === "S") {
      const targetCsv = filePath.endsWith(".csv") ? filePath : filePath.replace(/\.[^.]+$/, "") + ".csv";
      const csvData = serializeToCsv(results);
      fs.writeFileSync(targetCsv, csvData, "utf-8");
      log(`\n${ANSI.green}✓ Saved list & Product IDs to ${targetCsv}${ANSI.reset}\n`);
      continue;
    }

    if (choice === "Q") {
      log("\nExited without modifying cart.\n");
      break;
    }
  }
}

// -------------------------------------------------------------
// Core Command Execution
// -------------------------------------------------------------

async function cmdOrder(filePath, options = {}) {
  const config = getConfig();
  let locationId = config.locationId;
  let storeName = config.storeName;

  if (options.store) {
    if (options.store.match(/^\d{5}$/)) {
      const locs = await searchLocations({ zipCode: options.store, chain: null, limit: 1 });
      if (locs.length > 0) {
        locationId = locs[0].locationId;
        storeName = locs[0].name;
      }
    } else {
      locationId = options.store;
      storeName = `Store #${options.store}`;
    }
  }

  let defaultFile = "sample_list.csv";
  if (!fs.existsSync(defaultFile) && fs.existsSync("sample_list.txt")) {
    defaultFile = "sample_list.txt";
  }

  const targetFile = filePath || defaultFile;
  const resolved = path.resolve(targetFile);

  if (!fs.existsSync(resolved)) {
    log(`${ANSI.red}Error: Shopping list file not found: ${resolved}${ANSI.reset}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const parsed = parseShoppingList(content, resolved);
  const modality = (options.modality || (options.delivery ? "DELIVERY" : "PICKUP")).toUpperCase();
  const scheduleDate = parseScheduleDate(options.pickup || options.deliveryDate);

  if (options.format !== "json") {
    log(`\n🏬 Loading list from ${ANSI.bold}${path.basename(resolved)}${ANSI.reset} at ${ANSI.cyan}${storeName}${ANSI.reset}...`);
    if (scheduleDate) {
      log(`📅 Target ${modality === "DELIVERY" ? "Delivery" : "Pickup"} Date: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
    }
    if (options.prefer) {
      log(`🏷️  Brand Preference: ${ANSI.yellow}${options.prefer}${ANSI.reset}`);
    }
  }

  const results = await matchShoppingList(
    parsed,
    locationId,
    { prefer: options.prefer },
    options.format === "json"
      ? null
      : (curr, total, item) => {
          const idHint = item.productId ? ` [ID: ${item.productId}]` : "";
          process.stderr.write(`\r   Matching [${curr}/${total}]: ${item.searchQuery.slice(0, 25).padEnd(25)}${idHint}`);
        }
  );

  if (options.format !== "json") {
    process.stderr.write("\r" + " ".repeat(60) + "\r");
  }

  const estTotal = results.reduce((acc, r) => {
    if (r.matched && r.selected) {
      return acc + (parseFloat(r.selected.price) || 0) * r.item.quantity;
    }
    return acc;
  }, 0);

  if (options.budget && estTotal > options.budget) {
    log(
      `\n${ANSI.yellow}⚠️  Budget Alert: Estimated total $${estTotal.toFixed(2)} exceeds budget threshold of $${options.budget.toFixed(2)}${ANSI.reset}`
    );
  }

  if (options.format === "json") {
    outputJson(results, storeName, scheduleDate, modality, estTotal);
    return;
  }

  if (options.sync) {
    const targetCsv = resolved.endsWith(".csv") ? resolved : resolved.replace(/\.[^.]+$/, "") + ".csv";
    fs.writeFileSync(targetCsv, serializeToCsv(results), "utf-8");
    log(`${ANSI.green}✓ Synced Product IDs to ${targetCsv}${ANSI.reset}`);
    outputStdout(targetCsv);
    return;
  }

  const isNonInteractive = options.nonInteractive || options.yes || options.dryRun || Boolean((options.pickup || options.deliveryDate) && !options.interactive);

  if (isNonInteractive) {
    printTable(results, scheduleDate, storeName, modality);

    if (options.dryRun && !options.checkout) {
      log(`${ANSI.yellow}🔍 Dry Run complete: Cart was not modified.${ANSI.reset}\n`);
      return;
    }

    const validItems = results
      .filter((r) => r.matched && r.selected)
      .map((r) => ({
        upc: r.selected.productId || r.selected.upc,
        quantity: r.item.quantity,
        modality
      }));

    if (validItems.length === 0) {
      log(`${ANSI.red}✗ No valid items found to add to cart.${ANSI.reset}`);
      process.exit(1);
    }

    log(`🚀 Automated mode: Submitting ${validItems.length} items to Fred Meyer ${modality} Cart...`);
    const customerToken = await getCustomerToken(false);
    await addToCart(validItems, customerToken);

    log(`\n${ANSI.green}${ANSI.bold}✓ Success! ${validItems.length} items added to Fred Meyer ${modality} Cart.${ANSI.reset}`);

    // If --checkout is requested, run Playwright automated checkout
    if (options.checkout) {
      log(`\n🤖 Launching Playwright to complete automated checkout...`);
      const checkoutRes = await performAutomatedCheckout({
        scheduleDate,
        modality,
        dryRun: options.dryRun,
        headless: !options.headed
      });

      if (checkoutRes && checkoutRes.screenshot) {
        // Output ONLY the image path on stdout for piping: fm ... | xargs open
        outputStdout(checkoutRes.screenshot);
      }
    } else {
      if (scheduleDate) {
        log(`📅 Scheduled for ${modality === "DELIVERY" ? "Delivery" : "Pickup"} on: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
      }
      log(`👉 Complete checkout at: ${ANSI.cyan}https://www.fredmeyer.com/cart${ANSI.reset}\n`);
      outputStdout("https://www.fredmeyer.com/cart");
    }
  } else {
    await runInteractiveMode(results, resolved, locationId, scheduleDate, storeName, modality);
  }
}

async function cmdStore(zipArg) {
  const config = getConfig();
  const zip = zipArg || config.zipCode || "98029";
  log(`\n🔍 Searching stores near ZIP \x1b[1m${zip}\x1b[0m...\n`);

  const locations = await searchLocations({ zipCode: zip, chain: null, limit: 10 });
  if (locations.length === 0) {
    log(`No stores found near ${zip}.`);
    return;
  }

  locations.forEach((loc, idx) => {
    const isCurrent = loc.locationId === config.locationId ? ` ${ANSI.green}★ [CURRENT]${ANSI.reset}` : "";
    log(
      `${ANSI.bold}${idx + 1}. [${loc.chain}] ${loc.name}${ANSI.reset}${isCurrent}`
    );
    log(`   ID: ${ANSI.cyan}${loc.locationId}${ANSI.reset} | ${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.zipCode}`);
  });

  const choice = await askQuestion(
    `\nSelect store number (1-${locations.length}) to set as default, or press Enter to keep current: `
  );
  const num = parseInt(choice, 10);
  if (!isNaN(num) && num >= 1 && num <= locations.length) {
    const selected = locations[num - 1];
    saveConfig({
      zipCode: zip,
      locationId: selected.locationId,
      storeName: selected.name,
      storeAddress: `${selected.address.addressLine1}, ${selected.address.city}, ${selected.address.zipCode}`
    });
    log(`\n${ANSI.green}✓ Saved default store: ${selected.name} (${selected.locationId})${ANSI.reset}\n`);
  }
}

async function cmdAuth() {
  log(`\n${ANSI.bold}Fred Meyer API Customer Account Authorization${ANSI.reset}`);
  log("Connects your Fred Meyer account to authorize adding items to your cart via API.\n");
  try {
    await authenticateCustomer();
    log(`\n${ANSI.green}✓ API Authorization complete! Saved tokens to .tokens.json${ANSI.reset}\n`);
  } catch (err) {
    log(`\n${ANSI.red}✗ Authorization failed: ${err.message}${ANSI.reset}\n`);
  }
}

async function cmdSearch(query, locationId = null) {
  if (!query) {
    log("Usage: fm search <product name>");
    return;
  }
  const config = getConfig();
  const store = locationId || config.locationId;
  log(`\n🔍 Searching "${query}" at ${ANSI.bold}${config.storeName}${ANSI.reset}...\n`);

  const products = await searchProducts({ term: query, locationId: store, limit: 6 });
  if (products.length === 0) {
    log("No matching products found.");
    return;
  }

  products.forEach((prod, idx) => {
    const details = prod.items?.[0] || {};
    const price = details.price?.regular ? `$${details.price.regular}` : "Price N/A";
    const size = details.size ? ` (${details.size})` : "";
    const prodId = prod.productId || prod.upc;
    log(
      `${ANSI.bold}${idx + 1}. [ID: ${ANSI.cyan}${prodId}${ANSI.reset}] ${prod.brand ? prod.brand + " " : ""}${prod.description}${size}${ANSI.reset}`
    );
    log(`   Price: ${ANSI.green}${price}${ANSI.reset} | Stock: ${details.inventory?.stockLevel || "IN_STOCK"}\n`);
  });
}

function parseCliArgs(rawArgs) {
  const options = {
    command: null,
    list: null,
    pickup: null,
    delivery: false,
    deliveryDate: null,
    modality: null,
    store: null,
    prefer: null,
    budget: null,
    dryRun: false,
    sync: false,
    checkout: false,
    headed: false,
    format: "table",
    interactive: false,
    nonInteractive: false,
    yes: false,
    searchQuery: null,
    zip: null
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--list" || arg === "-l") {
      options.list = rawArgs[++i];
    } else if (arg.startsWith("--list=")) {
      options.list = arg.split("=")[1];
    } else if (arg === "--pickup" || arg === "-p") {
      options.pickup = rawArgs[++i];
    } else if (arg.startsWith("--pickup=")) {
      options.pickup = arg.split("=")[1];
    } else if (arg === "--delivery" || arg === "--deliver") {
      options.delivery = true;
      options.modality = "DELIVERY";
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-")) {
        options.deliveryDate = rawArgs[++i];
      }
    } else if (arg.startsWith("--delivery=")) {
      options.delivery = true;
      options.modality = "DELIVERY";
      options.deliveryDate = arg.split("=")[1];
    } else if (arg === "--checkout" || arg === "-c") {
      options.checkout = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--store" || arg === "-s") {
      options.store = rawArgs[++i];
    } else if (arg.startsWith("--store=")) {
      options.store = arg.split("=")[1];
    } else if (arg === "--prefer") {
      options.prefer = rawArgs[++i];
    } else if (arg.startsWith("--prefer=")) {
      options.prefer = arg.split("=")[1];
    } else if (arg === "--budget" || arg === "-b") {
      options.budget = parseFloat(rawArgs[++i]);
    } else if (arg.startsWith("--budget=")) {
      options.budget = parseFloat(arg.split("=")[1]);
    } else if (arg === "--format" || arg === "-f") {
      options.format = rawArgs[++i];
    } else if (arg.startsWith("--format=")) {
      options.format = arg.split("=")[1];
    } else if (arg === "--dry-run" || arg === "-d") {
      options.dryRun = true;
    } else if (arg === "--sync") {
      options.sync = true;
    } else if (arg === "-i" || arg === "--interactive") {
      options.interactive = true;
    } else if (arg === "-y" || arg === "--yes" || arg === "--non-interactive") {
      options.nonInteractive = true;
      options.yes = true;
    } else if (arg === "--clear-tokens") {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      log("✓ Cleared local token cache.");
      process.exit(0);
    } else if (arg === "--empty-cart" || arg === "--clear-cart") {
      options.command = "empty-cart";
    } else if (arg === "--clear-list" || arg === "--empty-list") {
      options.command = "clear-list";
      if (rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-")) {
        options.list = rawArgs[++i];
      }
    } else if (["auth", "auth-browser", "checkout", "empty-cart", "clear-cart", "empty", "clear-list", "empty-list", "sync", "store", "search", "help"].includes(arg)) {
      options.command = (arg === "clear-cart" || arg === "empty") ? "empty-cart" : (arg === "empty-list" ? "clear-list" : arg);
      if (arg === "search") {
        options.searchQuery = rawArgs.slice(i + 1).join(" ");
        break;
      }
      if (arg === "store") {
        options.zip = rawArgs[i + 1];
        break;
      }
      if ((arg === "sync" || arg === "clear-list" || arg === "empty-list") && rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-")) {
        options.list = rawArgs[++i];
      }
    } else if (!arg.startsWith("-") && !options.list) {
      options.list = arg;
    }
  }

  return options;
}

function cmdClearList(targetFile = "sample_list.csv") {
  const filePath = path.resolve(targetFile || "sample_list.csv");
  const header = "item,quantity,notes,productId,price,size\n";
  fs.writeFileSync(filePath, header, "utf-8");
  log(`✓ Cleared grocery shopping list: ${filePath}`);
}

async function main() {
  const creds = getNetrcCredentials();
  if (!creds) {
    log(`${ANSI.red}Error: No credentials found in .netrc for machine api.kroger.com${ANSI.reset}`);
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const options = parseCliArgs(rawArgs);

  if (options.command === "auth") {
    await cmdAuth();
    return;
  }
  if (options.command === "auth-browser") {
    await openBrowserLogin();
    return;
  }
  if (options.command === "clear-list") {
    cmdClearList(options.list);
    return;
  }
  if (options.command === "empty-cart") {
    await emptyCartStandalone({ headless: !options.headed });
    return;
  }
  if (options.command === "checkout") {
    const res = await performAutomatedCheckout({
      scheduleDate: parseScheduleDate(options.pickup || options.deliveryDate),
      modality: (options.modality || (options.delivery ? "DELIVERY" : "PICKUP")).toUpperCase(),
      dryRun: options.dryRun,
      headless: !options.headed
    });
    if (res && res.screenshot) {
      outputStdout(res.screenshot);
    }
    return;
  }
  if (options.command === "sync") {
    await cmdOrder(options.list, { sync: true, dryRun: true, format: "table" });
    return;
  }
  if (options.command === "store") {
    await cmdStore(options.zip);
    return;
  }
  if (options.command === "search") {
    await cmdSearch(options.searchQuery, options.store);
    return;
  }
  if (options.command === "help") {
    log(`
${ANSI.bold}Fred Meyer (Kroger) Cart Automation CLI (fm)${ANSI.reset}

${ANSI.bold}Usage:${ANSI.reset}
  fm [options]
  fm --list <file.csv> --pickup <date> --checkout [options]
  fm --list <file.csv> --delivery <date> --checkout [options]
  fm empty-cart
  fm clear-list [file.csv]

${ANSI.bold}Hands-Off Automation Options:${ANSI.reset}
  ${ANSI.cyan}--checkout, -c${ANSI.reset}          Automate final checkout (selects time slot, payment & submits)
  ${ANSI.cyan}--dry-run, -d${ANSI.reset}           Preview & take review screenshot without placing order
  ${ANSI.cyan}--headed${ANSI.reset}                Run browser visually instead of headless mode
  ${ANSI.cyan}empty-cart${ANSI.reset}              Remove all items and clear the active Fred Meyer cart
  ${ANSI.cyan}clear-list${ANSI.reset}              Reset the local grocery CSV shopping list to clean header

${ANSI.bold}Piping & Shell Integration:${ANSI.reset}
  All informational logs and tables are routed to stderr.
  The resulting screenshot path (or JSON) is routed to stdout, allowing:
    ${ANSI.cyan}fm --list weekly.csv --checkout --dry-run | xargs open${ANSI.reset}
    ${ANSI.cyan}open $(fm --list weekly.csv --checkout --dry-run)${ANSI.reset}
`);
    return;
  }

  await cmdOrder(options.list, options);
}

main().catch((err) => {
  log(`\n${ANSI.red}Error: ${err.message}${ANSI.reset}`);
  process.exit(1);
});
