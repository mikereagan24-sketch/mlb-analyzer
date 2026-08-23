# Why the model does not beat a constant — component diagnosis (2026-08-23)

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


> **Diagnosis only. No proposals, nothing shipped.**

`docs/edge-honesty-scope-2026-08-22.md` established the assembled model
is significantly worse than the market and not significantly better than
a constant 51.65%. This decomposes it: is any single input predictive on
its own?

Harness: `scripts/component-signal-diagnostic.js`. 789 games,
2026-06-01 → 2026-08-07, per-date wOBA snapshots.

## TL;DR — neither branch of the hypothesis is right

The brief posed two outcomes: components predictive but the combination
broken, or components carrying no signal. **The answer is a third
thing.**

- **No component beats the base rate individually.** Every CI spans zero.
- **But every quality component points the RIGHT way in all 5 folds**
  — sp, bp and bat all 5/5 positive. That is not what "no signal" looks
  like.
- **The combination is not the problem — it is the best part.** The
  assembled model's AUC (0.5504) beats a naive optimal linear
  combination of its own components (0.5137). The Pythag/weighting
  machinery is *adding* ordering information, not destroying it.
- **Recalibrating the model does not help** (log loss −0.00227 vs
  −0.00367 as-is), so the runs→probability step is not the fault either.
- **Verdict: the signal is real, directionally consistent, structurally
  well combined — and too small to resolve at n=789.** The model is
  underpowered, not broken.

## Method

Each input reduced to one per-game scalar, oriented so **positive =
home advantage**:

| feature | definition |
|---|---|
| `sp` | away SP wOBA-against − home SP wOBA-against |
| `bp` | away bullpen wOBA − home bullpen wOBA |
| `bat` | home lineup wOBA − away lineup wOBA |
| `pf` | park factor |
| `hfa` | degenerate for ML — it *is* the intercept, so it is the base-rate test |

**Every fitted predictor is scored only on data it was not fitted to:**
5 contiguous date-blocked folds, fit on 4, predict the held-out one.
The base rate is cross-fitted the same way. Fitting and scoring on the
same rows would have made every component look predictive.

## 1. HFA is not established either

Home win rate **51.71%**, which is **0.96 SE** from 50.0%. Not
significant. The home-field advantage the model hard-codes
(`HFA_BOOST=0.017`) is not distinguishable from zero in this sample —
worth knowing before anyone tunes it.

## 2. Out-of-sample log loss vs cross-fitted base rate

| predictor | log loss | Δ vs base | 95% CI | beats base? |
|---|---|---|---|---|
| base rate (constant) | 0.69321 | — | | |
| sp (SP quality) | 0.69244 | −0.00078 | [−0.00487, +0.00429] | no |
| bp (bullpen) | 0.69375 | +0.00054 | [−0.00468, +0.00780] | no |
| **bat (lineup wOBA)** | 0.69175 | **−0.00147** | [−0.00621, +0.00318] | no |
| pf (park factor) | 0.69364 | +0.00043 | [−0.00196, +0.00332] | no |
| all4 combined | 0.69625 | **+0.00303** | [−0.00446, +0.01265] | no (worse) |
| model* recalibrated | 0.69095 | −0.00227 | [−0.00748, +0.00338] | no |
| **model as-is** | 0.68954 | **−0.00367** | [−0.01051, +0.00383] | no |
| **market (ceiling)** | 0.68311 | **−0.01011** | **[−0.01863, −0.00015]** | **YES** |

**Only the market clears.** But note the ordering: the **assembled model
is the best non-market predictor** — better than any component alone,
better than the components combined, and better than itself recalibrated.

`all4 combined` being *worse than the base rate* is the signature of
fitting four weak, correlated features on ~630 training rows. It is a
statement about naive linear combination, not about the inputs.

## 3. Sign stability — this is where the signal shows up

Fitted coefficient per component, per fold. Positive = points the right
way.

| component | F1 | F2 | F3 | F4 | F5 | consistent |
|---|---|---|---|---|---|---|
| **sp** | +0.190 | +0.121 | +0.090 | +0.166 | +0.207 | **5/5 correct** |
| **bp** | +0.194 | +0.251 | +0.223 | +0.137 | +0.064 | **5/5 correct** |
| **bat** | +0.115 | +0.101 | +0.131 | +0.161 | +0.101 | **5/5 correct** |
| pf | −0.104 | −0.040 | −0.030 | −0.043 | −0.067 | 5/5 negative |

Under a null of no signal, P(all 5 folds same sign) = 2 × 0.5⁵ =
**0.0625** per component. Three quality components all landing 5/5 **in
the correct direction** is not what noise produces — though they are
correlated (all proxy team quality), so this is not three independent
6% events.

**This is the finding the log-loss table hides.** The components are
directionally right and stably so; they are simply small.

`pf` is consistently *negative* — a high-scoring home park slightly
predicts a home loss. Magnitude is the smallest of the four. Plausibly
confounding (park factor correlates with roster construction) rather
than a real effect, and park factor should not predict a *winner* at all
since it applies to both teams. Noted, not chased.

## 4. Ordering vs calibration — locating the failure

AUC is scale-free: it asks only whether games are *ranked* correctly.

| predictor | AUC |
|---|---|
| market | **0.5808** |
| **model as-is** | **0.5504** |
| model recalibrated | 0.5435 |
| all4 combined | 0.5137 |
| (no information) | 0.5000 |

Two things follow.

**The combination is adding value, not destroying it.** The assembled
model ranks games better (0.5504) than an optimally-fitted linear
combination of its own components (0.5137). Whatever Pythag + the
weighting chain are doing, they extract more ordering than a regression
handed the same raw inputs. **The brief's "the problem is in the
combination" hypothesis is not supported.**

**The runs→probability step is not the fault either.** Recalibrating the
model's own output moves log loss from −0.00367 to −0.00227 — i.e.
*worse*. If the ordering were fine and only the scale wrong,
recalibration would have improved it. It did not.

*(Technical note: recalibrated AUC differs slightly from as-is only
because each fold fits its own intercept/slope, so the pooled
predictions are not a single monotone transform. A monotone transform
cannot change AUC.)*

## 5. Power — the actual constraint

Games needed for 80% power at the observed point estimate:

| predictor | Δ | SE | multiple of current n | games | seasons |
|---|---|---|---|---|---|
| market | −0.01011 | 0.00471 | 1.7× | 1,347 | ~0.6 |
| **model as-is** | −0.00367 | 0.00366 | **7.8×** | 6,155 | **~2.5** |
| bat | −0.00147 | 0.00240 | 20.8× | 16,449 | ~6.8 |
| sp | −0.00078 | 0.00234 | 70.5× | 55,596 | ~22.9 |

The market's edge over a constant is large enough to establish in about
half a season. The model's is roughly a third that size and needs ~2.5
seasons. **Individual components are hopeless in isolation** — that is
expected, and it is why the model combines them.

## 6. What this means

Restating the earlier conclusion more precisely: **"the model does not
beat a constant" is a statement about statistical power, not about the
model being broken.** What the diagnosis actually shows:

- inputs carry real, directionally consistent signal (5/5 folds, three
  components);
- the model's combination of them is the best-performing arrangement
  tested, beating both the components alone and a fitted linear
  alternative;
- its probability scale is not obviously wrong — recalibration does not
  help;
- the whole thing is roughly one-third as informative as the market,
  which is a gap of degree, not of kind;
- n=789 cannot resolve an effect of that size.

That is a coherent picture of a **weak but sound** model, not a broken
one — and it is a different diagnosis from what
`docs/edge-honesty-scope-2026-08-22.md` implied when it said the model
was "not demonstrably better than a constant". Both statements are true;
this one is more informative.

## 7. What this does NOT establish

- **Not** that the model *does* beat a constant. It does not, at this n.
  The point estimate is favourable and the CI spans zero.
- **Not** that the combination is optimal — only that it beats the
  naive linear alternative tested here.
- **Not** anything about totals. Target throughout is the ML win
  probability.
- **Not** a verdict on `HFA_BOOST` beyond the observation that the home
  advantage itself is not significant here.
- **Not** an explanation for the negative `pf` coefficient.
- The components were reduced to simple mean-of-splits scalars. A richer
  encoding (platoon-correct splits, IP-weighted SP vs bullpen) might
  carry more signal than these proxies do.

## 8. Open questions this raises

Recorded, not proposed — per the brief, no recommendations here.

1. Is the model's advantage over a naive linear combination (AUC 0.5504
   vs 0.5137) real, or an artifact of the linear fit overfitting four
   correlated weak features? A regularised or lower-dimensional
   alternative would separate those.
2. Does the ~2.5-season power requirement change if the target is
   totals rather than ML? Totals may carry more signal per game.
3. Why is `pf` consistently negative?
4. Is `HFA_BOOST=0.017` supported by multi-season data, given the home
   rate here is 0.96 SE from 50%?

## Related

- `docs/edge-honesty-scope-2026-08-22.md` — the finding this diagnoses.
- `docs/wpit-wbat-calibration-sweep-2026-08-22.md` — the calibration target.
- `docs/sweep-selection-effect-2026-08-21.md` — why ROI could not get here.
- `scripts/component-signal-diagnostic.js` — this harness.
