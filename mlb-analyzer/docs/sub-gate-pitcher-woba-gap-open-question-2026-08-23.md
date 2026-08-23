# Sub-gate pitcher projections: is there a wOBA gap? — open question (2026-08-23)

> **Filed, not started. Standalone.**
>
> **This question does NOT inherit the rookie pricing hypothesis, which was
> refuted at power on 2026-08-23** (`docs/rookie-overrep-result-2026-08-23.md`).
> It asks something narrower that the refutation left untouched, and it
> carries no claim about signals, edges, or prices.

## The question, stated without the refuted chain

**For starting pitchers with no usable season actuals, does Steamer's
projected wOBA-against systematically differ from what they subsequently
allow — and in which direction?**

That is all. It is a question about a projection source, answerable
against outcomes, with no downstream claim attached.

### What it deliberately drops

The original ticket chained: rookies over-rated → team over-priced →
phantom edge → **signals fire disproportionately**. The terminal link was
tested first because it needed no effect-size resolution, and it came back
**0.993 with CI [0.888, 1.093]** against a 1.2× bar — a refutation at
power, not an underpowered null.

**So the chain is broken and must not be silently reassembled.** If this
question finds a gap, that gap is a fact about Steamer's priors. It is
**not** evidence that the model misprices those games, because the
mispricing consequence was looked for and is absent.

Anyone picking this up later: the temptation will be to read a positive
result here as reviving the pricing hypothesis. It does not. The pricing
hypothesis was tested on its own terms and failed.

## Why it is still worth asking

Three reasons that survive the refutation:

1. **It is a data-quality question about an input**, not a bet-selection
   question. If a projection source is biased for a population that
   starts ~12% of games, that is worth knowing regardless of whether it
   currently reaches a price.
2. **The cohort machinery already exists** —
   `scripts/build-rookie-cohorts.js` builds as-of-date cohorts with spring
   training excluded and career IP back-calculated. The expensive part is
   done.
3. **It bears on the ~300 BF cliff decision**, which still needs making.
   The cliff fix lost its *directional* justification when the hypothesis
   fell, but it retains an independent smoothness rationale
   (`model.js:320-325`: 100–130 BF SD 0.0537 falling to 450+ SD 0.0215).
   A measured projection gap would inform how much the sub-gate blend
   should move, without reinstating the pricing claim.

## Method, inherited from the prerequisite

- **As-of-each-game-date.** A pitcher who finished at 400 BF was below the
  gate for his first four starts and those starts belong in the cohort.
- **Spring training excluded** — `pitcher_game_log` carries 20.8% of rows
  before the regular season and March has more starts than any
  regular-season month. Accumulation is restricted to dates in `game_log`.
- **Career figures back-calculated**, since `pitcher_debut.career_ip` is
  as-of-fetch and includes 2026.
- **Cohorts and controls already defined**: `low_bf` (1a), `rookie` (1b),
  `vet_callup` (the discriminator between *no actuals* and *unestablished*),
  `established`.
- **Report median and sign-split alongside the mean** — wOBA-against
  residuals are right-skewed and a mean-only read shows tail skew as bias.

## What would need pre-registering

If this is run, the direction and rough magnitude go in **before** the
measurement, same as last time. Note that §PR predictions 1–3 already
state a version of this (positive gap, +0.010 to +0.025 wOBA, control
within ±0.005) — **those were written under the refuted framing** and
should be re-derived rather than inherited, because their motivation no
longer holds even though their arithmetic might.

## Not scheduled

No trigger, no window. This is filed because it is a real question with
the groundwork done, not because anything depends on it. The honest status
is: **nobody currently needs this answer.**

## Related

- `docs/rookie-overrep-result-2026-08-23.md` — the refutation this does not inherit.
- `docs/rookie-sp-prerequisite-2026-08-23.md` — the cohort machinery and its two traps.
- `services/model.js:320-325` — the measured pitcher shrinkage curve.
