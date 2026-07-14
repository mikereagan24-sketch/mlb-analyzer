#!/usr/bin/env node
'use strict';

// Supplementary joint sweep for sweep-look-ahead-safe-weights.js.
//
// The main harness picks "best candidate per lever" by |dValBook| +
// |dVal12|*0.5 — absolute magnitude, direction-blind. For SP_WEIGHT
// that picked 0.90 (dValBook=-2.92, dVal12=-19.98) over 0.75
// (dValBook=+4.04, dVal12=+9.17), because 0.90's absolute magnitude
// is bigger. But 0.90 HURTS; 0.75 HELPS. So the main harness's joint
// grid tested 4 combos with the wrong SP_WEIGHT high-side.
//
// This supplementary uses the SIGNED-best picks:
//   W_PIT: 0.35/0.65    (dValBook +12.49pp, dVal12 +28.60pp)
//   SP_WEIGHT: 0.75/0.25 (dValBook +4.04pp, dVal12 +9.18pp)
//   PA_WEIGHTS: flat 4.13 (dValBook +7.04pp, dVal12 +8.93pp)
//
// Runs the full 2^3 = 8 combo grid with these picks, fit+val, prints
// ship-gate check per combo. Same universe / grading / cap-pin as
// the main harness.

var fs = require('fs');
var path = require('path');
var q_db  = require('../db/schema');
var q     = q_db.q;
var db    = q_db.db;
var model = require('../services/model');
var jobs  = require('../services/jobs');

var OUT_DIR = path.join(__dirname, '..', 'docs', 'data');

var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];
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
).all().filter(function (s) { return V7_EXCL.indexOf(s.game_date) === -1; });

var fitSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-04-09' && s.game_date <= '2026-06-30'; });
var valSigs = prodSigs.filter(function (s) { return s.game_date >= '2026-07-01'; });

var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
var PIN_HARD_CAP = 0.08;

function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

var builtCache = {};
function bpKey(s) { return [s.BP_STRONG_WEIGHT_R, s.BP_WEAK_WEIGHT_R, s.BP_STRONG_WEIGHT_L, s.BP_WEAK_WEIGHT_L].join('|'); }
function buildGame(gameRow, settings) {
  var k = gameRow.game_date + '|' + gameRow.game_id + '|' + bpKey(settings);
  if (builtCache[k]) return builtCache[k];
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '', homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '', homeSp = gameRow.home_sp || '';
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

function scoreCandidate(pool, weights) {
  var s = Object.assign({}, base, weights);
  var kept = [], dropped = 0, suppressed = 0, skipped = 0;
  var SOFT = base.SIGNAL_EMIT_FLOOR_PP != null ? Number(base.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  var HARD = PIN_HARD_CAP;
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
        edge_pp: newEdge * 100, outcome: sig.bs_outcome, pnl: pnl,
        side_is_fav: sig.closing_line < 0, side_is_home: sig.signal_side === 'home',
      });
    } catch (e) { skipped++; }
  }
  return { kept: kept };
}

function summarize(kept) {
  var n = kept.length, w = 0, l = 0, pnl = 0;
  for (var i = 0; i < n; i++) {
    var x = kept[i];
    if (x.outcome === 'win') w++;
    else if (x.outcome === 'loss') l++;
    pnl += x.pnl;
  }
  return { n: n, roi: n > 0 ? (pnl / (n * 100)) * 100 : 0 };
}
function sliceRoi(kept, filter) { return summarize(kept.filter(filter)); }

function metricsFor(res) {
  return {
    book: summarize(res.kept),
    band12: sliceRoi(res.kept, function (x) { return x.edge_pp >= 1 && x.edge_pp < 2; }),
    band24: sliceRoi(res.kept, function (x) { return x.edge_pp >= 2 && x.edge_pp < 4; }),
    band46: sliceRoi(res.kept, function (x) { return x.edge_pp >= 4 && x.edge_pp < 6; }),
    bigfav: sliceRoi(res.kept, function (x) { return x.side_is_fav && x.edge_pp >= 6; }),
    bigdh: sliceRoi(res.kept, function (x) { return !x.side_is_fav && x.side_is_home && x.edge_pp >= 6; }),
  };
}

console.log('Corrected joint grid: W_PIT ∈ {0.40, 0.35}, SP_WEIGHT ∈ {0.80, 0.75}, PA ∈ {baseline, flat}');
console.log('Universe: ' + fitSigs.length + ' fit + ' + valSigs.length + ' val ML signals');
console.log('HARD cap pinned: ' + PIN_HARD_CAP + '\n');

// Baseline
process.stdout.write('BASELINE (0.40/0.80/baseline): fit ');
var bFit = scoreCandidate(fitSigs, {});
process.stdout.write(' val ');
var bVal = scoreCandidate(valSigs, {});
process.stdout.write(' done\n');
var bFitM = metricsFor(bFit);
var bValM = metricsFor(bVal);
console.log('  Fit book ' + bFitM.book.roi.toFixed(2) + '% (n=' + bFitM.book.n + ')  Val book ' + bValM.book.roi.toFixed(2) + '% (n=' + bValM.book.n + ')  Val 1-2pp ' + bValM.band12.roi.toFixed(2) + '% (n=' + bValM.band12.n + ')');

// Grid
var W_PIT_OPTS = [
  { name: 'baseline', w: {} },
  { name: '0.35/0.65', w: { W_PIT: 0.35, W_BAT: 0.65 } },
];
var SP_OPTS = [
  { name: 'baseline', w: {} },
  { name: '0.75/0.25', w: { SP_WEIGHT: 0.75, RELIEF_WEIGHT: 0.25 } },
];
var PA_OPTS = [
  { name: 'baseline', w: {} },
  { name: 'flat 4.13', w: { PA_WEIGHTS: [4.13,4.13,4.13,4.13,4.13,4.13,4.13,4.13,4.13] } },
];

var tsvRows = ['# Corrected joint grid — SIGNED-best picks, fit+val, HARD=0.08 pinned'];
tsvRows.push(['combo_id','W_PIT','SP_WEIGHT','PA','fit_n','fit_roi','val_n','val_roi','val_12_n','val_12_roi','val_24_n','val_24_roi','val_46_n','val_46_roi','val_bigfav_n','val_bigfav_roi','val_dh_n','val_dh_roi','gA_book','gB_12','gC_fav','gD_dh','ship'].join('\t'));

var results = [];
var comboId = 0;
for (var wi = 0; wi < W_PIT_OPTS.length; wi++) {
  for (var si = 0; si < SP_OPTS.length; si++) {
    for (var pi = 0; pi < PA_OPTS.length; pi++) {
      comboId++;
      if (wi === 0 && si === 0 && pi === 0) {
        // Baseline — already scored, reuse
        results.push({ id: comboId, label: 'baseline', wpit: W_PIT_OPTS[wi].name, sp: SP_OPTS[si].name, pa: PA_OPTS[pi].name, fitM: bFitM, valM: bValM });
        continue;
      }
      var w = {};
      Object.assign(w, W_PIT_OPTS[wi].w, SP_OPTS[si].w, PA_OPTS[pi].w);
      var lbl = 'W=' + W_PIT_OPTS[wi].name + ' SP=' + SP_OPTS[si].name + ' PA=' + PA_OPTS[pi].name;
      process.stdout.write('combo ' + comboId + '/8: ' + lbl + '\n  fit ');
      var cFit = scoreCandidate(fitSigs, w);
      process.stdout.write(' val ');
      var cVal = scoreCandidate(valSigs, w);
      process.stdout.write(' done\n');
      var cFitM = metricsFor(cFit);
      var cValM = metricsFor(cVal);
      console.log('  Fit ' + cFitM.book.roi.toFixed(2) + '% (n=' + cFitM.book.n + ')  Val ' + cValM.book.roi.toFixed(2) + '% (n=' + cValM.book.n + ')  Val 1-2pp ' + cValM.band12.roi.toFixed(2) + '% (n=' + cValM.band12.n + ')');
      results.push({ id: comboId, label: lbl, wpit: W_PIT_OPTS[wi].name, sp: SP_OPTS[si].name, pa: PA_OPTS[pi].name, fitM: cFitM, valM: cValM });
    }
  }
}

console.log('\n=== SHIP GATE CHECK — each combo vs baseline (Val OOS) ===');
for (var ri = 0; ri < results.length; ri++) {
  var r = results[ri];
  var gA = r.valM.book.roi > bValM.book.roi;
  var gB = r.valM.band12.roi >= bValM.band12.roi - 2;
  var gC = r.valM.bigfav.roi >= 0;
  var gD = r.valM.bigdh.roi > bValM.bigdh.roi;
  var pass = gA && gB && gC && gD;
  console.log('  #' + r.id + '  W=' + r.wpit.padEnd(9) + ' SP=' + r.sp.padEnd(9) + ' PA=' + r.pa.padEnd(9) +
    '  Val ' + r.valM.book.roi.toFixed(2).padStart(6) + '% (' + r.valM.book.n + ')' +
    '  1-2pp ' + r.valM.band12.roi.toFixed(2).padStart(6) + '% (' + r.valM.band12.n + ')' +
    '  (a)' + (gA?'✓':'✗') + ' (b)' + (gB?'✓':'✗') + ' (c)' + (gC?'✓':'✗') + ' (d)' + (gD?'✓':'✗') +
    '  ' + (pass ? '★ SHIP' : ''));
  tsvRows.push([r.id, r.wpit, r.sp, r.pa,
    r.fitM.book.n, r.fitM.book.roi.toFixed(2), r.valM.book.n, r.valM.book.roi.toFixed(2),
    r.valM.band12.n, r.valM.band12.roi.toFixed(2), r.valM.band24.n, r.valM.band24.roi.toFixed(2),
    r.valM.band46.n, r.valM.band46.roi.toFixed(2), r.valM.bigfav.n, r.valM.bigfav.roi.toFixed(2),
    r.valM.bigdh.n, r.valM.bigdh.roi.toFixed(2),
    gA?'PASS':'FAIL', gB?'PASS':'FAIL', gC?'PASS':'FAIL', gD?'PASS':'FAIL', pass?'SHIP':'NO'].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-look-ahead-safe-weights-joint-corrected.tsv'), tsvRows.join('\n'));
console.log('\nWrote docs/data/sweep-look-ahead-safe-weights-joint-corrected.tsv');
console.log('=== DONE ===');
