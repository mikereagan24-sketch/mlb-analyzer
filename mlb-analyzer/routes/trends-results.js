'use strict';

// GET /api/trends/results -- the pre-registered trends backtest, as recorded.
// (2026-09-29) DISPLAY ONLY.
//
// Serves the committed artifact docs/trends-results-2026-09-29.json and
// nothing else: no database, no computation, no settings. The run is fixed --
// recorded under the pre-registration (#478) and exported by
// scripts/export-trends-results.js -- so the tab shows exactly the numbers in
// the decision record, not a re-run that could drift.
//
// ITS OWN ROUTER, NOT routes/api.js, on purpose. services/jobs.js lazily
// requires routes/api.js (for ingestWobaCSV), which puts routes/api.js inside
// the pricing path's require graph. A trends route there would place the
// trends artifact in that graph; here it stays out of it, and
// scripts/test-trends-results-tab.js asserts that structurally.

const fs = require('fs');
const path = require('path');
const express = require('express');

const ARTIFACT = path.join(__dirname, '..', 'docs', 'trends-results-2026-09-29.json');
const router = express.Router();

// Read once, cache in memory. A failure is cached too (as an error) so a
// missing or corrupt file is reported on every request without re-reading.
let _cache = null;
function load() {
  if (_cache) return _cache;
  try {
    _cache = { ok: true, body: JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) };
  } catch (e) {
    _cache = { ok: false, body: {
      error: 'trends results unavailable',
      detail: (e && e.code === 'ENOENT' ? 'artifact not found: ' : 'artifact unreadable: ')
        + path.basename(ARTIFACT) + (e && e.message ? ' (' + e.message + ')' : ''),
    } };
  }
  return _cache;
}

router.get('/trends/results', (req, res) => {
  const c = load();
  if (!c.ok) return res.status(503).json(c.body);
  res.json(c.body);
});

module.exports = router;
