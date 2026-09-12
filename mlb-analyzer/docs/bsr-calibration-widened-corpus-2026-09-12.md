# BsR calibration prong on the widened corpus, and the disposition for the 2026-09-28 window close

Measurement only. **No gate flipped, and the registry row is not edited by
this PR** — the proposed disposition text is at the bottom for you to paste
when the window closes.

## Runs

Forward-honest, `level=player`, `window=trailing`, on `2026-06-16 ..
2026-09-10`. Primary metric is the 2026-08-23 re-spec: **calibration, log
loss over all scored games, identical set in both arms**. Negative
`delta_log_loss` = BsR improves.

```
arm                          scored  calib n   delta_log_loss   95% CI                  verdict
tag   (pre-#382 corpus)        807      805      +0.00059      [-0.00038, +0.00193]   not distinguishable
valid (weather_inputs_valid)  1078     1076      +0.00009      [-0.00077, +0.00127]   not distinguishable
```

The `tag` arm reproduces the **807** already recorded in the
`bsr_baserunning` registry note for the 2026-09-12 run, which is the check
that this arm really is the old corpus rather than merely a smaller one.

Supporting metrics, full window:

```
                 log loss              Brier                ECE
tag    without   0.66667   with 0.66726   0.23700 / 0.23729   0.04499 -> 0.03361
valid  without   0.66876   with 0.66885   0.23799 / 0.23803   0.04627 -> 0.03865
accuracy (valid): delta_mean_abs_err +0.001 runs, SE 0.003
```

**ECE is the one metric that moves in BsR's favour**, on both corpora
(−0.0114 tag, −0.0076 valid) while log loss and Brier sit on zero. It
worsens on the pre-half tag arm (0.0616 → 0.0631), so it is 3 of 4 rather
than uniform. Worth recording, not worth acting on: ECE was not named in
the re-spec as a decision metric.

## The n-matched control, and why it was needed

The pre-07-30 half is where all 268 newly-admitted games land, and there
the point estimate **flips sign**:

```
pre-half tag    n=255   +0.00039   [-0.00261, +0.00304]
pre-half valid  n=523   -0.00074   [-0.00247, +0.00125]
```

A sign flip between a subset and a wider set is the exact hazard CLAUDE.md
documents, so the flip is not readable until n is held fixed. Downsampling
the widened pre-half back to the tag arm's 257 games, four seeds:

```
seed 20260912   calib n 255   -0.00176   [-0.00463, +0.00132]
seed 7          calib n 255   -0.00021   [-0.00254, +0.00224]
seed 4242       calib n 256   -0.00017   [-0.00280, +0.00296]
seed 991        calib n 257   -0.00094   [-0.00348, +0.00163]
                              mean -0.00077, range [-0.00176, -0.00017]
```

**All four draws are negative, against the tag arm's +0.00039 at the same
n.** So the flip is **composition, not sample size** — the CT/MT/PT games
the widened filter admits carry a marginally BsR-favourable signal that the
ET-only set does not. The full-corpus pre-half value (−0.00074) sits
inside the control spread, as it should.

That is a real finding about the corpus. It is **not** a finding about
BsR: every interval above spans zero, and the whole spread lives inside
±0.002.

## What this is powered to see

This is a **paired** design — the same games scored with and without BsR —
so the floor to quote is the paired one
(`scripts/park-neutral-paired-floor.js`), **not** the between-cohort
`resolution-floor.js`. CLAUDE.md measured the difference directly: paired
n=801 gives ±0.000608 against ±0.01714 between-cohort, a ~28x gap. Quoting
the cohort floor here would declare an answerable question unanswerable.

Against that, the observed CI half-widths — ±0.00102 at n=1076, ±0.00116
at n=805 — are the right order for a paired comparison at this n, and
narrowing tracks √n almost exactly (0.00116 → 0.00102 predicted 0.00100).
The measurement is working; the effect is the thing that is absent.

## Proposed disposition to record at the 2026-09-28 window close

Not applied here. Suggested text for the `bsr_baserunning` note:

> **DISPOSITION 2026-09-28: NOT DISTINGUISHABLE — gate stays OFF.**
> Primary metric on the widest corpus available (`weather_inputs_valid`,
> forward-honest, 2026-06-16..09-10): `delta_log_loss = +0.00009`, 95% CI
> `[-0.00077, +0.00127]`, n=1076 scored games. The point estimate is
> positive (BsR marginally worse) and indistinguishable from zero. On the
> pre-#382 corpus the same run reads `+0.00059 [-0.00038, +0.00193]`,
> n=805 — same verdict, and the 807-game figure matches the one already in
> this note.
> Accuracy (second metric): `delta_mean_abs_err +0.001` runs against an SE
> of 0.003 — nil.
> ECE improves with BsR on both full-window corpora (0.04499→0.03361 tag,
> 0.04627→0.03865 valid) and worsens on the pre-half tag arm. ECE is not a
> decision metric under the 2026-08-23 re-spec; recorded, not acted on.
> The corpus grew 807→1078 when the weather filter moved from the emit-time
> tag to `weather_inputs_valid` (#382). On the pre-07-30 half the point
> estimate flips sign (+0.00039 tag → −0.00074 valid); an n-matched control
> at 257 games over four seeds returns −0.00176/−0.00021/−0.00017/−0.00094,
> all negative, so the flip is COMPOSITION rather than sample size. It does
> not change the verdict: every interval spans zero.
> Sample has not been the blocker for weeks and is not the blocker now.
> What would change this answer is an effect, not more games.

## Reproduce

```
node scripts/test-weather-filter-and-gaps.js

# the two arms
runBaserunningBacktest({ fromDate:'2026-06-16', toDate:'2026-09-10',
  level:'player', window:'trailing', forwardHonest:true, weatherFilter:'tag' })
#   ... weatherFilter:'valid'   for the production arm

# the control
  ... weatherFilter:'valid', sampleN:257, sampleSeed:20260912   (pre-half window)

# or over HTTP
GET /backtest/baserunning?from=2026-06-16&to=2026-09-10&level=player&window=trailing
    &forwardHonest=1&weatherFilter=tag
    &sampleN=257&sampleSeed=20260912
```

Every run now carries `weather_filter` and `sample` at the top level of
its result, so a pasted number arrives with the corpus it was computed on.
