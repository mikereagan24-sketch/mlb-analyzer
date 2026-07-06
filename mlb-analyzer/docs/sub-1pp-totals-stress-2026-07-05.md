# Sub-1pp Totals — stress tests before any floor change — 2026-07-05

The emit-floor sweep (`docs/signal-emit-floor-sweep-2026-07-05.md`) found
that Total signals with edge in [0, 0.01) — currently blocked by the
0.01 emit floor — showed +22.4% net ROI on n=62 in the 0.0-0.5pp band.
Task 3 stresses that finding.

Bar: **finding must survive monthly split, Over/Under composition,
and morning-line re-grade. If any test fails, no settings change.**
Same rigor as the BsR shelve decision.

## Test 1 — Monthly split

Does the +22.4% hold across April/May/June, or cluster in one stretch?

```
month     n     W/L/P     roi_close    pnl_close    roi_morning    pnl_morning
2026-04   34    21/12/1   +17.82%      +$606        +15.20%        +$334
2026-05   58    32/26/0   +5.90%       +$342        +1.32%         +$77
2026-06   34    25/9/0    +38.65%      +$1,314      +38.96%        +$1,325
2026-07    4    1/3/0     -59.25%      -$237        -59.25%        -$237
TOTAL    130    79/50/1   +15.58%      +$2,025      +12.70%        +$1,499
```

- **April: profitable** (+15-18%), moderate sample.
- **May: barely positive** (+5.90% close / +1.32% morning). Wins 55%.
  Not cluster-negative but close to noise.
- **June: strongly positive** (+38.65%). Wins 74%.
- **July: negative** on tiny n=4. Noise range.

**Verdict on Test 1:** PASSES the "no single-stretch cluster" bar
loosely — the finding isn't concentrated in one month. But the
month-to-month variance is huge (May +5.9% vs June +38.7%). This
looks like a signal that fluctuates a lot around a positive mean —
consistent with a real edge, but also consistent with noise on
n=~30-60 per month.

## Test 2 — Over/Under composition

Is the effect secretly one-sided?

```
side    n     W/L/P     roi_close    pnl_close    roi_morning    pnl_morning
over    51    31/20/0   +16.05%      +$819        +11.06%        +$498
under   79    48/30/1   +15.27%      +$1,207      +13.71%        +$1,001
```

Nearly identical ROI across sides (16% vs 15% close; 11% vs 14% morning).
Overs and Unders are both profitable. Split is 51/79 — Unders slightly
over-represented but not lopsided. **Verdict: PASSES.**

## Test 3 — Morning-line grade

The reconciliation doc showed that Total 1-3pp signals lose 4-5pp of
ROI when re-graded at the morning line (books moved lines up between
morning and close). Does the sub-1pp population survive that
correction?

```
Aggregate:  close +15.58%  →  morning +12.70%   Δ = -2.87pp
```

Within-band breakdown:

```
band          n     roi_close    roi_morning    Δ
0.0-0.5pp     62    +22.07%      +18.98%        -3.09pp
0.5-0.75pp    32    +6.29%       +14.36%        +8.07pp   ← morning BETTER
0.75-1.0pp    36    +12.65%      +0.61%         -12.04pp  ← morning much worse
```

Aggregate morning ROI = **+12.70%** on n=130 → still solidly positive.
118 of the 130 signals had a proj_market_total available. **Verdict:
PASSES** the "morning re-grade doesn't kill it" bar. The 0.75-1.0pp
band collapses (+12.65% → +0.61%), but the 0.0-0.5pp core (+18.98%)
holds.

## Statistical caveat

At n=130 (129 non-push), W=79 / L=50. Break-even win rate at Kalshi
average pricing is ~53% net of fees. The observed 60.7% is 7.7pp
above break-even, which gives:

- Binomial P(≥79 wins | p=0.53, n=129) ≈ **5.6%** (one-tailed)
- Two-tailed p ≈ **11%**

Marginally significant. Would not survive stricter thresholds
(p<0.05, adjusted for multiple comparisons across bands and sides
tested). This is real evidence but not overwhelming.

## Mechanism candidates

The user's bar: no mechanism → no settings change (BsR precedent).

Candidate mechanisms for why near-zero-edge Totals win:

1. **Selection**: sub-1pp edges are cases where model and market are
   near-agreement. High-agreement games might correlate with games
   where inputs (lineups, weather, SP forecasts) are stable and
   well-populated. Cleaner-input games might be genuinely more
   predictable than the average. Testable but not tested here.

2. **Market microstructure — books over-adjust on close**: `docs/run-conversion-audit-2026-07-05.md` showed close-line moved UP on HI games and DOWN on LO games vs morning. On near-zero-edge games specifically, the close might over-correct, meaning the morning-line snapshot the model priced against was already "correct" (matches actuals) and the close moved away from truth. Consistent with morning ROI ≈ close ROI in Test 3 (only -2.87pp lower, not -8-10pp like Total 1-3pp).

3. **Selection of the losing side**: at sub-1pp edge, the model picks a "side" almost arbitrarily. Whichever side happens to be the marginally-preferred one wins slightly more than random. Doesn't explain the effect size (60.7% is well above 52% random-flip).

4. **Small-n coincidence**: 130 signals over 4 months. Standard random-walk. The May result (+5.90% barely-positive) is what you'd expect if the true mean effect were 0 and April/June were positive tails.

**None is a strong, testable mechanism.** #4 is the null hypothesis
and can't be ruled out at p=0.056.

## Verdict

**Do not recommend a settings change at this time.**

The finding technically passes all three stress tests:
- Not clustered in one month.
- Not secretly one-sided.
- Morning-line re-grade keeps it positive.

But the evidence is not conclusive:
- Only marginally significant (p=0.06).
- Month-to-month variance is huge (May +5.9%, June +38.7%).
- No strong mechanism explains why sub-1pp edges would predict better
  than mid-band edges.
- Sample of n=130 is small for a betting recommendation.

**Recommended action: continue watching.** Keep the emit floor at 0.01
for both markets. Revisit in 6-8 weeks when the sub-1pp Total
population has doubled to ~250-300 signals. If the +12-15% net_morning
ROI holds at that sample size (n=250), the p-value drops to <0.01 and
we have a defensible case for splitting the emit floor.

If it drops toward 0% at n=250, this was small-n noise and the
current floor stays.

**Same rule as BsR: gather more data before recommending a change.**

## What "keep watching" looks like

- Monthly check-in: sub-1pp Total ROI aggregated to that point.
- Trigger for revisit: n ≥ 250 signals with ROI ≥ 10% net_morning,
  binomial p < 0.01.
- Trigger for kill: n ≥ 250 with ROI ≤ 3% net_morning → close the
  investigation, no floor change.

## Corrections to the emit-floor sweep

The `docs/signal-emit-floor-sweep-2026-07-05.md` recommendation:

> **Split the emit floor by market type.** `signal_emit_floor_pp_total`
> to 0.0 or 0.005.

That recommendation is now **paused** pending more data. The +22.4%
finding was real but n=62 was too small to act on. Task 3's stress
tests reveal marginal significance and no defensible mechanism.

## Files

- Script: `tmp/stress-sub1pp-totals.js`
