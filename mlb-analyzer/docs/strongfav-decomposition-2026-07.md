# Strong-favorite / big-edge decomposition — 2026-07-13

**DB snapshot:** 2026-07-13 18:29 UTC · **Clean-graded ML rows:** 608 (corrupted 34 + contaminated v7 dates excluded) · **Grading:** `closing_line`-graded, net-of-fees, edge recomputed per-row from `model_line` vs `closing_line`.

**Population under test:** big-edge (recomputed |edge| ≥ 6pp) — n=154 rows. Separately: 2-3pp band and NYM secondary reads.

Per-section data files in `docs/data/strongfav-*.tsv`.

> **Prior hypothesis (owner):** "60-65% home-fav bucket -8pp; extreme edges are model backing FAVORITES the market disagrees with."
>
> **What the data actually says:** the losing population is HOME **DOGS**, not favorites. The hypothesis is inverted. The mechanism is real (overconfidence at extremes) but the direction is opposite what the audit implied.

---

## STEP 1 — The losing population is HOME DOGS with big edges

Big-edge (≥6pp recomputed) aggregate: **n=154, W-L=65-89, ROI=-3.0%, PnL -$459**.

### Fav/Dog × Home/Away breakdown

| slice | n | W-L | pnl | ROI |
|---|---|---|---|---|
| big+FAV | 27 | 16-11 | +$500 | **+18.5%** |
| big+DOG | 127 | 49-78 | -$959 | -7.6% |
| big+HOME | 69 | 27-42 | -$905 | -13.1% |
| big+AWAY | 85 | 38-47 | +$446 | +5.2% |
| **big+FAV+HOME** | 16 | 9-7 | +$200 | +12.5% |
| **big+FAV+AWAY** | 11 | 7-4 | +$300 | +27.3% |
| **big+DOG+HOME** | **53** | **18-35** | **-$1105** | **-20.8%** |
| big+DOG+AWAY | 74 | 31-43 | +$146 | +2.0% |

**Verdict:** Big-edge signals on **favorites are winning** (+18.5% n=27). Big-edge signals on **home dogs are catastrophically losing** (-20.8% n=53). This is not favorite overconfidence — it's dog overconfidence, and it concentrates on the HOME dog. The prior audit's home-fav bucket may have been correct at the time but the current signal population points the other way.

### Team clustering

Top-10 by n in big-edge: COL (21), KC (17), ATH (12), CIN (12), WAS (10), DET (9), BAL (9), STL (7), MIN (6), ARI (6).

- **BAL: -50.6% n=9** — worst-per-signal
- **CIN: -42.0% n=12** — bad
- **KC: -25.3% n=17** — bad, largest n
- **DET: +40.8% n=9** — bucking the trend
- **MIN: +79.3% n=6** — noise-band n but strong

Bottom-half teams (BAL, CIN, KC, ATH, COL) dominate the big-edge population. The model produces its biggest edges on games featuring weaker teams — makes sense mechanically (weaker team = more probability space to disagree with market on) but the market is winning those disputes.

### Temporal

| month | n | W-L | pnl | ROI |
|---|---|---|---|---|
| 2026-04 | 37 | 20-17 | +$1103 | +29.8% |
| 2026-05 | 51 | 21-30 | -$573 | -11.2% |
| 2026-06 | 37 | 15-22 | -$260 | -7.0% |
| 2026-07 | 29 | 9-20 | -$729 | -25.1% |

**April profitable at big-edge, May onward loses.** This aligns with the RUN_MULT / seasonal temperature regime shift the model has been grappling with. The big-edge losses ARE partly seasonal — the model's calibration works cold-weather April, breaks down as run environment warms and offenses hit stride.

---

## STEP 2 — Mechanism apportionment (Pythag dominates; closing-line-direction is the smoking gun)

### (e) CRITICAL: Closing-line-direction test — biggest single explanatory variable

For big-edge signals with morning-line data (n=145 of 154), compare morning `proj_market` to `closing_line` — did the close move toward the model's view (making the edge smaller) or away (model's view further from market)?

| direction | n | W-L | pnl | ROI |
|---|---|---|---|---|
| TOWARD model (edge shrank) | 49 | 20-29 | -$465 | -9.5% |
| AWAY from model (edge grew) | 85 | 35-50 | -$278 | -3.3% |
| **strong TOWARD (>+2pp move)** | 25 | 12-13 | +$123 | **+4.9%** |
| **strong AWAY (<-2pp move)** | 64 | 23-41 | **-$980** | **-15.3%** |

**Interpretation:** when the market moves TOWARD the model's view (validating the model's morning read), big edges are marginally profitable. When the market moves AWAY (repudiating the model), big edges lose -15.3% on n=64. **The strongest single signal in this dataset:** if the close moved against the model by >2pp between morning and close, the model was wrong 64% of the time and lost -15% ROI.

**Actionable use:** this can't be a pre-emit filter (the close hasn't happened yet) but it CAN be a post-emit review flag. Also gives us a REAL indicator that the losing big-edge signals aren't "model right, market wrong" — the market is disagreeing with a real opinion, and the market is winning.

### (a) Pythag exponent compression — DOMINANT explanatory mechanism

Applied a WP-shift-toward-0.5 factor (proxy for reducing the Pythag exponent from ~1.83 downward). For each compression level, split the big-edge population into "still-big after compression" (kept) vs "no longer big" (dropped):

| compression | kept n | kept ROI | dropped n | dropped ROI |
|---|---|---|---|---|
| 5% | 109 | **+5.5%** | 45 | -23.5% |
| 10% | 103 | **+5.7%** | 51 | -20.6% |
| 15% | 96 | **+7.7%** | 58 | -20.7% |
| 20% | 93 | **+9.4%** | 61 | -21.8% |

**This is a clean split.** The Pythag compression identifies which "big edges" are real (kept, positive ROI) vs artifacts of Pythag over-separation (dropped, catastrophic negative ROI). At 15% compression: keep 96 signals at +7.7% ROI, drop 58 signals that would have lost -20.7%. **Net swing on the big-edge population: from -3.0% aggregate to +7.7% (kept-only) — that's the majority of the -34.6% 10+pp gap explained by ONE mechanism.**

Mechanically: Pythag exponent 1.83 in the WP conversion translates a runs-differential of 1.0 to a big WP delta. At extreme run diffs, this over-separates — a team projected to score 6.0 vs 4.5 has model WP that's too far from 0.5. Compressing WP toward 0.5 (equivalent to reducing pyth_exp toward 1.55-1.65) fixes the extremes without touching the middle where signals are working.

### (b) Bullpen quality — secondary contributor, not primary

Bucket big-edge by favored team's bullpen wOBA (q1=best):

| bucket | n | W-L | pnl | ROI |
|---|---|---|---|---|
| q1 (best bullpen) | 25 | 11-14 | -$13 | -0.5% |
| q2 | 24 | 8-16 | -$596 | -24.8% |
| q3 | 25 | 9-16 | -$553 | -22.1% |
| q4 (worst bullpen) | 24 | 8-16 | -$526 | -21.9% |

The model performs FLAT when the favored team has an elite bullpen (q1: -0.5%), and loses -22 to -25% when the favored team's bullpen is average or worse. This is the opposite of the prior "flatters good teams" hypothesis. Interpretation: **the model appears to CREDIT non-elite bullpens as if they were elite** — when combined with a big edge, the model is over-optimistic about a mediocre-bullpen team's win expectancy. Not the primary mechanism but a real contributor.

### (c) SP-forecast rank — noisy q3 outlier, not a clean pattern

| bucket (favored SP forecast IP) | n | W-L | pnl | ROI |
|---|---|---|---|---|
| q1 (weakest SPs) | 24 | 10-14 | -$51 | -2.1% |
| q2 | 24 | 10-14 | -$213 | -8.9% |
| **q3** | **24** | **5-19** | **-$1301** | **-54.2%** |
| q4 (strongest SPs) | 23 | 11-12 | +$177 | +7.7% |

The q3 (upper-middle) SP-tier is a **-54% ROI disaster**. This is either a sample artifact (n=24) or a real hole where the model over-trusts SP forecasts in the 4.5-5.5 IP forecast range. Not enough evidence to fix; flag for follow-up.

### (d) proj_market extremes — no clean pattern

Bucket by favored side's morning implied prob:

| bucket | n | ROI |
|---|---|---|
| mild (<55%) | 44 | -12.3% |
| moderate (55-60%) | 54 | -12.4% |
| strong (60-70%) | 43 | -1.0% |
| extreme (>70%) | 4 | +60.8% |

Losses concentrate in mild/moderate morning-line games, not extreme. Not a mechanism explanation — actually the OPPOSITE of what "extreme favorites" would predict.

---

## Apportionment ranking

1. **Pythag over-separation** — DOMINANT. 15% WP compression drops 58 signals at -20.7% and keeps 96 at +7.7%. Fits the "extreme WP → phantom big edges" story perfectly.
2. **Closing-line-direction** — biggest raw effect (-15.3% on strong AWAY, n=64) but not actionable as a pre-emit filter. Diagnostic only.
3. **Home-dog concentration** — the losses are heavily home-dogs (-20.8% n=53). This is a symptom of #1 (extreme WP produces extreme dog prices on home dogs particularly).
4. **Bullpen mediocrity credited as elite** — secondary contributor (-22% on q2-q4).
5. **SP q3 disaster** — noise-band artifact, flag only.
6. **proj_market extremes** — NOT a driver.

**Verdict:** Pythag exponent over-separation at extremes is the dominant mechanism. It explains why home-dogs concentrate (they're the side with the most compressible WP), why the closing-line-direction test works (real bettors are pushing back on the model's over-extreme reads), and why April worked (colder run environment kept run diffs smaller, exponent stayed in-calibration).

---

## STEP 3 — RECOMMENDATION (gated, not shipped)

### Primary: Pythag exponent reduction (targeted mechanism fix)

Reduce `pyth_exp` from **1.83 → 1.65** (a ~10% compression at typical run-diffs, ~15% at extreme run-diffs). Rationale:

- 15% compression on the recomputed WP separates $-20.7% signals from $+7.7% signals on n=154 big-edge signals. Clean split.
- Model's cold-weather April performance (+30% ROI on n=37) suggests the current exponent works when runs are lower. As offense heats up mid-season and run diffs stretch, 1.83 over-separates.
- Non-invasive settings change; single number.
- **Does not damage 1-2pp band:** compressing WP shifts the largest edges most; small edges barely move. The 1-2pp band is defined by proximity to closing_line — a WP shift of a few pp doesn't cross that boundary for most rows.

### Fallback / insurance: Hard edge cap at 8pp

If Pythag exponent reduction backtest is inconclusive or damages productive bands, ship a hard cap.

**Cap-value sweep** (`docs/data/strongfav-cap-sweep.tsv`):

| cap | suppressed n | saved $ | kept n | kept ROI | bands touched |
|---|---|---|---|---|---|
| 5 | 216 | $721 | 384 | +1.8% | 3-6 band hit (62 rows) |
| 6 | 154 | $459 | 446 | +0.9% | 6-10 band hit only |
| 7 | 102 | $188 | 498 | +0.3% | 6-10 band hit only |
| **8** | **72** | **$1172** | **528** | **+2.1%** | 6-10 (46) + 10+ (26) only |
| 9 | 48 | $997 | 552 | +1.7% | 6-10 (22) + 10+ (26) |
| 10 | 26 | $522 | 574 | +0.8% | 10+ (26) only |
| 12 | 15 | $650 | 585 | +1.0% | 10+ (15) only |

**Cap at 8pp is the sweet spot:** saves $1172 (biggest of any cap), suppresses 72 signals ALL in the 6-10 and 10+ bands, ZERO signals dropped from 1-2/2-3/3-6 productive bands. Kept-book ROI shifts from -0.1% (no cap) to **+2.1%** (with cap).

### Forward-ROI estimate for the primary recommendation

If Pythag exponent 1.65 drops the ~58 losing big-edge signals from -20.7% ROI to zero (by re-band-assigning them below 6pp where the productive-band ROI applies), the estimated forward book ROI improvement is roughly:

- Suppressed loss avoided: 58 × $100 × 20.7% = $1200 over the review window (Apr-Jul)
- Annualized: ~$2000-2500 in avoided losses for the full season
- Full-book ROI improvement: from ~0% to ~+2 to +3% net-of-fees

If Pythag exponent adjustment ALSO improves the 2-3pp band (by not over-separating there either), additional lift possible. Backtest must measure the 2-3pp band as a productive-band-safety check.

### Interaction with STEP 6 (post-deadline staleness)

The midyear flagged 07-31 trade-deadline as a staleness risk. The hard-cap-8pp option ALSO covers post-deadline phantom edges: any signal produced by stale roster input that inflates edge past 8pp gets suppressed automatically. The Pythag exponent fix does NOT cover this — it just makes the model's own math less extreme, but doesn't handle input-data-staleness edges. If the deadline concern is real, the hard cap is defensive coverage that Pythag doesn't provide.

**Owner decision required:** ship Pythag fix (primary mechanism), OR ship hard cap (broader coverage including deadline defense), OR ship BOTH (Pythag as the calibration fix + hard cap as the deadline safety net).

### Backtest plan (before shipping either)

1. **Holdout split:** fit on Apr-Jun (n=~470 clean ML), validate on Jul (n=~140).
2. **Metrics tracked:** ROI by band (must not damage 1-2pp), suppression count by band, CLV distribution (must not degrade).
3. **Success gate:** kept-book ROI net-positive, 1-2pp band ROI unchanged within ±2pp, no productive-band signal dropped by cap.
4. **Rollback plan:** either recommendation is a single settings change (`pyth_exp` or `signal_edge_hard_cap_pp`); revert is one flip.

---

## STEP 4 — Secondary reads

### 2-3pp band — different problem, uniform loss

The 2-3pp band (n=86 after clean filter, was 92 in midyear before recompute) shows uniform losses across every slice:

| slice | n | W-L | pnl | ROI |
|---|---|---|---|---|
| FAV | 46 | 18-28 | -$1000 | -21.7% |
| DOG | 40 | 13-27 | -$837 | -20.9% |
| HOME | 37 | 14-23 | -$838 | -22.6% |
| AWAY | 49 | 17-32 | -$999 | -20.4% |

**No pattern.** The 2-3pp band losses aren't concentrated in any subpopulation — it's a broad problem. Unlike the big-edge band (which has clean home-dog concentration + Pythag mechanism), the 2-3pp band is losing across the board.

**Hypothesis (not tested):** the 2-3pp band is where the SIGNAL_EMIT_FLOOR (0.01) meets the noise floor — signals that barely cross the emit gate carry high variance and no real edge. This is a DIFFERENT problem from big-edge, and NOT solved by a Pythag fix. Follow-up: measure whether emitting only ≥3pp signals (a raised floor) beats the current 1pp emit floor on net-of-fees ROI.

**Not recommending anything for the 2-3pp band this pass** — needs its own scoped investigation.

### NYM audit — team-level pattern, all bands

NYM signals across bands (26 total):

| band | n | W-L | pnl | ROI |
|---|---|---|---|---|
| 1-2 | 6 | 3-3 | $0 | 0.0% |
| 2-3 | 5 | 0-5 | -$500 | **-100%** |
| 3-6 | 11 | 4-7 | -$300 | -27.3% |
| 6-10 | 2 | 1-1 | $0 | 0.0% |
| 10+ | 2 | 0-2 | -$200 | -100% |

NYM is losing across MULTIPLE bands. 0-5 in 2-3pp and 0-2 in 10+ are both n<10 but 100% loss rates. 4-7 in 3-6pp band = -27%. Not a big-edge-mechanism problem — it looks like a NYM-specific input issue.

**Hypothesis:** stale roster or SP-forecast input for NYM. Their trades / lineup churn earlier in the season may not have propagated through model inputs cleanly. Follow-up: NYM-specific input audit (SP forecast currency, bullpen wOBA recency, framing catcher assignment).

**Not recommending anything for NYM this pass** — needs a team-specific input audit.

---

## Summary — one recommendation, gated

**Primary recommendation: reduce `pyth_exp` from 1.83 to 1.65.** Backtest with Apr-Jun fit / Jul validate. Expected forward ROI improvement: +2 to +3pp on full book. Must not damage 1-2pp productive band (backtest gate). Owner approves post-backtest.

**Fallback / insurance: hard cap at 8pp.** If Pythag adjustment doesn't hold on validation OR if deadline-staleness coverage is important, ship the cap either standalone or in addition to Pythag.

**Nothing shipped this pass.** Decomposition complete; recommendation is data-backed; owner decides which fix (or both) to backtest next.

---

## What's in this doc vs what's NOT

- **Fully measured:** Big-edge population characterization (home-dog concentration), Pythag compression apportionment (dominant mechanism), closing-line-direction test (strongest raw signal), bullpen/SP-forecast/proj_market secondary mechanisms, hard-cap sweep across 7 values, 2-3pp band absence-of-pattern, NYM band-by-band.
- **NOT measured this pass:**
  - Pythag exponent 1.65 forward validation on a proper fit/holdout split (recommendation is data-informed but needs its own backtest)
  - 2-3pp band emit-floor hypothesis (SIGNAL_EMIT_FLOOR effect)
  - NYM-specific input audit
  - Post-deadline (07-31) staleness harness (referenced but not built)

All numbers use `closing_line` as the price bettors got. Corrupted market_line values are excluded via the 34-row filter from PR #172's flagged set.
