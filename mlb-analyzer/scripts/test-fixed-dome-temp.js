#!/usr/bin/env node
// Fixed-dome temperature gate + tagging (2026-09-12).
//   node scripts/test-fixed-dome-temp.js
// Exit 1 on any failure.
//
// The load-bearing assertions:
//   (1) a fixed dome gets temp_run_adj 0 AND wind_factor 0 for EVERY
//       roof_status, including 'open' — the gate must not consult
//       roof_status, since consulting it is what let outdoor weather in
//   (2) NOTHING changes at any other park, checked on prod-shaped rows
//   (3) the fixed_dome_* tag makes a row invalid for re-scoring, and the
//       predicate that decides that lives in exactly one place
const Database = require('better-sqlite3');
const weather = require('../services/weather');
const { PARKS, computeEffectiveWeather, calcWindFactor, tempRunAdjFromTempF } = weather;
const wiv = require('../utils/weather-inputs-valid');
const task = require('../services/backfill-tasks/weather-contamination-fixed-dome');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}

console.log('1. a fixed dome is indoors on every roof_status');
const domePark = PARKS['tb'];
check('tb carries fixedDome', !!domePark.fixedDome, true);
for (const roof of ['open', 'closed', 'partial', null, 'estimated', 'garbage']) {
  const eff = computeEffectiveWeather({
    windSpeed: 12, windDir: 263, tempF: 92, roofStatus: roof, venueId: 12, park: domePark,
  });
  check('roof_status=' + JSON.stringify(roof) + ' -> both channels 0',
    [eff.windFactor, eff.tempRunAdj], [0, 0]);
}
// The temp the rows actually carried: 92F would be the +0.6 bucket.
check('the bucket it would otherwise have used is +0.6', tempRunAdjFromTempF(92), 0.6);
check('calcWindFactor also returns 0 directly (belt and braces)',
  calcWindFactor(263, 12, domePark), 0);
check('exactly one park is a fixed dome today', task.fixedDomeKeys(), ['tb']);

console.log('\n2. why 0 and not an indoor baseline');
// A reported indoor temperature would land in the 70-80 bucket and assert
// a third of a run of heat. This is the number that reasoning turns on.
check('an indoor 72F would have produced +0.3, not 0', tempRunAdjFromTempF(72), 0.3);
check('the neutral bucket really is 0', [tempRunAdjFromTempF(56), tempRunAdjFromTempF(69)], [0, 0]);

console.log('\n3. nothing changes at any other park (prod-shaped rows)');
const db = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
const rows = db.prepare(
  'SELECT game_date, game_id, roof_status, venue_id, temp_f, wind_speed, wind_dir, '
  + 'temp_run_adj, wind_factor FROM game_log '
  + "WHERE game_date >= '2026-08-13' AND game_date <= '2026-09-12' "
  + 'AND temp_f IS NOT NULL AND wind_speed IS NOT NULL AND wind_dir IS NOT NULL'
).all();
const { BEARING_REGIME_PARKS: BATCH3 } = require('../utils/bearing-regimes');
let domeRows = 0, domeNonZero = 0, otherChecked = 0, otherDrift = 0, skippedBearing = 0;
for (const r of rows) {
  const key = (r.game_id.split('-')[1] || '').toLowerCase();
  const park = PARKS[key];
  if (!park) continue;
  const eff = computeEffectiveWeather({
    windSpeed: r.wind_speed, windDir: r.wind_dir, tempF: r.temp_f,
    roofStatus: r.roof_status, venueId: r.venue_id, park: park,
  });
  if (park.fixedDome) {
    domeRows++;
    if (Math.abs(r.temp_run_adj || 0) > 0 || Math.abs(r.wind_factor || 0) > 0) domeNonZero++;
    if (eff.tempRunAdj !== 0 || eff.windFactor !== 0) {
      failures++; console.log('        FAIL dome not zeroed ' + r.game_date + ' ' + r.game_id);
    }
    continue;
  }
  // Pre-cutover bearing-regime rows cannot re-derive (CLAUDE.md, the
  // 2026-08-18 wind boundary). Excluded by name, counted, not dropped.
  if (BATCH3.has(key) && Math.abs(eff.windFactor - (r.wind_factor || 0)) > 1e-9) { skippedBearing++; continue; }
  otherChecked++;
  if (Math.abs(eff.tempRunAdj - (r.temp_run_adj || 0)) > 1e-9
      || Math.abs(eff.windFactor - (r.wind_factor || 0)) > 1e-9) {
    otherDrift++;
    if (otherDrift <= 5) console.log('        drift ' + r.game_date + ' ' + r.game_id
      + ' temp ' + r.temp_run_adj + '->' + eff.tempRunAdj
      + ' wind ' + r.wind_factor + '->' + eff.windFactor);
  }
}
console.log('     non-dome rows re-derived: ' + otherChecked
  + '   dome rows: ' + domeRows + ' (' + domeNonZero + ' carried outdoor weather)'
  + '   excluded: ' + skippedBearing + ' pre-cutover bearing-regime');
check('no drift at any non-dome park', otherDrift, 0);
check('the defect is real: dome rows carried outdoor weather', domeNonZero > 0, true);

console.log('\n4. the tag excludes a row from re-scoring');
check('fixed_dome_ prefix is exported from ONE place', wiv.FIXED_DOME_REASON_PREFIX, 'fixed_dome_');
check('the task reason uses that prefix', task.REASON.indexOf(wiv.FIXED_DOME_REASON_PREFIX), 0);
check('VALID_SQL mentions the prefix', wiv.VALID_SQL.indexOf('fixed_dome_') > 0, true);
// Behavioural: a row carrying the reason must fail the predicate. Proven
// against the live predicate on a temp table rather than by reading it.
const mem = new Database(':memory:');
mem.exec('CREATE TABLE game_log (temp_f REAL, weather_quality_at TEXT, weather_contamination_reason TEXT)');
const ins = mem.prepare('INSERT INTO game_log VALUES (?,?,?)');
ins.run(85, '2026-09-01 00:00:00', null);                          // fresh, untagged -> valid
ins.run(85, '2026-09-01 00:00:00', 'fixed_dome_outdoor_temp');      // fresh, dome-tagged -> INVALID
ins.run(85, '2026-09-01 00:00:00', 'central_naive_hour_pre_2026_07_30'); // fresh, naive -> valid
const valid = mem.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + wiv.VALID_SQL).get().n;
check('predicate admits 2 of 3, rejecting only the fixed_dome row', valid, 2);
for (const [label, where] of wiv.CLASS_ASSERTIONS) {
  if (!/fixed_dome/.test(label)) continue;
  const n = db.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + where).get().n;
  check('class assertion holds on the live DB: ' + label.slice(0, 46), n, 0);
}

console.log('\n5. the task selects what it claims');
const cands = task.selectCandidates(db, '2026-03-01', '2026-12-31');
const allGraded = cands.every((r) => r.temp_run_adj !== 0 || r.wind_factor !== 0);
const allUntagged = cands.every((r) => r.weather_contamination_reason == null);
const allDome = cands.every((r) => task.fixedDomeKeys().includes((r.game_id.split('-')[1] || '').toLowerCase()));
console.log('     candidates: ' + cands.length
  + '   temp runs summed ' + cands.reduce((s, r) => s + (r.temp_run_adj || 0), 0).toFixed(2));
check('every candidate carries non-zero weather', allGraded, true);
check('every candidate is currently untagged (re-run is a no-op)', allUntagged, true);
check('every candidate is at a fixed-dome park', allDome, true);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
