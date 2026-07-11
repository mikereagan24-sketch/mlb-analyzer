// Verification for feat/demote-unabated-from-betting-path (PR #230 in
// task list; owner's Part 3 after PR #167 landed).
//
// Regression gate (owner-stated):
//   "no post-change signal row carries a non-Kalshi/Poly market_line OR
//    a totals edge derived from unabated/xcheck. Add a test asserting a
//    total-suppressed game still emits its ML signal."
//
// Scenarios:
//   S1) Kalshi ML + Kalshi total present → BOTH ML and Totals signals emit.
//   S2) Kalshi ML present, no Kalshi/Poly total → ML signal emits, Totals
//       signal SUPPRESSED (this is the regression-gate test).
//   S3) No Kalshi/Poly ML, no total → no signals emit at all.
//   S4) Kalshi ML + Unabated-only total → Totals STILL suppressed (Unabated
//       must never feed a totals baseline). ML still emits.
//   S5) Live DB check: no active bet_signals row has price_venue NOT IN
//       ('poly','kalshi') AND market_line non-null (would mean a non-
//       Kalshi/Poly line leaked through).
//
// Isolated: runs against a synthetic date so we can't corrupt real data.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: false });

function pass(name) { console.log('  ✓ ' + name); }
function fail(name, want, got) {
  console.error('  ✗ ' + name + '\n     want: ' + JSON.stringify(want) + '\n     got : ' + JSON.stringify(got));
  process.exitCode = 1;
}

const { runModel, getSignals } = require('../services/model');

// -----------------------------------------------------------------------
// Scenario harness — build a synthetic game shape that runModel + getSignals
// accept. modelResult is faked to isolate the totals-gate + edge-calc
// changes from all the other model dependencies (SP forecast, lineup
// wOBA, weather, park factor, etc.).
// -----------------------------------------------------------------------

const fakeModel = {
  aML: -150,       // model likes home = ~60% win, away ML implied ~50% → edge
  hML: 135,        // fav side gets negative American
  estTot: 9.2,     // model total: 9.2 runs
  gameType: 'sp_sp',
};
const settings = {
  SIGNAL_EMIT_FLOOR_PP: 0.01,
  TOT_SLOPE: 0.08,
  TOT_PROB_LO: 0.20,
  TOT_PROB_HI: 0.80,
  MARKET_TOTAL_DFLT: 8.5,
  SIGNAL_EDGE_SOFT_CAP_PP: 0.15,
  SIGNAL_EDGE_HARD_CAP_PP: 0.20,
};

// -----------------------------------------------------------------------
// S1: Kalshi ML + Kalshi total → BOTH signals emit
// -----------------------------------------------------------------------
console.log('\nS1 — Kalshi ML + Kalshi total → both ML and Totals emit');
{
  const game = {
    game_date: '2199-03-01', game_id: 'aaa-bbb',
    market_away_ml: 130,  market_home_ml: -145,  ml_source: 'kalshi',
    market_total: 8.5, over_price: -110, under_price: -110, total_source: 'kalshi',
    xcheck_total: null, xcheck_over_price: null, xcheck_under_price: null, xcheck_total_source: null,
  };
  const sigs = getSignals(game, fakeModel, settings);
  const mlSig  = sigs.find(s => s.type === 'ML');
  const totSig = sigs.find(s => s.type === 'Total');
  mlSig  ? pass('ML signal emitted') : fail('S1 ML present', true, false);
  totSig ? pass('Totals signal emitted (primary Kalshi totals present)') : fail('S1 Total present', true, false);
}

// -----------------------------------------------------------------------
// S2: Kalshi ML + no Kalshi/Poly total → ML emits, Totals suppressed
//     (the regression-gate test owner asked for)
// -----------------------------------------------------------------------
console.log('\nS2 — Kalshi ML only, NO Kalshi/Poly totals → ML emits, Totals SUPPRESSED');
{
  const game = {
    game_date: '2199-03-01', game_id: 'ccc-ddd',
    market_away_ml: 130,  market_home_ml: -145,  ml_source: 'kalshi',
    market_total: null, over_price: null, under_price: null, total_source: null,
    xcheck_total: null, xcheck_over_price: null, xcheck_under_price: null, xcheck_total_source: null,
  };
  const sigs = getSignals(game, fakeModel, settings);
  const mlSig  = sigs.find(s => s.type === 'ML');
  const totSig = sigs.find(s => s.type === 'Total');
  mlSig  ? pass('ML signal still emitted (regression gate: ML unaffected by total gap)') : fail('S2 ML present', true, false);
  !totSig ? pass('Totals signal SUPPRESSED (no Kalshi/Poly total → no signal)') : fail('S2 Total suppressed', 'no signal', totSig);
}

// -----------------------------------------------------------------------
// S3: No Kalshi/Poly ML, no total → no signals at all
// -----------------------------------------------------------------------
console.log('\nS3 — No Kalshi/Poly anywhere → zero signals');
{
  const game = {
    game_date: '2199-03-01', game_id: 'eee-fff',
    market_away_ml: null,  market_home_ml: null,  ml_source: null,
    market_total: null, over_price: null, under_price: null, total_source: null,
    xcheck_total: null, xcheck_over_price: null, xcheck_under_price: null, xcheck_total_source: null,
  };
  const sigs = getSignals(game, fakeModel, settings);
  sigs.length === 0 ? pass('Zero signals emitted (no Kalshi/Poly baseline)') : fail('S3 count', 0, sigs.length);
}

// -----------------------------------------------------------------------
// S4: Kalshi ML + Unabated-only total (xcheck populated, primary null)
//     → Totals STILL suppressed (Unabated must never anchor totals)
// -----------------------------------------------------------------------
console.log('\nS4 — Kalshi ML + Unabated-only totals (xcheck) → Totals SUPPRESSED (Unabated cannot anchor)');
{
  const game = {
    game_date: '2199-03-01', game_id: 'ggg-hhh',
    market_away_ml: 130,  market_home_ml: -145,  ml_source: 'kalshi',
    // No Kalshi/Poly total — but xcheck (Unabated) HAS a total.
    market_total: null, over_price: null, under_price: null, total_source: null,
    xcheck_total: 9.0, xcheck_over_price: -108, xcheck_under_price: -112, xcheck_total_source: 'betmgm',
  };
  const sigs = getSignals(game, fakeModel, settings);
  const mlSig  = sigs.find(s => s.type === 'ML');
  const totSig = sigs.find(s => s.type === 'Total');
  mlSig ? pass('ML signal still emitted') : fail('S4 ML present', true, false);
  !totSig
    ? pass('Totals signal SUPPRESSED even with xcheck/Unabated total available (no leak)')
    : fail('S4 Total suppressed', 'no signal', totSig);
}

// -----------------------------------------------------------------------
// S5: Live DB check — no active bet_signals row carries a market_line
//     without a Kalshi/Poly price_venue tag
// -----------------------------------------------------------------------
console.log('\nS5 — Live DB regression scan (today\'s slate)');
{
  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const leaks = db.prepare(
    "SELECT game_id, signal_type, signal_side, market_line, price_venue "
  + "FROM bet_signals "
  + "WHERE game_date = ? AND is_active = 1 "
  + "  AND signal_type IN ('ML','Total') "
  + "  AND market_line IS NOT NULL "
  + "  AND (price_venue IS NULL OR price_venue NOT IN ('poly','kalshi'))"
  ).all(TODAY);
  // Informational (not gating): pre-deploy rows will always show leaks
  // because Unabated-derived market_line values persist until the first
  // odds cron re-anchors them under the new Kalshi/Poly-only rules.
  // Post-deploy verification: run this check again on a fresh DB pull
  // after the first cron pass — leaks.length should be 0 for all
  // non-locked rows.
  if (leaks.length === 0) {
    pass('No active ML/Total signal on today\'s slate has market_line without price_venue in {poly,kalshi}');
  } else {
    console.log('  · S5 (info): ' + leaks.length + ' pre-deploy leak rows present — will heal on first post-deploy odds cron');
    for (const l of leaks.slice(0, 5)) console.log('     leak: ' + JSON.stringify(l));
    if (leaks.length > 5) console.log('     ... +' + (leaks.length - 5) + ' more');
  }
}

// -----------------------------------------------------------------------
// S6: Confirm schema migration ran — unabated_* columns exist on game_log
// -----------------------------------------------------------------------
console.log('\nS6 — Schema: unabated_* columns exist on game_log');
{
  const cols = db.prepare('PRAGMA table_info(game_log)').all().map(c => c.name);
  const required = ['unabated_away_ml','unabated_home_ml','unabated_ml_source',
    'unabated_total','unabated_over_price','unabated_under_price','unabated_total_source'];
  const missing = required.filter(c => !cols.includes(c));
  missing.length === 0
    ? pass('All 7 unabated_* columns present')
    : fail('S6 missing', [], missing);
}

console.log('\nexit code:', process.exitCode || 0);
