# BsR gate status + criteria re-spec case (2026-08-23)

> **Status report. Nothing enabled, nothing recommended for early
> enablement.** Task #68 (forward-honest backtest) has now been run —
> it was outstanding from the midyear review.

## ⚠️ Data-freshness caveat — read first

**I cannot report gate-window accumulation.** The local snapshot is from
~2026-08-11:

| | real cutoff |
|---|---|
| graded games | **2026-08-06** |
| BsR snapshots | **2026-08-07** |
| bet_signals | 2026-08-08 |

The gate window opened **2026-08-13**. **Every day of the window is
after my data ends** — 17 days I cannot see. Everything below is *as of
the cutoff*, i.e. a lower bound, not a current reading. A
`refresh-db.sh` is needed before any real gate call.

**Self-inflicted contamination, disclosed:** running the server locally
during unrelated feature work triggered its crons, which wrote **15
`game_log` rows and 8 `bet_signals` rows dated 2026-08-23**
(`updated_at` 2026-08-22 20:03). They are excluded from every count
below. They are real scraped rows, not fabricated, but they create a
misleading 08-13→08-22 gap followed by a lone 08-23 slate. Not deleted —
a refresh supersedes them.

## 1. Accumulation (as of cutoff, not today)

| criterion | target | at cutoff | |
|---|---|---|---|
| trailing snapshot days | 60 | **54** (90%) | 2026-06-15 → 08-07 |
| forward graded games | 500 | **656** (131%) | **cleared** |

Snapshot cadence is clean: **54 captured across a 54-day calendar span,
zero missing days.** At 1/day from 54 on 08-07, the 60-day target would
have been reached **2026-08-13** — the day the window opened. Plausible
that both criteria are now met, but **unverified**.

Window closes 2026-09-14: **22 days remaining.**

## 2. Provisional with-vs-without (task #68, now run)

Forward-honest mode, player level, trailing window, BsR read as-of each
`game_date` from `player_baserunning_trailing_snapshot` — never future
BsR on past games. **641 games scored, 0 skipped, 0 suppressed**,
2026-06-16 → 2026-08-06.

### Accuracy — mean |model_margin − actual_margin|

| | runs |
|---|---|
| without BsR | 3.4986 |
| with BsR | 3.4917 |
| **delta** | **−0.0069** (negative = BsR better) |
| SE | 0.0038 |

Harness bar: `|delta| > 2×SE` is meaningful. **0.0069 vs 0.0076 — 1.8
SE, just under its own bar.** Directionally favourable, not meaningful.

### CLV

| | n bets | avg CLV | % positive | noise band |
|---|---|---|---|---|
| without | 348 | **1.8048pp** | 68.39% | ±5.36pp |
| with | 353 | **1.7795pp** | 67.14% | ±5.32pp |
| **delta** | +5 | **−0.0253pp** | −1.25pp | |

The delta is **0.5% of its own noise band.** Utterly indistinguishable.

### P&L — explicitly not a gate

22.16% → 20.22%, delta −1.94pp. The harness itself labels this
"CORROBORATING CONTEXT ONLY" and warns the sampling error swamps the
signal. Noted, not weighed.

## 3. Honest read: **dead even**

Not on track, not negative — **dead even**, exactly as the midyear
review projected. Accuracy is marginally favourable but under its bar;
CLV is marginally negative but far inside noise; P&L is not a gate
metric. Nothing has emerged that would earn early enablement, and
nothing has broken the gate premise.

**No recommendation to enable early.** The data would not support one
even if it were being sought.

## 4. The criteria question — the CLV prong is compromised

The gate compares two things. They have **very different** exposure to
the 2026-08-21 selection finding.

### Accuracy prong — sound, keep it

`nAcc++` fires for **every scored game** before any CLV gating. It is a
**paired MAE on run margin over the identical 641-game set**, with no
emit floor and no signal selection. Both configs score the same games.

**This is already a calibration-shaped target** and is immune to the
selection critique. It is the closest thing in the codebase to the
`scripts/calibration-sweep.js` construction, predating it.

### CLV prong — structurally composition-driven

`chooseMlSide(..., emitFloor)` returns `{side: null}` when
`best.edge < emitFloor`. So **the bet set differs between configs**. And
CLV per bet is `f(morning price, close price)` — **it does not depend on
the model at all**. Therefore, for any game where both configs signal
the same side, **CLV is byte-identical**.

The run reports exactly this:

```
bet_set_diff: { same_side: 330, without_only: 18, with_only: 23, side_flipped: 0 }
```

**330 of 348 bets are identical, contributing exactly zero to the
delta.** The entire CLV difference is produced by **41 marginal
near-floor bets** that crossed the emit threshold in one config and not
the other.

This is the same structure established for ROI sweeps
(`docs/sweep-selection-effect-2026-08-21.md`): the metric cannot move
for a kept bet, so only composition can move it.

**The harness already knows.** Its own `clv.interpretation` reads: *"CLV
diff between configs is driven by bet-set composition shifts (BsR flips
a few marginal selections)."* The insight was there; it simply was not
carried into how the criterion is weighted.

### And CLV is the criterion weighted heaviest

From `forward_honest_expectation`:

> *"Verdict bar: forward ACCURACY holds AND forward CLV turns positive
> on adequate bet sample. **Weight CLV heaviest**, accuracy second, ROI
> last."*

**So the gate weights most heavily the one prong whose delta is
structurally composition, and second the prong that is actually sound.**
That is backwards, and it was written before the selection finding
existed.

## 5. Re-spec proposal

**Not applied — this is a gate criteria change and wants an explicit
decision.**

1. **Promote accuracy to primary.** It already measures what the gate is
   trying to establish, over all games, unselected.
2. **Add the calibration targets** from `scripts/calibration-sweep.js`,
   WITH vs WITHOUT BsR over all games: **log loss** and **Brier** on the
   model's win probability, plus **ECE**. Immune to selection by
   construction, and directly comparable to the W_PIT/SP_WEIGHT results.
   The harness already computes both configs' win probabilities inline
   for its Pythag recompute, so the inputs are in hand.
3. **Add the claimed-vs-realised edge slope** WITH vs WITHOUT. If BsR
   makes claimed edge more honest, that is the thing worth having, and
   it is measurable over all games.
4. **Demote CLV to secondary/context**, reported alongside
   `bet_set_diff` and split into same-side (delta ≡ 0 by construction)
   vs churn — the same segmentation the logged-bet view now uses. It is
   not useless; it is just not a primary decision metric when 95% of its
   population cannot move.

**Note on the 60-day CLV rationale.** The expectation text argues CLV
needs 60–90 days because "baserunning nudges only ~4 bets across the
emit threshold per ~20", so the forward bet count grows slowly. That is
a correct read of the mechanism — and it is precisely the argument that
CLV here is a **churn statistic**. Waiting longer grows the churn
sample; it does not make the metric measure pricing.

## Related

- `docs/midyear-review-2026-07.md` — STEP 2, the trajectory this updates; task #68.
- `docs/sweep-selection-effect-2026-08-21.md` — the selection finding.
- `docs/wpit-wbat-calibration-sweep-2026-08-22.md` — the calibration target proposed here.
- `services/baserunning-backtest.js` — the harness.
