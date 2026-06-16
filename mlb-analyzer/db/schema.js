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

  -- Daily snapshot of woba_data. woba_data itself is wiped+reloaded on
  -- every FanGraphs refresh, destroying the prior state — which means a
  -- backtest can only ever see TODAY's wOBA values, not the values that
  -- existed when a past game was scored. This table archives each key's
  -- rows tagged with the calendar date the ingest ran, so date-accurate
  -- backtests can ask "what did the index look like on day X". Captured
  -- by ingestWobaCSV after each key's upsert. PK includes snapshot_date
  -- so a same-day re-refresh overwrites (last write per day wins, which
  -- matches what the model used by end of that day).
  CREATE TABLE IF NOT EXISTS woba_data_snapshot (
    snapshot_date TEXT NOT NULL,
    data_key TEXT NOT NULL,
    player_name TEXT NOT NULL,
    woba REAL NOT NULL,
    sample_size REAL DEFAULT 0,
    PRIMARY KEY (snapshot_date, data_key, player_name)
  );
  CREATE INDEX IF NOT EXISTS idx_woba_snap_date_key ON woba_data_snapshot(snapshot_date, data_key);
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
  -- Per-source probable-SP capture. statsapi_*_sp is the probable starter
  -- emitted by statsapi during the bootstrap pass; rotowire_*_sp is the
  -- starter parsed from RotoWire's lineup page. Each column is owned by
  -- exactly one source (the other passes null, COALESCE preserves), so
  -- the two raw values are independently auditable regardless of how the
  -- merged away_sp / home_sp landed under the existing Option B
  -- precedence (statsapi wins on conflict). sp_source_conflict /
  -- sp_source_conflict_note record the result of comparing the two raw
  -- values with name-normalization (normName + stripSfx + last+initial),
  -- recomputed every lineup-job pass; flag is FLAG-ONLY (signals are NOT
  -- suppressed when set).
  statsapi_away_sp TEXT,
  statsapi_home_sp TEXT,
  rotowire_away_sp TEXT,
  rotowire_home_sp TEXT,
  sp_source_conflict INTEGER DEFAULT 0,
  sp_source_conflict_note TEXT,
  -- Kalshi's implied "fair" total (the strike rung whose over_ask is
  -- closest to $0.50). Observation-only; the model continues to bet
  -- against market_total. Lets us see when Kalshi's fair line diverges
  -- from the consensus market line. Written by the Kalshi-direct totals
  -- override block in runOddsJob when kalshi_direct_totals_enabled is on.
  kalshi_implied_total REAL,
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
    -- signal_label and category column semantics CHANGED in
    -- feat/continuous-edge-score. Pre-cutover rows store star labels
    -- ('1*'/'2*'/'3*') and compound categories ('1star-fav',
    -- '2star-over', etc.). Post-cutover rows store NULL label and
    -- direction-only categories ('fav'|'dog'|'over'|'under').
    -- NOT NULL was dropped from signal_label by a one-time table
    -- recreate (see the migration block below — guarded by
    -- sqlite_master inspection so it runs once). Historical rows are
    -- intentionally NOT backfilled; the UI dispatches on (label != null)
    -- to render whichever shape the row stores.
    signal_label TEXT,
    category TEXT NOT NULL,
    market_line INTEGER,
    model_line INTEGER,
    -- edge_pct unit history (units stored in this column have shifted):
    --   * Legacy ML rows (pre-feat/probability-based-signal-thresholds):
    --     American-odds cents distance (e.g. 30 = 30-cent edge).
    --   * Legacy Total rows: probability-point decimal (e.g. 0.083).
    --   * Post-cutover (feat/continuous-edge-score): raw
    --     probability-point decimal for BOTH ML and Total (e.g.
    --     0.0437 = 4.37pp). The UI computes a rounded-0.5pp display
    --     score from edge_pct; the raw column is the source of truth.
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
  -- Parameter-sweep run log. POST /api/admin/parameter-sweep is
  -- async — it inserts a row here with status='running' and returns
  -- the run_id immediately. The sweep continues in the background;
  -- when it finishes the row is UPDATEd with results_json + status=
  -- 'done', or with error + status='error' if it threw. GET handlers
  -- read this table to surface status + results once complete.
  -- started_at / finished_at are PT (services/jobs.js nowPtIso),
  -- matching the morning-capture / empirical-spread convention.
  CREATE TABLE IF NOT EXISTS parameter_sweep_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,            -- 'running' | 'done' | 'error'
    params_json TEXT NOT NULL,       -- request body that started this run
    results_json TEXT,               -- full sweep response, NULL until done
    error TEXT,                      -- error message when status='error'
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_psr_started_at ON parameter_sweep_runs (started_at DESC);
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
  -- Pre-cutover tier-threshold seeds (ml_value_edge, ml_lean_edge,
  -- ml_3star_edge, tot_value_edge, tot_lean_edge, tot_3star_edge)
  -- were removed in feat/continuous-edge-score. The continuous-edge
  -- settings are seeded by the migration block at the bottom of this
  -- file via INSERT OR IGNORE so fresh installs and existing DBs
  -- both end up with the right keys.
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
    position TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(team, player_name)
  );
  -- Season-cumulative roster (statsapi rosterType=fullSeason). Superset
  -- of team_rosters — includes currently-IL players who were active
  -- earlier in the season, plus players who appeared on the team during
  -- a mid-season trade window. Used ONLY by backtest resolution
  -- (resolveBacktestMlbId in services/jobs.js); live signal generation
  -- continues to use team_rosters (active 26-man) so released players
  -- can't accidentally resolve in tonight's lineup.
  --
  -- Same shape as team_rosters so the resolver can match rows without
  -- per-table column shimming. Refreshed by runSeasonRosterJob on the
  -- same 6AM PT cadence as the active roster.
  CREATE TABLE IF NOT EXISTS team_rosters_season (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    player_name TEXT NOT NULL,
    mlb_id INTEGER,
    role TEXT NOT NULL,
    hand TEXT,
    position TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(team, player_name)
  );
  -- Catcher framing run values (Statcast catcher-framing leaderboard).
  -- Keyed by mlb_id, which Savant provides directly and which a lineup
  -- catcher resolves to via team_rosters. rv_tot is cumulative season
  -- framing runs (already ABS-haircut-adjusted in 2026 data — do NOT
  -- re-scale). pitches drives the per-game conversion (≈145 pitches/game).
  -- Empty until the Savant ingest is built; model wiring treats a missing
  -- row as zero framing adjustment, and the whole feature is gated behind
  -- the catcher_framing_enabled setting (default off).
  CREATE TABLE IF NOT EXISTS catcher_framing (
    mlb_id INTEGER PRIMARY KEY,
    name TEXT,
    rv_tot REAL NOT NULL DEFAULT 0,
    pitches INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Daily snapshot of catcher_framing. catcher_framing itself is
  -- upserted (last-write-wins) on each runCatcherFramingJob, destroying
  -- the prior state — which means a backtest can only see TODAY's
  -- rv_tot values, not the values that existed when a past game was
  -- scored. This table archives each (mlb_id, snapshot_date) pair so
  -- date-accurate backtests can ask "what did the framing index look
  -- like on day X". Captured by runCatcherFramingJob after each
  -- upsert. PK includes snapshot_date so a same-day re-refresh
  -- overwrites (last write per day wins, matching the wOBA pattern).
  -- See db/schema.js woba_data_snapshot for the canonical reference.
  CREATE TABLE IF NOT EXISTS catcher_framing_snapshot (
    snapshot_date TEXT NOT NULL,
    mlb_id INTEGER NOT NULL,
    name TEXT,
    rv_tot REAL,
    pitches INTEGER,
    PRIMARY KEY (snapshot_date, mlb_id)
  );
  CREATE INDEX IF NOT EXISTS idx_framing_snap_date ON catcher_framing_snapshot(snapshot_date);
  -- Multi-year (2023-2025) framing baseline, fallback for catchers with
  -- little/no current-season sample. Pre-ABS values; the model applies the
  -- ABS scaling factor at use-time. season_start/end record the span pulled.
  CREATE TABLE IF NOT EXISTS catcher_framing_historical (
    mlb_id INTEGER PRIMARY KEY,
    name TEXT,
    rv_tot REAL NOT NULL DEFAULT 0,
    pitches INTEGER NOT NULL DEFAULT 0,
    season_start INTEGER,
    season_end INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Statcast Fielding Run Value for NON-CATCHER position players (Build B,
  -- defensive impact). total_runs is FRV in runs (range + DP + arm; for
  -- non-catchers this is framing-free, so no double-count with the framing
  -- feature). outs_total is the fielding-opportunity count, the denominator
  -- for the per-opportunity → per-game conversion. position is the statsapi
  -- position the row was pulled under (label; game logic reads lineup pos).
  CREATE TABLE IF NOT EXISTS fielding_frv (
    mlb_id INTEGER PRIMARY KEY,
    name TEXT,
    total_runs REAL NOT NULL DEFAULT 0,
    outs_total INTEGER NOT NULL DEFAULT 0,
    position TEXT,
    season_start INTEGER,
    season_end INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Daily snapshot of fielding_frv (Build B defensive impact). Same
  -- date-accurate-backtest rationale as catcher_framing_snapshot:
  -- fielding_frv is upserted on every runFieldingFrvJob (daily 6AM PT
  -- cron) so the live table only shows today's view. position is in
  -- the PK because a single player may have rows for multiple
  -- positions (e.g. utility infielders). season_start/season_end carry
  -- the trailing-window provenance forward so a backtest can know
  -- which seasons fed the snapshotted total_runs value.
  CREATE TABLE IF NOT EXISTS fielding_frv_snapshot (
    snapshot_date TEXT NOT NULL,
    mlb_id INTEGER NOT NULL,
    name TEXT,
    total_runs REAL,
    outs_total INTEGER,
    position TEXT,
    season_start TEXT,
    season_end TEXT,
    PRIMARY KEY (snapshot_date, mlb_id, position)
  );
  CREATE INDEX IF NOT EXISTS idx_frv_snap_date ON fielding_frv_snapshot(snapshot_date);
  -- Team baserunning aggregates (season-to-date). One row per (season,
  -- team). bsr is the FanGraphs cumulative baserunning runs (UBR + wSB
  -- + wGDP), surfaced here so the runmodel can read a team-level
  -- baserunning adjustment alongside framing/FRV. Component fields
  -- captured for diagnostics + future per-component sweeps. g (games
  -- played) is used to derive a per-game rate at read time —
  -- materializing the rate here would couple to season length.
  --
  -- Source: FanGraphs team-aggregated batting leaderboard
  -- (team=0,ts on the leaders API). Refreshed daily by
  -- runBaserunningJob; snapshot mirror in team_baserunning_snapshot.
  CREATE TABLE IF NOT EXISTS team_baserunning (
    season INTEGER NOT NULL,
    team TEXT NOT NULL,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    refreshed_at TEXT,
    PRIMARY KEY (season, team)
  );
  -- Daily snapshot of team_baserunning — same date-accurate-backtest
  -- rationale as catcher_framing_snapshot / fielding_frv_snapshot.
  -- Lets a future forward-honest backtest pull the BsR value as it
  -- stood on game_date, not the current-state value (which is look-
  -- ahead when applied to early-season games).
  CREATE TABLE IF NOT EXISTS team_baserunning_snapshot (
    snapshot_date TEXT NOT NULL,
    season INTEGER NOT NULL,
    team TEXT NOT NULL,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    PRIMARY KEY (snapshot_date, season, team)
  );
  CREATE INDEX IF NOT EXISTS idx_team_baserunning_snapshot_date ON team_baserunning_snapshot(snapshot_date);
  -- Player-level baserunning (FanGraphs leaderboard with ind=1 instead
  -- of team=0,ts). One row per (season, mlbam_id) — aggregated across
  -- mid-season trade-window splits so the player has a single season
  -- total. mlbam_id == FG's xMLBAMID == statsapi's person.id (the join
  -- key the backtest resolver returns).
  --
  -- Source: FanGraphs leaders endpoint with the same pinned-URL
  -- shape as team_baserunning, but team=0 + ind=1. Aggregated on
  -- write because a traded player shows up with one row per team in
  -- FG's response; we want season-cumulative skill per player.
  CREATE TABLE IF NOT EXISTS player_baserunning (
    season INTEGER NOT NULL,
    mlbam_id INTEGER NOT NULL,
    name TEXT,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    refreshed_at TEXT,
    PRIMARY KEY (season, mlbam_id)
  );
  -- Daily snapshot mirror — same forward-honest backtest rationale as
  -- team_baserunning_snapshot.
  CREATE TABLE IF NOT EXISTS player_baserunning_snapshot (
    snapshot_date TEXT NOT NULL,
    season INTEGER NOT NULL,
    mlbam_id INTEGER NOT NULL,
    name TEXT,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    PRIMARY KEY (snapshot_date, season, mlbam_id)
  );
  CREATE INDEX IF NOT EXISTS idx_player_baserunning_snapshot_date ON player_baserunning_snapshot(snapshot_date);
  -- Trailing-window player baserunning (~365-day rolling, NOT YTD).
  -- YTD-season=2026 returned ~70 games per player — too noisy for a
  -- per-player true-talent estimate. Trailing-1yr ≈ full-season sample,
  -- aggregated across mid-season trade splits (Devers "2 Tms" lands as
  -- one row). FG probe confirmed the custom date range honors the
  -- window (top-10 G = 126-162, BsR ~8-10).
  --
  -- Single rolling window at a time. window_startdate / window_enddate
  -- columns name the period the row's values cover so the operator
  -- (and backtest readers) can see what data is loaded without
  -- joining a separate metadata table. Each refresh clears the table
  -- and re-inserts under the new window — small (~700 rows) and
  -- intentionally not snapshotted for v1.
  --
  -- Forward-honest path is the existing player_baserunning_snapshot
  -- table (YTD-season snapshots). Trailing-snapshot equivalent lives
  -- in player_baserunning_trailing_snapshot (below) — same daily
  -- delete-then-insert pattern, keyed on snapshot_date so the forward
  -- backtest can read each player's trailing-1yr BsR AS OF a past date.
  CREATE TABLE IF NOT EXISTS player_baserunning_trailing (
    mlbam_id INTEGER PRIMARY KEY,
    name TEXT,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    stint_count INTEGER,        -- 1 = single team over window; >1 = multi-team
    window_startdate TEXT,
    window_enddate TEXT,
    refreshed_at TEXT
  );
  -- Daily snapshot mirror of player_baserunning_trailing. Starts the
  -- forward-honest clock for the trailing-1yr player BsR variant: the
  -- forward backtest reads as-of-game_date values so it NEVER applies
  -- future BsR to past games.
  --
  -- window_startdate / window_enddate name the trailing period the
  -- row's values cover. These should differ row-to-row across
  -- snapshot_date as the trailing window rolls (e.g. snapshot
  -- 2026-06-16 covers 2025-06-16..2026-06-16; snapshot 2026-06-17
  -- covers 2025-06-17..2026-06-17). Carrying them on every row keeps
  -- the as-of reads self-describing without a separate metadata join.
  --
  -- Same delete-then-insert idempotency on the snapshot side as
  -- player_baserunning_snapshot. PK includes snapshot_date so a
  -- same-day re-run starts clean.
  CREATE TABLE IF NOT EXISTS player_baserunning_trailing_snapshot (
    snapshot_date TEXT NOT NULL,
    mlbam_id INTEGER NOT NULL,
    name TEXT,
    bsr REAL,
    ubr REAL,
    wsb REAL,
    wgdp REAL,
    sb INTEGER,
    cs INTEGER,
    g INTEGER,
    window_startdate TEXT,
    window_enddate TEXT,
    PRIMARY KEY (snapshot_date, mlbam_id)
  );
  CREATE INDEX IF NOT EXISTS idx_player_baserunning_trailing_snapshot_date
    ON player_baserunning_trailing_snapshot(snapshot_date);
  -- Kalshi MLB spread ladder (KXMLBSPREAD series). One row per
  -- (game_date, game_id, spread_team, spread_line) — each Kalshi
  -- game exposes ~10-12 spread markets (1.5 through 9.5 in 1-run
  -- steps, two sides per game). Stored for forward analysis of
  -- which spread line offers the best value per signal. INGEST
  -- ONLY for now — not consumed by the model or signal generation.
  -- yes_ask_dollars / yes_bid_dollars are the raw Kalshi prices
  -- ($0..$1 implied prob); yes_ask_ml is yes_ask_dollars converted
  -- to American odds and run through services/jobs.js's
  -- feeAdjustAmerican (same fee + 1-cent screen-shift the ML path
  -- uses) before storage. no_ask_ml mirrors the no side. spread_team
  -- is the team this spread is FOR (the side that wins if YES).
  CREATE TABLE IF NOT EXISTS kalshi_spread_markets (
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    spread_team TEXT NOT NULL,
    spread_line REAL NOT NULL,
    yes_ask_dollars REAL,
    yes_bid_dollars REAL,
    no_ask_dollars REAL,
    no_bid_dollars REAL,
    yes_ask_ml INTEGER,
    no_ask_ml INTEGER,
    volume_24h REAL,
    event_ticker TEXT,
    ticker TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_date, game_id, spread_team, spread_line)
  );
  CREATE INDEX IF NOT EXISTS idx_spread_game ON kalshi_spread_markets (game_date, game_id);
  -- Daily snapshot of kalshi_spread_markets — same date-accurate-
  -- backtest rationale as the framing/FRV snapshots. snapshot_date
  -- is PT-anchored (America/Los_Angeles) to align with the other
  -- snapshot writers (wOBA, framing, FRV).
  CREATE TABLE IF NOT EXISTS kalshi_spread_markets_snapshot (
    snapshot_date TEXT NOT NULL,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    spread_team TEXT NOT NULL,
    spread_line REAL NOT NULL,
    yes_ask_dollars REAL,
    yes_bid_dollars REAL,
    no_ask_dollars REAL,
    no_bid_dollars REAL,
    yes_ask_ml INTEGER,
    no_ask_ml INTEGER,
    volume_24h REAL,
    PRIMARY KEY (snapshot_date, game_date, game_id, spread_team, spread_line)
  );
  CREATE INDEX IF NOT EXISTS idx_spread_snap_date ON kalshi_spread_markets_snapshot (snapshot_date);
  -- Daily snapshots of Kalshi ML and totals markets — parallel to
  -- kalshi_spread_markets_snapshot. Backstop the empirical-market-
  -- capture CLV close lookup when the gametime live capture is
  -- absent (over_price/under_price null at the gametime pass, cron
  -- timing miss, etc.). Without these the ML/totals CLV is null
  -- for any morning capture whose gametime sibling didn't fire.
  -- See services/empirical-spread-roi.js fetchMarketRows for the
  -- consuming LEFT JOIN.
  --
  -- ML: one row per game (binary market, two sides). Prices stored
  -- are FEE-ADJUSTED with the 1-cent shift — same convention as
  -- game_log.market_*_ml, so a snapshot row is directly comparable
  -- to the morning capture's frozen price.
  CREATE TABLE IF NOT EXISTS kalshi_ml_markets_snapshot (
    snapshot_date TEXT NOT NULL,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    away_ask_dollars REAL,
    home_ask_dollars REAL,
    away_ask_ml INTEGER,
    home_ask_ml INTEGER,
    volume_24h_away REAL,
    volume_24h_home REAL,
    PRIMARY KEY (snapshot_date, game_date, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ml_snap_date ON kalshi_ml_markets_snapshot (snapshot_date);
  -- Totals: one row per game per snapshot_date, recording the rung
  -- whose strike matches the production override's chosen line
  -- (else Kalshi's default closest-to-$0.50 rung). market_line is a
  -- column (not in PK) because we keep only ONE rung per game per
  -- snapshot — the rung the override path used for game_log writes.
  -- If morning capture's market_line differs at lookup time, the
  -- line_moved branch in empirical-spread-roi handles it (sibling
  -- and snapshot both compared against morning's frozen line).
  CREATE TABLE IF NOT EXISTS kalshi_totals_markets_snapshot (
    snapshot_date TEXT NOT NULL,
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    market_line REAL,
    over_ask_dollars REAL,
    under_ask_dollars REAL,
    over_price_ml INTEGER,
    under_price_ml INTEGER,
    PRIMARY KEY (snapshot_date, game_date, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_totals_snap_date ON kalshi_totals_markets_snapshot (snapshot_date);
  -- Empirical spread signals. One row per (game_date, game_id,
  -- generated_at) — each odds-job run captures a fresh snapshot of
  -- the empirical edge analysis defined in services/empirical-
  -- spread-edge.js (top picks against the historical same-cell
  -- margin distribution). predictions_json carries up to 6 rows
  -- (3 spread_line rungs × 2 sides) as a JSON array of
  -- {spread_team, spread_line, kalshi_yes_ask_ml, implied_pct,
  --  empirical_pct, edge_pp}. top_edge_* are denormalized for cheap
  -- ORDER BY / threshold queries on the slate page.
  --
  -- [tz cutover: 2026-06-08]
  -- generated_at was UTC before fix/morning-capture-tz-anchor and is
  -- PT after. Existing UTC rows are NOT rewritten (PK component).
  -- The DEFAULT (datetime('now')) below is UTC — kept as a fallback
  -- only; the writer always supplies an explicit PT value via
  -- services/jobs.js nowPtIso(). The eventual ROI window readout
  -- must interpret rows with game_date <= 2026-06-08 as UTC.
  CREATE TABLE IF NOT EXISTS empirical_spread_signals (
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- 'gametime' = same-day refresh / odds-job pass (default — the
    -- current track that ships every runOddsJob). 'morning' = the
    -- D+1 first-eligible projected-lineup capture written by the
    -- 7:30am cron / POST /api/jobs/morning-capture. The delta
    -- between the two tracks per (game_date, game_id) is the
    -- user's realized CLV.
    capture_track TEXT NOT NULL DEFAULT 'gametime',
    model_total REAL,
    model_no_vig_home_prob REAL,
    cell_label TEXT,
    cell_sample_size INTEGER,
    predictions_json TEXT,
    top_edge_team TEXT,
    top_edge_line REAL,
    top_edge_yes_ask_ml INTEGER,
    top_edge_pp REAL,
    PRIMARY KEY (game_date, game_id, capture_track, generated_at)
  );
  CREATE INDEX IF NOT EXISTS idx_emp_spread_date ON empirical_spread_signals (game_date);
  CREATE INDEX IF NOT EXISTS idx_emp_spread_edge ON empirical_spread_signals (top_edge_pp DESC);
  -- Per-prediction outcome table for forward backtesting. One row
  -- per (game_date, game_id, spread_team, spread_line, generated_at)
  -- — captured at signal-emit time with NULL outcome/pnl; updated
  -- when the game grades. pnl_per_100 is the dollar profit/loss on
  -- a $100 stake at the original yes_ask_ml: +americanProfit on win,
  -- -100 on loss, 0 on push. This is the source of truth for the
  -- empirical-signal hindsight ROI.
  --
  -- [tz cutover: 2026-06-08]
  -- generated_at and graded_at were UTC before fix/morning-capture-
  -- tz-anchor and are PT after. graded_at switched from
  -- datetime('now') (UTC) to a bind parameter (PT). Existing UTC
  -- generated_at values are NOT rewritten (PK component); existing
  -- UTC graded_at values are left as-is. ROI window readout must
  -- interpret rows with game_date <= 2026-06-08 as UTC.
  CREATE TABLE IF NOT EXISTS empirical_spread_outcomes (
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    spread_team TEXT NOT NULL,
    spread_line REAL NOT NULL,
    -- 'lay' = favorite -L (YES side of the Kalshi market);
    -- 'take' = opposite team +L, priced from the SAME row's no_ask
    -- (the real Kalshi-posted +runline price, not (1 - yes_ask)).
    -- Each spread market emits both legs as separate rows so each
    -- side grades independently and the price-freeze is preserved
    -- per side.
    side TEXT NOT NULL DEFAULT 'lay',
    -- See empirical_spread_signals.capture_track. Morning rows are
    -- the first-eligible D+1 lock; gametime rows are the existing
    -- live odds-job track. Both grade against the same final
    -- margin but each row carries its OWN frozen price, so the
    -- ROI delta per game = morning_pnl − gametime_pnl.
    capture_track TEXT NOT NULL DEFAULT 'gametime',
    -- Stable across runs: game_id|line|spread_team. Same value on
    -- both legs of a market so downstream can group them.
    pair_id TEXT,
    -- yes_ask_ml = THIS SIDE's price (lay -> Kalshi yes_ask;
    -- take -> Kalshi no_ask). Column name kept for back-compat
    -- with the pre-take schema; semantically it is the side's
    -- frozen price-at-signal-time.
    yes_ask_ml INTEGER NOT NULL,
    edge_pp REAL NOT NULL,
    cell_sample_size INTEGER NOT NULL,
    generated_at TEXT NOT NULL,
    actual_margin INTEGER,
    outcome TEXT,
    pnl_per_100 REAL,
    graded_at TEXT,
    PRIMARY KEY (game_date, game_id, spread_team, spread_line, side, capture_track, generated_at)
  );
  CREATE INDEX IF NOT EXISTS idx_emp_outcome_date ON empirical_spread_outcomes (game_date);
  CREATE INDEX IF NOT EXISTS idx_emp_outcome_ungraded ON empirical_spread_outcomes (game_date) WHERE outcome IS NULL;
  -- idx_emp_outcome_pair lives in the ALTER block below — on an
  -- existing deploy the table doesn't have pair_id yet at this
  -- point, so creating the index here would fail.
  -- Morning-capture lock-window state. One row per D+1 date; opened_at
  -- is the timestamp of the first morning-capture invocation that day.
  -- Records when the lock window opened — the actual
  -- "don't-re-write" guard is q.existsMorningSignalForGame inside
  -- generateMorningCapture, which checks per-game presence in
  -- empirical_spread_signals (capture_track='morning'). State row
  -- presence is observability, not enforcement.
  --
  -- Entry points that may upsert this row + invoke
  -- generateMorningCapture (all idempotent via existsMorningSignalForGame):
  --   * 7:30AM PT cron (services/jobs.js startCronJobs) — opens the
  --     lock window early. Structurally too early for Kalshi spread
  --     posting (~14:30-21:30 UTC on D-1), so usually finds zero
  --     eligible games at 7:30AM — kept as a harmless extra attempt
  --     and to set opened_at to a true PT-morning timestamp.
  --   * runOddsJob completion tail (services/jobs.js) — every
  --     successful odds-job pass chains a runMorningCaptureJob call
  --     for the same date, so games lock at the first odds run AFTER
  --     Kalshi posts their spread market. Recursion-guarded via
  --     opts.skipChainedMorningCapture on the inner runOddsJob.
  --   * POST /api/jobs/morning-capture — manual operator trigger.
  --
  -- [tz cutover: 2026-06-08]
  -- opened_at was UTC before fix/morning-capture-tz-anchor and is PT
  -- after. The single 2026-06-08 row was DELETE'd as part of that
  -- fix (so the next morning-capture invocation re-sets it PT-clean
  -- via INSERT OR IGNORE).
  CREATE TABLE IF NOT EXISTS morning_capture_state (
    game_date TEXT PRIMARY KEY,
    opened_at TEXT NOT NULL
  );
  -- empirical_market_captures — feat/morning-capture-ml-totals.
  -- Two-track (morning/gametime) freeze of moneyline and totals
  -- markets, mirroring the empirical_spread_outcomes pattern for
  -- spread markets but with a separate table because:
  --   - Spread rows are intrinsically per-side (lay/take with shared
  --     pair_id); pair-collapse picks the signaled side. ML and
  --     totals have no analogous pair — both sides are sides of one
  --     market, not separate Kalshi events. Forcing into the spread
  --     schema would mean inventing fake pair_ids and synthetic
  --     sides.
  --   - One row per market with both sides' prices satisfies the
  --     brief's "do not create two summable rows" constraint
  --     intrinsically.
  --   - PK shape (game_date, game_id, market_type, capture_track,
  --     generated_at) is the same skeleton as the spread table so
  --     the grader UPDATE key + regrade backfill remain consistent
  --     across market types.
  --
  -- Prices are stored in the SAME convention as game_log's market_*_ml
  -- columns: fee-adjusted via feeAdjustAmerican (Kalshi-direct path,
  -- jobs.js feeAdjustAmerican; totals via feeAdjustAmericanFromC) +
  -- the bettor-unfavorable 1-cent shift. Readout consumes them as
  -- stored — no re-derive, no re-shift.
  --
  -- signaled_side identifies the side the model emitted at capture
  -- time (the side the user would bet). Grading writes outcome +
  -- pnl_per_100 ONLY for that side; the unsignaled side stays NULL.
  -- The readout aggregates over signaled_side, so an ML market never
  -- contributes two summable plays.
  CREATE TABLE IF NOT EXISTS empirical_market_captures (
    game_date     TEXT NOT NULL,
    game_id       TEXT NOT NULL,
    market_type   TEXT NOT NULL,          -- 'ml' | 'total'
    capture_track TEXT NOT NULL,          -- 'morning' | 'gametime'
    generated_at  TEXT NOT NULL,          -- PT-anchored
    -- Frozen market state. For ML, market_line is NULL and
    -- over/under prices are NULL. For totals, away/home prices are
    -- NULL and market_line carries the O/U number at capture time.
    market_line     REAL,                 -- totals: e.g. 8.5; ML: NULL
    away_price_ml   INTEGER,              -- ML only
    home_price_ml   INTEGER,              -- ML only
    over_price_ml   INTEGER,              -- totals only
    under_price_ml  INTEGER,              -- totals only
    -- Signaled side at capture time. Derived from model_* vs
    -- market_* on game_log at capture. NULL when no side cleared
    -- SIGNAL_EMIT_FLOOR_PP — row still written (so we have a price
    -- history) but it contributes 0 plays to the readout.
    signaled_side     TEXT,               -- ML: 'home'|'away'; totals: 'over'|'under'
    signaled_edge_pp  REAL,
    signaled_price_ml INTEGER,            -- denormalized: price of signaled_side
    -- Outcome (post-grade) — for the signaled side only.
    away_score    INTEGER,
    home_score    INTEGER,
    actual_total  INTEGER,                -- away_score + home_score; totals grading
    outcome       TEXT,                   -- 'win' | 'loss' | 'push'
    pnl_per_100   REAL,
    graded_at     TEXT,
    PRIMARY KEY (game_date, game_id, market_type, capture_track, generated_at)
  );
  CREATE INDEX IF NOT EXISTS idx_emp_market_date     ON empirical_market_captures (game_date);
  CREATE INDEX IF NOT EXISTS idx_emp_market_ungraded ON empirical_market_captures (game_date) WHERE outcome IS NULL;
  CREATE INDEX IF NOT EXISTS idx_emp_market_type     ON empirical_market_captures (market_type);
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

  -- Pitcher wOBA override — patches the wOBA index in getWobaIndex().
  -- Used when FG has a clearly-wrong projection (e.g. a stale value FG
  -- hasn't refreshed). Name-keyed since wOBA lookups are name-based;
  -- separate override per (pitcher_name, vs_hand) so vs LHB and vs RHB
  -- can be overridden independently. set_at + reason for traceability
  -- — keep these obvious so we remember to remove the override when
  -- FG corrects the upstream data.
  CREATE TABLE IF NOT EXISTS pitcher_woba_override (
    player_name TEXT NOT NULL,
    vs_hand TEXT NOT NULL CHECK(vs_hand IN ('L','R')),
    woba REAL NOT NULL,
    set_at TEXT NOT NULL DEFAULT (datetime('now')),
    reason TEXT,
    PRIMARY KEY (player_name, vs_hand)
  );

  -- Per-game opener override. Wins over the auto-detection in
  -- detectOpeners. side ∈ ('away','home'). is_opener and planned_batters
  -- are stored as integers; bulk_guy is the pitcher name to write into
  -- bulk_guy_{side}. opener_name (optional) pins the opener's name
  -- into away_sp/home_sp for the side — needed because opener identity
  -- otherwise comes from RotoWire/statsapi via the lineup-job path and
  -- can't be corrected for misclassified games (e.g. was-cle 2026-05-25
  -- where RotoWire's lineup feed put the bulk in the SP slot). set_by
  -- + reason are free-form for debugging.
  CREATE TABLE IF NOT EXISTS opener_override (
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('away','home')),
    is_opener INTEGER NOT NULL,
    bulk_guy TEXT,
    opener_name TEXT,
    planned_batters INTEGER,
    set_at TEXT NOT NULL DEFAULT (datetime('now')),
    set_by TEXT,
    reason TEXT,
    PRIMARY KEY (game_date, game_id, side)
  );
  -- Manual lineup override (feat/lineup-override-backend). Stores a full
  -- 9-batter replacement for a side, used while the RotoWire-projected
  -- lineup is stale (e.g. opposing SP flipped handedness and the team
  -- hasn't posted the platoon-adjusted lineup yet). Applied by
  -- runLineupJob ONLY while the side's incoming status is 'projected' —
  -- once RotoWire posts a 'confirmed' lineup, the override is
  -- auto-deleted (real beats guess).
  --
  -- lineup_json: JSON-serialized array of exactly 9 {name, hand, pos}
  -- entries IN BATTING ORDER. Order matters — perBatterEW
  -- (services/model.js ~162) weights each slot by PA_WEIGHTS[slot].
  CREATE TABLE IF NOT EXISTS lineup_override (
    game_date TEXT NOT NULL,
    game_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('away','home')),
    lineup_json TEXT NOT NULL,
    set_at TEXT NOT NULL DEFAULT (datetime('now')),
    set_by TEXT,
    reason TEXT,
    PRIMARY KEY (game_date, game_id, side)
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
// team_rosters position column (Build A: roster expansion to position players).
// Non-authoritative label — statsapi primary position; game logic reads the
// lineup's pos field. NULL on existing pitcher rows until next roster refresh.
try { db.exec("ALTER TABLE team_rosters ADD COLUMN position TEXT"); } catch(e) {}
// fielding_frv provenance (trailing-window ingest): which seasons the
// aggregate spans. NULL on rows from the earlier single-season ingest until
// the next refresh.
try { db.exec("ALTER TABLE fielding_frv ADD COLUMN season_start INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE fielding_frv ADD COLUMN season_end INTEGER"); } catch(e) {}
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
// stint_count was added to player_baserunning_trailing after the
// initial trailing ingest shipped (71d117b). Idempotent ALTER for any
// DB that already created the table without the column.
try { db.exec("ALTER TABLE player_baserunning_trailing ADD COLUMN stint_count INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_away_lineup_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_home_lineup_json TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_away_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_home_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_lineup_captured_at TEXT"); } catch(e) {}
// Per-source probable-SP capture (feat/pitcher-source-discrepancy-flag).
// statsapi_*_sp written by bootstrap, rotowire_*_sp written by RotoWire
// enrichment — each column owned by one source; the other passes null
// and COALESCE in upsertGame preserves. sp_source_conflict /
// sp_source_conflict_note are recomputed each lineup-job pass via a
// separate UPDATE (q.updateSpSourceConflict) using the two raw values.
try { db.exec("ALTER TABLE game_log ADD COLUMN statsapi_away_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN statsapi_home_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN rotowire_away_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN rotowire_home_sp TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN sp_source_conflict INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN sp_source_conflict_note TEXT"); } catch(e) {}
// Kalshi-direct totals: implied "fair" total (observation-only, see
// runOddsJob's totals override block).
try { db.exec("ALTER TABLE game_log ADD COLUMN kalshi_implied_total REAL"); } catch(e) {}
// opener_override.opener_name (piece 1 of feat/opener-name-override).
// Allows a manual override to pin the OPENER's name into
// away_sp/home_sp, not just is_opener/bulk_guy. Existing override rows
// keep their existing semantics (NULL opener_name = "don't touch the
// SP slot"); new rows can optionally pin a name.
try { db.exec("ALTER TABLE opener_override ADD COLUMN opener_name TEXT"); } catch(e) {}
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

// Opener-detection columns. Phase 1 is purely additive: detectOpeners
// writes these per side after lineups are known, the API returns them,
// and the UI shows a badge — but no run-estimation code reads them yet.
// Phase 2 (behind a settings flag, separate PR) is what will actually
// change model behavior. Splitting here so a v3 cohort flip can be
// scheduled cleanly.
//   is_opener_game_{side}        — 1 when the listed SP is functioning
//                                  as an opener (FG says RP, recent
//                                  outings are short)
//   bulk_guy_{side}              — pitcher name expected to take the
//                                  bulk after the opener; null when
//                                  detection couldn't pick one
//   opener_planned_batters_{side} — typically 3-6, default 4 when no
//                                  better signal is available
//   opener_detected_at           — ISO timestamp of the most recent
//                                  detection pass for the row
try { db.exec("ALTER TABLE game_log ADD COLUMN is_opener_game_away INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN is_opener_game_home INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN bulk_guy_away TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN bulk_guy_home TEXT"); } catch(e) {}
// RotoWire's PRIM-tagged announced bulk pitcher. High-confidence signal
// preferred over identifyBulkGuy's historical-pattern scoring.
try { db.exec("ALTER TABLE game_log ADD COLUMN bulk_guy_away_announced TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN bulk_guy_home_announced TEXT"); } catch(e) {}
// SP projected IP/start from FG Depth Charts, captured at lineup-job time
// for diagnostic visibility on /api/games/<date>. processGameSignals does
// its own fresh lookup at signal-fire time via q.getPitcherProjIP, so
// these columns are observability-only — model behavior reads from the
// live lookup, not these stored values.
try { db.exec("ALTER TABLE game_log ADD COLUMN away_sp_proj_ip REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_sp_proj_ip REAL"); } catch(e) {}
// F4 SP IP-per-start forecast (Bayesian shrinkage; see services/model.js
// forecastSpIP). Diagnostic-only in this PR — the model does not yet
// consume these. PR 4 will wire them into the SP/bullpen weight split.
// Populated by runLineupJob, which builds the start index once per slate
// and forecasts for each side's SP and announced bulk pitcher. Standard
// games leave bulk columns null; opener games with PRIM-tagged bulk
// populate both. When SP is null (PRIM detected, no opener announced yet)
// the SP forecast column stays null and the model uses its existing
// bullpen-sourced fallback for the opener slot.
try { db.exec("ALTER TABLE game_log ADD COLUMN away_sp_forecast_ip REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_sp_forecast_ip REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bulk_forecast_ip REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bulk_forecast_ip REAL"); } catch(e) {}
// Opener forecasts: F4 forecast IP for the named opener pitcher in
// opener-mode games, computed with role='opener' baseline (1.35 IP =
// design weight 0.15 × 9). Only populated when bulk_guy_announced is
// set; null on regular games. Powers the opener weight in the
// upcoming opener/bulk redesign (PR B).
try { db.exec("ALTER TABLE game_log ADD COLUMN away_opener_forecast_ip REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_opener_forecast_ip REAL"); } catch(e) {}
// Bullpen wOBA persistence. Diagnostic capture of the bullpen wOBA values
// that runModel actually consumed at signal-fire time. The blended scalar
// (away/home_bullpen_woba) plus the by-hand splits (vs_l, vs_r) are written
// by processGameSignals immediately after the model UPDATE. Doesn't affect
// model behavior — purely enables future replay-style backtests at new
// settings once we accumulate enough v3+v4 cohort signals. Closes the gap
// flagged in the May 2026 calibration analysis where bullpen wOBA was
// computed in-memory and never persisted, blocking historical replay.
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bullpen_woba REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bullpen_woba REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bullpen_woba_vs_l REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bullpen_woba_vs_r REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bullpen_woba_vs_l REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bullpen_woba_vs_r REAL"); } catch(e) {}
// Catcher framing inputs persisted at processGameSignals time
// (feat/matchups-framing-impact). Stores the RAW per-game run-value
// (pre-MUTE, pre-ENABLED-gating) so the route can apply current
// settings at request time — that keeps the toggle live without
// requiring a rescore after settings flip.
// catcher_framing_state is an enum for honest empty-state display:
//   'applied'         framing rv resolved and applied
//   'no_lineup'       lineup hadn't been posted at compute time
//   'no_catcher'      lineup posted but no pos=C entry
//   'no_roster_match' catcher name didn't resolve to a roster mlb_id
//   'no_framing_data' mlb_id resolved but no 2026 or historical row
try { db.exec("ALTER TABLE game_log ADD COLUMN away_catcher_name TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_catcher_name TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_catcher_framing_rv_per_game REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_catcher_framing_rv_per_game REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_catcher_framing_state TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_catcher_framing_state TEXT"); } catch(e) {}
// PR 4 (v4 cohort): SP/bulk weights actually used in runModel. Captures
// the per-game variable weights derived from F4 forecasts, so future
// backtests can replay runModel knowing exactly which weight values fed
// the model at signal-fire time. NULL when the forecast was null (model
// fell back to fixed SP_PIT_WEIGHT — value will be SP_PIT_WEIGHT setting
// or default 0.80). bulk_weight_used is NULL except on opener-mode games
// with PRIM-tagged bulk pitchers.
try { db.exec("ALTER TABLE game_log ADD COLUMN away_sp_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_sp_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bulk_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bulk_weight_used REAL"); } catch(e) {}
// PR B (opener/bulk redesign): realized PA-weighted opener and bullpen
// weights persisted alongside bulk weight. Only populated on opener-mode
// games (is_opener_game_* = 1); null on standard games where the SP/
// bullpen split is fully described by *_sp_weight_used + its complement.
try { db.exec("ALTER TABLE game_log ADD COLUMN away_opener_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_opener_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_bullpen_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_bullpen_weight_used REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_planned_batters_away INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_planned_batters_home INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_detected_at TEXT"); } catch(e) {}

// Phase 2 shadow-mode columns. Phase 2's opener-aware run estimation is
// always computed when a side is opener-led (regardless of the
// use_opener_logic flag) and persisted here. The flag selects which
// pair (model_* vs opener_model_*) feeds getSignals — the other
// stays as the comparison shadow. Lets us watch divergence for ≥1 week
// before flipping the flag and tainting v3.
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_model_away_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_model_home_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_model_total REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN opener_model_computed_at TEXT"); } catch(e) {}

// Phase 2 follow-on: derived game_type label per side. Authoritative
// inputs are still is_opener_game_{side} + bulk_guy_{side} — this column
// is the rolled-up label that downstream model + UI read:
//   'standard'      — non-opener side (existing 75/25 SP/RP path)
//   'opener'        — opener-flagged AND a credible bulk man identified
//                     (3-way model split: 0.15/0.60/0.25)
//   'bullpen_game'  — opener-flagged but NO bulk man (true bullpen day —
//                     0.15 opener / 0.85 bullpen pool)
// Default 'standard' applies to existing rows automatically; the
// one-shot backfill below seeds the 'opener' / 'bullpen_game' labels
// for rows already detected before this PR.
try { db.exec("ALTER TABLE game_log ADD COLUMN game_type_away TEXT DEFAULT 'standard'"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN game_type_home TEXT DEFAULT 'standard'"); } catch(e) {}
try {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='game_type_backfill_done'").get();
  if (!flag) {
    const r = db.prepare(
      "UPDATE game_log SET " +
      "  game_type_away = CASE " +
      "    WHEN is_opener_game_away = 1 AND bulk_guy_away IS NOT NULL THEN 'opener' " +
      "    WHEN is_opener_game_away = 1 AND bulk_guy_away IS NULL     THEN 'bullpen_game' " +
      "    ELSE 'standard' END, " +
      "  game_type_home = CASE " +
      "    WHEN is_opener_game_home = 1 AND bulk_guy_home IS NOT NULL THEN 'opener' " +
      "    WHEN is_opener_game_home = 1 AND bulk_guy_home IS NULL     THEN 'bullpen_game' " +
      "    ELSE 'standard' END"
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('game_type_backfill_done', datetime('now'))"
    ).run();
    console.log('[migration] game_type backfill: updated ' + r.changes + ' rows');
  }
} catch (e) {
  console.warn('[migration] game_type backfill failed (non-fatal): ' + e.message);
}

// Runline spread ingest (Step 1 of 3). Pure data layer — Step 2 will
// snapshot these onto bet_signals at fire time, Step 3 will surface
// runline ROI in the backtest tab. No model logic touches these
// columns yet.
//   market_{away,home}_spread        — signed REAL, almost always
//                                      ±1.5 for MLB runline (away
//                                      negative when favorite, etc.)
//   market_{away,home}_spread_price  — INTEGER American odds (e.g.
//                                      -140, +120). Treats 0 as null
//                                      via the cleanup at write site.
//   market_{away,home}_spread_quality — 'fresh' / 'stale' / null,
//                                      matches the per-field freshness
//                                      pattern used elsewhere.
//   market_spread_src                — source string (e.g. 'kalshi'),
//                                      mirrors ml_source / total_source.
try { db.exec("ALTER TABLE game_log ADD COLUMN market_away_spread REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_home_spread REAL"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_away_spread_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_home_spread_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_away_spread_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_home_spread_quality TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN market_spread_src TEXT"); } catch(e) {}

// One-shot Phase 2 flag flip. Sets use_opener_logic='true' (string;
// getSettings coerces to boolean) and stamps opener_logic_enabled_at
// with the wall-clock when the flip happened — that timestamp doubles
// as the idempotency marker. Subsequent deploys see a non-null
// timestamp and skip; user toggles via /api/settings persist across
// deploys (this won't override 'false' once a user has set it).
//
// Marks the v3 cohort taint boundary: opener-led games before the
// timestamp ran on the standard model; after, they run on the
// opener-aware path. Useful for future "ROI on opener-led games
// before vs after this deploy" analysis.
try {
  const enabledAt = db.prepare(
    "SELECT value FROM app_settings WHERE key='opener_logic_enabled_at'"
  ).get();
  if (!enabledAt) {
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('use_opener_logic', 'true') " +
      "ON CONFLICT(key) DO UPDATE SET value='true'"
    ).run();
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('opener_logic_enabled_at', datetime('now'))"
    ).run();
    console.log('[settings] use_opener_logic flipped to true on deploy at ' + new Date().toISOString());
  }
} catch (e) {
  console.warn('[migration] opener-logic flip failed (non-fatal): ' + e.message);
}

// pitcher_game_log richer capture (PR A of bulk-guy heuristic refinement).
// Statsapi's boxscore exposes innings, batters faced, and a gameStarted
// flag — we previously stored only pitches_thrown. The new columns let
// PR B's scored ranking distinguish "long relief 4+ IP" (bulk-guy
// signature) from "5-day rotation 6+ IP" (regular SP signature).
//   innings_pitched — REAL (parsed from "6.1" → 6.333... etc)
//   batters_faced   — INTEGER
//   was_starter     — 0/1 (statsapi's pitching.gamesStarted)
//   outing_type     — derived: 'start' (was_starter=1),
//                     'long_relief' (was_starter=0 AND IP >= 3),
//                     'short_relief' (otherwise). Stored so callers can
//                     filter without re-deriving on every read.
// No model behavior change in this PR — purely capture. PR B will
// consume these columns.
try { db.exec("ALTER TABLE pitcher_game_log ADD COLUMN innings_pitched REAL"); } catch(e) {}
try { db.exec("ALTER TABLE pitcher_game_log ADD COLUMN batters_faced INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE pitcher_game_log ADD COLUMN was_starter INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE pitcher_game_log ADD COLUMN outing_type TEXT"); } catch(e) {}
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

// v4 cohort backfill: PR 4 (v4 SP weight modulation) merged 2026-05-12.
// Signals on or after that date should be tagged v4, not v3. Catches any
// signals that fired between PR 4 merge and the jobs.js cohort-tagging
// fix (the tagging code wasn't updated when PR 4 merged — about 24-48
// hours of signals were stamped v3 by mistake). Idempotent: subsequent
// boots update 0 rows because new signals are tagged v4 directly.
try { db.exec("UPDATE bet_signals SET cohort='v4' WHERE cohort='v3' AND game_date >= '2026-05-12'"); } catch(e) {}

// v5 cohort backfill: wOBA blend retuned from 0.70/0.30 to 0.45/0.55 on
// 2026-05-20. Signals on or after that date belong to v5. NOTE: the
// blend only actually changed mid-day 2026-05-20, so any 5/20 signals
// fired that morning under the old blend must be RE-FIRED at the new
// blend (via lineup-job rescore) for this tag to be accurate — the
// re-fire is the source of truth, this UPDATE just keeps the tag
// consistent. Idempotent: subsequent boots update 0 rows because new
// signals are tagged v5 directly by jobs.js.
try { db.exec("UPDATE bet_signals SET cohort='v5' WHERE cohort='v4' AND game_date >= '2026-05-20'"); } catch(e) {}

// Runline companion capture (Step 2 of 3 in runline workstream).
// ML signals snapshot the spread (-1.5 / +1.5) line + price + source
// at fire time, then get graded against the eventual game result so
// we can compare ML signal ROI against the corresponding runline bet.
// Total signals leave these null (Step 1 ingest is intentionally
// ML-companion only). Forward-only — historical ML signals fired
// before this PR have no captured spread data and stay null.
//   companion_spread_line     — REAL, ±1.5 from the side's perspective
//   companion_spread_price    — INTEGER American odds, e.g. -140
//   companion_spread_outcome  — 'win' / 'loss' / 'pending'  (no push
//                                possible on ±1.5 in MLB)
//   companion_spread_pnl      — REAL, $100-to-win basis (matches the
//                                existing pnl column convention)
//   companion_spread_src      — TEXT, source string copied from
//                                game_log.market_spread_src at fire
try { db.exec("ALTER TABLE bet_signals ADD COLUMN companion_spread_line REAL"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN companion_spread_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN companion_spread_outcome TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN companion_spread_pnl REAL"); } catch(e) {}
try { db.exec("ALTER TABLE bet_signals ADD COLUMN companion_spread_src TEXT"); } catch(e) {}
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

// empirical_spread_outcomes — feat/empirical-spread-plus-run upgrade.
// Existing deploys created the table under the prior commit's schema
// without `side` / `pair_id` and with a PK that didn't include side.
// SQLite can't ALTER a PRIMARY KEY in-place, so this block detects an
// old shape (column `side` missing) and does a one-time rename →
// recreate → copy. New deploys hit the CREATE TABLE IF NOT EXISTS
// above directly and skip this block entirely.
//
// Old rows materialize as side='lay' (the only kind the prior code
// produced) with pair_id=NULL. Backfilling pair_id retroactively
// would require re-joining game_log + kalshi_spread_markets per row;
// not worth it because pair_id is only consumed by NEW signal
// generation downstream — the historical rows that were already
// graded don't need pairing.
try {
  const cols = db.prepare("PRAGMA table_info(empirical_spread_outcomes)").all();
  const hasSide = cols.some(c => c.name === 'side');
  if (cols.length && !hasSide) {
    db.exec(`
      ALTER TABLE empirical_spread_outcomes RENAME TO empirical_spread_outcomes_old;
      CREATE TABLE empirical_spread_outcomes (
        game_date TEXT NOT NULL,
        game_id TEXT NOT NULL,
        spread_team TEXT NOT NULL,
        spread_line REAL NOT NULL,
        side TEXT NOT NULL DEFAULT 'lay',
        pair_id TEXT,
        yes_ask_ml INTEGER NOT NULL,
        edge_pp REAL NOT NULL,
        cell_sample_size INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        actual_margin INTEGER,
        outcome TEXT,
        pnl_per_100 REAL,
        graded_at TEXT,
        PRIMARY KEY (game_date, game_id, spread_team, spread_line, side, generated_at)
      );
      INSERT INTO empirical_spread_outcomes
        (game_date, game_id, spread_team, spread_line, side, pair_id,
         yes_ask_ml, edge_pp, cell_sample_size, generated_at,
         actual_margin, outcome, pnl_per_100, graded_at)
      SELECT
         game_date, game_id, spread_team, spread_line, 'lay', NULL,
         yes_ask_ml, edge_pp, cell_sample_size, generated_at,
         actual_margin, outcome, pnl_per_100, graded_at
        FROM empirical_spread_outcomes_old;
      DROP TABLE empirical_spread_outcomes_old;
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_date     ON empirical_spread_outcomes (game_date);
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_ungraded ON empirical_spread_outcomes (game_date) WHERE outcome IS NULL;
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_pair     ON empirical_spread_outcomes (pair_id);
    `);
    console.log('[schema] migrated empirical_spread_outcomes to side/pair_id PK shape');
  }
} catch(e) { console.error('[schema] empirical_spread_outcomes migration failed:', e.message); }

// pair_id index. Created here (after the migration block) so it works
// uniformly on fresh deploys (table created with pair_id by the main
// CREATE TABLE block) AND on upgraded deploys (table migrated above).
try { db.exec("CREATE INDEX IF NOT EXISTS idx_emp_outcome_pair ON empirical_spread_outcomes (pair_id)"); } catch(e) {}

// empirical_spread_signals + empirical_spread_outcomes —
// feat/empirical-spread-projected-track upgrade. Adds capture_track
// to both tables and extends each PK to include it, so a 'morning'
// and 'gametime' row for the same game/line/side coexist without
// collision. Existing rows default to 'gametime'.
//
// Same rename → recreate → copy pattern as the side/pair_id
// migration above (SQLite can't ALTER a PK). Fresh deploys skip
// both blocks since the CREATE TABLE statements at the top of the
// file already include capture_track.
try {
  const sigCols = db.prepare("PRAGMA table_info(empirical_spread_signals)").all();
  const sigHas = sigCols.some(c => c.name === 'capture_track');
  if (sigCols.length && !sigHas) {
    db.exec(`
      ALTER TABLE empirical_spread_signals RENAME TO empirical_spread_signals_old;
      CREATE TABLE empirical_spread_signals (
        game_date TEXT NOT NULL,
        game_id TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        capture_track TEXT NOT NULL DEFAULT 'gametime',
        model_total REAL,
        model_no_vig_home_prob REAL,
        cell_label TEXT,
        cell_sample_size INTEGER,
        predictions_json TEXT,
        top_edge_team TEXT,
        top_edge_line REAL,
        top_edge_yes_ask_ml INTEGER,
        top_edge_pp REAL,
        PRIMARY KEY (game_date, game_id, capture_track, generated_at)
      );
      INSERT INTO empirical_spread_signals
        (game_date, game_id, generated_at, capture_track,
         model_total, model_no_vig_home_prob, cell_label, cell_sample_size,
         predictions_json, top_edge_team, top_edge_line,
         top_edge_yes_ask_ml, top_edge_pp)
      SELECT
         game_date, game_id, generated_at, 'gametime',
         model_total, model_no_vig_home_prob, cell_label, cell_sample_size,
         predictions_json, top_edge_team, top_edge_line,
         top_edge_yes_ask_ml, top_edge_pp
        FROM empirical_spread_signals_old;
      DROP TABLE empirical_spread_signals_old;
      CREATE INDEX IF NOT EXISTS idx_emp_spread_date ON empirical_spread_signals (game_date);
      CREATE INDEX IF NOT EXISTS idx_emp_spread_edge ON empirical_spread_signals (top_edge_pp DESC);
    `);
    console.log('[schema] migrated empirical_spread_signals to capture_track PK shape');
  }
} catch(e) { console.error('[schema] empirical_spread_signals capture_track migration failed:', e.message); }

try {
  const outCols = db.prepare("PRAGMA table_info(empirical_spread_outcomes)").all();
  const outHas = outCols.some(c => c.name === 'capture_track');
  if (outCols.length && !outHas) {
    db.exec(`
      ALTER TABLE empirical_spread_outcomes RENAME TO empirical_spread_outcomes_old2;
      CREATE TABLE empirical_spread_outcomes (
        game_date TEXT NOT NULL,
        game_id TEXT NOT NULL,
        spread_team TEXT NOT NULL,
        spread_line REAL NOT NULL,
        side TEXT NOT NULL DEFAULT 'lay',
        capture_track TEXT NOT NULL DEFAULT 'gametime',
        pair_id TEXT,
        yes_ask_ml INTEGER NOT NULL,
        edge_pp REAL NOT NULL,
        cell_sample_size INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        actual_margin INTEGER,
        outcome TEXT,
        pnl_per_100 REAL,
        graded_at TEXT,
        PRIMARY KEY (game_date, game_id, spread_team, spread_line, side, capture_track, generated_at)
      );
      INSERT INTO empirical_spread_outcomes
        (game_date, game_id, spread_team, spread_line, side, capture_track,
         pair_id, yes_ask_ml, edge_pp, cell_sample_size, generated_at,
         actual_margin, outcome, pnl_per_100, graded_at)
      SELECT
         game_date, game_id, spread_team, spread_line, side, 'gametime',
         pair_id, yes_ask_ml, edge_pp, cell_sample_size, generated_at,
         actual_margin, outcome, pnl_per_100, graded_at
        FROM empirical_spread_outcomes_old2;
      DROP TABLE empirical_spread_outcomes_old2;
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_date     ON empirical_spread_outcomes (game_date);
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_ungraded ON empirical_spread_outcomes (game_date) WHERE outcome IS NULL;
      CREATE INDEX IF NOT EXISTS idx_emp_outcome_pair     ON empirical_spread_outcomes (pair_id);
    `);
    console.log('[schema] migrated empirical_spread_outcomes to capture_track PK shape');
  }
} catch(e) { console.error('[schema] empirical_spread_outcomes capture_track migration failed:', e.message); }

// morning_capture_state. Idempotent for fresh deploys via the main
// CREATE TABLE block; an explicit ensure here is harmless and keeps
// the table guaranteed-present even if an old migration ever truncated
// the main block on partial upgrade.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS morning_capture_state (
    game_date TEXT PRIMARY KEY,
    opened_at TEXT NOT NULL
  )`);
} catch(e) {}

// One-shot TZ-cutover cleanup for fix/morning-capture-tz-anchor.
//
// Before this fix, morning_capture_state.opened_at and
// empirical_spread_signals/_outcomes.generated_at were stored as UTC
// via new Date().toISOString().slice(...) instead of PT. After the
// fix, all new writes are PT-anchored via services/jobs.js nowPtIso().
//
// Two pieces of cleanup must run exactly once after this fix lands:
//
//   1. DELETE morning_capture_state for 2026-06-08. The single row
//      was UTC-stamped (~21:02 instead of 14:02 PT). Removing it lets
//      the next morning-capture invocation re-set opened_at PT-clean
//      via its existing INSERT OR IGNORE.
//
//   2. DELETE today's (2026-06-08) capture_track='gametime' rows from
//      both empirical tables. Today's UTC-stamped gametime rows for
//      game_date='2026-06-08' have generated_at strings like
//      "2026-06-08 18:00:XX" (= 11AM PT). The slate's
//      MAX(generated_at) comparator would let those UTC strings OUT-
//      SORT post-fix PT writes at 3PM/5PM PT ("2026-06-08 15:00:XX"
//      and "2026-06-08 17:00:XX"), so the slate would freeze on the
//      11AM PT capture for the rest of today's slate window. Dropping
//      them lets the 3PM/5PM PT-stamped gametime rows surface cleanly.
//
// Morning rows for 2026-06-09 (the locked first-eligible from the
// 14:02 PT manual trigger today) are PRESERVED — they have correct
// prices, the lock semantics are unaffected by the timestamp format
// (existsMorningSignalForGame ignores generated_at), and rewriting
// PK-component generated_at values is the precise risk we're avoiding.
//
// Idempotent via the app_settings flag. The condition checks for the
// table existing first so a fresh deploy that's never seen the old
// schema doesn't trip on the morning_capture_state lookup.
try {
  const flag = db.prepare("SELECT value FROM app_settings WHERE key='tz_cutover_2026_06_08'").get();
  if (!flag) {
    let deletedState = 0, deletedSig = 0, deletedOut = 0;
    try {
      deletedState = db.prepare("DELETE FROM morning_capture_state WHERE game_date='2026-06-08'").run().changes;
    } catch(e) { console.warn('[migration] tz cutover state DELETE skipped:', e.message); }
    try {
      deletedSig = db.prepare("DELETE FROM empirical_spread_signals WHERE game_date='2026-06-08' AND capture_track='gametime'").run().changes;
    } catch(e) { console.warn('[migration] tz cutover signals DELETE skipped:', e.message); }
    try {
      deletedOut = db.prepare("DELETE FROM empirical_spread_outcomes WHERE game_date='2026-06-08' AND capture_track='gametime'").run().changes;
    } catch(e) { console.warn('[migration] tz cutover outcomes DELETE skipped:', e.message); }
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('tz_cutover_2026_06_08', datetime('now'))").run();
    console.log('[migration] tz cutover cleanup: morning_state=' + deletedState
      + ', gametime sigs=' + deletedSig + ', gametime outcomes=' + deletedOut
      + ' (game_date=2026-06-08); morning rows preserved');
  }
} catch (e) {
  console.warn('[migration] tz cutover cleanup failed (non-fatal): ' + e.message);
}

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
      statsapi_away_sp, statsapi_home_sp,
      rotowire_away_sp, rotowire_home_sp,
      bulk_guy_away_announced, bulk_guy_home_announced,
      away_sp_proj_ip, home_sp_proj_ip,
      away_sp_forecast_ip, home_sp_forecast_ip,
      away_bulk_forecast_ip, home_bulk_forecast_ip,
      away_opener_forecast_ip, home_opener_forecast_ip,
      market_away_ml, market_home_ml, market_total, park_factor,
      model_away_ml, model_home_ml, model_total, lineup_source,
      venue_id, venue_name, game_number, game_pk, updated_at
    ) VALUES (
      @game_date, @game_id, @away_team, @home_team, @game_time,
      @away_sp, @away_sp_hand, @home_sp, @home_sp_hand,
      @statsapi_away_sp, @statsapi_home_sp,
      @rotowire_away_sp, @rotowire_home_sp,
      @bulk_guy_away_announced, @bulk_guy_home_announced,
      @away_sp_proj_ip, @home_sp_proj_ip,
      @away_sp_forecast_ip, @home_sp_forecast_ip,
      @away_bulk_forecast_ip, @home_bulk_forecast_ip,
      @away_opener_forecast_ip, @home_opener_forecast_ip,
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
      -- Per-source SP capture. Each source-owned column COALESCEs against
      -- itself so the writer for the OTHER source (passing null here) does
      -- not wipe a previously-captured value. Bootstrap writes statsapi_*;
      -- RotoWire enrichment writes rotowire_*; neither touches the other.
      statsapi_away_sp = COALESCE(excluded.statsapi_away_sp, game_log.statsapi_away_sp),
      statsapi_home_sp = COALESCE(excluded.statsapi_home_sp, game_log.statsapi_home_sp),
      rotowire_away_sp = COALESCE(excluded.rotowire_away_sp, game_log.rotowire_away_sp),
      rotowire_home_sp = COALESCE(excluded.rotowire_home_sp, game_log.rotowire_home_sp),
      -- COALESCE bulk_guy_*_announced so a RotoWire upsert without a PRIM
      -- tag doesn't wipe a previously-captured announced bulk. RotoWire is
      -- the only writer of these fields; statsapi never sets them.
      bulk_guy_away_announced = COALESCE(excluded.bulk_guy_away_announced, game_log.bulk_guy_away_announced),
      bulk_guy_home_announced = COALESCE(excluded.bulk_guy_home_announced, game_log.bulk_guy_home_announced),
      -- COALESCE proj_ip so a non-lineup upsert (statsapi bootstrap) doesn't
      -- wipe the value the lineup-job already captured. The lineup-job is
      -- the only path that looks these up; everyone else passes null.
      away_sp_proj_ip = COALESCE(excluded.away_sp_proj_ip, game_log.away_sp_proj_ip),
      home_sp_proj_ip = COALESCE(excluded.home_sp_proj_ip, game_log.home_sp_proj_ip),
      -- COALESCE forecast_ip for the same reason as proj_ip: only the
      -- lineup-job computes these. A statsapi-bootstrap upsert passes
      -- null and must not wipe the lineup-job's value.
      away_sp_forecast_ip = COALESCE(excluded.away_sp_forecast_ip, game_log.away_sp_forecast_ip),
      home_sp_forecast_ip = COALESCE(excluded.home_sp_forecast_ip, game_log.home_sp_forecast_ip),
      away_bulk_forecast_ip = COALESCE(excluded.away_bulk_forecast_ip, game_log.away_bulk_forecast_ip),
      home_bulk_forecast_ip = COALESCE(excluded.home_bulk_forecast_ip, game_log.home_bulk_forecast_ip),
      -- Opener forecasts: same COALESCE pattern. Populated only by
      -- lineup-job when an opener game is detected (bulk_guy announced).
      away_opener_forecast_ip = COALESCE(excluded.away_opener_forecast_ip, game_log.away_opener_forecast_ip),
      home_opener_forecast_ip = COALESCE(excluded.home_opener_forecast_ip, game_log.home_opener_forecast_ip),
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
  // Recomputed each lineup-job pass: compares statsapi_*_sp vs
  // rotowire_*_sp (after both sources have written their raw values)
  // and persists the result. Caller owns the comparison + normalization;
  // this statement just writes the boolean flag + note. Note text is
  // null when flag is 0 (cleared on every pass so a resolved conflict
  // doesn't leave a stale note behind).
  updateSpSourceConflict: db.prepare(`
    UPDATE game_log SET
      sp_source_conflict = @sp_source_conflict,
      sp_source_conflict_note = @sp_source_conflict_note,
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
      category, market_line, model_line, edge_pct, outcome, pnl, cohort,
      companion_spread_line, companion_spread_price, companion_spread_outcome,
      companion_spread_pnl, companion_spread_src
    ) VALUES (
      @game_log_id, @game_date, @game_id, @signal_type, @signal_side, @signal_label,
      @category, @market_line, @model_line, @edge_pct, @outcome, @pnl, @cohort,
      @companion_spread_line, @companion_spread_price, @companion_spread_outcome,
      @companion_spread_pnl, @companion_spread_src
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
// Parameter-sweep run helpers (feat/totals-sweep-async). POST handler
// inserts a 'running' row, the background closure transitions it to
// 'done' (with results_json) or 'error' (with error column). All
// timestamps are PT via services/jobs.js nowPtIso() — matches the
// morning-capture / empirical-spread convention from
// fix/morning-capture-tz-anchor.
q.insertParameterSweepRun = db.prepare(
  "INSERT INTO parameter_sweep_runs (run_id, status, params_json, started_at) "
  + "VALUES (?, 'running', ?, ?)"
);
q.updateParameterSweepRunDone = db.prepare(
  "UPDATE parameter_sweep_runs SET status='done', results_json=?, finished_at=? WHERE run_id=?"
);
q.updateParameterSweepRunError = db.prepare(
  "UPDATE parameter_sweep_runs SET status='error', error=?, finished_at=? WHERE run_id=?"
);
q.getParameterSweepRun = db.prepare(
  "SELECT * FROM parameter_sweep_runs WHERE run_id=?"
);
q.getLatestParameterSweepRun = db.prepare(
  "SELECT * FROM parameter_sweep_runs ORDER BY started_at DESC LIMIT 1"
);
// In-flight dedupe + boot-time orphan cleanup. Only one sweep can run
// at a time on Render's single instance (event-loop contention pegs
// concurrent runs and was the likely cause of the HTTP 000 polls in
// fix/sweep-runaway-loop). At process boot, any row still marked
// 'running' is by definition an orphan from a prior crash/restart, so
// we mark it 'error' with an abandonment message before serving any
// /admin/parameter-sweep traffic.
q.getRunningParameterSweepRuns = db.prepare(
  "SELECT run_id, params_json, started_at FROM parameter_sweep_runs WHERE status='running'"
);
q.markParameterSweepRunAbandoned = db.prepare(
  "UPDATE parameter_sweep_runs SET status='error', error=?, finished_at=? WHERE run_id=? AND status='running'"
);

q.upsertRoster = db.prepare(`INSERT INTO team_rosters (team,player_name,mlb_id,role,hand,position,updated_at)
  VALUES (?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(team,player_name) DO UPDATE SET
    mlb_id=excluded.mlb_id, role=excluded.role, hand=excluded.hand, position=excluded.position, updated_at=excluded.updated_at`);
q.clearRoster  = db.prepare("DELETE FROM team_rosters WHERE team=?");
q.getRoster    = db.prepare("SELECT player_name,role,hand FROM team_rosters WHERE team=?");

// Season roster (statsapi rosterType=fullSeason) — used by
// resolveBacktestMlbId only. Same writer/reader shape as the active
// roster so the resolver can match identically.
q.upsertSeasonRoster = db.prepare(`INSERT INTO team_rosters_season (team,player_name,mlb_id,role,hand,position,updated_at)
  VALUES (?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(team,player_name) DO UPDATE SET
    mlb_id=excluded.mlb_id, role=excluded.role, hand=excluded.hand, position=excluded.position, updated_at=excluded.updated_at`);
q.clearSeasonRoster = db.prepare("DELETE FROM team_rosters_season WHERE team=?");
q.getSeasonPositionPlayers = db.prepare(
  "SELECT player_name, mlb_id, position FROM team_rosters_season WHERE team=? AND role='POS'"
);

// Catcher framing: upsert (for the Savant ingest, built later), point
// lookup by mlb_id, and a name→mlb_id bridge through team_rosters so a
// lineup catcher (RotoWire "First Last" name, no id) resolves to the
// Savant-keyed framing row. getFramingByCatcherName joins on team+name.
q.upsertCatcherFraming = db.prepare(
  "INSERT INTO catcher_framing (mlb_id,name,rv_tot,pitches,updated_at) " +
  "VALUES (?,?,?,?,datetime('now')) " +
  "ON CONFLICT(mlb_id) DO UPDATE SET " +
  "  name=excluded.name, rv_tot=excluded.rv_tot, pitches=excluded.pitches, updated_at=excluded.updated_at"
);
q.getCatcherFramingById = db.prepare("SELECT mlb_id,name,rv_tot,pitches FROM catcher_framing WHERE mlb_id=?");
// Full scan of catcher_framing — used as a fallback in
// resolveCatcherMlbId when the team_rosters lookup misses. Small
// table (~60 rows / season) so the linear scan in JS is cheap; the
// SQL only needs to surface name + mlb_id.
q.getAllCatcherFramingNames = db.prepare("SELECT mlb_id, name FROM catcher_framing");
q.getAllCatcherFramingHistNames = db.prepare("SELECT mlb_id, name FROM catcher_framing_historical");
q.getFramingByCatcherName = db.prepare(
  "SELECT cf.mlb_id, cf.rv_tot, cf.pitches FROM team_rosters tr " +
  "JOIN catcher_framing cf ON cf.mlb_id = tr.mlb_id " +
  "WHERE tr.team=? AND tr.player_name=?"
);
q.listCatcherFraming = db.prepare("SELECT mlb_id,name,rv_tot,pitches,updated_at FROM catcher_framing ORDER BY rv_tot DESC");
q.upsertCatcherFramingHist = db.prepare(
  "INSERT INTO catcher_framing_historical (mlb_id,name,rv_tot,pitches,season_start,season_end,updated_at) " +
  "VALUES (?,?,?,?,?,?,datetime('now')) " +
  "ON CONFLICT(mlb_id) DO UPDATE SET " +
  "  name=excluded.name, rv_tot=excluded.rv_tot, pitches=excluded.pitches, " +
  "  season_start=excluded.season_start, season_end=excluded.season_end, updated_at=excluded.updated_at"
);
q.getCatcherFramingHistById = db.prepare("SELECT mlb_id,name,rv_tot,pitches FROM catcher_framing_historical WHERE mlb_id=?");
q.listCatcherFramingHist = db.prepare("SELECT mlb_id,name,rv_tot,pitches,season_start,season_end,updated_at FROM catcher_framing_historical ORDER BY rv_tot DESC");
q.upsertFieldingFrv = db.prepare(
  "INSERT INTO fielding_frv (mlb_id,name,total_runs,outs_total,position,season_start,season_end,updated_at) " +
  "VALUES (?,?,?,?,?,?,?,datetime('now')) " +
  "ON CONFLICT(mlb_id) DO UPDATE SET " +
  "  name=excluded.name, total_runs=excluded.total_runs, outs_total=excluded.outs_total, " +
  "  position=excluded.position, season_start=excluded.season_start, season_end=excluded.season_end, updated_at=excluded.updated_at"
);
q.getFieldingFrvById = db.prepare("SELECT mlb_id,name,total_runs,outs_total,position,season_start,season_end FROM fielding_frv WHERE mlb_id=?");
q.listFieldingFrv = db.prepare("SELECT mlb_id,name,total_runs,outs_total,position,season_start,season_end,updated_at FROM fielding_frv ORDER BY total_runs DESC");
// Position players for a team (for the abbreviated-lineup-name → mlb_id
// resolver). Returns full names + ids; JS does accent-folded initial+last
// matching since SQLite LIKE won't fold accents reliably.
q.getPositionPlayers = db.prepare("SELECT player_name, mlb_id, position FROM team_rosters WHERE team=? AND role='POS'");

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

// Pitcher wOBA override CRUD. Used to patch obviously-wrong FG
// projections (e.g. stale RoS data the projection refresh hasn't
// fixed yet). Active overrides are applied inside getWobaIndex().
q.setWobaOverride = db.prepare(
  "INSERT INTO pitcher_woba_override (player_name, vs_hand, woba, set_at, reason) " +
  "VALUES (?, ?, ?, datetime('now'), ?) " +
  "ON CONFLICT(player_name, vs_hand) DO UPDATE SET " +
  "  woba=excluded.woba, set_at=excluded.set_at, reason=excluded.reason"
);
q.deleteWobaOverride = db.prepare("DELETE FROM pitcher_woba_override WHERE player_name=? AND vs_hand=?");
q.listWobaOverrides  = db.prepare("SELECT * FROM pitcher_woba_override ORDER BY set_at DESC");

q.setOpenerOverride = db.prepare(
  "INSERT INTO opener_override (game_date, game_id, side, is_opener, bulk_guy, opener_name, planned_batters, set_at, set_by, reason) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?) " +
  "ON CONFLICT(game_date, game_id, side) DO UPDATE SET " +
  "  is_opener=excluded.is_opener, bulk_guy=excluded.bulk_guy, " +
  "  opener_name=excluded.opener_name, " +
  "  planned_batters=excluded.planned_batters, set_at=excluded.set_at, " +
  "  set_by=excluded.set_by, reason=excluded.reason"
);
q.deleteOpenerOverride = db.prepare(
  "DELETE FROM opener_override WHERE game_date=? AND game_id=? AND side=?"
);
q.getOpenerOverride = db.prepare(
  "SELECT * FROM opener_override WHERE game_date=? AND game_id=? AND side=?"
);
q.listOpenerOverridesByDate = db.prepare(
  "SELECT * FROM opener_override WHERE game_date=? ORDER BY game_id, side"
);

// Manual lineup override (feat/lineup-override-backend). Mirrors the
// opener_override CRUD shape — same key (game_date, game_id, side),
// same upsert/get/delete/list-by-date set. Applied at runLineupJob
// write time only while the side's incoming status is 'projected'.
q.setLineupOverride = db.prepare(
  "INSERT INTO lineup_override (game_date, game_id, side, lineup_json, set_at, set_by, reason) " +
  "VALUES (?, ?, ?, ?, datetime('now'), ?, ?) " +
  "ON CONFLICT(game_date, game_id, side) DO UPDATE SET " +
  "  lineup_json=excluded.lineup_json, set_at=excluded.set_at, " +
  "  set_by=excluded.set_by, reason=excluded.reason"
);
q.deleteLineupOverride = db.prepare(
  "DELETE FROM lineup_override WHERE game_date=? AND game_id=? AND side=?"
);
q.getLineupOverride = db.prepare(
  "SELECT * FROM lineup_override WHERE game_date=? AND game_id=? AND side=?"
);
q.listLineupOverridesByDate = db.prepare(
  "SELECT * FROM lineup_override WHERE game_date=? ORDER BY game_id, side"
);

// 10 positional args: game_date, team, pitcher_name, pitcher_mlb_id,
// pitches_thrown, innings_pitched, batters_faced, was_starter,
// outing_type, appeared. INSERT OR REPLACE on the (game_date, team,
// pitcher_name) unique index — re-running fetchPitcherUsage for a date
// overwrites any partial row cleanly.
q.upsertPitcherGameLog = db.prepare(
  `INSERT OR REPLACE INTO pitcher_game_log
   (game_date, team, pitcher_name, pitcher_mlb_id, pitches_thrown,
    innings_pitched, batters_faced, was_starter, outing_type,
    appeared, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
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

// Daily wOBA snapshot helpers (date-accurate backtest support).
q._snapClearKeyDate = db.prepare("DELETE FROM woba_data_snapshot WHERE snapshot_date=? AND data_key=?");
q._snapInsert = db.prepare(
  "INSERT OR REPLACE INTO woba_data_snapshot (snapshot_date, data_key, player_name, woba, sample_size) VALUES (?,?,?,?,?)"
);
// Snapshot one key's rows for a given date. Clears any existing rows for
// (date,key) first so a same-day re-refresh replaces rather than appends.
// rows are the same expandedRows passed to upsertWobaBatch (name/woba/sample).
q.snapshotWobaKey = (snapshotDate, key, rows) => {
  const tx = db.transaction((d, k, rs) => {
    q._snapClearKeyDate.run(d, k);
    for (const r of rs) q._snapInsert.run(d, k, r.name, r.woba, r.sample || 0);
  });
  tx(snapshotDate, key, rows);
};
// List distinct snapshot dates (descending). For diagnostics / coverage checks.
q.getSnapshotDates = db.prepare(
  "SELECT snapshot_date, COUNT(DISTINCT data_key) AS keys, COUNT(*) AS rows " +
  "FROM woba_data_snapshot GROUP BY snapshot_date ORDER BY snapshot_date DESC"
);
// Resolve the latest snapshot_date that is on or before the requested date.
q.getSnapshotDateAsOf = db.prepare(
  "SELECT MAX(snapshot_date) AS d FROM woba_data_snapshot WHERE snapshot_date <= ?"
);
// Load all rows for a specific snapshot_date.
q.loadSnapshotRows = db.prepare(
  "SELECT data_key, player_name, woba, sample_size FROM woba_data_snapshot WHERE snapshot_date=?"
);

// ------------------------------------------------------------------
// Daily catcher_framing snapshot helpers. Mirror the wOBA pattern:
// DELETE the (snapshot_date) bucket first so a same-day re-run starts
// clean — this matters when rows DROP from the source between runs
// (a player removed from the leaderboard). Then INSERT OR REPLACE
// every current row keyed by (snapshot_date, mlb_id).
q._snapFramingClearDate = db.prepare(
  "DELETE FROM catcher_framing_snapshot WHERE snapshot_date=?"
);
q._snapFramingInsert = db.prepare(
  "INSERT OR REPLACE INTO catcher_framing_snapshot "
  + "(snapshot_date, mlb_id, name, rv_tot, pitches) VALUES (?,?,?,?,?)"
);
// rows are catcher_framing rows ({mlb_id, name, rv_tot, pitches}).
// Wrapped in a single transaction so the snapshot is all-or-nothing.
q.snapshotCatcherFraming = (snapshotDate, rows) => {
  const tx = db.transaction((d, rs) => {
    q._snapFramingClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.mlb_id == null) continue;
      q._snapFramingInsert.run(d, r.mlb_id, r.name || null,
        r.rv_tot == null ? null : Number(r.rv_tot),
        r.pitches == null ? null : Number(r.pitches));
    }
  });
  tx(snapshotDate, rows);
};

// ------------------------------------------------------------------
// Daily fielding_frv snapshot helpers. PK is (date, mlb_id, position)
// because a multi-position player carries multiple source rows. Same
// delete-then-insert idempotency model as the framing helper.
q._snapFrvClearDate = db.prepare(
  "DELETE FROM fielding_frv_snapshot WHERE snapshot_date=?"
);
q._snapFrvInsert = db.prepare(
  "INSERT OR REPLACE INTO fielding_frv_snapshot "
  + "(snapshot_date, mlb_id, name, total_runs, outs_total, position, season_start, season_end) "
  + "VALUES (?,?,?,?,?,?,?,?)"
);
// rows are fielding_frv rows ({mlb_id, name, total_runs, outs_total,
// position, season_start, season_end}). position is required for PK;
// rows missing it are skipped (they couldn't satisfy the constraint).
q.snapshotFieldingFrv = (snapshotDate, rows) => {
  const tx = db.transaction((d, rs) => {
    q._snapFrvClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.mlb_id == null || r.position == null) continue;
      q._snapFrvInsert.run(d, r.mlb_id, r.name || null,
        r.total_runs == null ? null : Number(r.total_runs),
        r.outs_total == null ? null : Number(r.outs_total),
        r.position,
        r.season_start == null ? null : String(r.season_start),
        r.season_end == null ? null : String(r.season_end));
    }
  });
  tx(snapshotDate, rows);
};

// ------------------------------------------------------------------
// Team baserunning helpers. team_baserunning is the live snapshot
// (one row per (season, team), latest values), team_baserunning_snapshot
// preserves daily history keyed by snapshot_date for forward-honest
// backtests. Same delete-then-insert idempotency on the snapshot side
// as framing/FRV.
q._upsertTeamBaserunning = db.prepare(
  "INSERT INTO team_baserunning "
  + "(season, team, bsr, ubr, wsb, wgdp, sb, cs, g, refreshed_at) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?) "
  + "ON CONFLICT(season, team) DO UPDATE SET "
  + "bsr=excluded.bsr, ubr=excluded.ubr, wsb=excluded.wsb, wgdp=excluded.wgdp, "
  + "sb=excluded.sb, cs=excluded.cs, g=excluded.g, refreshed_at=excluded.refreshed_at"
);
// rows are [{team, bsr, ubr, wsb, wgdp, sb, cs, g}]. Skip rows
// without a team identifier (PK violation otherwise).
q.upsertTeamBaserunning = (season, rows, refreshedAt) => {
  const tx = db.transaction((s, rs, t) => {
    for (const r of rs) {
      if (r == null || !r.team) continue;
      q._upsertTeamBaserunning.run(
        Number(s), String(r.team),
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)),
        t);
    }
  });
  tx(season, rows, refreshedAt);
};
q._snapTeamBaserunningClearDate = db.prepare(
  "DELETE FROM team_baserunning_snapshot WHERE snapshot_date=?"
);
q._snapTeamBaserunningInsert = db.prepare(
  "INSERT OR REPLACE INTO team_baserunning_snapshot "
  + "(snapshot_date, season, team, bsr, ubr, wsb, wgdp, sb, cs, g) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?)"
);
q.snapshotTeamBaserunning = (snapshotDate, season, rows) => {
  const tx = db.transaction((d, s, rs) => {
    q._snapTeamBaserunningClearDate.run(d);
    for (const r of rs) {
      if (r == null || !r.team) continue;
      q._snapTeamBaserunningInsert.run(d, Number(s), String(r.team),
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)));
    }
  });
  tx(snapshotDate, season, rows);
};
// Read helpers — live and snapshot. The "as-of" variant pulls the
// latest snapshot at or before a date (used by forward-honest path
// once enough snapshot history accumulates).
q.getTeamBaserunning = db.prepare(
  "SELECT season, team, bsr, ubr, wsb, wgdp, sb, cs, g, refreshed_at "
  + "FROM team_baserunning WHERE season=?"
);
q.getTeamBaserunningAsOf = db.prepare(
  "SELECT season, team, bsr, ubr, wsb, wgdp, sb, cs, g "
  + "FROM team_baserunning_snapshot "
  + "WHERE season=? AND snapshot_date = ( "
  + "  SELECT MAX(snapshot_date) FROM team_baserunning_snapshot "
  + "  WHERE season=? AND snapshot_date <= ?)"
);

// Player-level baserunning helpers. Same delete-then-insert pattern
// on the snapshot side; the live table is upserted by season+mlbam_id
// so a partial re-run doesn't lose rows. Aggregation across trade-
// window FG splits happens BEFORE this writer — the caller hands us
// already-aggregated rows.
q._upsertPlayerBaserunning = db.prepare(
  "INSERT INTO player_baserunning "
  + "(season, mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, refreshed_at) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
  + "ON CONFLICT(season, mlbam_id) DO UPDATE SET "
  + "name=excluded.name, bsr=excluded.bsr, ubr=excluded.ubr, wsb=excluded.wsb, "
  + "wgdp=excluded.wgdp, sb=excluded.sb, cs=excluded.cs, g=excluded.g, "
  + "refreshed_at=excluded.refreshed_at"
);
q.upsertPlayerBaserunning = (season, rows, refreshedAt) => {
  const tx = db.transaction((s, rs, t) => {
    for (const r of rs) {
      if (r == null || r.mlbam_id == null) continue;
      q._upsertPlayerBaserunning.run(
        Number(s),
        Math.round(Number(r.mlbam_id)),
        r.name || null,
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)),
        t);
    }
  });
  tx(season, rows, refreshedAt);
};
q._snapPlayerBaserunningClearDate = db.prepare(
  "DELETE FROM player_baserunning_snapshot WHERE snapshot_date=?"
);
q._snapPlayerBaserunningInsert = db.prepare(
  "INSERT OR REPLACE INTO player_baserunning_snapshot "
  + "(snapshot_date, season, mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?)"
);
q.snapshotPlayerBaserunning = (snapshotDate, season, rows) => {
  const tx = db.transaction((d, s, rs) => {
    q._snapPlayerBaserunningClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.mlbam_id == null) continue;
      q._snapPlayerBaserunningInsert.run(d, Number(s),
        Math.round(Number(r.mlbam_id)),
        r.name || null,
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)));
    }
  });
  tx(snapshotDate, season, rows);
};
q.getPlayerBaserunning = db.prepare(
  "SELECT season, mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, refreshed_at "
  + "FROM player_baserunning WHERE season=?"
);

// Trailing-window player BsR. Single rolling window at a time;
// runPlayerBaserunningTrailingJob clears the table then re-inserts.
q._clearPlayerBaserunningTrailing = db.prepare("DELETE FROM player_baserunning_trailing");
q._insertPlayerBaserunningTrailing = db.prepare(
  "INSERT OR REPLACE INTO player_baserunning_trailing "
  + "(mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, stint_count, "
  + " window_startdate, window_enddate, refreshed_at) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.replacePlayerBaserunningTrailing = (rows, startdate, enddate, refreshedAt) => {
  const tx = db.transaction((rs, sd, ed, t) => {
    q._clearPlayerBaserunningTrailing.run();
    for (const r of rs) {
      if (r == null || r.mlbam_id == null) continue;
      q._insertPlayerBaserunningTrailing.run(
        Math.round(Number(r.mlbam_id)),
        r.name || null,
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)),
        r.stint_count == null ? null : Math.round(Number(r.stint_count)),
        sd, ed, t);
    }
  });
  tx(rows, startdate, enddate, refreshedAt);
};
q.getPlayerBaserunningTrailing = db.prepare(
  "SELECT mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, stint_count, "
  + "       window_startdate, window_enddate, refreshed_at "
  + "FROM player_baserunning_trailing"
);
q.getPlayerBaserunningTrailingWindow = db.prepare(
  "SELECT window_startdate, window_enddate, MAX(refreshed_at) AS refreshed_at, "
  + "       COUNT(*) AS n_rows, "
  + "       SUM(CASE WHEN bsr IS NOT NULL THEN 1 ELSE 0 END) AS n_with_bsr, "
  + "       SUM(CASE WHEN stint_count > 1 THEN 1 ELSE 0 END) AS n_multi_team "
  + "FROM player_baserunning_trailing"
);

// Trailing-1yr player BsR snapshot helpers. Mirrors
// player_baserunning_snapshot: delete-then-insert per snapshot_date
// inside a single transaction so a same-day re-run starts clean. The
// caller hands the current player_baserunning_trailing rows in
// (already aggregated across trade splits by the trailing job).
q._snapPlayerBaserunningTrailingClearDate = db.prepare(
  "DELETE FROM player_baserunning_trailing_snapshot WHERE snapshot_date=?"
);
q._snapPlayerBaserunningTrailingInsert = db.prepare(
  "INSERT OR REPLACE INTO player_baserunning_trailing_snapshot "
  + "(snapshot_date, mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, "
  + " window_startdate, window_enddate) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.snapshotPlayerBaserunningTrailing = (snapshotDate, rows, windowStart, windowEnd) => {
  const tx = db.transaction((d, rs, ws, we) => {
    q._snapPlayerBaserunningTrailingClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.mlbam_id == null) continue;
      q._snapPlayerBaserunningTrailingInsert.run(d,
        Math.round(Number(r.mlbam_id)),
        r.name || null,
        r.bsr  == null ? null : Number(r.bsr),
        r.ubr  == null ? null : Number(r.ubr),
        r.wsb  == null ? null : Number(r.wsb),
        r.wgdp == null ? null : Number(r.wgdp),
        r.sb   == null ? null : Math.round(Number(r.sb)),
        r.cs   == null ? null : Math.round(Number(r.cs)),
        r.g    == null ? null : Math.round(Number(r.g)),
        ws || null, we || null);
    }
  });
  tx(snapshotDate, rows, windowStart, windowEnd);
};
// Read helpers — as-of and coverage diagnostics. The "as-of" variant
// pulls the latest snapshot at or before a date so the forward backtest
// reads point-in-time BsR for a past game_date without leaking future
// data. Returns one row per (mlbam_id) — the per-player BsR that was
// known at end-of-day on snapshot_date.
q.getPlayerBaserunningTrailingAsOf = db.prepare(
  "SELECT mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g, "
  + "       window_startdate, window_enddate, snapshot_date "
  + "FROM player_baserunning_trailing_snapshot "
  + "WHERE snapshot_date = ( "
  + "  SELECT MAX(snapshot_date) FROM player_baserunning_trailing_snapshot "
  + "  WHERE snapshot_date <= ?)"
);
q.getPlayerBaserunningTrailingSnapshotDates = db.prepare(
  "SELECT snapshot_date, COUNT(*) AS n_rows, "
  + "       SUM(CASE WHEN bsr IS NOT NULL THEN 1 ELSE 0 END) AS n_with_bsr, "
  + "       MIN(window_startdate) AS window_startdate, "
  + "       MAX(window_enddate)   AS window_enddate "
  + "FROM player_baserunning_trailing_snapshot "
  + "GROUP BY snapshot_date ORDER BY snapshot_date"
);
q.getPlayerBaserunningTrailingSnapshotCoverage = db.prepare(
  "SELECT COUNT(DISTINCT snapshot_date) AS n_snapshot_days, "
  + "       MIN(snapshot_date) AS first_snapshot_date, "
  + "       MAX(snapshot_date) AS last_snapshot_date "
  + "FROM player_baserunning_trailing_snapshot"
);

// ------------------------------------------------------------------
// Daily kalshi_spread_markets snapshot. Same delete-then-insert
// pattern as the framing/FRV helpers. Rows are upserted spread-
// market objects ({game_date, game_id, spread_team, spread_line,
// yes_ask_dollars, yes_bid_dollars, no_ask_dollars, no_bid_dollars,
// yes_ask_ml, no_ask_ml, volume_24h}). Rows missing any PK component
// (game_date, game_id, spread_team, spread_line) are skipped.
q._snapKalshiSpreadsClearDate = db.prepare(
  "DELETE FROM kalshi_spread_markets_snapshot WHERE snapshot_date=?"
);
q._snapKalshiSpreadsInsert = db.prepare(
  "INSERT OR REPLACE INTO kalshi_spread_markets_snapshot "
  + "(snapshot_date, game_date, game_id, spread_team, spread_line, "
  + " yes_ask_dollars, yes_bid_dollars, no_ask_dollars, no_bid_dollars, "
  + " yes_ask_ml, no_ask_ml, volume_24h) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.snapshotKalshiSpreads = (snapshotDate, rows) => {
  const tx = db.transaction((d, rs) => {
    q._snapKalshiSpreadsClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.game_date == null || r.game_id == null
          || r.spread_team == null || r.spread_line == null) continue;
      q._snapKalshiSpreadsInsert.run(d,
        r.game_date, r.game_id, r.spread_team, Number(r.spread_line),
        r.yes_ask_dollars == null ? null : Number(r.yes_ask_dollars),
        r.yes_bid_dollars == null ? null : Number(r.yes_bid_dollars),
        r.no_ask_dollars  == null ? null : Number(r.no_ask_dollars),
        r.no_bid_dollars  == null ? null : Number(r.no_bid_dollars),
        r.yes_ask_ml == null ? null : Number(r.yes_ask_ml),
        r.no_ask_ml  == null ? null : Number(r.no_ask_ml),
        r.volume_24h == null ? null : Number(r.volume_24h));
    }
  });
  tx(snapshotDate, rows);
};

// Daily kalshi_ml_markets snapshot. Same delete-then-insert pattern
// as the spreads writer. Rows: [{game_date, game_id, away_ask_dollars,
// home_ask_dollars, away_ask_ml, home_ask_ml, volume_24h_away,
// volume_24h_home}]. Rows missing any PK component skipped.
q._snapKalshiMlClearDate = db.prepare(
  "DELETE FROM kalshi_ml_markets_snapshot WHERE snapshot_date=?"
);
q._snapKalshiMlInsert = db.prepare(
  "INSERT OR REPLACE INTO kalshi_ml_markets_snapshot "
  + "(snapshot_date, game_date, game_id, "
  + " away_ask_dollars, home_ask_dollars, away_ask_ml, home_ask_ml, "
  + " volume_24h_away, volume_24h_home) "
  + "VALUES (?,?,?,?,?,?,?,?,?)"
);
q.snapshotKalshiMlMarkets = (snapshotDate, rows) => {
  const tx = db.transaction((d, rs) => {
    q._snapKalshiMlClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.game_date == null || r.game_id == null) continue;
      q._snapKalshiMlInsert.run(d,
        r.game_date, r.game_id,
        r.away_ask_dollars == null ? null : Number(r.away_ask_dollars),
        r.home_ask_dollars == null ? null : Number(r.home_ask_dollars),
        r.away_ask_ml == null ? null : Number(r.away_ask_ml),
        r.home_ask_ml == null ? null : Number(r.home_ask_ml),
        r.volume_24h_away == null ? null : Number(r.volume_24h_away),
        r.volume_24h_home == null ? null : Number(r.volume_24h_home));
    }
  });
  tx(snapshotDate, rows);
};

// Daily kalshi_totals_markets snapshot. Same pattern. Rows:
// [{game_date, game_id, market_line, over_ask_dollars,
//   under_ask_dollars, over_price_ml, under_price_ml}].
q._snapKalshiTotalsClearDate = db.prepare(
  "DELETE FROM kalshi_totals_markets_snapshot WHERE snapshot_date=?"
);
q._snapKalshiTotalsInsert = db.prepare(
  "INSERT OR REPLACE INTO kalshi_totals_markets_snapshot "
  + "(snapshot_date, game_date, game_id, market_line, "
  + " over_ask_dollars, under_ask_dollars, "
  + " over_price_ml, under_price_ml) "
  + "VALUES (?,?,?,?,?,?,?,?)"
);
q.snapshotKalshiTotalsMarkets = (snapshotDate, rows) => {
  const tx = db.transaction((d, rs) => {
    q._snapKalshiTotalsClearDate.run(d);
    for (const r of rs) {
      if (r == null || r.game_date == null || r.game_id == null) continue;
      q._snapKalshiTotalsInsert.run(d,
        r.game_date, r.game_id,
        r.market_line == null ? null : Number(r.market_line),
        r.over_ask_dollars == null ? null : Number(r.over_ask_dollars),
        r.under_ask_dollars == null ? null : Number(r.under_ask_dollars),
        r.over_price_ml == null ? null : Number(r.over_price_ml),
        r.under_price_ml == null ? null : Number(r.under_price_ml));
    }
  });
  tx(snapshotDate, rows);
};

// ------------------------------------------------------------------
// Empirical-spread signal helpers. Two parallel writes per game per
// odds-job: one row in empirical_spread_signals (the snapshot of the
// model context + the JSON pick list) and one row PER prediction in
// empirical_spread_outcomes (so each spread line is independently
// gradable). PK on (game_date, game_id, generated_at) means a re-run
// with the same datetime('now') would collide — runOddsJob naturally
// avoids this because each call gets a fresh second-resolution
// timestamp, but the INSERT OR REPLACE here keeps re-runs safe.
q.upsertEmpiricalSpreadSignal = db.prepare(
    "INSERT OR REPLACE INTO empirical_spread_signals "
  + "(game_date, game_id, generated_at, capture_track, "
  + " model_total, model_no_vig_home_prob, "
  + " cell_label, cell_sample_size, predictions_json, top_edge_team, "
  + " top_edge_line, top_edge_yes_ask_ml, top_edge_pp) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.upsertEmpiricalSpreadOutcome = db.prepare(
    "INSERT OR REPLACE INTO empirical_spread_outcomes "
  + "(game_date, game_id, spread_team, spread_line, side, capture_track, pair_id, "
  + " yes_ask_ml, edge_pp, cell_sample_size, generated_at, "
  + " actual_margin, outcome, pnl_per_100, graded_at) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
// Pending-grade pull. Only rows whose game is final (away/home_score
// non-null) AND whose outcome is still NULL come back. Joins game_log
// so the caller has the margin in hand without a second lookup. Returns
// side AND capture_track so the grading caller can key the UPDATE to
// the exact row — a morning lock and a gametime snapshot for the same
// spread coexist and grade independently against their own frozen prices.
q.getUngradedEmpiricalSpreads = db.prepare(
    "SELECT e.game_date, e.game_id, e.spread_team, e.spread_line, "
  + "       e.side, e.capture_track, e.yes_ask_ml, e.generated_at, "
  + "       g.away_team, g.home_team, g.away_score, g.home_score "
  + "FROM empirical_spread_outcomes e "
  + "JOIN game_log g ON g.game_date = e.game_date AND g.game_id = e.game_id "
  + "WHERE e.outcome IS NULL "
  + "  AND g.away_score IS NOT NULL AND g.home_score IS NOT NULL "
  + "ORDER BY e.game_date, e.game_id"
);
// graded_at takes a bind parameter (was datetime('now') = UTC) so the
// caller can supply a PT-anchored timestamp via services/jobs.js
// nowPtIso(). Matches the same PT convention used by generated_at
// going forward. [tz cutover: 2026-06-08] — rows graded before this
// fix carry UTC graded_at; rows graded after carry PT.
q.updateEmpiricalSpreadOutcome = db.prepare(
    "UPDATE empirical_spread_outcomes "
  + "SET actual_margin=?, outcome=?, pnl_per_100=?, graded_at=? "
  + "WHERE game_date=? AND game_id=? AND spread_team=? AND spread_line=? "
  + "  AND side=? AND capture_track=? AND generated_at=?"
);

// empirical_market_captures (feat/morning-capture-ml-totals)
// prepared statements. PK shape mirrors empirical_spread_outcomes;
// the writer uses INSERT OR IGNORE so re-invoking on a key that
// already has a row is a no-op (first-eligible-lock for the
// morning track). gametime captures use INSERT OR REPLACE — each
// odds-job pass writes a fresh snapshot under its own generated_at.
q.insertOrIgnoreMarketCapture = db.prepare(
    "INSERT OR IGNORE INTO empirical_market_captures "
  + "(game_date, game_id, market_type, capture_track, generated_at, "
  + " market_line, away_price_ml, home_price_ml, over_price_ml, under_price_ml, "
  + " signaled_side, signaled_edge_pp, signaled_price_ml) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.insertOrReplaceMarketCapture = db.prepare(
    "INSERT OR REPLACE INTO empirical_market_captures "
  + "(game_date, game_id, market_type, capture_track, generated_at, "
  + " market_line, away_price_ml, home_price_ml, over_price_ml, under_price_ml, "
  + " signaled_side, signaled_edge_pp, signaled_price_ml) "
  + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
);
q.existsMorningMarketCapture = db.prepare(
    "SELECT 1 FROM empirical_market_captures "
  + "WHERE game_date=? AND game_id=? AND market_type=? AND capture_track='morning' LIMIT 1"
);
q.getUngradedMarketCapturesByGame = db.prepare(
    "SELECT game_date, game_id, market_type, capture_track, generated_at, "
  + "       market_line, away_price_ml, home_price_ml, over_price_ml, under_price_ml, "
  + "       signaled_side, signaled_price_ml "
  + "FROM empirical_market_captures "
  + "WHERE game_date=? AND game_id=? AND outcome IS NULL"
);
q.updateMarketCaptureOutcome = db.prepare(
    "UPDATE empirical_market_captures "
  + "SET away_score=?, home_score=?, actual_total=?, "
  + "    outcome=?, pnl_per_100=?, graded_at=? "
  + "WHERE game_date=? AND game_id=? AND market_type=? "
  + "  AND capture_track=? AND generated_at=?"
);
// Cross-game-scan version of the ungraded pull. Used by the regrade
// backfill endpoint to walk every completed game with at least one
// ungraded market capture row. JOIN game_log so the caller has the
// scores in hand without a second lookup.
q.getUngradedMarketCaptures = db.prepare(
    "SELECT e.game_date, e.game_id, e.market_type, e.capture_track, e.generated_at, "
  + "       e.market_line, e.away_price_ml, e.home_price_ml, e.over_price_ml, e.under_price_ml, "
  + "       e.signaled_side, e.signaled_price_ml, "
  + "       g.away_team, g.home_team, g.away_score, g.home_score "
  + "FROM empirical_market_captures e "
  + "JOIN game_log g ON g.game_date = e.game_date AND g.game_id = e.game_id "
  + "WHERE e.outcome IS NULL "
  + "  AND g.away_score IS NOT NULL AND g.home_score IS NOT NULL "
  + "ORDER BY e.game_date, e.game_id, e.market_type, e.capture_track"
);
// Latest signal per game for a date — backs the slate API. Filtered to
// capture_track='gametime' so the slate keeps showing the CURRENT live
// line. Morning rows are for ROI tracking only; the slate UI must not
// display them as the "live" recommendation since by mid-afternoon
// the morning prices are typically stale.
q.getLatestEmpiricalSpreadSignalsByDate = db.prepare(
    "SELECT s.* FROM empirical_spread_signals s "
  + "WHERE s.game_date = ? AND s.capture_track = 'gametime' "
  + "  AND s.generated_at = ("
  + "  SELECT MAX(s2.generated_at) FROM empirical_spread_signals s2 "
  + "  WHERE s2.game_date = s.game_date AND s2.game_id = s.game_id "
  + "    AND s2.capture_track = 'gametime'"
  + ") "
  + "ORDER BY s.game_id"
);
// Morning-capture lock helpers. existsMorningSignalsForGame answers
// "has the first-eligible lock already fired for this (date, game_id)?"
// — true means the morning capture path MUST skip this game.
// upsertMorningCaptureState is the lock-window marker; it's
// INSERT-OR-IGNORE so multiple morning-cron / endpoint calls in a
// single day leave opened_at unchanged.
q.existsMorningSignalForGame = db.prepare(
    "SELECT 1 FROM empirical_spread_signals "
  + "WHERE game_date=? AND game_id=? AND capture_track='morning' LIMIT 1"
);
q.upsertMorningCaptureState = db.prepare(
    "INSERT OR IGNORE INTO morning_capture_state (game_date, opened_at) VALUES (?, ?)"
);
q.getMorningCaptureState = db.prepare(
    "SELECT * FROM morning_capture_state WHERE game_date=?"
);


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

q.getBullpenWoba = (teamAbbr, starterName, vsHand, wProj, wAct, gameDate, unknownWoba, minBF) => {
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
  // Gate actuals at minBF — matches the gate in services/model.js blendWoba
  // (used for SPs and bulk pitchers). Below threshold, actuals don't have
  // enough signal to override projection. Defaults to 100 inline so
  // standalone callers (scripts/) that don't thread minBF still get the
  // same behavior as getPitcherWoba's default.
  const minSample = (minBF != null) ? minBF : 100;
  const pitchers = bullpenProj.map(proj => {
    const pName = normName(proj.player_name.replace(/ [A-Z]+$/, ''));
    const actMatch = fuzzyLookup(actIdx, pName, teamAbbr);
    const useAct = actMatch && actMatch.woba && actMatch.sample_size >= minSample;
    const woba = useAct
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
  // Equal-weight aggregation across the pool. Each rostered RP (whether
  // established, partial-projection, or fallback callup) contributes
  // equally to the team's bullpen wOBA average. We don't know who the
  // manager will deploy, and a thin-sample reliever shouldn't be penalized
  // for being new — his fallback wOBA already encodes the "we don't know"
  // uncertainty (UNKNOWN_PITCHER_WOBA, default 0.335). The 70/30 actuals
  // blend per pitcher is preserved (above) — that gating happens BEFORE
  // aggregation, so a pitcher with meaningful actuals still blends his
  // projection and actuals into a single per-pitcher value before this
  // pool-level mean.
  const woba = pool.reduce((s,p)=>s+p.woba, 0) / pool.length;
  return { woba: parseFloat(woba.toFixed(4)), pitchers: pool.length, fallbacks: fallbackList.length };
};

q.getBullpenWobaBlended = (teamAbbr, starterName, lineup, bpStrongWtR, bpWeakWtR, bpStrongWtL, bpWeakWtL, wProj, wAct, gameDate, unknownWoba, minBF) => {
  // Blend the team's bullpen-allowed wOBA using per-handedness strong/weak
  // manager-assumption weights. For each batter in the opposing lineup the
  // manager is assumed to deploy `strongWt` share of the better-matched
  // reliever (min wOBA) and `weakWt` share of the worse-matched one, with
  // the R/L split tuned separately because righty vs lefty matchup leverage
  // differs in practice. Fallback (no lineup) averages R and L weights.
  // lineup = [{hand:'R'|'L'|'S'}] — the batting lineup the bullpen will face
  const rhb = q.getBullpenWoba(teamAbbr, starterName, 'rhb', wProj, wAct, gameDate, unknownWoba, minBF);
  const lhb = q.getBullpenWoba(teamAbbr, starterName, 'lhb', wProj, wAct, gameDate, unknownWoba, minBF);
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

// ============================================================
// feat/continuous-edge-score migrations
// ============================================================
// 1. Drop NOT NULL on bet_signals.signal_label so post-cutover
//    continuous-edge rows can be inserted with label=NULL. SQLite
//    has no ALTER COLUMN; the standard procedure is to recreate
//    the table with the desired schema and copy rows over. Guarded
//    by sqlite_master inspection so subsequent boots are a no-op.
// 2. DELETE the six legacy tier-threshold rows from app_settings.
//    Idempotent — re-running just produces a 0-row delete.
// 3. INSERT OR IGNORE the five new continuous-edge settings. Also
//    idempotent.
(function migrateContinuousEdge() {
  try {
    const tblRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='bet_signals'"
    ).get();
    if (tblRow && /signal_label\s+TEXT\s+NOT\s+NULL/i.test(tblRow.sql)) {
      console.log('[migrate:continuous-edge] dropping NOT NULL on bet_signals.signal_label');
      const cols = db.prepare("PRAGMA table_info('bet_signals')").all();
      // Build a faithful CREATE TABLE from the live shape, stripping
      // NOT NULL only on signal_label. Preserve PK / AUTOINCREMENT /
      // type / default on every other column so the row data round-trips
      // unchanged.
      const colSpecs = cols.map(c => {
        let spec = '"' + c.name + '"';
        if (c.type) spec += ' ' + c.type;
        if (c.pk === 1) spec += ' PRIMARY KEY AUTOINCREMENT';
        if (c.notnull === 1 && c.name !== 'signal_label' && c.pk !== 1) spec += ' NOT NULL';
        if (c.dflt_value !== null) {
          // SQLite requires function-call defaults like datetime('now')
          // to be parenthesized; literals like 0 or 'v1' don't strictly
          // need parens but tolerate them. Always wrap to keep it safe.
          const raw = String(c.dflt_value);
          const wrapped = raw.includes('(') ? '(' + raw + ')' : raw;
          spec += ' DEFAULT ' + wrapped;
        }
        return spec;
      });
      const ddl = 'CREATE TABLE bet_signals_new ('
        + colSpecs.join(', ')
        + ', FOREIGN KEY (game_log_id) REFERENCES game_log(id))';
      const colList = cols.map(c => '"' + c.name + '"').join(', ');
      // PRAGMA foreign_keys must be toggled OUTSIDE the transaction
      // per SQLite docs. Inside the tx: create + copy + drop + rename.
      db.exec('PRAGMA foreign_keys = OFF');
      const tx = db.transaction(() => {
        db.exec(ddl);
        db.exec('INSERT INTO bet_signals_new (' + colList + ') SELECT ' + colList + ' FROM bet_signals');
        db.exec('DROP TABLE bet_signals');
        db.exec('ALTER TABLE bet_signals_new RENAME TO bet_signals');
        db.exec('CREATE INDEX IF NOT EXISTS idx_signals_date ON bet_signals(game_date)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_signals_category ON bet_signals(category)');
      });
      tx();
      db.exec('PRAGMA foreign_keys = ON');
      console.log('[migrate:continuous-edge] bet_signals.signal_label NOT NULL dropped');
    }
  } catch (e) {
    console.error('[migrate:continuous-edge] table recreate FAILED:', e.message);
    // Re-enable FKs even on failure so we don't leave the DB in a
    // weakened state.
    try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
    throw e;
  }

  // app_settings cleanup. Idempotent on both directions: DELETE of a
  // non-existent key is a no-op; INSERT OR IGNORE of an existing key
  // is a no-op.
  db.exec(
    "DELETE FROM app_settings WHERE key IN ('ml_lean_edge','ml_value_edge','ml_3star_edge','tot_lean_edge','tot_value_edge','tot_3star_edge'); " +
    "INSERT OR IGNORE INTO app_settings VALUES ('signal_emit_floor_pp', '0.01'); " +
    "INSERT OR IGNORE INTO app_settings VALUES ('ui_highlight_ml_fav_min_pp', '0.02'); " +
    "INSERT OR IGNORE INTO app_settings VALUES ('ui_highlight_ml_dog_min_pp', '0.045'); " +
    "INSERT OR IGNORE INTO app_settings VALUES ('ui_highlight_tot_under_min_pp', '0.07'); " +
    "INSERT OR IGNORE INTO app_settings VALUES ('ui_highlight_tot_overs_enabled', 'false');"
  );
})();

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

module.exports = { db, q, DB_PATH };
