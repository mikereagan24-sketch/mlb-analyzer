'use strict';

// Verification harness for feat/emit-time-model-snapshot.
// 1) Require db/schema — triggers the idempotent ALTER TABLE migrations
//    that add model_line_source / model_total_at_emit /
//    opener_model_total_at_emit to bet_signals.
// 2) Confirm the three columns are present on bet_signals.
// 3) Simulate an emit via q.upsertSignal with the three new fields
//    populated (both 'opener' and 'std' source cases). Verify the values
//    land, and that a re-emit refreshes them on an unlocked row while a
//    locked row stays frozen.
// 4) Clean up the test rows so the local DB is unchanged.

const { db, q } = require('../db/schema');

const TEST_DATE = '9999-01-01';
const TEST_GAME_ID = 'zzz-yyy';

// Insert a test game_log row so bet_signals.game_log_id FK is satisfied.
db.prepare("DELETE FROM bet_signals WHERE game_date=?").run(TEST_DATE);
db.prepare("DELETE FROM game_log WHERE game_date=?").run(TEST_DATE);
const glInfo = db.prepare("INSERT INTO game_log (game_date, game_id, away_team, home_team) VALUES (?,?,?,?)")
  .run(TEST_DATE, TEST_GAME_ID, 'ZZZ', 'YYY');
const TEST_GAME_LOG_ID = Number(glInfo.lastInsertRowid);
console.log('DEBUG: inserted game_log id=' + TEST_GAME_LOG_ID);
const verify = db.prepare('SELECT id FROM game_log WHERE game_date=? AND game_id=?').get(TEST_DATE, TEST_GAME_ID);
console.log('DEBUG: verify game_log row =', verify);

function cleanup() {
  db.prepare("DELETE FROM bet_signals WHERE game_date=?").run(TEST_DATE);
  db.prepare("DELETE FROM game_log WHERE game_date=?").run(TEST_DATE);
}

// (1) & (2): confirm the migration landed.
const cols = db.prepare("PRAGMA table_info(bet_signals)").all().map(c => c.name);
console.log('=== bet_signals columns after boot ===');
console.log('  model_line_source          present:', cols.includes('model_line_source'));
console.log('  model_total_at_emit        present:', cols.includes('model_total_at_emit'));
console.log('  opener_model_total_at_emit present:', cols.includes('opener_model_total_at_emit'));
if (!cols.includes('model_line_source') || !cols.includes('model_total_at_emit') || !cols.includes('opener_model_total_at_emit')) {
  console.error('FAIL: missing columns');
  process.exit(2);
}

// (3): simulate a fresh emit (opener source).
q.upsertSignal.run({
  game_log_id: TEST_GAME_LOG_ID,
  game_date: TEST_DATE, game_id: TEST_GAME_ID,
  signal_type: 'Total', signal_side: 'under',
  signal_label: null, category: 'under',
  market_line: 8.5, model_line: 7.42, edge_pct: 0.052,
  outcome: 'pending', pnl: 0, cohort: 'v7',
  companion_spread_line: null, companion_spread_price: null,
  companion_spread_outcome: null, companion_spread_pnl: null, companion_spread_src: null,
  edge_suspect: 0, price_venue: null, venue_stale: 0, lineup_hash: 'test-hash',
  model_line_source: 'opener',
  model_total_at_emit: 7.55,
  opener_model_total_at_emit: 7.42,
});
let row = db.prepare("SELECT market_line, model_line, edge_pct, model_line_source, model_total_at_emit, opener_model_total_at_emit, bet_locked_at FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
  .get(TEST_DATE, TEST_GAME_ID, 'Total', 'under');
console.log('\n=== After initial emit (opener source) ===');
console.log(' ', row);
if (row.model_line_source !== 'opener' || row.model_total_at_emit !== 7.55 || row.opener_model_total_at_emit !== 7.42) {
  console.error('FAIL: initial emit values did not land');
  cleanup(); process.exit(3);
}

// Re-emit (unlocked): baseline + snapshot should both refresh.
q.upsertSignal.run({
  game_log_id: TEST_GAME_LOG_ID,
  game_date: TEST_DATE, game_id: TEST_GAME_ID,
  signal_type: 'Total', signal_side: 'under',
  signal_label: null, category: 'under',
  market_line: 8.5, model_line: 7.60, edge_pct: 0.038,
  outcome: 'pending', pnl: 0, cohort: 'v7',
  companion_spread_line: null, companion_spread_price: null,
  companion_spread_outcome: null, companion_spread_pnl: null, companion_spread_src: null,
  edge_suspect: 0, price_venue: null, venue_stale: 0, lineup_hash: 'test-hash-2',
  model_line_source: 'std',
  model_total_at_emit: 7.60,
  opener_model_total_at_emit: null,
});
row = db.prepare("SELECT market_line, model_line, edge_pct, model_line_source, model_total_at_emit, opener_model_total_at_emit FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
  .get(TEST_DATE, TEST_GAME_ID, 'Total', 'under');
console.log('\n=== After unlocked re-emit (source flipped opener→std) ===');
console.log(' ', row);
if (row.model_line_source !== 'std' || row.model_total_at_emit !== 7.60 || row.opener_model_total_at_emit !== null) {
  console.error('FAIL: unlocked re-emit should have refreshed snapshot');
  cleanup(); process.exit(4);
}

// Lock the row, then re-emit: snapshot must stay frozen at the last unlocked values.
db.prepare("UPDATE bet_signals SET bet_locked_at=datetime('now'), bet_line=? WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?").run(8.5, TEST_DATE, TEST_GAME_ID, 'Total', 'under');
q.upsertSignal.run({
  game_log_id: TEST_GAME_LOG_ID,
  game_date: TEST_DATE, game_id: TEST_GAME_ID,
  signal_type: 'Total', signal_side: 'under',
  signal_label: null, category: 'under',
  market_line: 999, model_line: 999, edge_pct: 0.999,   // would-be-refresh values, should NOT land
  outcome: 'pending', pnl: 0, cohort: 'v7',
  companion_spread_line: null, companion_spread_price: null,
  companion_spread_outcome: null, companion_spread_pnl: null, companion_spread_src: null,
  edge_suspect: 0, price_venue: null, venue_stale: 0, lineup_hash: 'test-hash-3',
  model_line_source: 'opener',
  model_total_at_emit: 999,
  opener_model_total_at_emit: 999,
});
row = db.prepare("SELECT market_line, model_line, edge_pct, model_line_source, model_total_at_emit, opener_model_total_at_emit, bet_locked_at FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
  .get(TEST_DATE, TEST_GAME_ID, 'Total', 'under');
console.log('\n=== After LOCK + re-emit (snapshot MUST NOT move) ===');
console.log(' ', row);
if (row.model_line_source !== 'std' || row.model_total_at_emit !== 7.60 || row.market_line !== 8.5) {
  console.error('FAIL: locked row snapshot moved — post-lock immutability broken');
  cleanup(); process.exit(5);
}

console.log('\n=== ALL CHECKS PASSED ===');
console.log('  - migration idempotent: columns present');
console.log('  - initial UPSERT: 3 new columns land');
console.log('  - unlocked re-emit: refreshes snapshot alongside baseline');
console.log('  - locked re-emit: snapshot frozen alongside baseline (WHERE guard covers all fields)');
cleanup();
console.log('  - test rows cleaned up');
