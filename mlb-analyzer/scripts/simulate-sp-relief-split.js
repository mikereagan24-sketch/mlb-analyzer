#!/usr/bin/env node
'use strict';

// Compare model output for today's slate under two SP/RP weight splits:
//   A (current)  SP_PIT=0.90, RELIEF_PIT=0.10
//   B (proposed) SP_PIT=0.75, RELIEF_PIT=0.25
// Every other setting stays at its app_settings value. Uses the app's own
// runModel/getSignals — no reimplementation of the math — but skips the
// DB writes that processGameSignals does.
//
// Usage:
//   node scripts/simulate-sp-relief-split.js              # defaults to 2026-04-18
//   node scripts/simulate-sp-relief-split.js 2026-04-19

const DATE = process.argv[2] || '2026-04-18';

const { q, db } = require('../db/schema');
const { runModel, getSignals } = require('../services/model');
const { getWobaIndex, getSettings } = require('../services/jobs');

function tryParse(str) { try { return str ? JSON.parse(str) : null; } catch (e) { return null; } }

function buildGame(gameRow, settings) {
  // Mirror processGameSignals' game-object setup without DB writes.
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
      var homeLU = tryParse(gameRow.home_lineup_json) || [];
      var awayLU = tryParse(gameRow.away_lineup_json) || [];
      var aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, homeLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      var hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, awayLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) { /* ignore, keep league-avg */ }
  return Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
  });
}

function fmtML(n) {
  if (n == null || isNaN(n)) return '—';
  var rounded = Math.round(n);
  return (rounded > 0 ? '+' : '') + rounded;
}
function signedDiff(n) {
  var r = Math.round(n);
  return (r > 0 ? '+' : '') + r;
}
function pad(s, n, right) {
  s = String(s);
  if (s.length >= n) return s;
  var fill = ' '.repeat(n - s.length);
  return right ? s + fill : fill + s;
}
function starRank(lbl) {
  if (!lbl) return 0;
  if (lbl[0] === '3') return 3;
  if (lbl[0] === '2') return 2;
  if (lbl[0] === '1') return 1;
  return 0;
}
function sigKey(s) { return s.type + ':' + s.side; }
function findSig(sigs, key) {
  for (var i = 0; i < sigs.length; i++) if (sigKey(sigs[i]) === key) return sigs[i];
  return null;
}

// --- main ---
var wobaIdx = getWobaIndex();
var base = getSettings();

var settingsA = Object.assign({}, base, { SP_PIT_WEIGHT: 0.90, RELIEF_PIT_WEIGHT: 0.10 });
var settingsB = Object.assign({}, base, { SP_PIT_WEIGHT: 0.75, RELIEF_PIT_WEIGHT: 0.25 });

var games = db.prepare('SELECT * FROM game_log WHERE game_date=? ORDER BY game_id').all(DATE);
if (!games.length) {
  console.log('No games for ' + DATE);
  process.exit(0);
}

console.log('Simulation: SP/RP weight split for ' + DATE);
console.log('  A = current   SP_PIT=0.90  RELIEF_PIT=0.10');
console.log('  B = proposed  SP_PIT=0.75  RELIEF_PIT=0.25');
console.log('  (all other settings identical — read from app_settings)');
console.log('');
console.log('Games: ' + games.length);
console.log('='.repeat(78));

var summary = { appeared: 0, disappeared: 0, upgraded: 0, downgraded: 0, unchanged: 0 };

for (var gi = 0; gi < games.length; gi++) {
  var g = games[gi];
  var gameA = buildGame(g, settingsA);
  var gameB = buildGame(g, settingsB);
  var mA = runModel(gameA, wobaIdx, settingsA);
  var mB = runModel(gameB, wobaIdx, settingsB);
  var sigsA = getSignals(gameA, mA, settingsA);
  var sigsB = getSignals(gameB, mB, settingsB);

  var dbSigs = db.prepare(
    "SELECT signal_type, signal_side, signal_label, market_line, model_line, edge_pct " +
    "FROM bet_signals WHERE game_date=? AND game_id=? AND is_active=1 " +
    "ORDER BY signal_type, signal_side"
  ).all(DATE, g.game_id);

  var away = (g.away_team || '').toUpperCase();
  var home = (g.home_team || '').toUpperCase();

  console.log('');
  console.log('-'.repeat(78));
  console.log(away + ' @ ' + home + '   ' + g.game_id + '   SP: ' + (g.away_sp || 'TBD') + ' / ' + (g.home_sp || 'TBD'));
  console.log('-'.repeat(78));
  console.log(pad('', 10, true) + pad('A (90/10)', 14) + pad('B (75/25)', 14) + pad('Δ', 10));
  console.log(pad('away ML', 10, true) + pad(fmtML(mA.aML), 14) + pad(fmtML(mB.aML), 14) + pad(signedDiff(mB.aML - mA.aML), 10));
  console.log(pad('home ML', 10, true) + pad(fmtML(mA.hML), 14) + pad(fmtML(mB.hML), 14) + pad(signedDiff(mB.hML - mA.hML), 10));
  console.log(pad('estTot', 10, true) + pad(mA.estTot.toFixed(2), 14) + pad(mB.estTot.toFixed(2), 14) + pad((mB.estTot - mA.estTot >= 0 ? '+' : '') + (mB.estTot - mA.estTot).toFixed(2), 10));

  console.log('');
  console.log('  Existing DB signals (is_active=1):');
  if (!dbSigs.length) {
    console.log('    (none)');
  } else {
    for (var di = 0; di < dbSigs.length; di++) {
      var ds = dbSigs[di];
      console.log('    ' + pad(ds.signal_type + ':' + ds.signal_side, 14, true)
        + ' ' + ds.signal_label
        + '  edge=' + (ds.edge_pct != null ? ds.edge_pct : '?')
        + '  market=' + ds.market_line
        + '  model=' + (ds.model_line != null ? ds.model_line : '?'));
    }
  }

  console.log('');
  console.log('  Signal change A → B:');
  var keySet = {};
  for (var ai = 0; ai < sigsA.length; ai++) keySet[sigKey(sigsA[ai])] = 1;
  for (var bi = 0; bi < sigsB.length; bi++) keySet[sigKey(sigsB[bi])] = 1;
  var keys = Object.keys(keySet).sort();
  if (!keys.length) {
    console.log('    (no signals in either scenario)');
  } else {
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      var a = findSig(sigsA, k);
      var b = findSig(sigsB, k);
      if (a && !b) {
        summary.disappeared++;
        console.log('    ' + pad(k, 14, true) + '  ' + a.label + ' → (disappears)');
      } else if (!a && b) {
        summary.appeared++;
        console.log('    ' + pad(k, 14, true) + '  (appears) → ' + b.label + '  edge=' + b.edge);
      } else if (a.label !== b.label) {
        var verdict = starRank(b.label) > starRank(a.label) ? 'UPGRADED' : 'DOWNGRADED';
        if (verdict === 'UPGRADED') summary.upgraded++; else summary.downgraded++;
        console.log('    ' + pad(k, 14, true) + '  ' + a.label + ' → ' + b.label + '   [' + verdict + ']  edgeA=' + a.edge + ' edgeB=' + b.edge);
      } else {
        summary.unchanged++;
        console.log('    ' + pad(k, 14, true) + '  ' + a.label + ' unchanged   edgeA=' + a.edge + ' edgeB=' + b.edge);
      }
    }
  }
}

console.log('');
console.log('='.repeat(78));
console.log('Summary across ' + games.length + ' games:');
console.log('  new signals appearing under B:         ' + summary.appeared);
console.log('  signals disappearing under B:          ' + summary.disappeared);
console.log('  upgraded star rating under B:          ' + summary.upgraded);
console.log('  downgraded star rating under B:        ' + summary.downgraded);
console.log('  unchanged (same side+label both):      ' + summary.unchanged);
