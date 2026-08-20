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

## Related

- `services/weather.js:calcWindFactor` — the function in question.
- `tmp/sens-audit-harness.js` — retired per-park sens audit that
  established the power constraint.
- `tmp/sens-pooled-fit.js` — pooled league fit confirming no
  aggregate distinguishable bias in the current paste.
- `tmp/park-intercept-median-analysis.js` — median-first per-park
  residual analysis (also 2026-08-19).
