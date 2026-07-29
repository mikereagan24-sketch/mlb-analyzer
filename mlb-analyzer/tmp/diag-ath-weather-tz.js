'use strict';
// Diagnose the ATH weather-hour bug on prod (79°F matches Sacramento at
// 9 PM PT, but ATH first pitch is 6:40 PM PT = 9:40 PM ET; naive
// fallback signature).
//
// Runs main's services/weather.js as-is (not the branch's — checkout
// origin/main:mlb-analyzer/services/weather.js if you want the deployed
// code, or just run this from a checkout of main). This script only
// requires the CURRENT services/weather.js in the working tree.
//
// Emits: PARKS↔PARK_TZ coverage diff, then for each ATH-side test
// case, the exact code path (park-local ISO match vs naive fallback)
// and which hour got picked in the returned data.

const w = require('../services/weather');
const { PARKS } = w;
const { PARK_TZ, parkLocalHourIso, _shiftDate } = w._internal;

// ── (2) PARK_TZ coverage against every key in PARKS ────────
console.log('== PARK_TZ coverage check ==');
const parksKeys = Object.keys(PARKS).sort();
const tzKeys = Object.keys(PARK_TZ).sort();
const missing = parksKeys.filter(k => !(k in PARK_TZ));
const orphan = tzKeys.filter(k => !(k in PARKS));
console.log('  PARKS keys:   ' + parksKeys.length + ' (' + parksKeys.join(', ') + ')');
console.log('  PARK_TZ keys: ' + tzKeys.length + ' (' + tzKeys.join(', ') + ')');
if (missing.length) console.log('  MISSING TZ (→ naive fallback fires for each):  ' + missing.join(', '));
else console.log('  MISSING TZ: none — every PARKS key has a PARK_TZ entry');
if (orphan.length) console.log('  ORPHAN PARK_TZ (no PARKS entry): ' + orphan.join(', '));
console.log('');

// ── (1) Direct confirmation on 'ath' + 'oak' ───────────────
console.log('== ath / oak specifically ==');
for (const k of ['ath', 'oak']) {
  console.log('  ' + k + ': PARKS = ' + JSON.stringify(PARKS[k]) + '  PARK_TZ = ' + (PARK_TZ[k] || 'MISSING'));
}
console.log('');

// ── (3+4) For today's ATH game: log the code path + game_time parse ─
const CASES = [
  { desc: 'today ATH first pitch as game_time="6:40 PM ET" (unlikely — game_time is ET)',
    date: '2026-07-29', game_time: '6:40 PM ET' },
  { desc: 'today ATH first pitch as game_time="9:40 PM ET" (actual ET wall-clock)',
    date: '2026-07-29', game_time: '9:40 PM ET' },
  // Sanity check with a known-good ET home game
  { desc: 'CIN 7:10 PM ET (sanity: should hit 19:00 ET)',
    date: '2026-07-29', game_time: '7:10 PM ET', park: 'cin' },
];

console.log('== path trace per case ==');
for (const c of CASES) {
  const parkKey = c.park || 'ath';
  const park = PARKS[parkKey];
  const tz = PARK_TZ[parkKey];
  console.log('  case: ' + c.desc);
  console.log('    park=' + parkKey + '  coords=(' + park.lat + ',' + park.lng + ')  tz=' + tz);
  const iso = parkLocalHourIso(c.date, c.game_time, tz);
  const parseM = c.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  const parses = !!parseM;
  console.log('    game_time="' + c.game_time + '" parses=' + parses
    + (parses ? '  → naive-ET-hour = ' + (parseM[3].toUpperCase() === 'PM' && +parseM[1] !== 12 ? +parseM[1] + 12
      : parseM[3].toUpperCase() === 'AM' && +parseM[1] === 12 ? 0 : +parseM[1]) : ''));
  console.log('    parkLocalHourIso() → ' + iso + (iso ? '  ← this is what indexOf targets' : '  ← NULL, forces naive-fallback'));

  if (!iso) { console.log(''); continue; }

  // Hit Open-Meteo and see whether the ISO is in the array (+ what hour
  // it would map to, and what wind/temp the naive fallback would pick
  // instead).
  const startDate = _shiftDate(c.date, -1);
  const endDate = _shiftDate(c.date, +1);
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + park.lat + '&longitude=' + park.lng
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto'
    + '&start_date=' + startDate + '&end_date=' + endDate;
  (async () => {
    const r = await fetch(url, { headers: { 'User-Agent': 'diag-ath-weather-tz/1.0' } });
    const d = await r.json();
    const times = d.hourly && d.hourly.time || [];
    const idx = times.indexOf(iso);
    console.log('    Open-Meteo hourly.time samples: ' + times.slice(0, 3).join(', ') + ' …');
    console.log('    hourly.time.length = ' + times.length + '   timezone reported = ' + d.timezone);
    console.log('    indexOf(' + iso + ') = ' + idx
      + (idx >= 0 ? '  ← PARK-LOCAL PATH FIRES; temp=' + d.hourly.temperature_2m[idx] + '°F, wind=' + d.hourly.wind_speed_10m[idx] + 'mph at that hour'
        : '  ← MISS; naive-fallback FIRES'));

    // Show what the naive-fallback path would produce
    const parseM2 = c.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
    let naiveH = 18;
    if (parseM2) {
      let h = parseInt(parseM2[1], 10);
      const ap = parseM2[3].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      naiveH = h;
    }
    const dayStart = times.findIndex(t => t.startsWith(c.date + 'T'));
    const naiveIdx = dayStart >= 0 ? Math.min(dayStart + naiveH, times.length - 1) : Math.min(naiveH, times.length - 1);
    console.log('    NAIVE fallback would pick: times[' + naiveIdx + '] = ' + times[naiveIdx]
      + '  temp=' + d.hourly.temperature_2m[naiveIdx] + '°F, wind=' + d.hourly.wind_speed_10m[naiveIdx] + 'mph');
    console.log('');
  })().catch(e => console.error('    fetch error: ' + e.message));
}

// Await network calls; simple sleep since we launched fire-and-forget.
setTimeout(() => {}, 8000);
