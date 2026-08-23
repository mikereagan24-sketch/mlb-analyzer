# Parameter provenance ledger (2026-08-23)

> **One page: which live values rest on nothing.**
> **71 live model parameters. 11 carry current evidence. 11 rest on
> evidence now known to be invalid. 49 were never evaluated at all.**
> (Counts verified against `getSettings()` output; 11 + 11 + 49 = 71.)
>
> **UPDATE 2026-08-22** — first three targets evaluated
> (`docs/three-targets-hfa-cap-framing-2026-08-22.md`). `HFA_BOOST` and
> `CATCHER_FRAMING_MUTE` both came back **defensible** and move to
> "current evidence"; the edge-cap trio was **misclassified** here (ROI
> is the right instrument for a suppression mechanism) and its 8pp level
> is now measured as the worst of nine tested. Running count:
> **14 current / 8 known-invalid / 49 never evaluated.**

Scope: everything `getSettings()` hands `runModel`. "Evidence" means an
argument that the value is *right*, not a record that it *is* the value —
`docs/cohort-v7-cutover-2026-07-05.md` is a birth certificate listing 40+
settings with no justification for any of them, and it is the only
mention 17 of these parameters have anywhere.

## Invalidity classes

| class | why it invalidates | established |
|---|---|---|
| **ROI-selection** | ROI over emitted signals measures *which bets get placed*, not pricing. `calcPnl` never sees the model's numbers, so a kept bet's P&L is byte-identical across arms — only composition can move the aggregate | `docs/sweep-selection-effect-2026-08-21.md` |
| **Orphaned key** | `getSettings()` is a hand-mapped whitelist; unmapped keys are invisible to the model, so any "tuning" of them never took effect | `docs/getsettings-whitelist-audit-2026-08-23.md` |
| **Confounded sweep** | `BAT_HAND_SP` moved `SP_WEIGHT` while leaving `RELIEF_WEIGHT` fixed, breaking the sum invariant — a batter-wOBA *level shift*, not a platoon reweight | `docs/sp-weight-calibration-sweep-2026-08-22.md` |
| **Pre-fix implementation** | The A/B tested a version of the feature that no longer exists | `docs/gate-evaluations-2026-08-23.md` |

## A. Current evidence — 11 parameters

| parameter | live | original evidence | status |
|---|---|---|---|
| `W_PIT` / `W_BAT` | 0.40 / 0.60 | `optimize-params.js` top-20 **by ROI** — invalid | **Re-validated 2026-08-22, and RE-RUN on the corrected harness** (framing + FRV populated). Conclusion holds: indistinguishable from the 0.30 optimum (gap 0.00026, CI [−0.00180, +0.00105]), inside a flat 0.20–0.50 plateau, **≥0.80 still ruled out** (CI excludes zero). Production has the **best ECE on the grid** (0.0074). No value clears all three gates |
| `SP_WEIGHT` | 0.80 | July sweep "combo 7" — **ROI + confounded** | **Re-validated 2026-08-22, and RE-RUN on the corrected harness.** Conclusion holds: shallow curve, minimum at 0.60 by 0.00030, **no CI excludes zero**, no fold set same-sign. Grid span 0.00117 (was 0.00126) — the small shift confirms the original sweep used the correct paired key. Production has the **best ECE on the grid** (0.0074) and matches the 0.800 volume-weighted BF benchmark |
| `RELIEF_WEIGHT` | 0.20 | complement of `SP_WEIGHT` | Inherits the above; sum invariant holds |
| `W_PROJ` / `W_ACT` | 0.45 / 0.55 | Phase-3-blocked, never measured | **Measured** 2026-08-21. No distinguishable effect across 0.1–0.9; production sits inside the null |
| `PARK_NEUTRAL_INPUTS_ENABLED` | true | PR #142 A/B — **ROI *and* pre-fix** | **Re-validated** 2026-08-22. Better on all 5 metrics; Δ −0.00055, CI [−0.00117, +0.00012] — not significant |
| `SP_WEIGHT_R` / `SP_WEIGHT_L` | 0.865 / 0.649 | **orphaned** — never read until 2026-08-22 | **Wired + set to benchmark.** 0.649/0.865 from `pitcher_game_log` BF data |
| `USE_HAND_CONDITIONAL_SP_WEIGHT` | false | none — was **unflippable** | **Evaluated** 2026-08-22, re-run on the corrected harness. Worse on 4 of 5, **better on ECE** — the earlier "worse on all five" was inaccurate. Tier 4 |
| `SIGNAL_EDGE_HARD_CAP_PP` | **0.25** | was 0.08 on an ROI backtest | **Re-derived 2026-08-22 from the production audit log**, not the backtest. Of 1283 signals the cap has suppressed, **279 carried an implausible market line** (up to +94400) and **all 279 had edge ≥ 0.25**, while **zero** below 25pp did. 25pp is empirically where the corrupt population begins. Restored to its documented purpose as a data-integrity ceiling |
| `DEFENSE_FRV_ENABLED` | false | precondition (now cleared) | **Evaluated.** Better on all 5, not significant; window to 2026-09-30 |

## B. Known-invalid evidence, not re-validated — 11 parameters

**These are live values whose stated justification we now know does not
support them.**

| parameter | live | evidence | invalidity |
|---|---|---|---|
| ~~`SIGNAL_EDGE_HARD_CAP_PP`~~ **moved to section A** | ~~0.08~~ **0.25** | `ship-hard-cap-0.08` ROI backtest | ~~ROI-selection~~ **MISCLASSIFIED — corrected 2026-08-22.** The cap *suppresses* (`model.js:1546 continue`), so selection **is** its mechanism and ROI measures it directly. The gap was always the 8pp level, not the instrument. **Now measured: 8pp is the worst of 9 levels tested** — it suppresses the only positive edge band (8-10pp, +15.1% ROI) and costs 1.41pp vs no cap. Code's own data-driven default is **0.25** |
| `SIGNAL_EDGE_SOFT_CAP_PP` | 0.06 | same | **Inert on P&L** — only sets the advisory `edge_suspect` flag; never changes emission or staking |
| `SIGNAL_EDGE_CAP_ENABLED` | true | same | Selection mechanism, correctly measured by ROI (see above) |
| `UI_HIGHLIGHT_TOT_OVERS_ENABLED`\* | false | "backtest showed no edge in overs" | ROI-selection |
| `PA_WEIGHTS` | 9-slot vector | July sweep — "Val movement without fit signal, noise catch" | ROI-selection |
| `BP_STRONG_WEIGHT_R/L`, `BP_WEAK_WEIGHT_R/L` | 0.55/0.35, 0.45/0.65 | July sweep, "marginal at one endpoint" | ROI-selection |
| `SP_PIT_WEIGHT` | 0.75 | July sweep declared it "completely INERT" | ROI-selection. Also carries a **dead 0.95 clamp** (shrinkage ceiling caps forecast-driven weight ≈0.79) |
| `BULLPEN_W_PROJ` / `BULLPEN_W_ACT` | 0.25 / 0.75 | 2026-07-07 sweep on **30-team mean wOBA spread** | *Not* selection-contaminated — wOBA spread is immune. But it is not a calibration test either, and the pair remains **Phase-3-blocked**: the global pair was unblocked 2026-08-21, the bullpen pair routes through a different blend with a different gate, so **nothing transferred** |

\* Not in the 71 — it is UI-only by design and never reaches `runModel`
(`services/jobs.js:211`). Listed here because it is a live behavioural
setting resting on invalid evidence, but it is not a model parameter.

The edge-cap trio is the most consequential entry on this page: three
live values in the emission path, all resting on one ROI backtest, with a
later targeted search finding no support for the level.

## C. Never evaluated — 49 parameters

**No evidence of any kind on record. Not invalid — simply unexamined.**

**Core run/probability conversion** — the arithmetic spine of every price:
`RUN_MULT` 46 · `PYTH_EXP` 1.83 · `WOBA_BASELINE` 0.23 · `TOT_SLOPE` 0.08
· `WP_CLAMP_LO/HI` 0.25/0.75 · `TOT_PROB_LO/HI` 0.20/0.80

`PYTH_EXP` was explicitly **deferred** after a gate-d failure (#179) and
never returned to.

**`HFA_BOOST` = 0.017** — ~~unexamined~~ **EVALUATED 2026-08-22, and this
entry was wrong.** See `docs/three-targets-hfa-cap-framing-2026-08-22.md` §1.

This page called it "a hardcoded boost for an effect we cannot
demonstrate," which ran two separate claims together. The *effect* is
indeed not established in this corpus (home win rate 51.83%, under 1 SE
from 50%). But the *parameter* sits at the **argmin of the log-loss
curve** and within 0.0003 of the mean-matching value (implied 0.01673 vs
live 0.01700), and it **halves ECE** (0.0147 -> 0.0074). AUC and edge
slope are identical to five decimals — a constant shift cannot reorder
anything, so this is a *pure calibration* parameter and calibration is
the only axis it can move. **Keep. Moved to section A.**

**Weather** — `WIND_SCALE` 2.0. Note the 8 mph deadband in
`calcWindFactor` discards ~54% of games and remains an open question
(`docs/wind-deadband-cliff-open-question-2026-08-19.md`).

**Sample gates** — `MIN_PA` 60 · `MIN_BF` 100 · `BULLPEN_MIN_BF` 50.
`MIN_PA`'s *cliff* was fixed 2026-08-21 (piecewise shrinkage to 150 PA);
the threshold value 60 itself was never justified.

**Framing / defense mutes** — `CATCHER_FRAMING_MUTE` **1.0**
(**EVALUATED 2026-08-22**: better than the schema default 0.65 on all
five metrics; Δ -0.00007, not significant. Divergence is benign — keep
1.0 and align the schema default) ·
`CATCHER_FRAMING_TAKES_PER_GAME` 58 · `CATCHER_FRAMING_ABS_FACTOR` 0.8 ·
`CATCHER_FRAMING_MIN_PITCHES_2026` 750 · `DEFENSE_FRV_MUTE` 0.5 ·
`DEFENSE_FRV_OPPS_PER_GAME` 25

Three of these — `CATCHER_FRAMING_ABS_FACTOR`, `DEFENSE_FRV_OPPS_PER_GAME`,
`QUICK_HOOK_FACTOR` — have **zero mentions in any doc**, not even a birth
certificate.

**Per-hand defaults** — 7 × `BAT_DFLT_*`, 4 × `PIT_DFLT_*`,
`UNKNOWN_PITCHER_WOBA` 0.335, `MARKET_TOTAL_DFLT` 8.5. Birth-cert listing
only. These fire whenever a player fails to resolve — the 2026-07-23
roster-gate incident hit 79/90 batters on one slate, so they are not rare.

**Opener path** — `OPENER_PIT_WEIGHT` 0.15 · `OPENER_RELIEF_PIT_WEIGHT`
0.25 · `BULK_PIT_WEIGHT` 0.6 · `QUICK_HOOK_FACTOR` 0.9

**Emission** — `SIGNAL_EMIT_FLOOR_PP` 0.01 · `FAV_ADJ` 8 · `DOG_ADJ` 4
(dismissed as "negligible" in PR #174 without a recorded measurement)

**Flags on mechanism grounds** — `USE_OPENER_LOGIC`,
`SIGNAL_VENUE_AWARE_ENABLED`, `KALSHI_DIRECT_PRIMARY_ENABLED`,
`KALSHI_DIRECT_TOTALS_ENABLED`, `BULLPEN_DOWNWEIGHT_STARTERS`,
`SP_PREFER_ROTOWIRE`, `CATCHER_FRAMING_ENABLED`. Argued from
construction, not measured — legitimate for structural choices, but not
evidence a value is optimal.

## What this page says

**11 of 71 live parameters carry evidence that survives current
standards.** All eleven were validated or re-validated in the last three
days; before that the number was **zero**.

The honest summary is not that the model is badly tuned — it is that
**almost nothing in it was ever tuned on evidence that measures
pricing.** Every historical sweep in this repo graded on ROI over
emitted signals, and that instrument cannot distinguish a better price
from a different bet set.

Two things follow, and they point opposite ways:

1. **This is less alarming than it looks.** The component diagnostic
   showed the model is weak-but-sound: inputs directionally right,
   combination better than a fitted linear alternative, probability
   scale not obviously wrong. Unexamined is not the same as wrong, and
   several of these values likely landed near-right by mechanism.
2. **It caps what re-tuning can deliver.** The model is significantly
   worse than the market and not demonstrably better than a constant.
   No parameter on this page is going to close that gap — the
   edge-honesty scope put the ceiling low. Re-validating 49 constants
   would be a large effort against an effect size we already know we
   cannot resolve.

**The defensible priority is not to re-validate everything.** It is:

- **The edge-cap trio** — three live values in the emission path with a
  targeted search having found no support. Highest-value re-derivation.
- **`HFA_BOOST`** — cheapest possible check, and the underlying effect is
  not established.
- **`CATCHER_FRAMING_MUTE` = 1.0 vs default 0.65** — an unexplained live
  divergence, one A/B away from an answer.
- Leave the rest recorded-as-unexamined. The ledger's value is that the
  list now exists and the gate health check reports on it.

## Housekeeping found while compiling

~~`getSettings()` returns **`odds_api_key`**~~ — **DONE 2026-08-22.**
Moved to a dedicated `getOddsApiKey()` accessor; the two genuine
consumers updated; `GET /api/settings` reads `app_settings` directly so
the UI was unaffected. `getSettings()` now returns exactly **71** keys —
the live parameter count, with no secret riding along.

**New, and more serious:** every calibration A/B run before 2026-08-22
scored with **catcher framing silently absent** — the inputs are
caller-populated and the harness never set them. The corrected OFF-arm
baseline moves 0.68975 -> 0.68951 and the edge slope -0.313 -> -0.243.
Deltas are probably intact; the absolute figures on four other pages are
not. See `docs/three-targets-hfa-cap-framing-2026-08-22.md` §4.

## Related

- `docs/sweep-selection-effect-2026-08-21.md` — why the historical evidence base is invalid.
- `docs/getsettings-whitelist-audit-2026-08-23.md` — orphaned keys; the reachable gate standard.
- `docs/component-signal-diagnostic-2026-08-23.md` — why the effects are small.
- `docs/edge-honesty-scope-2026-08-22.md` — the ceiling on what tuning can deliver.
- `docs/feature-gate-inventory-2026-08-23.md` — the 22 gated features.
- `services/feature-gate-registry.js` — the machine-readable half of this page.
