# Cohort v8 birth certificate — venue-aware signal edges — 2026-07-07

## Cohort rule

**v8** = rows emitted when `SIGNAL_VENUE_AWARE_ENABLED` is on. Gated
by setting, not by game_date. Rows can be v8 even when
`game_date >= '2026-07-06'` would otherwise place them in v7. Default
OFF ships byte-identical to v7 — no v8 rows appear until the operator
flips the setting.

Assignment lives in `services/jobs.js:processGameSignals`:

```
cohort: _venueAware ? 'v8' : cohortForGameDate(gameRow.game_date),
```

## What changed vs v7

The signal engine evaluates edges against the **best net at-size
price across Poly + Kalshi** (`services/odds-comparison.js`
`runComparison` winner per side), replacing the v7 Kalshi-only market
baseline. Fee-adjusted, depth-walked. Bet-size default $100 to match
the existing comparison harness.

Guardrails:
- **Fillable-at-stake required.** A side is eligible only if
  `!partial` — the walk depleted the requested stake before
  exhausting the book. Partial books cannot supply the baseline;
  the signal falls back to Kalshi-direct with `venue_stale=1`.
- **Comparison unavailable → fallback + flag.** If runComparison
  fails or returns no row for a game_id (game not on Poly's slate,
  Kalshi orderbook fetch error, etc), the row falls back to
  Kalshi-direct and gets `venue_stale=1`. Rows in this state are
  still cohort v8 (owner's amendment call — "not silent") so the
  population is coherent for backtest segmentation.
- **Winning venue recorded.** `bet_signals.price_venue` carries
  `'poly'` | `'kalshi'` per emitted ML signal so CLV / closing-line
  audits can match against the entry venue. Totals don't set
  `price_venue` in this PR (over/under prices stay on the Kalshi-
  direct/xcheck fallback until Stage 2).

## Known follow-ups (not this PR)

- **CLV closing-line capture stays Kalshi-only.** The `closing_line`
  column captures the Kalshi ML at game start; comparing a Poly-
  anchored `bet_line` against a Kalshi `closing_line` mixes venues.
  Follow-up PR: capture per-venue closing prices and route CLV
  through `price_venue`. Owner accepted this scope decision as a
  known follow-up.
- **Totals venue-awareness.** `market_total` / `over_price` /
  `under_price` currently stay on the v7 Kalshi-direct path even
  when the toggle is on. Follow-up PR wires the totals-priced side.
- **Non-cron callers.** 9 of the 10 `processGameSignals` call sites
  do NOT pre-fetch the venue slate in this PR — only the primary
  lineup cron loop (`runLineupJob`) does. Other callers (reruns,
  backfills, manual triggers) currently emit v8 rows with
  `venue_stale=1` when the toggle is on. Follow-up PR threads the
  prefetch through the remaining callers.

## Backtest guidance

- Default backtest filter should include v8 alongside v7 during the
  post-flip window so operators can compare ROI head-to-head.
- Rows with `venue_stale=1` should be segmented out when measuring
  the actual venue-awareness contribution.

## Timing

Toggle default OFF at PR ship. Owner flips when comfortable.
Flipping ON produces v8 rows immediately; v7 rows already in DB
stay v7.
