# Re-baseline: the stored actuals changed shape four times this season (2026-09-22, corrected 2026-09-23)

**Status: recorded, nothing re-run.** This is the ledger, not the redo.

> **CORRECTION (2026-09-23).** This doc originally said *"every
> actuals-dependent number this season was computed on a single season"*.
> That is too broad, and the correction matters because it changes which
> dates are affected. Measured directly from `woba_data_snapshot`, the
> stored actuals passed through **four regimes**, and single-season samples
> begin on **2026-08-03** — not in March. See "The corpus is four regimes"
> below. The original title is preserved in the git history; the claim it
> made was not verified against the snapshot table at the time, which is
> the same mistake as asserting a fix without its number.

`services/fangraphs.js` asked FanGraphs for `strGroup:'season'` over a
rolling two-year window. That returns one row per player *per season*,
and `q.upsertWoba` was `ON CONFLICT(data_key, player_name) DO UPDATE` —
so each player's first season was silently overwritten by the second.
Every stored actuals sample has been **one season**, while the code
documented it as the two-year cumulative figure the `MIN_BF=100` and
`MIN_PA=60` gates are calibrated against.

Fixed in two steps. **#435** added `strGroup:'career'` and duplicate
rejection, and shipped a regression with it (below). **#437** finds the
actual cause — `strAutoPt:'true'`, FanGraphs' automatic qualifier — and
turns it off. This doc exists because the fix changes inputs, and a
changed input invalidates measurements taken before it — CLAUDE.md §"Re-check a deprioritizing
number before treating the decision as settled" is the same asymmetry:
nothing downstream re-derives these on its own.

## Measured: how far off the samples are

`scripts/probe-woba-career-vs-stored.js`, four real FG calls, 2026-09-22,
window 2024-09-22 → 2026-09-22:

| data_key | career rows | stored rows | median stored / career sample |
|---|---|---|---|
| `pit-act-lhb` | 466 | 492 | **0.60** |
| `pit-act-rhb` | 421 | 539 | **0.52** |
| `bat-act-lhp` | 337 | 409 | **0.53** |
| `bat-act-rhp` | 332 | 418 | **0.49** |

Stored is roughly **half** the true two-year sample on every key. Inverted,
the fix roughly doubles samples — which is the direction the gate
measurement needs.

Before-side figures for the same thing, from our own data:

```
upload_log vs woba_data   pit-act-rhb 804 csv rows -> 539 stored  (1.49 rows/player)
                          pit-act-lhb 717 -> 492
                          bat-act-rhp 661 -> 418
                          bat-act-lhp 642 -> 409
                          projections 6229 -> 6238  (no collapse)
stored / 2026 batters-faced   median 0.94 across 490 pitchers
```

## Verified against FanGraphs' own career page

| player | split | stored | career (expected) | delta |
|---|---|---|---|---|
| **Blade Tidwell** | vs LHB | 111 / .398 | **154 / .388** | +43 BF |
| Framber Valdez | vs RHB | 545 / .319 | 1239 / .304 | +694 BF |
| Cristopher Sánchez | vs RHB | 601 / .332 | 1295 / .306 | +694 BF |
| Garrett Crochet | vs RHB | 118 / .364 | 792 / .298 | +674 BF |
| Max Fried | vs RHB | 290 / .260 | 954 / .257 | +664 BF |
| Tarik Skubal | vs RHB | 421 / .256 | 1077 / .251 | +656 BF |
| Bobby Witt Jr. | vs RHP | 420 / .352 | 996 / .353 | +576 PA |
| Taylor Ward | vs RHP | 412 / .309 | 987 / .319 | +575 PA |
| Vladimir Guerrero Jr. | vs RHP | 425 / .290 | 994 / .325 | +569 PA |
| José Altuve | vs RHP | 395 / .295 | 957 / .314 | +562 PA |
| Brent Rooker | vs RHP | 154 / .315 | 716 / .333 | +562 PA |

Tidwell vs LHB lands on **154 / .388**, exactly FanGraphs' career splits
page. That is the reported case closing.

**wOBA moves too, not just sample.** Crochet .364 → .298 and Guerrero
.290 → .325 are 3.5 points of wOBA, well past the 0.0215 cliff step. The
stored value was not a noisier version of the right number; it was a
different number.

**The range IS honoured.** Valdez at 1239 BF over two years is ~2 seasons
of work, not his ~9-year career, so `'career'` means "aggregate the
requested range" and not "ignore the dates". That was worth checking
rather than assuming, because the label invites the other reading.

## The cause was the qualifier, not the grouping

`strAutoPt:'true'` — FanGraphs' automatic minimum — was dropping rows
before we ever saw them. Verified, three calls, pitchers vs RHB, same
window (`tmp/probe-autopt.js`):

| strGroup | strAutoPt | rows | players | Blade Tidwell vs RHB |
|---|---|---|---|---|
| career | true | 421 | 421 | **absent** |
| career | **false** | **1158** | **1158** | **Total, TBF 146, wOBA .2824** |
| season | false | 2179 | 1158 | 2025: 47 / .4354 · 2026: 99 / .2098 |

**146 / .2824 is exactly FanGraphs' career splits page.** Tidwell vs RHB
is confirmed, closing the last open number from the original report.

Two things follow.

**#435 shipped a regression, live on main until #437 lands.** Its
421-row response was missing 118 of 539 stored pitchers and 86 of 418
batters — about one in five losing their actuals row entirely and falling
to pure projection, which is worse than the halved sample it replaced.
The risk was flagged in this doc before #435 merged; the sequencing went
wrong, not the analysis.

**Client-side summing cannot work while the qualifier is on**, which
retires the fallback plan. Summing Tidwell's *returned* season rows gives
99 BF, not 146, because his 47-BF 2025 season is below FG's per-row
minimum and is absent from the response. Across all pitchers only 25% of
season-sums matched FG's own career figure, and only 39% of wOBAs. The
missing data is missing before arithmetic can reach it.

With the qualifier off, the two agree exactly: `47 + 99 = 146`, and
`(47×.4354 + 99×.2098)/146 = .2824`, matching the career row to four
decimals. So TBF-weighting *is* the correct aggregation — we simply do
not need to perform it, because FanGraphs will.

## The ledger: what was computed on single-season actuals

Everything below consumed `blendWoba` output, so all of it predates a
correct input. **Do not re-run yet** — the pull has to land first, and
re-running against a subset-losing pull would just replace one wrong
baseline with another.

**Gate and cliff measurements (2026-09-21, this investigation):**
- 140 gated pitcher-hands: 68 of 539 `pit-act-rhb` (12.6%), 72 of 492 `pit-act-lhb` (14.6%)
- every gated row in the 70–99 BF band; zero below 70
- mean |actual − projection| on gated rows: 0.0390 (RHB) / 0.0428 (LHB) wOBA
- cliff step at the gate: 0.0215 wOBA mean, 0.064 for Tidwell
- 68 pitchers with one hand blending and the other gated
- 0 batter rows gated at `MIN_PA=60` — **true, and it was the wrong
  question. See "The batter side was not fine" below: eight hitters never
  reached the gate at all.**
- the claim "all 140 clear 100 if the sample doubles" — directionally safe, but the numbers behind it move

**Model calibration:**
- `scripts/calibration-sweep.js` runs, including the `W_PIT >= 0.80` rejection (`docs/wpit-wbat-calibration-sweep-2026-08-22.md`)
- `services/calibration-ab.js` flag A/Bs — every one in the gate registry
- the measured ROI and log-loss resolution floors in CLAUDE.md
  (`scripts/resolution-floor.js`): ±12pp ROI plateau, ~0.020 Δ log loss
- `scripts/park-neutral-paired-floor.js`: sd 0.010770, ±0.000617 at n=1171 —
  the dispersion the per-slot-hand power arithmetic borrowed
  (`docs/per-slot-pitcher-hand-open-question-2026-09-19.md`)

**Parameter work:**
- `W_PROJ`/`W_ACT` at 0.45/0.55 — the split *between* projection and a
  sample that was half its documented size
- `SP_WEIGHT` / `SP_PIT_WEIGHT` sweeps, `pyth_exp`, `RUN_MULT`
- `BATTER_ACT_FULL_WEIGHT_PA = 150`: the 60→150 ramp was being fed
  half-size samples, so batters near the floor got less actuals weight
  than their true sample warranted. No batter was *rejected* — but eight
  were never *found*, which is a different and worse failure and is
  recorded in the section below.

**Not affected:**
- anything on projections only (`pit-proj-*`, `bat-proj-*` never collapsed)
- park factors, wind, weather, FRV, framing, baserunning — different inputs
- the totals anchor work (#413/#414, `docs/totals-anchor-fallbacks-closed-2026-09-21.md`)
- signal selection sweeps whose target was not model output

## SEVERITY CORRECTION: the batter side was not fine (2026-09-23)

**Added after the fact.** The ledger above says "0 batter rows gated at
`MIN_PA=60`" and "no batter was *rejected*". Both are true and both read as
"the batter side came through this intact". It did not.

**A gate count cannot see a lookup that never happened.** Eight hitters'
actuals rows were never reached at all, so they were never gated, never
rejected, and never counted. Their wOBA was the projection alone for the
whole season.

`utils/fuzzyLookup` skipped index entries carrying a team tag using the
SHAPE `/\s[a-z]{2,3}$/`, and `" jr"` matches that shape. Projections are
team-tagged, so stage 5 reached them on the tag. Actuals are
collision-only tagged since #438, so a non-colliding actuals row is
**bare** — and a bare suffixed key was exactly the excluded one. Fixed in
#443; full taxonomy in `docs/name-resolution-failures-2026-09-23.md`.

Measured over every 2026 lineup lookup, old resolver against new
(0 lost, 0 changed, 1416 lookups gained):

| hitter | lookups gained | maps | **lineup slots** |
|---|---|---|---|
| Fernando Tatis Jr. [SD] | 284 | act ×2 | **142** |
| Michael Harris II [ATL] | 264 | act ×2 | **132** |
| Vladimir Guerrero Jr. [TOR] | 262 | act ×2 | **131** |
| Jazz Chisholm Jr. [NYY] | 232 | act ×2 | **116** |
| Lourdes Gurriel Jr. [ARI] | 192 | all ×4 | **48** |
| George Lombard Jr. [NYY] | 80 | act ×2 | **40** |
| Rafael Flores Jr. [PIT] | 76 | act ×2 | **38** |
| Gabriel Rincones Jr. [PHI] | 26 | act ×1 | **26** |
| | | | **673 slots** |

Gurriel is the arithmetic check: 192 / 4 maps = 48, which is independently
the slot count measured for him in the taxonomy doc.

**673 of 40,050 lineup slots (1.7%)** — and not a random 1.7%. Seven of the
eight are everyday hitters batting in high-PA-weight lineup positions, and
four are stars. Gurriel is worse again: his projection row also carries no
team tag, so **both** halves were missing and he took the league-average
`BAT_DFLT` for all 48 slots.

### Why this belongs in this ledger and not only in its own doc

It is the same failure as the single-season collapse — actuals silently not
reaching the blend — one layer down. The collapse happened at **ingest**
(`strGroup`/`strAutoPt` returning a subset); this happened in the
**resolver** (a key the scans could not see). They compound: for these
eight hitters the actuals were not merely half-size, they were absent.

So every entry in the ledger above carries a second defect on the batter
side:

- **Model calibration** — `calibration-sweep.js`, every gate-registry flag
  A/B, and the ROI and log-loss resolution floors were all computed with
  four star hitters priced on projection alone. The floors in particular
  are a noise measurement, and this is a systematic offset inside it.
- **`W_PROJ`/`W_ACT` at 0.45/0.55** — the split between projection and
  actuals, measured on a corpus where 673 batter slots had **no** actuals
  term to weight. The direction of that bias is knowable: it flatters
  `W_PROJ`, because the rows where actuals were missing scored as though
  the projection were the whole answer. **CLOSED 2026-09-23 — not
  re-runnable, and not for a corpus reason. See "CLOSED: W_PROJ / W_ACT is
  unanswerable" below: the full parameter range is 0.003 of log loss
  against a 0.015 floor, and 0.45/0.55 has no recorded derivation to
  re-derive.**
- **`BATTER_ACT_FULL_WEIGHT_PA = 150`** — the ramp's shape was fitted on
  `(actual − projection)` dispersion by PA bucket. The eight hitters
  contributed no rows to those buckets at all, so they are missing from
  the curve rather than misplaced on it.

### What does NOT need re-running because of this

- pitcher-side numbers: `pit-act-*` rows are team-tagged and were reached
  by stage 5 throughout, and the 140-gated-hand measurement is unaffected
  by this defect (it has its own, above);
- anything on projections only;
- park factors, wind, weather, FRV, framing, baserunning.

### Order of operations for this half

It slots in **after** step 2 of the list below and before step 3:

2a. With #443 merged and one refresh landed, re-run
    `scripts/test-team-tag-membership.js` and confirm the eight resolve.
2b. Re-run the batter ramp occupancy — the 60→150 band — because it now
    includes eight hitters it has never included, all of them
    high-sample. Expect the band to get *less* crowded, not more: their
    true two-year PA counts sit well above 150.
2c. Only then treat any batter-side calibration number as re-derivable.

**Do not re-run the calibration sweeps before 2b.** The ramp occupancy is
an input to interpreting them, and re-running in the wrong order replaces
one wrong baseline with another — the same trap step 1 above was written
to avoid.

## The corpus is four regimes, and any snapshot-bound analysis crossing them pools them

Measured on `woba_data_snapshot` / `bat-act-rhp`, 122 dates,
2026-05-20 → 2026-09-22:

| regime | dates | n dates | avg rows | max PA | what was stored |
|---|---|---|---|---|---|
| **A** | 05-20 → 07-01 | 34 | 727 | **1375** | two-year aggregate, unqualified |
| **B** | 07-02 → 07-30 | 27 | **338** | 1379 | two-year, **qualifier ON** — rows halve, max holds |
| **C** | 08-03 → 09-21 | 49 | 406 | **484** | **single season** — max collapses |
| **D** | 09-22 → | 1 | 705 | 1054 | corrected career pull (#437) |

The transitions are sharp, not gradual:

```
2026-07-01 (742 rows, max 1379)  ->  2026-07-02 (323 rows, max 1100)
2026-07-30 (322 rows, max 1088)  ->  2026-08-03 (388 rows, max  484)
2026-09-21 (419 rows, max  524)  ->  2026-09-22 (705 rows, max 1054)
```

**How to read them.** A full season of PA versus RHP for a regular is
roughly 400–480, so regime C's ceiling of 484 is one season and regime A's
1375 is two. Regime B keeps the two-year ceiling while losing more than
half the players, which is the signature of FanGraphs' automatic qualifier
(`strAutoPt`) rather than of the grouping — the same cause #437 found, two
months before anyone looked.

### This is a corpus hazard, in the same family as the park-factor boundary

`services/parameter-sweep.js` and `scripts/calibration-sweep.js` are
**snapshot-bound**: each game is scored against the `woba_data_snapshot`
rows for its own date, and games without a snapshot are skipped. So any
window crossing **2026-07-02**, **2026-08-03** or **2026-09-22** is pooling
regimes, exactly the way a corpus crossing 2026-08-25 pools two
park-factor regimes.

It is worse than the park-factor case in one respect and better in
another. Worse: the park-factor regimes were both "correct at the time",
whereas A, B and C are three different wrong answers. Better: it is
directly observable — the row count and max sample per date are enough to
classify a snapshot, so no marker column is needed.

**The boundary is observable, not a remembered date.** Classify a date by
querying it, the way `park_factor_source` is classified by comparing
against both tables:

```sql
SELECT snapshot_date, COUNT(*) rows, MAX(sample_size) max_pa
FROM woba_data_snapshot WHERE data_key='bat-act-rhp'
GROUP BY 1 ORDER BY 1;
```

Affected by this, beyond the entries already listed above: the
**2026-08-21 W_PROJ/W_ACT sweep**, whose window was 2026-06-01 → 2026-08-07
and therefore spanned regimes A, B **and** C. Its corpus was never one
corpus.

## CLOSED: W_PROJ / W_ACT is unanswerable, and 0.45/0.55 has no derivation

**Closing this rather than leaving it open**, because the ledger above
otherwise implies a re-run is owed. It is not.

### 0.45/0.55 was never fitted

- The schema default is **0.70 / 0.30** (`services/settings-schema.js:170-175`).
  Production's 0.45/0.55 is an `app_settings` override.
- `scripts/optimize-params-v2.js` sweeps `W_PROJ` on `[0.50, 0.60, 0.70, 0.80]`.
  **0.45 is not on that grid**, so it cannot have selected it.
- `scripts/sweep-woba-blend.js` says in its own header that it exists to
  compare "the current 0.70/0.30 against 0.50/0.50" — it predates the
  value, scores ROI on emitted signals, and documents its own look-ahead.
- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` opens *"Measurement pass
  only. NO parameter changes shipped."* Result: **0 of 9 bootstrap CIs
  exclude zero.** It confirmed the value was indistinguishable from its
  neighbours; it did not fit it.
- The earliest trace is `docs/audit-2026-07-02.md`, which reads it out of
  `getSettings()` as an already-live value, and
  `docs/cohort-v7-cutover-2026-07-05.md`, which records it in a settings
  snapshot. Both record; neither derives.

There is no "before" weight or CI to report. **Do not cite a fit for
0.45/0.55, because there isn't one.**

### And no corpus of any size can resolve it

`scripts/calibration-sweep.js W_PROJ_W_ACT 0.45 2026-06-01 2026-08-07`,
the instrument CLAUDE.md prescribes for a pricing parameter:

```
value     dLL       95% CI                  excludes 0?
 0.10   +0.00218   [-0.00123, +0.00579]         no
 0.40   +0.00022   [-0.00025, +0.00072]         no
 0.45    baseline (production)
 0.80   -0.00071   [-0.00409, +0.00251]         no
 0.90   -0.00065   [-0.00517, +0.00335]         no

verdict: clearing ALL THREE gates: NONE   ...and BETTER than production: NONE
gate counts: bootstrapCI=0   folds=0   valfit=8 (of 9)
```

**The whole 0.10 → 0.90 range spans 0.0029 of log loss. The measured floor
is 0.015.** The entire parameter range is five times smaller than the
smallest detectable difference, so correcting the inputs cannot make it
visible — corrected inputs change *what* is weighted, not the size of the
effect the weighting can have.

Two independent instruments agree. The 2026-08-21 pre-flight measured the
full range as moving team wOBA by a median of **0.0039 = 0.18 runs**,
against a median weather adjustment of 0.300 runs already known to be
undetectable at these sample sizes.

**The log-loss minimum sits at 0.80, and that is not a reason to move it.**
`bootstrapCI=0` and `folds=0` mean nothing clears the three-gate rule, and
CLAUDE.md §"The window sign test is not precise at n~350" records that a
grid minimum moves by half the parameter range across resamples of the
same data. This is the case that rule was written for.

Two caveats on the run itself, neither of which changes the conclusion:
the corpus was regimes A/B/C pooled, and the harness reported
`*** PARTIAL: W_PROJ is read by runModel AND by the bullpen computation,
whose output is now read from its persisted emit-time value ***` — only
the runModel half varies between arms. Both make the run *less* able to
find an effect, and it found none in a range already below the floor.

### And the ROI cut agrees, descriptively (2026-09-23)

**Descriptive, not evidence.** Run because it was asked for explicitly on
that basis. ROI over emitted signals reads SELECTION, not pricing --
`calcPnl` never sees the model's numbers, so a signal emitted on the same
side at two weights carries a byte-identical pnl and stake at both. The
log-loss result above already settles the pricing question the other way.

`services/parameter-sweep.js` exports driving the shipped scorer, corpus
2026-05-20 .. 2026-09-22, 1305 scoreable games:

```
W_PROJ    n     W-L-P       ROI%      95% CI              wagered
 0.25   1259  600-659-0    -5.03   [ -9.75, +3.54]        130218
 0.35   1235  583-652-0    -5.24   [-11.99, +1.01]        125767
 0.45*  1222  574-648-0    -5.12   [-12.30, -1.03]        123143
 0.55   1208  557-651-0    -6.35   [-13.10, -0.63]        120349
 0.65   1207  555-652-0    -6.17   [-12.58, -2.02]        119202
 0.75   1196  542-654-0    -7.05   [-10.87, -1.91]        117459
        * production
```

**Every interval is 5-7pp wide and they all overlap. The whole 2.02pp
headline span fits inside any single point's CI**, so the apparent
monotone decay is not separable from noise even before the decomposition.

#### The decomposition: 1.78pp composition, 0.24pp side flips

The three things CLAUDE.md requires of any such sweep:

```
vs 0.45     n_stay  n_enter  n_leave  n_changed_bet  d_stay
 0.25        1093     166      129          0         0.00
 0.35        1159      76       63          0         0.00
 0.55        1141      67       81          0         0.00
 0.65        1071     136      151          1         0.19
 0.75         986     210      236          2         0.40

CORE (emitted at all six weights): n = 863 of 1222
  core ROI  -7.04  -7.04  -7.04  -7.04  -7.04  -6.80
  core_roi_span = 0.24pp        headline span = 2.02pp
```

- **`n_changed_bet` is 0 at three of the five off-baseline points**, and at
  those three the core ROI is identical to the penny. That is the arithmetic
  proof that nothing was repriced: the same 863 bets, the same P&L.
- **The core returns −7.04 at five of six weights.** The only movement,
  −6.80 at 0.75, comes from **2 bets** flipping side.
- So of the 2.02pp headline span, **0.24pp is side flips and 1.78pp is pure
  composition** -- different bets landing, not better pricing.
- The marginal bets that do all the work have the CIs that class of bet
  always has here: enter/leave ROI at every weight spans zero, by ±20-30pp
  (0.35: enter +1.95 [−17.8, +22.5], leave +7.68 [−18.8, +31.0]).

#### Two instruments, one conclusion

| instrument | reads | result |
|---|---|---|
| `calibration-sweep.js` | log loss over ALL games | range 0.0029 against a 0.015 floor, 0 of 9 CIs exclude zero |
| this ROI cut | selection over emitted signals | core span 0.24pp on 2 flipped bets; 1.78pp composition |

**Not resolvable, and not worth moving.** The calibration instrument says
the parameter cannot be seen; the ROI instrument says what movement there is
does not come from pricing. They do not merely agree -- they fail in the two
independent ways the two designs can fail.

#### Two caveats that bound the reading

1. **The corpus straddles all four actuals regimes** (see "The corpus is four
   regimes" above): two-year unqualified to 2026-07-01, qualifier-restricted
   to 07-30, single-season 08-03 to 09-21, corrected from 09-22. So the
   spread reflects which regime's actuals a game landed under as well as
   which games landed. A snapshot-bound sweep over this window is pooling
   three wrong input regimes and one right one.
2. **The negative absolute ROI is a property of the emitted-signal
   population on this corpus**, not a verdict on the weights. Every arm is
   negative, including production; nothing here says the weights cost money,
   and nothing here should be quoted as an ROI figure for the model.

### What this closes

- **W_PROJ / W_ACT stays at 0.45/0.55.** Not because it is optimal —
  because it is indistinguishable, and because no available measurement
  can say otherwise.
- The `W_PROJ`/`W_ACT` line in the ledger above is **struck as
  re-runnable**. It is not blocked on corrected inputs; it is blocked on
  the effect being too small to see.
- What would reopen it: a materially larger scored corpus, or a
  reformulation where the weight moves something bigger than 0.18 runs.
  Not more snapshots of the same thing.


## RE-BASELINE: every FRV measurement ran with the term absent on ~17.6% of fielder slots (2026-09-23)

**A re-baseline entry, not a re-run instruction.** The FRV term is gated
OFF (`defense_frv_enabled` is not even in `app_settings`), so **no price has
ever been affected**. What was affected is the evidence the gate decision
rests on.

### The mechanism

`resolveCatcherMlbId` resolved fielder names against `team_rosters` — an
840-row snapshot refreshed daily, holding only currently-active players —
while replaying games from April onward. A player since optioned, traded or
shut down did not exist to it. `team_rosters_season` (1665 rows, keeps IL'd
players) had them all along and was not consulted. Fixed in #450.

Measured on the gate's own corpus: the `fielding_frv_snapshot` era,
**2026-06-04 → 2026-09-22, 1433 games**, FRV read **as-of** each game date
(the scope `defense_frv_split` pins).

```
fielder slots        20062
resolved, before     15707  (78.29%)      unresolved 4355 (21.71%)
resolved, after      18244  (90.94%)      unresolved 1818  (9.06%)
RECOVERED             2537
```

### What it did to the term

```
                n      mean    median      p10      p90       min      max
before       2854    0.0762    0.0855  -0.0996   0.2487   -0.6510   0.5241
after        2865    0.0557    0.0614  -0.1192   0.2247   -0.4134   0.5241
```

- **1502 of 2854 team-sides move** (52.6%); |delta| mean **0.0347 runs**,
  median 0.0059, p90 0.1037, max **0.3959**.
- Signed delta mean **−0.0199** — the unresolved version was systematically
  **flattering** defences.
- **1065 of 1433 games (74.3%)** have at least one side move; 437 both.
- The **differential**, which is what the model prices: |d| mean **0.0542
  runs**, median 0.0354, p90 0.1414, max **0.4417**.
- 11 team-sides had **no value at all** before and have one now.

For scale, the max differential of 0.44 runs is larger than the median
weather adjustment (0.300 runs) that CLAUDE.md already records as sitting at
the edge of detectability. This is not a rounding difference.

### Why it is concentrated, not diffuse

The term scales the resolved slots' mean across the full fielding
complement — correct when a fielder is genuinely absent from Savant, and
badly wrong when he is merely unresolvable. SF spent much of the season
with **one of seven** slots resolving, so one player's rate stood in for the
whole defence, and the value **flipped sign** when the rest arrived:

```
2026-07-24 laa-sf  SF   before +0.2943 (1/7 resolved)   after -0.1016 (7/7)
2026-07-19 sf-sea  SF   before -0.6230 (1/7)            after -0.2302 (7/7)
2026-06-21 pit-col COL  before +0.3399 (3/7)            after -0.0054 (6/7)
```

The players missing were everyday starters — Devers, Jung Hoo Lee, Ohtani,
Chisholm, Castro, Buxton, Keith — so the loss landed on high-usage slots,
not on the margins.

### What this re-baselines

Everything whose input was this term:

- **`defense_frv_enabled`** (gate registry). Its recorded evidence —
  *"moves p(home) on 100% of games (mean |dp| 0.0083), better on ALL FIVE
  metrics, edge slope −0.313 → −0.218, Δ log loss −0.00087
  CI [−0.00211, +0.00065]"* — was measured on the unresolved term. The flip
  criterion (**CI excludes zero on the negative side, ≥1200 games**) is
  unchanged; the figures it would be judged against are not re-derivable
  from that run.
- **`defense_frv_split`** (opened 2026-09-12 when the term was redefined,
  window to 2026-10-31). Same bar, same corpus, same defect.
- **The interaction arms** that carried FRV as one of their features.
- `services/frv-backtest.js` and
  `scripts/framing-frv-hindsight-backtest.js`, which take the same term
  through `utils/fielding-frv-term.js`.

**Not affected:** the catcher/framing path. Catchers resolved at **99.57%**
(14 misses of 3262) because `catcher_framing` is a second authority for
them specifically. Framing numbers stand.

### Order of operations for this half

Slots in alongside 2a–2c above:

2d. With #450 merged, re-run the slot count and confirm 90.94%.
2e. Re-run the `defense_frv_enabled` / `defense_frv_split` A/B on the
    as-of window. **This is the one re-run on this page that is worth
    doing**, because unlike W_PROJ/W_ACT the term demonstrably moves — 0.054
    runs of differential at the median, against a log-loss floor of 0.015
    that a 0.0083 mean |dp| was already close to clearing.
2f. Only then read the gate's flip criterion against it.

**The 1818 slots still unresolved after #450 are a different question** —
those are players absent from both rosters, and the honest reading is that
some are genuinely absent from Savant rather than name-resolution failures.
Do not treat 100% as the target.


## FRV gate re-run on the corrected resolver (2026-09-23)

Step **2e** of the order of operations below, done. Both gate rows are now
dispositioned in `services/feature-gate-registry.js` as
**`not_enabled_indistinguishable`**, and **neither window was extended** —
more of the same corpus cannot resolve an effect this size.

`scripts/calibration-ab.js DEFENSE_FRV_ENABLED false true`, `FRV_READ=asof`,
through the shipped chain (`harness-inputs` -> `frv-backtest` ->
`utils/fielding-frv-term` with `resolveId: resolveCatcherMlbId`), so #450's
season-roster fallback is in both arms.

| | `defense_frv_enabled` | `defense_frv_split` (as-of window) |
|---|---|---|
| window | 2026-06-01 .. 2026-08-07 | 2026-06-04 .. 2026-09-22 |
| games, identical set | **658** | **1076** |
| Δ logLoss (ON − OFF) | **−0.00075** | **−0.00047** |
| 95% CI | [−0.00230, +0.00086] | [−0.00170, +0.00092] |
| window sign test | 3/5 | 3/5 |
| p(home) moved | 619/658 (94.1%) | 1075/1076 (99.9%) |
| mean abs(Δp) | 0.00821 | 0.00873 |
| verdict | not significant | not significant |

**Neither clears the flip criterion** — *CI excludes zero on the negative
side, on ≥1200 games*. The as-of arm reaches 1076 of the 1200, and its CI
still spans zero.

**Both effects are one twentieth of the log-loss floor.** The floor is
**0.015** (re-measured, 1268 items — see the CLAUDE.md section this doc's
W_PROJ closure points at). 0.00075 and 0.00047 sit far below it. The
direction has been negative in all three measurements and the interval has
tightened slightly (±0.00131 now against ±0.00138 in 2026-08-23), but
tightening is not separating.

### The coverage win is real, and it is what #450 bought

```
FRV coverage, as-of window:  1076 / 1076 sides, BOTH teams
```

Before #450 roughly **a fifth of fielder slots silently defaulted** — 4355
of 20062 (21.71%) over this era — and the term scales the resolved slots'
mean across the full complement, so those sides were being priced from as
few as one of seven fielders. The term is now populated everywhere it
should be. That did not make the flag distinguishable; it made the number
being tested the right number.

### The recorded 2026-08-23 figures are NOT a baseline to difference against

| | recorded | now (recorded window) | now (as-of) |
|---|---|---|---|
| Δ logLoss | −0.00087 | −0.00075 | −0.00047 |
| ALL FIVE metrics better | claimed | **no** | **no** |
| edge slope | −0.313 → −0.218 | **+0.128 → +0.253** | +0.101 → +0.179 |

**The edge slope flipping sign at OFF is the proof they are not the same
measurement.** Three things changed in between and their contributions
cannot be separated:

1. the recorded run **predates `harness_inputs_persisted`** — the registry
   row says so itself — so bullpen and framing inputs were recomputed then
   and are read from persisted emit-time values now;
2. it **predates the 2026-09-14 `FRV_READ=asof` default**, so it read
   current-state FRV, which is hindsight for a June game;
3. it **predates the 2026-09-12 term redefinition** (the `(mlb_id,
   position)` split) — which is why `defense_frv_split` exists as a
   separate row at all.

So the recorded numbers are a record of what was believed on 2026-08-23,
not a comparator. Quoting a delta between them and these would be
attributing to the resolver fix a difference that four changes share.

### Disposition

**Not enabled. Effect indistinguishable. Revisit on a pooled multi-season
corpus.** Not by extending either window, and not by another re-run against
the same games — at one twentieth of the floor the answer would be the same
null with a slightly different third decimal. What would change the
picture is a corpus large enough to move the floor, which means more
seasons rather than more dates.


## Order of operations

1. Resolve the dropped-player question and merge a pull fix.
2. Let one real bookmarklet run land, then re-run
   `scripts/probe-woba-career-vs-stored.js` — median ratio should sit near
   1.0 and row counts should match.
3. **Then** re-measure the gate: gated pitcher-hands at `MIN_BF=100`, and
   batter occupancy of the 60–150 ramp. That is the number the threshold
   question should have been asked against.
4. Only then the cliff-vs-ramp question. Note that the **seasonal cliff**
   — samples near zero in April, the gate rejecting nearly everything
   until midsummer — is a consequence of this same defect: with one
   season stored, every sample restarts each March. A true trailing
   two-year window carries the prior season through the spring, so that
   cliff should disappear with the fix rather than need its own change.
