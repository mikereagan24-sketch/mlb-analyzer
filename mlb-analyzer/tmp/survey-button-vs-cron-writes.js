'use strict';
// Best-effort quantification of button-written vs cron-written weather
// rows. There is no marker column, so this is heuristic — reports
// suspects, not counts. Confidence bands stated per bucket.

const path = require('path');
const Database = require(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'node_modules', 'better-sqlite3'));
const db = new Database(path.join('C:', 'Users', 'Mike Reagan', 'mlb-analyzer', 'mlb-analyzer', 'data', 'mlb.db'), { readonly: true });

console.log('=== game_log weather-write metadata ===');
const total = db.prepare("SELECT COUNT(*) AS n FROM game_log").get().n;
const wxSet = db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE temp_f IS NOT NULL").get().n;
const qualSet = db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE weather_quality='fresh'").get().n;
const qualAtSet = db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE weather_quality_at IS NOT NULL").get().n;
const tempButNoQual = db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE temp_f IS NOT NULL AND (weather_quality IS NULL OR weather_quality != 'fresh')").get().n;
console.log('  total rows:                              ' + total);
console.log('  rows with temp_f set:                    ' + wxSet);
console.log('  rows with weather_quality=fresh:         ' + qualSet);
console.log('  rows with weather_quality_at set:        ' + qualAtSet);
console.log('  rows with temp_f but NOT weather_quality=fresh:');
console.log('    ' + tempButNoQual + '  ← these are STRONG suspects for button-written OR very old (pre-cron) writes');

// Suspect #1: temp_f set but weather_quality_at is NULL. Cron always sets both.
console.log('\n=== SUSPECTS #1: temp_f set, weather_quality_at NULL ===');
console.log('(cron always sets weather_quality_at; if it is null while temp_f exists, it was written by something other than the cron)');
const s1 = db.prepare(
  "SELECT game_date, game_id, home_team, temp_f, wind_speed, wind_dir, weather_quality, weather_quality_at, updated_at " +
  "FROM game_log WHERE temp_f IS NOT NULL AND weather_quality_at IS NULL ORDER BY game_date DESC LIMIT 15"
).all();
console.log('  count: ' + db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE temp_f IS NOT NULL AND weather_quality_at IS NULL").get().n);
for (const r of s1) console.log('    ' + r.game_date + '  ' + r.game_id.padEnd(14) + '  home=' + r.home_team + '  temp=' + r.temp_f + '  qual=' + r.weather_quality + '  qual_at=' + r.weather_quality_at + '  upd=' + r.updated_at);

// Suspect #2: updated_at strictly LATER than weather_quality_at (something touched
// the row after the last cron weather write). Not proof of button — could be
// odds, lineups, roof, etc. — but every button-written weather row lives here.
console.log('\n=== SUSPECTS #2: updated_at > weather_quality_at (something wrote AFTER the last weather cron) ===');
const s2n = db.prepare(
  "SELECT COUNT(*) AS n FROM game_log WHERE temp_f IS NOT NULL AND weather_quality_at IS NOT NULL AND updated_at IS NOT NULL AND updated_at > weather_quality_at"
).get().n;
console.log('  count: ' + s2n + '  ← noisy: includes odds/lineup/roof writes, not just button');

// Suspect #3: ATH home games where temp_f is Oakland-consistent (cool marine
// layer) despite date being after the 2026-07-27 server coord fix.
console.log('\n=== SUSPECTS #3: ATH home games ===');
const athAll = db.prepare(
  "SELECT game_date, game_id, home_team, temp_f, wind_speed, weather_quality_at, updated_at, weather_contamination_reason " +
  "FROM game_log WHERE LOWER(home_team) IN ('ath','oak') ORDER BY game_date DESC LIMIT 30"
).all();
console.log('  recent ATH home rows (' + athAll.length + '):');
for (const r of athAll) {
  const oakCold = r.temp_f != null && r.temp_f >= 55 && r.temp_f <= 70;  // Oakland marine layer signature
  const sacHot  = r.temp_f != null && r.temp_f >= 82;                     // Sacramento hot signature
  const tag = oakCold ? '  OAK-consistent (cool)' : sacHot ? '  SAC-consistent (hot)' : '';
  console.log('    ' + r.game_date + '  ' + r.game_id.padEnd(14) + '  temp=' + r.temp_f + '°F  contam=' + (r.weather_contamination_reason || '-') + tag);
}

// The only clean marker: rows where a KNOWN post-fix cron would have written a
// specific ISO hour, but the persisted value is naive-hour. Requires re-fetch
// against Open-Meteo which this sandbox cannot reach. Punt to the prod-side
// backfill (Phase A) — during the re-fetch, log every row whose stored
// weather doesn't match the corrected value beyond the natural minute drift.
// That population = button-corrupted rows (post-fix cron would have matched).
console.log('\n=== interpretation ===');
console.log('There is NO deterministic marker in the schema. Best-effort suspects:');
console.log('  1. temp_f set with weather_quality_at NULL: strong suspect (' + db.prepare("SELECT COUNT(*) AS n FROM game_log WHERE temp_f IS NOT NULL AND weather_quality_at IS NULL").get().n + ' rows locally).');
console.log('  2. updated_at > weather_quality_at: noisy — button lives here but so do odds/lineup writes.');
console.log('  3. ATH home rows with Oakland-consistent temp (marine layer 55-70°F, ~9 PM PT).');
console.log('');
console.log('Definitive quantification requires either (a) an audit column added going forward,');
console.log('or (b) Phase A backfill logging every row whose corrected value differs from the persisted value');
console.log('by more than natural Open-Meteo minute drift (~1°F). That population = weather written by anything other than the corrected cron path.');
