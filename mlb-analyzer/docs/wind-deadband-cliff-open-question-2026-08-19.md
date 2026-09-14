# Wind deadband cliff — open mechanism question (2026-08-19)

**Status:** logged, not planned. Mechanism argument only — the
2026-08-19 per-park sens audit established that per-park wind-
sensitivity effects at ±0.5-run resolution are unvalidatable at MLB
game-count scales (retired-methodology doc: `tmp/sens-audit-harness.js`
head comment; branch `chore/sens-audit-harness-methodology-check`).
This question compounds with that constraint, so any smooth-ramp
proposal would face the same power problem the sens audit hit.

## The observation

`services/weather.js:calcWindFactor` applies a hard deadband:

```js
if (windSpeed < 8) return 0;
const speedFactor = Math.min((windSpeed - 8) / 24, 0.75);
```

At 7.9 mph the model applies exactly zero wind adjustment. At 8.1 mph
it applies `(0.1/24) · sens · WIND_SCALE ≈ 0.017 · sens` runs — still
tiny in isolation, but the underlying **function is discontinuous at
8 mph**: a step from the "wind is not modeled" branch to the "wind
is modeled with a linear ramp" branch. There is no physical basis
for the discontinuity — the atmosphere doesn't switch on at 8 mph.

## Why the location of the cliff matters

Game-time wind at open-air venues (n=1303 clean rows, all seasons,
`weather_contamination_reason IS NULL`, roof null/open):

| percentile | wind speed (mph) |
|-----------:|-----------------:|
| p10        | 3.3              |
| p25        | 5.1              |
| **p50**    | **7.5**          |
| p75        | 10.1             |
| p90        | 13.0             |

Mean: **7.85 mph** — the deadband threshold sits at the mean of the
distribution. Cumulative shares:

| cutoff | share of games below |
|-------:|---------------------:|
| < 5 mph  | 23.9% |
| < 6 mph  | 33.1% |
| < 7 mph  | 44.4% |
| **< 8 mph (current deadband)** | **54.3%** |
| < 9 mph  | 64.5% |
| < 10 mph | 74.1% |
| < 12 mph | 86.3% |
| < 15 mph | 95.9% |

So the deadband **discards a majority of games** and the
discontinuity sits at the mode-adjacent densest part of the
distribution. Two games with essentially identical weather profiles
(say 7.5 vs 8.5 mph, straight-out at Wrigley) get radically different
model treatment — the first anchors at model_baseline, the second
receives a modest wind adjustment. The step is arbitrary, not
gradual.

## The mechanism argument for a smooth ramp

Physical intuition says a hard 8 mph on/off is not the right shape.
Fly-ball carry responds to wind roughly continuously; sub-8-mph
winds don't cease to affect ball flight, they just affect it less.
A defensible shape would be a **smooth ramp starting at ~5 mph**
(around p25) rising to the current cap, e.g.:

```
speedFactor = smoothstep(5, 26, windSpeed) · 0.75    // clamped [0, 0.75]
```

or a piecewise-linear ramp with a gentler onset. Both preserve the
current behavior at strong winds (≥ 26 mph → 0.75) while removing
the discontinuity at 8 mph and letting the 24-54% of games in the
5–8 mph band contribute a small, calibrated adjustment.

**Same cliff structure previously flagged on the wOBA minPA gate:**
hard sample-size floor on batter wOBA blending creates a similar
discontinuity between batters with `PA = minPA − 1` (blended one way)
and `PA = minPA + 1` (blended another). Mechanism argument for a
smooth shrinkage curve there too, same power constraint on
validation.

## Why this isn't being fixed

Per the 2026-08-19 pooled-league sens fit (n=286, cluster-by-park
95% CIs on `Δ_global_sens` all included zero across OLS+int, Theil-
Sen, and blowout-excluded OLS+int), the wind response magnitude
itself is not distinguishable from zero at current sample sizes.
That means any proposed change to the *shape* of the wind response
curve (deadband → smooth ramp, or slope adjustment, or cap
adjustment) is even less validatable — we can't detect the aggregate
signal, so we can't detect changes to how it's applied.

A smooth-ramp proposal would need to be defended on **mechanism +
distributional argument** rather than empirical fit:

- Mechanism: the atmosphere is continuous, so the model should be.
- Distributional: 54% of games shouldn't be tossed at a
  discontinuity in the densest part of the sample.
- Match at boundaries: the ramp should match the current behavior
  at 26 mph (both are 0.75) so the fix is a smoothing of the low
  end, not a re-scaling of the whole curve.

## What would move this to "actionable"

1. **Pooled multi-year data** that clears the sens-audit power
   constraint (probably needs 5+ seasons at 1500+ open-air games/
   year with post-TZ-fix hour indexing across all parks). Not
   reachable through organic accumulation this season.
2. **Acceptance of a defensible-by-construction change** without
   empirical validation, on the mechanism argument alone. This
   requires owner sign-off and would ship as a mild shape refinement,
   not a numerical recalibration. Riskless-if-boundary-matched:
   preserves current behavior at ≥ 26 mph and at very low winds
   (< 3-5 mph → still ~0), only affects the 5-8 mph band that's
   currently a discontinuity.

Neither is urgent. Filed for reference when someone next revisits
`calcWindFactor` or when the multi-year dataset accumulates.

## Averaging does NOT answer this (2026-09-14)

One route was tried and closed: if the 8 mph cliff hurts because a
single first-pitch reading is a poor summary of the game, then a
game-window average should price better. It does not.

`fetchWindAtCoords` reads ONE hourly index at the park-local
first-pitch hour -- `wind_factor` and `temp_run_adj` both come from it
-- so a 4-hour alternative (first pitch through FP+3h, direction and
speed from the vector resultant) was measured against it. Both arms
were computed from the SAME ERA5 archive array, because the stored
production values came from the forecast endpoint and comparing across
endpoints would have moved two things at once.

The factor does move. Over 2026-07-17..09-15, 781 non-dome games:

```
differ by > 0.01 factor (0.02 runs)   113   14.5%
differ by > 0.05 factor (0.10 runs)    25    3.2%
differ by > 0.10 factor (0.20 runs)     9    1.2%
differ by > 0.25 factor (0.50 runs)     0    0.0%
out <-> in sign flip (both non-zero)    2    0.3%
point >= 8mph, window < 8mph           68    8.7%   <- 61 genuine easing,
                                                       7 vector cancellation
point < 8mph, window >= 8mph           20    2.6%
```

So 8.7% of games cross the deadband downward under a window, which
looks like the cliff mattering. It does not survive scoring.

**MEASURED +0.00001 log loss, 95% CI [-0.00059, +0.00069], n=798** on
P(over), gate window 2026-06-16..09-10, `weatherFilter valid`,
identical game set both arms, 3000-rep date-clustered bootstrap. 2 of 5
windows favour the window. Restricted to the 201 games where the arms
actually differ: +0.00004, so the null is not dilution from the 597
identical games.

The arithmetic for why: `WIND_SCALE` turns a 0.05 factor into 0.1 runs,
and 0.1 runs against the totals sigma of 4.396 is a ~0.9pp shift in
P(over). Mean |dP(over)| across the corpus was 0.00122. The wind channel
is not large enough for a 4-hour average to register on this target at
this n.

**WHAT THIS DOES AND DOES NOT CLOSE.** It closes *averaging* as a route
to the deadband question -- a smoother summary of the same hours prices
the same. It says nothing about the cliff itself: the 5-8 mph
discontinuity is a shape problem in `calcWindFactor`, and every game in
the measurement above was priced through that same shape in both arms.
The two "what would move this to actionable" routes below are unaffected.

**And one instrument note, because it cost a detour.** This could not be
measured on `scripts/calibration-ab.js`. That harness scores `mr.adjHW`
against the home-win outcome, and in `services/model.js` `adjHW` is
computed from aRuns/hRuns BEFORE `windFactor` is read -- `windFactor`
feeds only `windRunAdj -> estTot`. So wind cannot move the ML target at
all, and an ML-target A/B on any wind change reports the flag inert by
construction. Any future wind measurement needs a totals target.

## Related

- `services/weather.js:calcWindFactor` — the function in question.
- `tmp/sens-audit-harness.js` — retired per-park sens audit that
  established the power constraint.
- `tmp/sens-pooled-fit.js` — pooled league fit confirming no
  aggregate distinguishable bias in the current paste.
- `tmp/park-intercept-median-analysis.js` — median-first per-park
  residual analysis (also 2026-08-19).
