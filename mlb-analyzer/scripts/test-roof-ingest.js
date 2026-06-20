'use strict';
// Local test for services/roof-ari.js — runs the same flow runWeatherJob
// will run. Reports scraped rows, planned updates, post-state on
// matched game_log rows. Local DB only.
//
// Usage (from repo root):
//   node scripts/test-roof-ingest.js          # dry-run (rollback)
//   node scripts/test-roof-ingest.js --commit # write to local DB

const path = require('path');
// Resolve to repo root so data/mlb.db opens correctly regardless of cwd.
process.chdir(path.join(__dirname, '..'));

const { db } = require('../db/schema');
const { runRoofStatusIngest } = require('../services/roof-ari');

(async () => {
  const commit = process.argv.includes('--commit');
  console.log('mode: ' + (commit ? 'COMMIT' : 'DRY-RUN (rollback after summary)'));
  console.log('DB:', db.name);
  console.log();

  const before = db.prepare(
    "SELECT game_date, game_id, roof_status, roof_confidence, temp_run_adj, wind_factor "
    + "FROM game_log WHERE venue_id=15 AND game_date >= '2026-04-01' "
    + "ORDER BY game_date LIMIT 60"
  ).all();
  console.log('Chase rows in DB (2026-04-01+):');
  for (const r of before) {
    console.log('  ' + r.game_date + '  ' + String(r.game_id || '').padEnd(14)
      + '  status=' + String(r.roof_status || 'null').padEnd(8)
      + '  conf=' + String(r.roof_confidence || 'null').padEnd(10)
      + '  temp_adj=' + (r.temp_run_adj == null ? 'null' : r.temp_run_adj)
      + '  wind=' + (r.wind_factor == null ? 'null' : r.wind_factor));
  }
  console.log();

  db.exec('BEGIN');
  let summary;
  try {
    summary = await runRoofStatusIngest('2026-06-19');
    if (commit) db.exec('COMMIT');
    else        db.exec('ROLLBACK');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log('=== summary ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!commit) console.log('\n(DRY-RUN — local DB rolled back.)');
})().catch(e => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
