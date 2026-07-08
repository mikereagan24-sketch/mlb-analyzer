# UPSERT signal refresh — single-number-pregame baseline — 2026-07-08

Implements the owner's design ruling on 2026-07-08 that supersedes the
frozen-at-emit signal baseline. One market number applies pregame across
the signal engine's edge computation, the sig-row `mkt` cell, and the
venue-flag winner: **the venue-best fee-adjusted net-at-size** from
`services/odds-comparison.js`. Refreshed every odds pull and cron pass
while unlocked. Frozen at T-10 via the existing `odds_locked_at` rule.
Frozen permanently per-bet via `bet_locked_at`.

## What changes

### `bet_signals` schema

- New column `updated_at TEXT`. Advances on every UPSERT-refresh pass;
  distinct from `created_at` which stays pinned to the row's first
  emission.
- New `UNIQUE INDEX uq_bet_signals_key ON (game_date, game_id,
  signal_type, signal_side)`. Required for `ON CONFLICT DO UPDATE`.

### `db/schema.js` prepared statements

- `upsertSignal` — INSERT with ON CONFLICT DO UPDATE clause. UPDATE
  refreshes market_line, model_line, edge_pct, category, price_venue,
  venue_stale, edge_suspect, is_active=1, notes=NULL, updated_at.
  Preserves already-graded `outcome`/`pnl` via CASE guard.
  **WHERE `bet_signals.bet_locked_at IS NULL` guards the UPDATE** — the
  per-bet freeze is enforced at the SQL layer, not the caller.
- `deactivateSignal` — `UPDATE ... SET is_active=0, notes=?, updated_at
  = datetime('now')`. Applies to locked and unlocked alike (lock only
  freezes the baseline, not is_active). Locked rows keep bet_line /
  bet_locked_at / closing_line / clv intact.

### `services/jobs.js`

- `processGameSignals` refactor:
  - DELETE + INSERT + restore-locks + dedupe path REPLACED by
    snapshot-existing → `q.upsertSignal.run(...)` per current signal →
    `q.deactivateSignal.run(...)` per orphan.
  - Audit trail (`bet_signal_audit.action`):
    - `'insert'` on first sight (record baseline snapshot).
    - `'refresh'` when at least one tracked column changes.
    - `'deactivated'` on orphan drop.
    - Locked rows never audit refresh events (WHERE guard makes UPDATE
      a no-op; nothing to record).

- `refreshSignalBaselines(dateStr, settings, opts)` — new. Called from
  `runOddsJob`'s tail. Iterates every active unlocked ML bet_signals
  row on `dateStr` and rewrites `market_line + edge_pct + price_venue
  + venue_stale + updated_at` against the fresh venue comparison,
  WITHOUT rebuilding the model. Enforces:
  - **Staleness guard** (owner's Option A ruling). Skip games where
    `game_log.lineups_quality_at > bet_signals.updated_at` — the
    persisted stdModel snapshot is stale relative to the lineup that
    shipped after it. Refreshing edge from a stale model against fresh
    prices would produce a false-precision number. Skip; next full
    processGameSignals pass picks it up.
  - **Freeze**: skip games with `game_log.odds_locked_at` set.
  - **Locked-row protection**: WHERE `bet_locked_at IS NULL` on the
    UPDATE.
  - **Fallback tiers** (owner's tightened ruling):
    - tier 1 (`venue_stale=0`): venue winner's `net_american`
      (fillable, fee-adjusted).
    - tier 2 (`venue_stale=1`): Kalshi `net_american` (fillable,
      fee-adjusted) when tier 1 is unavailable OR venue-aware toggle
      is OFF.
    - tier 3 (`venue_stale=1`): raw `game_log.market_*_ml` Kalshi-
      direct capture. Last resort when Kalshi's book is not computable.
  - Skips write when nothing changed (avoids audit churn).
  - Non-fatal: any failure is logged; odds cron continues to succeed.

- `runOddsJob` tail: `await refreshSignalBaselines(dateStr, settings)`
  after odds persist. Log line `[odds-tail-refresh] ...` records
  refreshed / staleSkip / lockedGameSkip / lockedRowSkip / unchanged
  / noComparison counts per pass.

### `routes/api.js`

- `/signals/manual` INSERT rewritten as INSERT ... ON CONFLICT DO
  UPDATE so a manual bet log against a tuple that already emitted
  gracefully patches the lock/bet_line fields onto the existing row
  instead of exploding on the UNIQUE index. Audit `signal_id` resolved
  via unique-tuple SELECT so it's correct on both INSERT and UPDATE
  paths.

### `public/index.html`

- Sig-row `mkt` cell suffix + hover updated:
  - Suffix now shows freshness from `updated_at` (falls back to
    `created_at` for rows written before this PR). Adds 🔒 marker when
    `bet_locked_at` is set.
  - Hover title distinguishes "first emitted at" vs "last refreshed at"
    and explicitly notes the refresh cadence + freeze rules.

## Verification (`tmp/verify-upsert-refresh.js`)

15 checks against an isolated in-memory SQLite with the real prepared-
statement text — all pass:

```
Scenario A — idempotency + updated_at bumps
  ✓ market_line unchanged (180)
  ✓ created_at pinned to first insert
  ✓ updated_at advanced past created_at
  ✓ same row (no duplicate insert)

Scenario B — market drift refresh
  ✓ market_line advanced 180 → 184
  ✓ price_venue advanced poly → kalshi
  ✓ updated_at re-advanced

Scenario C — lock immunity
  ✓ locked row market_line FROZEN at 184 (WHERE guard)
  ✓ bet_line preserved
  ✓ bet_locked_at preserved
  ✓ updated_at also frozen (row untouched)

Scenario D — deactivate orphan
  ✓ inserted active
  ✓ deactivated (is_active=0)
  ✓ notes set
  ✓ market_line preserved through deactivate
  ✓ reactivated on next emit
  ✓ market_line advanced through reactivation
  ✓ notes cleared on refresh

Scenario E — unique-index enforcement
  ✓ naked INSERT rejected by UNIQUE index
```

## Convention chain (non-circular, three games on 2026-07-08 slate)

Documented in the previous PR's message. External anchor = venue
(stadium ownership). All three games (BOS-CWS at Rate Field, COL-LAD
at Dodger Stadium, NYY-TB at Tropicana) show:
game_log.away_team matches the team NOT at the stadium; Poly's
`event_title` lists away-first; Kalshi's ticker format lists away-
first; live Kalshi/Poly YES-market pricing lines up with model +
market direction. Convention is safe to bake into the unique index.

Owner spot-check on CLE @ MIN 7/8 confirmed sides + prices consistent
with the card.

## What did NOT change

- Cohort assignment stays via `cohortForGameDate(game_date)`. No v8.
- Totals baselines still route through the legacy `gl.market_total /
  over_price / under_price` path — the odds-cron tail refresh
  currently only touches ML rows. Totals venue-awareness is a
  documented follow-up.
- CLV closing-line capture stays Kalshi-direct (also a documented
  follow-up).
- Signal emission floor / edge cap unchanged.
- `insertSignal` prepared statement kept for backward compat (unused
  by processGameSignals now; still callable by any legacy caller —
  though under the UNIQUE index it will fail on duplicates rather than
  silently over-insert, which is the correct fail-loud behavior).

## Post-deploy checklist

1. Boot: confirm `uq_bet_signals_key` UNIQUE index created (log line
   from `_upsertRefreshMigration`). If it fails, dupes exist — run the
   2026-07-07 dedupe cleanup migration first.
2. Boot: confirm `updated_at` column present via `PRAGMA
   table_info(bet_signals)`.
3. Trigger a lineup cron. Confirm signals emit with `updated_at`
   populated and matching `created_at` on first sight.
4. Trigger an odds cron. Look for `[odds-tail-refresh] {date} → {...}`
   log line. Refreshed count should be > 0 if any market moved.
5. Verify audit trail: `SELECT action, COUNT(*) FROM bet_signal_audit
   WHERE game_date = today GROUP BY action` should show
   `insert`, `refresh`, `refresh_odds_tail`, and (if any orphans)
   `deactivated`.
6. Lock a bet manually (bet-line lock button). Trigger another cron
   pass. Confirm the locked row's `market_line` and `edge_pct` did
   NOT move (WHERE guard held).
7. Wait for a game to hit T-10min. Confirm subsequent odds crons show
   `lockedGameSkip` > 0 in the tail-refresh log for that game.

## Files

- `db/schema.js` — updated_at column ALTER, UNIQUE index migration,
  `upsertSignal` + `deactivateSignal` prepared statements.
- `services/jobs.js` — processGameSignals UPSERT refactor +
  `refreshSignalBaselines` helper + odds cron tail hook.
- `routes/api.js` — `/signals/manual` INSERT → UPSERT with conflict
  handling; audit signal_id resolution via unique tuple.
- `public/index.html` — sig-row `mkt` suffix + hover updated for
  updated_at semantics.
- `tmp/verify-upsert-refresh.js` — 15-check isolated verification.
- `docs/upsert-signal-refresh-2026-07-08.md` — this file.
