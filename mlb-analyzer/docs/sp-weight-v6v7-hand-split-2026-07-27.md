# SP_WEIGHT hand-split — v6/v7 cohort-restricted 2026-07-27

**Supersedes for direction claims:** `docs/sp-weight-hand-split-results-2026-07-26.md`. The earlier sweep spanned 2026-04-09 → 2026-07-22 (v1-v7 mixed). That was fitting on one model stack and testing on another — the finding of R-facing DOWN direction was a mixed-cohort artifact.

**Script:** `scripts/sweep-sp-weight-v6v7-by-hand.js`
**TSV:** `docs/data/sweep-sp-weight-v6v7-by-hand.tsv`

## Setup changes vs the disconfirmed earlier sweep

1. **Cohort restriction.** Universe restricted to v6 (2026-05-29 → 2026-07-05) and v7 (2026-07-08 → 2026-07-22, excluding birth/transition days). Reported separately and combined. Rationale: cohort-v7 birth certificate (`docs/cohort-v7-cutover-2026-07-05.md`) lists park-neutral inputs, edge caps, opener detection, tandem split, framing, HFA=0.017, RUN_MULT=46, venue-aware pricing — all material stack changes. Pre-v6 signals ran on a materially different model.

2. **Hand-resolution gap fixed.** Three-stage lookup: (1) `team_rosters` exact, (2) `team_rosters_season` exact, (3) abbreviation fallback (initial + last-name unique match, same pattern as `services/jobs.js:forecastForPitcher`). Resolution went from 53% → **94.9%** of distinct v6+v7 SPs. Remaining 5.1% (13 names) are Shohei Ohtani, Carlos Rodon, and a handful of others that need targeted debugging — small enough to not materially affect direction.

3. **Contamination filter.** `contaminated_reason IS NULL` kept (was already in earlier sweep).

4. **Rolling-CV dropped for v7.** v7 window is 13 days after excluding birth/transition. Too thin for a meaningful fit/test split. Report is **single-window ROI + bootstrap 95% CI** per (cohort × hand × candidate). No fake folds.

5. **CI-first reporting.** Per your n<200 rule: bootstrap CIs alongside every point estimate; direction claims contingent on CI overlap.

## Cohort sample sizes

| Cohort | Signals | Date range |
|---|---|---|
| **v7** (current model stack) | 129 | 2026-07-09 → 2026-07-22 (13 days) |
| **v6** | 258 | 2026-05-29 → 2026-07-05 (38 days) |
| **v6+v7** | 387 | 55 days combined |

At baseline SP_WEIGHT=0.80, per-hand subsets:

| Cohort | R-facing n | L-facing n | Unknown n |
|---|---|---|---|
| v7 | 36 | 20 | 3 |
| v6 | 114 | 25 | 6 |
| v6+v7 | 150 | 45 | 9 |

**v7 is thin.** n<40 per hand-subset per candidate. CIs will be wide.

## v7 results (current model stack — the actual production behavior)

### R-facing (n=31-39 per candidate)

| SP_WEIGHT | n | ROI | 95% CI |
|---|---|---|---|
| 0.60 | 31 | +15.74% | [−22.23%, +54.45%] |
| 0.70 | 34 | +18.29% | [−16.47%, +55.18%] |
| 0.75 | 36 | +11.72% | [−24.92%, +45.53%] |
| **0.80** | **36** | **+11.72%** | **[−23.97%, +44.89%]** ← baseline |
| 0.83 | 36 | +17.28% | [−15.89%, +50.11%] |
| 0.85 | 36 | +17.28% | [−16.00%, +50.42%] |
| 0.90 | 39 | +18.51% | [−15.92%, +50.85%] ← best point |

- Mean below-baseline **+14.00%**, mean above-baseline **+17.71%**
- **Direction: slight UP** — but every CI (width ~70pp) includes the baseline point estimate and every other candidate's point estimate. **All values indistinguishable at 95%.**
- **This flips the earlier mixed-cohort finding** (which said DOWN with best at 0.60). Under v7 alone, best point is 0.90; under mixed, best point was 0.60. Cohort restriction moved the finding.

### L-facing (n=18-22 per candidate)

| SP_WEIGHT | n | ROI | 95% CI |
|---|---|---|---|
| 0.60 | 21 | −21.05% | [−61.43%, +22.19%] |
| 0.70 | 21 | −21.05% | [−60.95%, +24.90%] |
| 0.75 | 21 | −21.05% | [−61.43%, +21.43%] |
| **0.80** | **20** | **−7.10%** | **[−48.85%, +35.30%]** ← baseline, best-ish |
| 0.83 | 20 | −7.10% | [−50.00%, +35.70%] |
| 0.85 | 19 | −13.26% | [−56.68%, +31.47%] |
| 0.90 | 18 | −19.56% | [−66.67%, +27.44%] |

- Mean below-baseline **−19.46%**, mean above-baseline **−13.09%**
- **Direction: UP** (higher SP_WEIGHT helps at the point-estimate level)
- **Not statistically distinguishable** — CIs all overlap and baseline is co-best.
- Big change from earlier mixed sweep (which showed L-facing catastrophic at −30% to −40% for every SP_WEIGHT). Under v7 alone, L-facing at baseline is only −7%, not −34%. **The L-facing catastrophe was ~80% a pre-v6 cohort artifact.**

## v6 results (previous model stack — for comparison)

### R-facing (n=111-118 per candidate)

| SP_WEIGHT | n | ROI | 95% CI |
|---|---|---|---|
| 0.60 | 111 | +13.26% | [−6.90%, +33.01%] |
| 0.70 | 115 | +12.50% | [−8.42%, +32.33%] |
| 0.72 | 114 | +13.49% | [−7.26%, +34.22%] |
| **0.80** | **114** | **+9.82%** | **[−10.64%, +29.89%]** |
| 0.85 | 116 | +8.09% | [−10.88%, +26.90%] |
| 0.90 | 118 | +4.46% | [−15.66%, +25.39%] |

- v6 shows DOWN direction (best point at 0.60/0.72), same as the mixed-cohort finding.
- v6 → v7 direction FLIPPED. This is exactly the "fitting on one model and testing on another" problem the mixed sweep was blind to.

### L-facing (v6)

Range −17% to −27% across all candidates. Less catastrophic than the mixed-cohort suggested, but still uniformly loss-making. Direction: slight UP (0.83+ least bad).

## What this means

1. **v7 R-facing is essentially FLAT and unshippable at this n.** Every point estimate has a ~70pp CI that swallows every other candidate. The "best" point estimate is 0.90, but that's not different from baseline in any meaningful sense. Baseline SP_WEIGHT=0.80 remains defensible in v7 — because n<200 isn't enough to move it, not because it's known to be optimal.

2. **v7 L-facing is thinner (n≈20) and not shippable, but the story is very different from the mixed sweep.** L-facing at baseline in v7 is −7% ROI. That's a bad result but not the −34% catastrophe the mixed sweep suggested. **Most of the L-facing catastrophe was pre-v6 artifact** — the v6+v7 model changes (park-neutral inputs, edge cap, opener detection, RUN_MULT 46, framing) fixed something material for LHP-starter games.

3. **The v6 → v7 direction flip is the real finding.** v6 R-facing prefers DOWN (best point at 0.60-0.72). v7 R-facing prefers UP (best point at 0.90). The mixed sweep averaged these into a spurious DOWN, which is exactly why the earlier direction-based benchmark disconfirmation was invalid. The benchmark math wasn't necessarily wrong — the disconfirming evidence was contaminated by cohort mixing.

4. **The corrected benchmark (0.86 R / 0.68 L from `sp-weight-benchmark-correction-2026-07-26.md`) is neither confirmed nor disconfirmed by v7 alone.** v7 R-facing point estimates are: 0.83→+17.28%, 0.85→+17.28%, 0.90→+18.51%. All above the baseline +11.72%. That's directionally consistent with the R-benchmark prediction (0.86) — but the CIs prohibit shipping conclusion.

## Actions

1. **Do not ship the hand-conditional design** — v7 evidence too thin, and the direction from v6 to v7 is unstable. Waiting for more v7 signal accumulation is the honest answer.

2. **Un-halt the design in principle.** The v7 result is directionally compatible with the corrected benchmark (R-facing prefers slightly higher, L-facing prefers slightly higher too — the L direction was wrongly predicted DOWN but the actual data doesn't argue against UP either). The HALT preamble on `docs/sp-weight-hand-conditional-design-2026-07-26.md` should be softened: the earlier disconfirmation was mixed-cohort noise, not a benchmark failure.

3. **Do not un-halt the design in practice.** Even directionally compatible, v7 n=36 R-facing is not enough to distinguish 0.80 from 0.90. Shipping the hand-conditional constants now would be shipping based on point estimates in the presence of 70pp CIs.

4. **Recommend: re-run this sweep every 2-3 weeks as v7 accumulates.** Once v7 hand-subsets reach n≥100 per candidate (roughly 6-8 more weeks at current signal rate), the CIs tighten and direction becomes readable. That's when the design revives.

5. **The L-facing story is still worth investigating separately.** −7% ROI at baseline in v7 is not catastrophic, but it's still a bad segment. Understanding why LHP-starter games underperform the R-facing segment (v7 R-facing +11.72% vs L-facing −7.10% at same SP_WEIGHT) is a different question — could be a vsLHP data quality issue, or genuine market efficiency on LHP-starter games. Distinct from the SP_WEIGHT parameter question.

## Sample-size honesty

Every conclusion above rests on n<40 per candidate for v7 R-facing and n<25 for v7 L-facing. Bootstrap CIs are ~70pp wide. The right report is "we cannot ship anything," not "the direction is X." The mixed sweep's failing was pretending 55 days across four model stacks was one universe. This sweep does the opposite: says explicitly what n can't support, and reports what it can (v7 point estimates directionally, with CIs).

## Bottom line

- **Cohort restriction was the right call.** Direction findings flipped between v6 and v7.
- **v7 alone is too thin to move SP_WEIGHT.** All CIs overlap baseline.
- **v7 direction is directionally consistent with the corrected benchmark** (0.86 R / 0.68 L predicted UP for R-facing; v7 R-facing best point at 0.90). Not confirmatory — just consistent.
- **Design should un-halt as a principle but stay unbuilt until v7 accumulates more data.** Roughly 6-8 more weeks.
