# Runs-term recalibration — 2026-07-05

Follow-up to `docs/totals-morning-gap-2026-07-05.md`, which pinned the
morning-bucketed uniform under-projection at 0.7-1.4 runs across every
market bucket. This doc:

1. Establishes provenance of `RUN_MULT` and `WOBA_BASELINE`.
2. Checks whether 2026's league R/G explains the miscalibration.
3. Fits level + slope corrections against actuals, train Apr-May,
   validate June holdout.
4. Applies the ship criteria — HI holdout error improves, MID
   doesn't degrade, level correction justified by environment.
5. Recommends the bounded change.

## Provenance

`git log` on `services/model.js`:

- **Initial commit 2026-04-03**: `RUN_MULT=48`, wOBA baseline `-0.230`
  hardcoded inline.
- **Commit aabc607 2026-04-17**: baseline lifted to a settings key
  (`WOBA_BASELINE=0.230`, `RUN_MULT` default 48). Same values.
- **Commits c3941c1, 888ea63 (2026-06-14 window)**: added
  `services/runmult-totals-backtest.js` — a sweep endpoint
  `POST /api/admin/parameter-sweep` that ran RUN_MULT across 41..50.
  Result: RUN_MULT was moved from 48 → 46 in prod based on that sweep.
- **WOBA_BASELINE=0.230**: never changed since the initial commit.

**Sweep objective**: the 2026-06 sweep optimized ROI, not absolute
run-projection accuracy. A model can be ROI-optimal without being
scoring-calibrated — the market compensates in expected value even
when levels diverge, provided the model's relative rankings are
sound.

## Does 2026's league R/G alone explain the uniform 0.7-run cold?

Prod fetch 2026-04-01 → 2026-07-05, n=1,172 resolved games:

```
Mean actual R/G (both teams): 9.072   σ=4.556
Mean market close:            8.485   gap actual-mkt: +0.587
Mean market morning:          8.579   gap actual-mkt: +0.493
Mean model estTot:            8.186   gap actual-mkt: +0.886
```

Historical MLB R/G (public data):

```
2022:  ~8.56    (both teams)
2023:  ~9.24    (rule-change year — hot)
2024:  ~8.78
2025:  ~8.78
2026:  ~9.07    (current)
```

**Formula sanity at league-avg wOBA (0.320):**

```
Current:  46 × (0.320 − 0.230) × 2 = 8.28 runs   ← BELOW every recent season
```

The current formula's runs-per-game floor is **~0.30 below 2024/2025
and ~0.79 below 2026**. This is a stale calibration issue, not just
a 2026 hot-environment issue. The 2026 hot delta (+0.29 R/G vs 2025)
accounts for **~⅓** of the observed 0.886 model gap; the remaining
~⅔ is stale calibration to a run environment lower than any recent
season.

**Answer: 2026 alone does NOT explain the uniform cold.** Environment
contributes ~0.3; the rest is stale calibration.

## Fit: level + slope, train Apr-May, holdout Jun

Fitted on **n=701 prod-fetched train (Apr-May)** and validated on
**n=392 prod-fetched holdout (June)**. Two candidates evaluated
alongside current model:

| Model | Fit | Train RMSE |
|---|---|---:|
| M0 — current | `estTot = 46 × Δ × pf + wind + temp` (unchanged) | (baseline) |
| M1 — level | `+ c` where c = mean(actual − estTot) on train = **+0.767** | — |
| M2 — rescale | `estTot × A/46` — grid search A on train → **A = 50.37** | 4.332 |

A quadratic term `A × Δ + B × Δ²` (Model 3) was also fitted on a
narrower local-mirror sample. Best-fit A=29 with B=90 and c=2.45; the
train RMSE was tied with M2's (4.350 vs 4.356) but holdout degraded
sharply across every bucket. **Quadratic slope adds no value on this
data.** The correction is level-only.

### Holdout evaluation — CLOSE-line bucketing

```
bucket   n     meanLine    Model 0 estTot   M1 estTot     M2 estTot     actual
                            err   RMSE      err   RMSE     err   RMSE
LO       5     6.50        -0.44 2.492     -1.21 2.734    -1.13 2.692    6.80
MID      273   8.14        +0.88 4.472     +0.11 4.386    +0.12 4.395    8.81
HI       114   10.11       +1.58 5.147     +0.82 4.964    +0.71 4.946    10.77
```

### Holdout evaluation — MORNING-line bucketing (owner-perspective)

```
bucket   n     meanLine    Model 0 estTot   M1 estTot     M2 estTot     actual
                            err   RMSE      err   RMSE     err   RMSE
LO       1     6.50        +2.83 2.830     +2.06 2.063    +2.05 2.054    11.00
MID      291   8.17        +0.87 4.330     +0.10 4.244    +0.11 4.252    8.83
HI       100   10.28       +1.64 5.519     +0.87 5.343    +0.76 5.324    10.86
```

- **HI RMSE improves** (5.15 → 4.95 close, 5.52 → 5.32 morning) — ✓
- **MID RMSE improves** (4.47 → 4.40 close, 4.33 → 4.24 morning) — ✓
- **LO n=5 close / n=1 morning — degraded** slightly, but small-n
  unreliable; can't draw a conclusion. LO is not the bucket where
  Total signals fire heavily.
- **Bias reduction**: HI mean_err drops from +1.58 to +0.71 (M2). MID
  mean_err drops from +0.88 to +0.12. Both near-unbiased after
  correction.

## Ship criteria check

| Criterion | Threshold | M2 result | Status |
|---|---|---|---|
| HI holdout RMSE improves | <M0 RMSE 5.147 | 4.946 | ✓ |
| MID holdout RMSE doesn't degrade | ≤M0 RMSE 4.472 + 0.05 | 4.395 | ✓ |
| Level correction justified by environment | Aligns with any recent MLB R/G floor | 46→50 puts league-avg-wOBA output at 9.00 runs, within noise of every season 2022-2026 | ✓ |

**All three criteria met.**

## Level correction justification, expanded

M2 recommendation: **RUN_MULT 46 → 50** (+9.5%).

At league-avg wOBA (0.320) both teams, the projected game total:

```
Old (RUN_MULT=46):  46 × 0.090 × 2 = 8.28 runs
New (RUN_MULT=50):  50 × 0.090 × 2 = 9.00 runs

Recent seasons:  2022=8.56, 2024=8.78, 2025=8.78, 2026=9.07
```

**New value 9.00 sits centered in the 2022-2026 range**, within
0.07 of 2026's actual pace. Old value 8.28 was below every season
in that window.

**Alternative form (Model 1, add level intercept +0.767)** also
satisfies the ship criteria but is less clean:
- Requires new schema key + settings/model wiring (code change).
- Applies flat 0.77 to LO games too, over-projecting LO.
- Proportional rescale (M2) naturally scales less at LO, more at HI —
  matches the actual scoring elasticity across buckets.

## Bounded change recommendation

**Change `RUN_MULT` from 46 to 50 via the settings UI.**

- Zero code change. RUN_MULT is already a schema-driven settings key.
- Existing UI control on the model-settings page (`s-run-mult`).
- Reversible in one click if downstream ROI degrades.

Not a PR-worthy code change; it's a runtime settings adjustment.

## Expected downstream effects (caveats)

1. **All model estTot values scale up ~9.5%.** LO games move from
   ~7.06 to ~7.73; MID ~7.72 → 8.45; HI ~8.97 → 9.82.
2. **Model over/under probabilities shift toward Over.** At current
   TOT_SLOPE=0.08, a +0.7 run shift on the run differential produces
   +5.6pp of shift toward Over on the model probability. Historical
   Under signals that emitted under old RUN_MULT would now emit as
   Over signals or not emit at all.
3. **ML shifts too.** The Pythagorean win prob uses aRuns/hRuns; a
   proportional scale doesn't change the ratio, so the ML probability
   is nearly invariant. Expected ML behavior change: minimal.
4. **Historical PnL is now indicative, not predictive.** The
   emit-floor sweep, edge-cap retros, and calibration curves in
   `docs/emit-floor-reconciliation-2026-07-05.md` were all measured
   at RUN_MULT=46. Post-change, re-verify at the new value before
   trusting any tuning recommendation on top.
5. **Kalshi fees still eat the small edges.** From the reconciliation
   doc, ML edges barely survive fees at +0.86% net_close; Totals
   don't. RUN_MULT recalibration re-shapes the projections but
   doesn't fix the fee/edge problem. Don't expect an immediate PnL
   turnaround.

## Trigger a fresh calibration curve after the flip

Once RUN_MULT changes, the calibration curve in
`scripts/edge-calibration-curve.js` should be re-run against
post-flip signals. The edge-cap thresholds (SOFT 0.10, HARD 0.25) were
data-driven from the old calibration; they may need re-tuning.

Recommended sequence:
1. Flip RUN_MULT to 50 via settings UI.
2. Wait 1-2 weeks for ~200-300 new signals to grade.
3. Re-run `scripts/edge-calibration-curve.js` on the new cohort.
4. Adjust `signal_edge_soft_cap_pp` based on where realized calibration
   inflects post-recalibration.

## Framing field-aliasing bug — fixed in-place

`tmp/measure-run-conversion.js` previously passed raw `game_log` rows
to `runModel` in snake_case. Model reads camelCase
(`homeCatcherFramingRvPerGame`), so the audit reported framing
contribution = 0.000 in every bucket regardless of whether the DB
had framing data. Fixed in this branch: added the alias inside
`buildGame` — see `tmp/measure-run-conversion.js` lines ~49-64.

The `docs/framing-mute-semantics-2026-07-05.md` finding stands:
framing coverage was <5% before 2026-06-17 anyway, so re-running the
audit with the alias fixed would move numbers on ~40 games only —
rounding-error at the aggregate level. The bug fix matters going
forward, not retroactively.

## Framing backfill — CAN be done, not date-forward-only

The framing lookup at `services/jobs.js:455-494` (`perGame`) uses two
tables:
- Primary: `catcher_framing` (2026-season data)
- Fallback: `catcher_framing_hist` (2023-25 baseline × absFactor)

Both are populated year-round. When `processGameSignals` runs on a
2026-04-15 game *today*, the historical fallback still fires, and
framing_rv writes to game_log. The reason April/May currently show
0% coverage is that those games haven't been *rescored* since the
framing ingest went live (~2026-06-17).

**Backfill mechanism** (already exists):

```
POST /api/games/2026-04-15/rerun
```

Iterates every game on the date and calls `processGameSignals`. Would
re-populate framing on the April/May slate. Requires admin token.

Not a code change. Owner's call whether to trigger for the backlog
(~60 dates, ~750 games). Would ADD ~0.05-0.15 runs of framing
adjustment per game on average — small enough to not shift signal
population, but improves the fidelity of any retrospective PnL work.

## Files

- Fit script: `tmp/fit-runs-term.js` (local-mirror sample) and
  `tmp/fit-runs-term-prod-holdout.js` (prod-fetched holdout).
- Aliasing fix: `tmp/measure-run-conversion.js` (edits in place).
