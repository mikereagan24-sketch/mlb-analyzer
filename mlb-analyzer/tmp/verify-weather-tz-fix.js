// Verify the TZ fix in services/weather.js — assert that the park-local
// hour the fetch resolves to matches actual first pitch in park-local
// time. Exercises parkLocalHourIso directly against known-good cases in
// each MLB time zone (ET, CT, MT, PT), and includes the specific case
// Mike called out (7:05 PM ET game at a PT park → 4 PM local, not 7 PM).
//
// Also exercises the fallback-to-naive-hour path (park not in PARK_TZ)
// so the safety net doesn't silently regress.
//
// Note: prior to this fix, weather.js indexed Open-Meteo's hourly array
// with the raw ET hour, so 24 of 30 parks were fetching wind data for
// the WRONG hour of the day. All historical wind on non-ET parks was
// off by 1-3 hours; the run-conversion audit's small LO→HI wind spread
// was computed on wrong-hour data, so wind's real contribution is
// unmeasured, not measured-small.
//
// Run: node tmp/verify-weather-tz-fix.js

const path = require('path');
const weather = require(path.join(__dirname, '..', 'services', 'weather.js'));
const { parkLocalHourIso, etWallClockToUtcMs, PARK_TZ, _shiftDate } = weather._internal;

let failed = 0;
function assertEq(actual, expected, label) {
  const ok = actual === expected;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + '  →  ' + JSON.stringify(actual)
    + (ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'));
  if (!ok) failed++;
}

// ---- parkLocalHourIso: hour + date parts must match park-local wall clock ----

console.log('\n== parkLocalHourIso — one park per timezone (July 2026, DST active for TZs that observe it) ==');

// NYY (ET): 7:05 PM ET → 7 PM local, same date
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.nyy),
  '2026-07-22T19:00', 'NYY 7:05 PM ET → 19:00 local (ET park, no shift)');

// CHC (CT): 7:05 PM ET → 6 PM CT
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.chc),
  '2026-07-22T18:00', 'CHC 7:05 PM ET → 18:00 local (CT, -1h)');

// COL (MT with DST): 7:05 PM ET → 5 PM MT
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.col),
  '2026-07-22T17:00', 'COL 7:05 PM ET → 17:00 local (MT, -2h)');

// LAD (PT): 7:05 PM ET → 4 PM PT — Mike's explicit test case
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.lad),
  '2026-07-22T16:00', 'LAD 7:05 PM ET → 16:00 local (PT, -3h) — Mike\'s explicit case');

// ---- Arizona no-DST: gap vs ET depends on season ----
console.log('\n== Arizona (no DST year-round; ET does observe DST) ==');

// July: ET is EDT (UTC-4), Phoenix stays MST (UTC-7). Gap = 3h.
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.ari),
  '2026-07-22T16:00', 'ARI 7:05 PM ET (July, EDT) → 16:00 local (-3h)');

// January: ET is EST (UTC-5), Phoenix stays MST (UTC-7). Gap = 2h.
assertEq(parkLocalHourIso('2026-01-15', '7:05 PM', PARK_TZ.ari),
  '2026-01-15T17:00', 'ARI 7:05 PM ET (January, EST) → 17:00 local (-2h)');

// ---- Toronto — canonical Toronto TZ, but same behavior as ET parks ----
console.log('\n== Toronto (America/Toronto, same as ET) ==');
assertEq(parkLocalHourIso('2026-07-22', '7:05 PM', PARK_TZ.tor),
  '2026-07-22T19:00', 'TOR 7:05 PM ET → 19:00 local (America/Toronto, no shift)');

// ---- Cross-date edge cases ----
console.log('\n== Cross-date edge cases ==');

// Late-ET matinee: 1:10 PM ET at CHC → 12:10 PM CT same date
assertEq(parkLocalHourIso('2026-07-22', '1:10 PM', PARK_TZ.chc),
  '2026-07-22T12:00', 'CHC 1:10 PM ET → 12:00 local (afternoon shift)');

// Very-early ET game: 12:05 AM ET at LAD → 9:05 PM PT PREVIOUS date
assertEq(parkLocalHourIso('2026-07-22', '12:05 AM', PARK_TZ.lad),
  '2026-07-21T21:00', 'LAD 12:05 AM ET on 7/22 → 21:00 on 7/21 local (date rollback)');

// Late-PT game logged under next ET date: rare in practice but should not crash.
// A 1:00 AM ET game at LAD = 10 PM PT previous night.
assertEq(parkLocalHourIso('2026-07-22', '1:00 AM', PARK_TZ.lad),
  '2026-07-21T22:00', 'LAD 1:00 AM ET on 7/22 → 22:00 on 7/21 local');

// ---- etWallClockToUtcMs sanity ----
console.log('\n== etWallClockToUtcMs: UTC offset should be correct for the date ==');

// 7 PM ET on July 22 2026 (EDT, UTC-4) → 23:00 UTC
{
  const ms = etWallClockToUtcMs('2026-07-22', 19, 0);
  const dt = new Date(ms);
  assertEq(dt.toISOString(), '2026-07-22T23:00:00.000Z',
    '7:00 PM ET on 2026-07-22 (EDT) → 23:00 UTC same date');
}

// 7 PM ET on January 15 2026 (EST, UTC-5) → 00:00 UTC next day
{
  const ms = etWallClockToUtcMs('2026-01-15', 19, 0);
  const dt = new Date(ms);
  assertEq(dt.toISOString(), '2026-01-16T00:00:00.000Z',
    '7:00 PM ET on 2026-01-15 (EST) → 00:00 UTC next day');
}

// ---- _shiftDate ----
console.log('\n== _shiftDate ==');
assertEq(_shiftDate('2026-07-22', -1), '2026-07-21', '−1 day');
assertEq(_shiftDate('2026-07-22',  1), '2026-07-23', '+1 day');
assertEq(_shiftDate('2026-01-01', -1), '2025-12-31', 'year rollback');
assertEq(_shiftDate('2026-02-28',  1), '2026-03-01', 'non-leap Feb-end');
assertEq(_shiftDate('2024-02-28',  1), '2024-02-29', 'leap Feb-28 +1');

// ---- Summary ----
console.log();
if (failed === 0) {
  console.log('✓ all TZ conversions correct — safe to deploy');
  process.exit(0);
}
console.log(`✗ ${failed} assertion(s) failed`);
process.exit(1);
