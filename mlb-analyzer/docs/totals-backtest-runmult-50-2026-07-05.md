# Totals signal backtest — RUN_MULT 46 vs 50 — 2026-07-05

The betting-outcomes validation the recalibration skipped.

`docs/runs-term-recalibration-2026-07-05.md` ship criteria were
holdout RMSE (accuracy). This doc replays the season's totals signals
under both `RUN_MULT` values, morning-line graded with Kalshi fees,
to answer the different question: **what happens to actual signal PnL?**

**Verdict**: RUN_MULT=50 **improves per-side calibration but worsens
overall totals ROI**, particularly out-of-sample in June.
Calibration and betting outcomes are pulling in opposite directions
here. This is the outcome the owner asked me to report straight.

Prod state confirmed live: RUN_MULT already flipped to 50. Recommendation
below.

## Method

- **Population**: fresh prod fetch 2026-04-01 → 2026-07-05, n=1,144
  resolved games, n=1,064 with `proj_market_total`.
- **Rescoring at 50**: prod's stored `model_total` was scored at
  RUN_MULT=46 (historical). Reconstructed the RUN_MULT=50 estTot via
  scaling proxy — the wOBA-driven portion scales linearly with
  RUN_MULT, wind/temp adjustments do not:

  ```
  wOBA_part = model_total_46 − (wind_run_adj + temp_run_adj)
  model_total_50 = wOBA_part × (50/46) + (wind_run_adj + temp_run_adj)
  ```

  Framing/defense are per-side subtractions unavailable via API and
  <5% coverage before mid-June — treated as noise.
- **Signal reconstruction**: `getSignals`-equivalent math with prod
  `tot_slope=0.08`, `tot_prob_lo=0.20`, `tot_prob_hi=0.80`. Emit any
  side with edge > 0 (report all bands including sub-1pp).
- **Grading**: against `proj_market_total` (morning line, owner's
  actual bet-time reference). Kalshi taker fee applied. $100 stake
  per bet.
- **Holdout separation**: June flagged separately. Fit trained on
  Apr-May. Note: even "in-sample" Apr-May is hindsight rescoring, so
  it's not truly free of overfit — flagged in the caveats.

## Section 1 — Population shift

At 46 vs 50, signals by edge band × side:

```
band       side   n@46   n@50    Δ
sub-1pp    over   45     70     +25
sub-1pp    under  73     35     -38
1-3pp      over   77     146    +69
1-3pp      under  150    67     -83
3-6pp      over   57     186    +129
3-6pp      under  171    50     -121
6-10pp     over   30     133    +103
6-10pp     under  106    18     -88
10pp+      over   8      68     +60
10pp+      under  45     5      -40
Total      over   217    603    +386
Total      under  545    175    -370
Combined:         762    778    +16
```

**Nearly 3× more Overs. Nearly 3× fewer Unders. Combined count barely
moves — it's a pure redistribution from Under to Over.**

By morning bucket:

```
bucket   over@46  over@50   under@46  under@50
LO       3        7         0         0
MID      188      481       389       112
HI       26       115       156       63
```

The redistribution concentrates in MID games and HI games. Under
signals in HI games drop 60% (156 → 63).

## Section 2 — Hypothetical W/L + net ROI (morning-line graded, Kalshi fees)

Full population, all bands:

```
                 n     W/L/P       win%    net_pnl    ROI
At 46 Over       217   98/110/9    47.1    -$2,223    -10.24%
At 46 Under      545   278/258/9   51.9    -$1,725     -3.17%
At 46 Combined   762   376/368/18  50.5    -$3,948     -5.18%

At 50 Over       603   287/300/16  48.9    -$4,464     -7.40%
At 50 Under      175   91/81/3     52.9    -$105       -0.60%
At 50 Combined   778   378/381/19  49.8    -$4,569     -5.87%
```

**Combined ROI: -5.18% at 46 → -5.87% at 50. Worse by 0.69pp.**

**Per-side, both improve at 50:**
- Over: -10.24% → -7.40% (2.8pp better; but on 3× the volume)
- Under: -3.17% → -0.60% (2.6pp better; but on 1/3 the volume)

**But the volume shift moves signals FROM the better-performing side
(Under) TO the worse-performing side (Over).** Net negative for the
book.

## Section 3 — Overlap analysis (the "same or different Overs?" question)

Owner's specific fear: are the 50-Overs the same anti-predictive Overs
from the audit era, or a different population?

```
OVERS:
  still-Over (both 46 & 50 fired):    n=354   ROI=-7.40%   net=-$2,618
  new-Over (50 only, absent at 46):   n=249   ROI=-7.41%   net=-$1,846
  killed-Over (46 only, absent at 50): n=0    (N/A — 50 always emits Over when 46 did)

UNDERS:
  still-Under (both fired):           n=175   ROI=-0.60%   net=-$105
  new-Under (50 only, absent at 46):  n=0     (N/A — 50 cannot emit new Unders)
  killed-Under (46 only, absent at 50): n=256 ROI=-2.38%   net=-$610
```

**Same population. Still-Overs -7.40% ROI, new-Overs -7.41% ROI.**
Identical loss-rate. The 249 new Overs at 50 aren't a "different"
better-performing subset — they're just more of the same losing
Over signal.

The reason: RUN_MULT scales the model uniformly. It doesn't correct
the signal-selection bias that produces losing Overs; it just makes
MORE signals cross the threshold in the same direction.

**Answer**: same anti-predictive Overs. Bigger volume, same win rate.

## Section 4 — The counter-check: what did 50 kill?

Killed Unders (fired at 46, not at 50): **n=256, ROI=-2.38%, net=-$610**.

**50 killed losers.** The Unders that vanished were on average
losing 2.4% ROI. Killing them SAVED $610.

But 50 also minted 249 new Overs at ROI -7.41%, costing $1,846 net.

**Net trade-off**: 50 saves $610 by killing losing Unders but loses
$1,846 by adding losing Overs. **Net -$1,236 vs 46.**

## Section 5 — June holdout (out-of-sample)

The fit was trained on Apr-May; June was holdout. In-sample effects
are hindsight; June is the honest test.

```
                          n     W/L/P       win%    net_pnl    ROI
At 46 Over holdout        70    37/30/3     55.2    +$337      +4.81%
At 46 Under holdout       209   106/100/3   51.5    -$822      -3.93%
At 46 Combined holdout    279   143/130/6   52.4    -$485      -1.74%

At 50 Over holdout        198   102/93/3    52.3    -$151      -0.76%
At 50 Under holdout       78    34/42/2     44.7    -$1,203    -15.43%
At 50 Combined holdout    276   136/135/5   50.2    -$1,355    -4.91%
```

**Critical finding: at 46, June Overs were WINNING at +4.81% ROI on
n=70.** At 50, that winning slice gets diluted to n=198 with the
extra 128 Overs bringing losses; net Over ROI drops to -0.76%.

Meanwhile the June Unders that survive at 50 are the WORST of the
old population — the ones the model was most confident about — and
they're getting crushed at -15.43% ROI. At 46 the Under population
included many marginal signals that were closer to break-even
(-3.93% aggregate).

**June holdout combined: 46 → 50 loses 3.2pp of ROI, from -1.74%
to -4.91%.** This is the out-of-sample evidence that 50 is worse
than 46 for betting.

## Section 6 — Monthly split (contextualizes the volatility)

```
month     n@46  ROI@46    n@50  ROI@50
2026-04   142   -21.26%   133   +0.74%     ← 50 much better (April was HOT)
2026-05   305   -1.70%    333   -10.88%    ← 50 much worse (May was COOL)
2026-06   279   -1.74%    276   -4.91%     ← 50 worse (holdout)
2026-07   36    +2.07%    36    +8.62%     ← 50 better (tiny n=36)
```

The April vs May reversal tells the story. 2026 April was
unusually high-scoring (9.24 R/G) — the model at 46 badly
under-projected → emitted losing Unders → -21% ROI. At 50, the
model closer-matches the elevated actuals → those bad Unders don't
fire and Overs happen to win.

2026 May was unusually low-scoring (8.61 R/G, below 2024/2025's
8.78). At 46 the model happened to match reality; Unders won
(+5.75% ROI on 204 signals!). At 50, the model over-projects May
→ shifts to Overs → those Overs lose because reality was actually
cool.

**RUN_MULT tuning is a bet on the future run environment.**
- If future months look like April (hot): 50 is right.
- If future months look like May (cool): 46 is right.
- If mixed: closer to a wash.

The June holdout shows the mixed case cleanly, and 50 loses.

## Section 7 — In-sample summary

Apr-May combined (the fit train window):

```
At 46: n=447   W/L=213/222   ROI=-7.91%   net=-$3,537
At 50: n=466   W/L=221/231   ROI=-7.56%   net=-$3,525
Delta: essentially IDENTICAL (0.35pp better at 50 — noise)
```

Even in-sample, where the recalibration was optimized, the betting
outcome is a wash. The April improvement and May degradation
mostly cancel.

## Caveats

1. **Hindsight rescoring**: signals were reconstructed from the
   model's stored `model_total`. In production at RUN_MULT=46, the
   `bet_signals` table only contains signals the emit-floor let
   through. This backtest counts ALL signals with edge > 0,
   including the sub-1pp band that the current floor blocks. So
   "at 46" here is a superset of what actually ran. Same
   inflation applies to "at 50" — direct comparison is valid.
2. **Morning-line grading limit**: `proj_market_total` was
   available for 92% of resolved games. Games without it are
   dropped from the analysis. If the missing 8% is systematically
   different (early-morning-fetch failures, etc.), that's an
   unmeasured bias.
3. **In-sample nature of Apr-May**: the fit that recommended 50
   was trained on this same window. Apr-May results here are
   hindsight-optimized. **June holdout is the free evidence** — and
   it says 50 is worse.
4. **RUN_MULT scaling proxy is approximate**: framing and defense
   subtractions are not scaled by RUN_MULT and are missing from
   this proxy. Coverage on framing was <5% before mid-June, so
   the error is bounded to ~0.05-0.15 runs per game on ~5% of
   the population. Materially: rounding error at the aggregate.

## Decision framing

The recalibration doc said: **holdout HI RMSE 5.15 → 4.95 = ship.**

This doc says: **holdout combined betting ROI -1.74% → -4.91% =
don't ship.**

Both are true. They measure different things:

- **Recalibration doc**: is the model's absolute run projection
  closer to actual runs? Answer: yes at 50.
- **This doc**: are the signals the model produces + fee-adjusted
  better-EV? Answer: no at 50.

The gap between them is signal selection. RUN_MULT=50 makes the
model less-biased in absolute terms but doesn't correct the fact
that its emitted Overs are anti-predictive. It just makes MORE of
them cross the threshold.

## Recommendation

**Revert prod `RUN_MULT` from 50 back to 46**, based on the
morning-graded, fee-adjusted, out-of-sample June holdout showing
50 loses 3.2pp of ROI vs 46 with essentially the same population
size.

Same rule as always: **calibration is a means, not an end.** The
end is betting outcomes. If the recalibration improves the means
but degrades the end, the recalibration doesn't ship in production.

Follow-up work:
- Fix the Over-side signal-selection bias at the source (why do
  model-Overs consistently lose? — it's not a level issue, it's a
  matchup-selection issue documented in the emit-floor
  reconciliation).
- Investigate whether the 3-6pp Over band specifically (where the
  worst per-band losses concentrate) can be flagged via the
  edge-cap SOFT threshold at 0.03 (down from current 0.06 recommendation).
- Keep the runs-term recalibration doc's temp-extreme
  under-scaling finding as its own follow-up — 90+°F temp_run_adj
  under-delivers, but that's independent of RUN_MULT.

## Files

- Script: `tmp/backtest-runmult-50-totals.js`
- Per-signal detail: `tmp/backtest-runmult-50.tsv` (1,540 rows)
