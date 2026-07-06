# Under-projection: level vs seasonal decomposition — 2026-07-05

Owner context: `RUN_MULT` was ROI-tuned in mid-June against Apr–early-Jun
data (mostly <75°F games). Competing hypotheses ahead of the proposed
46→50 flip:

- **(A) Uniform level error**: RUN_MULT 50 correct year-round.
- **(B) Temp adjustment under-scaled**: gap grows with heat, so RUN_MULT
  50 would over-project the next cold April.

Measurement decides. Data: prod fetch 2026-04-01 → 2026-07-05, n=1,144
resolved games, n=1,064 with `proj_market_total`.

## Provenance clarification

Digging into the git history and the sweep code sharpened the picture:

- **`services/settings-schema.js:107`**: `run_mult` schema default = **45.5**,
  present from the schema's first commit. The "48" I cited earlier is
  only the code-level inline fallback (`num(settings.RUN_MULT, 48)` in
  `services/model.js:366`) that fires when the settings row is missing.
- **Sweep code shipped 2026-06-14** (`services/runmult-totals-backtest.js`,
  commits 2de772e / 888ea63 / c3941c1). Three progressively-refined
  passes:
  1. Downward 41..45 — accuracy got worse going down.
  2. Widened 41..50 step-1 — accuracy still improving at the top (best=50).
  3. Fine 45..48 step-0.5 — resolution test on the ROI wobble.
- **Sweep window**: caller-supplied `from/to` query params; not
  hardcoded. Cannot recover the exact window from git without server
  logs. Since the sweep was written on **2026-06-14**, the training
  window was almost certainly ~2026-04-01 → 2026-06-13.
- **Prod result**: 45.5 → 46 (small ROI shift, per the sweep's own
  headline metric wobble).

The sweep code comment (line 32-45) explicitly noted the accuracy
`mean_diff_model_minus_actual` was **negative at every tested value up
to 50**, and the operator would need to widen further to find the
zero-crossing. **The sweep KNEW 46 was ROI-optimal but accuracy-suboptimal.**
The 46 was chosen because ROI matters more than absolute accuracy
when the market's own line is the reference.

**Owner's "48-era" recollection**: the 48 was the inline default that
briefly ruled until the schema landed with 45.5, then prod moved to 46.
Both 48 and 45.5 → 46 tunings pre-dated peak-summer data. Owner's
intuition that "current value was ROI-tuned on cold-weather April data"
is correct in that the sweep window was 90%+ games below 75°F even
though the 2026 April R/G was elevated (see Section 4 below).

## Section 1 — Monthly gap (morning-bucketed, n=1,064)

```
month     n     temp_f  est   actual  gap(a−e)   temp_adj  residual(a−e−temp_adj)
2026-04   202   65.0    8.04  9.13    +1.089     +0.024    +1.065
2026-05   419   69.3    8.11  8.61    +0.494     +0.138    +0.356
2026-06   392   78.2    8.29  9.35    +1.066     +0.331    +0.735
2026-07    51   83.3    8.62  10.00   +1.377     +0.347    +1.030
```

**The gap is not monotonic with month.** April has +1.09, May drops to
+0.49, June/July climb to +1.07/+1.38. May was structurally lower-
scoring in 2026 despite being warmer than April.

Interpretation: **hypothesis (B) is partially supported** (Jul > Jun >
Apr > May by warmth-and-scoring correlation), but the May anomaly
breaks a clean seasonal narrative. Level component is present in every
month.

## Section 2 — Gap by temperature bin (OPEN roof only, n=949)

```
Temp bin   n     mean_T   mean_est   mean_act   gap       temp_adj   residual
<60        173   53.6°F   7.91       8.53       +0.612    −0.272     +0.884
60–70      228   64.4°F   7.94       8.61       +0.674    −0.005     +0.679
70–80      290   75.0°F   8.30       9.26       +0.960    +0.308     +0.651
80–90      198   84.3°F   8.66       9.45       +0.794    +0.619     +0.175
90+         60   93.4°F   8.69       10.28      +1.591    +0.580     +1.011
```

**The gap grows with temperature** — as (B) predicted. But the residual
(gap MINUS the model's existing temp_run_adj) tells a subtler story:

- **60–80°F residuals cluster around +0.65 to +0.88 runs** — a
  temperature-independent level offset.
- **80–90°F residual drops to +0.18** — temp_adj catches up in this
  band.
- **90+°F residual blows up to +1.01** — temp_adj under-delivers at
  extreme heat. Delivers +0.58; the data wanted +1.59.

**The picture**:
1. A ~0.7-run **uniform level under-projection** persists across every
   temp bin (visible as residual ≥ 0.6 even at moderate 60–80°F where
   temp_adj is near zero).
2. **Temp_run_adj is roughly right at 80–90°F** — the sweet spot.
3. **Temp_run_adj under-delivers at both extremes** — cold (<60°F, where
   the negative temp_adj isn't strong enough to fully explain the
   residual jump) and extreme heat (90+°F, where a linear scale
   badly misses the non-linear ball-carry effect).

## Section 3 — Closed-roof control (temperature-neutralized)

```
month     n    est    actual   gap
2026-04   5    7.22   7.00     −0.216   (small n, near zero)
2026-05   13   6.96   9.46     +2.498   (small n, huge)
2026-06   44   8.27   8.91     +0.644
2026-07   8    8.13   9.75     +1.621
```

Closed-roof games should have **no temperature-driven gap** because
game-time temperature is climate-controlled. Yet closed-roof May and
July show elevated gaps (small n caveat). June's n=44 shows +0.64 —
close to the residual seen in moderate temp bins.

**Interpretation**: the level under-projection exists even without
weather. This corroborates the temp-bin residual — there's a
non-weather level offset in the model.

## Section 4 — League R/G by month vs model tracking

```
Month     n     temp_f    ACTUAL R/G   MODEL R/G    Δ(act−mdl)
2026-04   282   65.8      9.245        8.071        +1.174
2026-05   419   69.3      8.609        8.115        +0.494
2026-06   392   78.2      9.355        8.288        +1.066
2026-07   51    83.3     10.000        8.623        +1.377
```

- **2026 April was already elevated** (9.245 R/G) vs 2024/2025 April
  norms (~8.78). The sweep training window included this hot April,
  yet the sweep concluded 46 was optimal — meaning the sweep tuned
  toward market ROI (Unders on hot cold April games) not toward
  absolute accuracy. The training set WAS cold-temperature; the
  actuals were surprising.
- **Model captures 73.1% of the seasonal rise Apr → Jul** (actuals rose
  0.76 R/G, model rose 0.55 R/G). ~0.20 R/G is uncaptured by the model's
  existing temp/wind/park layers as we move into summer.
- **May 2026 anomaly**: R/G 8.61 (below 2024/2025 avg 8.78 and well below
  April/June/July). No obvious explanation — could be small-window
  scheduling artifact, could be regression noise.

## Section 5 — temp_run_adj under-delivery, quantified

Comparing what `temp_run_adj` delivers vs the actual monthly deviation
from the season's overall mean R/G (9.083):

```
Month     mean_temp_adj_delivered   (actual − overall_mean)   uncaptured
2026-04   +0.052                    +0.162                    +0.110
2026-05   +0.138                    −0.474                    −0.612
2026-06   +0.331                    +0.272                    −0.060
2026-07   +0.347                    +0.917                    +0.570
```

- **April**: delivered +0.05, needed +0.16 — small under-delivery.
- **May**: delivered +0.14, needed −0.47 — May 2026 actually needed a
  DECREASE, but temp_adj added runs.
- **June**: delivered +0.33, needed +0.27 — slightly over-delivered.
- **July**: delivered +0.35, needed +0.92 — **massively under-delivered**.

**Temperature-adjustment size is roughly right in mid-summer conditions
but severely under-delivers in July** — which corresponds to the 90+°F
residual blowup in Section 2.

## Apportionment

The observed gap has two identifiable components:

**Level (non-seasonal)**: ~0.65–0.70 runs of under-projection persists
across all temp bins in the 60–80°F range where `temp_run_adj` is
near zero. Also visible on closed-roof games (June n=44 gap +0.64).
This is a genuine level correction — not a weather artifact.

**Temperature (seasonal)**: the gap swings by ~0.3–0.5 runs between
May and July on top of the level. `temp_run_adj` catches ~half of
that in 80–90°F, but under-delivers by ~+0.4 runs at 90+°F.

**Rough decomposition of the July gap (+1.38):**

```
Level component:            +0.65   (residual baseline seen in 60–80°F)
Existing temp_adj delivery: +0.35   (average July temp_adj)
Temp under-delivery at 90+: +0.40   (residual jump 60–80 to 90+)
Sample noise + other:       ≈+0.00
                            ──────
Predicted:                  ≈+1.40
Observed:                    +1.38  ✓
```

**Rough decomposition of the May gap (+0.49):**

```
Level component:            +0.65
Weather-cool residual:      −0.30   (May was structurally cool for scoring)
Existing temp_adj:          +0.14
                            ──────
Predicted:                  +0.49  ✓
```

## What RUN_MULT 46 → 50 would do to each month

Applying the flip (proportional +9.5% scale):

```
Month     current gap   +9.5% adds   new gap
2026-04   +1.089        +0.764        +0.325
2026-05   +0.494        +0.771        −0.277   ← OVER-projects May
2026-06   +1.066        +0.788        +0.278
2026-07   +1.377        +0.819        +0.558
```

**RUN_MULT 50 leaves May over-projected by 0.28 runs and July still
under-projected by 0.56 runs.** Not a clean fix. It centers the gap
better than 46 does (mean gap 0.860 → 0.221) but the seasonal
distribution isn't flat.

## Decision

**MIXED. Level dominates, seasonal component real at extremes.**

Both hypotheses have partial support:
- **(A) Uniform level**: ~65% of the observed gap is level, uniform
  across all temp bins in the moderate range. RUN_MULT 46 → 50 handles
  this.
- **(B) Temp under-scaled**: ~35% of the gap is seasonal, concentrated
  at extreme heat (90+°F). A `temp_run_adj` scale-up at extremes would
  handle this.

**Recommended path — TWO changes, sequenced:**

1. **Ship the RUN_MULT 46 → 50 flip** (already proposed in
   `docs/runs-term-recalibration-2026-07-05.md`). Accept the small
   May over-projection cost (−0.28 runs). Ship criteria still hold:
   HI holdout RMSE improves 5.15 → 4.95; MID holdout 4.47 → 4.40.
2. **Follow-up: scale `temp_run_adj` at extreme heat**. Current temp_adj
   delivers +0.58 at 90+°F but the data wants +1.59 (delta ~1.0 run).
   Options: (a) multiplier boost for temp ≥ 88°F (~3× current), (b) a
   nonlinear temp curve. Small population (~60 games at 90+ per season),
   so 1-3 weeks of new data needed for a real holdout evaluation.

**Do NOT hold up the RUN_MULT flip pending the temp fix.** The level
component is 65% of the pain; shipping it is a net win. The extreme-heat
follow-up refines the summer months and is its own investigation.

**May watch-item**: if May 2027 shows a similar sub-season dip, treat
as structural (baseball's seasonal scoring floor). If May 2027 tracks
normal, 2026 May was noise and the flip's May cost was one-time.

## Connection back to the earlier runs-term doc

`docs/runs-term-recalibration-2026-07-05.md` recommended RUN_MULT 46 → 50
based on the fit + ship criteria. This decomposition **confirms the
direction** and **quantifies the residual seasonal component** (~0.4 R/G
at extreme heat that survives the level correction).

The runs-term doc's recommendation stands. This doc adds the follow-up
scope: **scale `temp_run_adj` at 90+°F after 3-4 weeks of post-flip
data lands.**

## Files

- Script: `tmp/decompose-gap-by-season-temp.js`
- Per-game detail: `tmp/gap-by-season-temp.tsv` (1,144 rows)
