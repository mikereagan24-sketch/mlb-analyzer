'use strict';

// Read-only admin query whitelist.
//
// Backs GET /api/admin/query/:name (single query, JSON rows) and
// GET /api/admin/query (list of available queries). Adds a
// server-side alternative to "pull the 550 MB DB and grep locally"
// for the handful of rows we usually need in a verification pass.
//
// Design:
//   - Whitelist ONLY. No arbitrary SQL. Each query is a named entry
//     with a prepared statement string, a param schema, and a
//     description. The router validates params against the schema
//     before binding to the prepared statement.
//   - SELECTs only. The route's `db.prepare(...).all(...)` path
//     doesn't execute writes; but the SQL text is also grepped for
//     any leading keyword other than SELECT/WITH as belt-and-braces.
//   - Result cap. Every response is capped at MAX_ROWS (default
//     1000). If truncated, the response sets `truncated: true` and
//     the operator knows to narrow the filter.
//   - Admin-token gated (routes/api.js requireAdminToken).
//
// Adding a query: append to `QUERIES` below.
//
//   name         — kebab-case string. Path segment: /admin/query/<name>.
//   description  — one-line human summary shown in the list endpoint.
//   sql          — parameterized SQL. Use `?` positional params.
//   params       — array of { name, type, required, default? }.
//                    types: 'date' (YYYY-MM-DD), 'string', 'int',
//                           'string_upper' (uppercased before bind).
//   bindOrder    — the order params flow into the ?'s (repeats OK).
//
// The router iterates bindOrder to construct the args array. This
// lets the same param appear multiple times in the SQL without the
// caller passing it twice.

const MAX_ROWS = 1000;

const QUERIES = [
  // ==================== weather / contamination ====================

  {
    name: 'contamination-bucket-counts',
    description: 'game_log rows grouped by weather_contamination_reason.',
    sql:
      "SELECT COALESCE(weather_contamination_reason, '__NULL__') AS reason, "
      + "  COUNT(*) AS n "
      + "FROM game_log "
      + "WHERE COALESCE(is_removed, 0) = 0 "
      + "  AND (? IS NULL OR game_date >= ?) "
      + "  AND (? IS NULL OR game_date <= ?) "
      + "GROUP BY COALESCE(weather_contamination_reason, '__NULL__') "
      + "ORDER BY n DESC",
    params: [
      { name: 'from', type: 'date', required: false, default: null },
      { name: 'to',   type: 'date', required: false, default: null },
    ],
    bindOrder: ['from', 'from', 'to', 'to'],
  },

  {
    name: 'weather-null-in-window',
    description: 'Rows in [from, to] where temp_f is still NULL. Useful for post-backfill gap checks.',
    sql:
      "SELECT game_date, game_id, home_team, venue_id, game_time, "
      + "  weather_contamination_reason "
      + "FROM game_log "
      + "WHERE temp_f IS NULL "
      + "  AND game_date >= ? AND game_date <= ? "
      + "  AND COALESCE(is_removed, 0) = 0 "
      + "ORDER BY game_date, game_id "
      + "LIMIT ?",
    params: [
      { name: 'from',  type: 'date', required: true },
      { name: 'to',    type: 'date', required: true },
      { name: 'limit', type: 'int',  required: false, default: 500 },
    ],
    bindOrder: ['from', 'to', 'limit'],
  },

  {
    name: 'weather-field-summary',
    description: 'Counts of populated vs null temp_f, bucket distribution, plus min/max temp in a date window.',
    sql:
      "SELECT "
      + "  COUNT(*)                                                       AS total, "
      + "  SUM(CASE WHEN temp_f IS NULL THEN 1 ELSE 0 END)                AS temp_f_null, "
      + "  SUM(CASE WHEN temp_f IS NOT NULL THEN 1 ELSE 0 END)            AS temp_f_populated, "
      + "  SUM(CASE WHEN temp_f < 55 THEN 1 ELSE 0 END)                   AS bucket_lt55, "
      + "  SUM(CASE WHEN temp_f >= 55 AND temp_f < 70 THEN 1 ELSE 0 END)  AS bucket_55_69, "
      + "  SUM(CASE WHEN temp_f >= 70 AND temp_f < 80 THEN 1 ELSE 0 END)  AS bucket_70_79, "
      + "  SUM(CASE WHEN temp_f >= 80 AND temp_f < 90 THEN 1 ELSE 0 END)  AS bucket_80_89, "
      + "  SUM(CASE WHEN temp_f >= 90 THEN 1 ELSE 0 END)                  AS bucket_90plus, "
      + "  SUM(CASE WHEN weather_contamination_reason IS NOT NULL THEN 1 ELSE 0 END) AS contaminated, "
      + "  MIN(temp_f) AS min_temp, MAX(temp_f) AS max_temp "
      + "FROM game_log "
      + "WHERE game_date >= ? AND game_date <= ? "
      + "  AND COALESCE(is_removed, 0) = 0",
    params: [
      { name: 'from', type: 'date', required: true },
      { name: 'to',   type: 'date', required: true },
    ],
    bindOrder: ['from', 'to'],
  },

  // ==================== game_log peek ====================

  {
    name: 'game-log-rows',
    description: 'Sample rows with the common weather + score columns. Optional home_team filter (uppercase).',
    sql:
      "SELECT game_date, game_id, home_team, away_team, venue_id, "
      + "  game_time, temp_f, temp_run_adj, wind_speed, wind_dir, wind_factor, "
      + "  roof_status, roof_confidence, weather_quality, "
      + "  weather_contamination_reason, "
      + "  model_home_ml, model_away_ml, model_total, "
      + "  market_home_ml, market_away_ml, market_total, "
      + "  away_score, home_score, "
      + "  (COALESCE(away_score, 0) + COALESCE(home_score, 0)) AS total_score "
      + "FROM game_log "
      + "WHERE game_date >= ? AND game_date <= ? "
      + "  AND (? IS NULL OR UPPER(home_team) = ?) "
      + "  AND COALESCE(is_removed, 0) = 0 "
      + "ORDER BY game_date, game_id "
      + "LIMIT ?",
    params: [
      { name: 'from',      type: 'date',         required: true },
      { name: 'to',        type: 'date',         required: true },
      { name: 'home_team', type: 'string_upper', required: false, default: null },
      { name: 'limit',     type: 'int',          required: false, default: 50 },
    ],
    bindOrder: ['from', 'to', 'home_team', 'home_team', 'limit'],
  },

  {
    name: 'game-log-row',
    description: 'Full game_log row for one (game_date, game_id). Every column, one row max.',
    sql:
      "SELECT * FROM game_log "
      + "WHERE game_date = ? AND game_id = ?",
    params: [
      { name: 'game_date', type: 'date',   required: true },
      { name: 'game_id',   type: 'string', required: true },
    ],
    bindOrder: ['game_date', 'game_id'],
  },

  // ==================== signal performance ====================

  {
    name: 'tot-signals-roi',
    description: 'TOT signal win/loss/ROI by side in a window. clean_only=1 excludes contaminated-weather rows via JOIN.',
    sql:
      "SELECT s.signal_side AS side, "
      + "  COUNT(*)                                            AS n, "
      + "  SUM(CASE WHEN s.outcome = 'win' THEN 1 ELSE 0 END)  AS wins, "
      + "  SUM(CASE WHEN s.outcome = 'loss' THEN 1 ELSE 0 END) AS losses, "
      + "  SUM(CASE WHEN s.outcome = 'push' THEN 1 ELSE 0 END) AS pushes, "
      + "  ROUND(SUM(COALESCE(s.pnl, 0)), 2)                   AS pnl_total, "
      + "  ROUND(100.0 * SUM(COALESCE(s.pnl, 0)) / "
      + "    NULLIF(100.0 * (SUM(CASE WHEN s.outcome IN ('win','loss') THEN 1 ELSE 0 END)), 0), 2) AS roi_pct "
      + "FROM bet_signals s "
      + "JOIN game_log g ON g.game_date = s.game_date AND g.game_id = s.game_id "
      + "WHERE s.signal_type = 'Total' "
      + "  AND s.outcome IN ('win', 'loss', 'push') "
      + "  AND s.game_date >= ? AND s.game_date <= ? "
      + "  AND (? = 0 OR g.weather_contamination_reason IS NULL) "
      + "GROUP BY s.signal_side "
      + "ORDER BY s.signal_side",
    params: [
      { name: 'from',       type: 'date', required: true },
      { name: 'to',         type: 'date', required: true },
      { name: 'clean_only', type: 'int',  required: false, default: 1 },
    ],
    bindOrder: ['from', 'to', 'clean_only'],
  },

  // ==================== backfill jobs ====================

  {
    name: 'price-write-details',
    description: 'signal_id / action / created_at / detail for market_line changes on the '
      + 'refresh paths. Exists so the reversal rate can be re-measured against PRODUCTION '
      + 'without a 671MB download -- the fix in PR #310 shipped with a stated prediction '
      + '(reversal rate ~5%) and the follow-up needs prod rows, not the analysis copy.',
    sql:
      "SELECT signal_id, action, created_at, detail FROM bet_signal_audit "
      + "WHERE action IN ('refresh','refresh_odds_tail') AND detail LIKE '%market_line%' "
      + 'AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?) '
      + 'ORDER BY signal_id, created_at LIMIT ?',
    params: [
      { name: 'from',  type: 'string', required: false, default: null },
      { name: 'to',    type: 'string', required: false, default: null },
      { name: 'limit', type: 'int',    required: false, default: 1000 },
    ],
    bindOrder: ['from', 'from', 'to', 'to', 'limit'],
  },
  {
    name: 'signal-audit-actions',
    description: 'bet_signal_audit action counts in a date window. Exists so a REFUSAL '
      + 'path can be confirmed in production without pulling the DB -- a green deploy '
      + 'proves nothing about a guard that only fires on a live in-progress rescore.',
    sql:
      'SELECT action, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at '
      + 'FROM bet_signal_audit '
      + 'WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?) '
      + '  AND (? IS NULL OR action = ?) '
      + 'GROUP BY action ORDER BY n DESC',
    params: [
      { name: 'from',   type: 'string', required: false, default: null },
      { name: 'to',     type: 'string', required: false, default: null },
      { name: 'action', type: 'string', required: false, default: null },
    ],
    bindOrder: ['from', 'from', 'to', 'to', 'action', 'action'],
  },
  {
    name: 'lineup-capture-health',
    description: 'Per-horizon, per-PT-hour lineup_captures inventory with anchor coverage. '
      + 'Exists to confirm a NEW SCHEDULED JOB actually ran in production -- the 10AM PT '
      + 'lineup pull added 2026-08-26 has never fired, and the park-factor table shipped '
      + 'empty for exactly this reason (monthly cron, no bootstrap, nobody looked). '
      + 'Hour is PT so it lines up with the cron schedule; anchor coverage is here because '
      + 'a capture with lead_minutes NULL is a row that cannot be bucketed by lead.',
    sql:
      "SELECT substr(datetime(capture_time,'-7 hours'),1,10) AS pt_date, "
      + "  CAST(substr(datetime(capture_time,'-7 hours'),12,2) AS INTEGER) AS pt_hour, "
      + '  horizon, COUNT(*) AS rows, '
      + "  COUNT(DISTINCT game_date || '|' || game_id) AS games, "
      + '  SUM(CASE WHEN lead_minutes IS NOT NULL THEN 1 ELSE 0 END) AS with_lead, '
      + "  SUM(CASE WHEN lead_anchor='scheduled' THEN 1 ELSE 0 END) AS anchor_sched, "
      + "  SUM(CASE WHEN lead_anchor='first_pitch' THEN 1 ELSE 0 END) AS anchor_fp, "
      + '  SUM(COALESCE(page_has_started,0)) AS started, '
      + '  SUM(CASE WHEN n_slots=0 THEN 1 ELSE 0 END) AS empty_lineups '
      + 'FROM lineup_captures '
      + "WHERE (? IS NULL OR substr(datetime(capture_time,'-7 hours'),1,10) >= ?) "
      + '  AND (? IS NULL OR horizon = ?) '
      // since_ts is a ROW-LEVEL cutoff on capture_time, deliberately not a
      // date. The anchor fix (PR #314) deployed at 22:36Z on 2026-08-26 --
      // 3:36PM PT -- so the boundary falls INSIDE a slate: the 8AM/10AM/
      // noon-3PM PT pulls that day are pre-fix and the 4PM/5PM/6PM/11PM
      // ones are post-fix. A date-level filter would throw away half a day
      // of perfectly good captures to exclude the other half.
      + '  AND (? IS NULL OR capture_time >= ?) '
      + 'GROUP BY pt_date, pt_hour, horizon ORDER BY pt_date DESC, pt_hour, horizon LIMIT ?',
    params: [
      { name: 'from',     type: 'string', required: false, default: null },
      { name: 'horizon',  type: 'string', required: false, default: null },
      { name: 'since_ts', type: 'string', required: false, default: null },
      { name: 'limit',    type: 'int',    required: false, default: 200 },
    ],
    bindOrder: ['from', 'from', 'horizon', 'horizon', 'since_ts', 'since_ts', 'limit'],
  },
  {
    name: 'lineup-capture-anchor-boundary',
    description: 'The earliest capture_time carrying a non-null lead_anchor, i.e. OBSERVABLE '
      + 'evidence of when the anchor-fix code went live. Exists so the anchor-coverage check '
      + 'can be scoped by comparison against the data rather than by a remembered deploy date '
      + '-- the same reasoning as the park-factor regime column. Also returns the pre-boundary '
      + 'row count so those rows are reported as excluded rather than silently dropped.',
    sql:
      'SELECT (SELECT MIN(capture_time) FROM lineup_captures WHERE lead_anchor IS NOT NULL) '
      + '  AS first_anchored_at, '
      + '  (SELECT COUNT(*) FROM lineup_captures WHERE lead_anchor IS NOT NULL) AS anchored_rows, '
      + '  (SELECT COUNT(*) FROM lineup_captures) AS total_rows, '
      + '  (SELECT MIN(capture_time) FROM lineup_captures) AS first_capture_at',
    params: [],
    bindOrder: [],
  },
  {
    name: 'first-pitch-anchor-coverage',
    description: 'game_log start-anchor coverage by date. Confirms the first-pitch backfill '
      + 'is progressing in production, where only 30 of ~1876 rows carried an anchor before '
      + '2026-08-26. scheduled_start_utc is the column that matters for lineup capture: '
      + 'first_pitch_utc does not exist for a game that has not started, so a pre-game '
      + 'capture can only be lead-bucketed against the schedule.',
    sql:
      'SELECT game_date, COUNT(*) AS games, '
      + '  SUM(CASE WHEN game_pk IS NOT NULL THEN 1 ELSE 0 END) AS with_pk, '
      + '  SUM(CASE WHEN scheduled_start_utc IS NOT NULL THEN 1 ELSE 0 END) AS with_scheduled, '
      + '  SUM(CASE WHEN first_pitch_utc IS NOT NULL THEN 1 ELSE 0 END) AS with_first_pitch '
      + 'FROM game_log WHERE (? IS NULL OR game_date >= ?) '
      + 'GROUP BY game_date ORDER BY game_date DESC LIMIT ?',
    params: [
      { name: 'from',  type: 'string', required: false, default: null },
      { name: 'limit', type: 'int',    required: false, default: 60 },
    ],
    bindOrder: ['from', 'from', 'limit'],
  },
  {
    name: 'backfill-recent',
    description: 'Most recent backfill_jobs rows across all tasks (or filtered by task).',
    sql:
      "SELECT job_id, task, dry_run, status, started_at, finished_at, "
      + "  CASE WHEN LENGTH(COALESCE(error, '')) > 200 THEN SUBSTR(error, 1, 200) || '…' ELSE error END AS error "
      + "FROM backfill_jobs "
      + "WHERE (? IS NULL OR task = ?) "
      + "ORDER BY started_at DESC "
      + "LIMIT ?",
    params: [
      { name: 'task',  type: 'string', required: false, default: null },
      { name: 'limit', type: 'int',    required: false, default: 20 },
    ],
    bindOrder: ['task', 'task', 'limit'],
  },
];

// Index for O(1) lookup by name.
const BY_NAME = new Map(QUERIES.map(q => [q.name, q]));

function getQuery(name) {
  return BY_NAME.get(name) || null;
}

function listQueries() {
  return QUERIES.map(q => ({
    name: q.name,
    description: q.description,
    params: q.params.map(p => ({
      name: p.name,
      type: p.type,
      required: p.required,
      default: p.default,
    })),
  }));
}

// Parse a raw query-string value into the declared type. Returns
// { ok: true, value } or { ok: false, error }. null/undefined-in and
// non-required => uses default; null-in and required => error.
function parseParam(raw, spec) {
  if (raw == null || raw === '') {
    if (spec.required) return { ok: false, error: 'param "' + spec.name + '" is required' };
    return { ok: true, value: spec.default != null ? spec.default : null };
  }
  switch (spec.type) {
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: 'param "' + spec.name + '" must be YYYY-MM-DD' };
      return { ok: true, value: raw };
    case 'string':
      return { ok: true, value: String(raw) };
    case 'string_upper':
      return { ok: true, value: String(raw).toUpperCase() };
    case 'int':
      const n = Number(raw);
      if (!Number.isInteger(n)) return { ok: false, error: 'param "' + spec.name + '" must be an integer' };
      return { ok: true, value: n };
    default:
      return { ok: false, error: 'unknown param type "' + spec.type + '" for "' + spec.name + '"' };
  }
}

// SELECT-only safety check on the whitelist entry's SQL. Belt-and-
// braces against a future maintainer adding a non-read query to the
// whitelist by mistake. Better-sqlite3's .all() would also reject
// writes on some paths, but this is cheaper and clearer.
function assertReadOnly(sql) {
  const t = sql.trim().toUpperCase();
  if (!t.startsWith('SELECT') && !t.startsWith('WITH')) {
    throw new Error('admin-queries: SQL must start with SELECT or WITH — got "' + t.slice(0, 30) + '..."');
  }
}

// Verify each whitelist entry parses & is read-only at module load.
// Any startup failure here is a wiring bug and should crash boot
// (better to fail loudly at deploy than silently ship a broken
// endpoint).
for (const q of QUERIES) {
  assertReadOnly(q.sql);
  if (!Array.isArray(q.bindOrder)) throw new Error('admin-queries: bindOrder missing for ' + q.name);
  const paramNames = new Set(q.params.map(p => p.name));
  for (const b of q.bindOrder) {
    if (!paramNames.has(b)) throw new Error('admin-queries: bindOrder refers to unknown param "' + b + '" in ' + q.name);
  }
}

module.exports = {
  MAX_ROWS,
  getQuery,
  listQueries,
  parseParam,
  QUERIES,
};
