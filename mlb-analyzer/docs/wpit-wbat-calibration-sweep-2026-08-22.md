# W_PIT/W_BAT swept on calibration, not ROI (2026-08-22)

> **Measurement pass. No parameter change shipped.** Production
> `W_PIT=0.40 / W_BAT=0.60` stays.

**First use of a method that can actually answer the question.** Per the
2026-08-21 rule, an ROI sweep measures selection — and
`scripts/optimize-params.js` (April 2026, top-20 **by ROI**) is exactly
how production `W_PIT=0.40` was chosen. This re-runs the question against
a calibration target over **every game**, no emit floor, no selection.

Harness: `scripts/calibration-sweep.js` (parameterised — any key
`applySweepOverrides` accepts).

## TL;DR

- **The method has power.** `W_PIT ≥ 0.80` is **significantly worse**
  than production — bootstrap CIs exclude zero. First parameter region
  this project has ruled out with a method capable of ruling anything
  out.
- **0.40 survives, but not for April's reasons.** Log loss is minimised
  at **0.30** (0.68954 vs production 0.68975), a gap of 0.00020 whose CI
  spans zero. 0.40 sits inside a flat, defensible plateau of roughly
  0.20–0.50. The ROI ranking that picked it does not survive; the value
  it picked does.
- **The optimum drifts.** 0/8 candidates hold a log-loss sign across
  five folds, and Val:Fit fails on sign for the low half — the early
  season mildly prefers ~0.40–0.50, the later season clearly prefers
  lower.
- **Bigger than the W_PIT answer:** the model's **claimed edge is not
  demonstrably real**. Slope of realised excess on claimed edge is
  −0.313 with 95% CI **[−0.907, +0.548]** — spans zero, but **excludes
  1.0**. The model beats the base rate and loses to the market.

## Setup

790 games, 2026-06-01 → 2026-08-07, per-date wOBA snapshots
(look-ahead safe). Home win rate 51.65%.

**The design property that matters:** the harness asserts an identical
game set at every grid value — 790 at all nine, 0 dropped. Composition
cannot move any number here, which is precisely what the ROI sweep could
not say.

Targets on `runModel().adjHW` (home win probability): log loss
(primary), Brier, ECE over deciles, and the OLS slope of realised excess
`(y − p_market)` on claimed edge `(p_model − p_market)`, with market
probabilities de-vigged from both sides.

## 1. Reference points

| | log loss |
|---|---|
| always predict the base rate (51.65%) | 0.69261 |
| **model, production W_PIT=0.40** | **0.68975** |
| market, de-vigged | **0.68310** |

The model is genuinely informative — 0.00286 better than the base rate.
The market is 0.00951 better. **The model captures about 30% of the
market's information advantage.** That is the honest frame for
everything below: a model with real but partial signal.

## 2. Log loss across the grid

| W_PIT | log loss | Δ vs prod | Brier | ECE | edge slope |
|---|---|---|---|---|---|
| 0.10 | 0.69060 | +0.00085 | 0.24873 | 0.0336 | −0.043 |
| 0.20 | 0.68983 | +0.00009 | 0.24835 | 0.0167 | −0.113 |
| **0.30** | **0.68954** | **−0.00020** | 0.24820 | **0.0039** | −0.208 |
| **0.40** | 0.68975 | — | 0.24830 | 0.0114 | −0.313 |
| 0.50 | 0.69047 | +0.00072 | 0.24864 | 0.0196 | −0.393 |
| 0.60 | 0.69175 | +0.00200 | 0.24925 | 0.0252 | −0.422 |
| 0.70 | 0.69354 | +0.00379 | 0.25009 | 0.0275 | −0.400 |
| 0.80 | 0.69600 | +0.00625 | 0.25122 | 0.0329 | −0.364 |
| 0.90 | 0.69887 | +0.00913 | 0.25252 | 0.0384 | −0.318 |

**This is a curve, not noise.** Smooth, unimodal, shallow minimum near
0.30, rising steeply above 0.5 — at 0.90 the model is *worse than
guessing the base rate*. Contrast the W_PROJ ROI sweep, where the fixed
core had span 0.00 and the headline was pure churn.

Brier and ECE agree with log loss; ECE is minimised at 0.30 (0.0039 vs
production 0.0114).

## 3. Bootstrap — the method rejects the high end

Date-clustered, B=2000, on Δ log loss vs production.

| W_PIT | Δ log loss | 95% CI | excludes 0 |
|---|---|---|---|
| 0.10 | +0.00085 | [−0.00362, +0.00478] | no |
| 0.20 | +0.00009 | [−0.00286, +0.00280] | no |
| 0.30 | −0.00020 | [−0.00174, +0.00112] | no |
| 0.50 | +0.00072 | [−0.00065, +0.00224] | no |
| 0.60 | +0.00200 | [−0.00071, +0.00508] | no |
| 0.70 | +0.00379 | [−0.00032, +0.00854] | no |
| **0.80** | **+0.00625** | **[+0.00069, +0.01254]** | **YES (worse)** |
| **0.90** | **+0.00913** | **[+0.00235, +0.01720]** | **YES (worse)** |

**Two candidates are distinguishable, both as worse.** This is the
result that validates the method: it is not simply returning "everything
is noise" the way every ROI sweep has. It can separate hypotheses, and
here it separates them.

Nothing is distinguishably *better* than production. 0.30's advantage is
0.00020 with a CI spanning zero — a point estimate, not a finding.

## 4. Where it does not hold up: the optimum drifts

Rolling folds, Δ log loss vs production (negative = better):

| W_PIT | F1 | F2 | F3 | F4 | F5 |
|---|---|---|---|---|---|
| 0.10 | −0.00417 | +0.00091 | +0.01195 | +0.00433 | −0.00827 |
| 0.30 | −0.00195 | −0.00022 | +0.00357 | +0.00105 | −0.00330 |
| 0.60 | +0.00577 | +0.00210 | −0.00580 | −0.00080 | +0.00840 |
| 0.90 | +0.01682 | +0.01027 | −0.01055 | +0.00162 | +0.02642 |

**0 of 8 hold a sign** — but read the columns, not the rows. F1 and F5
favour *low* W_PIT for every candidate; F3 favours *high* for every
candidate. The signs flip together, in opposite directions, in a
consistent pattern. That is not random noise; it is a **time-varying
optimum**.

Val:Fit says the same thing. For 0.10–0.30 the fit period says worse
(+) while the validation period says better (−); for 0.50+ the fit
period is ~flat while validation says clearly worse. **0 of 8 pass**,
and the failures are sign disagreements, not ratio blowouts.

So: the later season prefers a lower W_PIT than the earlier season. This
is worth a separate look — a candidate mechanism is that as actuals
mature the batter side carries more information, reducing the optimal
pitcher weight — but it is not established here and should not be acted
on from this sweep.

## 5. Calibration curves

Production, and the log-loss minimum, over deciles of predicted home
win probability:

**W_PIT=0.40 (production)**

| bin | n | mean p | realised | diff |
|---|---|---|---|---|
| 0.3-0.4 | 12 | 0.378 | 0.583 | +0.205 |
| 0.4-0.5 | 278 | 0.466 | 0.457 | −0.009 |
| 0.5-0.6 | 438 | 0.541 | 0.543 | +0.003 |
| 0.6-0.7 | 62 | 0.626 | 0.581 | −0.046 |

**W_PIT=0.30 (lowest log loss)**

| bin | n | mean p | realised | diff |
|---|---|---|---|---|
| 0.3-0.4 | 5 | 0.372 | 0.200 | −0.172 |
| 0.4-0.5 | 280 | 0.467 | 0.468 | +0.001 |
| 0.5-0.6 | 453 | 0.540 | 0.536 | −0.003 |
| 0.6-0.7 | 52 | 0.626 | 0.635 | +0.009 |

Both are well calibrated where the games are — 716 of 790 sit in the two
middle bins, with diffs of 0.001–0.009. The model is mildly
**overconfident in the high tail** (0.6-0.7: claims 0.626, realises
0.581 at production), on n=62. The 0.3-0.4 bin is n=12/n=5 and carries
no weight.

Note the model almost never leaves 0.4–0.7. It is a low-conviction
model, which is consistent with capturing only ~30% of the market's
information.

## 6. The claimed edge

Slope of realised excess on claimed edge, production settings, n=790:

**−0.313, 95% CI [−0.907, +0.548]**

Read carefully:

- The CI **spans zero**, so the claimed edge is **not shown to be
  backwards**. The point estimate is negative; that is not a finding on
  its own.
- The CI **excludes 1.0**. So the claimed edge is **definitely not fully
  real** — at most about half real, and plausibly zero.

Binned, which is more informative than the single slope:

| claimed edge bin | n | mean claimed | mean realised |
|---|---|---|---|
| ≤ −0.05 | 150 | −0.0748 | −0.0232 |
| −0.05..−0.03 | 118 | −0.0396 | −0.0122 |
| −0.03..−0.01 | 142 | −0.0199 | +0.0561 |
| −0.01..+0.01 | 140 | −0.0001 | +0.0073 |
| +0.01..+0.03 | 103 | +0.0202 | −0.0533 |
| +0.03..+0.05 | 59 | +0.0390 | −0.0852 |
| ≥ +0.05 | 78 | +0.0745 | −0.0488 |

There is a hint of asymmetry — when the model fades the home team it is
directionally right (ratio ~0.31 in both negative tails); when it backs
the home team, realised excess is negative in every positive bin. But at
n=59–150 per bin the standard error on realised excess is roughly
0.045–0.065, so most individual cells are inside one or two SE. **Hint,
not finding.**

What is solid: **the model beats the base rate on log loss but its
deviations from the market are not demonstrably profitable in either
direction.** That is the cleanest explanation yet for why every ROI
sweep has sat at −5% to −6%, and it is a model-quality question rather
than a parameter-tuning one.

## 7. So does 0.40 hold up?

**Yes as a value, no as a derivation.**

- April's ROI grid search cannot support the choice — that design
  measures selection. That 0.40 was picked rather than 0.80 was not
  earned by that method.
- Under a target that *can* answer, 0.40 is statistically
  indistinguishable from the optimum and sits inside a flat plateau of
  ~0.20–0.50. There is no case for changing it.
- There is now a real case for **never raising it**: ≥0.80 is
  significantly worse, and the whole region above 0.5 degrades
  monotonically.

**Recommendation: leave `W_PIT=0.40 / W_BAT=0.60` alone**, and record
that the region above 0.5 is ruled out. Do not move to 0.30 on a
0.00020 point estimate with a CI spanning zero and unstable folds.

## 8. What this does not establish

- **Not** that 0.30 is better. It is a point estimate inside the noise.
- **Not** a totals result. The target here is the ML win probability;
  `W_PIT` also moves `estTot`, which is unmeasured by this pass.
- **Not** an explanation for the drift in §4 — only that it exists.
- **Not** that the claimed edge is backwards. Only that it is not fully
  real (slope CI excludes 1.0).

## 9. Follow-ups worth having

1. **Re-run the other reframed parameters** on this harness — `SP_WEIGHT`
   first, since it was the other half of "combo 7" and that +15.28pp is
   now known to be a selection effect. `scripts/calibration-sweep.js`
   takes the parameter name as an argument.
2. **Investigate the seasonal drift** (§4) before anyone proposes a
   calendar-varying W_PIT; the sweep shows the pattern but cannot
   attribute it.
3. **Chase the edge slope, not the parameters** (§6). If claimed edge is
   at most half real, that caps what any weight retune can deliver, and
   it is the more valuable thing to fix.

## Related

- `CLAUDE.md` — "Sweep ROI measures selection, not pricing".
- `docs/sweep-selection-effect-2026-08-21.md` — why ROI could not answer this.
- `docs/weight-sensitivity-sweep-2026-07.md` — the reframed pass; "combo 7".
- `scripts/optimize-params.js` — the April top-20-by-ROI search that chose 0.40.
- `scripts/calibration-sweep.js` — this harness, reusable.
