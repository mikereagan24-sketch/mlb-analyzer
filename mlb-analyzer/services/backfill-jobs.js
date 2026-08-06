'use strict';

// Async backfill job runner + task registry.
//
// Backs POST /api/admin/backfill/:task. The route inserts a row into
// backfill_jobs, returns 202 + job_id, and dispatches runBackfillJob
// on setImmediate so the response goes out before the runner starts
// consuming the event loop (same pattern as parameter-sweep).
//
// Tasks register themselves via registerBackfillTask({ name, run }).
// A task's run(ctx) receives:
//   ctx.db          — better-sqlite3 handle
//   ctx.params      — the request body {from, to, dry_run, ...task-specific}
//   ctx.dryRun      — boolean (echoes params.dry_run; runner MUST honor it)
//   ctx.onProgress  — (patch) => void; merge-writes progress_json,
//                     throttled to ~5s so it doesn't SQLite-thrash a
//                     tight inner loop.
// The run() function returns a summary object that lands in
// results_json. Throws are caught by the orchestrator and land in
// error/status='error'.
//
// Idempotency is the TASK's responsibility. Each runner is expected to
// scope its writes to rows that still need the fill (e.g. IS NULL
// filters, contamination_reason IS NULL) so re-running is a no-op.
// The orchestrator itself does nothing to prevent double-write; a
// task that clobbers on re-run has a task-side bug.
//
// Dry-run semantics: a task MUST branch on ctx.dryRun and skip actual
// writes when true, returning the projected-change counts in the same
// summary shape so the operator can compare projected-vs-actual after
// flipping to live.

const PROGRESS_THROTTLE_MS = 5000;

// ------------- registry -------------

const _tasks = new Map();

function registerBackfillTask(def) {
  if (!def || typeof def.name !== 'string' || typeof def.run !== 'function') {
    throw new Error('registerBackfillTask: def must be { name, run }');
  }
  if (_tasks.has(def.name)) {
    throw new Error('registerBackfillTask: duplicate task name ' + def.name);
  }
  _tasks.set(def.name, def);
}

function getBackfillTask(name) {
  return _tasks.get(name) || null;
}

function listBackfillTasks() {
  return Array.from(_tasks.keys()).sort();
}

// ------------- orchestrator -------------

// Runs a task by name. Called by the route on setImmediate. Not a
// long-lived function — it awaits the task's run() and persists the
// outcome. Errors are caught here so the row always transitions out of
// 'running' (or is left for boot-cleanup on a hard crash).
async function runBackfillJob(db, q, nowPtIso, jobId, taskName, params) {
  const task = getBackfillTask(taskName);
  if (!task) {
    q.updateBackfillJobError.run('unknown task: ' + taskName, nowPtIso(), jobId);
    return;
  }
  const dryRun = params.dry_run !== false;
  let lastProgressWrite = 0;
  let latestProgress = null;
  const onProgress = (patch) => {
    latestProgress = Object.assign({}, latestProgress || {}, patch || {});
    const now = Date.now();
    if (now - lastProgressWrite < PROGRESS_THROTTLE_MS) return;
    lastProgressWrite = now;
    try {
      q.updateBackfillJobProgress.run(JSON.stringify(latestProgress), jobId);
    } catch (e) {
      console.warn('[backfill] progress write failed job_id=' + jobId, e && e.message);
    }
  };
  try {
    const summary = await task.run({ db, q, params, dryRun, onProgress });
    // Final progress flush + terminal write. Passing the last
    // progress_json as the second arg to updateBackfillJobDone COALESCEs
    // in the last throttled tick that may have been suppressed.
    const finalProgress = latestProgress ? JSON.stringify(latestProgress) : null;
    q.updateBackfillJobDone.run(JSON.stringify(summary || {}), finalProgress, nowPtIso(), jobId);
    console.log('[backfill] done job_id=' + jobId + ' task=' + taskName + ' dry_run=' + dryRun);
  } catch (err) {
    console.error('[backfill] error job_id=' + jobId + ' task=' + taskName, err);
    try {
      q.updateBackfillJobError.run(err.message || String(err), nowPtIso(), jobId);
    } catch (writeErr) {
      console.error('[backfill] error-write failed job_id=' + jobId, writeErr);
    }
  }
}

// ------------- boot cleanup -------------

// Same reasoning as cleanupOrphanedSweepRuns: any row still 'running'
// at process start has lost its in-process async closure. Mark 'error'
// with an abandonment message. Logs task + params for triage.
function cleanupOrphanedBackfillJobs(q, nowPtIso) {
  const orphans = q.getRunningBackfillJobs.all();
  if (!orphans.length) {
    console.log('[backfill-cleanup] no orphaned running rows at boot');
    return { abandoned: 0, jobs: [] };
  }
  const finishedAt = nowPtIso();
  const errMsg = 'abandoned: process restarted while backfill was in flight';
  const jobs = [];
  for (const row of orphans) {
    let params = null;
    try { params = JSON.parse(row.params_json); } catch (e) { /* best-effort */ }
    console.warn('[backfill-cleanup] abandoning job_id=' + row.job_id
      + ' task=' + row.task
      + ' dry_run=' + row.dry_run
      + ' started_at=' + row.started_at
      + ' params=' + (params ? JSON.stringify(params) : row.params_json));
    q.markBackfillJobAbandoned.run(errMsg, finishedAt, row.job_id);
    jobs.push({ job_id: row.job_id, task: row.task, dry_run: !!row.dry_run, started_at: row.started_at, params });
  }
  console.warn('[backfill-cleanup] marked ' + orphans.length + ' orphan(s) as error');
  return { abandoned: orphans.length, jobs };
}

// ------------- shared helpers used by task runners -------------

function assertDateRange(params) {
  const errs = [];
  if (!params.from || !/^\d{4}-\d{2}-\d{2}$/.test(params.from)) errs.push('from (YYYY-MM-DD) required');
  if (!params.to   || !/^\d{4}-\d{2}-\d{2}$/.test(params.to))   errs.push('to (YYYY-MM-DD) required');
  if (!errs.length && params.from > params.to) errs.push('from must be <= to');
  if (errs.length) throw new Error(errs.join('; '));
}

module.exports = {
  registerBackfillTask,
  getBackfillTask,
  listBackfillTasks,
  runBackfillJob,
  cleanupOrphanedBackfillJobs,
  assertDateRange,
  PROGRESS_THROTTLE_MS,
};

// ------------- built-in task registrations -------------
//
// Loaded eagerly so any process that requires this module gets the
// tasks registered before the route handler queries the registry.
// Placed at the bottom to keep the module surface (exports above)
// stable regardless of task set.

require('./backfill-tasks/sp-forecast-ip');
require('./backfill-tasks/weather-contamination-ath');
require('./backfill-tasks/weather-backfill-season');
require('./backfill-tasks/weather-contamination-naive-hour');
