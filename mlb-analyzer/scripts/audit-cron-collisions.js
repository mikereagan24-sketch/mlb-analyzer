#!/usr/bin/env node
/**
 * Which cron minutes fire more than one job? (2026-09-05)
 *
 * 8AM PT killed the instance with `lineup 8AM` and `odds 8AM` both STARTed
 * on the same minute and neither ENDing. The question "what else shares a
 * minute" should not be answered by reading the file, because the hour
 * loops are array-driven and easy to miscount by eye.
 *
 * So this enumerates at RUNTIME: stub node-cron's schedule(), call
 * startCronJobs(), and record every expression actually registered. Exact
 * by construction -- if a schedule is registered, it is here.
 *
 * Also reports which registered jobs go through the serial queue
 * (_queued/withMemLog) and which do not, because an unqueued job can still
 * overlap a queued one.
 *
 * Run: node scripts/audit-cron-collisions.js
 * Exit 1 if any minute carries two or more jobs that are NOT both queued.
 */
const path = require('path');
const Module = require('module');
const R = path.join(__dirname, '..');
const NL = String.fromCharCode(10);

// Intercept node-cron before services/jobs.js requires it.
const cron = require(path.join(R, 'node_modules/node-cron'));
const registered = [];
const stub = { stop() {}, start() {}, destroy() {} };
cron.schedule = function (expr, fn, opts) {
  registered.push({ expr, fn, opts });
  return stub;
};

const jobs = require(path.join(R, 'services/jobs'));

// Silence the heartbeat + banner that startCronJobs emits.
const realLog = console.log;
console.log = () => {};
try { jobs.startCronJobs(); } finally { console.log = realLog; }

// Name each job from its own callback source: every one logs a [cron]
// line or calls _queued/_mem with a label.
function nameOf(fn) {
  const src = String(fn);
  let m = src.match(/_queued\(\s*'([^']+)'/) || src.match(/_mem\(\s*'([^']+)'/);
  if (m) return m[1] + (src.indexOf('_queued(') !== -1 ? '' : '  [NOT QUEUED]');
  m = src.match(/\[cron\]\s*'?\s*\+?\s*([A-Za-z0-9 ]*)/);
  const lit = src.match(/console\.log\('\[cron\] ([^']+)'/);
  if (lit) return lit[1] + '  [NOT QUEUED]';
  m = src.match(/run([A-Z]\w+)\(/);
  return (m ? m[0].replace(/\($/, '') : 'unknown') + '  [NOT QUEUED]';
}

// Expand '0 '+h+' * * *' style expressions: they are already concrete
// strings by the time schedule() sees them.
const rows = registered.map(r => {
  const parts = String(r.expr).trim().split(/\s+/);
  return {
    expr: r.expr,
    min: parts[0], hour: parts[1], dom: parts[2], mon: parts[3], dow: parts[4],
    name: nameOf(r.fn),
    queued: String(r.fn).indexOf('_queued(') !== -1,
    tz: r.opts && r.opts.timezone ? r.opts.timezone : '(none)',
  };
});

const out = [];
out.push('=== registered cron schedules (' + rows.length + ') ===');
out.push('  all times are the timezone each schedule declares');
out.push('');
out.push('  min hour dom mon dow   tz                      queued  job');
for (const r of rows.slice().sort((a, b) =>
  (Number(a.hour) || 0) - (Number(b.hour) || 0) || (Number(a.min) || 0) - (Number(b.min) || 0))) {
  out.push('  ' + String(r.min).padStart(3) + String(r.hour).padStart(5)
    + String(r.dom).padStart(4) + String(r.mon).padStart(4) + String(r.dow).padStart(4)
    + '   ' + r.tz.padEnd(22) + (r.queued ? ' yes  ' : ' NO   ') + '  ' + r.name);
}

// Collisions: same minute+hour+dow+dom.
const key = r => [r.min, r.hour, r.dom, r.mon, r.dow].join(' ');
const byKey = new Map();
for (const r of rows) {
  if (!byKey.has(key(r))) byKey.set(key(r), []);
  byKey.get(key(r)).push(r);
}
const collisions = [...byKey.entries()].filter(([, v]) => v.length > 1);

out.push('');
out.push('=== minutes carrying more than one job (' + collisions.length + ') ===');
let unsafe = 0;
if (!collisions.length) out.push('  none');
for (const [k, v] of collisions.sort((a, b) => (Number(a[1][0].hour) || 0) - (Number(b[1][0].hour) || 0))) {
  const allQueued = v.every(r => r.queued);
  if (!allQueued) unsafe++;
  out.push('  ' + k + '   ' + v.length + ' jobs   '
    + (allQueued ? 'SERIALIZED by the queue' : '*** CAN STILL OVERLAP ***'));
  for (const r of v) out.push('      - ' + (r.queued ? '[queued] ' : '[unqueued] ') + r.name);
}

out.push('');
out.push('  ' + rows.filter(r => r.queued).length + ' of ' + rows.length
  + ' registered schedules go through the serial queue.');
out.push('  Unqueued schedules are not necessarily a problem -- a light job');
out.push('  that shares no minute with another cannot overlap anything.');
out.push('  What matters is a shared minute with at least one unqueued job.');

// BASELINE ARM. A check that is red forever for a known, accepted gap
// trains the eye to skip it. So the accepted set is written down, and the
// check fails on a CHANGE in either direction: a new overlapping minute
// appears, or a baselined one gets fixed and the baseline goes stale.
const BASELINE = ['0 23 * * *'];
const nowUnsafe = collisions.filter(([, v]) => !v.every(r => r.queued)).map(([k]) => k).sort();
const base = BASELINE.slice().sort();
const added = nowUnsafe.filter(k => base.indexOf(k) === -1);
const fixed = base.filter(k => nowUnsafe.indexOf(k) === -1);

out.push('');
out.push('=== baseline ===');
out.push('  accepted overlapping minutes: ' + (base.length ? base.join(', ') : '(none)'));
out.push('    0 23 * * *  the 11PM PT lineup pull and the 11PM PT tomorrow-slate');
out.push('    refresh share a minute and neither is _mem-wrapped, so neither is');
out.push('    queued. Same failure shape as the 8AM kill; it has not fired.');
out.push('    Deliberately NOT changed in the PR that added the queue -- that');
out.push('    PR was scoped to _mem-wrapped jobs, and restructuring two of the');
out.push('    heaviest chains belongs in its own change.');
if (added.length) {
  out.push('');
  out.push('  NEW overlapping minute(s) not in the baseline: ' + added.join(', '));
  out.push('  Two jobs can now run at once where they could not before.');
}
if (fixed.length) {
  out.push('');
  out.push('  Baselined minute(s) now SERIALIZED: ' + fixed.join(', '));
  out.push('  Good news -- update BASELINE in this file so the check keeps its');
  out.push('  teeth. An accepted-failure list nobody prunes is how a real');
  out.push('  regression hides inside a carried failure count.');
}
out.push('');
out.push(added.length || fixed.length ? '  RESULT: baseline mismatch' : '  RESULT: matches baseline');
process.stdout.write(out.join(NL) + NL);
process.exit(added.length || fixed.length ? 1 : 0);
