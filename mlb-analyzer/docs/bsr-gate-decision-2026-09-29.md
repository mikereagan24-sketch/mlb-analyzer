# BsR gate decision — ON at 1x, construction `current` (2026-09-29)

**Status: decided. `bsr_baserunning` → ON at 1x, construction `current`, on
mechanistic grounds.** Registry: `decision.outcome = 'on_for_mechanism'`,
`key: 'bsr_enabled'`, `on_expected: true`. The term has priced in production
since the first scoring pass after `bsr_enabled` was set (2026-09-29 21:00 UTC).

## The decision in one paragraph

The lineup baserunning term points the right way, is scaled about right, and
its benefit is below what this season's corpus can resolve. Calibration cannot
adjudicate at this n, and scaling the term cannot make it resolvable (the
t-statistic is scale-invariant, below). It is therefore enabled for the
**mechanism** — the same resting state as `park_neutral_inputs_enabled` — and
judged forward through the shadow logging, not by another pass over the same
corpus.

## How it got here — including the OFF that was drafted and replaced

- **2026-08-23** gate re-spec: calibration primary, accuracy second, CLV
  context (`docs/bsr-gate-status-2026-08-23.md`). **2026-09-12** CLV prong
  re-spec to marginal rows only; preconditions met (88 snapshot days, 1,110
  forward games). Window end moved to 2026-09-28.
- **2026-09-26** refreshed prongs, all indistinguishable: calibration
  n=1,286, ΔlogLoss −0.00042 [−0.00106, +0.00029], ΔMAE −0.0033 ± 0.0015;
  forward-honest `current` −0.00016, `pt_neutral` −0.00008, `pa_weighted`
  +0.00034; pooled CLV deltas +0.10 / −0.04 / −0.04 pp against a ±3.8 pp noise
  band; `side_flipped` 0 everywhere.
- **2026-09-27 01:57 UTC — an OFF disposition was drafted** ("direction
  plausible, scale about right, benefit below resolution; enabling would
  reshuffle ~14–17% of bet decisions with unmeasurable marginal CLV, #469").
  **It was never committed, and it was replaced the same session by ON at 1x**
  on the same three findings read the other way: a term that is right in sign
  and scale and costs nothing measurable is priced, and the reshuffled
  decisions are exactly what the shadow logging now records. #469 was raised
  from low priority at that point, because marginal-row CLV is the instrument
  that judges the shadow.
- **#471** consolidated the four Pythag+HFA+clamp copies into
  `utils/pythag-win-prob.js` (byte-identical). **#477** added the term behind
  `bsr_enabled` (default off, byte-identical off). The switch was set on
  2026-09-29.

## Evidence 1 — multiplier sweep (2026-09-27, read-only diagnostic)

Forward-honest harness, 1,280 games scored (9 dropped: the 2026-09-03 snapshot
gap; `pa_weighted` 22). ΔlogLoss vs the 0x baseline, CI95:

| mult | `current` | `pt_neutral` | `pa_weighted` |
|---|---|---|---|
| 1x | **−0.00016** [−0.00107, +0.00063] | **−0.00008** [−0.00100, +0.00071] | +0.00034 [−0.00103, +0.00155] |
| 2x | −0.00003 | +0.00015 | +0.00110 |
| 3x | +0.00037 | +0.00071 | +0.00211 |
| 4x | +0.00103 | +0.00160 | +0.00342 |
| 5x | +0.00193 | +0.00249 | +0.00491 |
| **−3x** (placebo) | +0.00232 [−0.00005, +0.00515] | +0.00226 [+0.00000, +0.00513] | +0.00249 [−0.00084, +0.00649] |

- **Scale.** Quadratic optimum 1.09x (`current`, depth 0.00016) and 0.78x
  (`pt_neutral`, depth 0.00009). Production's 1x sits on the optimum; there is
  no headroom anywhere in the grid.
- **Sign.** Right sign: the −3x placebo is worse than +3x in both sound
  constructions. It is the worst cell overall in the `current` construction
  (−3x +0.00232 vs 5x +0.00193); in `pt_neutral`, 5x is worse (+0.00249 vs
  +0.00226 for −3x). +3x and −3x do not separate beyond their intervals —
  consistency, not replication, since the constructions share games and
  players.
- **`pa_weighted` is sign-symmetric** (−3x +0.00249 vs +3x +0.00211): a pure
  m² curve with no optimum. The sign information lives only in the two
  constructions that weight players defensibly — modest corroboration that the
  direction is real.
- **Bet-set shift at 1x (`current`):** 67 without-only, 55 with-only, 0 flips —
  16.6% of rows marginal, rising to 49.3% at 5x.

**Pre-registration (sweep):** Shape A (underweighted signal: improves then
turns) vs Shape B (noise: worsens with |multiplier|, placebo ≈ +3x). **Outcome:
split.** B's magnitude clause held (worse as |m| grows); A's sign clause held
faintly (placebo worse than +3x). Mechanism prior (dimensionally correct, not
double-counting — wOBA is batting events, BsR the non-batting residual)
predicted B. Recorded miss: the power prediction that 5x would resolve at
~−0.001 against a fixed half-width — see scale invariance below. Recorded miss:
`pa_weighted` −3x predicted ≈ +0.00085, observed +0.00249 (the fitted linear
term does not carry across the origin).

## Evidence 2 — extremes diagnostic (2026-09-27, read-only)

Arms vs 0x: A full term; B team-level extremes (top/bottom 25% of per-game
lineup BsR, forward-honest expanding-window cutoffs); C player-level extremes;
D team middle 50%; E player middle 50%. Decomposition assertions passed
(vB + vD == v exactly; vC + vE == v to 1e-9, 0 violations).

| arm | mult | `current` | `pt_neutral` |
|---|---|---|---|
| A | 1x | −0.00016 [−0.00107, +0.00063] | −0.00008 [−0.00100, +0.00071] |
| **B** | **1x** | **−0.00021** [−0.00117, +0.00062] | **−0.00019** [−0.00113, +0.00065] |
| B | 2x | −0.00015 | −0.00007 |
| B | 3x | +0.00021 | +0.00036 |
| B | 5x | +0.00168 | +0.00194 |
| B | −3x | +0.00254 [−0.00001, +0.00544] | +0.00253 [+0.00003, +0.00542] |
| C | 1x | −0.00013 | +0.00011 |
| C | 2x | +0.00002 | +0.00042 |
| C | 3x | +0.00046 | +0.00093 |
| C | 5x | +0.00208 | +0.00254 |
| C | −3x | +0.00221 | +0.00092 |
| **D** | **1x** | **+0.00013** [−0.00017, +0.00047] | **+0.00015** [−0.00021, +0.00047] |
| E | 1x | −0.00003 [−0.00013, +0.00010] | −0.00020 [−0.00063, +0.00027] |

One ordinal finding replicates across both constructions: **B beats A, and D
(the team-level middle 50%) is the worst cell** — the middle is the harmful
part. Arm B's fitted optimum is **1.27x** (`current`) / **1.16x**
(`pt_neutral`). Nothing is individually resolvable: best depth anywhere 0.00022
against a ~0.00088 threshold; the only CI excluding zero is a −3x placebo, in
the harmful direction.

**Pre-registration scorecard (extremes), misses included:**

| prediction | outcome |
|---|---|
| Team magnitude share 75–82% | **HIT** — 77.2% / 75.5% |
| Player share 55–75% (revised after a degenerate first cut) | **MISS** — 100.1% / 87.4%: \|·\| is taken after summing within a team-game, so the statistic is not bounded by 100% |
| 1x within [−0.00036, +0.00004] / [−0.00028, +0.00012] | **HIT** — all four cells inside |
| Optimum **below** 1x (extremes are partly luck) | **MISS** — 1.27x / 1.16x |
| Nothing individually resolvable | **HIT, one exception** — the −3x placebo (`pt_neutral` B@−3x [+0.00003, +0.00542]) |

**`pt_neutral` caveat:** the player cut ranks on counting BsR, not the rate
`pt_neutral` sums, and arm C goes sign-symmetric there (+0.00093 vs +0.00092).
**Arms C and E are not interpretable for `pt_neutral`**; only A, B and D are.
For `current`, arm C retains 100.1% of the magnitude, so it is largely
uninformative by construction.

## Two methodological findings worth keeping

1. **Scale invariance.** The CI half-width scales linearly with the
   multiplier (0.00085 → 0.00417 from 1x to 5x), so the t-statistic is
   scale-invariant: **scaling an additive term buys zero statistical
   resolution.** A multiplier sweep can locate an optimum and a sign; it cannot
   make a sub-resolution effect detectable.
2. **Truncation power is about variance, not magnitude.** Arm B was predicted
   to have a narrower CI in proportion to its 77% magnitude share (~0.00068).
   It did not (0.000895, slightly wider than A's 0.00085): the CI scales with
   the term's standard deviation, and the extreme quartiles carry nearly all
   of the variance (0.00032² + 0.000895² ≈ 0.00085²). Dropping the middle buys
   essentially no power.

## What was enabled, exactly (#477)

- `utils/bsr-term.js`, construction `current`: Σ starters' trailing-1yr BsR /
  team games completed **strictly before** the game date, from the dated
  trailing snapshot as of the game date; names resolved with
  `resolveCatcherMlbId`.
- Fused clamp `max(0, raw − framing − defense + bsr)`, moneyline only (totals
  unaffected, verified: 0 of 1,049 forward games differ in `estTot` or Total
  signals). The sweep's double-clamp and this fused form are identical on this
  corpus: 0 clamp hits, minimum run expectation 2.27 against a term ≤ 0.15.
- **Not exactly the measured term.** The backtest's denominator counted games
  through the end of its window (hindsight even in forward-honest mode);
  production counts games strictly before the game date. The two converge late
  in the season. **The shadow logging, not the sweep, evaluates the term that
  is actually priced.**
- Off-by-default verification: byte-identical to `main` across the current
  slate and the forward corpus (sha256 `51f88466…ba4d` both). On: 182 of 1,049
  forward games cross the bet line (88 none→bet, 94 bet→none), `side_flipped`
  0, mean |Δ home wp| 0.0097.

## Production check after the flip (2026-09-29)

2026-09-29 slate, re-scored 21:00:08–21:00:10 UTC (first pass after the flip):
all 4 games show `lineup_bsr.applied = true`, 8 of 8 sides status `ok`
(**0 fallbacks**), and `bsr_off_home_wp`, `bsr_off_ml_decision`,
`bsr_on_ml_decision` populated on all 4. No game's ML decision differed with
and without the term on that pass (phi-atl away/away, chc-sd away/away,
cws-hou none/none, bos-nyy none/none).

## What judges it from here

**No outcome evaluation has been done.** The shadow columns
(`bsr_off_home_wp`, `bsr_off_ml_decision`, `bsr_on_ml_decision`) are
populated in production, but no game with a final score has values yet, so
evaluation is pending final games and #469.

- **The shadow columns** — every priced game now records the win prob and ML
  decision with and without the term.
- **#469** — marginal-row CLV. The rows the term changes are exactly the rows
  `bet_set_diff` reports only as counts; until #469 lands, the shadow
  accumulates evidence that cannot yet be scored on CLV.
- **Pooled multi-season corpus** — the first out-of-sample test of both the
  full term and the forward hypothesis below.

## Forward hypothesis — registered, NOT adopted

Team-level extremes (top/bottom 25% of per-game lineup BsR, forward-honest
cutoffs) outperform the full term, with an optimum above 1x (1.27x / 1.16x on
this corpus). Found **post hoc** on this season's corpus after ~50 cells on the
same data; the pooled corpus is its first out-of-sample test. Nothing about it
is in production.

## Related

- `services/feature-gate-registry.js` `bsr_baserunning`
- `docs/bsr-gate-status-2026-08-23.md`, `docs/bsr-calibration-widened-corpus-2026-09-12.md`
- `utils/bsr-term.js`, `services/model.js` (BSR_ENABLED, BSR_WEIGHT), `services/baserunning-backtest.js`
- PRs #471, #477; issues #469 (marginal-row CLV), #470 (ubr/wgdp never populated — latent)
- Replay vintage: `docs/actuals-single-season-rebaseline-2026-09-22.md` (paired within-replay deltas cancel; the numbers above stand)
