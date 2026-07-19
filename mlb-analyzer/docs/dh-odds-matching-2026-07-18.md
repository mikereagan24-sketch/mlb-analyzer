# Doubleheader odds-matching bug — findings 2026-07-18

## Summary

PIT@CLE 2026-07-18 doubleheader: Game 1 pulled Game 2's market odds, Game 2 pulled nothing. **Root cause is Polymarket-side** (with the same class of bug also present in the Odds-API fallback in `scraper.js`). Kalshi and Unabated are both DH-aware and correct. The DB schema, statsapi bootstrap, and RotoWire scraper are all DH-aware too — the break is purely at the odds-source parsers that produce a `game_id` without a `-g{N}` suffix, then get collapsed to one row on the way into `game_log`.

Historical evidence in the local DB (2026-07-11 MIL@PIT, DH day): same fingerprint — `mil-pit` got ML but no total, `mil-pit-g2` got total but no ML. Different columns to different rows, but the mechanism is the same: two odds records for the same team-pair, both keyed to the same `game_id`, second write partially overwrites first, no discriminator to keep them apart.

## Answers to the four questions

### (1) What key does the odds-matching use? Confirm non-unique for doubleheaders.

The join key is **`(game_date, game_id)`**. `game_log` has `UNIQUE(game_date, game_id)` (schema.js:150) so the DB itself is fine — as long as `game_id` carries the DH suffix.

Convention (documented in kalshi.js:190–199, unabated.js:302, schema.js migration comment): `{away}-{home}` for a single game, `{away}-{home}-g{N}` for game N > 1. This convention holds at the `game_log` layer — both the statsapi schedule bootstrap and the RotoWire scraper produce `-g{N}` correctly for legs 2+.

The break is that **two of the four odds sources feed the matcher a `game_id` string that never has the suffix, so both DH legs collapse to the base key `pit-cle`**. When the pipeline UPDATEs a row keyed by `(date, 'pit-cle')`, only game 1's `game_log` row is touched — game 2's row (`pit-cle-g2` in `game_log`) never gets those fields.

### (2) What discriminator is available? Does game_log already store it?

Three discriminators are stored on `game_log`:

- **`game_pk`** (`INTEGER`) — MLB's unique per-game ID from statsapi. Populated by the schedule bootstrap.
- **`game_number`** (`INTEGER DEFAULT 1`) — 1 for game 1, 2 for game 2. Populated by bootstrap. (Note: currently has a secondary bug — on the 2026-07-11 MIL@PIT `-g2` row, `game_number` was still `1` despite the correct `-g2` suffix on `game_id`. Doesn't affect the unique key, but the column value is out of sync with the id. Log this separately.)
- **`game_time`** (`TEXT`) — human-readable ET time (e.g. `"4:05 PM ET"`). Populated by bootstrap.

For the **odds-source side**, what's available per source:

| Source | Discriminator available in source data | Currently used? |
|---|---|---|
| Kalshi (direct primary) | Ticker suffix `G2` on nightcap markets | **✅ Yes** — extracted in `parseMarketTicker` (kalshi.js:158–164) |
| Unabated (fallback + xcheck) | `eventStart` timestamp per event | **✅ Yes** — 90-min gap cluster + leg-index suffix (unabated.js:296–348) |
| **Polymarket** (ML backup + totals primary) | `game_start_time_iso` captured on `sides` (polymarket.js:392) | **❌ No** — `buildGameId()` called without `gameNumber` (polymarket.js:681, 710); dedup collapses same-team-pair events by liquidity (polymarket.js:683–689), discarding the losing leg |
| **Odds API** (`scraper.js` fallback path) | `commence_time` on each event | **❌ No** — `game_id: (awayAbbr + '-' + homeAbbr).toLowerCase()` (scraper.js:526) |

Both broken sources have the timestamp needed to distinguish legs; they just aren't using it.

### (3) Fix design

Two changes, same shape as Unabated's existing pattern:

**A. `services/polymarket.js` — `getPolymarketMlbLines`:**

Replace the current "dedupe by team-pair, keep highest liquidity" pass with the same cluster-then-pick approach Unabated uses:

1. Group events by team-pair (base `{away}-{home}`).
2. Within each group, sort by `sides.game_start_time_iso` ascending.
3. Cluster consecutive events whose start times fall within `LEG_GAP_MS = 90*60*1000` — anything wider is a separate leg (matches Unabated's threshold and the "DH legs are never scheduled <90min apart" invariant).
4. Assign `gameNumber = clusterIndex + 1`.
5. Within each cluster, keep the highest-liquidity event (preserves the placeholder-vs-real filter already in place).
6. Call `buildGameId(away, home, gameNumber)` at both output sites (681, 710). `buildGameId` already supports the arg — the callers just don't pass it.

Also emit `game_number` on the output object so downstream consumers (and any future audit) see it, matching Unabated's shape.

**B. `services/scraper.js` — `parseOddsAPIResponse` around line 526:**

Same treatment. Odds-API events carry `commence_time`. Options:

1. **Self-contained cluster** (parallel to Unabated + Poly): 90-min gap on `commence_time` within team-pair, assign leg by index.
2. **Schedule-anchored lookup**: `runOddsJob` already fetches the statsapi schedule at line 3600 (`scheduleRows`). Pass it into `fetchOddsAPI` / `parseOddsAPIResponse` and look up gameNumber by matching (away, home, commence_time ± tolerance) against the schedule rows.

I'd go with **option 1 for symmetry** — three sources with the same pattern is easier to reason about than two flavors of DH handling. The 90-min invariant is already documented and enforced elsewhere.

**C. Sanity check to catch this class of bug going forward:**

Inside `runOddsJob` (jobs.js), after `processOddsArray` runs, add an assertion pass: for each `(date, base team-pair)` in `game_log` that has both a `-g{N}` row and a base row, if either row got a market write from a source whose input for that team-pair was a single object (i.e. no distinct `-g{N}` entry from that source), log a WARN so the coverage gap is loud rather than silent.

### (4) Backfill / re-pull today's PIT@CLE

**Two immutability constraints to respect** (CLAUDE.md post-lock rule):

1. Once `game_log.odds_locked_at IS NOT NULL` on a row, `market_*_ml` is immutable. Lock fires at T-10min before first pitch.
2. Once `bet_signals.bet_locked_at IS NOT NULL` on a linked signal, same fields are also immutable.

**Sequencing:**

1. Confirm current state on prod:
   - `SELECT game_id, game_time, game_number, odds_locked_at, market_away_ml, market_home_ml, market_total, ml_source, total_source FROM game_log WHERE game_date='2026-07-18' AND (away_team='PIT' OR home_team='PIT') ORDER BY game_id`.
   - `SELECT id, game_log_id, bet_locked_at FROM bet_signals WHERE game_date='2026-07-18' AND (game_id='pit-cle' OR game_id='cle-pit' OR game_id LIKE '%pit-cle-g2' OR game_id LIKE '%cle-pit-g2')`.
2. **If Game 1 (`pit-cle` or `cle-pit`) is already locked**: the wrong ML/total on that row is frozen. Nothing to do at the game_log layer — the closing_line / clv capture already happened against the frozen (wrong) value and is preserved. The user's real reference (the actual market at lock time) is unrecoverable from our side; only Game 2's fix is actionable.
3. **If Game 2 (`-g2`) row exists but has NULL market_\*_ml AND is not yet locked**: apply the Polymarket fix, run `runOddsJob('2026-07-18')`, and Game 2's row picks up the right odds on the next pass.
4. **If Game 2 row doesn't exist at all**: bootstrap issue, not an odds issue. Confirm the statsapi schedule bootstrap saw both legs (`SELECT COUNT(*) FROM game_log WHERE game_date='2026-07-18' AND game_id LIKE '%pit%cle%'` should be 2). If only 1, that's a separate escalation — statsapi should have both by now.
5. **If Game 1 not yet locked either**: run the fixed odds job; it should overwrite the wrongly-collapsed values and produce distinct entries.

Order: fix Polymarket → deploy → re-run odds job → verify both rows show distinct market lines from Polymarket → let the normal cron carry from there.

### Branch and testing

- Branch: `fix/dh-odds-poly-and-oddsapi`.
- Unit test at `tmp/verify-dh-odds-matching.js`: seed two events with same team-pair, different `commence_time` >90min apart, assert `buildGameId` outputs distinct `game_id`s and both survive dedup.
- Live verification: on the next cron after deploy, `SELECT ...` above should show `pit-cle` and `pit-cle-g2` with distinct `market_*_ml` and matching `ml_source='polymarket'`.

### Not touched by this PR (separately trackable)

- `game_number` column being `1` on `-g2` rows in the local DB (2026-07-11 MIL@PIT). If prod shows the same, add a small backfill (`UPDATE game_log SET game_number = 2 WHERE game_id LIKE '%-g2' AND game_number != 2`). Non-blocking — no code path currently reads `game_number` for the join.
