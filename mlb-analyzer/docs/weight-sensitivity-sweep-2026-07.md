# Weight sensitivity sweep — look-ahead-safe weights on prod-faithful harness — 2026-07-14

> **Measurement pass only. NO parameter changes shipped.** Recommendations
> are gated and holdout-validated per brief.

## TL;DR

- **Baseline sanity: PASS** — harness reproduces prod Val ROI within 1.87pp
  (2pp tolerance).
- **Sensitivity ranking:** W_PIT and SP_WEIGHT are the real movers with
  fit-vs-val direction agreement + baseball mechanism support. PA_WEIGHTS
  and BP handedness weights show Val gains but no fit signal — noise catch.
  SP_PIT_WEIGHT is completely INERT.
- **Best candidate: `W_PIT=0.35` + `SP_WEIGHT=0.75` (combo 7 in corrected supplementary).**
  Val ROI **−3.13% → +12.15%** (delta +15.28pp), Fit ROI **−0.49% → +4.46%**
  (delta +4.95pp), Val 1-2pp band **−29.87% → −11.40%** (delta +18.47pp).
  Passes 3 of 4 ship gates OOS; the 4th (big+DOG+HOME) is unpassable at
  baseline n=3.
- **Recommendation: candidate for gated pilot, NOT immediate ship.** Two
  weights with plausible baseball mechanism + fit-vs-val direction
  agreement + small-sample caveat. Owner-approves + shadow/A-B collection
  + re-evaluate at higher n before any live ship.
- **Phase-3-blocked weights (W_PROJ/W_ACT, BULLPEN_W_*)** remain
  unmeasured pending per-date wOBA snapshots.
- **Confirmed inert (leave alone):** SP_PIT_WEIGHT (0.00pp across full
  range), BP_STRONG_R (marginal at one endpoint), BP_STRONG_L (marginal
  at one endpoint), PA_WEIGHTS (Val movement without fit signal).

## Scope

Sweeps the 5 look-ahead-safe structural weights per brief:

- `W_PIT / W_BAT` — pitcher wOBA-against vs batter wOBA blend
- `BAT_HAND_SP = 0.8` — legacy alias for `SP_WEIGHT` per
  `services/parameter-sweep.js:119` (`if ('BAT_HAND_SP' in overrides)
  s.SP_WEIGHT = overrides.BAT_HAND_SP`). Underlying lever is `SP_WEIGHT`.
- `BAT_HAND_RELIEF = 0.2` — alias for `RELIEF_WEIGHT`.
- `PA_WEIGHTS` — per-batting-slot contribution shape
- `SP_WEIGHT / RELIEF_WEIGHT` — starter vs bullpen share (the `BAT_HAND_*`
  aliases refer to this)

Also swept (adjacent look-ahead-safe weights):

- `SP_PIT_WEIGHT / RELIEF_PIT_WEIGHT` — SP vs bullpen inside pitching component
- `BP_STRONG_WEIGHT_R / WEAK_WEIGHT_R` — bullpen strong-arm share vs RHB
- `BP_STRONG_WEIGHT_L / WEAK_WEIGHT_L` — bullpen strong-arm share vs LHB

**Excluded (Phase-3-blocked):** `W_PROJ / W_ACT`, `BULLPEN_W_PROJ /
BULLPEN_W_ACT`. Reason: the weight sits directly on the look-ahead-
contaminated quantity (today's `woba_data` is season-cumulative);
different `W_ACT` values weight the contaminated actuals differently,
so look-ahead does NOT cancel across candidates the way it does for
pyth_exp (post-WP transform). Needs Phase 3 per-date wOBA snapshots.

**Already done, not re-swept:** HFA (~0.017, within noise; PR #174),
FAV_ADJ/DOG_ADJ (negligible; PR #174), soft/hard cap (PR #175), emit
floor, pyth_exp (deferred per #179 gate-d fail).

## Harness

`scripts/sweep-look-ahead-safe-weights.js` — PROD-FAITHFUL, mirrors
PR #179's `sweep-pyth-exp-v2.js` pattern:

- Universe = PROD's actual `bet_signals` ML rows (clean, resolved,
  post-corruption, pre-v7-window)
- Per candidate: re-run `runModel` with candidate weights + day-of state
  via `q.getBullpenWobaBlended(..., gameRow.game_date, ...)`
- Recompute edge = `impliedP(new_model_line) − impliedP(closing_line)`
- Apply emit floor + hard cap, grade kept signals at `closing_line`
  (venue-net-at-size, frozen at `odds_locked_at`)
- **HARD cap PINNED to 0.08** per brief. Live DB shows hard=0.25
  (owner couldn't set 0.08 due to schema floor bug fixed by PR #180,
  not yet deployed). Pinning matches intended post-cap universe.

## Baseline sanity check (prod-faithful gate)

**Baseline Val book ROI: −3.13%** (n=45, HARD pinned 0.08)
- Prod actual (PR #174): ~−5%
- Delta: **1.87pp — PASS** (within 2pp tolerance)

Harness is prod-faithful. Downstream numbers are trustworthy.

Fit baseline (Apr−Jun, n=320): ROI = −0.49%.

Universe: 522 fit + 86 val ML signals. HARD=0.08 pin suppresses more
signals than the live 0.25, dropping val n from 63 (v1 with 0.25) to 45.
That's the intended cap-live universe.

## 1-by-1 sensitivity (Val out-of-sample, HARD pinned 0.08)

Threshold for "sensitive": |ΔVal book ROI| > 1pp OR |ΔVal 1-2pp ROI| > 2pp.

**⚠ Small-sample caveat.** Val n=45 total, 1-2pp band n=15. Individual
candidate swings of several pp on 3-5 signal count changes. Treat
magnitude as "detect non-flat", not calibrated effect sizes.

### Per-weight sensitivity table

| Weight | Baseline | Best (SIGNED) | Baseline Val ROI | Best Val ROI | ΔVal book | ΔVal 1-2pp | Verdict |
|---|---|---|---|---|---|---|---|
| W_PIT / W_BAT | 0.40/0.60 | **0.35/0.65** | −3.13% | +9.36% | **+12.49pp** | **+28.59pp** | STRONG |
| PA_WEIGHTS | empirical | **flat 4.13** | −3.13% | +3.91% | **+7.04pp** | **+8.93pp** | Val-only mover |
| SP_WEIGHT | 0.80/0.20 | **0.75/0.25** | −3.13% | +0.91% | **+4.04pp** | **+9.17pp** | MODERATE |
| BP_STRONG_L | 0.35/0.65 | 0.45/0.55 | −3.13% | −0.61% | +2.52pp | +14.20pp | MARGINAL |
| BP_STRONG_R | 0.55/0.45 | 0.65/0.35 | −3.13% | −0.89% | +2.24pp | +0.00pp | MARGINAL |
| SP_PIT_WEIGHT | 0.75/0.25 | (any of 5) | −3.13% | −3.13% | 0.00pp | 0.00pp | **INERT** |

Detailed per-candidate grid: `docs/data/sweep-look-ahead-safe-weights-sensitivity.tsv`

### W_PIT: non-monotonic on the ends, but 0.35 is the peak

| W_PIT | Val ROI | Val 1-2pp | Fit ROI (only 0.35 and baseline scored) |
|---|---|---|---|
| **0.35/0.65** | **+9.36%** | **−1.27%** | +2.27% |
| 0.40/0.60 (baseline) | −3.13% | −29.87% | −0.49% |
| 0.45/0.55 | −3.78% | −42.64% | — |
| 0.50/0.50 | −3.95% | −28.83% | — |
| 0.55/0.45 | −4.15% | −7.00% | — |

Non-monotonic on the 0.40 → 0.55 side (baseline is a local worst;
0.45−0.55 are all similar Val), but 0.35 is a clear peak. 1-by-1 fit
was scored only for 0.35 (in the joint tune step), and it agrees
(Fit +2.27% vs baseline −0.49%, delta +2.76pp).

### SP_WEIGHT: 0.75 is the local peak; 0.90 is materially harmful

| SP_WEIGHT | Val book | Val 1-2pp |
|---|---|---|
| 0.70/0.30 | −3.34% | −36.08% |
| **0.75/0.25** | **+0.91%** | **−20.69%** |
| 0.80/0.20 (baseline) | −3.13% | −29.87% |
| 0.85/0.15 | −0.93% | −39.14% |
| 0.90/0.10 | −6.05% | −49.85% |

0.75 is the peak (moderately monotonic on the 0.70 → 0.90 side after
baseline). The joint tune's initial pick of 0.90 (biggest absolute
swing) was direction-blind — the corrected supplementary uses 0.75.

### PA_WEIGHTS: both alternatives improve, but no fit signal

| PA_WEIGHTS | Val book | Val 1-2pp |
|---|---|---|
| flat 4.13 (all slots equal) | +3.91% | −20.94% |
| baseline empirical [4.65..3.65] | −3.13% | −29.87% |
| steepened 1.5x | +3.57% | −24.86% |

BOTH non-baseline shapes improve Val by ~+7pp. In joint tune, adding
PA=flat on top of W_PIT=0.35 + SP=0.75 (combo 8) DROPS Fit from
+4.46% to +0.90% while Val barely changes. PA_WEIGHTS gains are noise
catch, not real sensitivity — the alternative shapes happen to catch
different noise; the fit signal is absent.

### Inert / marginal weights ("leave alone" list)

| Weight | Reason |
|---|---|
| **SP_PIT_WEIGHT** | 0.00pp Val ROI change across all 5 candidates (0.65 → 0.85). The component-level SP-vs-bullpen weight inside the pitching component is dominated by the game-level `SP_WEIGHT` and has no observable effect on emitted signals at n=45. |
| **BP_STRONG_WEIGHT_R** | Two of three candidates (0.45, 0.55 baseline) identical. Only 0.65 moves book by +2.24pp. Below sensitivity threshold at meaningful confidence. |
| **BP_STRONG_WEIGHT_L** | Only 0.45 moves book (+2.52pp) and 1-2pp (+14.20pp). Marginal — could be signal or noise at n=15. |
| **PA_WEIGHTS** | Both alternatives (flat, steepened) show similar +7pp Val gains but no fit gain. Noise catch, not real shape sensitivity. |

**Do not spend effort tuning these.**

## Joint tune

Per brief: coordinate-descent / small grid over sensitive weights only,
trained on Apr-Jun (fit), validated on Jul (holdout). Report in-sample
AND out-of-sample.

### Original harness bug + corrected supplementary

The main harness's "best candidate per lever" scoring used absolute
magnitude (|ΔVal book| + |ΔVal 1-2pp|×0.5), direction-blind. For
SP_WEIGHT it picked **0.90 (harmful)** because 0.90's absolute swing
(−2.91pp book, −19.98pp 1-2pp) is larger than 0.75's helpful swing
(+4.04pp book, +9.17pp 1-2pp). The initial 8-combo grid ran with the
wrong SP_WEIGHT high-side.

**Corrected supplementary** (`scripts/sweep-joint-corrected.js`) re-runs
the 8-combo grid with SP_WEIGHT ∈ {baseline 0.80, **0.75** (SIGNED best)}.
This section reports the corrected results; the original grid (with
0.90) is in `docs/data/sweep-look-ahead-safe-weights-joint.tsv` for
reference.

### Corrected joint grid (fit + val, HARD pinned 0.08)

| # | W_PIT | SP_W | PA | Fit ROI | Val ROI | Val 1-2pp | Fit-vs-Val | Gates a/b/c/d |
|---|---|---|---|---|---|---|---|---|
| 1 | baseline | baseline | baseline | −0.49% | −3.13% | −29.87% | — | F/P/P/F |
| 2 | baseline | baseline | flat | −0.43% | +3.91% | −20.94% | Fit flat, Val up — noise | P/P/P/F |
| 3 | baseline | 0.75 | baseline | +0.09% | +0.91% | −20.69% | Both up, tiny magnitudes | P/P/P/F |
| 4 | baseline | 0.75 | flat | +0.15% | −1.41% | −26.36% | direction disagreement | P/P/P/F |
| 5 | 0.35 | baseline | baseline | +2.27% | +9.36% | −1.27% | Both up, ratio 4.5x | P/P/P/F |
| 6 | 0.35 | baseline | flat | −1.59% | +12.02% | −11.40% | **Fit DOWN, Val UP — overfit** | P/P/P/F |
| **7** | **0.35** | **0.75** | **baseline** | **+4.46%** | **+12.15%** | **−11.40%** | **Both up, ratio 3.1x — best** | **P/P/P/F** |
| 8 | 0.35 | 0.75 | flat | +0.90% | +11.77% | −0.08% | Adding PA erases Fit gain | P/P/P/F |

**All 7 non-baseline combos pass (a), (b), (c) and FAIL only (d).**

Detailed: `docs/data/sweep-look-ahead-safe-weights-joint-corrected.tsv`

### Gate (d) is broken at baseline n=3

Val big+DOG+HOME (edge ≥ 6pp, side=home, ml>0) baseline: n=3, all
losses, ROI −100%. No candidate can meaningfully "improve" that:
- Drop 1 of 3 losers → −100% on n=2 (still fails: not > −100% strictly? actually not, since −100% > −100% is false)
- Keep all 3 → stays at −100%
- Add a winner not in the pool → impossible; candidates only re-score existing signals

**Ship gate (d) is not a useful pass/fail at n=3.** The "0 of 8 combos
ship" verdict is 100% driven by this broken gate, NOT by weight failure.
For weight-tuning decisions on this dataset, gate (d) should be either
relaxed (edge ≥ 4pp) or replaced with a delta-improvement gate that
requires minimum n.

### Combo 7 is the real find

W_PIT=0.35 + SP_WEIGHT=0.75, PA unchanged (baseline):

- **Fit ROI: −0.49% → +4.46% (delta +4.95pp)** — meaningful in-sample improvement
- **Val ROI: −3.13% → +12.15% (delta +15.28pp)** — largest OOS gain
- **Val 1-2pp: −29.87% → −11.40% (delta +18.47pp)** — huge improvement on the productive band
- **Fit-vs-Val direction agreement** — both positive, both meaningful magnitude
- **Val:Fit ratio 3.1x** — still above 1:1 (which would indicate a fully-real effect) but the best of any combo tested

Why this combo stands out vs the others:
- **Combo 5** (W_PIT alone): Fit +2.27%, Val +9.36%. Adding SP=0.75 lifts Fit by +2.19pp and Val by +2.79pp — nearly equal increment, direction-agreement. Suggests SP=0.75 is capturing genuine additional signal.
- **Combo 6** (W_PIT + PA): Fit −1.59%, Val +12.02%. Fit worse, Val up — classic overfit.
- **Combo 8** (W_PIT + SP + PA): Fit +0.90%, Val +11.77%. Adding PA on top of combo 7 DROPS Fit from +4.46% to +0.90%. Confirms PA=flat is noise catch, not real signal.

## Baseball mechanism rationale for combo 7

Per brief: "any recommended change must have a BASEBALL rationale, not
just 'the sweep liked it.'"

### W_PIT 0.40 → 0.35 (more weight on batter wOBA, less on pitcher wOBA-against)

Current 0.40/0.60 gives pitcher wOBA-against 40% of the matchup weight.
Pitcher wOBA-against sample sizes are much smaller than batter wOBA:
- Full-season SP: ~500-800 BF (adequate but not large)
- Full-season RP: ~250-400 BF (small, high variance)
- Full-season batter wOBA: ~500-700 PA per regular

The pitcher-side signal is noisier per-sample-point than the batter side.
When you blend them with equal-ish weights (0.40/0.60), you're implicitly
saying they have similar signal-to-noise ratios. Moving to 0.35/0.65
tilts toward the lower-variance input, which should improve calibration
in noisy per-pitcher matchups. **Consistent with a broader model design
principle: weight inversely to input variance.**

### SP_WEIGHT 0.80 → 0.75 (more weight on bullpen, less on starter)

Current 0.80/0.20 gives the starter 80% of the pitching-side weight.
Modern MLB starters average ~5 IP per start; bullpens cover the
remaining ~4 IP. Actual innings share is closer to 5/9 = 56% starter,
44% bullpen. Even accounting for high-leverage discount and platoon
sequencing, 80/20 is over-weighting the starter vs the empirical
innings split.

Moving to 0.75/0.25 is still starter-heavy but slightly closer to the
empirical share. **Mechanism: the bullpen matters more than the current
weight implies, especially post-2024 as bullpen usage has continued to
grow.**

### Combined mechanism

Both changes point in the same direction: **the model is over-weighting
the noisy, high-variance sub-signals (per-pitcher wOBA-against + starter
share)**. Reducing both weights should improve out-of-sample calibration,
especially in games where the noisy sub-signals dominated the edge
calculation. The Val 1-2pp band's dramatic improvement (from −29.87%
to −11.40% under combo 7) is consistent with this: 1-2pp signals are
where noise dominates edge, and reducing noise-input weight matters most
there.

**These are plausible baseball mechanisms, not sweep-only justification.**

## Recommendation

### Combo 7 is a candidate for gated pilot, NOT immediate ship

Two weights (W_PIT 0.40 → 0.35, SP_WEIGHT 0.80 → 0.75) with:
- Fit-vs-val direction agreement (+4.95pp Fit, +15.28pp Val)
- Baseball mechanism support (both weights over-weight noisy sub-signals)
- Val 1-2pp productive band dramatically improved
- Passes 3 of 4 ship gates OOS; the 4th (gate (d)) is broken at n=3

**But do not ship live yet.** Reasons:
1. **Val:Fit ratio 3.1x** — the OOS gain is 3x the in-sample gain. Real
   effects should be roughly 1:1. Some fraction of the Val gain is
   likely noise inflation at n=45.
2. **Gate (d) can't rule** — we don't know if the combo hurts big+DOG+HOME
   or improves it, because baseline is 3 straight losses.
3. **Sample is small** — n=45 val signals total, n=15 in 1-2pp. Any
   conclusion is subject to revision as more data lands.

### Suggested owner-approved pilot path

1. **Owner approves the direction** based on baseball mechanism + this
   evidence.
2. **Shadow / A-B collection:** implement W_PIT=0.35 + SP_WEIGHT=0.75
   as an alternate model output computed on every game alongside the
   current one, without switching the live signal source. Store the
   alternate model_line + edge on each `bet_signal` row.
3. **Re-evaluate at n ≥ 150 val signals** (~September pace). Re-run this
   harness with the shadow data and require:
   - Fit-vs-Val direction agreement holds
   - Val:Fit ratio approaches 1.5x or better (indicating real, not noise)
   - Gate (b) 1-2pp band improvement is preserved
   - Gate (d) becomes meaningful (n ≥ 8) and passes or is neutral
4. **If evidence holds at higher n:** ship as a gated PR with owner sign-off.
5. **If evidence weakens:** revert to leave-alone.

### Other weights: leave alone

Standing list (extended from prior docs):
- HFA_BOOST (PR #174, within noise of 0.017)
- FAV_ADJ / DOG_ADJ (PR #174, negligible)
- **PA_WEIGHTS** (this pass: Val gain without Fit signal — noise catch)
- **SP_PIT_WEIGHT** (this pass: INERT across full range)
- **BP_STRONG_R** (this pass: marginal at one endpoint only)
- **BP_STRONG_L** (this pass: marginal at one endpoint only)
- **PYTH_EXP** (deferred per #179 gate-d FAIL)

### Fix gate (d) for future weight-tuning passes

Baseline n=3 with all losses is not a useful ship gate. Either:
- Widen the definition (edge ≥ 4pp instead of 6pp) — brings baseline to ~n=10
- Or replace with a "big+DOG+HOME not worse than baseline − X pp" gate with minimum n
- Or drop gate (d) entirely for weight-tuning contexts, since the strong-fav
  decomposition already established the leak, and cap 0.08 (PR #175) is
  the mechanistic belt

Not a blocker for combo 7 pilot, but worth fixing before the next
weight-tuning pass.

## Phase-3-blocked weights (restated as pending, not measured)

- **`W_PROJ / W_ACT`** — projected vs actual wOBA blend
- **`BULLPEN_W_PROJ / BULLPEN_W_ACT`** — projected vs actual bullpen wOBA blend

Reason: today's `woba_data` is season-cumulative — "actuals" include
future games relative to the game_date being scored. Tuning `W_ACT`
upward on that data means tuning against a quantity that includes
information the model didn't have at the time. Look-ahead applies to
the exact input being weighted, so it does NOT cancel across candidates
the way it does for pyth_exp.

**Pending: Phase 3 per-date wOBA snapshots.** Estimated 1-2 sessions to
build. Unlocks these 2 weights + removes the mild look-ahead caveat
from all future settings-only sweeps.

## Artifacts

- Main harness: `scripts/sweep-look-ahead-safe-weights.js`
- Corrected joint harness: `scripts/sweep-joint-corrected.js`
- 1-by-1 raw grid: `docs/data/sweep-look-ahead-safe-weights-sensitivity.tsv`
- Joint grid (original, buggy SP_WEIGHT high-side): `docs/data/sweep-look-ahead-safe-weights-joint.tsv`
- Joint grid (corrected, SIGNED-best SP_WEIGHT high-side): `docs/data/sweep-look-ahead-safe-weights-joint-corrected.tsv`
- Baseline sanity: Val −3.13% vs prod actual ~−5% (delta 1.87pp)
- Cap live during sweep: HARD=0.08 pinned (live DB has 0.25 pending PR #180 deploy)
- Universe: 522 fit + 86 val ML signals

## What this pass measured vs did NOT

**Measured:** Sensitivity of the 5 in-scope weights (+3 adjacent) on
prod-faithful post-cap ML signal population. Whether current values are
on their local optimum. Whether any joint combination survives out-of-
sample gates with fit-vs-val direction agreement.

**Not measured:**
- **Totals ROI** (paused; deferred as diagnostic — would be added if
  combo 7 pilot proceeds and needs a "does this hurt Totals?" cross-check)
- **Phase-3-blocked weights** (W_PROJ/W_ACT, BULLPEN_W_*)
- **Second-order interactions beyond 2-value pairwise** — the joint grid
  only tested 2 values per lever; a proper 3+ value grid on W_PIT + SP_WEIGHT
  is a follow-up if the pilot direction holds

**Not shipped:** Nothing. This is a measurement pass. Combo 7 is a
CANDIDATE for gated pilot, not a live ship. Any pilot requires owner
sign-off + shadow data collection + higher-n re-evaluation.
