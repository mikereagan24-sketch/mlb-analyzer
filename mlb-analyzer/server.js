// @deployed 2026-04-17T16:23:52.313Z
'use strict';
// BUILD_TS: 2026-04-11T17:15:25.624Z
const express = require('express');
const cors = require('cors');
const path = require('path');
const { startCronJobs, runRosterJob, runOddsJob, runWeatherJob, runLineupJob, runPitcherUsageBackfill } = require('./services/jobs');

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
