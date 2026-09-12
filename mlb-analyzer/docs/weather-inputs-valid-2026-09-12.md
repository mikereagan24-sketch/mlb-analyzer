# weather_inputs_valid — splitting the two meanings of the weather tag (2026-09-12)

## Registration

**Change.** `game_log` gains `weather_inputs_valid INTEGER`. Harnesses that
**re-score** from the stored weather columns filter on it instead of on
`weather_contamination_reason IS NULL`. Anything reading a stored
**emit-time** artifact keeps the tag filter.

**Reason, stated before the numbers.** In the BsR forward window
`2026-06-16 → 2026-09-10`, the tag filter does not thin the corpus evenly —
it removes a park-clustered block:

```
06-16 .. 07-29   admitted 257 games, 14 home parks: TB DET WAS BOS NYM PIT PHI NYY MIA CIN ATL TOR CLE BAL
                 excluded 286 games, 16 home parks: STL ATH TEX ARI SF MIL COL SEA LAA CWS MIN LAD HOU CHC SD KC
07-30 .. 09-10   admitted 550 of 557
```

The two sets are **exactly disjoint by park**. The naive-hour cohorts were
defined by time zone, so the first six weeks of the window are an
ET-home-park-only sample — 47% of games — while the last six weeks are
effectively complete. That is a conditional sub-sample of the kind
CLAUDE.md's subset sign-flip rule says not to read direction from, and it
is the reason for this change. The n gain is secondary.

**What this is not.** It is not a gate flip, and it does not relax the
emit-time filter anywhere. No production pricing path changes.

## The two senses, which came apart

`weather_contamination_reason` has always carried both of these, and until
2026-08-05 they were the same thing:

| sense | still true? |
|---|---|
| (a) the emit-time price used bad weather | **always true while tagged.** The signal was emitted against whatever the columns held that day. |
| (b) the weather columns in this row are bad *now* | **no longer implied.** |

The ordering is what broke (b), and it is recorded in `backfill_jobs`:

```
weather_contamination_ath          2026-08-05 12:41:06 PT   tagged 56 rows
weather_backfill_season   (live)   2026-08-05 16:21:36 PT   1545 rows rewritten, 56 restored
weather_backfill_season   (SF)     2026-08-06 08:01:36 PT
weather_contamination_naive_hour   2026-08-06 10:49:29 PT   tagged 738 rows
weather_contamination_ari_roof     2026-08-09 19:12:03 PT   recomputed 3 rows
```

The backfill rewrote the weather columns through the **fixed**
park-local-hour path and restored only the rows already tagged at that
moment — the 56 ATH ones. The naive-hour job then tagged 738 rows that had
been corrected the previous evening. Every one of those 738 carries
`weather_quality_at` inside `[2026-08-05 23:22:26Z, 2026-08-06 15:12:55Z]`;
every one of the 56 ATH rows carries a stamp from **before** the backfill
(`2026-04-28 .. 2026-08-03`), because restoring put the old stamp back too.

## The guard-removal check

CLAUDE.md requires naming the failure mode a guard prevents, and showing
whether it is present in the data about to be evaluated.

**The failure mode**, named from the code rather than the tag string —
`services/jobs.js:4068`: *"Pre-2026-07-29, the cron path silently used a
naive-ET-hour index no matter what tz the park was in."* For a CT/MT/PT
park that samples Open-Meteo's hourly series 1/2/3 hours later in the
park-local diurnal cycle than first pitch. `temp_run_adj` (a 55/70/80°F
bucket step) and `wind_factor` (an 8 mph threshold plus an orientation
projection) inherit the error, and `runModel` reads both identically in
both arms of any A/B — symmetric noise on every calibration metric.

**The test.** `fetchWindAtCoords` still contains both code paths: pass `tz`
and it indexes on the park-local ISO (the fix), omit `tz` and the naive
fallback fires at the ET hour (the bug). So each row can be re-derived both
ways through the production function — no parallel weather implementation —
off the same archive endpoint the backfill used.
`scripts/verify-weather-inputs-valid.js`, roof-open rows only:

```
set                                    matches park-local hour   matches naive ET hour
naive-hour tagged (n=18)                      17/18                    0/18
untagged, same backfill (n=8)                  7/8                      7/8   <- ET: hours coincide
ATH @ current park (n=5)                       0/5                      0/5
ATH @ pre-fix Coliseum coords (n=5)            0/5                   4/5 within 1.4F
```

Both "misses" in the first two rows are `d=0.20°F` ERA5-revision noise
against a `TOL` of 0.15, not hour mismatches — the naive-hour alternative
on those same rows is off by 9.0 and 9.9°F. Reading it straight:

- **The defect is absent from the naive-hour columns.** 17/18 reproduce the
  park-local-hour value to **0.00°F**; 0/18 match the naive hour.
  `wind_factor` re-derives on 17/18 and `temp_run_adj` on 18/18.
- **The defect was material**, so this is not a null from a small effect:
  mean |park-local − naive| is **3.12°F**, up to 9.2°F, straddling the
  bucket edges `temp_run_adj` steps on.
- **The ATH rows are confirmed bad on both axes** and stay excluded. Their
  stored values match neither the current park (off 16.7–30.0°F — Sacramento
  is not Oakland) nor a clean derivation at the old Coliseum coordinates;
  the closest match is Coliseum coordinates **at the naive hour**, which is
  exactly the pre-fix double defect.

The distributional comparison is reported in
`tmp/weather-input-distributions.js` but is **not** load-bearing: the
admitted and excluded sets are park-disjoint, so a raw comparison measures
climate. The within-park pre/post-fix panel that can see the defect gives a
difference-in-differences against the ET control of −0.47°F on night games
and −1.33°F on day games — inside climate noise at these n, and unable to
resolve ±1°F either way. The per-row hour match is the evidence; the panel
only fails to contradict it.

One thing the distributions do show, and it reinforces the park-clustering
point: the excluded set holds the entire cool-marine-park population, so the
admitted corpus is warm-skewed in the exact channel this filter governs —
`temp_run_adj = 0.6` is 57.9% of admitted rows against 39.7% of the
corrected ones.

## Definition, and why the boundary is observable

`weather_inputs_valid = 1` iff the row's weather columns were produced by a
park-local-hour-correct, correct-coordinate path:

```sql
temp_f IS NOT NULL
AND weather_quality_at IS NOT NULL
AND weather_quality_at >= '2026-08-05 23:00:00'   -- UTC
```

One predicate, no per-cohort special casing, keyed on `weather_quality_at`
— which records when a row's weather was last written. Every write at or
after the backfill's first came from the fixed path, because that path
landed 2026-07-29/30, before the backfill ran.

**Zones, because this schema mixes them and the comparison fails silently.**
`weather_quality_at` is UTC (SQL `datetime('now')`); `backfill_jobs.started_at`
is PT (`nowPtIso`). The backfill's PT start 16:21:36 is 23:21:36Z and its
first weather write is 23:22:25Z — one minute later, the a-priori ordering
that confirms the reading. The 7-hour window where the two readings disagree
contains **0 rows**, so no classification depended on getting this right;
it is stated because the next such comparison might not be so lucky.

The constant is sited in **measured empty space**: the last pre-backfill
write is `2026-08-03 00:00:37Z`, the first backfill write is
`2026-08-05 23:22:25Z`, and the 2.97-day gap between them holds zero rows.
`scripts/set-weather-inputs-valid.js` re-asserts that gap is still empty on
every run, so a future row landing inside it fails loudly rather than being
classified by a stale constant.

Resulting classification, asserted rather than assumed (the script exits 1
on any violation):

```
untagged     1320 rows -> 1319 valid,  1 invalid (no temp_f, 2026-07-14)
naive_hour    738 rows ->  738 valid,  0 invalid
ath_*          56 rows ->    0 valid, 56 invalid
ari_roof_*      3 rows ->    3 valid,  0 invalid
```

## Corpus effect

```
graded games          emit-time tag filter   weather_inputs_valid   delta
BsR forward window            807                   1078            +271  (+33.6%)
full season                  1247                   1977            +730  (+58.5%)
```

**n is not the argument.** Per CLAUDE.md's measured floors, log-loss
resolution plateaus at ~0.020 by n≈300 and ROI at ~12pp by n≈300–400, so a
1.17× gain in √n at n≈800 changes no verdict on its own. The argument is
the park clustering above. The one place n may matter on its own terms is
the `defense_frv_enabled` flip criterion, which requires **≥1200 games** —
whether the widened corpus reaches that bar is a question for the post-merge
re-runs, not a claim here.

## Consumers

| site | filter | why |
|---|---|---|
| `services/baserunning-backtest.js` | `weather_inputs_valid` | re-scores via `runModel`; reads no stored emit-time artifact |
| `services/frv-backtest.js` | `weather_inputs_valid` | same; its ROI metric reads market price + final score, neither weather-derived |
| `services/parameter-sweep.js` `loadGames` | `weatherFilter` default `'inputs_valid'` | shared corpus loader for `calibration-ab.js`, `calibration-sweep.js`, `component-signal-diagnostic.js`, `bullpen-neutral-ab.js` |
| `scripts/contamination-impact.js` | unchanged (`'none'`) | measures what exclusion costs; must see everything |
| `services/admin-queries.js`, `weather-backfill-season.js` | unchanged (tag) | reporting and producer policy |

Verified before the switch: none of the four re-scoring harnesses reads
`game_log.model_total` as a value or selects from `bet_signals` — the only
`model_total` reference in any of them is `loadGames`' `IS NOT NULL`
completeness gate. So the emit-time carve-out has no site inside these
files, and every ROI/CLV path that does read a stored artifact is untouched.

`loadGames` **throws** on an unrecognised `weatherFilter` rather than
falling through to no filter. Three hand-maintained lookups in this repo
have failed open and each produced a confident wrong null.

## Staying correct going forward

There are exactly **two** writers of the weather columns and both now set
the flag: `q.updateWindData` in `db/schema.js` and the inline copy at
`services/jobs.js:4033`. Without that, new rows land NULL and every
`weather_inputs_valid = 1` filter silently drops the current slate — the
failure mode is invisible in output, which is why the flag is set at the
ingest layer rather than by a scheduled reclassification.

`weather_inputs_valid` is also added to `RESTORE_COLS` in
`weather-backfill-season.js`, so a future restore reverts the flag with the
values it describes. Otherwise a restored row would claim re-scoring-safe
weather it does not have — precisely the state the 56 ATH rows would be in
today had the column existed on 2026-08-05.

## Re-runnable

```
node scripts/set-weather-inputs-valid.js              # dry run + assertions
node scripts/set-weather-inputs-valid.js --apply      # write
"$NODE20" --max-old-space-size=1536 scripts/verify-weather-inputs-valid.js
```

## Open, deliberately not decided here

- **The 22 in-window ATH rows stay excluded.** Their coordinates are wrong
  in the stored columns; correcting them is a separate backfill, not this PR.
- **Observed-vs-forecast remains.** Backfilled rows hold ERA5 observed
  weather, not the forecast live at emit time
  (`docs/season-weather-backfill-observed-vs-forecast-2026-08.md`). Admitting
  the naive-hour rows adds no new instance of this: they came from the same
  backfill as the 344 admitted pre-08-05 rows that already carry it.
- **No gate flips.** `defense_frv_enabled` and every other gate keep their
  current state and their current windows.
