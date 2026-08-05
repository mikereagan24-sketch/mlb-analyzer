#!/usr/bin/env node
'use strict';

// Verifies the cron path is byte-identical after the archive-mode
// refactor to services/weather.js. Rather than asserting by
// inspection ("the else branch looks unchanged"), this test:
//
//   1. Monkey-patches global.fetch to capture the URL fetchWindAtCoords
//      constructs and to return a canned Open-Meteo-shaped response.
//   2. Calls fetchWindAtCoords three times:
//        (a) with NO opts.archive at all (cron behavior)
//        (b) with archive:false explicit
//        (c) with archive:undefined explicit
//      All three MUST produce a URL identical to the pre-refactor
//      forecast URL (including precipitation_probability in hourly)
//      and MUST return the same shape.
//   3. Calls once with archive:true and asserts the URL routes to
//      archive-api and drops precipitation_probability.
//
// The pre-refactor URL is hardcoded below; any change to the else
// branch of fetchWindAtCoords will drift from it and fail the test.
//
// USAGE: node tmp/verify-cron-path-byte-identical.js

const { fetchWindAtCoords } = require('../services/weather');

// Pre-refactor URL shape from services/weather.js pre-2026-08-05,
// with lat/lng/dates matching the fixture below. cacheBust suffix
// stripped for stable comparison.
const EXPECTED_FORECAST_URL = (() => {
  return 'https://api.open-meteo.com/v1/forecast?latitude=42.3467&longitude=-71.0972'
    + '&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability'
    + '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto'
    + '&start_date=2026-06-01&end_date=2026-06-03';
})();

const EXPECTED_ARCHIVE_URL_PREFIX = 'https://archive-api.open-meteo.com/v1/archive?';

const FIXTURE_ARCHIVE_HOURS_HAS_PRECIP  = false;  // archive endpoint
const FIXTURE_FORECAST_HOURS_HAS_PRECIP = true;   // forecast endpoint

// Canned hourly response — 72 hours (3 days) covering start_date..end_date.
function makeCannedResponse({ withPrecip }) {
  const times = [];
  const winds = [];
  const dirs  = [];
  const temps = [];
  const precips = withPrecip ? [] : undefined;
  const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];
  for (const d of dates) {
    for (let h = 0; h < 24; h++) {
      times.push(`${d}T${String(h).padStart(2, '0')}:00`);
      winds.push(10 + h * 0.1);
      dirs.push((45 + h) % 360);
      temps.push(70 + h * 0.5);
      if (withPrecip) precips.push(5);
    }
  }
  const hourly = { time: times, wind_speed_10m: winds, wind_direction_10m: dirs, temperature_2m: temps };
  if (withPrecip) hourly.precipitation_probability = precips;
  return { timezone: 'America/New_York', hourly };
}

let capturedUrls = [];

function installFetch(mode) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    capturedUrls.push(url);
    const isArchive = String(url).startsWith('https://archive-api.');
    return {
      json: async () => makeCannedResponse({ withPrecip: !isArchive }),
    };
  };
  return () => { global.fetch = originalFetch; };
}

function stripCacheBust(url) { return String(url).replace(/&_t=\d+$/, ''); }

async function main() {
  const fixture = {
    lat: 42.3467, lng: -71.0972,
    tz: 'America/New_York',
    gameDate: '2026-06-02', gameTime: '7:10 PM ET',
    sourceLabel: 'test bos home',
    cacheBust: true,
  };
  const uninstall = installFetch();

  let failures = 0;
  const results = [];

  // Case (a): no opts.archive at all
  capturedUrls = [];
  const resA = await fetchWindAtCoords(fixture);
  const urlA = stripCacheBust(capturedUrls[0]);
  const okA = urlA === EXPECTED_FORECAST_URL && Number.isFinite(resA.precipProb);
  results.push({ case: 'no archive opt', ok: okA, url: urlA, precipProb: resA.precipProb });
  if (!okA) failures++;

  // Case (b): archive:false explicit
  capturedUrls = [];
  const resB = await fetchWindAtCoords(Object.assign({}, fixture, { archive: false }));
  const urlB = stripCacheBust(capturedUrls[0]);
  const okB = urlB === EXPECTED_FORECAST_URL && Number.isFinite(resB.precipProb);
  results.push({ case: 'archive:false', ok: okB, url: urlB, precipProb: resB.precipProb });
  if (!okB) failures++;

  // Case (c): archive:undefined explicit
  capturedUrls = [];
  const resC = await fetchWindAtCoords(Object.assign({}, fixture, { archive: undefined }));
  const urlC = stripCacheBust(capturedUrls[0]);
  const okC = urlC === EXPECTED_FORECAST_URL && Number.isFinite(resC.precipProb);
  results.push({ case: 'archive:undefined', ok: okC, url: urlC, precipProb: resC.precipProb });
  if (!okC) failures++;

  // Case (d): archive:true — url differs, precipProb=0
  capturedUrls = [];
  const resD = await fetchWindAtCoords(Object.assign({}, fixture, { archive: true }));
  const urlD = stripCacheBust(capturedUrls[0]);
  const archiveRouted = urlD.startsWith(EXPECTED_ARCHIVE_URL_PREFIX);
  const droppedPrecip = !urlD.includes('precipitation_probability');
  const precipZero    = resD.precipProb === 0;
  const okD = archiveRouted && droppedPrecip && precipZero;
  results.push({ case: 'archive:true', ok: okD, url: urlD, precipProb: resD.precipProb,
                 checks: { archiveRouted, droppedPrecip, precipZero } });
  if (!okD) failures++;

  uninstall();

  console.log('=== verify-cron-path-byte-identical ===');
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + ' — ' + r.case);
    console.log('  url: ' + r.url);
    console.log('  precipProb: ' + r.precipProb);
    if (r.checks) console.log('  checks: ' + JSON.stringify(r.checks));
    if (!r.ok && r.case !== 'archive:true') {
      console.log('  expected url: ' + EXPECTED_FORECAST_URL);
    }
  }
  console.log('');
  console.log(failures === 0 ? 'ALL PASS' : (failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('THREW', e); process.exit(2); });
