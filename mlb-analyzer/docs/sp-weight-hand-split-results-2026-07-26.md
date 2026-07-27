# Hand-split SP_WEIGHT rolling-CV — results 2026-07-26

**Script:** `scripts/sweep-sp-weight-rolling-cv-by-hand.js`
**TSV:** `docs/data/sweep-sp-weight-rolling-cv-by-hand.tsv`

**Setup:** identical to `sweep-sp-weight-rolling-cv.js` — same universe
(675 clean+non-contaminated ML signals, Apr 9 - Jul 22), same 3 folds,
same 10 SP_WEIGHT candidates. Adds a per-signal tag for opposing SP
hand (resolved from `team_rosters` by name).

**Sample coverage:** hand resolved for ~53% of kept signals per
candidate. R-facing n≈150, L-facing n≈45, unresolved n≈60 (across
all 3 folds combined). The ~47% miss rate is a data-quality issue —
`team_rosters` name-join misses some pitchers (call-ups, cross-team,
name variants); investigating in a follow-up. The R:L ratio in the
resolved subset is roughly 77:23, matching the expected ~70:30 league
mix.

## The result: benchmark prediction FAILS

Prediction from `docs/sp-weight-benchmark-correction-2026-07-26.md`:
- R-facing games should prefer HIGHER SP_WEIGHT (benchmark 0.86 vs default 0.80)
- L-facing games should prefer LOWER SP_WEIGHT (benchmark 0.68 vs default 0.80)

Data:

### R-facing (n≈150 across all 3 folds)

| SP_WEIGHT | Fold A | Fold B | Fold C | mean test ROI |
|---|---|---|---|---|
| 0.60 | +13.25% | +14.64% | +18.62% | **+14.81%** ← best |
| 0.65 | +5.19% | +5.69% | +12.11% | +6.61% |
| 0.70 | +7.24% | +16.39% | +21.08% | +12.95% |
| 0.72 | +7.24% | +20.47% | +21.08% | +14.43% |
| 0.75 | +4.42% | +20.47% | +21.08% | +13.12% |
| 0.77 | +4.55% | +19.05% | +21.08% | +12.72% |
| **0.80** | +3.06% | +15.16% | +17.04% | **+9.81%** (baseline) |
| 0.83 | +4.83% | +15.16% | +17.04% | +10.68% |
| 0.85 | +3.33% | +13.14% | +17.04% | +9.21% |
| 0.90 | −2.50% | +9.40% | +22.13% | +5.69% ← worst |

- Direction: **DOWN** (mean below-baseline +12.44% vs above-baseline +8.53%)
- Monotonic across the grid: raising SP_WEIGHT above 0.80 monotonically hurts R-facing signals; lowering below 0.80 monotonically helps.
- **Opposite of benchmark prediction (predicted UP).**

### L-facing (n≈45 across all 3 folds)

| SP_WEIGHT | Fold A | Fold B | Fold C | mean test ROI |
|---|---|---|---|---|
| 0.60 | −26.11% | −35.63% | −28.06% | −30.87% |
| 0.65 | −26.11% | −35.63% | −28.06% | −30.87% |
| 0.72 | −21.36% | −46.16% | −36.06% | −36.72% |
| 0.75 | −21.36% | −46.16% | −36.06% | −36.72% |
| **0.80** | −13.50% | −43.17% | −31.80% | −32.30% (baseline) |
| 0.83 | −13.50% | −43.17% | −31.80% | −32.30% |
| 0.85 | −13.50% | −43.17% | −31.80% | −32.30% |
| 0.90 | −13.50% | −51.59% | −41.21% | −38.76% |

- Direction summary reports "UP" (mean above-baseline −34.45% vs below −34.77%), but that's a **0.3pp difference in a sea of −30% to −40% losses**. Effectively FLAT.
- **The real story is not direction — it's that L-facing signals are catastrophically money-losing regardless of SP_WEIGHT tuning.** No candidate produces positive ROI in any fold. Best L-facing result is −13.5% in Fold A.
- **Opposite of benchmark prediction (predicted DOWN would help — data says nothing helps).**

## What this means

The corrected handedness-exposure benchmark predicted the direction
wrong for BOTH subsets. Two possibilities:

**1. The benchmark math is missing something.** The 0.86/0.68 numbers
are the mechanical handedness-exposure of a PA. But the model uses
SP_WEIGHT to weight the batter's *split-quality data*, not just to
approximate exposure. If the vs-RHP splits are systematically more
reliable (larger samples, less noise) than vs-LHP splits, then over-
weighting the more-reliable side would be *wrong* — a good model
should shrink toward the noisier side to hedge, not lean into the
already-well-measured side. That would predict LOWER SP_WEIGHT is
better for R-facing (vsRHP is well-measured, don't over-weight it) —
which matches the data. Untested; a real hypothesis to check.

**2. The L-facing catastrophe suggests a structural model bug
independent of SP_WEIGHT.** All values −30% to −40% for a market
that should be roughly break-even at 0% ROI implies the model
systematically mis-prices L-facing games. The batter-side weight
isn't the lever. Could be:
- vsLHP split data source has a bias
- The pitching-side scores LHP starters poorly (SP_PIT_WEIGHT issue)
- Bullpen wOBA weights for LHP-starter games under- or over-weight
  the same-hand LOOGY effect
- Something about lineup construction against LHP that the model
  doesn't capture

Or the small n=45 could be dominated by a handful of bad losses.
Sanity-check the L-facing signal population before drawing conclusions.

## Actions per the design doc's risk register

The design doc explicitly said:

> Hand-split sweep shows OPPOSITE direction (R prefers LOWER, L
> prefers HIGHER) → Halt. Something's wrong with the benchmark
> math. Investigate before shipping anything.

That's the situation. **Halt Phase 1 and Phase 2 shipping.** The
hand-conditional design is not invalidated in principle, but the
initial constants (0.86 / 0.68) are provably wrong — data says the
right R-facing constant is probably 0.60-0.72 (matching sweep
optimum), not 0.86. Which direction the "true" constant lives is a
data-driven question now, not a benchmark-derived one.

## Recommended next steps (before revisiting design)

1. **Investigate the L-facing catastrophe first.** It's the largest
   effect in the data and the most surprising finding. Pull the 45
   L-facing signals and eyeball: (a) are they concentrated on a few
   teams? (b) are they mostly closing-line-value negatives? (c) does
   the model's win-prob estimate correlate with actual outcomes at
   all? If L-facing is a broken market segment, the R-facing sweep
   finding may share a common root cause.

2. **Fix the hand-resolution gap.** 47% of kept signals fall into the
   Unknown bucket because the SP name doesn't join `team_rosters`.
   Add a fallback: (a) look up via `pitcher_fg_role` join on
   `mlb_id`, (b) fuzzy match on last-name/team, (c) fall back to the
   pitcher's most recent appearance's hand. Getting to >95%
   resolution before rerunning the sweep.

3. **Only after the above: revisit whether the mechanistic benchmark
   is missing a signal-quality term.** The vs-RHP-splits-are-more-
   reliable hypothesis is testable — compare TBF-counts backing the
   vsRHP vs vsLHP columns for the same batters. If vsRHP has 3-5x
   the sample size, that's evidence the model should be weighting
   away from the over-fit side, not toward it.

4. **Consider whether the sweep is picking up a different confound
   entirely.** The SP_PIT_WEIGHT non-stationarity from
   `docs/sp-forecast-ip-blast-radius-2026-07-26.md` was already
   flagged as a confound for the flat sweep. It could confound the
   hand-split sweep too — R-facing and L-facing games might have
   different missingness patterns for `sp_forecast_ip`, which would
   change `SP_PIT_WEIGHT` differently between subsets. Untested.

## Direction summary

| Subset | Benchmark predicted | Data shows | Action |
|---|---|---|---|
| R-facing | UP (0.86) | **DOWN** (best at 0.60) | Benchmark wrong; investigate signal-quality hypothesis |
| L-facing | DOWN (0.68) | **FLAT/broken** (all values −30% to −40%) | Bigger fish — investigate L-facing catastrophe first |

Bottom line: the corrected benchmark from
`sp-weight-benchmark-correction-2026-07-26.md` is directionally wrong.
The design work in
`sp-weight-hand-conditional-design-2026-07-26.md` should not proceed
with those constants. Neither doc is invalidated on the principle
that "a scalar can't be right for both R and L" — data now confirms
they behave differently — but the specific values are provably wrong.
