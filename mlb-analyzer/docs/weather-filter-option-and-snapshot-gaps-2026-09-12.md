# `weatherFilter` on the calibration harnesses, and a mid-era snapshot gap check (2026-09-12)

Two small things, both of which exist because a measurement was harder or
quieter than it should have been.

## 1. `weatherFilter` — making #382's own instruction runnable

`docs/weather-inputs-valid-2026-09-12.md` tells the reader to "pass
`weatherFilter:'tag'` to reproduce the old arm B". No caller could. The
FRV before/after in this session was therefore measured through a **local
uncommitted patch** to `calibration-ab.js`, which is not a reproducible
method — the number and the corpus it came from were held together by
hand.

| harness | how to select | default |
|---|---|---|
| `scripts/calibration-ab.js` | `WEATHER_FILTER=tag` env | `valid` |
| `services/baserunning-backtest.js` | `opts.weatherFilter: 'tag'` | `valid` |
| `GET /backtest/baserunning` | `?weatherFilter=tag` | `valid` |
| `services/parameter-sweep.js` `loadGames` | `{ weatherFilter }` | `valid` |

- **`valid`** → `weather_inputs_valid = 1`. Rows whose stored weather can
  be re-scored from. The production arm.
- **`tag`** → `weather_contamination_reason IS NULL`. Reproduces the
  pre-#382 corpus exactly.

`'valid'` is the canonical short spelling; **`'inputs_valid'` is kept as
an alias** so #382's own write-up stays runnable. One SQL fragment, two
keys — not two copies. `none` remains for contamination-cost measurement.

Both harnesses **throw** on an unrecognised value rather than falling
through to no filter; three hand-maintained lookups in this repo have
failed open and each produced a confident wrong null. An **empty** value
means "unset" and takes the default — that is how an unset env var and the
route's `|| undefined` both arrive, and it is asserted in the test so it
is a decision on the record rather than an accident of falsiness.

Each run now **echoes its filter into its own output**
(`weather filter: tag *** PRE-#382 CORPUS ***`), and the BsR harness
returns `weather_filter` plus `weather_filter_meaning` in its result. A
pasted number arrives with the corpus attached, which matters because the
arms differ by **271 games** on `2026-06-16 .. 09-10` and **428** on the
full season.

Still without the switch, deliberately out of scope here:
`scripts/calibration-sweep.js`, `scripts/component-signal-diagnostic.js`,
`scripts/bullpen-neutral-ab.js`. All three call `loadGames`, so they take
the new default; adding the env switch to each is a one-liner if wanted.

## 2. Mid-era gap check on `woba_data_snapshot`

`pipeline-freshness` asked "how old is the newest row?" — which
`woba_data_snapshot` answered with `ok` all season while **missing
2026-06-26 and 2026-07-19 outright**.

That is not a cosmetic hole. `parameter-sweep.js:397` looks the snapshot up
with `WHERE snapshot_date = <game date>` — an **exact** match, not an
as-of — so each missing day silently dropped its entire slate from every
calibration corpus: **30 otherwise-perfect graded games**, all with
`model_total` populated. And it is unrecoverable: a snapshot records what
wOBA looked like that morning, and there is no backfill for a day that has
passed, exactly like the lineup captures.

### The check

A new optional `gaps` hook on any pipeline entry, in the same declarative
idiom as the existing `perRow`:

```
gaps: { sql, recentDays, warnCount, critCount, note }
```

`sql` returns `{d, n}` rows — a date **inside the pipeline's own era** with
no capture, and how many games it holds. The query is bounded by
`MIN`/`MAX(snapshot_date)` on both sides, so the 44 pre-era dates never
appear; no snapshot could exist for those and listing them would be
permanent noise.

**Today is excluded**, because the day's snapshot is written during the
day. Without that the check would report a false gap every single morning,
which is the fastest way to make it unread.

**The level is driven by recent gaps only** (`recentDays: 7`). Older holes
can never be repaired, and a check that fails forever on unfixable history
trains the reader to skip the output — which costs more than the check is
worth. They are still **printed by name on every run**, including on an
all-OK run, because an analysis spanning them should say so:

```
woba_data_snapshot          2026-09-11      1      +1      ok
    GAPS INSIDE THE ERA: 3 date(s), 32 game(s) lost from every calibration corpus   (all historical, unrecoverable)
      2026-06-26  15 games
      2026-07-14   1 games
      2026-07-19  16 games
```

`2026-07-14` is the All-Star exhibition date and holds a single ungraded
row. It is reported rather than filtered out: a rule like "hide one-game
dates" would also hide a real single-game makeup date, and the counts
beside each date already let a reader see which ones matter.

Surfaced in all three places the existing check is surfaced: the script,
the 6AM cron log (`logPipelineFreshness`, which now prints gaps even on an
OK run), and `/health` — where `mid_era_gaps` is lifted to the top of the
`pipeline_freshness` block rather than left inside `per_pipeline`, because
a historical gap does **not** raise the pipeline's level and would
otherwise be invisible to anything reading `status` alone.

## Verification

```
node scripts/test-weather-filter-and-gaps.js     # 24 checks, exit 0
node scripts/pipeline-freshness.js               # readout above, exit 0
```

The filter assertions **count both corpora** rather than reading the SQL
(`valid` 1382 vs `tag` 954 on the full season; 1078 vs 807 on the BsR
window), check that the `inputs_valid` alias resolves to the same corpus,
and check that three unrecognised spellings — including wrong case — all
throw.

The gap assertions check that the two founding dates are named, that today
is not, that pre-era dates never appear, and that the level stays `ok`
while the dates are still reported. The **escalation** path is proven on a
synthetic in-memory DB rather than on live data, so the assertion does not
depend on the calendar: three snapshots, five game dates, two interior
holes → both found, 30 games counted, `recentCount: 2` → `CRITICAL`, and
the pipeline row inherits it.

## Queued, not implemented: an as-of fallback for `loadWobaSnapshot`

Recovering those 30 games needs the exact-match lookup to fall back to the
previous day's snapshot, capped at a 1-day lag and tagged so the affected
rows are visible in the result. That is a **methodology change** to every
calibration number, not a bug fix, so it should be pre-registered before
it runs rather than discovered afterwards in a moved figure.

One design note worth recording now: the before/after would be a **paired**
design — the same games scored under two corpora — so the resolution floor
to quote is `scripts/park-neutral-paired-floor.js`, not the between-cohort
`resolution-floor.js`. Quoting the cohort floor for a paired comparison
overstates the difficulty by roughly 28x, which CLAUDE.md measured
directly.
