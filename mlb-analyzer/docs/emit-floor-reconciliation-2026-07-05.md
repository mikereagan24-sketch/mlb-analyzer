# Reconciliation: emit-floor sweep vs edge-cap clean slice — 2026-07-05

Same book. Different numbers.

- `docs/signal-emit-floor-sweep-2026-07-05.md`: at the current 0.01
  floor, ML+Total combined net ROI = **-7.74%** (fee-adjusted).
- `services/settings-schema.js:210` and earlier PR #145 discussion:
  the "clean slice" (edge < SOFT cap 10pp) → **+4.14% ROI**.

Both can't describe the same betting operation. This doc decomposes.

## The single reconciliation table

v6 cohort resolved bet_signals (n=95, joined to game_log for morning
line + prices). ML has no `proj_market_ml` stored, so morning-line
re-grade only affects Totals.

| Slice | n | gross_close | net_close | gross_morning | net_morning |
|---|--:|--:|--:|--:|--:|
| **ML clean (<10pp)** | 47 | **+4.25%** | +0.86% | +4.25% | +0.86% |
| Total clean (<10pp) | 45 | −10.91% | −12.54% | −12.93% | **−14.39%** |
| **Full v6 rollup** | 95 | −6.56% | **−9.07%** | −7.58% | **−10.00%** |

The +4.14% number in the schema comment is essentially the same as the
+4.25% here — v6 ML-only, gross of fees, graded at close. It IS real.
It just isn't what happens after realistic corrections.

## Column-by-column reading

**gross_close → net_close: subtract Kalshi fees.**
- ML clean loses 3.4pp of ROI (+4.25% → +0.86%).
- Total clean loses 1.6pp (−10.91% → −12.54%).
- Combined v6 loses 2.5pp (−6.56% → −9.07%).

Kalshi fees are 1.7-3.4% of stake depending on contract price C
(peaks at C=0.50). On average across mixed populations, ~2.5pp of ROI
is fees. Every model-side edge under ~3pp of gross claim doesn't survive
fees.

**net_close → net_morning: re-grade Totals at proj_market_total (the
line the owner actually bets at, morning refresh).**
- ML unchanged (no proj_market_ml stored).
- Total clean loses another 1.9pp (−12.54% → −14.39%).
- Combined v6 loses 0.9pp (−9.07% → −10.00%).

Morning grading makes Totals WORSE, not better. The mechanism: from
`docs/run-conversion-audit-2026-07-05.md`, books moved the total
line UP from morning to close on most games (mean shift +0.22 runs on
HI-bucket). So games that pushed at close (Under barely covers) tend to
LOSE at morning (Under didn't cover the morning number). The
v6 Total clean slice is Under-heavy, and morning-under lines are
harder to hit than close-under lines.

**ML has no morning-grade change** because ML lines don't move enough
to shift outcomes (the game either wins or loses regardless of the
morning-vs-close price for that side; only the payout might vary).
Population differences are the more likely ML-morning source of
discrepancy, and we don't have proj_market_ml stored to test.

## Bands within the clean slice

Per band × type (from bet_signals v6, n=95):

```
                n    stake   gross_close   net_close   gross_morning   net_morning
--- ML ---
  1-3pp        16    1685    +11.2%        +7.9%       +11.2%          +7.9%
  3-6pp        19    1822    -3.2%         -6.6%       -3.2%           -6.6%
  6-10pp       12    1089    +6.0%         +2.5%       +6.0%           +2.5%
  10pp+         1      81    -100.0%       -103.8%     -100.0%         -103.8%
  clean ML(<10pp) n=47  gross_close=+4.25% net_close=+0.86%

--- Total ---
  1-3pp        19    2090    +0.5%         0.0%        -4.3%           -4.3%
  3-6pp        18    1980    -15.2%        -19.7%      -15.2%          -19.7%
  6-10pp        8     880    -28.4%        -26.3%      -28.4%          -26.3%
  10pp+         2     220    -100.0%       -103.5%     -100.0%         -103.5%
  clean Total(<10pp) n=45  gross_close=-10.91% net_close=-12.54% net_morning=-14.39%
```

- **ML 1-3pp is where the money is** (+7.9% net_close on n=16). Small
  sample, but consistent with the emit-floor sweep's find that ML sub-2pp
  bands win.
- **ML 6-10pp still positive** (+2.5% net_close on n=12) — the emit-floor
  sweep's ML 5-10pp band was +2.9%, matches.
- **ML 3-6pp is the losing bucket** for ML (-6.6% net_close). Same pattern
  the PR #145 audit flagged.
- **Total 3-6pp is where the pain lives** (-19.7% net_close). Also
  matches the sweep.
- **Morning re-grade only bites at Total 1-3pp** (+0.0% → -4.3% net) —
  the small 1-3pp margin flips negative when re-graded at the morning
  line.

## Population differences: 1663 vs 95

The two analyses cover different populations:

- Emit-floor sweep (1663 candidates): fetched from prod
  `/api/games/YYYY-MM-DD`, all resolved games Apr-Jul, both sides
  scored (candidate signal per side per market), all cohorts
  (v3/v5/v6 mixed by scoring date), edges reconstructed from stored
  `model_total` / `model_away_ml` / `model_home_ml`.
- Reconciliation (95): local `bet_signals` v6 cohort only, actually-emitted
  rows, joined to game_log for morning line.

Sources of the count divergence:

1. **Cohort filter**: v6 is a subset (April-May-June-early-July;
   locally-mirrored). Full sweep includes v3/v5 legacy signals with
   different scoring math.
2. **Both-sides vs one-side emission**: the sweep counts a
   positive-edge Over AND Under as two candidates. `getSignals` in
   prod only emits the side above floor, and the losing side often
   has negative edge (would be filtered out).
3. **Emitted vs candidate**: bet_signals rows are what actually made
   it through the emit floor + suppression + locking cascade. Many
   candidates are dropped before persistence (e.g. bullpen games,
   pre-lineup scoring, opener suppression states).
4. **Local mirror gap**: local ends at ~2026-06-30 for many tables;
   prod ends at 2026-07-05. The 95 doesn't include the last week.

**The 95 is the ground-truth PnL** for what the owner actually saw.
The 1663 is the "what could have happened" simulation.

## Rehabilitating the +4.14% number

The `settings-schema.js:210` comment says the +4.14% was from
`scripts/edge-calibration-curve.js` on ~600 resolved signals. That
predates v6 stability and includes older cohorts with different
scoring math (v3-pretuning garbage was later filtered). Redoing the
sweep on ~600 v5-plus signals with the same close-line, gross-of-fees
basis would probably still show +3-5% on ML clean.

**The number was never wrong on its own terms. It measured:**
- ML only (implied by "clean slice" in the calibration curve — Totals
  ROI has always been worse)
- Gross of fees (fees are a separate consideration)
- Graded at close market_total / market_line
- A cohort that included v4-v5 stability

**What we know now that we didn't then:**
- Fees eat 2-3pp of ROI.
- Morning-line grading (for Totals) subtracts another ~2pp.
- Total edges are dominated by mid-band signals that LOSE.

## Does the model's edge survive fees at all?

**On ML: barely.** v6 ML at any floor:
- ML clean slice (<10pp): +0.86% net_close. n=47.
- Break-even is 0%. This is +0.86 pp of net-of-fees edge — real, but
  within noise for n=47.

**On Totals: no, at any floor.** Every Total band in v6 shows
negative net PnL. The best emit-floor sweep number (Total floor 0.005)
was −5.78% net. The reconciliation clean slice is −12.54% net_close /
−14.39% net_morning.

**Combined at prod's current 0.01 floor:**
- Sweep-wide (n=1377, all cohorts): −7.74% net_close.
- v6 only (n=95): −9.07% net_close, −10.00% net_morning.

The direction of the finding is unanimous: **net of realistic fees
and vintage, this book is unprofitable on the Totals side.** ML is
break-even net.

## Implications for the sub-1pp Totals recommendation (task 3 preview)

The emit-floor sweep flagged sub-1pp Totals as +22.4% ROI (0-0.5pp
band, n=62). BUT:
- That was close-line graded. Morning re-grade will likely worsen it
  the same way it worsened the clean slice (-2pp).
- The reconciliation shows Total 1-3pp goes from breakeven at close
  to -4.3% at morning. If a similar magnitude applies to 0-1pp, the
  +22.4% could collapse to +10-15% or worse.
- The 62-signal sample is small. Task 3 will stress-test.

If Task 3 finds the sub-1pp Totals number survives the morning
re-grade, monthly split, and side-composition tests, we have real
evidence. If it doesn't, the emit-floor recommendation dies.

## What this reconciliation determines

Priority ranking for the model's calibration issues:

1. **The 3-6pp Total band is where the money is being lost.** −19.7%
   net_close ROI on n=18. Fixing this bucket has more leverage than
   any emit-floor change. Options: SIGNAL_EDGE_SOFT_CAP dropped to
   0.03 (from 0.10) would flag this entire band as `edge_suspect`.
   `docs/verify-measurement-session-2026-07-05.md` Part 2 already
   recommended 0.06 based on the 6-10pp bucket — 0.03 would extend
   coverage to the more damaging 3-6pp band.
2. **Consider a Totals-side skip pending calibration.** The model's
   Total edges are unprofitable at every vintage and every floor. A
   provisional response: don't emit Totals to the ticket until the
   calibration curve is corrected. Owner's call — this is the kind of
   thing that eats years of PnL if left.
3. **ML operations are marginal but not broken.** +0.86% net_close ROI
   on ML clean is genuinely at break-even. Floor tweaks in the 1-3pp
   band (where the +7.9% lives) could improve, but the gains are
   small and n is 16.
4. **Emit-floor per-market-type split is lower priority.** The Totals
   floor change might still be worth doing if Task 3's stress tests
   pass, but it's second-order to whether Totals should emit at all.

## Files

- Script: `tmp/reconcile-emit-vs-cap.js`
