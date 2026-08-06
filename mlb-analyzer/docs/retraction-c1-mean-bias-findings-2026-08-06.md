# Retraction — mean-based temp attribution findings (2026-08-06)

Two Phase C1 findings landed with mean-based residual analysis and
were then contradicted by a distributional redo the same session.
Both are retracted here so future analysis doesn't re-cite them.

## What was claimed

### Retracted finding #1: "Model globally under-forecasts run totals by ~0.9 runs"

- **Source:** first Phase C1 pass, `tmp/temp-attribution-c1-2026-08-06.js`.
- **Basis:** mean residual (actual_total − model_total) = +0.815 on
  777 clean rows, with 95% bootstrap CIs excluding zero in several
  temperature buckets (65-69°F, 70-74°F, 75-79°F, 90°+).
- **Recommended follow-up (from the original pass):** sweep RUN_MULT
  to correct the global under-forecast.

### Retracted finding #2: "Temp curve slope is 0.0197 runs/°F"

- **Source:** first Phase C1 pass.
- **Basis:** OLS of `pre_temp_residual = residual + temp_run_adj`
  against `(temp_f − 65)` on individual rows.
- **Recommended follow-up (from the original pass):** propose a
  continuous temp formula behind a settings flag, shadow-mode first.

## Why both are wrong

Distributional redo (`tmp/temp-attribution-c1-distributional-2026-08-06.js`,
same 777 clean rows):

- **Median residual overall is +0.190**, not +0.815. Gap of 0.625
  runs is entirely from the right tail — 20+ run blowouts exist
  (max residual +19.6) but games have a natural floor around 4-6
  runs (min residual −8.6). Skewness = +0.597.
- **Sign-split is 51.4% under / 48.6% over.** Model is per-game
  centered as tightly as a probabilistic model can be.
- **Removing 12.6% blowouts (`actual_total ≥ 15`) flips the mean
  sign.** Non-blowout mean is −0.309 (slightly over-forecast).
  Blowouts contribute +1.085 runs to the overall mean by themselves.
- **Bucket medians cluster around zero.** The 80-84 bucket has
  median +0.030 (mean was +0.513). The 85-89 bucket has median
  −0.360 (mean was +0.380). Both were flagged as "under-forecast"
  by the mean; both are essentially calibrated on the median.
- **Median-based temp slope is −0.00054 runs/°F**, versus the
  mean-based 0.0197. Effectively zero. The mean-based slope was
  capturing intercept-shift-across-buckets from tail skew
  concentrating in hot games, not a genuine temperature-runs
  relationship.
- **Signal performance corroborates.** In the same clean window,
  the model emits Unders 258:113 over Overs and Unders lose −4.6%
  ROI vs Overs at −9.5%. A RUN_MULT level-up "correction" would
  flip the model toward emitting more Overs and would likely
  degrade the working Under-lean.

## What's actually there

- **The model is calibrated per-game.** No global RUN_MULT change is
  warranted.
- **The temp step function is roughly correctly calibrated across
  all buckets from <55°F through 85-89°F on medians.** No continuous-form
  change is warranted; the earlier CV win of continuous over step (~1.2%
  MSE) was carried by the intercept absorbing tail-skew.
- **The only remaining open question is 90°F+.** Median residual there
  is +1.05 on n=55 (95% CI 0.52-2.83 on the mean, wide on median), and
  the current step ceilings at +0.6. This might justify a 90°+ ceiling
  extension but the sample is too small to commit. See
  `shadow-mode-90f-ceiling-2026-08-06.md` for the collection plan.

## Discipline going forward

Added to CLAUDE.md ("Skewed-residual analysis discipline"). The short
form: on any residual analysis where the outcome has an asymmetric
floor/tail (run totals are the canonical case for this project), report
mean AND median, sign-split, trimmed mean, and blowout-excluded mean
side-by-side. If the mean-based finding disappears on medians or on
blowout-excluded numbers, it was skew masquerading as bias.
