import { getClientToken } from "./auth.mjs";

const BASE_URL = "https://api.kroger.com/v1";

/**
 * Search locations by ZIP code or chain
 */
export async function searchLocations({ zipCode = "98029", chain = "FRED_MEYER", limit = 5 } = {}) {
  const token = await getClientToken();
  const params = new URLSearchParams({
    "filter.zipCode.near": zipCode,
    "filter.limit": limit.toString()
  });
  if (chain) {
    params.set("filter.chain", chain);
  }

  const res = await fetch(`${BASE_URL}/locations?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Location search failed (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  return json.data || [];
}

/**
 * Search products by search term and location
 */
export async function searchProducts({ term, locationId, limit = 6 } = {}) {
  const token = await getClientToken();
  const params = new URLSearchParams({
    "filter.term": term,
    "filter.limit": limit.toString()
  });
  if (locationId) {
    params.set("filter.locationId", locationId);
  }

  const res = await fetch(`${BASE_URL}/products?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Product search failed for "${term}" (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  return json.data || [];
}

/**
 * Lookup a specific product by its Product ID (UPC)
 */
export async function getProductById(productId, locationId) {
  const token = await getClientToken();
  const url = `${BASE_URL}/products/${encodeURIComponent(productId)}?filter.locationId=${encodeURIComponent(locationId)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    return null;
  }

  const json = await res.json();
  return json.data || null;
}

/**
 * Add items to customer pickup cart
 * @param {Array<{upc: string, quantity: number, modality?: string}>} items
 * @param {string} customerToken
 */
export async function addToCart(items, customerToken) {
  const payload = {
    items: items.map((item) => ({
      upc: item.upc || item.productId,
      quantity: item.quantity || 1,
      modality: item.modality || "PICKUP"
    }))
  };

  const res = await fetch(`${BASE_URL}/cart/add`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${customerToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to add items to cart (${res.status}): ${errorText}`);
  }

  return { success: true, count: items.length };
}
