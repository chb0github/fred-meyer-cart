/**
 * Lightweight fuzzy matching and scoring utilities
 */

/**
 * Tokenize string into clean lower-case alphanumeric words
 */
export function tokenize(str) {
  if (!str) return [];
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Levenshtein distance between two strings
 */
export function levenshtein(a, b) {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix = Array.from({ length: bn + 1 }, () => new Array(an + 1).fill(0));
  for (let i = 0; i <= an; i++) matrix[0][i] = i;
  for (let j = 0; j <= bn; j++) matrix[j][0] = j;

  for (let j = 1; j <= bn; j++) {
    for (let i = 1; i <= an; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1, // deletion
        matrix[j][i - 1] + 1, // insertion
        matrix[j - 1][i - 1] + cost // substitution
      );
    }
  }
  return matrix[bn][an];
}

/**
 * String similarity ratio (0.0 to 1.0)
 */
export function stringSimilarity(str1, str2) {
  const s1 = (str1 || "").toLowerCase().trim();
  const s2 = (str2 || "").toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const maxLen = Math.max(s1.length, s2.length);
  const distance = levenshtein(s1, s2);
  return Math.max(0, (maxLen - distance) / maxLen);
}

/**
 * Token overlap / Jaccard similarity score (0.0 to 1.0)
 */
export function tokenOverlapScore(queryTokens, targetTokens) {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;

  let matches = 0;
  for (const q of queryTokens) {
    // Check exact token match or close substring/fuzzy match
    const found = targetTokens.some((t) => {
      if (t === q) return true;
      if (q.length >= 4 && t.includes(q)) return true;
      if (stringSimilarity(q, t) >= 0.8) return true;
      return false;
    });
    if (found) matches++;
  }

  return matches / queryTokens.length;
}

/**
 * Calculate overall fuzzy match score between search query and product candidate
 */
export function calculateFuzzyScore(query, product, options = {}) {
  const queryClean = (query || "").toLowerCase();
  const titleClean = `${product.brand || ""} ${product.description || ""}`.toLowerCase();
  const sizeClean = (product.size || "").toLowerCase();

  const qTokens = tokenize(queryClean);
  const titleTokens = tokenize(titleClean);

  // 1. Token overlap score (weight: 50%)
  const tokenScore = tokenOverlapScore(qTokens, titleTokens);

  // 2. Direct string similarity (weight: 25%)
  const strScore = stringSimilarity(queryClean, titleClean);

  // 3. Substring inclusion bonus (weight: 15%)
  let substringBonus = 0;
  if (titleClean.includes(queryClean)) {
    substringBonus = 0.2;
  } else {
    // Check if key query parts are contained
    const matchedParts = qTokens.filter((tok) => tok.length > 2 && titleClean.includes(tok));
    substringBonus = (matchedParts.length / (qTokens.length || 1)) * 0.15;
  }

  // 4. Size & Quantity keyword bonus (e.g. "5 lb", "18 ct", "12 oz") (weight: 10%)
  let sizeBonus = 0;
  for (const tok of qTokens) {
    if ((tok.match(/^\d+/) || ["lb", "oz", "ct", "gal", "bunch"].includes(tok)) && sizeClean.includes(tok)) {
      sizeBonus += 0.05;
    }
  }

  // 5. In-stock penalty/bonus
  const isOutOfStock = product.stockLevel === "TEMPORARILY_OUT_OF_STOCK";
  const stockMultiplier = isOutOfStock ? 0.7 : 1.0;

  let totalScore = (tokenScore * 0.5 + strScore * 0.2 + substringBonus + sizeBonus) * stockMultiplier;
  return Math.min(1.0, Math.max(0.0, totalScore));
}
