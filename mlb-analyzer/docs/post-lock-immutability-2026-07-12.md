# Post-lock immutability guard — 2026-07-12

Owner-approved fix for a pre-existing bug going back to April 2026:
`processGameSignals` was rewriting `bet_signals.market_line` (and
`edge_pct`, `price_venue`, `venue_stale`) on games where the market
had already been frozen at T-10 (`odds_locked_at IS NOT NULL`).

## The corruption

Owner spotted a LAA-MIN row with `market_line=+253` while the live
Kalshi price was +134 — a 119-point phantom. A DB scan found
**34 corrupted rows since 2026-04** (4/12/1/17 by month), all with
the same pattern: `|market_line - closing_line| ≥ 30`, all with
`odds_locked_at` set at the time of the corrupted write.

`closing_line` was clean on every corrupted row — captured by
`cron_closing_lock` at odds_locked_at time from the frozen pre-lock
`game_log.market_*_ml`. So the bettor's true reference was preserved;
only the tracked "current market" number moved.

## Root cause

`processGameSignals` → `upsertSignal` guarded on
`WHERE bet_signals.bet_locked_at IS NULL` — the per-bet lock — but
NOT on `game_log.odds_locked_at` — the T-10 game-level lock.
`processOddsArray` correctly skips locked games' `game_log.market_*_ml`
writes (jobs.js:3441). But any of the 6 callers of `processGameSignals`
that fired after `odds_locked_at` was set would re-read the frozen
`game_log` price AND then run the venue-override block against LIVE
`runComparisonCached` data. In-play Poly/Kalshi books have thin ladders;
a $100 stake walks past top-of-book to avg_price ≈ 0.22, producing
`net_american=+355` for a game whose real pre-lock line was +113.
The UPSERT then stomped `market_line` with the in-play value.

This directly violated the owner's PR #164/#228 ruling: **"one market
number pregame, frozen at T-10"** — the ruling was correctly enforced
for `bet_locked_at` (the manual bet-log lock) but never wired to the
`odds_locked_at` (the T-10 market-freeze).

## Fix

`services/jobs.js:1007` — one line added right after the graded-game
guard:

```js
if (gl.odds_locked_at && gl.away_score == null) return;
```

Post-lock, pre-final: `processGameSignals` returns without touching
`bet_signals`. All other flows still work:

- **`closing_line` + `clv`** — captured by `cron_closing_lock` at
  odds_locked_at time (one-time write). Unaffected.
- **`outcome` + `pnl`** — computed by the graded-game branch above,
  which fires when `gl.away_score IS NOT NULL`. Unaffected.
- **`companion_spread_*`** — graded in the same graded-game branch.
  Unaffected.
- **Empirical-spread + market-capture grading** — piggy-backs on the
  graded-game branch. Unaffected.

## Historical rows

**Not repaired.** Owner ruling from the corruption discussion: the 34
corrupted rows stay flagged. Backtests grade against `closing_line`
(which is clean), so ROI/CLV/calibration numbers are honest without
touching the historical `market_line` values. The corrupted rows are
identifiable by `|market_line - closing_line| >= 30`; the midyear
review's cohort-hygiene filter lists them in
`docs/data/midyear-corrupted-rows.tsv`.

## Verification

`tmp/verify-post-lock-immutability.js` — 3 scenarios, all pass:

- **S1** pre-lock (`odds_locked_at IS NULL`) → writes flow normally
  (baseline behavior preserved)
- **S2** post-lock, pre-final (`odds_locked_at SET`, `away_score IS NULL`)
  → NONE of market_line, edge_pct, price_venue, venue_stale, model_line,
  category, signal_label, is_active move even when the caller passes
  a bogus `venueRowsByGid` that would have stomped market_line to +355
  under the old code
- **S3** post-lock, post-final (`away_score SET`) → graded-game branch
  still runs; outcome and pnl computed correctly; market_line still
  frozen

## Files

- `services/jobs.js` — one-line guard at line 1007 with a full comment
  block explaining the ruling and the corruption pattern
- `tmp/verify-post-lock-immutability.js` — 3-scenario harness
- `docs/post-lock-immutability-2026-07-12.md` — this file
- `CLAUDE.md` — new "Post-lock immutability rule" section under the
  demotion-pre-flight rule

## Related

- PR #164 / #228 established the "one number pregame, freeze at T-10"
  ruling — this fix finally enforces the odds-freeze half
- PR #167 fixed the ping-pong bug (a related but distinct symptom of
  the same over-write pattern, pre-lock)
- PR #169 demoted Unabated — the post-#171 corruption owner spotted
  was NOT that PR's cause; the same corruption was happening back to
  April, just quieter
