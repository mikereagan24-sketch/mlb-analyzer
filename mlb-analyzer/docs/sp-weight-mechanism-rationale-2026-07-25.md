# SP_WEIGHT (0.80) — mechanism analysis

**Date:** 2026-07-25
**Scope:** the batter-side SP-vs-bullpen weight used in `services/model.js perBatterEW` (line 502):

```js
const batW = vsStart * spW + vsOpp * relW;
```

Where `spW` = `SP_WEIGHT` (default 0.80) and `relW` = `RELIEF_WEIGHT` (default 0.20). This is the fraction of the batter's per-slot wOBA equation that uses their vs-starter-hand splits (`batter.vsRHP` if SP is R, else `batter.vsLHP`) vs their vs-opposite-hand splits (bullpen proxy).

**`BAT_HAND_SP` note.** Legacy alias for the same lever. `services/parameter-sweep.js:119` maps `BAT_HAND_SP → SP_WEIGHT` at override time. Not a separate parameter.

## Question: is 0.80 defensible from exposure alone?

**Short answer: no.** Realistic PA exposure across a season implies **~54%** SP share, not 80%. The 0.80 default overweights the starter by **~26pp of actual exposure**.

## The math

MLB starters face batters in order. If an SP faces N total batters starting with slot 0, slot i sees `ceil((N - i) / 9)` PAs vs the SP (0 if `N ≤ i`). Total PAs per slot come from `PA_WEIGHTS` in the model (`[4.65, 4.55, 4.5, 4.5, 4.25, 4.13, 4.0, 3.85, 3.7]`). Bullpen picks up the residual.

**Per-slot SP share varies dramatically with SP length.** For a 6-IP outing (~24 batters faced), an average lineup gets:

| Slot | SP PAs | Total PAs | SP share |
|---|---|---|---|
| 1 | 3 | 4.65 | 64.5% |
| 2 | 3 | 4.55 | 65.9% |
| 3 | 3 | 4.50 | 66.7% |
| 4 | 3 | 4.50 | 66.7% |
| 5 | 3 | 4.25 | 70.6% |
| 6 | 3 | 4.13 | 72.6% |
| 7 | 2 | 4.00 | 50.0% |
| 8 | 2 | 3.85 | 51.9% |
| 9 | 2 | 3.70 | 54.1% |

Range: 50% (bottom of order) to 73% (mid-order). The single `SP_WEIGHT` parameter can't capture this variation — it's a slot-invariant approximation of a slot-varying reality. That's a structural limitation of the model, orthogonal to whether 0.80 is the right *average* value.

## Aggregate SP share across realistic SP-IP distribution

Weighted average across the 2024 MLB starter-outing distribution:

| SP outing | Batters faced | Slot-frequency weight | SP share |
|---|---|---|---|
| < 4 IP | 13 | 15% | ~34% |
| 4–5 IP | 17 | 20% | ~45% |
| 5–6 IP | 21 | 30% | 55.1% |
| 6–7 IP | 25 | 25% | 65.5% |
| 7+ IP | 28 | 10% | 73.4% |

**Frequency-weighted SP share = 54.3% (raw), 54.4% (wOBA-quality-weighted).**

The wOBA quality weighting barely moves the answer because `PA_WEIGHTS` and the wOBA gradient are both top-heavy — the "top of the order faces the SP more AND matters more per PA" effect is double-counted between `SP_PAs[i]` and the weighting factor, so they largely cancel.

## Why the naive framing is wrong

A common defense of high SP_WEIGHT: "starters face the top of the order 3+ times, so weight them heavily." But this argument is already baked into `PA_WEIGHTS` (top slots have 4.65 PAs vs 3.70 for the 9-hole). When you compute the properly-weighted average — either by PA importance or by expected batter wOBA — the numbers converge to ~55%. The top-of-order-matters-more effect doesn't push the answer up from 55% to 80%. It moves it by ~0.3pp.

## What could justify 0.80

Three plausible mechanisms that would push the effective weight above raw exposure. **None are documented in this repo** (grep of every SP_WEIGHT reference: schema help text is bare `"SP weight in run estimation."`; no comment in `services/model.js`; no historical decision doc).

**1. SP predictability premium.** A named starter's per-hand wOBA is a single-pitcher signal with hundreds of TBF; the bullpen "vs-opposite-hand" proxy is an aggregate over ~8 relievers each with 20-50 TBF against that side. Higher-signal weight goes to the SP not because he faces more PAs, but because the estimate is tighter. Magnitude: plausibly worth +5-10pp over raw exposure. Would land SP_WEIGHT around 0.60-0.65, not 0.80.

**2. Bullpen wOBA is systematically biased.** The `vsOpp` term uses the batter's vs-opposite-hand split as a bullpen proxy, but real bullpens often lean same-hand for platoon matchups (LOOGYs against LHBs, etc.). If the proxy under-weights actual bullpen difficulty, up-weighting the SP compensates. Plausible but hand-wavy — no evidence in the repo that this mechanism was measured. Also: bullpen wOBA is separately averaged into the pitching-side term (`pitW = pitWvsBatter * spPitW + bullpenWoba * relPitW`), so double-counting the same correction on the batter side is architecturally awkward.

**3. Historical calibration finding.** Some pre-git-history sweep landed 0.80 as backtest-optimal. If true, there's no paper trail. The most recent sweep on record (`docs/weight-sensitivity-sweep-2026-07.md`) tested 0.70/0.75/0.80/0.85/0.90 and found **0.75 was the local peak** at +0.91% Val book vs baseline −3.13% (delta +4.04pp Val, +9.17pp on the 1-2pp band). 0.80 was NOT the peak in the most recent measured evidence.

## What we know

| Value | Source | Confidence |
|---|---|---|
| ~54% | Raw PA exposure math (this doc) | High — first-principles from the SP-outing distribution |
| ~60-65% | Exposure + reasonable SP-predictability premium | Speculative — magnitude not measured |
| 0.75 | Sweep peak (naive fit/val, `weight-sensitivity-sweep-2026-07.md`) | Moderate — n=45 val, no rolling-CV yet |
| 0.80 | Current schema default | **Undocumented** — no mechanism or calibration reference in the repo |

## Recommendation

The 0.80 default is not defensible from exposure alone and has no documented mechanism. The gap between exposure (~54%) and default (0.80) is 26pp — larger than the "SP predictability" premium can plausibly cover (~5-10pp).

**Two actions:**

1. Run a proper rolling-CV sweep on `SP_WEIGHT` in isolation (see `scripts/sweep-sp-weight-rolling-cv.js` alongside this doc). If the CV shows a stable winner materially different from 0.80, that's ship-actionable. If nothing clears the CV gates, that's still informative: it means the parameter is under-powered at current sample size and the 0.80 default persists by default of counter-evidence, not by defensibility.

2. Consider whether `SP_WEIGHT` should be **per-slot** rather than global — computed from `game.away_sp_forecast_ip` (already available on `game_log` per `services/model.js:494`) times an outing-to-batters map, times the per-slot `SP_PA[i]` formula in this doc. Would replace one under-powered scalar with a mechanical model of actual exposure. Out of scope for this doc; noting as a structural follow-up.

## Data used

- `PA_WEIGHTS`: `[4.65, 4.55, 4.5, 4.5, 4.25, 4.13, 4.0, 3.85, 3.7]` (from `services/settings-schema.js` default and confirmed in prod `app_settings`)
- 2024 SP-IP distribution: approximate from public MLB pitching leaderboards, bucketed by outing length. Not season-2026 data — the distribution has been stable within a few percentage points year over year.
- Realistic wOBA gradient: `[.340, .335, .335, .335, .330, .325, .315, .305, .295]` — rough NL/AL lineup shape. Result is insensitive to the exact numbers (quality-weighted vs raw shifts by <0.5pp).

## Reproducing

Run the inline math in `tmp/verify-sp-weight-mechanism.js` (or the block in the commit that landed this doc). Outputs the per-slot SP share for four SP-IP scenarios and the frequency-weighted aggregate.
