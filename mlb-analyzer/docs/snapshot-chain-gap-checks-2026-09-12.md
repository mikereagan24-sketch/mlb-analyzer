# Gap checks on the whole 6AM snapshot chain (2026-09-12)

#386 put a mid-era gap check on `woba_data_snapshot`. This declares it on
the other five per-date captures — the whole 6AM chain — and fixes a rule
in the original that would have made one of them useless.

## Why the chain needs it

All five are written by `_snapshotStep` in the 6AM cron, and every one is
looked up **by exact date** downstream. A last-arrival check cannot see a
missed day: the job recovers the next morning and the number is current
again.

**Founding instance 2026-09-03** — a whole-chain miss. All five tables plus
the 5:30 PT fg-woba job wrote nothing, on a day with 726 cron rows and no
restart signature. It was found **a week late** by diffing snapshot dates
against a calendar. Now every one of them names it:

```
fielding_frv_snapshot               2026-09-11      1      +1      ok
    GAPS INSIDE THE ERA: 2 date(s), 24 game(s) lost ...   (all historical, unrecoverable)
      2026-08-09  15 games
      2026-09-03   9 games
catcher_framing_snapshot            2026-09-11      1      +1      ok
    GAPS INSIDE THE ERA: 1 date(s), 9 game(s) lost ...
      2026-09-03   9 games
team_baserunning_snapshot                 ... 2026-09-03   9 games
player_baserunning_snapshot               ... 2026-09-03   9 games
player_baserunning_trailing_snapshot      ... 2026-09-03   9 games
```

**`fielding_frv_snapshot` carries a second, previously unrecorded gap:
2026-08-09**, 15 games. It is FRV-only — no other chain table missed that
day — so it is not a chain outage and has a different cause. Reported here;
not investigated.

## The rule that had to change first

Declaring #386's check as written on `catcher_framing_snapshot` would have
reported **81 missing dates**. The reason is not a broken job:

```
catcher_framing_snapshot:  2026-06-03   one capture, 58 rows
                           ...83-day desert...
                           2026-08-25 .. 2026-09-11   daily, missing only 2026-09-03
```

The table became a daily capture on 2026-08-25. #386 bounded the era by
`MIN..MAX` of the capture column, which is correct only when the first row
ever **is** the start of daily operation — true for `woba_data_snapshot`,
false here. Every one of those 81 dates is a day on which nothing was
expected, and a check that cries wolf 81 times is one nobody reads, which
is the precise failure this family of checks exists to avoid.

**The era now starts at the first capture whose next capture is within
`maxCadenceDays` (7).** Observable from the data, no remembered per-table
start date, and it self-corrects if a table's cadence changes.

```
table                                  MIN..MAX era    daily-regime era
catcher_framing_snapshot                 81 gaps            1 gap
woba_data_snapshot                        3 gaps            3 gaps   (unchanged)
```

The `woba` result is identical under both rules, so the change is
backward-compatible with what #386 shipped — and `woba_data_snapshot` now
uses the shared builder rather than its own inline copy. One builder, six
callers; the test asserts every gap query normalises to the same string, so
a seventh table cannot quietly arrive with its own spelling.

That assertion earned its place immediately: it caught `woba_data_snapshot`
still sitting on the old inline SQL after an edit of mine reported success
but aborted before writing the file.

## Levels

Unchanged from #386 and worth restating: **the level is driven by recent
gaps only** (7-day window), so the unrepairable history above leaves every
chain pipeline at `ok` and the run exits 0. The dates are printed anyway,
on every run, because an analysis spanning them should say so. A gap inside
the recent window raises STALE at one and CRITICAL at two — proven on a
synthetic in-memory DB that includes the lone-early-capture shape, so the
assertion does not depend on the calendar.

## Verification

```
node scripts/test-snapshot-chain-gaps.js         # 33 checks, exit 0
node scripts/test-weather-filter-and-gaps.js     # #386's suite, still passes
node scripts/pipeline-freshness.js               # 0 critical, 1 stale, 16 ok
```

The readout's key column was widened 28 → 36 characters;
`player_baserunning_trailing_snapshot` is 36 and had been colliding with
the date beside it.

## Not done here

- **2026-08-09 on `fielding_frv_snapshot`** — a real, previously unnoticed
  single-table gap. Cause unknown.
- **The 5:30 PT fg-woba job** missed 2026-09-03 too. It is a job, not a
  per-date table, so this hook does not cover it;
  `scripts/test-snapshot-chain-cron-log.js` is the thing that now makes
  such a miss visible in `cron_log`.
- **No backfill.** Every gap above is permanent. The only recovery on the
  table is the queued as-of fallback for `loadWobaSnapshot`, which would
  let a calibration run borrow the previous day's snapshot rather than drop
  the date — queued, pre-registration pending, and a paired design when it
  is measured.
