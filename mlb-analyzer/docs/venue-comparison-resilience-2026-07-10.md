# Venue-comparison resilience — 2026-07-10

Two-part fix for the 07-10 morning incident.

## Part 1 — incident diagnosis

**Symptom (owner-reported):** all cards single-source fanduel, ODDS FLAG
firing, venue comparison unavailable slate-wide.

**Actual DB state on 07-10 (fresh pull):**
- All 15 active ML signals: `price_venue=NULL, venue_stale=1`, market_line
  matches `game_log.market_*_ml` — this is **tier-3 raw game_log capture**,
  the last-resort fallback in `refreshSignalBaselines`.
- Not fanduel: `game_log.ml_source='kalshi'` on all 15 games. Kalshi-direct
  override worked; unabated was replaced by Kalshi values in the primary
  odds capture path. But the value stored is Kalshi's **ask_ml** (raw
  top-of-book), NOT `net_american` (fee-adjusted at-size).
- 15 snapshots exist in `venue_comparison_snapshot` at
  `2026-07-10 17:54:11Z` (~10:54 AM PT). runComparison DID work at that
  moment. bet_signals were updated at `18:00:56Z` (6-7 min later) — the
  next odds-cron tail pass, when the 60s cache had expired.

**Root cause:** the next fresh `runComparison` call at 18:00:56Z failed
(likely Poly Gamma API rate-limit or transient error). `services/odds-
comparison.js:235` did `await poly.getPolymarketMlbLines(...)` without
a try/catch, so a Poly throw killed the whole function. Route caught
the throw and returned `rows: []`. refreshSignalBaselines saw
`cmpRow=null`, fell through tier-1 (no venue winner), tier-2 (no
Kalshi cmpRow either), landed on tier-3 raw game_log capture.

Kalshi was NEVER the problem (kalshi.js has 429 backoff). Poly's
missing try/catch was the load-bearing failure.

## Part 2 — resilience shipped

**One-number-pregame ruling** (owner, 2026-07-08) is preserved. The fix
adds a new tier-1 source: **the most recent `venue_comparison_snapshot`
if age ≤ `SNAPSHOT_FRESH_MAX_MS` (default 30 min)**. Semantically the
snapshot IS a venue-winner-net-at-size from a fresh runComparison; the
only difference from a live fetch is that the data is minutes old rather
than seconds old. Using it as tier-1 (venue_stale=0) preserves the
signal-baseline contract without a tier downgrade when the live fetch
is transiently down.

### `services/odds-comparison.js`

- `runComparison` — Poly fetch wrapped in try/catch (symmetric with
  Kalshi's existing try/catch). Partial success (one venue down) is
  now the default degradation instead of a full throw.
- New return fields: `poly_error` / `kalshi_error` (both null on
  success). Callers use these to decide fallback semantics.
- New `runComparisonCached(date, opts)` — shared 60s cache with
  **in-flight-promise dedup**. Consolidates the previously-independent
  route + jobs caches. Simultaneous callers with the same key wait on
  ONE upstream fetch instead of triggering N.

### `services/jobs.js`

- `_fetchVenueSlateCached` — thin adapter over `runComparisonCached`
  (its own Map cache removed; consolidated upstream).
- `refreshSignalBaselines` — snapshot-fallback tier interposed BEFORE
  tier-1 fallthrough. Fetches snapshot only when live `cmpRow` is null
  AND age ≤ `SNAPSHOT_FRESH_MAX_MS`. Marks `venue_stale=0` (venue-
  winner semantics preserved) with source='snapshot' in the audit
  detail JSON. New `stats.snapshotServed` counter.

### `routes/api.js` `/admin/odds-comparison`

- Route uses `runComparisonCached` — coalesces with jobs.
- `serve_source` marker added to every returned row:
  - `'live'` — fresh from runComparison this call
  - `'frozen'` — T-10 lock; snapshot served intentionally (existing)
  - `'stale'` — live fetch didn't cover this game_id (either failed or
    game didn't match); serving snapshot with `stale_reason` and
    `age_stale` markers
  - `'no_snapshot'` — no snapshot exists for this game today; UI
    renders "unavailable"
- Response `._serve_stats` gives operators a quick per-slate
  {live, frozen, stale, no_snapshot, persisted} breakdown.
- Total-failure catch path also serves from snapshot when possible
  (previously returned `rows:[]` unconditionally).

### `public/index.html` `renderPlayVenueFlags`

- New "🕘 as of HH:MM" marker for `serve_source='stale'` rows (distinct
  from the "🧊 frozen HH:MM" T-10 marker). Hover explains staleness
  reason.
- "unavailable" only renders when `serve_source='no_snapshot'` (no
  snapshot at all today). Transient fetch failures no longer produce
  the misleading "unavailable" text.

## Verification — 14/14 pass

`tmp/verify-snapshot-fallback.js` scenarios (real DB, scratch date):

```
Scenario A — live fetch returns full slate → tier-1 live
  ✓ market_line=190 (Poly winner)
  ✓ venue=poly, venue_stale=0, not from snapshot

Scenario B — live fetch failed, fresh snapshot (~6 min) → tier-1 snapshot
  ✓ market_line=184 (Poly winner from snapshot)
  ✓ venue=poly, venue_stale=0 (NOT downgraded)
  ✓ servedFromSnapshot flag set

Scenario C — live fetch empty, snapshot > 30 min old → tier-3
  ✓ falls back to game_log capture (180)
  ✓ venue=null, venue_stale=1
  ✓ snapshot rejected as too old

Scenario D — live fetch empty, no snapshot → tier-3
  ✓ game_log capture (180), venue_stale=1
```

Scenario B is the 07-10 incident. Under new logic: rows would have
stayed at venue_stale=0 with venue=poly, market_line=184 (the
17:54:11Z snapshot value) — no tier-3 downgrade.

## Self-heal answer for the 07-10 rows

Under this PR: YES, self-heals automatically on next successful cron.
Even if the fresh runComparison still fails, the tier-1 snapshot
fallback kicks in (as long as a snapshot ≤30 min exists) and rows
lift back to venue_stale=0 with the venue-winner net. No manual
rerun needed.

If the outage persists >30 min AND no fresh snapshot lands during
that window, the tier-1 snapshot path also expires and rows stay at
tier-3 raw capture until a live fetch succeeds again. That's the
same behavior as today for extended outages.

## Toggle defaults

- `SIGNAL_VENUE_AWARE_ENABLED` — no change, still ON.
- `SNAPSHOT_FRESH_MAX_MS` — new setting-shape (not stored in
  app_settings yet; hardcoded default `30 * 60 * 1000`). If future
  incidents make 30 min feel wrong, expose as a real setting. Left
  as code default for now to keep the PR bounded.

## Files

- `services/odds-comparison.js` — Poly try/catch + error surface +
  `runComparisonCached` + `_cmpCacheStats`.
- `services/jobs.js` — `_fetchVenueSlateCached` → adapter, remove
  duplicate cache; `refreshSignalBaselines` snapshot-tier + stats.
- `routes/api.js` — `/admin/odds-comparison`: `serve_source` marker,
  unlocked-snapshot-serve path, total-failure snapshot fallback,
  `_serve_stats`.
- `public/index.html` — "🕘 as of HH:MM" marker for stale-serve rows;
  "unavailable" reserved for no-snapshot state.
- `tmp/verify-snapshot-fallback.js` — 14-check isolated verification.
- `docs/venue-comparison-resilience-2026-07-10.md` — this file.

## Post-deploy verification

1. Boot, hit `/admin/odds-comparison?date=today` — response should
   include `_serve_stats: {live: N, frozen: 0, stale: 0, no_snapshot: 0}`
   with N = today's game count.
2. Artificially fail the live fetch (e.g. temporarily change Poly's
   URL to a 404 in dev). Reload — response should have `serve_source:
   'stale'` on rows that had snapshots, with `stale_reason: 'poly_failed'`.
   Cards render "🕘 as of HH:MM" not "unavailable".
3. Run odds cron. bet_signals rows should keep `venue_stale=0` and
   `price_venue` populated. Audit rows show `source: 'snapshot'`.
4. Query cache dedup: hit the route twice quickly. Second call should
   return in <5ms (in-flight-promise or cache hit).
