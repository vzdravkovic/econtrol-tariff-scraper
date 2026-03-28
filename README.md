# E-Control Tariff Scraper

Scrapes all electricity (Strom) and gas (Gas) tariffs from the Austrian energy regulator's [Tarifkalkulator](https://www.e-control.at/tarifkalkulator) — including classic fixed/floater tariffs, dynamic spot-market tariffs, grid costs, taxes/levies, and Preisblatt PDFs.

**No authentication required.** The E-Control API is fully public.

## What it collects

### Tariffs (`products`)
- **287 deduplicated products** across all 41 Austrian grid areas
- Both **POWER** (Strom) and **GAS** tariffs
- All tariff types:
  - `GUARANTEE` — fixed price
  - `ADJUSTING` — floater (monthly/quarterly adjustment)
  - `NO_GUARANTEE` — no price guarantee
  - `DYNAMIC` — hourly/quarter-hourly spot market (EPEX Spot Day-Ahead)

### Grid costs (`grid_costs`)
- Network charges per grid area (base rate, usage rate, loss rate, meter rate)
- All taxes and levies broken down individually (Gebrauchsabgabe, etc.)
- Both gross (inkl. 20% MwSt) and netto values

### Preisblatt PDFs
- Downloads the official price sheet PDF for every tariff directly from the E-Control portal
- Also supports ALB (Allgemeine Lieferbedingungen) downloads

## Requirements

- Node.js ≥ 18 (uses native `fetch` — no dependencies)

## Usage

```bash
# Scrape everything (POWER + GAS, all grid areas)
node scrape_econtrol_tariffs.js

# POWER only
node scrape_econtrol_tariffs.js --energy POWER

# GAS only
node scrape_econtrol_tariffs.js --energy GAS

# Custom consumption
node scrape_econtrol_tariffs.js --power-consumption 4000 --gas-consumption 20000

# Custom output file
node scrape_econtrol_tariffs.js --out ./my_output.json

# Scrape + download all Preisblatt PDFs
node scrape_econtrol_tariffs.js --download-pdfs ./data/preisblatter
```

## Output format

`data/econtrol_tariffs.json`:

```json
{
  "scraped_at": "2026-03-28T...",
  "energy_types": ["POWER", "GAS"],
  "consumption": { "power_kwh": 3500, "gas_kwh": 15000 },
  "grid_areas": [...],
  "grid_costs": [...],
  "products": [...]
}
```

### Product fields

| Field | Description |
|---|---|
| `product_id` | E-Control internal product ID |
| `association_id` | Association ID (used for deduplication) |
| `energy_type` | `POWER` or `GAS` |
| `price_guarantee_type` | `GUARANTEE` / `ADJUSTING` / `NO_GUARANTEE` / `DYNAMIC` |
| `brand_name` | Provider brand name |
| `supplier_name` | Legal supplier entity |
| `product_name` | Tariff name |
| `grid_area_id` | Grid area ID |
| `grid_operator_name` | Grid operator (e.g. Wiener Netze GmbH) |
| `annual_gross_eur` | Annual cost incl. 20% VAT (at given consumption) |
| `base_rate_gross_eur_month` | Monthly base rate incl. VAT |
| `energy_rate_gross_ct_kwh` | Energy rate ct/kWh incl. VAT (classic) or margin (spot) |
| `base_rate_netto_eur_month` | Monthly base rate excl. VAT |
| `energy_rate_netto_ct_kwh` | Energy rate ct/kWh excl. VAT |
| `contract_duration_months` | Minimum contract duration |
| `price_guarantee_months` | Price guarantee period |
| `energy_sources` | e.g. `RENEWABLE:100%` |
| `spot_interval` | `HOURLY` or `QUARTER-HOURLY` (DYNAMIC tariffs only) |
| `stock_exchange_name` | Exchange used (e.g. `Day-Ahead-Auktion EPEX Spot`) |
| `spot_margin_gross_ct_kwh` | Fixed markup above spot price, ct/kWh incl. VAT |
| `avg_margin_plus_base_ct_kwh` | (margin + base) per kWh — comparable metric for spot tariffs |
| `preisblatt_url` | Direct URL to download the Preisblatt PDF |
| `alb_url` | Direct URL to download the ALB (delivery terms) PDF |

### Pricing notes

- All `_gross_` fields are **BRUTTO** (inkl. 20% MwSt)
- All `_netto_` fields are **NETTO** (excl. MwSt) = gross ÷ 1.20
- For spot tariffs, `energy_rate_gross_ct_kwh` = the fixed **margin/surcharge** above live spot prices, not a fixed total rate

## How it works

1. **Grid area discovery** — samples 61 representative postal codes across all Austrian states to find all 41 unique grid area/operator combinations
2. **Classic tariff scrape** — calls `POST /rate-calculator/energy-type/{POWER|GAS}/rate` with `searchPriceModel: "CLASSIC"` for each grid area
3. **Spot tariff scrape** — calls the same endpoint with `searchPriceModel: "SPOT_MARKET"` + `priceView: "SPOT_MARKET_BREAKDOWN"` for each POWER grid area
4. **Deduplication** — products are deduplicated by `association_id + energy_type` (nationwide tariffs appear once per grid area; only the first occurrence is kept)
5. **Grid costs** — extracted from the first product per grid area (grid charges are identical for all tariffs in the same area)

## API

Base URL: `https://www.e-control.at/o/rc-public-rest`

Key endpoints used:
```
GET  /rate-calculator/grid-operators?locale=de&zipCode={plz}&energyType={POWER|GAS}
POST /rate-calculator/energy-type/POWER/rate?locale=de&isSmartMeter=false
POST /rate-calculator/energy-type/GAS/rate?locale=de
```

Preisblatt PDF downloads via Liferay portal (no auth):
```
GET https://www.e-control.at/c/portal/layout
  ?p_l_id=1804911
  &p_p_id=at_econtrol_rc_search_web_RcPublicWebPortlet_INSTANCE_XGD3jX0Z0z2N
  &p_p_lifecycle=2
  &p_p_resource_id=downloadAttachment
  &p_p_cacheability=cacheLevelPage
  &_at_econtrol_rc_search_web_RcPublicWebPortlet_INSTANCE_XGD3jX0Z0z2N_attachmentType=PRODUCT_PRICE_INFO
  &_at_econtrol_rc_search_web_RcPublicWebPortlet_INSTANCE_XGD3jX0Z0z2N_productId={productId}
```
