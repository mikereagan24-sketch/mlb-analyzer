# Re-runs on the corrected harness, and the cap sign test (2026-08-22)

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


> **Headline: every conclusion holds. Not one verdict changed.**
> The framing defect moved absolute numbers — mostly in the model's
> favour — but no gate flipped, no tier changed, and no recommendation
> reversed.
>
> **On the cap: no level clears Tier 2. Prod's 8pp ranks 13th of 14.**

## 0. The defect was wider than first reported

`docs/three-targets-hfa-cap-framing-2026-08-22.md` §4 reported that
catcher framing was absent from `calibration-ab.js`. Checking the other
harnesses before re-running found it is worse:

| harness | framing | FRV |
|---|---|---|
| `scripts/edge-honesty-scope.js` | missing | **also missing** |
| `scripts/component-signal-diagnostic.js` | missing | **also missing** |
| `scripts/projected-vs-closing-calibration.js` | missing | **also missing** |
| `scripts/calibration-sweep.js` | missing | **also missing** |

**All four scored a model with *both* defensive inputs structurally
disabled** — a model that has never run in production. And
`calibration-sweep.js` is what produced the `W_PIT`/`W_BAT` and
`SP_WEIGHT` re-validations, i.e. two of the eleven parameters the ledger
lists as carrying current evidence.

### The fix is one helper, not five patches

Patching each script is how this codebase ended up with **six** copies of
`computeFramingRvPerGame`. New `services/harness-inputs.js` owns the
list of caller-populated fields and the population logic; all five
harnesses (including `calibration-ab.js`, refactored off its own inline
copy) now call it.

```js
const CALLER_POPULATED_FIELDS = [
  'awayFieldingRunsPerGame', 'homeFieldingRunsPerGame',
  'awayCatcherFramingRvPerGame', 'homeCatcherFramingRvPerGame',
];
```

If `runModel` starts reading a new caller-populated field it goes in one
place, and the guard table in `calibration-ab.js` keys off the same idea.

## 1. FRV — run first, because it is the gate candidate

| arm | logLoss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| OFF | 0.68944 | 0.24815 | 0.0074 | 0.5518 | −0.243 |
| **ON** | **0.68852** | **0.24769** | 0.0074 | **0.5555** | **−0.153** |

- Δ log loss **−0.00092** (was −0.00087), CI **[−0.00215, +0.00059]**
- **4 / 5 windows** — W1 +0.00226, W2 −0.00127, W3 −0.00262, W4 −0.00187, W5 −0.00086
- Blast radius 790/790, mean |Δp| 0.00833
- FRV coverage 790/790

**Against Tier 2:**

| requirement | result |
|---|---|
| sign test p ≤ 0.05 (5/5 at K=5) | **4/5, p = 0.188 — FAILS** |
| point estimate favourable on ≥4 of 5 metrics | 4 better, 1 tied — passes |
| bounded harm: CI upper < +0.001 | +0.00059 — passes |

**Verdict unchanged: still exactly one window short.** Do not enable.

What *did* improve is the edge slope: **−0.243 → −0.153**, now the
largest honesty gain measured anywhere in the repo and larger in
absolute terms than the pre-fix figure suggested. That strengthens the
mechanism case without changing the gate arithmetic.

Per `docs/getsettings-whitelist-audit-2026-08-23.md` §3, re-evaluate at
accumulated windows rather than a calendar date — roughly 3–4 more
favourable windows (~500–600 games).

## 2. park_neutral

| arm | logLoss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| OFF | 0.68995 | 0.24841 | 0.0077 | 0.5477 | −0.264 |
| **ON (live)** | **0.68944** | **0.24815** | **0.0074** | **0.5518** | **−0.243** |

Δ **−0.00051** (was −0.00055), CI [−0.00113, +0.00015]. **3 / 5
windows** (unchanged). Better on all five. Blast radius 667/790.

Bounded harm passes comfortably (+0.00015). Sign test still fails.
**Verdict unchanged:** live value is fine, evidence still short of Tier 2.

## 3. hand_conditional

| arm | logLoss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| **OFF (live)** | **0.68944** | **0.24815** | 0.0074 | **0.5518** | **−0.243** |
| ON | 0.68955 | 0.24821 | **0.0063** | 0.5511 | −0.249 |

Δ **+0.00011** (was +0.00009), CI [−0.00036, +0.00061]. **2 / 5 windows.**

**One correction:** the earlier write-up called this "directionally worse
on all five metrics." On the corrected harness it is worse on four and
**better on ECE** (0.0063 vs 0.0074). Still Tier 4 on the sign test, and
still no case for enabling — but "all five" is no longer accurate and the
audit doc should not keep saying so.

Note this arm now uses `sp_weight_l = 0.649`, matching prod.

## 4. Edge-honesty scope — the number that moved most

ML slope **−0.313 → −0.243**. But the important change is in the
by-magnitude breakdown:

```
-- ML --
|claimed edge|      n    slope    95% CI
BELOW cap (<8pp)  700   -0.871   [-1.904, +0.127]   excludes 1.0
ABOVE cap (>=8pp)  90   +0.321   [-0.650, +1.276]   does NOT exclude 1.0
```

A perfectly honest edge has slope **1.0**. So on the corrected harness:

- **Below-cap claimed edges are demonstrably dishonest** — CI excludes 1.0.
- **Above-cap claimed edges are the only ones not statistically
  distinguishable from honest.**

**The cap suppresses the one band whose claimed edge cannot be shown to
be dishonest.** That is a mechanism confirmation of §5 arrived at from a
completely different instrument, and it is stronger than the pre-fix
version of the same table.

The 2–4pp ML band remains the worst offender (slope −3.257, CI
[−5.345, −1.069], excludes 0 *backwards*) and no cap can touch it,
because a cap is a high-side filter.

## 5. The cap: does any level clear Tier 2?

`scripts/edge-cap-sign-test.js` (new). Fourteen levels, paired
date-clustered bootstrap on the **delta** (both arms on the same
resampled dates, so the shared date variance cancels instead of being
counted twice), plus a K=5 window sign test per level.

```
cap   supp_n  kept_ROI   dROI     95% CI (paired)    windows  sign-p  T2?
0.04    485    -6.51     -0.50   [-6.28, +5.01]      +---+    0.813   no
0.05    360    -5.35     +0.67   [-3.38, +4.63]      +---+    0.813   no
0.06    264    -6.39     -0.38   [-3.96, +3.35]      +---+    0.813   no
0.07    186    -6.84     -0.82   [-3.57, +1.86]      ++--+    0.500   no
0.08    130    -7.43     -1.41   [-3.34, +0.41]      +---+    0.813   no  <- PROD
0.09     80    -5.39     +0.63   [-1.09, +2.21]      ++--+    0.500   no
0.10     49    -5.69     +0.33   [-1.32, +1.89]      +--++    0.500   no
0.11     31    -6.06     -0.04   [-1.23, +1.15]      +--+-    0.813   no
0.12     19    -6.10     -0.08   [-0.88, +0.71]      +--+-    0.813   no
0.13     10    -6.27     -0.26   [-0.89, +0.36]      +--+-    0.813   no
0.15      4    -6.23     -0.22   [-0.64, +0.15]      -----    1.000   no
0.20      3    -6.13     -0.12   [-0.45, +0.18]      -----    1.000   no
0.25      0    -6.02     +0.00   [+0.00, +0.00]      -----    1.000   no
```

**No level clears Tier 2.** Not one of fourteen is favourable in all five
windows; the best any level manages is 3/5. The best point estimate
(0.05, +0.67) has a CI of [−3.38, +4.63] — it is noise.

### What can be said about 8pp specifically

- **Rank 13 of 14 by ΔROI.** Only 0.04 is worse.
- Its interval is **asymmetric against it**: [−3.34, **+0.41**]. The most
  8pp could plausibly be *helping* is +0.41pp; the most it could be
  *hurting* is −3.34pp. Under the bounded-harm principle that Tier 2 and
  Tier 3 both rest on, **prod fails the check in the direction that
  matters** — and bounded harm is the one part of the standard that does
  not require significance to apply.
- Its 2/5 window record is no better than chance.

So: 8pp is not merely unsupported. It is the level for which the harm
interval is widest and the benefit interval narrowest, and that
conclusion does *not* depend on the n=81 subset you rightly declined to
act on.

### Where that leaves the recommendation

**You asked for a level the standard supports. Tier 2 supports none.**
Picking 0.05 or 0.09 off a point estimate would be exactly the
ROI-chasing the selection-effect doc warns against — those CIs are four
to eight points wide.

The only level with a defensible argument is **0.25, and its argument is
Tier 3, not Tier 2**:

| Tier 3 requirement | 0.25 |
|---|---|
| mechanism pre-registered before the run | **yes** — "edge-sanity", data-error trap; the 0.25 default is in the code comment and predates this analysis |
| point estimate not worse | **exactly 0.00** |
| bounded harm | **exactly [0.00, 0.00]** |
| blast radius measured | **0 of 1026 signals** |

**Be clear about what that means: on this corpus 0.25 is inert.** It is a
"does nothing" pass, and it should not be dressed as an improvement.
That is, however, exactly what a data-error trap *should* look like in
clean data — it fires on corrupted inputs, not on ordinary disagreement.
Max observed edge sits between 0.20 and 0.25.

So the honest statement of the choice:

- The evidence supports **removing 8pp**. That much is as solid as this
  corpus can make it, and it is corroborated independently by §4.
- The evidence supports **no replacement level**.
- Moving to 0.25 keeps the trap for genuinely absurd edges while ending a
  filter that currently removes the most honest band in the book. It is a
  mechanism decision, not an ROI decision, and it should be recorded as
  Tier 3.

**Not applied.** Live emission parameter; your call.

## 6. Component diagnostic — conclusions unchanged

```
predictor              logLoss    d vs base    95% CI                  beats base?
base rate (constant)   0.69321        —
sp (SP quality)        0.69244    -0.00078   [-0.00487, +0.00429]      no
bp (bullpen)           0.69375    +0.00054   [-0.00468, +0.00780]      no
bat (lineup wOBA)      0.69175    -0.00147   [-0.00621, +0.00318]      no
pf (park factor)       0.69364    +0.00043   [-0.00196, +0.00332]      no
all4 combined          0.69625    +0.00303   [-0.00446, +0.01265]      no
model* recalibrated    0.69071    -0.00251   [-0.00773, +0.00286]      no
model as-is            0.68926    -0.00396   [-0.01065, +0.00338]      no
market (ceiling)       0.68311    -0.01011   [-0.01863, -0.00015]    *** YES ***
```

AUC: model as-is 0.5527, all4 combined 0.5137, market 0.5808.

**The market is still the only predictor that beats the base rate.** The
assembled model still beats the fitted 4-input alternative (0.68926 vs
0.69625), so the combination is still doing real work. Nothing here
moves.

## 7. What changed, in one table

| doc | before | after | verdict |
|---|---|---|---|
| FRV | Δ −0.00087, 4/5 | Δ **−0.00092**, 4/5 | unchanged — 1 window short |
| park_neutral | Δ −0.00055, 3/5 | Δ **−0.00051**, 3/5 | unchanged |
| hand_conditional | Δ +0.00009, 2/5, "worse on all 5" | Δ **+0.00011**, 2/5, **worse on 4, better on ECE** | Tier 4 unchanged; the "all five" phrasing corrected |
| edge-honesty ML slope | −0.313 | **−0.243** | conclusion strengthened |
| component diagnostic | market only | market only | unchanged |

**Every verdict held.** The framing defect was real and worth fixing, and
it changed no decision — which is the outcome worth stating plainly
rather than burying, because the opposite outcome was entirely possible.

## 8. Also done

- `catcher_framing_mute` **schema default 0.65 → 1.0**, aligning it with
  the measured and already-deployed prod value. Verified: schema default
  and prod now agree. The help text records why, so the next reader does
  not re-derive 0.65 from the double-counting argument.

## Related

- `docs/three-targets-hfa-cap-framing-2026-08-22.md` — where the defect was found.
- `docs/framing-duplication-and-edge-units-open-question-2026-08-22.md` — the two structural defects filed alongside.
- `services/harness-inputs.js` — the shared fix.
- `scripts/edge-cap-sign-test.js` — §5.
