# Fred Meyer (Kroger) Shopping List & Cart Automation

This project provides an automated pipeline and CLI tool to convert a local shopping list into a populated Fred Meyer pickup cart using the official **Kroger Developer API**.

---

## 1. Project Overview

- **Goal**: Read an existing list of grocery items with rough quantities, resolve each item to the best matching Fred Meyer product (UPC) for a specific store location, and add all items to the user's Fred Meyer account with `modality: "PICKUP"`.
- **Target Retailer**: Fred Meyer (Kroger Banner).
- **Core API**: [Kroger Developer API](https://developer.kroger.com/) (Products API, Locations API, Cart API).

---

## 2. Architecture & Workflow

```
[Shopping List File] (txt, csv, json, yaml)
        │
        ▼
[List Parser] ── Extracts item name, brand preference, quantity, unit
        │
        ▼
[Locations Service] ── Resolves local store ID (e.g., via ZIP code)
        │
        ▼
[Product Matcher] ── Queries Kroger Products API, scores/selects UPCs
        │
        ▼
[OAuth2 Auth Manager] ── Manages customer tokens (cart.basic:write)
        │
        ▼
[Cart Service] ── Calls PUT /v1/cart/add (modality: "PICKUP")
        │
        ▼
[Ready for Pickup Checkout on fredmeyer.com / app]
```

---

## 3. Kroger Developer API Specifications

### Base URLs
- **Production API**: `https://api.kroger.com/v1`
- **OAuth Token URL**: `https://api.kroger.com/v1/connect/oauth2/token`
- **OAuth Authorization URL**: `https://api.kroger.com/v1/connect/oauth2/authorize`

### Required Scopes
- `product.compact` - Search products and view pricing/stock.
- `cart.basic:write` - Add items to the authenticated customer's cart.
- `profile.compact` - (Optional) Verify user profile.

### Key API Endpoints
1. **Locations Lookup**:
   - `GET /v1/locations?filter.zipCode.near={zip}&filter.chain=FRED_MEYER`
2. **Product Search**:
   - `GET /v1/products?filter.term={query}&filter.locationId={locationId}&filter.limit=5`
3. **Add Items to Cart**:
   - `PUT /v1/cart/add`
   - Payload:
     ```json
     {
       "items": [
         {
           "upc": "0001111041700",
           "quantity": 1,
           "modality": "PICKUP"
         }
       ]
     }
     ```

---

## 4. Planned Directory Structure

```
fm/
├── agents.md               # Context and instructions for AI agents (this file)
├── README.md               # User guide and quickstart
├── .env.example            # Environment variables template
├── requirements.txt        # Python dependencies (or package.json if Node.js)
├── config.yaml             # User config (default store ID, search preferences)
├── src/
│   ├── auth/               # OAuth2 client credentials & customer authorization flow
│   ├── client/             # Kroger API HTTP client wrapper
│   ├── parser/             # Shopping list parsers (text, CSV, markdown)
│   ├── matcher/            # Fuzzy matching & product resolution engine
│   ├── cart/               # Cart submission service
│   └── cli.py              # CLI entry point (search, review, push)
└── data/
    └── sample_list.txt     # Sample shopping list
```

---

## 5. Environment & Configuration

Create a `.env` file in the project root with the following keys:

```env
KROGER_CLIENT_ID=your_client_id_here
KROGER_CLIENT_SECRET=your_client_secret_here
KROGER_REDIRECT_URI=http://localhost:8000/callback
DEFAULT_LOCATION_ID=
DEFAULT_ZIP_CODE=
```

---

## 6. Agent Directives & Implementation Guidelines

When implementing or modifying features in this codebase:
1. **Idempotency & Safety**: Always prompt or display a summary before making mutating API calls to the cart unless explicitly told to run in `--auto` / `--non-interactive` mode.
2. **Unit & Quantity Normalization**: Handle natural quantity expressions (e.g., `2 lbs`, `1 bunch`, `dozen`, `1/2 gal`) and map them sensibly to store packaging quantities.
3. **Token Management**: Cache access and refresh tokens locally in a secure file (e.g., `.token_cache.json`) to avoid re-prompting for browser login on every run.
4. **Fallback Handling**: If a product has multiple matching variants (e.g., store brand vs organic vs name brand), prioritize store brand / lowest price or allow interactive CLI selection.
