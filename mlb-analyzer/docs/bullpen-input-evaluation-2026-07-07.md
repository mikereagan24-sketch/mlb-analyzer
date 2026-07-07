# Bullpen input evaluation — 2026-07-07

Owner's question: is the bullpen wOBA input sharp enough, weighted
enough, given games are increasingly bullpen-decided? Owner
observation: the bullpen report shows very little between-team
difference, and bullpen wOBAs often look better than solid starters'.

Measurement only. No changes.

## Section 1 — Construction audit (`db/schema.js` q.getBullpenWobaBlended)

Full formula, plainly:

```
For each team T and each batter-hand H (RHB, LHB):
  1. Filter woba_data.pit-proj-H to pitchers whose player_name ends
     with " T" (team suffix). Exclude the starter, exclude fatigued
     pitchers (getFatiguedPitchers table).
  2. If team_rosters has active RPs (role='RP'), further filter to
     pitchers appearing in that roster (exact-name match, else
     last-name match).
  3. For each remaining pitcher:
       woba_pitcher = (actuals_sample >= minBF=100)
                      ? W_PROJ × proj.woba + W_ACT × actual.woba
                      : proj.woba
       (W_PROJ=0.45, W_ACT=0.55 in prod)
  4. Inject FALLBACK entries for every roster-RP with NO proj row:
       woba = UNKNOWN_PITCHER_WOBA (0.335)
       (i.e., callups get league-average placeholder)
  5. Aggregate: EQUAL-WEIGHT MEAN across the pool.
       team_bullpen_H = mean(woba_pitcher)  for all pitchers in pool

Then getBullpenWobaBlended:
  6. Get team_bullpen_RHB and team_bullpen_LHB.
  7. For each opposing-lineup batter b:
       strong = min(bullpen_R, bullpen_L)   (better-matched reliever)
       weak   = max(bullpen_R, bullpen_L)   (worse-matched reliever)
       contrib_b = strongWt(b.hand) × strong + weakWt(b.hand) × weak
     with strongWt/weakWt = 0.55/0.45 for R-batters, 0.35/0.65 for L.
  8. Return mean(contrib_b) over the 9 lineup slots.
```

**Key properties:**

- **Equal-weight pool aggregation.** A mop-up middle reliever with
  proj wOBA 0.335 and 5 BF sample counts EQUALLY with the team's
  closer at 0.290. Real usage is nowhere near uniform (closer throws
  high-leverage 9ths; mop-up throws blowout 7ths).
- **Steamer projection dominates.** Actuals only override when sample
  ≥ 100 BF; most middle relievers never accumulate that in a proj
  window. So the input is essentially "current team's rostered RP
  Steamer projections, equal-weight."
- **No rolling window.** The projection is Steamer's rest-of-season,
  updated on the roster ingest cadence. Not "last 30 days actuals."
- **Fatigue exclusion.** Recent 2-3 day appearance pitchers dropped
  from eligibility, but that's about deployment, not quality.
- **Fallback pool inflation.** Every rostered RP without a proj row
  gets 0.335 injected. Teams with 3-4 callups (injuries, minor-league
  churn) get their pool pulled toward 0.335.
- **Openers not distinguished.** If a pitcher is listed as RP but
  occasionally starts (opener), his opener-inning stats mix into his
  wOBA-against.

## Section 2 — Reality check: compression + level

30-team snapshot from prod-mirror woba_data, `getBullpenWobaBlended`
against a neutral all-R lineup:

```
Team-blended bullpen wOBA (all 30 teams, facing all-R lineup)
  min  0.2947 (BOS)
  P10  0.2998
  P25  0.3025
  P50  0.3071
  P75  0.3144
  P90  0.3227
  max  0.3242 (WAS)

  mean 0.3088   σ 0.0080
  P90-P10 range: 22.9pt
  max-min range: 29.5pt
```

For comparison, team SP wOBA (active-roster SPs averaged, same
source):

```
Team-mean SP wOBA (all 30 teams)
  min  0.2873 (PHI)
  P10  0.3033
  P50  0.3123
  P90  0.3263
  max  0.3290 (ARI)

  mean 0.3131   σ 0.0094
  P90-P10 range: 23.0pt
```

**Two findings, both real:**

### 2a. Spread compression (~2×)

- Model's team-bullpen P90-P10: **22.9pt**
- Real MLB team-bullpen wOBA-allowed span (2024/25 references):
  ~50pt from elite (LAD, PHI, HOU ~0.290) to bottom (COL, WSH ~0.340)
- **Model captures ~46% of the real spread.** Not as dramatic as the
  owner's ~5pt recollection, but half of real is still compression.

### 2b. LEVEL is the bigger issue

- Model bullpen mean: **0.3088**
- Model SP mean:      **0.3131**
- **Bullpen − SP = −4.3pt** (bullpen looks 4.3pt "better" than SPs)
- **Real MLB bullpen advantage: 10-15pt** (relief pitchers face fewer
  batters per outing, throw max effort, have platoon advantage — all
  documented ~10-15pt lower wOBA-allowed than starters)
- **Model's bullpen advantage is only ~30% of real.** Bullpens are
  compressed toward SPs, not distinct enough.

The owner's "bullpen wOBAs often look better than solid starters'"
is technically true (mean-below-SP) but understated: **the gap SHOULD
be much larger.** Model bullpens are too pool-diluted to hit real
elite-relief numbers.

## Section 3 — Sharper construction: 30-day usage-weighted

Same per-pitcher wOBA numbers, but weighted by 30-day BF from
`pitcher_game_log` (relief outings only, was_starter=0). Last 30
days ending 2026-06-03 (local mirror endpoint).

```
Team-level per-arm construction:
  1. Query pitcher_game_log: relief BF sum per (pitcher, team) over
     30 days.
  2. Look up per-pitcher combined wOBA (proj + actuals blend, same
     rules as current construction).
  3. Team wOBA_usage = Σ(bf_i × woba_i) / Σ(bf_i)   ← usage-weighted
     vs
     Team wOBA_equal = Σ(woba_i) / n                  ← current
```

Team-by-team results (29 teams with sufficient BF sample; SEA/others
had 3-4 arms):

```
team  n_arms  total_BF  equal_wt   usage_wt   Δ(usage−equal)
ATH    10      397     0.3210     0.3210     +0.0pt
ARI     7      268     0.3147     0.3155     +0.8pt
BOS    11      392     0.3047     0.3105     +5.7pt   ← high-usage arms WORSE
PIT    10      388     0.3205     0.3245     +4.0pt   ← high-usage arms WORSE
SEA    12      342     0.3109     0.3136     +2.7pt
HOU    15      416     0.3134     0.3151     +1.7pt
LAA    12      470     0.3161     0.3163     +0.2pt
...
NYY    12      413     0.3078     0.3065     −1.3pt
CHC    13      419     0.3171     0.3166     −0.5pt
BAL    13      399     0.3152     0.3144     −0.8pt
CIN    15      457     0.3216     0.3205     −1.1pt
KC     12      415     0.3146     0.3135     −1.1pt
CLE    12      383     0.3099     0.3073     −2.6pt
COL    13      478     0.3286     0.3259     −2.7pt
LAD    12      336     0.3054     0.3026     −2.8pt
SF     13      448     0.3185     0.3157     −2.8pt
CWS    11      411     0.3138     0.3108     −2.9pt
TB     15      471     0.3166     0.3135     −3.2pt
PHI     9      337     0.3030     0.2997     −3.4pt
SD     11      433     0.3056     0.3022     −3.4pt
MIL    10      404     0.3082     0.3045     −3.8pt
MIA    14      433     0.3192     0.3153     −3.9pt
ATL     8      289     0.3037     0.2996     −4.1pt
MIN    14      430     0.3241     0.3194     −4.7pt
TOR    13      398     0.3127     0.3079     −4.8pt   ← high-usage arms BETTER
NYM    13      486     0.3124     0.3072     −5.2pt   ← high-usage arms BETTER
DET    14      469     0.3159     0.3089     −7.1pt   ← high-usage arms BETTER
```

**Aggregate:**
- Equal-weight mean: 0.3142
- Usage-weight mean: 0.3125 (−1.7pt shift, closer to real)
- Equal-weight P90-P10: 16.9pt
- Usage-weight P90-P10: 18.8pt (+1.9pt more spread)

The sharper construction reveals **modest additional spread (~2pt)**
and **meaningful team-level movement (4-7pt on the extreme teams).**
DET, TOR, NYM, PIT all move materially. But the MEAN shift is small —
usage-weighting doesn't close the ~10pt level gap vs real relief
advantage.

**Conclusion on sharper construction**: worth doing, but by itself it
addresses ~20% of the level problem. The other ~80% is elsewhere
(callup fallback @ 0.335, opener pollution, or Steamer regression on
RPs).

## Section 4 — Weighting question: does it matter at 25% share?

Current model applies bullpen at `RELIEF_PIT_WEIGHT = 0.25` (25% of
the pitcher-side wOBA blend). At `RUN_MULT = 46`, the run-conversion
sensitivity to a bullpen-wOBA shift is roughly:

```
run_delta_per_team = Δ_wOBA × RELIEF_PIT_WEIGHT × RUN_MULT
                   = 0.005 × 0.25 × 46
                   = 0.06 runs per team per game
```

Or:
- 5pt of wOBA delta on the bullpen input → **~0.12 runs** total on estTot
- 10pt of wOBA delta → **~0.23 runs**

**Line movement scale:**
- 0.12 runs on estTot × TOT_SLOPE 0.08 → ~1pp of Over-probability shift
- 0.12 runs on run diff × RUN_MULT-derived Pythagorean sensitivity
  → ~0.5-1pp of ML win-prob shift on close games

**Is the constraint the input or the weight?**

The math says the input CAN move lines meaningfully at 25% weight,
but only when the input itself moves by 5+ wOBA points. The sharper
construction gives that magnitude on ~1/3 of teams (DET −7.1, NYM
−5.2, TOR −4.8, MIN −4.7, ATL −4.1, PIT +4.0, MIA −3.9). For those
teams' games, a sharper input would shift lines by ~0.6-1.5pp of
win-prob.

For the other 2/3 of teams (delta < 3pt), even a sharper input
barely moves the line at 25% weight. **The weight IS a soft cap** in
the sense that bullpen influence is bounded to ~0.06 runs per 5pt of
input delta.

Bumping the bullpen weight (say 25% → 35%) would proportionally
increase sensitivity — but that trade-off shifts weight AWAY from
SPs, which is a bigger direct signal on most games. Not obviously
correct.

## Section 5 — Predictive test — deferred

Ideal: bucket resolved games by "sharper bullpen quality gap"
(team A usage-weighted − team B usage-weighted) and check whether
games with big gaps deviate systematically from model expectations
(ML outcomes, late-inning-decided game outcomes).

**Deferred**: this needs joined data (per-game bullpen inputs at
scoring time + actual game outcomes) that isn't cleanly available in
the local mirror without deeper joins across `game_log`,
`pitcher_game_log`, and re-scoring. Would require ~2-3 additional
hours of joined-query work. Not blocking the top-level finding: the
LEVEL is wrong before the SPREAD is fixed.

## Connection to the strong-favorite overconfidence lead

Owner's earlier finding: 60-65% home favorites lose at −8pp ROI.
Model over-projects home-team strength.

Could bullpen flattening plausibly contribute?

- If the model UNDER-projects the visiting team's bullpen (i.e., the
  visitor's bullpen is REALLY better than the model thinks), that
  makes the home offense's late-innings projection UNDER-project as
  well, making the home team look TOO strong.
- Direction is consistent, but MAGNITUDE is small: the bullpen input
  moves win-prob by ~0.5-1pp per 5pt of wOBA delta at current weight.
  For strong-fav overconfidence at 60-65% (should be ~55%), we'd
  need 5-10pp of shift — an order of magnitude larger than what
  bullpen input alone can produce.

**Bullpen input is plausibly a contributing factor to strong-fav
overconfidence, but not the primary driver.** More likely drivers
per prior audits: framing not yet at full coverage, park factor
elasticity, HFA_BOOST calibration, or SP-forecast confidence
haircut applying differently on strong SPs vs weak ones.

## Decision

**A sharper bullpen input is worth backtesting, but not before the
level bug is investigated.**

**Recommended sequence** (each a separate PR, all measurement-first):

1. **Level investigation (highest priority).** Why is bullpen mean
   only 4.3pt below SP mean when it should be 10-15pt below? Test
   three hypotheses:
   - **Callup fallback pollution**: teams with N callups injected
     at 0.335 — how many teams have this, and what's the level shift
     if fallback pitchers are DROPPED instead of injected? (Trade-off:
     missing usage from real callups.)
   - **Opener pollution**: identify pitchers on the roster with
     role='RP' who have started >2 games in the last 60 days. Are
     their opener-inning wOBAs pulling up the RP mean?
   - **Steamer RP regression**: how much does Steamer's own RP
     projection regress toward 0.320 vs SPs regressed toward 0.325?
     If RPs regress harder (they usually do due to small BF), the
     projection ITSELF is the compression source.

2. **Sharper construction (after level fixed).** Switch to
   usage-weighted 30-day rolling. Test as a settings toggle
   (BULLPEN_USAGE_WEIGHTED_ENABLED, default OFF, byte-identical when
   off). Backtest on Apr-Jun, ship if the direction improves
   strong-fav ML calibration by ≥1pp.

3. **Weight sensitivity** (after both above land). Test
   `RELIEF_PIT_WEIGHT` at 0.30 and 0.35. If the sharper input then
   moves lines materially, calibration might improve. But this
   trades SP weight for bullpen weight, so expect regressions on
   games where SP is the dominant signal.

**Do NOT recommend** raising `RELIEF_PIT_WEIGHT` before fixing the
level and spread. Higher weight on a compressed, level-wrong input
just amplifies wrong direction.

## Files

- Script: none (measurements done inline via `node -e`)
- Reference: `db/schema.js q.getBullpenWoba / q.getBullpenWobaBlended`
  at lines 2926-3061
- Prod-mirror data as of 2026-07-07 for team snapshots; 30-day
  rolling window ending 2026-06-03 for pitcher_game_log.
