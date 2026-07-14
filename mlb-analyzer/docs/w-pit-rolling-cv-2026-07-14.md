# W_PIT rolling-origin CV — supersedes PR #181's combo 7 pilot recommendation

**Date:** 2026-07-14
**Supersedes:** PR #181 recommendation that combo 7 (W_PIT=0.35 + SP_WEIGHT=0.75) was a candidate for gated pilot.

## TL;DR

**Owner pushback on PR #181 was correct.** Val:Fit 3.1x is an overfit
warning, not a strength. Rolling-origin CV with bootstrap CIs shows:

- **No candidate is statistically distinguishable from baseline W_PIT=0.40**
  at 95% confidence. Test CIs overlap baseline in EVERY fold for EVERY
  candidate.
- **The "best" W_PIT is not stable across folds** — Fold A winner is
  0.32, Fold B is 0.35, Fold C is 0.32. If it were a real optimum, one
  value would win consistently.
- **Val:Fit ratio for W_PIT=0.35 flips signs across folds**: +0.94x, −0.35x,
  +1.44x. Robust params would show consistent ~1x ratios. Sign flips
  mean noise.
- **Baseline itself (W_PIT=0.40) shows a Fit-Test disagreement pattern**:
  Fit ROI +0.77% to +3.09% (positive across all folds), Test ROI −5.42%
  to −11.04% (negative across all folds). Even the current prod weight
  is overfit to its own fit period.
- **The DIRECTION is right (mean test ROI is higher at 0.30-0.35 than at
  0.40-0.50), but the MAGNITUDE and SPECIFIC value are noise-inflated.**

**Decision: DO NOT SHIP any pilot on combo 7. Retract PR #181's pilot
recommendation. Leave W_PIT at 0.40.** Revisit when sample doubles.

## Method

`scripts/sweep-w-pit-rolling-cv.js` — same PR #179 prod-faithful harness
pattern, extended with:

- **Fine W_PIT grid**: `{0.30, 0.32, 0.35, 0.37, 0.40 baseline, 0.42, 0.45, 0.50}`
- **SP_WEIGHT held at prod 0.80 throughout** — decouple to isolate W_PIT
  effect (PR #181's combo 7 varied both simultaneously)
- **3 rolling-origin folds:**
  - Fold A: Fit Apr 9 − May 31 (n=312), Test Jun 1 − Jun 30 (n=210)
  - Fold B: Fit Apr 9 − Jun 14 (n=419), Test Jun 15 − Jul 13 (n=189)
  - Fold C: Fit Apr 9 − Jun 29 (n=513), Test Jun 30 − Jul 13 (n=95)
- **Bootstrap 95% CI** (1000 resamples) on Fit ROI and Test ROI per
  (fold × candidate)
- **HARD cap pinned to 0.08** (same as PR #181)
- **runModel cached by (game_id, W_PIT)** — 8 candidates × 608 signals =
  ~4800 unique runModel calls, reused across folds. ~15 min total.

## Per-fold test ROI (with 95% bootstrap CI)

### Fold A (Fit Apr-May, Test Jun)

| W_PIT | Fit n | Fit ROI [95% CI] | Test n | Test ROI [95% CI] | Val:Fit ratio |
|---|---|---|---|---|---|
| 0.30 | 192 | +1.87% [−15.10, +18.39] | 134 | −0.06% [−18.87, +18.55] | −0.03x |
| **0.32** | 192 | +0.83% [−15.63, +16.67] | 130 | **+2.98%** [−15.55, +22.10] | +3.59x |
| 0.35 | 197 | +2.32% [−14.01, +19.05] | 129 | +2.19% [−15.51, +20.71] | +0.94x |
| 0.37 | 198 | +3.95% [−10.93, +19.26] | 129 | −1.42% [−20.47, +16.76] | −0.36x |
| 0.40 * | 194 | +2.72% [−13.98, +18.93] | 126 | −5.42% [−24.56, +12.95] | −2.00x |
| 0.42 | 186 | +2.45% [−13.97, +19.26] | 120 | −4.63% [−25.12, +16.74] | −1.89x |
| 0.45 | 183 | +2.43% [−13.32, +19.61] | 117 | −0.24% [−20.22, +18.97] | −0.10x |
| 0.50 | 183 | +2.90% [−13.96, +20.17] | 116 | −5.37% [−23.44, +13.94] | −1.85x |

### Fold B (Fit Apr-mid Jun, Test late Jun-mid Jul)

| W_PIT | Fit n | Fit ROI [95% CI] | Test n | Test ROI [95% CI] | Val:Fit ratio |
|---|---|---|---|---|---|
| 0.30 | 262 | +5.84% [−6.83, +19.43] | 102 | −5.75% [−26.99, +15.04] | −0.98x |
| 0.32 | 260 | +5.07% [−9.17, +19.27] | 100 | −1.78% [−24.00, +20.84] | −0.35x |
| **0.35** | 266 | +4.92% [−8.57, +19.29] | 102 | **−1.75%** [−24.42, +20.26] | −0.35x |
| 0.37 | 268 | +4.74% [−8.13, +17.55] | 101 | −5.07% [−25.53, +16.50] | −1.07x |
| 0.40 * | 264 | +3.09% [−10.58, +17.16] | 101 | −11.01% [−32.86, +9.64] | −3.57x |
| 0.42 | 254 | +3.72% [−8.63, +17.91] | 97 | −12.43% [−35.00, +8.00] | −3.35x |
| 0.45 | 251 | +3.83% [−9.46, +18.10] | 94 | −7.60% [−28.65, +13.95] | −1.98x |
| 0.50 | 252 | +2.08% [−11.18, +17.31] | 90 | −8.73% [−30.67, +13.66] | −4.21x |

### Fold C (Fit Apr-Jun, Test Jul only — SMALL test window)

| W_PIT | Fit n | Fit ROI [95% CI] | Test n | Test ROI [95% CI] | Val:Fit ratio |
|---|---|---|---|---|---|
| 0.30 | 321 | +2.03% [−10.42, +14.73] | 43 | +6.81% [−27.51, +41.12] | +3.36x |
| **0.32** | 318 | +2.35% [−9.31, +14.41] | 42 | **+9.36%** [−23.57, +43.12] | +3.99x |
| 0.35 | 322 | +2.92% [−9.19, +15.33] | 46 | +4.20% [−27.61, +36.00] | +1.44x |
| 0.37 | 322 | +2.80% [−8.60, +15.94] | 47 | −3.00% [−33.36, +28.26] | −1.07x |
| 0.40 * | 316 | +0.77% [−11.63, +13.03] | 49 | −11.04% [−39.80, +19.16] | −14.30x |
| 0.42 | 302 | +0.99% [−11.32, +13.65] | 49 | −11.47% [−41.49, +19.84] | −11.55x |
| 0.45 | 297 | +2.41% [−10.53, +14.34] | 48 | −9.79% [−37.63, +18.73] | −4.06x |
| 0.50 | 295 | +1.04% [−11.00, +12.87] | 47 | −12.13% [−42.89, +19.83] | −11.65x |

## Cross-fold summary

| W_PIT | Fold A test | Fold B test | Fold C test | Mean test | CI overlap w/ baseline? |
|---|---|---|---|---|---|
| 0.30 | −0.06% | −5.75% | +6.81% | +0.34% | A=yes, B=yes, C=yes |
| **0.32** | **+2.98%** | −1.78% | **+9.36%** | **+3.52%** | A=yes, B=yes, C=yes |
| 0.35 | +2.19% | **−1.75%** | +4.20% | +1.55% | A=yes, B=yes, C=yes |
| 0.37 | −1.42% | −5.07% | −3.00% | −3.16% | A=yes, B=yes, C=yes |
| **0.40 *** | **−5.42%** | **−11.01%** | **−11.04%** | **−9.16%** | (baseline) |
| 0.42 | −4.63% | −12.43% | −11.47% | −9.51% | A=yes, B=yes, C=yes |
| 0.45 | −0.24% | −7.60% | −9.79% | −5.88% | A=yes, B=yes, C=yes |
| 0.50 | −5.37% | −8.73% | −12.13% | −8.74% | A=yes, B=yes, C=yes |

`*` = current prod baseline.
"CI overlap w/ baseline" = candidate's test CI overlaps baseline's test CI
(mutual containment of point estimate) → NOT distinguishable at 95%.

## Findings

### Finding 1: No candidate is statistically distinguishable from baseline

**Every candidate's test CI overlaps the baseline's test CI in every fold.**
The bootstrap 95% CIs are ~30-40pp wide because n=90-134 per test window
with high per-signal PnL variance. Even the mean-best candidate (W_PIT=0.32,
mean test +3.52% vs baseline −9.16%, delta +12.68pp) has overlapping CIs
across all 3 folds — so we cannot reject the null hypothesis that they are
equal.

**At the current sample size, weight-tuning conclusions on W_PIT are
underpowered.**

### Finding 2: The "best" W_PIT is not stable across folds

- Fold A winner: **0.32** (+2.98% test)
- Fold B winner: **0.35** (−1.75% test)
- Fold C winner: **0.32** (+9.36% test)

If W_PIT had a stable optimum, one value would win consistently. Instead
we see two different winners across three folds, both within noise of
each other. **PR #181's specific value W_PIT=0.35 is a point estimate on
one fold, not a stable optimum.**

### Finding 3: Val:Fit ratios show noise, not real signal

Robust params show Val ≈ Fit (ratio ~1x). This sweep shows:

| W_PIT | Fold A Val:Fit | Fold B Val:Fit | Fold C Val:Fit | Consistent? |
|---|---|---|---|---|
| 0.30 | −0.03x | −0.98x | +3.36x | NO — sign flips |
| 0.32 | +3.59x | −0.35x | +3.99x | NO — sign flips |
| 0.35 | +0.94x | −0.35x | +1.44x | NO — sign flips |
| 0.37 | −0.36x | −1.07x | −1.07x | mostly negative |
| 0.40 | −2.00x | −3.57x | −14.30x | consistently negative — baseline overfit |
| 0.42 | −1.89x | −3.35x | −11.55x | consistently negative |
| 0.45 | −0.10x | −1.98x | −4.06x | mostly negative |
| 0.50 | −1.85x | −4.21x | −11.65x | consistently negative |

The best candidate by PR #181 (W_PIT=0.35) shows Val:Fit **sign flips
across folds** (+0.94x, −0.35x, +1.44x). This is textbook noise
signature. Robust improvements would show consistent ~+1x ratios in
every fold.

### Finding 4: Baseline itself is overfit

W_PIT=0.40 shows:
- Fit ROI positive across all 3 folds: +2.72%, +3.09%, +0.77%
- Test ROI negative across all 3 folds: −5.42%, −11.01%, −11.04%
- Val:Fit ratio: −2.00x, −3.57x, −14.30x — all deeply negative

**The current prod weight is consistently overfit to its own fit period.**
This is why the "any lower value looks better" pattern shows up — moving
away from baseline reduces the overfit penalty, but doesn't identify a
better weight per se.

Any true optimum is somewhere in the 0.30-0.35 range, but the specific
value cannot be resolved at n≈100-200 per test window.

### Finding 5: Direction is right, magnitude is not

Mean test ROI (across all 3 folds) by W_PIT:
```
0.30: +0.34%
0.32: +3.52% ← highest mean
0.35: +1.55%
0.37: -3.16%
0.40: -9.16% (baseline)
0.42: -9.51%
0.45: -5.88%
0.50: -8.74%
```

Monotonic pattern: candidates below baseline have positive-or-near-zero
mean test ROI; candidates at or above baseline are negative. This
suggests the true optimum is below 0.40 — but the specific value
(0.30, 0.32, 0.35) cannot be distinguished, and none is significantly
different from baseline at 95%.

## Decision: DO NOT SHIP, LEAVE W_PIT AT 0.40, REVISIT

### Retract PR #181's combo 7 pilot recommendation

PR #181 recommended combo 7 (W_PIT=0.35 + SP_WEIGHT=0.75) as a candidate
for gated pilot based on:
- Val ROI +12.15% on the July holdout
- Fit ROI +4.46% agreeing in direction
- Val 1-2pp band dramatically improved

The Val:Fit ratio 3.1x was noted as "still above 1:1 but the best of any
combo tested." This rolling-CV supersedes that: **3.1x is an overfit
warning, not a partial-signal indicator.** Across 3 folds, W_PIT=0.35
shows Val:Fit ratios that flip signs (0.94x, −0.35x, +1.44x) —
inconsistent with a real effect at the current sample size.

**PR #181's pilot recommendation is retracted.** Nothing ships. W_PIT
stays at 0.40.

### Why leave W_PIT at 0.40 despite mean-test evidence favoring lower

1. **Statistical significance:** CIs overlap baseline in every fold. At
   95% we cannot reject "W_PIT = 0.40 is fine."
2. **Optimum instability:** Winner varies (0.32 vs 0.35) across folds.
3. **Val:Fit inconsistency:** Sign flips indicate noise, not signal.
4. **Baseline overfit is a separate problem:** The mean-test gain
   reflects "less overfit" rather than "closer to true optimum." Fixing
   the overfit requires a genuinely-calibrated weight, not just a
   different arbitrary value.
5. **Ship cost:** Every settings change touches every future signal.
   Shipping a change without confidence risks worse performance if the
   true optimum drifts from what a small sample says.

### Suggested revisit path

- **Wait for sample to ~2x current** (~ end of season / into October).
  Target: n≥250 per test window with CI widths <~20pp.
- **Then re-run this rolling-CV** with the same 8-value grid + expanded
  window range.
- **Ship criteria if re-run supports:**
  - Same W_PIT winner in all 3 folds (stable optimum)
  - Test CI excludes baseline in at least 2 of 3 folds (statistical significance)
  - Val:Fit ratios positive and ~0.7x to ~1.3x in all folds (real signal)
  - Baseball mechanism story unchanged (weight inversely to input variance)
- **If any of those fail:** leave W_PIT at 0.40 permanently, treat as
  "on a broad plateau; not worth further sweep effort."

### For future weight-tuning passes

- **Bootstrap CIs are mandatory** on small-sample sensitivity work.
  Point estimates at n<200 can move ±5-10pp on 1-2 signal flips.
- **Rolling-origin CV is mandatory** for any recommendation with ship
  implications. Single-split (Fit Apr-Jun / Test Jul) numbers cannot
  distinguish real optima from noise.
- **Val:Fit ratio ≤1.5x is the threshold** for "real, not overfit." 3x
  is overfit warning, not partial signal.
- **CI overlap with baseline in majority of folds = insufficient
  evidence.** Do not ship unless CIs at least partially separate.

## Artifacts

- Script: `scripts/sweep-w-pit-rolling-cv.js`
- Grid TSV: `docs/data/sweep-w-pit-rolling-cv.tsv`
- Cap pinned: HARD=0.08 (matches PR #181 harness)
- SP_WEIGHT held at prod baseline 0.80 throughout
- 3 folds × 8 candidates × bootstrap 1000 = full evidence base

## What this pass measured vs did NOT

**Measured:** W_PIT stability across 3 rolling-origin holdout windows
with bootstrap 95% CIs. Whether the PR #181 finding (W_PIT=0.35 helps
Val) replicates across multiple test windows. Whether Val:Fit ratio
suggests real signal or noise inflation.

**Not measured:**
- SP_WEIGHT rolling-CV (would be a separate follow-up if the direction
  ever earns further investigation — but per the PR #181 corrected
  supplementary, SP_WEIGHT=0.75 alone showed weak Val gain (+0.91%) with
  Fit +0.09%, small effect that would likely also fail rolling-CV)
- Interaction of W_PIT + SP_WEIGHT under rolling-CV (moot; W_PIT alone
  fails CV, so combo 7 fails too)
- Totals rolling-CV (Totals paused, and no weight change is being
  proposed for ML anyway)

**Not shipped:** Nothing. PR #181's pilot recommendation is retracted.
