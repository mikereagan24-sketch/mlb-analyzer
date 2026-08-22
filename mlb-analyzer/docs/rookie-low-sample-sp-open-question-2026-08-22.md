# Rookie / low-sample starting pitchers — open question (2026-08-22)

> **Status: filed, not started.** Scoped only — the numbers below are
> population counts and code references gathered to make the ticket
> actionable. No hypothesis test has been run.

## Hypothesis

For starting pitchers with no usable actuals (pure projection), Steamer
regresses toward a **league-average prior**. But the population that
actually gets MLB starts as rookies is **below** league average. If both
halves hold, the model systematically **over-rates** these pitchers.

**Compounding mechanism:** pure projection means there is no in-season
correction. A veteran's bad projection gets pulled toward reality as
actuals accumulate; a rookie below the gate never does — the gate is a
hard cliff, so the projection stands unchallenged for as long as they
are under it.

**Suspected consequence:** the model over-prices the rookie's team,
reads the difference from market as edge, and **signals fire
disproportionately on those games**.

This is a coherent chain and each link is separately testable. It is
also the first hypothesis on this repo that predicts *where* the model's
edge should be least honest, rather than predicting a level shift — that
makes it falsifiable in a way most of the parameter work is not.

## Test plan (as specified)

1. **Define the population** — starters with actuals below the `MIN_BF`
   gate, or below some career-IP threshold.
2. **Projected vs realized wOBA-against** for that group, with
   established pitchers as a control. Is there a systematic gap, and in
   which direction?
3. **Over-representation** — are these games over-represented among
   emitted signals relative to their share of the schedule?
4. **Calibration on the subset** — log loss and edge slope for
   rookie-SP games vs the rest. If claimed edge is less honest there,
   the mechanism is confirmed.
5. **The pitcher-side shrinkage cliff** — `db/schema.js:3310` was
   deferred pending a pitcher-specific constant, and this is the same
   population.

Sample will be thin, so **(3) model-impact and over-representation are
likely to be more conclusive than (4) calibration.** Noted and agreed —
plan the write-up so a null on (4) does not read as a null on the
hypothesis.

## Scoping findings — three things that change how this is run

### A. "Below the gate" is NOT "rookie", and the gap is large

```
distinct starters in pitcher_game_log       : 438
starters with season BF < 100 (the gate)    : 232   (53%)
```

More than half of all starters sit below `MIN_BF = 100` on season
totals. That population is **not** rookies — it is rookies plus spot
starters, openers, callups, post-injury returns, and mid-season
acquisitions. Steamer's prior behaves very differently for a 34-year-old
returning from the IL than for a debutant.

**Consequence:** definitions (1a) "below minBF" and (1b) "below a
career-IP threshold" will select substantially different groups, and the
hypothesis is specifically about (1b). Running only (1a) risks
confirming or refuting something the hypothesis does not claim. **Run
both, report both, and treat the veteran-callup subgroup as a second
control** — it isolates "no actuals" from "genuinely unestablished."

### B. Defining the cohort on season totals is look-ahead bias

The 232 count above is on **end-of-season** BF, which is exactly the
mistake to avoid. A pitcher who finishes with 400 BF was below the gate
for their first four starts, and those starts belong in the cohort.

**The population must be defined as-of-each-game-date** — BF accumulated
*before* that game — the same as-of discipline the per-date `woba_data_snapshot`
already enforces for batters. Using season totals would both shrink the
cohort and select on the outcome.

### C. Career data to define "rookie" does not exist locally

```
pitcher_game_log range: 2026-03-03 .. 2026-08-06   (18,586 rows)
```

Single season only. There is **no career IP or debut date in the DB**, so
definition (1b) needs an external source — statsapi `people/{id}` carries
`mlbDebutDate`, which is the cheapest route and needs one backfill pass
keyed on `pitcher_mlb_id` (present in `pitcher_game_log`).

**This is a prerequisite, not part of the analysis.** It should be a
separate, small, verifiable step before anything is measured.

## On item (5) — the pitcher cliff is already partly quantified

`services/model.js:320-325` records the measurement that deferred it:

```
BATTERS ONLY. The pitcher curve has the same shape shifted right and
has NOT flattened by 150 (100-130 BF SD 0.0537, 150-200 SD 0.0427,
200-300 SD 0.0364, 450+ SD 0.0215), so a pitcher floor would be
~300 BF, not 150. getPitcherWoba deliberately passes no floor and is
byte-identical everywhere.
```

So the shrinkage curve for pitchers is measured and the constant is
argued at **~300 BF**. What is missing is not the number but the
decision to apply it.

The hard cliff itself is at `db/schema.js:3310`:

```js
const minSample = (minBF != null) ? minBF : 100;
...
const useAct = actMatch && actMatch.woba && actMatch.sample_size >= minSample;
```

Binary. Below 100 BF the actuals contribute **nothing**; at 100 they
contribute in full.

**Important:** this ticket and the cliff fix point in *opposite*
directions and must not be conflated.

- The **cliff fix** would let sub-gate actuals contribute partially —
  moving these pitchers *away* from pure projection.
- **This hypothesis** says pure projection is biased for this group.

If the hypothesis holds, the cliff fix is not merely a smoothness
improvement — it is the **corrective**, and its expected sign is
predicted in advance rather than fitted. That would be the first change
in this repo with a pre-registered directional prediction, which is
worth considerably more than another A/B that lands inside its own CI.

**Sequence accordingly: measure (2) before shipping the cliff fix**, so
the prediction is on record first.

## Method constraints carried from prior work

- **Use the corrected calibration harness.** Every A/B before 2026-08-22
  scored with catcher framing silently absent
  (`docs/three-targets-hfa-cap-framing-2026-08-22.md` §4). Item (4) must
  run post-fix or its numbers are not comparable to anything.
- **Item (3) is a counting question, and ROI is legitimate for it** —
  over-representation among emitted signals *is* a selection effect, and
  selection is what the hypothesis predicts. This is the same
  distinction that applied to the edge cap. Item (2) and (4) are
  calibration questions and ROI is invalid for them.
- **Subsets this size flip sign.** `feedback_subset_sign_flip` and the
  8pp cap analysis both showed n≈25–130 subsets inverting a full-sample
  direction. Any directional claim from the rookie subset must be
  re-stated against the unconditioned population before it is believed.
- **Report median and sign-split alongside mean** for the
  projected-vs-realized gap — wOBA-against residuals are right-skewed
  and a mean-only read will show tail skew as bias.

## Open sub-questions

- Does Steamer's rookie prior differ by role — does it regress a
  projected *starter* differently from a projected reliever moved into
  starts? The `pitcher_fg_role` / `outing_type` columns may separate
  these.
- Openers are structurally low-BF and already have their own weight path
  (`OPENER_PIT_WEIGHT` 0.15). They may need excluding from the cohort
  rather than counting as rookies.
- If the gap is real, is the right fix the cliff (partial actuals), a
  rookie-specific prior shift, or a wider `UNKNOWN_PITCHER_WOBA`-style
  default? Do not choose before (2) reports.

## Related

- `services/model.js:320-325` — the deferred pitcher-floor measurement.
- `db/schema.js:3310` — the hard cliff.
- `docs/woba-minpa-shrinkage-cliff-2026-08-21.md` — the batter-side fix this mirrors.
- `docs/three-targets-hfa-cap-framing-2026-08-22.md` §4 — harness constraint for item (4).
- `docs/sweep-selection-effect-2026-08-21.md` — why item (3) may use ROI and items (2)/(4) may not.
