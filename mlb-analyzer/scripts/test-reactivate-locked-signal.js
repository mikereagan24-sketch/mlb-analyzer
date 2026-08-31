#!/usr/bin/env node
/**
 * Reactivating a locked bet must not re-price it. (2026-08-30)
 *
 * WHY THIS TEST IS THE POINT OF THE CHANGE. Locked rows are guarded because
 * a re-priced locked bet corrupts CLV and grading -- market_line and
 * bet_line anchor to the price at lock time and must never move. This
 * change moves is_active and notes OUT from behind that guard, so the
 * guarantee now rests on the SET list of one statement rather than on a
 * WHERE clause covering everything.
 *
 * So the assertion is not "market_line looks right". It is: EVERY column
 * except the three we intend to change is byte-identical across a
 * reactivation. Written that way, a future edit that adds a priced column
 * to reactivateLockedSignal fails here immediately -- which is the failure
 * mode worth catching, and the one a hand-picked list of columns would miss.
 */
const path = require('path');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const { q, db } = require(path.join(R, 'db/schema'));

const D = '2026-06-04';          // no real rows on this date for our team
const G = 'zzr-zzs';
const EXPECTED_TO_CHANGE = new Set(['is_active', 'notes', 'updated_at']);

// A game_log row to satisfy the FK.
const glId = (() => {
  const existing = db.prepare('SELECT id FROM game_log WHERE game_date=? AND game_id=?').get(D, G);
  if (existing) return existing.id;
  db.prepare('INSERT INTO game_log (game_date, game_id, away_team, home_team) VALUES (?,?,?,?)')
    .run(D, G, 'ZZR', 'ZZS');
  return db.prepare('SELECT id FROM game_log WHERE game_date=? AND game_id=?').get(D, G).id;
})();

const snap = (type, side) =>
  db.prepare('SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?')
    .get(D, G, type, side);

try {
  // ---- a LOCKED bet, with every price-bearing column populated ---------
  db.prepare(`INSERT INTO bet_signals
    (game_log_id, game_date, game_id, signal_type, signal_side, category,
     market_line, model_line, edge_pct, outcome, pnl, cohort,
     bet_line, bet_locked_at, closing_line, clv, is_active, notes,
     price_venue, venue_stale, edge_suspect, lineup_hash, model_line_source,
     model_total_at_emit, model_home_ml_at_emit, model_away_ml_at_emit,
     created_at, updated_at)
    VALUES (?,?,?,'ML','away','dog',
     133, -109, 0.0829, 'pending', 0, 'v7',
     133, '2026-06-04 15:22:10', 128, 1.75, 0, 'stale note from when it went dark',
     'poly', 0, 0, 'abc123', 'std',
     8.4, -110, -109,
     '2026-06-04 14:00:00', '2026-06-04 18:29:47')`).run(glId, D, G);

  const before = snap('ML', 'away');
  ok(before != null, 'fixture row created');
  eq(before.is_active, 0, 'fixture starts INACTIVE');
  ok(before.bet_locked_at != null, 'fixture is LOCKED');

  // ---- reactivate -----------------------------------------------------
  const res = q.reactivateLockedSignal.run(D, G, 'ML', 'away');
  eq(res.changes, 1, 'reactivateLockedSignal updated exactly one row');
  const after = snap('ML', 'away');

  // ---- the three intended changes -------------------------------------
  eq(after.is_active, 1, 'is_active flipped 0 -> 1');
  eq(after.notes, null, 'the stale note was cleared');
  ok(after.updated_at !== before.updated_at, 'updated_at moved');

  // ---- EVERYTHING ELSE IS BYTE-IDENTICAL ------------------------------
  // Compared column-by-column across the whole row, so a future edit that
  // adds a priced column to the SET list fails here rather than in
  // production CLV.
  const cols = Object.keys(before);
  ok(cols.length > 20, 'comparing a full row (' + cols.length + ' columns)');
  const moved = [];
  for (const c of cols) {
    if (EXPECTED_TO_CHANGE.has(c)) continue;
    if (before[c] !== after[c]) moved.push(c + ': ' + JSON.stringify(before[c]) + ' -> ' + JSON.stringify(after[c]));
  }
  ok(moved.length === 0,
     'every other column is byte-identical'
     + (moved.length ? ' -- MOVED: ' + moved.join(' | ') : ''));

  // Named explicitly too, so the failure message says which guarantee broke.
  eq(after.market_line, 133, 'market_line frozen at the locked price');
  eq(after.bet_line, 133, 'bet_line frozen');
  eq(after.bet_locked_at, before.bet_locked_at, 'bet_locked_at frozen');
  eq(after.edge_pct, 0.0829, 'edge_pct frozen at lock-time edge, NOT re-derived');
  eq(after.model_line, -109, 'model_line frozen');
  eq(after.closing_line, 128, 'closing_line untouched');
  eq(after.clv, 1.75, 'clv untouched');
  eq(after.price_venue, 'poly', 'price_venue untouched');
  eq(after.created_at, before.created_at, 'created_at still pinned to first emission');
  eq(after.model_away_ml_at_emit, -109, 'emit-time model snapshot frozen');

  // ---- scope: it must not touch rows it does not own -------------------
  // An UNLOCKED inactive row is upsertSignal's business, not this one.
  db.prepare(`INSERT INTO bet_signals
    (game_log_id, game_date, game_id, signal_type, signal_side, category,
     market_line, model_line, edge_pct, outcome, pnl, is_active, bet_line, bet_locked_at)
    VALUES (?,?,?,'ML','home','fav', -150, -160, 0.02, 'pending', 0, 0, NULL, NULL)`)
    .run(glId, D, G);
  const unlockedBefore = snap('ML', 'home');
  const r2 = q.reactivateLockedSignal.run(D, G, 'ML', 'home');
  eq(r2.changes, 0, 'an UNLOCKED inactive row is NOT reactivated by this statement');
  eq(snap('ML', 'home').is_active, 0, 'and it stays inactive');
  ok(unlockedBefore.market_line === snap('ML', 'home').market_line, 'unlocked row untouched');

  // An already-active locked row is a no-op, so repeated passes do not
  // churn updated_at or spam the audit log.
  const r3 = q.reactivateLockedSignal.run(D, G, 'ML', 'away');
  eq(r3.changes, 0, 'reactivating an already-active row is a no-op');

  // ---- the negative control: prove the comparison would BITE ----------
  // Simulate the mistake this guards against -- a statement that also
  // re-prices -- and confirm the byte-identical check catches it.
  db.prepare('UPDATE bet_signals SET market_line = 999 WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?')
    .run(D, G, 'ML', 'away');
  const tampered = snap('ML', 'away');
  const wouldCatch = Object.keys(before).some(c =>
    !EXPECTED_TO_CHANGE.has(c) && before[c] !== tampered[c]);
  ok(wouldCatch, 'the byte-identical comparison DOES detect a re-priced column');
} finally {
  db.prepare('DELETE FROM bet_signals WHERE game_date=? AND game_id=?').run(D, G);
  db.prepare('DELETE FROM game_log WHERE game_date=? AND game_id=?').run(D, G);
}

// ---- the statement itself names no priced column -----------------------
// Structural backstop: read the SQL and assert the SET list is exactly the
// three columns. Catches a bad edit even if someone also edits the fixture.
const fs = require('fs');
const schemaSrc = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
const m = schemaSrc.match(/reactivateLockedSignal:\s*db\.prepare\(`([\s\S]*?)`\)/);
ok(!!m, 'located the reactivateLockedSignal SQL');
if (m) {
  const sql = m[1];
  const setBody = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
  for (const banned of ['market_line', 'model_line', 'edge_pct', 'bet_line',
                        'bet_locked_at', 'closing_line', 'clv', 'price_venue',
                        'created_at', 'at_emit']) {
    ok(!setBody.includes(banned),
       'the SET list does not mention ' + banned);
  }
  ok(sql.includes('bet_locked_at IS NOT NULL'), 'scoped to LOCKED rows only');
  ok(sql.includes('is_active = 0'), 'scoped to INACTIVE rows only');
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
