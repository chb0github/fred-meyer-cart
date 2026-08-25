/**
 * Normalization helpers for known shopping list patterns and search queries
 */
const QUERY_REPLACEMENTS = [
  { pattern: /\brainers?\b/i, replacement: "Rainier" },
  { pattern: /\blow cal drinks?\b/i, replacement: "sparkling water" },
  { pattern: /\b18\s+white\s+eggs\b/i, replacement: "18 white eggs" },
  { pattern: /\b5lb\b/i, replacement: "5 lb" },
  { pattern: /\b(bag|box|package|pack|carton|tub|bottle|can|container)s?\b/gi, replacement: "" }
];

/**
 * Clean up extra symbols and leading numbers (e.g. " 1.", "14.", "- [ ]")
 */
function cleanLine(line) {
  return line
    .replace(/^[\s\u2000-\u200F\uFEFF\u00A0]*(\d+[\.\)]|[-*•]|\-\s*\[[ xX]?\])\s*/, "")
    .trim();
}

/**
 * Extract notes inside parentheses or brackets
 */
function extractNotes(text) {
  const noteMatch = text.match(/[\(\[](.*?)[\)\]]/);
  const note = noteMatch ? noteMatch[1].trim() : null;
  const cleaned = text.replace(/[\(\[].*?[\)\]]/g, "").trim();
  return { cleaned, note };
}

/**
 * Parse an individual item segment into quantity and search term
 */
export function parseSingleItem(rawText, inheritedNote = null, explicitProductId = null, explicitQty = null) {
  let { cleaned, note } = extractNotes(rawText);
  if (!note && inheritedNote) note = inheritedNote;

  let quantity = explicitQty ? parseInt(explicitQty, 10) : 1;
  let term = cleaned;

  if (!explicitQty) {
    // Pattern: "Rigatoni x2" or "Farfalle 2x" or "Apples x 3"
    const suffixQtyMatch = term.match(/^(.*?)(?:\s*[,xX]\s*|\s+x\s*)(\d+)\s*$/);
    if (suffixQtyMatch) {
      term = suffixQtyMatch[1].trim();
      quantity = parseInt(suffixQtyMatch[2], 10);
    }

    // Pattern: "2 carrots", "3 apples", "1 package baby spinach", "2 gal milk"
    const prefixQtyMatch = term.match(/^(\d+)\s+(?:packages?|packs?|bags?|cans?|bottles?|bunches?|ct|count|lbs?|pounds?|gallons?|gals?)\s*(?:of\s+)?(.*)$/i);
    if (prefixQtyMatch && !term.match(/^\d+\s+(?:white\s+eggs|eggs|oz|lb|g)\b/i)) {
      const parsedQty = parseInt(prefixQtyMatch[1], 10);
      const remainder = prefixQtyMatch[2].trim();
      if (remainder.length > 0 && parsedQty <= 50) {
        quantity = parsedQty;
        term = remainder;
      }
    }
  }

  // Handle "Flour, 5lb bag" -> "flour 5 lb"
  let cleanTerm = term.replace(/,\s*/g, " ");

  // Apply search query optimizations
  let searchQuery = cleanTerm;
  for (const { pattern, replacement } of QUERY_REPLACEMENTS) {
    searchQuery = searchQuery.replace(pattern, replacement);
  }
  searchQuery = searchQuery.replace(/\s+/g, " ").trim();

  return {
    raw: rawText.trim(),
    term: cleanTerm.trim(),
    searchQuery: searchQuery || cleanTerm.trim(),
    quantity: Math.max(1, isNaN(quantity) ? 1 : quantity),
    note: note || undefined,
    productId: explicitProductId ? String(explicitProductId).trim() : undefined,
    upc: explicitProductId ? String(explicitProductId).trim() : undefined
  };
}

/**
 * Parse CSV list format: item,quantity,notes,productId,price,size
 */
function parseCsv(content) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length === 0) return [];

  // Check header
  let startIdx = 0;
  const firstLine = lines[0].toLowerCase();
  if (firstLine.includes("item") || firstLine.includes("product") || firstLine.includes("quantity")) {
    startIdx = 1;
  }

  const items = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // CSV parser handling commas inside quotes
    const regex = /(?:,|\n|^)("(?:(?:"")*[^"]*)*"|[^",\n]*|(?:\n|$))/g;
    const cols = [];
    let match;
    while ((match = regex.exec(line)) !== null) {
      let val = match[1] || "";
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1).replace(/""/g, '"');
      }
      cols.push(val.trim());
      if (regex.lastIndex === line.length) break;
    }

    const itemName = cols[0];
    const qty = cols[1] ? parseInt(cols[1], 10) : 1;
    const note = cols[2] || undefined;
    const productId = cols[3] || undefined;

    if (itemName) {
      items.push(parseSingleItem(itemName, note, productId, isNaN(qty) ? 1 : qty));
    }
  }
  return items;
}

/**
 * Parse plain text lines
 */
function parsePlainText(content) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const parsedItems = [];

  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned) continue;

    // Split multiple items (e.g. "Rigatoni x2, Farfalle x2")
    if (cleaned.includes(",") && cleaned.match(/[xX]\d+/)) {
      const parts = cleaned.split(/,\s*/);
      for (const part of parts) {
        if (part.trim()) {
          parsedItems.push(parseSingleItem(part));
        }
      }
    } else {
      parsedItems.push(parseSingleItem(cleaned));
    }
  }

  return parsedItems;
}

import fs from "fs";

/**
 * Parse either CSV or Plain Text list (accepts either string content or file path)
 */
export function parseShoppingList(contentOrPath, filePath = "") {
  let content = contentOrPath;
  let file = filePath;
  if (typeof contentOrPath === "string" && fs.existsSync(contentOrPath)) {
    content = fs.readFileSync(contentOrPath, "utf-8");
    file = contentOrPath;
  }
  const isCsv = file.toLowerCase().endsWith(".csv") || (content.includes(",") && content.split("\n")[0].toLowerCase().includes("item"));
  if (isCsv) {
    return parseCsv(content);
  }
  return parsePlainText(content);
}

/**
 * Convert structured list back to CSV format with Product ID reference
 */
export function serializeToCsv(results) {
  const header = "item,quantity,notes,productId,price,size\n";
  const rows = results.map((r) => {
    const item = r.item;
    const prod = r.selected;
    const productId = prod?.productId || prod?.upc || item.productId || "";
    const price = prod?.price ? `$${parseFloat(prod.price).toFixed(2)}` : "";
    const size = prod?.size || "";
    const note = item.note || "";
    const name = `"${item.term.replace(/"/g, '""')}"`;
    return `${name},${item.quantity},"${note.replace(/"/g, '""')}","${productId}","${price}","${size}"`;
  });
  return header + rows.join("\n") + "\n";
}
