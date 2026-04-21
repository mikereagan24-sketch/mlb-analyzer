#!/usr/bin/env node
'use strict';

// Grid-search the four most impactful model parameters (W_BAT / SP_PIT_WEIGHT /
// ML_LEAN_EDGE / ML_VALUE_EDGE) against the current backtest universe and
// report the top 20 combinations by ROI.
//
// Uses the app's own runModel + getSignals + calcPnl — no re-implementation.
// Writes nothing. Resolved-games universe is clamped to MIN_MODEL_DATE so
// pre-2026-04-09 signals (older parameter sets) cannot contaminate results.
//
// USAGE:  node scripts/optimize-params.js
//         node scripts/optimize-params.js 2026-04-09 2026-04-30   # custom range
//
// GRID (ML_VALUE must be strictly greater than ML_LEAN — 5 invalid pairs skipped):
//   w_bat        ∈ { 0.45, 0.50, 0.55, 0.60, 0.65 }      (w_pit = 1 − w_bat)
//   sp_weight    ∈ { 0.80, 0.85, 0.90, 0.95 }            (relief = 1 − sp_weight)
//   ml_lean_edge ∈ { 10, 15, 20, 25 }
//   ml_value_edge∈ { 25, 30, 35, 40 }
//
// 5 × 4 × 13 = 260 valid combinations. Per-game model math depends only on
// (w_bat, sp_weight) so we cache 5×4 = 20 model result sets and re-apply
// the star-threshold filters cheaply. Progress printed every 10 combos.

var args = process.argv.slice(2);
var dateRe = /^\d{4}-\d{2}-\d{2}$/;
var DATE_START = (args[0] && dateRe.test(args[0])) ? args[0] : null;
var DATE_END   = (args[1] && dateRe.test(args[1])) ? args[1] : null;

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
  var bpS   = settings.BP_STRONG_WEIGHT != null ? settings.BP_STRONG_WEIGHT : 0.60;
  var bpW   = settings.BP_WEAK_WEIGHT   != null ? settings.BP_WEAK_WEIGHT   : 0.40;
  var LEAGUE_BP = 0.318;
  var awayVsR = LEAGUE_BP, awayVsL = LEAGUE_BP, homeVsR = LEAGUE_BP, homeVsL = LEAGUE_BP;
  var awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      var hLU = tryParse(gameRow.home_lineup_json) || [];
      var aLU = tryParse(gameRow.away_lineup_json) || [];
      var aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, hLU, bpS, bpW, wProj, wAct, gameRow.game_date);
      var hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, aLU, bpS, bpW, wProj, wAct, gameRow.game_date);
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

function pad(s, n, right) {
  s = String(s);
  if (s.length >= n) return s;
  var f = new Array(n - s.length + 1).join(' ');
  return right ? s + f : f + s;
}

// ---- main ----
var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();

var MIN_MODEL_DATE = '2026-04-09';
var effectiveStart = (DATE_START && DATE_START > MIN_MODEL_DATE) ? DATE_START : MIN_MODEL_DATE;

var gameSql = "SELECT DISTINCT gl.* FROM game_log gl "
  + "WHERE gl.away_score IS NOT NULL AND gl.home_score IS NOT NULL "
  + "AND (gl.market_away_ml IS NOT NULL OR gl.market_total IS NOT NULL) "
  + "AND gl.game_date >= ?";
var params = [effectiveStart];
if (DATE_END) { gameSql += ' AND gl.game_date <= ?'; params.push(DATE_END); }
gameSql += ' ORDER BY gl.game_date, gl.game_id';

var stmt = db.prepare(gameSql);
var games = stmt.all.apply(stmt, params);

if (!games.length) {
  console.log('No resolved games in range — nothing to optimize');
  process.exit(0);
}

console.log('Parameter optimization');
console.log('Universe: ' + games.length + ' resolved games  ('
  + games[0].game_date + ' → ' + games[games.length - 1].game_date + ')');

var W_BAT_GRID = [0.45, 0.50, 0.55, 0.60, 0.65];
var SP_GRID    = [0.80, 0.85, 0.90, 0.95];
var LEAN_GRID  = [10, 15, 20, 25];
var VALUE_GRID = [25, 30, 35, 40];

// Enumerate valid threshold pairs up-front (ML_VALUE must exceed ML_LEAN).
var threshPairs = [];
for (var li = 0; li < LEAN_GRID.length; li++) {
  for (var vi = 0; vi < VALUE_GRID.length; vi++) {
    if (VALUE_GRID[vi] > LEAN_GRID[li]) threshPairs.push([LEAN_GRID[li], VALUE_GRID[vi]]);
  }
}
var totalCombos = W_BAT_GRID.length * SP_GRID.length * threshPairs.length;
console.log('Grid: ' + W_BAT_GRID.length + ' × ' + SP_GRID.length + ' × '
  + threshPairs.length + ' (lean<value) = ' + totalCombos + ' combinations');
console.log('='.repeat(80));

var results = [];
var comboIdx = 0;
var t0 = Date.now();

for (var wi = 0; wi < W_BAT_GRID.length; wi++) {
  var wBat = W_BAT_GRID[wi];
  var wPit = parseFloat((1 - wBat).toFixed(2));
  for (var si = 0; si < SP_GRID.length; si++) {
    var spW = SP_GRID[si];
    var rpW = parseFloat((1 - spW).toFixed(2));

    // Build per-combo model settings ONCE, run the model on every game ONCE,
    // and cache the modelResults. Threshold pairs then only need getSignals.
    var modelSettings = Object.assign({}, base, {
      W_BAT: wBat, W_PIT: wPit,
      SP_PIT_WEIGHT: spW, RELIEF_PIT_WEIGHT: rpW,
    });
    var gameCache = [];
    for (var gi = 0; gi < games.length; gi++) {
      var g = games[gi];
      try {
        var built = buildGame(g, modelSettings);
        var mr = model.runModel(built, wobaIdx, modelSettings);
        gameCache.push({ game: g, built: built, mr: mr });
      } catch (e) { /* skip bad game */ }
    }

    for (var ti = 0; ti < threshPairs.length; ti++) {
      var lean = threshPairs[ti][0];
      var value = threshPairs[ti][1];
      var sigSettings = Object.assign({}, modelSettings, {
        ML_LEAN_EDGE: lean, ML_VALUE_EDGE: value,
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
        w_bat: wBat, w_pit: wPit, sp: spW, rp: rpW,
        ml_lean: lean, ml_value: value,
        plays: plays, wins: wins, losses: losses, pushes: pushes,
        pnl: parseFloat(pnl.toFixed(2)),
        wagered: parseFloat(wagered.toFixed(2)),
        roi: parseFloat(roiPct.toFixed(2)),
      });
      comboIdx++;
      if (comboIdx % 10 === 0 || comboIdx === totalCombos) {
        var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log('  [' + pad(comboIdx, 3) + '/' + totalCombos + ']  '
          + elapsed + 's  last: w_bat=' + wBat.toFixed(2) + ' sp=' + spW.toFixed(2)
          + ' lean=' + lean + ' value=' + value
          + ' → ' + plays + 'p ' + (roiPct.toFixed(2)) + '% ROI');
      }
    }
  }
}

// Sort by ROI desc (ties broken by absolute pnl, then by plays)
results.sort(function (a, b) {
  if (b.roi !== a.roi) return b.roi - a.roi;
  if (b.pnl !== a.pnl) return b.pnl - a.pnl;
  return b.plays - a.plays;
});

console.log('');
console.log('='.repeat(96));
console.log('TOP 20 by ROI%  (tiebreak: pnl desc, plays desc)');
console.log('='.repeat(96));
console.log(
  pad('rank', 5) + ' ' +
  pad('w_bat', 6) + ' ' +
  pad('w_pit', 6) + ' ' +
  pad('sp', 5) + ' ' +
  pad('rp', 5) + ' ' +
  pad('lean', 5) + ' ' +
  pad('val', 4) + ' ' +
  pad('plays', 6) + ' ' +
  pad('W', 4) + ' ' +
  pad('L', 4) + ' ' +
  pad('P', 4) + ' ' +
  pad('pnl', 10) + ' ' +
  pad('roi%', 7)
);
console.log('-'.repeat(96));
var TOPN = Math.min(20, results.length);
for (var r = 0; r < TOPN; r++) {
  var row = results[r];
  console.log(
    pad((r + 1) + '.', 5) + ' ' +
    pad(row.w_bat.toFixed(2), 6) + ' ' +
    pad(row.w_pit.toFixed(2), 6) + ' ' +
    pad(row.sp.toFixed(2), 5) + ' ' +
    pad(row.rp.toFixed(2), 5) + ' ' +
    pad(row.ml_lean, 5) + ' ' +
    pad(row.ml_value, 4) + ' ' +
    pad(row.plays, 6) + ' ' +
    pad(row.wins, 4) + ' ' +
    pad(row.losses, 4) + ' ' +
    pad(row.pushes, 4) + ' ' +
    pad(row.pnl >= 0 ? '+$' + row.pnl.toFixed(2) : '-$' + Math.abs(row.pnl).toFixed(2), 10) + ' ' +
    pad(row.roi.toFixed(2) + '%', 7)
  );
}

// Current-settings comparator row (if present)
var curW = Number(base.W_BAT != null ? base.W_BAT : 0.5);
var curS = Number(base.SP_PIT_WEIGHT != null ? base.SP_PIT_WEIGHT : 0.80);
var curL = Number(base.ML_LEAN_EDGE  != null ? base.ML_LEAN_EDGE  : 15);
var curV = Number(base.ML_VALUE_EDGE != null ? base.ML_VALUE_EDGE : 30);
var curMatch = null, curRank = -1;
for (var i = 0; i < results.length; i++) {
  var rr = results[i];
  if (rr.w_bat === curW && rr.sp === curS && rr.ml_lean === curL && rr.ml_value === curV) {
    curMatch = rr; curRank = i + 1; break;
  }
}
console.log('');
if (curMatch) {
  console.log('Current live settings rank #' + curRank + '/' + results.length
    + ': w_bat=' + curW.toFixed(2) + ' sp=' + curS.toFixed(2)
    + ' lean=' + curL + ' value=' + curV
    + ' → ' + curMatch.plays + 'p  roi=' + curMatch.roi.toFixed(2) + '%  pnl=$' + curMatch.pnl.toFixed(2));
} else {
  console.log('Current live settings (w_bat=' + curW + ' sp=' + curS
    + ' lean=' + curL + ' value=' + curV + ') not on grid — can\'t rank directly.');
}
console.log('');
