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
  '  lead_minutes INTEGER,' +            // first_pitch - capture_time; NULL if unknown
  '  first_pitch_utc TEXT,' +            // copied at capture so it stays reproducible
  '  PRIMARY KEY (game_date, game_id, source, horizon, capture_time, side)' +
  ')',
  'CREATE INDEX IF NOT EXISTS idx_lineup_captures_game ON lineup_captures (game_date, game_id)',
  'CREATE INDEX IF NOT EXISTS idx_lineup_captures_horizon ON lineup_captures (horizon, game_date)',
];

module.exports = { LINEUP_CAPTURES_DDL };
