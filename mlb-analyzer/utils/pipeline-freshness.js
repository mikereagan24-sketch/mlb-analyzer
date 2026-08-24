'use strict';
/**
 * Ingest-freshness check. (2026-08-24)
 *
 * THE FAILURE MODE. A job stops and nothing says so. The gate-health
 * check (services/feature-gate-registry.js) covers feature gates; the
 * settings-sync check (utils/settings-sync-check.js) covers settings;
 * /health covers FanGraphs wOBA upload age. NOTHING covered ingest
 * freshness -- whether scores, pitcher logs, market captures or the
 * slate itself are still arriving.
 *
 * That gap cost a full day on 2026-08-23/24. An analysis copy of the DB
 * had not been refreshed since 2026-08-06; every measurement run against
 * it silently used a corpus that ended eighteen days earlier, and the
 * staleness was eventually mistaken for a production outage. Production
 * was healthy the whole time. Neither the "is production broken" question
 * nor the "is my copy stale" question had an answer you could look up --
 * this module answers both, because it is the same question asked of
 * whichever database you point it at.
 *
 * WHY expectedLagDays RATHER THAN A FLAT THRESHOLD. Pipelines have
 * different natural lags. Yesterday's scores land at 4AM PT, so
 * "game_log scored" is ALWAYS at least one day behind and a flat two-day
 * rule would be measuring cadence, not health. The slate runs the other
 * way -- the 8PM prefetch means tomorrow's games exist tonight, so its
 * expected lag is negative. Each entry declares its own baseline and the
 * thresholds apply to the EXCESS over that baseline.
 *
 * TIMESTAMP UNITS. Per the discipline in CLAUDE.md, every entry states
 * the zone of the column it reads. Mixing a UTC column into a PT
 * comparison produces a spurious one-day error, which is the same size as
 * the signal being measured. Columns written by SQL datetime('now') are
 * UTC and are shifted before truncation; columns written by nowPtIso()
 * are already PT; game_date and snapshot_date are PT calendar dates.
 */

// Days between two PT calendar dates, both YYYY-MM-DD.
function dayDiff(aIso, bIso) {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
  return Math.round((a - b) / 86400000);
}

// Today as a PT calendar date, matching how game_date is written.
function todayPt() {
  return new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The registry. Each entry:
 *   key             short name shown in output
 *   sql             returns one row, one column, a PT YYYY-MM-DD string
 *   zone            documented zone of the source column
 *   expectedLagDays normal distance behind today; excess over this is
 *                   what the thresholds measure
 *   warnDays        excess at which it reports as STALE
 *   critDays        excess at which it reports as CRITICAL
 *   note            what breaks downstream when this one stops
 */
const PIPELINES = [
  {
    key: 'cron_log',
    sql: "SELECT MAX(substr(datetime(ran_at,'-7 hours'),1,10)) v FROM cron_log",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 1, critDays: 2,
    note: 'the meta-check: if no job has logged a run, the whole chain is down',
  },
  {
    key: 'game_log slate',
    sql: 'SELECT MAX(game_date) v FROM game_log',
    zone: 'PT-date', expectedLagDays: -1, warnDays: 2, critDays: 3,
    note: 'the 8PM prefetch normally puts tomorrow on the board tonight',
  },
  {
    key: 'game_log scored',
    sql: 'SELECT MAX(game_date) v FROM game_log WHERE home_score IS NOT NULL',
    zone: 'PT-date', expectedLagDays: 1, warnDays: 2, critDays: 3,
    note: 'nothing is grading bets; ROI, CLV and every backtest freeze',
  },
  {
    key: 'pitcher_game_log',
    sql: 'SELECT MAX(game_date) v FROM pitcher_game_log',
    zone: 'PT-date', expectedLagDays: 1, warnDays: 2, critDays: 3,
    note: 'SP actuals stop accumulating; the BF-weighted blend silently freezes',
  },
  {
    key: 'woba_data_snapshot',
    sql: 'SELECT MAX(snapshot_date) v FROM woba_data_snapshot',
    zone: 'PT-date', expectedLagDays: 0, warnDays: 2, critDays: 3,
    note: 'batter inputs freeze; every signal is priced on old wOBA',
  },
  {
    key: 'empirical_market_captures',
    sql: 'SELECT MAX(substr(generated_at,1,10)) v FROM empirical_market_captures',
    zone: 'PT-ts', expectedLagDays: 0, warnDays: 2, critDays: 4,
    note: 'closing lines stop being observed; CLV falls back to re-derivation',
  },
  {
    key: 'bet_signals',
    sql: 'SELECT MAX(substr(created_at,1,10)) v FROM bet_signals',
    zone: 'PT-ts', expectedLagDays: 0, warnDays: 2, critDays: 4,
    note: 'no signals emitted; either the slate is empty or the rerun step died',
  },
  {
    key: 'team_rosters',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM team_rosters",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 2, critDays: 4,
    note: 'IL moves and callups stop landing; bullpen-aware signals use old rosters',
  },
  {
    key: 'fielding_frv',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM fielding_frv",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 3, critDays: 7,
    note: 'a trailing 3yr aggregate; slow-moving, so a longer threshold is honest',
  },
  {
    key: 'catcher_framing',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM catcher_framing",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 14, critDays: 45,
    note: 'no cron refreshes this; it is fetched by hand. The long thresholds '
        + 'describe the actual cadence, they do not endorse it',
  },
];

/**
 * @param db    better-sqlite3 handle
 * @param asOf  PT date string to compare against; defaults to today PT
 * @returns {{asOf, rows, warn, crit, ok}}
 */
function checkPipelineFreshness(db, asOf) {
  const today = asOf || todayPt();
  const rows = [];
  let warn = 0, crit = 0;

  for (const p of PIPELINES) {
    let last = null, err = null;
    try {
      const r = db.prepare(p.sql).get();
      last = r && r.v ? String(r.v).slice(0, 10) : null;
    } catch (e) {
      err = e && e.message;
    }

    // A pipeline that cannot be read at all is a CRITICAL finding, not a
    // skip -- a dropped table looks identical to a stopped job downstream.
    if (err || !last) {
      crit++;
      rows.push({ key: p.key, last: null, lagDays: null, excess: null, level: 'CRITICAL',
                  detail: err ? ('query failed: ' + err) : ('no rows at all -- ' + p.note) });
      continue;
    }

    const lag = dayDiff(today, last);
    const excess = lag - p.expectedLagDays;
    let level = 'ok';
    if (excess >= p.critDays) { level = 'CRITICAL'; crit++; }
    else if (excess >= p.warnDays) { level = 'STALE'; warn++; }

    rows.push({ key: p.key, last, lagDays: lag, excess, level,
                expectedLagDays: p.expectedLagDays, zone: p.zone, detail: p.note });
  }

  return { asOf: today, rows, warn, crit, ok: warn === 0 && crit === 0 };
}

/**
 * Cron-friendly wrapper. Never throws -- a check that can abort the
 * morning chain is worse than the staleness it detects.
 */
function logPipelineFreshness(db, asOf) {
  let r;
  try {
    r = checkPipelineFreshness(db, asOf);
  } catch (e) {
    console.warn('[freshness] check failed (non-fatal): ' + (e && e.message));
    return null;
  }

  if (r.ok) {
    console.log('[freshness] OK  ' + r.rows.length + ' pipelines current as of ' + r.asOf);
    return r;
  }

  console.warn('[freshness] *** ' + (r.crit + r.warn) + ' PIPELINE(S) BEHIND as of ' + r.asOf
    + '  (' + r.crit + ' critical, ' + r.warn + ' stale) ***');
  for (const row of r.rows) {
    if (row.level === 'ok') continue;
    console.warn('[freshness]     ' + row.level.padEnd(9) + row.key.padEnd(28)
      + 'last=' + (row.last || 'none')
      + (row.excess != null ? ('  +' + row.excess + 'd beyond normal lag') : '')
      + '  -- ' + row.detail);
  }
  console.warn('[freshness]     if this is an analysis COPY of the database this is not an outage'
    + ' -- refresh it before measuring anything (scripts/refresh-analysis-db.sh)');
  return r;
}

module.exports = { checkPipelineFreshness, logPipelineFreshness, PIPELINES, todayPt, dayDiff };
