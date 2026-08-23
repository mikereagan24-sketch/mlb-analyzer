# Over-representation result: REFUTED (2026-08-23)

> **Prediction committed `47dc062`, before the number was computed.
> Threshold: confirm at ratio ≥ 1.2× with a CI excluding 1.0; refute at
> ratio ≤ 1.0.**
>
> **Observed rookie ratio: 0.993, CI [0.888, 1.093].**
>
> **REFUTED.** And it is falsifier #3 from §PR firing exactly as written:
> *"no over-representation among emitted signals (ratio ≈ 1.0)"*.

## The result

```
cohort         sched%   signal%   ratio    95% CI            verdict
rookie          12.1%     12.0%    0.993   [0.888, 1.093]   spans 1.0
low_bf          54.3%     52.4%    0.965   [0.920, 1.013]   spans 1.0
vet_callup      47.5%     45.3%    0.953   [0.897, 1.009]   spans 1.0
established     74.2%     78.4%    1.057   [1.017, 1.107]   EXCLUDES 1.0
```

1,575 cohort-eligible games, 1,005 emitting at least one signal (63.8%).
Unit is the game; contaminated games excluded; CI by date-clustered
bootstrap — all fixed in advance.

**Rookie-SP games get signals at 12.0% against a 12.1% schedule share.
There is no over-representation. There is not even a directional hint.**

## This was not an underpowered null

That distinction is the whole reason this leg was run first.

The CI on the rookie ratio is **[0.888, 1.093]** — a width of about 0.2.
The confirmation bar was **1.2×**, which sits far outside the upper bound.
**A true 1.2× effect would have been detected comfortably.** The test had
the power to find what was predicted, looked, and found nothing.

Contrast this with the calibration leg, which the ticket flags as
expected-underpowered. A null there would have been uninformative. A null
here is a result.

## The one cohort that moves is the wrong one

**`established` is the only ratio whose CI excludes 1.0 — and it points
the other way**, at 1.057. Signals fire slightly *more* on games started
by established pitchers.

That is the opposite of the hypothesis's central claim. It is a small
effect and I am not building anything on it, but it is worth recording
that the only statistically distinguishable signal-composition effect in
the data runs against the prediction rather than for it.

## What is and is not refuted

**Refuted: the hypothesis as framed.** The chain was — rookies are
over-rated by a league-average prior → their team is over-priced →
phantom edge → **signals fire disproportionately on those games**. The
terminal, observable consequence is absent at good power. That is the
claim failing where it was most testable.

**Also refuted: §PR prediction 5** (1.2×–2.0× over-representation) and,
by the ticket's own instruction, this is not to be reinterpreted as
partial support.

**Not refuted, and worth keeping separate:**

- **§PR prediction 1**, the projected-vs-realized wOBA gap, has not been
  measured. It is possible for Steamer to systematically over-rate
  rookies *and* for that to produce no signal-composition skew — if, for
  instance, the over-rating is small relative to the emit floor, or is
  offset elsewhere in the price. But the hypothesis said the skew is the
  consequence, and the consequence is not there.
- **The ~300 BF cliff fix** retains its independent smoothness rationale
  (`model.js:320-325` measures the pitcher curve at 100-130 BF SD 0.0537
  rising to 450+ SD 0.0215). What it **loses** is the pre-registered
  directional prediction: §PR prediction 7 framed it as *the corrective
  if the hypothesis holds*, and the hypothesis does not hold in the way
  predicted. Per §PR, it now has to be judged as a plain Tier 3 mechanism
  change with no directional claim attached.

**And prediction 4's discriminator never got to matter.** vet_callup at
0.953 versus rookie at 0.993 is a distinction between two numbers that are
both indistinguishable from 1.0. There is nothing for it to separate.

## METHODOLOGICAL RECORD — the project's first pre-registered prediction, and it was refuted at power

Worth separating from the finding itself, because it is the more durable
result.

**Every prior finding in this project was either unfalsifiable or
underpowered.** The pattern is visible across the last two days:

| | |
|---|---|
| **ROI sweeps** | measured selection, not pricing — structurally incapable of answering the question asked of them (`sweep-selection-effect-2026-08-21`) |
| **Calibration A/Bs** | FRV, park_neutral, hand_conditional — all landed inside their own CIs; the tiered standard exists *because* nothing could clear significance |
| **The totals edge** | +10.66pp with a CI spanning zero; its one significant subset collapsed on re-measurement |
| **CLV vs vig** | net −0.45pp, interval spanning zero |
| **Mechanism hunts** | the totals selection effect survived four controls and decomposed into nothing measurable |

Not one of those could have come back "no". They came back *unresolved*,
and unresolved is what a study looks like when it cannot fail.

**This one could fail, and did.**

- The prediction was written **before** the number existed
  (`47dc062`), with a numeric bar (**≥1.2×**), an explicit refutation
  condition (**≤1.0**), and a stated **INCONCLUSIVE** outcome so that
  ambiguity had somewhere to go other than into the confirming column.
- The denominators were computed first and the script **refused to touch
  signals** until the prediction was committed.
- The test had **power**: CI width ~0.2 against a bar at 1.2×, so the
  predicted effect would have been detected.
- It came back **0.993** and the pre-written falsifier fired.

**That is the first time this project produced a result that could have
gone either way and went against the person who proposed it.**

### Why that matters more than the rookie question

A finding that cannot be refuted is not evidence, however carefully it is
measured — and most of this project's history is careful measurement of
things that could not be refuted. The fix is not more precision. It is
committing to a falsifiable claim, in advance, with the bar and the
failure condition written down.

**The cost was about two hours.** The prerequisite backfill, the cohort
build, and the two-stage script were the expensive parts, and they exist
now. The pre-registration itself was ten minutes of writing before running
a query that already worked.

**The practice to keep: pre-register before measuring, state the
refutation condition, and give ambiguity its own named outcome.** Applied
to a hypothesis that felt strong, it took a day to settle instead of a
season.

## Recommendation

**Stop the remaining measurements, or run them knowing what they can no
longer establish.**

The ticket's own sequencing argued this leg carries the weight precisely
because it needs no effect-size resolution. It refuted. Running the
projected-vs-realized gap now would answer a narrower question — *does
Steamer over-rate this population* — which is interesting but is no longer
evidence for the pricing consequence that motivated the ticket.

My recommendation is to record the refutation, keep the cliff fix as a
mechanism-only change if it is wanted at all, and **not** spend the
calibration leg on a hypothesis whose most diagnostic test has already
failed at power.

That is a recommendation, not a decision — the remaining measurements are
cheap and the projected-vs-realized number has standalone value.

## Related

- `docs/rookie-overrep-prediction-2026-08-23.md` — the prediction, committed before the run.
- `docs/rookie-low-sample-sp-open-question-2026-08-22.md` §PR — the seven predictions and three falsifiers, untouched.
- `docs/rookie-sp-prerequisite-2026-08-23.md` — cohort construction and its two traps.
- `scripts/build-rookie-cohorts.js` — stage 1 denominators, stage 2 signal share.
