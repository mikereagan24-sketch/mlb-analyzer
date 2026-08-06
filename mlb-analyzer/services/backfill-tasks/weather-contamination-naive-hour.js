'use strict';

// Backfill task: tag naive-ET-hour contamination on non-ET home games
// pre-2026-07-30.
//
// Bug summary: pre-commit b71109e (deployed 2026-07-30), runWeatherJob's
// inline Open-Meteo fetch indexed hourly weather by the game's ET
// wall-clock hour directly into the returned park-local hourly array.
// Open-Meteo returns `hourly.time` in the park's local time (via
// `timezone=auto`), so a game at 7 PM ET at Dodger Stadium landed at
// hourly[19] which is 7 PM Los Angeles time — three hours off the
// actual 4 PM PT gametime. The measured slate-wide drift was:
//   - ET parks:      0.00°F  (naive ET hour == park-local hour)
//   - Central parks: ~1°F mean
//   - Mountain:      2-3°F depending on DST
//   - Pacific parks: 8.1°F mean, 14°F max
// Every non-ET home game with `game_date < 2026-07-30` is contaminated.
//
// Naming follows the ATH-tag shape (<scope>_<cause>_pre_<YYYY_MM_DD>):
//   - pacific_naive_hour_pre_2026_07_30
//   - mountain_naive_hour_pre_2026_07_30
//   - central_naive_hour_pre_2026_07_30
// ET parks are NOT tagged (verified 0.00°F drift).
//
// Interaction with existing contamination tags: UPDATE gates on
// `weather_contamination_reason IS NULL` so already-tagged rows
// (the 56 ATH Coliseum/Vegas rows) are never overwritten. This
// matches the single-reason-per-row design decision — when a game
// qualifies for multiple contamination flavors, the earlier tag
// wins; downstream calibration excludes the row regardless via
// `IS NULL` filter.
//
// The `cohorts` body param (optional) restricts tagging to a subset.
// Defaults to all three (`pacific`, `mountain`, `central`).

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');

// Modern abbreviations as stored in game_log.home_team. Legacy aliases
// (sfg, kan, oak) resolve to the same physical park but the abbrev
// column uses the current form.
const COHORTS = {
  pacific:  { teams: ['LAD', 'LAA', 'SD',  'SF',  'SEA', 'ATH'], reason: 'pacific_naive_hour_pre_2026_07_30' },
  mountain: { teams: ['COL', 'ARI'],                              reason: 'mountain_naive_hour_pre_2026_07_30' },
  central:  { teams: ['CHC', 'CWS', 'MIL', 'MIN', 'STL', 'HOU', 'TEX', 'KC'], reason: 'central_naive_hour_pre_2026_07_30' },
};

// Fix date the tag suffix references. Any row with game_date < this
// value + home_team in a non-ET cohort is contaminated.
const CUTOFF_DATE = '2026-07-30';

registerBackfillTask({
  name: 'weather_contamination_naive_hour',
  run: async function ({ db, params, dryRun, onProgress }) {
    assertDateRange(params);

    // Resolve cohorts to run. Default all three; explicit filter lets
    // the operator run one cohort at a time if needed.
    const wantedCohorts = params.cohorts && Array.isArray(params.cohorts) && params.cohorts.length
      ? params.cohorts.filter(c => COHORTS[c])
      : Object.keys(COHORTS);

    // Effective end date is the earlier of params.to and (CUTOFF_DATE − 1).
    // Any row on or after CUTOFF_DATE ran on the fixed code path and
    // must NOT be tagged. We compute this once and slice the query.
    const cutoffMinusOne = (() => {
      const d = new Date(CUTOFF_DATE + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const effectiveTo = params.to < cutoffMinusOne ? params.to : cutoffMinusOne;

    // Planning: candidates per cohort in the effective window.
    const perCohort = {};
    let totalCandidates = 0;
    let totalAlreadyTagged = 0;

    for (const cohort of wantedCohorts) {
      const teams = COHORTS[cohort].teams;
      const placeholders = teams.map(() => '?').join(',');
      const rows = db.prepare(
        "SELECT game_date, game_id, home_team, weather_contamination_reason "
        + "FROM game_log "
        + "WHERE game_date >= ? AND game_date <= ? "
        + "  AND UPPER(home_team) IN (" + placeholders + ") "
        + "  AND COALESCE(is_removed, 0) = 0"
      ).all(params.from, effectiveTo, ...teams);
      const untagged = rows.filter(r => r.weather_contamination_reason == null);
      const alreadyTagged = rows.filter(r => r.weather_contamination_reason != null);
      perCohort[cohort] = { reason: COHORTS[cohort].reason, total_in_window: rows.length, would_tag: untagged.length, already_tagged: alreadyTagged.length, rows: untagged };
      totalCandidates += untagged.length;
      totalAlreadyTagged += alreadyTagged.length;
    }

    onProgress({
      phase: 'planning',
      effective_to: effectiveTo,
      cutoff_date: CUTOFF_DATE,
      per_cohort_would_tag: Object.fromEntries(
        Object.entries(perCohort).map(([c, v]) => [c, v.would_tag])),
      total_would_tag: totalCandidates,
      total_already_tagged_left_alone: totalAlreadyTagged,
    });

    // Write path. Same IS NULL guard as the ATH tagger so already-
    // tagged rows are safe.
    const upd = db.prepare(
      "UPDATE game_log SET weather_contamination_reason = ?, updated_at = datetime('now') "
      + "WHERE game_date = ? AND game_id = ? AND weather_contamination_reason IS NULL"
    );
    const writeTx = db.transaction(function (rows, reason) {
      let n = 0;
      for (const r of rows) {
        const res = upd.run(reason, r.game_date, r.game_id);
        if (res.changes > 0) n++;
      }
      return n;
    });

    const perCohortWritten = {};
    let totalWritten = 0;
    if (!dryRun) {
      for (const cohort of wantedCohorts) {
        const c = perCohort[cohort];
        const wrote = writeTx(c.rows, c.reason);
        perCohortWritten[cohort] = wrote;
        totalWritten += wrote;
      }
    }

    // Sample verification (live only). One row per cohort.
    const sampleTagged = [];
    if (!dryRun && totalWritten > 0) {
      for (const cohort of wantedCohorts) {
        const reason = COHORTS[cohort].reason;
        const s = db.prepare(
          "SELECT game_date, game_id, home_team, temp_f, wind_factor, weather_contamination_reason "
          + "FROM game_log WHERE weather_contamination_reason = ? "
          + "ORDER BY game_date DESC LIMIT 2"
        ).all(reason);
        sampleTagged.push({ cohort, samples: s });
      }
    }

    return {
      task: 'weather_contamination_naive_hour',
      dry_run: dryRun,
      window: { from: params.from, to: params.to, effective_to: effectiveTo },
      cutoff_date: CUTOFF_DATE,
      cohorts_processed: wantedCohorts,
      per_cohort: Object.fromEntries(
        Object.entries(perCohort).map(([c, v]) => [c, {
          reason: v.reason,
          total_in_window: v.total_in_window,
          would_tag: v.would_tag,
          already_tagged_left_alone: v.already_tagged,
          written: perCohortWritten[c] || 0,
        }])),
      total_would_tag: totalCandidates,
      total_already_tagged_left_alone: totalAlreadyTagged,
      total_written: totalWritten,
      sample_tagged_rows: sampleTagged,
      values_not_overwritten_note:
        'wind_*/temp_f/temp_run_adj were NOT modified — contamination is tagged, not re-scored. '
        + 'Downstream calibration filters WHERE weather_contamination_reason IS NULL exclude these rows regardless of the specific reason string.',
    };
  },
});
