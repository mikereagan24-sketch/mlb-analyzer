# Rookie / low-sample starting pitchers — open question (2026-08-22)

> **Status: APPROVED AS SCOPED 2026-08-22. Not started.** The numbers
> below are population counts and code references. No hypothesis test has
> been run.
>
> **Execution order is fixed:** the `mlbDebutDate` backfill (§P) is a hard
> prerequisite — nothing else begins until it lands. Then both cohort
> definitions, as-of-date, with the veteran-callup control. The
> pre-registered prediction in §PR is timestamped and must not be edited
> after measurement begins.
>
> **Item (5) is part of this ticket, not a separate one.** Same
> population, and the decision is the deliverable.

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

## §P. Prerequisite — `mlbDebutDate` backfill (blocks everything)

**Nothing in the test plan starts until this lands.** Definition (1b)
does not exist without it, and (1a)-only would answer a question the
hypothesis does not ask.

Scope:

- Source: statsapi `people/{id}` → `mlbDebutDate`.
- Key: `pitcher_mlb_id`, already present on `pitcher_game_log`.
- Volume: 438 distinct starters — a single pass, not a rolling job.
- Storage: new table `pitcher_debut` (`pitcher_mlb_id` PK, `mlb_debut_date`,
  `fetched_at`), not a column on `pitcher_game_log`, which is per-appearance.
- Also capture career IP if statsapi returns it cheaply in the same call;
  if it needs a second endpoint, debut date alone is enough to define
  rookie status and career-IP can be a later refinement.

Acceptance: coverage reported as `n_with_debut / 438`, and the misses
**enumerated rather than summarised** — a systematic miss (e.g. every
2026-debut pitcher) would bias the cohort in exactly the direction the
hypothesis predicts, which is the one failure mode that could manufacture
a false positive.

**This is a data step. It must not be bundled with any measurement.**

## §PR. Pre-registered prediction — written 2026-08-22, before any measurement

Recorded now, timestamped, so it cannot be adjusted to fit the result.
This is the point of the exercise: if the cliff fix ships afterwards, it
ships against a prediction made in advance rather than a rationale fitted
in hindsight.

**Predictions, in the order they will be tested:**

1. **Direction (item 2).** For the no-actuals rookie cohort, realized
   wOBA-against will be **HIGHER (worse) than projected** — the model
   over-rates them. Gap = realized − projected, predicted **positive**.
2. **Rough magnitude (item 2).** Order **+0.010 to +0.025 wOBA** for the
   rookie cohort. Stated as a range because it is a prior, not an
   estimate: it is the scale of the difference between a league-average
   prior and the talent level of pitchers who need a rookie to start.
   **A gap under +0.005 should be read as the hypothesis failing**, not
   as weak support.
3. **Control (item 2).** Established starters: gap near zero,
   **within ±0.005**. If the control shows a comparable positive gap,
   the finding is a global projection bias and **not** about rookies —
   that would refute the specific hypothesis even while showing a real
   problem.
4. **Veteran-callup subgroup.** Predicted to sit **between** the two,
   nearer the control. This subgroup is what separates "no actuals" from
   "genuinely unestablished"; if it matches the rookie cohort, the
   mechanism is sample-size, not inexperience, and the cliff fix — not a
   rookie prior — is the whole answer.
5. **Over-representation (item 3).** Rookie-SP games predicted
   **over-represented among emitted signals** relative to schedule share,
   by a factor of **1.2×–2.0×**. Direction is the claim; the factor is a
   rough prior.
6. **Calibration (item 4).** Rookie-SP subset predicted **worse** on log
   loss and **less honest** on edge slope than the rest. Expected to be
   the weakest of the tests — see the thin-sample caveat.
7. **The cliff fix (item 5).** Letting sub-gate actuals contribute
   partially is predicted to **improve** pooled log loss by
   **−0.0003 to −0.0015**, i.e. comparable to FRV's −0.00092. It is
   bounded well below that by the affected share of games: it only moves
   games with a sub-gate starter.

**Falsifiers, stated in advance.** Any of these refutes the hypothesis as
framed, and none is to be reinterpreted as partial support:

- rookie-cohort gap ≤ +0.005, or negative;
- control gap statistically indistinguishable from the rookie gap;
- no over-representation among emitted signals (ratio ≈ 1.0).

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
the prediction is on record first. §PR is that record.

### The ~300 BF decision belongs to this ticket

Folded in rather than split out: it is the same population, and splitting
it is how the constant ended up deferred in the first place. The
measurement at `model.js:320-325` is done and the number is argued. What
is missing is a decision, and a decision with no owner is what this repo
has just spent a week cataloguing.

**Deliverable for item (5) is therefore the change itself, not another
measurement**, conditional on §PR prediction 1 holding:

- pitcher-side smoothstep mirroring the batter fix
  (`docs/woba-minpa-shrinkage-cliff-2026-08-21.md`), floor at
  **~300 BF** per the measured curve;
- byte-identical above the floor, asserted on replay, same discipline as
  the batter fix;
- shipped as **Tier 3** — mechanism pre-registered in §PR, point estimate
  not worse, bounded harm, blast radius reported.

If §PR prediction 1 fails, the cliff fix still has an independent
smoothness rationale but **loses its predicted direction**, and should
then be judged on its own as a Tier 3 mechanism change with no
directional claim attached.

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
