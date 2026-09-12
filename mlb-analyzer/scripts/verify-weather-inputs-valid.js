// Guard-removal check for the weather_contamination_reason filter in the
// re-scoring calibration harnesses (2026-09-12). READ-ONLY.
//
// THE FAILURE MODE THE FILTER GUARDS AGAINST, named from the code
// (services/jobs.js:4068): pre-2026-07-29 the weather cron indexed
// Open-Meteo's hourly series with a NAIVE ET hour regardless of the
// park's timezone. For a CT/MT/PT park that samples the weather 1/2/3
// hours later in the park-local diurnal cycle than first pitch, so
// temp_f / wind_speed / wind_dir hold the wrong hour's values, and the
// derived temp_run_adj (a 55/70/80F bucket step) and wind_factor (an
// 8mph threshold plus an orientation projection) inherit the error.
// runModel reads both, identically in both arms of a with/without A/B,
// so the defect adds symmetric noise to every calibration metric.
//
// THE TEST: fetchWindAtCoords still contains BOTH code paths - pass tz
// and it indexes on the park-local ISO (the fix); omit tz and the naive
// fallback fires at the ET hour (the bug). Same production function, so
// this is not a parallel weather impl. For each sampled row, re-derive
// the weather both ways off the same archive endpoint the 08-05 backfill
// used, and ask which one the stored columns match.
//
// Run: "$NODE20" --max-old-space-size=1536 scripts/verify-weather-inputs-valid.js
// Read-only, ~66 archive fetches, about 30s. Cited by the
// weather_inputs_valid comment in db/schema.js.
const Database = require('better-sqlite3');
const weather = require('../services/weather');
const { PARKS, fetchWindAtCoords, calcWindFactor, tempRunAdjFromTempF } = weather;
const { PARK_TZ, parkLocalHourIso, parseGameTimeToEtHm } = weather._internal;

const db = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
const F = '2026-06-16', T = '2026-09-10';
const TOL = 0.15;            // degF / mph float+rounding tolerance
const PER_COHORT = 6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (v, d) => (v == null ? '  null' : Number(v).toFixed(d == null ? 2 : d).padStart(6));

// Bounded by construction: narrow column set, one cohort, always inside
// one date window. Never .all() unfiltered game_log (CLAUDE.md 2GB rule).
function candidates(where) {
  return db.prepare(
    'SELECT game_date, game_id, home_team, game_time, temp_f, wind_speed, wind_dir, '
    + 'wind_factor, temp_run_adj, roof_status, weather_contamination_reason, weather_quality_at '
    + 'FROM game_log WHERE game_date>=? AND game_date<=? AND away_score IS NOT NULL '
    + "AND roof_status='open' AND game_time IS NOT NULL AND temp_f IS NOT NULL AND " + where
    + ' ORDER BY game_date, game_id'
  ).all(F, T);
}
function stride(rows, k) {
  if (rows.length <= k) return rows;
  const step = rows.length / k, out = [];
  for (let i = 0; i < k; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

async function probe(row, coordsOverride) {
  const homeKey = (row.game_id.split('-')[1] || '').toLowerCase();
  const park = Object.assign({}, PARKS[homeKey], coordsOverride || {});
  const tz = PARK_TZ[homeKey];
  if (park.lat == null) return { skip: 'no_park' };
  const common = { lat: park.lat, lng: park.lng, gameDate: row.game_date, gameTime: row.game_time, archive: true };
  const fixed = await fetchWindAtCoords(Object.assign({}, common, { tz: tz, sourceLabel: 'fixed' }));
  await sleep(120);
  const naive = await fetchWindAtCoords(Object.assign({}, common, { tz: null, sourceLabel: 'naive' }));
  await sleep(120);
  if (fixed.error || naive.error) return { skip: (fixed.error || naive.error) };
  return {
    park: park, tz: tz,
    parkLocalIso: parkLocalHourIso(row.game_date, row.game_time, tz),
    naiveEtHour: (parseGameTimeToEtHm(row.game_time) || {}).hour,
    fixed: fixed, naive: naive,
    dFixed: Math.abs(row.temp_f - fixed.tempF),
    dNaive: Math.abs(row.temp_f - naive.tempF),
    spread: Math.abs(fixed.tempF - naive.tempF),
    wfFixed: calcWindFactor(fixed.windDir, fixed.windSpeed, park),
    traFixed: tempRunAdjFromTempF(fixed.tempF),
  };
}

async function runSet(label, rows, coordsOverride) {
  console.log('\n' + '='.repeat(78) + '\n' + label + '   (n=' + rows.length + ')');
  console.log('date       game      local naive  stored  fixed   naive | d(fix) d(naiv) spread  verdict');
  let mFixed = 0, mNaive = 0, sumSpread = 0, used = 0, skipped = 0;
  let wfOk = 0, traOk = 0;
  for (const row of rows) {
    const p = await probe(row, coordsOverride);
    if (p.skip) { skipped++; console.log(row.game_date + ' ' + row.game_id.padEnd(9) + ' SKIP ' + JSON.stringify(p.skip).slice(0, 60)); continue; }
    used++;
    const verdict = (p.dFixed <= TOL && p.dNaive > TOL) ? 'PARK-LOCAL'
      : (p.dNaive <= TOL && p.dFixed > TOL) ? 'NAIVE-ET'
      : (p.dFixed <= TOL && p.dNaive <= TOL) ? 'both (hours agree)'
      : 'NEITHER';
    if (p.dFixed <= TOL) mFixed++;
    if (p.dNaive <= TOL) mNaive++;
    const storedWf = (row.wind_factor == null ? 0 : row.wind_factor);
    if (Math.abs(storedWf - p.wfFixed) <= 0.005) wfOk++;
    if (row.temp_run_adj != null && p.traFixed != null && Math.abs(row.temp_run_adj - p.traFixed) <= 0.001) traOk++;
    sumSpread += p.spread;
    console.log(row.game_date + ' ' + row.game_id.padEnd(9)
      + ' ' + String(p.parkLocalIso || '').slice(11).padStart(5)
      + ' ' + String(p.naiveEtHour).padStart(5)
      + ' ' + fmt(row.temp_f, 1) + ' ' + fmt(p.fixed.tempF, 1) + ' ' + fmt(p.naive.tempF, 1)
      + ' |' + fmt(p.dFixed, 2) + ' ' + fmt(p.dNaive, 2) + ' ' + fmt(p.spread, 2)
      + '  ' + verdict);
  }
  console.log('-'.repeat(78));
  console.log('  fetched ' + used + ', skipped ' + skipped
    + ' | stored matches PARK-LOCAL hour: ' + mFixed + '/' + used
    + ' | matches NAIVE ET hour: ' + mNaive + '/' + used);
  console.log('  mean |park-local - naive| temp spread: ' + (used ? (sumSpread / used).toFixed(2) : 'n/a') + ' degF'
    + '   (how far the defect moves the input)');
  console.log('  re-derived from the park-local hour: wind_factor reproduces ' + wfOk + '/' + used
    + ', temp_run_adj reproduces ' + traOk + '/' + used);
  return { used: used, mFixed: mFixed, mNaive: mNaive };
}

(async () => {
  console.log('GUARD-REMOVAL CHECK - weather_contamination_reason as a re-scoring filter');
  console.log('window ' + F + ' -> ' + T + ', roof_status=open, archive endpoint (as the 08-05 backfill used)');

  console.log('\n### PROVENANCE (why the columns and the tag disagree) ###');
  const prov = db.prepare(
    "SELECT CASE WHEN weather_contamination_reason IS NULL THEN 'untagged (clean)' "
    + "WHEN weather_contamination_reason LIKE '%naive_hour%' THEN 'naive-hour tagged' "
    + "WHEN weather_contamination_reason LIKE 'ath_%' THEN 'ATH tagged (restored)' "
    + "ELSE 'ARI roof tagged (recomputed)' END cls, COUNT(*) n, "
    + 'MIN(weather_quality_at) first_write, MAX(weather_quality_at) last_write '
    + 'FROM game_log WHERE game_date>=? AND game_date<=? AND away_score IS NOT NULL GROUP BY 1 ORDER BY n DESC'
  ).all(F, T);
  for (const r of prov) {
    console.log('  ' + String(r.n).padStart(4) + '  ' + r.cls.padEnd(30) + '  weather written ' + r.first_write + ' .. ' + r.last_write);
  }
  const jobs = db.prepare(
    "SELECT task, started_at, finished_at FROM backfill_jobs WHERE dry_run=0 AND task IN "
    + "('weather_backfill_season','weather_contamination_naive_hour','weather_contamination_ath','weather_contamination_ari_roof') "
    + 'ORDER BY started_at'
  ).all();
  for (const j of jobs) console.log('  job  ' + j.task.padEnd(34) + ' ' + j.started_at + ' -> ' + (j.finished_at || '(none)'));

  const naiveRows = [].concat(
    stride(candidates("weather_contamination_reason='central_naive_hour_pre_2026_07_30'"), PER_COHORT),
    stride(candidates("weather_contamination_reason='pacific_naive_hour_pre_2026_07_30'"), PER_COHORT),
    stride(candidates("weather_contamination_reason='mountain_naive_hour_pre_2026_07_30'"), PER_COHORT));
  const cleanRows = stride(candidates("weather_contamination_reason IS NULL AND game_date<='2026-08-05'"), 8);
  const athRows = stride(candidates("weather_contamination_reason='ath_coliseum_coords_pre_2026_07_27'"), 5);

  const a = await runSet('1. NAIVE-HOUR TAGGED - the rows the filter currently excludes', naiveRows);
  const b = await runSet('2. CONTROL: untagged rows from the SAME 08-05 archive backfill', cleanRows);
  const c = await runSet('3. NEGATIVE CONTROL: ATH rows re-derived at the CURRENT park (Sutter Health)', athRows);
  const d = await runSet('3b. the same ATH rows re-derived at the PRE-FIX Oakland Coliseum coords', athRows,
    { lat: 37.7516, lng: -122.2005 });

  console.log('\n' + '='.repeat(78) + '\nSUMMARY');
  console.log('  naive-hour tagged  : ' + a.mFixed + '/' + a.used + ' match park-local hour, ' + a.mNaive + '/' + a.used + ' match naive ET hour');
  console.log('  untagged control   : ' + b.mFixed + '/' + b.used + ' match park-local hour, ' + b.mNaive + '/' + b.used + ' match naive ET hour');
  console.log('  ATH @ current park : ' + c.mFixed + '/' + c.used + ' match');
  console.log('  ATH @ Coliseum     : ' + d.mFixed + '/' + d.used + ' match');
})();
