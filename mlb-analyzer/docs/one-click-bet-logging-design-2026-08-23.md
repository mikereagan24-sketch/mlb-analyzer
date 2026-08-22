# One-click bet logging + logged-bet tracking — design report (2026-08-23)

> **Design report. Nothing built.** Answers the four questions raised
> before implementation, and surfaces two decisions plus one blocker.

## Q1 — Does logging need a timestamp?

**No new column. It already exists and the day-before distinction is
already implemented.**

`bet_signals.bet_locked_at` is set to `datetime('now')` by both logging
paths, and is populated on all 312 rows that have a `bet_line`.

`services/clv-stats.js:timingBucket()` already classifies it:

```js
const gameDay = new Date(row.game_date + 'T12:00:00');
const hoursBefore = (gameDay.getTime() - locked.getTime()) / 3600000;
if (hoursBefore >= 18) return 'day_before';
return 'same_day';
```

18-hour threshold, deliberately tighter than "calendar day prior" so a
2am same-day lock reads as morning-of. `buildClvStats` already reports a
`byTiming` breakdown on it. **Part 2 should reuse `timingBucket()`
rather than reimplement the cut.**

## Q2 — Does the schema carry everything one-click needs?

**Almost. One gap, and it needs a decision.**

Present and sufficient: `signal_side`, `market_line`, `price_venue`,
`venue_stale`, `bet_line`, `bet_locked_at`, `closing_line`, `clv`,
`cohort`, `outcome`, `pnl`. All reach the card already — the games
payload uses `SELECT *` (`db/schema.js:2250`), so `g.signals[]` carries
the signal `id` and every field one-click needs.

**Missing: there is no stake column.** Nothing matching
`stake|amount|size|unit|risk` exists on `bet_signals`. P&L is computed
to-win-100, deriving stake from the price:

```js
const stake = ml > 0 ? 10000/ml : Math.abs(ml);
pnl = outcome === 'win' ? 100 : -stake;
```

So stake is currently **implicit and uniform**, not a stored quantity.

**Decision needed.** If "stake default" means every bet is one unit —
no column, nothing to do. If bets are ever sized differently and that
should show in ROI, it needs `bet_signals.stake REAL` plus a change to
the P&L math, which touches every historical row's comparability. Those
are very different amounts of work.

**Recommendation: no stake column.** Uniform staking keeps ROI
comparable across the whole history, and nothing downstream currently
reads a stake. Add it later if position sizing becomes real.

## Q3 — Which line should one-click default to?

**`bet_signals.market_line` on the signal row — it already *is* the
venue-best net price.**

`signal_venue_aware_enabled` is **`true` in prod**. Per
`services/settings-schema.js:273` that evaluates signal edges against
"the best net at-size price across Poly + Kalshi
(`services/odds-comparison.js`) with fillable-at-stake guard".

It is genuinely live — recent ML signals by venue:

| price_venue | n | mean abs line |
|---|---|---|
| poly | 270 | 139.6 |
| kalshi | 103 | 136.3 |
| null (stale fallback) | 112 | 128.5 |

And it is the right freshness. Per the post-lock immutability rule,
`market_line` is frozen once `odds_locked_at` **or** `bet_locked_at` is
set — but **before** either lock it refreshes on each odds pass
(`services/jobs.js:1676`). So on a pre-lineup card it is the live
venue-best net: exactly "the line I'd be getting at that moment."

**Use `sig.market_line`, and surface `sig.price_venue` and
`sig.venue_stale` next to the button.** `venue_stale=1` means no
fillable venue-best baseline was obtained and it fell back to
Kalshi-direct — the operator should see that before clicking, because
that is the case where the displayed line is least likely to be the fill.

## Q4 — Does the manual-log path break the emit-time snapshot columns?

**Yes. This is the real finding, and it decides the implementation.**

There are two logging paths and they behave very differently:

| | `POST /signals/:id/bet-line` | `POST /signals/manual` |
|---|---|---|
| targets | an existing signal row by id | a game, creates/upserts a row |
| writes | `bet_line`, `bet_locked_at`, `clv` | full row |
| on conflict | n/a | **overwrites `market_line`, `model_line`, `edge_pct`, `category`** |
| `*_at_emit` columns | untouched | **never written** |

Today's "Log Bet" button calls `openManualBetForGame()` →
`submitManualBet()` → **`POST /signals/manual`** — the row-creating
path.

Two consequences:

1. **It clobbers the emit-time baseline.** Its `ON CONFLICT` clause
   unconditionally sets `market_line`, `model_line`, `edge_pct` and
   `category` from *current* values. Logging a bet on a signal that
   already exists therefore overwrites the line the signal was emitted
   against with the line as of the click. The code comments this as
   deliberate ("manual log is authoritative for a locked bet"), but it
   is in direct tension with the post-lock immutability rule, which
   names `market_line` and `edge_pct` as frozen fields.
2. **It never populates `*_at_emit`.** Its INSERT column list omits
   `model_total_at_emit`, `opener_model_total_at_emit`,
   `model_home_ml_at_emit`, `model_away_ml_at_emit`. Only
   `q.upsertSignal` (the cron emit path) writes those.

**So one-click built on `/signals/manual` would make this strictly
worse** — the whole point is more logging, which means more clobbering.

**Recommendation: build one-click on `POST /signals/:id/bet-line`.** The
card already has `sig.id`. That endpoint touches only `bet_line`,
`bet_locked_at` and `clv`, all on the immutability whitelist, so it
cannot damage the emit-time baseline. It is also a much smaller change
than the modal path.

Keep `/signals/manual` for its actual purpose: logging a bet on a game
where **no signal was emitted**. That is the only case that legitimately
needs row creation.

## BLOCKER — `closing_line` is not always a closing line

Found while scoping Part 2's CLV view. `GET /api/backtest`
(`routes/api.js:1415`) performs a **write** on every request:

```sql
UPDATE bet_signals SET closing_line = market_line, clv = ...
WHERE closing_line IS NULL AND outcome != 'pending' AND market_line IS NOT NULL
```

It backfills `closing_line` **from `market_line`** whenever a resolved
signal lacks one. The effect on the CLV population:

| | n | mean CLV |
|---|---|---|
| `closing_line != market_line` (genuine capture) | 62 | **+2.218pp** |
| `closing_line == market_line` (consistent with backfill) | **211** | **+0.356pp** |
| all | 273 | +0.779pp |

**77% of the CLV rows have a `closing_line` equal to `market_line`.**
For a locked row `market_line` is frozen at lock time, so for those rows
CLV is not measuring *bet price vs closing price* — it is measuring
**bet price vs the card's line at lock time**. That is a real and useful
number ("did I beat the price the card showed me"), but it is a
different quantity from closing-line value, and the two are currently
averaged together.

**This qualifies the +0.779pp figure reported in
`docs/projected-state-calibration-and-clv-2026-08-23.md`.** The headline
number and its t-statistic stand as computed, but it is a blend of two
measurements, and the genuine-capture subset is ~6× larger (+2.218pp,
n=62). Both readings deserve to be reported separately, not pooled.

*(Note the vig arithmetic from that doc does not change its conclusion:
even +2.218pp on the genuine subset is close to the ~2.25pp per-side
vig, so it is around breakeven rather than clearly profitable — on
n=62.)*

**Decision needed before Part 2's CLV view is trustworthy.** Options:

- **(a) Segment.** Report CLV split by whether `closing_line` came from
  a genuine capture. Cheapest, no writes, honest. Needs a provenance
  flag — `clv-stats.js:detectClosingSource()` already does this
  per-pick against `empirical_market_captures` and the kalshi snapshot
  tables, so the logic exists.
- **(b) Stop the backfill** and leave `closing_line` NULL when no real
  close was captured. Cleanest semantics; shrinks the CLV population to
  ~62 rows.
- **(c) Add `closing_line_source`** and record provenance at write time.
  Most work, best long-term.

**Recommendation: (a) now, (c) later.** (b) is tempting but throws away
the beat-the-card number, which is genuinely informative about fills.

Separately: a `GET` that mutates is worth fixing on its own merits —
any dashboard refresh silently rewrites `closing_line` and `clv`.

## Proposed build, once the two decisions land

**Part 1 — one-click log**

1. Replace the per-game `Log Bet` button with a per-signal button
   rendered next to each signal row on the card.
2. Click → `POST /signals/:id/bet-line` with
   `bet_line = sig.market_line`. No modal.
3. Render the logged row inline showing the logged line, `price_venue`,
   and a `venue_stale` warning where set.
4. Click-again-to-adjust: the logged row becomes a small inline number
   input posting to the same endpoint (it already overwrites
   `bet_line`/`bet_locked_at` idempotently, and recomputes `clv`).
5. Keep the existing modal reachable for the no-signal-emitted case.

**Part 2 — logged-bet tracking**

1. `GET /api/backtest?mode=logged` — filter to `bet_line IS NOT NULL`.
2. Grade against `bet_line` rather than `market_line`. The recalc branch
   at `routes/api.js:5697` already does exactly this
   (`sig.bet_line || sig.market_line`), so the math exists.
3. Same breakdowns as today: ROI, by market, by band, by cohort.
4. CLV block for logged mode only: per-bet `bet_line` vs `closing_line`,
   aggregate CLV, win rate against both — **segmented by closing-line
   provenance** per the blocker above, and by `timingBucket()` so
   day-before vs same-day is visible, since that distinction is the
   point.

## Summary of what needs a decision

| # | question | recommendation |
|---|---|---|
| 1 | stake column? | **No** — uniform staking, add later if sizing becomes real |
| 2 | closing_line provenance | **Segment now (a)**, add `closing_line_source` later (c) |

Everything else is settled: timestamp exists, schema is otherwise
sufficient, default to `sig.market_line`, and build on
`/signals/:id/bet-line` rather than `/signals/manual`.

## Related

- `docs/projected-state-calibration-and-clv-2026-08-23.md` — the CLV figure qualified above.
- `docs/locked-bet-visibility-fix-2026-07-06.md` — prior manual-log cohort bug.
- `CLAUDE.md` — post-lock immutability rule.
- `services/clv-stats.js` — `timingBucket()`, `detectClosingSource()`.
- `services/odds-comparison.js` — venue-best net pricing.
