# Sweep ROI measures selection, not pricing (2026-08-21)

**Status:** structural finding, acted on. Rule added to `CLAUDE.md`
("Sweep ROI measures selection, not pricing"); the decomposition is now
unconditional output from `services/parameter-sweep.js`.

Found while asking why ML ROI rose with `W_PROJ` while totals ROI fell —
a plausible-looking "opposing response" that turned out to be an
artifact of the signal mix shifting.

## 1. The claim

Any sweep scored by **re-emitting signals under new settings and grading
them** measures *which bets get placed*, not *how well they are priced*.
Such a sweep can never validate a pricing change. It can validate an
emit-threshold change, because there selection is the thing under test.

## 2. Why it is structural

```js
// services/model.js
function calcPnl(signal, awayScore, homeScore, marketTotal) { ... }
// services/parameter-sweep.js
function wageredFor(signal) {
  if (signal.type === 'ML') { const ln = Number(signal.marketLine); ... }
  return 110;
}
```

`calcPnl` reads the side bet, the market line and the final score. It
never sees the model's numbers. `wageredFor` reads only the market line —
stake is **not** edge-scaled (no Kelly sizing anywhere).

So a signal emitted **on the same side** at two parameter values has a
byte-identical `pnl` and `wagered` at both. A swept parameter can move
ROI through exactly two channels:

1. which signals clear `SIGNAL_EMIT_FLOOR_PP` — **composition**
2. which side gets bet — **side flips**

Both are selection. This is not a power problem that more seasons would
fix; it is what the harness computes.

## 3. The demonstration

W_PROJ/W_ACT sweep, 814 games, 10 grid values, 742 baseline signals.

**Fixed core** — the 459 signals (61.9% of the baseline set) emitted at
*every* grid value:

| W_PROJ | core ROI% | core ML ROI% | core TOT ROI% |
|---|---|---|---|
| 0.10 … 0.90 (all ten) | **−4.78** | **−2.25** | **−6.52** |

**Span 0.00pp.** Identical to the last decimal at every grid point.

The full-population spans were ML 4.33pp and TOT 2.62pp. All of it is
composition. Side flips: **0 at seven of nine grid points**, 1 at 0.80,
5 at 0.90 — and `d_stay` is exactly `0.00` wherever flips are zero,
which is the arithmetic proof that nothing kept was repriced.

**What actually drove the headline numbers:**

| case | nEnter | ROI enter | nLeave | ROI leave | dTotal |
|---|---|---|---|---|---|
| 0.60 ML | 38 | +19.66 | 50 | −18.51 | **+4.33** |
| 0.70 TOT | 38 | +0.51 | 31 | +19.65 | **−1.54** |

ML "improved" by shedding bets that lost; totals "worsened" by shedding
bets that won. Same churn, opposite luck.

These are marginal by construction — median edge **1.3–2.6pp for
enterers/leavers vs 3.1–3.8pp for stayers**, against a 1.0pp floor — and
every bootstrapped CI spans zero, typically by ±30pp at n≈30–80:

| | ROI | 95% CI |
|---|---|---|
| 0.60 ML enterers | +19.66 | [−13.84, +52.26] |
| 0.60 ML leavers | −18.51 | [−43.97, +8.84] |
| 0.70 TOT leavers | +19.65 | [−15.87, +50.64] |

## 4. The one part that *is* mechanistic

The **counts** move for a real reason. Raising `W_PROJ` regresses team
wOBA toward projection. ML edge depends on the *difference* between two
teams, which regression shrinks — ML signals fell 400 → 361. Totals edge
depends on the *sum*, which regression moves rather than shrinks —
totals rose 367 → 382.

So the mix shift is a genuine consequence of the parameter. The **ROI
consequence of that shift is a coin flip.**

## 5. A trap in detecting side flips

The first flip detector compared `category` and reported 0 flips at
W_PROJ=0.80 while `d_stay` was −0.85 — an inconsistency that had to be
resolved rather than waved through.

Cause: in a tight game **both sides can carry negative American odds**
(e.g. −112 / −108, the vig on a near-pick'em). `categoryFor` buckets ML
by `marketLine < 0`, so a genuine away→home switch keeps
`category='favs'` and looks like the same bet.

Detect a flip by comparing the **realised bet** — category, outcome,
pnl and stake together. With that fix, flips reconcile exactly with
`d_stay` at every grid point.

## 6. What shipped

`services/parameter-sweep.js` now emits unconditionally:

- **run level** `selection_effect`: `core_n`, `core_share_pct`,
  `core_roi_baseline`, **`core_roi_span`**, and a plain-language
  `interpretation` that says outright when the headline is composition.
  Also logged to console on every run.
- **per combo** `vs_baseline_train` (and `vs_baseline_test` for the
  top-K): `n_stay` / `n_enter` / `n_leave` / `n_changed_bet`,
  `roi_stay_combo` vs `roi_stay_baseline`, `d_stay`, and
  `roi_enter` / `roi_leave` each with a bootstrap `ci95`.

Exported for reuse: `signalKey`, `decomposeVsBaseline`,
`coreSignalStats`, `roiBootstrapCI`.

The bootstrap resamples **signals**, deliberately the *narrower*
interval — the point is that even the optimistic CI spans zero. Where a
sweep's headline needs a defensible interval, resample **dates**
instead, as `tmp/sweep-wproj-wact-disciplined.js` does.

Verified: the engine functions reproduce the standalone analysis
exactly — `core_n=459`, `core_share=61.9%`, `core_roi_span=0`,
`core_roi_baseline=−4.78`.

## 7. To actually validate a pricing change

Use a calibration metric over **all games**, not ROI over emitted
signals — claimed edge vs realised frequency, Brier score, log loss.
`scripts/edge-calibration-curve.js` is the existing example of the right
shape. Any target computed on model outputs rather than on the emitted
subset is immune, as is any target that is not ROI (the 2026-07-07
bullpen blend sweep ranked on 30-team mean wOBA spread, which is why it
is unaffected).

## 8. Prior work reframed

Listed in the `CLAUDE.md` rule. The most consequential:

- **`docs/weight-sensitivity-sweep-2026-07.md` "combo 7"** —
  `W_PIT=0.35` + `SP_WEIGHT=0.75`, Val ROI −3.13% → +12.15%. That
  **+15.28pp is a selection effect.** It was carried as a candidate for
  gated pilot; it should not be piloted on that number.
- **`scripts/optimize-params.js`** — the April 2026 top-20-by-ROI grid
  search that selected **production `W_PIT=0.40 / W_BAT=0.60`**. The
  live value rests on this measurement.

Reframed is not the same as wrong-and-discard. It means the ROI delta
measures which near-floor bets happened to land in the sample, so it
cannot support a claim that the model prices better. Any conclusion that
leaned on such a delta needs re-deriving from a calibration metric
before it is acted on.

## Related

- `CLAUDE.md` — "Sweep ROI measures selection, not pricing".
- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` — the sweep this came
  out of.
- `tmp/decompose-wproj-signal-mix.js` — the standalone analysis.
- `scripts/edge-calibration-curve.js` — the immune design.
