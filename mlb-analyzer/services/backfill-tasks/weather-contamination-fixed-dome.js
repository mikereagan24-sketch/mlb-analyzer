'use strict';

// Backfill task: tag rows at a FIXED DOME that carry outdoor weather.
//
// Bug summary. A fixed dome cannot open, but the roof scraper wrote
// roof_status='open' at confidence 'estimated' on all 72 Tropicana Field
// (venue 12) home games of the 2026 season. computeEffectiveWeather gated
// on roof_status, so those games got the full outdoor treatment:
//
// Measured by this task's own dry run over 2026-03-01..2026-12-31:
//
//   69 graded rows carry non-zero weather
//   temp_run_adj   mean +0.5565, 38.40 runs summed
//   wind_factor    non-zero on 33 rows, 2.762 runs summed (|wf| up to 0.076)
//
// model.js:1389 is `estTot = aRuns + hRuns + windRunAdj + tempRunAdj`, so
// the temp term lands on the total once, at full strength. It is ~14x the
// wind exposure and it is the reason this task exists. The wind half was
// closed FORWARD by the fixedDome guard in calcWindFactor (2026-09-12),
// but that guard does not touch rows already written -- hence 33 of them
// here. An earlier note of "0.032 runs" for wind was the 30-day window
// only; over the season it is 2.762.
//
// Re-run the measurement: POST /admin/backfill/weather_contamination_fixed_dome
// with dry_run true, or node scripts/test-fixed-dome-temp.js (section 5).
//
// THIS TASK IS TAG-ONLY. It does NOT recompute the weather columns, which
// is where it differs from weather_contamination_ari_roof. Rewriting
// temp_run_adj to 0 on a graded row would leave game_log.model_total --
// computed from the OLD temp at emit time -- inconsistent with its own
// stored inputs, and nothing re-runs the model here. So the rows are
// marked instead: weather_contamination_reason records that the emit-time
// price used bad weather (permanently true), and weather_inputs_valid = 0
// takes them out of every re-scoring harness until somebody re-derives
// them deliberately. Same two-sense split as db/schema.js documents.
//
// GRADED ROWS ONLY. Un-graded rows need no tag: the code fix means the
// next weather pass writes 0/0 for them, so they are corrected forward. At
// commit time that is 3 rows.

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');
const { PARKS } = require('../weather');

const REASON = 'fixed_dome_outdoor_temp';

// Derived from PARKS, not a second hand-maintained list. If another park
// is ever marked fixedDome, this task covers it with no edit.
//
// Keyed on the park rather than on venue_id DELIBERATELY: 8 of the 69
// affected rows carry venue_id NULL, so a FIXED_DOME_VENUE_IDS registry
// alongside SEALED_DOME_VENUE_IDS would have silently missed them. Same
// hazard roof-prior.js already warns about for the temp gate, where an
// unrecognised or NULL venue_id has to fail safe.
function fixedDomeKeys() {
  return Object.keys(PARKS).filter((k) => PARKS[k] && PARKS[k].fixedDome);
}

function selectCandidates(db, from, to) {
  const keys = fixedDomeKeys();
  if (!keys.length) return [];
  // game_id is 'away-home', so the home park is the suffix.
  const likes = keys.map(() => 'game_id LIKE ?').join(' OR ');
  const args = keys.map((k) => '%-' + k);
  return db.prepare(
    'SELECT game_date, game_id, venue_id, venue_name, roof_status, roof_confidence, '
    + '  temp_f, temp_run_adj, wind_factor, model_total, weather_inputs_valid, '
    + '  weather_contamination_reason '
    + 'FROM game_log '
    + 'WHERE game_date >= ? AND game_date <= ? '
    + '  AND (' + likes + ') '
    + '  AND away_score IS NOT NULL AND home_score IS NOT NULL '
    + '  AND ((temp_run_adj IS NOT NULL AND temp_run_adj != 0) '
    + '       OR (wind_factor IS NOT NULL AND wind_factor != 0)) '
    + '  AND weather_contamination_reason IS NULL '
    + 'ORDER BY game_date, game_id'
  ).all(from, to, ...args);
}

registerBackfillTask({
  name: 'weather_contamination_fixed_dome',
  run: async function ({ db, params, dryRun, onProgress }) {
    assertDateRange(params);

    const keys = fixedDomeKeys();
    const candidates = selectCandidates(db, params.from, params.to);

    // Exposure, in the unit that matters: runs on the total.
    let sumTemp = 0, sumWindRuns = 0, nWind = 0, nNoModelTotal = 0;
    const byVenue = {};
    for (const r of candidates) {
      sumTemp += Number(r.temp_run_adj) || 0;
      if (r.wind_factor) { nWind++; sumWindRuns += Math.abs(Number(r.wind_factor) * 2.0); }
      if (r.model_total == null) nNoModelTotal++;
      const v = String(r.venue_id == null ? 'null' : r.venue_id);
      byVenue[v] = (byVenue[v] || 0) + 1;
    }
    const exposure = {
      rows: candidates.length,
      temp_runs_summed: Number(sumTemp.toFixed(2)),
      temp_runs_mean: candidates.length ? Number((sumTemp / candidates.length).toFixed(4)) : null,
      rows_with_wind: nWind,
      wind_runs_summed: Number(sumWindRuns.toFixed(4)),
      rows_without_model_total: nNoModelTotal,
      by_venue_id: byVenue,
    };

    onProgress({ phase: 'planning', fixed_dome_park_keys: keys, candidates: candidates.length, exposure });

    const note =
      'TAG ONLY — weather values are NOT recomputed. Sets '
      + "weather_contamination_reason='" + REASON + "' (the emit-time price used "
      + 'outdoor weather in a building that cannot open) AND weather_inputs_valid=0 '
      + '(the stored columns cannot be re-scored from). Un-graded rows are '
      + 'deliberately excluded: the fixedDome guard in computeEffectiveWeather '
      + 'corrects them forward on the next weather pass.';

    if (dryRun) {
      return {
        task: 'weather_contamination_fixed_dome',
        dry_run: true,
        window: { from: params.from, to: params.to },
        reason: REASON,
        fixed_dome_park_keys: keys,
        candidates: candidates.length,
        exposure: exposure,
        note: note,
        sample_candidates: candidates.slice(0, 10).map((r) => ({
          game_date: r.game_date, game_id: r.game_id, venue_id: r.venue_id,
          roof: (r.roof_status || 'null') + '/' + (r.roof_confidence || 'null'),
          temp_f: r.temp_f, temp_run_adj: r.temp_run_adj, wind_factor: r.wind_factor,
          weather_inputs_valid: r.weather_inputs_valid,
        })),
      };
    }

    // Live run. One statement per row inside a single transaction; the
    // guard on weather_contamination_reason IS NULL makes a re-run a
    // no-op rather than a double-tag.
    const upd = db.prepare(
      'UPDATE game_log SET weather_contamination_reason = ?, weather_inputs_valid = 0, '
      + "  updated_at = datetime('now') "
      + 'WHERE game_date = ? AND game_id = ? AND weather_contamination_reason IS NULL'
    );
    let written = 0;
    const tx = db.transaction(function (rows) {
      for (const r of rows) {
        const res = upd.run(REASON, r.game_date, r.game_id);
        written += res.changes;
      }
    });
    tx(candidates);
    onProgress({ phase: 'writing', candidates: candidates.length, written: written });

    // Post-write verification, in the result rather than in a log line.
    const after = db.prepare(
      "SELECT COUNT(*) n, SUM(weather_inputs_valid = 0) invalid FROM game_log "
      + 'WHERE weather_contamination_reason = ?'
    ).get(REASON);

    return {
      task: 'weather_contamination_fixed_dome',
      dry_run: false,
      window: { from: params.from, to: params.to },
      reason: REASON,
      fixed_dome_park_keys: keys,
      candidates: candidates.length,
      written: written,
      exposure: exposure,
      verification: {
        rows_carrying_reason: after.n,
        of_which_weather_inputs_valid_0: after.invalid,
        all_invalid: after.n === after.invalid,
      },
      note: note,
      values_not_overwritten_note:
        'temp_f / temp_run_adj / wind_* were NOT modified. The tag records the '
        + 'defect; weather_inputs_valid=0 excludes the row from re-scoring. A '
        + 'future re-derivation should recompute the weather AND re-run the '
        + 'model together, then clear both flags.',
    };
  },
});

module.exports = { REASON, selectCandidates, fixedDomeKeys };
