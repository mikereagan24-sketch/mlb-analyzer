'use strict';
// SELECT DISTINCT on the SHAPE of game_time across game_log — reduces
// each value to a template (digit→D, letter→A) so shape-classes cluster
// even when the specific times differ. Also samples per lineup_source
// (statsapi vs rotowire vs unabated bootstrap paths).

const path = require('path');
const Database = require(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'node_modules', 'better-sqlite3'));
const db = new Database(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'data', 'mlb.db'), { readonly: true });

function shape(s) {
  if (s == null) return '<null>';
  if (s === '') return '<empty>';
  return String(s)
    .replace(/[0-9]/g, 'D')
    .replace(/[A-Za-z]/g, 'A');
}

// 1) Shape distribution across ALL rows
const rows = db.prepare("SELECT game_time FROM game_log").all();
const byShape = {};
for (const r of rows) {
  const s = shape(r.game_time);
  if (!byShape[s]) byShape[s] = { count: 0, sample: r.game_time };
  byShape[s].count++;
}
console.log('== shape distribution across ' + rows.length + ' game_log rows ==');
const entries = Object.entries(byShape).sort((a, b) => b[1].count - a[1].count);
for (const [s, v] of entries) {
  console.log('  ' + String(v.count).padStart(6, ' ') + '  shape="' + s + '"    sample=' + JSON.stringify(v.sample));
}

// 2) Regex-match rate: how many pass the CURRENT weather.js parser?
const currentRe = /(\d+):(\d+)\s*(AM|PM)/i;
let pass = 0, fail = 0, nullEmpty = 0;
const failSamples = [];
for (const r of rows) {
  if (r.game_time == null || r.game_time === '') { nullEmpty++; continue; }
  if (currentRe.test(r.game_time)) pass++;
  else { fail++; if (failSamples.length < 10) failSamples.push(r.game_time); }
}
console.log('\n== current weather.js regex /(\\d+):(\\d+)\\s*(AM|PM)/i match rate ==');
console.log('  pass:        ' + pass);
console.log('  fail:        ' + fail);
console.log('  null/empty:  ' + nullEmpty);
if (failSamples.length) console.log('  fail samples: ' + JSON.stringify(failSamples));

// 3) Per-source-path breakdown (lineup_source is closest proxy to
// which bootstrap path wrote the row)
const perSrc = db.prepare(
  "SELECT COALESCE(lineup_source, '<null>') AS src, game_time, COUNT(*) AS n " +
  "FROM game_log GROUP BY src, game_time ORDER BY src, n DESC"
).all();
const bySource = {};
for (const r of perSrc) {
  const src = r.src;
  const s = shape(r.game_time);
  if (!bySource[src]) bySource[src] = {};
  if (!bySource[src][s]) bySource[src][s] = { count: 0, sample: r.game_time };
  bySource[src][s].count += r.n;
}
console.log('\n== shape × lineup_source ==');
for (const src of Object.keys(bySource).sort()) {
  console.log('  source=' + src);
  const inner = Object.entries(bySource[src]).sort((a, b) => b[1].count - a[1].count);
  for (const [s, v] of inner) {
    console.log('    ' + String(v.count).padStart(5, ' ') + '  shape="' + s + '"    sample=' + JSON.stringify(v.sample));
  }
}

// 4) Distinct value dump when the row count is small — sometimes more
//    useful than shape classes
const distinct = db.prepare("SELECT COUNT(DISTINCT game_time) AS n FROM game_log").get();
console.log('\ndistinct game_time values: ' + distinct.n);

// 5) Recent DH rows specifically — DH bootstrap can take different
//    paths for leg 2 (bal-bos-g2 style)
const dhRows = db.prepare("SELECT game_date, game_id, game_time, lineup_source FROM game_log WHERE game_number > 1 ORDER BY game_date DESC LIMIT 20").all();
console.log('\n== recent DH rows (game_number > 1) ==');
for (const r of dhRows) {
  console.log('  ' + r.game_date + '  ' + r.game_id.padEnd(16) + '  game_time=' + JSON.stringify(r.game_time)
    + '  source=' + (r.lineup_source || '<null>'));
}

// 6) ATH rows in the last two weeks — the actual bug's population
const athRows = db.prepare(
  "SELECT game_date, game_id, game_time, lineup_source, home_team " +
  "FROM game_log WHERE (LOWER(home_team)='ath' OR LOWER(home_team)='oak') " +
  "AND game_date >= '2026-07-10' ORDER BY game_date DESC LIMIT 20"
).all();
console.log('\n== recent ATH home games ==');
for (const r of athRows) {
  console.log('  ' + r.game_date + '  ' + r.game_id.padEnd(16) + '  home=' + r.home_team
    + '  game_time=' + JSON.stringify(r.game_time) + '  source=' + (r.lineup_source || '<null>'));
}
