# Venue lazy-fetch + lineup-content staleness guard — 2026-07-10

Two coupled fixes for post-#166 symptoms owner spotted on today's slate.

## Fix 1 — ping-pong bug (processGameSignals venue lazy-fetch)

### Symptom

Post-#166 audit trail on `KC-BAL` (and CIN, CLE) showed rows alternating
between `venue_stale=0` (tier-1, via `refresh_odds_tail`) and
`venue_stale=1` (tier-3, via `process_game_signals_upsert`) on
consecutive cron cycles — market_line jittering between the venue
winner net and the raw game_log capture.

### Root cause

`processGameSignals` reads its venue data from `opts.venueRowsByGid`.
There are 6 callers:

- `runLineupJob` (line 2402) — prefetches slate-wide venue rows before
  the per-game loop ✓
- 5 others (lines 2957, 3118, 3416, 4111, 4833) — call
  `processGameSignals` without `opts`, so venue data is unavailable ✗

Those 5 paths write tier-3 unconditionally, so any pass that hits them
between two refreshSignalBaselines runs downgrades the row.
refreshSignalBaselines then re-upgrades it. Ping-pong.

### Fix

Rather than thread venue data through 5 call sites (fragile), make
`processGameSignals` lazily fetch venue data itself when `opts` is
missing. Same tier discipline as `refreshSignalBaselines`:

1. `opts.venueRowsByGid` (fast path, runLineupJob)
2. `peekCachedRowsByGid(dateStr)` — synchronous peek of the
   `runComparisonCached` 60s shared cache (matches refresh cadence)
3. `_loadFreshSnapshotForGid(game_date, game_id)` — most-recent
   snapshot ≤30 min old (matches #166's snapshot tier-1 rule)
4. Fall through to Kalshi-direct with `venue_stale=1`

All 5 callers now get tier-1 through the same discipline
`refreshSignalBaselines` uses. No ping-pong.

### Files

- `services/odds-comparison.js` — new `peekCachedRowsByGid(date, opts)`
  synchronous cache-peek helper (returns null on miss, expiry, or
  in-flight — sync callers should fall back rather than await).
- `services/jobs.js` — new shared `_loadFreshSnapshotForGid(gd, gid,
  maxAgeMs)` helper used by both processGameSignals AND
  refreshSignalBaselines; `processGameSignals` venue-override block
  extended with the 3-tier fallback chain; `_venueRows` promoted from
  const → let so the lazy-fetch can populate it in-place.

## Fix 2 — stuck-rows bug (staleness guard uses content hash, not timestamp)

### Symptom

Fresh 07-10 DB pull, 5 games (NYY-WAS, CLE-MIA, others) with
`updated_at='2026-07-09 17:41:39'` — bet_signals rows untouched for
~24 hours. Same game_log rows had `lineups_quality_at` from earlier
today (RotoWire had touched them). Result: today's market_line stuck
on yesterday's price, tier-3 tier-3 tier-3.

### Root cause

`refreshSignalBaselines` staleness guard read:

```js
if (row.lineups_quality_at && rowStamp && row.lineups_quality_at > rowStamp) {
  stats.staleSkip++;
  continue;
}
```

Rationale: don't rewrite market_line/edge_pct if a fresh lineup is
about to trigger a model re-run (which would rewrite everything from
processGameSignals anyway). Avoids churn.

Failure mode: `lineups_quality_at` bumps on **every** RotoWire pull,
not just when the lineup CONTENT actually changes. RotoWire re-serving
an identical projected lineup was tripping the guard and freezing
rows that had no meaningful update pending.

### Fix

Replace timestamp comparison with lineup-CONTENT hash comparison.

- New `_computeLineupHash(gl)` helper — sha1(away_lineup_json |
  home_lineup_json | away_lineup_status | home_lineup_status).
  Nulls collapse to empty strings so the hash is stable
  pre-lineup-population.
- New `lineup_hash TEXT` column on `bet_signals` (via `ALTER TABLE`
  migration in schema.js). Populated at UPSERT time from the current
  game_log row.
- refreshSignalBaselines guard rewritten:

```js
const currentLineupHash = _computeLineupHash({...gl fields from row...});
if (row.lineup_hash && currentLineupHash && row.lineup_hash !== currentLineupHash) {
  stats.staleSkip++;
  continue;
}
```

- Fail-open on `row.lineup_hash === NULL` (rows from before this PR):
  refresh, don't skip. Only cost is one pass of an edge_pct computed
  against slightly-stale model_line — not a tier downgrade, no lock
  contamination, self-corrects on next processGameSignals pass.

### Files

- `db/schema.js` — `_lineupHashMigration` idempotent ALTER TABLE;
  `upsertSignal` prepared statement extended with `@lineup_hash`
  (both INSERT + ON CONFLICT DO UPDATE SET paths).
- `services/jobs.js` — `_computeLineupHash` helper; UPSERT call site
  passes `lineup_hash: _lineupHash`; refresh SELECT extended with
  game_log lineup fields + bs.lineup_hash; guard rewritten as above.

## Verification — `tmp/verify-lazy-fetch-and-content-guard.js`

### Part A — 4 scenarios

- **A1** `opts` prefetched (runLineupJob path) → tier-1 live, venue=poly
- **A2** `opts` absent, cache warm (odds-cron path) → tier-1 live, venue=poly
- **A3** `opts` absent, cache cold, fresh snapshot → tier-1 snapshot,
  venue=poly, `venue_stale=0` (was tier-3 before this PR)
- **A4** `opts` absent, cache cold, snapshot expired → tier-3 fallback,
  `venue_stale=1`

### Part B — 4 scenarios

- **B1** Identical lineup content, `lineups_quality_at` bumped (RotoWire
  re-served) → REFRESH (was skipped before this PR — the 07-10 stuck-
  rows bug)
- **B2** Lineup content changed (batter added) → SKIP correctly
- **B3** Lineup status projected → confirmed → SKIP (status is material)
- **B4** `row.lineup_hash IS NULL` (pre-migration row) → REFRESH
  (fail-open)

## Self-heal for the 5 stuck rows

Under this PR: **YES, self-heals on deploy + first cron pass**.

- NYY-WAS et al. rows have `lineup_hash IS NULL` (pre-migration).
- refreshSignalBaselines fail-opens on NULL hash, refreshes market_line
  to the current venue winner net.
- On the next processGameSignals pass, `lineup_hash` is populated to
  the current game_log hash. Subsequent refreshes then use the strict
  hash-comparison path.

No manual rerun needed.

## Related

- Precedes task #230 (Part 3 — demote Unabated feed out of betting
  path entirely; remove tier-3 raw-capture fallback). Once #230 lands,
  the "fail through to game_log market_*_ml" arms in
  refreshSignalBaselines + processGameSignals are removed.
