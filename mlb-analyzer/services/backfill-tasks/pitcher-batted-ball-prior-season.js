'use strict';

// Backfill task: 2025 full-season pitcher batted-ball profile, stamped as a
// prior-season snapshot so the as-of lookup has something to resolve to for
// 2026 games that predate the first live capture.
//
// WHY A BACKFILL TASK AND NOT A SCRIPT. A script opens data/mlb.db and is a
// laptop tool; it never reaches production. The historical weather load is
// a registered task for exactly this reason, and this is the same shape of
// job: one fixed window, run once, writes a dated row set.
//
// WHAT IT DOES AND DOES NOT GIVE THE MEASUREMENT.
//
//   It DOES give BETWEEN-PITCHER variation for every 2026 game. A
//   ground-ball starter and a fly-ball starter are distinguishable on
//   2026-04-01 using their 2025 profiles, which is the variation an
//   interaction term needs.
//
//   It does NOT give WITHIN-SEASON drift. Every 2026 game before the first
//   live snapshot resolves to the SAME 2025 row for a given pitcher, so
//   across that stretch the batted-ball term is constant per pitcher. A
//   pitcher who changed his mix in 2026 looks unchanged until the live
//   series starts.
//
// That asymmetry is a property of the corpus, not a defect, and it bounds
// what the interaction measurement can detect. It is written up in
// docs/batted-ball-prior-season-2026-09-13.md and must be stated in any
// result computed on this window.
//
// ROOKIES RESOLVE NULL. A pitcher with no 2025 qualifying row gets no row
// here, so the as-of lookup returns nothing and the consumer contributes
// null -- the same convention as the FRV term, where a missing fielder is
// null rather than an assertion that he is exactly league-average.

const { registerBackfillTask } = require('../backfill-jobs');

// 2025 regular season, generous at both ends so spring and the postseason
// tail cannot trim a start or a finish. FIXED, not derived from today: a
// rolling window would make the backfill return a different corpus every
// time it ran, which is the opposite of a reproducible historical load.
const PRIOR_SEASON_START = '2025-03-01';
const PRIOR_SEASON_END = '2025-11-30';

// Stamped just before the 2026 season so any 2026 game date resolves to it
// under `snapshot_date <= game_date`, and so it sorts before every live
// capture. Not a real capture date and deliberately not pretending to be:
// the source column says prior_season.
const SNAPSHOT_DATE = '2026-03-31';
const SOURCE = 'prior_season';

registerBackfillTask({
  name: 'pitcher_batted_ball_prior_season',
  run: async function ({ db, q, params, dryRun, onProgress }) {
    const cookieRow = q.getSetting.get('fangraphs_session_cookie');
    const cookieValue = cookieRow && cookieRow.value ? String(cookieRow.value).trim() : '';
    if (!cookieValue) {
      throw new Error('fangraphs_session_cookie not configured — this task needs the '
        + 'same Member session the wOBA sync uses');
    }

    const existing = db.prepare(
      'SELECT COUNT(*) n FROM pitcher_batted_ball_snapshot WHERE snapshot_date = ?'
    ).get(SNAPSHOT_DATE).n;

    onProgress({ phase: 'planning', snapshot_date: SNAPSHOT_DATE, source: SOURCE,
      window: { from: PRIOR_SEASON_START, to: PRIOR_SEASON_END }, existing_rows: existing });

    if (dryRun) {
      return {
        task: 'pitcher_batted_ball_prior_season',
        dry_run: true,
        window: { from: PRIOR_SEASON_START, to: PRIOR_SEASON_END },
        snapshot_date: SNAPSHOT_DATE,
        source: SOURCE,
        existing_rows_at_that_date: existing,
        note:
          'Live run: two authenticated FanGraphs pulls (split 5 vs LHB, split 6 vs '
          + 'vs RHB) at strType=3 over the FIXED 2025 window, then one '
          + 'replace-the-date write into pitcher_batted_ball_snapshot with '
          + "source='prior_season'. Does NOT touch pitcher_batted_ball (the "
          + 'current-state table), because a 2025 profile is not the current '
          + 'profile and the live sync owns that row set.',
      };
    }

    const { fetchPitcherBattedBall } = require('../fangraphs');
    const rows = await fetchPitcherBattedBall(cookieValue, {
      start: PRIOR_SEASON_START, end: PRIOR_SEASON_END,
    });
    onProgress({ phase: 'fetched', rows: rows.length });

    // Replace-the-date, so a re-run is idempotent rather than additive.
    // Only the current-state table is left alone -- see the dry-run note.
    const written = q.snapshotPitcherBattedBall(SNAPSHOT_DATE, rows, SOURCE);

    const bySplit = {};
    let bipSum = 0;
    for (const r of rows) {
      bySplit[r.split] = (bySplit[r.split] || 0) + 1;
      bipSum += Number(r.bip) || 0;
    }
    const check = db.prepare(
      "SELECT COUNT(*) n, COUNT(DISTINCT mlb_id) pitchers, SUM(source = ?) tagged "
      + 'FROM pitcher_batted_ball_snapshot WHERE snapshot_date = ?'
    ).get(SOURCE, SNAPSHOT_DATE);

    return {
      task: 'pitcher_batted_ball_prior_season',
      dry_run: false,
      window: { from: PRIOR_SEASON_START, to: PRIOR_SEASON_END },
      snapshot_date: SNAPSHOT_DATE,
      source: SOURCE,
      fetched: rows.length,
      written: written,
      by_split: bySplit,
      total_bip: bipSum,
      verification: {
        rows_at_snapshot_date: check.n,
        distinct_pitchers: check.pitchers,
        all_tagged_prior_season: check.n === check.tagged,
      },
      methodology_note:
        'This row set supplies BETWEEN-PITCHER variation for every 2026 game. It '
        + 'does NOT supply within-season drift: every 2026 game before the first '
        + 'live snapshot resolves to the same 2025 row per pitcher, so the '
        + 'batted-ball term is constant per pitcher across that stretch. Any '
        + 'interaction result computed on that window must say so. '
        + 'docs/batted-ball-prior-season-2026-09-13.md',
    };
  },
});

module.exports = { PRIOR_SEASON_START, PRIOR_SEASON_END, SNAPSHOT_DATE, SOURCE };
