#!/usr/bin/env node
'use strict';

// Analyze whether starter workload correlates with model-total error.
// For each resolved game: pull starter IP from MLB Stats API, bucket by
// combined starter innings, and compare the model's projected total to the
// actual runs scored and the market total.
//
// Usage:
//   node scripts/analyze-starter-bullpen-theory.js                    # all dates
//   node scripts/analyze-starter-bullpen-theory.js 2026-04-01         # single date
//   node scripts/analyze-starter-bullpen-theory.js 2026-04-01 2026-04-30

var path = require('path');
var fs = require('fs');
var Database = require('better-sqlite3');
var fetch = require('node-fetch');

var DB_PATH = process.env.DB_PATH
  || (fs.existsSync('/data/mlb.db') ? '/data/mlb.db' : path.join(__dirname, '..', 'data', 'mlb.db'));
if (!fs.existsSync(DB_PATH)) { console.error('DB not found at ' + DB_PATH); process.exit(1); }

var DATE_START = process.argv[2] || null;
var DATE_END   = process.argv[3] || null;

var db = new Database(DB_PATH, { readonly: true });

// IMPORTANT: the MLB Stats /v1/schedule endpoint returns teams.{side}.team
// as { id, name, link } — NO abbreviation field. Match by the numeric team
// id (stable across seasons) on BOTH sides: map our game_id tokens to ids,
// and compare against the schedule's team ids.
//
// Aliases matter because different parts of the app use different short
// codes for the same club:
//   sf / sfg    (team 137 — Giants)
//   ath / oak   (team 133 — Athletics, pre/post-relocation)
//   was / wsh   (team 120 — Nationals)
//   kc / kan    (team 118 — Royals)
// The PARKS map in public/index.html, for instance, uses 'sfg' for SF.
// Covering both forms avoids silent skips.
var ABBR_TO_TEAM_ID = {
  laa: 108, ari: 109, bal: 110, bos: 111, chc: 112, cin: 113, cle: 114,
  col: 115, det: 116, hou: 117,
  kc:  118, kan: 118,
  lad: 119,
  was: 120, wsh: 120,
  nym: 121,
  ath: 133, oak: 133,
  pit: 134, sd:  135, sea: 136,
  sf:  137, sfg: 137,
  stl: 138, tb:  139, tex: 140, tor: 141, min: 142, phi: 143, atl: 144,
  cws: 145, mia: 146, nyy: 147, mil: 158,
};

// Set env DEBUG_MATCH=1 to log every schedule vs game_id mismatch.
var DEBUG = !!process.env.DEBUG_MATCH;

// MLB IP strings like "6.1" mean 6 innings + 1 out (= 6 1/3).
function parseIP(ipStr) {
  if (ipStr == null) return null;
  var p = String(ipStr).split('.');
  var whole = parseInt(p[0], 10);
  if (isNaN(whole)) return null;
  var outs = p[1] != null ? parseInt(p[1], 10) : 0;
  if (isNaN(outs)) outs = 0;
  return whole + (outs / 3);
}

// Buckets per spec:
//   both_short:    both SPs < 5
//   mixed:         one SP < 5, the other ≥ 5
//   both_average:  both SPs in [5, 6)
//   both_long:     both SPs ≥ 6
//   one_avg_one_long: leftover (one in [5,6), other ≥ 6). Not in the named
//                   four — surfaced separately so nothing is silently lost.
function bucket(a, h) {
  if (a < 5 && h < 5) return 'both_short';
  if ((a < 5 && h >= 5) || (a >= 5 && h < 5)) return 'mixed';
  if (a >= 5 && a < 6 && h >= 5 && h < 6) return 'both_average';
  if (a >= 6 && h >= 6) return 'both_long';
  return 'one_avg_one_long';
}

function pad(s, n, right) {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  var f = new Array(n - s.length + 1).join(' ');
  return right ? s + f : f + s;
}
function fmt(v, d) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(d == null ? 2 : d);
}
function signed(v, d) {
  if (v == null || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d);
}

// --- query resolved games ---
// NB: schema has away_sp / home_sp (the SP name column) and a single
// market_total — using those for the "away_pitcher / home_pitcher / market"
// fields from the spec.
var sql = 'SELECT game_date, game_id, away_team, home_team, away_score, home_score, '
        + 'away_sp AS away_pitcher, home_sp AS home_pitcher, market_total '
        + 'FROM game_log '
        + 'WHERE away_score IS NOT NULL AND home_score IS NOT NULL';
var params = [];
if (DATE_START && DATE_END) { sql += ' AND game_date BETWEEN ? AND ?'; params = [DATE_START, DATE_END]; }
else if (DATE_START)       { sql += ' AND game_date = ?';             params = [DATE_START]; }
sql += ' ORDER BY game_date, game_id';

var stmt = db.prepare(sql);
var games = stmt.all.apply(stmt, params);
if (!games.length) { console.log('No resolved games found'); process.exit(0); }

// Pre-aggregate model totals per game from bet_signals.
//   MIN(model_line) WHERE signal_type='Total' GROUP BY game_date, game_id
var modelTotMap = {};
var sigRows = db.prepare(
  "SELECT game_date, game_id, MIN(model_line) AS model_total " +
  "FROM bet_signals WHERE signal_type='Total' AND model_line IS NOT NULL " +
  "GROUP BY game_date, game_id"
).all();
for (var si = 0; si < sigRows.length; si++) {
  var row = sigRows[si];
  modelTotMap[row.game_date + '|' + row.game_id] = row.model_total;
}

// --- MLB Stats API helpers ---
var scheduleCache = {};
async function getSchedule(dateStr) {
  if (scheduleCache[dateStr]) return scheduleCache[dateStr];
  var p = dateStr.split('-');
  var url = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + p[1] + '/' + p[2] + '/' + p[0];
  var r = await fetch(url);
  if (!r.ok) throw new Error('schedule HTTP ' + r.status);
  var data = await r.json();
  scheduleCache[dateStr] = data;
  return data;
}
async function getBoxscore(gamePk) {
  var r = await fetch('https://statsapi.mlb.com/api/v1/game/' + gamePk + '/boxscore');
  if (!r.ok) throw new Error('boxscore HTTP ' + r.status);
  return await r.json();
}
function findGamePk(schedule, awayAbbr, homeAbbr, gameDateForLog, gameIdForLog) {
  var wantAwayId = ABBR_TO_TEAM_ID[awayAbbr];
  var wantHomeId = ABBR_TO_TEAM_ID[homeAbbr];
  if (!wantAwayId || !wantHomeId) {
    if (DEBUG) console.error('[debug] unknown abbr in game_id ' + gameIdForLog
      + ' (away=' + awayAbbr + ' -> ' + wantAwayId + ', home=' + homeAbbr + ' -> ' + wantHomeId + ')');
    return null;
  }
  var days = schedule.dates || [];
  var candidates = []; // for debug
  for (var i = 0; i < days.length; i++) {
    var gs = days[i].games || [];
    for (var j = 0; j < gs.length; j++) {
      var g = gs[j];
      var awayId = g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.id;
      var homeId = g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.id;
      candidates.push({ awayId: awayId, homeId: homeId, gamePk: g.gamePk });
      if (awayId === wantAwayId && homeId === wantHomeId) return g.gamePk;
    }
  }
  if (DEBUG) {
    console.error('[debug] no pk for ' + gameDateForLog + '/' + gameIdForLog
      + ' (looking for ids ' + wantAwayId + '@' + wantHomeId + ', from abbr ' + awayAbbr + '@' + homeAbbr + '); schedule had:');
    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      console.error('  ' + c.awayId + '@' + c.homeId + ' pk=' + c.gamePk);
    }
  }
  return null;
}
function getStarterIP(boxscore, side) {
  var team = boxscore.teams && boxscore.teams[side];
  if (!team) return null;
  var pids = team.pitchers || [];
  if (!pids.length) return null;
  var starterId = pids[0];
  var player = team.players && team.players['ID' + starterId];
  if (!player) return null;
  var ip = player.stats && player.stats.pitching && player.stats.pitching.inningsPitched;
  return parseIP(ip);
}

// --- main ---
async function main() {
  console.log('Analyze: starter IP → total-accuracy buckets');
  console.log('Universe: ' + games.length + ' resolved games (' + games[0].game_date + ' → ' + games[games.length-1].game_date + ')');
  console.log('Fetching MLB Stats API boxscores — expect ~1-2 min for a full season');
  console.log('');

  var rows = [];
  var processed = 0;
  var skipNoPk = 0, skipNoIP = 0, skipError = 0;

  for (var i = 0; i < games.length; i++) {
    var g = games[i];
    var parts = (g.game_id || '').split('-');
    var awayAbbr = parts[0];
    var homeAbbr = parts[1];
    try {
      var sched = await getSchedule(g.game_date);
      var gamePk = findGamePk(sched, awayAbbr, homeAbbr, g.game_date, g.game_id);
      if (!gamePk) { skipNoPk++; process.stderr.write('?'); continue; }
      var box = await getBoxscore(gamePk);
      var awayIP = getStarterIP(box, 'away');
      var homeIP = getStarterIP(box, 'home');
      if (awayIP == null || homeIP == null) {
        skipNoIP++; process.stderr.write('!');
        if (DEBUG) console.error('[debug] no IP for ' + g.game_date + '/' + g.game_id + ' pk=' + gamePk
          + ' awayIP=' + awayIP + ' homeIP=' + homeIP);
        continue;
      }

      var key = g.game_date + '|' + g.game_id;
      var modelTot = modelTotMap[key];
      if (modelTot == null) modelTot = g.market_total; // fall back to market if no signal
      var actual = g.away_score + g.home_score;
      var error = modelTot != null ? (actual - modelTot) : null; // actual − model
      var marketErr = g.market_total != null ? (actual - g.market_total) : null;

      rows.push({
        date: g.game_date,
        game_id: g.game_id,
        away: (awayAbbr || '').toUpperCase(),
        home: (homeAbbr || '').toUpperCase(),
        awaySp: g.away_pitcher || '?',
        homeSp: g.home_pitcher || '?',
        awayIP: awayIP, homeIP: homeIP,
        combinedIP: awayIP + homeIP,
        market: g.market_total, model: modelTot, actual: actual,
        error: error, marketErr: marketErr,
        bucket: bucket(awayIP, homeIP),
        openerFlag: (awayIP < 2 || homeIP < 2),
      });
      processed++;
      if (processed % 20 === 0) process.stderr.write('.');
    } catch (e) {
      skipError++;
      process.stderr.write('x');
      if (DEBUG) console.error('[debug] error on ' + g.game_date + '/' + g.game_id + ': ' + e.message);
    }
  }
  process.stderr.write('\n');
  console.log('Processed: ' + processed
    + '  Skipped: ' + (skipNoPk + skipNoIP + skipError)
    + ' (no-pk=' + skipNoPk + ', no-IP=' + skipNoIP + ', error=' + skipError + ')');
  console.log('');

  // --- bucket summary ---
  var bucketOrder = ['both_short', 'mixed', 'both_average', 'both_long', 'one_avg_one_long'];
  var buckets = {}; for (var b = 0; b < bucketOrder.length; b++) buckets[bucketOrder[b]] = [];
  for (var r = 0; r < rows.length; r++) buckets[rows[r].bucket].push(rows[r]);

  console.log('Bucket summary  (error = actual − model,  positive = model UNDER-predicted)');
  console.log(
    pad('bucket', 18, true)
    + pad('n', 5)
    + pad('avg IP a/h', 14)
    + pad('avg actual', 11)
    + pad('avg model', 11)
    + pad('avg market', 11)
    + pad('avg error', 11)
    + pad('|avg error|', 11)
    + pad('|mkt err|', 11)
    + pad('bias', 18, true)
  );
  console.log('-'.repeat(121));

  for (var bi = 0; bi < bucketOrder.length; bi++) {
    var bn = bucketOrder[bi];
    var rs = buckets[bn];
    if (!rs.length) {
      console.log(pad(bn, 18, true) + pad('0', 5) + pad('—', 14) + pad('—', 11) + pad('—', 11) + pad('—', 11) + pad('—', 11) + pad('—', 11) + pad('—', 11));
      continue;
    }
    var sumA=0, sumH=0, sumAct=0, sumModel=0, sumMarket=0, sumErr=0, sumAbsErr=0, sumAbsMktErr=0;
    var nModel=0, nMarket=0;
    for (var k = 0; k < rs.length; k++) {
      var x = rs[k];
      sumA += x.awayIP; sumH += x.homeIP; sumAct += x.actual;
      if (x.model != null) { sumModel += x.model; sumErr += x.error; sumAbsErr += Math.abs(x.error); nModel++; }
      if (x.market != null) { sumMarket += x.market; sumAbsMktErr += Math.abs(x.marketErr); nMarket++; }
    }
    var avgErr = nModel ? (sumErr / nModel) : null;
    var biasLabel;
    if (avgErr == null) biasLabel = '—';
    else if (Math.abs(avgErr) < 0.15) biasLabel = 'neutral';
    else if (avgErr > 0) biasLabel = 'model UNDER-preds';
    else biasLabel = 'model OVER-preds';

    console.log(
      pad(bn, 18, true)
      + pad(String(rs.length), 5)
      + pad(fmt(sumA / rs.length) + ' / ' + fmt(sumH / rs.length), 14)
      + pad(fmt(sumAct / rs.length), 11)
      + pad(nModel ? fmt(sumModel / nModel) : '—', 11)
      + pad(nMarket ? fmt(sumMarket / nMarket) : '—', 11)
      + pad(nModel ? signed(avgErr) : '—', 11)
      + pad(nModel ? fmt(sumAbsErr / nModel) : '—', 11)
      + pad(nMarket ? fmt(sumAbsMktErr / nMarket) : '—', 11)
      + pad(biasLabel, 18, true)
    );
  }

  // --- full game table ---
  console.log('');
  console.log('Full game-by-game table (' + rows.length + ' rows). "*" on IP = <2 IP, possible opener');
  console.log(
    pad('date', 12, true)
    + pad('matchup', 11, true)
    + pad('away SP', 19, true)
    + pad('IPa', 7)
    + pad('home SP', 19, true)
    + pad('IPh', 7)
    + pad('market', 8)
    + pad('model', 8)
    + pad('actual', 8)
    + pad('error', 9)
    + pad('bucket', 18, true)
  );
  console.log('-'.repeat(126));

  for (var gi = 0; gi < rows.length; gi++) {
    var row = rows[gi];
    var aMark = row.awayIP < 2 ? '*' : '';
    var hMark = row.homeIP < 2 ? '*' : '';
    console.log(
      pad(row.date, 12, true)
      + pad(row.away + '@' + row.home, 11, true)
      + pad((row.awaySp || '?').slice(0, 17), 19, true)
      + pad(row.awayIP.toFixed(1) + aMark, 7)
      + pad((row.homeSp || '?').slice(0, 17), 19, true)
      + pad(row.homeIP.toFixed(1) + hMark, 7)
      + pad(row.market != null ? row.market.toFixed(1) : '—', 8)
      + pad(row.model  != null ? row.model.toFixed(2)  : '—', 8)
      + pad(String(row.actual), 8)
      + pad(signed(row.error), 9)
      + pad(row.bucket, 18, true)
    );
  }

  console.log('');
  console.log('Legend:');
  console.log('  both_short       : both SPs < 5 IP');
  console.log('  mixed            : exactly one SP < 5 (the other ≥ 5)');
  console.log('  both_average     : both SPs in [5, 6) IP');
  console.log('  both_long        : both SPs ≥ 6 IP');
  console.log('  one_avg_one_long : one SP in [5,6), the other ≥ 6 (leftover)');
  console.log('  error            : actual − model  (+ = model under-predicted, − = model over-predicted)');
  console.log('  bias             : neutral if |avg error| < 0.15, else UNDER/OVER');
  console.log('  *                : IP < 2 — possible opener, starter math may not apply');
}

main().catch(function(err) {
  console.error('FATAL:', err);
  process.exit(1);
});
