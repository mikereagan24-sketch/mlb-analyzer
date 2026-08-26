# Rookie-cohort ROI and calibration: the result (2026-08-26)

> **Verdict: INCONCLUSIVE on the registered test, and the bar was not
> reachable.** The rookie-vs-rest ROI gap is **−3.60pp**, CI
> **[−22.89, +15.18]**. That is a ±19.0pp interval against a 15pp bar —
> **the bar sat inside the noise floor**, so neither confirmation nor
> refutation was available no matter what the data did. That is a defect
> in the pre-registration, and it is recorded as one in §5.
>
> **Calibration is flat and produces no tier change**, as pre-registered.
> Rookie Δ log loss **+0.00720**, CI **[−0.02247, +0.03786]** — spans zero.
>
> **Both control cohorts point the other way and refute a −15pp effect:**
> `low_bf` **+6.74pp** [−4.38, +17.91], `vet_callup` **+8.49pp**
> [−2.05, +19.24]. Both CIs span zero, so this is **not** evidence of a
> rookie *advantage* either. It is one directional claim ruled out, not a
> reverse claim established.

Prediction on record: `docs/rookie-roi-prediction-2026-08-26.md`, commit
**b52c101**, 2026-08-26T11:44:42-07:00. No figure below existed at that
commit.

## 1. LEG 1 — ROI over emitted signals (selection, not pricing)

949 graded, staked signals on the clean cohort-eligible corpus.

```
cohort        n     wagered     pnl     ROI       95% CI            GAP vs rest     verdict
rookie      128       12986    -756   -5.82pp   [-24.43, +12.44]   -3.60pp  [-22.89, +15.18]   INCONCLUSIVE
low_bf      432       44289    +456   +1.03pp   [ -8.84, +11.18]   +6.74pp  [ -4.38, +17.91]   REFUTED
vet_callup  356       36481    +971   +2.66pp   [ -7.54, +12.83]   +8.49pp  [ -2.05, +19.24]   REFUTED
```

"REFUTED" here means precisely what the pre-registration defined: **the
interval excludes −15pp**, so an effect of the registered size is ruled
out for those two cohorts. It does not mean the cohorts are good bets.
Both intervals contain zero.

**Mike's predicted direction is not supported and not refuted.** The
rookie point estimate is negative (−3.60pp), which is his direction, at
roughly a fifth of the size he'd need and well inside the noise. The two
larger cohorts move positive. Nothing here should be written up as "rookie
signals settle worse."

### Supplementary, not the registered test

The cohorts **nest**: "rest" for the rookie leg still contains `low_bf`
and `vet_callup` games. The disjoint contrast:

```
rookie n=128  -5.82pp   vs   established n=498  -4.59pp   GAP -1.24pp  [-20.31, +18.46]
```

The gap **shrinks to −1.24pp** once the comparison is against established
starters only, rather than against a "rest" that is half low-sample
pitchers. Both readings are inconclusive; the disjoint one is closer to
zero, which is the direction that matters if anyone later wants to argue
the −3.60pp was a signal.

### Composition, checked before reading the gap as settlement

```
          ML    Total
rookie    75      53      (58.6% ML)
rest     448     373      (54.6% ML)
```

Close enough that the type mix is not driving the gap. ML and Total do not
share a staking rule, so an imbalance here would have shown up as a ROI
difference with no settlement difference behind it. It isn't one.

### Park-factor regime, reported and not pooled

```
legacy_unsourced          rest     n=673   -1.61pp
legacy_unsourced          rookie   n=109   -4.65pp
unchanged_either_regime   rest     n=148   -4.92pp
unchanged_either_regime   rookie   n= 19  -12.55pp
```

**The −12.55pp cell is 19 signals.** It is printed because the
pre-registration said to report the split rather than pool it, not because
it means anything. At n=19 the interval on that number is wider than the
number. Do not quote it.

## 2. LEG 2 — calibration over all scored games (the pricing leg)

558 scored games.

```
cohort         n    logLoss    d vs rest    95% CI                  edge slope   95% CI
rookie        63    0.69562    +0.00720    [-0.02247, +0.03786]      -1.706     [-3.672, +0.653]
low_bf       207    0.68881    -0.00067    [-0.02010, +0.01846]      -0.915     [-2.539, +0.765]
vet_callup   164    0.68863    -0.00086    [-0.01947, +0.01712]      -0.579     [-2.551, +1.219]

reference: rest-of-corpus log loss 0.68842, edge slope +0.259
```

**No tier change, as pre-registered.** Every Δ log loss interval spans
zero, and the largest point estimate (+0.0072 on rookies) is an order of
magnitude below any gate this project has moved on.

**The rookie edge slope is −1.706 and should not be read as a finding.**
Its interval is [−3.672, +0.653]: it spans zero, and it spans the
rest-of-corpus value of +0.259. At n=63 with claimed edges capped at 8pp,
the regressor has almost no spread, and the slope is correspondingly
unstable. The honest statement is that rookie edge realisation is **not
distinguishable** from the rest of the corpus — not that it is negative.

Worth noting separately: the **rest-of-corpus slope is +0.259**, not near
1.0. Claimed edge is only weakly realised corpus-wide. That is a
pre-existing property of the model, not something this cohort split
discovered, and it is not what was being tested here.

## 3. ROI and calibration agree, so the disagreement rule does not fire

The pre-registration pre-committed the reading for a ROI gap with flat
calibration: **selection, not mispricing.** That branch is not needed.
Both legs are flat. There is nothing to arbitrate and nothing that
licenses a selection filter.

## 4. The calibration leg is far smaller than the pre-registration implied

This is the one number in §2 of the prediction doc that was misleading,
and it was mine:

```
game_log                                       1876
  model_total NOT NULL                         1861
  + weather_contamination_reason IS NULL       1069   (-792)
  + market_contamination_reason IS NULL         897   (-172)
  - 55 with no matched regular-season start (uncohorted)
  - 4 unscored, 4 with no market ML
  - 276 with no wOBA snapshot for the date        558

  of which rookie                                63
```

The pre-registration quoted **260 rookie games**. That was the *schedule*
share — the correct denominator for the over-representation test it was
borrowed from, and the wrong one for this. Contamination filtering removes
half the corpus, and `woba_data_snapshot` only begins **2026-05-20** (93 of
140 game dates), which removes another 276. The calibration leg therefore
ran at **63 rookie games, not 260** — under a quarter of the stated power.

The prediction (no tier change) survives this, because it was a prediction
of *no effect* and a smaller n makes that easier to fail to reject, not
harder. But a reader comparing §2 of the prediction to §2 of this document
would otherwise conclude the test was four times stronger than it was.

## 5. The bar was inside the noise floor, which is a pre-registration defect

The prediction doc estimated ROI intervals of **±15–20pp** and then set the
confirmation bar at **15pp**. The realised interval is **±19.0pp**.

That means:

- **CONFIRMATION was unreachable.** A 15pp gap with a ±19pp interval
  cannot have a CI excluding zero.
- **REFUTATION was unreachable for the rookie cohort** for the same reason
  — the lower bound could not clear −15pp.
- The only outcomes available on the rookie leg were INCONCLUSIVE, or a
  point estimate so extreme it would have signalled a data error.

Naming INCONCLUSIVE in advance as the likely outcome was right, and it is
why this document is not dressed up as a direction. But naming it is not
the same as fixing it. **The bar has to sit outside the estimated noise
floor, or the test has to be declared unresolvable before it runs.**

The two control cohorts did resolve, because n is 3× larger — which is the
constructive version of the same point: **at this corpus size, ROI
questions are answerable at n≈400 signals and not at n≈130.** Any future
ROI pre-registration in this project should either target a cohort of that
size or state up front that it is a descriptive run and not a test.

## 6. What this does and does not license

**Does:** closing the rookie-pricing line of inquiry on the evidence
available. Two independent tests — the 2026-08-23 over-representation test
(0.993, CI [0.888, 1.093], refuted at power) and the calibration leg here
(flat, no tier change) — both looked for a terminal consequence and found
none.

**Does not:** any claim about rookie settlement, in either direction. The
ROI leg did not resolve. It is not evidence of an effect and it is not
evidence of absence.

**Does not:** a selection filter. The pre-registration made that
conditional on a confirmed gap, and there isn't one.

## 7. Reproduce

```
node scripts/rookie-roi-and-calibration.js
```

Cohort assignment is not re-implemented in that script — it imports
`build()` and `gamesFromRows()` from `scripts/build-rookie-cohorts.js`, so
both consumers classify identically. The aggregation was extracted into
`gamesFromRows` in this change; stage-1 output is byte-identical to the
figures quoted in the pre-registration (919 / 260 / 779 / 1385).

## Related

- `docs/rookie-roi-prediction-2026-08-26.md` — the pre-registration (b52c101).
- `docs/sub-gate-pitcher-woba-gap-open-question-2026-08-23.md` — the first
  rookie prediction, refuted at power.
- `CLAUDE.md` — "ROI over emitted signals measures selection, not pricing".
