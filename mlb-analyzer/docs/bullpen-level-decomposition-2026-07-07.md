# Bullpen level bug — decomposition + bounded-fix sequence — 2026-07-07

Follow-up to `docs/bullpen-input-evaluation-2026-07-07.md`, which
identified a ~10pt level bug: model bullpen mean 0.3088 vs SP mean
0.3131 (−4.3pt gap), where the real MLB relief advantage should be
10-15pt below SP mean (making the target bullpen mean ~0.298-0.303).

This doc decomposes the ~10pt shortfall into three suspected
contributors and quantifies each. Measurement only. Fix sequence
proposed at the end.

**Headline apportionment** (sums to ~9.4pt of the ~10pt observed gap):

| Contributor | Level drag | % of gap | Priority |
|---|--:|--:|---|
| (a) Callup 0.335 fallback pollution | ~0.6pt UP | 6% | LOW |
| (b) Opener/bulk pollution in RP pool | ~2.2pt UP | 22% | MEDIUM |
| (c) Steamer over-regression on RPs | ~6.6pt UP | 70% | **HIGH** |
| **Total** | **~9.4pt UP** | **~94% of the gap** | |

## (a) Callup 0.335 fallback pollution — 0.6pt aggregate

Every team-roster RP without a projection row gets injected at
`UNKNOWN_PITCHER_WOBA = 0.335` per `db/schema.js:2991`. That
placeholder is at the 90th percentile of realized RP wOBA — a
"we don't know, assume slightly-below-replacement" default.

Cross-team count as of 2026-07-07:

```
Total roster RPs across 30 teams:          ~245
Roster RPs WITHOUT a projection row:         7  (2.9%)
Teams with any fallback:                     8
Teams with 0 fallbacks:                     22
Max fallbacks per team:                      1  (CHC, DET, KC, MIL, PHI, TEX, WAS)
```

**Aggregate mean drag from fallback injection: +0.6pt UPWARD.** At
current low fallback prevalence (7/245 = ~3% of pool), this is
noise-level. Where it does bite is on the specific teams with a
fallback: max per-team shift is 4.5pt UP (PHI: pool without
fallback 0.2992, with 0.3037).

**Verdict**: real but small in aggregate. Low priority. Would
matter more on high-churn dates when injuries add multiple
callups (typical mid-season crunch is 2-4 per team).

## (b) Opener/bulk pollution in the RP pool — 2.2pt aggregate

Roster RPs (role='RP') who have started ANY games in the 2026-01 →
2026-06-03 window (opener, tandem bulk, or role transitions):

```
Roster RPs with ≥1 start outing:            59
Total BF from those pitchers:            7,946
BF from starts vs relief:              1,332 / 6,614  (16.8% from starts)
```

Notable examples (>25% BF from starts):

```
MIL  Chad Patrick        starts 9, reliefs 9,  173/81  BF   68% from starts
TEX  Jacob Latz          starts 4, reliefs 22,  66/87  BF   43% from starts
KC   Luinder Avila       starts 2, reliefs 9,   39/77  BF   34% from starts
COL  Tanner Gordon       starts 3, reliefs 8,   55/135 BF   29% from starts
MIL  Shane Drohan        starts 3, reliefs 12,  50/124 BF   29% from starts
MIA  Tyler Phillips      starts 3, reliefs 17,  50/136 BF   27% from starts
LAA  Mitch Farris        starts 2, reliefs 11,  32/106 BF   23% from starts
NYM  Huascar Brazobán    starts 5, reliefs 21,  28/96  BF   23% from starts
```

Steamer projection ties to the pitcher's TOTAL usage, not just
relief. A pitcher who throws 30% of his BF as an opener has his
"vs RHB" projection pulled up by the opener innings (first
time through the order, longer outings, tougher hitter
matchups).

Per-pitcher wOBA comparison:

```
                                    n     mean_proj_wOBA
Roster RPs WITH start outings      55       0.3194
Pure-relief roster RPs             172      0.3106
                                              -----
Δ (polluted − pure)                          +8.8pt
```

**Roster RPs who've been used as openers/bulks project 8.8pt
higher than pure-relief RPs.**

Applied to the pool:
- 25% of the pool contributes at +8.8pt higher wOBA
- Effect on team mean: 0.25 × 8.8 = **~2.2pt UP per team**

**Verdict**: meaningful contributor at ~22% of the gap. Medium
priority. A bounded fix: identify roster RPs whose recent
outings include ANY starts and either drop them from the pool or
downweight them.

## (c) Steamer over-regression on RPs — 6.6pt aggregate

Direct comparison of Steamer projection vs 2yr realized actuals
for the same pitchers (n=168 roster RPs with actuals sample ≥100
BF vs both hands):

```
                     Proj (Steamer)      Act (2yr realized)      Δ (proj−act)
Mean wOBA            0.3083              0.3018                  +6.6pt
σ (per-pitcher)      0.0153              0.0485                  spread ratio 3.17×
Per-pitcher P10-P90  39.7pt              134.4pt                 Steamer captures 30%
```

**Level bias**: Steamer projects RPs at a level 6.6pt higher than
their realized 2yr average. This is direct level pollution.

**Spread compression**: Steamer's per-pitcher spread is 30% of
realized. Elite relievers (Cade Smith, Ryan Yarbrough, Alex
Vesia, Raisel Iglesias) project 60-130pt higher than their
actuals. Blowup relievers (Tanner Gordon, Bryse Wilson, Jake
Bird) project 50-70pt lower than their actuals.

Extreme underestimation of elite relievers (proj − act):

```
Cade Smith (CLE)     act 0.216   proj 0.345   +128.6pt  (Steamer misses by 128pt)
Ryan Yarbrough (LAA) act 0.202   proj 0.318   +115.5pt
Tim Hill (NYY)       act 0.233   proj 0.327   +93.7pt
Tyler Holton (DET)   act 0.227   proj 0.305   +78.7pt
Jose A Ferrer (NYM)  act 0.224   proj 0.294   +69.8pt
Adrian Morejon (SD)  act 0.216   proj 0.284   +68.3pt
```

Steamer treats these elite relievers as league-average middle
relievers. That's the projection framework's structural weakness:
RPs have small BF samples per year, so Bayesian regression
toward league-mean dominates the projected value. It's a valid
projection technique for the average case; catastrophic for the
tail (both elite and blowup).

**Verdict**: **DOMINANT contributor at ~70% of the gap.** High
priority. This is where the fix belongs.

## Fix sequence (per prior doc)

### Step 1 — target the Steamer regression (contributor c)

**Bounded fix candidates**, ordered by scope:

**(i) Lower the actuals-gating threshold for the bullpen pool.**
Current `minBF=100` gates when actuals override projection. RPs
rarely accumulate 100 BF vs a specific handedness per year
(median RP has ~40-70 BF vs RHB). At `minBF=100`, only ~168 of
230 pool-eligible RPs qualify for the blend. Dropping to
`minBF=50` roughly doubles that.

- **Change scope**: settings-only if we thread `minBF` through
  `q.getBullpenWobaBlended` as a settings-overridable, or add
  a new `BULLPEN_MIN_BF` setting.
- **Expected impact**: teams with 3-5 known-quality RPs (Cade
  Smith on CLE, Iglesias on ATL etc.) would see their bullpen
  means drop 3-5pt closer to reality. Aggregate mean shift toward
  the real 0.298-0.303 target.

**(ii) Add a bullpen-specific W_PROJ/W_ACT.** Prod is currently
0.45/0.55 across the board. For bullpens where actuals ARE
available (n≥100 BF), we could tilt to 0.25/0.75 — reflecting
that RP actuals over 100 BF are a much better signal than SP
actuals given the smaller true-talent-vs-noise ratio.

- **Change scope**: adds two new settings keys
  (`BULLPEN_W_PROJ`, `BULLPEN_W_ACT`) and threads them through
  `q.getBullpenWobaBlended`.
- **Expected impact**: further amplifies the Steamer correction
  for the pitchers who cleared the sample gate. Combined with
  (i): compounds toward the real spread.

**(iii) Skip Steamer entirely for RPs.** Use pure actuals (any
sample size >0) as the RP wOBA. Steamer becomes the fallback
only when no actuals exist.

- **Change scope**: bigger — inverts the projection-vs-actuals
  hierarchy for RPs specifically.
- **Expected impact**: largest correction to the level bug. Also
  most risk of noise on thin-sample RPs.

**Recommendation for Step 1**: start with **(i) — lower `minBF`
to 50 for the bullpen pool.** Settings-only if we thread the
value through. If not, small code change to add a
`BULLPEN_MIN_BF` setting with schema default 50 and prod
override. Byte-identical when set equal to the current 100.

### Step 2 — target opener/bulk pollution (contributor b)

For each roster RP, check `pitcher_game_log` for any start
outings in the last 60 days. Two options:

- **Exclude entirely**: drop them from the RP pool. Loses their
  relief usage contribution but avoids the opener drag.
- **Downweight**: apply a `(1 - start_BF_fraction)` weight to
  their contribution.

The second is more information-preserving. Implementation adds a
per-pitcher usage lookup in `q.getBullpenWoba`.

**Change scope**: requires `pitcher_game_log` join in the
bullpen-pool query. Small code change.

**Expected impact**: ~2pt aggregate mean drop toward the target.

### Step 3 — target callup fallback pollution (contributor a)

Low aggregate impact (0.6pt). Deferred as long as fallback
prevalence stays under ~10%. Watch on high-churn dates (August
waiver / September rosters).

### Step 4 — sharper 30-day usage-weighted construction (behind the level fixes)

Ship as a toggle: `BULLPEN_USAGE_WEIGHTED_ENABLED` default OFF.
When ON, replace the equal-weight pool aggregation with a
BF-weighted mean over the last 30 days from `pitcher_game_log`.

**Change scope**: significant code addition to
`q.getBullpenWoba`. Backtest gate: A/B against post-level-fix
model on the resolved-game population.

**Expected impact**: from the prior doc's Section 3, this
delivers ~2pt more spread and shifts 6-8 teams by 4-7pt each.
Predictive test in Step 5 determines whether the additional
signal earns its complexity.

### Step 5 — predictive test — gates the RELIEF_PIT_WEIGHT question

Per the user's amendment: **before touching `RELIEF_PIT_WEIGHT`,
run the predictive test.** Bucket resolved games by
usage-weighted-bullpen-quality gap (team A − team B). For each
bucket:

- Does the model's ML win prob deviate systematically from
  actuals?
- Does the effect show up specifically in late-inning-decided
  outcomes (games where the bullpen dominated the last 3-4
  innings)?

**Passes → consider `RELIEF_PIT_WEIGHT` bump.**
**Fails → the input matters but weight adjustment doesn't help.**

This test is currently **deferred** (needs joined data across
`game_log`, `pitcher_game_log`, `bet_signals`). Estimated
scope: 3-4 hours of joined-query work + one bounded doc. Should
be scheduled AFTER Step 1 lands (so it uses the corrected input).

## Sizing summary — expected level shift after fixes

Assuming Step 1 delivers ~5pt of correction on the polluted
Steamer regression side, Step 2 delivers ~2pt on the
opener/bulk side:

```
Current bullpen mean:              0.3088
After Step 1 (Steamer fix):        0.3038  (~5pt drop)
After Step 2 (opener/bulk drop):   0.3018  (~2pt more drop)

Target: 0.298-0.303 (~10-15pt below SP mean 0.3131)
```

Step 1 + Step 2 together land within the target range. Step 3
(fallback) is a rounding polish. Step 4 (sharper construction)
addresses spread, not level, and gates on Step 5's predictive
test.

## Files

- Reference: `db/schema.js:2926-3061` (getBullpenWoba,
  getBullpenWobaBlended)
- Reference: `docs/bullpen-input-evaluation-2026-07-07.md`
  (compression + level headline finding)
- Measurements: inline `node -e` queries against local mirror
  (30-team snapshot + `pitcher_game_log` 30-day window ending
  2026-06-03)
