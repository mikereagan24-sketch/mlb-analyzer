const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
  clv REAL                   -- closing line value: how much better your line was,
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
INSERT OR IGNORE INTO app_settings VALUES ('odds_api_key', '');
  INSERT OR IGNORE INTO app_settings VALUES ('lineup_cron', '0 17 * * *');
  INSERT OR IGNORE INTO app_settings VALUES ('scores_cron', '0 7 * * *');
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE game_log ADD COLUMN game_time TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN odds_locked_at TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN over_price INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN away_lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN home_lineup_status TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_away_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_home_ml INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE game_log ADD COLUMN proj_model_total REAL"); } catch(e) {}
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
  getGamesByDate: db.prepare(`SELECT * FROM game_log WHERE game_date = ? ORDER BY game_time, game_id`),
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
  getSignalsByDate: db.prepare(`SELECT * FROM bet_signals WHERE game_date = ? ORDER BY game_id`),
  getSignalsByDateRange: db.prepare(`SELECT * FROM bet_signals WHERE game_date BETWEEN ? AND ? ORDER BY game_date, game_id`),
  getSummaryByCategory: db.prepare(`
    SELECT category,
      COUNT(*) as plays,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome='push' THEN 1 ELSE 0 END) as pushes,
      SUM(CASE WHEN outcome='pending' THEN 1 ELSE 0 END) as pending,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(pnl) / NULLIF(COUNT(*) * 100.0, 0) * 100, 2) as roi
    FROM bet_signals WHERE game_date BETWEEN ? AND ?
    GROUP BY category ORDER BY category
  `),
  getOverallSummary: db.prepare(`
    SELECT COUNT(*) as plays,
      SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome='push' THEN 1 ELSE 0 END) as pushes,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(pnl) / NULLIF(COUNT(*) * 100.0, 0) * 100, 2) as roi
    FROM bet_signals WHERE game_date BETWEEN ? AND ? AND outcome != 'pending'
  `),
  logCron: db.prepare(`INSERT INTO cron_log (job_type, run_date, status, message, games_updated) VALUES (?, ?, ?, ?, ?)`),
  getRecentCronLogs: db.prepare(`SELECT * FROM cron_log ORDER BY ran_at DESC LIMIT 20`),
  getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`),
  getAllSettings: db.prepare(`SELECT key, value FROM app_settings`),
};

q.upsertWobaBatch = (key, rows) => {
  const tx = db.transaction((k, rs) => { for (const r of rs) q.upsertWoba.run(k, r.name, r.woba, r.sample || 0); });
  tx(key, rows);
};

module.exports = { db, q };
