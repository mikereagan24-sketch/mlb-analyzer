#!/usr/bin/env node
'use strict';

// W_PROJ / W_ACT blend sweep. Re-scores all resolved v4-eligible games
// through the app's own runModel + getSignals + calcPnl at several
// Steamer-projection / actuals blend weights, and reports plays / W-L /
// P&L / ROI per blend. Lets us compare the current 0.70/0.30 against
// 0.50/0.50 and the points between.
//
// IMPORTANT CAVEAT: uses the CURRENT wOBA index (today's snapshot), not
// the index as it stood on each game date. So this answers "is X a better
// blend setting" — NOT "what would my literal historical P&L have been."
// For input tuning, that's the right question.
//
// USAGE:  node scripts/sweep-woba-blend.js
//         node scripts/sweep-woba-blend.js 2026-05-12 2026-05-19   # custom range
//         node scripts/sweep-woba-blend.js 2026-05-12 2026-05-19 v4  # filter cohort

var args = process.argv.slice(2);
var dateRe = /^\d{4}-\d{2}-\d{2}$/;
var DATE_START = (args[0] && dateRe.test(args[0])) ? args[0] : null;
var DATE_END   = (args[1] && dateRe.test(args[1])) ? args[1] : null;
var COHORT     = args[2] || null;  // optional: only grade signals whose stored cohort matches

var q_db  = require('../db/schema');
var q     = q_db.q;
var db    = q_db.db;
var model = require('../services/model');
var jobs  = require('../services/jobs');

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ---- buildGame: identical to optimize-params.js so model inputs match prod ----
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
  if (sig.type === 'ML') raw = parseFloat(sig.marketLine);
  else {
    raw = parseFloat(sig.side === 'over' ? sig.overPrice : sig.underPrice);
    if (isNaN(raw) || raw === 0) raw = -110;
  }
  if (isNaN(raw) || raw === 0) return 0;
  return raw > 0 ? parseFloat((10000 / raw).toFixed(2)) : Math.abs(raw);
}

function gradeSig(sig, gameRow) {
  if (gameRow.away_score == null || gameRow.home_score == null) return null;
  var r = model.calcPnl(
    { type: sig.type, side: sig.side, marketLine: sig.marketLine, bet_line: null,
      overPrice: sig.overPrice, underPrice: sig.underPrice },
    gameRow.away_score, gameRow.home_score, gameRow.market_total
  );
  return { outcome: r.outcome, pnl: r.pnl, stake: stakeForSignal(sig), type: sig.type };
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

var games = db.prepare(gameSql).all.apply(db.prepare(gameSql), params);
if (!games.length) { console.log('No resolved games in range'); process.exit(0); }

console.log('W_PROJ / W_ACT blend sweep');
console.log('Universe: ' + games.length + ' resolved games  ('
  + games[0].game_date + ' → ' + games[games.length - 1].game_date + ')');
console.log('NOTE: re-scored with CURRENT wOBA index, not date-snapshotted. '
  + 'Compares blend settings, not literal historical P&L.');
console.log('Current live setting: W_PROJ=' + (base.W_PROJ != null ? base.W_PROJ : 0.65)
  + ' / W_ACT=' + (base.W_ACT != null ? base.W_ACT : 0.35));
console.log('='.repeat(92));

// Blends to test (proj, act). Full curve from current 0.70/0.30 down
// through 0.50/0.50 and on to actuals-heavy 0.30/0.70.
var BLENDS = [
  [0.70, 0.30],
  [0.65, 0.35],
  [0.60, 0.40],
  [0.55, 0.45],
  [0.50, 0.50],
  [0.45, 0.55],
  [0.40, 0.60],
  [0.35, 0.65],
  [0.30, 0.70],
];

function summarize(rows) {
  var n = rows.length;
  var w = 0, l = 0, p = 0, pnl = 0, wag = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.outcome === 'win') w++;
    else if (r.outcome === 'loss') l++;
    else if (r.outcome === 'push') { p++; continue; }
    if (typeof r.pnl === 'number') pnl += r.pnl;
    if (typeof r.stake === 'number') wag += r.stake;
  }
  var roi = wag > 0 ? (100 * pnl / wag) : 0;
  return { n: n, w: w, l: l, p: p, pnl: pnl, wag: wag, roi: roi };
}

var allResults = [];
for (var bi = 0; bi < BLENDS.length; bi++) {
  var wProj = BLENDS[bi][0], wAct = BLENDS[bi][1];
  var s = Object.assign({}, base, { W_PROJ: wProj, W_ACT: wAct });
  var graded = [];     // all signals
  for (var gi = 0; gi < games.length; gi++) {
    var g = games[gi];
    var built, mr, sigs;
    try {
      built = buildGame(g, s);
      mr = model.runModel(built, wobaIdx, s);
      sigs = model.getSignals(built, mr, s);
    } catch (e) { continue; }
    for (var xi = 0; xi < sigs.length; xi++) {
      var gr = gradeSig(sigs[xi], g);
      if (gr) graded.push(gr);
    }
  }
  var all = summarize(graded);
  var ml  = summarize(graded.filter(function (r) { return r.type === 'ML'; }));
  var tot = summarize(graded.filter(function (r) { return r.type === 'Total'; }));
  allResults.push({ wProj: wProj, wAct: wAct, all: all, ml: ml, tot: tot });
  console.log('  done ' + wProj.toFixed(2) + '/' + wAct.toFixed(2)
    + '  (' + all.n + ' plays, ROI ' + all.roi.toFixed(2) + '%)');
}

function row(label, s) {
  return pad(label, 12) + ' '
    + pad(s.n, 6) + ' '
    + pad(s.w + '-' + s.l + (s.p ? '-' + s.p : ''), 9) + ' '
    + pad((s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2), 11) + ' '
    + pad((s.roi >= 0 ? '+' : '') + s.roi.toFixed(2) + '%', 9);
}

console.log('');
console.log('='.repeat(92));
console.log(pad('blend', 12) + ' ' + pad('plays', 6) + ' ' + pad('W-L-P', 9) + ' '
  + pad('P&L', 11) + ' ' + pad('ROI', 9));
console.log('='.repeat(92));
for (var ri = 0; ri < allResults.length; ri++) {
  var r = allResults[ri];
  var tag = r.wProj.toFixed(2) + '/' + r.wAct.toFixed(2);
  console.log('--- ' + tag + (Math.abs(r.wProj - (base.W_PROJ != null ? base.W_PROJ : 0.65)) < 0.001 ? '  (LIVE)' : '') + ' ---');
  console.log(row('  ALL', r.all));
  console.log(row('  ML', r.ml));
  console.log(row('  Total', r.tot));
}
console.log('='.repeat(92));
console.log('Bet-to-win-$100 P&L convention. Pushes excluded from ROI denominator.');
