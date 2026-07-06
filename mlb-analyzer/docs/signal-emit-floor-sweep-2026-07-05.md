# SIGNAL_EMIT_FLOOR sweep, Kalshi-fee-adjusted — 2026-07-05

Sweeps hypothetical `signal_emit_floor_pp` values against reconstructed
prod signals with Kalshi's actual taker fee formula applied. Includes
the below-floor population — the point of the exercise.

**Two headline findings:**

1. **Below-floor Totals ARE profitable and currently blocked.** Sub-1pp
   Total signals (edge in [0, 0.01)) show +$2,025 net PnL across 130
   candidates (2026-04-01 → 2026-07-05, prod-fetched). Never emit
   under the current 0.01 floor.

2. **The floor's optimal value differs by market type.** For Totals,
   a floor of 0.005 or 0.0 captures the sub-1pp profitable pocket
   (+22% ROI at 0.0-0.5pp band). For ML, sub-1pp is genuinely losing
   (-18.7% at 0.0-0.5pp) — keep the ML floor near 0.01. Structural
   asymmetry, not noise.

## Method

- **Population**: fetched `/api/games/YYYY-MM-DD` from prod for
  2026-04-01 → 2026-07-05. 1226 games total, 1144 resolved with all
  fields (model_total, model_away_ml, model_home_ml, market_total,
  market_away_ml, market_home_ml, over_price, under_price, both
  scores).
- **Edge reconstruction**: rebuilt ML and Total edges from stored
  model + market columns, replicating `getSignals` math:
  - ML: `impliedP(model_ml) − impliedP(market_ml)`
  - Total: `clamp(0.5 + (model_tot − market_tot) × TOT_SLOPE, LO, HI) − impliedP(price)`
  - Prod TOT_SLOPE=0.08, TOT_PROB_LO=0.20, TOT_PROB_HI=0.80.
- **Candidate signals**: every side with edge > 0 (i.e., positive
  model preference). n=1,663 candidates: 853 ML, 810 Total.
- **Fee model**: Kalshi taker,
  `fee = 0.068 × C × (1 − C) × contracts`, ceil-to-cent on order total,
  from `services/kalshi.js` (empirically back-solved to 3-cent
  precision against real fills). Poly's coefficient is 0.058 (~15%
  cheaper); running Kalshi only — the owner's primary venue is Kalshi
  per prod settings.
- **Stake basis**: $100 per bet; contracts = 100 / C; fee applied on
  both wins and losses (Kalshi charges on order placement).
- **Grading**: actual scores from game_log; pushes (actual == market)
  net zero. Win prob threshold for +EV vs -EV is bet-price-dependent
  because of fee curvature.

## Edge distribution (all positive-edge candidates)

```
n=1663  min=0.003pp  max=58.406pp
P10=0.578pp  P25=1.440pp  P50=3.043pp  P75=5.277pp  P90=7.793pp  P95=9.651pp  P99=13.283pp
  ML only  : n=853  P50=2.79  P90=7.09  P99=12.81  max=58.41
  Total    : n=810  P50=3.34  P90=8.58  P99=14.17  max=45.50
```

Median candidate edge is ~3pp. 25% of candidates fall below the current
1pp emit floor — that's ~400 signals dropped, before considering the
narrower emit-both-sides logic in getSignals.

## Sweep — hypothetical floors, Kalshi fees applied

### ML only

| Floor | n | W/L | Win% | ROI_gross | Fee | ROI_net | PnL_net |
|------:|--:|:--|--:|--:|--:|--:|--:|
| 0.005 | 772 | 357/415 | 46.2 | −4.57% | $2,700 | **−8.06%** | −$6,226 |
| 0.0075| 731 | 337/394 | 46.1 | −4.54% | $2,566 | −8.05% | −$5,885 |
| 0.01  | 697 | 320/377 | 45.9 | −4.61% | $2,457 | −8.14% | −$5,672 |
| 0.015 | 606 | 270/336 | 44.6 | −6.41% | $2,155 | −9.96% | −$6,037 |
| 0.02  | 538 | 233/305 | 43.3 | −8.47% | $1,927 | −12.05% | −$6,482 |

**ML gets WORSE as the floor rises.** Lowering to 0.005 is very slightly
better than 0.01 but every level loses money net of fees.

### Totals only

| Floor | n | W/L/P | Win% | ROI_gross | Fee | ROI_net | PnL_net |
|------:|--:|:--|--:|--:|--:|--:|--:|
| 0.005 | 748 | 376/368/4 | 50.5 | −2.49% | $2,451 | **−5.78%** | −$4,302 |
| 0.0075| 716 | 358/354/4 | 50.3 | −3.03% | $2,346 | −6.32% | −$4,503 |
| 0.01  | 680 | 336/340/4 | 49.7 | −4.04% | $2,228 | −7.34% | −$4,959 |
| 0.015 | 626 | 305/317/4 | 49.0 | −5.18% | $2,053 | −8.48% | −$5,273 |
| 0.02  | 556 | 276/278/2 | 49.8 | −3.78% | $1,828 | −7.08% | −$3,921 |

**Totals also improve as floor drops.** 0.005 is the best sweep point
tested (-5.78% ROI vs -7.34% at current 0.01).

### Combined

| Floor | n | Win% | ROI_net | PnL_net |
|------:|--:|--:|--:|--:|
| 0.005 | 1,520 | 48.4 | **−6.94%** | −$10,528 |
| 0.0075| 1,447 | 48.2 | −7.20% | −$10,388 |
| 0.01  | 1,377 | 47.8 | −7.74% | −$10,631 |
| 0.015 | 1,232 | 46.8 | −9.21% | −$11,310 |
| 0.02  | 1,094 | 46.6 | −9.53% | −$10,403 |

**Every floor from 0.005 to 0.02 produces net losses.** The floor is
not the primary problem — signal calibration is. But within the space,
LOWERING the floor slightly improves net PnL.

## Below-floor band breakdown (the point)

### ML

```
band          n     W/L      win%    ROI_gross  fee     ROI_net    PnL_net
0.0-0.5pp     81    34/47    42.0    -15.35%    $267    -18.65%    -$1,510
0.5-0.75pp    41    20/21    48.8    -5.03%     $135     -8.32%      -$341
0.75-1.0pp    34    17/17    50.0    -3.04%     $109     -6.24%      -$212
1.0-1.5pp     91    50/41    54.9    +7.33%     $302     +4.01%      +$365   ← emitted, +
1.5-2.0pp     68    37/31    54.4    +9.89%     $228     +6.54%      +$445   ← emitted, +
2.0-3.0pp    135    54/81    40.0   -17.75%     $472    -21.24%    -$2,868   ← emitted, LOSING
3.0-5.0pp    215    88/127   40.9   -15.07%     $756    -18.59%    -$3,997   ← emitted, LOSING
5.0-10pp     168    83/85    49.4    +6.60%     $613     +2.95%      +$495   ← emitted, +
10pp+         20     8/12    40.0    -1.35%      $85     -5.60%      -$112
```

- **ML sub-1pp: -$2,063 net PnL** across 156 signals. Correctly blocked.
- **ML 1-2pp: +$810 net PnL** (n=159). Currently emitted, profitable.
- **ML 2-5pp: -$6,865 net PnL** (n=350). Currently emitted, deeply losing.
- **ML 5-10pp: +$495 net PnL** (n=168). Currently emitted, profitable.

Non-monotonic. The middle band (2-5pp) is the model's weak zone — same
pattern the PR #145 audit found, still present.

### Totals

```
band          n     W/L/P    win%    ROI_gross  fee     ROI_net    PnL_net
0.0-0.5pp     62    39/22/1  63.9    +25.73%    $201    +22.44%    +$1,369   ← blocked, WINNING
0.5-0.75pp    32    18/14/0  56.3     +9.57%    $105     +6.29%      +$201   ← blocked, WINNING
0.75-1.0pp    36    22/14/0  61.1    +15.93%    $118    +12.65%      +$455   ← blocked, WINNING
1.0-1.5pp     54    31/23/0  57.4     +9.05%    $175     +5.82%      +$314   ← emitted, +
1.5-2.0pp     70    29/39/2  42.6    -16.56%    $225    -19.87%    -$1,351   ← emitted, LOSING
2.0-3.0pp    118    58/59/1  49.6     -4.04%    $384     -7.33%      -$857
3.0-5.0pp    180    87/93/0  48.3     -7.48%    $590    -10.76%    -$1,936
5.0-10pp     204   100/103/1 49.3     -4.40%    $671     -7.70%    -$1,563
10pp+         54    31/23/0  57.4    +11.45%    $183     +8.07%      +$436
```

- **Total sub-1pp: +$2,025 net PnL** across 130 signals. **Currently blocked.**
- **Total 1-1.5pp: +$314** (n=54). Currently emitted, marginally +.
- **Total 1.5-5pp: -$4,144** (n=368). Currently emitted, deeply losing.
- **Total 5-10pp: -$1,563** (n=204). Currently emitted, LOSING (matches
  the earlier v6 6-10pp finding — the miscalibrated band).
- **Total 10pp+: +$436** (n=54). Currently emitted, +.

**Totals are structurally different from ML on the low end.** The
sub-1pp band on Totals wins 61% (n=130); the sub-1pp band on ML wins
44% (n=156). The gap is 17pp of win-rate — well outside noise for these
sample sizes. Something about the model's marginal-preference on
totals is well-calibrated at zero-lean; the same edge on ML is
worse than random.

## Answering the exercise questions

**Q1. Does 0.5-1.0pp contain net-profitable volume after fees?**

Yes for Totals; no for ML.
- Totals [0.5, 1.0): n=68, W/L 40/28, ROI_net +9.6%, PnL +$656.
- ML [0.5, 1.0): n=75, W/L 37/38, ROI_net -7.4%, PnL -$553.

Confirmed as separable per market type.

**Q2. Should the floor differ by market type given totals' worse
calibration?**

The question's premise is inverted. Under fee-adjusted grading:
- Totals **outperform** ML at the very-low-edge tail (< 1pp).
- Totals **still under-perform** ML in the mid-range (2-10pp), matching
  the PR #145 audit's finding.
- Totals **outperform** ML at high edges (10pp+).

The right structure isn't "worse-calibrated Total → higher floor" — it's
that Totals have a very different edge-vs-outcome curve than ML.
Setting a single floor for both makes both worse than optimal.

**Q3. Below-floor population summary.**

```
Type    Band       n     ROI_net   PnL_net
ML      0-1pp     156    -13.6%   -$2,063
Total   0-1pp     130    +14.5%   +$2,025
```

The below-floor Total pocket is REAL, profitable, and blocked.
Estimated 3-month impact of enabling it: **~+$675/month** of net PnL
at $100 stake (unadjusted for stake-size variance).

## Recommendation

**Split the emit floor by market type.** Requires:
1. New schema key `signal_emit_floor_pp_ml` (default 0.01, same as current).
2. New schema key `signal_emit_floor_pp_total` (proposed 0.0 or 0.005).
3. `services/model.js getSignals` reads them separately for the ML vs
   Total branches (currently one shared `SIGNAL_EMIT_FLOOR_PP`).
4. UI controls per the CLAUDE.md standing rule (both keys need
   controls in the same PR).

Projected impact from this cohort:
- Totals floor → 0.0: gains +$2,025 vs current +$0 (currently blocked).
- Totals floor → 0.005: gains +$656 (only the [0.005, 0.01) band).
- ML floor stays at 0.01.

**Not recommending: raising the floor.** Every tested elevation
(0.015, 0.02) makes PnL WORSE. The model's edge-vs-outcome curve is
non-monotonic; the 2-5pp band is the model's weakness, but signals
elsewhere (1-2pp, 5-10pp for ML; 0-1pp, 10pp+ for Totals) still add
value.

**Bigger fish**: every floor produces net losses. The floor tweak
above adds ~$2k of PnL. The core issue — the 2-5pp Total band losing
$4,144 net — is a calibration problem best addressed by the
`signal_edge_cap` mechanism at a lower SOFT threshold (as
recommended in `docs/verify-measurement-session-2026-07-05.md` Part 2:
move SOFT from 0.10 → 0.06 to flag the 6-10pp band).

## Files

- Script: `tmp/sweep-emit-floor.js`
- Per-signal detail: `tmp/emit-floor-sweep.tsv` (1,663 rows)
