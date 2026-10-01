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
//
// GET /api/trends/slate[?date=YYYY-MM-DD] (2026-09-30) -- which of a date's
// games fit each scenario (services/trends-slate.js), for the tab's "Fits the
// slate" column. Display only, for interest only. Default date: today in PT.
// Reads game_log through its OWN read-only connection, opened lazily, with
// bounded queries; cached per date for SLATE_TTL_MS so a page view does not
// recompute (a computation measured 49 ms mean / 100 ms max per date). It
// imports nothing from the pricing path; /trends/results above is unchanged
// and still reads only the artifact.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { slateFits } = require('../services/trends-slate');

const ARTIFACT = path.join(__dirname, '..', 'docs', 'trends-results-2026-09-29.json');
// GET /api/trends/top-traders (2026-10-01): the pre-registered Polymarket
// top-traders backtest (#489 / #490), as recorded. Same rule as the trends
// artifact: committed files and nothing else -- no database, no computation.
// Two artifacts, returned labelled: the corrected run (prereg §9, repeat
// trades restored -- #496 / #498), which the tab shows, and the original run,
// shown as superseded. Either one missing or unreadable -> the error JSON.
const TOP_TRADERS_ARTIFACT = path.join(__dirname, '..', 'docs', 'polymarket-top-traders-results-2026-09-30.json');
const TOP_TRADERS_CORRECTED_ARTIFACT = path.join(__dirname, '..', 'docs', 'polymarket-top-traders-results-2026-09-30-corrected.json');
const router = express.Router();

// Read once, cache in memory. A failure is cached too (as an error) so a
// missing or corrupt file is reported on every request without re-reading.
function cachedArtifact(file, label) {
  let cache = null;
  return function () {
    if (cache) return cache;
    try {
      cache = { ok: true, body: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      cache = { ok: false, body: {
        error: label + ' unavailable',
        detail: (e && e.code === 'ENOENT' ? 'artifact not found: ' : 'artifact unreadable: ')
          + path.basename(file) + (e && e.message ? ' (' + e.message + ')' : ''),
      } };
    }
    return cache;
  };
}
const load = cachedArtifact(ARTIFACT, 'trends results');
const loadTopTraders = cachedArtifact(TOP_TRADERS_ARTIFACT, 'top-traders original results');
const loadTopTradersCorrected = cachedArtifact(TOP_TRADERS_CORRECTED_ARTIFACT, 'top-traders corrected results');

router.get('/trends/results', (req, res) => {
  const c = load();
  if (!c.ok) return res.status(503).json(c.body);
  res.json(c.body);
});

router.get('/trends/top-traders', (req, res) => {
  const c = loadTopTradersCorrected(), o = loadTopTraders();
  if (!c.ok) return res.status(503).json(c.body);
  if (!o.ok) return res.status(503).json(o.body);
  res.json({ corrected: c.body, original: o.body });
});

// ---- slate fits
const SLATE_TTL_MS = 10 * 60 * 1000;       // prices move pre-lock; refresh at most every 10 minutes
const SLATE_CACHE_MAX = 14;                // dates kept
const _slateCache = new Map();             // date -> { at, body }
let _readDb = null;
function readDb() {
  // Own READ-ONLY handle on the app database. db/schema is already loaded by
  // server.js; only its path is used here, never its read-write handle.
  if (!_readDb) {
    const Database = require('better-sqlite3');
    _readDb = new Database(require('../db/schema').DB_PATH, { readonly: true, fileMustExist: true });
  }
  return _readDb;
}
const ptToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

router.get('/trends/slate', (req, res) => {
  const date = req.query && req.query.date ? String(req.query.date) : ptToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const hit = _slateCache.get(date);
  if (hit && Date.now() - hit.at < SLATE_TTL_MS) return res.json(Object.assign({}, hit.body, { cached: true }));
  try {
    const t0 = process.hrtime.bigint();
    const body = Object.assign(slateFits(readDb(), date), {
      generated_at: new Date().toISOString(),
      compute_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
      note: 'Fits are for interest only. No trend passed the test.',
    });
    _slateCache.set(date, { at: Date.now(), body });
    while (_slateCache.size > SLATE_CACHE_MAX) _slateCache.delete(_slateCache.keys().next().value);
    res.json(Object.assign({}, body, { cached: false }));
  } catch (e) {
    res.status(503).json({ error: 'slate fits unavailable', detail: e && e.message ? e.message : String(e) });
  }
});

// For tests: release the read-only handle (Windows cannot delete an open file) and drop the cache.
router._closeSlateDb = () => { if (_readDb) { _readDb.close(); _readDb = null; } _slateCache.clear(); };

module.exports = router;
