# Pre-registration: rookie-cohort ROI and calibration (2026-08-26)

> **Written and committed BEFORE any ROI or calibration figure was
> computed.** Cohort *sizes* were computed first — deliberately, because a
> confirmation bar that is not calibrated to the available n is not a bar,
> it is a coin flip with extra steps. Sizes are not outcomes.
>
> This is the project's **second** pre-registered prediction. The first was
> refuted at power.

## The reminder, because it was asked for

The last rookie-pitcher hunch **felt strong and was wrong.** On 2026-08-23
the over-representation prediction — rookie-SP games should fire signals
at ≥1.2× their schedule share — came back at **0.993, CI [0.888, 1.093]**.
Not underpowered. Refuted.

`docs/sub-gate-pitcher-woba-gap-open-question-2026-08-23.md` records the
consequence and it applies here verbatim:

> *"The temptation will be to read a positive result here as reviving the
> pricing hypothesis. It does not. The pricing hypothesis was tested on
> its own terms and failed."*

So: **a rookie ROI gap found today would not resurrect that chain.** ROI
over emitted signals measures *selection*, not pricing — the 2026-08-21
rule — and the terminal pricing consequence was already looked for and
found absent. What a gap would mean is narrower and is stated in §4.

## 1. The prediction

**Direction (Mike's, recorded as his):** rookie-cohort ROI is **worse**
than the rest of the corpus.

**My prior, recorded separately so the two are not conflated:** I expect
**no distinguishable difference**, because the mechanism that would
produce one was tested and refuted, and because ROI at this n has not
resolved anything smaller than ~20pp anywhere in this project.

## 2. The numeric bar, set from n and not from hope

Cohort sizes, computed before this document (games where at least one
starter is in the cohort, as-of-date, spring training excluded):

```
low_bf (1a)     919 games   50.9%
rookie (1b)     260 games   14.4%
vet_callup      779 games   43.1%
established    1385 games   76.6%
```

The rookie cohort is ~14% of games. Emitted-and-graded signals will be a
fraction of that — on the order of 150, and ROI confidence intervals at
n≈150 with to-win-$100 staking have run **±15–20pp** everywhere this
project has measured them.

**CONFIRMATION requires both:**

1. rookie-cohort ROI is **at least 15pp worse** than the rest; and
2. the **date-clustered bootstrap CI on the difference excludes zero**.

**REFUTATION:** the CI on the difference **excludes −15pp** — i.e. the
predicted effect can be ruled out at the size that would matter.

**INCONCLUSIVE** is everything between, and **it is the most likely
outcome.** Naming it in advance is the point: at n≈150 the test can fail
to confirm without having refuted anything, and that must not be written
up later as "no effect".

## 3. The calibration leg, which is the one that speaks to pricing

Reported alongside, on rookie-SP games versus the rest:

- **Δ log loss** with a date-clustered CI;
- **edge slope** (realised excess on claimed edge) with a CI;
- both against the standard tier gate.

**Pre-registered expectation:** no tier change. Same reason — the pricing
consequence was already refuted, and 260 games is below where any gate in
this project has resolved.

**If ROI and calibration disagree** — a ROI gap with flat calibration —
the reading is **selection**, not mispricing: the model is not pricing
rookie games worse, the cap and emit floor are selecting differently
within them. That is the 2026-08-21 rule and it is written here in
advance so it cannot be re-argued after the fact.

## 4. What a confirmed gap would and would not license

**Would:** a real finding about *which* rookie-cohort signals get emitted
and how they settle — actionable as a selection filter, testable on its
own terms.

**Would NOT:** revive the claim that Steamer over-rates rookies and the
model therefore misprices those games. That claim was tested at power and
failed. A selection effect is a different mechanism at a different stage.

## 5. Filters, fixed in advance

Same as any other calibration on this corpus:

- `weather_contamination_reason IS NULL`
- `market_contamination_reason IS NULL`
- **park-factor regime split reported, not pooled.** `park_factor_source`
  splits the corpus at 2026-08-25; the honest denominator is the
  `legacy_unsourced` rows (1,436 of 1,876), and `unchanged_either_regime`
  is unaffected. Reported per §doc, not averaged across the boundary.
- as-of-date cohort assignment, spring training excluded.
- Both cohort definitions run, `vet_callup` as the second control — it is
  what separates *no actuals* from *unestablished*.

## 6. Commitment

No ROI figure, no log loss, no edge slope has been computed at the time of
this commit. The cohort sizes in §2 are the only numbers seen, and they
are denominators.

If the result lands in the INCONCLUSIVE band, **that is what gets
reported** — not the point estimate dressed as a direction.

---

## ANNOTATION (2026-08-26, after the run) — do not edit the above

Result: `docs/rookie-roi-result-2026-08-26.md`.

**Outcome: INCONCLUSIVE on the rookie leg, as §2 said was most likely.**
Gap −3.60pp, CI [−22.89, +15.18]. `low_bf` and `vet_callup` both refuted a
−15pp effect. Calibration flat, no tier change, as §3 predicted.

**Two defects in this document, recorded here so it is not cited as a
clean pre-registration:**

1. **§2's bar was unresolvable.** It estimated ±15–20pp intervals and set
   the bar at 15pp. The realised interval was ±19.0pp, so neither verdict
   was reachable on the rookie leg regardless of the data. Now a standing
   rule in `CLAUDE.md`.

2. **§2's "260 games" is a schedule share, not the measurement n.** The
   calibration leg ran on **63** rookie games after contamination
   filtering and wOBA-snapshot availability. The stated power was ~4×
   the actual power.

Neither defect changes the verdicts — both predictions were of *no
distinguishable effect*, and that is what was found. They change how much
this run should be leaned on as evidence, which is less than §2 implies.
