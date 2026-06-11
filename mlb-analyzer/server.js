// @deployed 2026-04-17T16:23:52.313Z
'use strict';
// BUILD_TS: 2026-04-11T17:15:25.624Z
const express = require('express');
const cors = require('cors');
const path = require('path');
const { startCronJobs, runRosterJob, runOddsJob, runWeatherJob, runLineupJob, runPitcherUsageBackfill } = require('./services/jobs');

// One-shot row migrations. db/schema.js's require() opened the DB and
// ran its schema migrations (CREATE TABLE IF NOT EXISTS, idempotent
// ALTER TABLE attempts) at module load. applyPendingMigrations does
// the next layer — row-level normalizations gated by a
// migrations_applied bookkeeping table so each one runs at most once.
// Synchronous + sequenced before app.listen so any /api request
// served after listen() sees fully-normalized rows. Aborts the boot
// on failure rather than coming up half-migrated.
const { db, q } = require('./db/schema');
const { applyPendingMigrations } = require('./services/migrations');
applyPendingMigrations(db);

// Orphan parameter_sweep_runs cleanup. Any row still 'running' at boot
// is by definition orphaned (the in-process closure that would have
// transitioned it to 'done'/'error' is gone with the prior process).
// Mark them error so /admin/parameter-sweep/latest stops surfacing
// them and the POST-handler in-flight dedupe clears. Logs each
// orphan's params_json so the operator can see what was killed.
// Runs synchronously before listen() so /admin/parameter-sweep routes
// served immediately after boot see a clean table.
const { cleanupOrphanedSweepRuns } = require('./services/parameter-sweep');
const { nowPtIso } = require('./services/jobs');
try { cleanupOrphanedSweepRuns(q, nowPtIso); }
catch (e) { console.warn('[sweep-cleanup] boot cleanup failed:', e && e.message); }

// Empirical-spread ROI readout boot smoke. Exercises the full
// buildReadout pipeline once on a 30-day window so a ReferenceError
// or similar JS-level failure surfaces in the deploy log instead of
// 500-ing on the operator's first curl. Picked up after a missing-
// variable bug in the FIX 1 enrichPlay rewrite (commit 17232dd)
// shipped to prod and broke every readout call until the hotfix.
// Synchronous + boot-blocking guard logs but does NOT abort listen()
// — the readout being broken shouldn't keep the rest of the app
// from serving its routes; the log line + an externally-monitored
// boot grep are enough to catch the regression.
try {
  const { buildReadout } = require('./services/empirical-spread-roi');
  const _now = new Date();
  const _ago = new Date(_now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const _fmt = (d) => d.toISOString().slice(0, 10);
  const _res = buildReadout(db, _fmt(_ago), _fmt(_now), false);
  // Tiny sanity — should always return a window envelope. If we got
  // here without throwing, the JS-level smoke passed even if the
  // window had zero rows.
  console.log('[boot-smoke] empirical-spread roi-readout: ok'
    + ' (morning bets=' + (_res && _res.morning && _res.morning.bets)
    + ', gametime bets=' + (_res && _res.gametime && _res.gametime.bets) + ')');
} catch (e) {
  console.error('[boot-smoke] empirical-spread roi-readout FAILED:',
    e && (e.stack || e.message));
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Version endpoint
app.get('/api/version', (req, res) => res.json({
  build: '2026-04-11T14:20:01.140Z',
  routes: ['weather','scores','lineups','odds','signals']
}));

// API routes
app.use('/api', require('./routes/api'));

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// JSON error handler for anything under /api that escaped a route's try/catch
// (malformed JSON bodies, unhandled promise rejections bubbling up, etc).
// Express's default handler returns an HTML stack trace — clients expect JSON.
app.use('/api', (err, req, res, next) => {
  console.error('[api-error]', req.method, req.path, '-', err && err.stack || err);
  if (res.headersSent) return next(err);
  res.status(err && err.status || 500).json({
    error: err && err.message || 'Internal server error',
  });
});

// JSON 404 for unmatched /api paths — prevents falling through to the SPA
// fallback, which would return text/html and break any client doing r.json().
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// SPA fallback — serve index.html with no-cache headers
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  startCronJobs();
  // One-shot roster refresh on startup. Bridges the gap when the server
  // starts up after the 6AM PT cron window — without this, rosters would
  // sit at last-cron-state until the following morning. Failure here must
  // not block the listen() callback returning, so the call is fire-and-forget.
  runRosterJob().catch(e => console.warn('[startup-roster] failed:', e && e.message));

  // One-shot pitcher_game_log backfill (PR A). Self-gating via the
  // 'pitcher_usage_backfill_done' app_settings flag — runs at most once
  // per database. Fires after the roster pull so it doesn't compete for
  // statsapi attention during the boot critical path. Fire-and-forget;
  // a partial run will simply resume on the next start (the flag only
  // flips when every date in the 60-day window completed cleanly).
  runPitcherUsageBackfill().catch(e =>
    console.warn('[startup-pitcher-usage-backfill] failed:', e && e.message));

  // One-shot tomorrow-slate prefetch on startup. Bridges the gap when the
  // server starts up after the 8PM/11PM PT prefetch crons — without this,
  // tomorrow's odds/weather/lineups would be missing until the next cron
  // window. Delayed 30s so the startup roster pull and other boot work
  // can settle before three sequential network calls fire.
  setTimeout(async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    console.log('[startup-prefetch] tomorrow-slate ' + dateStr);
    try {
      const oddsR    = await runOddsJob(dateStr);
      const weatherR = await runWeatherJob(dateStr);
      const lineupR  = await runLineupJob(dateStr);
      console.log('[startup-prefetch] ' + dateStr
        + ': odds updated ' + ((oddsR && oddsR.updated) || 0)
        + ', weather updated ' + ((weatherR && weatherR.updated) || 0)
        + ', lineups ' + ((lineupR && lineupR.gamesUpdated) || 0));
    } catch (e) {
      console.warn('[startup-prefetch] failed:', e && e.message);
    }
  }, 30000);
});
