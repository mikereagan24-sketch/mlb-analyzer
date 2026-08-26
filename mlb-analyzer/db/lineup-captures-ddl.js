/**
 * DDL for lineup_captures, in one place. (2026-08-26)
 *
 * Extracted so db/schema.js and scripts/test-lineup-capture.js build the
 * table from the SAME string. A test that creates its own approximation of
 * a table proves the code works against the approximation -- which is how
 * a column-type or NOT NULL difference survives a green test suite.
 */
const LINEUP_CAPTURES_DDL = [
  'CREATE TABLE IF NOT EXISTS lineup_captures (' +
  '  game_date TEXT NOT NULL,' +
  '  game_id TEXT NOT NULL,' +
  '  source TEXT NOT NULL,' +            // 'rotowire'
  '  horizon TEXT NOT NULL,' +           // 'same_day' | 'next_day'
  '  capture_time TEXT NOT NULL,' +      // UTC ISO, when the fetch returned
  '  side TEXT NOT NULL,' +              // 'away' | 'home'
  '  lineup_json TEXT,' +                // [{name, hand}, ...] batting order
  '  lineup_status TEXT,' +              // 'confirmed' | 'projected' (RotoWire)
  '  sp_name TEXT,' +
  '  sp_hand TEXT,' +
  '  hand_source TEXT,' +                // 'source' | 'roster' -- specced flag
  '  n_slots INTEGER,' +
  '  page_has_started INTEGER,' +        // RotoWire marked the game in progress
  // lead_minutes is measured against the best anchor AVAILABLE AT CAPTURE
  // TIME, and lead_anchor records which one it was.
  //
  // This is not a detail. first_pitch_utc DOES NOT EXIST until the game
  // begins -- statsapi returns it as null for a scheduled game (verified
  // 2026-08-26 on gamePk 822694: scheduled_start_utc 2026-08-27T17:05:00Z,
  // first_pitch_utc null). Every capture is by definition pre-game, so a
  // lead computed only from first pitch would be NULL on exactly the rows
  // the analysis is about, and no backfill would ever fix it: the value
  // did not exist at the moment being described.
  //
  // So scheduled_start_utc is the capture-time anchor, first_pitch_utc is
  // filled in afterwards by runScoreJob, and the comparison script
  // recomputes an exact post-hoc lead from game_log when it wants one.
  // Both are kept: the scheduled lead is what a bettor could have known,
  // the actual lead is what happened, and rain delays separate them.
  '  lead_minutes INTEGER,' +            // anchor - capture_time, negative if after
  '  lead_anchor TEXT,' +                // 'first_pitch' | 'scheduled' | NULL
  '  scheduled_start_utc TEXT,' +        // known in advance; the capture-time anchor
  '  first_pitch_utc TEXT,' +            // NULL for any genuinely pre-game capture
  '  PRIMARY KEY (game_date, game_id, source, horizon, capture_time, side)' +
  ')',
  'CREATE INDEX IF NOT EXISTS idx_lineup_captures_game ON lineup_captures (game_date, game_id)',
  'CREATE INDEX IF NOT EXISTS idx_lineup_captures_horizon ON lineup_captures (horizon, game_date)',
];

// Columns added after the table first existed. CREATE TABLE IF NOT EXISTS
// is a no-op against an existing table, so a database created between the
// first version of this file and the anchor fix would silently keep the
// old shape and every insert would fail on the column count.
//
// Each is attempted individually and its "duplicate column" error is
// swallowed -- the same idempotent-ALTER pattern db/schema.js uses
// throughout. Applied by applyLineupCapturesDdl, which is the only
// supported way to build this table.
const LINEUP_CAPTURES_ALTERS = [
  'ALTER TABLE lineup_captures ADD COLUMN lead_anchor TEXT',
  'ALTER TABLE lineup_captures ADD COLUMN scheduled_start_utc TEXT',
];

function applyLineupCapturesDdl(db) {
  for (const ddl of LINEUP_CAPTURES_DDL) db.exec(ddl);
  for (const alter of LINEUP_CAPTURES_ALTERS) {
    try { db.exec(alter); } catch (e) { /* already present */ }
  }
}

module.exports = { LINEUP_CAPTURES_DDL, LINEUP_CAPTURES_ALTERS, applyLineupCapturesDdl };
