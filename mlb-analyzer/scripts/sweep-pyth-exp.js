#!/usr/bin/env node
'use strict';

// PYTH_EXP sweep — real-model validation of the strong-fav decomposition's
// primary recommendation (pyth_exp 1.83 → 1.65). Adapted from
// scripts/sweep-woba-blend.js so day-of state reconstruction (bullpen/
// SP/lineup via gameRow.game_date → getBullpenWobaBlended) works the
// same way. Grades on CLOSING LINE (game_log.market_*_ml which is frozen
// at odds_locked_at) not final-score price, matching the discipline
// established by PRs #172/#174. Excludes corrupted rows + contaminated
// v7 dates.
//
// Owner criteria (2026-07-13, PR #174 doc + follow-up):
//   Fit  = Apr-Jun 2026
//   Val  = Jul 2026 (holdout)
//   Sweep pyth_exp ∈ {1.55, 1.60, 1.65, 1.70, 1.75, 1.83}
//   4 gates for ship:
//     (a) Val book ROI improves over baseline (pyth 1.83)
//     (b) Val 1-2pp band ROI not damaged
//     (c) Val big+FAV subset stays positive
//     (d) Val big+DOG+HOME improves
//   PLUS: full-distribution WP calibration curve at 1.65 vs 1.83 —
//     predicted vs realized by WP bucket across ALL games. Gate is
//     "extremes tighten AND middle stays calibrated," not just big-edge.
//     Global exponent change requires the middle to hold.
//
// USAGE:  node scripts/sweep-pyth-exp.js
// Outputs: docs/data/sweep-pyth-exp-grid.tsv, sweep-pyth-exp-calibration.tsv

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

// ---- Contaminated dates + corrupted-row IDs ----
var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];
var corruptRows = db.prepare(
  "SELECT id FROM bet_signals WHERE signal_type='ML' AND closing_line IS NOT NULL AND ("
+ "(market_line > 0 AND closing_line > 0 AND ABS(market_line - closing_line) >= 30) OR "
+ "(market_line < 0 AND closing_line < 0 AND ABS(market_line - closing_line) >= 30) OR "
+ "(market_line > 100 AND closing_line < 0) OR "
+ "(market_line < -100 AND closing_line > 0)"
+ ")"
).all();
var CORRUPT_GAME_KEYS = new Set();
for (var i = 0; i < corruptRows.length; i++) {
  var r = db.prepare("SELECT game_date, game_id FROM bet_signals WHERE id=?").get(corruptRows[i].id);
  CORRUPT_GAME_KEYS.add(r.game_date + '|' + r.game_id);
}
console.log('Corrupted rows: ' + corruptRows.length + ', unique game keys: ' + CORRUPT_GAME_KEYS.size);
console.log('V7 contaminated dates: ' + V7_EXCL.join(', '));

// ---- Helpers ----
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }

// buildGame — same pattern as sweep-woba-blend.js
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

// ---- Games in scope: resolved + closing prices available + clean ----
var effectiveStart = '2026-04-09';
var games = db.prepare(
  "SELECT * FROM game_log gl "
+ "WHERE gl.away_score IS NOT NULL AND gl.home_score IS NOT NULL "
+ "AND gl.market_away_ml IS NOT NULL AND gl.market_home_ml IS NOT NULL "
+ "AND gl.game_date >= ? "
+ "AND gl.away_lineup_json IS NOT NULL AND gl.home_lineup_json IS NOT NULL "
+ "ORDER BY gl.game_date, gl.game_id"
).all(effectiveStart);

// Filter: exclude v7-contaminated + corrupt game_keys
var cleanGames = games.filter(function (g) {
  if (V7_EXCL.indexOf(g.game_date) !== -1) return false;
  if (CORRUPT_GAME_KEYS.has(g.game_date + '|' + g.game_id)) return false;
  return true;
});
console.log('Total resolved games: ' + games.length + ', clean after exclusions: ' + cleanGames.length);

var fitGames = cleanGames.filter(function (g) { return g.game_date >= '2026-04-09' && g.game_date <= '2026-06-30'; });
var valGames = cleanGames.filter(function (g) { return g.game_date >= '2026-07-01'; });
console.log('Fit (Apr-Jun): ' + fitGames.length + ' games');
console.log('Val (Jul):     ' + valGames.length + ' games');

// ---- Base settings + wobaIdx ----
var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
console.log('Current live PYTH_EXP: ' + (base.PYTH_EXP != null ? base.PYTH_EXP : 1.83));

// ---- Signal grading ----
// For each candidate signal from re-run:
//   marketPrice on signal side = game_log.market_*_ml (frozen at odds_locked_at)
//   outcome: from away_score/home_score
//   pnl per $100 stake: standard American ML convention
function gradeSignal(sig, gameRow) {
  if (sig.type !== 'ML') return null; // Only ML this pass — matches ship gates
  var marketLineForSide = sig.side === 'away' ? gameRow.market_away_ml : gameRow.market_home_ml;
  if (marketLineForSide == null) return null;
  var awayWon = gameRow.away_score > gameRow.home_score;
  var homeWon = gameRow.home_score > gameRow.away_score;
  var tied = !awayWon && !homeWon;
  var win;
  if (tied) return { outcome: 'push', pnl: 0, marketLine: marketLineForSide, edge: sig.edge, side: sig.side };
  win = sig.side === 'away' ? awayWon : homeWon;
  var pnl;
  if (win) pnl = marketLineForSide > 0 ? marketLineForSide : 100;
  else pnl = -100;
  return { outcome: win ? 'win' : 'loss', pnl: pnl, marketLine: marketLineForSide, edge: sig.edge, side: sig.side };
}

// ---- Per-run scoring: takes a settings object, iterates games, returns pool stats ----
function scorePool(pool, settings, opts) {
  opts = opts || {};
  var results = [];
  var wpCurve = []; // For calibration: {predP, homeWon}
  var progressEvery = Math.max(50, Math.floor(pool.length / 10));
  for (var gi = 0; gi < pool.length; gi++) {
    if (gi > 0 && gi % progressEvery === 0) {
      process.stdout.write('.');
    }
    var g = pool[gi];
    var built, mr, sigs;
    try {
      built = buildGame(g, settings);
      mr = model.runModel(built, wobaIdx, settings, 'standard', true);
      if (!mr || mr.aML == null || mr.hML == null) continue;
      sigs = model.getSignals(built, mr, settings);
    } catch (e) { continue; }
    // Full-distribution WP for calibration
    var homeWon = g.home_score > g.away_score;
    var awayWon = g.away_score > g.home_score;
    if (homeWon || awayWon) {
      var homeP = impliedP(mr.hML);
      wpCurve.push({ predP: homeP, homeWon: homeWon ? 1 : 0 });
    }
    // Grade emitted signals
    for (var si = 0; si < sigs.length; si++) {
      var sig = sigs[si];
      var graded = gradeSignal(sig, g);
      if (graded) {
        graded.side_is_home = sig.side === 'home';
        var mp = sig.side === 'home' ? impliedP(mr.hML) : impliedP(mr.aML);
        var cp = impliedP(sig.side === 'home' ? g.market_home_ml : g.market_away_ml);
        graded.edge_pp = Math.max(0, (mp - cp) * 100);
        graded.side_is_fav = graded.marketLine < 0;
        results.push(graded);
      }
    }
  }
  return { grades: results, wpCurve: wpCurve };
}

// ---- Aggregate metrics per pool + settings ----
function metricsFrom(grades) {
  var n = grades.length;
  var pnl = 0, w = 0, l = 0, p = 0;
  for (var i = 0; i < n; i++) {
    var g = grades[i];
    if (g.outcome === 'win') w++; else if (g.outcome === 'loss') l++; else p++;
    pnl += g.pnl;
  }
  var roi = n > 0 ? (pnl / (n * 100)) * 100 : 0;
  return { n: n, w: w, l: l, p: p, pnl: pnl, roi: roi };
}
function sliceRoi(grades, filter) {
  var arr = grades.filter(filter);
  return metricsFrom(arr);
}

// ---- Sweep ----
// Reduced to just the two needed for gate scoring — 1.65 target and 1.83
// baseline. Earlier partial-run captured 1.55/1.60 which showed monotonic
// direction (lower exponent → higher ROI). Add back the full sweep when
// running for a more detailed picture; for the ship decision, 1.65 vs 1.83
// is what the 4 gates and the calibration curve compare.
// Owner criteria: fit Apr-Jun / val Jul, sweep pyth_exp ∈ {1.55..1.83}.
// Reduced from the full 6 exponents to just 1.65 target + 1.83 baseline
// for the ship-gate comparison. Extend the list for a broader picture.
var EXPS = [1.65, 1.83];
var rows = [];
console.log('\n=== SWEEP (grading against closing prices from game_log.market_*_ml) ===');
console.log('exp   | Fit book n/ROI    | Val book n/ROI    | Val 1-2pp n/ROI | Val big+FAV n/ROI | Val big+DOG+HOME n/ROI');

// Cache results for calibration comparison
var cachedResults = {};

for (var ei = 0; ei < EXPS.length; ei++) {
  var exp = EXPS[ei];
  var s = Object.assign({}, base, { PYTH_EXP: exp });
  var fitR = scorePool(fitGames, s);
  var valR = scorePool(valGames, s);
  cachedResults[exp] = { fit: fitR, val: valR };
  var fitBook = metricsFrom(fitR.grades);
  var valBook = metricsFrom(valR.grades);
  var val12 = sliceRoi(valR.grades, function (r) { return r.edge_pp >= 1 && r.edge_pp < 2; });
  var valFav = sliceRoi(valR.grades, function (r) { return r.side_is_fav && r.edge_pp >= 6; });
  var valDogHome = sliceRoi(valR.grades, function (r) { return !r.side_is_fav && r.side_is_home && r.edge_pp >= 6; });
  console.log(exp.toFixed(2) + '  | ' + String(fitBook.n).padStart(3) + ' / ' + fitBook.roi.toFixed(1).padStart(6) + '%    | ' + String(valBook.n).padStart(3) + ' / ' + valBook.roi.toFixed(1).padStart(6) + '%    | ' + String(val12.n).padStart(2) + ' / ' + val12.roi.toFixed(1).padStart(6) + '%  | ' + String(valFav.n).padStart(2) + ' / ' + valFav.roi.toFixed(1).padStart(6) + '%    | ' + String(valDogHome.n).padStart(2) + ' / ' + valDogHome.roi.toFixed(1).padStart(6) + '%');
  rows.push({ exp: exp, fit_book: fitBook, val_book: valBook, val_12: val12, val_fav: valFav, val_doghome: valDogHome });
}

// ---- Gate scoring: 1.65 vs baseline 1.83 ----
console.log('\n=== GATE SCORING (pyth_exp 1.65 vs baseline 1.83) ===');
var baseline = rows[rows.length - 1]; // 1.83 is last
var target = rows[0]; // 1.65 is first (reduced sweep to [1.65, 1.83])
console.log('(a) Val book ROI: ' + baseline.val_book.roi.toFixed(2) + '% (baseline) → ' + target.val_book.roi.toFixed(2) + '% (candidate) — delta ' + (target.val_book.roi - baseline.val_book.roi).toFixed(2) + 'pp');
console.log('(b) Val 1-2pp:    ' + baseline.val_12.roi.toFixed(2) + '% n=' + baseline.val_12.n + ' → ' + target.val_12.roi.toFixed(2) + '% n=' + target.val_12.n + ' — delta ' + (target.val_12.roi - baseline.val_12.roi).toFixed(2) + 'pp');
console.log('(c) Val big+FAV:  ' + baseline.val_fav.roi.toFixed(2) + '% n=' + baseline.val_fav.n + ' → ' + target.val_fav.roi.toFixed(2) + '% n=' + target.val_fav.n);
console.log('(d) Val big+DOG+HOME: ' + baseline.val_doghome.roi.toFixed(2) + '% n=' + baseline.val_doghome.n + ' → ' + target.val_doghome.roi.toFixed(2) + '% n=' + target.val_doghome.n);
var gA = target.val_book.roi > baseline.val_book.roi;
var gB = target.val_12.roi >= baseline.val_12.roi - 2;
var gC = target.val_fav.roi >= 0;
var gD = target.val_doghome.roi > baseline.val_doghome.roi;
console.log('\nGates: (a) ' + (gA?'PASS':'FAIL') + '  (b) ' + (gB?'PASS':'FAIL') + '  (c) ' + (gC?'PASS':'FAIL') + '  (d) ' + (gD?'PASS':'FAIL'));
console.log('SHIP DECISION: ' + ((gA && gB && gC && gD) ? '✓ ALL PASS' : '✗ ONE OR MORE FAIL'));

// ---- Full-distribution WP calibration curve ----
console.log('\n=== WP CALIBRATION CURVE (all Fit + Val games, home-team predicted vs realized) ===');
console.log('Global exponent gate: middle buckets must stay calibrated.');
console.log('predWP bucket | n | pred_mean | realized_rate | diff_pp (pyth 1.65) || pred_mean | realized_rate | diff_pp (pyth 1.83)');
var curveLines = ['# WP calibration curve: predicted vs realized by bucket'];
curveLines.push(['pred_bucket','n_1.65','pred_mean_1.65','realized_1.65','diff_pp_1.65','n_1.83','pred_mean_1.83','realized_1.83','diff_pp_1.83'].join('\t'));
function bucketCalib(wpCurve) {
  var buckets = { '.20-.35':[], '.35-.45':[], '.45-.50':[], '.50-.55':[], '.55-.65':[], '.65-.80':[] };
  for (var i = 0; i < wpCurve.length; i++) {
    var w = wpCurve[i].predP;
    var b;
    if (w < 0.35) b = '.20-.35';
    else if (w < 0.45) b = '.35-.45';
    else if (w < 0.50) b = '.45-.50';
    else if (w < 0.55) b = '.50-.55';
    else if (w < 0.65) b = '.55-.65';
    else b = '.65-.80';
    buckets[b].push(wpCurve[i]);
  }
  var out = {};
  var order = ['.20-.35','.35-.45','.45-.50','.50-.55','.55-.65','.65-.80'];
  for (var oi = 0; oi < order.length; oi++) {
    var k = order[oi];
    var arr = buckets[k];
    if (arr.length === 0) {
      out[k] = { n: 0, predMean: 0, realized: 0, diff: 0 };
      continue;
    }
    var pm = arr.reduce(function (a, x) { return a + x.predP; }, 0) / arr.length;
    var r = arr.reduce(function (a, x) { return a + x.homeWon; }, 0) / arr.length;
    out[k] = { n: arr.length, predMean: pm, realized: r, diff: (r - pm) * 100 };
  }
  return out;
}
var expForCurveA = EXPS[0];
var expForCurveB = EXPS.length > 1 ? EXPS[EXPS.length-1] : EXPS[0];
var curve165 = bucketCalib([].concat(cachedResults[expForCurveA].fit.wpCurve, cachedResults[expForCurveA].val.wpCurve));
var curve183 = bucketCalib([].concat(cachedResults[expForCurveB].fit.wpCurve, cachedResults[expForCurveB].val.wpCurve));
var bucketOrder = ['.20-.35','.35-.45','.45-.50','.50-.55','.55-.65','.65-.80'];
for (var bi = 0; bi < bucketOrder.length; bi++) {
  var k = bucketOrder[bi];
  var c65 = curve165[k], c83 = curve183[k];
  console.log(k + '  | ' + String(c65.n).padStart(3) + ' | ' + c65.predMean.toFixed(3) + '    | ' + c65.realized.toFixed(3) + '        | ' + c65.diff.toFixed(1).padStart(6) + 'pp || ' + c83.predMean.toFixed(3) + '    | ' + c83.realized.toFixed(3) + '        | ' + c83.diff.toFixed(1).padStart(6) + 'pp');
  curveLines.push([k, c65.n, c65.predMean.toFixed(4), c65.realized.toFixed(4), c65.diff.toFixed(2), c83.n, c83.predMean.toFixed(4), c83.realized.toFixed(4), c83.diff.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-pyth-exp-calibration.tsv'), curveLines.join('\n'));

// ---- Write grid TSV ----
var gridLines = ['# Pyth sweep — fit Apr-Jun / val Jul, grading on closing_line, clean rows only'];
gridLines.push(['pyth_exp','fit_book_n','fit_book_roi','val_book_n','val_book_roi','val_12_n','val_12_roi','val_fav_n','val_fav_roi','val_doghome_n','val_doghome_roi'].join('\t'));
for (var ri2 = 0; ri2 < rows.length; ri2++) {
  var r = rows[ri2];
  gridLines.push([r.exp, r.fit_book.n, r.fit_book.roi.toFixed(2), r.val_book.n, r.val_book.roi.toFixed(2), r.val_12.n, r.val_12.roi.toFixed(2), r.val_fav.n, r.val_fav.roi.toFixed(2), r.val_doghome.n, r.val_doghome.roi.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-pyth-exp-grid.tsv'), gridLines.join('\n'));

console.log('\nWrote docs/data/sweep-pyth-exp-grid.tsv and sweep-pyth-exp-calibration.tsv');
