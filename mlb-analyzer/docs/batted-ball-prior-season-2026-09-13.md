# Batted-ball prior-season backfill, and what it does to the interaction corpus (2026-09-13)

A 2025 full-season pull stamped as a prior-season snapshot, so the as-of
lookup has something to resolve to for 2026 games that predate the first
live capture. **This is a methodology note as much as a data load** — the
corpus it creates is 2025-prior + 2026-forward, not as-of 2026 throughout,
and that bounds what the interaction measurement can detect.

## The methodology note, first

**What this gives the measurement: BETWEEN-PITCHER variation for every 2026
game.** A ground-ball starter and a fly-ball starter are distinguishable on
2026-04-01 using their 2025 profiles, and that is the variation an
interaction term needs in order to exist at all.

**What it does not give: WITHIN-SEASON drift.** Every 2026 game before the
first live snapshot resolves to the **same 2025 row** for a given pitcher.
Across that stretch the batted-ball term is constant per pitcher; a pitcher
who genuinely changed his mix in 2026 looks unchanged until the live series
begins.

So the term carries cross-sectional signal over the whole season and
longitudinal signal only after the live captures start. Two consequences
for any result computed on this corpus:

1. **An interaction that is real but driven by in-season change will be
   attenuated**, because most of the corpus cannot see change.
2. **A null is not evidence that the interaction is absent** — only that it
   is absent in the between-pitcher direction, measured with a profile up
   to a season stale.

Both must be stated in any result computed on this window. This is the same
class of statement as "sweep ROI measures selection, not pricing": the
instrument can only see part of the question, and saying which part is the
difference between a finding and a mistake.

## What it does

| | |
|---|---|
| window | `2025-03-01 .. 2025-11-30`, **fixed** |
| position | `P`, splits 5 (vs LHB) and 6 (vs RHB) |
| panel | `strType '3'` (Batted Ball) via the existing client |
| written to | `pitcher_batted_ball_snapshot` |
| `snapshot_date` | `2026-03-31` |
| `source` | `prior_season` |

The window is **fixed rather than derived from today**. `fetchActualSplit`'s
default is a rolling two-year range, which would make this backfill return
a different corpus every time it ran — the opposite of a reproducible
historical load. `opts.start` / `opts.end` were added for exactly this, and
the default path is untouched (asserted).

`2026-03-31` is chosen so that any 2026 game date satisfies
`snapshot_date <= game_date` and so the row sorts before every live
capture. It is not a real capture date and does not pretend to be — that is
what the `source` column is for.

**It does not write `pitcher_batted_ball`**, the current-state table. A
2025 profile is not the current profile, and the live sync owns that row
set.

## `source`

New column on the snapshot table, `prior_season | live`. The table shipped
in #390 without it; the migration is a plain `ADD COLUMN` plus a one-time
`UPDATE ... SET source='live' WHERE source IS NULL`, which is safe because
the only rows that can exist so far are live captures. The live job now
tags its own rows explicitly rather than relying on a default.

A consumer that needs within-season drift has to know which kind of row it
got, and the as-of lookup returns `source` alongside the values so it can.

## Rookies resolve null

A pitcher with no qualifying 2025 row gets no row here, so the as-of lookup
returns nothing and the consumer contributes **null** — the same convention
as the FRV term, where a missing fielder is null rather than an assertion
that he is exactly league-average. Contributing a zero or a league mean
would be a claim about a pitcher we have no data for.

## Runs as a backfill task, not a script

`POST /admin/backfill/pitcher_batted_ball_prior_season`, registered
alongside the weather loads. A script opens `data/mlb.db` and is a laptop
tool that never reaches production; the historical weather load is a
registered task for the same reason. Dry run reports the window, the
snapshot date, the source tag and how many rows already sit at that date;
the live run is replace-the-date, so a re-run is idempotent rather than
additive.

**Not executed here.** It needs the authenticated Member session and writes
to prod, so this PR ships the capability and the dry run only. The dry run
against the local copy reports `existing_rows_at_that_date: 0`.

Also still true from #390: **the live payload shape is unverified**. The
parser throws, naming the keys it found, rather than writing nulls — so the
first run of either job is the real test, and the `cron_log` row plus the
`awaitingFirstRun` freshness entry are how you find out.

## Verification

```
node scripts/test-pitcher-batted-ball.js     # 51 checks, exit 0
```

Sections 8 and 9 cover: the fixed window and the `2026-03-31` /
`prior_season` stamps; the task being reachable through the registry; the
`source` column present; the rolling default preserved when `start`/`end`
are absent; the live job tagging `live`; and the as-of behaviour across the
boundary — an April game resolving to the 2025 profile, a September game to
the live one, **between-pitcher variation present in April** (0.52 vs 0.33
GB%), **no within-season drift before the first live capture** (identical
value in April and August), a rookie resolving to nothing, and a
pre-stamp date resolving to nothing.

One of my own assertions needed fixing: it pinned the exact one-line
formatting of the `fetchActualSplit` call and broke when that call gained
the `start`/`end` passthrough — a failure that said nothing true. It now
asserts the arguments (`strType '3'`, `raw`, `'P'`) rather than the layout.
