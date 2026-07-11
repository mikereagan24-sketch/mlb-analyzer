# Demote Unabated from betting path — 2026-07-10

Part 3 of the venue-comparison work (after PRs #166 + #167 landed).
Owner's ruling: **no bet_signals row must carry a market_line derived
from Unabated, and no Totals edge may ever price against a book the
bettor can't transact on.**

## Design

Unabated stays **connected** (raw JSON still fetched and captured in
`writeSnapshot('odds', ...)` for `/api/replay/odds`), and its parsed
values are still persisted in `game_log` — but only into columns
that are labeled reference-only in the UI. No signal-generation path
ever reads Unabated data.

### Data flow, pre and post

**Pre-#230:**
```
Unabated parse → market_*_ml / market_total / over_price / under_price / ml_source / total_source
                 (bettable columns; consumed by processGameSignals + refreshSignalBaselines)
              → xcheck_*_ml / xcheck_total / ... (Unabated's 2nd sportsbook, used by divergence flag)

Kalshi-direct override (gated on KALSHI_DIRECT_PRIMARY_ENABLED)
              → OVERWRITES market_*_ml when it covers the game
```

**Post-#230:**
```
Unabated parse → unabated_*_ml / unabated_total / unabated_ml_source (NEW columns; reference-only)
              → xcheck_*_ml / ... (Unabated's 2nd sportsbook, UNCHANGED — divergence flag still works)

Then all market_* fields are explicitly NULLED before Kalshi override runs.

Kalshi-direct override runs unconditionally (KALSHI_DIRECT_PRIMARY_ENABLED is
              the ONLY writer of market_*_ml / market_total post-#230)
              → market_*_ml + ml_source='kalshi' when Kalshi covers the game
              → market_total / over_price / under_price / total_source='kalshi'
                 when KALSHI_DIRECT_TOTALS_ENABLED covers it

Games neither Kalshi nor (future: Poly) covers: market_* stays NULL.
processGameSignals + refreshSignalBaselines interpret NULL market_line
as "no bettable baseline" → signal is suppressed.
```

**Baseline framing** (per owner's explicit correction on the scoping
message): market_*_ml = best-of {Kalshi, Poly}, NULL only when BOTH
absent. Poly integration lives in the venue-comparison layer already
(`services/odds-comparison.js` runComparison feeds
`bet_signals.market_line` via `refreshSignalBaselines` tier-1). This
PR completes the demotion; a follow-up will push Poly-only-covered
games' market_*_ml into game_log so the "game_log = Kalshi-only" gap
narrows.

## Files changed

### `db/schema.js`
- New idempotent ALTER TABLE migrations for 7 columns on `game_log`:
  `unabated_away_ml`, `unabated_home_ml`, `unabated_ml_source`,
  `unabated_total`, `unabated_over_price`, `unabated_under_price`,
  `unabated_total_source`.

### `services/jobs.js`
- **`runOddsJob` demotion block (new, ~line 3608)**: after
  `parseUnabatedOdds`, copy Unabated's `market_*` and source-tag fields
  into `o.unabated_*`, then NULL out `o.market_away_ml`, `.market_home_ml`,
  `.ml_source`, `.market_total`, `.over_price`, `.under_price`,
  `.total_source`. This makes the Kalshi override block the sole writer.
- **`Kalshi-direct totals override` (~line 4020-4110)**: anchor rung
  selection moved from `o.market_total` (was Unabated) to
  `o.unabated_total` (new reference column). When no reference exists
  or the rung gap is >0.5, use Kalshi's own auto-picked rung (`k.line`)
  instead of skipping — Kalshi's fair line IS the correct answer when
  there's no reference to agree with. `o.market_total` now WRITTEN
  from Kalshi's chosen strike (was: left on Unabated).
- **`processOddsArray` UPDATE stmt (~line 3499)**: extended with 7
  new `unabated_*` bind sites so processOddsArray persists them to
  `game_log`.
- **`refreshSignalBaselines` tier-3 removed (~line 1506)**: the
  `newMarket = row.market_away_ml || row.market_home_ml` fallthrough
  is deleted. Post-#230 that would either be Kalshi/Poly (redundant
  with tier-1/2) or NULL. Rows with no live venue + no fresh snapshot
  now stay at their prior baseline until the next successful cron —
  matches owner's "snapshot-fallback replaces raw fallthrough" ruling.

### `services/model.js`
- **`haveAnyTot` gate (~line 947)**: drops the OR-with-xcheck clause.
  Totals signal is now suppressed unless PRIMARY (Kalshi/Poly) totals
  exist. Games with Kalshi/Poly ML but no total emit ML only.
- **Totals edge-calc (~line 999)**: drops the xcheck fallback for
  `mktTotal`/`overPrice`/`underPrice`. Only PRIMARY feeds the edge —
  matches owner's ruling that a totals signal must never price
  against a book you can't bet.

### `public/index.html`
- **`fmtTotalsBlock` (~line 735)**: when primary is null, falls back
  to xcheck THEN unabated_*, tagged **`(ref)`** so the reader knows
  it's not a bettable line. Server-side signal suppression is the
  hard gate; the UI tag is defense-in-depth.

## Regression harness — `tmp/verify-demote-unabated.js`

6 scenarios, run via `node tmp/verify-demote-unabated.js`:

- **S1 Kalshi ML + Kalshi total** → BOTH ML and Totals signals emit ✓
- **S2 Kalshi ML only, no Kalshi/Poly total** → ML emits, Totals SUPPRESSED ✓ (owner-requested test)
- **S3 No Kalshi/Poly anywhere** → zero signals ✓
- **S4 Kalshi ML + Unabated-only total (xcheck)** → ML emits, Totals STILL SUPPRESSED ✓ (no leak)
- **S5 Live DB scan** → any active ML/Total with market_line non-null
  and price_venue NOT IN ('poly','kalshi') is flagged. Informational
  pre-deploy (pre-existing rows persist until first odds cron);
  should be 0 post-deploy after one cron pass.
- **S6 Schema check** → 7 unabated_* columns present ✓

## Post-deploy verification

1. Boot; migrations run (`unabated_*` columns present).
2. First 8/11/15/17 PT odds cron: `game_log.market_*` gets rewritten
   Kalshi-only where covered, NULL where not; `game_log.unabated_*`
   gets populated for every Unabated-covered game.
3. `processOddsArray` calls `processGameSignals` with the new game_log
   row. For Kalshi-covered games, ML + Totals signals emit as before.
   For Unabated-only games (rare), no signal emits — that's the ruling.
4. `refreshSignalBaselines` odds-tail refresh keeps
   `bet_signals.market_line` anchored to venue-net-at-size, unchanged
   from #167 behavior.
5. Re-run the S5 live check: `leaks.length === 0` for all UNLOCKED
   rows (locked rows keep their pre-deploy market_line by design).
6. Health check `venue_stale_stuck` (from PR #168) will surface any
   row that stays uncovered longer than 240 min — same monitor covers
   this scenario.

## Cohort note

No cohort bump. This is a data-cleanup change with no material impact
on ROI for games that DO get Kalshi coverage (which is the vast
majority of the slate on any given day). Unabated-only games would
lose their signals entirely; the operational answer to that gap is
Poly integration in a follow-up PR (already scoped by the "best-of
{Kalshi, Poly}" framing), not backing out this ruling.
