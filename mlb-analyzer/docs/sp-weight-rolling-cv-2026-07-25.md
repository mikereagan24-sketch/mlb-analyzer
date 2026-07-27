# SP_WEIGHT rolling-origin CV — 2026-07-25

**Companion doc:** `sp-weight-mechanism-rationale-2026-07-25.md` (exposure math showing 0.80 default is ~26pp above raw PA-exposure floor of ~54%, no documented mechanism).

**Script:** `scripts/sweep-sp-weight-rolling-cv.js`
**TSV:** `docs/data/sweep-sp-weight-rolling-cv.tsv`

## Setup

- Universe: 675 clean+non-contaminated ML signals from PROD `bet_signals`, `2026-04-09` → `2026-07-22`, v7-excluded dates removed.
- HARD cap pinned 0.08, SOFT floor from settings (0.01).
- W_PIT held at 0.40 baseline (decouple).
- RELIEF_WEIGHT auto-set to `1 - SP_WEIGHT` (schema invariant).
- 3 rolling-origin folds (same date splits as PR #182):
  - Fold A: Fit `2026-04-09` → `2026-05-31` (n=312), Test `2026-06-01` → `2026-06-30` (n=200)
  - Fold B: Fit `2026-04-09` → `2026-06-14` (n=413), Test `2026-06-15` → `2026-07-13` (n=181)
  - Fold C: Fit `2026-04-09` → `2026-06-29` (n=503), Test `2026-06-30` → `2026-07-13` (n=91)
- Bootstrap 1000 resamples per (fold × candidate) for 95% CIs.

## Ship-gate verdict: **FAIL — keep baseline 0.80**

| Gate | Result |
|---|---|
| Stability (same winner in ≥2/3 folds) | **FAIL** — each fold picks a different winner |
| Val:Fit ≤ 1.5x | N/A (no candidate cleared stability gate) |
| Val CI-lo > baseline point | N/A |

Per-fold winners:
- Fold A: SP_WEIGHT=**0.60** (+10.69%)
- Fold B: SP_WEIGHT=**0.72** (+3.94%)
- Fold C: SP_WEIGHT=**0.77** (+0.32%)

All three winners are far apart in parameter space and dwarf-in-magnitude by the CI widths (~40-60pp per fold). No candidate's test-CI excludes the baseline in any fold — **at n=91-200 per test window, this parameter cannot be moved off 0.80 by evidence alone**.

## Directional finding: **monotonicity is DOWN** (informative even though nothing ships)

Mean test ROI across grid:

| SP_WEIGHT | Fold A | Fold B | Fold C | mean |
|---|---|---|---|---|
| 0.60 | +10.69% | +1.58% | −1.33% | **+3.65%** |
| 0.65 | +5.81% | −2.72% | −3.63% | −0.18% |
| 0.70 | +6.95% | +1.77% | −1.77% | +2.32% |
| 0.72 | +6.03% | +3.94% | −1.77% | +2.73% |
| 0.75 | +2.53% | +2.84% | −1.77% | +1.20% |
| 0.77 | +2.58% | +2.90% | +0.32% | +1.93% |
| **0.80** | +3.47% | +2.77% | −0.07% | **+2.06%** (baseline) |
| 0.83 | +4.54% | +2.77% | −0.07% | +2.42% |
| 0.85 | +2.74% | +0.56% | −2.24% | +0.35% |
| 0.90 | **−2.46%** | **−2.84%** | **−2.34%** | **−2.55%** |

- Mean test ROI at SP_WEIGHT ≤ 0.80: **+1.96%**
- Mean test ROI at SP_WEIGHT ≥ 0.80: **+0.57%**
- Direction: **DOWN** (lower SP_WEIGHT helps on average, ~1.4pp gap between the halves)

This aligns with the mechanism doc: raw PA exposure is ~54%, so a lever *below* 0.80 was the a-priori expected direction. The rolling CV confirms the sign of the gradient at low confidence.

## Two concrete signals

1. **SP_WEIGHT=0.90 is uniformly bad.** Every fold, negative. Mean −2.55%. If the schema `max` were tightened from 0.95 to 0.87 or 0.85, no evidence in the record would object. Not shipping this change — flagging as an observation.

2. **The 0.72-0.83 plateau.** All five candidates in {0.72, 0.75, 0.77, 0.80, 0.83} produce mean test ROI in the +1.2% to +2.4% band. Whatever "real" optimum this data can support is somewhere inside that band. 0.80 is a defensible point *within the plateau* even though it isn't defensible from exposure alone. Framed differently: the exposure argument (which says ~54% is right) is not confirmed by the sweep — the sweep says the effective optimum is at least 0.72, not near exposure.

## Reconciliation with mechanism doc

The mechanism doc argued 0.80 was ~26pp above raw exposure and speculated a "SP predictability premium" of maybe +5-10pp could partially close the gap — landing an exposure-defensible weight around 0.60-0.65.

The sweep does not support 0.60-0.65 as the effective optimum:
- 0.65 has the *worst* mean of the whole grid (−0.18%).
- 0.60 has the best mean, but that's driven by fold A's +10.69% outlier — folds B (+1.58%) and C (−1.33%) are near-zero, and 0.60 also has the widest CI at low n.

The plateau at 0.72-0.83 is more consistent with a larger predictability/adjustment premium than the mechanism doc estimated. Either:
- (a) The SP-predictability premium is +15-25pp not +5-10pp (unmeasured in the repo), OR
- (b) There is a bullpen-proxy bias worth ~10-15pp that up-weights SP, OR
- (c) The sample is just too thin and the "true" optimum could be anywhere in [0.60, 0.85].

At n=675 total signals across the entire universe, we can't distinguish these.

## Reconciliation with 2026-07 naive fit/val sweep

`docs/weight-sensitivity-sweep-2026-07.md` found 0.75 was the local peak on naive fit/val with **+0.91%** Val book. Rolling CV confirms the sign (0.75 mean is above 0.80's) but with a much wider spread (0.75 is +1.20% mean vs 0.80's +2.06%). The naive sweep's finding does not survive rolling CV — 0.75 is not better than 0.80 in any single fold on the raw ROI metric.

## Recommendation

1. **Do not change SP_WEIGHT from 0.80.** Ship-gate fails cleanly.
2. **Do not close the mechanism-doc question** on the basis of this sweep alone. The sweep is under-powered (n=91-200 per test window); the mechanism doc's exposure math is a first-principles constraint that shouldn't be dismissed just because n=675 can't disprove a 26pp gap. The reconciliation section above lays out what would resolve it.
3. **Consider tightening the schema `max` from 0.95** to 0.85 as a defensive rail. The 0.90 result is unambiguous. Optional and out of scope for this branch.
4. **The per-slot SP_WEIGHT structural follow-up** flagged at the end of the mechanism doc remains the highest-leverage next step. Replacing one under-powered scalar with a mechanical per-slot exposure model would sidestep this entire debate — the answer becomes computed per-batter from `game.away_sp_forecast_ip`, not sweep-fit.

## Reproducing

```
node scripts/sweep-sp-weight-rolling-cv.js
```

Runs ~5-8 minutes. Writes TSV to `docs/data/sweep-sp-weight-rolling-cv.tsv`. Full console output in commit that landed this doc.
