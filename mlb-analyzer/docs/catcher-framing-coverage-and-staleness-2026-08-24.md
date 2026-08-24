# Catcher framing: who gets a value, who gets nothing, and what 82 days cost (2026-08-24)

> **The 59 is Savant's "Qualified" leaderboard, not our floor.** The
> current-season fetch sends no `minPitches` parameter, so Savant's default
> qualifier decides who exists. Our own 750-pitch floor **never binds** —
> the smallest row in the table has 913.
>
> **Below the threshold there is no league-average default.** The
> precedence is current-season → 2023-25 historical × 0.80 → **`null`,
> which the model turns into a 0-run adjustment.** Neutral by absence, not
> by design.
>
> **14% of today's and tomorrow's starting catchers get nothing.** 7 of 50
> catcher-sides fall all the way through.
>
> **Season-to-date, but consumed as a rate** — so 82 days of staleness is
> not "missing accumulation". It is a noisier estimate that **moved 53 of
> 59 catchers on refresh, median 0.0185 runs/game, and flipped the sign
> for 10 of them.**
>
> **And a second defect: the upsert never deletes.** Seven rows are still
> frozen — five at 2026-06-03, two at **2026-05-21** — after today's
> refresh, and one of them started a game today.

## 1. What determines who gets populated

`services/scraper.js:fetchCatcherFraming` requests:

```
https://baseballsavant.mlb.com/leaderboard/catcher-framing?year=2026&csv=true
```

**No `minPitches` parameter.** Savant's `<select id="ddlMinPitches">`
defaults to `q` — its own "Qualified" view — and that returns **59 rows**.

The historical fetch, two functions down, deliberately does the opposite:
it passes `minPitches=100` to bypass the qualifier and pulls **128 rows**,
then applies a 750-pitch floor in our own code. The comment there says the
current-season URL is *"deliberately untouched — the model's read-time
`CATCHER_FRAMING_MIN_PITCHES_2026` floor (default 750) already governs
there."*

**It does not govern there.** Measured:

```
catcher_framing, 2026-08-24
  rows                 66
  pitches >= 750       66     <- every single one
  min pitches         913
  distribution:  750-999    2
                 1000-1499  4
                 1500+     60
```

The 750 floor has never rejected a row, because Savant's qualifier is
stricter than ours and runs first. **The effective inclusion rule is
Savant's, we do not control it, and we do not record what it was.** The
same reasoning that made `minPitches=100` right for the historical pull
applies here and was not carried across.

## 2. What happens to a catcher below it

`services/frv-backtest.js:computeFramingRvPerGame`, precedence in order:

```js
const row = q.getCatcherFramingById.get(mlbId);
if (row && row.pitches >= min2026) return rate(row.rv_tot, row.pitches);
if (q.getCatcherFramingHistById) {
  const h = q.getCatcherFramingHistById.get(mlbId);
  if (h && h.pitches > 0) { const r = rate(h.rv_tot, h.pitches);
                            if (r != null) return r * absFactor; }   // 0.80
}
return null;
```

`rate = (rv_tot / pitches) * CATCHER_FRAMING_TAKES_PER_GAME` (58).

**There is no league-average lookup anywhere in that chain.** `null`
reaches `applyCatcherFramingDelta`, which returns **0**.

The distinction matters for how you read it. Because the term is a *delta*
applied to the opposing offense's runs, 0 is functionally "assume this
catcher frames exactly league-average". But it is reached by **absence**,
not by a default — which means *no framing data* and *feature disabled*
are indistinguishable downstream, and neither is counted anywhere.

Fallback depth: the historical table holds **119** catchers versus 66
current-season, so it is a genuinely wider net, taken at a 0.80 haircut.

## 3. How many of today's starting catchers land in each bucket

All 50 catcher-sides across `2026-08-24` and `2026-08-25`, run through the
real resolver and the real function:

```
current-season value       42   84%
historical x0.80            1    2%
NONE -> 0 runs              7   14%
unresolved name             0
no catcher in lineup        0
```

The seven with no framing at all:

```
2026-08-24  bos-mia  MIA  B. Navarreto
2026-08-24  cin-sf   SF   D. Cavanaugh
2026-08-24  pit-sd   PIT  R. Flores
2026-08-25  bos-mia  MIA  B. Navarreto
2026-08-25  cin-sf   SF   D. Cavanaugh
2026-08-25  pit-sd   PIT  R. Flores
2026-08-25  col-was  WAS  Harry Ford
```

Three teams (MIA, SF, PIT) are running a catcher with no framing value on
both days. The one historical-fallback case is `B. Fulford` (COL,
2026-08-25) — no current-season row at all.

**Name resolution is not the problem.** All 50 resolved to an `mlb_id`;
the misses are genuine absences from the leaderboard, not lookup failures.

## 4. Is the term big enough to care about?

Per-game framing adjustment across the 66 catchers in the table:

```
  min      -0.1298 runs
  p10      -0.0947
  median   +0.0009
  p90      +0.0692
  max      +0.1048

  mean |value|                 0.0480 runs/game
  best-to-worst catcher spread 0.2345 runs/game
```

For scale, yesterday's measured lineup-projection error had a **median
model impact of 0.130 runs**. So the typical framing adjustment is smaller
than typical lineup noise, but the **best-vs-worst catcher spread is
comparable to it**, and the extremes (±0.13) are the same order.

At `CATCHER_FRAMING_MUTE = 1.0` none of this is discounted.

## 5. Season-to-date, but consumed as a rate — so staleness bites differently

`rv_tot` is **cumulative season framing runs** (Savant, already
ABS-adjusted for 2026). The model divides by `pitches`, so what reaches
the run estimate is a **rate**, not an accumulation.

**That means an 82-day-old value is not "missing three months of runs".**
The rate largely self-normalises: both numerator and denominator grew.

The harm is different, and arguably worse than a level error would be:

**(a) It was a much smaller sample.**

```
                    rows   mean pitches   max pitches
stale (2026-06-03)    60          2,122         3,725
fresh (2026-08-24)    66          4,018         7,442
```

The stale rate is the same quantity estimated on **half the sample**.

**(b) The values moved, and not by a little.**

```
catchers whose value changed on refresh: 53 of 59

|change|   median 0.0185   p90 0.0508   max 0.0810 runs/game
```

Against a mean |value| of 0.0480 runs, **the median catcher moved by ~39%
of the typical effect size.**

Largest movers:

```
Rushing, Dalton      -0.1207 -> -0.0397   +0.0810
Campusano, Luis      -0.0522 -> -0.1145   -0.0623
Kelly, Carson        -0.0469 -> +0.0134   +0.0603
Diaz, Yainer         -0.1009 -> -0.0453   +0.0556
McCann, James        -0.0621 -> -0.1133   -0.0512
Heineman, Tyler      +0.1196 -> +0.0688   -0.0508
```

**(c) Ten of fifty-three flipped sign.**

```
Kelly, Carson       -0.0469 -> +0.0134
Baldwin, Drake      -0.0140 -> +0.0184
Heim, Jonah         +0.0190 -> -0.0130
Alvarez, Francisco  -0.0295 -> +0.0009
Raleigh, Cal        +0.0126 -> -0.0136
Realmuto, J.T.      +0.0253 -> -0.0010
```

For those catchers the model was **adjusting in the wrong direction** —
crediting a good framer where the season now says slightly negative, and
vice versa — at full strength, on every game they started since June.

**(d) New qualifiers were invisible.** The table went 60 → 66 rows. A
catcher who crossed Savant's qualifier after 2026-06-03 was getting the
historical × 0.80 fallback, or nothing, instead of his current-season
rate.

So the answer to "is an 82-day-stale season-to-date value just old" is:
**no, it is a different and noisier estimator of the same quantity, wrong
in sign for 19% of catchers, and blind to everyone who qualified since.**

## 6. Second defect: the upsert never deletes

`runCatcherFramingJob` upserts every row the CSV returns and removes
nothing. A catcher who drops off Savant's Qualified list keeps his last
value **forever**.

After today's refresh, 7 of 66 rows are still stale:

```
updated_at    rows   min pitches   max pitches
2026-05-21       2           913           946
2026-06-03       5         1,237         1,833
2026-08-24      59         2,271         7,442

frozen rows:
  666310  Naylor, Bo          1833   2026-06-03
  665561  Marchán, Rafael     1415   2026-06-03
  641555  Escarra, J.C.       1342   2026-06-03
  682663  Ramírez, Agustín    1255   2026-06-03
  665861  Rivero, Sebastián   1237   2026-06-03
  518595  d'Arnaud, Travis     946   2026-05-21
  642851  Wynns, Austin        913   2026-05-21
```

They all still clear the 750 floor on their frozen pitch counts, so they
**take precedence over the historical baseline** — the model prefers a
stale current-season rate to a three-year one.

**`T. d'Arnaud` started for LAA today** and was priced on a **2026-05-21**
framing rate. Bo Naylor is in the same set.

### The freshness check I built would not catch this

`utils/pipeline-freshness.js` reads `MAX(updated_at)`. With 59 rows
written today, `catcher_framing` reports **`last = 2026-08-24`, level
ok** — while seven rows sit 82 and 95 days behind.

That is the same shape of error as reading `MAX(game_date)` and
concluding a pipeline was alive: **an aggregate over the newest row says
nothing about the oldest.** Recorded rather than patched, because
changing the check is a decision, not a cleanup.

## 7. What is not established here

- **Whether any of this changes a price enough to matter.** The framing
  A/B is `MUTE = 0.65 vs 1.0`, which moves p(home) by a mean |Δp| of
  0.0024, and at n=349 that is unresolvable
  (`docs/decontaminated-rerun-corrected-2026-08-24.md` §3c). Nothing here
  makes that A/B answerable.
- **Whether the 0-run fallback is better or worse than the historical
  fallback** for the 14%. Untested.
- **Savant's actual qualifier threshold.** Inferred from the row count and
  the minimum pitches present, not read from their documentation.

## Related

- `services/scraper.js:896` — `fetchCatcherFraming`, the missing `minPitches`.
- `services/scraper.js:965` — `fetchCatcherFramingHistorical`, which does pass it, and why.
- `services/frv-backtest.js:51` — `computeFramingRvPerGame`, the precedence chain.
- `docs/decontaminated-rerun-corrected-2026-08-24.md` §3c — why MUTE = 1.0 is held by inertia.
