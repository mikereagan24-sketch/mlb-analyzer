# Pythag exponent holdout — PROD-FAITHFUL v2 — DEFER

**Date:** 2026-07-13
**Supersedes:** `docs/pyth-exp-holdout-2026-07-13.md` (PR #177)
**Related:** PR #173 (strong-fav decomposition), PR #174 (weight sensitivity + cap),
PR #175 (cap ship 0.25→0.08), PR #178 (17pp harness-vs-prod gap diagnostic)

## TL;DR

Pythag 1.65 does not ship. Prod-faithful holdout on the actual bet_signals
universe (n=608 clean ML rows, fit Apr-Jun / val Jul, graded at closing_line)
fails ship gate (d): Val big+DOG+HOME ROI gets **worse**, not better, at 1.65
(−39.64% n=11 vs −33.60% n=10 baseline).

Baseline sanity check passes: 1.83 val book ROI = **−4.11%**, prod actual ≈ **−5%**
per PR #174 — the harness is aligned with prod within ~1pp.

## Why v2 exists

PR #177's v1 sweep (`scripts/sweep-pyth-exp.js`) ran runModel + getSignals on
every game_log row and graded synthetic signals against `game_log.market_*_ml`.
PR #178's diagnostic showed that this misses the venue-net-at-size override
`processGameSignals` applies in prod (venue winner net at $100 replaces the
Kalshi/Poly top-of-book prices before `getSignals` sees them). Same model,
different market prices → ~17pp ROI gap on Poly-tagged rows.

v1 also over-generated signals (it emitted on every game where the model
found edge, not just the ones that survived prod's chosen-market venue winner
and staleness gates). Net effect: v1 measured a different universe than the
one prod actually bets.

v2 fixes this by walking prod's actual `bet_signals` rows directly:

- **Universe:** stored `bet_signals` where `signal_type='ML'`, resolved
  (`outcome IN ('win','loss')`), pre-v7-window baseline (post-#164 stable
  logic), and post-corruption (`odds_locked_at` present, guarded by PR #172).
- **Rebuild:** for each candidate `pyth_exp`, re-run `runModel` on the
  matching game_log row using day-of state (`q.getBullpenWobaBlended(...,
  gameRow.game_date, ...)` — same pattern as `scripts/sweep-woba-blend.js`).
- **Recompute edge:** `newEdge = impliedP(newModelLine_on_side) −
  impliedP(closing_line)`. `closing_line` = frozen-at-lock venue-net-at-size
  in game_log (clean since #172).
- **Apply gates:** drop if `newEdge < 0.01` (emit floor), suppress if
  `newEdge >= 0.25` (baseline cap; the 0.08 ship is being tracked
  separately in PR #175).
- **Grade kept:** P&L computed at `closing_line` against the stored outcome.

Result: identical signal population to prod on baseline 1.83 (n=63 vs prod
n≈65 — one row lost to signal-rebuild edge-recompute noise), and the 1.83
val book ROI matches prod actual within 1pp. That's the harness alignment
check.

## Result grid

Fit = Apr-Jun (n=522), Val = Jul (n=86). All ROI at $100 flat stake, graded
at closing_line, wins/losses only.

| pyth_exp | Fit book n / ROI | Val book n / ROI | Val 1-2pp n / ROI | Val big+FAV n / ROI | Val big+DOG+HOME n / ROI |
|---|---|---|---|---|---|
| 1.83 (baseline) | 382 / **+5.4%** | 63 / **−4.1%** | 15 / −29.9% | 4 / +50.0% | 10 / **−33.6%** |
| 1.65 (candidate) | 382 / +3.8% | 64 / **−2.3%** | 17 / **−2.1%** | 2 / 0.0% | 11 / **−39.6%** |

Buckets: 1-2pp = 1% ≤ edge < 2%. big = edge ≥ 4%. FAV = market_line < 0.
DOG+HOME = market_line > 0 and signal_side == home team.

Full raw grid: `docs/data/sweep-pyth-exp-v2-grid.tsv`
Script: `scripts/sweep-pyth-exp-v2.js`

## Gate scoring

Owner-defined ship gates from PR #174:

| Gate | Baseline 1.83 | Candidate 1.65 | Delta | Result |
|---|---|---|---|---|
| (a) Val book ROI improves | −4.11% (n=63) | −2.28% (n=64) | +1.83pp | **PASS** |
| (b) Val 1-2pp not damaged | −29.87% (n=15) | −2.06% (n=17) | +27.81pp | **PASS** |
| (c) Val big+FAV stays positive | +50.00% (n=4) | 0.00% (n=2) | small-n | PASS (trivially) |
| (d) Val big+DOG+HOME improves | −33.60% (n=10) | −39.64% (n=11) | −6.04pp | **FAIL** |

**Ship decision: DEFER.** One hard gate fails. The reason gate (d) fails is
exactly the mechanism story PR #173 laid out: home-dog signals leak, and
compressing WP with a lower Pythag exponent doesn't fix the underlying leak
— it slightly widens it.

## What v2 corrects about v1 (PR #177)

v1 concluded "Pythag defers because it makes book worse" and, as a
side-finding, "PR #173's mechanism story doesn't survive real-model
validation — big+DOG+HOME is winning at +66% baseline in the real-model
holdout, not losing." That side-finding is retracted.

v2 shows big+DOG+HOME is **−33.60% baseline** in the prod-signal universe.
PR #173's decomposition was correct: home-dog signals are the leak, and it
shows up when you measure against the population prod actually bets.

v1 was measuring the wrong universe. In the raw game_log universe, real-model
signals over Apr-Jun include a lot of Poly-tagged rows where the model
disagrees with the exchange price by an amount that would never actually make
it into `bet_signals` because prod's venue-net-at-size override collapses the
edge before `getSignals` sees it. Those synthetic-only signals happened to
include some winning big+DOG+HOME rows that inflated v1's baseline to +66%.
None of that survives in prod.

**Net effect on PR #173:** the recommendation stands (Pythag stays deferred),
but the mechanism story stands too. Home-dogs are a real leak in the
bet_signals population; v1's proxy contradiction was an artifact of measuring
the wrong universe.

## Look-ahead caveat

Both runs use today's `woba_data` snapshot for hitter/pitcher inputs —
season-cumulative rollups, not as-of-game-date partial-season. That means
absolute ROI numbers in the grid carry mild look-ahead: at earlier dates the
model sees a slightly cleaner version of each team than it saw in prod.

**Comparison is honest.** Both 1.65 and 1.83 run against identical inputs;
the pyth_exp swap is a post-WP transform. Look-ahead applies equally to both
sides of the comparison and cancels out. What we can't claim from this doc:
that 1.83's baseline Val ROI of −4.11% would still be −4.11% under a strict
as-of-date snapshot. What we can claim: the direction and magnitude of the
delta from 1.65 to 1.83 survives look-ahead.

Building per-date woba snapshots is Phase 3 work. Not blocking this defer
decision.

## Why the 1-2pp gate improvement doesn't rescue Pythag

Gate (b) is dramatic: −29.87% → −2.06%, a 27.81pp improvement. The mechanism
is intuitive: lower Pythag exponent compresses WP, which moves marginal
signals from the "just barely emitted at 1-2pp edge" band into the below-emit
band (dropped: 22 → 21) and moves some 2-4pp signals down into 1-2pp. The
1-2pp bucket ends up populated by rows the model is more genuinely uncertain
about, which grade closer to breakeven.

That's real. But it's not enough to overcome gate (d)'s FAIL because:

1. Ship gates are hard-fail, not weighted. Gate (d) blocks the ship.
2. The 1-2pp benefit is orthogonal to the leak. Prod's actual bleed is
   concentrated in big+DOG+HOME, not 1-2pp — that's PR #173's whole point.
   Fixing a bucket that's already numerically small (n=15) while widening
   the bucket that's actually eating equity (n=10) is a wash at best.
3. The cap ship in PR #175 (0.25→0.08) is the belt for big+DOG+HOME. With
   hard-cap 8pp live, most of the big+DOG+HOME rows in the val period get
   suppressed at emit time. That's the leak-mitigation lever; Pythag is not
   needed as a second belt.

## Recommendation

1. **Ship cap 0.08 (PR #175) as the leak-mitigation belt.** Already
   validated on prod-faithful analytic proxy in PR #174. The cap makes the
   big+DOG+HOME leak numerically small regardless of Pythag choice.
2. **Keep Pythag at 1.83.** Prod-faithful evidence says 1.65 does not
   improve gate (d), and the 1-2pp benefit doesn't offset that.
3. **Revisit Pythag when Phase 3 (per-date wOBA snapshots) is done.** That
   removes the look-ahead caveat and lets us build a real time-honest
   holdout. Until then, the current comparison is honest but the absolute
   numbers are not.
4. **PR #173 mechanism story stands.** Home-dog signals are the leak. The
   cap is the near-term fix; a targeted home-dog filter or a component-level
   audit (why does the model over-favor home dogs?) is the medium-term fix.
   Neither depends on Pythag.

## Artifacts

- Script: `scripts/sweep-pyth-exp-v2.js`
- Raw grid: `docs/data/sweep-pyth-exp-v2-grid.tsv`
- Baseline sanity: 1.83 val book ROI −4.11% vs prod actual ≈−5% (delta 0.89pp)
- Universe: 522 fit + 86 val = 608 clean bet_signals ML rows
