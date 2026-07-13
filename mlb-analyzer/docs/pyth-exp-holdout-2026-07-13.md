# Pythag exponent holdout — real-model validation — 2026-07-13

**DB snapshot:** 2026-07-13 20:04 UTC · **Grading:** `game_log.market_*_ml` (frozen at odds_locked_at, clean since PR #172), win/loss from `away_score`/`home_score`, standard $100-stake convention · **Corrupted 33 game keys + v7-contaminated dates excluded** · **Fit:** Apr-Jun 2026 (n=1079 games) · **Val:** Jul 2026 (n=102 games).

## Ship decision: **DEFER PYTHAG** — real-model evidence flips the mechanism story

Real-model re-scoring shows that moving `pyth_exp` from 1.83 → 1.65 **makes the book worse** on the Jul holdout, contrary to both my analytic proxy (PR #174) and the strong-fav decomposition's mechanism narrative. The productive 1-2pp band ACTUALLY improves at 1.65, but the aggregate book and the big+DOG+HOME extreme both regress. Two of four gates fail decisively.

## Results — real-model, fit Apr-Jun / val Jul

| pyth_exp | Fit book n / ROI | Val book n / ROI | Val 1-2pp n / ROI | Val big+FAV n / ROI | Val big+DOG+HOME n / ROI |
|---|---|---|---|---|---|
| **1.83 (baseline)** | 628 / **+10.44%** | 51 / **+11.90%** | 14 / **-23.00%** | 4 / **+50.00%** | 4 / **+66.00%** |
| 1.65 (candidate) | 625 / +7.66% | 52 / +9.75% | 18 / -17.89% | 2 / 0.00% | 5 / +32.80% |
| _1.60 (from earlier partial run)_ | 624 / +8.6% | 54 / +10.0% | 18 / -4.9% | 2 / 0.0% | 5 / +32.8% |
| _1.55 (from earlier partial run)_ | 619 / +9.0% | 55 / +12.3% | 18 / +8.1% | 2 / 0.0% | 5 / +32.8% |

## Gate scoring

| gate | 1.83 baseline | 1.65 candidate | delta | verdict |
|---|---|---|---|---|
| (a) Val book ROI improves | +11.90% | +9.75% | **-2.15pp** | **FAIL** — book gets worse |
| (b) Val 1-2pp not damaged | -23.00% (n=14) | -17.89% (n=18) | +5.11pp | PASS (marginal on small n) |
| (c) Val big+FAV stays positive | +50.00% (n=4) | 0.00% (n=2) | inconclusive small-n | Inconclusive |
| (d) Val big+DOG+HOME improves | **+66.00%** (n=4) | +32.80% (n=5) | **-33.20pp** | **FAIL** — the bucket the fix was meant to help gets substantially worse |

**Two hard-fail gates. Ship blocked.**

## WP calibration curve — both exponents reasonably calibrated in the middle

| bucket | n @ 1.65 | pred_mean @ 1.65 | realized @ 1.65 | diff | n @ 1.83 | pred_mean @ 1.83 | realized @ 1.83 | diff |
|---|---|---|---|---|---|---|---|---|
| .20-.35 | 4 | 0.331 | 0.000 | -33.1 | 7 | 0.327 | 0.429 | +10.2 |
| .35-.45 | 140 | 0.420 | 0.450 | +3.0 | 163 | 0.418 | 0.442 | +2.4 |
| .45-.50 | 301 | 0.472 | 0.445 | -2.7 | 295 | 0.472 | 0.431 | -4.1 |
| .50-.55 | 279 | 0.534 | 0.484 | **-5.0** | 246 | 0.535 | 0.508 | -2.6 |
| .55-.65 | 434 | 0.582 | 0.606 | +2.4 | 439 | 0.584 | 0.597 | +1.3 |
| .65-.80 | 23 | 0.671 | 0.696 | +2.5 | 31 | 0.677 | 0.710 | +3.3 |

Both exponents show middle-bucket calibration within ~5pp. 1.65 shows a WORSE fit on the .50-.55 bucket (-5.0pp vs -2.6pp at 1.83). The extreme .20-.35 bucket noise is small-n (4-7 games). **Middle-of-distribution calibration doesn't clearly favor either exponent** — but the ROI evidence in the gates above does.

## Why my earlier analytic proxy was misleading

Two problems:

1. **Baseline miscount:** proxy computed `edge_pct` from stored `bet_signals.market_line` (which included corruption era artifacts) and used stored `closing_line` for grading. This produced a "baseline Jul book ROI = -5.07%." Real-model re-scoring produces **+11.90%** on the same population. The gap is where the proxy went wrong.
2. **Uniform WP compression assumption:** proxy applied `newP = 0.5 + (oldP - 0.5) × (1 - c)` uniformly across all signals. Real `pyth_exp` change interacts with the wOBA→runs→WP pipeline non-uniformly. The proxy's Δ was too smooth; real model has sharp reshuffles of which signals qualify as big+DOG+HOME.

**Practical impact:** the strong-fav decomposition's core hypothesis — "Pythag over-separation drives home-dog losses at pyth_exp=1.83" — is CONTRADICTED by real-model evidence at baseline. Real model at 1.83 produces **+66% ROI big+DOG+HOME on n=4** in Jul (winning), while stored bet_signals from prod showed -31% on n=13. The delta is largely from the corruption era's signal miscount plus the analytic proxy's edge miscalibration.

The mechanism finding I made in PR #173 (`docs/strongfav-decomposition-2026-07.md`) needs to be reassessed against real-model evidence.

## Look-ahead caveat (owner-noted)

Absolute ROI numbers from real-model re-scoring on today's `woba_data` (season-cumulative) are LOOK-AHEAD-biased vs what the model actually saw at emit time in Apr/May/Jun. The comparison ACROSS pyth_exp values is honest (same look-ahead applied to all runs), but the absolute levels (e.g. "+11.90% Val ROI at 1.83") are NOT what you'd have achieved live. Real prod Val ROI in Jul was ~-5% (from PR #174 analytic on corrected `closing_line`). The gap is the look-ahead advantage the wOBA rollup provides.

**Implication:** the delta between 1.83 and 1.65 (-2.15pp on Val book) is honest under look-ahead-equal terms. Whether that delta holds under time-honest state (Phase 3 infrastructure, not yet built) is unknown but plausibly similar because pyth_exp is a post-WP transform independent of the wOBA data freshness.

## Recommendations

1. **DEFER Pythag 1.65 ship.** Two of four gates fail decisively (book ROI -2.15pp, big+DOG+HOME -33.20pp).
2. **Cap 8pp (PR #175) remains the belt.** It suppresses extreme-edge signals via post-emit filtering without touching the model calibration — orthogonal to the Pythag question. Ship approved.
3. **Reassess the strong-fav decomposition** — the mechanism story ("home-dog losses driven by Pythag over-separation") doesn't survive real-model validation. The prior finding was made on stored `bet_signals` values distorted by the corruption era. Big+DOG+HOME at real-model baseline 1.83 is **+66%**, not -20%. The audit that flagged home dogs as the losing population was reading corruption-era data.
4. **Middle-band calibration is already close to optimal at 1.83.** Both middle-bucket predicted/realized gaps are within 5pp. This is not a bin the model needs to fix.
5. **What SHOULD get investigated next:** the discrepancy between (a) stored `bet_signals` prod ROI (negative on many buckets, per midyear review) and (b) real-model re-run ROI on cleaner state (positive on most buckets). This gap suggests the CORRUPTION IMPACT + potentially other data-quality issues were larger than the midyear review estimated. The 34 corrupted rows may be the tip of a larger data-quality problem. Investigate before doing more calibration work.

## Follow-up (owner decision)

Two ways to interpret this session's finding:
1. **Cap ships (PR #175). Pythag defers. Investigate corruption-vs-real-model gap.** ← my recommendation
2. **Pause all model-calibration work.** The strong-fav decomposition mechanism story was wrong; the midyear scorecard's ROI numbers were computed on stored data that doesn't match real-model reality. Re-run the entire midyear scorecard with real-model re-scoring before drawing any conclusions from it.

Option 2 is invasive but honest. Option 1 keeps momentum while flagging the investigation. Your call.

## Files

- `scripts/sweep-pyth-exp.js` — the harness (real-model re-scoring, adapted from `scripts/sweep-woba-blend.js`)
- `docs/data/sweep-pyth-exp-grid.tsv` — real-model grid
- `docs/data/sweep-pyth-exp-calibration.tsv` — WP calibration curve
- `docs/pyth-exp-holdout-2026-07-13.md` — this doc
