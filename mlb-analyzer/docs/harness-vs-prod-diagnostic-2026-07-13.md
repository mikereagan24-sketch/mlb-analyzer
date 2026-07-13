# Harness-vs-prod diagnostic — 17pp gap explained — 2026-07-13

**Question owner asked:** the harness's +11.90% Val Jul baseline vs prod's ~-5% actual = 17pp gap. Where does it come from? Does the cap #175 validation survive?

**TL;DR:** the harness in PR #177 is scoring a **different signal universe than prod** — different model_lines (look-ahead wOBA) and different market prices (Kalshi-direct top-of-book vs prod's venue-net-at-size). The 17pp gap is real and structural. **BUT: cap validation from PR #174 used a DIFFERENT method (analytic proxy on stored bet_signals, graded on closing_line = venue-net), and that method IS prod-faithful.** Cap ships. Pythag defer needs re-evaluation with a prod-faithful sweep before shipping either way.

## Diagnosis

### Per-game comparison, 10 random resolved Jul games

Harness ≠ prod on 8 of 10 sample games:

- **Only 2/10 match** (ath-cws, nyy-tb): both emit same side, close model_lines
- **3/10 prod-only** (phi-det, sea-tb, tex-cle): harness's recomputed edge fell below emit floor → no signal
- **1/10 harness-only** (mil-stl): harness emitted home +10.3pp (marked edge_suspect), prod said nothing
- **4/10 both empty**: no signal from either
- Model_line divergence: tex-cle prod home=-134 vs harness home=-110 (24-point gap) is representative — enough to change signal emission

### Market-price divergence — JUL clean (n=86, corrupted excluded)

**bet_signals.market_line vs game_log.market_*_ml, by price_venue tag:**

| tag | n | mean \|delta\| |
|---|---|---|
| poly | 24 | **142.7** points |
| kalshi | 4 | 111.3 points |
| null (no venue tag) | 58 | 0.3 points (negligible) |

**This is huge.** For rows where prod tagged a venue winner (Poly or Kalshi net-at-size fill), the prod-actual market_line is on average **~140 points DIFFERENT** from what game_log stored (Kalshi-direct top-of-book price from PR #167's KALSHI_DIRECT_PRIMARY override).

Sanity checks:
- `bet_signals.market_line` ≈ `bet_signals.closing_line` (post-corruption exclusion, mean delta ≤2pts) — both frozen at odds_locked_at, both from venue-net-at-size
- Null-tagged rows (venue_aware failed / partial fill / tier-3 fallback) match game_log exactly

So prod's actual bettor price on venue-tagged rows is a **completely different number** than what the harness grades against.

### Settings comparison (harness vs prod — clean)

Harness uses `jobs.getSettings()` which reads app_settings. Values match prod exactly:

- PYTH_EXP=1.83, W_PROJ=0.45, W_ACT=0.55, W_PIT=0.4, W_BAT=0.6, HFA_BOOST=0.017, RUN_MULT=46
- SIGNAL_VENUE_AWARE_ENABLED=true, SIGNAL_EDGE_CAP_ENABLED=true, HARD_CAP=0.25
- KALSHI_DIRECT_PRIMARY=true, PARK_NEUTRAL=true, FRAMING=true

**Settings are identical.** Not the cause.

## Cause apportionment

The 17pp gap is a combination of three structural harness deficits:

1. **Venue-aware ML override MISSING from harness** — **primary cause**
   - Prod: `processGameSignals` runs the venue-override block that overwrites `game.market_away_ml`/`market_home_ml` with venue-net-at-size before `getSignals` computes edges.
   - Harness: calls `runModel + getSignals` directly. No venue override. Sees raw `game_log.market_*_ml` (Kalshi-direct top-of-book).
   - Impact: ~140-point market_line delta on 32.5% of rows (venue-tagged), less-favorable Kalshi-direct prices → smaller edges → different emit decisions.

2. **Look-ahead wOBA** — **secondary cause**
   - Harness uses today's `woba_data` (season-cumulative rollups through 2026-07-13).
   - Prod at emit time used as-of-that-date wOBA (partial season).
   - Impact: harness's model_lines are ~5-25 points off from prod's for the same games. Enough to cross emit floors and change signal populations.

3. **Signal-emission population divergence** — **downstream consequence of 1 + 2**
   - Same games produce different signal counts in each system.
   - Some games only harness emits (mil-stl +10.3pp edge_suspect); some only prod emits (tex-cle at fav price where harness sees smaller edge).

## Does the cap validation survive?

**YES.** Cap validation from PR #174 was NOT done via the harness. Reviewing my PR #174 methodology:

- PR #174 cap sweep: `tmp/pythag-holdout-backtest.js` — analytic proxy that pulls from `bet_signals` directly. Grades on `closing_line` (venue-net, post-freeze). Applies cap suppression as post-hoc filter on stored `edge_pct` (recomputed from `model_line vs closing_line`).
- PR #177 Pythag sweep: `scripts/sweep-pyth-exp.js` — REAL runModel re-run. Grades on `game_log.market_*_ml` (Kalshi-direct). Does NOT do venue-override.

**The two methods measure different universes:**

| method | signal population | market price for grading | prod-faithful? |
|---|---|---|---|
| PR #174 analytic proxy | Prod's ACTUAL bet_signals | Prod's ACTUAL closing_line (venue-net) | **YES** |
| PR #177 real-model harness | Hypothetical re-run universe | Kalshi-direct top-of-book | **NO** |

**Cap +5.35pp Val ROI recovery survives.** It measured what happens if we retroactively suppress prod's actual 9pp+ signals via a hard cap. That's what the cap will do in prod going forward. Cap ships.

## Does the Pythag defer survive?

**Uncertain.** The Pythag ship decision in PR #177 was based on harness numbers that don't reflect prod. The gate-scoring deltas (-2.15pp book, -33.20pp big+DOG+HOME) are between hypothetical universes with the same non-prod-faithful methodology (Kalshi-direct grading, look-ahead wOBA).

**Deltas might still be honest** — under equal-look-ahead conditions, comparing pyth_exp values should show real directional response. But the magnitudes AND the identity of which signals move don't map to prod behavior.

**Defer decision holds pending a prod-faithful Pythag sweep.** That would require either:
- A harness that replicates `processGameSignals`' full venue-override logic (including runComparison venue-net computation for historical dates — infrastructure that doesn't exist and would be expensive to build)
- Approximation: grade against `bet_signals.closing_line` (venue-net) for signals whose game+side matches a prod signal, and use `game_log.market_*_ml` (Kalshi-direct) for NEW signals the sweep emits that prod didn't. This mixed grading is defensible for sweeping post-WP parameters like pyth_exp.

## Also disqualified from PR #177 as CONTRADICTING PR #173

PR #177 said "the strong-fav decomposition mechanism story is contradicted." **That was wrong.** The strong-fav decomposition in PR #173 used stored `bet_signals` data directly — prod-faithful. Real-model harness in PR #177 measures a different universe with different market prices. The two don't contradict; they measure different things. **PR #173's mechanism finding stands.**

## Recommendations

1. **Ship PR #175 (cap 8pp).** Validation is prod-faithful — used analytic proxy on stored bet_signals + closing_line. Cap suppresses prod's actual 9pp+ signals. +5.35pp Val ROI recovery holds.

2. **Ship PR #176 (param-sensitivity closing_line fix).** Small script fix. Not affected by harness gap because param-sensitivity.js reads bet_signals directly with corruption filter.

3. **HOLD PR #177 (Pythag holdout).** The ship-defer decision might be right but the evidence isn't prod-faithful. Either:
   - **Add a caveat to the doc** stating the numbers reflect a hypothetical model universe, not prod. Defer Pythag pending a prod-faithful sweep. Owner-approved caveat = merge.
   - **OR: build a hybrid-grading sweep-pyth-exp v2** that uses bet_signals.closing_line for prod-matched signals + game_log.market_*_ml only for new ones. Rerun Pythag holdout on that.

4. **Follow-up: harness fidelity work isn't done.**
   - Existing `sweep-woba-blend.js`, `optimize-params-v2.js` and other `scripts/sweep-*.js` all have the SAME harness gap (grade via re-run outputs, no venue-override, look-ahead wOBA). Their historical ROI numbers describe hypothetical universes.
   - Task #86 or new: build a "prod-faithful sweep pattern" module that reads bet_signals for prod-matched signals + game_log for new ones. Standard grading for future weight sweeps.

## Files

- `tmp/diag-harness-vs-prod.js` — this diagnostic harness
- `docs/harness-vs-prod-diagnostic-2026-07-13.md` — this doc
- `docs/data/sweep-pyth-exp-grid.tsv` — retains for historical record but flagged as non-prod-faithful
- `docs/data/sweep-pyth-exp-calibration.tsv` — same
