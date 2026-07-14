#!/usr/bin/env node
'use strict';

// W_PIT rolling-origin cross-validation with bootstrap confidence intervals.
//
// Owner pushback on PR #181 (combo 7 pilot recommendation): Val:Fit ratio
// 3.1x is an overfit WARNING, not a strength. Robust params show Val≈Fit.
// n=45 val / gate-d n=3 is too thin to commit a global weight.
//
// Before any pilot: decouple W_PIT from SP_WEIGHT, sweep finer, use
// rolling-origin CV, report CIs — is 0.35 a stable optimum across
// multiple holdout windows, or a point estimate on one July sample?
//
// Design:
//   - Universe: PROD bet_signals ML rows (clean, resolved, post-corrupt,
//     pre-v7). Same filter as PR #179 / PR #181 harness. HARD=0.08 pinned.
//   - W_PIT candidates: {0.30, 0.32, 0.35, 0.37, 0.40 baseline, 0.42, 0.45, 0.50}
//     — finer granularity around the 0.35 finding
//   - SP_WEIGHT held at prod baseline 0.80 throughout (decouple)
//   - 3 rolling-origin folds:
//       Fold A: Fit Apr 9 - May 31    Test Jun 1  - Jun 30  (30-day test)
//       Fold B: Fit Apr 9 - Jun 14    Test Jun 15 - Jul 13  (~30-day test)
//       Fold C: Fit Apr 9 - Jun 29    Test Jun 30 - Jul 13  (14-day test)
//   - Per fold × candidate: fit ROI, test ROI, both with bootstrap 95% CIs
//     (1000 resamples of the kept-signal pool with replacement)
//   - Report: is W_PIT=0.35 the optimum in EVERY fold? Does Val ≈ Fit?
//     Ratio 3x is overfit; 1x-1.5x is real.
//
// USAGE: node scripts/sweep-w-pit-rolling-cv.js
// Output: docs/data/sweep-w-pit-rolling-cv.tsv

var fs = require('fs');
var path = require('path');
var q_db  = require('../db/schema');
var q     = q_db.q;
var db    = q_db.db;
var model = require('../services/model');
var jobs  = require('../services/jobs');

var OUT_DIR = path.join(__dirname, '..', 'docs', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

var SNAP_TS = db.prepare("SELECT datetime('now') n").get().n;
console.log('DB snapshot: ' + SNAP_TS + ' UTC');
console.log('W_PIT rolling-origin CV — decoupled from SP_WEIGHT, HARD pinned 0.08');
console.log('');

var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];

var prodSigs = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, "
+ "  bs.market_line, bs.closing_line, bs.model_line AS bs_model_line, "
+ "  bs.outcome AS bs_outcome "
+ "FROM bet_signals bs "
+ "WHERE bs.signal_type='ML' AND bs.outcome IN ('win','loss','push') "
+ "  AND bs.closing_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-04-09' "
+ "  AND NOT ((bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line > 100 AND bs.closing_line < 0) "
+ "        OR (bs.market_line < -100 AND bs.closing_line > 0))"
).all().filter(function (s) { return V7_EXCL.indexOf(s.game_date) === -1; });

console.log('Universe: ' + prodSigs.length + ' clean+non-contaminated ML signals');
console.log('Date range: ' + prodSigs[0].game_date + ' to ' + prodSigs[prodSigs.length-1].game_date);
console.log('');

var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
var PIN_HARD_CAP = 0.08;

function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// buildGame cache — bullpen weights fixed in this sweep, so cache by game only
var builtCache = {};
function buildGame(gameRow) {
  var k = gameRow.game_date + '|' + gameRow.game_id;
  if (builtCache[k]) return builtCache[k];
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '', homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '', homeSp = gameRow.home_sp || '';
  var wProj = base.W_PROJ != null ? base.W_PROJ : 0.65;
  var wAct  = base.W_ACT  != null ? base.W_ACT  : 0.35;
  var bpSR  = base.BP_STRONG_WEIGHT_R != null ? base.BP_STRONG_WEIGHT_R : 0.55;
  var bpWR  = base.BP_WEAK_WEIGHT_R   != null ? base.BP_WEAK_WEIGHT_R   : 0.45;
  var bpSL  = base.BP_STRONG_WEIGHT_L != null ? base.BP_STRONG_WEIGHT_L : 0.35;
  var bpWL  = base.BP_WEAK_WEIGHT_L   != null ? base.BP_WEAK_WEIGHT_L   : 0.65;
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
  var built = Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
  });
  builtCache[k] = built;
  return built;
}

var gameLogCache = {};
function loadGameLog(gd, gid) {
  var k = gd + '|' + gid;
  if (gameLogCache[k]) return gameLogCache[k];
  var row = db.prepare("SELECT * FROM game_log WHERE game_date=? AND game_id=?").get(gd, gid);
  gameLogCache[k] = row || null;
  return row;
}

function pnlFromOutcome(outcome, closingLine) {
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -100;
  return closingLine > 0 ? closingLine : 100;
}

// Precompute cached model outputs per (game, W_PIT) to avoid re-scoring
// the same game repeatedly across folds. Each fold re-uses these.
var modelCache = {};
function runForCandidate(sig, wPit) {
  var k = sig.game_date + '|' + sig.game_id + '|' + wPit;
  if (modelCache[k]) return modelCache[k];
  var gRow = loadGameLog(sig.game_date, sig.game_id);
  if (!gRow || gRow.away_score == null) {
    modelCache[k] = null; return null;
  }
  var s = Object.assign({}, base, { W_PIT: wPit, W_BAT: 1 - wPit });
  try {
    var built = buildGame(gRow);
    var mr = model.runModel(built, wobaIdx, s, 'standard', true);
    modelCache[k] = mr;
    return mr;
  } catch (e) {
    modelCache[k] = null; return null;
  }
}

// Score a pool at a given W_PIT. Returns kept signals with edge + outcome.
function scorePool(pool, wPit) {
  var kept = [];
  var SOFT = base.SIGNAL_EMIT_FLOOR_PP != null ? Number(base.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  var HARD = PIN_HARD_CAP;
  for (var i = 0; i < pool.length; i++) {
    var sig = pool[i];
    var mr = runForCandidate(sig, wPit);
    if (!mr || mr.aML == null || mr.hML == null) continue;
    var newML = sig.signal_side === 'away' ? mr.aML : mr.hML;
    var newP = impliedP(newML);
    var closeP = impliedP(sig.closing_line);
    var newEdge = newP - closeP;
    if (newEdge < SOFT) continue;
    if (newEdge >= HARD) continue;
    kept.push({
      pnl: pnlFromOutcome(sig.bs_outcome, sig.closing_line),
      edge_pp: newEdge * 100,
    });
  }
  return kept;
}

function roi(kept) {
  if (kept.length === 0) return 0;
  var pnl = 0;
  for (var i = 0; i < kept.length; i++) pnl += kept[i].pnl;
  return (pnl / (kept.length * 100)) * 100;
}

// Bootstrap 95% CI on ROI: resample the kept-pool with replacement N times,
// compute ROI for each resample, return 2.5-97.5 percentile.
function bootstrapCI(kept, N) {
  if (kept.length < 2) return { lo: NaN, hi: NaN };
  var samples = [];
  for (var b = 0; b < N; b++) {
    var pnl = 0;
    for (var i = 0; i < kept.length; i++) {
      var idx = Math.floor(Math.random() * kept.length);
      pnl += kept[idx].pnl;
    }
    samples.push((pnl / (kept.length * 100)) * 100);
  }
  samples.sort(function (a, b) { return a - b; });
  return {
    lo: samples[Math.floor(N * 0.025)],
    hi: samples[Math.floor(N * 0.975)],
  };
}

// Folds
var FOLDS = [
  { name: 'A', fit_end: '2026-05-31', test_start: '2026-06-01', test_end: '2026-06-30' },
  { name: 'B', fit_end: '2026-06-14', test_start: '2026-06-15', test_end: '2026-07-13' },
  { name: 'C', fit_end: '2026-06-29', test_start: '2026-06-30', test_end: '2026-07-13' },
];

for (var fi = 0; fi < FOLDS.length; fi++) {
  var f = FOLDS[fi];
  f.fit_sigs  = prodSigs.filter(function (s) { return s.game_date >= '2026-04-09' && s.game_date <= f.fit_end; });
  f.test_sigs = prodSigs.filter(function (s) { return s.game_date >= f.test_start && s.game_date <= f.test_end; });
  console.log('Fold ' + f.name + ': Fit ' + '2026-04-09' + ' to ' + f.fit_end + ' (n=' + f.fit_sigs.length + '), Test ' + f.test_start + ' to ' + f.test_end + ' (n=' + f.test_sigs.length + ')');
}
console.log('');

var W_PIT_GRID = [0.30, 0.32, 0.35, 0.37, 0.40, 0.42, 0.45, 0.50];
var BOOT_N = 1000;

var results = [];  // one row per fold × candidate

console.log('=== SCORING (' + W_PIT_GRID.length + ' candidates × ' + FOLDS.length + ' folds × 2 pools = ' + (W_PIT_GRID.length * FOLDS.length * 2) + ' score-runs; caching by game+W_PIT) ===');

for (var wi = 0; wi < W_PIT_GRID.length; wi++) {
  var wPit = W_PIT_GRID[wi];
  process.stdout.write('W_PIT=' + wPit.toFixed(2) + ' scoring...');
  for (var fi2 = 0; fi2 < FOLDS.length; fi2++) {
    var f = FOLDS[fi2];
    var fitKept  = scorePool(f.fit_sigs,  wPit);
    var testKept = scorePool(f.test_sigs, wPit);
    var fitRoi   = roi(fitKept);
    var testRoi  = roi(testKept);
    var fitCI    = bootstrapCI(fitKept,  BOOT_N);
    var testCI   = bootstrapCI(testKept, BOOT_N);
    // 1-2pp band
    var fit12 = fitKept.filter(function (x) { return x.edge_pp >= 1 && x.edge_pp < 2; });
    var test12 = testKept.filter(function (x) { return x.edge_pp >= 1 && x.edge_pp < 2; });
    var fit12Roi = roi(fit12), test12Roi = roi(test12);
    results.push({
      wPit: wPit, fold: f.name,
      fit_n: fitKept.length, fit_roi: fitRoi, fit_ci_lo: fitCI.lo, fit_ci_hi: fitCI.hi,
      test_n: testKept.length, test_roi: testRoi, test_ci_lo: testCI.lo, test_ci_hi: testCI.hi,
      fit_12_n: fit12.length, fit_12_roi: fit12Roi,
      test_12_n: test12.length, test_12_roi: test12Roi,
      val_fit_ratio: (fitRoi > 0.5) ? (testRoi / fitRoi) : null,  // meaningful only if fit is nontrivially positive
    });
    process.stdout.write(' ' + f.name);
  }
  process.stdout.write(' done\n');
}
console.log('');

// Report table per fold
for (var fi3 = 0; fi3 < FOLDS.length; fi3++) {
  var f = FOLDS[fi3];
  console.log('=== FOLD ' + f.name + ' (fit ' + '2026-04-09' + ' → ' + f.fit_end + '  |  test ' + f.test_start + ' → ' + f.test_end + ') ===');
  console.log('  W_PIT | Fit n | Fit ROI          [95% CI]         | Test n | Test ROI          [95% CI]         | Val:Fit | 1-2pp Fit (n/ROI) | 1-2pp Test (n/ROI)');
  console.log('  ' + '-'.repeat(180));
  for (var wi2 = 0; wi2 < W_PIT_GRID.length; wi2++) {
    var wPit = W_PIT_GRID[wi2];
    var r = results.find(function (x) { return x.wPit === wPit && x.fold === f.name; });
    if (!r) continue;
    var isBase = wPit === 0.40 ? ' *' : '  ';
    var ratioStr = r.val_fit_ratio == null ? '   --' : (r.val_fit_ratio >= 0 ? '+' : '') + r.val_fit_ratio.toFixed(2) + 'x';
    console.log('  ' + wPit.toFixed(2) + isBase +
      '  ' + String(r.fit_n).padStart(4) + '  ' +
      ((r.fit_roi >= 0 ? '+' : '') + r.fit_roi.toFixed(2)).padStart(7) + '%  [' +
      ((r.fit_ci_lo >= 0 ? '+' : '') + r.fit_ci_lo.toFixed(2)).padStart(7) + '%,' +
      ((r.fit_ci_hi >= 0 ? '+' : '') + r.fit_ci_hi.toFixed(2)).padStart(7) + '%]' +
      '  ' + String(r.test_n).padStart(3) + '  ' +
      ((r.test_roi >= 0 ? '+' : '') + r.test_roi.toFixed(2)).padStart(7) + '%  [' +
      ((r.test_ci_lo >= 0 ? '+' : '') + r.test_ci_lo.toFixed(2)).padStart(7) + '%,' +
      ((r.test_ci_hi >= 0 ? '+' : '') + r.test_ci_hi.toFixed(2)).padStart(7) + '%]  ' +
      ratioStr.padStart(7) +
      '  ' + String(r.fit_12_n).padStart(3) + '/' + ((r.fit_12_roi >= 0 ? '+' : '') + r.fit_12_roi.toFixed(2)).padStart(7) + '%' +
      '  ' + String(r.test_12_n).padStart(3) + '/' + ((r.test_12_roi >= 0 ? '+' : '') + r.test_12_roi.toFixed(2)).padStart(7) + '%');
  }
  console.log('');
}

// Cross-fold summary
console.log('=== CROSS-FOLD SUMMARY: is W_PIT=0.35 the optimum in EVERY fold? ===');
console.log('  W_PIT | Fold A test | Fold B test | Fold C test | mean test | test-CI overlap w/ baseline?');
console.log('  ' + '-'.repeat(120));
for (var wi3 = 0; wi3 < W_PIT_GRID.length; wi3++) {
  var wPit = W_PIT_GRID[wi3];
  var byFold = FOLDS.map(function (f) { return results.find(function (r) { return r.wPit === wPit && r.fold === f.name; }); });
  var mean = byFold.reduce(function (a, r) { return a + r.test_roi; }, 0) / byFold.length;
  // Baseline (W_PIT=0.40) CI per fold — overlap with this candidate's CI
  var overlaps = FOLDS.map(function (f) {
    var baseR = results.find(function (r) { return r.wPit === 0.40 && r.fold === f.name; });
    var candR = results.find(function (r) { return r.wPit === wPit && r.fold === f.name; });
    // Overlap if candidate CI contains baseline point estimate OR baseline CI contains candidate point
    var overlap = (candR.test_ci_lo <= baseR.test_roi && baseR.test_roi <= candR.test_ci_hi) ||
                  (baseR.test_ci_lo <= candR.test_roi && candR.test_roi <= baseR.test_ci_hi);
    return overlap ? 'yes' : 'NO';
  });
  var isBase = wPit === 0.40 ? ' *' : '  ';
  console.log('  ' + wPit.toFixed(2) + isBase +
    '  ' + ((byFold[0].test_roi >= 0 ? '+' : '') + byFold[0].test_roi.toFixed(2)).padStart(7) + '%' +
    '     ' + ((byFold[1].test_roi >= 0 ? '+' : '') + byFold[1].test_roi.toFixed(2)).padStart(7) + '%' +
    '     ' + ((byFold[2].test_roi >= 0 ? '+' : '') + byFold[2].test_roi.toFixed(2)).padStart(7) + '%' +
    '     ' + ((mean >= 0 ? '+' : '') + mean.toFixed(2)).padStart(7) + '%' +
    '     A=' + overlaps[0] + ', B=' + overlaps[1] + ', C=' + overlaps[2]);
}
console.log('  * = baseline. "CI overlap w/ baseline" = candidate\'s test CI overlaps baseline\'s test CI → NOT distinguishable from baseline at 95%.');
console.log('');

// Write TSV
var lines = ['# W_PIT rolling-origin CV, HARD=0.08 pinned, SP_WEIGHT=0.80 held'];
lines.push(['w_pit','fold','fit_start','fit_end','test_start','test_end','fit_n','fit_roi','fit_ci_lo','fit_ci_hi','test_n','test_roi','test_ci_lo','test_ci_hi','fit_12_n','fit_12_roi','test_12_n','test_12_roi','val_fit_ratio'].join('\t'));
for (var ri = 0; ri < results.length; ri++) {
  var r = results[ri];
  var f = FOLDS.find(function (x) { return x.name === r.fold; });
  lines.push([
    r.wPit.toFixed(2), r.fold, '2026-04-09', f.fit_end, f.test_start, f.test_end,
    r.fit_n, r.fit_roi.toFixed(2), r.fit_ci_lo.toFixed(2), r.fit_ci_hi.toFixed(2),
    r.test_n, r.test_roi.toFixed(2), r.test_ci_lo.toFixed(2), r.test_ci_hi.toFixed(2),
    r.fit_12_n, r.fit_12_roi.toFixed(2),
    r.test_12_n, r.test_12_roi.toFixed(2),
    r.val_fit_ratio == null ? '' : r.val_fit_ratio.toFixed(2),
  ].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-w-pit-rolling-cv.tsv'), lines.join('\n'));
console.log('Wrote docs/data/sweep-w-pit-rolling-cv.tsv');
console.log('=== DONE ===');
