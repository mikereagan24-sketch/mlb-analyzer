#!/usr/bin/env node
/**
 * Boot runs one job at a time. (2026-09-03)
 *
 * WHY. On 2026-09-02 Render OOM-killed the service four times between
 * 16:29 and 16:35 PT (one exit 134, >512MB against a ~670MB database). The
 * deploy that triggered it added a single unreferenced script file -- there
 * was nothing in the diff. A restart alone was enough, which is what boot
 * being over budget looks like, and the loop is self-sustaining because
 * every restart re-runs the same heavy boot.
 *
 * The listen() callback fired four fire-and-forget jobs at once plus a
 * delayed prefetch running three more. The memory is statsapi JSON, not
 * SQLite: runFirstPitchBackfillIfMissing walks up to 400 games through the
 * v1.1 feed/live endpoint, which carries every play of a game.
 *
 * THE PROPERTY IS PEAK CONCURRENCY, so that is what this asserts -- not
 * "the jobs are still called". Total network work is deliberately
 * unchanged; only how much of it is alive at once.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };

const src = fs.readFileSync(path.join(R, 'server.js'), 'utf8');

// Bound the listen() callback.
const start = src.indexOf('  startCronJobs();');
ok(start > 0, 'located the listen() callback');
const body = src.slice(start);

// The deferred chain begins at the setTimeout inside the roster .then().
const deferAt = body.indexOf('setTimeout(async () => {');
ok(deferAt > 0, 'located the deferred boot chain');

const critical = body.slice(0, deferAt);
const deferred = body.slice(deferAt);

const HEAVY = [
  'runParkFactorsJobIfStale',
  'runFirstPitchBackfillIfMissing',
  'runPitcherUsageBackfill',
  'runOddsJob',
  'runWeatherJob',
  'runLineupJob',
];

// ---- 1. only the roster pull is on the critical path -------------------
for (const j of HEAVY) {
  ok(!critical.includes(j + '('),
     j + ' is NOT on the boot critical path');
}
ok(critical.includes('runRosterJob()'),
   'runRosterJob IS on the critical path -- everything downstream resolves '
   + 'names against team_rosters, so a stale roster degrades the model');

// ---- 2. every heavy job is inside the deferred chain ------------------
for (const j of HEAVY) {
  ok(deferred.includes(j + '('), j + ' runs in the deferred chain');
}

// ---- 3. peak concurrency is 1: each heavy job is awaited --------------
// The old shape was `job().catch(...)` with no await -- four of those in a
// row means four in flight. Assert the fire-and-forget form is gone for
// each heavy job, and that the chain awaits.
for (const j of HEAVY.slice(0, 3)) {
  const fireAndForget = new RegExp(j + '\\(\\)\\s*\\n?\\s*\\.catch');
  ok(!fireAndForget.test(src),
     j + ' is not invoked fire-and-forget (no bare .catch() chain)');
}
ok(/await step\(/.test(deferred), 'the deferred chain awaits each step');
const awaited = (deferred.match(/await step\(/g) || []).length;
ok(awaited >= 4, 'at least four steps are awaited in sequence (got ' + awaited + ')');

// A step helper that swallows per-job failures, so one failure does not
// abort the rest -- that is what the four independent .catch() calls bought
// and it must not be lost to serialising them.
ok(/const step = async \(label, fn\) =>/.test(deferred),
   'a step() helper wraps each job');
ok(/catch \(e\) \{ console\.warn\('\[boot-chain\] '/.test(deferred),
   'and a failing step logs and continues rather than aborting the chain');

// ---- 4. nothing is called twice --------------------------------------
// A botched edit that leaves the old call site behind would double the work
// AND restore the concurrency.
for (const j of HEAVY.concat(['runRosterJob'])) {
  const n = (src.match(new RegExp(j + '\\(', 'g')) || []).length;
  ok(n === 1, j + ' appears exactly once in server.js (got ' + n + ')');
}

// ---- 5. the file still parses and the module graph loads --------------
const { execFileSync } = require('child_process');
let checkOk = true;
try { execFileSync(process.execPath, ['--check', path.join(R, 'server.js')], { stdio: 'pipe' }); }
catch (e) { checkOk = false; }
ok(checkOk, 'server.js passes node --check');

// The jobs the boot chain names must actually be exported, or boot throws
// a TypeError at the first step -- after listen() has already returned 200,
// which would look like a silent no-op rather than a crash.
const jobs = require(path.join(R, 'services/jobs'));
for (const j of ['runRosterJob', 'runParkFactorsJobIfStale',
                 'runFirstPitchBackfillIfMissing', 'runPitcherUsageBackfill',
                 'runOddsJob', 'runWeatherJob', 'runLineupJob']) {
  ok(typeof jobs[j] === 'function', 'services/jobs exports ' + j);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
