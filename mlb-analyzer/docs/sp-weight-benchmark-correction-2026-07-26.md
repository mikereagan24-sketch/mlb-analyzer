# SP_WEIGHT benchmark — corrected 2026-07-26

**Supersedes:** `docs/sp-weight-mechanism-rationale-2026-07-25.md`
(retracted in place; original preserved as paper trail).

## The mislabel

`services/model.js perBatterEW:498-502`:

```js
const spW  = SP_WEIGHT;
const relW = RELIEF_WEIGHT;
const vsStart = pitcherHand === 'R' ? batter.vsRHP : batter.vsLHP;
const vsOpp   = pitcherHand === 'R' ? batter.vsLHP : batter.vsRHP;
const batW = vsStart * spW + vsOpp * relW;
```

`vsStart` is the batter's split against **the starter's handedness**,
not against the starter as a person. So SP_WEIGHT is a **handedness-mix
parameter**, not a PA-exposure parameter. The mechanism doc analyzed
it as the latter — measuring what fraction of PAs the starter takes —
which is arithmetically fine as raw exposure but does not describe
this parameter.

## Correct benchmark

The right quantity is: **fraction of PAs a batter faces the starter's
handedness class**, counting same-hand relievers as part of that class.

```
handedness_exposure = SP_share + RP_share × P(RP same-hand as SP)
```

League data (`pitcher_fg_role='RP'` × `team_rosters.hand`): **166 R,
74 L → 69.2% R / 30.8% L**. Similar breakdown for SP.

|  | SP_share | RP_share | P(RP same-hand) | **Handedness exposure** | Delta from 0.80 |
|---|---|---|---|---|---|
| **RHP starter** | 0.54 | 0.46 | 0.69 | **0.857** | +5.7pp (0.80 is LOW) |
| **LHP starter** | 0.54 | 0.46 | 0.31 | **0.683** | −11.7pp (0.80 is HIGH) |
| **Volume-weighted** (70% R, 30% L SPs) | | | | **0.805** | +0.5pp |

**The 0.80 default is essentially the volume-weighted correct value.**
But that average papers over a structural mismatch:

- For R-starter games (~70% of slate): 0.80 is ~6pp too LOW
- For L-starter games (~30% of slate): 0.80 is ~12pp too HIGH

A single scalar cannot be right for both. This is a different kind of
"structurally wrong" than the mechanism doc's exposure framing
implied — the issue is not that 0.80 is far from a single truth, but
that there is no single truth. **The parameter should be conditioned
on SP handedness.**

## Second-order effect: pinch-hit strategy

Extreme-split hitters get pinch-hit for against the disfavored hand
before their PA happens. So the *realized* exposure to the opposite
hand is LOWER than the raw bullpen mix predicts — the manager pulls
the hitter before the LOOGY-vulnerable PA.

Direction: pushes the effective handedness exposure HIGHER than the
mechanical benchmark, especially for RHP starters where the
opposite-hand PAs are the LOOGY-vulnerable ones. Not currently
modeled; noted as further support for weight not going lower than
~0.80 on the R side.

## Sweep results — reinterpreted

`docs/sp-weight-rolling-cv-2026-07-25.md` showed:
- Direction: **DOWN** (mean test ROI +1.96% @ SP_WEIGHT ≤ 0.80 vs +0.57% @ ≥ 0.80)
- No stable per-fold winner (Fold A picks 0.60, B picks 0.72, C picks 0.77)
- CIs all overlap baseline

Under the corrected framing, the DOWN direction is surprising for the
~70% of the slate that's R-starter games (benchmark predicts UP for
those). Two possible explanations:

1. **L-starter games dominate the aggregate.** For L-starter games,
   0.80 is a much larger overshoot (−12pp) than the R-starter
   undershoot (+6pp), so even at 30% share, L-starter effect could
   drag the aggregate DOWN. **Testable — see hand-split sweep.**
2. **Signal is noise.** n=91-200 per fold, CIs all overlap baseline.
   Aggregate direction could be spurious.

The hand-split sweep (`scripts/sweep-sp-weight-rolling-cv-by-hand.js`,
companion to this doc) tests hypothesis 1 by scoring each candidate
separately on the R-facing-SP and L-facing-SP subsets of each fold. If
R-facing prefers HIGHER SP_WEIGHT and L-facing prefers LOWER — even
underpowered and with overlapping CIs — that's strong corroboration
the scalar is structurally wrong rather than merely mistuned.

## What survives, what dies

| Artifact | Status |
|---|---|
| Retracted mechanism doc (in commit `c03f35e`) | Kept with retraction preamble |
| Rolling-CV sweep script (in `c03f35e`) | Fully valid — measures ROI at different scalar values |
| Rolling-CV sweep results doc (in `c03f35e`) | Numbers valid; direction interpretation now framed against the corrected benchmark |
| Schema tighten `sp_weight.max` 0.95→0.85 (`2961797`) | **Survives.** 0.90 uniformly negative is data, not framing |
| Blast-radius doc (untracked) | Consumers section (a-c) survives — `sp_forecast_ip` genuinely feeds `SP_PIT_WEIGHT`, not `SP_WEIGHT`. Rewrite the framing: it stands on its own as a `SP_PIT_WEIGHT` data-quality issue, not a per-game-SP_WEIGHT blocker |
| Per-game-from-forecast-IP design | **Scrap.** Wrong quantity entirely |
| Hand-conditional per-game SP_WEIGHT design | **New scope** — see `docs/sp-weight-hand-conditional-design-2026-07-26.md` |

## Bottom line

- 0.80 is a defensible *volume-weighted average* of the correct
  benchmark — not a well-founded scalar, but not a bad one either.
- The real improvement isn't tuning the scalar; it's conditioning on
  SP handedness (and optionally opposing bullpen mix per team).
- The hand-conditional constant is likely the 80% win: two constants
  (~0.86 R, ~0.68 L) or three including a switch-hitter mode, no
  per-team roster lookup, minimal code change.
- Per-team refinement is available once the hand-conditional constant
  ships and its behavior is stable.
