'use strict';
// End-to-end verification of the __NEXT_DATA__ scraper against the
// live D-backs page + local DB. Snapshots current roof state for all
// ARI home games in the scraper window, runs the ingest, then diffs.
// No weather-job side effects; we only exercise roof-ari.

const { db } = require('../db/schema');
const { runRoofStatusIngest } = require('../services/roof-ari');

(async () => {
  const window = db.prepare(
    "SELECT game_date, game_id, roof_status, roof_confidence, "
    + "wind_factor, temp_run_adj, temp_f "
    + "FROM game_log WHERE venue_id = 15 AND game_date BETWEEN ? AND ? "
    + "ORDER BY game_date"
  ).all('2026-08-01', '2026-08-15');
  const before = Object.fromEntries(window.map(r => [r.game_date + '|' + r.game_id, r]));
  console.log('BEFORE — ARI home games 2026-08-01..15:');
  for (const r of window) {
    console.log('  ' + r.game_date + ' ' + r.game_id
      + ' roof=' + r.roof_status + '/' + r.roof_confidence
      + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj + ' temp=' + r.temp_f);
  }

  console.log('\nRUNNING runRoofStatusIngest("2026-08-08")...');
  const summary = await runRoofStatusIngest('2026-08-08');
  console.log('summary:', JSON.stringify(summary, null, 2));

  const after = db.prepare(
    "SELECT game_date, game_id, roof_status, roof_confidence, "
    + "wind_factor, temp_run_adj, temp_f "
    + "FROM game_log WHERE venue_id = 15 AND game_date BETWEEN ? AND ? "
    + "ORDER BY game_date"
  ).all('2026-08-01', '2026-08-15');
  console.log('\nAFTER — ARI home games 2026-08-01..15:');
  for (const r of after) {
    const key = r.game_date + '|' + r.game_id;
    const b = before[key];
    const flip = (b && (b.roof_status !== r.roof_status || b.roof_confidence !== r.roof_confidence))
      ? '  <-- FLIPPED from ' + b.roof_status + '/' + b.roof_confidence
      : '';
    console.log('  ' + r.game_date + ' ' + r.game_id
      + ' roof=' + r.roof_status + '/' + r.roof_confidence
      + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj + ' temp=' + r.temp_f
      + flip);
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
