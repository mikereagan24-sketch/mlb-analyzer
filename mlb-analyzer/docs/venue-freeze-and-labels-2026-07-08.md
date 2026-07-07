# Venue-comparison pregame freeze + baseline labels — 2026-07-08

Two fixes shipped together:

1. **Freeze bug** — MIL@STL 2026-07-08 showed Poly **+496** on the venue
   flag mid-game while the odds-capture side correctly stayed frozen at
   Kalshi **+173**. Root cause: `services/odds-comparison.js runComparison`
   fetches Poly + Kalshi orderbooks live (its Kalshi fetch even passes
   `includeLive: true` explicitly) and has no awareness of
   `game_log.odds_locked_at` — the 10-min-before-first-pitch pregame
   freeze that the odds-capture path respects.

2. **Baseline labels** — the sig-row displays `market_line` as "mkt: XXX"
   without any indication of which venue supplied it or when it was
   captured. Under venue-aware ON, the number is often 3-10 points off
   from what the live venue-flag card shows for the same side, and that
   read as "error" when it was really emit-vs-live drift.

## Fix 1: pregame-freeze aware venue-comparison route

New table `venue_comparison_snapshot` (game_date, game_id, snapshot_at,
snapshot_json). Route `/admin/odds-comparison` split logic:

```
1. Query game_log for all games on the date with odds_locked_at != NULL.
2. Skip live fetch for locked game_ids; runComparison only prices the
   unlocked subset (respects any existing gameIds filter).
3. For each row returned by runComparison, INSERT OR REPLACE into
   venue_comparison_snapshot (INSERT OR REPLACE, so the latest pregame
   state per game persists).
4. For every locked in-scope game_id NOT covered by data.rows, load the
   last snapshot from venue_comparison_snapshot and inject it with
   { frozen: true, snapshot_at, locked_at }.
5. Locked games with no snapshot → { frozen: true, no_snapshot: true }
   sentinel so the UI renders "🧊 frozen — no pregame snapshot captured"
   honestly instead of falling through to "unavailable".
```

Effect on MIL@STL: after ship, when the odds cron sets
`odds_locked_at` at T-10min, the next `/admin/odds-comparison` call
serves the last pregame snapshot (locked in ~15 minutes earlier when
the page last refreshed at the top of the hour) marked frozen. The
Poly +496 live in-game odds never reach the UI.

### Why this wasn't caught in item 5 of the duplication brief

Item 5 of `docs/dedupe-regression-2026-07-07.md` explicitly deferred the
"live-odds leak into venue flags" fix: **"Owner flagged live in-game
odds (PHI-KC -426/+9601 mid-game) leaking into venue-flag/odds displays.
Distinct code path from the signal-lifecycle bug; wants a separate small
PR that suppresses venue-flag refresh once a game starts. Not addressed
in this PR per the owner's constraint (keep the dedupe fix bounded)."**

This PR is that separate small PR. It shipped 2026-07-08 rather than
immediately after the 2026-07-06 dedupe fix because the two-PR bullpen
sequence + venue-aware PR came first.

## Fix 2: baseline labels

Two label edits in `public/index.html`:

### Slate-card venue flag (renderPlayVenueFlags)

Adds "net" suffix so operators can distinguish net-at-size (fee +
depth-adjusted, what the model uses as baseline) from Poly/Kalshi's
top-of-book gross (still visible in the admin venue-comparison panel
via `(top +XXX, fee $Y)`). Adds "🧊 frozen HH:MM" trailing marker when
`row.frozen == true`, with hover explaining why the pregame snapshot
is being served instead of live.

Before:
```
▶ ATH ML: Poly +131 (Kalshi +129) — bet Poly
```

After (unlocked):
```
▶ ATH ML: Poly +131 net (Kalshi +129 net) — bet Poly
```

After (locked, snapshot available):
```
▶ ATH ML: Poly +131 net (Kalshi +129 net) — bet Poly 🧊 frozen 16:45
```

After (locked, no snapshot):
```
▶ ATH ML: 🧊 frozen — no pregame snapshot captured
```

### Sig-row "mkt" cell

Adds a compact venue tag + capture time suffix + hover title with full
provenance. Existing card shape preserved; only the "mkt: XXX" span
grows a small suffix.

Before (Kalshi-direct / venue-aware OFF):
```
mkt: +180
```

After (venue-aware OFF, cohort v7 pre-amendment):
```
mkt: +180
[hover: captured at signal emit 2026-07-07 18:06:01 — Kalshi-direct
        capture from game_log.market_*_ml (venue-aware off). Baseline
        the edge was scored against; live venue-comparison numbers on
        the card refresh every 60s and will drift.]
```

After (venue-aware ON, Poly winner):
```
mkt: +184 Ⓟ@11:06
[hover: captured at signal emit 2026-07-07 18:06:01 — Poly $100-fill
        net-at-size (fee + depth adjusted). Baseline the edge was
        scored against; live venue-comparison numbers on the card
        refresh every 60s and will drift.]
```

After (venue-aware ON, Kalshi winner):
```
mkt: -128 Ⓚ@11:06
```

After (venue-aware ON, venue_stale=1 fallback):
```
mkt: -122 Ⓚ⚠@11:06
[⚠ = fell back to Kalshi-direct because venue comparison was
     unavailable or the winner failed fillable-at-stake]
```

Sizing: mkt cell width goes 60px → 110px to accommodate the tag; other
row spans unchanged.

## Verification (`tmp/verify-freeze-fix.js` + `tmp/verify-venue-live.js`)

DB pull at 2026-07-07 13:52 PT (roughly 3 hours before MIL@STL's
16:45 PT first pitch), setting_value=`true` (flip already occurred):

**Flip took at the settings level:**
```
signal_venue_aware_enabled : true
```

**But no post-flip re-emit has happened yet in this snapshot:**
```
=== all 07-08 signals by cohort/venue ===
[ { cohort: 'v7', price_venue: null, venue_stale: 0, c: 11 } ]

CHC-BAL rows created_at = 2026-07-07 18:06:01  (pre-flip cron)
NYY-TB  — no signal fired today
```

Every existing 07-08 signal has `price_venue=NULL` — they were emitted
before the flip. The next lineup cron (runs ~every 15 min) will
re-emit against the venue-aware code path and start populating
`price_venue` per side.

**Emit-vs-live drift on the pre-flip signals** (illustrates why the
sig-row hover matters):

```
COL-LAD ML|away  stored=180  live Kalshi net=+181  live Poly net=+184
CLE-MIN ML|home  stored=-122 live Kalshi net=-126  live Poly net=-128
```

3-6 points of drift over ~2 hours between emit and DB pull. Under
venue-aware ON this drift will read on the card as `stored (Ⓟ@HH:MM)` vs
`live venue flag (fresh)` — same order of magnitude, but the label +
hover now makes it read as time, not error.

**Freeze plan simulation** (`tmp/verify-freeze-fix.js`):

```
LOCKED   (0 games): route serves snapshot
UNLOCKED (15 games): route fetches live + persists snapshot
```

Zero games are currently locked in the snapshot (all first pitches
are 3+ hours out). Once the odds cron sets `odds_locked_at` at
T-10min for the earliest games (tor-sf at 15:45 PT ET → 12:45 PT is
the earliest lock), the freeze fix kicks in and MIL@STL's future
in-game +496 is caught at the route level.

## Files

- `db/schema.js` — `venue_comparison_snapshot` table (both the main
  CREATE block and the runtime idempotent create).
- `routes/api.js` — `/admin/odds-comparison` route: split
  locked/unlocked, subset fetch, persist snapshot as byproduct,
  serve snapshot for locked. ~55 lines added.
- `public/index.html`:
  - `renderPlayVenueFlags` — "net" suffix + "🧊 frozen HH:MM" marker.
  - `_mktBaselineSuffix` + `_mktBaselineTitle` helpers.
  - sig-row `mkt` cell (ML + Totals) uses the helpers.
- `tmp/verify-freeze-fix.js` — locked/unlocked split simulation.
- `tmp/verify-venue-live.js` — updated for the flip; carries the
  emit-vs-live drift readout.
- `docs/venue-freeze-and-labels-2026-07-08.md` — this file.

## Post-deploy verification checklist

1. Boot: confirm `venue_comparison_snapshot` table created
   (no error on the runtime `CREATE TABLE IF NOT EXISTS`).
2. Load the games tab well before any locks (e.g. 3 PM PT): confirm
   the venue-flag card shows "Poly +131 net (Kalshi +129 net) — bet
   Poly" — the "net" suffix appears. Under the hood, snapshot rows
   are being persisted.
3. Wait for the first odds-lock (T-10min on the earliest game).
   Confirm that game_log.odds_locked_at is set, and reloading the
   games tab renders "🧊 frozen HH:MM" on that game's venue flag.
   The Poly/Kalshi numbers should be the pregame snapshot, not live.
4. `curl /admin/odds-comparison?date=2026-07-08 -H X-Admin-Token: ...`
   — response should contain `frozen: true` on locked games and no
   `frozen` field on unlocked games.
5. Post-flip signal re-emit: confirm at least one CHC-BAL or NYY-TB
   ML signal (or the next lineup cron's re-run of any 07-08 signal)
   carries `price_venue` populated and `venue_stale=0`. The sig-row
   should render `mkt: XXX Ⓟ@HH:MM` or `mkt: XXX Ⓚ@HH:MM`.
6. Hover over the sig-row mkt cell: confirm the tooltip text reads
   "captured at signal emit ... — Poly/Kalshi $100-fill net-at-size
   (fee + depth adjusted). Baseline the edge was scored against; live
   venue-comparison numbers on the card refresh every 60s and will
   drift."
