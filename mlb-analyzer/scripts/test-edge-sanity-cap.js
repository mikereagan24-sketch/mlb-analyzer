// Fixture tests for feat/edge-sanity-cap.
//
// 1. Toggle OFF → getSignals output is byte-identical to pre-cap.
// 2. Synthetic 45pp edge → hard-suppressed, audit row logged.
// 3. Synthetic 8pp edge → emitted unchanged (edge_suspect=0).
// 4. Synthetic 15pp edge (SOFT <= edge < HARD) → emitted with
//    edge_suspect=true.
// 5. Invariant guard: HARD > SOFT (settings-schema.js enforces).
//
// Run: node scripts/test-edge-sanity-cap.js

// FIXTURE REPAIRED 2026-08-30.
//
// Every moneyline assertion in this file had been failing while every
// Totals assertion passed, and it was carried as an accepted failure count
// for weeks. The cause was NOT the edge cap.
//
// The fixture priced its synthetic market at +100 / +100. utils/market-sanity
// checkMarketMLPairSanity -- added AFTER this test (27f2ded, the CLE-CIN DH
// incident) -- correctly rejects that pair: both sides positive means no
// favorite in a two-outcome market, implied sum 1.0000. getSignals then sets
// haveAnyML=false and emits no ML signal at all, so every ML assertion failed
// for a reason that had nothing to do with the cap. Totals use a separate
// gate, which is why they were unaffected.
//
// THE PART THAT MATTERED: Test 2's '45pp signal NOT emitted' was PASSING --
// vacuously. No ML signal was emitted for ANY input, so the assertion could
// not fail. The ML half of the edge cap (hard cap, soft cap, edge_suspect)
// has therefore been unverified since 27f2ded shipped.
//
// The market is now -110 / -110 (implied 0.5238 a side, sum 1.0476), which
// passes sanity, and model probabilities are derived as MARKET_P + the edge
// under test rather than hardcoded off a 0.500 baseline.

const model = require('../services/model');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

// Build a game + modelResult that would produce a specific edge magnitude.
// Working backward from the edge formula in getSignals:
//   awayEdge = impliedP(aModel) - impliedP(aMarket)
// If we want awayEdge = X pp on the away side, we set market at some fair
// value and model at a much steeper (or shallower) value. Easiest: pick
// market_away_ml = +100 (implied 0.50) and vary model_away_ml.
function impliedP(ml) {
  const m = Number(ml);
  if (m < 0) return Math.abs(m) / (Math.abs(m) + 100);
  return 100 / (m + 100);
}
function mlForImplied(p) {
  // Given probability p, invert to American odds. p<0.5 = dog (+), p>0.5 = fav (-).
  if (p >= 0.5) return -Math.round(100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

// A market pair that passes checkMarketMLPairSanity. -110/-110 is the
// standard no-lean price; +100/+100 is structurally impossible and is
// rejected before any edge is computed.
const MARKET_ML = -110;
const MARKET_P  = impliedP(MARKET_ML);          // 0.52381
// The model line that produces exactly `edge` probability points on the
// away side against that market.
const modelForEdge = edge => mlForImplied(MARKET_P + edge);

function buildGame(marketAwayMl, marketHomeMl, marketTotal, overPrice, underPrice) {
  return {
    market_away_ml: marketAwayMl,
    market_home_ml: marketHomeMl,
    market_total: marketTotal,
    over_price: overPrice,
    under_price: underPrice,
    xcheck_total: marketTotal, xcheck_over_price: overPrice, xcheck_under_price: underPrice,
    xcheck_total_source: 'synthetic',
  };
}

function buildModel(aML, hML, estTot) {
  return { aML, hML, estTot };
}

// ── Test 0: the fixture's own market must pass sanity ────────────────
// Without this, a future sanity rule can silently empty the ML path again
// and the failures will look like a cap regression. This assertion names
// the real precondition.
console.log('\n=== Test 0: fixture market passes checkMarketMLPairSanity ===');
{
  const { checkMarketMLPairSanity } = require('../utils/market-sanity');
  const verdict = checkMarketMLPairSanity(MARKET_ML, MARKET_ML);
  expect('the synthetic market pair is structurally valid',
    verdict == null, verdict ? String(verdict) : '');
  expect('and the old +100/+100 pair is correctly rejected',
    checkMarketMLPairSanity(100, 100) != null);
}

// ── Test 1: cap disabled → output identical to no-cap ─────────────────
console.log('\n=== Test 1: cap DISABLED — no filtering, no edge_suspect ===');
{
  const marketML = MARKET_ML;
  const modelML  = modelForEdge(0.045);   // 4.5pp edge → below any cap
  const game  = buildGame(marketML, marketML, 8.5, -110, -110);
  const mr    = buildModel(modelML, mlForImplied(MARKET_P), 8.5);
  const settings = { SIGNAL_EMIT_FLOOR_PP: 0.01, SIGNAL_EDGE_CAP_ENABLED: false };
  const supp = [];
  const sigs = model.getSignals(game, mr, settings, supp);
  const awaySig = sigs.find(s => s.type === 'ML' && s.side === 'away');
  expect('emitted an ML away signal', !!awaySig);
  expect('edge is ~4.5pp', awaySig && Math.abs(awaySig.edge - 0.045) < 0.005, awaySig ? 'edge=' + awaySig.edge : '');
  expect('no edge_suspect when disabled', awaySig && awaySig.edge_suspect === undefined);
  expect('no suppressions recorded', supp.length === 0);
}

// ── Test 2: 45pp edge → HARD-cap suppressed ───────────────────────────
console.log('\n=== Test 2: synthetic 45pp edge with cap ENABLED → suppressed ===');
{
  const marketML = MARKET_ML;
  const modelML  = modelForEdge(0.45);   // 45pp edge
  const game  = buildGame(marketML, marketML, 8.5, -110, -110);
  const mr    = buildModel(modelML, mlForImplied(MARKET_P), 8.5);
  const settings = {
    SIGNAL_EMIT_FLOOR_PP: 0.01,
    SIGNAL_EDGE_CAP_ENABLED: true,
    SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
    SIGNAL_EDGE_HARD_CAP_PP: 0.25,
  };
  const supp = [];
  const sigs = model.getSignals(game, mr, settings, supp);
  const awaySig = sigs.find(s => s.type === 'ML' && s.side === 'away');
  expect('45pp signal NOT emitted', !awaySig);
  expect('exactly one suppression recorded', supp.length === 1, 'got ' + supp.length);
  const s = supp[0];
  expect('suppression carries reason=edge_hard_cap', s && s.reason === 'edge_hard_cap');
  expect('suppression has expected edge ~0.45', s && Math.abs(s.edge - 0.45) < 0.01, s ? 'edge=' + s.edge : '');
  expect('suppression carries type/side', s && s.type === 'ML' && s.side === 'away');
}

// ── Test 3: 8pp edge → emitted unchanged (below SOFT cap) ─────────────
console.log('\n=== Test 3: synthetic 8pp edge with cap ENABLED → emit clean ===');
{
  const marketML = MARKET_ML;
  const modelML  = modelForEdge(0.08);   // 8pp edge
  const game  = buildGame(marketML, marketML, 8.5, -110, -110);
  const mr    = buildModel(modelML, mlForImplied(MARKET_P), 8.5);
  const settings = {
    SIGNAL_EMIT_FLOOR_PP: 0.01,
    SIGNAL_EDGE_CAP_ENABLED: true,
    SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
    SIGNAL_EDGE_HARD_CAP_PP: 0.25,
  };
  const supp = [];
  const sigs = model.getSignals(game, mr, settings, supp);
  const awaySig = sigs.find(s => s.type === 'ML' && s.side === 'away');
  expect('8pp signal emitted', !!awaySig);
  expect('edge ~0.08', awaySig && Math.abs(awaySig.edge - 0.08) < 0.005);
  expect('edge_suspect NOT set (below SOFT cap)', awaySig && !awaySig.edge_suspect);
  expect('no suppressions', supp.length === 0);
}

// ── Test 4: 15pp edge → emitted with edge_suspect=true (in [SOFT, HARD)) ─
console.log('\n=== Test 4: synthetic 15pp edge → emit with edge_suspect ===');
{
  const marketML = MARKET_ML;
  const modelML  = modelForEdge(0.15);   // 15pp edge
  const game  = buildGame(marketML, marketML, 8.5, -110, -110);
  const mr    = buildModel(modelML, mlForImplied(MARKET_P), 8.5);
  const settings = {
    SIGNAL_EMIT_FLOOR_PP: 0.01,
    SIGNAL_EDGE_CAP_ENABLED: true,
    SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
    SIGNAL_EDGE_HARD_CAP_PP: 0.25,
  };
  const supp = [];
  const sigs = model.getSignals(game, mr, settings, supp);
  const awaySig = sigs.find(s => s.type === 'ML' && s.side === 'away');
  expect('15pp signal emitted', !!awaySig);
  expect('edge_suspect === true', awaySig && awaySig.edge_suspect === true);
  expect('no suppressions', supp.length === 0);
}

// ── Test 5: Total-side hard cap ─────────────────────────────────────
console.log('\n=== Test 5: Total 45pp edge → hard-suppressed ===');
{
  // Choose estTot high enough that overEdge >> 25pp given TOT_SLOPE=0.08
  // and market -110 juice (implied ~52.4%).
  // modelOverP = 0.5 + runDiff * 0.08 → runDiff=6 → modelOverP=0.98 (clamped to 0.80 by default clamp)
  // overImplied = 110/210 = 0.524
  // overEdge = 0.80 - 0.524 = 0.276 → in [SOFT=0.10, HARD=0.25) → soft flag
  // For >25pp overEdge, need model close to 1.0 and market close to 0 → hard to hit without changing clamp.
  // Use runDiff=100 (unrealistic) + settings.TOT_PROB_HI=0.99 to allow model close to 1.0
  const game  = buildGame(MARKET_ML, MARKET_ML, 8.5, -110, -110);
  const mr    = buildModel(-110, -110, 100);  // absurdly high estTot to force massive overEdge
  const settings = {
    SIGNAL_EMIT_FLOOR_PP: 0.01,
    SIGNAL_EDGE_CAP_ENABLED: true,
    SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
    SIGNAL_EDGE_HARD_CAP_PP: 0.25,
    TOT_SLOPE: 0.08,
    TOT_PROB_LO: 0.001,
    TOT_PROB_HI: 0.999,   // relax clamp so extreme model can produce extreme edge
  };
  const supp = [];
  const sigs = model.getSignals(game, mr, settings, supp);
  const overSig = sigs.find(s => s.type === 'Total' && s.side === 'over');
  expect('Total over 45pp+ NOT emitted', !overSig);
  const suppOver = supp.find(s => s.type === 'Total' && s.side === 'over');
  expect('Total over suppression recorded', !!suppOver);
  expect('Total suppression reason=edge_hard_cap', suppOver && suppOver.reason === 'edge_hard_cap');
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
