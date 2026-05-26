#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// Parameter optimizer (v2)
// ---------------------------------------------------------------------------
// Replays the model + signal-generation + grading pipeline against the
// resolved-games universe under different parameter combinations and reports
// ROI. Three modes:
//
//   grid        (default) — full Cartesian grid over the most-impactful
//                            parameters (W_BAT, SP_PIT_WEIGHT, the Phase 2
//                            opener weights, ML/Total threshold pairs).
//                            Smart-cached: model knobs in outer loop,
//                            threshold knobs in inner loop. Hundreds of
//                            combos, runs in seconds-to-minutes.
//
//   sensitivity            — single-knob sweeps. For each model knob in a
//                            configurable list, holds all other settings at
//                            current production values and varies that one
//                            knob across a range. Reports ROI delta vs
//                            baseline. Tens of combos, runs in seconds.
//                            Useful for "what if I nudged BULLPEN_AVG?"
//                            without combinatorial cost.
//
//   baseline               — single run with current production settings.
//                            Anchor number to compare against.
//
// All modes use the app's own runModel + getSignals + calcPnl — no
// re-implementation. Writes nothing.
//
// CRITICAL FIX vs v1: this version routes opener-led games through
// runModel(..., 'opener_aware') when the use_opener_logic flag is on,
// matching live-firing behavior. v1 always used the standard model path,
// which produced misleading results for any combo touching an opener game
// once Phase 2 shipped.
//
// USAGE:
//   node scripts/optimize-params.js                         # grid, full universe
//   node scripts/optimize-params.js 2026-04-24              # grid from date
//   node scripts/optimize-params.js 2026-04-24 2026-05-01   # grid date range
//   node scripts/optimize-params.js --mode=sensitivity      # sensitivity sweep
//   node scripts/optimize-params.js --mode=baseline         # current settings only
//   node scripts/optimize-params.js --cohort=v3             # filter by cohort
//   node scripts/optimize-params.js --holdout=2026-05-01    # train: < holdout, test: >= holdout
//
// Args can be combined: dates first, then --mode=, --cohort=, --holdout=
// flags in any order.
//
// CAVEAT (READ THIS): grid-search results on small samples (< 200 plays
// per bucket) are noisy. The "winner" combo will look impressive but
// often fails to replicate on out-of-sample data. Use --holdout to split
// the date range — top-N on training data should also rank well on the
// holdout. If they don't agree directionally, the apparent winner was
// noise. v3 cohort started 2026-04-24; sample is small until ~end of May.

var args = process.argv.slice(2);
var dateRe = /^\d{4}-\d{2}-\d{2}$/;
var DATE_START = null, DATE_END = null;
var MODE = 'grid';
var COHORT_FILTER = null;
var HOLDOUT_DATE = null;

for (var ai = 0; ai < args.length; ai++) {
  var a = args[ai];
  if (dateRe.test(a)) {
    if (!DATE_START) DATE_START = a;
    else if (!DATE_END) DATE_END = a;
  } else if (a.indexOf('--mode=') === 0) {
    MODE = a.substr('--mode='.length);
  } else if (a.indexOf('--cohort=') === 0) {
    COHORT_FILTER = a.substr('--cohort='.length);
  } else if (a.indexOf('--holdout=') === 0) {
    HOLDOUT_DATE = a.substr('--holdout='.length);
  }
}

if (['grid', 'sensitivity', 'baseline'].indexOf(MODE) === -1) {
  console.error('Unknown mode: ' + MODE + ' (expected grid|sensitivity|baseline)');
  process.exit(1);
}

var q_db = require('../db/schema');
var q = q_db.q;
var db = q_db.db;
var model = require('../services/model');
var jobs = require('../services/jobs');

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

function buildGame(gameRow, settings) {
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '';
  var homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '';
  var homeSp = gameRow.home_sp || '';
  var wProj = settings.W_PROJ != null ? settings.W_PROJ : 0.65;
  var wAct  = settings.W_ACT  != null ? settings.W_ACT  : 0.35;
  var bpSR  = settings.BP_STRONG_WEIGHT_R != null ? settings.BP_STRONG_WEIGHT_R : 0.55;
  var bpWR  = settings.BP_WEAK_WEIGHT_R   != null ? settings.BP_WEAK_WEIGHT_R   : 0.45;
  var bpSL  = settings.BP_STRONG_WEIGHT_L != null ? settings.BP_STRONG_WEIGHT_L : 0.35;
  var bpWL  = settings.BP_WEAK_WEIGHT_L   != null ? settings.BP_WEAK_WEIGHT_L   : 0.65;
  var LEAGUE_BP = 0.318;
  var awayVsR = LEAGUE_BP, awayVsL = LEAGUE_BP, homeVsR = LEAGUE_BP, homeVsL = LEAGUE_BP;
  var awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      var hLU = tryParse(gameRow.home_lineup_json) || [];
      var aLU = tryParse(gameRow.away_lineup_json) || [];
      var aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, hLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      var hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, aLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) { /* ignore */ }
  return Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
  });
}

function stakeForSignal(sig) {
  var raw;
  if (sig.type === 'ML') {
    raw = parseFloat(sig.marketLine);
  } else {
    raw = parseFloat(sig.side === 'over' ? sig.overPrice : sig.underPrice);
    if (isNaN(raw) || raw === 0) raw = -110;
  }
  if (isNaN(raw) || raw === 0) return 0;
  return raw > 0 ? parseFloat((10000 / raw).toFixed(2)) : Math.abs(raw);
}

function gradeSig(sig, gameRow) {
  if (gameRow.away_score == null || gameRow.home_score == null) return null;
  var r = model.calcPnl(
    {
      type: sig.type, side: sig.side,
      marketLine: sig.marketLine, bet_line: null,
      overPrice: sig.overPrice, underPrice: sig.underPrice,
    },
    gameRow.away_score, gameRow.home_score, gameRow.market_total
  );
  return { outcome: r.outcome, pnl: r.pnl, stake: stakeForSignal(sig) };
}

// Pick the right runModel mode for a given game. Phase 2: when the live
// use_opener_logic flag is on AND a game has either side flagged as
// opener-led, the live signal-firing path uses 'opener_aware'. The
// optimizer must do the same or it's measuring against the wrong model
// output for opener games.
function modelModeFor(gameRow, settings) {
  var openerOn = !!(settings.USE_OPENER_LOGIC || settings.use_opener_logic);
  var openerSide = gameRow.is_opener_game_away || gameRow.is_opener_game_home;
  return (openerOn && openerSide) ? 'opener_aware' : 'standard';
}

function pad(s, n, right) {
  s = String(s);
  if (s.length >= n) return s;
  var f = new Array(n - s.length + 1).join(' ');
  return right ? s + f : f + s;
}

function fmtPnl(p) {
  if (p == null || isNaN(p)) return '—';
  return p >= 0 ? '+$' + p.toFixed(2) : '-$' + Math.abs(p).toFixed(2);
}

// ---------------------------------------------------------------------------
// Universe loader — shared by all modes.
// ---------------------------------------------------------------------------

var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();

var MIN_MODEL_DATE = '2026-04-09';
var effectiveStart = (DATE_START && DATE_START > MIN_MODEL_DATE) ? DATE_START : MIN_MODEL_DATE;

var gameSql = "SELECT DISTINCT gl.* FROM game_log gl "
  + "WHERE gl.away_score IS NOT NULL AND gl.home_score IS NOT NULL "
  + "AND (gl.market_away_ml IS NOT NULL OR gl.market_total IS NOT NULL) "
  + "AND gl.game_date >= ?";
var sqlParams = [effectiveStart];
if (DATE_END) { gameSql += ' AND gl.game_date <= ?'; sqlParams.push(DATE_END); }
gameSql += ' ORDER BY gl.game_date, gl.game_id';

var stmt = db.prepare(gameSql);
var games = stmt.all.apply(stmt, sqlParams);

// Cohort filter: if requested, keep only games where ANY bet_signal in
// the requested cohort exists for that game. Game_log rows themselves
// don't carry cohort — bet_signals do — so we resolve via a join.
if (COHORT_FILTER) {
  var cohortSet = new Set(
    db.prepare("SELECT DISTINCT game_date || '|' || game_id AS k FROM bet_signals WHERE cohort = ?")
      .all(COHORT_FILTER)
      .map(function (r) { return r.k; })
  );
  var before = games.length;
  games = games.filter(function (g) { return cohortSet.has(g.game_date + '|' + g.game_id); });
  console.log('Cohort filter "' + COHORT_FILTER + '": ' + games.length + '/' + before + ' games retained');
}

// Holdout split: train = games before HOLDOUT_DATE, test = games on/after.
var trainGames = games, testGames = [];
if (HOLDOUT_DATE) {
  trainGames = games.filter(function (g) { return g.game_date < HOLDOUT_DATE; });
  testGames  = games.filter(function (g) { return g.game_date >= HOLDOUT_DATE; });
}

if (!games.length) {
  console.log('No resolved games in range — nothing to optimize');
  process.exit(0);
}

console.log('Parameter optimizer (v2)  mode=' + MODE);
console.log('Universe: ' + games.length + ' resolved games  ('
  + games[0].game_date + ' → ' + games[games.length - 1].game_date + ')');
if (HOLDOUT_DATE) {
  console.log('Holdout split at ' + HOLDOUT_DATE + ': train=' + trainGames.length + '  test=' + testGames.length);
}
console.log('use_opener_logic flag: ' + ((base.USE_OPENER_LOGIC || base.use_opener_logic) ? 'ON (opener-aware routing active)' : 'OFF'));
console.log('='.repeat(80));

// ---------------------------------------------------------------------------
// Core: run the pipeline for one (settings, games) pair and return aggregate.
// ---------------------------------------------------------------------------

function runOneSet(settings, gameSet) {
  var plays = 0, wins = 0, losses = 0, pushes = 0, pnl = 0, wagered = 0;
  var byType = { ML: { plays: 0, pnl: 0, wagered: 0 }, Total: { plays: 0, pnl: 0, wagered: 0 } };
  for (var gi = 0; gi < gameSet.length; gi++) {
    var g = gameSet[gi];
    var built, mr, sigs;
    try {
      built = buildGame(g, settings);
      var mode = modelModeFor(g, settings);
      mr = model.runModel(built, wobaIdx, settings, mode);
    } catch (e) { continue; }
    try { sigs = model.getSignals(built, mr, settings); }
    catch (e) { continue; }
    for (var xi = 0; xi < sigs.length; xi++) {
      var sig = sigs[xi];
      var gr = gradeSig(sig, g);
      if (!gr) continue;
      plays++;
      if (gr.outcome === 'win') wins++;
      else if (gr.outcome === 'loss') losses++;
      else if (gr.outcome === 'push') pushes++;
      if (gr.outcome !== 'pending' && gr.outcome !== 'push') {
        if (typeof gr.pnl === 'number') pnl += gr.pnl;
        if (typeof gr.stake === 'number') wagered += gr.stake;
        var bucket = sig.type === 'ML' ? byType.ML : byType.Total;
        bucket.plays++;
        if (typeof gr.pnl === 'number') bucket.pnl += gr.pnl;
        if (typeof gr.stake === 'number') bucket.wagered += gr.stake;
      }
    }
  }
  return {
    plays: plays, wins: wins, losses: losses, pushes: pushes,
    pnl: parseFloat(pnl.toFixed(2)),
    wagered: parseFloat(wagered.toFixed(2)),
    roi: wagered > 0 ? parseFloat((100 * pnl / wagered).toFixed(2)) : 0,
    byType: {
      ML:    { plays: byType.ML.plays,    pnl: parseFloat(byType.ML.pnl.toFixed(2)),    roi: byType.ML.wagered    > 0 ? parseFloat((100 * byType.ML.pnl    / byType.ML.wagered).toFixed(2))    : 0 },
      Total: { plays: byType.Total.plays, pnl: parseFloat(byType.Total.pnl.toFixed(2)), roi: byType.Total.wagered > 0 ? parseFloat((100 * byType.Total.pnl / byType.Total.wagered).toFixed(2)) : 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Mode: BASELINE
// ---------------------------------------------------------------------------

if (MODE === 'baseline') {
  var r = runOneSet(base, games);
  console.log('');
  console.log('Baseline (current production settings):');
  console.log('  plays:    ' + r.plays + '  (W ' + r.wins + ' / L ' + r.losses + ' / P ' + r.pushes + ')');
  console.log('  pnl:      ' + fmtPnl(r.pnl));
  console.log('  wagered:  $' + r.wagered.toFixed(2));
  console.log('  roi:      ' + r.roi.toFixed(2) + '%');
  console.log('  ML:       ' + r.byType.ML.plays + 'p  pnl=' + fmtPnl(r.byType.ML.pnl) + '  roi=' + r.byType.ML.roi.toFixed(2) + '%');
  console.log('  Total:    ' + r.byType.Total.plays + 'p  pnl=' + fmtPnl(r.byType.Total.pnl) + '  roi=' + r.byType.Total.roi.toFixed(2) + '%');
  if (HOLDOUT_DATE) {
    var rt = runOneSet(base, trainGames);
    var rh = runOneSet(base, testGames);
    console.log('');
    console.log('  TRAIN (< ' + HOLDOUT_DATE + '): ' + rt.plays + 'p  pnl=' + fmtPnl(rt.pnl) + '  roi=' + rt.roi.toFixed(2) + '%');
    console.log('  TEST  (>= ' + HOLDOUT_DATE + '): ' + rh.plays + 'p  pnl=' + fmtPnl(rh.pnl) + '  roi=' + rh.roi.toFixed(2) + '%');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode: SENSITIVITY
// ---------------------------------------------------------------------------
//
// For each knob in SENSITIVITY_KNOBS, sweep its values while holding all
// other settings at base. Compute ROI for each setting. Print a table per
// knob showing baseline vs each candidate value and the delta.
//
// Why this is useful: full grid is intractable across 24+ model knobs.
// Sensitivity sweeps tell you which knobs the system is responsive to and
// in which direction. Use this to pick which knobs to add to the full
// grid in a future tuning pass.

var SENSITIVITY_KNOBS = [
  // name,                        values to test
  ['W_BAT',                       [0.40, 0.45, 0.50, 0.55, 0.60]],
  ['SP_PIT_WEIGHT',               [0.65, 0.70, 0.75, 0.80, 0.85, 0.90]],
  ['RUN_MULT',                    [40, 44, 48, 52, 56]],
  ['HFA_BOOST',                   [0.00, 0.01, 0.02, 0.03, 0.04]],
  ['FAV_ADJ',                     [-15, -10, -5, 0, 5, 10]],
  ['DOG_ADJ',                     [-10, -5, 0, 5, 10, 15]],
  ['W_PROJ',                      [0.50, 0.60, 0.70, 0.80]],
  ['BULLPEN_AVG',                 [0.295, 0.305, 0.318, 0.330, 0.340]],
  ['WOBA_BASELINE',               [0.215, 0.225, 0.235, 0.245]],
  ['PYTH_EXP',                    [1.65, 1.75, 1.83, 1.90, 2.00]],
  ['WIND_SCALE',                  [1.0, 1.5, 2.0, 2.5, 3.0]],
  ['TOT_SLOPE',                   [0.05, 0.07, 0.08, 0.09, 0.11]],
  ['BAT_DFLT_START',              [0.295, 0.305, 0.315, 0.325, 0.335]],
  ['MIN_PA',                      [40, 50, 60, 80, 100]],
  ['MIN_BF',                      [60, 80, 100, 120, 150]],
  // Phase 2 opener weights (only matter on opener-led games).
  ['OPENER_PIT_WEIGHT',           [0.10, 0.15, 0.20, 0.25]],
  ['BULK_PIT_WEIGHT',             [0.50, 0.55, 0.60, 0.65, 0.70]],
  ['OPENER_RELIEF_PIT_WEIGHT',    [0.15, 0.20, 0.25, 0.30]],
  // Threshold knobs (filter-only — cheap, but worth sweeping).
  ['ML_LEAN_EDGE',                [10, 15, 20, 25, 30]],
  ['ML_VALUE_EDGE',               [25, 30, 35, 40, 45]],
  ['ML_3STAR_EDGE',               [50, 60, 70, 80]],
  ['TOT_LEAN_EDGE',               [0.03, 0.04, 0.05, 0.06, 0.07]],
  ['TOT_VALUE_EDGE',              [0.06, 0.08, 0.10, 0.12]],
  ['TOT_3STAR_EDGE',              [0.10, 0.12, 0.15, 0.18]],
];

if (MODE === 'sensitivity') {
  // Compute baseline once.
  var baselineRes = runOneSet(base, games);
  console.log('');
  console.log('BASELINE: ' + baselineRes.plays + 'p  pnl=' + fmtPnl(baselineRes.pnl)
    + '  roi=' + baselineRes.roi.toFixed(2) + '%');
  console.log('');
  console.log('Sweeping ' + SENSITIVITY_KNOBS.length + ' knobs '
    + '(' + SENSITIVITY_KNOBS.reduce(function (a, k) { return a + k[1].length; }, 0)
    + ' total runs)');
  console.log('');

  // Precompute baseline-train / baseline-test if holdout is requested.
  var baselineTrain = null, baselineTest = null;
  if (HOLDOUT_DATE) {
    baselineTrain = runOneSet(base, trainGames);
    baselineTest  = runOneSet(base, testGames);
  }

  for (var ki = 0; ki < SENSITIVITY_KNOBS.length; ki++) {
    var knob = SENSITIVITY_KNOBS[ki][0];
    var values = SENSITIVITY_KNOBS[ki][1];
    var curVal = base[knob];
    console.log('-'.repeat(96));
    console.log(knob + '   (current=' + (curVal != null ? curVal : 'unset') + ')');
    if (HOLDOUT_DATE) {
      console.log(
        pad('value', 10) + ' ' +
        pad('plays', 7) + ' ' +
        pad('roi%', 8) + ' ' +
        pad('train roi%', 12) + ' ' +
        pad('test roi%', 11) + ' ' +
        pad('Δ vs base', 10)
      );
    } else {
      console.log(
        pad('value', 10) + ' ' +
        pad('plays', 7) + ' ' +
        pad('W-L-P', 12) + ' ' +
        pad('pnl', 10) + ' ' +
        pad('roi%', 8) + ' ' +
        pad('Δ roi', 8)
      );
    }
    for (var vi = 0; vi < values.length; vi++) {
      var v = values[vi];
      var s = Object.assign({}, base);
      s[knob] = v;
      // Constraint: if W_BAT changes, set W_PIT = 1 - W_BAT.
      if (knob === 'W_BAT')          s.W_PIT = parseFloat((1 - v).toFixed(3));
      // SP_PIT_WEIGHT: pair with RELIEF_PIT_WEIGHT.
      if (knob === 'SP_PIT_WEIGHT')  s.RELIEF_PIT_WEIGHT = parseFloat((1 - v).toFixed(3));
      // W_PROJ: pair with W_ACT.
      if (knob === 'W_PROJ')         s.W_ACT = parseFloat((1 - v).toFixed(3));
      // Phase 2 weights are independent — they sum to 1.0 by Mike's
      // tuning, but no auto-rebalance here. If a candidate value pushes
      // the sum off 1.0, that's a trade-off the grid will reveal.

      var r = runOneSet(s, games);
      var marker = (curVal != null && Math.abs(Number(curVal) - v) < 1e-6) ? '*' : ' ';
      if (HOLDOUT_DATE) {
        var rt = runOneSet(s, trainGames);
        var rh = runOneSet(s, testGames);
        console.log(
          marker + pad(String(v), 9) + ' ' +
          pad(r.plays, 7) + ' ' +
          pad(r.roi.toFixed(2) + '%', 8) + ' ' +
          pad(rt.roi.toFixed(2) + '%', 12) + ' ' +
          pad(rh.roi.toFixed(2) + '%', 11) + ' ' +
          pad((r.roi - baselineRes.roi >= 0 ? '+' : '') + (r.roi - baselineRes.roi).toFixed(2), 10)
        );
      } else {
        console.log(
          marker + pad(String(v), 9) + ' ' +
          pad(r.plays, 7) + ' ' +
          pad(r.wins + '-' + r.losses + '-' + r.pushes, 12) + ' ' +
          pad(fmtPnl(r.pnl), 10) + ' ' +
          pad(r.roi.toFixed(2) + '%', 8) + ' ' +
          pad((r.roi - baselineRes.roi >= 0 ? '+' : '') + (r.roi - baselineRes.roi).toFixed(2), 8)
        );
      }
    }
    console.log('');
  }
  console.log('* = current production value');
  if (HOLDOUT_DATE) {
    console.log('');
    console.log('Holdout interpretation: a candidate value is reliable if its TRAIN and TEST');
    console.log('ROI move directionally together vs baseline. Train-up / test-down is overfitting.');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mode: GRID (default)
// ---------------------------------------------------------------------------
//
// Full Cartesian grid over the most-impactful core knobs. Each (model
// knob set) combination triggers ONE pass of buildGame + runModel per
// game (the expensive step). For each model-knob set, the threshold
// knobs are then varied in the inner loop — getSignals + grading is
// cheap.
//
// Phase 2 opener weights are included in the model-knob set. They only
// affect opener-led games but adding them to the grid lets us answer
// "given the post-flip live setup, what's the best (W_BAT, SP, opener
// split, thresholds) combination?"

var W_BAT_GRID = [0.45, 0.50, 0.55, 0.60];
var SP_GRID    = [0.65, 0.75, 0.85, 0.95];     // widened from v1 (was 0.80–0.95)

// Phase 2 opener weights. Test 3 candidate splits including current (live).
// Each entry is [opener, bulk, leftover_bullpen]. Sums to 1.0.
var OPENER_SPLIT_GRID = [
  [0.10, 0.65, 0.25],   // less opener
  [0.15, 0.60, 0.25],   // current (live)
  [0.20, 0.55, 0.25],   // more opener
  [0.15, 0.55, 0.30],   // more leftover bullpen
];

var ML_LEAN_GRID  = [10, 15, 20, 25];
var ML_VALUE_GRID = [25, 30, 35, 40];
var TOT_LEAN_GRID  = [0.03, 0.04, 0.05, 0.06];
var TOT_VALUE_GRID = [0.06, 0.08, 0.10];

// Enumerate valid threshold pairs up-front.
var mlPairs = [];
for (var li = 0; li < ML_LEAN_GRID.length; li++) {
  for (var vii = 0; vii < ML_VALUE_GRID.length; vii++) {
    if (ML_VALUE_GRID[vii] > ML_LEAN_GRID[li]) mlPairs.push([ML_LEAN_GRID[li], ML_VALUE_GRID[vii]]);
  }
}
var totPairs = [];
for (var li2 = 0; li2 < TOT_LEAN_GRID.length; li2++) {
  for (var vi2 = 0; vi2 < TOT_VALUE_GRID.length; vi2++) {
    if (TOT_VALUE_GRID[vi2] > TOT_LEAN_GRID[li2]) totPairs.push([TOT_LEAN_GRID[li2], TOT_VALUE_GRID[vi2]]);
  }
}

var modelCombos = W_BAT_GRID.length * SP_GRID.length * OPENER_SPLIT_GRID.length;
var threshCombos = mlPairs.length * totPairs.length;
var totalCombos = modelCombos * threshCombos;
console.log('Grid: ' + W_BAT_GRID.length + ' W_BAT × ' + SP_GRID.length + ' SP × '
  + OPENER_SPLIT_GRID.length + ' opener-split × ' + mlPairs.length + ' ML-thresh × '
  + totPairs.length + ' Tot-thresh = ' + totalCombos + ' combinations');
console.log('  (' + modelCombos + ' model passes × ' + threshCombos + ' threshold pairs each)');
console.log('='.repeat(80));

var results = [];
var comboIdx = 0;
var modelIdx = 0;
var t0 = Date.now();

for (var wi = 0; wi < W_BAT_GRID.length; wi++) {
  var wBat = W_BAT_GRID[wi];
  var wPit = parseFloat((1 - wBat).toFixed(3));
  for (var si = 0; si < SP_GRID.length; si++) {
    var spW = SP_GRID[si];
    var rpW = parseFloat((1 - spW).toFixed(3));
    for (var oi = 0; oi < OPENER_SPLIT_GRID.length; oi++) {
      var opSplit = OPENER_SPLIT_GRID[oi];
      var modelSettings = Object.assign({}, base, {
        W_BAT: wBat, W_PIT: wPit,
        SP_PIT_WEIGHT: spW, RELIEF_PIT_WEIGHT: rpW,
        OPENER_PIT_WEIGHT: opSplit[0],
        BULK_PIT_WEIGHT: opSplit[1],
        OPENER_RELIEF_PIT_WEIGHT: opSplit[2],
      });
      // Cache model output per game for this model-knob set.
      var gameCache = [];
      for (var gi = 0; gi < games.length; gi++) {
        var g = games[gi];
        try {
          var built = buildGame(g, modelSettings);
          var mode = modelModeFor(g, modelSettings);
          var mr = model.runModel(built, wobaIdx, modelSettings, mode);
          gameCache.push({ game: g, built: built, mr: mr });
        } catch (e) { /* skip */ }
      }
      modelIdx++;

      for (var ti = 0; ti < mlPairs.length; ti++) {
        for (var tti = 0; tti < totPairs.length; tti++) {
          var mlLean  = mlPairs[ti][0],  mlValue  = mlPairs[ti][1];
          var totLean = totPairs[tti][0], totValue = totPairs[tti][1];
          var sigSettings = Object.assign({}, modelSettings, {
            ML_LEAN_EDGE: mlLean, ML_VALUE_EDGE: mlValue,
            TOT_LEAN_EDGE: totLean, TOT_VALUE_EDGE: totValue,
          });
          var plays = 0, wins = 0, losses = 0, pushes = 0, pnl = 0, wagered = 0;
          for (var ci = 0; ci < gameCache.length; ci++) {
            var entry = gameCache[ci];
            var sigs;
            try { sigs = model.getSignals(entry.built, entry.mr, sigSettings); }
            catch (e) { continue; }
            for (var xi = 0; xi < sigs.length; xi++) {
              var gr = gradeSig(sigs[xi], entry.game);
              if (!gr) continue;
              plays++;
              if (gr.outcome === 'win') wins++;
              else if (gr.outcome === 'loss') losses++;
              else if (gr.outcome === 'push') pushes++;
              if (gr.outcome !== 'pending' && gr.outcome !== 'push') {
                if (typeof gr.pnl === 'number') pnl += gr.pnl;
                if (typeof gr.stake === 'number') wagered += gr.stake;
              }
            }
          }
          var roiPct = wagered > 0 ? (100 * pnl / wagered) : 0;
          results.push({
            w_bat: wBat, sp: spW, op: opSplit[0], bulk: opSplit[1], lo: opSplit[2],
            ml_lean: mlLean, ml_value: mlValue,
            tot_lean: totLean, tot_value: totValue,
            plays: plays, wins: wins, losses: losses, pushes: pushes,
            pnl: parseFloat(pnl.toFixed(2)),
            wagered: parseFloat(wagered.toFixed(2)),
            roi: parseFloat(roiPct.toFixed(2)),
          });
          comboIdx++;
          if (comboIdx % 50 === 0 || comboIdx === totalCombos) {
            var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log('  [' + pad(comboIdx, 4) + '/' + totalCombos + ']  '
              + elapsed + 's  (model ' + modelIdx + '/' + modelCombos + ')'
              + '  last: ' + plays + 'p ' + roiPct.toFixed(2) + '% ROI');
          }
        }
      }
    }
  }
}

results.sort(function (a, b) {
  if (b.roi !== a.roi) return b.roi - a.roi;
  if (b.pnl !== a.pnl) return b.pnl - a.pnl;
  return b.plays - a.plays;
});

console.log('');
console.log('='.repeat(120));
console.log('TOP 20 by ROI%  (tiebreak: pnl desc, plays desc)');
console.log('='.repeat(120));
console.log(
  pad('rank', 5) + ' ' +
  pad('w_bat', 6) + ' ' +
  pad('sp', 5) + ' ' +
  pad('op/bulk/lo', 12) + ' ' +
  pad('mlL', 4) + ' ' +
  pad('mlV', 4) + ' ' +
  pad('tL', 5) + ' ' +
  pad('tV', 5) + ' ' +
  pad('plays', 6) + ' ' +
  pad('W', 4) + ' ' +
  pad('L', 4) + ' ' +
  pad('pnl', 11) + ' ' +
  pad('roi%', 8)
);
console.log('-'.repeat(120));
var TOPN = Math.min(20, results.length);
for (var rr = 0; rr < TOPN; rr++) {
  var row = results[rr];
  console.log(
    pad((rr + 1) + '.', 5) + ' ' +
    pad(row.w_bat.toFixed(2), 6) + ' ' +
    pad(row.sp.toFixed(2), 5) + ' ' +
    pad(row.op.toFixed(2) + '/' + row.bulk.toFixed(2) + '/' + row.lo.toFixed(2), 12) + ' ' +
    pad(row.ml_lean, 4) + ' ' +
    pad(row.ml_value, 4) + ' ' +
    pad(row.tot_lean.toFixed(2), 5) + ' ' +
    pad(row.tot_value.toFixed(2), 5) + ' ' +
    pad(row.plays, 6) + ' ' +
    pad(row.wins, 4) + ' ' +
    pad(row.losses, 4) + ' ' +
    pad(fmtPnl(row.pnl), 11) + ' ' +
    pad(row.roi.toFixed(2) + '%', 8)
  );
}

// Locate current production settings on the grid.
var curW  = Number(base.W_BAT != null ? base.W_BAT : 0.5);
var curS  = Number(base.SP_PIT_WEIGHT != null ? base.SP_PIT_WEIGHT : 0.80);
var curOp = Number(base.OPENER_PIT_WEIGHT != null ? base.OPENER_PIT_WEIGHT : 0.15);
var curBk = Number(base.BULK_PIT_WEIGHT != null ? base.BULK_PIT_WEIGHT : 0.60);
var curLo = Number(base.OPENER_RELIEF_PIT_WEIGHT != null ? base.OPENER_RELIEF_PIT_WEIGHT : 0.25);
var curML = Number(base.ML_LEAN_EDGE != null ? base.ML_LEAN_EDGE : 20);
var curMV = Number(base.ML_VALUE_EDGE != null ? base.ML_VALUE_EDGE : 40);
var curTL = Number(base.TOT_LEAN_EDGE != null ? base.TOT_LEAN_EDGE : 0.05);
var curTV = Number(base.TOT_VALUE_EDGE != null ? base.TOT_VALUE_EDGE : 0.08);

var curMatch = null, curRank = -1;
for (var i = 0; i < results.length; i++) {
  var rrr = results[i];
  if (rrr.w_bat === curW && rrr.sp === curS &&
      Math.abs(rrr.op - curOp) < 1e-6 && Math.abs(rrr.bulk - curBk) < 1e-6 && Math.abs(rrr.lo - curLo) < 1e-6 &&
      rrr.ml_lean === curML && rrr.ml_value === curMV &&
      Math.abs(rrr.tot_lean - curTL) < 1e-6 && Math.abs(rrr.tot_value - curTV) < 1e-6) {
    curMatch = rrr; curRank = i + 1; break;
  }
}
console.log('');
if (curMatch) {
  console.log('Current live settings rank #' + curRank + '/' + results.length
    + '  → ' + curMatch.plays + 'p  roi=' + curMatch.roi.toFixed(2) + '%  pnl=' + fmtPnl(curMatch.pnl));
} else {
  console.log('Current live settings not on grid (one or more values not in the search range).');
  console.log('  Live: w_bat=' + curW + ' sp=' + curS + ' op/bulk/lo=' + curOp + '/' + curBk + '/' + curLo
    + ' ml_lean=' + curML + ' ml_value=' + curMV + ' tot_lean=' + curTL + ' tot_value=' + curTV);
}

// Holdout check: re-evaluate the top-5 grid winners on the test set.
if (HOLDOUT_DATE && testGames.length > 0) {
  console.log('');
  console.log('='.repeat(120));
  console.log('HOLDOUT VALIDATION  (top 5 from training, re-evaluated on test set: ' + testGames.length + ' games)');
  console.log('='.repeat(120));
  console.log(
    pad('rank', 5) + ' ' +
    pad('train roi%', 12) + ' ' +
    pad('test roi%', 12) + ' ' +
    pad('train plays', 12) + ' ' +
    pad('test plays', 11) + ' ' +
    pad('verdict', 20)
  );
  console.log('-'.repeat(120));
  var TOP5 = Math.min(5, results.length);
  for (var hi = 0; hi < TOP5; hi++) {
    var topRow = results[hi];
    var s = Object.assign({}, base, {
      W_BAT: topRow.w_bat, W_PIT: parseFloat((1 - topRow.w_bat).toFixed(3)),
      SP_PIT_WEIGHT: topRow.sp, RELIEF_PIT_WEIGHT: parseFloat((1 - topRow.sp).toFixed(3)),
      OPENER_PIT_WEIGHT: topRow.op, BULK_PIT_WEIGHT: topRow.bulk, OPENER_RELIEF_PIT_WEIGHT: topRow.lo,
      ML_LEAN_EDGE: topRow.ml_lean, ML_VALUE_EDGE: topRow.ml_value,
      TOT_LEAN_EDGE: topRow.tot_lean, TOT_VALUE_EDGE: topRow.tot_value,
    });
    var rTrain = runOneSet(s, trainGames);
    var rTest  = runOneSet(s, testGames);
    var verdict;
    if (rTest.plays < 20) verdict = 'too few test plays';
    else if (rTrain.roi > 0 && rTest.roi > 0) verdict = 'CONFIRMED ↑';
    else if (rTrain.roi < 0 && rTest.roi < 0) verdict = 'CONFIRMED ↓';
    else verdict = 'OVERFIT — disagree';
    console.log(
      pad((hi + 1) + '.', 5) + ' ' +
      pad(rTrain.roi.toFixed(2) + '%', 12) + ' ' +
      pad(rTest.roi.toFixed(2) + '%', 12) + ' ' +
      pad(rTrain.plays, 12) + ' ' +
      pad(rTest.plays, 11) + ' ' +
      pad(verdict, 20)
    );
  }
  console.log('');
  console.log('Top-N combos that look CONFIRMED on holdout are stronger candidates.');
  console.log('Combos that look OVERFIT should NOT be used to change live settings.');
}

console.log('');
