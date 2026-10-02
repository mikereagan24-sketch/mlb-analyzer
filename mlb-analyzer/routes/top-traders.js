'use strict';

// GET /api/top-traders/:date -- the top-traders card's data (PR B, 2026-10-01).
// docs/polymarket-top-traders-card-decisions-2026-10-01.md. DISPLAY ONLY.
//
// Stored rows only: the latest lean per game from top_trader_lean_log (the
// final row when there is one, else the latest provisional row), written by
// services/top-traders-live.js. No network call, no computation beyond
// formatting, and an empty list when nothing is stored.
//
// NO ROUTE EVER RETURNS A WALLET ADDRESS: this router never reads a wallets
// table or the stored fills, only the lean log's aggregates.
//
// ITS OWN ROUTER, NOT routes/api.js (decision 10): routes/api.js sits in the
// pricing path's require graph. Mounted in server.js before routes/api.js.
// It requires express, the pure shared rules (for the label and the 75% flag)
// and, lazily, db/schema (for the app's handle).

const express = require('express');
const { CARD_LABEL: LABEL, POSTSEASON_NOTE, CONCENTRATION_FLAG } = require('../utils/top-traders/rules');
const router = express.Router();

let _db = null;
const appDb = () => (_db || (_db = require('../db/schema').db));

router.get('/top-traders/:date', (req, res) => {
  const date = String(req.params.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  let rows;
  try {
    rows = appDb().prepare(`SELECT game_id, kind, shown_at, cut_utc, lean_team, lean_dollars, other_dollars, wallets_with_money,
        top_wallet_share, qualified_count, snapshot_as_of, phase, skip_reason, away_ml_shown, home_ml_shown, price_source
      FROM top_trader_lean_log WHERE game_date = ? ORDER BY game_id, (kind = 'final') DESC, id DESC`).all(date);
  } catch (e) {
    return res.status(503).json({ error: 'top-traders data unavailable', detail: e && e.message ? e.message : String(e) });
  }
  const games = [];
  for (const r of rows) {
    if (games.length && games[games.length - 1].game_id === r.game_id) continue;     // first row per game = the latest lean
    const postseason = r.phase === 'postseason';
    games.push({
      game_id: r.game_id, kind: r.kind, shown_at: r.shown_at, cut_utc: r.cut_utc,
      lean_team: r.lean_team, lean_dollars: r.lean_dollars, other_dollars: r.other_dollars,
      wallets_with_money: r.wallets_with_money, largest_wallet_share: r.top_wallet_share,
      concentration_flag: r.top_wallet_share != null && r.top_wallet_share >= CONCENTRATION_FLAG,
      qualified_count: r.qualified_count, snapshot_as_of: r.snapshot_as_of, postseason,
      skip_reason: r.skip_reason,
      prices: { away_ml: r.away_ml_shown, home_ml: r.home_ml_shown, source: r.price_source },
      label: LABEL, note: postseason ? POSTSEASON_NOTE : null,
    });
  }
  res.json({ date, label: LABEL, games });
});

// For tests: release the cached handle, or hand it a throwaway database.
router._resetDb = () => { _db = null; };
router._setDb = (db) => { _db = db; };

module.exports = router;
module.exports.LABEL = LABEL;
