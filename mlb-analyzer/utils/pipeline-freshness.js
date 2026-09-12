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
 * PER-ROW STALENESS (2026-08-24). MAX(date) is an aggregate over the
 * NEWEST row and says nothing about the oldest -- the same shape of error
 * as reading MAX(game_date) and concluding a pipeline was alive. It bit
 * immediately: catcher_framing is an upsert-per-catcher table that never
 * deleted, so 59 rows written today made it report `ok` while seven rows
 * sat 82 and 95 days behind, one of them pricing a catcher who started
 * that day. Any entry may declare `perRow`, and the pipeline's level is
 * the WORSE of the aggregate and per-row verdicts.
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
 *   perRow          OPTIONAL {sql, warnDays, critDays, note}. sql returns
 *                   one row: v = OLDEST per-row PT date, n = how many rows
 *                   are behind the newest. Only meaningful for tables
 *                   upserted per entity (per catcher, per player, per
 *                   team), where a partial refresh leaves a stale tail.
 *   gaps            OPTIONAL {sql, recentDays, warnCount, critCount, note}.
 *                   sql returns MANY rows, {d, n}: a date INSIDE the
 *                   pipeline's own era that has no row, and how many games
 *                   that date holds. For a per-DATE capture, "last arrival
 *                   is current" says nothing about holes behind it.
 *                   (2026-09-12) woba_data_snapshot reported `ok` all
 *                   season while missing 2026-06-26 and 2026-07-19
 *                   outright. parameter-sweep.js:397 looks the snapshot up
 *                   with `snapshot_date = <game date>`, an EXACT match, so
 *                   each missing day silently dropped its whole slate from
 *                   every calibration corpus: 30 otherwise-perfect graded
 *                   games, gone and unrecoverable -- a snapshot records
 *                   what wOBA looked like that morning and there is no
 *                   backfill for a day that has passed.
 *                   LEVEL IS DRIVEN BY RECENT GAPS ONLY. Older holes can
 *                   never be repaired, so alarming on them forever would
 *                   train the reader to skip the output, which costs more
 *                   than the check is worth (see CLAUDE.md, "Scope a check
 *                   to what it can act on"). They are still PRINTED BY
 *                   NAME every run, because an analysis spanning them
 *                   should say so.
 */

// Gap SQL for a per-DATE capture table, built once and shared by every
// snapshot pipeline (2026-09-12). Six tables need this rule and none of
// them may re-spell it.
//
// THE ERA MUST START AT THE DAILY REGIME, NOT AT THE FIRST ROW EVER.
// The first version of this check (#386) bounded the era by MIN..MAX of
// the capture column, which is only correct when the first capture IS the
// start of daily operation. catcher_framing_snapshot is the counter-
// example: one lone capture on 2026-06-03, an 83-day desert, then daily
// from 2026-08-25. Under the MIN..MAX rule that table reports 81 missing
// dates -- every one of them a date on which nothing was expected -- and a
// check that cries wolf 81 times is one nobody reads, which is the exact
// failure this family of checks exists to avoid.
//
// So the era starts at the first capture whose NEXT capture is within
// maxCadenceDays. Observable from the data, needs no remembered per-table
// start date, and self-corrects if a table's cadence changes. Measured
// effect on catcher_framing_snapshot: 81 reported gaps -> 1 (2026-09-03),
// which is the real one. woba_data_snapshot is unchanged at 3, so the rule
// is backward-compatible with what #386 shipped.
function snapshotGapSql(table, maxCadenceDays) {
  const cadence = maxCadenceDays || 7;
  return 'WITH dates AS (SELECT DISTINCT snapshot_date d FROM ' + table + '), '
    + 'seq AS (SELECT d, LEAD(d) OVER (ORDER BY d) nxt FROM dates), '
    + 'era AS (SELECT (SELECT MIN(d) FROM seq WHERE nxt IS NOT NULL '
    + '                  AND julianday(nxt) - julianday(d) <= ' + cadence + ') lo, '
    + '               (SELECT MAX(d) FROM dates) hi) '
    + 'SELECT g.game_date AS d, COUNT(*) AS n FROM game_log g, era '
    + 'WHERE g.game_date > era.lo AND g.game_date < era.hi '
    + '  AND NOT EXISTS (SELECT 1 FROM ' + table + ' s WHERE s.snapshot_date = g.game_date) '
    + 'GROUP BY g.game_date ORDER BY g.game_date';
}

// The five tables the 6AM chain snapshots, in chain order. A miss on any
// of them is invisible to a last-arrival check the moment the job recovers
// the next day, which is how 2026-09-03 -- a WHOLE-CHAIN miss, all five
// tables plus the 5:30 PT fg-woba job -- went a week without being noticed.
const SNAPSHOT_CHAIN = [
  { key: 'fielding_frv_snapshot',
    note: 'defensive run values freeze; DEFENSE_FRV scoring falls back to the current table, which is hindsight' },
  { key: 'catcher_framing_snapshot',
    note: 'framing rates freeze; forward-honest framing scoring loses the day' },
  { key: 'team_baserunning_snapshot',
    note: 'team BsR freezes; the team-level BsR harness loses the day' },
  { key: 'player_baserunning_snapshot',
    note: 'player BsR freezes; the player-level BsR harness loses the day' },
  { key: 'player_baserunning_trailing_snapshot',
    note: 'trailing-1yr BsR freezes; the FORWARD-HONEST BsR prong drops that date entirely' },
];

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
    // MID-ERA GAP CHECK (2026-09-12). Every game date strictly inside the
    // snapshot era that has no snapshot of its own. Bounded by the era on
    // both sides, so pre-era dates (44 of them, before 2026-05-20) never
    // appear -- no snapshot could exist for those and listing them would
    // be permanent noise. TODAY is excluded because the day's snapshot is
    // written during the day; without that, the check would report a false
    // gap every morning, which is the fastest way to make it unread.
    gaps: {
      sql: snapshotGapSql('woba_data_snapshot'),
      recentDays: 7, warnCount: 1, critCount: 2,
      note: 'a missing snapshot date drops that whole slate from every calibration corpus '
          + '(parameter-sweep.js:397 matches snapshot_date to the game date exactly) and is '
          + 'NOT recoverable afterwards',
    },
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
    // Registered on day one, before there is any data to be stale.
    //
    // Forward capture is the one thing here where a day not running is
    // UNRECOVERABLE -- there is no backfill for "what did RotoWire say at
    // 10AM on a date that has passed". A silent stop costs a day of the
    // only corpus that can answer the horizon question, and the whole
    // reason this table exists is that the same-day pulls ran all season
    // while nothing noticed they were being discarded.
    //
    // The per-row dimension is the important half: the AGGREGATE goes
    // green as long as *some* horizon is landing, and next-day capture
    // would keep it green on its own while same-day silently stopped.
    // perRow tracks the oldest per-horizon max, so one horizon dying is
    // visible even while the other is healthy.
    key: 'lineup_captures',
    sql: 'SELECT MAX(substr(capture_time,1,10)) v FROM lineup_captures',
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 2, critDays: 4,
    note: 'forward lineup capture stopped; a missed day is unrecoverable, there is no backfill',
    perRow: {
      sql: 'SELECT MIN(h) v, SUM(CASE WHEN h < (SELECT MAX(substr(capture_time,1,10)) '
         + 'FROM lineup_captures) THEN 1 ELSE 0 END) n FROM '
         + '(SELECT horizon, MAX(substr(capture_time,1,10)) h FROM lineup_captures GROUP BY horizon)',
      warnDays: 2, critDays: 4,
      note: 'one horizon stopped while the other kept running -- the aggregate cannot see this',
    },
  },
  {
    key: 'team_rosters',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM team_rosters",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 2, critDays: 4,
    note: 'IL moves and callups stop landing; bullpen-aware signals use old rosters',
    perRow: {
      sql: "SELECT MIN(substr(datetime(updated_at,'-7 hours'),1,10)) v, "
         + "SUM(CASE WHEN substr(datetime(updated_at,'-7 hours'),1,10) < "
         + "(SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) FROM team_rosters) "
         + "THEN 1 ELSE 0 END) n FROM team_rosters",
      warnDays: 4, critDays: 10,
      note: 'a tail of players not refreshed with the rest of the roster',
    },
  },
  {
    key: 'fielding_frv',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM fielding_frv",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 3, critDays: 7,
    note: 'a trailing 3yr aggregate; slow-moving, so a longer threshold is honest',
    perRow: {
      sql: "SELECT MIN(substr(datetime(updated_at,'-7 hours'),1,10)) v, "
         + "SUM(CASE WHEN substr(datetime(updated_at,'-7 hours'),1,10) < "
         + "(SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) FROM fielding_frv) "
         + "THEN 1 ELSE 0 END) n FROM fielding_frv",
      // Deliberately looser than catcher_framing's 3/7. FRV is a trailing
      // THREE-SEASON aggregate, so a player whose row is a few weeks old is
      // barely wrong; a current-season framing RATE a few weeks old is. The
      // thresholds encode that difference rather than copying a number.
      //
      // KNOWN OPEN as of 2026-08-24: 44 of 552 rows sit at 2026-05-22,
      // +94d, so this fires today. runFieldingFrvJob has the same
      // never-deletes shape the framing job had, but the right policy is
      // NOT obviously a prune -- a fielder who drops off the leaderboard
      // still has a valid three-year FRV, unlike a stale partial-season
      // framing rate. Awaiting a decision; this is a standing item, not a
      // new incident.
      warnDays: 21, critDays: 60,
      note: 'players dropped from the Savant leaderboard keeping a frozen FRV '
          + '(known open 2026-08-24: 44 rows at +94d, prune policy undecided)',
    },
  },
  {
    key: 'catcher_framing',
    sql: "SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) v FROM catcher_framing",
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 3, critDays: 7,
    note: 'framing RV feeds the pricing path; scheduled daily in the 6AM chain '
        + 'from 2026-08-24 after 82 days unrefreshed',
    perRow: {
      sql: "SELECT MIN(substr(datetime(updated_at,'-7 hours'),1,10)) v, "
         + "SUM(CASE WHEN substr(datetime(updated_at,'-7 hours'),1,10) < "
         + "(SELECT MAX(substr(datetime(updated_at,'-7 hours'),1,10)) FROM catcher_framing) "
         + "THEN 1 ELSE 0 END) n FROM catcher_framing",
      warnDays: 3, critDays: 7,
      note: 'a catcher off the leaderboard keeping a frozen rate that still outranks the historical baseline -- exactly the 2026-08-24 defect',
    },
  },
  {
    key: 'park_factors',
    sql: "SELECT MAX(substr(datetime(pulled_at,'-7 hours'),1,10)) v FROM park_factors",
    // MONTHLY on purpose, so the thresholds are wide on purpose. Savant's
    // index_runs is a regressed three-season aggregate that barely moves;
    // what moved by a third of a run in six days in April 2026 was two
    // humans reading it, not the data. warn at 35d catches a missed monthly
    // run; crit at 70d catches two.
    zone: 'UTC-ts', expectedLagDays: 0, warnDays: 35, critDays: 70,
    note: 'park factor multiplies BOTH teams run estimates on every game; it sat '
        + '127 days unrefreshed as a source literal before this table existed',
    perRow: {
      sql: "SELECT MIN(substr(datetime(pulled_at,'-7 hours'),1,10)) v, "
         + "SUM(CASE WHEN substr(datetime(pulled_at,'-7 hours'),1,10) < "
         + "(SELECT MAX(substr(datetime(pulled_at,'-7 hours'),1,10)) FROM park_factors) "
         + "THEN 1 ELSE 0 END) n FROM park_factors",
      warnDays: 35, critDays: 70,
      note: 'a team left behind by a partial pull -- the ingest refuses to write a partial set, so a split here means something wrote outside the job',
    },
  },
  // The 6AM snapshot chain (2026-09-12). Each is a per-DATE capture, so a
  // gap check is the only thing that can see a missed day once the job
  // recovers -- the last-arrival number is current again the next morning.
  // FOUNDING INSTANCE 2026-09-03: all five missed together, plus the 5:30 PT
  // fg-woba job, on a day with 726 cron rows and no restart signature. It was
  // found a WEEK LATE by diffing snapshot dates against a calendar.
  ...SNAPSHOT_CHAIN.map(function (t) {
    return {
      key: t.key,
      sql: 'SELECT MAX(snapshot_date) v FROM ' + t.key,
      zone: 'PT-date', expectedLagDays: 0, warnDays: 2, critDays: 3,
      note: t.note,
      gaps: {
        sql: snapshotGapSql(t.key),
        recentDays: 7, warnCount: 1, critCount: 2,
        note: 'a missed capture cannot be backfilled -- the snapshot records what that '
            + 'day looked like, and forward-honest scoring for the date is gone',
      },
    };
  }),
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

    // PER-ROW pass. The aggregate above says the newest row is current;
    // this asks whether the OLDEST one is. The pipeline's level is the
    // WORSE of the two -- a table can be freshly written and still carry a
    // stale tail, which is exactly the state that reported `ok` on
    // 2026-08-24 while pricing a catcher off a 95-day-old rate.
    let perRow = null;
    if (p.perRow) {
      try {
        const pr = db.prepare(p.perRow.sql).get();
        const oldest = pr && pr.v ? String(pr.v).slice(0, 10) : null;
        const behind = pr && pr.n != null ? Number(pr.n) : 0;
        if (oldest) {
          const pLag = dayDiff(today, oldest);
          const pExcess = pLag - p.expectedLagDays;
          let pLevel = 'ok';
          if (pExcess >= p.perRow.critDays) pLevel = 'CRITICAL';
          else if (pExcess >= p.perRow.warnDays) pLevel = 'STALE';
          perRow = { oldest, rowsBehindNewest: behind, lagDays: pLag,
                     excess: pExcess, level: pLevel, note: p.perRow.note };
          if (pLevel === 'CRITICAL' && level !== 'CRITICAL') {
            if (level === 'STALE') warn--;
            level = 'CRITICAL'; crit++;
          } else if (pLevel === 'STALE' && level === 'ok') {
            level = 'STALE'; warn++;
          }
        }
      } catch (e) {
        // A per-row query that cannot run must not take the whole check
        // down, but it must not read as a pass either.
        perRow = { error: e && e.message, level: 'CRITICAL' };
        if (level !== 'CRITICAL') { if (level === 'STALE') warn--; level = 'CRITICAL'; crit++; }
      }
    }

    // MID-ERA GAP pass. The aggregate says the newest capture is current
    // and perRow says the oldest row is; neither can see a date MISSING
    // from the middle. Level is driven by RECENT gaps only -- older holes
    // are unrepairable, and a check that fails forever on unfixable
    // history is a check nobody reads. Old gaps are still reported.
    let gaps = null;
    if (p.gaps) {
      try {
        const all = db.prepare(p.gaps.sql).all()
          .map((r) => ({ date: String(r.d).slice(0, 10), games: Number(r.n) || 0 }))
          .filter((r) => r.date !== today);     // today's capture may still be pending
        const recent = all.filter((r) => dayDiff(today, r.date) <= p.gaps.recentDays);
        let gLevel = 'ok';
        if (recent.length >= p.gaps.critCount) gLevel = 'CRITICAL';
        else if (recent.length >= p.gaps.warnCount) gLevel = 'STALE';
        gaps = {
          missing: all, missingCount: all.length,
          recent: recent, recentCount: recent.length,
          gamesLost: all.reduce((s, r) => s + r.games, 0),
          recentDays: p.gaps.recentDays, level: gLevel, note: p.gaps.note,
        };
        if (gLevel === 'CRITICAL' && level !== 'CRITICAL') {
          if (level === 'STALE') warn--;
          level = 'CRITICAL'; crit++;
        } else if (gLevel === 'STALE' && level === 'ok') {
          level = 'STALE'; warn++;
        }
      } catch (e) {
        // Same rule as perRow: a gap query that cannot run must not take
        // the check down, and must not read as a pass either.
        gaps = { error: e && e.message, level: 'CRITICAL' };
        if (level !== 'CRITICAL') { if (level === 'STALE') warn--; level = 'CRITICAL'; crit++; }
      }
    }

    rows.push({ key: p.key, last, lagDays: lag, excess, level,
                expectedLagDays: p.expectedLagDays, zone: p.zone, detail: p.note,
                perRow, gaps });
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

  // Mid-era gaps are reported even on an all-OK run, because a historical
  // hole does not raise the level and would otherwise never be mentioned
  // again. This is the line that would have named 2026-06-26 and
  // 2026-07-19 the morning after each of them.
  for (const row of r.rows) {
    if (!row.gaps) continue;
    if (row.gaps.error) {
      console.warn('[freshness]     ' + row.key + ' gap check failed: ' + row.gaps.error);
    } else if (row.gaps.missingCount) {
      console.warn('[freshness]     ' + row.key + ' MID-ERA GAPS: '
        + row.gaps.missingCount + ' date(s), ' + row.gaps.gamesLost + ' game(s) lost'
        + (row.gaps.recentCount ? ' (' + row.gaps.recentCount + ' recent)' : ' (all historical)')
        + ' -- ' + row.gaps.missing.map((g) => g.date + '(' + g.games + ')').join(' ')
        + '  -- ' + row.gaps.note);
    }
  }

  if (r.ok) {
    console.log('[freshness] OK  ' + r.rows.length + ' pipelines current as of ' + r.asOf);
    return r;
  }

  console.warn('[freshness] *** ' + (r.crit + r.warn) + ' PIPELINE(S) BEHIND as of ' + r.asOf
    + '  (' + r.crit + ' critical, ' + r.warn + ' stale) ***');
  for (const row of r.rows) {
    if (row.level === 'ok') continue;
    console.warn('[freshness]     ' + row.level.padEnd(9) + row.key.padEnd(36)
      + 'last=' + (row.last || 'none')
      + (row.excess != null ? ('  +' + row.excess + 'd beyond normal lag') : '')
      + '  -- ' + row.detail);
    // Say WHICH half fired. "newest row is current but N rows are not" is a
    // different problem from "nothing has arrived", and the fixes differ.
    if (row.perRow && row.perRow.level && row.perRow.level !== 'ok') {
      if (row.perRow.error) {
        console.warn('[freshness]         per-row check failed: ' + row.perRow.error);
      } else {
        console.warn('[freshness]         PER-ROW: oldest row ' + row.perRow.oldest
          + '  (+' + row.perRow.excess + 'd), ' + row.perRow.rowsBehindNewest
          + ' row(s) behind the newest  -- ' + row.perRow.note);
      }
    }
  }
  console.warn('[freshness]     if this is an analysis COPY of the database this is not an outage'
    + ' -- refresh it before measuring anything (scripts/refresh-analysis-db.sh)');
  return r;
}

module.exports = { checkPipelineFreshness, logPipelineFreshness, PIPELINES, todayPt, dayDiff,
  SNAPSHOT_CHAIN, snapshotGapSql };
