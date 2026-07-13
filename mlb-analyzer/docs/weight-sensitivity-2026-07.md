# Weight sensitivity analytic pass — infrastructure wall + HFA/FAV_ADJ/DOG_ADJ + cap evidence — 2026-07-13

> **Pythag holdout section removed.** The proxy-based gate scoring that originally lived here has been superseded by the prod-faithful holdout in **PR #179** (`docs/pyth-exp-holdout-v2-prod-faithful-2026-07-13.md`). See that doc for the definitive Pythag ship/defer decision (result: DEFER, gate (d) fails on prod-faithful evidence).

**DB snapshot:** 2026-07-13 18:47 UTC · **Clean-graded ML:** n=608 · **Grading:** `closing_line`-graded, net-of-fees, corrupted 34 + contaminated v7 dates excluded · **Fit:** Apr-Jun (n=522) · **Val:** Jul (n=86, kept-n=74 after emit-floor).

---

## Scope note upfront — the weight-sensitivity ask hit an infrastructure wall

The task listed 8+ weights to sweep (`W_PIT`/`W_BAT`, `BAT_HAND_SP/RELIEF`, PA weights, `W_PROJ`/`W_ACT`, `BULLPEN_W_*`, plus context weights). Half of these are **not measurable via post-hoc transformation of stored model outputs** — they feed into per-batter expected-wOBA math that requires re-executing `runModel` against time-honest input snapshots (batter/pitcher wOBA state, bullpen quality, framing coverage as of each game_date).

**A minimal feasibility test confirmed the barrier:** calling `model.runModel()` with a stripped-down settings object against a mid-June 2026 game returned `{aML: null, hML: null, estTot: null}` — the model hit its "empty/incomplete lineups → suppress" early-exit because time-honest bullpen wOBA and SP forecast state were missing. A proper re-scoring harness would need to rewind those data sources per game_date. That infrastructure does not exist as a stand-alone tool.

**What I CAN measure analytically** (via WP-space transformations of stored `model_line` vs `closing_line`):
- `HFA_BOOST` — home-side WP shift (subtract/re-add different values)
- `FAV_ADJ`/`DOG_ADJ` — direct American-odds shifts
- `SIGNAL_EDGE_HARD_CAP_PP` — signal suppression
- `SIGNAL_EMIT_FLOOR_PP` — signal filtering
- `PYTH_EXP` — WP compression proxy (turned out to be misleading; see PR #178 diagnostic and PR #179 for prod-faithful replacement)

**What I CANNOT measure this pass:** `W_PIT`/`W_BAT`, `BAT_HAND_*`, `W_PROJ`/`W_ACT`, `BULLPEN_W_*`, PA weights, `SP_WEIGHT`/`RELIEF_WEIGHT`. These need a time-honest runModel harness — proposed as follow-up infrastructure (est. 1-2 sessions to build).

This doc now scopes down to: (1) the infrastructure wall, (2) HFA / FAV_ADJ / DOG_ADJ measurements, (3) the cap evidence base (shipping via PR #175). The Pythag holdout section has been moved to PR #179.

---

## Pythag exponent holdout — moved to PR #179

The original Pythag section here ran a WP-compression proxy holdout (proxy c=0.08 ≈ pyth_exp 1.65) and scored the owner's 4 gates. PR #178 diagnosed a 17pp harness-vs-prod gap in that proxy (misses the venue-net-at-size override that `processGameSignals` applies before `getSignals`). PR #179 replaced the proxy with a prod-faithful sweep that walks stored `bet_signals` and grades against `closing_line` (venue-net).

**Definitive result lives in PR #179** (`docs/pyth-exp-holdout-v2-prod-faithful-2026-07-13.md`):
- Baseline sanity: 1.83 val book ROI **-4.11%** vs prod actual ≈ -5% (0.89pp delta — harness aligned).
- Gates (a)/(b)/(c) PASS, **gate (d) FAIL** on prod-faithful evidence: big+DOG+HOME goes -33.60% → -39.64% at pyth_exp 1.65.
- **Ship decision: DEFER.** Cap (PR #175) is the belt for big+DOG+HOME; Pythag isn't needed as a second belt.

The proxy grid + proxy harness that lived on this branch (`docs/data/pythag-holdout-grid.tsv`, `tmp/pythag-holdout-backtest.js`) have been removed in this strip commit to prevent them from being read as authoritative. `tmp/weight-sensitivity-analytic.js` is retained — its HFA / FAV_ADJ / DOG_ADJ measurements are WP-space transforms on stored `model_line` (no runModel dependency), independent of the Pythag proxy issue, and still valid.

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
- The **model's underlying overconfidence** — cap is a bandage, not a mechanism fix. Pythag was proposed as a mechanism fix in PR #173 but PR #179's prod-faithful holdout shows pyth_exp 1.65 doesn't help gate (d), so Pythag stays deferred.

The cap is a Pareto-improvement move: no downside on productive bands, real upside on the losing tail. It's the belt.

---

## Sensitivity ranking (what I could measure)

| weight | analytically measurable? | sensitivity | current value clearly off? |
|---|---|---|---|
| SIGNAL_EDGE_HARD_CAP_PP | YES | **HIGH** — +5.35pp Val ROI recovery at cap=8 | YES: currently off; **SHIP cap=0.08** (via PR #175) |
| SIGNAL_EMIT_FLOOR_PP | YES | LOW-MEDIUM — see notes | needs its own sweep (deferred) |
| PYTH_EXP | Proxy MISLEADING; superseded by PR #179 prod-faithful holdout | see PR #179 | **DEFER** — PR #179 gate (d) FAIL on prod-faithful evidence |
| HFA_BOOST | YES | MEASURED, not primary — small directional effect (regenerable via `tmp/weight-sensitivity-analytic.js` SWEEP 2) | Slight preference for 0.02 over 0.017 on val, but within noise |
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

**Ships (via PR #175):** hard cap `signal_edge_hard_cap_pp = 0.08`, with `signal_edge_cap_enabled = true` (both must be set — the master toggle needs to be on). Estimated forward Val ROI lift: +5.35pp (from -5% to +0.3% on the Jul holdout, per the evidence in this doc).

**Defers (per PR #179):** Pythag exponent 1.65. Prod-faithful gate scoring in PR #179 shows gate (d) big+DOG+HOME fails (-33.60% → -39.64%). Not shipping Pythag.

## Files

- `docs/weight-sensitivity-2026-07.md` — this doc (retained: infrastructure wall + sensitivity ranking + HFA/FAV_ADJ/DOG_ADJ measurements + cap evidence)
- `tmp/weight-sensitivity-analytic.js` — analytic sweep harness (WP-space transforms; source of the HFA/FAV/DOG numbers used in the sensitivity ranking)
- **Removed by strip commit:** `docs/data/pythag-holdout-grid.tsv` + `tmp/pythag-holdout-backtest.js` — proxy Pythag artifacts superseded by PR #179's prod-faithful sweep

## Data caveats

- Val n=74 is noise-band for many band-level metrics. The book-level +5.35pp cap improvement is the strongest signal in this dataset.
- The 34 corrupted rows are excluded via the standard filter (from PR #172's flagged set).
