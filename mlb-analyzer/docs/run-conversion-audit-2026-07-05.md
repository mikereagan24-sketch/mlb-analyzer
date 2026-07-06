# Run-conversion audit — 2026-07-05

Follow-up to `docs/woba-blend-compression-2026-07-05.md`, which ruled
out the wOBA blend as the compression source. This audit isolates
the downstream run-conversion stage: how park factor, WIND_SCALE, and
temperature adjustments contribute to LO→HI model spread. Also
includes a market-vintage sanity check.

## Formula (services/model.js:841-886)

```
aRunsRaw = max(0, (aTeamWoba − WOBA_BASELINE) × RUN_MULT × pf)
hRunsRaw = same for home
aRuns    = aRunsRaw − aFramingAdj − aDefenseAdj
hRuns    = same for home
estTot   = aRuns + hRuns + windRunAdj + tempRunAdj
```

Order: `pf` is **multiplicative** on wOBA→runs per side. Wind + temp
are **additive** on the sum. Framing + defense are per-side additive
subtractions. Weather (wind, temp) is applied AFTER framing/defense
and does NOT scale with pf — this is by design (weather is symmetric,
park factor is home-park scoring elasticity).

## Component decomposition, all parks (n=768)

Per-game mean contribution:

```
Component               LO_mean    HI_mean    Δ(HI−LO)    % of model spread
base_runs (wOBA)         7.272      7.957      +0.685      36.1%
pf contribution         −0.011     +0.768      +0.780      41.0%
framing/defense          0.000      0.000       0.000       0.0%
wind adj                −0.033     +0.072      +0.105       5.5%
temp adj                −0.154     +0.176      +0.330      17.4%
────────────────────────────────────────────────────────────────
MODEL estTot             7.074      8.974      +1.900       —
MARKET (close)           6.500      9.801      +3.301       —
MARKET (morning)         7.360      9.575      +2.215       —
ACTUAL                   7.379     10.326      +2.947       —
```

**Park factor is the single biggest contributor to LO→HI model spread
(41% at +0.78 runs).** It works exactly as designed: LO games happen to
be at slightly pitcher-friendly parks on average (pf 0.986), and HI
games skew toward hitter parks (pf 1.038 all / 1.17 extreme).

**Wind is a rounding error at the bucket level** (+0.10 runs of spread,
6%). Non-zero rows (n=324 of 768) show mean +0.095, P10 -0.20, P90
+0.44. Even at P90 magnitude, one game moves by ~0.4 runs — meaningful
per-game, immaterial across the bucket.

**Temp is the second biggest additive lever** (+0.33 runs of spread,
17%). Non-zero rows show mean +0.20, P90 +0.60. Temperature captures
some of the LO→HI separation — probably day/night + summer/cold-weather
correlation with total.

**Framing/defense is exactly zero in every bucket.** Either the
`CATCHER_FRAMING_ENABLED` toggle is masking it in current settings
(prod has `catcher_framing_mute=1.0`, which is full mute → adjustment
= 0), or defense FRV is not populating. Not a driver in the current
configuration.

## Extreme-park subset breakdown

```
                       n     pf      base    pfΔ     wind    temp   estTot
EXT LO                 14   1.010   7.433  +0.079   -0.114  -0.268   7.131
EXT MID               187   0.995   7.669  -0.040   +0.032  +0.015   7.676
EXT HI                 75   1.173   8.008  +1.389   +0.049  +0.066   9.511
NEU LO                 15   0.986   7.121  -0.096   +0.042  -0.047   7.021
NEU MID               411   1.000   7.560  +0.002   +0.038  +0.147   7.747
NEU HI                 66   1.008   7.900  +0.064   +0.098  +0.301   8.363
```

Key contrasts:
- **EXT HI vs NEU HI**: same batter wOBA (~0.316), but EXT HI has pf 1.173 (contributes +1.39 runs) while NEU HI has pf 1.008 (+0.06). This is the model working *correctly* for extreme parks.
- **NEU HI mean estTot = 8.36 vs actual 10.00 = -1.64 runs of under-projection with pf ≈ 1.0.** These are the games where pf contributes essentially nothing but the market and reality both go higher. There's no lever left in the current formula.
- Weather can't explain it either: NEU HI wind + temp = +0.40 combined, moves needle from 7.96 (base) to 8.36. Would need another ~1.6 runs of add-on to match reality.

## Market vintage sanity check

`market_total` in game_log is the *close* line (latest refresh before
grading). `proj_market_total` is captured with COALESCE on first write —
approximates the morning line the owner would have bet against.

Mean close vs morning by bucket:

```
LO   close = 6.50    morning = 7.36    Δ = -0.86    (morning was HIGHER)
MID  close = 8.03    morning = 8.24    Δ = -0.21    (morning slightly higher)
HI   close = 9.80    morning = 9.58    Δ = +0.22    (close moved UP)
```

- **Books moved DOWN on LO games (7.36 → 6.50) and UP on HI games (9.58 → 9.80) between morning and close.** That's the market tightening its estimate as info arrives.
- **Model spread against morning line = only 0.315 runs** (7.36 → 9.58 = 2.22 morning market spread vs 1.90 model spread). Model captures **86% of the morning spread**.
- **Model spread against close = 58%** of the close spread.

The morning line is what the owner priced against. The gap "model −
close" overstates the model's disagreement with the market as-of-bet-time
by about 0.4 runs at LO and 0.2 runs at HI. Rerunning the totals gap
analysis against `proj_market_total` would be a fairer benchmark for
the owner's actual PnL calibration.

For extreme LO games specifically, the close moved 0.9 runs DOWN from
morning. Meaning the model's "+0.63 gap at EXT LO" is largely a vintage
artifact — against the morning line, the model would look UNDER by
0.28 runs, not OVER.

## Answering the "does it account for 1.3 runs" question

**No — but the shortfall shrinks substantially against the morning line.**

- Model LO→HI spread = 1.90 runs
- Market close spread = 3.30 runs → missing 1.40 runs
- Market morning spread = 2.22 runs → missing 0.32 runs
- Actual spread = 2.95 runs → missing 1.05 runs

Against the *close*, the model under-scales by ~1.4 runs. Against the
*morning line the owner actually sees at bet time*, the model
under-scales by ~0.3 runs — small enough that further compression
mechanisms may not be worth chasing separately.

**Against ACTUALS**, the model under-scales by ~1.0 runs of LO→HI
spread. That's real reality-vs-model divergence, and the follow-up
work should benchmark against actuals, not against a moving market.

## Wind & temp magnitude sanity

```
Wind adj (non-zero): n=324/768
  mean=+0.095   min=-0.72   P10=-0.20   P90=+0.44   max=+1.95
Temp adj (non-zero): n=413/768
  mean=+0.203   min=-1.30   P10=-0.50   P90=+0.60   max=+1.26
Zero-adj rows: wind=444, temp=355
```

Wind reaches ~2 runs max but averages 0.1 across the population. Temp
is more consistently applied (54% non-zero rows) and skews slightly
positive.

**WIND_SCALE=2.0 seems calibrated correctly** given the wind_factor
distribution. Bumping it up would exaggerate outlier games without
closing the between-bucket compression (which is dominated by pf, not
wind).

## Decision + follow-ups

**No settings-only fix from this audit.** The formula components work
as designed:
- Park factor delivers +0.78 runs of LO→HI spread (the biggest lever).
- Temperature adds +0.33 runs.
- Wind adds +0.10 runs.
- Framing/defense are gated off in current settings (mute=1.0) — zero
  contribution. Enabling them would ADD variance but wouldn't scale
  with market total specifically.

The remaining ~1.0 runs of under-projection vs ACTUALS at HI (and
~0.3 runs vs morning market) lives in the **linear wOBA→runs term**
itself. Neither pf nor weather can scale a game's base runs when the
underlying wOBA delta is small. The candidate the prior doc mentioned
— a non-linear `runs = A×(wOBA−baseline) + B×(wOBA−baseline)²` term —
is the one lever that could differentially amplify HI games without
also inflating LO games.

**Two follow-up measurements warranted** (both separate, deferred per
the new priority task on SIGNAL_EMIT_FLOOR):
1. **Re-run the totals gap analysis against `proj_market_total`** to
   see the "morning gap" — the owner's actual bet-time exposure.
   Cheap, no code.
2. **Non-linear runs term regression.** Fit A/B against actuals on
   April-May, validate on June holdout. Ship only if the holdout
   improves HI without degrading MID. This is a real code change if
   it lands.

## Files

- Script: `tmp/measure-run-conversion.js`
- Per-game detail: `tmp/run-conversion-decomp.tsv`
