'use strict';

// POST /api/admin/totals-line-repair -- move the price out of bet_line on 37
// early-season logged Totals (2026-10-04). Admin only (X-Admin-Token,
// utils/admin-auth.js).
//
// Body (JSON): { mode: 'diff' | 'apply' }
//   diff  (default) per id: current, expected and target values, and whether
//                   apply would write or skip. Writes nothing.
//   apply           compare-and-set on exactly the listed ids and columns; one
//                   bet_signal_audit row per changed bet. Never grades.
// The list, the columns and the guarantees: services/totals-line-repair.js.
//
// Runs through the app's serial job queue (services/jobs.js _queued, exported
// as withMemLog), so it never overlaps another job.
//
// ITS OWN ROUTER, NOT routes/api.js. Mounted in server.js before routes/api.js
// (and its POST /upload/:key? catch-all).

const express = require('express');
const { requireAdminToken } = require('../utils/admin-auth');
const repair = require('../services/totals-line-repair');

const router = express.Router();
let _deps = null;                                    // tests inject { db, queued }

// The queue is the only thing taken from services/jobs.js.
function deps() {
  const o = _deps || {};
  return {
    db: o.db || require('../db/schema').db,
    queued: o.queued || require('../services/jobs').withMemLog,
  };
}

router.post('/admin/totals-line-repair', requireAdminToken, express.json({ limit: '16kb' }), async (req, res) => {
  const p = repair.parseRequest(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const d = deps();
  try {
    const out = await d.queued('totals-line repair ' + p.mode, async () => repair.run(req.body, d));
    if (out && out.error) return res.status(400).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'totals-line repair failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

// For tests: inject dependencies (or null to restore the defaults).
router._setDeps = (x) => { _deps = x; };

module.exports = router;
