#!/usr/bin/env node
/**
 * A market gate that kills ML signals must say so. (2026-08-31)
 *
 * THE SYMPTOM. CIN@CHC 08-31: the Total was correctly hard-capped and shown
 * with a pill; the ML showed nothing at all -- no signal, no suppression, no
 * explanation -- while the UI still displayed a market price.
 *
 * THE MECHANISM. signalsForGame nulls the RUNTIME market_*_ml on three
 * conditions (structural pair impossibility, sources disagreeing on the
 * favorite, DH-crossed source rejection) and deliberately leaves the game_log
 * row intact for post-lock immutability. getSignals then sets haveAnyML=false
 * and never pushes an ML signal.
 *
 * outSuppressed was populated ONLY by the edge-cap loop, and that loop
 * iterates over signals that were already pushed. So every gate running
 * BEFORE the push was structurally incapable of producing an audit row or a
 * pill. The operator saw a price and silence.
 *
 * Totals were unaffected throughout, because they run off a separate
 * haveAnyTot gate -- which is exactly the asymmetry that made this visible.
 *
 * SAME DEFECT AS test-edge-sanity-cap's ML failures. That fixture priced its
 * market at +100/+100, which the sanity guard rejects, so its ML path went
 * silent the same way. Repairing the fixture stopped the test failing but did
 * NOT fix this: the silence is reachable in production with real prices.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const model = require(path.join(R, 'services/model'));
const { checkMarketMLPairSanity } = require(path.join(R, 'utils/market-sanity'));

const BASE_SETTINGS = {
  SIGNAL_EMIT_FLOOR_PP: 0.01,
  SIGNAL_EDGE_CAP_ENABLED: true,
  SIGNAL_EDGE_SOFT_CAP_PP: 0.10,
  SIGNAL_EDGE_HARD_CAP_PP: 0.25,
};

// Mirrors what signalsForGame does: reject, stash the reason and the
// pre-null lines, then null the runtime market.
function buildGame(awayMl, homeMl, estTotDriver) {
  const reason = checkMarketMLPairSanity(awayMl, homeMl);
  const g = {
    market_away_ml: reason ? null : awayMl,
    market_home_ml: reason ? null : homeMl,
    market_total: 8.5, over_price: -117, under_price: -104,
    xcheck_total: 8.5, xcheck_over_price: -117, xcheck_under_price: -104,
    xcheck_total_source: 'synthetic',
  };
  if (reason) { g._mlGateReason = reason; g._mlGateRawAway = awayMl; g._mlGateRawHome = homeMl; }
  return g;
}
const MR = { aML: 106, hML: -125, estTot: 11.2 };   // big Total edge, ~5.8pp ML edge

// ---- 1. the reproduction: gated ML, live Total -------------------------
{
  const supp = [];
  const sigs = model.getSignals(buildGame(134, 110), MR, BASE_SETTINGS, supp);
  eq(sigs.filter(s => s.type === 'ML').length, 0, 'gated market emits no ML signal');
  ok(sigs.filter(s => s.type === 'Total').length > 0,
     'the Total still emits -- separate gate, which is why the asymmetry showed');
  eq(supp.length, 1, 'the gate is RECORDED, not silent');
  const g = supp[0];
  ok(g && g.type === 'ML', 'the record is for the ML market');
  ok(g && g.gate === true, 'it is flagged as a gate, not an edge-cap suppression');
  ok(g && /impossible line pair/i.test(String(g.reason)),
     'and it carries the real reason (' + (g ? String(g.reason).slice(0, 40) : 'n/a') + ')');
  eq(g && g.edge, null,
     'edge is NULL -- no edge is invented against a market we just rejected');
  eq(g && g.marketLine, 134, 'the PRE-NULL market line is preserved for the operator');
}

// ---- 2. visible regardless of the edge-cap toggle ----------------------
// A market gate has nothing to do with the cap. If recording it rode inside
// the cap loop it would vanish whenever the cap was switched off, which is
// its default state.
{
  const supp = [];
  model.getSignals(buildGame(134, 110), MR,
    Object.assign({}, BASE_SETTINGS, { SIGNAL_EDGE_CAP_ENABLED: false }), supp);
  eq(supp.length, 1, 'the gate is still recorded with the edge cap DISABLED');
  ok(supp[0] && supp[0].gate === true, 'and still flagged as a gate');
}

// ---- 3. no false positives on a healthy market -------------------------
{
  const supp = [];
  const sigs = model.getSignals(buildGame(134, -155), MR, BASE_SETTINGS, supp);
  ok(sigs.filter(s => s.type === 'ML').length > 0, 'a valid market still emits ML');
  eq(supp.filter(x => x.gate).length, 0, 'and records no gate suppression');
  const ml = sigs.find(s => s.type === 'ML');
  ok(ml && Math.abs(ml.edge - 0.058) < 0.005,
     'the ML edge is ~5.8pp as read off the game (' + (ml ? ml.edge : 'n/a') + ')');
}

// ---- 4. EMISSION IS UNCHANGED -----------------------------------------
// This must not alter what gets priced. Same inputs, with and without the
// gate metadata, must produce identical emitted signals.
{
  const withMeta = buildGame(134, -155);
  const without = buildGame(134, -155);
  delete without._mlGateReason; delete without._mlGateRawAway; delete without._mlGateRawHome;
  const a = model.getSignals(withMeta, MR, BASE_SETTINGS, []);
  const b = model.getSignals(without, MR, BASE_SETTINGS, []);
  eq(JSON.stringify(a), JSON.stringify(b),
     'emitted signals are byte-identical -- this is an audit change, not a pricing change');
}

// ---- 5. a missing outSuppressed must not crash -------------------------
// Backtest callers invoke getSignals with three arguments.
{
  let threw = null;
  try { model.getSignals(buildGame(134, 110), MR, BASE_SETTINGS); }
  catch (e) { threw = e.message; }
  ok(threw === null, 'getSignals survives a caller that passes no outSuppressed array'
     + (threw ? ' (threw: ' + threw + ')' : ''));
}

// ---- 6. the plumbing downstream ---------------------------------------
const jobsSrc = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');

ok(jobsSrc.includes('game._mlGateReason = reason;'),
   'signalsForGame carries the reason through instead of only nulling');
ok(jobsSrc.includes("sup.gate ? 'suppressed_market_gate' : 'suppressed_edge_cap'"),
   'a market gate is audited under its OWN action, so the edge-cap burst alarm stays clean');
ok(apiSrc.includes("action IN ('suppressed_edge_cap','suppressed_market_gate')"),
   'the suppression endpoint returns market-gate rows too');
ok(uiSrc.includes('var isCap ='),
   'the pill tooltip branches on reason rather than asserting "edge cap" for everything');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
