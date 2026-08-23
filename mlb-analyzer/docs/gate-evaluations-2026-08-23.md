# Gate evaluations: park-neutral, BsR re-spec, FRV, hand-conditional (2026-08-23)

> ---
> **ANNOTATION 2026-08-23 — re-run on the decontaminated corpus.**
> Every figure on this page was computed on a corpus that retained 128
> games priced after real first pitch
> (`docs/post-start-pricing-tagged-2026-08-22.md`). Those are now excluded
> and everything here was re-run.
>
> **No verdict changed and no tier moved.** Absolute numbers shift because
> the corpus drops 790 -> 662 (16.2%); the shifts were checked against a
> 20-seed n-matched control drawn from the *contaminated* corpus, and
> **every one lands inside the control's p5..p95** — i.e. they are power
> effects, not contamination effects.
>
> Superseding numbers: `docs/decontaminated-rerun-2026-08-23.md`.
> Figures below are left as originally recorded rather than overwritten.
> ---


> **Nothing flipped.** Four evaluations, all on calibration targets.
> New harness: `scripts/calibration-ab.js`.

## TL;DR

| | result |
|---|---|
| **park_neutral** | A/B **does** exist — I was wrong to file it forgotten. But it's ROI-based *and* predates a fix to the feature. Re-run on calibration: **better on all 5 metrics, not significant** |
| **BsR re-spec** | Done and run. Calibration is now primary; CLV demoted and split. Verdict unchanged: **not distinguishable** — but now on a metric that could have distinguished |
| **FRV** | Evaluation written and run instead of flipping. **Better on all 5 metrics, not significant.** Flip criterion + window now defined |
| **hand_conditional** | **Not "awaiting a decision" — UNFLIPPABLE.** `getSettings()` never maps it. No criterion can apply until it's wired |

## 1. park_neutral_inputs_enabled — the A/B exists

**Correction to `docs/feature-gate-inventory-2026-08-23.md`**, which filed
this as forgotten. It was A/B tested: PR #142,
`scripts/backtest-park-neutral.js`, **+3.32pp totals ROI** (+4.39pp on
affected teams).

Two problems with that evidence:

1. **It's ROI-based**, so per the 2026-08-21 rule it measured selection.
2. **It predates a correction to the feature itself.** The 2026-07-02
   audit found the neutralization was applied to *both* the projection
   and actuals components when only actuals carry a home-park signature
   — over-neutralizing extreme-park hitters by ~2.2pp. The actuals-only
   fix landed (`services/model.js:381`) and the audit's recommended
   re-run **was never recorded**.

So the feature running in prod today is not the feature that was tested.

**Re-run on calibration** (790 games, identical set both arms):

| arm | log loss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| OFF | 0.69029 | 0.24857 | 0.0126 | 0.5443 | −0.331 |
| **ON** | **0.68975** | **0.24829** | **0.0114** | **0.5494** | **−0.313** |

The flag moves p(home) on **84.4%** of games (mean |Δp| 0.0034), so it's
genuinely active.

**Δ log loss = −0.00055, CI [−0.00117, +0.00012] — not significant**,
though ~90% of the interval sits below zero.

**Read:** ON is better on *every* metric and misses significance
narrowly. Directionally validated, not statistically established. There
is no case for turning it off, and it is no longer running on
unexamined evidence.

## 2. BsR gate — re-spec'd and run

Implemented as proposed in `docs/bsr-gate-status-2026-08-23.md`.

**`calibration` is now the primary block** in
`services/baserunning-backtest.js` — log loss / Brier / ECE on the
model's win probability, over **every scored game with the same set
under both arms**, with a paired date-clustered bootstrap. Composition
cannot move it.

**CLV is demoted** to `clv_role: 'SECONDARY / CONTEXT ONLY'`, retained
because it's informative about the marginal bets, not because it can
decide the gate.

Run (forward-honest, 2026-06-16 → 2026-08-06):

| | log loss | Brier | ECE |
|---|---|---|---|
| without BsR | 0.67216 | 0.23961 | 0.06264 |
| with BsR | 0.67109 | 0.23909 | 0.06390 |
| **Δ log loss** | **−0.00107** | CI **[−0.00258, +0.00054]** | **not significant** |

n=639. BsR improves log loss and Brier directionally; ECE is marginally
worse.

**Verdict unchanged — but that now means something.** Before, "dead
even" rested partly on a CLV prong whose delta was 41 marginal bets out
of 348. Now it rests on a metric that *could* have separated the arms
and didn't.

## 3. FRV — evaluation written and run, not flipped

Per instruction: spec first, then decide.

**Criterion:** `scripts/calibration-ab.js DEFENSE_FRV_ENABLED false true`
— Δ log loss over all games, identical set, date-clustered CI.
**Flip bar:** CI excludes zero on the negative side, on **≥1200 games**.
**Window:** re-evaluate **2026-09-30**. Recorded in the registry.

Result (790 games):

| arm | log loss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| OFF | 0.68975 | 0.24829 | 0.0114 | 0.5494 | −0.313 |
| **ON** | **0.68888** | **0.24786** | **0.0101** | **0.5528** | **−0.218** |

Flag moves p(home) on **100%** of games, mean |Δp| **0.0083** — twice
park-neutral's. **Δ log loss = −0.00087, CI [−0.00211, +0.00065] — not
significant.**

Better on all five metrics, and the **edge-slope improvement
(−0.313 → −0.218) is the largest measured anywhere in this codebase** —
the only intervention that has moved claimed-edge honesty at all. Worth
watching, not worth flipping on a CI that spans zero.

### A near-miss worth recording

**The first FRV run reported the flag as completely inert** — 0 of 790
games changed. That was **a harness artifact, not a finding**.

`runModel` does not compute team FRV; it *reads*
`game.{away,home}FieldingRunsPerGame`, which `services/jobs.js` builds
before calling it. `preScreenGame` doesn't, so both arms were identical
for a harness reason.

Had I reported it, the conclusion would have been "FRV does nothing,
leave it off forever" — exactly backwards from what the data says once
the input is wired.

**Fixed structurally, not just for FRV:** `calibration-ab.js` now
carries a `CALLER_POPULATED_INPUTS` table and **hard-exits** when a
flag's required caller-populated field is null across the corpus, rather
than reporting a false negative. `computeTeamFieldingRunsPerGame` is now
exported from `services/frv-backtest.js` so the harness populates FRV
the same way prod does. (Two more duplicate copies remain in
`baserunning-backtest.js` and `runmult-totals-backtest.js`.)

## 4. hand_conditional_sp_weight — unflippable, not undecided

The inventory called this "awaiting a decision with no flip criterion."
**It's worse: the flag cannot be turned on.**

`services/jobs.js:getSettings()` returns an **explicit hand-mapped
whitelist**. `USE_HAND_CONDITIONAL_SP_WEIGHT` is **not in it**, so
`model.js:763` reads `undefined`:

```js
const USE_HAND_CONDITIONAL_SP_WEIGHT = !!settings.USE_HAND_CONDITIONAL_SP_WEIGHT;  // always false
```

**No value in `app_settings` can enable this feature.**

It compounds:

```js
const SP_WEIGHT_R = num(settings.SP_WEIGHT_R, 0.865);   // settings.SP_WEIGHT_R is undefined
const SP_WEIGHT_L = num(settings.SP_WEIGHT_L, 0.649);   // ditto
```

`sp_weight_r` and `sp_weight_l` are **also unmapped**, so the model uses
its hardcoded constants. **The operator-tuned `sp_weight_l = 0.7` sitting
in `app_settings` has never had any effect** — the model has always used
0.649.

Shadow logging still fires because the alternative path uses those
hardcoded constants, which is why the feature *looks* live.

**This is the UI-parity rule inverted.** That rule catches "schema key
with no UI". This is schema key **+** UI control **+** stored
`app_settings` value, with **no `getSettings()` mapping to read any of
it** — a whole feature that is configurable in appearance only.

**Writing a flip criterion now would be premature.** Sequence:

1. Map `use_hand_conditional_sp_weight`, `sp_weight_r`, `sp_weight_l` in
   `getSettings()`.
2. Verify `sp_weight_l` actually takes effect (a calibration A/B on
   0.649 vs 0.7 becomes meaningful only after this).
3. *Then* run `calibration-ab.js USE_HAND_CONDITIONAL_SP_WEIGHT false true`
   and set a bar and window.

Registry now carries `blocked_reason` for this, and the health check
reports it as **`blocked`** rather than `awaiting_decision` — a gate that
cannot be flipped should not send anyone to make a decision they can't
act on. `blocked_reason` still counts as needing attention, because a
wiring defect is a bug, not a decision to wait on.

## What this changes in the inventory

| | before | after |
|---|---|---|
| needs attention | 8 | **6** |
| ROI-contaminated | 6 | **5** |
| park_neutral | forgotten | decided (calibration) |
| defense_frv | awaiting_decision | in_window, bar + 2026-09-30 |
| hand_conditional | awaiting_decision | **blocked** (wiring defect) |
| bsr | roi criterion | calibration criterion |

## The pattern across all four

Every flag tested is **directionally better on every metric and
statistically significant on none.** park-neutral −0.00055, FRV
−0.00087, BsR −0.00107 — all with CIs spanning zero.

That is consistent with the component diagnostic: a weak-but-sound model
whose individual improvements are each too small to resolve at ~800
games. It is *not* evidence any of them is worthless, and it is not
evidence any should ship. It means **the honest bar — a CI excluding
zero — is not reachable on a single season for effects this size**, and
gate windows should be set against that reality rather than against a
season boundary.

## Related

- `docs/feature-gate-inventory-2026-08-23.md` — the 22-gate inventory this corrects.
- `docs/bsr-gate-status-2026-08-23.md` — the re-spec proposal implemented here.
- `docs/sweep-selection-effect-2026-08-21.md` — why ROI A/Bs could not have settled any of this.
- `docs/component-signal-diagnostic-2026-08-23.md` — why every effect is small.
- `scripts/calibration-ab.js` — the harness.
