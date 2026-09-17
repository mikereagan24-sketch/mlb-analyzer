# Unabated fetch removed (2026-09-17)

## What this is

PR 3 of the Unabated removal. The fetch, its parser (`services/unabated.js`),
the odds snapshot write, and the `stream-json` / `stream-chain` dependencies
are deleted. **The `unabated_*` and `xcheck_*` columns stay**, holding what was
captured before this date; nothing writes them now.

After the 2026-07-10 demote, nothing Unabated supplied was a betting-path
**price**. What it still carried was moved to surviving sources first:

| Unabated supplied | now | when |
|---|---|---|
| ML cross-check book (`xcheck_*_ml`, Poly on 97.0%) | direct Poly quote | #366 |
| Poly totals rung anchor (`unabated_total`) | Kalshi line, this pass or persisted | #365, #369 |
| runline columns (`market_*_spread`) | Kalshi 1.5 spread markets | **this change** |
| Kalshi totals rung anchor (`unabated_total`) | persisted Kalshi line, else auto rung | **this change, owner ruling** |
| totals sportsbook comparison (`xcheck_total`) | none; Poly arm logs NOFLAG | #367 |

## Gate

Met on the 2026-09-16 slate. phi-nym and det-cws were `priced=yes agree=yes`
via `liquidity_fallback`; ath-tb and sd-col were `kalshi_exact`.

## Runline: Kalshi's 1.5 markets

Each game has a "TEAM wins by more than 1.5" market per team: YES is TEAM
−1.5, NO is the opponent +1.5. The team whose market has the **higher YES
ask** lays −1.5.

`node scripts/measure-kalshi-runline-rule.js` runs the shipped function over
`kalshi_spread_markets` against what Unabated wrote, 2026-08-15..09-14:

```
416 games with a stored runline, 416 with a Kalshi ladder, 0 refused
side matches stored side: 405 / 416
   stored src kalshi       ladder 293/293   match 286
   stored src polymarket   ladder 119/119   match 115
   stored src fanduel      ladder   3/3     match   3
   stored src prophet      ladder   1/1     match   1
by |YES gap| between the two 1.5 markets:
   <0.02       37/45     coin flips
   0.02-0.05   73/74
   >=0.05     295/297
```

- **No coverage loss.** Kalshi had both teams' 1.5 markets for every game,
  including all **119** whose runline had come from Polymarket.
- **Tie rule.** Ties go to away (405). Ties to home gave 403, and "ML favourite
  lays −1.5" gave 362.
- **Values are now COALESCE'd.** `getKalshiMlbSpreads` drops a game 15
  minutes before first pitch, and the lock fires at T-10. Without COALESCE, a
  pass in that 5-minute window would NULL the runline just before
  `processGameSignals` snapshots it as the companion spread. `*_spread_quality`
  still drops to null on such a pass, so staleness stays visible.

## Kalshi totals rung: sticky on the persisted line

Kalshi's own totals write anchored on `unabated_total`: it priced the rung
matching Unabated's line, else its auto rung (over ask nearest $0.50). That
was not in the original PR 3 list and was found while removing the fetch.

Measured before choosing:

```
live, 2026-09-17 pre-game slate      auto rung == unabated_total on 7 / 7
30-day estimate, 2026-08-15..09-14   nearest half-run to kalshi_implied_total
                                     differs from unabated_total by one run on
                                     82 / 416 (70 of them Kalshi-priced)

   |implied - nearest whole run|   n    differ
   [0.0, 0.1)                      80     44
   [0.1, 0.2)                     104     28
   [0.2, 0.3)                      84     10
   [0.3, 0.5]                     148      0
```

The estimate is crude, because it ignores vig. It still says the auto rung
and the consensus line diverge **only where the fair total sits between two
rungs**. Auto-only would let such a game flip 7.5 ↔ 8.5 across passes, moving
the priced line and the spread-cell total axis (8.25 / 8.75).

**Ruling:** anchor on the line an earlier Kalshi pass persisted for the game
today (exact, else nearest within 0.5), else the auto rung. The first pass of
the day takes the auto rung; later passes hold it.

## Two guards that would have gone dark silently

Deleting the fetch as specified would have broken two things **without an
error**:

1. **ML cross-check.** `singleSource` keyed on `xcheck_ml_source`, which is
   now never written, so every row would read single-source and
   `checkBookDivergence` would never run. It now keys on the Poly quote. A
   Poly-primary row has no second book.
2. **Totals comparison.** The branch required `xcheck_total`, so the Poly
   comparison would never run and every priced total would be flagged
   single-source. It now keys on `poly_total`, excluding Poly-priced totals.
   It stays **observation only**; promoting it to a flag would be a new rule
   on a different book.

Also retired: health check 5 (`totals_xcheck`). It would have warned on every
game forever, and a warn-severity warn marks the slate "degraded".
`POST /api/replay/odds` is gone, since there are no odds snapshots to replay.

## Per-pass anchor count

```
[odds] pass summary <date>: updated N; poly totals by anchor: kalshi pass=a persisted=b
  liquidity_fallback=c; kalshi totals rung: persisted=d auto=e   *** c PRICED WITH NO KALSHI ANCHOR ***
```

The same bracket is appended to the odds `cron_log` message. That is the only
place a per-pass anchor count persists, because Render logs roll.

## Known gap, found by the slate test — FIXED 2026-09-17

The persisted-Kalshi anchor (#369) read `existing.total_source === 'kalshi'`.
When Poly priced a game from that persisted line it wrote
`total_source='polymarket'`, which **erased the marker**. On the next pass
with Kalshi still silent the anchor was gone and Poly fell to liquidity: in
the test, sea-ath flipped 9.5 → 8.5 on the second pass. Kalshi's own sticky
rung had the same defect, from the other side — once Poly owned the row it
fell back to the auto rung.

Fixed by `game_log.kalshi_anchor_total`: the Kalshi rung, written on every
Kalshi-priced pass, never cleared by another source, and read by **both**
anchors. `total_source` is no longer read for this. Existing rows are seeded
by migration `kalshi-anchor-total-backfill-001`. The test now asserts sea-ath
**holds 9.5 across three passes** and that pass 3 keeps Kalshi on the 8.5 rung
on a row Poly owned.

## Verification

```
node scripts/test-odds-job-no-unabated.js        31 checks: real runOddsJob, all fetch stubbed, temp DB, 0 network
node scripts/test-poly-anchor-fallback.js        OK
node scripts/test-poly-rung-anchor.js            OK
node scripts/test-book-divergence-poly.js        OK
node scripts/test-totals-divergence.js           OK
node scripts/test-dep-check.js                   OK
node scripts/measure-kalshi-runline-rule.js      405/416, 0 refused
```

`MLB_DB_PATH` (db/schema.js) exists so the slate test never opens
`data/mlb.db`. It is unset everywhere else.
