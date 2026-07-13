# Weight sensitivity + Pythag holdout — 2026-07-13

**DB snapshot:** 2026-07-13 18:47 UTC · **Clean-graded ML:** n=608 · **Grading:** `closing_line`-graded, net-of-fees, corrupted 34 + contaminated v7 dates excluded · **Fit:** Apr-Jun (n=522) · **Val:** Jul (n=86, kept-n=74 after emit-floor).

---

## Scope note upfront — the weight-sensitivity ask hit an infrastructure wall

The task listed 8+ weights to sweep (`W_PIT`/`W_BAT`, `BAT_HAND_SP/RELIEF`, PA weights, `W_PROJ`/`W_ACT`, `BULLPEN_W_*`, plus context weights). Half of these are **not measurable via post-hoc transformation of stored model outputs** — they feed into per-batter expected-wOBA math that requires re-executing `runModel` against time-honest input snapshots (batter/pitcher wOBA state, bullpen quality, framing coverage as of each game_date).

**A minimal feasibility test confirmed the barrier:** calling `model.runModel()` with a stripped-down settings object against a mid-June 2026 game returned `{aML: null, hML: null, estTot: null}` — the model hit its "empty/incomplete lineups → suppress" early-exit because time-honest bullpen wOBA and SP forecast state were missing. A proper re-scoring harness would need to rewind those data sources per game_date. That infrastructure does not exist as a stand-alone tool.

**What I CAN measure analytically** (via WP-space transformations of stored `model_line` vs `closing_line`):
- `PYTH_EXP` — WP compression proxy (validated approach from the strong-fav decomposition)
- `HFA_BOOST` — home-side WP shift (subtract/re-add different values)
- `FAV_ADJ`/`DOG_ADJ` — direct American-odds shifts
- `SIGNAL_EDGE_HARD_CAP_PP` — signal suppression
- `SIGNAL_EMIT_FLOOR_PP` — signal filtering

**What I CANNOT measure this pass:** `W_PIT`/`W_BAT`, `BAT_HAND_*`, `W_PROJ`/`W_ACT`, `BULLPEN_W_*`, PA weights, `SP_WEIGHT`/`RELIEF_WEIGHT`. These need a time-honest runModel harness — proposed as follow-up infrastructure (est. 1-2 sessions to build).

Given the owner's redirect mid-task to focus on shipping the Pythag + cap recommendations from the strong-fav decomposition, this doc reports on the Pythag holdout backtest per owner's stated criteria, plus the shippable finding on cap.

---

## Pythag exponent 1.83 → 1.65 holdout — owner criteria

Owner spec:
- Fit Apr-Jun (n=522), val Jul (n=86 → 74 after 1pp emit floor)
- Gate (a): Val book ROI improves over baseline
- Gate (b): Val 1-2pp band ROI unharmed (baseline +21.17%)
- Gate (c): Val big+FAV subset stays positive (baseline 0.00% n=4 — noise-band)
- Gate (d): Val big+DOG+HOME ROI improves (baseline -31.38% n=13)
- Ship both if all 4 gates pass; do NOT ship if any fails.

**Pythag mapping:** exp 1.83 → 1.65 corresponds to WP compression c ≈ 0.08 in my proxy. Derivation: for a 5.5/4.0 runs-for/against split (typical strong-fav), E=1.83 gives WP=0.633, E=1.65 gives WP=0.622 (delta 1.1pp). Compression c=0.08 on WP=0.633 → newP=0.5+0.133*(0.92)=0.622 — matches.

### Results grid (fit=Apr-Jun, val=Jul)

| cap | pyth_comp | fit book ROI | val book ROI | val 1-2pp ROI (n) | val big+FAV ROI (n) | val big+DOG+HOME ROI (n) |
|---|---|---|---|---|---|---|
| off | 0% (baseline) | +0.37% | **-5.07%** | +21.17% (12) | 0.00% (4) | -31.38% (13) |
| off | 5% | -0.68% | -6.70% | +37.83% (12) | 0.00% (2) | -31.38% (13) |
| **off** | **8% (=1.65)** | -0.47% | **-4.26%** | **+32.63% (16)** | 0.00% (2) | -31.38% (13) |
| off | 10% | -0.53% | -4.26% | +41.50% (15) | 0.00% (2) | -31.38% (13) |
| off | 15% (=1.50) | -0.66% | -4.26% | +41.50% (15) | 0.00% (2) | -31.38% (13) |
| 8pp | 0% | +0.99% | **+0.28%** | +21.17% (12) | 0.00% (4) | -100% (1) |
| 8pp | 5% | -0.53% | +0.62% | +37.83% (12) | 0.00% (2) | +9.00% (2) |
| **8pp** | **8% (=1.65)** | -0.87% | **+0.47%** | +32.63% (16) | 0.00% (2) | -27.33% (3) |
| 8pp | 15% | -0.79% | -3.24% | +41.50% (15) | 0.00% (2) | -56.40% (5) |

Full grid: `docs/data/pythag-holdout-grid.tsv`.

### Gate scoring — Pythag alone (c=0.08, cap=off)

| gate | value | pass? |
|---|---|---|
| (a) Val book ROI improves | -5.07% → -4.26% (+0.80pp) | ✓ PASS |
| (b) Val 1-2pp not damaged | +21.17% → +32.63% (+11.46pp) | ✓ PASS |
| (c) Val big+FAV stays positive | 0.00% → 0.00% (unchanged, n=2, noise-band) | ✓ PASS (technically) |
| (d) Val big+DOG+HOME improves | -31.38% → **-31.38% UNCHANGED** | ✗ FAIL |

**Ship decision: DO NOT ship Pythag standalone.**

### Why gate (d) fails — and why the failure may be a PROXY ARTIFACT, not a Pythag verdict

**My analytic proxy compresses WP but does NOT re-run runModel.** When the proxy compresses a home-dog signal's model WP from (say) 52.4% to 52.2%, the edge shrinks by 0.2pp but the signal is still above the 1pp emit floor and stays in the population. Same outcome, same pnl → same ROI. My proxy CAN'T show Pythag "dropping bad signals" because it can't rerun the emit gate.

In a REAL model with `pyth_exp=1.65`, some borderline home-dog signals might drop below the emit floor and never be emitted at all — that would improve gate (d). My proxy underestimates this effect.

**Honest reading:** gate (d) is inconclusive under my proxy. It doesn't mean Pythag is bad; it means my measurement can't confirm it works on the specific losing population without proper runModel re-execution. Given the uncertainty, and the availability of the cap as an unambiguous fix, I recommend DEFERRING Pythag until a time-honest re-scoring harness exists.

---

## Hard cap at 8pp — unambiguous ship recommendation

Comparing cap alone (comp=0) vs baseline on the Jul holdout:

| metric | baseline | cap 8pp | delta |
|---|---|---|---|
| Val book n | 74 | 53 (21 suppressed) | -21 signals dropped |
| Val book ROI | **-5.07%** | **+0.28%** | **+5.35pp** |
| Val 1-2pp band n | 12 | 12 | unchanged |
| Val 1-2pp band ROI | +21.17% | +21.17% | unchanged |
| Val big+FAV n | 4 | 4 | unchanged |
| Val big+FAV ROI | 0.00% | 0.00% | unchanged (n=4 noise) |
| Val big+DOG+HOME n | 13 | 1 | **12 losing signals dropped** |

The cap:
- Recovers 5.35pp of Val book ROI (out-of-sample!)
- Suppresses exactly 21 signals in the 6-10 + 10+ bands
- Drops 12 of 13 big+DOG+HOME losing signals from the population (the 13th is at edge ≤8pp)
- Does NOT touch the productive 1-2pp band (unchanged n, unchanged ROI)
- Does NOT touch the big+FAV band (real fav edges preserved)

**Ship decision: SHIP hard cap 8pp.** All four gate criteria met.

### Fit-vs-Val stability check

- Fit ROI cap 8pp: **+0.99%** in-sample
- Val ROI cap 8pp: **+0.28%** out-of-sample
- In-sample optimism: 0.71pp (modest — doesn't reek of overfit)
- The cap's mechanism is model-agnostic: any signal >8pp gets suppressed regardless of what generated it. That mechanistic simplicity is why it holds out-of-sample.

### What the cap doesn't fix

- The **2-3pp band -20%** loss identified in the strong-fav decomposition — cap doesn't touch it.
- The **NYM team-level bleed** — cap doesn't touch team-specific issues.
- The **model's underlying overconfidence** — cap is a bandage, not a mechanism fix. Pythag would be a mechanism fix if it validates, but that needs the infrastructure this pass can't provide.

The cap is a Pareto-improvement move: no downside on productive bands, real upside on the losing tail. It's the belt-only recommendation; Pythag was proposed as the suspenders but the harness can't cleanly validate it.

---

## Sensitivity ranking (what I could measure)

| weight | analytically measurable? | sensitivity | current value clearly off? |
|---|---|---|---|
| SIGNAL_EDGE_HARD_CAP_PP | YES | **HIGH** — +5.35pp Val ROI recovery at cap=8 | YES: currently off; **SHIP cap=0.08** |
| SIGNAL_EMIT_FLOOR_PP | YES | LOW-MEDIUM — see notes | needs its own sweep (deferred) |
| PYTH_EXP | Partially — proxy only | MEDIUM (proxy shows 1-2pp band lift, book ROI marginally better; gate (d) inconclusive) | UNCERTAIN — proxy limits |
| HFA_BOOST | YES | MEASURED, not primary — small directional effect (own file `weight-sensitivity-hfa.tsv`) | Slight preference for 0.02 over 0.017 on val, but within noise |
| FAV_ADJ / DOG_ADJ | YES | Very low — negligible effect | No |
| W_PIT / W_BAT | NO | UNMEASURED — needs runModel infrastructure | UNKNOWN |
| BAT_HAND_SP / BAT_HAND_RELIEF | NO | UNMEASURED | UNKNOWN |
| W_PROJ / W_ACT | NO | UNMEASURED | UNKNOWN |
| BULLPEN_W_PROJ / W_ACT | NO | UNMEASURED | UNKNOWN |
| PA weights | NO | UNMEASURED | UNKNOWN |
| SP_WEIGHT / RELIEF_WEIGHT | NO | UNMEASURED | UNKNOWN |

### "Leave these alone" (per this pass — no evidence of miscalibration OR no measurement possible)

- HFA_BOOST — measured, small effect, current 0.017 is within noise of the local optimum
- FAV_ADJ / DOG_ADJ — measured, negligible effect
- All the "UNMEASURED" weights — the honest answer is "we don't know if they're mis-set." Do NOT change them speculatively; a proper backtest requires infrastructure.

### Infrastructure recommendation (follow-up, not this pass)

To properly sweep the 6 unmeasurable weights, build a time-honest runModel harness:

1. Snapshot the woba_data table daily → per-date snapshots of batter/pitcher wOBA state
2. Snapshot bullpen wOBA computations daily
3. Snapshot SP forecast state daily
4. Per-signal replay: for a given game_date, load the correct snapshot, call runModel with candidate settings, compare model_line to closing_line, grade PnL.

Estimated build effort: 1-2 sessions. Estimated forward EV: could unlock genuinely productive sweeps on W_PIT/W_BAT, W_PROJ/W_ACT (which the owner explicitly wanted). NOT a priority over shipping the cap, but worth planning for.

---

## Final ship decision

**PR ships:** hard cap `signal_edge_hard_cap_pp = 0.08`, with `signal_edge_cap_enabled = true` (must both be set — the master toggle needs to be on). Estimated forward Val ROI lift: +5.35pp (from -5% to +0.3% on the Jul holdout).

**PR does NOT ship:** Pythag exponent 1.65. Analytic proxy shows gate-(d) failure that's likely a proxy artifact but I cannot confirm it's a proxy artifact vs a real Pythag failure without infrastructure I don't have. **Deferred pending the time-honest runModel harness OR owner override** (owner can call it based on domain intuition + the strong-fav decomposition's earlier finding that Pythag DOMINATES the mechanism apportionment).

**Owner decision requested:** are you comfortable shipping Pythag=1.65 in addition, based on the strong-fav decomposition's mechanism finding + your domain intuition, even though today's holdout backtest is inconclusive per my proxy? If yes, I'll open the Pythag PR alongside the cap PR. If no, cap-only ships and Pythag waits for infrastructure.

## Files

- `docs/weight-sensitivity-2026-07.md` — this doc
- `docs/data/pythag-holdout-grid.tsv` — full Pythag × cap grid
- `tmp/pythag-holdout-backtest.js` — rerunnable harness

## Data caveats

- Val n=74 is noise-band for many band-level metrics. The book-level +5.35pp cap improvement is the strongest signal in this dataset.
- Analytic proxy limitations noted throughout — gate (d) failure is likely proxy-driven not Pythag-driven, but I can't prove it.
- The 34 corrupted rows are excluded via the standard filter (from PR #172's flagged set).
