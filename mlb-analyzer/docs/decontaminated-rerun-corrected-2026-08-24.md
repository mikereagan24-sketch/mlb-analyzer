# The decontaminated re-run, done properly (2026-08-24)

> **No verdict changes tier. Not one, across eleven comparisons.** Same
> conclusion as 2026-08-23 — but that conclusion was reached by accident
> last time, and it is now reached on evidence.
>
> **The exclusion is 57.3% of games, not 16.2%.** The 2026-08-23 run
> measured decontamination against 27 weather tags. The corrected corpus
> has 797, and `loadGames` filtered weather *unconditionally*, so the arm
> labelled "A, full, contaminated" had already had one contamination class
> silently removed.
>
> **The finding that matters is not about contamination at all.** It is
> that **the window sign test — the criterion that made FRV "exactly one
> window short of Tier 2" — is not a reproducible statistic at this
> corpus size.** Same-n controls with contamination *retained* produce
> 2/5, 3/5 and 4/5 on the same feature. "One window short" was never a
> precision the data supports.

## Why the previous run could not have answered the question

The three-arm design was right. The corpus it ran on was not.

`services/parameter-sweep.js:loadGames` filtered
`weather_contamination_reason IS NULL` with **no opt-out**, while
`includeMarketContaminated` existed for the market class. So arm A —
the arm whose whole job is to be the contaminated baseline — was already
weather-filtered.

With 27 weather tags in the database that was nearly harmless. The
corrected corpus has **797**, which means roughly **770 known-bad-weather
games sat in both arms**, invisible to the comparison. An arm that has had
one contamination class quietly removed cannot bound what exclusion costs.

```
                              2026-08-23 believed    corrected corpus
weather tags in the DB                27                    797
games excluded (same window)         128  (16.2%)           469  (57.3%)
```

`includeWeatherContaminated` now exists, mirroring the market option, and
`INCLUDE_CONTAMINATED=1` retains **both** classes in every harness.

## The corpus, stated honestly

Window `2026-06-01 .. 2026-08-07`, the same one the prior run used, so the
only thing that changes is the corpus.

```
A  FULL, both classes retained                818 scored
     market-contaminated (post-first-pitch)   137
     weather-contaminated (known-wrong)       379
     BOTH classes on the same game             47

B_all      both excluded        n=349   drops 57.3%   <- the production filter
B_market   post-first-pitch     n=681   drops 16.7%   <- what 08-23 thought it ran
B_weather  known-bad weather    n=439   drops 46.3%   <- the newly visible class
```

Four arms rather than three, because there are **two** contamination
classes and only one was ever measured. Each partial arm carries its own
n-matched control — a control built for one n does not bound another.

## 1. Market-vs-model and edge honesty

**Every metric, in every arm, lands inside its control. Nothing is
attributable to contamination.**

```
A (FULL, n=818)  vs  B_all (both excluded, n=349)
  metric               A          B          B-A        C control p5..p95      verdict
  model logLoss     +0.68969  +0.69444  +0.00475   [+0.68094, +0.69554]   POWER
  market logLoss    +0.68370  +0.68663  +0.00293   [+0.67240, +0.69496]   POWER
  base-rate logLoss +0.69264  +0.69314  +0.00050   [+0.68920, +0.69314]   POWER
  model - market    +0.00599  +0.00780  +0.00181   [+0.00184, +0.01377]   POWER
  model - base      -0.00295  +0.00129  +0.00425   [-0.00994, +0.00297]   POWER
  edge slope (ML)     -0.209    -0.534  -0.32414   [-0.60238, +0.27464]   POWER
```

`model - base` **changes sign** — the model goes from marginally better
than a constant to marginally worse. That is the most alarming-looking
movement in the whole re-run, and the control spans it comfortably.
Dropping 469 random games with the contamination left in produces
movements of that size routinely.

The two partial arms say the same thing, and they locate where the
movement comes from:

```
B_market  (n=681)   model - market +0.00506   edge slope -0.118   all POWER
B_weather (n=439)   model - market +0.00761   edge slope -0.506   all POWER
```

**The weather class drives essentially all of the edge-slope movement**
(−0.209 → −0.506 removing weather alone, versus −0.209 → −0.118 removing
market alone). That is the effect the 2026-08-23 run could not see, and
it is still not distinguishable from noise.

### Headline CIs

```
A FULL (n=818)      model-market +0.00599 [-0.00060, +0.01227]  not sig
                    model-base   -0.00295 [-0.00996, +0.00459]  not sig
                    edge slope   -0.209   [-0.922, +0.515]      excludes 1.0
B_all clean (n=349) model-market +0.00780 [-0.00373, +0.01942]  not sig
                    model-base   +0.00129 [-0.00896, +0.01511]  not sig
                    edge slope   -0.534   [-1.758, +0.671]      excludes 1.0
```

**What we believe the model is does not change.** Not demonstrably better
than a constant, not demonstrably worse than the market, claimed edge
still demonstrably dishonest.

### The extended window agrees

Re-run to `2026-08-23` (A=1036, B_all=488, 52.9% dropped): every metric
POWER again. One difference worth recording — with the extra 218 games,
**"the market beats the base rate" becomes significant on arm A** and does
not survive on B_all; the control holds it in only 4/20 same-n
contaminated subsamples. Same story, more data.

The edge slope on arm A is **−0.209 on the short window and +0.046 on the
extended one**. A statistic that changes sign on adding three weeks is
carrying no information at these sample sizes, whatever its CI says.

## 2. The gates

| feature | arm | Δ log loss | 95% CI | windows |
|---|---|---|---|---|
| **FRV** | A full (n=818) | −0.00107 | [−0.00227, +0.00030] | **4/5** |
| | **B clean (n=349)** | **−0.00112** | **[−0.00299, +0.00085]** | **3/5** |
| | C controls (n≈355) | −0.00047 … −0.00135 | | **2, 3, 3, 4, 4** |
| **park_neutral** | A full | −0.00051 | [−0.00119, +0.00011] | 4/5 |
| | **B clean** | **−0.00047** | **[−0.00121, +0.00029]** | **3/5** |
| | C controls | +0.00008 … −0.00099 | | **2, 2, 2, 2, 4** |
| **hand_conditional** | A full | +0.00006 | [−0.00047, +0.00053] | 2/5 |
| | **B clean** | **+0.00020** | **[−0.00062, +0.00102]** | **2/5** |
| | C controls | −0.00058 … +0.00042 | | **1, 1, 2, 3, 3** |

**All three verdicts unchanged. FRV do-not-enable, park_neutral
do-not-enable, hand_conditional Tier 4.**

FRV's bounded-harm criterion still passes: upper CI **+0.00085 < +0.001**.

### The window sign test does not survive its own control

FRV read **4/5** on 2026-08-23 and reads **3/5** now. Treated as a
finding, that says decontamination pushed FRV further from the bar.

It says no such thing. Five random n-matched subsamples of the
**contaminated** corpus, same n, produce **2/5, 3/5, 3/5, 4/5, 4/5**.
The clean corpus's 3/5 is the median of that spread.

park_neutral is worse: controls give **2, 2, 2, 2, 4** while the clean
corpus gives 3.

```
feature            A     B_clean   same-n controls (contamination RETAINED)
FRV               4/5      3/5      2, 3, 3, 4, 4
park_neutral      4/5      3/5      2, 2, 2, 2, 4
hand_conditional  2/5      2/5      1, 1, 2, 3, 3
```

**The Tier 2 window criterion (≥4/5, sign test p≤0.05) cannot discriminate
at n≈350.** A feature can read 2/5 or 4/5 on the same data depending
which 350 games it sees. "FRV is exactly one window short" was a precise
sentence about an imprecise quantity, and it has been repeated across
several documents.

This is not an argument for lowering the bar. It is an argument that **at
this corpus size the window count should not be reported as a near-miss**
— either the window is met on a corpus where the statistic is stable, or
the honest answer is "underpowered", and 4/5 versus 3/5 is not the
difference between them.

## 3. The sweeps

```
W_PIT_W_BAT (production 0.40)
  arm            lowest log loss     gap vs prod   values ruled out by CI
  B clean        0.40 = PRODUCTION      0.00000            0 of 8
  A full         0.30                   0.00012            2 of 8
  C seed 11      0.20                   0.00071            1 of 8
  C seed 37      0.30                   0.00003            0 of 8

BAT_HAND_SP_PAIRED / SP_WEIGHT (production 0.80)
  B clean        0.30                   0.00131            0 of 8
  A full         0.60                   0.00031            0 of 8
  C seed 11      0.90                   0.00031            0 of 8
  C seed 37      0.80 = PRODUCTION      0.00000            0 of 8
  C seed 71      0.90                   0.00003            0 of 8
```

**NONE clears all three gates, in any arm, on either sweep. Both verdicts
unchanged.**

And the same instability again, one level down: **the grid minimum wanders
across arms** — 0.20/0.30/0.40 for W_PIT, and 0.30/0.60/0.80/0.90 for
SP_WEIGHT. On the clean corpus production 0.40 *is* the minimum for
W_PIT; on a same-n contaminated control it is 0.20. **"The lowest value on
the grid" is not a reproducible quantity here either**, which is exactly
why the three-gate rule exists and why it is right that nothing passes it.

One movement worth recording rather than smoothing over: values ruled out
by the bootstrap CI went **2 → 1 → 0** across the three corpus versions.
That is monotone power loss, not rehabilitation of any value.

## 3b. The component diagnostic — the one flip, settled

This is where 2026-08-23's single verdict change came from, and the
corrected corpus settles it outright.

```
"market beats the base rate", out-of-sample, cross-fitted
  arm                       d vs base      95% CI                  beats base?
  A FULL      (n=817)        -0.00938   [-0.01884, -0.00019]     *** YES ***
  B clean     (n=349)        -0.01049   [-0.02454, +0.00679]         no
  C seed 11   (n=355)        -0.01182   [-0.02453, +0.00257]         no
  C seed 23   (n=352)        -0.01635   [-0.03092, +0.00002]         no
  C seed 37   (n=352)        -0.01224   [-0.02562, +0.00332]         no
```

**Zero of three same-n contaminated controls hold the claim.** It is
significant only on the full corpus and dies on every subsample of that
size, contaminated or not.

And the decisive detail: on the clean corpus the point estimate is
**−0.01049, larger in magnitude than arm A's −0.00938.** The market looks
*better* against the base rate after decontamination and still loses
significance, because the interval nearly doubles in width. **The effect
did not weaken; the measurement did.** That is what a power effect looks
like when you can see both halves.

Two other things flicker in and out across arms and should not be read as
findings:

- `pf (park factor)` is significantly **worse** than the base rate on
  B clean (`+0.00495 [+0.00142, +0.00836]`) — and `bat` does the same
  thing on control seed 23 (`+0.00360 [+0.00061, +0.00695]`), where
  nothing was excluded at all. Sporadic wrong-side significance at n≈350.
- `bat (lineup wOBA)` reads "consistent across all 5 folds" on arm A and
  "2/5 positive" on B clean.

`sp` and `bp` remain sign-consistent across all five folds in **every**
arm. Those two are the only component results that survive resampling,
and that is unchanged from before.

## 3c. CATCHER_FRAMING_MUTE, re-measured on framing that is not eleven weeks old

`catcher_framing` had not been refreshed since **2026-06-03**. The
2026-08-22 evaluation that kept production's `MUTE = 1.0` over the schema
default `0.65` was measured against that frozen table — and `MUTE` is a
**multiplier, not a switch**, so framing was being applied at full
strength off 82-day-old run values.

Re-run after refreshing the table (59 catchers, 2026-08-24):

```
                  logLoss     Brier      ECE      AUC    edgeSlope
  0.65 (schema)   0.69442   0.25058   0.0368   0.5366     -0.565
  1.00 (live)     0.69444   0.25059   0.0336   0.5374     -0.534

  d logLoss (1.0 - 0.65) = +0.00002   95% CI [-0.00061, +0.00067]
  2 / 5 windows.   mean |dp| 0.00239 over 349/349 games.
```

**The "better on all five metrics" claim does not reproduce.** On fresh
framing, 1.0 is better on ECE, AUC and edge slope, and **worse on log loss
and Brier** — three of five, not five of five.

It is still not significant in either direction (Δ = +0.00002 on a CI
spanning ±0.0006), so this is **not** a case for moving to 0.65. What it
removes is the *support* for having kept 1.0: that recommendation rested
on a clean five-metric sweep, and the sweep was of a stale input.

Confounded, and stated as such: n also fell from 790 to 349 between the
two runs, so freshness and power moved together. What can be said without
untangling them is that **the five-metric argument is gone and the honest
status is "indistinguishable"**.

**Recommendation unchanged in action, changed in justification:** leave
production at 1.0 because nothing argues for moving it, not because it was
shown better. The schema-default alignment recommended on 2026-08-22 still
stands — a default no deployment uses is a trap either way.

## 4. Summary — which verdicts change tier

| item | 2026-08-23 | 2026-08-24 corrected | tier change? |
|---|---|---|---|
| model − market | not sig | not sig | **no** |
| model − base | not sig | not sig (sign flips, inside control) | **no** |
| edge slope | excludes 1.0 | excludes 1.0 | **no** |
| FRV | 4/5, do not enable | 3/5, do not enable | **no** |
| park_neutral | 3/5 | 3/5 | **no** |
| hand_conditional | Tier 4 | Tier 4 | **no** |
| W_PIT sweep | prod unbeaten | prod unbeaten *and now the minimum* | **no** |
| SP_WEIGHT sweep | prod unbeaten | prod unbeaten | **no** |
| market beats base | flipped, power | not sig short window; sig on A extended, power | **no** |
| component: market vs base | flipped, power (5/20 control) | flipped, power (**0/3** controls hold) | **no** |
| CATCHER_FRAMING_MUTE 1.0 | better on 5/5 metrics | **better on 3/5**, Δ +0.00002 n/s | **no**, but the support is gone |

**Eleven comparisons, zero tier changes.**

The same bottom line as last time — but last time it rested on an arm A
that had been quietly cleaned, and on an exclusion believed to be a
quarter of its real size. Reaching the same answer on a corpus where the
exclusion is 57.3% and the baseline is genuinely contaminated is a much
stronger statement than reaching it on a corpus where the comparison could
not have detected the effect.

## 5. What actually changed, and it is not a verdict

1. **The window sign test is unreliable at n≈350** and has been quoted to
   one-window precision in at least four documents.
2. **The grid minimum in a sweep is unreliable at n≈350** and moves by
   0.4–0.6 of the parameter range across same-n resamples.
3. **The weather class, invisible until 2026-08-24, is the larger of the
   two contaminations** — 379 games versus 137 in this window, and it
   carries essentially all of the edge-slope movement.
4. **Excluding contamination now costs 57.3% of the corpus.** Everything
   downstream of the clean corpus is materially less powered than it was
   believed to be yesterday, and that is the real cost of the correction.

Point 4 is the one with consequences. A clean-corpus analysis on this
window now has **n=349**. The subset sign-flip rule
(`CLAUDE.md`, 2026-08-19) applies at that size, and several of this week's
conclusions live there.

## Method note

The n-matched control earned its keep twice over here. Without it:

- FRV 4/5 → 3/5 reads as decontamination hurting the feature;
- `model - base` changing sign reads as a real finding about the model;
- the W_PIT grid minimum moving from 0.30 to 0.40 reads as production
  being vindicated.

All three are what dropping to n≈350 does on its own. **Every one of them
would have been reported as a result.**

## Related

- `docs/decontaminated-rerun-2026-08-23.md` — annotated; superseded by this page.
- `docs/the-outage-that-was-not-2026-08-24.md` — why the corpus was wrong.
- `scripts/contamination-impact.js` — the four-arm harness.
- `services/parameter-sweep.js` — `includeWeatherContaminated`, the missing opt-out.
