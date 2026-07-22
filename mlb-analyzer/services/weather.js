'use strict';

// Ballpark data: lat, lng, outfield_dir (compass degrees FROM home plate TOWARD CF),
// sensitivity (0-2 scale; Wrigley=2 most wind-sensitive, typical=1)
const PARKS = {
  'chc': { lat:41.9484, lng:-87.6553, cfDir:60,  sens:2.0, name:'Wrigley Field' },
  'cws': { lat:41.8300, lng:-87.6339, cfDir:5,   sens:1.0, name:'Guaranteed Rate' },
  'nyy': { lat:40.8296, lng:-73.9262, cfDir:45,  sens:1.0, name:'Yankee Stadium' },
  'nym': { lat:40.7571, lng:-73.8458, cfDir:45,  sens:0.3, name:'Citi Field' },
  'bos': { lat:42.3467, lng:-71.0972, cfDir:75,  sens:1.5, name:'Fenway Park' },
  'det': { lat:42.3390, lng:-83.0485, cfDir:45,  sens:1.2, name:'Comerica Park' },
  'cle': { lat:41.4962, lng:-81.6852, cfDir:45,  sens:1.2, name:'Progressive Field' },
  'min': { lat:44.9817, lng:-93.2776, cfDir:45,  sens:0.8, name:'Target Field' },
  'tor': { lat:43.6414, lng:-79.3894, cfDir:45,  sens:0.4, name:'Rogers Centre' },
  'bal': { lat:39.2838, lng:-76.6218, cfDir:45,  sens:1.0, name:'Camden Yards' },
  'was': { lat:38.8730, lng:-77.0074, cfDir:45,  sens:1.0, name:'Nationals Park' },
  'atl': { lat:33.8908, lng:-84.4677, cfDir:45,  sens:0.8, name:'Truist Park' },
  'mia': { lat:25.7781, lng:-80.2197, cfDir:45,  sens:0.1, name:'LoanDepot Park' },
  'phi': { lat:39.9061, lng:-75.1665, cfDir:45,  sens:1.5, name:'Citizens Bank' },
  'pit': { lat:40.4469, lng:-80.0058, cfDir:30,  sens:1.2, name:'PNC Park' },
  'cin': { lat:39.0979, lng:-84.5082, cfDir:45,  sens:1.0, name:'Great American' },
  'mil': { lat:43.0280, lng:-87.9712, cfDir:45,  sens:0.2, name:'American Family' },
  'stl': { lat:38.6226, lng:-90.1930, cfDir:25,  sens:1.0, name:'Busch Stadium' },
  'col': { lat:39.7559, lng:-104.9942,cfDir:45,  sens:0.5, name:'Coors Field' },
  'ari': { lat:33.4453, lng:-112.0667,cfDir:45,  sens:0.2, name:'Chase Field' },
  'lad': { lat:34.0739, lng:-118.2400,cfDir:45,  sens:0.5, name:'Dodger Stadium' },
  'sfg': { lat:37.7786, lng:-122.3893,cfDir:90,  sens:0.3, name:'Oracle Park' },
  'oak': { lat:37.7516, lng:-122.2005,cfDir:45,  sens:1.2, name:'RingCentral' },
  'ath': { lat:37.7516, lng:-122.2005,cfDir:45,  sens:1.2, name:'RingCentral' },
  'sea': { lat:47.5914, lng:-122.3325,cfDir:45,  sens:0.6, name:'T-Mobile Park' },
  'tex': { lat:32.7512, lng:-97.0832, cfDir:45,  sens:0.1, name:'Globe Life' },
  'hou': { lat:29.7573, lng:-95.3555, cfDir:45,  sens:0.1, name:'Minute Maid' },
  'laa': { lat:33.8003, lng:-117.8827,cfDir:45,  sens:0.8, name:'Angel Stadium' },
  'kan': { lat:39.0517, lng:-94.4803, cfDir:45,  sens:1.3, name:'Kauffman' },
  'kc':  { lat:39.0517, lng:-94.4803, cfDir:45,  sens:1.3, name:'Kauffman' },
  'sd':  { lat:32.7076, lng:-117.1570,cfDir:45,  sens:0.4, name:'Petco Park' },
  'tb':  { lat:27.7683, lng:-82.6534, cfDir:45,  sens:0.5, name:'Tropicana' },
};

// Wind factor: positive = blowing out (more runs), negative = blowing in (fewer runs)
// Uses dot product of wind vector with outfield vector
// Returns factor in range roughly -1 to +1, scaled by sensitivity and speed
// Wind factor: positive = blowing out (more runs), negative = blowing in (fewer runs)
// Based on actual MLB data:
//   <8mph:  minimal impact — show direction only, ~0 run adjustment
//   8-12mph: moderate — ~0.4-0.8 run adjustment (Wrigley sens=2.0 → 0.8-1.6)
//   13-17mph: significant — ~0.8-1.5 runs (Wrigley up to 3.0)
//   18+mph:  major — books pull action, max ~1.5 base runs (Wrigley up to 3.0+)
// Run adjustment = factor * 2.0 in model.js (factor range -1 to +1 → -2 to +2 runs at sens=1)
function calcWindFactor(windDir, windSpeed, park) {
  if (!park || !windSpeed) return 0;
  // Below 8mph: negligible — don't adjust the model
  if (windSpeed < 8) return 0;
  // Convert wind direction (FROM) to where it's blowing TO
  const windTo = (windDir + 180) % 360;
  const diff = windTo - park.cfDir;
  const rad = diff * Math.PI / 180;
  const alignment = Math.cos(rad); // +1=blowing straight out, -1=blowing straight in
  // Threshold-based scaling: starts meaningful at 8mph, grows non-linearly
  // At 10mph aligned: factor ≈ 0.25 * sens → * 2.0 in model = ~0.5 runs at sens=1
  // At 15mph aligned: factor ≈ 0.50 * sens → ~1.0 runs at sens=1, ~2.0 at Wrigley
  // At 20mph aligned: factor ≈ 0.75 * sens → ~1.5 runs at sens=1, ~3.0 at Wrigley
  const speedFactor = Math.min((windSpeed - 8) / 24, 0.75); // 0 at 8mph, 0.75 at 32mph
  const factor = alignment * speedFactor * park.sens;
  return parseFloat(factor.toFixed(3));
}


// Per-park IANA timezone. gameTime in game_log is an ET wall-clock string
// (e.g. "7:05 PM ET"); Open-Meteo's hourly array is indexed in the park's
// LOCAL wall clock when we request `timezone=auto`. Prior versions used
// the ET hour directly to index — silently off by 1-3h for every non-ET
// park, and off by an ET-vs-Arizona DST-dependent amount for ARI. See
// tmp/verify-weather-tz-fix.js for the spot checks.
const PARK_TZ = {
  chc:'America/Chicago',    cws:'America/Chicago',
  nyy:'America/New_York',   nym:'America/New_York',
  bos:'America/New_York',   phi:'America/New_York',
  was:'America/New_York',   bal:'America/New_York',
  atl:'America/New_York',   mia:'America/New_York',
  tb: 'America/New_York',
  tor:'America/Toronto',    // ET, but canonical IANA name
  pit:'America/New_York',   cle:'America/New_York',
  cin:'America/New_York',   det:'America/Detroit',   // ET
  mil:'America/Chicago',    min:'America/Chicago',
  stl:'America/Chicago',    hou:'America/Chicago',
  tex:'America/Chicago',
  kan:'America/Chicago',    kc: 'America/Chicago',
  col:'America/Denver',     // MT with DST
  ari:'America/Phoenix',    // MT year-round, NO DST
  lad:'America/Los_Angeles', laa:'America/Los_Angeles',
  sd: 'America/Los_Angeles', sfg:'America/Los_Angeles',
  sea:'America/Los_Angeles', oak:'America/Los_Angeles',
  ath:'America/Los_Angeles',
};

// Convert a (dateStr, hour, minute) ET wall-clock moment to UTC milliseconds.
// Uses Intl to derive ET's current UTC offset at the given date, so DST is
// handled by the platform rather than a hard-coded shift. No dependency.
function etWallClockToUtcMs(dateStr, hour, minute) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Naive: treat the ET wall clock as if it were UTC.
  const naive = Date.UTC(y, mo - 1, d, hour, minute);
  // Re-render that instant in ET; the difference between the two wall clocks
  // is ET's UTC offset at that moment (in the correct direction).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
  }).formatToParts(new Date(naive));
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  // Intl 'hour' can render midnight as '24' in some locales; normalize.
  const etH = parseInt(p.hour, 10) === 24 ? 0 : parseInt(p.hour, 10);
  const asEtWallMs = Date.UTC(+p.year, +p.month - 1, +p.day, etH, +p.minute);
  const offsetMs = asEtWallMs - naive;
  return naive - offsetMs;
}

// Given (gameDate, gameTime-ET, timeZone), return "YYYY-MM-DDTHH:00" in the
// park's local wall clock — the exact string shape Open-Meteo emits in
// `hourly.time[]` when requested with `timezone=auto`. Enables direct
// `indexOf` matching against the hourly array without arithmetic that could
// drift on DST boundaries or cross-date late/early games.
//
// Returns null if gameTime doesn't parse.
function parkLocalHourIso(gameDate, gameTime, timeZone) {
  if (!gameTime) return null;
  const m = gameTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;

  const utcMs = etWallClockToUtcMs(gameDate, h, min);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const localH = parseInt(p.hour, 10) === 24 ? 0 : parseInt(p.hour, 10);
  return `${p.year}-${p.month}-${p.day}T${String(localH).padStart(2, '0')}:00`;
}

// Fetch wind at game time for a specific park using Open-Meteo (no API key needed)
// Uses Node 20 built-in fetch
async function fetchParkWind(homeTeam, gameDate, gameTime) {
  const teamKey = (homeTeam || '').toLowerCase().replace(/[^a-z]/g, '');
  const park = PARKS[teamKey];
  if (!park) return null;
  const tz = PARK_TZ[teamKey];
  if (!tz) {
    console.warn(`[weather] no timezone mapping for ${teamKey}; falling back to naive-hour index`);
  }

  // Compute the park-local hour ISO we want to hit in the Open-Meteo array.
  // gameTime is an ET wall clock ("7:05 PM ET"); Open-Meteo hourly.time
  // strings are the park's LOCAL wall clock, so we convert once and match
  // by string. Falls back to naive-hour indexing only when either the
  // gameTime can't be parsed or the park has no TZ entry.
  let targetIso = null;
  let gameHourNaive = 18;
  if (gameTime) {
    const m = gameTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const ap = m[3].toUpperCase();
      if (ap === 'PM' && h !== 12) h += 12;
      if (ap === 'AM' && h === 12) h = 0;
      gameHourNaive = h;
    }
  }
  if (tz) {
    targetIso = parkLocalHourIso(gameDate, gameTime, tz);
  }

  try {
    // Request gameDate ± 1 day so cross-date wraps (a late-ET game at a
    // PT park, or a very-early-ET matinee at an ET park with DST shifts)
    // are still findable in the hourly array. Open-Meteo returns 24
    // hours per date requested; 3 days = ~72 rows, cheap.
    const startDate = _shiftDate(gameDate, -1);
    const endDate   = _shiftDate(gameDate, +1);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${park.lat}&longitude=${park.lng}` +
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability` +
      `&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto` +
      `&start_date=${startDate}&end_date=${endDate}`;
    // User-Agent: some upstream APIs reject headerless server-side fetches.
    // Open-Meteo's free tier rate-limit is per-IP, and Render shared IPs hit
    // it; the UA helps the provider distinguish our traffic if we need to
    // request a quota bump.
    const data = await fetch(url, {
      headers: { 'User-Agent': 'mlb-analyzer/1.0 (https://github.com/mikereagan24-sketch/mlb-analyzer)' },
    }).then(r => r.json());

    // Validate response shape — fail loud rather than silently returning the
    // 65°F / 0mph default cluster, which the cron then writes over real data.
    if (!data || !data.hourly || !Array.isArray(data.hourly.time) || !data.hourly.time.length) {
      console.warn(`[weather] empty/invalid response for ${homeTeam}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }

    // Preferred path: exact string match against the park-local ISO hour we
    // computed. Fallback path (targetIso null): naive-hour index into
    // gameDate-only data — retains the pre-fix behavior for the tiny
    // no-TZ / no-gameTime cases, so this fix doesn't silently break parks
    // absent from PARK_TZ.
    let idx = -1;
    if (targetIso) {
      idx = data.hourly.time.indexOf(targetIso);
      if (idx < 0) {
        console.warn(`[weather] target ${targetIso} not found in hourly array for ${homeTeam}; falling back to naive hour ${gameHourNaive}`);
      }
    }
    if (idx < 0) {
      // Find first hourly.time entry whose date part matches gameDate, then
      // step by gameHourNaive. Robust against the ± 1-day window we now
      // request (hourly.time is not guaranteed to start at 00:00 of gameDate).
      const dayStart = data.hourly.time.findIndex(t => t.startsWith(gameDate + 'T'));
      idx = dayStart >= 0
        ? Math.min(dayStart + gameHourNaive, data.hourly.time.length - 1)
        : Math.min(gameHourNaive, data.hourly.time.length - 1);
    }
    if (idx < 0) return null;

    const windSpeed = data.hourly.wind_speed_10m?.[idx];
    const windDir   = data.hourly.wind_direction_10m?.[idx];
    const tempF     = data.hourly.temperature_2m?.[idx];
    const precipProb = data.hourly.precipitation_probability?.[idx];

    // Require all four fields to be present and finite. A missing field is
    // a data-quality problem, not a fact about the weather.
    if (![windSpeed, windDir, tempF, precipProb].every(v => Number.isFinite(v))) {
      console.warn(`[weather] missing fields for ${homeTeam}: speed=${windSpeed} dir=${windDir} temp=${tempF} precip=${precipProb}`);
      return null;
    }

    const factor = calcWindFactor(windDir, windSpeed, park);
    // Temp adjustment: research shows ~1 run per 50F from 65F baseline.
    const tempAdj = Math.max(-1.3, Math.min(1.3, (tempF - 65) * 0.052)); // continuous: -1.3 at 40°F, 0 at 65°F baseline, +1.3 at 90°F
    return { windSpeed, windDir, factor, tempF, tempAdj, precipProb, parkName: park.name, cfDir: park.cfDir };
  } catch (e) {
    console.error('[weather] fetch failed for ' + homeTeam + ':', e.message);
    return null;
  }
}

// YYYY-MM-DD ± n days. Purely calendar math, no TZ needed.
function _shiftDate(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, mo - 1, d) + days * 86400000;
  const dt = new Date(ms);
  return dt.getUTCFullYear() + '-'
    + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(dt.getUTCDate()).padStart(2, '0');
}

module.exports = {
  fetchParkWind, calcWindFactor, PARKS,
  _internal: { PARK_TZ, etWallClockToUtcMs, parkLocalHourIso, _shiftDate },
};
