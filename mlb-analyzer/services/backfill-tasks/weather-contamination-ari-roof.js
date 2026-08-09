'use strict';

// Backfill task: tag + fix ARI (venue 15) rows contaminated by the
// broken roof scraper (MLB Next.js migration → parseRoofHtml returned
// 0 rows → games defaulted to roof=open under a sealed dome that was
// actually closed).
//
// Bug summary: from ~2026-05 through 2026-08-07, the D-backs roof page
// went client-rendered. The old <td>-scraping parseRoofHtml returned 0
// rows; runWeatherJob's fallback set roof_status='open' /
// roof_confidence='estimated' and applied full temp / wind adjustments
// to games that were actually roof-closed (100°+ Phoenix summers →
// closed every home game). Effect on the local DB snapshot at commit
// time: 27 dirty rows, |Σ temp_run_adj| = 15.00 runs of misapplied
// temp adjustment. Scraper rewrite landed 2026-08-08 (this fix date);
// this backfill retroactively fixes the historical rows.
//
// Three sub-populations, one predicate ("weather signals non-zero for
// a sealed dome that was actually closed"), one fix (recompute
// wind_factor + temp_run_adj under the actual roof from statsapi):
//
//   - closed/actual + dirty weather (7 rows in the snapshot): the
//     post-game corrector flipped roof but pre-Phase-2 corrector didn't
//     recompute weather.
//   - open/estimated + dirty weather (18 rows): scraper failed silently,
//     the corrector's 14-day lookback missed the older ones, weather
//     stayed computed under default-open.
//   - closed/announced + dirty weather (2 rows): scraper flipped roof
//     today but hasn't been through a subsequent weather cycle yet.
//
// Actions per row:
//   1. Fetch actual roof state via statsapi
//      (services/roof-correct.js:fetchActualRoof).
//   2. Recompute wind_factor + temp_run_adj via
//      services/weather.js:computeEffectiveWeather under the actual roof
//      (sealed ARI + closed → both zero).
//   3. UPDATE game_log SET roof_status, roof_confidence='actual',
//      wind_factor, temp_run_adj, weather_contamination_reason.
//
// Idempotency: SELECT and UPDATE both gate on
// weather_contamination_reason IS NULL, matching the ATH/naive-hour
// tagger. Re-runs of the same window are no-ops. Rows already tagged
// under another cohort (e.g. mountain_naive_hour_pre_2026_07_30) are
// LEFT ALONE — the single-string reason design (see
// docs/weather-contamination-single-reason) means whichever tag lands
// first wins; the IS NULL exclusion filter excludes the row regardless.
//
// Tag semantics (differs subtly from ATH/naive-hour): those two cohorts
// are TAG-ONLY because the underlying raw weather values are wrong and
// unrecoverable (wrong hour → wrong reading). Here the raw weather
// (wind_speed, wind_dir, temp_f) IS correct — only the roof gate was
// misapplied — so the fix is a pure recompute of the two effective
// columns. Rows keep the tag for conservative default-exclude
// behavior (backtests filtering `WHERE weather_contamination_reason
// IS NULL` still skip them, matching the tag+values-together policy in
// services/backfill-tasks/weather-backfill-season.js's
// contaminated-row comment). Consumers that specifically want the
// fixed values can `AND weather_contamination_reason NOT LIKE
// 'ari_roof_scraper_%'`.

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');
const { computeEffectiveWeather, PARKS } = require('../weather');
const { fetchActualRoof } = require('../roof-correct');

const REASON = 'ari_roof_scraper_open_default_pre_2026_08_08';
const ARI_VENUE_ID = 15;
const STATSAPI_THROTTLE_MS = 50;  // matches roof-correct.js pacing

// Selects the dirty-row cohort in the requested window. Predicate mirrors
// tmp/inventory-ari-dirty-rows.js's union of the three sub-populations.
// Both IS NULL guards (weather_contamination_reason, and raw weather
// completeness) make the SELECT the source of truth for "candidate";
// nothing downstream widens it.
function selectCandidates(db, from, to) {
  return db.prepare(
    "SELECT game_date, game_id, venue_id, game_pk, "
    + "  roof_status, roof_confidence, "
    + "  wind_speed, wind_dir, wind_factor, temp_f, temp_run_adj "
    + "FROM game_log "
    + "WHERE venue_id = ? AND game_pk IS NOT NULL "
    + "  AND game_date >= ? AND game_date <= ? "
    + "  AND weather_contamination_reason IS NULL "
    + "  AND wind_speed IS NOT NULL AND wind_dir IS NOT NULL AND temp_f IS NOT NULL "
    + "  AND ((wind_factor IS NOT NULL AND wind_factor != 0) "
    + "       OR (temp_run_adj IS NOT NULL AND temp_run_adj != 0))"
  ).all(ARI_VENUE_ID, from, to);
}

registerBackfillTask({
  name: 'weather_contamination_ari_roof',
  run: async function ({ db, params, dryRun, onProgress }) {
    assertDateRange(params);

    const candidates = selectCandidates(db, params.from, params.to);

    // Split the projected diff by current-roof-state so the operator
    // can eyeball which subset is being fixed. Same buckets as the
    // inventory script; useful in both dry-run and live summaries.
    const buckets = { closed_actual_dirty: 0, closed_announced_dirty: 0, open_estimated_dirty: 0, other: 0 };
    for (const r of candidates) {
      const roof = (r.roof_status || '').toLowerCase();
      const conf = r.roof_confidence || '';
      if (roof === 'closed' && conf === 'actual')      buckets.closed_actual_dirty++;
      else if (roof === 'closed' && conf === 'announced') buckets.closed_announced_dirty++;
      else if (roof === 'open')                        buckets.open_estimated_dirty++;
      else                                             buckets.other++;
    }

    onProgress({ phase: 'planning', candidates: candidates.length, buckets });

    if (dryRun) {
      const sample = candidates.slice(0, 10).map(r => ({
        game_date: r.game_date, game_id: r.game_id,
        current_roof: (r.roof_status || 'null') + '/' + (r.roof_confidence || 'null'),
        current_wf: r.wind_factor, current_tra: r.temp_run_adj, temp_f: r.temp_f,
      }));
      return {
        task: 'weather_contamination_ari_roof',
        dry_run: true,
        window: { from: params.from, to: params.to },
        reason: REASON,
        candidates: candidates.length,
        buckets,
        note:
          'Live run: per-row statsapi fetch for actual roof state, recompute '
          + 'wind_factor + temp_run_adj via computeEffectiveWeather under the '
          + 'actual roof (sealed ARI + closed → both zero), UPDATE with tag. '
          + 'Rows without a statsapi actual (pre-final games or blank condition) '
          + 'are skipped; nothing is written for those.',
        sample_candidates: sample,
      };
    }

    // Live run. Per-row statsapi fetch with 50ms throttle so we don't
    // hammer the API (matches roof-correct.js pacing). Everything is
    // read-only until the transaction at the bottom, so a mid-loop
    // crash leaves the DB untouched.
    let fetched = 0, fetchErrors = 0, noData = 0;
    const updates = [];
    for (const r of candidates) {
      let res;
      try {
        res = await fetchActualRoof(r.game_pk);
        fetched++;
      } catch (e) {
        fetchErrors++;
        continue;
      }
      if (res.roof === null) { noData++; continue; }
      const homeKey = String(r.game_id).split('-')[1];
      const park = PARKS[homeKey];
      const eff = computeEffectiveWeather({
        windSpeed: r.wind_speed, windDir: r.wind_dir, tempF: r.temp_f,
        roofStatus: res.roof, venueId: r.venue_id, park,
      });
      updates.push({
        game_date: r.game_date, game_id: r.game_id,
        new_roof_status: res.roof,
        old_repr: (r.roof_status || 'null') + '/' + (r.roof_confidence || 'null')
          + ' wf=' + r.wind_factor + ' tra=' + r.temp_run_adj,
        new_repr: res.roof + '/actual'
          + ' wf=' + eff.windFactor + ' tra=' + eff.tempRunAdj,
        new_wf: eff.windFactor, new_tra: eff.tempRunAdj,
      });
    }

    onProgress({ phase: 'writing', fetched, fetch_errors: fetchErrors, no_data: noData, would_write: updates.length });

    // IS NULL guard on the UPDATE makes this safe against races with
    // another tagger that got there first (would end up as res.changes=0
    // and we count it as skipped rather than fail).
    const upd = db.prepare(
      "UPDATE game_log SET roof_status = ?, roof_confidence = 'actual', "
      + "  wind_factor = ?, temp_run_adj = ?, "
      + "  weather_contamination_reason = ?, updated_at = datetime('now') "
      + "WHERE game_date = ? AND game_id = ? "
      + "  AND weather_contamination_reason IS NULL"
    );
    const writeTx = db.transaction(function (rows) {
      let n = 0;
      const skipped = [];
      for (const u of rows) {
        const info = upd.run(u.new_roof_status, u.new_wf, u.new_tra, REASON,
          u.game_date, u.game_id);
        if (info.changes > 0) n++;
        else skipped.push({ game_date: u.game_date, game_id: u.game_id });
      }
      return { n, skipped };
    });
    const { n: written, skipped } = writeTx(updates);

    // Verification sample (live only).
    let sample = [];
    if (written > 0) {
      sample = db.prepare(
        "SELECT game_date, game_id, roof_status, roof_confidence, "
        + "  wind_factor, temp_run_adj, temp_f, weather_contamination_reason "
        + "FROM game_log WHERE weather_contamination_reason = ? "
        + "ORDER BY game_date DESC LIMIT 5"
      ).all(REASON);
    }

    return {
      task: 'weather_contamination_ari_roof',
      dry_run: false,
      window: { from: params.from, to: params.to },
      reason: REASON,
      candidates: candidates.length,
      buckets,
      fetched,
      fetch_errors: fetchErrors,
      no_data_from_statsapi: noData,
      would_write: updates.length,
      written,
      raced_and_skipped: skipped,
      values_recomputed_note:
        'wind_factor + temp_run_adj were RECOMPUTED under the statsapi-derived '
        + 'actual roof gate (sealed ARI + closed → both zero). This differs '
        + 'from the tag-only ATH/naive-hour cohorts: ARI raw weather '
        + '(wind_speed, wind_dir, temp_f) is correct, only the roof gate was '
        + 'misapplied. Rows keep the tag for conservative default-exclude; '
        + "consumers can include via WHERE weather_contamination_reason NOT LIKE 'ari_roof_scraper_%'.",
      updates_preview: updates.slice(0, 20),
      sample_written_rows: sample,
    };
  },
});

module.exports = { REASON, ARI_VENUE_ID, selectCandidates };
