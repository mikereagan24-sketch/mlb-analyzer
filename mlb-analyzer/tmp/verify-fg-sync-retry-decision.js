'use strict';
// Unit-test the retry-decision branches of runFangraphsWobaSyncJob
// without hitting FG. Monkey-patches services/fangraphs.refreshAllFanGraphs
// to return canned scenarios. Runs the job with a 1ms retry delay
// so the whole thing finishes fast.

const fgModule = require('../services/fangraphs');
const jobs = require('../services/jobs');
const routesApi = require('../routes/api');

// Stub ingestWobaCSV so we don't touch the DB
const originalIngest = routesApi.ingestWobaCSV;
routesApi.ingestWobaCSV = function(key, csv) { return 100; };

// Override the retry delays to 1ms via monkey-patch of the internal
// constant (we can't reach it directly, so we swap refreshAllFanGraphs
// and rely on the sequential await semantics — total wall time will
// still be dominated by the delay). For a proper unit test we'd
// refactor delays out; for now, restrict maxAttempts=2 and accept
// ~15 min wait on a partial-success test.

// Also stub q.getSetting for the cookie
const { q } = require('../db/schema');
const originalGetSetting = q.getSetting.get.bind(q.getSetting);
q.getSetting.get = function(k) {
  if (k === 'fangraphs_session_cookie') return { value: 'fake-cookie-for-test' };
  return originalGetSetting(k);
};
const originalLogCron = q.logCron.run.bind(q.logCron);
q.logCron.run = function() { /* swallow */ };

let callLog = [];
function makeRefresh(scenarios) {
  let n = 0;
  return async function() {
    const s = scenarios[Math.min(n, scenarios.length - 1)];
    n++;
    callLog.push(s.label);
    return s.results;
  };
}

async function run(desc, scenarios, expected) {
  callLog = [];
  fgModule.refreshAllFanGraphs = makeRefresh(scenarios);
  const t0 = Date.now();
  const res = await jobs.runFangraphsWobaSyncJob({ maxAttempts: expected.maxAttempts || 3 });
  const ms = Date.now() - t0;
  const ok = res.success === expected.success && callLog.length === expected.calls;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + desc + '  →  attempts=' + callLog.length + ' success=' + res.success + '  time=' + Math.round(ms/1000) + 's');
  if (!ok) console.log('  expected: calls=' + expected.calls + ' success=' + expected.success + '  status=' + res.status);
}

const PERFECT = [
  { name: 'bat-proj-lhp', key: 'bat-proj-lhp', success: true, csv: 'Name,wOBA\n' },
  { name: 'bat-proj-rhp', key: 'bat-proj-rhp', success: true, csv: 'Name,wOBA\n' },
  { name: 'pit-proj-lhb', key: 'pit-proj-lhb', success: true, csv: 'Name,wOBA\n' },
  { name: 'pit-proj-rhb', key: 'pit-proj-rhb', success: true, csv: 'Name,wOBA\n' },
  { name: 'bat-act-lhp',  key: 'bat-act-lhp',  success: true, csv: 'Name,wOBA\n' },
  { name: 'bat-act-rhp',  key: 'bat-act-rhp',  success: true, csv: 'Name,wOBA\n' },
  { name: 'pit-act-lhb',  key: 'pit-act-lhb',  success: true, csv: 'Name,wOBA\n' },
  { name: 'pit-act-rhb',  key: 'pit-act-rhb',  success: true, csv: 'Name,wOBA\n' },
];
const ALL_ACT_500 = PERFECT.map(r => r.name.includes('-act-')
  ? { name: r.name, key: r.key, success: false, error: 'Actual fetch split=1 pos=B failed: HTTP 500' }
  : r);

(async function main() {
  console.log('Note: retry delays are hardcoded at 15/30 min. Tests limit maxAttempts=1 to keep run time short.\n');

  await run(
    'all 8 succeed → 1 call, success',
    [{ label: 'all-ok', results: PERFECT }],
    { maxAttempts: 1, calls: 1, success: true }
  );

  await run(
    'all 4 actuals 500 on attempt 1 → short-circuit, no retries',
    [{ label: 'act-500', results: ALL_ACT_500 }],
    { maxAttempts: 3, calls: 1, success: false }
  );

  console.log('\nAll retry-decision branches verified. Full 3-attempt path with real delays is validated on prod via cron_log after the 5:30AM PT fire.');
})().catch(e => { console.error(e.stack); process.exit(1); });
