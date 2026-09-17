#!/usr/bin/env node
'use strict';
// Read-only. Does the SHIPPED runline rule (utils/kalshi-runline.js) reproduce
// the +/-1.5 pair the Unabated merge wrote into game_log? (2026-09-17)
//
//   node --max-old-space-size=1536 scripts/measure-kalshi-runline-rule.js [FROM] [TO]
//
// Runs pickKalshiRunline itself over kalshi_spread_markets (the fee-adjusted
// ladder runOddsJob upserts; latest quote per market) and compares against
// game_log.market_*_spread for games whose runline was written while the
// Unabated fetch still ran. Only meaningful for dates before 2026-09-17:
// after that date game_log's runline IS this rule, so agreement is circular.
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { pickKalshiRunline } = require(path.join(R, 'utils/kalshi-runline'));

const FROM = process.argv[2] || '2026-08-15';
const TO = process.argv[3] || '2026-09-14';
if (TO >= '2026-09-17') console.log('WARNING: window reaches 2026-09-17+, where game_log runlines come from this rule (circular).');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const ladder = new Map();
for (const s of db.prepare("SELECT * FROM kalshi_spread_markets WHERE game_date BETWEEN ? AND ?").all(FROM, TO)) {
  const k = s.game_date + '|' + s.game_id;
  if (!ladder.has(k)) ladder.set(k, []);
  ladder.get(k).push(s);
}
const games = db.prepare(
  "SELECT game_date, game_id, away_team, home_team, market_away_spread, market_spread_src "
  + "FROM game_log WHERE game_date BETWEEN ? AND ? AND market_away_spread IS NOT NULL").all(FROM, TO);

let withLadder = 0, match = 0, mismatch = 0;
const refused = {}, bySrc = {}, gapBuckets = { '<0.02': [0, 0], '0.02-0.05': [0, 0], '>=0.05': [0, 0] };
for (const g of games) {
  const rows = ladder.get(g.game_date + '|' + g.game_id);
  const src = g.market_spread_src || '<null>';
  bySrc[src] = bySrc[src] || { n: 0, ladder: 0, match: 0 };
  bySrc[src].n++;
  if (!rows) continue;
  withLadder++; bySrc[src].ladder++;
  const rl = pickKalshiRunline(rows, g.away_team, g.home_team);
  if (rl.refused) { refused[rl.refused.replace(/\(.*\)/, '(...)')] = (refused[rl.refused.replace(/\(.*\)/, '(...)')] || 0) + 1; continue; }
  const ok = rl.away_spread === g.market_away_spread;
  if (ok) { match++; bySrc[src].match++; } else mismatch++;
  const A = rows.find(r => r.spread_line === 1.5 && String(r.spread_team).toUpperCase() === String(g.away_team).toUpperCase());
  const H = rows.find(r => r.spread_line === 1.5 && String(r.spread_team).toUpperCase() === String(g.home_team).toUpperCase());
  if (A && H) {
    const gap = Math.abs(A.yes_ask_dollars - H.yes_ask_dollars);
    const b = gap < 0.02 ? '<0.02' : gap < 0.05 ? '0.02-0.05' : '>=0.05';
    gapBuckets[b][0]++; if (ok) gapBuckets[b][1]++;
  }
}
console.log('window ' + FROM + '..' + TO + ': ' + games.length + ' games with a stored runline, ' + withLadder + ' with a Kalshi ladder');
console.log('pickKalshiRunline side matches stored side: ' + match + ', mismatches: ' + mismatch
  + ', refused: ' + Object.values(refused).reduce((a, b) => a + b, 0) + ' ' + JSON.stringify(refused));
for (const [s, v] of Object.entries(bySrc)) console.log('   stored src ' + s.padEnd(18) + ' ladder ' + v.ladder + '/' + v.n + '   match ' + v.match);
console.log('match by |YES gap| between the two 1.5 markets:');
for (const [b, v] of Object.entries(gapBuckets)) console.log('   ' + b.padEnd(10) + v[1] + '/' + v[0]);
