# Edge honesty: scope of the calibration finding (2026-08-22)

> ---
> **SUPERSEDED 2026-08-24 — re-run on the corrected corpus.**
> These figures were measured against a database carrying **27**
> weather-contamination tags. The corrected corpus has **797**, and
> `loadGames` filtered weather UNCONDITIONALLY, so the arm labelled
> "full/contaminated" had already had one contamination class removed.
> The real exclusion is **57.3% of games, not 16.2%**.
>
> **No verdict changed tier on re-run** — but two quoted precisions do not
> survive: the **window sign test is unstable at n=349** (same-n controls
> give 2/5, 3/5 and 4/5 on the same feature), and the **sweep grid minimum
> moves across resamples**. FRV reads 3/5 rather than 4/5, and that
> difference is power, not decontamination.
>
> Original figures left intact. See
> `docs/decontaminated-rerun-corrected-2026-08-24.md`.
> ---


> ---
> **ANNOTATION 2026-08-23 — re-run on the decontaminated corpus.**
> Every figure on this page was computed on a corpus that retained 128
> games priced after real first pitch
> (`docs/post-start-pricing-tagged-2026-08-22.md`). Those are now excluded
> and everything here was re-run.
>
> **No verdict changed and no tier moved.** Absolute numbers shift because
> the corpus drops 790 -> 662 (16.2%); the shifts were checked against a
> 20-seed n-matched control drawn from the *contaminated* corpus, and
> **every one lands inside the control's p5..p95** — i.e. they are power
> effects, not contamination effects.
>
> Superseding numbers: `docs/decontaminated-rerun-2026-08-23.md`.
> Figures below are left as originally recorded rather than overwritten.
> ---


**Status:** measurement pass, nothing shipped. Harness:
`scripts/edge-honesty-scope.js`.

Scopes the finding from `docs/wpit-wbat-calibration-sweep-2026-08-22.md`
— claimed edge does not translate into realised edge. The question:
**real but overstated (worth shrinking toward), or mostly illusory?**

## TL;DR

- **No regime is honest.** 18 subgroup slopes tested — by market,
  magnitude, month, park. **0 have a CI excluding zero.** Most exclude
  1.0, so the claimed edge is definitely overstated; none establishes it
  is real.
- **The model is significantly WORSE than the market** (log loss
  +0.00665, CI [+0.00025, +0.01286]).
- **The model is NOT significantly better than the base rate**
  (−0.00286, CI [−0.00983, +0.00458]). **This corrects the
  2026-08-22 sweep doc**, which called the model "genuinely
  informative" off a point estimate with no CI. It is not established.
- **The 8pp cap is NOT independently justified by this.** Honesty does
  not degrade with edge size; if anything ML is marginally better above
  the cap than below. Whatever justifies `SIGNAL_EDGE_HARD_CAP=0.08`, it
  is not this.
- **Verdict: leaning illusory, but the data cannot decide.** Resolving a
  true slope of 0.30 needs ~3.8 more seasons.

## Method

One observation per game per market, always the **same side** (home for
ML, over for totals) — so nothing is conditioned on what the model
picked and there is no selection of any kind. The opposite side is the
exact mirror, so this is unconditional.

```
x = p_model(side)  − p_market_devig(side)     claimed edge
y = outcome(side)  − p_market_devig(side)     realised excess
slope 1.0 = claimed edge fully real | 0.0 = noise | <0 = backwards
```

Market probabilities de-vigged from both sides. All CIs are
**date-clustered** bootstrap, B=3000.

> **Correction to the prior doc's interval.** The ML slope CI was
> reported yesterday as [−0.907, +0.548] from an *observation-level*
> bootstrap. Date-clustering is correct here — same-slate games share
> market state — and widens it to **[−1.032, +0.392]**. The conclusion
> (spans 0, excludes 1.0) is unchanged; the interval was slightly
> optimistic.
>
> Note also that production's own `edge` field compares against the
> **raw vigged** implied price, so the edges the model reports are
> systematically *smaller* than the honest ones measured here.

## 1. By market — ML and totals disagree in sign, neither is real

| group | n | slope | 95% CI | |
|---|---|---|---|---|
| ML (home side) | 790 | −0.313 | [−1.032, +0.392] | spans 0, excl 1.0 |
| Totals (over side) | 789 | +0.207 | [−0.390, +0.874] | spans 0, excl 1.0 |
| **pooled** | 1579 | **+0.006** | [−0.410, +0.458] | spans 0, excl 1.0 |

The pooled slope is **+0.006** — as close to exactly zero as this could
land. ML and totals point opposite ways with wide overlapping intervals,
which is what two draws from a null look like.

## 2. By magnitude — no degradation, and no support for the 8pp cap

| ML \|claimed edge\| | n | slope | 95% CI |
|---|---|---|---|
| 0-2pp | 271 | −4.335 | [−9.687, +1.808] |
| 2-4pp | 204 | −1.700 | [−3.588, +0.772] |
| 4-8pp | 235 | −0.391 | [−1.692, +0.773] |
| 8pp+ | 80 | +0.110 | [−0.830, +1.211] |
| **below cap (<8pp)** | 710 | −0.731 | [−1.724, +0.289] |
| **above cap (≥8pp)** | 80 | **+0.110** | [−0.846, +1.207] |

| TOT \|claimed edge\| | n | slope | 95% CI |
|---|---|---|---|
| below cap (<8pp) | 635 | +0.365 | [−0.447, +1.237] |
| above cap (≥8pp) | 154 | −0.070 | [−0.930, +0.650] |

**Read the point estimates with care.** Within a narrow magnitude bin
the variance of `x` collapses, which inflates |slope| — that is why
0-2pp reads −4.3 with a CI six units wide. The bin slopes are an
artifact-prone statistic; §3 is the robust view.

What *is* readable: **there is no monotone degradation with size, and
the above-cap group is not worse than the below-cap group in either
market.** For ML it is marginally better. So this analysis provides **no
independent justification for `SIGNAL_EDGE_HARD_CAP=0.08`**. That cap
may still be right on its original basis
(`docs/ship-hard-cap-0.08-2026-07-13.md`) — it simply does not get
support from here, and it would have been convenient to claim it did.

## 3. Binned realised vs claimed (ML) — the robust view

| claimed bin | n | mean claimed | mean realised | ±SE | ratio |
|---|---|---|---|---|---|
| ≤ −0.08 | 49 | −0.1004 | −0.0684 | 0.069 | +0.68 |
| −0.08..−0.04 | 164 | −0.0554 | +0.0026 | 0.039 | −0.05 |
| −0.04..−0.02 | 119 | −0.0294 | +0.0016 | 0.045 | −0.06 |
| −0.02..+0.02 | 271 | −0.0015 | +0.0208 | 0.030 | — |
| +0.02..+0.04 | 85 | +0.0291 | **−0.1004** | 0.053 | −3.45 |
| +0.04..+0.08 | 71 | +0.0545 | −0.0500 | 0.057 | −0.92 |
| ≥ +0.08 | 31 | +0.0978 | −0.0350 | 0.085 | −0.36 |

There is a **hint of asymmetry**: when the model fades the home team at
size it is directionally right (ratio +0.68 in the extreme negative
bin); every positive-claim bin has negative realised excess. If real,
that would mean the model's "back the home team" signal is the broken
half.

But: the largest cell (+0.02..+0.04 at −0.1004 ± 0.053) is ~1.9 SE, and
**seven bins were examined**. One ~2 SE cell out of seven is what chance
produces. This is a hypothesis to re-test on more data, not a finding.

## 4. By month and by park — nothing

| group | n | slope | 95% CI |
|---|---|---|---|
| ML 2026-06 | 368 | +0.168 | [−0.942, +1.410] |
| ML 2026-07 | 347 | −0.728 | [−1.757, +0.476] |
| ML 2026-08 | 75 | −0.390 | [−1.783, +1.370] |
| TOT 2026-06 | 367 | +0.206 | [−0.738, +1.058] |
| TOT 2026-07 | 347 | +0.234 | [−0.652, +1.141] |
| TOT 2026-08 | 75 | −0.121 | [−1.642, +1.724] |

By park run environment (park_factor tertiles, cuts 0.970 / 1.030): ML
−0.188 / −1.017 / +0.150 and TOT −0.485 / +0.159 / +0.293 across
pitcher / neutral / hitter parks. **Every interval spans zero.**

*Cohort was not available as a breakdown:* `game_log` carries no cohort
column, and this analysis re-scores with current code, so cohort is
constant by construction. Month is the time-regime analogue.

## 5. The two framing facts — and a correction

The slope asks a second-order question and is low-powered by
construction. These two are higher-powered and decide the reading
(n=790, ML, date-clustered CIs):

| | log loss |
|---|---|
| model | 0.68975 |
| market (de-vigged) | 0.68310 |
| base rate (51.65%) | 0.69261 |

| comparison | Δ | 95% CI | |
|---|---|---|---|
| model − base rate | −0.00286 | [−0.00983, +0.00458] | **not significant** |
| model − market | **+0.00665** | **[+0.00025, +0.01286]** | **significant (model worse)** |

**The model is significantly worse than the market. The model is NOT
significantly better than predicting a constant 51.65%.**

> **REFINED 2026-08-23 by `docs/component-signal-diagnostic-2026-08-23.md`.**
> Both statements stand, but "not better than a constant" turns out to
> be a statement about **power, not brokenness**. Decomposing the model:
> sp, bullpen and lineup wOBA each point the **right way in all 5
> out-of-sample folds**; the assembled model is the best non-market
> predictor tested and ranks games better (AUC 0.5504) than an
> optimally-fitted linear combination of its own components (0.5137);
> and recalibrating its output makes log loss *worse*, so the
> runs→probability step is not the fault. The model is **weak but
> sound** — roughly a third as informative as the market — and
> establishing its edge over a constant needs ~2.5 seasons at the
> observed effect size.

> **This corrects `docs/wpit-wbat-calibration-sweep-2026-08-22.md`**,
> which stated "the model is genuinely informative — 0.00286 better than
> the base rate" and "captures ~30% of the market's information
> advantage". Both were point-estimate ratios reported without an
> interval. With a CI, the numerator is not distinguishable from zero,
> so the 30% figure has no support. That doc has been annotated.

Skill and edge-honesty are different questions — a model can be better
than the base rate while its *deviations from a sharper market* carry
nothing exploitable. Here we cannot even establish the first.

## 6. Real-but-overstated, or illusory?

**The data cannot decide, and the weight of evidence leans illusory.**

For "real but overstated": every slope CI comfortably contains +0.2 to
+0.3, so a genuinely one-third-real edge is not excluded.

For "illusory": the pooled slope is +0.006; 0 of 18 cuts reach
significance; no regime, magnitude band, month or park stands out; and
the model is not demonstrably better than a constant. If there were a
real edge of meaningful size somewhere, 18 cuts is a reasonable number
of chances to have seen a hint of it.

**A shrinkage multiplier is not actionable here.** It would only be so
if its CI excluded *both* 0 and 1 — otherwise "shrink to nothing" and
"do not shrink at all" are both inside the interval. ML implies −31%
(CI −104%..+38%), totals +21% (CI −38%..+85%). Neither qualifies.

What *is* consistent: model significantly worse than market + claimed
edge not demonstrably real ⇒ betting the model's deviations has
negative expectation before vig. That is a coherent explanation for
every ROI sweep sitting at −5% to −6%.

## 7. Power

| | slope SE at current n | to resolve a true slope of 0.30 |
|---|---|---|
| ML | 0.364 (n=790) | ~11.6× the data — 9,134 games, **~3.8 seasons** |
| Totals | 0.314 (n=789) | ~8.6× the data — 6,790 games, **~2.8 seasons** |

Not reachable by accumulation this season. The same constraint that
retired the per-park sens audit.

## 8. What follows

1. **Do not implement an edge-shrinkage multiplier.** The CI does not
   support choosing one, and picking a number inside a [−104%, +38%]
   interval is the failure mode the sweep rules exist to prevent.
2. **The live question is skill, not calibration of edge.** "Is the
   model better than a constant?" is higher-powered than any slope
   question and currently answers *not demonstrably*. That is the thing
   worth fixing, and it is upstream of every weight.
3. **Re-test the positive/negative asymmetry** (§3) on multi-season data
   before treating it as real.
4. **The 8pp cap needs its own justification** — it does not get one
   here.

## Related

- `docs/wpit-wbat-calibration-sweep-2026-08-22.md` — where the slope
  came from; corrected by §5 above.
- `docs/sweep-selection-effect-2026-08-21.md` — why ROI could not have
  answered any of this.
- `docs/ship-hard-cap-0.08-2026-07-13.md` — the cap's actual basis.
- `scripts/calibration-sweep.js` — the parameter harness.
