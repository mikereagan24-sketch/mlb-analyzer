#!/usr/bin/env node
'use strict';

// Backtest: for every resolved game in the DB, replay getSignals under two
// SP/RP weight splits and grade the resulting signals against actual scores.
//   A = current   SP_PIT=0.90  RELIEF_PIT=0.10
//   B = proposed  SP_PIT=0.75  RELIEF_PIT=0.25
// All other settings come from app_settings.
//
// Uses the app's own runModel + getSignals + calcPnl — no re-implementation.
// Writes nothing to the DB.
//
// Usage:
//   node scripts/backtest-sp-relief-split.js                        # full history
//   node scripts/backtest-sp-relief-split.js 2026-04-01             # single date
//   node scripts/backtest-sp-relief-split.js 2026-04-01 2026-04-18  # date range

var DATE_START = process.argv[2] || null;
var DATE_END   = process.argv[3] || null;

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

function grade(sig, gameRow) {
  if (gameRow.away_score == null || gameRow.home_score == null) return null;
  var graded = model.calcPnl(
    {
      type: sig.type,
      side: sig.side,
      marketLine: sig.marketLine,
      bet_line: null,
      overPrice: sig.overPrice,
      underPrice: sig.underPrice,
    },
    gameRow.away_score, gameRow.home_score, gameRow.market_total
  );
  return {
    outcome: graded.outcome,
    pnl: graded.pnl,
    stake: stakeForSignal(sig),
  };
}

function emptyBucket() {
  return { plays: 0, wins: 0, losses: 0, pushes: 0, pending: 0, pnl: 0, wagered: 0 };
}
function accumulate(b, g) {
  if (!g) return;
  b.plays++;
  if (g.outcome === 'win') b.wins++;
  else if (g.outcome === 'loss') b.losses++;
  else if (g.outcome === 'push') b.pushes++;
  else b.pending++;
  if (g.outcome !== 'pending' && g.outcome !== 'push') {
    if (typeof g.pnl === 'number') b.pnl += g.pnl;
    if (typeof g.stake === 'number') b.wagered += g.stake;
  }
}
function winPct(b) {
  var r = b.wins + b.losses;
  return r > 0 ? (100 * b.wins / r).toFixed(1) + '%' : '—';
}
function roi(b) {
  return b.wagered > 0 ? (100 * b.pnl / b.wagered).toFixed(2) + '%' : '—';
}
function pad(s, n, right) {
  s = String(s);
  if (s.length >= n) return s;
  var f = new Array(n - s.length + 1).join(' ');
  return right ? s + f : f + s;
}

// --- main ---
var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();

var scenarios = {
  A: Object.assign({}, base, { SP_PIT_WEIGHT: 0.90, RELIEF_PIT_WEIGHT: 0.10 }),
  B: Object.assign({}, base, { SP_PIT_WEIGHT: 0.75, RELIEF_PIT_WEIGHT: 0.25 }),
};

var gameSql = "SELECT DISTINCT gl.* FROM game_log gl "
  + "JOIN bet_signals bs ON bs.game_date=gl.game_date AND bs.game_id=gl.game_id "
  + "WHERE bs.outcome IS NOT NULL AND bs.outcome != 'pending' "
  + "AND gl.away_score IS NOT NULL AND gl.home_score IS NOT NULL";
var params = [];
if (DATE_START && DATE_END) { gameSql += ' AND gl.game_date BETWEEN ? AND ?'; params = [DATE_START, DATE_END]; }
else if (DATE_START)       { gameSql += ' AND gl.game_date = ?';             params = [DATE_START]; }
gameSql += ' ORDER BY gl.game_date, gl.game_id';

var stmt = db.prepare(gameSql);
var games = stmt.all.apply(stmt, params);

if (!games.length) {
  console.log('No resolved games found' + (DATE_START ? ' in range ' + DATE_START + (DATE_END ? '..' + DATE_END : '') : ''));
  process.exit(0);
}

console.log('Backtest: SP/RP weight split');
console.log('  A = current   SP_PIT=0.90  RELIEF_PIT=0.10');
console.log('  B = proposed  SP_PIT=0.75  RELIEF_PIT=0.25');
console.log('Universe: ' + games.length + ' resolved games  ('
  + games[0].game_date + ' → ' + games[games.length - 1].game_date + ')');
console.log('='.repeat(80));

var STARS = ['1\u2605', '2\u2605', '3\u2605'];
var TYPES = ['ML:away', 'ML:home', 'Total:over', 'Total:under'];
function newStats() {
  var s = { overall: emptyBucket(), byStar: {}, byType: {} };
  for (var i = 0; i < STARS.length; i++) s.byStar[STARS[i]] = emptyBucket();
  for (var j = 0; j < TYPES.length; j++) s.byType[TYPES[j]] = emptyBucket();
  return s;
}
var stats = { A: newStats(), B: newStats() };

var diffAnotB = [];
var diffBnotA = [];

function sigKey(s) { return s.type + ':' + s.side; }

var processed = 0, skipped = 0;
for (var gi = 0; gi < games.length; gi++) {
  var g = games[gi];
  try {
    var gameA = buildGame(g, scenarios.A);
    var gameB = buildGame(g, scenarios.B);
    var mA = model.runModel(gameA, wobaIdx, scenarios.A);
    var mB = model.runModel(gameB, wobaIdx, scenarios.B);
    var sigsA = model.getSignals(gameA, mA, scenarios.A);
    var sigsB = model.getSignals(gameB, mB, scenarios.B);

    var pairs = [['A', sigsA], ['B', sigsB]];
    for (var pi = 0; pi < pairs.length; pi++) {
      var scen = pairs[pi][0];
      var sigs = pairs[pi][1];
      for (var si = 0; si < sigs.length; si++) {
        var s = sigs[si];
        var gr = grade(s, g);
        if (!gr) continue;
        accumulate(stats[scen].overall, gr);
        if (stats[scen].byStar[s.label]) accumulate(stats[scen].byStar[s.label], gr);
        var tk = s.type + ':' + s.side;
        if (stats[scen].byType[tk]) accumulate(stats[scen].byType[tk], gr);
      }
    }

    var keysA = {}, keysB = {};
    for (var ai = 0; ai < sigsA.length; ai++) keysA[sigKey(sigsA[ai])] = sigsA[ai];
    for (var bi = 0; bi < sigsB.length; bi++) keysB[sigKey(sigsB[bi])] = sigsB[bi];
    for (var ka in keysA) if (!keysB[ka]) diffAnotB.push({ game: g.game_id, date: g.game_date, sig: keysA[ka], graded: grade(keysA[ka], g) });
    for (var kb in keysB) if (!keysA[kb]) diffBnotA.push({ game: g.game_id, date: g.game_date, sig: keysB[kb], graded: grade(keysB[kb], g) });

    processed++;
  } catch (e) {
    skipped++;
    console.log('skip ' + g.game_date + '/' + g.game_id + ': ' + e.message);
  }
}

console.log('Processed: ' + processed + ', skipped: ' + skipped);

function printSection(name, stat) {
  console.log('');
  console.log('Scenario ' + name);
  console.log(pad('', 18, true) + pad('plays', 7) + pad('W', 5) + pad('L', 5) + pad('P', 5) + pad('win%', 9) + pad('pnl', 11) + pad('roi', 10));
  console.log('-'.repeat(70));
  var o = stat.overall;
  console.log(pad('OVERALL', 18, true) + pad(o.plays, 7) + pad(o.wins, 5) + pad(o.losses, 5) + pad(o.pushes, 5) + pad(winPct(o), 9) + pad(o.pnl.toFixed(2), 11) + pad(roi(o), 10));
  console.log('  by star rating');
  for (var i = 0; i < STARS.length; i++) {
    var b = stat.byStar[STARS[i]];
    console.log(pad('  ' + STARS[i], 18, true) + pad(b.plays, 7) + pad(b.wins, 5) + pad(b.losses, 5) + pad(b.pushes, 5) + pad(winPct(b), 9) + pad(b.pnl.toFixed(2), 11) + pad(roi(b), 10));
  }
  console.log('  by signal type');
  for (var j = 0; j < TYPES.length; j++) {
    var bt = stat.byType[TYPES[j]];
    console.log(pad('  ' + TYPES[j], 18, true) + pad(bt.plays, 7) + pad(bt.wins, 5) + pad(bt.losses, 5) + pad(bt.pushes, 5) + pad(winPct(bt), 9) + pad(bt.pnl.toFixed(2), 11) + pad(roi(bt), 10));
  }
}

printSection('A (SP=0.90 / RP=0.10)', stats.A);
printSection('B (SP=0.75 / RP=0.25)', stats.B);

function printDiffTable(title, rows) {
  console.log('');
  console.log('='.repeat(80));
  console.log(title + '  (' + rows.length + ')');
  console.log(pad('date', 12, true) + pad('game', 12, true) + pad('signal', 16, true) + pad('label', 6, true) + pad('market', 9) + pad('outcome', 9) + pad('pnl', 9));
  console.log('-'.repeat(80));
  var n = Math.min(rows.length, 40);
  for (var i = 0; i < n; i++) {
    var r = rows[i];
    var s = r.sig;
    console.log(pad(r.date, 12, true)
      + pad(r.game, 12, true)
      + pad(s.type + ':' + s.side, 16, true)
      + pad(s.label, 6, true)
      + pad(String(s.marketLine), 9)
      + pad((r.graded && r.graded.outcome) || '—', 9)
      + pad(r.graded && typeof r.graded.pnl === 'number' ? r.graded.pnl.toFixed(2) : '—', 9));
  }
  if (rows.length > n) console.log('  ... ' + (rows.length - n) + ' more rows');
  var tot = emptyBucket();
  for (var k = 0; k < rows.length; k++) accumulate(tot, rows[k].graded);
  console.log('  TOTAL: ' + tot.wins + 'W / ' + tot.losses + 'L / ' + tot.pushes + 'P   '
    + 'win% ' + winPct(tot) + '   pnl ' + tot.pnl.toFixed(2) + '   roi ' + roi(tot));
}

printDiffTable('Signals unique to A (would NOT fire under B)', diffAnotB);
printDiffTable('Signals unique to B (would NOT fire under A)', diffBnotA);

console.log('');
