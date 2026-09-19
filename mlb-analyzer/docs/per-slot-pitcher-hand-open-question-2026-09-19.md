# Open question: the model uses ONE pitcher hand per game, so the bulk's handedness never reaches a platoon split (2026-09-19)

**Status: registered as an UNMEASURED CANDIDATE. Not scheduled, not
built, not flagged.** The decision on 2026-09-19 was explicitly *not*
to build it dark in order to find out whether it is measurable. The
power arithmetic below is recorded so that decision can be revisited
against a pooled multi-season corpus without re-deriving it.

Distinct from `docs/bulk-hand-measured-inert-2026-09-19.md`, which
closed the *column-wiring* question (0 of 222 sides move). This is the
gap that survived it.

## What the model does now

`services/model.js:perBatterEW` (~:597) takes a **single**
`pitcherHand` for the entire game:

```js
const eff = effHand(batter.hand, pitcherHand);          // switch hitters
...
const vsStart = pitcherHand === 'R' ? batter.vsRHP : batter.vsLHP;
const vsOpp   = pitcherHand === 'R' ? batter.vsLHP : batter.vsRHP;
// batW = vsStart * SP_WEIGHT + vsOpp * RELIEF_WEIGHT
```

`runModel` fills it with the opposing SP's hand — on an opener game,
the **opener's**. The bulk pitcher enters only through
`bulkVsL`/`bulkVsR`, which are indexed by the *batter's* effective
hand, itself computed from the opener. So there is no per-slot hand
anywhere in the batter model.

Live settings at filing: `sp_weight = 0.8`,
`use_hand_conditional_sp_weight = false` (so `sp_weight_l = 0.649` /
`sp_weight_r = 0.865` are dark). The `vsStart`/`vsOpp` selection above
runs regardless of that flag.

**Consequence.** On an opener game the bulk throws the majority of
innings (design weight ~0.60 against the opener's ~0.15), while 80% of
every batter's weight sits on their split against the *opener's* hand.
When the two hands differ, the platoon channel is pointed the wrong way
for most of the game.

## How often that happens

Analysis copy, all opener sides with both hands resolvable:

```
opener sides with a named bulk + both hands known : 217   (5 unresolved)
  opener hand == bulk hand                        :  68
  opener hand != bulk hand                        : 149   (68.7%)
      L -> R  106
      R -> L   43
  of the mismatched, PLAYED / scorable            : 146

switch hitters in opposing lineups : 207 / 1953 slots (10.6%)
mismatched sides facing >= 1 switch hitter :  96

played games with >= 1 mismatched side : 144  (2 with both sides)
```

Frequency is high. **Magnitude is unmeasured** — that is the whole
point of this ticket, and nothing below should be read as an estimate
of the effect.

## The power arithmetic

Paired design: the same games scored twice under two configurations.
Per CLAUDE.md §"FIRST decide which DESIGN you are measuring", the
between-cohort floor from `resolution-floor.js --calibration` (~0.020)
**does not apply** and would overstate the difficulty by roughly 30x.
The correct template is `scripts/park-neutral-paired-floor.js`, run
2026-09-19:

```
games scored both ways : 1171
games the flag MOVED   : 1036  (88.5%)
sd(per-game paired d log loss) : 0.010770
date clustering: ICC -0.0142 over 110 dates -> design effect 1.000
RESOLVABLE at n=1171 : +/-0.000617   (95% CI half-width)
```

Translating to this treatment. Untreated games contribute exactly zero
to a paired delta, so they add no variance but dilute the corpus-wide
mean. With per-treated-game dispersion `s_t` and treated fraction `p`:

```
half-width  =  1.96 * s_t * sqrt(p) / sqrt(n)
```

Back-deriving `s_t` from the template (`0.010770 / sqrt(0.885) =
0.011449`) and reusing it at `p = 144/1171 = 0.123`:

| quantity | value |
|---|---|
| treated games | **144** (≈12.3% of the 1171-game scorable corpus) |
| corpus-wide resolvable Δ log loss | **≈ ±0.00023** |
| equivalent **per-treated-game** effect | **≈ ±0.0019** |

Sanity check on the formula: `1.96 * 0.010770 / sqrt(1171) = 0.000617`,
reproducing the template's own line exactly.

### Two things this arithmetic is not

1. **It is an extrapolation, not a measurement.** `s_t` is borrowed
   from the park-neutral flag. The dispersion of *this* treatment has
   never been observed, and cannot be without building the arm.
2. **The borrowed dispersion is likely CONSERVATIVE**, i.e. the real
   bar is probably easier to clear than ±0.0019. Flipping which platoon
   split carries 80% of a batter's weight across ~60% of a game's
   innings is a larger input move than a park-factor tick (4 of 29
   parks moved by 0.02 in the 2026-09-18 refresh A/B). A larger `s_t`
   raises the numerator but the effect it is measuring rises with it;
   historically on this repo the per-game effect has scaled faster than
   its own dispersion. Treat ±0.0019 as an upper bound on the bar, not
   a point estimate of it.

## Why it is not being built

The only way to learn the true `s_t` — and therefore whether the
question is answerable at n=144 — is to implement per-slot hand and run
the arm. There is no power calculation that escapes that. Building a
hot-path change dark, on the pricing path, purely to discover whether
the resulting measurement resolves, is a cost with no floor on it: per
CLAUDE.md §"Ingest-not-hot-path", a hot-path change needs prod-shaped
verification before it ships at all, and two prior attempts at hot-path
filters each caused prod-wide incidents.

So: registered, not built.

## What would change the answer — and the re-run that settles it

**Revisit on a pooled multi-season corpus.** n=144 treated games is one
season's worth of opener/bulk hand mismatches. The per-treated-game bar
falls as `1/sqrt(n_treated)`:

| treated games | corpus-wide half-width | per-treated-game bar |
|---|---|---|
| 144 (today, 1 season) | ≈±0.00023 | ≈±0.0019 |
| ~290 (2 seasons) | ≈±0.00023 | ≈±0.0013 |
| ~430 (3 seasons) | ≈±0.00023 | ≈±0.0011 |

(The corpus-wide figure is near-flat because `n` and `p` grow together;
the per-treated-game bar is the one that moves.)

Re-derive the inputs rather than quoting this table — CLAUDE.md
§"Re-check a deprioritizing number before treating the decision as
settled" exists because **a stale green light corrects itself and a
stale red light does not**, and this doc is a red light:

```
node --max-old-space-size=1536 scripts/park-neutral-paired-floor.js   # the s_t template
node --max-old-space-size=1536 scripts/probe-bulk-hand-channel.js     # the treated-side counts
```

Both are read-only. If the opener/bulk mismatch rate or the corpus size
has moved materially since 2026-09-19, the arithmetic above is
**unverified**, not settled.

## Related

- `docs/bulk-hand-measured-inert-2026-09-19.md` — why reading
  `bulk_guy_{side}_hand` into the current call site moves nothing. That
  column is the input this work would need.
- CLAUDE.md §"SP_WEIGHT vs SP_PIT_WEIGHT" — `SP_WEIGHT` is the
  batter-side handedness weight this ticket is about. Do not conflate
  with `SP_PIT_WEIGHT`.
- `docs/sp-weight-empirical-benchmark-2026-07-27.md` — the 0.865 vs
  0.649 hand-conditional benchmark, dark in prod
  (`use_hand_conditional_sp_weight = false`). If that flag is ever
  flipped, this gap compounds with it and the arithmetic here needs
  redoing.
