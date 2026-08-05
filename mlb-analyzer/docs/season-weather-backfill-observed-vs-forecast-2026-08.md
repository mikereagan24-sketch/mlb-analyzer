# Season weather backfill — observed-vs-forecast caveat (2026-08)

## What the Phase A backfill does

The `weather_backfill_season` task (`services/backfill-tasks/weather-backfill-season.js`,
exposed via `POST /admin/backfill/weather_backfill_season`) refreshes the
weather columns on historical `game_log` rows:

- `wind_speed`, `wind_dir`, `wind_factor`
- `temp_f`, `temp_run_adj`
- `roof_status`, `roof_confidence`
- `weather_quality`, `weather_quality_at`

It reuses `runWeatherJob(date)` per date so the venue-override chain
(`VENUE_ID_OVERRIDES` → `pickVenueOverride` → `PARKS`), the park-local
hour ISO, and the roof gating (`services/jobs.js:3115-3184`) are the
same code paths that run in production today. Rows tagged with
`weather_contamination_reason IS NOT NULL` are restored from a
pre-write snapshot after the runWeatherJob call, so they stay
consistent with their tag.

## The caveat: observed values, not forecast

Open-Meteo's hourly endpoint returns different data depending on
whether the requested hour is in the past or the future:

- **Future hours** → forecast values (what runWeatherJob normally
  captures for T-hours pregame games).
- **Past hours** → observed / reanalysis values (what runWeatherJob
  captures when this backfill runs for historical dates).

Signals were emitted against a **forecast** live at signal-emit time.
After the backfill, the stored columns hold the **observed** values
for the same park-local hour. These are not the same number.

For most games the delta is small (fractions of a degree, wind under
1 mph off). For games with fast-moving fronts the delta can push a
row across a temperature bucket boundary (55 / 70 / 80 °F) — the
model would have priced the game differently at emit time than it
would if given the observed value now.

## Downstream implications

**Calibration and ROI backtests that treat the refreshed columns as
"what the model saw at emit time" carry a mild hindsight bias.**
The direction and size of the bias is:

- **Direction:** unclear a priori. Observed can be higher or lower
  than the forecast; the model doesn't systematically over- or
  under-forecast temp in either direction we've measured.
- **Size:** empirically small for the median game, non-trivial for
  the tails. A row that was ~5°F warmer than forecast can flip
  between the 70-80 bucket and the ≥80 bucket, changing `temp_run_adj`
  from 0.3 to 0.6.

## Who should worry about this

**Fine for**: calibration filters that need "the best available
representation of game-day weather" (e.g. Phase C1 temp attribution,
future model recalibration against observed conditions). The backfill
IS the right input for these — observed beats forecast when
attributing what actually happened.

**Not fine for**: harnesses that need to reproduce the model's
emit-time signal (e.g. "would the signal have crossed the emit floor
if we had X setting at emit time"). These should pin against a
pre-backfill DB snapshot (`tmp/backfill-backups/prod-pre-*.db`) rather
than reading the refreshed columns.

## Concrete guidance

- **Contamination-tag rows** are unaffected — they stay at their
  known-wrong pre-write values (deliberate; see the contamination
  policy note in the task file).
- **Bucket-crossing counts** in the backfill's `results_json`
  report the operator-relevant delta: rows where `temp_f`'s bucket
  changed. `material_crossings` filters out sealed-dome closed-roof
  rows where `temp_run_adj=0` regardless of temp.
- **Wind changes** aren't bucketed in this doc's discussion; the
  wind factor is a continuous function of speed × direction relative
  to `cfDir`. Phase C2 (wind attribution) is blocked on the cfDir
  bearings audit and will address that separately.

## Reversibility

The full backfill is reversible via the pre-write DB snapshot at
`tmp/backfill-backups/prod-pre-*.db` (pull via `GET /admin/download-db`
before flipping live per the runbook). No column values are computed
from other columns during the backfill — every value comes from a
fresh Open-Meteo fetch — so a restore is a straight column overwrite
per-row if needed.
