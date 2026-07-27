#!/usr/bin/env node
'use strict';

// SP_WEIGHT rolling-origin CV, SPLIT BY OPPOSING-SP HANDEDNESS.
//
// Companion to sweep-sp-weight-rolling-cv.js. Tests the hypothesis from
// docs/sp-weight-benchmark-correction-2026-07-26.md: SP_WEIGHT is a
// handedness-mix parameter (not exposure), and the correct benchmark is
// asymmetric — ~0.86 for R-starter games, ~0.68 for L-starter games. A
// single scalar can't be right for both. If the direction of preferred
// SP_WEIGHT differs by opposing-SP hand — even underpowered, even with
// overlapping CIs — that's corroboration the scalar is structurally
// wrong rather than just mistuned.
//
// Design mirrors sweep-sp-weight-rolling-cv.js exactly:
//   - Same universe filter, same date-excluded v7 days
//   - Same 3 rolling-origin folds
//   - Same 10 SP_WEIGHT candidates (0.60-0.90)
//   - Same HARD=0.08 pin, same W_PIT=0.40 hold, same bootstrap 1000
//
// Adds: for each kept signal, resolve the OPPOSING SP's hand
//   (signal_side='away' → opposing SP = home_sp; 'home' → away_sp).
// Split each fold's kept pool into R-facing / L-facing / unknown, then
// compute ROI + bootstrap CI for each subset separately.
//
// USAGE: node scripts/sweep-sp-weight-rolling-cv-by-hand.js
// Output: docs/data/sweep-sp-weight-rolling-cv-by-hand.tsv

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
console.log('SP_WEIGHT rolling-origin CV, SPLIT BY OPPOSING-SP HAND');
console.log('');

var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];

// Prebuild an SP-name → hand cache from team_rosters. Name-only join
// (name is unique enough in practice; ~5% unresolved go to 'U' bucket).
var handByName = {};
var rosterRows = db.prepare("SELECT DISTINCT player_name, hand FROM team_rosters WHERE role IN ('SP','RP') AND hand IN ('R','L')").all();
rosterRows.forEach(function (r) { handByName[r.player_name] = r.hand; });
console.log('SP hand cache: ' + Object.keys(handByName).length + ' pitcher names resolved');

function spHandForSignal(sig, gRow) {
  var opposingSp = sig.signal_side === 'away' ? gRow.home_sp : gRow.away_sp;
  return handByName[opposingSp] || 'U';
}

var prodSigs = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, "
+ "  bs.market_line, bs.closing_line, bs.model_line AS bs_model_line, "
+ "  bs.outcome AS bs_outcome "
+ "FROM bet_signals bs "
+ "WHERE bs.signal_type='ML' AND bs.outcome IN ('win','loss','push') "
+ "  AND bs.closing_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-04-09' "
+ "  AND bs.contaminated_reason IS NULL "
+ "  AND NOT ((bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line > 100 AND bs.closing_line < 0) "
+ "        OR (bs.market_line < -100 AND bs.closing_line > 0))"
).all().filter(function (s) { return V7_EXCL.indexOf(s.game_date) === -1; });

console.log('Universe: ' + prodSigs.length + ' clean+non-contaminated ML signals');
console.log('');

var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
var PIN_HARD_CAP = 0.08;

function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

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

var modelCache = {};
function runForCandidate(sig, spW) {
  var k = sig.game_date + '|' + sig.game_id + '|' + spW;
  if (modelCache[k]) return modelCache[k];
  var gRow = loadGameLog(sig.game_date, sig.game_id);
  if (!gRow || gRow.away_score == null) {
    modelCache[k] = null; return null;
  }
  var s = Object.assign({}, base, { SP_WEIGHT: spW, RELIEF_WEIGHT: +(1 - spW).toFixed(4) });
  try {
    var built = buildGame(gRow);
    var mr = model.runModel(built, wobaIdx, s, 'standard', true);
    modelCache[k] = mr;
    return mr;
  } catch (e) {
    modelCache[k] = null; return null;
  }
}

// Score a pool at a given SP_WEIGHT. Returns kept signals tagged with
// opposing-SP hand for later split.
function scorePool(pool, spW) {
  var kept = [];
  var SOFT = base.SIGNAL_EMIT_FLOOR_PP != null ? Number(base.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  var HARD = PIN_HARD_CAP;
  for (var i = 0; i < pool.length; i++) {
    var sig = pool[i];
    var mr = runForCandidate(sig, spW);
    if (!mr || mr.aML == null || mr.hML == null) continue;
    var newML = sig.signal_side === 'away' ? mr.aML : mr.hML;
    var newP = impliedP(newML);
    var closeP = impliedP(sig.closing_line);
    var newEdge = newP - closeP;
    if (newEdge < SOFT) continue;
    if (newEdge >= HARD) continue;
    var gRow = loadGameLog(sig.game_date, sig.game_id);
    kept.push({
      pnl: pnlFromOutcome(sig.bs_outcome, sig.closing_line),
      edge_pp: newEdge * 100,
      opp_sp_hand: spHandForSignal(sig, gRow),
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

var SP_WEIGHT_GRID = [0.60, 0.65, 0.70, 0.72, 0.75, 0.77, 0.80, 0.83, 0.85, 0.90];
var BASELINE_SP = 0.80;
var BOOT_N = 1000;

var results = [];  // one row per (fold × candidate × hand-bucket)

console.log('=== SCORING (' + SP_WEIGHT_GRID.length + ' candidates × ' + FOLDS.length + ' folds × 2 pools, split by opp-SP hand) ===');

for (var wi = 0; wi < SP_WEIGHT_GRID.length; wi++) {
  var spW = SP_WEIGHT_GRID[wi];
  process.stdout.write('SP_WEIGHT=' + spW.toFixed(2) + ' scoring...');
  for (var fi2 = 0; fi2 < FOLDS.length; fi2++) {
    var f = FOLDS[fi2];
    var testKept = scorePool(f.test_sigs, spW);
    // Split by opp-SP hand
    ['R', 'L', 'U'].forEach(function (h) {
      var subset = testKept.filter(function (x) { return x.opp_sp_hand === h; });
      var subRoi = roi(subset);
      var subCI  = bootstrapCI(subset, BOOT_N);
      results.push({
        spW: spW, fold: f.name, hand: h,
        test_n: subset.length, test_roi: subRoi,
        test_ci_lo: subCI.lo, test_ci_hi: subCI.hi,
      });
    });
    process.stdout.write(' ' + f.name);
  }
  process.stdout.write(' done\n');
}
console.log('');

// Report table per fold × hand
console.log('=== PER-FOLD × HAND TEST ROI ===');
for (var fi3 = 0; fi3 < FOLDS.length; fi3++) {
  var f = FOLDS[fi3];
  console.log('');
  console.log('--- FOLD ' + f.name + ' (' + f.test_start + ' → ' + f.test_end + ') ---');
  ['R', 'L', 'U'].forEach(function (h) {
    var label = h === 'R' ? 'R-facing (batters face RHP starter)'
              : h === 'L' ? 'L-facing (batters face LHP starter)'
                          : 'Unknown SP hand';
    console.log('  ' + label + ':');
    console.log('    SP_WT | n | Test ROI          [95% CI]');
    for (var wi2 = 0; wi2 < SP_WEIGHT_GRID.length; wi2++) {
      var spW = SP_WEIGHT_GRID[wi2];
      var r = results.find(function (x) { return x.spW === spW && x.fold === f.name && x.hand === h; });
      if (!r) continue;
      var isBase = spW === BASELINE_SP ? ' *' : '  ';
      var ciStr = isNaN(r.test_ci_lo) ? 'CI: n/a'
        : '[' + ((r.test_ci_lo >= 0 ? '+' : '') + r.test_ci_lo.toFixed(2)).padStart(7) + '%,'
        + ((r.test_ci_hi >= 0 ? '+' : '') + r.test_ci_hi.toFixed(2)).padStart(7) + '%]';
      console.log('    ' + spW.toFixed(2) + isBase + '  ' + String(r.test_n).padStart(3) + '  '
        + ((r.test_roi >= 0 ? '+' : '') + r.test_roi.toFixed(2)).padStart(7) + '%  ' + ciStr);
    }
  });
}
console.log('');

// Cross-fold mean test ROI per hand — the key finding
console.log('=== CROSS-FOLD MEAN TEST ROI PER HAND ===');
console.log('  (does the R-facing subset prefer higher SP_WEIGHT, L-facing prefer lower?)');
['R', 'L', 'U'].forEach(function (h) {
  var label = h === 'R' ? 'R-facing' : h === 'L' ? 'L-facing' : 'Unknown';
  console.log('');
  console.log('--- ' + label + ' ---');
  console.log('  SP_WT | Fold A | Fold B | Fold C | mean test ROI (n total)');
  for (var wi3 = 0; wi3 < SP_WEIGHT_GRID.length; wi3++) {
    var spW = SP_WEIGHT_GRID[wi3];
    var byFold = FOLDS.map(function (f) { return results.find(function (r) { return r.spW === spW && r.fold === f.name && r.hand === h; }); });
    var totalN = byFold.reduce(function (a, r) { return a + r.test_n; }, 0);
    // Weighted mean (by n) — otherwise Fold C's tiny n distorts
    var weightedRoi = totalN === 0 ? 0 : byFold.reduce(function (a, r) { return a + r.test_roi * r.test_n; }, 0) / totalN;
    var isBase = spW === BASELINE_SP ? ' *' : '  ';
    console.log('  ' + spW.toFixed(2) + isBase
      + '  ' + ((byFold[0].test_roi >= 0 ? '+' : '') + byFold[0].test_roi.toFixed(2)).padStart(7) + '%'
      + '  ' + ((byFold[1].test_roi >= 0 ? '+' : '') + byFold[1].test_roi.toFixed(2)).padStart(7) + '%'
      + '  ' + ((byFold[2].test_roi >= 0 ? '+' : '') + byFold[2].test_roi.toFixed(2)).padStart(7) + '%'
      + '  ' + ((weightedRoi >= 0 ? '+' : '') + weightedRoi.toFixed(2)).padStart(7) + '%  (n=' + totalN + ')');
  }
});
console.log('');

// Direction summary: for each hand-subset, is the below-baseline mean > above-baseline mean?
console.log('=== DIRECTION SUMMARY BY HAND ===');
['R', 'L'].forEach(function (h) {
  var below = [], above = [];
  SP_WEIGHT_GRID.forEach(function (spW) {
    var byFold = FOLDS.map(function (f) { return results.find(function (r) { return r.spW === spW && r.fold === f.name && r.hand === h; }); });
    var totalN = byFold.reduce(function (a, r) { return a + r.test_n; }, 0);
    var weightedRoi = totalN === 0 ? 0 : byFold.reduce(function (a, r) { return a + r.test_roi * r.test_n; }, 0) / totalN;
    if (spW < BASELINE_SP) below.push(weightedRoi);
    else if (spW > BASELINE_SP) above.push(weightedRoi);
  });
  var belowMean = below.reduce(function (a, b) { return a + b; }, 0) / below.length;
  var aboveMean = above.reduce(function (a, b) { return a + b; }, 0) / above.length;
  var dir = belowMean > aboveMean ? 'DOWN (lower helps)' : belowMean < aboveMean ? 'UP (higher helps)' : 'FLAT';
  console.log('  ' + (h === 'R' ? 'R-facing' : 'L-facing')
    + ': mean below-baseline ' + (belowMean >= 0 ? '+' : '') + belowMean.toFixed(2) + '%'
    + ', mean above-baseline ' + (aboveMean >= 0 ? '+' : '') + aboveMean.toFixed(2) + '%'
    + ' → ' + dir);
});
console.log('');
console.log('Benchmark prediction: R-facing should prefer HIGHER (benchmark 0.86 vs default 0.80),');
console.log('                     L-facing should prefer LOWER (benchmark 0.68 vs default 0.80).');
console.log('');

// Write TSV
var lines = ['# SP_WEIGHT rolling-CV, split by opposing-SP hand'];
lines.push(['sp_weight','fold','opp_sp_hand','test_n','test_roi','test_ci_lo','test_ci_hi'].join('\t'));
for (var ri = 0; ri < results.length; ri++) {
  var r = results[ri];
  lines.push([
    r.spW.toFixed(2), r.fold, r.hand,
    r.test_n, r.test_roi.toFixed(2),
    isNaN(r.test_ci_lo) ? '' : r.test_ci_lo.toFixed(2),
    isNaN(r.test_ci_hi) ? '' : r.test_ci_hi.toFixed(2),
  ].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-sp-weight-rolling-cv-by-hand.tsv'), lines.join('\n'));
console.log('Wrote docs/data/sweep-sp-weight-rolling-cv-by-hand.tsv');
console.log('=== DONE ===');
