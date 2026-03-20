/**
 * update-prices.mjs
 *
 * Fetches year-to-date average prices for Gold, Silver, WTI and Brent,
 * then patches the last entry in each histPrice array inside index.html.
 *
 * Logic:
 *   - If it's still the current year, replace the last histPrice value
 *     with the live YTD average (so the chart tracks the rolling annual avg).
 *   - If a new year has started and there's no entry for it yet, append
 *     a new year + price + cost entry automatically.
 *
 * Run:  node scripts/update-prices.mjs
 * Env:  EIA_API_KEY   (optional — oil will be skipped if absent)
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const HTML_PATH = path.resolve('index.html');
const CURRENT_YEAR = new Date().getFullYear();

// ─── Helpers ────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
}

/**
 * Patch a named array inside the HTML string.
 * Replaces the last value if the last year matches currentYear,
 * or appends a new [year, price, cost] triplet if the year is new.
 */
function patchArray(html, commodity, newPrice, newYear, newCost) {
  // Match all three arrays for this commodity block
  const blockRe = new RegExp(
    `(${commodity}:\\{[\\s\\S]*?histYears:\\[)([^\\]]+)(\\][\\s\\S]*?histPrice:\\[)([^\\]]+)(\\][\\s\\S]*?histCost:\\[)([^\\]]+)(\\])`,
    'm'
  );
  const m = html.match(blockRe);
  if (!m) {
    console.warn(`⚠️  Could not find arrays for ${commodity}`);
    return html;
  }

  let years  = m[2].trim().split(',').map(Number);
  let prices = m[4].trim().split(',').map(Number);
  let costs  = m[6].trim().split(',').map(Number);

  const lastYear = years[years.length - 1];

  if (lastYear === newYear) {
    // Update the rolling average for the current year
    const oldPrice = prices[prices.length - 1];
    prices[prices.length - 1] = newPrice;
    console.log(`✅ ${commodity} ${newYear}: ${oldPrice} → ${newPrice}`);
  } else if (lastYear < newYear) {
    // New year has started — append a fresh entry
    years.push(newYear);
    prices.push(newPrice);
    costs.push(newCost);
    console.log(`🆕 ${commodity} ${newYear}: appended ${newPrice} (cost ${newCost})`);
  } else {
    console.log(`ℹ️  ${commodity}: lastYear=${lastYear}, skipping (future year?)`);
    return html;
  }

  // Re-serialise
  const newYears  = years.join(',');
  const newPrices = prices.join(',');
  const newCosts  = costs.join(',');

  return html.replace(blockRe,
    `$1${newYears}$3${newPrices}$5${newCosts}$7`
  );
}

// ─── Fetch: Gold & Silver via gold-api.com ───────────────────────────────────

async function fetchMetalYTD(symbol) {
  // gold-api.com /price/<SYMBOL> returns today's price.
  // For YTD average we fetch up to 365 days of daily history.
  // Endpoint: https://api.gold-api.com/price/<SYMBOL>/history?startDate=YYYY-01-01
  const startDate = `${CURRENT_YEAR}-01-01`;
  const url = `https://api.gold-api.com/price/${symbol}/history?startDate=${startDate}`;

  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // API returns array of { date, price } or similar — adapt to actual shape
    let prices = [];
    if (Array.isArray(data)) {
      prices = data.map(d => d.price ?? d.close ?? d.value).filter(Boolean);
    } else if (data.items || data.data) {
      const arr = data.items ?? data.data;
      prices = arr.map(d => d.price ?? d.close ?? d.value).filter(Boolean);
    }

    if (prices.length === 0) {
      // Fallback: just grab today's live price
      const live = await fetch(`https://api.gold-api.com/price/${symbol}`, { timeout: 10000 });
      const ld = await live.json();
      return ld.price ? +ld.price.toFixed(2) : null;
    }

    return avg(prices);
  } catch (err) {
    console.warn(`⚠️  ${symbol} history fetch failed: ${err.message}`);
    // Fallback to live price
    try {
      const live = await fetch(`https://api.gold-api.com/price/${symbol}`, { timeout: 10000 });
      const ld = await live.json();
      return ld.price ? +ld.price.toFixed(2) : null;
    } catch {
      return null;
    }
  }
}

// ─── Fetch: WTI & Brent via EIA ─────────────────────────────────────────────

async function fetchOilYTD(series, apiKey) {
  if (!apiKey) {
    console.warn(`⚠️  EIA_API_KEY not set — skipping ${series}`);
    return null;
  }
  const startDate = `${CURRENT_YEAR}-01-01`;
  const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/`
    + `?api_key=${apiKey}`
    + `&frequency=daily`
    + `&data[0]=value`
    + `&sort[0][column]=period`
    + `&sort[0][direction]=asc`
    + `&start=${startDate}`
    + `&length=365`
    + `&facets[series][]=${series}`;

  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.response?.data ?? [];
    if (!rows.length) return null;
    const prices = rows.map(r => +r.value).filter(v => !isNaN(v) && v > 0);
    return avg(prices);
  } catch (err) {
    console.warn(`⚠️  EIA ${series} fetch failed: ${err.message}`);
    return null;
  }
}

// ─── Default costs for a new year (carried forward from last known) ──────────
// Update these manually each January once AISC/breakeven estimates are published.
const DEFAULT_COSTS = {
  XAU:  1521,
  XAG:  14.5,
  WTI:  42,
  BRENT: 45,
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const eiaKey = process.env.EIA_API_KEY ?? '';

  console.log(`\n📅 Updating prices for year ${CURRENT_YEAR}…\n`);

  const [xauAvg, xagAvg, wtiAvg, brentAvg] = await Promise.all([
    fetchMetalYTD('XAU'),
    fetchMetalYTD('XAG'),
    fetchOilYTD('RWTC',  eiaKey),
    fetchOilYTD('RBRTE', eiaKey),
  ]);

  console.log('\n📊 YTD averages fetched:');
  console.log(`   XAU  : $${xauAvg}`);
  console.log(`   XAG  : $${xagAvg}`);
  console.log(`   WTI  : $${wtiAvg}`);
  console.log(`   BRENT: $${brentAvg}\n`);

  let html = fs.readFileSync(HTML_PATH, 'utf8');

  if (xauAvg)   html = patchArray(html, 'XAU',   xauAvg,   CURRENT_YEAR, DEFAULT_COSTS.XAU);
  if (xagAvg)   html = patchArray(html, 'XAG',   xagAvg,   CURRENT_YEAR, DEFAULT_COSTS.XAG);
  if (wtiAvg)   html = patchArray(html, 'WTI',   wtiAvg,   CURRENT_YEAR, DEFAULT_COSTS.WTI);
  if (brentAvg) html = patchArray(html, 'BRENT', brentAvg, CURRENT_YEAR, DEFAULT_COSTS.BRENT);

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log('\n✍️  index.html patched successfully.\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
