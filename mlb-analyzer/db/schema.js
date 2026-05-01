const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { normName, fuzzyLookup } = require('../utils/names');

let DATA_DIR;
if (process.env.RENDER) {
  DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../data');
} else {
  DATA_DIR = path.join(__dirname, '../data');
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'mlb.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS woba_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_key TEXT NOT NULL,
    player_name TEXT NOT NULL,
    woba REAL NOT NULL,
    sample_size REAL DEFAULT 0,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(data_key, player_name)
  );
  CREATE INDEX IF NOT EXISTS idx_woba_key_name ON woba_data(data_key, player_name);
  CREATE TABLE IF NOT EXISTS upload_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS game_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    away_team TEXT NOT NULL,
    home_team TEXT NOT NULL,
    game_time TEXT,
    away_sp TEXT,
    away_sp_hand TEXT,
    home_sp TEXT,
    home_sp_hand TEXT,
    market_away_ml INTEGER,
    market_home_ml INTEGER,
    market_total REAL,
    park_factor REAL DEFAULT 1.0,
    proj_model_away_ml INTEGER,
  proj_market_away_ml INTEGER,
  proj_market_home_ml INTEGER,
  proj_market_total REAL,
  proj_model_home_ml INTEGER,
  proj_model_total REAL,
  model_away_ml INTEGER,
    model_home_ml INTEGER,
    model_total REAL,
    away_score INTEGER,
    home_score INTEGER,
    actual_total INTEGER,
    away_lineup_json TEXT,
    home_lineup_json TEXT,
    lineup_source TEXT DEFAULT 'auto',
    scores_source TEXT,
  odds_locked_at TEXT,
  over_price INTEGER,
  under_price INTEGER,
  odds_flagged INTEGER DEFAULT 0,
  odds_flag_reason TEXT,
  xcheck_away_ml INTEGER,
  xcheck_home_ml INTEGER,
  xcheck_total REAL,
  xcheck_over_price INTEGER,
  xcheck_under_price INTEGER,
  xcheck_total_source TEXT,
  total_source TEXT,
  ml_source TEXT,
  xcheck_ml_source TEXT,
  venue_id INTEGER,
  venue_name TEXT,
  -- Per-field-group freshness markers. Set inline at successful ingest.
  -- Read-time logic in /api/games/:date computes the actual displayable
  -- state from age + odds_locked_at (lock state short-circuits to 'locked').
  odds_quality TEXT,
  odds_quality_at TEXT,
  lineups_quality TEXT,
  lineups_quality_at TEXT,
  weather_quality TEXT,
  weather_quality_at TEXT,
  scores_quality TEXT,
  scores_quality_at TEXT,
  game_number INTEGER DEFAULT 1,
  game_pk INTEGER,
  -- First-projection snapshot. Captured once on the first non-empty
  -- projected lineup write, frozen across subsequent updates so
  -- proj_* keeps the original projection while away_lineup_json /
  -- home_lineup_json track the live (eventually confirmed) state.
  proj_away_lineup_json TEXT,
  proj_home_lineup_json TEXT,
  proj_away_sp TEXT,
  proj_home_sp TEXT,
  proj_lineup_captured_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(game_date, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_game_log_date ON game_log(game_date);
  CREATE TABLE IF NOT EXISTS bet_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_log_id INTEGER NOT NULL REFERENCES game_log(id),
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_side TEXT NOT NULL,
    signal_label TEXT NOT NULL,
    category TEXT NOT NULL,
    market_line INTEGER,
    model_line INTEGER,
    edge_pct REAL,
    outcome TEXT,
    pnl REAL DEFAULT 0,
  bet_line INTEGER,          -- the line you actually bet (manually entered)
  bet_locked_at TEXT,        -- when you locked your bet line
  closing_line INTEGER,      -- final pregame locked line (auto-set when odds lock)
  clv REAL,                  -- closing line value: how much better your line was
  is_active INTEGER NOT NULL DEFAULT 1, -- 1=show on Games tab, 0=locked bet no longer qualifies
  notes TEXT,                -- explanation when signal state changes (e.g. line moved)
  cohort TEXT DEFAULT 'v1',  -- model/parameter epoch the signal was produced under
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signals_date ON bet_signals(game_date);
  CREATE INDEX IF NOT EXISTS idx_signals_category ON bet_signals(category);
  CREATE TABLE IF NOT EXISTS bet_signal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER,
    game_date TEXT,
    game_id TEXT,
    signal_type TEXT,
    signal_side TEXT,
    action TEXT,
    bet_line REAL,
    closing_line REAL,
    clv REAL,
    source TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_date ON bet_signal_audit(game_date);
  CREATE INDEX IF NOT EXISTS idx_audit_game ON bet_signal_audit(game_date, game_id);
  CREATE INDEX IF NOT EXISTS idx_audit_signal ON bet_signal_audit(signal_id);
  CREATE TABLE IF NOT EXISTS cron_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    run_date TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    games_updated INTEGER DEFAULT 0,
    ran_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO app_settings VALUES ('run_mult', '48');
  INSERT OR IGNORE INTO app_settings VALUES ('hfa_boost', '0.02');
  INSERT OR IGNORE INTO app_settings VALUES ('fav_adj', '10');
  INSERT OR IGNORE INTO app_settings VALUES ('dog_adj', '5');
  INSERT OR IGNORE INTO app_settings VALUES ('w_pit', '0.5');
  INSERT OR IGNORE INTO app_settings VALUES ('w_bat', '0.5');
  INSERT OR IGNORE INTO app_settings VALUES ('w_proj', '0.65');
  INSERT OR IGNORE INTO app_settings VALUES ('w_act', '0.35');
  INSERT OR IGNORE INTO app_settings VALUES ('ml_value_edge', '40');
  INSERT OR IGNORE INTO app_settings VALUES ('ml_lean_edge', '20');
  INSERT OR IGNORE INTO app_settings VALUES ('tot_value_edge', '1.0');
INSERT OR IGNORE INTO app_settings VALUES ('ml_3star_edge', '60');
INSERT OR IGNORE INTO app_settings VALUES ('tot_3star_edge', '0.12');
  INSERT OR IGNORE INTO app_settings VALUES ('tot_lean_edge', '0.5');
INSERT OR IGNORE INTO app_settings VALUES ('sp_weight', '0.77');
INSERT OR IGNORE INTO app_settings VALUES ('relief_weight', '0.23');
INSERT OR IGNORE INTO app_settings VALUES ('sp_pit_weight', '0.80');
INSERT OR IGNORE INTO app_settings VALUES ('relief_pit_weight', '0.20');
  INSERT OR IGNORE INTO app_settings VALUES ('bp_strong_weight_r', '0.55');
  INSERT OR IGNORE INTO app_settings VALUES ('bp_weak_weight_r',   '0.45');
  INSERT OR IGNORE INTO app_settings VALUES ('bp_strong_weight_l', '0.35');
  INSERT OR IGNORE INTO app_settings VALUES ('bp_weak_weight_l',   '0.65');
  INSERT OR IGNORE INTO app_settings VALUES ('bullpen_avg', '0.318');
  INSERT OR IGNORE INTO app_settings VALUES ('woba_baseline', '0.230');
  INSERT OR IGNORE INTO app_settings VALUES ('pyth_exp', '1.83');
  INSERT OR IGNORE INTO app_settings VALUES ('wind_scale', '2.0');
  INSERT OR IGNORE INTO app_settings VALUES ('tot_slope', '0.08');
  INSERT OR IGNORE INTO app_settings VALUES ('min_pa', '60');
  INSERT OR IGNORE INTO app_settings VALUES ('min_bf', '100');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_start', '0.315');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_opp', '0.320');
  INSERT OR IGNORE INTO app_settings VALUES ('unknown_pitcher_woba', '0.335');
  INSERT OR IGNORE INTO app_settings VALUES ('pa_weights', '[4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7]');
  INSERT OR IGNORE INTO app_settings VALUES ('wp_clamp_lo', '0.25');
  INSERT OR IGNORE INTO app_settings VALUES ('wp_clamp_hi', '0.75');
  INSERT OR IGNORE INTO app_settings VALUES ('tot_prob_lo', '0.20');
  INSERT OR IGNORE INTO app_settings VALUES ('tot_prob_hi', '0.80');
  INSERT OR IGNORE INTO app_settings VALUES ('market_total_dflt', '8.5');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_r_vs_rhp', '0.305');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_r_vs_lhp', '0.325');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_l_vs_rhp', '0.330');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_l_vs_lhp', '0.290');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_s_vs_rhp', '0.322');
  INSERT OR IGNORE INTO app_settings VALUES ('bat_dflt_s_vs_lhp', '0.308');
  INSERT OR IGNORE INTO app_settings VALUES ('pit_dflt_r_vs_lhb', '0.320');
  INSERT OR IGNORE INTO app_settings VALUES ('pit_dflt_r_vs_rhb', '0.295');
  INSERT OR IGNORE INTO app_settings VALUES ('pit_dflt_l_vs_lhb', '0.285');
  INSERT OR IGNORE INTO app_settings VALUES ('pit_dflt_l_vs_rhb', '0.330');
INSERT OR IGNORE INTO app_settings VALUES ('odds_api_key', '');
  INSERT OR IGNORE INTO app_settings VALUES ('fangraphs_session_cookie', '');
  INSERT OR IGNORE INTO app_settings VALUES ('lineup_cron', '0 17 * * *');
  INSERT OR IGNORE INTO app_settings VALUES ('scores_cron', '0 7 * * *');
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_rosters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    player_name TEXT NOT NULL,
    mlb_id INTEGER,
    role TEXT NOT NULL,
    hand TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(team, player_name)
  );
  CREATE TABLE IF NOT EXISTS pitcher_game_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date TEXT NOT NULL,
    team TEXT NOT NULL,
    pitcher_name TEXT NOT NULL,
    pitcher_mlb_id INTEGER,
    pitches_thrown INTEGER DEFAULT 0,
    appeared INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pgl_date_team_pitcher ON pitcher_game_log(game_date, team, pitcher_name);
  CREATE INDEX IF NOT EXISTS idx_pgl_team_date ON pitcher_game_log(team, game_date);
  CREATE TABLE IF NOT EXISTS pit_proj_ip (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT NOT NULL,
    player_name_norm TEXT NOT NULL,
    team TEXT,
    ip_per_start REAL NOT NULL,
    season_ip REAL,
    season_gs INTEGER,
    is_override INTEGER DEFAULT 0,
    uploaded_at TEXT DEFAULT (datetime('now')),
    UNIQUE(player_name_norm)
  );
  CREATE INDEX IF NOT EXISTS idx_pit_proj_ip_team ON pit_proj_ip(team);

  -- FanGraphs RosterResource role classifier. Keyed by mlb_id so the
  -- signal survives team_rosters churn (clearRoster wipes per-team rows
  -- on every roster refresh; this side table preserves the last good FG
  -- pull per pitcher). role is 'SP' / 'RP' / 'CL'; the team_rosters role
  -- column is the resolved 'SP' or 'RP' (CL → RP) used by downstream
  -- bullpen/SP weight code. role_detail keeps FG's specific tag (SP1,
  -- CL, SU8, MID, LR, …) for debugging.
  CREATE TABLE IF NOT EXISTS pitcher_fg_role (
    mlb_id INTEGER PRIMARY KEY,
    player_name TEXT NOT NULL,
    team TEXT,
    role TEXT NOT NULL,
    role_detail TEXT,
    role_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'fangraphs'
  );
  CREATE INDEX IF NOT EXISTS idx_pitcher_fg_role_team ON pitcher_fg_role(team);

  -- Manual override — wins over both fg_role and the GS/G heuristic.
  -- Useful for fresh transactions FG hasn't indexed yet, or for the
  -- rare case where FG is flat-out wrong.
  CREATE TABLE IF NOT EXISTS pitcher_role_override (
    mlb_id INTEGER PRIMARY KEY,
    role TEXT NOT NULL,
    set_at TEXT NOT NULL DEFAULT (datetime('now')),
    reason TEXT
  );
`);


// Migrations for existing DBs

// One-time migration: bp_strong_weight / bp_weak_weight → 4 per-handedness keys.
// On pre-upgrade DBs both legacy keys exist; copy each value into both R and L
// slots (user's handedness split preference is unknown at this point), then
// drop the legacy rows. INSERT OR REPLACE so we overwrite the default seeds
// above. Fresh installs and re-runs are no-ops because the old keys are gone.
try {
  const _oldBpS = db.prepare("SELECT value FROM app_settings WHERE key='bp_strong_weight'").get();
  const _oldBpW = db.prepare("SELECT value FROM app_settings WHERE key='bp_weak_weight'").get();
  if (_oldBpS) {
    db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('bp_strong_weight_r', ?)").run(_oldBpS.value);
    db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('bp_strong_weight_l', ?)").run(_oldBpS.value);
  }
  if (_oldBpW) {
    db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('bp_weak_weight_r', ?)").run(_oldBpW.value);
    db.prepare("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('bp_weak_weight_l', ?)").run(_oldBpW.value);
  }
  db.prepare("DELETE FROM app_settings WHERE key IN ('bp_strong_weight','bp_weak_weight')").run();
} catch(e) { /* no-op on fresh installs */ }

// One-time cleanup: the dynamic SP/RP weight adjustment that keyed off
// starter projected IP was removed — the two settings that fed it are no
// longer consulted by runModel, so drop them to keep app_settings honest.
// Fresh installs never seeded them either; this is purely for DBs that
// were created while the old seeds were in place.
try {
  db.prepare("DELETE FROM app_settings WHERE key IN ('sp_ip_baseline','sp_ip_weight_per')").run();
} catch(e) { /* no-op */ }

try { db.exec("ALTER TABLE game_log ADD COLUMN odds_flagged INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN odds_flag_reason TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_away_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_total REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_over_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_under_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_total_source TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN total_source TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN ml_source TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_ml_source TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN venue_id INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN venue_name TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN xcheck_home_ml INTEGER"); } catch(e) {}
// Per-field-group quality columns. Stored value is set inline at ingest;
// /api/games/:date computes the displayable state from age + odds_locked_at.
try { db.exec("ALTER TABLE game_log ADD COLUMN odds_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN odds_quality_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN lineups_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN lineups_quality_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN weather_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN weather_quality_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN scores_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN scores_quality_at TEXT"); } catch(e) {}
// Doubleheader support. game_id alone collided across legs of a doubleheader
// (UNIQUE(game_date, game_id) silently kept only one row); game_id now
// includes a -g{N} suffix from gameNumber > 1, and game_number/game_pk
// give us a stable handle off statsapi for cross-source matching.
try { db.exec("ALTER TABLE game_log ADD COLUMN game_number INTEGER DEFAULT 1"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN game_pk INTEGER"); } catch(e) {}
// Projected-lineup snapshot columns. Capture-once via COALESCE in the
// updateLineup statement; preserved across subsequent (projected or
// confirmed) updates so we can later diff the original projection
// against the eventual confirmed state.
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_away_lineup_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_home_lineup_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_away_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_home_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_lineup_captured_at TEXT"); } catch(e) {}
// Soft-delete columns for the auto-prune path. fetchSchedule sets these
// when a previously-bootstrapped row's game_pk disappears from statsapi
// (cancellation, postponement to a different date, doubleheader
// consolidation, etc.). Hard delete is unsafe — the user may have a
// locked bet on the row whose audit trail we want to preserve.
//   is_removed       — 0 = active, 1 = soft-deleted (hidden from UI)
//   removed_at       — datetime('now') stamp when the prune fired
//   removed_reason   — string tag explaining why (see fetchSchedule for
//                      the values written today). Also written without
//                      flipping is_removed when locked bets block the
//                      delete: 'removed_from_schedule_but_has_locked_bets'.
try { db.exec("ALTER TABLE game_log ADD COLUMN is_removed INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN removed_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN removed_reason TEXT"); } catch(e) {}

// cron_log observability columns. Added so runWeatherJob (and any future
// job that wants the same structured trail) can record per-game skip
// counts + reasons + duration in addition to the legacy
// games_updated/message fields. Other jobs continue writing the legacy
// 5-arg form via q.logCron; weather uses q.logCronStructured below.
//   games_skipped     — count of games the job declined to update this run
//   games_skipped_ids — comma-joined game_ids for the skipped set
//   skip_reasons      — JSON object: { reason_tag: count, ... }
//   duration_ms       — wall-clock duration of the job in milliseconds
try { db.exec("ALTER TABLE cron_log ADD COLUMN games_skipped INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE cron_log ADD COLUMN games_skipped_ids TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE cron_log ADD COLUMN skip_reasons TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE cron_log ADD COLUMN duration_ms INTEGER"); } catch(e) {}
// Historical backfill: rows created before this migration default to G1.
try { db.exec("UPDATE game_log SET game_number = 1 WHERE game_number IS NULL"); } catch(e) {}
// Rename legacy consensus_* columns on pre-upgrade DBs. The book-vs-book
// check replaces the old "sharp consensus" terminology — the column holds
// the same data shape (one secondary source's raw price) but the field
// name was misleading. RENAME COLUMN preserves any values already saved;
// the try/catch no-ops on fresh installs (no legacy columns) and on re-
// runs (already renamed). If both the new and old columns somehow exist
// simultaneously (interrupted migration), we copy then drop.
try {
  const cols = db.prepare("PRAGMA table_info(game_log)").all().map(c => c.name);
  const hasLegacy = cols.includes('consensus_away_ml') || cols.includes('consensus_home_ml');
  const hasNew    = cols.includes('xcheck_away_ml')    && cols.includes('xcheck_home_ml');
  if (hasLegacy && !hasNew) {
    db.exec("ALTER TABLE game_log RENAME COLUMN consensus_away_ml TO xcheck_away_ml");
    db.exec("ALTER TABLE game_log RENAME COLUMN consensus_home_ml TO xcheck_home_ml");
  } else if (hasLegacy && hasNew) {
    db.exec("UPDATE game_log SET xcheck_away_ml=COALESCE(xcheck_away_ml,consensus_away_ml), xcheck_home_ml=COALESCE(xcheck_home_ml,consensus_home_ml)");
    db.exec("ALTER TABLE game_log DROP COLUMN consensus_away_ml");
    db.exec("ALTER TABLE game_log DROP COLUMN consensus_home_ml");
  }
} catch(e) { /* no-op on fresh installs */ }
try { db.exec("ALTER TABLE bet_signals ADD COLUMN cohort TEXT DEFAULT 'v1'"); } catch(e) {}
// One-time backfill: signals without a cohort value belong to v1 (pre-cohort era).
try { db.exec("UPDATE bet_signals SET cohort='v1' WHERE cohort IS NULL"); } catch(e) {}
// v2 signals were produced against wrong Unabated source IDs — re-label as
// tainted so they don't contaminate current numbers. Idempotent: once all
// v2 rows have been retagged, future runs update 0 rows. New signals are
// written as v3 (see services/jobs.js + routes/api.js).
try { db.exec("UPDATE bet_signals SET cohort='v2-tainted' WHERE cohort='v2'"); } catch(e) {}
// c7b2ffa source-ID bug period is concluded. The v3-tainted migration was a
// one-shot that has already run on the production database. Do NOT reintroduce
// — its "older than 2 minutes" predicate triggered on every deploy and
// re-tainted healthy v3 signals.
// One-shot unification: merge existing v3-tainted rows back into v3. The
// historical separation isn't worth the UI confusion. Idempotent: once all
// v3-tainted rows have been merged, future runs update 0 rows.
try { db.exec("UPDATE bet_signals SET cohort='v3' WHERE cohort='v3-tainted'"); } catch(e) {}
// User was tuning model inputs through 2026-04-23. v3 cohort is reserved
// for the stable post-tuning period starting 2026-04-24 — earlier v3 rows
// are reclassified as v3-pretuning so the default 'v3 (current)' Backtest
// filter shows only the clean evaluation set. Idempotent: once all v3 rows
// dated before the cutoff have been retagged, future runs update 0 rows
// (new signals get cohort='v3' with today's game_date, which is post-cutoff).
try { db.exec("UPDATE bet_signals SET cohort='v3-pretuning' WHERE cohort='v3' AND game_date < '2026-04-24'"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN wind_speed REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN wind_dir REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN wind_factor REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN temp_f REAL DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN temp_run_adj REAL DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN roof_status TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN roof_confidence TEXT DEFAULT 'estimated'"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN game_time TEXT"); } catch(e) {}try { db.exec("ALTER TABLE game_log ADD COLUMN odds_locked_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN over_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_away_ml INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_away_ml INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_home_ml INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_total REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_home_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_total REAL"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_away_ml INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_home_ml INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE game_log ADD COLUMN proj_market_total REAL"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN bet_line INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN bet_locked_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN closing_line INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN clv REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN under_price INTEGER"); } catch(e) {}

// One-shot CLV backfill: every CLV value written before
// fix/clv-formula-correct used the buggy American-cents formula. Some are
// double-wrong (cross-sign cases where lock and close had opposite signs),
// some have right magnitude / wrong sign. Easiest correct migration is to
// nullify all ML CLV values and recompute from existing bet_line/closing_line
// pairs using the new implied-probability math (see services/clv.js).
// Total signals stay clv=NULL — bet_line on a Total is a runs total, not a
// price, and implied-prob doesn't apply.
// Idempotent via the app_settings flag at the bottom; runs once on first
// boot after this migration lands, then skipped on subsequent boots.
try {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='clv_backfill_2026_04_26'").get();
  if (!flag) {
    const nulled = db.prepare("UPDATE bet_signals SET clv=NULL WHERE signal_type='ML'").run();
    const recompute = db.prepare(`UPDATE bet_signals SET clv = ROUND(
      ((CASE WHEN closing_line < 0 THEN ABS(closing_line)*1.0/(ABS(closing_line)+100)
                                   ELSE 100.0/(closing_line+100) END)
       -
       (CASE WHEN bet_line < 0     THEN ABS(bet_line)*1.0/(ABS(bet_line)+100)
                                   ELSE 100.0/(bet_line+100)     END)
      ) * 1000) / 10.0
      WHERE signal_type='ML' AND bet_line IS NOT NULL AND closing_line IS NOT NULL`).run();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('clv_backfill_2026_04_26', datetime('now'))").run();
    console.log('[migration] CLV backfill: nulled ' + nulled.changes + ' ML signals, recomputed ' + recompute.changes + ' from bet_line/closing_line pairs');
  }
} catch (e) {
  console.warn('[migration] CLV backfill failed (non-fatal): ' + e.message);
}

// One-shot phantom HOU@BAL Game 2 cleanup (2026-04-30). statsapi reported a
// real doubleheader Game 2 (gamePk 824850, makeup of postponed 4/29) but
// emitted a placeholder gameDate within 5 minutes of Game 1 (16:35Z vs
// 16:40Z) — bootstrap then materialized a row whose first-pitch column
// landed at 9:40 AM PT, well before any plausible MLB start time.
// Removes the phantom row + non-locked bet_signals + audit entries; the
// fetchSchedule sanity filters added in this branch keep it from
// re-bootstrapping. Idempotent via the app_settings flag. Skipped if the
// user has manually locked a bet on the row so manual state isn't lost.
try {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='phantom_hou_bal_g2_cleanup_2026_04_30'").get();
  if (!flag) {
    const PD = '2026-04-30', GID = 'hou-bal-g2';
    const locked = db.prepare(
      "SELECT 1 FROM bet_signals WHERE game_date=? AND game_id=? AND bet_line IS NOT NULL LIMIT 1"
    ).get(PD, GID);
    if (locked) {
      console.warn('[migration] phantom hou-bal-g2 cleanup SKIPPED: locked bet_line found — investigate manually');
    } else {
      const sigs   = db.prepare("DELETE FROM bet_signals      WHERE game_date=? AND game_id=? AND bet_line IS NULL").run(PD, GID);
      const audits = db.prepare("DELETE FROM bet_signal_audit WHERE game_date=? AND game_id=?").run(PD, GID);
      const games  = db.prepare("DELETE FROM game_log         WHERE game_date=? AND game_id=?").run(PD, GID);
      console.log('[migration] phantom hou-bal-g2 cleanup: removed ' + games.changes + ' game_log row, ' + sigs.changes + ' signal(s), ' + audits.changes + ' audit row(s)');
    }
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, datetime('now'))").run('phantom_hou_bal_g2_cleanup_2026_04_30');
  }
} catch (e) {
  console.warn('[migration] phantom hou-bal-g2 cleanup failed (non-fatal): ' + e.message);
}

const q = {
  upsertWoba: db.prepare(`
    INSERT INTO woba_data (data_key, player_name, woba, sample_size, uploaded_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(data_key, player_name) DO UPDATE SET
      woba = excluded.woba, sample_size = excluded.sample_size, uploaded_at = excluded.uploaded_at
  `),
  getWobaByKey: db.prepare(`SELECT player_name, woba, sample_size FROM woba_data WHERE data_key = ?`),
  clearWobaKey: db.prepare(`DELETE FROM woba_data WHERE data_key = ?`),
  wobaKeySummary: db.prepare(`SELECT data_key, COUNT(*) as row_count, MAX(uploaded_at) as uploaded_at FROM woba_data GROUP BY data_key`),
  logUpload: db.prepare(`INSERT INTO upload_log (data_key, filename, row_count) VALUES (?, ?, ?)`),
  upsertGame: db.prepare(`
    INSERT INTO game_log (
      game_date, game_id, away_team, home_team, game_time,
      away_sp, away_sp_hand, home_sp, home_sp_hand,
      market_away_ml, market_home_ml, market_total, park_factor,
      model_away_ml, model_home_ml, model_total, lineup_source,
      venue_id, venue_name, game_number, game_pk, updated_at
    ) VALUES (
      @game_date, @game_id, @away_team, @home_team, @game_time,
      @away_sp, @away_sp_hand, @home_sp, @home_sp_hand,
      @market_away_ml, @market_home_ml, @market_total, @park_factor,
      @model_away_ml, @model_home_ml, @model_total, @lineup_source,
      @venue_id, @venue_name, COALESCE(@game_number, 1), @game_pk, datetime('now')
    )
    ON CONFLICT(game_date, game_id) DO UPDATE SET
      -- COALESCE SP fields so a later upsert with null SP (e.g. RotoWire
      -- supplying lineup_json only) doesn't wipe statsapi-bootstrapped
      -- probable pitchers. Non-null values still overwrite — RotoWire's
      -- confirmed SP, when provided, supersedes the statsapi probable.
      away_sp = COALESCE(excluded.away_sp, game_log.away_sp),
      away_sp_hand = COALESCE(excluded.away_sp_hand, game_log.away_sp_hand),
      home_sp = COALESCE(excluded.home_sp, game_log.home_sp),
      home_sp_hand = COALESCE(excluded.home_sp_hand, game_log.home_sp_hand),
      game_time = COALESCE(excluded.game_time, game_log.game_time),
      market_away_ml = excluded.market_away_ml, market_home_ml = excluded.market_home_ml,
      market_total = excluded.market_total, park_factor = excluded.park_factor,
      model_away_ml = excluded.model_away_ml, model_home_ml = excluded.model_home_ml,
      model_total = excluded.model_total, lineup_source = excluded.lineup_source,
      -- COALESCE venue fields so a RotoWire-only upsert (which doesn't
      -- carry venue from statsapi) doesn't wipe a bootstrapped venue_id.
      venue_id = COALESCE(excluded.venue_id, game_log.venue_id),
      venue_name = COALESCE(excluded.venue_name, game_log.venue_name),
      -- COALESCE game_number/game_pk so a RotoWire-only upsert (no statsapi
      -- doubleheader markers) doesn't wipe the gameNumber/gamePk the
      -- statsapi bootstrap already wrote.
      game_number = COALESCE(excluded.game_number, game_log.game_number),
      game_pk = COALESCE(excluded.game_pk, game_log.game_pk),
      updated_at = datetime('now')
  `),
  updateScores: db.prepare(`
    UPDATE game_log SET
      away_score = @away_score, home_score = @home_score,
      actual_total = @away_score + @home_score,
      scores_source = @scores_source,
      scores_quality = 'fresh', scores_quality_at = datetime('now'),
      updated_at = datetime('now')
    WHERE game_date = @game_date AND game_id = @game_id
  `),
  // is_removed = 0 hides soft-deleted rows from every caller of this query
  // (the UI route, rerun, weather job, cron rerun). Forensic access goes
  // through GET /api/games/:date/removed instead. COALESCE guards against
  // pre-migration rows where the column may be NULL.
  getGamesByDate: db.prepare(`SELECT * FROM game_log
      WHERE game_date = ? AND COALESCE(is_removed, 0) = 0
      ORDER BY
        CASE
          WHEN game_time IS NULL THEN 9999
          WHEN game_time LIKE '%AM%' THEN
            (CAST(SUBSTR(game_time,1,INSTR(game_time,':')-1) AS INT)%12)*60 +
            CAST(TRIM(SUBSTR(game_time,INSTR(game_time,':')+1,2)) AS INT)
          ELSE
            ((CAST(SUBSTR(game_time,1,INSTR(game_time,':')-1) AS INT)%12)+12)*60 +
            CAST(TRIM(SUBSTR(game_time,INSTR(game_time,':')+1,2)) AS INT)
        END, game_id`),
  getGameById: db.prepare(`SELECT * FROM game_log WHERE game_date = ? AND game_id = ?`),
  getDates: db.prepare(`SELECT DISTINCT game_date FROM game_log ORDER BY game_date DESC LIMIT 60`),
  deleteSignalsForGame: db.prepare(`DELETE FROM bet_signals WHERE game_date = ? AND game_id = ?`),
  insertSignal: db.prepare(`
    INSERT INTO bet_signals (
      game_log_id, game_date, game_id, signal_type, signal_side, signal_label,
      category, market_line, model_line, edge_pct, outcome, pnl, cohort
    ) VALUES (
      @game_log_id, @game_date, @game_id, @signal_type, @signal_side, @signal_label,
      @category, @market_line, @model_line, @edge_pct, @outcome, @pnl, @cohort
    )
  `),
  getSignalsByDate: db.prepare(`SELECT * FROM bet_signals WHERE game_date = ? AND is_active = 1 ORDER BY game_id`),
  getSignalsForBacktest: db.prepare(`SELECT * FROM bet_signals WHERE game_date = ? ORDER BY game_id`),
  getSignalsByDateRange: db.prepare(`SELECT * FROM bet_signals WHERE game_date BETWEEN ? AND ? ORDER BY game_date, game_id`),
  getBacktestByDateRange: db.prepare(`SELECT * FROM bet_signals WHERE game_date BETWEEN ? AND ? ORDER BY game_date, game_id`),
  getBacktestByDateRange: db.prepare(`SELECT * FROM bet_signals WHERE game_date BETWEEN ? AND ? ORDER BY game_date, game_id`),
  // NOTE: the summary queries below hardcode a floor of 2026-04-09 — the
  // date the current model version was established. Signals from earlier
  // dates were generated by older model parameters and are excluded from
  // reported ROI/win% so historical noise can't mask current behavior.
  getSummaryByCategory: db.prepare(`
    SELECT category,
      COUNT(*) as plays,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome='push' THEN 1 ELSE 0 END) as pushes,
      SUM(CASE WHEN outcome='pending' THEN 1 ELSE 0 END) as pending,
      ROUND(SUM(CASE WHEN outcome!='pending' THEN pnl ELSE 0 END), 2) as total_pnl,
      ROUND(SUM(CASE WHEN outcome!='pending' THEN pnl ELSE 0 END)
        / NULLIF(SUM(CASE WHEN outcome NOT IN ('pending','push') THEN 1 ELSE 0 END) * 100.0, 0) * 100, 2) as roi
    FROM bet_signals WHERE game_date BETWEEN ? AND ? AND game_date >= '2026-04-09' AND outcome != 'pending'
    GROUP BY category ORDER BY category
  `),
  getOverallSummary: db.prepare(`
    SELECT COUNT(*) as plays,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome='push' THEN 1 ELSE 0 END) as pushes,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(CASE
        WHEN signal_type='ML' AND COALESCE(bet_line,market_line) > 0
          THEN ROUND(10000.0/COALESCE(bet_line,market_line),2)
        WHEN signal_type='ML'
          THEN ABS(COALESCE(bet_line,market_line))
        ELSE 110.0
      END), 2) as wagered,
      ROUND(SUM(pnl) / NULLIF(SUM(CASE
        WHEN signal_type='ML' AND COALESCE(bet_line,market_line) > 0
          THEN ROUND(10000.0/COALESCE(bet_line,market_line),2)
        WHEN signal_type='ML'
          THEN ABS(COALESCE(bet_line,market_line))
        ELSE 110.0
      END), 0) * 100, 2) as roi
    FROM bet_signals WHERE game_date BETWEEN ? AND ? AND game_date >= '2026-04-09' AND outcome NOT IN ('pending','push')
  `),
  logCron: db.prepare(`INSERT INTO cron_log (job_type, run_date, status, message, games_updated) VALUES (?, ?, ?, ?, ?)`),
  // Structured variant — populates the columns added in the cron_log
  // observability migration above. Use this when the job has more to say
  // than "n games updated, here's a string". runWeatherJob is the first
  // caller; future jobs can adopt the same form without forcing every
  // existing logCron call site to change.
  logCronStructured: db.prepare(
    "INSERT INTO cron_log (job_type, run_date, status, message, games_updated, games_skipped, games_skipped_ids, skip_reasons, duration_ms) " +
    "VALUES (@job_type, @run_date, @status, @message, @games_updated, @games_skipped, @games_skipped_ids, @skip_reasons, @duration_ms)"
  ),
  getRecentCronLogs: db.prepare(`SELECT * FROM cron_log ORDER BY ran_at DESC LIMIT 20`),
  getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`),
  updateWindData: null, // initialized lazily after migrations
  getAllSettings: db.prepare(`SELECT key, value FROM app_settings`),
};
q.upsertRoster = db.prepare(`INSERT INTO team_rosters (team,player_name,mlb_id,role,hand,updated_at)
  VALUES (?,?,?,?,?,datetime('now'))
  ON CONFLICT(team,player_name) DO UPDATE SET
    mlb_id=excluded.mlb_id, role=excluded.role, hand=excluded.hand, updated_at=excluded.updated_at`);
q.clearRoster  = db.prepare("DELETE FROM team_rosters WHERE team=?");
q.getRoster    = db.prepare("SELECT player_name,role,hand FROM team_rosters WHERE team=?");

// pitcher_fg_role + pitcher_role_override prepared statements.
q.upsertPitcherFgRole = db.prepare(
  "INSERT INTO pitcher_fg_role (mlb_id, player_name, team, role, role_detail, role_at, source) " +
  "VALUES (?, ?, ?, ?, ?, datetime('now'), 'fangraphs') " +
  "ON CONFLICT(mlb_id) DO UPDATE SET " +
  "  player_name=excluded.player_name, team=excluded.team, role=excluded.role, " +
  "  role_detail=excluded.role_detail, role_at=excluded.role_at, source=excluded.source"
);
q.getFgRoleByMlbId = db.prepare("SELECT * FROM pitcher_fg_role WHERE mlb_id=?");
q.getFgRolesByTeam = db.prepare("SELECT * FROM pitcher_fg_role WHERE team=?");
q.fgRoleFreshnessByTeam = db.prepare(
  "SELECT team, MAX(role_at) AS last_at, COUNT(*) AS n FROM pitcher_fg_role GROUP BY team"
);

q.setRoleOverride = db.prepare(
  "INSERT INTO pitcher_role_override (mlb_id, role, set_at, reason) " +
  "VALUES (?, ?, datetime('now'), ?) " +
  "ON CONFLICT(mlb_id) DO UPDATE SET " +
  "  role=excluded.role, set_at=excluded.set_at, reason=excluded.reason"
);
q.deleteRoleOverride = db.prepare("DELETE FROM pitcher_role_override WHERE mlb_id=?");
q.getRoleOverride    = db.prepare("SELECT * FROM pitcher_role_override WHERE mlb_id=?");
q.listRoleOverrides  = db.prepare("SELECT * FROM pitcher_role_override ORDER BY set_at DESC");

q.upsertPitcherGameLog = db.prepare(
  `INSERT OR REPLACE INTO pitcher_game_log
   (game_date, team, pitcher_name, pitcher_mlb_id, pitches_thrown, appeared, created_at)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
);

// Projected starter IP (from Steamer or manual override).
// Bulk uploads only update rows where is_override=0. Override writes are
// sticky and always win. Query by normalized player name.
q.upsertPitProjIPBulk = db.prepare(
  `INSERT INTO pit_proj_ip (player_name, player_name_norm, team, ip_per_start, season_ip, season_gs, is_override, uploaded_at)
   VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
   ON CONFLICT(player_name_norm) DO UPDATE SET
     player_name=excluded.player_name,
     team=excluded.team,
     ip_per_start=excluded.ip_per_start,
     season_ip=excluded.season_ip,
     season_gs=excluded.season_gs,
     uploaded_at=datetime('now')
   WHERE pit_proj_ip.is_override = 0`
);
q.upsertPitProjIPOverride = db.prepare(
  `INSERT INTO pit_proj_ip (player_name, player_name_norm, team, ip_per_start, is_override, uploaded_at)
   VALUES (?, ?, ?, ?, 1, datetime('now'))
   ON CONFLICT(player_name_norm) DO UPDATE SET
     player_name=excluded.player_name,
     team=excluded.team,
     ip_per_start=excluded.ip_per_start,
     is_override=1,
     uploaded_at=datetime('now')`
);
q.getAllPitProjIP = db.prepare(
  `SELECT player_name, player_name_norm, team, ip_per_start, season_ip, season_gs, is_override, uploaded_at
   FROM pit_proj_ip ORDER BY COALESCE(team,'zzz'), player_name`
);
q.getPitProjIPByNameNorm = db.prepare(
  `SELECT * FROM pit_proj_ip WHERE player_name_norm=?`
);

// Look up a pitcher's projected IP/start. Exact normalized match first,
// then last-name fallback (prefer is_override rows, then most recent).
// Returns a number or null.
q.getPitcherProjIP = (playerName) => {
  if (!playerName) return null;
  const norm = normName(playerName);
  if (!norm) return null;
  const exact = q.getPitProjIPByNameNorm.get(norm);
  if (exact) return exact.ip_per_start;
  const parts = norm.split(' ');
  const last = parts[parts.length - 1];
  if (!last || last.length < 3) return null;
  const row = db.prepare(
    "SELECT ip_per_start FROM pit_proj_ip " +
    "WHERE player_name_norm LIKE ? OR player_name_norm = ? " +
    "ORDER BY is_override DESC, uploaded_at DESC LIMIT 1"
  ).get('% ' + last, last);
  return row ? row.ip_per_start : null;
};
q.getPitcherLogForTeam = db.prepare(
  `SELECT game_date, pitcher_name, pitcher_mlb_id, pitches_thrown, appeared
   FROM pitcher_game_log
   WHERE team=? AND game_date >= ? AND game_date < ?
   ORDER BY game_date DESC`
);

// Returns an array of { pitcher_name, reasons[] } for pitchers who should
// be excluded from a team's bullpen pool on gameDate based on recent usage.
// Rules: pitched both yesterday AND the day before (2-consecutive),
// pitched 3 of last 4 days (3in4), threw >29 pitches yesterday (pitch-count).
q.getFatiguedPitchers = (teamAbbr, gameDate) => {
  if (!gameDate) return [];
  const teamU = (teamAbbr||'').toUpperCase();
  const base = new Date(gameDate + 'T00:00:00Z');
  const addDays = (n) => {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0,10);
  };
  const yesterday = addDays(-1);
  const dayBefore = addDays(-2);
  const fourDaysAgo = addDays(-4);
  const fiveDaysAgo = addDays(-5);
  const rows = q.getPitcherLogForTeam.all(teamU, fiveDaysAgo, gameDate);
  const byPitcher = {};
  for (const r of rows) {
    if (!r.appeared) continue;
    if (!byPitcher[r.pitcher_name]) byPitcher[r.pitcher_name] = [];
    byPitcher[r.pitcher_name].push(r);
  }
  const out = [];
  for (const [name, apps] of Object.entries(byPitcher)) {
    const dates = new Set(apps.map(a => a.game_date));
    const reasons = [];
    if (dates.has(yesterday) && dates.has(dayBefore)) reasons.push('2-consecutive');
    const last4 = apps.filter(a => a.game_date >= fourDaysAgo);
    if (last4.length >= 3) reasons.push('3in4');
    const yApp = apps.find(a => a.game_date === yesterday);
    if (yApp && (yApp.pitches_thrown||0) > 29) reasons.push('pitch-count');
    if (reasons.length) out.push({ pitcher_name: name, reasons });
  }
  return out;
};


q.upsertWobaBatch = (key, rows) => {
  const tx = db.transaction((k, rs) => { for (const r of rs) q.upsertWoba.run(k, r.name, r.woba, r.sample || 0); });
  tx(key, rows);
};


// Initialize prepared statements that need new columns
try {
  q.updateWindData = db.prepare(`UPDATE game_log SET wind_speed=?,wind_dir=?,wind_factor=?,temp_f=?,temp_run_adj=?,roof_status=?,roof_confidence=?,weather_quality='fresh',weather_quality_at=datetime('now') WHERE game_date=? AND game_id=?`);
} catch(e) { console.error('updateWindData init failed:', e.message); }


// Bullpen wOBA queries
q.getPitchersByTeam = (dataKey, teamAbbr) => {
  return db.prepare(
    "SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=? AND player_name LIKE ? ORDER BY sample_size DESC"
  ).all(dataKey, '%'+teamAbbr);
};

q.getBullpenWoba = (teamAbbr, starterName, vsHand, wProj, wAct, gameDate, unknownWoba) => {
  if (unknownWoba == null) unknownWoba = 0.335;
  const teamLower = teamAbbr.toLowerCase();
  const starterNorm = normName(starterName).split(' ').pop();
  const projKey = 'pit-proj-'+vsHand;
  const projRows = db.prepare(
    "SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=? AND player_name LIKE ?"
  ).all(projKey, '% '+teamLower.toUpperCase());
  const rosterRows = db.prepare("SELECT player_name,role FROM team_rosters WHERE team=? AND role='RP'").all(teamAbbr.toUpperCase());
  const activeRPSet = new Set(rosterRows.map(r=>normName(r.player_name)));
  const hasRoster = activeRPSet.size > 0;
  if (!projRows.length && !hasRoster) return null;
  // Fatigue log stores full names from MLB Stats API — exact match only, no last-name fallback.
  const fatiguedSet = new Set(q.getFatiguedPitchers(teamAbbr, gameDate).map(f => normName(f.pitcher_name)));
  const bullpenProj = projRows.filter(r => {
    const nameClean = r.player_name.replace(/ [A-Z]{2,3}$/, '');
    const pn = normName(nameClean);
    const last = pn.split(' ').pop();
    if (starterNorm && pn.includes(starterNorm)) return false;
    if (fatiguedSet.has(pn)) return false;
    if (hasRoster) {
      return activeRPSet.has(pn) || [...activeRPSet].some(n => n.endsWith(' '+last));
    }
    return r.sample_size >= 5;
  });
  const actKey = 'pit-act-'+vsHand;
  const actRows = db.prepare(
    "SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?"
  ).all(actKey);
  const actIdx = {};
  for (const r of actRows) actIdx[normName(r.player_name)] = r;

  const W_PROJ = (wProj != null) ? wProj : 0.65;
  const W_ACT = (wAct != null) ? wAct : 0.35;
  const pitchers = bullpenProj.map(proj => {
    const pName = normName(proj.player_name.replace(/ [A-Z]+$/, ''));
    const actMatch = fuzzyLookup(actIdx, pName, teamAbbr);
    const woba = (actMatch && actMatch.woba)
      ? W_PROJ * proj.woba + W_ACT * actMatch.woba
      : proj.woba;
    return { name: pName, woba, sample: proj.sample_size, fallback: false };
  });

  // Inject fallback entries for active RPs who have no proj row (injury
  // callups, recent trades, etc). Skip the SP and any fatigued pitchers.
  // Last-name collision with an existing proj entry = treat as same person.
  if (hasRoster) {
    const representedFull = new Set(pitchers.map(p => p.name));
    const representedLast = new Set(pitchers.map(p => { var parts = p.name.split(' '); return parts[parts.length-1]; }));
    for (const r of rosterRows) {
      const rName = normName(r.player_name);
      const rParts = rName.split(' ');
      const rLast = rParts[rParts.length-1];
      if (!rName) continue;
      if (representedFull.has(rName)) continue;
      if (rLast && representedLast.has(rLast)) continue;
      if (starterNorm && rName.includes(starterNorm)) continue;
      if (fatiguedSet.has(rName)) continue;
      pitchers.push({ name: rName, woba: unknownWoba, sample: 0, fallback: true });
    }
  }

  if (!pitchers.length) return null;
  const fallbackList = pitchers.filter(p => p.fallback);
  const projPitchers = pitchers.filter(p => !p.fallback);
  const qualifiedProj = projPitchers.filter(p => p.sample >= 5);
  // Primary pool: qualified proj if enough; otherwise take up to 8 proj rows.
  const primary = qualifiedProj.length >= 3 ? qualifiedProj : projPitchers.slice(0, 8);
  // Always include fallback entries — a rostered callup will throw innings.
  const pool = primary.concat(fallbackList);
  if (!pool.length) return null;
  const totalW = pool.reduce((s,p)=>s+(p.sample||20), 0);
  const woba = pool.reduce((s,p)=>s+(p.woba*(p.sample||20)), 0) / totalW;
  return { woba: parseFloat(woba.toFixed(4)), pitchers: pool.length, fallbacks: fallbackList.length };
};

q.getBullpenWobaBlended = (teamAbbr, starterName, lineup, bpStrongWtR, bpWeakWtR, bpStrongWtL, bpWeakWtL, wProj, wAct, gameDate, unknownWoba) => {
  // Blend the team's bullpen-allowed wOBA using per-handedness strong/weak
  // manager-assumption weights. For each batter in the opposing lineup the
  // manager is assumed to deploy `strongWt` share of the better-matched
  // reliever (min wOBA) and `weakWt` share of the worse-matched one, with
  // the R/L split tuned separately because righty vs lefty matchup leverage
  // differs in practice. Fallback (no lineup) averages R and L weights.
  // lineup = [{hand:'R'|'L'|'S'}] — the batting lineup the bullpen will face
  const rhb = q.getBullpenWoba(teamAbbr, starterName, 'rhb', wProj, wAct, gameDate, unknownWoba);
  const lhb = q.getBullpenWoba(teamAbbr, starterName, 'lhb', wProj, wAct, gameDate, unknownWoba);
  const vsRHB = rhb?.woba || null;
  const vsLHB = lhb?.woba || null;
  if (!vsRHB && !vsLHB) return null;
  // Defaults mirror the seed values so standalone callers (scripts/) still
  // produce sane results if they forget to pass weights.
  const sR = (bpStrongWtR != null) ? bpStrongWtR : 0.55;
  const wR = (bpWeakWtR   != null) ? bpWeakWtR   : 0.45;
  const sL = (bpStrongWtL != null) ? bpStrongWtL : 0.35;
  const wL = (bpWeakWtL   != null) ? bpWeakWtL   : 0.65;
  if (vsRHB && vsLHB && lineup && lineup.length > 0) {
    const strongWoba = Math.min(vsRHB, vsLHB);
    const weakWoba   = Math.max(vsRHB, vsLHB);
    let sum = 0;
    for (const b of lineup) {
      let sW, wW;
      if (b.hand === 'R')      { sW = sR;            wW = wR;            }
      else if (b.hand === 'L') { sW = sL;            wW = wL;            }
      else                     { sW = (sR + sL) / 2; wW = (wR + wL) / 2; }
      sum += sW * strongWoba + wW * weakWoba;
    }
    const blended = parseFloat((sum / lineup.length).toFixed(4));
    return { woba: blended, vsRHB, vsLHB, strongWoba, weakWoba, source: 'strong-weak-by-hand' };
  }
  // No lineup: average the two handedness weight pairs.
  if (vsRHB && vsLHB) {
    const strongWoba = Math.min(vsRHB, vsLHB);
    const weakWoba   = Math.max(vsRHB, vsLHB);
    const avgStrong = (sR + sL) / 2;
    const avgWeak   = (wR + wL) / 2;
    const blended = parseFloat((avgStrong * strongWoba + avgWeak * weakWoba).toFixed(4));
    return { woba: blended, vsRHB, vsLHB, source: 'strong-weak-fallback' };
  }
  return { woba: vsRHB || vsLHB, vsRHB, vsLHB, source: 'single-side' };
};

// Add is_active and notes columns if not present
  try { db.prepare("ALTER TABLE bet_signals ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1").run(); } catch(e) {}
  try { db.prepare("ALTER TABLE bet_signals ADD COLUMN notes TEXT").run(); } catch(e) {}

const _insertAuditStmt = db.prepare(
  "INSERT INTO bet_signal_audit (signal_id, game_date, game_id, signal_type, signal_side, action, bet_line, closing_line, clv, source, detail) " +
  "VALUES (@signal_id, @game_date, @game_id, @signal_type, @signal_side, @action, @bet_line, @closing_line, @clv, @source, @detail)"
);
q.insertBetSignalAudit = (row) => {
  _insertAuditStmt.run({
    signal_id: row.signal_id != null ? row.signal_id : null,
    game_date: row.game_date || null,
    game_id: row.game_id || null,
    signal_type: row.signal_type || null,
    signal_side: row.signal_side || null,
    action: row.action || null,
    bet_line: row.bet_line != null ? row.bet_line : null,
    closing_line: row.closing_line != null ? row.closing_line : null,
    clv: row.clv != null ? row.clv : null,
    source: row.source || null,
    detail: row.detail || null,
  });
};

module.exports = { db, q };
