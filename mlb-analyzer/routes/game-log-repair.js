'use strict';

// POST /api/admin/game-log-repair -- repair game_log against MLB's statsapi
// (#486, 2026-10-02). Admin only (X-Admin-Token, utils/admin-auth.js).
//
// Body (JSON): { mode: 'diff' | 'apply' | 'grade', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD',
//                categories?: [...] }       -- at most 31 dates per call.
//   diff  (default) every difference by category; writes nothing.
//   apply           writes ONLY the requested categories (all when omitted).
//   grade           bet_signals grading for finished games on those dates, via
//                   services/jobs.js gradeBetSignalsForGame and nothing else.
// The categories, what each writes, and the guarantees (no prices, locks,
// model outputs, signals, captures or bets written; no model / odds / weather /
// lineup / signal code called): services/game-log-repair.js.
//
// Runs through the app's serial job queue (services/jobs.js _queued, exported
// as withMemLog), so it never overlaps another job. The request waits for its
// turn asynchronously; the work is per date (one statsapi request, one short
// write transaction), so web requests are never blocked behind it.
//
// ITS OWN ROUTER, NOT routes/api.js. Mounted in server.js before routes/api.js.

const express = require('express');
const { requireAdminToken } = require('../utils/admin-auth');
const repair = require('../services/game-log-repair');

const router = express.Router();
let _deps = null;                                    // tests inject { db, queued, grade, fetchJson, fetchFirstPitch }

async function fetchJsonDefault(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return await r.json();
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 500 * attempt)); }
  }
  throw last;
}
// Each dependency can be injected (tests); the rest load lazily. Only the queue
// and the grading function are ever taken from services/jobs.js.
function deps() {
  const o = _deps || {};
  const jobs = (!o.queued || !o.grade) ? require('../services/jobs') : null;
  return {
    db: o.db || require('../db/schema').db,
    queued: o.queued || jobs.withMemLog,
    grade: o.grade || jobs.gradeBetSignalsForGame,
    fetchJson: o.fetchJson || fetchJsonDefault,
    fetchFirstPitch: o.fetchFirstPitch || ((pk) => require('../services/first-pitch').fetchFirstPitch(pk)),
  };
}

router.post('/admin/game-log-repair', requireAdminToken, express.json({ limit: '64kb' }), async (req, res) => {
  const p = repair.parseRequest(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const d = deps();
  try {
    const out = await d.queued('game-log repair ' + p.mode + ' ' + p.from + '..' + p.to, () => repair.run(req.body, d));
    if (out && out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'game-log repair failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

// For tests: inject dependencies (or null to restore the defaults).
router._setDeps = (x) => { _deps = x; };

module.exports = router;
