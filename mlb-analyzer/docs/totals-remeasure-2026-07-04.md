# Totals gap re-measurement — 2026-07-04

Re-measures `docs/audit-2026-07-02.md` finding 1.3 (mid-range totals over-projected
on Overs) with the model as it stands today. Read-only, no settings changes.

## Method

- **Population:** all resolved games with `market_total IS NOT NULL` since 2026-04-01
  from `game_log` — n = 768 games. Full season, no sampling needed
  (scored in 72s with current runModel).
- **Scoring:** current `services/model.js` runModel with current
  `app_settings`. All feature branches merged to main (through PR #150).
- **Buckets:** `LO = market_total < 7`, `MID = 7 ≤ market_total ≤ 9`,
  `HI = market_total > 9`.
- **Park class:** extreme = home team's `WOBA_PARK_FACTORS` deviates
  >3% from 1.00. That set is `COL, ATH, CIN, ARI, CHC, BOS, TB, NYM, SEA, SD, SF`
  (11 teams). The brief listed `COL/ATH/SEA/SD`; the code's calibrated
  threshold catches 7 more but doesn't change the shape of the finding.
- **Signals:** `model.getSignals` → Over/Under Total signals, then
  `model.calcPnl` for hypothetical W/L on resolved games.
- **Setting note:** `PARK_NEUTRAL_INPUTS_ENABLED = false` in
  production. The audit-era park-neutralization branch is **not** live;
  the actuals-only correction (PR #144 §1.1) is gated behind this
  flag. So "the park fix" as a live model change did not happen the way
  the brief implied — see Discussion below.
- **Script:** `tmp/remeasure-totals-gap.js`. Run:
  `<node20> tmp/remeasure-totals-gap.js`.

## Result 1 — audit's Over over-projection is GONE

**Pre-fix (audit §1.3):** Model mean 8.7 vs market 7.9 (**+0.8 runs high**);
Overs -8.6% ROI (75 signals); Unders -1.1% ROI (143 signals).

**Today (mid-range, all parks):**

| | n | mean market | mean model | mean actual | model − market | actual − market |
|--|--:|--:|--:|--:|--:|--:|
| LO (<7) | 29 | 6.50 | 7.06 | 7.38 | **+0.56** | +0.88 |
| MID (7–9) | 598 | 8.04 | 7.72 | 8.62 | **−0.33** | +0.58 |
| HI (>9) | 141 | 9.80 | 8.97 | 10.33 | **−0.83** | +0.52 |

**Direction flipped.** Model now **under-projects** mid-range totals by 0.33 runs
(was over by 0.8). Signal ROI reflects the reversal:

| Bucket | Over ROI | n | Under ROI | n |
|--|--:|--:|--:|--:|
| MID all | **+1.9%** | 88 | −1.4% | 269 |
| MID neutral | **+8.8%** | 54 | −5.0% | 193 |
| MID extreme | −9.9% | 34 | +7.7% | 76 |
| HI  all | +73.3% | 7 | −6.4% | 85 |
| HI  extreme | +69.3% | 6 | −21.5% | 32 |

Overs at mid-range went from −8.6% (loser) to +1.9% aggregate / +8.8% on
neutral parks. The Over over-projection finding is **substantially resolved.**

## Result 2 — gap shape is NON-uniform (slope-like, not offset)

Gap spread across market buckets: **1.39 runs** (LO +0.56 → HI −0.83).

- **LO:** model **over**-projects by +0.56 (small n=29)
- **MID:** model **under**-projects by −0.33
- **HI:** model **under**-projects by −0.83

The model has a **flatter scoring slope than the market:** as market total grows,
model total grows less. This is a *slope* problem, not a constant bias. TOT_SLOPE
tuning would not fix it — TOT_SLOPE only scales the (estTot − mkt) run-differential
into edge; the projection gap itself lives in the wOBA→runs pipeline (RUN_MULT
+ park + weather + relief blend).

## Result 3 — park class does NOT explain the mid-range gap

| Class | MID gap (model − market) | MID actual − market |
|--|--:|--:|
| All parks | −0.33 | +0.58 |
| Extreme parks | −0.26 | +0.39 |
| Neutral parks | **−0.36** | +0.67 |

Neutral parks show a *slightly larger* mid gap than extreme parks — the
opposite of what a "park calibration explains it" story would predict.

Top per-team home gap magnitudes are dominated by **neutral parks:**

```
LAA  (0.98)  n=27  −1.08
BAL  (0.99)  n=28  −1.04
MIN  (0.99)  n=28  −0.93
WAS  (1.00)  n=28  −0.80
MIL  (0.99)  n=27  −0.72
TB   (0.97)  n=27  −0.72
KC   (1.01)  n=27  −0.70
CLE  (0.98)  n=26  −0.66
COL  (1.10)  n=24  −0.65
LAD  (1.00)  n=25  −0.64
```

Nine of the top 10 outliers are league-average parks (wobaPF 0.97–1.01).
Whatever's compressing model totals is not park-related.

## Result 4 — market itself is low; both model and market under-forecast reality

Actual scoring is **above** market across all buckets (+0.88 / +0.58 / +0.52).
2026 has run hotter than the market's opening lines. The model tracks the same
under-forecast direction as the market but goes further, especially at high totals.

This means the current Under signals in HI-neutral parks (n=53, +1.9% ROI) and
Unders on extreme HI parks (n=32, **−21.5% ROI**, −$740 PnL) are the model's
new weak leg — a slope problem, not an over-projection problem.

## Signal population summary

| Bucket × class | Over signals | Under signals |
|--|--:|--:|
| MID / all | 88 | 269 |
| MID / neutral | 54 | 193 |
| MID / extreme | 34 | 76 |
| HI  / all | 7 | 85 |

Under signals outnumber Overs ~3:1 at mid, ~12:1 at high. Under-projection
of high-total games mints the Under bias.

## Decision

**Neutral-park mid-range gap: |−0.36| runs.** Falls in the "partial" band
(0.2 ≤ |gap| < 0.4). Under the brief's decision rules:

- **NOT ≥ 0.4:** so this pass does not conclude "TOT_SLOPE / totals
  construction needs work" as a MID-range priority.
- **NOT < 0.2:** so we can't call the audit finding fully closed
  either — the gap is still measurable, it just flipped sign.

**Recommendation this pass: no tuning.** Reasons:

1. The audit's **specific concern** (mid-range Overs bleeding at −8.6% ROI on
   an over-projecting model) is resolved. Overs are now +1.9% aggregate /
   +8.8% on neutral mid. The volume of Over signals (88 mid) is also down
   substantially from the audit's 75-over-in-mid (the audit measured a shorter
   window; still, the audit population was more over-tilted).
2. The new pattern — **HI-bucket under-projection driving losing Unders** —
   is a distinct finding, not a residual of the audit's finding. It is a
   slope problem in the run-generation math (or an interaction with the
   opener-detection changes shipped in PR #148–150 that raised opener/
   bulk weights and lowered SP innings, potentially dropping projected
   scoring). Chasing it needs its own investigation, not a TOT_SLOPE knob.
3. **PARK_NEUTRAL_INPUTS_ENABLED is off** — so the audit's "park fix
   plausibly explains it" hypothesis in the brief was based on a wrong
   premise about what shipped. The input-neutralization branch never
   went live in production; PR #144 fixed the way that branch would
   behave IF it were on. The audit-era over-projection resolved from
   other changes (most likely PR #144's SP-null → 0.62 fix, PR #148/149
   opener-detection tightening, PR #150 SP-SP tandem split).

**Follow-up (out of scope for this pass, but worth noting):**

- The HI-bucket under-projection is a real, larger gap (−0.83 on all, −1.20
  on neutral HI). If Under signal ROI degrades further next month it may
  warrant a dedicated look — likely in `services/model.js` `estTot`
  assembly around lines 800–890 (`aRuns + hRuns + windRunAdj + tempRunAdj`),
  or upstream in per-batter run scoring.
- Investigate whether PR #148–150's opener changes reduced projected SP
  innings materially — this pass didn't isolate that lever.

## Files

- Script: `tmp/remeasure-totals-gap.js` (read-only, run with node 20).
- Raw output: captured in the commit-message body when this doc was pushed.
