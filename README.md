# Fred Meyer (Kroger) Cart Automation CLI (`fm`)

A fast Node.js CLI tool to parse grocery shopping lists, fuzzy match live Fred Meyer inventory (Issaquah Store `#70100658`), and populate your Fred Meyer Pickup cart using the official Kroger Developer API.

---

## 🤖 Use as an MCP Server (LM Studio & other MCP clients)

This project ships a stdio-based [Model Context Protocol](https://modelcontextprotocol.io) server at [`src/mcp-server.mjs`](file:///Users/dmiles/lmstudiofiles/fred-meyer-cart/src/mcp-server.mjs). It exposes the CLI's functionality as tools an LLM can call directly — no new npm packages required (Node 18+ builtins only).

| Tool | What it does | Mutates? |
|---|---|---|
| `fm_search_products` | Keyword search of live Fred Meyer inventory (price/size/stock) | No |
| `fm_get_product` | Look up a product by its Kroger Product ID / UPC | No |
| `fm_search_locations` | Find store IDs near a ZIP code | No |
| `fm_match_shopping_list` | Fuzzy-match a list to live products with prices & estimated total (dry run) | No |
| `fm_cart_status` | Show items in the staged cart | No |
| `fm_auth_status` | Check API credentials + customer login state | No |
| `fm_cart_add` | Match items and push them into your online Fred Meyer cart | **Yes** |
| `fm_clear_cart` | Clear local cart (optionally empty the online cart via browser automation) | **Yes** |
| `fm_checkout` | Automated slot reservation & order review — **dry run by default**; `dryRun:false` places the order | Optional |

### Setup in LM Studio

1. Confirm Node 18+ and get its absolute path: `which node` (e.g. `/opt/homebrew/bin/node`).
2. In LM Studio open **Developer → MCP** (in some versions: **Settings → MCP Servers**) and click **Add Server / New Custom Server**.
3. Fill in:
   - **Name**: `Fred Meyer Cart`
   - **Command**: the full path to node, e.g. `/opt/homebrew/bin/node`
   - **Args** (one per line): `/Users/dmiles/lmstudiofiles/fred-meyer-cart/src/mcp-server.mjs`
4. Save and refresh — the nine `fm_*` tools should appear in your tool list; enable them for the chat/model profile you want to use.

That's it. Just talk to it: *“Price sample_list.csv at Fred Meyer,”* *“Add burrata and 18 white eggs to my pickup cart,”* *“What’s in my FM cart?”* The model will pick the right tools on its own.

> If you prefer editing LM Studio's MCP config file directly, the equivalent entry is:
>
> ```json
> {
>   "mcpServers": {
>     "fred-meyer-cart": {
>       "command": "/opt/homebrew/bin/node",
>       "args": ["/Users/dmiles/lmstudiofiles/fred-meyer-cart/src/mcp-server.mjs"]
>     }
>   }
> }
> ```

### Prerequisites (same as the CLI)

- **Credentials for every tool**: a `.netrc` file in this project root (or `~/.netrc`, or env vars) with:
  ```
  machine api.kroger.com login <YOUR_CLIENT_ID> password <YOUR_CLIENT_SECRET>
  ```
- **For cart mutations** (`fm_cart_add`, `fm_checkout`): authenticate once from a terminal — `node src/cli.mjs auth-browser`. Tokens then auto-refresh in the background (`.tokens.json`).
- **Only for `fm_checkout` and remote `fm_clear_cart`**: install Playwright + WebKit — `npm install && npx playwright install webkit`. Everything else works without any `npm install`.

> **Safety built into the server:** read-only tools can't change anything; `fm_checkout` defaults to a **dry run** (screenshot of the review page, no order placed) until you explicitly pass `dryRun=false`, and cart operations never block on interactive prompts (stdin belongs to the MCP client).

---

## 🔒 Zero Credentials on the CLI

**No username, password, or API secrets are ever passed on the CLI.**
Credentials live strictly in [`fm/.netrc`](file:///Users/280001747@bwt3.com/fm/.netrc) (gitignored). All OAuth tokens and refresh tokens are handled and auto-refreshed silently in the background.

---

## 🚀 CLI Arguments & Usage

```bash
fm [options]
fm --list <file.csv> --pickup <date> [options]
fm <command> [arguments]
```

### 🛠 Practical CLI Flags

| Flag | Shorthand | Description | Example |
|---|---|---|---|
| `--list <path>` | `-l` | Path to shopping list file (CSV or TXT) | `fm -l weekly.csv` |
| `--pickup <date>` | `-p` | Set target pickup date (`MM/DD`, `today`, `tomorrow`, etc.) | `fm -p 09/10` |
| `--dry-run` | `-d` | Preview matches, prices & totals without touching cart | `fm -d` |
| `--store <zip\|id>` | `-s` | Override store location for this run | `fm -s 98029` |
| `--prefer <type>` | | Brand/diet priority: `store-brand`, `organic`, `lowest-price`, `name-brand` | `fm --prefer organic` |
| `--budget <$$>` | `-b` | Set spending limit; warns if estimated total exceeds budget | `fm -b 75.00` |
| `--format <type>` | `-f` | Output format: `table` or `json` (for cron / scripts) | `fm -f json` |
| `--sync` | | Write back resolved Kroger Product IDs & latest prices to CSV | `fm --sync` |
| `--yes` | `-y` | Force non-interactive automated order | `fm -y` |
| `--interactive` | `-i` | Force interactive review & edit mode | `fm -i` |
| `--clear-tokens` | | Reset local OAuth token cache | `fm --clear-tokens` |

---

## 💡 Practical Examples

### 1. Interactive Shopping Mode (Default)
```bash
# Review cart table, edit quantities, swap brands, fuzzy-match name edits, and push:
fm
```

### 2. Automated Scheduled Order (For Cron / Scripts)
```bash
# Automatically match items and submit pickup order for 09/10:
fm --list weekly.csv --pickup 09/10

# Sliced with shorthand:
fm -l weekly.csv -p 09/10
```

### 3. Dry-Run with Budget & Brand Preference
```bash
# Match with preference for store brands and check against a $75 budget without ordering:
fm -l weekly.csv --prefer store-brand --budget 75.00 --dry-run
```

### 4. Organic Preference Mode
```bash
# Boost Simple Truth / Organic candidates:
fm -l sample_list.csv --prefer organic -d
```

### 5. JSON Output for Automations / Slack Bots / Dashboards
```bash
# Output full structured JSON:
fm -l weekly.csv --pickup tomorrow --format json --dry-run
```

### 6. Search Catalog & View Product IDs
```bash
fm search "burrata"
fm search "organic milk"
```

### 7. Switch Default Store Location
```bash
fm store 98029
```

---

## ⏰ Cron Automation Guide

To automatically submit your grocery order on a recurring schedule (e.g. every Tuesday at 8:00 AM for Wednesday pickup):

```cron
# Run crontab -e and add:
0 8 * * 2 cd /Users/280001747@bwt3.com/fm && /usr/local/bin/node src/cli.mjs --list sample_list.csv --pickup tomorrow >> cron.log 2>&1
```

---

## 📊 CSV Column Specification

[`fm/sample_list.csv`](file:///Users/280001747@bwt3.com/fm/sample_list.csv):

```csv
item,quantity,notes,productId,price,size
"Flour 5lb bag",1,"","0001111085402","$2.69","5 lb"
"Deli ham",1,"","0022575400000","$13.99","1 lb"
"American white cheese",1,"","0020613510000","$5.00","12 oz"
"Rigatoni",2,"","0001097820050","$4.49","16 oz"
"Farfalle",2,"","0081542101128","$5.79","12 oz"
"Baby spinach",1,"package","0001111091649","$2.49","10 oz"
"Bananas",1,"bunch","0000000004011","$0.55","1 lb"
"Carrots",2,"","0001111091620","$1.49","16 oz"
"Italian parsley",1,"","0000000094901","$1.99","each"
"Celery",1,"","0000000004070","$1.89","1 lb"
"Rainier Cherries",1,"","0000000004258","$7.99","1 lb"
"Burrata",1,"near deli counter on an island","0081794401000","$10.99","8 oz"
"Eggplant",1,"","0000000094081","$3.99","1 lb"
"Low cal drinks",1,"NO DIET CRAP","0081921502357","$5.99","12 fl oz"
"White eggs",1,"18 count","0001111008963","$3.79","18 ct"
```

---

## 🧪 Testing with `curl` (Using `--netrc-file ./.netrc`)

### 1. Fetch App Access Token
```bash
TOKEN=$(curl -s -X POST "https://api.kroger.com/v1/connect/oauth2/token" \
  --netrc-file ./.netrc \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=product.compact" | jq -r .access_token)

echo "App Access Token: $TOKEN"
```

### 2. Search Products at Fred Meyer Issaquah (`70100658`)
```bash
curl -s -X GET "https://api.kroger.com/v1/products?filter.term=burrata&filter.locationId=70100658&filter.limit=3" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" | jq '.data[] | {productId: .productId, brand: .brand, description: .description, price: .items[0].price.regular, size: .items[0].size}'
```

### 3. Lookup Product by Exact Product ID
```bash
curl -s -X GET "https://api.kroger.com/v1/products/0001111086116?filter.locationId=70100658" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" | jq '.data | {productId: .productId, description: .description, price: .items[0].price.regular}'
```
