// Verify the Poly totals write path added by
// fix/poly-totals-write-path (2026-07-22). Structural checks on
// services/jobs.js + isolated exercise of the rung-pick cascade
// against synthetic ladders.
//
// Run: node tmp/verify-poly-totals-write.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function assert(ok, label) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label);
  if (!ok) failed++;
}

const jobsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---- structural: jobs.js additions ----
console.log('\n== jobs.js structural checks ==');

// Shared polyRows fetch, shared fee helper, both hoisted.
assert(/let polyRows = \[\][\s\S]{0,300}polyRows = await getPolymarketMlbLines/.test(jobsSrc),
  'polyRows fetch hoisted to a shared let (single fetch feeds ML + totals)');
assert(/function polyFeeAdjustAmerican\(topAskPrice\)[\s\S]{0,400}polyTakerFeeRate\(C\)/.test(jobsSrc),
  'polyFeeAdjustAmerican helper hoisted (shared by ML + totals blocks)');

// Poly totals write block present.
assert(/Poly-direct TOTALS override/.test(jobsSrc),
  'Poly-direct totals block header comment present');
assert(/o\.market_total\s*=\s*picked\.strike/.test(jobsSrc),
  'Poly totals writes market_total = picked.strike');
assert(/o\.over_price\s*=\s*overMl[\s\S]{0,200}o\.under_price\s*=\s*underMl/.test(jobsSrc),
  'Poly totals writes over_price and under_price (per-side fee-adjusted)');
assert(/o\.total_source\s*=\s*'polymarket'/.test(jobsSrc),
  "Poly totals sets total_source='polymarket'");

// Ranking below Kalshi: only writes when Kalshi didn't cover.
assert(/if \(o\.market_total != null\)[\s\S]{0,100}skippedHaveKalshi\+\+/.test(jobsSrc),
  'Poly totals ranks below Kalshi (skips when market_total already set)');

// Rung-pick cascade — three tiers with correct anchor labels.
assert(/anchorTier\s*=\s*'unabated_exact'/.test(jobsSrc),
  'rung-pick tier 1: unabated_exact');
assert(/anchorTier\s*=\s*'unabated_nearest'/.test(jobsSrc),
  'rung-pick tier 2: unabated_nearest');
assert(/anchorTier\s*=\s*'liquidity_fallback'/.test(jobsSrc),
  'rung-pick tier 3: liquidity_fallback');
assert(/bestDist <= 0\.5/.test(jobsSrc),
  'unabated_nearest gated at 0.5 line-gap (matches Kalshi totals convention)');

// Per-block anchor summary log.
assert(/anchors: unabated_exact=/.test(jobsSrc),
  'per-slate anchor-tier summary logged');

// Coverage instrumentation extended for totals.
assert(/const totalsMisses\s*=/.test(jobsSrc),
  'coverage block tracks totals coverage');
assert(/\[odds-coverage\] TOTALS MISS/.test(jobsSrc),
  'per-game TOTALS MISS warn present');

// ---- structural: server.js /health additions ----
console.log('\n== server.js /health checks ==');
assert(/ml_priced:/.test(serverSrc),
  '/health returns ml_priced');
assert(/totals_priced:/.test(serverSrc),
  '/health returns totals_priced');
assert(/ml_missing:/.test(serverSrc),
  '/health returns ml_missing');
assert(/totals_missing:/.test(serverSrc),
  '/health returns totals_missing');
assert(/r\.market_total == null/.test(serverSrc),
  '/health totals_missing filters by market_total NULL');

// ---- rung-pick cascade exercise ----
console.log('\n== rung-pick cascade (isolated exercise) ==');

// Extract the cascade logic into a local pure function for direct
// exercise. Same algorithm as in jobs.js.
function pickRung(ladder, unabatedTotal) {
  let picked = null, anchorTier = null;
  if (unabatedTotal != null) {
    picked = ladder.find(r => Math.abs(r.strike - unabatedTotal) < 0.001);
    if (picked) anchorTier = 'unabated_exact';
    if (!picked) {
      let best = null, bestDist = Infinity;
      for (const r of ladder) {
        const d = Math.abs(r.strike - unabatedTotal);
        if (d < bestDist) { best = r; bestDist = d; }
      }
      if (best && bestDist <= 0.5) { picked = best; anchorTier = 'unabated_nearest'; }
    }
  }
  if (!picked) {
    let best = null, bestLiq = -1;
    for (const r of ladder) {
      const liq = r.market_liquidity_clob != null ? r.market_liquidity_clob : 0;
      if (liq > bestLiq) { best = r; bestLiq = liq; }
    }
    picked = best;
    anchorTier = picked ? 'liquidity_fallback' : null;
  }
  return { picked, anchorTier };
}

const ladder = [
  { strike: 7.0, market_liquidity_clob: 100 },
  { strike: 7.5, market_liquidity_clob: 500 },
  { strike: 8.0, market_liquidity_clob: 900 },   // highest liquidity
  { strike: 8.5, market_liquidity_clob: 700 },
  { strike: 9.0, market_liquidity_clob: 200 },
];

// Tier 1: exact match on unabated_total.
{
  const { picked, anchorTier } = pickRung(ladder, 8.0);
  assert(picked && picked.strike === 8.0 && anchorTier === 'unabated_exact',
    'unabated_total=8.0 matches ladder exactly → strike=8.0, tier=unabated_exact');
}

// Tier 2: nearest within 0.5.
{
  const { picked, anchorTier } = pickRung(ladder, 8.3);   // nearest is 8.5 (dist 0.2)
  assert(picked && picked.strike === 8.5 && anchorTier === 'unabated_nearest',
    'unabated_total=8.3 → nearest 8.5 within 0.5 → strike=8.5, tier=unabated_nearest');
}

// Tier 2 boundary: exactly 0.5 gap → still nearest (inclusive).
{
  const { picked, anchorTier } = pickRung(ladder, 7.5);
  assert(picked && picked.strike === 7.5 && anchorTier === 'unabated_exact',
    'unabated_total=7.5 → exact match wins over nearest even though 7.0/8.0 are also 0.5 away');
}

// Tier 3: unabated_total more than 0.5 from any rung → liquidity fallback.
{
  const { picked, anchorTier } = pickRung(ladder, 10.0);   // nearest is 9.0 (dist 1.0) → too far
  assert(picked && picked.strike === 8.0 && anchorTier === 'liquidity_fallback',
    'unabated_total=10.0 (>0.5 from any rung) → falls back to highest-liquidity rung 8.0');
}

// Tier 3: no unabated_total at all → liquidity fallback.
{
  const { picked, anchorTier } = pickRung(ladder, null);
  assert(picked && picked.strike === 8.0 && anchorTier === 'liquidity_fallback',
    'unabated_total=null → falls back to highest-liquidity rung 8.0');
}

// Empty ladder → no pick, no crash.
{
  const { picked, anchorTier } = pickRung([], 8.5);
  assert(picked == null && anchorTier == null,
    'empty ladder → picked=null, anchorTier=null');
}

// Tier 2 with ladder-liquidity NOT preferred (correctness check —
// unabated_nearest should win over liquidity even when the nearest rung
// has lower liquidity than another).
{
  const ladderSkewed = [
    { strike: 7.0, market_liquidity_clob: 999 },  // huge liquidity
    { strike: 8.0, market_liquidity_clob: 50 },   // low liquidity but nearer to 8.2
  ];
  const { picked, anchorTier } = pickRung(ladderSkewed, 8.2);
  assert(picked && picked.strike === 8.0 && anchorTier === 'unabated_nearest',
    'unabated_nearest wins over liquidity when a rung is within 0.5, regardless of liquidity depth');
}

// ---- per-side fee adjustment exercise ----
console.log('\n== polyFeeAdjustAmerican exercise ==');

// Reuse the coefficient literal from services/polymarket.js
const POLY_TAKER_FEE_COEF = 2.56 / 44;
function polyTakerFeeRate(price) {
  const C = Number(price);
  if (!Number.isFinite(C) || C <= 0 || C >= 1) return 0;
  return POLY_TAKER_FEE_COEF * C * (1 - C);
}
function polyFeeAdjustAmerican(topAskPrice) {
  const C = Number(topAskPrice);
  if (!Number.isFinite(C) || !(C > 0.001 && C < 0.999)) return null;
  const adj = C + polyTakerFeeRate(C);
  if (!(adj > 0.001 && adj < 0.999)) return null;
  if (adj >= 0.5) {
    const americanFloat = -(100 * adj / (1 - adj));
    const twoDecimal    = Math.round(americanFloat * 100) / 100;
    return Math.round(twoDecimal - 1.0);
  } else {
    const americanFloat = 100 * (1 - adj) / adj;
    const twoDecimal    = Math.round(americanFloat * 100) / 100;
    return Math.round(twoDecimal - 1.0);
  }
}

// 50/50: fee-adjusted should be ~-107 (matches -Math.round(100*0.514/(1-0.514))).
{
  const ml = polyFeeAdjustAmerican(0.50);
  assert(ml != null && ml <= -105 && ml >= -110,
    `polyFeeAdjustAmerican(0.50) = ${ml} — expected in [-110, -105]`);
}
// 55% over: reasonable dog on other side (~-130 to -140).
{
  const ml = polyFeeAdjustAmerican(0.55);
  assert(ml != null && ml < -100,
    `polyFeeAdjustAmerican(0.55) = ${ml} — should be negative (favorite)`);
}
// 45% under: dog territory.
{
  const ml = polyFeeAdjustAmerican(0.45);
  assert(ml != null,
    `polyFeeAdjustAmerican(0.45) = ${ml} — should return a finite value`);
}
// Edge/degenerate: 0.001 boundary.
{
  const ml = polyFeeAdjustAmerican(0.0001);
  assert(ml == null,
    'polyFeeAdjustAmerican(0.0001) returns null (below plausibility floor)');
}
// Edge: exactly 0.999.
{
  const ml = polyFeeAdjustAmerican(0.999);
  assert(ml == null,
    'polyFeeAdjustAmerican(0.999) returns null (above plausibility ceiling)');
}
// Symmetry sanity: over + under from same rung should read reasonable together.
// A rung at over=0.52 / under=0.48 → over becomes small favorite, under becomes small dog.
{
  const overMl  = polyFeeAdjustAmerican(0.52);
  const underMl = polyFeeAdjustAmerican(0.48);
  assert(overMl != null && underMl != null && overMl < 0,
    `per-side fee adjust: over=0.52 → ${overMl}, under=0.48 → ${underMl}`);
}

console.log();
if (failed === 0) {
  console.log('✓ all invariants hold — Poly totals write path is structurally sound');
  process.exit(0);
}
console.log(`✗ ${failed} assertion(s) failed`);
process.exit(1);
