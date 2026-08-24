# Re-run on the decontaminated corpus (2026-08-23)

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


> **One verdict changed, and it changed for the wrong reason.**
>
> Everything was re-run with the 128 post-first-pitch-priced games
> excluded. **No tier moved.** The single flip — "the market beats the
> base rate" going from significant to not — is a **power effect**, not a
> contamination effect, and the control that proves it is below.

## The method: three arms, not before/after

Excluding 16.2% of games widens every interval regardless of *which*
games are excluded. A before/after comparison cannot tell "the finding
was propped up by contaminated rows" from "the finding was never robust
to n". So every comparison here runs three arms:

| arm | n | what it is |
|---|---|---|
| **A** | 790 | full corpus — contaminated, the original |
| **B** | 662 | clean corpus — contamination excluded |
| **C** | 662 × 20 seeds | **random** n-matched subsamples of A, contamination **retained** |

**C is the null distribution for "what does merely dropping to n=662
do".** If B lands inside C's p5..p95, the movement is power. Outside, it
is contamination.

One scoring pass: a game's prediction does not depend on which arm it
sits in, so the corpus is scored once and each arm is a re-slice. That is
what makes a 20-seed control affordable.

## 1. Market-vs-model and edge honesty — priority one

```
metric                A          B          B-A        C control p5..p95      verdict
model logLoss       0.68944    0.69122    +0.00178   [0.68707, 0.69273]   POWER
market logLoss      0.68310    0.68613    +0.00303   [0.68096, 0.68937]   POWER
base-rate logLoss   0.69261    0.69278    +0.00017   [0.69198, 0.69307]   POWER
model - market     +0.00634   +0.00509    -0.00125   [+0.00268, +0.00868] POWER
model - base       -0.00317   -0.00156    +0.00161   [-0.00548, +0.00015] POWER
edge slope (ML)      -0.243     -0.120    +0.12279   [-0.500, +0.208]     POWER
```

**Every metric lands inside the control.** Not one movement is
attributable to the contamination.

The edge slope is the instructive case. It moved **−0.243 → −0.120**, a
halving, which looks like a major finding — and it is comfortably inside
a control spanning −0.500 to +0.208. Dropping 128 random games moves that
statistic by more than the decontamination did. Reported as a
contamination effect it would have been wrong.

### Headline comparisons, both corpora

```
A contaminated (n=790)
  model - market : +0.00634  [-0.00028, +0.01284]   not significant
  model - base   : -0.00317  [-0.01032, +0.00456]   not significant
  edge slope     : -0.243    [-0.951,   +0.522]     excludes 1.0 (dishonest)

B clean (n=662)
  model - market : +0.00509  [-0.00250, +0.01269]   not significant
  model - base   : -0.00156  [-0.00942, +0.00761]   not significant
  edge slope     : -0.120    [-0.979,   +0.793]     excludes 1.0 (dishonest)
```

**The gap did narrow in the predicted direction** — removing games where
the market "knew" the result made the market look less sharp, so
`model - market` fell from +0.00634 to +0.00509. That is the effect you
anticipated, and it is real in sign. It is simply **not distinguishable
from noise**: the control says a random 128-game drop produces movements
of that size routinely.

**What we think the model is does not change.** It remains not
demonstrably better than a constant, not demonstrably worse than the
market on this window, and its claimed edge remains demonstrably
dishonest (CI excludes 1.0 on both corpora).

## 2. FRV — an unresolved gate candidate

| | contaminated | clean |
|---|---|---|
| Δ log loss | −0.00092 | **−0.00088** |
| 95% CI | [−0.00215, +0.00059] | **[−0.00221, +0.00079]** |
| windows | **4 / 5** | **4 / 5** |
| edge slope OFF→ON | −0.243 → −0.153 | −0.120 → −0.030 |

**Verdict unchanged: does not clear Tier 2. Do not enable.**

> *Softened 2026-08-24: this read "one window short". The window sign test is not precise to one window at n~350 -- same-n resamples of the same corpus give 2/5, 3/5 and 4/5 on this feature -- so the count is a pass/fail, not a distance. See CLAUDE.md "The window sign test is not precise at n~350".*

The delta is essentially identical (−0.00092 → −0.00088) while the CI
widened by 0.0002 on the upper side — textbook power, not a change in the
effect. Bounded harm still passes (+0.00079 < +0.001), and the sign
pattern is identical window by window, with W1 still the lone dissenter.

## 3. park_neutral, hand_conditional

| feature | | contaminated | clean | tier |
|---|---|---|---|---|
| park_neutral | Δ | −0.00051 | **−0.00053** | unchanged |
| | CI | [−0.00113, +0.00015] | [−0.00124, +0.00019] | |
| | windows | 3 / 5 | **3 / 5** | |
| hand_conditional | Δ | +0.00011 | **+0.00010** | **Tier 4** unchanged |
| | CI | [−0.00036, +0.00061] | [−0.00041, +0.00059] | |
| | windows | 2 / 5 | **2 / 5** | |

Both deltas stable to the fifth decimal; both window counts identical.
hand_conditional remains worse on four metrics and better on ECE.

## 4. The sweeps

**W_PIT/W_BAT** — production 0.40, lowest log loss at 0.30, gap
**0.00005** (was 0.00026). Verdict unchanged: *no value clears all three
gates, none better than production.*

One weakening worth recording: values ruled out by the bootstrap CI went
from **2 → 1**. On the contaminated corpus both 0.80 and 0.90 had CIs
excluding zero; on the clean corpus only 0.90 does (0.80 is now
[−0.00030, +0.01311]). **That is a loss of power, not a rehabilitation of
0.80** — the point estimate is unchanged at +0.00595 and still the second
worst on the grid.

Also: production 0.40 no longer holds the best ECE (0.0142 vs 0.30's
0.0108). That was a supporting observation, not load-bearing, and it does
not survive decontamination. Recorded rather than quietly dropped.

**SP_WEIGHT (via `BAT_HAND_SP_PAIRED`)** — production 0.80, lowest at
0.50, gap **0.00049** (was 0.00030). Grid span 0.00097 (was 0.00117). No
CI excludes zero, no fold set same-sign. Verdict unchanged.

## 5. The one flip — and why it is power

`component-signal-diagnostic` on the clean corpus:

```
predictor              logLoss    d vs base    95% CI                 beats base?
market (ceiling)      0.68614    -0.00781   [-0.01844, +0.00426]     no
```

On the contaminated corpus this read `-0.01011  [-0.01863, -0.00015]
*** YES ***`. **The market was the only predictor that beat the base
rate, and now it does not.**

Before treating that as a finding, two checks:

**(a) Significance retention under the n-matched control.** In the 20
control subsamples — same n=662, contamination **retained** — how often
does each claim survive?

```
claim                     A(n=790)    B(n=662)    control holds at same n
market beats base rate    not sig     not sig     5 / 20
model beats base rate     not sig     not sig     0 / 20
model worse than market   not sig     not sig     4 / 20
```

**"Market beats base rate" survives in only 5 of 20 same-n contaminated
subsamples.** A claim that dies three times out of four purely from
dropping to n=662 was never robust to n. Losing it on the clean corpus is
what that fragility looks like, not evidence the contamination was
holding it up.

**(b) A second estimator disagrees with the original on both corpora.**
The table above uses an in-sample date-clustered bootstrap; the component
diagnostic uses a cross-fitted out-of-sample estimator. Mine finds
`market beats base rate` **not significant on A either** — so the two
methods disagree about the contaminated corpus, and the flip is at least
partly an artefact of which estimator is asked.

**Conclusion: report the flip, do not act on it.** The honest statement
is that "the market beats a constant" was always marginal on this window
and this corpus size, and it is now on the wrong side of the line. It is
not a new fact about the market.

## 6. Summary

| item | verdict change? | why |
|---|---|---|
| model − market | no | narrowed as predicted, inside control |
| model − base | no | inside control |
| edge slope | no | halved, but well inside control |
| **FRV** | **no** | fails the window test on both; CI widened only |
| park_neutral | no | 3/5 both |
| hand_conditional | no | 2/5 both, Tier 4 |
| W_PIT sweep | no | prod still unbeaten; 1 fewer value ruled out (power) |
| SP_WEIGHT sweep | no | prod still unbeaten |
| **market beats base** | **YES — but power** | control holds 5/20 at same n |

**Nine comparisons, one flip, and the flip is power.** The
decontamination was correct to do and changed nothing about what we
believe.

That is a useful result in itself: it means the reframing findings —
selection-vs-pricing, the edge-honesty ceiling, the weak-but-sound
component picture — were not artefacts of post-first-pitch prices.

## Method note

The n-matched control is the reusable part. Any future analysis that
excludes a subpopulation should carry one: without it, "the CI widened
after I removed rows" is indistinguishable from a finding, and the
temptation is always to read it as one.

## Related

- `docs/post-start-pricing-tagged-2026-08-22.md` — what was excluded and why.
- `scripts/contamination-impact.js` — the three-arm harness and the retention control.
- Prior docs carry an annotation banner pointing here; their original figures are left intact.
