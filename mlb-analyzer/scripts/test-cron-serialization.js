#!/usr/bin/env node
/**
 * The serial job queue: two jobs on one minute must not overlap.
 * (2026-09-05)
 *
 * 8AM PT killed the instance with `lineup 8AM` and `odds 8AM` both STARTed
 * on the same minute from a ~240MB baseline and neither ENDing. 3PM and 5PM
 * fire the same pair and survived from ~219-235MB. The difference was
 * concurrency, not which jobs ran.
 *
 * Asserted here rather than reasoned about:
 *   1. two _queued jobs fired on the same tick run strictly one after the
 *      other, and the second logs how long it waited
 *   2. a job that FAILS does not poison the mutex -- the next one still runs
 *   3. peak sampling emits [job-peak] and analyze-mem-log.js still parses
 *      the END line unchanged
 *   4. nothing calls _queued from inside a queued job (that would deadlock:
 *      the mutex has no re-entrancy detection, by design and by comment)
 *
 * Run: node scripts/test-cron-serialization.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const NL = String.fromCharCode(10);

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== cron serialization ===');

const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- 4. no nesting, checked before anything runs ---------------------
// A _queued call inside a function that is itself queued would deadlock.
// The queued jobs are runLineupJob / runOddsJob / runScoreJob plus whatever
// server.js passes to withMemLog. None of their bodies may call _queued.
const bodyOf = name => {
  const a = src.indexOf('async function ' + name + '(');
  if (a < 0) return '';
  let d = 0;
  for (let i = src.indexOf('{', a); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(a, i + 1); }
  }
  return '';
};
const QUEUED_ENTRYPOINTS = ['runLineupJob', 'runOddsJob', 'runScoreJob',
  'runMorningCaptureJob', 'runWeatherJob', 'runRosterJob'];
let nested = [];
for (const n of QUEUED_ENTRYPOINTS) {
  const b = bodyOf(n);
  if (b && b.indexOf('_queued(') !== -1) nested.push(n);
}
ok('no queued job calls _queued internally (would deadlock)',
   nested.length === 0, nested.length ? 'NESTED IN: ' + nested.join(', ') : 'checked '
     + QUEUED_ENTRYPOINTS.length + ' entrypoints');
ok('the no-reentrancy rule is written down beside the mutex',
   src.indexOf('DO NOT CALL THIS FROM INSIDE A QUEUED JOB') !== -1);

// ---- 3. log contract -------------------------------------------------
ok('END line format unchanged (analyze-mem-log.js parses it)',
   src.indexOf("'[job-mem] ' + label") !== -1
   && src.indexOf("+ '  heap ' + _mb(b.heapUsed) + ' -> ' + _mb(a.heapUsed)") !== -1);
ok('peak reported on its own [job-peak] line',
   src.indexOf("'[job-peak] ' + label") !== -1);
ok('synchronous-region caveat recorded',
   src.indexOf('LOWER BOUNDS') !== -1);

const analyzer = fs.readFileSync(path.join(R, 'scripts/analyze-mem-log.js'), 'utf8');
const jobRe = analyzer.match(/\[job-mem\]\\s\+\(\.\+\?\)[\s\S]*?ms\//);
ok('analyzer job regex requires "heap A -> B", so [job-peak] cannot match it',
   analyzer.indexOf('heap\\s+([\\d.]+)MB\\s*->') !== -1);

// ---- 1 & 2. runtime behaviour ---------------------------------------
const jobs = require(path.join(R, 'services/jobs'));
const withMemLog = jobs.withMemLog;

const lines = [];
const realLog = console.log;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log = (...a) => { lines.push(a.join(' ')); };
  const order = [];
  const mk = (name, ms, fail) => () => (async () => {
    order.push('start:' + name);
    await sleep(ms);
    order.push('end:' + name);
    if (fail) throw new Error('deliberate ' + name);
    return name;
  })();

  // Fired on the same tick, exactly like two crons on one minute.
  const p1 = withMemLog('probe A', mk('A', 400));
  const p2 = withMemLog('probe B', mk('B', 120));
  await Promise.allSettled([p1, p2]);
  // Snapshot now: `order` keeps accumulating through the later probes, and
  // comparing the whole array at the end would fail on entries this
  // assertion is not about.
  const pairOrder = order.slice(0, 4).join(',');

  // A failing job must not poison the mutex.
  const p3 = withMemLog('probe C fails', mk('C', 60, true));
  await Promise.allSettled([p3]);
  const p4 = withMemLog('probe D', mk('D', 60));
  await Promise.allSettled([p4]);

  console.log = realLog;

  ok('two jobs fired on one tick do not interleave',
     pairOrder === 'start:A,end:A,start:B,end:B',
     pairOrder);
  ok('the second job logs that it waited',
     lines.some(l => l.indexOf('[job-queue] probe B waited') === 0),
     (lines.find(l => l.indexOf('[job-queue]') === 0) || '(no [job-queue] line)').trim());
  ok('a failed job does not poison the mutex -- the next one still runs',
     order.indexOf('end:D') !== -1, order.slice(-4).join(' '));
  ok('the failed job still logs its END with FAILED',
     lines.some(l => l.indexOf('[job-mem] probe C fails') === 0 && l.indexOf('FAILED') !== -1));
  ok('every job emits START, END and [job-peak]',
     ['probe A', 'probe B', 'probe D'].every(n =>
       lines.some(l => l.indexOf('[job-mem] START ' + n) === 0)
       && lines.some(l => l.indexOf('[job-mem] ' + n + '  heap') === 0)
       && lines.some(l => l.indexOf('[job-peak] ' + n) === 0)));

  console.log('');
  console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
  process.exit(failures ? 1 : 0);
})();
