#!/usr/bin/env node
'use strict';

// One-shot: tag the 49 ATH home games (2026-03-01 → 2026-07-22) that
// pulled Oakland Coliseum weather instead of Sutter Health Park weather,
// due to a stale entry in services/weather.js PARKS map.
//
// Sets game_log.weather_contamination_reason = 'ath_coliseum_coords_pre_2026_07_27'
// for every ATH home game with the affected weather values.
//
// Does NOT overwrite wind_speed / wind_dir / wind_factor / temp_f /
// temp_run_adj. Those values remain the historical record of what the
// model actually saw at signal-emission time. Contamination tag lets
// downstream backtests / calibration exclude them without hiding the
// error.
//
// Also tags 6 ATH "home" games at Las Vegas Ballpark 2026-06-08 → 2026-06-14
// with a separate reason 'ath_vegas_venue_override_not_propagated_pre_2026_07_27'.
// Those games had venue_id=5355 correctly captured by the scraper but the
// weather fetch fell through to PARKS[ath] (Coliseum coords), so they got
// Oakland weather instead of Vegas. Distinct reason keeps the two bug
// families cleanly separable.
//
// USAGE: node scripts/tag-ath-coliseum-weather-contamination-2026-07-27.js
// USAGE: node scripts/tag-ath-coliseum-weather-contamination-2026-07-27.js --dry-run

var q_db = require('../db/schema');
var db = q_db.db;

var DRY_RUN = process.argv.indexOf('--dry-run') !== -1;
if (DRY_RUN) console.log('=== DRY RUN — no writes ===');
console.log('ATH weather-contamination backfill');
console.log('');

var COLISEUM_REASON = 'ath_coliseum_coords_pre_2026_07_27';
var VEGAS_REASON    = 'ath_vegas_venue_override_not_propagated_pre_2026_07_27';

// Identify affected rows
var athHome = db.prepare(
  "SELECT game_date, game_id, venue_id, wind_factor, temp_run_adj, weather_contamination_reason " +
  "FROM game_log " +
  "WHERE game_date >= '2026-03-01' AND home_team='ATH' AND wind_factor IS NOT NULL"
).all();
console.log('ATH home games with weather data: ' + athHome.length);

// Vegas series: game_date in 2026-06-08..14 AND venue_id=5355
var vegas = athHome.filter(r => r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && r.venue_id === 5355);
var coliseum = athHome.filter(r => !(r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && r.venue_id === 5355));
console.log('  → Coliseum-coords contamination: ' + coliseum.length);
console.log('  → Vegas-venue-override contamination: ' + vegas.length);
console.log('');

var alreadyTagged = athHome.filter(r => r.weather_contamination_reason != null);
if (alreadyTagged.length > 0) {
  console.log('WARN: ' + alreadyTagged.length + ' rows already have a contamination reason — will not overwrite');
}

var upd = db.prepare(
  "UPDATE game_log SET weather_contamination_reason = ?, updated_at = datetime('now') " +
  "WHERE game_date = ? AND game_id = ? AND weather_contamination_reason IS NULL"
);

var writeTx = db.transaction(function (rows, reason) {
  var n = 0;
  rows.forEach(function (r) {
    var res = upd.run(reason, r.game_date, r.game_id);
    if (res.changes > 0) n++;
  });
  return n;
});

var wroteColiseum = 0, wroteVegas = 0;
if (!DRY_RUN) {
  wroteColiseum = writeTx(coliseum, COLISEUM_REASON);
  wroteVegas    = writeTx(vegas,    VEGAS_REASON);
  console.log('WROTE ' + wroteColiseum + ' Coliseum tags, ' + wroteVegas + ' Vegas tags');
} else {
  console.log('DRY RUN — would write ' + coliseum.length + ' Coliseum tags, ' + vegas.length + ' Vegas tags');
}
console.log('');

// Verification: sample recent tagged rows
if (!DRY_RUN) {
  var sample = db.prepare(
    "SELECT game_date, game_id, wind_factor, temp_f, weather_contamination_reason " +
    "FROM game_log WHERE weather_contamination_reason LIKE 'ath_%' " +
    "ORDER BY game_date DESC LIMIT 5"
  ).all();
  console.log('Sample tagged rows (verification):');
  sample.forEach(function (r) {
    console.log('  ' + r.game_date + '  ' + r.game_id + '  wind_factor=' + r.wind_factor + '  temp_f=' + r.temp_f + '  reason=' + r.weather_contamination_reason);
  });
  console.log('');
  console.log('Values NOT overwritten — contamination is TAGGED, not re-scored.');
  console.log('Downstream: filter WHERE weather_contamination_reason IS NULL for weather-sensitive backtests.');
}
console.log('=== DONE ===');
