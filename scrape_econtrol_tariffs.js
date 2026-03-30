"use strict";

/**
 * E-Control Tarifkalkulator scraper
 * Scrapes all electricity (POWER) and gas (GAS) tariffs for all grid areas in Austria.
 *
 * Usage:
 *   node scripts/scrape_econtrol_tariffs.js [--energy POWER|GAS|ALL] [--consumption 3500] [--out ./data/econtrol_tariffs.json]
 *
 * No authentication required — the API is public.
 */

const fs = require("fs");
const path = require("path");

const BASE = "https://www.e-control.at/o/rc-public-rest";

// Liferay portal parameters for Preisblatt / ALB downloads (no auth required)
const PORTLET_ID  = "at_econtrol_rc_search_web_RcPublicWebPortlet_INSTANCE_XGD3jX0Z0z2N";
const PAGE_LAYOUT = "1804911";

function preisblattUrl(productId, attachmentType = "PRODUCT_PRICE_INFO") {
  const u = new URL("https://www.e-control.at/c/portal/layout");
  u.searchParams.set("p_l_id",               PAGE_LAYOUT);
  u.searchParams.set("p_p_id",               PORTLET_ID);
  u.searchParams.set("p_p_lifecycle",         "2");
  u.searchParams.set("p_p_resource_id",       "downloadAttachment");
  u.searchParams.set("p_p_cacheability",      "cacheLevelPage");
  u.searchParams.set(`_${PORTLET_ID}_attachmentType`, attachmentType);
  u.searchParams.set(`_${PORTLET_ID}_productId`,      String(productId));
  return u.toString();
}

// Representative PLZs spread across all Austrian states and regions
// Used to discover all unique grid operators / grid areas
const DISCOVERY_PLZS = [
  // Wien
  "1010", "1100", "1200",
  // Niederösterreich
  "2000", "2100", "2340", "2500", "2700", "3100", "3200", "3400", "3500", "3700", "3900",
  // Burgenland
  "7000", "7100", "7200", "7400",
  // Oberösterreich
  "4020", "4100", "4200", "4300", "4400", "4500", "4600", "4700", "4800", "4900",
  // Salzburg
  "5020", "5100", "5200", "5300", "5400", "5500", "5600", "5700",
  // Steiermark
  "8010", "8200", "8400", "8600", "8700", "8900",
  // Kärnten
  "9020", "9100", "9300", "9500", "9800",
  // Tirol
  "6020", "6100", "6200", "6300", "6400", "6500", "6600",
  // Vorarlberg
  "6700", "6750", "6800", "6830", "6840", "6850", "6900",
];

const DEFAULT_POWER_CONSUMPTION = 3500;   // kWh/year (typical household)
const DEFAULT_GAS_CONSUMPTION   = 15000;  // kWh/year (typical household)

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

async function getGridOperators(plz, energyType) {
  const url = `${BASE}/rate-calculator/grid-operators?locale=de&zipCode=${plz}&energyType=${energyType}`;
  const data = await fetchJson(url);
  return data.isZipCodeValid ? (data.gridOperators || []) : [];
}

async function getRatePower(gridOp, consumptionKwh) {
  const url = `${BASE}/rate-calculator/energy-type/POWER/rate?locale=de&isSmartMeter=false`;
  const body = {
    customerGroup: "HOME",
    energyType: "POWER",
    zipCode: parseInt(gridOp.samplePlz, 10),
    gridOperatorId: gridOp.id,
    gridAreaId: gridOp.gridAreaId,
    moveHome: true,
    includeSwitchingDiscounts: false,
    firstMeterOptions: {
      standardConsumption: consumptionKwh,
      smartMeterRequestOptions: {
        smartMeterSearch: false,
        loadProfileUpload: false,
        consumptionType: null,
        calculatedValues: null,
        detailedValues: null,
        lastUploadDate: null,
      },
    },
    membership: null,
    requirements: [],
    priceView: "EUR_PER_YEAR",
    referencePeriod: "ONE_YEAR",
    searchPriceModel: "CLASSIC",
  };
  const data = await fetchJson(url, { method: "POST", body: JSON.stringify(body) });
  if (data.errCode) throw new Error(`API error ${data.errCode}: ${data.errDescription}`);
  return data;
}

async function getRatePowerSpot(gridOp, consumptionKwh) {
  // SPOT_MARKET search: returns dynamic/hourly spot tariffs (priceGuaranteeType=DYNAMIC)
  // priceView=SPOT_MARKET_BREAKDOWN gives both the avg spot component and the fixed margin
  const url = `${BASE}/rate-calculator/energy-type/POWER/rate?locale=de&isSmartMeter=false`;
  const body = {
    customerGroup: "HOME",
    energyType: "POWER",
    zipCode: parseInt(gridOp.samplePlz, 10),
    gridOperatorId: gridOp.id,
    gridAreaId: gridOp.gridAreaId,
    moveHome: true,
    includeSwitchingDiscounts: false,
    firstMeterOptions: {
      standardConsumption: consumptionKwh,
      smartMeterRequestOptions: {
        smartMeterSearch: false,
        loadProfileUpload: false,
        consumptionType: null,
        calculatedValues: null,
        detailedValues: null,
        lastUploadDate: null,
      },
    },
    membership: null,
    requirements: [],
    priceView: "SPOT_MARKET_BREAKDOWN",
    referencePeriod: "ONE_YEAR",
    searchPriceModel: "SPOT_MARKET",
  };
  const data = await fetchJson(url, { method: "POST", body: JSON.stringify(body) });
  if (data.errCode) throw new Error(`API error ${data.errCode}: ${data.errDescription}`);
  return data;
}

async function getRateGas(gridOp, consumptionKwh) {
  const url = `${BASE}/rate-calculator/energy-type/GAS/rate?locale=de`;
  const body = {
    customerGroup: "HOME",
    energyType: "GAS",
    zipCode: parseInt(gridOp.samplePlz, 10),
    gridOperatorId: gridOp.id,
    gridAreaId: gridOp.gridAreaId,
    moveHome: true,
    includeSwitchingDiscounts: false,
    gasRequestOptions: { annualConsumption: consumptionKwh },
    membership: null,
    requirements: [],
    priceView: "EUR_PER_YEAR",
    referencePeriod: "ONE_YEAR",
  };
  const data = await fetchJson(url, { method: "POST", body: JSON.stringify(body) });
  if (data.errCode) throw new Error(`API error ${data.errCode}: ${data.errDescription}`);
  return data;
}

// ---------------------------------------------------------------------------
// Grid area discovery
// ---------------------------------------------------------------------------

async function discoverGridAreas(energyTypes) {
  const seen = new Map(); // key: `${gridAreaId}_${tenantId}` => gridOp info

  console.log(`[discovery] Sampling ${DISCOVERY_PLZS.length} PLZs for energy types: ${energyTypes.join(", ")}`);

  for (const plz of DISCOVERY_PLZS) {
    for (const energyType of energyTypes) {
      try {
        const operators = await getGridOperators(plz, energyType);
        for (const op of operators) {
          const key = `${op.gridAreaId}_${op.tenantId}_${energyType}`;
          if (!seen.has(key)) {
            seen.set(key, {
              energyType,
              gridAreaId: op.gridAreaId,
              id: op.tenantId,          // gridOperatorId for the API call
              name: op.name,
              brandHome: op.brandHome,
              samplePlz: plz,
            });
            console.log(`  [found] ${energyType} grid: ${op.name} (area=${op.gridAreaId}, tenant=${op.tenantId}, plz=${plz})`);
          }
        }
      } catch (err) {
        // PLZ might not be valid or no operators — skip silently
      }
    }
  }

  const result = Array.from(seen.values());
  console.log(`[discovery] Found ${result.length} unique grid area/operator combinations`);
  return result;
}

// ---------------------------------------------------------------------------
// Grid cost / tax normalisation (same for all products in a grid area)
// ---------------------------------------------------------------------------

function normaliseGridCosts(product, gridOp, consumptionKwh, scrapedAt) {
  const gc = product.calculatedGridCosts;
  if (!gc) return null;

  const centToEurMonth = (c) => c != null ? +(c / 100 / 12).toFixed(4) : null;
  const centToCtKwh    = (c) => c != null && consumptionKwh > 0 ? +(c / consumptionKwh).toFixed(6) : null;

  return {
    energy_type: gridOp.energyType,
    grid_area_id: gridOp.gridAreaId,
    grid_operator_id: gridOp.id,
    grid_operator_name: gridOp.name,
    consumption_kwh: consumptionKwh,

    // All calculatedGridCosts values from the API are in Cent/year, NETTO (excl. 20% MwSt).
    // GROSS (inkl. 20% MwSt) is derived by multiplying NETTO × 1.20.
    // Grid network charges — NETTO (API source)
    grid_base_rate_netto_eur_month:  centToEurMonth(gc.gridBaseRate),
    grid_usage_rate_netto_ct_kwh:    centToCtKwh(gc.gridUsageRate),
    grid_loss_rate_netto_ct_kwh:     centToCtKwh(gc.gridLossRate),
    meter_rate_netto_eur_month:      centToEurMonth(gc.meterRateNetSum),
    grid_costs_total_netto_eur_year: gc.gridCostsNetSum != null ? +(gc.gridCostsNetSum / 100).toFixed(2) : null,

    // Grid network charges — GROSS (×1.20)
    grid_base_rate_gross_eur_month:  gc.gridBaseRate   != null ? +(gc.gridBaseRate   / 100 / 12 * 1.2).toFixed(4) : null,
    grid_usage_rate_gross_ct_kwh:    gc.gridUsageRate  != null && consumptionKwh > 0 ? +(gc.gridUsageRate  / consumptionKwh * 1.2).toFixed(6) : null,
    grid_loss_rate_gross_ct_kwh:     gc.gridLossRate   != null && consumptionKwh > 0 ? +(gc.gridLossRate   / consumptionKwh * 1.2).toFixed(6) : null,
    meter_rate_gross_eur_month:      gc.meterRateNetSum != null ? +(gc.meterRateNetSum / 100 / 12 * 1.2).toFixed(4) : null,
    grid_costs_total_gross_eur_year: gc.gridCostsNetSum != null ? +(gc.gridCostsNetSum / 100 * 1.2).toFixed(2) : null,

    // Taxes & levies (Abgaben) — individual breakdown
    // fee.value is NETTO; gross = netto × 1.20
    taxes_total_netto_eur_year: gc.gridFeeNetSum != null ? +(gc.gridFeeNetSum / 100).toFixed(2) : null,
    taxes_total_gross_eur_year: gc.gridFeeNetSum != null ? +(gc.gridFeeNetSum / 100 * 1.2).toFixed(2) : null,
    taxes: (gc.calculatedFees || []).map(fee => ({
      fee_id: fee.id,
      name: fee.name,
      netto_eur_year: +(fee.value / 100).toFixed(4),
      gross_eur_year: +(fee.value / 100 * 1.2).toFixed(4),
      applied_to_energy_rate: fee.appliedToEnergyRate,
      proportional_rate: fee.proportionalRate || null,
    })),

    scraped_at: scrapedAt,
  };
}

// ---------------------------------------------------------------------------
// Product normalisation
// ---------------------------------------------------------------------------

function normaliseProduct(product, gridOp, consumptionKwh, scrapedAt) {
  const costs = product.calculatedProductEnergyCosts || {};
  const contract = product.contractTermInfo || {};
  const annualCentToEurMonth = (cent) => (cent && cent > 0) ? +(cent / 100 / 12).toFixed(4) : null;
  const annualCentToCtKwh = (cent, kwh) => (cent && cent > 0 && kwh > 0) ? +(cent / kwh).toFixed(6) : null;

  // Prices from API are BRUTTO (inkl. 20% MwSt)
  // base_rate: EUR/month gross
  const baseRateGrossEurMonth = costs.baseRate != null
    ? +(costs.baseRate / 100 / 12).toFixed(4)
    : null;

  // energy rate: ct/kWh gross (derive from total energy cost minus base rate)
  const energyCostGrossCent = costs.energyRateTotal != null ? costs.energyRateTotal : null;
  const energyRateGrossCtKwh = energyCostGrossCent != null
    ? +(energyCostGrossCent / consumptionKwh).toFixed(6)
    : null;

  // Annual total gross in EUR
  const annualGrossEur = product.annualGrossRate != null
    ? +(product.annualGrossRate / 100).toFixed(2)
    : null;

  return {
    // Identifiers
    product_id: product.id,
    association_id: product.associationId,
    energy_type: gridOp.energyType,
    product_type: product.productType,      // MAIN / ADDITIONAL

    // Provider
    brand_id: product.brandId,
    brand_name: product.brandName,
    supplier_name: product.supplierName || product.brandName,

    // Product
    product_name: product.productName,

    // Grid info
    grid_area_id: gridOp.gridAreaId,
    grid_operator_id: gridOp.id,
    grid_operator_name: gridOp.name,

    // Pricing (BRUTTO / gross, inkl. 20% MwSt)
    annual_gross_eur: annualGrossEur,
    base_rate_gross_eur_month: baseRateGrossEurMonth,
    energy_rate_gross_ct_kwh: energyRateGrossCtKwh,
    consumption_kwh: consumptionKwh,

    // Derived NETTO (excl. 20% MwSt)
    base_rate_netto_eur_month: baseRateGrossEurMonth != null ? +(baseRateGrossEurMonth / 1.2).toFixed(4) : null,
    energy_rate_netto_ct_kwh: energyRateGrossCtKwh != null ? +(energyRateGrossCtKwh / 1.2).toFixed(6) : null,

    // Contract
    price_guarantee_type: contract.priceGuaranteeType || null, // GUARANTEE|ADJUSTING|NO_GUARANTEE|DYNAMIC
    contract_duration_months: contract.contractDuration || null,
    price_guarantee_months: contract.priceGuarantee || null,
    notice_period_weeks: contract.noticePeriod || null,
    auto_renewal: contract.autoRenewal ?? null,

    // Spot/dynamic market fields (only for priceGuaranteeType=DYNAMIC)
    spot_interval: contract.spotMarketPriceAdjustment?.propName || null, // HOURLY | QUARTER-HOURLY
    stock_exchange_name: contract.stockExchangeIndex?.name || null,
    stock_exchange_link: contract.stockExchangeIndex?.link || null,
    // Margin (fixed markup above spot) in ct/kWh gross — from energyRateTotal
    spot_margin_gross_ct_kwh: energyCostGrossCent != null && consumptionKwh > 0
      ? +(energyCostGrossCent / consumptionKwh).toFixed(6)
      : null,
    spot_margin_netto_ct_kwh: energyCostGrossCent != null && consumptionKwh > 0
      ? +(energyCostGrossCent / consumptionKwh / 1.2).toFixed(6)
      : null,
    // SPOT_MARKET_BREAKDOWN fields: margin+base per kWh (excludes live spot component)
    // avg_margin_plus_base_ct_kwh = averageTotalPriceInCentKWh = (energyMargin + baseRate) / consumption
    avg_margin_plus_base_ct_kwh: product.averageTotalPriceInCentKWh || null,

    // Product properties
    rate_zoning_type: product.rateZoningType || null,
    version_state: product.versionState || null,
    energy_sources: product.energySources
      ? (Array.isArray(product.energySources)
          ? product.energySources.map(s => s.energySourceName || s).join("|")
          : Object.entries(product.energySources).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}%`).join("|"))
      : null,
    combination_type: product.combinationType || null,
    membership_id: product.membershipId || null,

    // Document URLs (no auth required)
    preisblatt_url: preisblattUrl(product.id, "PRODUCT_PRICE_INFO"),
    alb_url:        preisblattUrl(product.id, "PRODUCT_DELIVERY_TERMS"),

    // Meta
    scraped_at: scrapedAt,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };

  const energyArg    = (getArg("--energy", "ALL")).toUpperCase();
  const powerKwh     = parseInt(getArg("--power-consumption", String(DEFAULT_POWER_CONSUMPTION)), 10);
  const gasKwh       = parseInt(getArg("--gas-consumption", String(DEFAULT_GAS_CONSUMPTION)), 10);
  const outFile      = getArg("--out", path.join(__dirname, "../data/econtrol_tariffs.json"));
  const pdfDir       = getArg("--download-pdfs", null);  // if set, download Preisblätter here

  const energyTypes  = energyArg === "ALL" ? ["POWER", "GAS"] : [energyArg];

  console.log("=== E-Control Tariff Scraper ===");
  console.log(`Energy types : ${energyTypes.join(", ")}`);
  console.log(`Consumption  : POWER=${powerKwh} kWh, GAS=${gasKwh} kWh`);
  console.log(`Output       : ${outFile}`);
  console.log("");

  // 1. Discover all grid areas
  const gridAreas = await discoverGridAreas(energyTypes);

  // 2. Fetch tariffs for each grid area
  const allProducts = [];
  const gridCostsMap = new Map(); // key: `${gridAreaId}_${tenantId}_${energyType}`
  const scrapedAt = new Date().toISOString();
  let successCount = 0;
  let errorCount = 0;

  for (const gridOp of gridAreas) {
    const label = `${gridOp.energyType} / ${gridOp.name} (area=${gridOp.gridAreaId})`;
    try {
      const consumptionKwh = gridOp.energyType === "GAS" ? gasKwh : powerKwh;
      let rateData;
      if (gridOp.energyType === "POWER") {
        rateData = await getRatePower(gridOp, powerKwh);
      } else {
        rateData = await getRateGas(gridOp, gasKwh);
      }

      const products = rateData.ratedProducts || [];
      const normalised = products.map(p => normaliseProduct(p, gridOp, consumptionKwh, scrapedAt));
      allProducts.push(...normalised);

      // Extract grid costs from the first product (identical for all in this grid area)
      if (products.length > 0) {
        const gcKey = `${gridOp.gridAreaId}_${gridOp.id}_${gridOp.energyType}`;
        if (!gridCostsMap.has(gcKey)) {
          const gc = normaliseGridCosts(products[0], gridOp, consumptionKwh, scrapedAt);
          if (gc) gridCostsMap.set(gcKey, gc);
        }
      }

      successCount++;
      console.log(`  [ok]  ${label} → ${products.length} classic products`);
    } catch (err) {
      errorCount++;
      console.log(`  [err] ${label} → ${err.message}`);
    }

    // For POWER grid areas: also scrape SPOT_MARKET (dynamic/hourly) tariffs
    if (gridOp.energyType === "POWER") {
      try {
        const spotData = await getRatePowerSpot(gridOp, powerKwh);
        const spotProducts = spotData.ratedProducts || [];
        const normalisedSpot = spotProducts.map(p => normaliseProduct(p, gridOp, powerKwh, scrapedAt));
        allProducts.push(...normalisedSpot);
        if (spotProducts.length > 0) {
          console.log(`  [ok]  ${label} → ${spotProducts.length} spot/dynamic products`);
        }
      } catch (err) {
        console.log(`  [err] ${label} SPOT → ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 200));
  }

  // 3. Deduplicate products by association_id + energy_type (keep first occurrence)
  const seenProds = new Set();
  const deduped = [];
  for (const p of allProducts) {
    const key = `${p.association_id}_${p.energy_type}`;
    if (!seenProds.has(key)) {
      seenProds.add(key);
      deduped.push(p);
    }
  }

  const gridCosts = Array.from(gridCostsMap.values());

  // 4. Summary
  console.log("");
  console.log(`=== Done ===`);
  console.log(`Grid areas   : ${gridAreas.length} (${successCount} ok, ${errorCount} errors)`);
  console.log(`Grid costs   : ${gridCosts.length} entries`);
  console.log(`Products raw : ${allProducts.length}`);
  console.log(`Products deduped: ${deduped.length}`);

  // 5. Save
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const output = {
    scraped_at: scrapedAt,
    energy_types: energyTypes,
    consumption: { power_kwh: powerKwh, gas_kwh: gasKwh },
    grid_areas: gridAreas.map(g => ({ energyType: g.energyType, gridAreaId: g.gridAreaId, id: g.id, name: g.name })),
    grid_costs: gridCosts,
    products: deduped,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf8");
  console.log(`Saved ${deduped.length} products + ${gridCosts.length} grid cost entries to ${outFile}`);

  // 6. Optionally download all Preisblätter
  if (pdfDir) {
    await downloadPreisblatter(deduped, pdfDir);
  }
}

async function downloadPreisblatter(products, pdfDir) {
  fs.mkdirSync(pdfDir, { recursive: true });
  console.log(`\n=== Downloading Preisblätter → ${pdfDir} ===`);

  let ok = 0, missing = 0, errors = 0;
  for (const prod of products) {
    const filename = `${prod.energy_type}_${prod.product_id}_Preisblatt.pdf`;
    const outPath  = path.join(pdfDir, filename);

    // Skip if already downloaded
    if (fs.existsSync(outPath)) { ok++; continue; }

    try {
      const res = await fetch(prod.preisblatt_url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status === 404 || res.status === 204) {
        missing++;
        console.log(`  [--]  ${prod.supplier_name} / ${prod.product_name} → no Preisblatt`);
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      if (!res.ok) {
        errors++;
        console.log(`  [err] ${prod.supplier_name} / ${prod.product_name} → HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      // Check content-disposition for actual filename
      const disposition = res.headers.get("content-disposition") || "";
      const nameMatch   = disposition.match(/filename="([^"]+)"/);
      const actualName  = nameMatch ? nameMatch[1] : filename;
      const actualPath  = path.join(pdfDir, actualName.replace(/[/\\:*?"<>|]/g, "_"));

      const buf = await res.arrayBuffer();
      fs.writeFileSync(actualPath, Buffer.from(buf));
      ok++;
      console.log(`  [ok]  ${prod.supplier_name} / ${prod.product_name} → ${actualName} (${Math.round(buf.byteLength / 1024)} KB)`);
    } catch (err) {
      errors++;
      console.log(`  [err] ${prod.supplier_name} / ${prod.product_name} → ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nPreisblätter: ${ok} downloaded, ${missing} not available, ${errors} errors`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
