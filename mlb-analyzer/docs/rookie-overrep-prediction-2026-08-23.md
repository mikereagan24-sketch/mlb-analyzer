# Pre-registered prediction: rookie-SP over-representation (2026-08-23)

> **Written before the signal share was computed.** Stage 1 of
> `scripts/build-rookie-cohorts.js` deliberately computes only the
> denominator and refuses to touch emitted signals; the `--signals` stage
> has not been run.
>
> This is committed **before** that run. If the numbers below are edited
> after it, the git history says so.

## The denominators — measured, and all I have seen

Cohorts built as-of-each-game-date, spring training excluded, career IP
back-calculated to the game date (`docs/rookie-sp-prerequisite-2026-08-23.md`).

```
regular-season starts on model dates : 3186
games with a matched start           : 1575   (of 1678 game_log games)

cohort          games   share of scheduled games
low_bf  (1a)      856   54.3%
rookie  (1b)      191   12.1%
vet_callup        748   47.5%
established      1168   74.2%
```

Shares exceed 100% because a game has two starters and they can fall in
different cohorts. Per-start: low_bf 39.9%, rookie 6.3%, vet_callup 34.4%.

**So X = 12.1% for the rookie cohort, 54.3% for low_bf.**

## The predictions

Consistent with §PR prediction 5 in the ticket (*"over-represented …
by a factor of 1.2×–2.0×"*), now made concrete against measured
denominators.

### Primary — rookie cohort (1b), the hypothesis proper

**Predicted: signals fire on meaningfully more than 12.1% of games.**

| | |
|---|---|
| null (no over-representation) | 12.1% |
| §PR range, 1.2×–2.0× | **14.5% – 24.2%** |
| point prediction | ~16% (ratio ≈ 1.3×) |

### Secondary — low_bf cohort (1a)

**Predicted: over-represented, but by LESS than the rookie cohort.**
Ratio predicted in **1.05×–1.3×** (57% – 71%).

The reasoning is the hypothesis itself: (1a) is contaminated with
experienced pitchers whose projections are anchored by career data, so if
the mechanism is "Steamer regresses the unestablished to a league-average
prior", (1a) should dilute it. **If (1a) over-represents as strongly as
(1b), the effect is about missing actuals, not about inexperience.**

### The discriminator — vet_callup control

**Predicted: ratio ≈ 1.0, within 1.05×.**

This is the measurement that separates *"no actuals"* from *"genuinely
unestablished"*. Veteran callups have no usable season actuals but a real
career prior, so if the mechanism is inexperience they should show **no**
over-representation.

**If vet_callup over-represents as much as rookie, the hypothesis as
framed is wrong** — the effect would be about the actuals gate, not about
rookies, and the cliff fix rather than a rookie prior would be the whole
answer.

## Confirmation threshold — decided now, not after

**CONFIRMED** requires **both**:

1. rookie signal share ≥ **14.5%** (ratio ≥ 1.2×), and
2. the ratio's 95% CI **excludes 1.0**.

**REFUTED** if any of:

- rookie ratio ≤ 1.0 (no over-representation, or under-representation);
- rookie ratio < 1.2× *with* a CI including 1.0 — a directional wobble
  that cannot be distinguished from chance;
- **vet_callup ratio ≥ rookie ratio** — the effect is the actuals gate,
  not inexperience, and prediction 4 of §PR fails.

**INCONCLUSIVE** if the rookie ratio exceeds 1.2× but its CI includes 1.0.
That is a real possible outcome at n=191 cohort games and must not be
written up as support.

### Why 1.2× and not something looser

At roughly 700 signal-games, the standard error on a 12.1% share is about
1.2pp, so 2 SE is ~2.5pp — which is 12.1% → 14.6%, i.e. **1.2× is
approximately the two-sigma line**. The §PR lower bound and the
statistical threshold coincide, which is why 1.2× is the bar rather than a
rounder number.

### Method fixed in advance

- Unit is the **game**, not the start, so a game is counted once no matter
  how many signals it produced.
- CI on the ratio by **date-clustered bootstrap** — same-slate games share
  market state and model version.
- **ROI is not used and is not needed.** This is a counting question, the
  same category as the edge cap: *which games got signals* is exactly what
  the hypothesis predicts, so selection is the effect rather than a
  confound. No pricing claim is made from it.

## Why this leg carries the weight

The calibration leg (§4) is expected to be underpowered — that is written
into the ticket. **This one is not**, because it needs no effect-size
resolution, only a share comparison on 1,575 games.

So the write-up must not let a null on calibration read as a null on the
hypothesis. **If this test confirms and calibration is inconclusive, the
hypothesis stands on this leg.** If this test refutes, calibration cannot
rescue it.

## Related

- `docs/rookie-low-sample-sp-open-question-2026-08-22.md` §PR — the original seven predictions, untouched.
- `docs/rookie-sp-prerequisite-2026-08-23.md` — how the cohorts were built.
- `scripts/build-rookie-cohorts.js` — stage 1 here; `--signals` is stage 2.
