# Re-baseline: every actuals-dependent number this season was computed on a single season (2026-09-22)

**Status: recorded, nothing re-run.** This is the ledger, not the redo.

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
  the projection were the whole answer.
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
