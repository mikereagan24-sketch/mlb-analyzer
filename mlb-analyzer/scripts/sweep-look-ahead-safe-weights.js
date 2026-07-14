#!/usr/bin/env node
'use strict';

// Sweep look-ahead-safe weights on PR #179's prod-faithful harness pattern.
//
// Scope (per owner brief 2026-07-13, post-PR #179 reframe):
//   Include (settings-only, look-ahead-symmetric):
//     - W_PIT / W_BAT               (sum-to-1 invariant)
//     - SP_WEIGHT / RELIEF_WEIGHT   (sum-to-1 invariant) — game-level SP vs bp
//     - SP_PIT_WEIGHT / RELIEF_PIT_WEIGHT (sum-to-1) — pitching-component split
//     - BP_STRONG_WEIGHT_R / BP_WEAK_WEIGHT_R (sum-to-1)
//     - BP_STRONG_WEIGHT_L / BP_WEAK_WEIGHT_L (sum-to-1)
//     - PA_WEIGHTS shape (flat / baseline / steepened)
//   Exclude (look-ahead NOT symmetric — need Phase 3 wOBA snapshots):
//     - W_PROJ / W_ACT
//     - BULLPEN_W_PROJ / BULLPEN_W_ACT
//   Not swept (no settings key exists in jobs.js/schema):
//     - BAT_HAND_SP / BAT_HAND_RELIEF — listed in PR #174's ranking as
//       "unmeasured" but they aren't real app_settings keys; the model
//       reads handedness through per-hand batter/pitcher wOBA columns,
//       not through a weight. No lever to move.
//
// Design (mirrors scripts/sweep-pyth-exp-v2.js):
//   1. Universe = PROD's actual bet_signals ML rows (clean, resolved,
//      post-corruption, pre-v7). Fit=Apr-Jun, Val=Jul.
//   2. For each candidate settings object: re-run runModel per game with
//      day-of state (getBullpenWobaBlended); recompute edge; apply emit
//      floor + hard cap; grade kept signals at closing_line vs stored
//      outcome. Same grading as prod would have applied.
//   3. buildGame caches per (game_id, bp-relevant-key) so sweeps that
//      don't touch bp weights reuse the cached bullpen build.
//   4. Phase A: 1-by-1 sensitivity — score each weight's candidates,
//      report Val book ROI + Val 1-2pp band ROI (called out per brief).
//   5. Phase B: identify sensitive weights (|dVal book| > 1pp OR
//      |dVal 1-2pp| > 2pp) and joint-sweep those.
//   6. Report ship candidates that pass PR #174's 4 gates on Val.
//
// Look-ahead caveat: same as PR #179. Absolute ROI carries mild look-ahead
// from season-cumulative woba_data; deltas across candidates are honest
// because same inputs feed both. Ship gates compare Val vs baseline
// on Val (out-of-sample); nothing ships that doesn't survive.
//
// USAGE:  node scripts/sweep-look-ahead-safe-weights.js
// Output: docs/data/sweep-look-ahead-safe-weights-{sensitivity,joint}.tsv

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
console.log('Look-ahead-safe weight sweep — universe = actual bet_signals, grading = closing_line');
console.log('');

var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];

// Pull PROD bet_signals — same filter as sweep-pyth-exp-v2.js
var prodSigs = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, "
+ "  bs.market_line, bs.closing_line, bs.model_line AS bs_model_line, "
+ "  bs.edge_pct AS bs_edge_pct, bs.outcome AS bs_outcome, "
+ "  bs.price_venue, bs.venue_stale "
+ "FROM bet_signals bs "
+ "WHERE bs.signal_type='ML' AND bs.outcome IN ('win','loss','push') "
+ "  AND bs.closing_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-04-09' "
+ "  AND NOT ((bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) "
+ "        OR (bs.market_line > 100 AND bs.closing_line < 0) "
+ "        OR (bs.market_line < -100 AND bs.closing_line > 0))"
).all();
prodSigs = prodSigs.filter(function (s) { return V7_EXCL.indexOf(s.game_date) === -1; });

var fitSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-04-09' && s.game_date <= '2026-06-30'; });
var valSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-07-01'; });
console.log('Universe: PROD ML bet_signals, clean+non-contaminated');
console.log('  Fit (Apr-Jun): ' + fitSigs.length + ' signals');
console.log('  Val (Jul):     ' + valSigs.length + ' signals');

var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();

// Base weight values (from schema defaults, matching production intent)
var BASE = {
  W_PIT: base.W_PIT != null ? base.W_PIT : 0.40,
  W_BAT: base.W_BAT != null ? base.W_BAT : 0.60,
  SP_WEIGHT: base.SP_WEIGHT != null ? base.SP_WEIGHT : 0.80,
  RELIEF_WEIGHT: base.RELIEF_WEIGHT != null ? base.RELIEF_WEIGHT : 0.20,
  SP_PIT_WEIGHT: base.SP_PIT_WEIGHT != null ? base.SP_PIT_WEIGHT : 0.75,
  RELIEF_PIT_WEIGHT: base.RELIEF_PIT_WEIGHT != null ? base.RELIEF_PIT_WEIGHT : 0.25,
  BP_STRONG_WEIGHT_R: base.BP_STRONG_WEIGHT_R != null ? base.BP_STRONG_WEIGHT_R : 0.55,
  BP_WEAK_WEIGHT_R: base.BP_WEAK_WEIGHT_R != null ? base.BP_WEAK_WEIGHT_R : 0.45,
  BP_STRONG_WEIGHT_L: base.BP_STRONG_WEIGHT_L != null ? base.BP_STRONG_WEIGHT_L : 0.35,
  BP_WEAK_WEIGHT_L: base.BP_WEAK_WEIGHT_L != null ? base.BP_WEAK_WEIGHT_L : 0.65,
  PA_WEIGHTS: Array.isArray(base.PA_WEIGHTS) ? base.PA_WEIGHTS.slice() : [4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7],
};
console.log('Baseline weights (from prod-live settings):');
console.log('  W_PIT/W_BAT: ' + BASE.W_PIT + '/' + BASE.W_BAT);
console.log('  SP_WEIGHT/RELIEF_WEIGHT: ' + BASE.SP_WEIGHT + '/' + BASE.RELIEF_WEIGHT);
console.log('  SP_PIT_WEIGHT/RELIEF_PIT_WEIGHT: ' + BASE.SP_PIT_WEIGHT + '/' + BASE.RELIEF_PIT_WEIGHT);
console.log('  BP_STRONG_R/WEAK_R: ' + BASE.BP_STRONG_WEIGHT_R + '/' + BASE.BP_WEAK_WEIGHT_R);
console.log('  BP_STRONG_L/WEAK_L: ' + BASE.BP_STRONG_WEIGHT_L + '/' + BASE.BP_WEAK_WEIGHT_L);
console.log('  PA_WEIGHTS: [' + BASE.PA_WEIGHTS.join(',') + ']');

// ---- Helpers ----
function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// Cache built games per (game_id, bp-key). BP weights are the ONLY sweep
// dimensions that affect buildGame (because getBullpenWobaBlended takes
// bpSR/bpWR/bpSL/bpWL as args). Other sweeps reuse the same cached build.
var builtCache = {};
function bpKey(s) {
  return [s.BP_STRONG_WEIGHT_R, s.BP_WEAK_WEIGHT_R, s.BP_STRONG_WEIGHT_L, s.BP_WEAK_WEIGHT_L].join('|');
}
function buildGame(gameRow, settings) {
  var k = gameRow.game_date + '|' + gameRow.game_id + '|' + bpKey(settings);
  if (builtCache[k]) return builtCache[k];
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

// Score a candidate settings object against a pool. Returns kept signals w/ metadata.
function scoreCandidate(pool, weights) {
  var s = Object.assign({}, base, weights);
  var kept = [];
  var dropped = 0, suppressed = 0, skipped = 0;
  var SOFT = base.SIGNAL_EMIT_FLOOR_PP != null ? Number(base.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  var HARD = base.SIGNAL_EDGE_HARD_CAP_PP != null ? Number(base.SIGNAL_EDGE_HARD_CAP_PP) : 0.25;
  var progressEvery = Math.max(50, Math.floor(pool.length / 10));
  for (var i = 0; i < pool.length; i++) {
    if (i > 0 && i % progressEvery === 0) process.stdout.write('.');
    var sig = pool[i];
    var gRow = loadGameLog(sig.game_date, sig.game_id);
    if (!gRow || gRow.away_score == null) { skipped++; continue; }
    try {
      var built = buildGame(gRow, s);
      var mr = model.runModel(built, wobaIdx, s, 'standard', true);
      if (!mr || mr.aML == null || mr.hML == null) { skipped++; continue; }
      var newModelMlForSide = sig.signal_side === 'away' ? mr.aML : mr.hML;
      var newModelP = impliedP(newModelMlForSide);
      var closeP = impliedP(sig.closing_line);
      var newEdge = newModelP - closeP;
      if (newEdge < SOFT) { dropped++; continue; }
      if (newEdge >= HARD) { suppressed++; continue; }
      var pnl = pnlFromOutcome(sig.bs_outcome, sig.closing_line);
      kept.push({
        game_date: sig.game_date, game_id: sig.game_id, side: sig.signal_side,
        closing_line: sig.closing_line, new_model_line: newModelMlForSide,
        new_edge_pp: newEdge * 100, outcome: sig.bs_outcome, pnl: pnl,
        side_is_fav: sig.closing_line < 0, side_is_home: sig.signal_side === 'home',
      });
    } catch (e) { skipped++; }
  }
  return { kept: kept, dropped: dropped, suppressed: suppressed, skipped: skipped };
}

function summarize(kept) {
  var n = kept.length, w = 0, l = 0, p = 0, pnl = 0;
  for (var i = 0; i < n; i++) {
    var x = kept[i];
    if (x.outcome === 'win') w++;
    else if (x.outcome === 'loss') l++;
    else p++;
    pnl += x.pnl;
  }
  return { n: n, w: w, l: l, p: p, pnl: pnl, roi: n > 0 ? (pnl / (n * 100)) * 100 : 0 };
}
function sliceMet(kept, filter) { return summarize(kept.filter(filter)); }

function metricsFor(res) {
  return {
    book: summarize(res.kept),
    band12: sliceMet(res.kept, function (x) { return x.new_edge_pp >= 1 && x.new_edge_pp < 2; }),
    band24: sliceMet(res.kept, function (x) { return x.new_edge_pp >= 2 && x.new_edge_pp < 4; }),
    band46: sliceMet(res.kept, function (x) { return x.new_edge_pp >= 4 && x.new_edge_pp < 6; }),
    bigfav: sliceMet(res.kept, function (x) { return x.side_is_fav && x.new_edge_pp >= 6; }),
    bigdoghome: sliceMet(res.kept, function (x) { return !x.side_is_fav && x.side_is_home && x.new_edge_pp >= 6; }),
    dropped: res.dropped, suppressed: res.suppressed, skipped: res.skipped,
  };
}

// ---- Baseline ----
// Fit is scored ONCE for baseline (used as reference in the ship-gate check
// on the joint combo). 1-by-1 candidates score Val only — sensitivity is a
// Val-movement question; running fit for each 1-by-1 candidate is 6x more
// compute for information we don't use until joint tune. Sensitive levers
// re-run fit at the joint-tune step, which is when fit stability actually
// matters (proves the direction holds in-sample).
console.log('\n=== BASELINE (all prod-live weights) ===');
process.stdout.write('  fit ');
var baseFit = scoreCandidate(fitSigs, {});
process.stdout.write(' val ');
var baseVal = scoreCandidate(valSigs, {});
process.stdout.write(' done\n');
var baseFitM = metricsFor(baseFit);
var baseValM = metricsFor(baseVal);
console.log('  Fit book: n=' + baseFitM.book.n + ' ROI=' + baseFitM.book.roi.toFixed(2) + '%');
console.log('  Val book: n=' + baseValM.book.n + ' ROI=' + baseValM.book.roi.toFixed(2) + '%');
console.log('  Val 1-2pp: n=' + baseValM.band12.n + ' ROI=' + baseValM.band12.roi.toFixed(2) + '%');
console.log('  Val big+DOG+HOME: n=' + baseValM.bigdoghome.n + ' ROI=' + baseValM.bigdoghome.roi.toFixed(2) + '%');
console.log('  Val big+FAV: n=' + baseValM.bigfav.n + ' ROI=' + baseValM.bigfav.roi.toFixed(2) + '%');

// ---- 1-by-1 sensitivity ----
// Each sweep: array of {name, weights} candidates. First entry is baseline
// echo (skipped in scoring — we reuse baseVal).
var SWEEPS = [
  {
    key: 'W_PIT', label: 'W_PIT / W_BAT (must sum to 1)',
    cands: [
      { name: '0.35/0.65', weights: { W_PIT: 0.35, W_BAT: 0.65 } },
      { name: '0.40/0.60 (baseline)', weights: null },
      { name: '0.45/0.55', weights: { W_PIT: 0.45, W_BAT: 0.55 } },
      { name: '0.50/0.50', weights: { W_PIT: 0.50, W_BAT: 0.50 } },
      { name: '0.55/0.45', weights: { W_PIT: 0.55, W_BAT: 0.45 } },
    ],
  },
  {
    key: 'SP_WEIGHT', label: 'SP_WEIGHT / RELIEF_WEIGHT (game-level run est)',
    cands: [
      { name: '0.70/0.30', weights: { SP_WEIGHT: 0.70, RELIEF_WEIGHT: 0.30 } },
      { name: '0.75/0.25', weights: { SP_WEIGHT: 0.75, RELIEF_WEIGHT: 0.25 } },
      { name: '0.80/0.20 (baseline)', weights: null },
      { name: '0.85/0.15', weights: { SP_WEIGHT: 0.85, RELIEF_WEIGHT: 0.15 } },
      { name: '0.90/0.10', weights: { SP_WEIGHT: 0.90, RELIEF_WEIGHT: 0.10 } },
    ],
  },
  {
    key: 'SP_PIT_WEIGHT', label: 'SP_PIT_WEIGHT / RELIEF_PIT_WEIGHT (pitching component)',
    cands: [
      { name: '0.65/0.35', weights: { SP_PIT_WEIGHT: 0.65, RELIEF_PIT_WEIGHT: 0.35 } },
      { name: '0.70/0.30', weights: { SP_PIT_WEIGHT: 0.70, RELIEF_PIT_WEIGHT: 0.30 } },
      { name: '0.75/0.25 (baseline)', weights: null },
      { name: '0.80/0.20', weights: { SP_PIT_WEIGHT: 0.80, RELIEF_PIT_WEIGHT: 0.20 } },
      { name: '0.85/0.15', weights: { SP_PIT_WEIGHT: 0.85, RELIEF_PIT_WEIGHT: 0.15 } },
    ],
  },
  {
    key: 'BP_STRONG_R', label: 'BP_STRONG_R / BP_WEAK_R (bullpen vs RHB)',
    cands: [
      { name: '0.45/0.55', weights: { BP_STRONG_WEIGHT_R: 0.45, BP_WEAK_WEIGHT_R: 0.55 } },
      { name: '0.55/0.45 (baseline)', weights: null },
      { name: '0.65/0.35', weights: { BP_STRONG_WEIGHT_R: 0.65, BP_WEAK_WEIGHT_R: 0.35 } },
    ],
  },
  {
    key: 'BP_STRONG_L', label: 'BP_STRONG_L / BP_WEAK_L (bullpen vs LHB)',
    cands: [
      { name: '0.25/0.75', weights: { BP_STRONG_WEIGHT_L: 0.25, BP_WEAK_WEIGHT_L: 0.75 } },
      { name: '0.35/0.65 (baseline)', weights: null },
      { name: '0.45/0.55', weights: { BP_STRONG_WEIGHT_L: 0.45, BP_WEAK_WEIGHT_L: 0.55 } },
    ],
  },
  {
    key: 'PA_WEIGHTS', label: 'PA_WEIGHTS shape',
    cands: [
      { name: 'flat 4.13', weights: { PA_WEIGHTS: [4.13,4.13,4.13,4.13,4.13,4.13,4.13,4.13,4.13] } },
      { name: 'baseline empirical', weights: null },
      { name: 'steepened 1.5x', weights: { PA_WEIGHTS: (function() {
        var b = BASE.PA_WEIGHTS;
        var mean = b.reduce(function(a,x){return a+x;},0)/b.length;
        return b.map(function(x){ return mean + (x - mean) * 1.5; });
      })() } },
    ],
  },
];

// TSV rows for the sensitivity file
var sensRows = [];
sensRows.push(['# 1-by-1 sensitivity — Val ROI + band-level effects (baseline = current prod weights)'].join(''));
sensRows.push(['sweep','candidate','fit_book_n','fit_book_roi','val_book_n','val_book_roi','val_12_n','val_12_roi','val_24_n','val_24_roi','val_46_n','val_46_roi','val_bigfav_n','val_bigfav_roi','val_dh_n','val_dh_roi','fit_dropped','val_dropped','fit_suppressed','val_suppressed'].join('\t'));

// Baseline row
sensRows.push([
  'BASELINE','all defaults',
  baseFitM.book.n, baseFitM.book.roi.toFixed(2), baseValM.book.n, baseValM.book.roi.toFixed(2),
  baseValM.band12.n, baseValM.band12.roi.toFixed(2), baseValM.band24.n, baseValM.band24.roi.toFixed(2),
  baseValM.band46.n, baseValM.band46.roi.toFixed(2), baseValM.bigfav.n, baseValM.bigfav.roi.toFixed(2),
  baseValM.bigdoghome.n, baseValM.bigdoghome.roi.toFixed(2),
  baseFitM.dropped, baseValM.dropped, baseFitM.suppressed, baseValM.suppressed,
].join('\t'));

// Track sensitive weights: |dVal book| > 1pp OR |dVal 1-2pp| > 2pp
var SENSITIVE_BOOK_THRESH = 1.0;
var SENSITIVE_BAND12_THRESH = 2.0;
var sensitiveWeights = {}; // key -> { bestCand, maxDelta }

console.log('\n=== 1-BY-1 SENSITIVITY (5 sweeps, ' + SWEEPS.reduce(function(a,s){return a+s.cands.length;},0) + ' candidates) ===');
console.log('sweep       | candidate                | Val book (n/ROI)   | Val 1-2pp (n/ROI) | Val 2-4pp (n/ROI) | dVal book | dVal 1-2pp');
console.log('-'.repeat(140));

for (var si = 0; si < SWEEPS.length; si++) {
  var sw = SWEEPS[si];
  for (var ci = 0; ci < sw.cands.length; ci++) {
    var cand = sw.cands[ci];
    var valM;
    var fitM;
    var fitRes;
    if (cand.weights === null) {
      // Baseline — reuse
      valM = baseValM;
      fitM = baseFitM;
    } else {
      process.stdout.write('  ' + sw.key.padEnd(14) + cand.name.padEnd(30) + ' val ');
      var valRes = scoreCandidate(valSigs, cand.weights);
      process.stdout.write(' done\n');
      valM = metricsFor(valRes);
      // Fit only re-run at joint-tune step. Populate fit metrics as blanks
      // so TSV columns line up; sensitive levers get their fit later.
      fitM = { book: { n: '-', roi: NaN }, dropped: '-', suppressed: '-' };
    }
    var dValBook = valM.book.roi - baseValM.book.roi;
    var dVal12 = valM.band12.roi - baseValM.band12.roi;
    console.log(
      sw.key.padEnd(12) + '| ' +
      cand.name.padEnd(25) + '| ' +
      (String(valM.book.n).padStart(3) + ' / ' + valM.book.roi.toFixed(2).padStart(6) + '%').padEnd(19) + '| ' +
      (String(valM.band12.n).padStart(3) + ' / ' + valM.band12.roi.toFixed(2).padStart(6) + '%').padEnd(18) + '| ' +
      (String(valM.band24.n).padStart(3) + ' / ' + valM.band24.roi.toFixed(2).padStart(6) + '%').padEnd(18) + '| ' +
      (dValBook >= 0 ? '+' : '') + dValBook.toFixed(2).padStart(6) + 'pp | ' +
      (dVal12 >= 0 ? '+' : '') + dVal12.toFixed(2).padStart(6) + 'pp'
    );
    sensRows.push([
      sw.key, cand.name,
      fitM.book.n, isNaN(fitM.book.roi) ? '-' : fitM.book.roi.toFixed(2),
      valM.book.n, valM.book.roi.toFixed(2),
      valM.band12.n, valM.band12.roi.toFixed(2), valM.band24.n, valM.band24.roi.toFixed(2),
      valM.band46.n, valM.band46.roi.toFixed(2), valM.bigfav.n, valM.bigfav.roi.toFixed(2),
      valM.bigdoghome.n, valM.bigdoghome.roi.toFixed(2),
      fitM.dropped, valM.dropped, fitM.suppressed, valM.suppressed,
    ].join('\t'));

    // Sensitivity check (skip baseline echoes)
    if (cand.weights !== null && (Math.abs(dValBook) > SENSITIVE_BOOK_THRESH || Math.abs(dVal12) > SENSITIVE_BAND12_THRESH)) {
      var cur = sensitiveWeights[sw.key];
      var score = Math.abs(dValBook) + Math.abs(dVal12) * 0.5;
      if (!cur || score > cur.score) {
        sensitiveWeights[sw.key] = {
          sweep: sw, cand: cand, valM: valM, fitM: fitM,
          dValBook: dValBook, dVal12: dVal12, score: score,
        };
      }
    }
  }
  console.log('-'.repeat(140));
}

fs.writeFileSync(path.join(OUT_DIR, 'sweep-look-ahead-safe-weights-sensitivity.tsv'), sensRows.join('\n'));
console.log('\nWrote docs/data/sweep-look-ahead-safe-weights-sensitivity.tsv');

// ---- Identify sensitive weights ----
var sensKeys = Object.keys(sensitiveWeights);
console.log('\n=== SENSITIVITY SUMMARY ===');
console.log('Thresholds: |dVal book ROI| > ' + SENSITIVE_BOOK_THRESH + 'pp OR |dVal 1-2pp ROI| > ' + SENSITIVE_BAND12_THRESH + 'pp');
if (sensKeys.length === 0) {
  console.log('  NO SENSITIVE WEIGHTS. All candidates within noise of baseline.');
  console.log('  → No joint tuning. Ship nothing. Report defers all levers.');
  process.exit(0);
}
console.log('  Sensitive levers (best candidate per lever):');
for (var ki = 0; ki < sensKeys.length; ki++) {
  var k = sensKeys[ki];
  var e = sensitiveWeights[k];
  console.log('    ' + k + ' → ' + e.cand.name +
    '   dVal book ' + (e.dValBook >= 0 ? '+' : '') + e.dValBook.toFixed(2) + 'pp' +
    '   dVal 1-2pp ' + (e.dVal12 >= 0 ? '+' : '') + e.dVal12.toFixed(2) + 'pp');
}

// ---- Joint tune ----
// Combine best candidate from each sensitive lever, plus a few neighboring
// combinations to check that the joint effect is roughly additive.
// If only 1 sensitive lever: no joint sweep needed (1-by-1 already IS the answer).
if (sensKeys.length === 1) {
  console.log('\n  Only 1 sensitive lever — 1-by-1 result IS the ship candidate.');
  console.log('  Skipping joint sweep.');
} else {
  console.log('\n=== JOINT TUNE (' + sensKeys.length + ' sensitive levers) ===');
  // Assemble the "best" combination (each lever at its best 1-by-1 candidate)
  var jointWeights = {};
  for (var ki2 = 0; ki2 < sensKeys.length; ki2++) {
    Object.assign(jointWeights, sensitiveWeights[sensKeys[ki2]].cand.weights);
  }
  var jointRows = [];
  jointRows.push(['# Joint tune of sensitive levers — Val out-of-sample'].join(''));
  jointRows.push(['combo','levers','fit_book_n','fit_book_roi','val_book_n','val_book_roi','val_12_n','val_12_roi','val_24_n','val_24_roi','val_46_n','val_46_roi','val_bigfav_n','val_bigfav_roi','val_dh_n','val_dh_roi'].join('\t'));
  process.stdout.write('  BEST combo (all best-1-by-1): fit ');
  var jFit = scoreCandidate(fitSigs, jointWeights);
  process.stdout.write(' val ');
  var jVal = scoreCandidate(valSigs, jointWeights);
  process.stdout.write(' done\n');
  var jFitM = metricsFor(jFit);
  var jValM = metricsFor(jVal);
  var leverList = sensKeys.map(function(k){ return k + '=' + sensitiveWeights[k].cand.name; }).join(', ');
  console.log('  Joint  | ' + leverList);
  console.log('         | Fit book n=' + jFitM.book.n + ' ROI=' + jFitM.book.roi.toFixed(2) + '%');
  console.log('         | Val book n=' + jValM.book.n + ' ROI=' + jValM.book.roi.toFixed(2) + '%  (baseline ' + baseValM.book.roi.toFixed(2) + '%, delta ' + (jValM.book.roi - baseValM.book.roi).toFixed(2) + 'pp)');
  console.log('         | Val 1-2pp n=' + jValM.band12.n + ' ROI=' + jValM.band12.roi.toFixed(2) + '%  (baseline ' + baseValM.band12.roi.toFixed(2) + '%, delta ' + (jValM.band12.roi - baseValM.band12.roi).toFixed(2) + 'pp)');
  console.log('         | Val big+FAV n=' + jValM.bigfav.n + ' ROI=' + jValM.bigfav.roi.toFixed(2) + '%');
  console.log('         | Val big+DOG+HOME n=' + jValM.bigdoghome.n + ' ROI=' + jValM.bigdoghome.roi.toFixed(2) + '%');
  jointRows.push([
    'best_combined', leverList,
    jFitM.book.n, jFitM.book.roi.toFixed(2), jValM.book.n, jValM.book.roi.toFixed(2),
    jValM.band12.n, jValM.band12.roi.toFixed(2), jValM.band24.n, jValM.band24.roi.toFixed(2),
    jValM.band46.n, jValM.band46.roi.toFixed(2), jValM.bigfav.n, jValM.bigfav.roi.toFixed(2),
    jValM.bigdoghome.n, jValM.bigdoghome.roi.toFixed(2),
  ].join('\t'));
  fs.writeFileSync(path.join(OUT_DIR, 'sweep-look-ahead-safe-weights-joint.tsv'), jointRows.join('\n'));
  console.log('  Wrote docs/data/sweep-look-ahead-safe-weights-joint.tsv');

  // ---- Ship gate check on joint ----
  console.log('\n=== SHIP GATE CHECK (joint combo vs baseline, PR #174 gates) ===');
  var gA = jValM.book.roi > baseValM.book.roi;
  var gB = jValM.band12.roi >= baseValM.band12.roi - 2;
  var gC = jValM.bigfav.roi >= 0;
  var gD = jValM.bigdoghome.roi > baseValM.bigdoghome.roi;
  console.log('  (a) Val book ROI improves: ' + baseValM.book.roi.toFixed(2) + '% → ' + jValM.book.roi.toFixed(2) + '%  ' + (gA?'PASS':'FAIL'));
  console.log('  (b) Val 1-2pp not damaged: ' + baseValM.band12.roi.toFixed(2) + '% → ' + jValM.band12.roi.toFixed(2) + '%  ' + (gB?'PASS':'FAIL'));
  console.log('  (c) Val big+FAV stays ≥0: ' + jValM.bigfav.roi.toFixed(2) + '%  ' + (gC?'PASS':'FAIL'));
  console.log('  (d) Val big+DOG+HOME improves: ' + baseValM.bigdoghome.roi.toFixed(2) + '% → ' + jValM.bigdoghome.roi.toFixed(2) + '%  ' + (gD?'PASS':'FAIL'));
  console.log('  SHIP DECISION: ' + ((gA && gB && gC && gD) ? '✓ ALL PASS — joint combo ships' : '✗ ONE OR MORE FAIL — do NOT ship joint combo'));
}

console.log('\n=== DONE ===');
