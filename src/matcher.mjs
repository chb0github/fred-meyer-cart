import { searchProducts, getProductById } from "./krogerApi.mjs";
import { calculateFuzzyScore } from "./fuzzy.mjs";

function formatProduct(prod, query = "", preference = null) {
  const details = prod.items?.[0] || {};
  const price = details.price?.regular || details.price?.promo || null;
  const size = details.size || "";
  const isSpecial = Boolean(details.price?.promo);
  const productId = prod.productId || prod.upc;
  const brand = prod.brand || "";
  const description = prod.description || "";
  const fullName = `${brand ? brand + " " : ""}${description}`;
  const stockLevel = details.inventory?.stockLevel || "IN_STOCK";

  const formatted = {
    productId,
    upc: prod.upc || productId,
    brand,
    description,
    fullName,
    size,
    price,
    isPromo: isSpecial,
    stockLevel,
    fuzzyScore: 1.0
  };

  if (query) {
    let score = calculateFuzzyScore(query, formatted);

    // Apply brand/category preferences
    const brandLower = brand.toLowerCase();
    const fullLower = fullName.toLowerCase();

    if (preference === "organic") {
      if (fullLower.includes("organic") || brandLower.includes("simple truth")) {
        score += 0.2;
      }
    } else if (preference === "store-brand" || preference === "kroger") {
      if (brandLower.includes("kroger") || brandLower.includes("private selection") || brandLower.includes("simple truth")) {
        score += 0.15;
      }
    } else if (preference === "name-brand") {
      if (!brandLower.includes("kroger") && !brandLower.includes("private selection")) {
        score += 0.15;
      }
    }

    formatted.fuzzyScore = Math.min(1.0, score);
  }

  return formatted;
}

/**
 * Match a single item against Fred Meyer inventory with fuzzy scoring & preferences
 */
export async function matchItem(item, locationId, preference = null) {
  try {
    // 1. If explicit productId is provided in CSV, attempt direct lookup
    if (item.productId) {
      const direct = await getProductById(item.productId, locationId);
      if (direct) {
        const candidate = formatProduct(direct, "", preference);
        candidate.fuzzyScore = 1.0;
        return {
          item,
          matched: true,
          selected: candidate,
          candidates: [candidate]
        };
      }
    }

    // 2. Perform search queries
    let products = await searchProducts({
      term: item.searchQuery,
      locationId,
      limit: 6
    });

    // Fallback if search query returned nothing
    if ((!products || products.length === 0) && item.term !== item.searchQuery) {
      products = await searchProducts({
        term: item.term,
        locationId,
        limit: 6
      });
    }

    if (!products || products.length === 0) {
      return {
        item,
        matched: false,
        candidates: []
      };
    }

    // 3. Format and score all candidates with fuzzy matcher
    const candidates = products.map((p) => formatProduct(p, item.term, preference));

    // Sort by preference or fuzzy score
    if (preference === "lowest-price") {
      candidates.sort((a, b) => (parseFloat(a.price) || 999) - (parseFloat(b.price) || 999));
    } else {
      candidates.sort((a, b) => b.fuzzyScore - a.fuzzyScore);
    }

    const selected = candidates[0];

    return {
      item,
      matched: true,
      selected,
      candidates
    };
  } catch (error) {
    return {
      item,
      matched: false,
      error: error.message,
      candidates: []
    };
  }
}

/**
 * Match an entire list of parsed items against Fred Meyer store inventory
 */
export async function matchShoppingList(parsedItems, locationId, options = {}, onProgress = null) {
  const preference = options.preference || options.prefer || null;
  const results = [];
  for (let i = 0; i < parsedItems.length; i++) {
    const item = parsedItems[i];
    if (onProgress) {
      onProgress(i + 1, parsedItems.length, item);
    }
    const match = await matchItem(item, locationId, preference);
    results.push(match);
  }
  return results;
}
