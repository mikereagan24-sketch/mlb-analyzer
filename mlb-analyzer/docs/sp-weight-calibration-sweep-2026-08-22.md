# SP_WEIGHT on calibration — inert, and combo 7's leg was doubly invalid (2026-08-22)

> **Measurement pass. Nothing shipped.** Production `sp_weight=0.80 /
> relief_weight=0.20` stays.

The other leg of "combo 7". Its +15.28pp ROI evidence was already known
to be a selection effect
(`docs/sweep-selection-effect-2026-08-21.md`). Re-run on the calibration
harness — and a second, independent invalidity turned up along the way.

## TL;DR

- **SP_WEIGHT is essentially inert on calibration.** Log loss varies by
  **0.00126 across the entire 0.10–0.90 grid** — seven times flatter
  than W_PIT's 0.00933. **0 of 8 candidates have a CI excluding zero.**
- **Production 0.80 is fine.** The shallow minimum sits at 0.60,
  0.00026 better, CI [−0.00152, +0.00133] spanning zero.
- **This contradicts the July sweep**, which ranked SP_WEIGHT as one of
  "the real movers" alongside W_PIT. On a target that measures pricing
  it barely moves anything.
- **A second, independent defect in the July design:** sweeping
  `BAT_HAND_SP` alone **breaks the `sp_weight + relief_weight = 1.0`
  schema invariant**, so it scales batter wOBA rather than re-splitting
  the platoon blend. Combo 7's `SP_WEIGHT=0.75` leg was a −5% batter
  level shift, not a platoon reweight.
- Fixed with a new `BAT_HAND_SP_PAIRED` sweep key that holds the sum at
  1.0.

## 1. The confound, found by running it

The first run swept `BAT_HAND_SP` — the key the July sweep used — and
returned something obviously wrong:

| BAT_HAND_SP | log loss | ECE |
|---|---|---|
| 0.10 | **0.69261** | 0.0005 |
| 0.20 | **0.69261** | 0.0005 |
| 0.30 | 0.70414 | 0.0217 |
| **0.40** | **0.74418** | **0.1458** |
| 0.50 | 0.70827 | 0.0709 |
| 0.80 (prod) | 0.68975 | 0.0114 |
| 0.90 | 0.68938 | 0.0083 |

Two tells. 0.10 and 0.20 give **byte-identical** log loss, and that
value — 0.69261 — is *exactly* the always-predict-the-base-rate number,
with ECE 0.0005. The model had degenerated to a constant. And 0.40
spikes to 0.74418, wildly non-monotone against both neighbours.

**Cause.** `perBatterEW` computes

```js
const batW = vsStart * spW + vsOpp * relW;
```

and `services/settings-schema.js:126` requires
`sp_weight + relief_weight == 1.0`. But `applySweepOverrides` sets each
weight **independently**:

```js
if ('BAT_HAND_SP' in overrides) s.SP_WEIGHT = overrides.BAT_HAND_SP;
if ('BAT_HAND_RELIEF' in overrides) s.RELIEF_WEIGHT = overrides.BAT_HAND_RELIEF;
```

So sweeping `BAT_HAND_SP` alone leaves `RELIEF_WEIGHT` at its production
0.20 and the **sum ranges 0.30 → 1.10**. Batter wOBA is scaled by that
factor, not re-split. At the low end the scaling drives `aRuns`/`hRuns`
into their `Math.max(0, …)` floor, `rawHW` pins at 0.5, and `adjHW`
becomes a constant `0.5 + HFA_BOOST = 0.517` — indistinguishable from
the 51.65% base rate, which is exactly what the table shows.

This is not a bug in the engine — its comment says the sweep
"deliberately allows out-of-schema values to probe the model's behavior
at extremes." It is a bug in **using that key to ask about the platoon
split**, which is what the July sweep did.

**Fix:** new `BAT_HAND_SP_PAIRED` key sets `SP_WEIGHT = v` and
`RELIEF_WEIGHT = 1 − v`, holding the total batter weight at 1.0. The
bare key is left alone for deliberate out-of-schema probing, with the
trap documented at the call site.

## 2. The clean result

`BAT_HAND_SP_PAIRED`, 790 games, identical game set at every grid value
(asserted).

| value | log loss | Δ vs prod | Brier | ECE | edge slope |
|---|---|---|---|---|---|
| 0.10 | 0.69075 | +0.00101 | 0.24880 | 0.0180 | −0.235 |
| 0.20 | 0.69027 | +0.00052 | 0.24856 | 0.0091 | −0.260 |
| 0.30 | 0.68990 | +0.00016 | 0.24838 | 0.0109 | −0.284 |
| 0.40 | 0.68965 | −0.00009 | 0.24825 | 0.0193 | −0.303 |
| 0.50 | 0.68951 | −0.00023 | 0.24818 | 0.0284 | −0.317 |
| **0.60** | **0.68949** | **−0.00026** | 0.24817 | 0.0163 | −0.324 |
| 0.70 | 0.68956 | −0.00018 | 0.24821 | 0.0122 | −0.322 |
| **0.80 (prod)** | 0.68975 | — | 0.24830 | 0.0114 | −0.313 |
| 0.90 | 0.69003 | +0.00028 | 0.24843 | 0.0106 | −0.298 |

Smooth and unimodal, minimum at 0.60 — but the **entire grid spans
0.00126 of log loss**. For scale, W_PIT spanned 0.00933 and its extremes
were rejected outright.

**Bootstrap: 0 of 8 exclude zero.** Even the 0.10-vs-0.80 comparison —
the widest on the grid — is not significant (CI [−0.00344, +0.00668]).

**Folds: 0 of 8 hold a sign**, with the same column pattern seen
elsewhere: F1 favours high SP_WEIGHT for every candidate, F2 favours
low. Val:Fit passes 6 of 8, which means nothing when no candidate is
distinguishable — with deltas this small the two halves agree because
both are noise around zero.

## 3. Does 0.80 hold up?

**Yes, and this time with converging evidence.**

- Calibration cannot distinguish 0.80 from anything else on the grid.
  There is no case to move it.
- `docs/sp-weight-empirical-benchmark-2026-07-27.md` derives the
  benchmark from `pitcher_game_log` BF data: **0.865 vs RHP, 0.649 vs
  LHP, 0.800 volume-weighted overall.** Production is exactly that
  volume-weighted value.

A mechanism-derived value and a calibration measurement that cannot
improve on it is the strongest position available for a parameter this
flat. Leave it.

## 4. What this does to combo 7

`docs/weight-sensitivity-sweep-2026-07.md` proposed `W_PIT=0.35` +
`SP_WEIGHT=0.75`, Val ROI −3.13% → +12.15%. Its SP_WEIGHT leg now fails
on three counts:

1. **Selection.** The +15.28pp is composition, not pricing
   (2026-08-21 rule).
2. **Confounded.** With `RELIEF_WEIGHT` pinned at 0.20, `SP_WEIGHT=0.75`
   is a **0.95× batter-wOBA level shift**, not a platoon reweight. It
   was not testing the thing it claimed to test.
3. **Inert anyway.** On a proper paired sweep, no SP_WEIGHT value on the
   grid is distinguishable from production.

Its W_PIT leg fares better — `W_PIT=0.35` sits inside the defensible
0.20–0.50 plateau (`docs/wpit-wbat-calibration-sweep-2026-08-22.md`) —
but W_PIT is set by `W_PIT_W_BAT`, which *does* maintain its complement,
so that leg was at least measuring what it claimed.

**Combo 7 should be retired as a candidate.** Not "not yet piloted" —
retired.

## 5. Edge slope, again

The edge slope sits between −0.235 and −0.324 across the whole grid,
tracking production's −0.313 with no meaningful variation. Consistent
with `docs/edge-honesty-scope-2026-08-22.md`: **no SP_WEIGHT value makes
the claimed edge honest.** Nothing here changes that picture.

## 6. What this does not establish

- **Not** that SP_WEIGHT is irrelevant to the model — only that
  calibration cannot distinguish values of it on 790 games. The whole
  grid spans less than a fifth of W_PIT's range, so it would need far
  more data than W_PIT to resolve.
- **Not** a totals result. Target is the ML win probability.
- **Not** a verdict on hand-conditional SP_WEIGHT (`sp_weight_r` /
  `sp_weight_l`). `use_hand_conditional_sp_weight` is off, so the
  scalar path is what was swept. The hand-conditional path is unmeasured
  and is a separate question.

## 7. Follow-up

Any other sweep that touched `BAT_HAND_SP` or `BAT_HAND_RELIEF`
**independently** carries the same level-shift confound. That includes
the July univariate pass and its joint mode, which crossed the two keys
over `{0.1,0.3,0.5,0.7,0.9}` — 20 of those 25 pairs violate the sum
invariant. Anything read off those cells is a level effect wearing a
platoon-split label.

## Related

- `docs/wpit-wbat-calibration-sweep-2026-08-22.md` — the other leg.
- `docs/edge-honesty-scope-2026-08-22.md` — why the slope is flat here.
- `docs/sweep-selection-effect-2026-08-21.md` — why the ROI evidence never counted.
- `docs/sp-weight-empirical-benchmark-2026-07-27.md` — the 0.800 benchmark.
- `docs/weight-sensitivity-sweep-2026-07.md` — combo 7's origin.
