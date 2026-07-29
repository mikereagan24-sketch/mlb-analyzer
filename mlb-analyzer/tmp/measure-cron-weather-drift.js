'use strict';
// Quantify the slate-wide impact of the runWeatherJob bypass.
//
// For each game on today's statsapi slate, compute what the OLD cron
// path wrote (ET hour from game_time applied directly as idx into a
// 1-day, park-local-tz-indexed hourly array) vs what the NEW cron
// path writes (park-local hour ISO via parseGameTimeToEtHm +
// parkLocalHourIso). Reports the drift in hours + resulting
// temp/wind delta.
//
// Usage: node tmp/measure-cron-weather-drift.js [YYYY-MM-DD]

const path = require('path');
const {
  PARKS, calcWindFactor,
  _internal: { PARK_TZ, parkLocalHourIso, parseGameTimeToEtHm, _shiftDate },
} = require('../services/weather');

const ABBR_NORM = { WSH: 'WAS', OAK: 'ATH', AZ: 'ARI' };
const norm = a => (ABBR_NORM[a] || a || '').toLowerCase();

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function fmtEt(iso) {
  if (!iso) return '(no start)';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' ET';
}

async function fetchOM(park, date) {
  const startDate = _shiftDate(date, -1);
  const endDate = _shiftDate(date, +1);
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + park.lat + '&longitude=' + park.lng
    + '&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability'
    + '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto'
    + '&start_date=' + startDate + '&end_date=' + endDate;
  const r = await fetch(url, { headers: { 'User-Agent': 'measure-cron-weather-drift/1.0' } });
  return r.json();
}

(async function main() {
  const date = process.argv[2] || todayPT();
  console.log('Slate-wide runWeatherJob drift check for ' + date);
  console.log('OLD path: ET hour → idx directly into park-local-tz array');
  console.log('NEW path: parkLocalHourIso → indexOf against same array\n');

  const sresp = await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + date
    + '&hydrate=' + encodeURIComponent('probablePitcher(note),team'));
  const sjson = await sresp.json();
  const sgames = (sjson.dates && sjson.dates[0] && sjson.dates[0].games) || [];

  console.log('game_id             tz              gameTime      OLD idx OLD temp  |  NEW idx  NEW temp  |  Δh    Δtemp');
  console.log('------------------- --------------- ------------- ------- --------  ---------- ---------  ----- --------');

  const rows = [];
  for (const g of sgames) {
    const away = norm(g.teams?.away?.team?.abbreviation);
    const home = norm(g.teams?.home?.team?.abbreviation);
    if (!away || !home) continue;
    const gn = g.gameNumber || 1;
    const gid = gn > 1 ? away + '-' + home + '-g' + gn : away + '-' + home;
    const park = PARKS[home];
    if (!park) continue;
    const tz = PARK_TZ[home];
    const gameTime = new Date(g.gameDate).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' ET';

    // OLD path replica: ET hour from gameTime, idx = min(hour, len-1)
    const parsed = parseGameTimeToEtHm(gameTime);
    const oldHour = parsed ? parsed.hour : 19;

    // Fetch Open-Meteo (single fetch shared; simulate both paths' idx choices)
    const wd = await fetchOM(park, date);
    if (!wd?.hourly?.time?.length) { console.log('  ' + gid + '  (open-meteo failed)'); continue; }

    // OLD used 1-day fetch (start_date=end_date=date). Rebuild that behavior
    // by SLICING today's 24 rows out of the ± 1-day array. Simulates the
    // pre-fix cron exactly.
    const todayOnly = wd.hourly.time
      .map((t, i) => ({ t, i }))
      .filter(x => x.t.startsWith(date + 'T'))
      .map(x => x.i);
    if (!todayOnly.length) continue;
    const oldIdx = Math.min(oldHour, todayOnly.length - 1);
    const oldGlobalIdx = todayOnly[oldIdx];
    const oldTemp = wd.hourly.temperature_2m[oldGlobalIdx];
    const oldWind = wd.hourly.wind_speed_10m[oldGlobalIdx];

    // NEW path: park-local ISO indexed into the ± 1-day array
    const targetIso = parkLocalHourIso(date, gameTime, tz);
    const newGlobalIdx = targetIso ? wd.hourly.time.indexOf(targetIso) : -1;
    const newTemp = newGlobalIdx >= 0 ? wd.hourly.temperature_2m[newGlobalIdx] : null;
    const newWind = newGlobalIdx >= 0 ? wd.hourly.wind_speed_10m[newGlobalIdx] : null;

    const deltaTemp = newTemp != null ? (newTemp - oldTemp).toFixed(1) : 'n/a';
    const deltaH = newGlobalIdx >= 0 ? (newGlobalIdx - oldGlobalIdx) : 'n/a';

    console.log(
      '  ' + gid.padEnd(18) + ' ' + tz.padEnd(15) + ' ' + gameTime.padEnd(13)
      + ' ' + String(oldGlobalIdx).padStart(3) + '     ' + String(oldTemp).padStart(5) + '°F  |  '
      + String(newGlobalIdx).padStart(3) + '     ' + String(newTemp).padStart(5) + '°F  |  '
      + String(deltaH).padStart(3) + '   ' + String(deltaTemp).padStart(5)
      + (Math.abs(Number(deltaTemp)) >= 3 ? ' °F  <-- SIGNIFICANT' : ' °F')
    );

    rows.push({ gid, tz, oldTemp, newTemp, deltaTemp: newTemp != null ? newTemp - oldTemp : null });
  }

  // Distribution summary
  const drifts = rows.map(r => r.deltaTemp).filter(x => x != null).map(x => Math.abs(x));
  drifts.sort((a, b) => a - b);
  const q = f => drifts[Math.min(drifts.length - 1, Math.max(0, Math.floor(f * (drifts.length - 1))))];
  console.log('\nDrift summary (|Δtemp|, °F):');
  console.log('  games: ' + drifts.length);
  if (drifts.length) {
    console.log('  min=' + drifts[0].toFixed(1) + '  median=' + q(0.5).toFixed(1)
      + '  p75=' + q(0.75).toFixed(1) + '  p90=' + q(0.9).toFixed(1)
      + '  max=' + drifts[drifts.length - 1].toFixed(1));
    console.log('  games with |Δ| ≥ 3°F: ' + drifts.filter(d => d >= 3).length);
    console.log('  games with |Δ| ≥ 5°F: ' + drifts.filter(d => d >= 5).length);
    console.log('  games with |Δ| ≥ 10°F: ' + drifts.filter(d => d >= 10).length);
  }

  // Per-tz breakdown
  const byTz = {};
  for (const r of rows) {
    if (r.deltaTemp == null) continue;
    (byTz[r.tz] = byTz[r.tz] || []).push(Math.abs(r.deltaTemp));
  }
  console.log('\nPer-timezone mean |Δtemp|:');
  for (const [tz, ds] of Object.entries(byTz).sort()) {
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    console.log('  ' + tz.padEnd(24) + '  n=' + String(ds.length).padStart(2) + '  mean=' + mean.toFixed(2) + '°F');
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
