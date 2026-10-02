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
//                         (2026-10-01, PR B) lean_team and the dollar columns
//                         are NULL when skip_reason says why there is no lean
//                         (a price-step skip on a final row, or no qualified
//                         money / a tie); snapshot_as_of records which
//                         qualified set was used. At most ONE final row per
//                         game (unique partial index), so re-running is a no-op.
//   top_trader_live_markets / top_trader_live_fills / top_trader_live_state
//                         the live job (services/top-traders-live.js): each
//                         game's Polymarket market, the QUALIFIED wallets'
//                         pre-game fills only (wallet id, never an address),
//                         kept only while the game is in progress -- deleted
//                         with the write of its final lean-log row (decision 3,
//                         amended) -- and how far its passes have fetched (last_end).
//   top_trader_seed_stage_wallets / top_trader_seed_stage_qualified
//                         the seed upload's staging area: a file is streamed in
//                         here, and only a file with no rejected row replaces
//                         the two tables above, in one transaction. Empty
//                         between uploads.

const LEAN_LOG_TABLE = `CREATE TABLE IF NOT EXISTS top_trader_lean_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date           TEXT NOT NULL,
  game_id             TEXT NOT NULL,
  shown_at            TEXT NOT NULL,
  cut_utc             INTEGER NOT NULL,
  lean_team           TEXT,
  lean_dollars        REAL,
  other_dollars       REAL,
  wallets_with_money  INTEGER,
  top_wallet_share    REAL,
  qualified_count     INTEGER NOT NULL,
  away_ml_shown       INTEGER,
  home_ml_shown       INTEGER,
  price_source        TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('provisional', 'final')),
  phase               TEXT NOT NULL CHECK (phase IN ('regular', 'postseason')),
  locked_away_ml      INTEGER,
  locked_home_ml      INTEGER,
  skip_reason         TEXT,
  snapshot_as_of      TEXT,
  CHECK (kind = 'final' OR (locked_away_ml IS NULL AND locked_home_ml IS NULL)),
  CHECK (lean_team IS NOT NULL OR skip_reason IS NOT NULL)
);`;
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
${LEAN_LOG_TABLE}
CREATE INDEX IF NOT EXISTS idx_top_trader_lean_log_game ON top_trader_lean_log (game_date, game_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_top_trader_lean_log_final ON top_trader_lean_log (game_date, game_id) WHERE kind = 'final';
CREATE TABLE IF NOT EXISTS top_trader_live_markets (
  game_date         TEXT NOT NULL,
  game_id           TEXT NOT NULL,
  condition_id      TEXT,
  slug              TEXT,
  outcome0_is_home  INTEGER,
  cutoff_utc        INTEGER,
  cutoff_source     TEXT,
  reason            TEXT,
  discovered_at     TEXT NOT NULL,
  PRIMARY KEY (game_date, game_id),
  CHECK (condition_id IS NOT NULL OR reason IS NOT NULL)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS top_trader_live_fills (
  game_date   TEXT NOT NULL,
  game_id     TEXT NOT NULL,
  wallet_id   INTEGER NOT NULL,
  outcome     INTEGER NOT NULL,
  side        INTEGER NOT NULL,
  price       REAL NOT NULL,
  size        REAL NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_top_trader_live_fills_game ON top_trader_live_fills (game_date, game_id, ts);
CREATE TABLE IF NOT EXISTS top_trader_live_state (
  game_date       TEXT NOT NULL,
  game_id         TEXT NOT NULL,
  snapshot_as_of  TEXT NOT NULL,
  last_end        INTEGER NOT NULL DEFAULT 0,
  passes          TEXT NOT NULL DEFAULT '',
  updated_at      TEXT,
  PRIMARY KEY (game_date, game_id)
) WITHOUT ROWID;
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

// PR B (2026-10-01): a lean log created by PR A has lean_team NOT NULL and no
// skip_reason / snapshot_as_of. SQLite cannot relax a NOT NULL in place, so it
// is REBUILT -- one path whether it is empty or holds rows: create the table
// under a temporary name with the current definition, copy every existing row
// (ids kept), drop the old table and rename the new one, all in ONE
// transaction together with the indexes. Only the lean log is touched;
// top_trader_wallets and top_trader_qualified never are.
function rebuildLeanLog(db) {
  const oldCols = db.prepare('PRAGMA table_info(top_trader_lean_log)').all().map(c => c.name);
  db.exec(LEAN_LOG_TABLE.replace('CREATE TABLE IF NOT EXISTS top_trader_lean_log (', 'CREATE TABLE top_trader_lean_log_rebuild ('));
  const newCols = new Set(db.prepare('PRAGMA table_info(top_trader_lean_log_rebuild)').all().map(c => c.name));
  const cols = oldCols.filter(c => newCols.has(c)).join(', ');
  db.exec('INSERT INTO top_trader_lean_log_rebuild (' + cols + ') SELECT ' + cols + ' FROM top_trader_lean_log ORDER BY id');
  db.exec('DROP TABLE top_trader_lean_log');
  db.exec('ALTER TABLE top_trader_lean_log_rebuild RENAME TO top_trader_lean_log');
}
function applyTopTradersDdl(db) {
  db.transaction(() => {
    const ll = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'top_trader_lean_log'").get();
    if (ll && !db.prepare('PRAGMA table_info(top_trader_lean_log)').all().some(c => c.name === 'skip_reason')) rebuildLeanLog(db);
    db.exec(TOP_TRADERS_DDL);
  })();
}

// The seed CSV's header: written by scripts/export-top-trader-seed.js, required
// by POST /api/upload/top-trader-seed (routes/top-traders-upload.js).
const SEED_HEADER = 'type,wallet_id,addr,games,profit,volume,both_teams,as_of';

module.exports = { TOP_TRADERS_DDL, LEAN_LOG_TABLE, applyTopTradersDdl, SEED_HEADER };
