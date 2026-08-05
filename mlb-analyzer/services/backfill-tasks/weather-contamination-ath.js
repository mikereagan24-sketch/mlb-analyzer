'use strict';

// Backfill task: tag ATH home games whose weather values were pulled
// from the wrong coordinates.
//
// Two distinct reason codes:
//   'ath_coliseum_coords_pre_2026_07_27'
//     — ATH home games (game_date >= from) that pulled Oakland Coliseum
//       weather from a stale PARKS[ath] entry, instead of Sutter Health
//       Park.
//   'ath_vegas_venue_override_not_propagated_pre_2026_07_27'
//     — the 6 Vegas-series "home" games 2026-06-08..14 (venue_id=5355)
//       where the scraper captured the venue_id but the weather fetch
//       fell through to PARKS[ath] anyway.
//
// Only sets weather_contamination_reason. Does NOT overwrite
// wind_speed / wind_dir / wind_factor / temp_f / temp_run_adj — the
// persisted values remain the historical record of what the model saw
// at signal-emission time. Downstream backtests filter WHERE
// weather_contamination_reason IS NULL when weather is load-bearing.
//
// Ported from scripts/tag-ath-coliseum-weather-contamination-2026-07-27.js
// with the hardcoded 2026-03-01 start replaced by params.from.
//
// Idempotency: the UPDATE guards on weather_contamination_reason IS NULL
// so already-tagged rows are never overwritten.

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');

const COLISEUM_REASON = 'ath_coliseum_coords_pre_2026_07_27';
const VEGAS_REASON    = 'ath_vegas_venue_override_not_propagated_pre_2026_07_27';
const VEGAS_VENUE_ID  = 5355;
const VEGAS_FROM_DATE = '2026-06-08';
const VEGAS_TO_DATE   = '2026-06-14';

registerBackfillTask({
  name: 'weather_contamination_ath',
  run: async function ({ db, params, dryRun, onProgress }) {
    assertDateRange(params);

    const athHome = db.prepare(
      "SELECT game_date, game_id, venue_id, wind_factor, temp_run_adj, weather_contamination_reason "
      + "FROM game_log "
      + "WHERE game_date >= ? AND game_date <= ? AND home_team='ATH' AND wind_factor IS NOT NULL"
    ).all(params.from, params.to);

    const vegas    = athHome.filter(r =>
      r.game_date >= VEGAS_FROM_DATE && r.game_date <= VEGAS_TO_DATE && r.venue_id === VEGAS_VENUE_ID);
    const coliseum = athHome.filter(r =>
      !(r.game_date >= VEGAS_FROM_DATE && r.game_date <= VEGAS_TO_DATE && r.venue_id === VEGAS_VENUE_ID));

    const alreadyTagged = athHome.filter(r => r.weather_contamination_reason != null);

    onProgress({
      phase: 'planning',
      ath_home_rows: athHome.length,
      coliseum_candidates: coliseum.length,
      vegas_candidates: vegas.length,
      already_tagged: alreadyTagged.length,
    });

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

    // Untagged-only candidate counts drive the "would_write" projection
    // (matches the actual UPDATE gate: reason IS NULL).
    const coliseumCandidates = coliseum.filter(r => r.weather_contamination_reason == null);
    const vegasCandidates    = vegas.filter(r => r.weather_contamination_reason == null);

    let wroteColiseum = 0, wroteVegas = 0;
    if (!dryRun) {
      wroteColiseum = writeTx(coliseumCandidates, COLISEUM_REASON);
      wroteVegas    = writeTx(vegasCandidates,    VEGAS_REASON);
    }

    // Verification sample (post-write, live only). Small enough to
    // inline in the response.
    let sample = [];
    if (!dryRun && (wroteColiseum + wroteVegas) > 0) {
      sample = db.prepare(
        "SELECT game_date, game_id, wind_factor, temp_f, weather_contamination_reason "
        + "FROM game_log WHERE weather_contamination_reason LIKE 'ath_%' "
        + "AND game_date >= ? AND game_date <= ? "
        + "ORDER BY game_date DESC LIMIT 5"
      ).all(params.from, params.to);
    }

    return {
      task: 'weather_contamination_ath',
      dry_run: dryRun,
      window: { from: params.from, to: params.to },
      ath_home_rows_in_window: athHome.length,
      already_tagged: alreadyTagged.length,
      coliseum: {
        reason: COLISEUM_REASON,
        candidates: coliseumCandidates.length,
        written: wroteColiseum,
      },
      vegas: {
        reason: VEGAS_REASON,
        candidates: vegasCandidates.length,
        written: wroteVegas,
      },
      total_would_write: coliseumCandidates.length + vegasCandidates.length,
      total_written: wroteColiseum + wroteVegas,
      values_not_overwritten_note:
        'wind_*/temp_f/temp_run_adj were NOT modified — contamination is tagged, not re-scored. '
        + 'Filter WHERE weather_contamination_reason IS NULL for weather-sensitive backtests.',
      sample_tagged_rows: sample,
    };
  },
});
