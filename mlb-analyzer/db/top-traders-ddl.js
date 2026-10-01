'use strict';

// Production tables for the Polymarket top-traders card
// (docs/polymarket-top-traders-card-decisions-2026-10-01.md, decisions 3 and 8).
// DISPLAY ONLY -- nothing in the pricing path reads these tables.
//
// The DDL lives here so db/schema.js and the tests build the tables from one
// string. Idempotent: CREATE ... IF NOT EXISTS only, safe to run on every boot.
//
// WALLET ADDRESSES (top_trader_wallets.addr) ARE STORED, NEVER SERVED. They
// exist only so settlement can attribute trades to a wallet. No route may
// SELECT or return them -- cards and logs carry aggregates only.
// scripts/test-top-traders-card-a.js (check d) enforces this across routes/
// and server.js.
//
//   top_trader_wallets    one row per wallet: running totals over settled
//                         regular-season games dated strictly BEFORE as_of
//                         (pre-registration §3; §2's excluded dates never count).
//                         wallet_id is the backfill's wallets.id, kept so the
//                         §3 top-25 tie-break (wallet id ascending) is the same.
//   top_trader_qualified  the qualified set as of a date (decision 3's daily
//                         snapshot): the wallets that pass §3 on history
//                         strictly before as_of.
//   top_trader_lean_log   one row per displayed lean snapshot, plus one final
//                         row per game with the locked price (decision 8), for
//                         a 2027 pre-registered test. Empty until the card ships.
//   top_trader_seed_stage_wallets / top_trader_seed_stage_qualified
//                         the seed upload's staging area: a file is streamed in
//                         here, and only a file with no rejected row replaces
//                         the two tables above, in one transaction. Empty
//                         between uploads.

const TOP_TRADERS_DDL = `
CREATE TABLE IF NOT EXISTS top_trader_wallets (
  wallet_id   INTEGER PRIMARY KEY,
  addr        TEXT NOT NULL UNIQUE,
  games       INTEGER NOT NULL CHECK (games >= 0),
  profit      REAL NOT NULL,
  volume      REAL NOT NULL CHECK (volume >= 0),
  both_teams  INTEGER NOT NULL CHECK (both_teams >= 0 AND both_teams <= games),
  as_of       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS top_trader_qualified (
  as_of       TEXT NOT NULL,
  wallet_id   INTEGER NOT NULL,
  PRIMARY KEY (as_of, wallet_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS top_trader_lean_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date           TEXT NOT NULL,
  game_id             TEXT NOT NULL,
  shown_at            TEXT NOT NULL,
  cut_utc             INTEGER NOT NULL,
  lean_team           TEXT NOT NULL,
  lean_dollars        REAL NOT NULL,
  other_dollars       REAL NOT NULL,
  wallets_with_money  INTEGER NOT NULL,
  top_wallet_share    REAL,
  qualified_count     INTEGER NOT NULL,
  away_ml_shown       INTEGER,
  home_ml_shown       INTEGER,
  price_source        TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('provisional', 'final')),
  phase               TEXT NOT NULL CHECK (phase IN ('regular', 'postseason')),
  locked_away_ml      INTEGER,
  locked_home_ml      INTEGER,
  CHECK (kind = 'final' OR (locked_away_ml IS NULL AND locked_home_ml IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_top_trader_lean_log_game ON top_trader_lean_log (game_date, game_id);
CREATE TABLE IF NOT EXISTS top_trader_seed_stage_wallets (
  wallet_id   INTEGER PRIMARY KEY,
  addr        TEXT NOT NULL UNIQUE,
  games       INTEGER NOT NULL,
  profit      REAL NOT NULL,
  volume      REAL NOT NULL,
  both_teams  INTEGER NOT NULL,
  as_of       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS top_trader_seed_stage_qualified (
  wallet_id   INTEGER PRIMARY KEY,
  line        INTEGER NOT NULL
);
`;

function applyTopTradersDdl(db) {
  db.exec(TOP_TRADERS_DDL);
}

// The seed CSV's header: written by scripts/export-top-trader-seed.js, required
// by POST /api/upload/top-trader-seed (routes/top-traders-upload.js).
const SEED_HEADER = 'type,wallet_id,addr,games,profit,volume,both_teams,as_of';

module.exports = { TOP_TRADERS_DDL, applyTopTradersDdl, SEED_HEADER };
