'use strict';

// Ballpark data: lat, lng, outfield_dir (compass degrees FROM home plate TOWARD CF),
// sensitivity (0-2 scale; Wrigley=2 most wind-sensitive, typical=1)
const PARKS = {
  // Bearings history:
  //   2026-07-22 (audit/park-cf-bearings): chc corrected from 60° → 33°
  //     via Wikipedia + ballpark-survey references (Wrigley home→CF).
  //   2026-08-11 (audit/park-cf-bearings batch 2): 10 parks measured
  //     directly from home-plate and CF-fence lat/lng, bearings via
  //     great-circle atan2. chc refined 33° → 38° from measured coords.
  //     9 parks moved off the 45° placeholder: phi, kan (+kc alias),
  //     det, cle, nyy, bal, was, cin, ath (+oak alias). lat/lng on
  //     those parks also updated from ~1km-Open-Meteo-grid coords to
  //     measured home-plate. The most surprising corrections:
  //       DET  45° → 151° SSE (Comerica is one of the few south-facing
  //                            MLB parks; +106° delta)
  //       CLE  45° → 359° N   (Progressive is due-north-facing; -46°
  //                            shortest-arc delta)
  //       CIN  45° → 122° ESE (Great American faces the river +77°)
  //       NYY  45° → 75° ENE  (Yankee Stadium +30°)
  //       PHI  45° → 8° N     (Citizens Bank near-due-north, -37°)
  //     KAN's 45° placeholder was accidentally within 1° of measured
  //     (46°); the update is functionally a no-op there but the lat/
  //     lng gets pinned to home plate for consistency.
  //   2026-08-18 (audit/park-cf-bearings batch 3): the remaining 7
  //     open-air parks measured off the 45° placeholder — nym, min,
  //     atl, col, lad, laa, sd. Same method: home-plate and CF-fence
  //     coords from Google Maps satellite, great-circle atan2, lat/
  //     lng pinned to home plate. Home→CF distances all 395-415 ft
  //     as sanity check. Corrections:
  //       ATL  45° → 159° SSE (Truist faces south; +114° — largest
  //                            correction in either batch)
  //       MIN  45° → 90° E   (Target Field due-east; +45°)
  //       COL  45° → 3° N    (Coors Field north-facing; -43°)
  //       SD   45° → 0° N    (Petco due-north; -45°)
  //       NYM  45° → 14° NNE (Citi Field; -31°)
  //       LAD  45° → 25° NNE (Dodger Stadium; -20°)
  //       LAA  45° → 44° NE  (Angel Stadium essentially on the
  //                            placeholder; -1° — the only park
  //                            where the placeholder happened to be
  //                            approximately right)
  //   8 parks remain on the 45° placeholder — all retractable-roof
  //   or fixed-dome (tor, mia, mil, ari, sea, tex, hou, tb). Closed
  //   roofs mean no wind reaches the field, so cfDir is unused for
  //   those cohorts; leaving the placeholder is intentional. All
  //   open-air parks now have measured bearings, which unblocks the
  //   per-park sens audit. See docs/park-bearings-audit.md.
  'chc': { lat:41.94792028864351, lng:-87.6558333825289,  cfDir:38,  sens:2.0, name:'Wrigley Field' },
  'cws': { lat:41.8300, lng:-87.6339, cfDir:5,   sens:1.0, name:'Guaranteed Rate' },
  'nyy': { lat:40.82949062712526, lng:-73.92695841016014, cfDir:75,  sens:1.0, name:'Yankee Stadium' },
  'nym': { lat:40.75659049940357, lng:-73.84602873744261, cfDir:14, sens:0.3, name:'Citi Field' },
  'bos': { lat:42.3467, lng:-71.0972, cfDir:75,  sens:1.5, name:'Fenway Park' },
  'det': { lat:42.339461081107764, lng:-83.048978867262,  cfDir:151, sens:1.2, name:'Comerica Park' },
  'cle': { lat:41.49554793391344, lng:-81.68529019867165, cfDir:359, sens:1.2, name:'Progressive Field' },
  'min': { lat:44.981717162370394, lng:-93.27829383556069, cfDir:90, sens:0.8, name:'Target Field' },
  'tor': { lat:43.6414, lng:-79.3894, cfDir:45,  sens:0.4, name:'Rogers Centre' },
  'bal': { lat:39.2835019755712, lng:-76.62192251082257,  cfDir:24,  sens:1.0, name:'Camden Yards' },
  'was': { lat:38.87257142688703, lng:-77.00773522543847, cfDir:27,  sens:1.0, name:'Nationals Park' },
  'atl': { lat:33.891126700858116, lng:-84.4678868457582, cfDir:159, sens:0.8, name:'Truist Park' },
  'mia': { lat:25.7781, lng:-80.2197, cfDir:45,  sens:0.1, name:'LoanDepot Park' },
  'phi': { lat:39.90558890172053, lng:-75.16660702298513, cfDir:8,   sens:1.5, name:'Citizens Bank' },
  'pit': { lat:40.4469, lng:-80.0058, cfDir:30,  sens:1.2, name:'PNC Park' },
  'cin': { lat:39.097471625086264, lng:-84.5070384836874, cfDir:122, sens:1.0, name:'Great American' },
  'mil': { lat:43.0280, lng:-87.9712, cfDir:45,  sens:0.2, name:'American Family' },
  'stl': { lat:38.6226, lng:-90.1930, cfDir:25,  sens:1.0, name:'Busch Stadium' },
  'col': { lat:39.75570889434178, lng:-104.99420013642896, cfDir:3, sens:0.5, name:'Coors Field' },
  'ari': { lat:33.4453, lng:-112.0667,cfDir:45,  sens:0.2, name:'Chase Field' },
  'lad': { lat:34.0734220619125, lng:-118.24022795237009, cfDir:25, sens:0.5, name:'Dodger Stadium' },
  // 'sfg' and 'sf' both resolve to Oracle Park. runWeatherJob parses
  // game_id as `parts[1]` off the "away-home" convention, and SF's
  // game_ids end in `-sf`, so PARKS[homeKey] with homeKey='sf' must
  // resolve. The 2026-08-05 season backfill uncovered that 46 SF home
  // games had silently no_park-skipped for the full season because
  // only 'sfg' was mapped. Both keys point to the same object so any
  // reader gets consistent lat/lng/cfDir/sens/name. Same shape as the
  // existing oak/ath alias below.
  'sfg': { lat:37.7786, lng:-122.3893,cfDir:90,  sens:0.3, name:'Oracle Park' },
  'sf':  { lat:37.7786, lng:-122.3893,cfDir:90,  sens:0.3, name:'Oracle Park' },
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
  // no measured sensitivity yet. cfDir + lat/lng measured 2026-08-11
  // (batch 2 of audit/park-cf-bearings) from home-plate + CF-fence
  // coordinates: bearing = 42° NE, only 3° off the 45° placeholder.
  'oak': { lat:38.58020291363677, lng:-121.51406478832237, cfDir:42, sens:1.0, name:'Sutter Health Park' },
  'ath': { lat:38.58020291363677, lng:-121.51406478832237, cfDir:42, sens:1.0, name:'Sutter Health Park' },
  'sea': { lat:47.5914, lng:-122.3325,cfDir:45,  sens:0.6, name:'T-Mobile Park' },
  'tex': { lat:32.7512, lng:-97.0832, cfDir:45,  sens:0.1, name:'Globe Life' },
  'hou': { lat:29.7573, lng:-95.3555, cfDir:45,  sens:0.1, name:'Minute Maid' },
  'laa': { lat:33.799920691495615, lng:-117.88316982446123, cfDir:44, sens:0.8, name:'Angel Stadium' },
  'kan': { lat:39.051245928408854, lng:-94.48082370618096, cfDir:46, sens:1.3, name:'Kauffman' },
  'kc':  { lat:39.051245928408854, lng:-94.48082370618096, cfDir:46, sens:1.3, name:'Kauffman' },
  'sd':  { lat:32.70705001125514, lng:-117.15706906729568, cfDir:0, sens:0.4, name:'Petco Park' },
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
  const speedFactor = Math.min((windSpeed - 8) / 24, 0.75); // 0 at 8mph, saturates at 0.75 from 26mph up
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
  sf: 'America/Los_Angeles',   // alias — see PARKS['sf'] note above
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
// SHARED weather fetch. Takes pre-resolved coordinates + timezone so
// callers that route through venue-override chains (runWeatherJob) get
// the same park-local-hour ISO indexing as the direct-team path
// (fetchParkWind).
//
// Returns {windSpeed, windDir, tempF, precipProb} on success — raw
// hourly values the caller pairs with its own tempAdj formula and its
// own wind-factor invocation. On failure returns {error, transient?,
// detail?} matching runWeatherJob's existing skipReasonCounts keys
// (empty_response, bad_index, non_finite_value, exception) so its
// retry + cron_log accounting works unchanged.
//
// Instrumentation: mode1 (no tz), mode2 (unparseable gameTime), mode3
// (indexOf miss) all WARN with raw context. Success emits INFO with
// path=park_local_iso|naive_fallback and idx.
//
// Pre-fix (2026-07-29 ATH incident): runWeatherJob had its own inline
// Open-Meteo fetch and its own gameHour = parseInt(...) narrow regex,
// duplicating everything fetchParkWind did but WITHOUT the
// parkLocalHourIso conversion. Every non-ET park got ET-hour indexed
// into a park-local hourly array (off by 1-3h). Sacramento (ATH) hour
// 21 PT = 9 PM Sacramento = 78°F, when correct hour 18 PT = 92°F.
// The naive-hour bug the 0e1e48f TZ fix was meant to cure was never
// actually cured on the cron path — the cron never called fetchParkWind.
async function fetchWindAtCoords({ lat, lng, tz, gameDate, gameTime, sourceLabel, cacheBust, archive }) {
  const label = sourceLabel || 'unknown';
  if (!tz) {
    console.warn(`[weather] mode1 no tz for ${label}; naive-hour fallback will fire — pass tz from PARK_TZ or override.tz`);
  }
  const parsedHm = parseGameTimeToEtHm(gameTime);
  if (!parsedHm) {
    console.warn(`[weather] mode2 gameTime unparseable for ${label} on ${gameDate}: raw=${JSON.stringify(gameTime)} — naive-hour fallback will fire at DEFAULT hour 18. Widen parseGameTimeToEtHm if this is a legitimate new source format.`);
  }
  const gameHourNaive = parsedHm ? parsedHm.hour : 18;
  const targetIso = tz ? parkLocalHourIso(gameDate, gameTime, tz) : null;

  const startDate = _shiftDate(gameDate, -1);
  const endDate   = _shiftDate(gameDate, +1);
  // archive=true routes through Open-Meteo's ERA5-based reanalysis
  // endpoint (archive-api.open-meteo.com/v1/archive) instead of the
  // rolling forecast endpoint. Rationale:
  //   - forecast endpoint serves a short window (roughly last ~2 weeks
  //     + forward 16d); older dates return {} or hourly nulls, which
  //     the caller sees as empty_response / non_finite_value.
  //   - Season backfill (services/backfill-tasks/weather-backfill-season.js)
  //     needs coverage back to March; only the archive endpoint has it.
  //   - Archive is OBSERVED, not forecast. The backfill task's doc
  //     (docs/season-weather-backfill-observed-vs-forecast-2026-08.md)
  //     spells out the hindsight-bias implications for downstream
  //     consumers.
  // The archive endpoint doesn't expose precipitation_probability
  // (probability is a forecast concept; observations record
  // precipitation amount instead), so archive mode drops the field
  // and the caller treats precipProb as 0. The retractable-roof
  // heuristic that reads precipProb is dead code today (see
  // jobs.js:3134 comment; no park carries roofType).
  let url;
  if (archive) {
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}` +
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m` +
      `&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto` +
      `&start_date=${startDate}&end_date=${endDate}`;
  } else {
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability` +
      `&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto` +
      `&start_date=${startDate}&end_date=${endDate}`;
  }
  if (cacheBust) url += `&_t=${Date.now()}`;

  let data;
  try {
    data = await fetch(url, {
      headers: { 'User-Agent': 'mlb-analyzer/1.0 (https://github.com/mikereagan24-sketch/mlb-analyzer)' },
    }).then(r => r.json());
  } catch (e) {
    return { error: 'exception', transient: true, detail: e.message };
  }
  if (!data || !data.hourly || !Array.isArray(data.hourly.time) || !data.hourly.time.length) {
    return { error: 'empty_response', transient: true, detail: JSON.stringify(data).slice(0, 200) };
  }

  let idx = -1;
  let wxPath = null;
  if (targetIso) {
    idx = data.hourly.time.indexOf(targetIso);
    if (idx < 0) {
      console.warn(`[weather] mode3 target ISO ${JSON.stringify(targetIso)} not found in hourly array for ${label} (array tz=${data.timezone}, samples=${JSON.stringify(data.hourly.time.slice(0, 3))}); naive-hour fallback firing at hour ${gameHourNaive}`);
    } else {
      wxPath = 'park_local_iso';
    }
  }
  if (idx < 0) {
    const dayStart = data.hourly.time.findIndex(t => t.startsWith(gameDate + 'T'));
    idx = dayStart >= 0
      ? Math.min(dayStart + gameHourNaive, data.hourly.time.length - 1)
      : Math.min(gameHourNaive, data.hourly.time.length - 1);
    wxPath = 'naive_fallback';
  }
  if (idx < 0) return { error: 'bad_index', transient: true, detail: `idx=-1 after all fallbacks (gameHour=${gameHourNaive})` };

  const windSpeed = data.hourly.wind_speed_10m?.[idx];
  const windDir   = data.hourly.wind_direction_10m?.[idx];
  const tempF     = data.hourly.temperature_2m?.[idx];
  // Archive endpoint doesn't return precipitation_probability;
  // substitute 0 so the caller's return-shape contract stays constant
  // across modes (callers unconditionally read .precipProb).
  const precipProb = archive ? 0 : data.hourly.precipitation_probability?.[idx];
  // Finite-value validation is mode-aware: forecast requires all four
  // fields (unchanged pre-refactor behavior), archive requires only
  // the three fields the archive endpoint actually returns. The
  // forecast branch MUST keep its precipProb validation — a null
  // precipProb from the forecast endpoint has always been a signal
  // that the response is malformed / partial, and we don't loosen
  // that in exchange for archive-mode support.
  const requiredFinite = archive
    ? [windSpeed, windDir, tempF]
    : [windSpeed, windDir, tempF, precipProb];
  if (!requiredFinite.every(v => Number.isFinite(v))) {
    return { error: 'non_finite_value', transient: true, detail: `speed=${windSpeed} dir=${windDir} temp=${tempF} precip=${precipProb}` };
  }

  console.log(`[weather] ${label} ${gameDate} gameTime=${JSON.stringify(gameTime)} path=${wxPath} idx=${idx} hourly.time[idx]=${data.hourly.time[idx]}`);
  return { windSpeed, windDir, tempF, precipProb };
}

async function fetchParkWind(homeTeam, gameDate, gameTime) {
  const teamKey = (homeTeam || '').toLowerCase().replace(/[^a-z]/g, '');
  const park = PARKS[teamKey];
  if (!park) return null;
  const tz = PARK_TZ[teamKey];
  const wx = await fetchWindAtCoords({
    lat: park.lat, lng: park.lng, tz,
    gameDate, gameTime,
    sourceLabel: (homeTeam || teamKey) + ' home',
  });
  if (!wx || wx.error) {
    if (wx && wx.error) console.warn(`[weather] fetchParkWind: ${homeTeam} → ${wx.error}${wx.detail ? ' ('+wx.detail+')' : ''}`);
    return null;
  }
  const factor = calcWindFactor(wx.windDir, wx.windSpeed, park);
  // Continuous temp-adjustment (see PARKS comment). Note: runWeatherJob
  // uses a DIFFERENT step-function tempAdj and writes it to game_log —
  // the two formulas are intentionally not unified because the cron
  // path's persisted values must not shift under this refactor. Only
  // fetchParkWind's return-value callers (currently: none in prod;
  // ad-hoc routes if any) see this continuous form.
  const tempAdj = Math.max(-1.3, Math.min(1.3, (wx.tempF - 65) * 0.052));
  return { windSpeed: wx.windSpeed, windDir: wx.windDir, factor, tempF: wx.tempF, tempAdj, precipProb: wx.precipProb, parkName: park.name, cfDir: park.cfDir };
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

// Step-function temperature-to-run adjustment written to game_log's
// temp_run_adj column. Distinct from fetchParkWind's linear form above
// (that one is intentionally kept separate; see the comment at
// tempAdj on line 419). This step function is the ONE that lands in
// the DB, so every write path that persists temp_run_adj must go
// through this exact formula.
function tempRunAdjFromTempF(tempF) {
  if (tempF == null || !isFinite(tempF)) return null;
  return tempF < 55 ? -0.5 : tempF < 70 ? 0 : tempF < 80 ? 0.3 : 0.6;
}

// Compute the effective (stored) wind_factor and temp_run_adj from raw
// weather inputs, applying the roof-state gate exactly as
// services/jobs.js:runWeatherJob does at initial write time.
// Callers that reclassify a game's roof AFTER weather has been written
// (services/roof-correct.js) must reuse this to keep the stored effective
// values consistent with the corrected roof — otherwise wind_factor /
// temp_run_adj stay computed under the wrong roof state.
//
// Args:
//   windSpeed, windDir, tempF — raw weather from open-meteo (as stored
//     in game_log.wind_speed / wind_dir / temp_f).
//   roofStatus — 'open' | 'closed' | 'partial' (any case).
//   venueId    — used to check sealed-dome status via roof-prior.
//   park       — the PARKS entry (needs cfDir, sens) for wind attribution.
// Returns: { windFactor, tempRunAdj } — the values to persist.
function computeEffectiveWeather({ windSpeed, windDir, tempF, roofStatus, venueId, park }) {
  const { isSealedDome } = require('./roof-prior');
  const rawWindFactor = (park && windSpeed != null && windDir != null)
    ? calcWindFactor(windDir, windSpeed, park)
    : 0;
  const rawTempAdj = tempRunAdjFromTempF(tempF);
  const rawTempAdjNum = rawTempAdj == null ? 0 : rawTempAdj;
  const st = String(roofStatus || 'open').toLowerCase();
  const roofMult = st === 'closed' ? 0 : st === 'partial' ? 0.5 : 1;
  const sealedClosed = st === 'closed' && isSealedDome(venueId);
  const windFactor = sealedClosed ? 0 : rawWindFactor * roofMult;
  const tempRunAdj = sealedClosed ? 0 : rawTempAdjNum * roofMult;
  return { windFactor, tempRunAdj };
}

module.exports = {
  fetchParkWind, fetchWindAtCoords, calcWindFactor, PARKS,
  tempRunAdjFromTempF, computeEffectiveWeather,
  _internal: { PARK_TZ, etWallClockToUtcMs, parkLocalHourIso, parseGameTimeToEtHm, _shiftDate },
};
