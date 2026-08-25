#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";
import { getConfig, saveConfig, getNetrcCredentials, TOKEN_FILE } from "./config.mjs";
import { authenticateCustomer, getCustomerToken } from "./auth.mjs";
import { searchLocations, searchProducts, addToCart } from "./krogerApi.mjs";
import { parseShoppingList, parseSingleItem, serializeToCsv } from "./parser.mjs";
import { matchShoppingList, matchItem } from "./matcher.mjs";

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

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
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

  // Match MM/DD or MM-DD or MM/DD/YY
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    const dateObj = new Date(year, month - 1, day);
    if (!isNaN(dateObj.getTime())) {
      return dateObj.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric"
      });
    }
  }
  return input.trim();
}

function printTable(results, scheduleDate = null, storeName = null, modality = "PICKUP") {
  const modeLabel = modality === "DELIVERY" ? "Delivery" : "Pickup";
  console.log(`\n${ANSI.bold}Fred Meyer ${modeLabel} Cart Preview:${ANSI.reset}`);
  if (storeName) {
    console.log(` 🏬 ${ANSI.dim}Store:${ANSI.reset} ${ANSI.cyan}${storeName}${ANSI.reset}`);
  }
  if (scheduleDate) {
    console.log(` 📅 ${ANSI.dim}Target ${modeLabel} Date:${ANSI.reset} ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
  }
  console.log(` 🚚 ${ANSI.dim}Modality:${ANSI.reset} ${ANSI.yellow}${modality}${ANSI.reset}`);
  console.log();
  console.log(
    ` ${ANSI.dim}#   Qty  Price    Subtotal  Product Description                     Product ID     Size${ANSI.reset}`
  );
  console.log(` ${ANSI.dim}─`.repeat(96) + ANSI.reset);

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

      console.log(
        ` ${ANSI.bold}${num}${ANSI.reset}  ${ANSI.cyan}${qty}x${ANSI.reset} ${priceStr}  ${ANSI.green}${subtotalStr}${ANSI.reset}  ${name}  ${prodId} ${ANSI.dim}${size}${ANSI.reset}`
      );
      if (res.item.note) {
        console.log(`     ${ANSI.dim}↳ Note: "${res.item.note}"${ANSI.reset}`);
      }
    } else {
      console.log(
        ` ${ANSI.bold}${num}${ANSI.reset}  ${ANSI.yellow}${qty}x${ANSI.reset}    --         --     ${ANSI.red}✗ "${res.item.term}" (No product found)${ANSI.reset}`
      );
    }
  });

  console.log(` ${ANSI.dim}─`.repeat(96) + ANSI.reset);
  console.log(
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
  console.log(JSON.stringify(output, null, 2));
}

// -------------------------------------------------------------
// Interactive Mode Loop
// -------------------------------------------------------------

async function runInteractiveMode(initialResults, filePath, locationId, scheduleDate = null, storeName = null, modality = "PICKUP") {
  let results = [...initialResults];

  while (true) {
    printTable(results, scheduleDate, storeName, modality);

    const modeLabel = modality === "DELIVERY" ? "Delivery" : "Pickup";
    console.log(`${ANSI.bold}Actions:${ANSI.reset}`);
    console.log(`  ${ANSI.green}[P]${ANSI.reset} Push cart to Fred Meyer ${modeLabel}`);
    console.log(`  ${ANSI.cyan}[E]${ANSI.reset} Edit quantity / change name (fuzzy match) / swap product`);
    console.log(`  ${ANSI.cyan}[A]${ANSI.reset} Add a new item`);
    console.log(`  ${ANSI.yellow}[D]${ANSI.reset} Delete an item`);
    console.log(`  ${ANSI.yellow}[M]${ANSI.reset} Toggle Modality (${modality === "PICKUP" ? "switch to DELIVERY" : "switch to PICKUP"})`);
    console.log(`  ${ANSI.magenta}[S]${ANSI.reset} Save current list & Product IDs to CSV`);
    console.log(`  ${ANSI.dim}[Q] Quit without submitting${ANSI.reset}`);

    const choice = (await askQuestion(`\nChoose action [P/e/a/d/m/s/q]: `)).toUpperCase();

    if (choice === "M") {
      modality = modality === "PICKUP" ? "DELIVERY" : "PICKUP";
      console.log(`\n${ANSI.green}✓ Switched modality to ${modality}${ANSI.reset}`);
      continue;
    }

    if (choice === "P" || choice === "") {
      const validItems = results
        .filter((r) => r.matched && r.selected)
        .map((r) => ({
          upc: r.selected.productId || r.selected.upc,
          quantity: r.item.quantity,
          modality
        }));

      if (validItems.length === 0) {
        console.log(`\n${ANSI.red}No matched items to add to cart.${ANSI.reset}\n`);
        continue;
      }

      console.log(`\n📦 Authenticating & sending items to Fred Meyer (${modality})...`);
      const customerToken = await getCustomerToken(true);
      await addToCart(validItems, customerToken);

      console.log(
        `\n${ANSI.green}${ANSI.bold}🎉 Success! Added ${validItems.length} items to your Fred Meyer ${modeLabel} cart!${ANSI.reset}`
      );
      if (scheduleDate) {
        console.log(`📅 Target ${modeLabel} Date: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
      }
      console.log(
        `👉 Next Step: Open ${ANSI.cyan}https://www.fredmeyer.com/cart${ANSI.reset} to choose your ${modeLabel.toLowerCase()} window.\n`
      );
      break;
    }

    if (choice === "E") {
      const itemNumStr = await askQuestion(`Enter item # to edit (1-${results.length}): `);
      const idx = parseInt(itemNumStr, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= results.length) {
        console.log("Invalid item number.");
        continue;
      }

      const current = results[idx];
      console.log(`\nEditing Item #${idx + 1}: "${current.item.term}" (Current ID: ${current.selected?.productId || "None"})`);

      const newName = await askQuestion(`Change product name/query (press Enter to keep "${current.item.term}"): `);
      if (newName.trim() !== "") {
        console.log(`Fuzzy matching "${newName}" against Fred Meyer inventory...`);
        const tempItem = parseSingleItem(newName);
        tempItem.quantity = current.item.quantity;
        const rematch = await matchItem(tempItem, locationId);
        if (rematch.matched) {
          results[idx] = rematch;
          console.log(`${ANSI.green}✓ Fuzzy matched: ${rematch.selected.fullName} ($${rematch.selected.price})${ANSI.reset}`);
          continue;
        } else {
          console.log(`${ANSI.red}No product found. Keeping original.${ANSI.reset}`);
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
        console.log(`\nAvailable alternatives from Fred Meyer:`);
        current.candidates.forEach((c, cIdx) => {
          const isSel = c.productId === current.selected?.productId ? ` ${ANSI.green}★ [SELECTED]${ANSI.reset}` : "";
          const score = Math.round((c.fuzzyScore || 0) * 100);
          console.log(
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
              console.log(`${ANSI.red}No products found for "${customQuery}".${ANSI.reset}`);
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
        console.log(`Fuzzy matching "${parsed.searchQuery}" at Fred Meyer...`);
        const matched = await matchItem(parsed, locationId);
        results.push(matched);
        if (matched.matched) {
          console.log(`${ANSI.green}✓ Added ${matched.selected.fullName} (ID: ${matched.selected.productId})${ANSI.reset}`);
        } else {
          console.log(`${ANSI.yellow}! Added item, but no matching Fred Meyer product found.${ANSI.reset}`);
        }
      }
      continue;
    }

    if (choice === "D") {
      const itemNumStr = await askQuestion(`Enter item # to delete (1-${results.length}): `);
      const idx = parseInt(itemNumStr, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < results.length) {
        const removed = results.splice(idx, 1);
        console.log(`${ANSI.yellow}✓ Removed ${removed[0]?.item?.term}${ANSI.reset}`);
      }
      continue;
    }

    if (choice === "S") {
      const targetCsv = filePath.endsWith(".csv") ? filePath : filePath.replace(/\.[^.]+$/, "") + ".csv";
      const csvData = serializeToCsv(results);
      fs.writeFileSync(targetCsv, csvData, "utf-8");
      console.log(`\n${ANSI.green}✓ Saved list & Product IDs to ${targetCsv}${ANSI.reset}\n`);
      continue;
    }

    if (choice === "Q") {
      console.log("\nExited without modifying cart.\n");
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
    console.error(`${ANSI.red}Error: Shopping list file not found: ${resolved}${ANSI.reset}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, "utf-8");
  const parsed = parseShoppingList(content, resolved);
  const modality = (options.modality || (options.delivery ? "DELIVERY" : "PICKUP")).toUpperCase();
  const scheduleDate = parseScheduleDate(options.pickup || options.deliveryDate);

  if (options.format !== "json") {
    console.log(`\n🏬 Loading list from ${ANSI.bold}${path.basename(resolved)}${ANSI.reset} at ${ANSI.cyan}${storeName}${ANSI.reset}...`);
    if (scheduleDate) {
      console.log(`📅 Target ${modality === "DELIVERY" ? "Delivery" : "Pickup"} Date: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
    }
    if (options.prefer) {
      console.log(`🏷️  Brand Preference: ${ANSI.yellow}${options.prefer}${ANSI.reset}`);
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
          process.stdout.write(`\r   Matching [${curr}/${total}]: ${item.searchQuery.slice(0, 25).padEnd(25)}${idHint}`);
        }
  );

  if (options.format !== "json") {
    process.stdout.write("\r" + " ".repeat(60) + "\r");
  }

  const estTotal = results.reduce((acc, r) => {
    if (r.matched && r.selected) {
      return acc + (parseFloat(r.selected.price) || 0) * r.item.quantity;
    }
    return acc;
  }, 0);

  if (options.budget && estTotal > options.budget) {
    console.warn(
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
    console.log(`${ANSI.green}✓ Synced Product IDs to ${targetCsv}${ANSI.reset}`);
  }

  const isNonInteractive = options.nonInteractive || options.yes || options.dryRun || Boolean((options.pickup || options.deliveryDate) && !options.interactive);

  if (isNonInteractive) {
    printTable(results, scheduleDate, storeName, modality);

    if (options.dryRun) {
      console.log(`${ANSI.yellow}🔍 Dry Run complete: Cart was not modified.${ANSI.reset}\n`);
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
      console.error(`${ANSI.red}✗ No valid items found to add to cart.${ANSI.reset}`);
      process.exit(1);
    }

    console.log(`🚀 Automated mode: Submitting ${validItems.length} items to Fred Meyer ${modality} Cart...`);
    const customerToken = await getCustomerToken(false);
    await addToCart(validItems, customerToken);

    console.log(`\n${ANSI.green}${ANSI.bold}✓ Success! ${validItems.length} items added to Fred Meyer ${modality} Cart.${ANSI.reset}`);
    if (scheduleDate) {
      console.log(`📅 Scheduled for ${modality === "DELIVERY" ? "Delivery" : "Pickup"} on: ${ANSI.bold}${scheduleDate}${ANSI.reset}`);
    }
    console.log(`👉 Complete checkout at: ${ANSI.cyan}https://www.fredmeyer.com/cart${ANSI.reset}\n`);
  } else {
    await runInteractiveMode(results, resolved, locationId, scheduleDate, storeName, modality);
  }
}

async function cmdStore(zipArg) {
  const config = getConfig();
  const zip = zipArg || config.zipCode || "98029";
  console.log(`\n🔍 Searching stores near ZIP \x1b[1m${zip}\x1b[0m...\n`);

  const locations = await searchLocations({ zipCode: zip, chain: null, limit: 10 });
  if (locations.length === 0) {
    console.log(`No stores found near ${zip}.`);
    return;
  }

  locations.forEach((loc, idx) => {
    const isCurrent = loc.locationId === config.locationId ? ` ${ANSI.green}★ [CURRENT]${ANSI.reset}` : "";
    console.log(
      `${ANSI.bold}${idx + 1}. [${loc.chain}] ${loc.name}${ANSI.reset}${isCurrent}`
    );
    console.log(`   ID: ${ANSI.cyan}${loc.locationId}${ANSI.reset} | ${loc.address.addressLine1}, ${loc.address.city}, ${loc.address.zipCode}`);
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
    console.log(`\n${ANSI.green}✓ Saved default store: ${selected.name} (${selected.locationId})${ANSI.reset}\n`);
  }
}

async function cmdAuth() {
  console.log(`\n${ANSI.bold}Fred Meyer Customer Account Authorization${ANSI.reset}`);
  console.log("Connects your Fred Meyer account to authorize adding items to your cart.\n");
  try {
    await authenticateCustomer();
    console.log(`\n${ANSI.green}✓ Authorization complete! Saved tokens to .tokens.json${ANSI.reset}\n`);
  } catch (err) {
    console.error(`\n${ANSI.red}✗ Authorization failed: ${err.message}${ANSI.reset}\n`);
  }
}

async function cmdSearch(query, locationId = null) {
  if (!query) {
    console.log("Usage: fm search <product name>");
    return;
  }
  const config = getConfig();
  const store = locationId || config.locationId;
  console.log(`\n🔍 Searching "${query}" at ${ANSI.bold}${config.storeName}${ANSI.reset}...\n`);

  const products = await searchProducts({ term: query, locationId: store, limit: 6 });
  if (products.length === 0) {
    console.log("No matching products found.");
    return;
  }

  products.forEach((prod, idx) => {
    const details = prod.items?.[0] || {};
    const price = details.price?.regular ? `$${details.price.regular}` : "Price N/A";
    const size = details.size ? ` (${details.size})` : "";
    const prodId = prod.productId || prod.upc;
    console.log(
      `${ANSI.bold}${idx + 1}. [ID: ${ANSI.cyan}${prodId}${ANSI.reset}] ${prod.brand ? prod.brand + " " : ""}${prod.description}${size}${ANSI.reset}`
    );
    console.log(`   Price: ${ANSI.green}${price}${ANSI.reset} | Stock: ${details.inventory?.stockLevel || "IN_STOCK"}\n`);
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
      console.log("✓ Cleared local token cache.");
      process.exit(0);
    } else if (["auth", "sync", "store", "search", "help"].includes(arg)) {
      options.command = arg;
      if (arg === "search") {
        options.searchQuery = rawArgs.slice(i + 1).join(" ");
        break;
      }
      if (arg === "store") {
        options.zip = rawArgs[i + 1];
        break;
      }
      if (arg === "sync" && rawArgs[i + 1] && !rawArgs[i + 1].startsWith("-")) {
        options.list = rawArgs[++i];
      }
    } else if (!arg.startsWith("-") && !options.list) {
      options.list = arg;
    }
  }

  return options;
}

async function main() {
  const creds = getNetrcCredentials();
  if (!creds) {
    console.error(`${ANSI.red}Error: No credentials found in .netrc for machine api.kroger.com${ANSI.reset}`);
    process.exit(1);
  }

  const rawArgs = process.argv.slice(2);
  const options = parseCliArgs(rawArgs);

  if (options.command === "auth") {
    await cmdAuth();
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
    console.log(`
${ANSI.bold}Fred Meyer (Kroger) Cart Automation CLI (fm)${ANSI.reset}

${ANSI.bold}Usage:${ANSI.reset}
  fm [options]
  fm --list <file.csv> --pickup <date> [options]
  fm --list <file.csv> --delivery <date> [options]

${ANSI.bold}Core Options:${ANSI.reset}
  ${ANSI.cyan}--list, -l <path>${ANSI.reset}          Path to shopping list CSV / TXT
  ${ANSI.cyan}--pickup, -p <date>${ANSI.reset}        Set target pickup date (e.g. 09/10, tomorrow)
  ${ANSI.cyan}--delivery [date]${ANSI.reset}          Submit cart for DELIVERY instead of Pickup
  ${ANSI.cyan}--dry-run, -d${ANSI.reset}              Preview matched items, prices & total without pushing to cart
  ${ANSI.cyan}--store, -s <id|zip>${ANSI.reset}       Override store location (e.g. -s 98029)
  ${ANSI.cyan}--prefer <brand>${ANSI.reset}          Brand priority: store-brand | organic | lowest-price | name-brand
  ${ANSI.cyan}--budget, -b <dollars>${ANSI.reset}    Budget limit warning threshold
  ${ANSI.cyan}--format <table|json>${ANSI.reset}     Output format (default: table)
  ${ANSI.cyan}--sync${ANSI.reset}                    Write back resolved Product IDs and prices to CSV
  ${ANSI.cyan}--interactive, -i${ANSI.reset}          Force interactive mode
  ${ANSI.cyan}--yes, -y${ANSI.reset}                  Force automated non-interactive order
`);
    return;
  }

  await cmdOrder(options.list, options);
}

main().catch((err) => {
  console.error(`\n${ANSI.red}Error: ${err.message}${ANSI.reset}`);
  process.exit(1);
});
