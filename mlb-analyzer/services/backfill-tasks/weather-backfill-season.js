'use strict';

// Backfill task: season weather backfill at correct park-local hour,
// venue-override chain honored, roof gating preserved.
//
// Phase A of the season weather correctness pass. Two goals:
//
//   1. Recompute wind_speed / wind_dir / wind_factor / temp_f /
//      temp_run_adj / roof_status / roof_confidence for historical
//      game_log rows using the CURRENT weather pipeline — which fixes
//      the naive-ET-hour indexing bug (pre-2026-07-29) and the
//      Vegas-venue-override bug (pre-2026-07-27). Signals aren't
//      rewritten (post-lock immutability); only the weather columns
//      are refreshed for downstream calibration.
//
//   2. Preserve the roof-gated write semantics. temp_run_adj must NOT
//      be recomputed by bucketing temp_f alone — that would apply
//      heat adjustments to closed-roof games that correctly have
//      temp_run_adj=0. We hit this correctness bar by REUSING
//      runWeatherJob(date) rather than reimplementing the gating.
//      See services/jobs.js:3115-3184 for the reference gating.
//
// Contaminated-row policy (weather_contamination_reason IS NOT NULL):
//   SKIP. Those rows are already excluded from calibration by the
//   tag; overwriting their values with a fresh fetch would
//   un-contaminate the numeric fields without clearing the tag,
//   leaving them permanently excluded despite being fixed. Cleanest
//   read: leave the known-wrong values in place so the tag stays
//   consistent with reality. If a future pass wants to re-include
//   these rows, it should be a separate clear-and-recompute task.
//
// Because runWeatherJob(date) processes ALL games for a date, we
// snapshot contaminated rows before the call and RESTORE them from
// snapshot after — that keeps the reuse-runWeatherJob path clean
// without adding a filter param to shared code.
//
// Dry-run semantics: cannot use runWeatherJob (it writes). Instead we
// call fetchWindAtCoords read-only against each non-contaminated row,
// compute the would-be new temp_f, and report BUCKET CROSSINGS against
// the currently-stored temp_f. Buckets are the same 55/70/80 thresholds
// runWeatherJob uses. temp_run_adj isn't recomputed in dry-run — we
// report the temp_f bucket delta (a superset of temp_run_adj changes)
// so the operator can eyeball the projected write scope without the
// task duplicating the roof-gating logic. Live run gets the true
// temp_run_adj change count from post-runWeatherJob state.
//
// Observed-vs-forecast caveat (see
// docs/season-weather-backfill-observed-vs-forecast-2026-08.md):
// for historical dates, Open-Meteo returns OBSERVED values, not the
// forecast that was live at signal-emission time. Using observed
// values downstream introduces a mild hindsight bias in any
// calibration that relies on "what did the model see at emit time".
// Backtest harnesses that need emit-time inputs should pin against
// a pre-backfill snapshot rather than the refreshed column.

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');

const TEMP_BUCKET_EDGES = [55, 70, 80];   // matches jobs.js:3118

// Snapshot columns runWeatherJob writes (jobs.js:3183). Restored for
// contaminated rows after the runWeatherJob(date) call so those rows
// keep their known-wrong values (paired with the contamination tag).
const RESTORE_COLS = [
  'wind_speed', 'wind_dir', 'wind_factor',
  'temp_f', 'temp_run_adj',
  'roof_status', 'roof_confidence',
  'weather_quality', 'weather_quality_at',
];

function tempBucket(tempF) {
  if (tempF == null) return null;
  for (let i = 0; i < TEMP_BUCKET_EDGES.length; i++) {
    if (tempF < TEMP_BUCKET_EDGES[i]) return i;   // 0..2
  }
  return TEMP_BUCKET_EDGES.length;                // 3 (≥80)
}

function bucketCrossingLabel(before, after) {
  if (before == null || after == null) return 'unknown';
  if (before === after) return 'unchanged';
  const delta = after - before;
  if (delta === 1)  return 'up_one';
  if (delta === -1) return 'down_one';
  if (delta > 1)    return 'up_multi';
  return 'down_multi';
}

// Enumerate YYYY-MM-DD strings from `from` to `to` inclusive.
function eachDate(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  const end   = new Date(to   + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

registerBackfillTask({
  name: 'weather_backfill_season',
  run: async function ({ db, q, params, dryRun, onProgress }) {
    assertDateRange(params);

    const jobs = require('../jobs');
    const { runWeatherJob } = jobs;
    const { fetchWindAtCoords, PARKS, _internal: { PARK_TZ } } = require('../weather');
    const { VENUE_ID_OVERRIDES } = require('../model');
    const { pickVenueOverride } = require('../scraper');
    const { isSealedDome } = require('../roof-prior');

    // Total-scope planning read: how many rows are in play, and how
    // many are already contaminated (and will be skipped).
    const planning = db.prepare(
      "SELECT "
      + "  COUNT(*) AS total, "
      + "  SUM(CASE WHEN weather_contamination_reason IS NOT NULL THEN 1 ELSE 0 END) AS contaminated, "
      + "  SUM(CASE WHEN weather_contamination_reason IS NULL THEN 1 ELSE 0 END) AS in_scope "
      + "FROM game_log WHERE game_date >= ? AND game_date <= ? AND COALESCE(is_removed, 0) = 0"
    ).get(params.from, params.to);
    onProgress({ phase: 'planning', ...planning });

    // Crossing histogram + failure buckets. Same shape for dry / live
    // so operator diffs are apples-to-apples.
    const crossings = { unchanged: 0, up_one: 0, down_one: 0, up_multi: 0, down_multi: 0, unknown: 0 };
    const materialCrossings = { unchanged: 0, up_one: 0, down_one: 0, up_multi: 0, down_multi: 0, unknown: 0 };
    const fetchFailures = { empty_response: 0, bad_index: 0, non_finite_value: 0, exception: 0, other: 0 };
    const skipReasons   = { dome: 0, no_park: 0, contaminated: 0, no_temp_stored: 0 };
    const sampleRows    = [];    // first 10 changed rows for eyeball
    const dates = eachDate(params.from, params.to);
    let processed = 0;
    let totalRowsSeen = 0;
    let liveWritesUpdated = 0;

    for (const date of dates) {
      // ---- LIVE PATH ----
      if (!dryRun) {
        // 1. Snapshot every row for the date BEFORE the runWeatherJob
        //    call. Contaminated rows will be restored from this; other
        //    rows contribute their old temp_f to the bucket-diff.
        const before = db.prepare(
          "SELECT game_id, temp_f, wind_factor, wind_speed, wind_dir, temp_run_adj, "
          + "  roof_status, roof_confidence, weather_quality, weather_quality_at, "
          + "  weather_contamination_reason "
          + "FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0"
        ).all(date);
        if (!before.length) { processed++; continue; }
        const beforeById = new Map(before.map(r => [r.game_id, r]));
        const contaminated = before.filter(r => r.weather_contamination_reason != null);

        // 2. Reuse runWeatherJob wholesale — it handles the venue-
        //    override chain, park-local hour, and roof gating exactly
        //    as production does. This is the correctness anchor.
        let jobRes = null;
        try {
          // archive:true routes fetchWindAtCoords onto Open-Meteo's
          // archive-api. Applies to the ENTIRE window (not just old
          // dates) so the season dataset stays homogeneous — mixing
          // observed archive vs rolling-forecast responses would
          // corrupt Phase C attribution. See the doc for the
          // observed-vs-forecast hindsight-bias implication.
          jobRes = await runWeatherJob(date, { archive: true });
        } catch (e) {
          console.warn('[weather-backfill] runWeatherJob(' + date + ') threw:', e.message);
          fetchFailures.exception += before.length;
          processed++;
          continue;
        }
        if (jobRes && typeof jobRes.updated === 'number') liveWritesUpdated += jobRes.updated;

        // 3. Restore contaminated rows to their pre-write state.
        //    Rewrites the exact columns runWeatherJob touched
        //    (RESTORE_COLS). weather_contamination_reason itself is
        //    never touched by runWeatherJob so no restore needed.
        if (contaminated.length) {
          const restoreSql = db.prepare(
            "UPDATE game_log SET "
            + RESTORE_COLS.map(c => c + '=?').join(', ')
            + ", updated_at = datetime('now') "
            + "WHERE game_date = ? AND game_id = ?"
          );
          const restoreTx = db.transaction(function (rows) {
            for (const r of rows) {
              const vals = RESTORE_COLS.map(c => r[c]);
              vals.push(date, r.game_id);
              restoreSql.run.apply(restoreSql, vals);
            }
          });
          restoreTx(contaminated);
          skipReasons.contaminated += contaminated.length;
        }

        // 4. Post-write read + bucket-diff for non-contaminated rows.
        const after = db.prepare(
          "SELECT game_id, temp_f, temp_run_adj, roof_status, venue_id "
          + "FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0"
        ).all(date);
        for (const a of after) {
          totalRowsSeen++;
          const b = beforeById.get(a.game_id);
          if (!b) continue;
          if (b.weather_contamination_reason != null) continue;
          if (b.temp_f == null) { skipReasons.no_temp_stored++; continue; }
          if (a.temp_f == null) { fetchFailures.empty_response++; continue; }
          const bBucket = tempBucket(b.temp_f);
          const aBucket = tempBucket(a.temp_f);
          const label = bucketCrossingLabel(bBucket, aBucket);
          crossings[label]++;
          const isSealedClosed = (a.roof_status === 'closed') && isSealedDome(a.venue_id);
          const isMaterial = !isSealedClosed;
          if (isMaterial) materialCrossings[label]++;
          if (label !== 'unchanged' && sampleRows.length < 10) {
            sampleRows.push({
              game_date: date, game_id: a.game_id,
              before_temp_f: b.temp_f, after_temp_f: a.temp_f,
              before_bucket: bBucket, after_bucket: aBucket,
              crossing: label, roof_status: a.roof_status, material: isMaterial,
              before_temp_run_adj: b.temp_run_adj, after_temp_run_adj: a.temp_run_adj,
            });
          }
        }

        processed++;
        onProgress({
          phase: 'live_writing',
          date, dates_processed: processed, dates_total: dates.length,
          rows_seen: totalRowsSeen,
          live_writes_updated: liveWritesUpdated,
          crossings, materialCrossings, skipReasons,
        });
        continue;
      }

      // ---- DRY-RUN PATH ----
      // Fetch-only pass: hit fetchWindAtCoords per non-contaminated
      // row and compare would-be new temp_f bucket to stored temp_f
      // bucket. Does NOT recompute temp_run_adj (that would duplicate
      // the roof gating — the exact correctness risk we're avoiding).
      //
      // The WHERE clause excludes contaminated rows so the dry-run
      // projections match the live path's write scope (contaminated
      // rows are snapshot-restored on the live path). Earlier
      // iteration of this file omitted the filter, which inflated
      // dry-run crossing counts by ~30 ATH rows whose Coliseum-to-
      // Sutter-Health delta is dramatic (+15-24°F); confirmed in the
      // 2026-08-05 dry-run before this fix.
      const rows = db.prepare(
        "SELECT game_id, game_date, game_time, home_team, venue_id, "
        + "  temp_f, temp_run_adj, roof_status "
        + "FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0 "
        + "  AND weather_contamination_reason IS NULL"
      ).all(date);
      for (const g of rows) {
        totalRowsSeen++;
        if (g.temp_f == null && g.temp_run_adj == null) {
          // No stored weather to diff against — likely a pre-scrape
          // row. Skip; a live run would write fresh values, but the
          // bucket-crossing metric is meaningless with no baseline.
          skipReasons.no_temp_stored++;
          continue;
        }
        // Venue-override chain — same precedence as jobs.js:3210.
        const parts = g.game_id.split('-');
        const homeKey = parts[1];
        const upperHome = (homeKey || '').toUpperCase();
        const venueIdOv  = (g.venue_id != null) ? VENUE_ID_OVERRIDES[g.venue_id] : null;
        const teamDateOv = pickVenueOverride(upperHome, g.game_date);
        let park = PARKS[homeKey];
        let tz = PARK_TZ[homeKey];
        if (venueIdOv && venueIdOv.lat != null && venueIdOv.lng != null) {
          park = Object.assign({}, park, { lat: venueIdOv.lat, lng: venueIdOv.lng });
          if (venueIdOv.tz) tz = venueIdOv.tz;
        } else if (teamDateOv && teamDateOv.lat != null && teamDateOv.lng != null) {
          park = Object.assign({}, park, { lat: teamDateOv.lat, lng: teamDateOv.lng });
          if (teamDateOv.tz) tz = teamDateOv.tz;
        }
        if (!park) { skipReasons.no_park++; continue; }
        if (park.dome) { skipReasons.dome++; continue; }
        let wx;
        try {
          wx = await fetchWindAtCoords({
            lat: park.lat, lng: park.lng, tz,
            gameDate: g.game_date, gameTime: g.game_time,
            sourceLabel: 'weather-backfill dry ' + g.game_id,
            cacheBust: true,
            archive: true,
          });
        } catch (e) {
          fetchFailures.exception++;
          continue;
        }
        if (!wx || wx.error) {
          const key = (wx && wx.error) ? wx.error : 'other';
          fetchFailures[key] = (fetchFailures[key] || 0) + 1;
          continue;
        }
        const newTempF = parseFloat(wx.tempF.toFixed(1));
        const bBucket = tempBucket(g.temp_f);
        const aBucket = tempBucket(newTempF);
        const label = bucketCrossingLabel(bBucket, aBucket);
        crossings[label]++;
        const isSealedClosed = (g.roof_status === 'closed') && isSealedDome(g.venue_id);
        const isMaterial = !isSealedClosed;
        if (isMaterial) materialCrossings[label]++;
        if (label !== 'unchanged' && sampleRows.length < 10) {
          sampleRows.push({
            game_date: date, game_id: g.game_id,
            before_temp_f: g.temp_f, projected_temp_f: newTempF,
            before_bucket: bBucket, projected_bucket: aBucket,
            crossing: label, roof_status: g.roof_status, material: isMaterial,
          });
        }
      }
      processed++;
      onProgress({
        phase: 'dry_fetching',
        date, dates_processed: processed, dates_total: dates.length,
        rows_seen: totalRowsSeen,
        crossings, materialCrossings, skipReasons, fetchFailures,
      });
    }

    const materialTotal =
      materialCrossings.up_one + materialCrossings.down_one
      + materialCrossings.up_multi + materialCrossings.down_multi;
    const anyCrossingTotal =
      crossings.up_one + crossings.down_one
      + crossings.up_multi + crossings.down_multi;

    return {
      task: 'weather_backfill_season',
      dry_run: dryRun,
      window: { from: params.from, to: params.to, dates: dates.length },
      planning,
      rows_seen: totalRowsSeen,
      live_writes_updated: liveWritesUpdated,
      contamination_policy: 'skip',
      contaminated_rows_restored: skipReasons.contaminated,
      crossings,
      material_crossings: materialCrossings,
      any_bucket_crossings_total: anyCrossingTotal,
      material_bucket_crossings_total: materialTotal,
      fetch_failures: fetchFailures,
      skip_reasons: skipReasons,
      sample_crossing_rows: sampleRows,
      observed_vs_forecast_caveat:
        'Open-Meteo returns OBSERVED temps/winds for historical dates, not the forecast that was live '
        + 'at signal-emission time. Downstream calibration that treats these values as emit-time inputs '
        + 'carries mild hindsight bias. See docs/season-weather-backfill-observed-vs-forecast-2026-08.md.',
    };
  },
});
