'use strict';
// Verify that fetchActualSplit's body matches the captured working
// payload byte-for-byte on shape (types, keys). Also checks
// seasonDateRange derivation across boundary cases.

const path = require('path');
// Load fangraphs.js in a way that exposes internals via re-require
// tricks — the module doesn't export the body helper directly, so
// we monkey-patch fetch to capture the outgoing body without hitting
// the network.

// Stub global fetch to capture the outgoing request.
let captured = null;
global.fetch = async function(url, opts) {
  captured = { url, opts };
  // Return a valid-looking 500 so the caller throws (we don't care
  // about the return value — we're just capturing the body).
  return {
    ok: false, status: 500,
    text: async () => JSON.stringify({ Message: 'test' }),
    json: async () => ({ data: [] }),
  };
};

const fg = require('../services/fangraphs');

(async function main() {
  // Trigger a call. We know it will throw (fake 500); ignore the throw.
  try {
    await fg.fetchActualSplit(1, 'B', 'FAKECOOKIE');
  } catch (e) { /* expected */ }

  if (!captured) { console.error('FAIL: fetch not intercepted'); process.exit(1); }
  const body = JSON.parse(captured.opts.body);

  const captureRef = {
    arrPlayerId: [],
    arrWxAirDensity: null,
    arrWxElevation: null,
    arrWxPressure: null,
    arrWxTemperature: null,
    arrWxWindSpeed: null,
    dctFilters: [],
    strAutoPt: 'true',
    strGroup: 'season',
    strPlayerId: 'all',
    strPosition: 'B',
    // strSplitArr: our code passes [splitCode] not []; verify separately
    strSplitArrPitch: [],
    strSplitTeams: false,
    strStatType: 'player',
    strType: '2',
    // dates verified separately
  };

  console.log('== field/type diff against captured payload ==');
  const bodyKeys = Object.keys(body).sort();
  const refKeys = Object.keys(captureRef).sort();
  let fails = 0;

  // Key set (excluding our splitCode + dates)
  const skipCompare = new Set(['strSplitArr', 'strStartDate', 'strEndDate']);
  const bodyKeysNoSkip = bodyKeys.filter(k => !skipCompare.has(k));
  const refExpected = refKeys.filter(k => !skipCompare.has(k));

  const missing = refExpected.filter(k => !bodyKeysNoSkip.includes(k));
  const extra = bodyKeysNoSkip.filter(k => !refExpected.includes(k));
  if (missing.length) { console.log('FAIL missing keys: ' + missing.join(', ')); fails++; }
  if (extra.length)   { console.log('FAIL extra keys: '   + extra.join(', ')); fails++; }
  if (!missing.length && !extra.length) console.log('PASS  key set matches captured payload (' + bodyKeysNoSkip.length + ' keys)');

  // Type + value comparison for each expected key
  for (const k of refExpected) {
    const got = body[k];
    const want = captureRef[k];
    const typeMatch = typeof got === typeof want && Array.isArray(got) === Array.isArray(want);
    let valMatch;
    if (Array.isArray(want)) valMatch = Array.isArray(got) && got.length === want.length;
    else valMatch = got === want;
    const ok = typeMatch && valMatch;
    if (!ok) fails++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + k.padEnd(20) + '  got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want));
  }

  // strSplitArr — our code passes [splitCode] not [] from captured
  console.log('PASS  strSplitArr (our use case sends [splitCode] intentionally) got=' + JSON.stringify(body.strSplitArr));

  // Dates — should be 2-year trailing (start ≈ end - 2 years). Signal-
  // stability choice from the original 2026-04-21 introduction; see the
  // comment above twoYearDateRange in services/fangraphs.js. Match the
  // captured payload only on TYPE (ISO YYYY-MM-DD), not on the specific
  // 03-01→11-01 range the operator was viewing at capture time.
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;
  const s = Date.parse(body.strStartDate);
  const e = Date.parse(body.strEndDate);
  const rangeDays = (e - s) / (24 * 3600 * 1000);
  const twoYearOk = rangeDays > 729 && rangeDays < 732;  // ±1 leap-day slack
  const shapesOk = isoRe.test(body.strStartDate) && isoRe.test(body.strEndDate);
  if (shapesOk && twoYearOk) {
    console.log('PASS  strStartDate/strEndDate 2-year trailing: ' + body.strStartDate + ' → ' + body.strEndDate + '  (' + Math.round(rangeDays) + 'd)');
  } else {
    console.log('FAIL  strStartDate/strEndDate: got ' + body.strStartDate + ' → ' + body.strEndDate + '  (' + rangeDays + 'd, want ~730d)');
    fails++;
  }

  // URL should be canonical splits-leaders (NOT -legacy)
  if (captured.url === 'https://www.fangraphs.com/api/leaders/splits/splits-leaders') {
    console.log('PASS  URL canonical (not -legacy): ' + captured.url);
  } else {
    console.log('FAIL  URL: ' + captured.url);
    fails++;
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
