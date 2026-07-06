# wOBA blend compression measurement — 2026-07-05

Follow-up to `docs/opener-tandem-blend-audit-2026-07-05.md`, which
identified that model team wOBAs land at ~0.316 across the season while
market-implied team wOBAs on HI-market games are ~0.342. That doc
proposed three candidate mechanisms for the compression: Steamer drag,
bullpen clamp, park-neutral drag. This measurement quantifies each.

**Headline finding — the three candidates from the prior doc do NOT
explain the compression.** All three measure at ≤2pt of wOBA. The
model's batter-side blend is nearly market-invariant across LO / MID /
HI buckets, but that turns out to be *approximately correct* — real
lineups don't systematically differ by market total. The under-projection
mechanism lives downstream of the wOBA blend, most likely in park-factor
application, weather adjustment, or the RUN_MULT scaling.

Data: 768 resolved games since 2026-04-01 from the local mirror
(matches the population used in the earlier totals gap re-measure).
Team-halves = 1536 samples.

## Method

For each team-half of each resolved game:

1. **Blended wOBA** — call `model.getBatterWoba` with live prod settings
   (W_PROJ=0.45 / W_ACT=0.55 / PARK_NEUTRAL_INPUTS_ENABLED=true).
2. **Proj-only** — call with W_PROJ=0.999 / W_ACT=0.001 (weights kept
   truthy because `blendWoba` treats 0 as unset and falls back to the
   default 0.65/0.35 — verified in this session).
3. **Act-only** — W_PROJ=0.001 / W_ACT=0.999.
4. **Park-off** — same as blended but PARK_NEUTRAL_INPUTS_ENABLED=false.
5. **Pitcher-side wOBA-against** — `model.getPitcherWoba` averaged
   across the opposing lineup with platoon splits.
6. **Bullpen wOBA** — raw `q.getBullpenWobaBlended` team value.

Each lineup-average is PA-weighted using `PA_WEIGHTS`. All wOBAs are
computed on the batter's perspective (facing opposing SP hand).

Script: `tmp/measure-woba-blend-compression.js`.
Per-game detail: `tmp/woba-blend-compression.tsv` (1536 rows).

## Result 1 — batter wOBA is nearly flat across market buckets

Team-half batter wOBA (blended, facing opposing SP):

```
bucket   n     mean_blend  σ       mean_market  mean_actual
LO       58    0.3160     0.0104   6.50         7.38
MID      1196  0.3163     0.0106   8.04         8.62
HI       282   0.3171     0.0115   9.80         10.33
```

**Range HI − LO: 1.1pt of wOBA.** Contributes ~0.1 runs of variation to
the model total across the LO → HI market range. Meanwhile the market's
LO → HI range is 3.30 runs and actual is 2.95 runs. The batter-side blend
contributes essentially nothing to the model's between-bucket separation.

Within-bucket σ is 10-11pp — the model *is* differentiating individual
lineups, just not systematically by market total. That's approximately
correct behavior: real MLB lineups don't cluster by market total. What
makes a game HI-total is usually a weak pitcher or a hitter park, not a
systematically stronger offense.

## Result 2 — Steamer drag is negligible

Comparing proj-only vs act-only vs blend (drag = act mean − blend mean):

```
LO:   act=0.3166  blend=0.3160  proj=0.3153  drag(act→blend)=+0.6pt
MID:  act=0.3168  blend=0.3163  proj=0.3156  drag(act→blend)=+0.5pt
HI:   act=0.3167  blend=0.3171  proj=0.3176  drag(act→blend)=-0.4pt
```

**All buckets: <1pt of drag.** Steamer projections and actuals produce
very similar team wOBA means once PA-weighted across a lineup. This is
because the blend is dominated by the ~9-batter average, which regresses
individual variance. Adjusting W_PROJ/W_ACT can't close the compression.

## Result 3 — Park-neutral drag is small but real at HI extreme

```
LO:  on=0.3160  off=0.3160  drag(on−off) =   0.0pt
MID: on=0.3163  off=0.3164  drag(on−off) =  -0.1pt
HI:  on=0.3171  off=0.3182  drag(on−off) =  -1.1pt

Park class × bucket:
EXT LO:  drag = -0.3pt
EXT MID: drag = -0.0pt
EXT HI:  drag =  -2.0pt   ← the biggest single effect measured
NEU LO:  drag = +0.2pt
NEU MID: drag = -0.1pt
NEU HI:  drag = -0.1pt
```

**Park-neutralization deflates HI extreme-park batter wOBA by 2pt on
average.** Corresponds to ~0.09 runs on the model total (2pt × 45.5 =
0.09 per team half). At 75 HI-extreme games, aggregate impact is
minimal, but this matches the earlier verification session's finding
that HI extreme gap *worsened* by 0.16 runs OFF→ON. The deflation is
also the right sign to make Under signals lose (model too low → market
higher → Overs would win → but model emits Unders instead).

Practical impact is small. Reverting park-neutral would close 2pt of
the 25-36pt implied-vs-modeled wOBA gap on HI-extreme games — a partial
mitigation, not a fix.

## Result 4 — bullpen clamp doesn't fire in bulk

Bullpen wOBA distribution (raw team values, n=1536):

```
min  = 0.2895   (best bullpen)
max  = 0.3435   (worst bullpen)
mean = 0.3099
σ    = 0.0081
P10  = 0.3004
P50  = 0.3083
P90  = 0.3225
BULLPEN_AVG (used when null) = 0.318
```

Real team bullpens vary by ~5pt (P10 → P90). BULLPEN_AVG=0.318 sits
*above* the P50 (0.308) and the P90 (0.322). So when the fallback
fires (null bullpen input), the model uses 0.318 — 10pt higher than the
median actual bullpen. This inflates the model's pitcher-side wOBA on
null-bullpen games, which would make those games project MORE runs, not
fewer. Wrong direction to explain under-projection.

Also: the fallback rarely fires. `q.getBullpenWobaBlended` returned a
non-null value for essentially every game (all 1536 rows have populated
bullpen values). The clamp isn't the mechanism.

## What IS driving the compression

The batter-side blend measures show the compression is downstream of
wOBA lookup. Working back from model estTot:

```
Batter wOBA (both halves, HI bucket): 0.3171
SP faced (opposing, HI bucket):       0.3228

perBatterEW formula:
  pitW = 0.3228 (SP mean)     × 0.75 + 0.312 (bullpen) × 0.25 = 0.3198
  batW = 0.3171 (batter mean) × 1.0                             = 0.3171
  effective wOBA = pitW × W_PIT + batW × W_BAT
                 = 0.3198 × 0.40 + 0.3171 × 0.60
                 = 0.3182
```

Compare to LO bucket:

```
Batter wOBA: 0.3160
SP faced:    0.3035

  pitW = 0.3035 × 0.75 + 0.307 (LO bullpen) × 0.25 = 0.3044
  batW = 0.3160
  effective = 0.3044 × 0.40 + 0.3160 × 0.60 = 0.3113
```

**Effective wOBA LO → HI: +6.9pt** (0.3113 → 0.3182). Times RUN_MULT=45.5
× 2 teams = **+0.63 runs of estTot variation from wOBA between LO and HI**.

But actual estTot LO → HI variation is ~1.9 runs (from prior measurements).
So wOBA blend contributes ~33% of the between-bucket separation; the
other ~1.3 runs comes from **park factors, wind adjustments, and any
non-linearity in the runs formula.**

## Distribution of pitcher-side wOBA (where the real separation lives)

```
bucket    SP_faced_mean  σ         Bullpen_mean  σ
LO        0.3035         0.0184    0.3074        0.0079
MID       0.3136         0.0167    0.3096        0.0081
HI        0.3228         0.0136    0.3117        0.0082
```

- **SP faced range LO → HI: +19pt.** The model DOES pick up that
  HI-total games face weaker SPs.
- Bullpen range LO → HI: +4pt. Bullpens are much more clustered.
- SP variance shrinks in HI (σ 0.018 → 0.014). Weaker SPs are more
  homogeneous; there's less spread among "bad" SPs than among the
  full population.

## Where the compression actually lives

The batter side is nearly flat and Steamer/bullpen/park-neutral don't
account for the residual under-projection. Given estTot's actual
between-bucket separation of ~1.9 runs vs the ~0.63 runs the wOBA
blend contributes, the missing ~1.3 runs must come from downstream of
`aRuns / hRuns`:

- **Park factor multiplier** (`scraper.js PARK_FACTORS`, run-scale).
  Applied at the `aRuns = aTeamWoba × RUN_MULT × pf` step. If the
  extreme-park multiplier is weaker than reality, it doesn't scale
  the HI games up enough.
- **Weather run adjustment** (`windRunAdj`, `tempRunAdj`). On the 100
  Neither-HI games the mean windRunAdj was +0.09 — essentially not
  moving the total.
- **Non-linearity of wOBA→runs.** The RUN_MULT × (wOBA - baseline)
  formula is linear. Real runs-per-wOBA relation may be super-linear
  in the tails (small wOBA delta → outsized run delta when both
  sides of the matchup are extreme).

The fact that the market and actuals both scale runs steeply with wOBA
delta (market LO 6.50 → HI 9.80 = +3.30 runs), while the model scales
gently (LO 7.06 → HI 8.97 = +1.91 runs) is consistent with a
compressed pf/weather application, or a linear runs-per-wOBA that
undershoots the actual super-linear response.

## Decision

**Neither of the three candidate mechanisms explains the compression.**
The wOBA blend inputs are correctly-shaped; the model's team wOBAs
match the reality that lineups don't cluster by market total.

Corrections to the earlier doc's conjecture list:

- **Steamer drag: NOT a driver.** Blend and act-only differ by <1pt
  across every bucket. Adjusting W_PROJ / W_ACT won't help.
- **Bullpen clamp: NOT a driver.** BULLPEN_AVG=0.318 is *above* the
  actual bullpen distribution (P50 0.308), so the fallback would
  inflate model runs, not deflate. Also, the fallback rarely fires;
  actual bullpen values populate the pipeline.
- **Park-neutral drag: MEASURABLE but small.** 2pt on HI-extreme,
  corresponds to ~0.09 runs. Real, but explains less than 5% of the
  ~2-run under-projection.

The compression is in the **run-conversion stage**, not the wOBA lookup.
Follow-up investigation should target:

1. **PARK_FACTORS calibration.** Do the run-scale park multipliers
   fully capture the actual scoring elasticity at extreme parks? Run
   an OFF/reduced/normal/inflated sweep and measure the HI-bucket gap.
2. **Weather run adjustment magnitude.** WIND_SCALE=2.0 seems small.
   HI-total games often have wind-out or high-temp signatures — is
   the adjustment strong enough?
3. **Consider a non-linear wOBA→runs term.** Instead of
   `runs = RUN_MULT × (wOBA − baseline)`, try
   `runs = A × (wOBA − baseline) + B × (wOBA − baseline)²` and
   calibrate on actuals. Would let HI games scale up faster than LO.

None of these are settings-only. They're their own investigation
PRs. This measurement rules out three cheap knobs and points to
downstream code changes.

## Files

- Script: `tmp/measure-woba-blend-compression.js`
- Per-game detail: `tmp/woba-blend-compression.tsv`
