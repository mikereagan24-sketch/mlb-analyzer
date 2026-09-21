# Open question: kalshi_totals_markets_snapshot keeps one pass per PT day, not a history (2026-09-17)

**Status: RESOLVED 2026-09-21.** Nothing in production reads this table for
pricing; the cost was analytical.

Shipped in two parts, and the second is not the one this ticket proposed:

1. **The clear is now scoped to `(snapshot_date, game_date)`** on all three
   tables. That alone fixes the overwrite described below -- an evening pass
   for D+1 no longer deletes D's rows -- and it needed no key change, because
   the PK already carried `game_date`.

2. **Three new `kalshi_*_markets_log` tables**, keyed
   `(game_date, game_id, captured_at)` (spread adds `spread_team, spread_line`),
   never cleared, written in the same transaction as the snapshot.

The `*_snapshot` tables KEEP their shape and their writes, against this
ticket's "add the new table" wording but for the reason that wording
anticipated: `services/clv-stats.js`, `services/baserunning-backtest.js` and
`services/empirical-spread-roi.js` read them by the existing key. Re-keying in
place would have meant migrating three consumers, or inventing a `captured_at`
for rows whose pass time is not recoverable. Old rows stay exactly readable;
history starts at the deploy.

`captured_at` is PT (`nowPtIso()`) and is REQUIRED -- the helpers throw on a
missing or malformed value rather than defaulting, because a default would
silently re-collapse every pass onto one key.

Verified by `node scripts/test-kalshi-snapshot-per-pass.js`, which includes
this ticket's own acceptance check (§"If picked up" item 3): two passes on one
slate keep two observations with the line move visible, and an evening pass for
D+1 leaves D's rows intact.

## What it does now

`q.snapshotKalshiTotalsMarkets(snapshotDate, rows)` (db/schema.js) runs
`_snapKalshiTotalsClearDate` and then inserts the current pass's rows:

```
PRIMARY KEY (snapshot_date, game_date, game_id)
each call: DELETE WHERE snapshot_date = ?   then INSERT the rows of THIS pass
```

So the table holds **only the last Kalshi totals pass of each PT date** — and
that clear is not scoped to the slate being priced. The 8PM and 11PM PT passes
run for **tomorrow's** games, so the evening passes wipe the game-day rows and
replace them with next-day rows under the same `snapshot_date`.

## What it costs

Measured on the analysis copy, `game_date >= 2026-09-01`:

```
snapshot_date vs game_date:   day-before 172   same-day 10
```

Same-day Kalshi presence is **10 of 182 rows**. That is not Kalshi's
behaviour, it is the overwrite: whichever slate the last pass of the PT day
priced is the only one left.

Consequences already hit:

- The 14-day anchor-path analysis (2026-09-03..09-16) could not use this table
  to tell whether Kalshi had a line for a game at the pass where Poly priced
  it. It had to fall back to `kalshi_implied_total` (a boolean "ever listed")
  and `empirical_market_captures` (a line history with no source), which
  cannot order Kalshi's appearance against Poly's write.
- Anything asking "when did Kalshi's totals line move" gets one observation
  per day at best.

## What it should be

Key on the **pass**, not the date, and never clear another slate:

```
PRIMARY KEY (game_date, game_id, captured_at)      -- captured_at = pass time, PT
```

Plus, if the clear is kept at all, scope it to `(snapshot_date, game_date)` so
an evening pass for tomorrow cannot delete today's rows.

`kalshi_spread_markets_snapshot` and `kalshi_ml_markets_snapshot` need the same
check — they follow the same `snapshotDate`-keyed shape and were written from
the same convention.

## What it is not

- **Not a pricing defect.** No live path reads it. The Poly and Kalshi rung
  anchors read `game_log.kalshi_anchor_total` (2026-09-17), not this table.
- **Not recoverable.** A pass whose rows were overwritten is gone; Kalshi
  serves current state. Whatever history exists starts when the key changes.

## If picked up

1. Add the new table (or new columns) rather than mutating the existing one in
   place, so the old rows stay readable.
2. Retention: one row per (game, pass) over a season is ~15 games x ~8 passes
   x 180 days, order 20k rows. No pruning needed at that size.
3. The check that proves it works: after a full day, distinct `captured_at`
   per (game_date, game_id) should equal the number of Kalshi totals passes
   that priced that slate, and an evening pass for D+1 must leave D's rows
   intact.
