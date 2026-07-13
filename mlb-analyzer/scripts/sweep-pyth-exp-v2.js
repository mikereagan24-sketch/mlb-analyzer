#!/usr/bin/env node
'use strict';

// PYTH_EXP sweep v2 — PROD-FAITHFUL.
//
// v1 (scripts/sweep-pyth-exp.js) had a 17pp gap vs prod because it graded
// against game_log.market_*_ml (Kalshi-direct top-of-book), while prod bets
// venue-net-at-size (~140-point difference on Poly-tagged rows). See
// docs/harness-vs-prod-diagnostic-2026-07-13.md.
//
// v2 fixes that. Design:
//   - Universe = PROD's actual bet_signals ML rows (clean, resolved,
//     non-corrupt, non-contaminated-v7-dates)
//   - For each candidate pyth_exp:
//       - Re-run runModel + getSignals against that game with new
//         pyth_exp (day-of state via getBullpenWobaBlended)
//       - For each PROD signal on that game:
//           - Compute new_edge = new_model_p(signal_side) - impliedP(closing_line)
//           - If new_edge < SIGNAL_EMIT_FLOOR_PP: signal DROPPED (would not
//             emit at candidate pyth_exp)
//           - If new_edge >= SIGNAL_EDGE_HARD_CAP_PP: signal SUPPRESSED
//             (cap catches it)
//           - Otherwise: signal emits, graded at closing_line (venue-net),
//             stored outcome
//   - Baseline (pyth_exp=1.83) applied to same universe should ~match prod
//     actual ROI (sanity check that harness now aligns with reality)
//
// Look-ahead caveat: model re-run uses today's woba_data (season-cumulative).
// Absolute ROI carries mild look-ahead. Delta across pyth_exp values is
// honest because same inputs apply to both. Owner-noted this is acceptable
// until per-date woba snapshots exist.
//
// USAGE:  node scripts/sweep-pyth-exp-v2.js
// Output: docs/data/sweep-pyth-exp-v2-grid.tsv

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
console.log('PROD-FAITHFUL Pythag sweep v2 — universe = actual bet_signals, grading = closing_line');
console.log('');

var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];

// Pull PROD bet_signals — ML, resolved, clean, non-contaminated
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

// Split fit / val
var fitSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-04-09' && s.game_date <= '2026-06-30'; });
var valSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-07-01'; });
console.log('Universe: PROD ML bet_signals, clean+non-contaminated');
console.log('  Fit (Apr-Jun): ' + fitSigs.length + ' signals');
console.log('  Val (Jul):     ' + valSigs.length + ' signals');

// Base settings + wobaIdx
var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
console.log('  Base PYTH_EXP: ' + (base.PYTH_EXP != null ? base.PYTH_EXP : 1.83));

// ---- Helpers ----
function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

function buildGame(gameRow, settings) {
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '';
  var homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '';
  var homeSp = gameRow.home_sp || '';
  var wProj = settings.W_PROJ != null ? settings.W_PROJ : 0.65;
  var wAct  = settings.W_ACT  != null ? settings.W_ACT  : 0.35;
  var bpSR  = 0.55, bpWR  = 0.45, bpSL  = 0.35, bpWL  = 0.65;
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

// Cache game_log rows per game_date+game_id since many signals share a game
var gameLogCache = {};
function loadGameLog(gd, gid) {
  var k = gd + '|' + gid;
  if (gameLogCache[k]) return gameLogCache[k];
  var row = db.prepare("SELECT * FROM game_log WHERE game_date=? AND game_id=?").get(gd, gid);
  gameLogCache[k] = row || null;
  return row;
}

// PnL on $100 stake at closing_line (venue-net)
function pnlFromOutcome(outcome, closingLine) {
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -100;
  // win
  return closingLine > 0 ? closingLine : 100;
}

// ---- Score a candidate pyth_exp against a prod-signal pool ----
function scoreCandidate(pool, expVal) {
  var s = Object.assign({}, base, { PYTH_EXP: expVal });
  var kept = [];    // signals that emit at candidate settings, with their new_edge_pp
  var dropped = 0;  // signals that fall below emit floor at candidate
  var suppressed = 0; // signals suppressed by hard cap at candidate
  var skipped = 0;  // couldn't re-run model on the game
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
      // Signal emits — grade at closing_line
      var pnl = pnlFromOutcome(sig.bs_outcome, sig.closing_line);
      kept.push({
        game_date: sig.game_date,
        game_id: sig.game_id,
        side: sig.signal_side,
        closing_line: sig.closing_line,
        new_model_line: newModelMlForSide,
        new_edge_pp: newEdge * 100,
        outcome: sig.bs_outcome,
        pnl: pnl,
        side_is_fav: sig.closing_line < 0,
        side_is_home: sig.signal_side === 'home',
      });
    } catch (e) {
      skipped++;
    }
  }
  return { kept: kept, dropped: dropped, suppressed: suppressed, skipped: skipped };
}

function summarize(kept) {
  var n = kept.length;
  var w = 0, l = 0, p = 0, pnl = 0;
  for (var i = 0; i < n; i++) {
    var x = kept[i];
    if (x.outcome === 'win') w++;
    else if (x.outcome === 'loss') l++;
    else p++;
    pnl += x.pnl;
  }
  var roi = n > 0 ? (pnl / (n * 100)) * 100 : 0;
  return { n: n, w: w, l: l, p: p, pnl: pnl, roi: roi };
}
function sliceMetrics(kept, filter) {
  return summarize(kept.filter(filter));
}

// ---- Sweep ----
var EXPS = [1.65, 1.83];
var results = [];
console.log('\n=== PROD-FAITHFUL SWEEP (universe=bet_signals, grade=closing_line) ===');
console.log('exp   | Fit book n/ROI    | Val book n/ROI    | Val 1-2pp n/ROI  | Val big+FAV n/ROI | Val big+DOG+HOME n/ROI  | dropped f/v | suppressed f/v');
for (var ei = 0; ei < EXPS.length; ei++) {
  var expVal = EXPS[ei];
  process.stdout.write('exp=' + expVal + ' fit ');
  var fitR = scoreCandidate(fitSigs, expVal);
  process.stdout.write(' val ');
  var valR = scoreCandidate(valSigs, expVal);
  process.stdout.write(' done\n');
  var fitMet = summarize(fitR.kept);
  var valMet = summarize(valR.kept);
  var val12 = sliceMetrics(valR.kept, function (x) { return x.new_edge_pp >= 1 && x.new_edge_pp < 2; });
  var valFav = sliceMetrics(valR.kept, function (x) { return x.side_is_fav && x.new_edge_pp >= 6; });
  var valDogHome = sliceMetrics(valR.kept, function (x) { return !x.side_is_fav && x.side_is_home && x.new_edge_pp >= 6; });
  console.log(expVal.toFixed(2) + '  | '
    + String(fitMet.n).padStart(3) + ' / ' + fitMet.roi.toFixed(1).padStart(6) + '%    | '
    + String(valMet.n).padStart(3) + ' / ' + valMet.roi.toFixed(1).padStart(6) + '%    | '
    + String(val12.n).padStart(2) + ' / ' + val12.roi.toFixed(1).padStart(6) + '%  | '
    + String(valFav.n).padStart(2) + ' / ' + valFav.roi.toFixed(1).padStart(6) + '%    | '
    + String(valDogHome.n).padStart(2) + ' / ' + valDogHome.roi.toFixed(1).padStart(6) + '%      | '
    + fitR.dropped + '/' + valR.dropped + '        | '
    + fitR.suppressed + '/' + valR.suppressed);
  results.push({
    exp: expVal,
    fit_book: fitMet, val_book: valMet,
    val_12: val12, val_fav: valFav, val_doghome: valDogHome,
    fit_dropped: fitR.dropped, val_dropped: valR.dropped,
    fit_suppressed: fitR.suppressed, val_suppressed: valR.suppressed,
    fit_kept_count: fitR.kept.length, val_kept_count: valR.kept.length,
  });
}

// ---- Ship gates ----
console.log('\n=== GATE SCORING (pyth_exp 1.65 vs baseline 1.83) — PROD-FAITHFUL ===');
var baseline = results[1];
var target = results[0];
console.log('(a) Val book ROI: ' + baseline.val_book.roi.toFixed(2) + '% n=' + baseline.val_book.n + ' → ' + target.val_book.roi.toFixed(2) + '% n=' + target.val_book.n + '  delta ' + (target.val_book.roi - baseline.val_book.roi).toFixed(2) + 'pp');
console.log('(b) Val 1-2pp: ' + baseline.val_12.roi.toFixed(2) + '% n=' + baseline.val_12.n + ' → ' + target.val_12.roi.toFixed(2) + '% n=' + target.val_12.n + '  delta ' + (target.val_12.roi - baseline.val_12.roi).toFixed(2) + 'pp');
console.log('(c) Val big+FAV: ' + baseline.val_fav.roi.toFixed(2) + '% n=' + baseline.val_fav.n + ' → ' + target.val_fav.roi.toFixed(2) + '% n=' + target.val_fav.n);
console.log('(d) Val big+DOG+HOME: ' + baseline.val_doghome.roi.toFixed(2) + '% n=' + baseline.val_doghome.n + ' → ' + target.val_doghome.roi.toFixed(2) + '% n=' + target.val_doghome.n);
var gA = target.val_book.roi > baseline.val_book.roi;
var gB = target.val_12.roi >= baseline.val_12.roi - 2;
var gC = target.val_fav.roi >= 0;
var gD = target.val_doghome.roi > baseline.val_doghome.roi;
console.log('\nGates: (a) ' + (gA?'PASS':'FAIL') + '  (b) ' + (gB?'PASS':'FAIL') + '  (c) ' + (gC?'PASS':'FAIL') + '  (d) ' + (gD?'PASS':'FAIL'));
console.log('SHIP DECISION: ' + ((gA && gB && gC && gD) ? '✓ ALL PASS — safe to ship' : '✗ ONE OR MORE FAIL — do NOT ship'));

// Baseline sanity: 1.83 val ROI should approximate prod actual (~-5% per PR #174)
console.log('\nBaseline sanity check: 1.83 val book ROI = ' + baseline.val_book.roi.toFixed(2) + '%');
console.log('  (prod actual Val Jul ROI per PR #174 analytic: ~-5%. Delta ' + (baseline.val_book.roi - (-5)).toFixed(2) + 'pp).');
console.log('  If |delta| < ~3pp, harness is well-aligned with prod. Larger = residual look-ahead or model-input differences.');

// Persist
var tsvLines = ['# Pyth exp v2 sweep — PROD-FAITHFUL (universe=bet_signals, grade=closing_line)'];
tsvLines.push(['pyth_exp','fit_book_n','fit_book_roi','val_book_n','val_book_roi','val_12_n','val_12_roi','val_fav_n','val_fav_roi','val_doghome_n','val_doghome_roi','fit_dropped','val_dropped','fit_suppressed','val_suppressed'].join('\t'));
for (var ri = 0; ri < results.length; ri++) {
  var r = results[ri];
  tsvLines.push([r.exp, r.fit_book.n, r.fit_book.roi.toFixed(2), r.val_book.n, r.val_book.roi.toFixed(2), r.val_12.n, r.val_12.roi.toFixed(2), r.val_fav.n, r.val_fav.roi.toFixed(2), r.val_doghome.n, r.val_doghome.roi.toFixed(2), r.fit_dropped, r.val_dropped, r.fit_suppressed, r.val_suppressed].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-pyth-exp-v2-grid.tsv'), tsvLines.join('\n'));
console.log('\nWrote docs/data/sweep-pyth-exp-v2-grid.tsv');
