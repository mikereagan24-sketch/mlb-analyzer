# Unsealed-closed wind multiplier — open question (2026-08-20)

**Status:** logged, not planned. Wind stays at ×0 for every closed
game, canopy or not. **Do not put a hand-picked number in
`weather.js:roofChannelMults` without reading this first.**

The 2026-08-20 per-channel roof gate
(`docs/sea-canopy-roof-scope-2026-08-20.md`) split the roof gate into a
wind channel and a temp channel, because a canopy roof does different
things to each. The temp channel was resolved by measurement. The wind
channel was not, and this doc records why — specifically so the
question isn't reopened by someone who assumes it just needs more data.

## The question

T-Mobile Park's roof covers the field but the park stays open at the
sides. Physically, a closed canopy should reduce field-level wind
without eliminating it. So the true `windMult` for an unsealed-closed
game is plausibly somewhere in `(0, 1)`. What is it?

## What was measured

50 closed SEA games spanning 2023-2026 (plus 255 open games as
control), each paired with ERA5 outdoor reanalysis at the same
park-local hour via the production fetcher (`fetchWindAtCoords`,
`archive: true`), so both sources use identical hour indexing and
direction conventions. This was run specifically to clear the n≈25-30
threshold the subset sign-flip rule implies.

**It cleared the threshold and still produced no answer.** The problem
turned out not to be sample size.

### Finding 1 — 70% of the closed-game readings are nulls, not zeros

statsapi reports `0 mph` on **35 of 50** closed SEA games. On those same
35 games ERA5 shows a **median 8.1 mph** outdoors at the same hour
(p90 14.1, max 17.2). Only **7 of 35** had outdoor wind under 3 mph.

So 28 of the 35 "zero" readings sit on days with meaningful outdoor
wind. The zero is the field not being populated under a closed roof,
not a measurement of a becalmed field.

By direction string:

| string | n | ERA5 ≥3 mph (ambiguous) | ERA5 <3 mph (plausible calm) |
|---|---|---|---|
| `0 mph, Calm` | 23 | 19 | 4 |
| `0 mph, None` | 12 | 9 | 3 |
| **total** | **35** | **28** | **7** |

`Calm` is no more trustworthy than `None` — both are dominated by games
that were not calm outdoors. And the vocabulary contains internally
inconsistent strings (`10 mph, Calm`; 3 such on closed games, 9 on
open), confirming speed and direction are populated independently and
unreliably.

For contrast, statsapi reports 0 mph on only **8% of open** SEA games.

### Finding 2 — the non-null readings show no roof effect at all

The 15 closed games that *do* carry a non-zero reading, ratio of
statsapi wind to ERA5 outdoor wind:

| | p10 | p25 | p50 | p75 | p90 | min | max |
|---|---|---|---|---|---|---|---|
| **closed** (n=15) | 0.32 | 0.62 | **0.75** | 1.01 | 1.48 | 0.31 | 2.27 |
| **open** (n=234) | 0.28 | 0.59 | **0.89** | 1.20 | 1.67 | 0.09 | 10.00 |

Permutation test on the difference in median ratio, 20,000
relabelings, deterministic seed: observed difference 0.136,
**p = 0.339. Not significant.**

If the roof attenuated wind, the closed non-zero readings should sit
systematically below the open ones. They don't — the distributions
overlap almost entirely, and one closed game reports *more* wind than
ERA5 says was blowing outdoors (ratio 2.27).

## Why this is unresolvable, not just underpowered

The two subsets tell contradictory stories:

- the 35 zeros say `windMult = 0`
- the 15 non-zeros say `windMult ≈ 0.85` — i.e. indistinguishable from
  open air, no roof effect

And which subset a game lands in is **unrelated to conditions**: 28 of
35 zeros occurred with real outdoor wind. The split is a data-entry
artifact of the reporting pipeline, not physics.

Any multiplier fitted from this data is really a choice about how many
of the 35 nulls you decide to read as true zeros. Pooling everything
gives a median ratio of 0.00 (the zeros dominate); dropping the nulls
gives 0.75; there is no principled basis to prefer either, and the
difference spans essentially the whole legal range.

More seasons will not help. Adding 50 more closed games adds ~35 more
nulls and ~15 more non-informative non-zeros in the same proportion.

## Why ×0 was kept rather than something else

Not because 0 was measured — it wasn't. Because:

1. It is the pre-existing behavior for every closed game, so keeping it
   makes the shipped change provably scoped to the temp channel (the
   verification harness asserts `wind_factor` changes in 0 of 7,680
   synthetic combinations and 0 of 1,518 DB rows).
2. Substituting any value in `(0, 1)` would be inventing a number and
   dressing it as a measurement — the failure mode the skewed-residual
   and subset sign-flip rules exist to prevent.
3. `calcWindFactor` already has an 8 mph deadband, so for a large share
   of closed SEA games any multiplier under ~1 lands on zero regardless.

## What would move this to actionable

A wind source that actually measures the field, rather than being
reported into a form field. Candidates, none currently available:

1. **Statcast / Hawk-Eye environmental data**, if it exposes in-park
   wind for closed-roof games. This is the only realistic path to a
   genuine measurement.
2. **Batted-ball carry residuals** at closed SEA games versus open ones
   with matched ERA5 conditions — infers the multiplier from outcomes
   rather than instruments. n=50 across 4 seasons is far too thin for
   a ±0.5-run-resolution effect; the 2026-08-19 pooled sens fit
   established the aggregate wind response isn't distinguishable from
   zero at current sample sizes, so a *sub*-effect of it is hopeless.
3. **A venue statement** on roof-closed airflow. Not data, but would at
   least justify a defensible-by-construction value.

Until one of those exists, this is a mechanism question with no
instrument, and the honest treatment is the status quo plus this note.

## Related

- `docs/sea-canopy-roof-scope-2026-08-20.md` — parent scoping doc.
- `docs/wind-deadband-cliff-open-question-2026-08-19.md` — the 8 mph
  deadband, and the power constraint that also blocks this.
- `services/weather.js:roofChannelMults` — where the number would go.
- `tmp/verify-per-channel-roof-gate.js` — asserts the wind channel is
  untouched.
