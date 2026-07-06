// Dedupe idempotency + regression fixture.
// Reproduces the 2026-07-06 duplication scenario in a synthetic
// in-memory sqlite DB, applies the fixed dedupe logic, and asserts:
//   1. Duplicate cleanup migration leaves one row per (game, type, side).
//   2. Survivor is the EARLIEST-locked row (echo-stamps from later
//      reruns are removed).
//   3. Running the cleanup a second time is a no-op (idempotent).
//   4. Simulated processGameSignals rerun does NOT create duplicates
//      under the reverted dedupe DELETE.
//   5. A second simulated rerun stays at 1 row per (type, side)
//      (idempotency of the rerun path).
//
// Run: <node20>/node scripts/test-dedupe-idempotency.js
'use strict';

const Database = require('better-sqlite3');
const db = new Database(':memory:');

// Minimal schema mirroring bet_signals + bet_signal_audit for the
// migration + rerun paths we're testing.
db.exec(`
  CREATE TABLE bet_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_side TEXT NOT NULL,
    signal_label TEXT,
    market_line INTEGER,
    model_line INTEGER,
    edge_pct REAL,
    outcome TEXT,
    pnl REAL,
    cohort TEXT,
    bet_line INTEGER,
    bet_locked_at TEXT,
    closing_line INTEGER,
    clv REAL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE bet_signal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER,
    game_date TEXT,
    game_id TEXT,
    signal_type TEXT,
    signal_side TEXT,
    action TEXT,
    bet_line INTEGER,
    closing_line INTEGER,
    clv REAL,
    source TEXT,
    detail TEXT
  );
`);

let failed = 0;
function expect(name, cond, extra) {
  const marker = cond ? 'PASS' : 'FAIL';
  console.log('  ' + marker + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

// ─── Test 1: cleanup migration collapses duplicates, keeps original lock ───
console.log('\n=== Test 1: cleanup migration keeps earliest-locked survivor ===');
db.exec('DELETE FROM bet_signals');
// Simulate 07-06 nym-atl ML/away: 7 identical rows, all locked, echo-stamps
db.exec(`
  INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, bet_locked_at, is_active) VALUES
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- ORIGINAL lock (first)
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- echo from rerun 2
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- echo from rerun 3
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- echo from rerun 4
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- echo from rerun 5
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1),  -- echo from rerun 6
    ('2026-07-06','nym-atl','ML','away', 113, '2026-07-06 19:22:35', 1);  -- echo from rerun 7
  -- Also: a distinct non-duplicated signal that should be untouched
  INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, bet_locked_at, is_active) VALUES
    ('2026-07-06','nym-atl','Total','over', NULL, NULL, 1);
`);

// Apply the migration exactly as it appears in db/schema.js
function runCleanupMigration() {
  const dupGroups = db.prepare(
    "SELECT game_date, game_id, signal_type, signal_side, COUNT(*) AS n FROM bet_signals GROUP BY game_date, game_id, signal_type, signal_side HAVING COUNT(*) > 1"
  ).all();
  let deleted = 0;
  for (const g of dupGroups) {
    const rows = db.prepare(
      "SELECT id, bet_locked_at FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=? " +
      "ORDER BY (CASE WHEN bet_locked_at IS NULL THEN 1 ELSE 0 END), bet_locked_at ASC, id ASC"
    ).all(g.game_date, g.game_id, g.signal_type, g.signal_side);
    const keepId = rows[0].id;
    for (const r of rows.slice(1)) {
      db.prepare("INSERT INTO bet_signal_audit (signal_id, game_date, game_id, signal_type, signal_side, action, source, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(r.id, g.game_date, g.game_id, g.signal_type, g.signal_side, 'dedupe_cleanup', 'test_boot', 'kept_id=' + keepId);
      db.prepare("DELETE FROM bet_signals WHERE id=?").run(r.id);
      deleted++;
    }
  }
  return deleted;
}

const originalMinId = db.prepare("SELECT MIN(id) AS m FROM bet_signals WHERE game_id='nym-atl' AND signal_type='ML' AND signal_side='away'").get().m;
const deleted1 = runCleanupMigration();
expect('deleted 6 rows on first run', deleted1 === 6, 'got ' + deleted1);
const remaining = db.prepare("SELECT COUNT(*) AS n FROM bet_signals WHERE game_id='nym-atl'").get().n;
expect('nym-atl now has 2 rows (1 ML/away + 1 Total/over)', remaining === 2, 'got ' + remaining);
const survivor = db.prepare("SELECT id, bet_locked_at FROM bet_signals WHERE game_id='nym-atl' AND signal_type='ML' AND signal_side='away'").get();
expect('survivor is the original locked row (MIN(id))', survivor.id === originalMinId, 'got id=' + survivor.id + ', expected ' + originalMinId);
expect('survivor keeps bet_locked_at=19:22:35', survivor.bet_locked_at === '2026-07-06 19:22:35');
const auditCount = db.prepare("SELECT COUNT(*) AS n FROM bet_signal_audit WHERE action='dedupe_cleanup'").get().n;
expect('6 audit rows written', auditCount === 6, 'got ' + auditCount);

// ─── Test 2: cleanup is idempotent ─────────────────────────
console.log('\n=== Test 2: cleanup is idempotent ===');
const deleted2 = runCleanupMigration();
expect('second run deletes 0 rows', deleted2 === 0, 'got ' + deleted2);
const auditCountAfter = db.prepare("SELECT COUNT(*) AS n FROM bet_signal_audit WHERE action='dedupe_cleanup'").get().n;
expect('no additional audit rows on second run', auditCountAfter === 6, 'got ' + auditCountAfter);

// ─── Test 3: reverted dedupe DELETE (from services/jobs.js) is lock-safe ───
console.log('\n=== Test 3: reverted dedupe DELETE preserves the invariant on rerun ===');
db.exec('DELETE FROM bet_signals');
db.exec('DELETE FROM bet_signal_audit');
// Simulate: game already has a locked signal (owner locked earlier)
db.exec(`
  INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, bet_locked_at, is_active) VALUES
    ('2026-07-06','col-lad','ML','away', 240, '2026-07-06 19:23:54', 1);
`);
const preId = db.prepare("SELECT id FROM bet_signals WHERE game_id='col-lad'").get().id;

// Simulate a rerun's steps (mirrors services/jobs.js processGameSignals):
function simulateRerun(gameDate, gameId, newSignals) {
  // Step 1: capture lockedLines BEFORE any DELETE
  const lockedLines = db.prepare(
    "SELECT signal_type, signal_side, bet_line, bet_locked_at, closing_line, clv FROM bet_signals WHERE game_date=? AND game_id=? AND bet_line IS NOT NULL"
  ).all(gameDate, gameId);
  // Step 2: DELETE unlocked (line 834 in services/jobs.js)
  db.prepare("DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND (bet_line IS NULL OR bet_line=0)").run(gameDate, gameId);
  // Step 3: INSERT new signals (line 855+)
  for (const s of newSignals) {
    db.prepare("INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, is_active) VALUES (?, ?, ?, ?, NULL, 1)").run(gameDate, gameId, s.type, s.side);
  }
  // Step 4: DEDUPE (line 974) — REVERTED (no `AND bet_line IS NULL`)
  db.prepare(`DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND id NOT IN (
    SELECT MAX(id) FROM bet_signals WHERE game_date=? AND game_id=? GROUP BY signal_type, signal_side
  )`).run(gameDate, gameId, gameDate, gameId);
  // Step 5: restore locks (line 977+)
  const newSigKeys = new Set(newSignals.map(s => s.type + '|' + s.side));
  for (const locked of lockedLines) {
    if (!newSigKeys.has(locked.signal_type + '|' + locked.signal_side)) {
      // deactivate; skip for this test
      continue;
    }
    db.prepare(
      "UPDATE bet_signals SET bet_line=?, bet_locked_at=?, closing_line=?, clv=? WHERE game_date=? AND game_id=? AND UPPER(signal_type)=UPPER(?) AND UPPER(signal_side)=UPPER(?)"
    ).run(locked.bet_line, locked.bet_locked_at, locked.closing_line, locked.clv,
          gameDate, gameId, locked.signal_type, locked.signal_side);
  }
}

// Rerun 1: model produces ML/away as usual
simulateRerun('2026-07-06','col-lad', [{ type:'ML', side:'away' }]);
const rowsAfterRerun1 = db.prepare("SELECT * FROM bet_signals WHERE game_id='col-lad'").all();
expect('after rerun 1: exactly 1 row for col-lad', rowsAfterRerun1.length === 1, 'got ' + rowsAfterRerun1.length);
expect('the row is locked (bet_line=240)', rowsAfterRerun1[0].bet_line === 240);
expect('bet_locked_at preserved from original', rowsAfterRerun1[0].bet_locked_at === '2026-07-06 19:23:54');

// Rerun 2: same signals produced — verify no accumulation
simulateRerun('2026-07-06','col-lad', [{ type:'ML', side:'away' }]);
const rowsAfterRerun2 = db.prepare("SELECT * FROM bet_signals WHERE game_id='col-lad'").all();
expect('after rerun 2: still exactly 1 row (idempotent)', rowsAfterRerun2.length === 1, 'got ' + rowsAfterRerun2.length);
expect('still locked (bet_line=240)', rowsAfterRerun2[0].bet_line === 240);

// Rerun 3 & 4 (as user asked — double-rerun idempotency)
simulateRerun('2026-07-06','col-lad', [{ type:'ML', side:'away' }]);
simulateRerun('2026-07-06','col-lad', [{ type:'ML', side:'away' }]);
const rowsAfterMoreReruns = db.prepare("SELECT * FROM bet_signals WHERE game_id='col-lad'").all();
expect('after 4 reruns total: still exactly 1 row', rowsAfterMoreReruns.length === 1, 'got ' + rowsAfterMoreReruns.length);
expect('still locked (bet_line=240)', rowsAfterMoreReruns[0].bet_line === 240);

// ─── Test 4: signal that stops qualifying gets deactivated, not duplicated ───
console.log('\n=== Test 4: rerun where locked signal no longer qualifies ===');
db.exec('DELETE FROM bet_signals');
db.exec(`
  INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, bet_locked_at, is_active) VALUES
    ('2026-07-06','test-game','ML','home', -150, '2026-07-06 19:00:00', 1);
`);
// Simulate a rerun that produces NO signals (edge no longer meets floor)
function simulateRerunWithDeactivate(gameDate, gameId, newSignals) {
  const lockedLines = db.prepare(
    "SELECT signal_type, signal_side, bet_line, bet_locked_at, closing_line, clv FROM bet_signals WHERE game_date=? AND game_id=? AND bet_line IS NOT NULL"
  ).all(gameDate, gameId);
  db.prepare("DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND (bet_line IS NULL OR bet_line=0)").run(gameDate, gameId);
  for (const s of newSignals) {
    db.prepare("INSERT INTO bet_signals (game_date, game_id, signal_type, signal_side, bet_line, is_active) VALUES (?, ?, ?, ?, NULL, 1)").run(gameDate, gameId, s.type, s.side);
  }
  db.prepare(`DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND id NOT IN (
    SELECT MAX(id) FROM bet_signals WHERE game_date=? AND game_id=? GROUP BY signal_type, signal_side
  )`).run(gameDate, gameId, gameDate, gameId);
  const newSigKeys = new Set(newSignals.map(s => s.type + '|' + s.side));
  for (const locked of lockedLines) {
    if (!newSigKeys.has(locked.signal_type + '|' + locked.signal_side)) {
      // Deactivate the locked row (still present because DELETE at start only removed unlocked, then dedupe only removed non-max)
      db.prepare("UPDATE bet_signals SET is_active=0 WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
        .run(gameDate, gameId, locked.signal_type, locked.signal_side);
      continue;
    }
    db.prepare("UPDATE bet_signals SET bet_line=?, bet_locked_at=?, closing_line=?, clv=? WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
      .run(locked.bet_line, locked.bet_locked_at, locked.closing_line, locked.clv, gameDate, gameId, locked.signal_type, locked.signal_side);
  }
}
simulateRerunWithDeactivate('2026-07-06','test-game', []);  // no signals emitted
const afterDeact = db.prepare("SELECT * FROM bet_signals WHERE game_id='test-game'").all();
expect('deactivation preserves the locked row', afterDeact.length === 1, 'got ' + afterDeact.length);
expect('bet_line still set', afterDeact[0].bet_line === -150);
expect('is_active=0 (deactivated)', afterDeact[0].is_active === 0);

// Rerun again: still no signals produced, no duplicate accumulation
simulateRerunWithDeactivate('2026-07-06','test-game', []);
const afterDeact2 = db.prepare("SELECT * FROM bet_signals WHERE game_id='test-game'").all();
expect('after 2nd deactivate-rerun: still 1 row (idempotent)', afterDeact2.length === 1, 'got ' + afterDeact2.length);

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
