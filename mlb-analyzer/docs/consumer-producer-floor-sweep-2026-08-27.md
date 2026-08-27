# When the consumer is more permissive than the producer (2026-08-27)

> **The `fielding_frv` per-row CRITICAL was not staleness. It was 44 rows
> the current ingest cannot produce.**
>
> Every fresh row clears `minInnings=200` → **600 outs**. All 44 stale rows
> sat below it, from **6 outs** upward. The pricing-path consumer accepted
> any row with `outs_total > 0` — **~100× more permissive than the ingest
> that fills the table** — so precisely the rows the producer excludes were
> the ones that survived as leftovers.
>
> **Fixed, and the check went green on its own** rather than by exception.

## 1. What the 44 actually were

```
                  outs_total          season window   updated_at
  fresh  n=510    min 600, med 3847   2024-2026       2026-08-24
  stale  n=44     min   6, med   78   NULL            2026-05-22
```

The NULL season window is the tell: the current fetch always stamps
`2024-2026`. These came from a **pre-floor ingest generation**. They are
not qualified fielders who dropped off the leaderboard carrying a valid
trailing figure — they were never eligible under the rule the table is now
filled by. `outs_total >= 600` partitions them perfectly: 510 above, 44
below, **zero** fresh-generation rows below.

**The harm was noise, not age.** `total_runs / outs_total × OPPS_PER_GAME`
turns a handful of outs into a full-game adjustment:

| | median | p90 | max |
|---|---|---|---|
| legitimate rows | 0.0340 | 0.0880 | 0.2083 |
| sub-threshold rows | 0.0893 | 0.3875 | **2.2132** |

Worst cases, confirmed by `mlb_id`: **Scott Kingery, 18 outs, −2.213
runs/game**; Joc Pederson, 18 outs, −0.697; Kyle Schwarber, 51 outs,
−0.519. Full-time DHs with almost no fielding sample. A single fielder
moving more than the entire park-factor effect (0.30–0.43 runs).

**Exposure:** 17 of 44 on active rosters; lineup slots in **176 of 337
games** since 2026-08-01. `DEFENSE_FRV_ENABLED = false`, so nothing was
mispriced — this was a landmine under a gate, not a live defect. A gate
evaluation flipping it would have imported all 44 into the pricing path.

## 2. Why this is the framing bug's sibling

Not the same *mechanism* — there is no historical fallback for a stale FRV
row to outrank, so a missing row simply drops that fielder from the sum.

But the same **class**: a floor that does not check what the producer
checks.

| | producer | consumer | direction |
|---|---|---|---|
| catcher framing (the 2026-08-24 bug) | pitch volume | pitch volume, **no age** | let a frozen row win |
| fielding FRV (this) | 600 outs | **`> 0` outs** | let a 6-out row price |

Both were a gate that looked *almost* right and omitted the dimension that
mattered.

## 3. The fix

1. **`FRV_MIN_INNINGS` / `FRV_MIN_OUTS` exported from the producer**
   (`services/scraper.js`), derived as `innings × 3`. The fetch's own
   `minInnings` param now reads from it. **A second literal 600 is how this
   recurs**, so there isn't one.
2. **The consumer applies the producer's floor.** `teamFielding` in
   `services/jobs.js` skips any row below `FRV_MIN_OUTS`, with a warning
   naming the sample size — skipped, not extrapolated.
3. **The ingest maintains its own invariant.** `runFieldingFrvJob` prunes
   sub-floor rows after a successful upsert. In the **job**, not only a
   script, because a script opens `data/mlb.db` and is a laptop tool —
   the same gap the first-pitch backfill had. **Guarded by `applied > 0`**:
   a fetch that returns nothing must never delete, which is the
   truncated-fetch failure `utils/prune-missing.js` exists to prevent.
4. **`scripts/prune-subthreshold-frv.js`** for the analysis copy —
   dry-run by default, prints every row, and **refuses** if any sub-floor
   row carries a season window (which would mean the producer and the
   floor had diverged, and a human should look before rows are destroyed).

**Criterion-based, not a fetch diff.** `prune-missing`'s guard is the wrong
tool here and is deliberately not used: nothing is being fetched, and the
criterion is checkable before and after.

### Result

```
deleted: 44   rows 554 -> 510
  rows still below the floor : 0  ok
  updated_at spread          : 2026-08-24 .. 2026-08-24  ZERO
```

`fielding_frv` dropped from permanent CRITICAL to ordinary STALE, tracking
the same 3-day local-copy drift as every other pipeline. **No exception
mechanism, no amber state, no acknowledgment stamp** — and a future genuine
staleness still turns it red.

The 44 rows are backed up as JSON outside the repo before deletion.

## 4. The sweep — the other two tables

### `catcher_framing` / `catcher_framing_historical` — LATENT, not live

```
                              n     pitches min    below producer floor (100)
catcher_framing             100          335      0
catcher_framing_historical  119          776      0
```

- **Main path is STRICTER than the producer** — consumer floor 750 vs
  producer 100. That is the *safe* direction, and deliberate: 335-pitch
  rows exist in the table and the consumer correctly refuses them.
- **The historical fallback checks `pitches > 0`** (`utils/framing-rate.js`
  lines ~138, ~154). That *is* the permissive shape. It is inert today only
  because the historical table's minimum is 776 — comfortably above the
  750 the main path demands.

**Not changed, deliberately.** It is zero-impact on current data, and
changing a fallback's floor without first measuring which catchers would
lose their fallback is the kind of unmeasured change this repo keeps
regretting. **The trigger for revisiting is explicit: if
`catcher_framing_historical` ever holds a row below 750 pitches, the gap
becomes live.** A cheap guard would be an assertion that
`MIN(pitches) >= CATCHER_FRAMING_MIN_PITCHES_2026` in both framing tables.

### `pitcher_debut` — clean, no instance

```
n=448   career_ip NULL=35   career_bf NULL=35   min career_ip=3
fetched_at: 2026-08-24 .. 2026-08-24
```

**No producer floor exists to mismatch** — it is a per-pitcher debut
lookup, not a filtered leaderboard, so there is no qualifier for a consumer
to under-apply. The 35 NULL-career rows are handled correctly: the cohort
builder returns `null` for them rather than defaulting, and they are
excluded from the rookie definition rather than silently counted as
0 career IP.

## 5. The generalisation

**Two confirmed instances in four days makes this a pattern, not a
coincidence.** Whenever a table is filled by a *filtered* source:

- The qualifier belongs in **one exported constant**, owned by the
  producer. Not a literal in the fetch and another in the consumer.
- The consumer applies **the producer's floor**, or a stricter one —
  never a looser one. Stricter is safe; looser means the only rows the
  gap admits are ones the producer would have rejected.
- The ingest **maintains the invariant**, so leftovers from an earlier
  generation cannot survive indefinitely. An upsert never removes what it
  stops touching.
- Rows a *current* producer could not have made are **residue, not
  history**. Prune them; do not build an exception path to keep them.

## Related

- `docs/catcher-framing-coverage-and-staleness-2026-08-24.md` — the sibling bug.
- `services/scraper.js` — `FRV_MIN_INNINGS` / `FRV_MIN_OUTS`.
- `utils/framing-rate.js` — the latent `pitches > 0` fallback.
- `CLAUDE.md` — "Scope a check to what it can act on".
