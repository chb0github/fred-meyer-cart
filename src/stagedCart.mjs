import fs from "fs";
import os from "os";
import path from "path";

const CONFIG_DIR = path.join(os.homedir(), ".config", "fm");
const STAGED_CART_FILE = path.join(CONFIG_DIR, "staged_cart.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Loads the currently staged cart items
 */
export function getStagedCart() {
  ensureConfigDir();
  if (!fs.existsSync(STAGED_CART_FILE)) {
    return { items: [], locationId: "70100658", modality: "PICKUP", updatedAt: null };
  }
  try {
    const raw = fs.readFileSync(STAGED_CART_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { items: [], locationId: "70100658", modality: "PICKUP", updatedAt: null };
  }
}

/**
 * Saves the staged cart state
 */
export function saveStagedCart(cartState) {
  ensureConfigDir();
  cartState.updatedAt = new Date().toISOString();
  fs.writeFileSync(STAGED_CART_FILE, JSON.stringify(cartState, null, 2), "utf-8");
}

/**
 * Clears the staged cart
 */
export function clearStagedCart() {
  ensureConfigDir();
  saveStagedCart({ items: [], locationId: "70100658", modality: "PICKUP", updatedAt: null });
}

/**
 * Adds or updates items in the staged cart
 */
export function addItemsToStagedCart(newItems, locationId = "70100658", modality = "PICKUP") {
  const current = getStagedCart();
  current.locationId = locationId || current.locationId;
  current.modality = modality || current.modality;

  const itemMap = new Map();
  for (const item of current.items) {
    const key = item.productId || item.upc || item.searchTerm;
    itemMap.set(key, item);
  }

  for (const item of newItems) {
    const key = item.productId || item.upc || item.searchTerm;
    if (itemMap.has(key)) {
      const existing = itemMap.get(key);
      existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
    } else {
      itemMap.set(key, { ...item });
    }
  }

  current.items = Array.from(itemMap.values());
  saveStagedCart(current);
  return current;
}
