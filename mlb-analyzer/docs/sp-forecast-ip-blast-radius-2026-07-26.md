# sp_forecast_ip data-quality blast radius — 2026-07-26

**Context:** raised while scoping the per-game SP_WEIGHT feature (see
`docs/sp-weight-mechanism-rationale-2026-07-25.md` and
`docs/sp-weight-rolling-cv-2026-07-25.md`). Investigation of the
`sp_forecast_ip` field's data quality *before* any per-game code is
written, treating the field as a first-class problem in its own right
rather than a blocker.

**Verdict:** the per-game SP_WEIGHT feature is correctly-designed and
appropriately-blocked, but the blast radius of the underlying data
problem is bigger than "one feature is blocked." Fixing the input is
the higher-leverage thread — it unblocks the feature AND repairs an
existing silent degradation in `SP_PIT_WEIGHT`.

## (a) Why is 35% NULL/zero?

**It's a backfill artifact, not an ongoing gap.** Fill rate by month:

| Month | Total rows | away_sp_forecast_ip NULL/0 | Fill rate |
|---|---|---|---|
| 2026-04 | 333 | **333** | **0%** |
| 2026-05 | 426 | 144 | 66% |
| 2026-06 | 401 | 22 | 95% |
| 2026-07 | 280 | 1 | 100% |

The forecaster code (`services/jobs.js:1970` `forecastForPitcher` →
`services/model.js:1816` `forecastSpIP`) landed and shipped mid-May
2026. April rows were never re-filled. Since June 1 the fill rate is
functionally 100% — the only remaining gaps are pitchers that
`forecastForPitcher` couldn't resolve (unresolved name, no priors, and
the abbreviation-fallback didn't hit — logged as
`[forecast-null-resolve]`).

**Fix:** re-run the lineup job's forecast step in backfill mode on
game_dates 2026-04-01 → 2026-05-31. Existing SP names on those rows
give the forecaster something to look up; abbreviation fallback
handles the ~20 SP-abbreviation cases that were the original bug the
2026-07-04 doc caught.

**Cost of not fixing:** anything that trains, backtests, or replays on
the April-May window silently gets a two-modes universe where
`SP_PIT_WEIGHT` is effectively 0.62 for every April game and the
graduated haircut for June-July games. This is precisely the case for
the SP_WEIGHT rolling-CV sweep that just ran — see section 4.

## (b) Why does the distribution top out at 5.93 IP?

**It's a design property of the Bayesian shrinkage forecaster, not a
truncation or bucketing bug.** `forecastSpIP` computes:

```
forecast = alpha * f0 + (1 - alpha) * ewma
alpha    = K / (K + n_eff)
f0       ≈ 5.4  (league baseline from _lookupLeagueBaseline)
```

Every forecast is pulled toward the ~5.4 IP league prior. With
`FORECAST_SHRINKAGE_K` defaulting to a value that keeps `alpha`
meaningful for pitchers with ≤10 starts (typical mid-season sample
size), even an ace averaging 6.5+ IP shrinks to ~5.9 IP. The
observed max of 5.93 IP is exactly the shrinkage ceiling for the
highest-workload pitcher in the current sample.

**This is not a data-quality bug per se** — Bayesian shrinkage should
compress. It's a *calibration question* whether the anchor is set
correctly. Two concerns:

1. **`f0 ≈ 5.4` is potentially low because it likely includes 4-inning
   opener starts and quick-hooks.** If `_lookupLeagueBaseline` filters
   to "true starter appearances" (say IP ≥ 3.0, not opener-flagged),
   the anchor might land at 5.7-5.9. Currently the code path is
   unclear without deeper trace — flagging for follow-up. If the
   anchor is too low, every forecast is over-shrunk downward.

2. **The `SP_PIT_WEIGHT` clamp at `FORECAST_WEIGHT_MAX=0.95` is dead
   code.** The haircut formula is `0.75 + (forecast_ip - 5.5) * 0.10`.
   For clamp to fire at 0.95 you need `forecast_ip ≥ 7.5`. Actual max
   is 5.93 → weight 0.793. **No pitcher in the current data can earn
   `SP_PIT_WEIGHT` above ~0.80.** Ace pitchers get the same effective
   pitching weight as league-average starters. Whether that's a
   feature (Bayesian humility) or a bug (aces genuinely earn more
   weight) is a modeling decision, but it's happening silently — the
   0.95 ceiling exists in code as if it were reachable.

## (c) Other consumers — the real blast radius

Grepping `sp_forecast_ip` / `forecast_ip` across the repo shows the
following consumers *beyond* the per-game SP_WEIGHT feature that
sparked this investigation:

### 1. **`computeSpPitWeightFromForecast`** (`services/model.js:1543`)

The primary consumer. Feeds `SP_PIT_WEIGHT` (pitching-side weight,
distinct from the batter-side `SP_WEIGHT` this whole thread was about).
Called at `services/model.js:1045-1046` for both sides on every game.

**Behavior when forecast IS present:** graduated haircut, weight
scales from 0.62 (0 priors) to `0.75 + (fc - 5.5) * 0.10` (≥3 priors),
clamped [0.50, 0.95].

**Behavior when forecast IS NULL:** returns `SP_FORECAST_LOW_CONF_TARGET =
0.62`. This is what the docstring at model.js:1533-1542 calls
"revised 2026-07-03" — before that fix, null forecast returned null
and fell through to `?? SP_PIT_WEIGHT = 0.80` (backwards: missing
data got maximum confidence). The current behavior treats missing as
low-confidence (0.62).

**Downstream consequence for April 2026 games:** every SP got
`SP_PIT_WEIGHT = 0.62` because forecast was null for the entire
month. Ace pitchers, backups, first-start rookies — all treated
identically as "low confidence." This is deeply wrong for backtest
comparability: an April game's pitching-side blend is dramatically
different from a July game's, purely because of the backfill gap.

### 2. **Opener/bulk sister columns** (`away_opener_forecast_ip`, `away_bulk_forecast_ip`)

`computeOpenerPitWeightFromForecast` and
`computeBulkPitWeightFromForecast` at `services/model.js:1580` and
below use these for opener-mode games. Same shrinkage issue applies
but with different anchors (opener default 1.23 IP, bulk different).
Blast radius smaller because opener games are ~10% of sides.

### 3. **Diagnostic replay/backtest paths**

`scripts/test-sp-sp-tandem-split.js`, `tmp/strongfav-decomposition.js`,
`services/under-selection-diagnostic.js`, `routes/api.js` (for the
`/api/games/<date>` payload that surfaces `*_sp_weight_used` in the
UI). All of these show or replay based on `sp_forecast_ip` and its
derived `_sp_weight_used` columns. Anything that shows April data is
showing 0.62-across-the-board pitching weights.

### 4. **The v4 cohort persistence columns** (`away_sp_weight_used`, etc.)

`db/schema.js:1259` — these columns persist the ACTUAL `SP_PIT_WEIGHT`
that ran at signal-fire time. So historical replays are reproducible.
But: rows written during April 2026 all have `sp_weight_used ≈ 0.62`
because that's what the model computed with the missing forecast.
Replaying these rows at "corrected" settings still shows the
April-era value in the persisted column. Backfill fix needs to
either re-run the forecast AND re-run runModel, or accept the
persisted-value skew and note it in analysis.

### 5. **The just-run SP_WEIGHT rolling-CV sweep** — CONFOUND

`scripts/sweep-sp-weight-rolling-cv.js` universe is 2026-04-09 →
2026-07-22, sweeping the *batter-side* `SP_WEIGHT`. But the model it
runs against is using `SP_PIT_WEIGHT` derived from
`computeSpPitWeightFromForecast(game.forecast_ip, ...)`. Which means:

- **April signals** ran with `SP_PIT_WEIGHT = 0.62` (missing → low-conf)
- **June/July signals** ran with `SP_PIT_WEIGHT ≈ 0.75-0.80` (present → shrunken haircut)

Fold A (Fit Apr 9 - May 31, Test Jun 1 - Jun 30):
- Fit universe is ~65% April+May with heavy 0.62 mode
- Test universe is June with high fill rate
- Fit optimum for batter-side SP_WEIGHT is being estimated against a
  different pitching-side reality than the test optimum

**This partially explains why the sweep couldn't find a stable
winner across folds.** Each fold's fit and test halves are running
against slightly different effective models. The batter-side sweep
was measuring "what SP_WEIGHT works best given the *actual mix* of
SP_PIT_WEIGHT the universe saw" — which is not stationary across the
window.

**Corrective action:** re-run the sweep on Jun 15 - Jul 22 only (all
folds' fit AND test in the ≥95%-fill regime) once April/May are
backfilled. Not urgent — the sweep verdict "keep 0.80" is unchanged
either way — but the *directional finding* (DOWN, lower SP_WEIGHT
helps) might sharpen or reverse when the pitching-side is stationary.

## Summary of blast radius

| Concern | Blast size | Fix priority |
|---|---|---|
| April 2026 backfill: 100% missing → all `SP_PIT_WEIGHT` = 0.62 | Large — 333 rows, entire month | **P0**: backfill forecast job for Apr-May |
| Ace pitchers capped at ~0.79 pitching weight (0.95 clamp dead) | Medium — modeling decision, not a bug per se | P2: audit anchor `f0` and slope; possibly retire the 0.95 clamp |
| Rolling-CV sweep universe was non-stationary | Small — verdict unchanged, direction may sharpen | P2: rerun on Jun 15+ once backfill completes |
| Per-game SP_WEIGHT feature | Blocked | P1: fix the input, feature becomes safe to build |
| Opener/bulk forecast columns (sister issue) | Small — 10% of sides | P3: same backfill pass covers them |

## Recommended sequencing

1. **Backfill the forecast columns** for game_dates 2026-04-01 → 2026-05-31.
   Reuse `services/jobs.js` forecast machinery in a one-shot script — no
   new logic, just call `forecastForPitcher` for every historical row.
   Emit a report of how many rows changed and how many still resolved
   to null (name unresolvable, no priors).

2. **Audit `_lookupLeagueBaseline`** — is `f0 ≈ 5.4` correct for
   "starter" baseline, or is it including openers and short outings
   that pull it down? If low, adjust before backfill runs (so the
   backfilled values use the corrected anchor).

3. **Decide on the 0.95 clamp.** Two options:
   - (a) Retire it (drop `FORECAST_WEIGHT_MAX` to 0.85 or 0.82, matching
     what the compressed forecast actually produces). Documents the
     current behavior; no model change.
   - (b) Un-shrink somehow so that ace pitchers can earn higher
     weights. Bigger change; needs justification and calibration.

4. **Re-run the SP_WEIGHT rolling-CV sweep** on the corrected data.
   Compare direction/mean to the current run. If the direction flips
   or the plateau tightens, that's evidence that the current sweep's
   "under-powered" verdict was partly a data-quality artifact.

5. **THEN scope per-game SP_WEIGHT.** Original design from
   `docs/sp-weight-mechanism-rationale-2026-07-25.md` still applies,
   with the forecast-derived `SP_TBF = round(forecast_ip * 4.35)` for
   the per-slot exposure calculation. Fallback path becomes cleaner
   because the missingness is <1% forward from June.

## What this doesn't change

- The mechanism-doc exposure math (`~54.4%` frequency-weighted SP
  share across the 2024 SP-IP distribution) is unaffected. That was
  computed from *actual* 2024 batters-faced distribution, not from
  `sp_forecast_ip`. The per-game feature's underlying premise (compute
  exposure per game rather than tune a global constant) is still
  correct.

- The 0.80 default staying in place is still the correct action given
  the rolling-CV verdict.

- The schema tightening (max 0.95 → 0.85, commit `2961797`) is
  independently justified — 0.90 was uniformly negative regardless of
  the pitching-side confound.
