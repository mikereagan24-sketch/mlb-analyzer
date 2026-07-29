'use strict';

// Ballpark data: lat, lng, outfield_dir (compass degrees FROM home plate TOWARD CF),
// sensitivity (0-2 scale; Wrigley=2 most wind-sensitive, typical=1)
const PARKS = {
  // cfDir corrected 2026-07-22 (audit/park-cf-bearings): was 60°.
  // Wikipedia's Wrigley Field infobox and multiple ballpark-survey
  // references put home-plate-to-CF at ~33° NNE. Old 60° underweighted
  // the aligned in/out signal by ~10-15% at the highest-sensitivity
  // park in the league (sens=2.0). See docs/park-bearings-audit.md
  // for the audit and the 26 other parks still on unverified 45°.
  'chc': { lat:41.9484, lng:-87.6553, cfDir:33,  sens:2.0, name:'Wrigley Field' },
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
  // ATH plays at Sutter Health Park, West Sacramento in 2026 (not Oakland
  // Coliseum). Prior coords 37.7516/-122.2005 pulled Oakland weather for
  // every ATH home game — ~25-30°F cold-bias in July (Sacramento ~93°F vs
  // Oakland ~68°F), which via temp_run_adj under-forecast runs by ~1.0-1.3
  // per game across 49 home games since 2026-03-01. Three other files
  // (scraper.js PARK_FACTORS, park-factors-woba.js WOBA_PARK_FACTORS,
  // scraper.js PARK_TZ comment) already knew about the move; weather.js
  // was the fourth-file blind spot. Fixed 2026-07-27.
  //
  // sens dropped 1.2 → 1.0 (default): Coliseum's 1.2 was calibrated to
  // its specific wind pattern; Sutter Health is a different park with
  // no measured sensitivity yet. cfDir stays 45° placeholder until the
  // measurement pass includes Sutter Health (joins the priority list).
  'oak': { lat:38.5804, lng:-121.5111,cfDir:45,  sens:1.0, name:'Sutter Health Park' },
  'ath': { lat:38.5804, lng:-121.5111,cfDir:45,  sens:1.0, name:'Sutter Health Park' },
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

// Widened game_time parser. Accepts every observed shape written to
// game_log.game_time by the various bootstrap paths (statsapi, RotoWire,
// manual) plus defensive fallbacks for shapes we haven't seen but that
// a future feed might emit. Returns { hour, minute } in ET wall-clock —
// this is the app's canonical convention (see scraper.js fmtET), and
// downstream code treats the two integers as ET so downstream math
// stays unchanged.
//
// Handled shapes:
//   "9:40 PM ET"       — fmtET output, dominant (1334/1440 local rows)
//   "12:10 PM ET"      — 2-digit hour, same content class (96 rows)
//   "9:40 PM"          — no tz suffix (2 rows on manual path)
//   "10:45 AM"         — 2-digit hour, no tz (1 row, DH manual)
//   "21:40 ET"         — 24-hour with ET suffix (defensive; not yet observed)
//   "21:40"            — 24-hour bare (defensive)
//   "9:40:00 PM ET"    — includes seconds (defensive)
//   "2026-07-29T21:40:00Z"  — full ISO in UTC (defensive; some bootstrap
//                             paths could emit statsapi's gameDate raw)
//   "2026-07-29T21:40:00-04:00"  — ISO with tz offset (defensive)
//   "2026-07-29T21:40:00"  — naive ISO (assume ET per convention)
//
// Returns null when the input is null/empty/whitespace or doesn't match
// any shape. Caller is expected to WARN with the raw input value so
// unparseable inputs become debuggable at first sight.
//
// Pre-widening (2026-07-27), the parser was a single regex
// `/(\d+):(\d+)\s*(AM|PM)/i` — brittle: it silently returned null for
// 24-hour or ISO inputs, and the caller silently degraded to a naive
// hour lookup indexed in the WRONG timezone (2026-07-29 ATH incident:
// naive fallback indexed hour 21 in Pacific because gameTime was
// treated as ET even though the code path returned null → PT-indexed
// array hour 21 = 9 PM PT Sacramento = 79°F instead of the correct
// hour 18 PT = 92°F). The fix pairs this widened parser with a WARN
// on the null-return path (see fetchParkWind) so silent degradation
// becomes noisy.
function parseGameTimeToEtHm(gameTime) {
  if (gameTime == null) return null;
  const s = String(gameTime).trim();
  if (s === '') return null;

  // ISO-8601 with T separator (with or without tz offset / seconds).
  // Parse via Date, then re-render in ET.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    // Naive ISOs (no Z, no offset) get treated as ET per the project's
    // "game_time is ET" convention — otherwise `new Date(...)` would
    // interpret them as local runtime tz, which on Render (UTC) or
    // dev (PT) would silently shift by hours.
    let iso = s;
    if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) {
      // No tz marker: treat as ET wall-clock. Extract H/M directly
      // (safer than fabricating an offset string, which drifts across
      // DST boundaries).
      const m = s.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
      if (m) return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
      return null;
    }
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const h = parseInt(p.hour, 10) === 24 ? 0 : parseInt(p.hour, 10);
    const m = parseInt(p.minute, 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return { hour: h, minute: m };
  }

  // 12-hour with AM/PM (with optional seconds and optional tz suffix)
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)\b/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = parseInt(ampm[2], 10);
    const ap = ampm[3].toUpperCase();
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return { hour: h, minute: min };
  }

  // 24-hour bare or with a trailing timezone-ish suffix. Rejects
  // ambiguous inputs (e.g. "9:40" without AM/PM would be treated
  // 24-hour, but 24-hour convention normally has 2-digit hours; still
  // accept it as a best-effort).
  const h24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*[A-Z]{2,4})?$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const min = parseInt(h24[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { hour: h, minute: min };
  }

  return null;
}

// Given (gameDate, gameTime-ET, timeZone), return "YYYY-MM-DDTHH:00" in the
// park's local wall clock — the exact string shape Open-Meteo emits in
// `hourly.time[]` when requested with `timezone=auto`. Enables direct
// `indexOf` matching against the hourly array without arithmetic that could
// drift on DST boundaries or cross-date late/early games.
//
// Returns null if gameTime doesn't parse (see parseGameTimeToEtHm for
// the accepted shapes).
function parkLocalHourIso(gameDate, gameTime, timeZone) {
  const hm = parseGameTimeToEtHm(gameTime);
  if (!hm) return null;

  const utcMs = etWallClockToUtcMs(gameDate, hm.hour, hm.minute);
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

  // Failure-mode observability (2026-07-29 ATH incident). All three
  // fallback triggers now WARN with enough context to diagnose from a
  // single log line. Pre-fix, mode 2 (unparseable gameTime) was silent:
  // parkLocalHourIso returned null → naive-hour index fired → app
  // persisted the wrong-hour temperature indefinitely with no visible
  // signal. Mode 1 (no tz) and mode 3 (indexOf miss) already warned;
  // this brings mode 2 into parity and adds a success INFO so an
  // operator can distinguish "fell to fallback silently" from "didn't
  // reach the code at all" on prod.
  const tz = PARK_TZ[teamKey];
  if (!tz) {
    console.warn(`[weather] mode1 no PARK_TZ entry for teamKey=${JSON.stringify(teamKey)} (homeTeam=${JSON.stringify(homeTeam)}); naive-hour fallback will fire — add teamKey to PARK_TZ`);
  }

  // Parse once via the widened parser (handles 12h AM/PM, 24h, and ISO —
  // see parseGameTimeToEtHm). Both the target-ISO path and the naive-
  // hour fallback read from the same parse result so they can't disagree.
  const parsedHm = parseGameTimeToEtHm(gameTime);
  if (!parsedHm) {
    console.warn(`[weather] mode2 gameTime unparseable for ${homeTeam} on ${gameDate}: raw=${JSON.stringify(gameTime)} — naive-hour fallback will fire at DEFAULT hour 18. Widen parseGameTimeToEtHm if this is a legitimate new source format.`);
  }
  const gameHourNaive = parsedHm ? parsedHm.hour : 18;
  const targetIso = tz ? parkLocalHourIso(gameDate, gameTime, tz) : null;

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
    // computed. Fallback path (targetIso null OR indexOf miss): naive-hour
    // index into gameDate-only data. `_wxPath` labels which path fired so
    // the success INFO log is self-describing.
    let idx = -1;
    let _wxPath = null;
    if (targetIso) {
      idx = data.hourly.time.indexOf(targetIso);
      if (idx < 0) {
        console.warn(`[weather] mode3 target ISO ${JSON.stringify(targetIso)} not found in hourly array for ${homeTeam} (array tz=${data.timezone}, samples=${JSON.stringify(data.hourly.time.slice(0, 3))}); naive-hour fallback firing at hour ${gameHourNaive}`);
      } else {
        _wxPath = 'park_local_iso';
      }
    }
    if (idx < 0) {
      const dayStart = data.hourly.time.findIndex(t => t.startsWith(gameDate + 'T'));
      idx = dayStart >= 0
        ? Math.min(dayStart + gameHourNaive, data.hourly.time.length - 1)
        : Math.min(gameHourNaive, data.hourly.time.length - 1);
      _wxPath = 'naive_fallback';
    }
    if (idx < 0) return null;
    // Success INFO — one line per game per cron pass. Cheap; the failure
    // WARNs would be uninterpretable without a corresponding INFO to
    // confirm which games hit the good path.
    console.log(`[weather] ${homeTeam} ${gameDate} gameTime=${JSON.stringify(gameTime)} path=${_wxPath} idx=${idx} hourly.time[idx]=${data.hourly.time[idx]}`);

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
  _internal: { PARK_TZ, etWallClockToUtcMs, parkLocalHourIso, parseGameTimeToEtHm, _shiftDate },
};
