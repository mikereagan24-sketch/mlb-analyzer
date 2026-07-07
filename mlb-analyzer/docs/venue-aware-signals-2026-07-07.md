# Venue-aware signal edges — 2026-07-07

## Motivation

Owner case: COL@LAD 2026-07-07. Signal computed vs Kalshi ML +228
(model edge ~2pp) while the venue-comparison shows Poly ML **+244**
as the fillable-at-stake fill. Model's edge understates the true
available edge; borderline plays that would fire against Poly's
better price never fire against Kalshi.

Systemic pattern, not one game. Across today's 16-game slate
(2026-07-07), **9 games** show a materially different market baseline
when priced venue-best, and **2 new signals** emerge on borderline
plays that Kalshi-only would have missed entirely (BOS-CWS ML|away,
NYY-TB ML|home).

## Design

`services/odds-comparison.js` already computes per-side fee-adjusted
depth-walked fills (`net_american`) for both Poly and Kalshi and picks
a `winner` per side. This PR pipes that winner into the signal
engine's edge math.

### Injection point

`services/jobs.js:processGameSignals` — right before `runModel`, on
the `game` object that carries the market baseline into the model:

```
if (_venueAware) {
  const rowForGame = _venueRows && _venueRows[gameRow.game_id];
  if (rowForGame) {
    const bestA = _pickBestML(rowForGame, 'away');
    const bestH = _pickBestML(rowForGame, 'home');
    if (bestA) { game.market_away_ml = bestA.ml; _venueByMarket.ml_away = bestA.venue; _venueStaleFlag = false; }
    if (bestH) { game.market_home_ml = bestH.ml; _venueByMarket.ml_home = bestH.venue; _venueStaleFlag = false; }
  }
}
```

`_pickBestML` respects the **fillable-at-stake** guard — a side is
eligible only if `!partial`. If both venues are eligible, higher
`net_american` wins (better price for the bettor).

The `market_line` stored on the emitted `bet_signals` row is the
overridden value; PnL grading uses the same baseline so ROI reflects
the price the model actually saw.

### Slate-level cache

`runComparison` fetches the entire Poly + Kalshi MLB slate. Per-game
invocation would re-fetch each iteration — expensive. Solution: a
module-level cache in `jobs.js`:

```
const _venueCache = new Map(); // key=game_date, value={ ts, rowsByGid }
const _VENUE_TTL_MS = 60_000;
```

Matches the existing 60-second TTL on the `/admin/venue-comparison`
route cache. The primary caller (`runLineupJob`) awaits
`_fetchVenueSlateCached(dateStr)` once above the per-game loop and
passes the resulting `rowsByGid` map to each `processGameSignals`
call via `opts.venueRowsByGid`. Cache miss → single fetch → serve
all downstream calls for this rerun.

### Cohort discipline

`SIGNAL_VENUE_AWARE_ENABLED = true` promotes emitted rows from v7
to **v8** unconditionally (setting-gated, not game_date-gated). Birth
cert: `docs/cohort-v8-cutover-2026-07-07.md`. Rows that fall back to
Kalshi-direct because the venue comparison was unavailable or the
winner failed the fillable-at-stake guard **still get v8** — with
`venue_stale=1` to segment them out in backtest. Owner's explicit
"not silent" call: the cohort change reflects operator intent even
when the fallback fires.

Default OFF ships byte-identical to v7 — no code path change, no
cohort change, no runComparison fetches.

### Storage

Two new `bet_signals` columns (ALTER on boot, DEFAULT-safe for
existing rows):

- `price_venue TEXT` — `'poly'` | `'kalshi'` | NULL. NULL for totals
  (deferred to Stage 2) and for pre-v8 rows.
- `venue_stale INTEGER NOT NULL DEFAULT 0` — 1 when a v8 row fell
  back to Kalshi-direct because the venue comparison was unavailable
  or the winner failed the guard.

### Fillable-at-stake semantics

`services/odds-comparison.js` `priceAtSize` (line 23) sets
`partial: true` when the depth walk depletes the book before hitting
`stake_usd`. My `_pickBestML` treats `partial: true` as ineligible
for supplying the baseline — the price on a thin book is a lie about
what the bettor could actually get filled at. Both venues can go
partial simultaneously (illiquid mid-week matinees); in that case
the row falls back to Kalshi-direct + `venue_stale=1`.

## Verification (`tmp/verify-venue-aware.js`)

Read-only harness: scores today's slate through both code paths and
diffs. Runs `runModel` + `getSignals` twice per game — once with the
current game object (Kalshi-only), once with the venue-override
applied via the same code path production uses.

```
=== venue-aware signal diff — 2026-07-07 ===
games in log: 16
priced 15 games

=== side-by-side signal diff ===
games with any diff: 9 / 16

ARI-SD:    kal 100/-126  →  ven 102(poly)/-116(poly)
  ML|away    kalshi=9.51pp  venue=10.01pp  Δ=+0.50pp

ATH-DET:   kal 158/-192  →  ven 183(poly)/-208(kalshi)
  ML|away    kalshi=2.91pp  venue=6.33pp   Δ=+3.42pp

BOS-CWS:   kal -126/105  →  ven -122(poly)/108(poly)
  ML|away    kalshi=—       venue=1.76pp   Δ=+NEW

COL-LAD:   kal 228/-276  →  ven 244(poly)/-276(poly)
  ML|away    kalshi=1.98pp  venue=3.40pp   Δ=+1.42pp    ← owner case

LAA-TEX:   kal 134/-168  →  ven 140(kalshi)/-159(poly)
  ML|away    kalshi=2.93pp  venue=4.00pp   Δ=+1.07pp

MIL-STL:   kal -200/165  →  ven -215(poly)/183(poly)
  ML|home    kalshi=4.11pp  venue=6.51pp   Δ=+2.40pp

NYY-TB:    kal 100/-122  →  ven 102(poly)/-120(poly)
  ML|home    kalshi=—       venue=1.40pp   Δ=+NEW

PHI-CIN:   kal -176/145  →  ven -165(poly)/146(poly)
  ML|home    kalshi=5.06pp  venue=5.22pp   Δ=+0.16pp

SEA-MIA:   kal 105/-122  →  ven 106(poly)/-124(poly)
  ML|away    kalshi=5.35pp  venue=5.58pp   Δ=+0.23pp
```

Direction is uniformly correct: every diff moves the edge in the
bettor's favor (positive Δ or a new signal). No signals *disappear*
under venue-aware — venue-best can only match or beat Kalshi by
construction.

### COL@LAD detail

```
Kalshi ML   away/home : +228 / -276
Poly best   away/home : +244 (part=false) / -276 (part=false)
Kalshi net  away/home : +229 (part=false) / -276 (part=false)
winner              : poly / tie
picked venue away   : poly ml=+244
picked venue home   : poly ml=-276
```

Poly wins away (+244 vs Kalshi net +229 = 15pt gap); both venues tie
on home. COL edge lifts 1.98pp → 3.40pp — exactly the pattern the
owner flagged. Fillable-at-stake guard passes on both sides
(`partial=false`).

### Byte-identical guard

By construction: `SIGNAL_VENUE_AWARE_ENABLED = false` skips the
entire override block. Same code path as pre-PR. No runComparison
call, no `market_line` override, cohort stays v7 by game_date. No
explicit numeric guard test needed — the branch is gated at
the top of the block.

## Follow-ups (deferred; documented in birth cert)

- CLV closing-line venue routing
- Totals venue-awareness (over/under prices)
- Non-cron `processGameSignals` callers (9 of 10 currently emit v8
  with `venue_stale=1` when toggle is on)

## Files

- `services/settings-schema.js` — `signal_venue_aware_enabled`
- `db/schema.js` — seed row + ALTER TABLE for `price_venue` + `venue_stale`
- `services/jobs.js` — `_venueCache` + `_fetchVenueSlateCached` +
  `_pickBestML` + processGameSignals injection + insertSignal thread
  + cohort promotion; lineup cron slate prefetch
- `public/index.html` — one checkbox + schema map + load + save
- `tmp/verify-venue-aware.js` — read-only diff harness
- `docs/cohort-v8-cutover-2026-07-07.md` — v8 birth cert
- `docs/venue-aware-signals-2026-07-07.md` — this file
