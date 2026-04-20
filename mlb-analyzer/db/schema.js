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
  proj_market_away_ml INTEGER,
  proj_market_home_ml INTEGER,
  proj_market_total REAL,
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
  notes TEXT                 -- explanation when signal state changes (e.g. line moved)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signals_date ON bet_signals(game_date);
  CREATE INDEX IF NOT EXISTS idx_signals_category ON bet_signals(category);
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
  INSERT OR IGNORE INTO app_settings VALUES ('bp_strong_weight', '0.60');
  INSERT OR IGNORE INTO app_settings VALUES ('bp_weak_weight', '0.40');
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
  INSERT OR IGNORE INTO app_settings VALUES ('sp_ip_baseline', '5.5');
  INSERT OR IGNORE INTO app_settings VALUES ('sp_ip_weight_per', '0.03');
  INSERT OR IGNORE INTO app_settings VALUES ('pa_weights', '[4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7]');
INSERT OR IGNORE INTO app_settings VALUES ('odds_api_key', '');
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
`);


// Migrations for existing DBs
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
      model_away_ml, model_home_ml, model_total, lineup_source, updated_at
    ) VALUES (
      @game_date, @game_id, @away_team, @home_team, @game_time,
      @away_sp, @away_sp_hand, @home_sp, @home_sp_hand,
      @market_away_ml, @market_home_ml, @market_total, @park_factor,
      @model_away_ml, @model_home_ml, @model_total, @lineup_source, datetime('now')
    )
    ON CONFLICT(game_date, game_id) DO UPDATE SET
      away_sp = excluded.away_sp, away_sp_hand = excluded.away_sp_hand,
      home_sp = excluded.home_sp, home_sp_hand = excluded.home_sp_hand,
      game_time = COALESCE(excluded.game_time, game_log.game_time),
      market_away_ml = excluded.market_away_ml, market_home_ml = excluded.market_home_ml,
      market_total = excluded.market_total, park_factor = excluded.park_factor,
      model_away_ml = excluded.model_away_ml, model_home_ml = excluded.model_home_ml,
      model_total = excluded.model_total, lineup_source = excluded.lineup_source,
      updated_at = datetime('now')
  `),
  updateScores: db.prepare(`
    UPDATE game_log SET
      away_score = @away_score, home_score = @home_score,
      actual_total = @away_score + @home_score,
      scores_source = @scores_source, updated_at = datetime('now')
    WHERE game_date = @game_date AND game_id = @game_id
  `),
  getGamesByDate: db.prepare(`SELECT * FROM game_log WHERE game_date = ?
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
      category, market_line, model_line, edge_pct, outcome, pnl
    ) VALUES (
      @game_log_id, @game_date, @game_id, @signal_type, @signal_side, @signal_label,
      @category, @market_line, @model_line, @edge_pct, @outcome, @pnl
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
  q.updateWindData = db.prepare(`UPDATE game_log SET wind_speed=?,wind_dir=?,wind_factor=?,temp_f=?,temp_run_adj=?,roof_status=?,roof_confidence=? WHERE game_date=? AND game_id=?`);
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

q.getBullpenWobaBlended = (teamAbbr, starterName, lineup, bpStrongWt, bpWeakWt, wProj, wAct, gameDate, unknownWoba) => {
  // Compute bullpen wOBA blended by actual opposing lineup handedness
  // lineup = [{hand:'R'|'L'|'S'}] — the batting lineup the bullpen will face
  const rhb = q.getBullpenWoba(teamAbbr, starterName, 'rhb', wProj, wAct, gameDate, unknownWoba);
  const lhb = q.getBullpenWoba(teamAbbr, starterName, 'lhb', wProj, wAct, gameDate, unknownWoba);
  const vsRHB = rhb?.woba || null;
  const vsLHB = lhb?.woba || null;
  if (!vsRHB && !vsLHB) return null;
  const strongWt = (bpStrongWt != null) ? bpStrongWt : 0.60;
  const weakWt = (bpWeakWt != null) ? bpWeakWt : 0.40;
  if (vsRHB && vsLHB && lineup && lineup.length > 0) {
    // Use actual lineup handedness composition
    let pctR = 0;
    for (const b of lineup) {
      if (b.hand === 'R') pctR += 1;
      else if (b.hand === 'L') pctR += 0;
      else pctR += 0.5; // switch hitter
    }
    pctR = pctR / lineup.length;
    const pctL = 1 - pctR;
    const blended = parseFloat((pctR * vsRHB + pctL * vsLHB).toFixed(4));
    return { woba: blended, vsRHB, vsLHB, pctR: parseFloat(pctR.toFixed(3)), pctL: parseFloat(pctL.toFixed(3)), source: 'lineup-weighted' };
  }
  // Fallback: use strong/weak manager assumption
  if (vsRHB && vsLHB) {
    const strongWoba = Math.min(vsRHB, vsLHB);
    const weakWoba = Math.max(vsRHB, vsLHB);
    const blended = parseFloat((strongWt * strongWoba + weakWt * weakWoba).toFixed(4));
    return { woba: blended, vsRHB, vsLHB, source: 'strong-weak-fallback' };
  }
  return { woba: vsRHB || vsLHB, vsRHB, vsLHB, source: 'single-side' };
};

// Add is_active and notes columns if not present
  try { db.prepare("ALTER TABLE bet_signals ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1").run(); } catch(e) {}
  try { db.prepare("ALTER TABLE bet_signals ADD COLUMN notes TEXT").run(); } catch(e) {}
module.exports = { db, q };
