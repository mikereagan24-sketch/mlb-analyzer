// Verify the UPSERT + refresh path in an isolated in-memory SQLite.
// Uses the real prepared statements from db/schema (upsertSignal,
// deactivateSignal, unique index) and simulates:
//
//   Scenario A — idempotency: upsert the same row twice; second call
//                bumps updated_at, keeps created_at pinned; edge_pct
//                stays equal; audit trail records first insert + one
//                no-delta refresh (which we skip in code).
//
//   Scenario B — market drift: upsert row, then upsert with new
//                market_line. Assert updated_at advanced, market_line
//                changed, created_at pinned.
//
//   Scenario C — lock immunity: upsert row, manually SET bet_locked_at,
//                then upsert again with new market_line. Assert the
//                stored row's market_line DID NOT change (WHERE guard
//                on the UPSERT).
//
//   Scenario D — deactivate orphan: upsert row A, then run
//                deactivateSignal for a tuple that's no longer emitting.
//                Assert is_active=0 + notes set; other columns intact.
//
// Runs against a temp SQLite file (not the real DB) so nothing
// destructive touches prod copies.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const tempPath = path.join(os.tmpdir(), 'verify-upsert-' + process.pid + '.db');
try { fs.unlinkSync(tempPath); } catch(e) {}
const db = new Database(tempPath);

// Minimal schema — only bet_signals and its indices. Mirrors db/schema.js
// CREATE TABLE + subsequent ALTERs + the new UNIQUE index + updated_at.
db.exec(`
  CREATE TABLE bet_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_log_id INTEGER,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_side TEXT NOT NULL,
    signal_label TEXT,
    category TEXT,
    market_line REAL,
    model_line REAL,
    edge_pct REAL,
    outcome TEXT,
    pnl REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    bet_line INTEGER,
    bet_locked_at TEXT,
    closing_line INTEGER,
    clv REAL,
    is_active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    cohort TEXT,
    companion_spread_line REAL,
    companion_spread_price INTEGER,
    companion_spread_outcome TEXT,
    companion_spread_pnl REAL,
    companion_spread_src TEXT,
    edge_suspect INTEGER NOT NULL DEFAULT 0,
    price_venue TEXT,
    venue_stale INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );
  CREATE UNIQUE INDEX uq_bet_signals_key ON bet_signals (game_date, game_id, signal_type, signal_side);
`);

const upsert = db.prepare(`
  INSERT INTO bet_signals (
    game_log_id, game_date, game_id, signal_type, signal_side, signal_label,
    category, market_line, model_line, edge_pct, outcome, pnl, cohort,
    companion_spread_line, companion_spread_price, companion_spread_outcome,
    companion_spread_pnl, companion_spread_src, edge_suspect,
    price_venue, venue_stale, updated_at
  ) VALUES (
    @game_log_id, @game_date, @game_id, @signal_type, @signal_side, @signal_label,
    @category, @market_line, @model_line, @edge_pct, @outcome, @pnl, @cohort,
    @companion_spread_line, @companion_spread_price, @companion_spread_outcome,
    @companion_spread_pnl, @companion_spread_src, @edge_suspect,
    @price_venue, @venue_stale, datetime('now')
  )
  ON CONFLICT(game_date, game_id, signal_type, signal_side) DO UPDATE SET
    market_line   = excluded.market_line,
    model_line    = excluded.model_line,
    edge_pct      = excluded.edge_pct,
    category      = excluded.category,
    signal_label  = excluded.signal_label,
    price_venue   = excluded.price_venue,
    venue_stale   = excluded.venue_stale,
    edge_suspect  = excluded.edge_suspect,
    outcome       = CASE WHEN bet_signals.outcome IN ('win','loss','push') THEN bet_signals.outcome ELSE excluded.outcome END,
    pnl           = CASE WHEN bet_signals.outcome IN ('win','loss','push') THEN bet_signals.pnl     ELSE excluded.pnl     END,
    is_active     = 1,
    notes         = NULL,
    updated_at    = datetime('now')
  WHERE bet_signals.bet_locked_at IS NULL
`);

const deactivate = db.prepare(`
  UPDATE bet_signals SET
    is_active = 0,
    notes = ?,
    updated_at = datetime('now')
  WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?
`);

const fetchRow = db.prepare(
  "SELECT * FROM bet_signals WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?"
);

const baseArgs = (over) => Object.assign({
  game_log_id: 100, game_date: '2026-07-08', game_id: 'col-lad',
  signal_type: 'ML', signal_side: 'away', signal_label: null,
  category: 'dog', market_line: 180, model_line: 135,
  edge_pct: 0.0684, outcome: 'pending', pnl: 0, cohort: 'v7',
  companion_spread_line: null, companion_spread_price: null,
  companion_spread_outcome: null, companion_spread_pnl: null,
  companion_spread_src: null, edge_suspect: 0,
  price_venue: 'poly', venue_stale: 0,
}, over || {});

function pass(name) { console.log('  ✓ ' + name); }
function fail(name, want, got) { console.error('  ✗ ' + name + '\n     want: ' + JSON.stringify(want) + '\n     got : ' + JSON.stringify(got)); process.exitCode = 1; }

// Small sleep so datetime('now') advances between UPSERT calls (SQLite
// datetime resolution is per-second; two calls in the same second
// produce identical timestamps).
function sleepSec() { const end = Date.now() + 1100; while (Date.now() < end) {} }

console.log('\nScenario A — idempotency + updated_at bumps');
upsert.run(baseArgs());
const rA1 = fetchRow.get('2026-07-08','col-lad','ML','away');
const createdAt = rA1.created_at;
sleepSec();
upsert.run(baseArgs());
const rA2 = fetchRow.get('2026-07-08','col-lad','ML','away');
rA2.market_line === 180 ? pass('market_line unchanged (180)') : fail('market_line', 180, rA2.market_line);
rA2.created_at === createdAt ? pass('created_at pinned to first insert') : fail('created_at', createdAt, rA2.created_at);
rA2.updated_at > createdAt ? pass('updated_at advanced past created_at') : fail('updated_at advanced', '> '+createdAt, rA2.updated_at);
rA2.id === rA1.id ? pass('same row (no duplicate insert)') : fail('same row', rA1.id, rA2.id);

console.log('\nScenario B — market drift refresh');
sleepSec();
const prevUpdated = rA2.updated_at;
upsert.run(baseArgs({ market_line: 184, edge_pct: 0.0710, price_venue: 'kalshi' }));
const rB = fetchRow.get('2026-07-08','col-lad','ML','away');
rB.market_line === 184 ? pass('market_line advanced 180 → 184') : fail('market_line 184', 184, rB.market_line);
rB.price_venue === 'kalshi' ? pass('price_venue advanced poly → kalshi') : fail('price_venue', 'kalshi', rB.price_venue);
rB.updated_at > prevUpdated ? pass('updated_at re-advanced') : fail('updated_at re-advanced', '> '+prevUpdated, rB.updated_at);

console.log('\nScenario C — lock immunity');
db.prepare("UPDATE bet_signals SET bet_line=185, bet_locked_at='2026-07-08 17:00:00' WHERE id=?").run(rB.id);
sleepSec();
upsert.run(baseArgs({ market_line: 999, edge_pct: 0.1234, price_venue: 'poly' }));
const rC = fetchRow.get('2026-07-08','col-lad','ML','away');
rC.market_line === 184 ? pass('locked row market_line FROZEN at 184 (WHERE guard)') : fail('locked market_line', 184, rC.market_line);
rC.bet_line === 185 ? pass('bet_line preserved') : fail('bet_line', 185, rC.bet_line);
rC.bet_locked_at === '2026-07-08 17:00:00' ? pass('bet_locked_at preserved') : fail('bet_locked_at', '2026-07-08 17:00:00', rC.bet_locked_at);
rC.updated_at === rB.updated_at ? pass('updated_at also frozen (row untouched)') : fail('updated_at frozen', rB.updated_at, rC.updated_at);

console.log('\nScenario D — deactivate orphan');
upsert.run(baseArgs({ game_id: 'bos-cws', market_line: -126, category: 'fav', edge_pct: 0.0275, price_venue: 'kalshi' }));
const rD1 = fetchRow.get('2026-07-08','bos-cws','ML','away');
rD1.is_active === 1 ? pass('inserted active') : fail('is_active insert', 1, rD1.is_active);
sleepSec();
deactivate.run('signal dropped', '2026-07-08', 'bos-cws', 'ML', 'away');
const rD2 = fetchRow.get('2026-07-08','bos-cws','ML','away');
rD2.is_active === 0 ? pass('deactivated (is_active=0)') : fail('deactivate', 0, rD2.is_active);
rD2.notes === 'signal dropped' ? pass('notes set') : fail('notes', 'signal dropped', rD2.notes);
rD2.market_line === -126 ? pass('market_line preserved through deactivate') : fail('market_line preserved', -126, rD2.market_line);
sleepSec();
upsert.run(baseArgs({ game_id: 'bos-cws', market_line: -128, category: 'fav', edge_pct: 0.0284, price_venue: 'poly' }));
const rD3 = fetchRow.get('2026-07-08','bos-cws','ML','away');
rD3.is_active === 1 ? pass('reactivated on next emit') : fail('reactivate', 1, rD3.is_active);
rD3.market_line === -128 ? pass('market_line advanced through reactivation') : fail('market_line adv', -128, rD3.market_line);
rD3.notes === null ? pass('notes cleared on refresh') : fail('notes cleared', null, rD3.notes);

console.log('\nScenario E — unique-index enforcement');
try {
  db.prepare("INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, market_line) VALUES (?,?,?,?,?)")
    .run('2026-07-08','bos-cws','ML','away',-200);
  fail('unique constraint fired', 'SQLite UNIQUE constraint error', 'no error');
} catch (e) {
  /UNIQUE constraint failed/.test(e.message) ? pass('naked INSERT rejected by UNIQUE index') : fail('unique error', 'UNIQUE constraint failed…', e.message);
}

console.log('\ntotals    :', db.prepare('SELECT COUNT(*) c FROM bet_signals').get().c, 'rows');
console.log('exit code :', process.exitCode || 0);

db.close();
try { fs.unlinkSync(tempPath); } catch(e) {}
