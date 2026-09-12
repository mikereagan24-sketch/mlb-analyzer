# Fixed-dome temperature: gate it, and tag the rows already priced (2026-09-12)

## The defect

A fixed dome cannot open, but the roof scraper wrote
`roof_status='open'` at confidence `estimated` on **all 72 Tropicana Field
home games** of the season. `computeEffectiveWeather` gated on
`roof_status`, so those games received the full outdoor treatment, and
`model.js:1389` adds the temp term straight onto the total:

```js
const estTot = Math.max(0, aRuns + hRuns + windRunAdj + tempRunAdj);
```

Measured by the new task's own dry run over `2026-03-01 .. 2026-12-31`:

```
69 graded rows carry non-zero weather
temp_run_adj   mean +0.5565 runs,  38.40 runs summed
wind_factor    non-zero on 33 rows, 2.762 runs summed (|wf| up to 0.076)
venue_id       61 rows carry 12, and 8 carry NULL
```

Two corrections to figures quoted earlier in this work:

- The wind exposure is **2.762 runs across 33 rows**, not the 0.032 runs I
  reported from the 30-day window. #383's `calcWindFactor` guard closed
  this **forward only**; it does not touch rows already written.
- The totals metric below is computed on **68** rows, not 69 — one graded
  row has no `model_total`.

## Why `temp_run_adj = 0` and not an indoor baseline

`tempRunAdjFromTempF` is a **deviation** bucket, not an absolute
temperature term:

```
<55F -> -0.5    55-70 -> 0    70-80 -> +0.3    80+ -> +0.6
```

Its zero bucket **is** the neutral case, so "no thermal effect" is spelled
`0`. Substituting a reported indoor temperature instead would put ~72°F in
the 70–80 bucket and assert **+0.3** — that a climate-controlled building
plays a third of a run hotter than neutral, which nothing measures.
`scripts/test-fixed-dome-temp.js` asserts both of those numbers so the
reasoning is checkable rather than asserted.

Two independent reasons converge on 0:

1. **Convention.** `roofChannelMults` already returns `tempMult: 0` for
   every closed non-canopy venue — sealed retractables and fixed domes
   alike — with SEA's canopy the single allowlisted exception. A fixed
   dome getting 0 is the existing treatment, not a new theory.
2. **Measurement.** Below.

## The measured level shift

Totals metric, **not** ROI: MAE, RMSE and the level (mean model − actual),
with level reported apart from dispersion. Positive = model over-forecasts.

**Blowouts removed (`actual_total >= 15` dropped), n = 59 — the reading to
trust:**

| arm | MAE | RMSE | level | median | %over |
|---|---|---|---|---|---|
| as priced (+outdoor temp) | 2.532 | 3.134 | **+0.506** | +0.810 | 64.4 |
| counterfactual (temp = 0) | 2.426 | 3.107 | **−0.043** | +0.210 | 55.9 |
| league reference, no blowouts | 2.734 | 3.322 | +0.444 | +0.605 | 56.3 |

All four measures agree: dropping the term moves TB from *more*
over-forecast than the league to centred, and its sign split from 64.4% to
the league-typical 55.9% (league 56.3%). Neither arm's CI excludes zero at
n = 59, so **the direction is consistent across four measures and
individually underpowered** — that is the honest statement, not
significance.

**Full sample, n = 68 — reported because it points the other way:**

| arm | MAE | RMSE | level | median | %over |
|---|---|---|---|---|---|
| as priced | 3.411 | 4.508 | −0.775 | +0.355 | 55.9 |
| counterfactual | 3.398 | 4.656 | −1.331 | −0.245 | 48.5 |

On the untrimmed mean, removing the term looks **worse** (level −0.775 →
−1.331). That is the tail artifact CLAUDE.md's skewed-residual discipline
describes, and it is not TB-specific: league-wide the level flips sign
between the full sample (−0.677) and the blowout-excluded one (+0.444).
The untrimmed mean is not the statistic to read on this question. The
paired `dLEVEL` is deterministic — exactly `−mean(temp_run_adj)` — so a CI
on it would be meaningless; the CIs above are each arm's level against 0.

One hypothesis was **refuted**. An inflated total should push emitted
signals toward Over; it did not. TB home over-share is **41.7%** (15 of
36) against the league's **39.6%** (456 of 1152) — 2.1pp at n = 36, i.e.
nothing.

## Registry rows whose recorded totals evidence includes TB home games

TB-home exposure in the corpora these rows cite:

```
Total signals        36 of 1188      under 21 of 717     over 15 of 471
logged totals bets    2 of 78
ML signals           52 of 1480      logged 13 of 417
graded totals games  68
```

| registry row | evidence | TB exposure | affected? |
|---|---|---|---|
| `totals_selection_edge` | 37–38 logged totals bets; the 550-signal unconditioned under comparison | **2 of the logged bets**; 21 of the unconditioned unders | **Yes.** Its headline (+10.66pp gap, and the +18.10pp under subset) is computed on emitted signals whose edges came from an inflated model total at TB. At 2 of 37 the aggregate barely moves, but the under subset is the one it warns about. |
| `ui_highlight_under_band` | 355-signal under corpus, 157 in the admitted `[2.0,5.0)pp` band | 21 of 355 (5.9%) | **Yes.** The band edges are in model-vs-market pp, so an inflated total shifts which TB unders land in the band. |
| `ui_highlight_symmetric_floor` | same under/fav/dog band corpus | same 21 | **Yes**, same mechanism. |
| `ui_highlight_tot_overs_enabled` | ROI on over signals | 15 of 471 | **Yes** for composition; it is an ROI row, so per the 2026-08-21 rule it measures selection either way. |
| `spread_cells_market_total_axis` | cell totals axis, n = 1158 / 1938 | TB games present | **No.** Its axis is `market_total_at_emit`, not the model total, so a model-side level error cannot move it. Listed to record that it was checked. |
| `defense_frv_enabled` | log loss on the ML target | 52 ML signals, 68 games in corpus | **Not on the totals channel.** Park/weather terms that scale both sides barely move a win-probability ratio (CLAUDE.md measures 0.00028 mean |Δp(home)| for a park-factor swap). Listed for completeness. |

None of these is re-opened here, and no gate is flipped. The point of the
list is that when any of them is next re-run, the 69 tagged rows will be
excluded automatically by `weather_inputs_valid`, so the numbers will move
slightly and that movement is expected rather than a new finding.

## What ships

1. **The gate.** `computeEffectiveWeather` returns `{windFactor: 0,
   tempRunAdj: 0}` for a `fixedDome` park **without consulting
   `roof_status`** — consulting it is what let outdoor weather in. All
   three callers (`runWeatherJob`, `roof-correct.js`, the ARI backfill)
   already pass `park`, so there is one gate site.
2. **The tag.** New backfill task `weather_contamination_fixed_dome`,
   registered alongside the three existing weather-contamination tasks.
   **Tag-only:** sets `weather_contamination_reason='fixed_dome_outdoor_temp'`
   and `weather_inputs_valid = 0` on the 69 graded rows, and does **not**
   rewrite the weather columns. Rewriting `temp_run_adj` to 0 on a graded
   row would leave `model_total` — computed from the old temp — inconsistent
   with its own stored inputs, and nothing re-runs the model here. A
   future re-derivation should recompute the weather **and** re-run the
   model together, then clear both flags.
3. **The predicate.** `utils/weather-inputs-valid.js` excludes
   `fixed_dome_%` by tag rather than by timestamp, because this is the one
   class the observable boundary cannot see: those rows were written by
   the live job *after* the boundary, so their `weather_quality_at` is
   fresh while their columns are wrong. A class assertion was added, so a
   future re-run fails loudly if any such row reads valid.
4. **Un-graded rows are excluded deliberately** (3 at commit time): the
   gate corrects them forward on the next weather pass, so tagging them
   would mark a row that is about to be right.

Keyed on `PARKS[].fixedDome` rather than a `FIXED_DOME_VENUE_IDS` set
because **8 of the 69 rows carry `venue_id` NULL** — a venue-id registry
would have silently missed them, the same hazard `roof-prior.js` already
warns about for the temp gate.

## Verification

```
node scripts/test-fixed-dome-temp.js
POST /admin/backfill/weather_contamination_fixed_dome  { dry_run: true }
```

29 checks: both channels zero at a fixed dome for `open` / `closed` /
`partial` / `null` / unknown `roof_status`; the +0.6 and +0.3 buckets the
reasoning turns on; **no drift at any non-dome park across 391
prod-shaped rows** (15 dome rows, 8 pre-cutover bearing-regime rows
excluded by name with counts printed); the tag-excludes-from-re-scoring
behaviour proven against the live predicate; and the task's own selection
(69 candidates, all untagged so a re-run is a no-op, all at a fixed-dome
park).

## Also in this PR

The **2026-08-18 wind regime boundary** is recorded in CLAUDE.md beside
the `park_factor_source` boundary it mirrors: `cfDir` moved for 7 parks
(`nym min atl col lad laa sd`) in bearing batch 3, `wind_factor` is
persisted at scrape time, so re-deriving wind across that date pools two
regimes. The boundary is **intra-day** — `lad-col 2026-08-19` was written
17:00 PT that day and still matches the old bearing — and unlike the park
factors there is **no `wind_factor_source` column**, so a row can only be
detected by re-deriving it. Noted there rather than left in a PR body,
because that section is where someone looks before running a corpus-wide
re-derivation.
