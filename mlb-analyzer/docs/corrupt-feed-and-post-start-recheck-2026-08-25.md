# The corrupt feed stopped. The hole it came through did not. (2026-08-25)

> **Nothing changed. Reporting first, as asked.**
>
> **Corrupt lines are not still arriving.** The ~10/day figure is
> historical. Four independent tables agree, including 56,564 market
> captures spanning 2026-06-11 to 2026-08-25 with **zero** implausible
> values. The last one anywhere is **2026-04-23**.
>
> **But the mechanism behind them is still open, and I was measuring the
> wrong half of it.** The guard added on 08-22 covers the path that
> *creates* signals. It does not cover the path that *refreshes* them —
> and **76% of signals since the fix carry a price written after real
> first pitch**, via `updated_at`, unchanged from July.
>
> **`processGameSignals` has no start check at all.** Zero mentions of
> `gameHasStarted` in it, and it is called from eight sites.

## 1. Are corrupt lines still arriving? No.

```
game_log, |market ML| > 1000            2 rows, both 2026-04-23
game_log, implied pair sum outside 0.90..1.20   2 of 1856, both 2026-04-23
kalshi_ml_markets_snapshot              927 rows, 0 implausible
                                        ask dollars 0.25..0.76, none <=0.02 or >=0.99
empirical_market_captures               56,564 rows, 2026-06-11..2026-08-25
                                        0 with any |ML| > 1000
                                        signaled_edge_pp max 0.265
```

The Kalshi snapshot is the one that would carry a no-liquidity marker if
one existed: ask prices span **$0.25–$0.76**, with **nothing at or below
$0.02 and nothing at or above $0.99**. No sentinel, no max-int, no
zero-price row being converted. Consistent with the earlier trace's
finding that the values were a smooth continuum rather than a repeating
marker.

### Why the ~10/day figure cannot be re-derived from current data

The traced values are **gone**. `market_line=94400`, `89373`, `80672`:
zero rows each.

`bet_signals.market_line` is **overwritten by the refresh path** — 7,075
`refresh` and 1,845 `refresh_odds_tail` audit rows since 2026-07-08 — and
`game_log.market_*_ml` is overwritten by the next odds pull. The corrupt
price survived only in whichever row happened to be read at the time.
**The 279 was measurable then and is not measurable now**, which is worth
knowing before anyone tries to reproduce it.

### And signal counts are the wrong instrument anyway

Signals at ≥25pp stop on **2026-05-19** — not because the feed cleaned up,
but because the 8pp hard cap started suppressing them (7,773
`suppressed_edge_cap` audit rows). A corrupt price after that date never
becomes a signal, so counting signals cannot see it. That is why the
measurement above uses `game_log`, the Kalshi snapshot and the capture
table instead.

## 2. The important question: is the hole closed? No.

`empirical_market_captures` is not overwritten, so it can answer this.

```
ALL signals on games with a real first_pitch_utc

  month     signals    CREATED after FP      UPDATED after FP
  2026-07      658     236 (35.9%)           462 (70.2%)
  2026-08      564      76 (13.5%)           435 (77.1%)

  since 08-22   50       5 (10.0%)            38 (76.0%)
```

**Creation is improving. Refresh is not.** 70.2% → 77.1% → 76.0% is flat
across the fix.

### The mechanism

The guard sits at `services/jobs.js:4014`, inside `runOddsJob`:

```js
if (existing && gameHasStarted(existing, dateStr)) {
  // skip writing prices to game_log
}
```

That stops **game_log** taking a live price. It does not stop
`processGameSignals` from re-running the model on a game row and upserting
`market_line` onto an **existing signal**. Grepped: **zero occurrences of
`gameHasStarted` anywhere in `processGameSignals`**, which is called from
eight sites including the 7AM rerun loop, the odds path, and
`POST /rerun`.

That is why the tagged games look the way they do:

```
261 signals on tagged games
   52  created after first pitch
  209  created BEFORE first pitch  <- the signal predates the game
  235  UPDATED after first pitch   <- the price was rewritten mid-game
```

The signal was emitted honestly before the game and then had its price
overwritten while the game was in progress.

### The seven post-fix tagged games, traced

All 7 games tagged on 08-22 and 08-23 show the same shape:

```
2026-08-23 laa-tex   fp=17:38Z   odds_locked_at=19:00Z
   captures 56  (51 before FP, 5 after)
   last before FP:  11:00:54 PT  a=134 h=-162
   first after FP:  12:52:43 PT  a=134 h=-162   <- IDENTICAL
```

**The price did not move in any of the seven.** `game_log` holds the same
number before and after. What differs is the price frozen on the *signal*,
which is what the tagging criterion compares against.

## 3. Two things I had wrong, corrected here

**The 15.6% / 284 figure is not comparable to anything above.** It was
computed on a different corpus (pre-refresh, 1678 games) with a different
criterion. On the corrected corpus the same script tags **219 games** and
finds **226 signals with a real price move** out of 252 exposed.

**Pre-July `created_at` cannot be read as an emit time.** April–June show
87%, 94% and 99.8% "created after first pitch", which would mean nearly
the whole June corpus was priced live. It is an artifact: **433 of ~454
June signals carry `created_at` at hour 01 PT** — a single nightly batch
window, matching the `auto_delete` / `set_closing_line` crons of that era.
Those rows were *rewritten* at 1AM, not emitted then. **Those three months
are excluded from the table above**, and any earlier statement resting on
them should be too.

## 4. What the tag actually means, which is narrower than its name

`market_contamination_reason = 'priced_post_first_pitch'` is assigned when
the **signal's stored `market_line` differs from the last capture before
first pitch**. That is not the same as "the signal was priced after first
pitch":

- a signal emitted at 8AM, with the market moving normally by the 3PM
  capture, differs from that last pre-FP capture and gets tagged;
- 209 of 261 signals on tagged games were **created before** first pitch.

So the tag is a superset. It is still pointing at something real — 235 of
those 261 were genuinely rewritten after first pitch — but the label
overstates what was measured, and a calibration excluding on it is
excluding more than post-start pricing.

## 5. Scope and caveats

- **The local copy is one day behind production** on `bet_signals`
  (08-24 vs 08-25). It is nonetheless the only place this is answerable:
  `first_pitch_utc` exists on **1,569 rows here and 30 in production**,
  because the backfill was never run there.
- **Two days is not a trend.** Post-fix is 50 signals over 08-22..08-24.
  The daily tagged-game rate ranged 20%–67% in the twelve days before, so
  the post-fix 23.3% sits inside the pre-fix spread. The `updated_at`
  finding does not depend on that, because 76% flat against 77% is not a
  change in either direction.
- **Nothing here was changed.** No guard added, no rows retagged.

## Recommended next step

The gap is one check in one function. `processGameSignals` should refuse
to overwrite `market_line` on a game that has started, the same way
`runOddsJob` refuses to write `game_log`. It should be a *refusal*, not a
flag — the price it would write is a live in-game price, which is the
thing the whole exercise is about.

Worth confirming first whether any consumer *depends* on the mid-game
refresh — closing-line capture writes through `writeClosing` on the
started-game branch, and that one is deliberate.

## Related

- `docs/corrupt-line-source-trace-2026-08-22.md` — the original trace.
- `docs/post-start-pricing-tagged-2026-08-22.md` — the tagging.
- `services/jobs.js:4014` — the guard that exists.
- `services/jobs.js:566` — `processGameSignals`, which has none.

---

# The trace, and the refusal (2026-08-25, later)

## (1) Which callers legitimately write after first pitch: none of them

All eight call sites of `processGameSignals` are **model-rescoring** paths:

```
jobs.js:2699   lineup ingest    -> rescore
jobs.js:3400   weather update   -> rescore
jobs.js:3670   7AM rerun loop
jobs.js:4139   odds job         -> rescore
jobs.js:5238   date rescore
jobs.js:5960   opener detection -> rescore
api.js:1302    POST /games/:date/rerun
```

**The closing-capture path is not among them.** It lives in `runOddsJob`'s
started-game branch and calls `writeClosing` directly, never entering
`processGameSignals`. So the distinction turned out to be neither
per-caller nor per-field — **no caller of this function needs a
post-first-pitch write at all**, and the legitimate one is on a separate
path already.

### Per-field would have been the answer if they shared a path

Your instinct was right about which fields, and the audit trail shows
exactly the set:

```
2026-07-08 22:21:08  refresh            {"market_line":{"from":100,"to":-104},"model_line":...
2026-07-09 03:00:13  refresh            {"market_line":{"from":-102,"to":-104},"edge_pct":...
2026-07-09 18:00:22  set_closing_line   odds locked at game start gate
2026-07-09 20:00:12  deactivated        Model ml at rerun: -139, mkt=-104 - edge no longer meets threshold
```

`market_line`, `model_line`, `edge_pct` on the refresh path; `closing_line`
and grading elsewhere. Since they do not share a path, **the refusal is
the whole upsert** — freezing `market_line` alone would leave `edge_pct`
and `category` derived from a price the row no longer carries, which is
internally inconsistent and worse than either consistent state.

**An unrelated pathology visible in that same trace:** `refresh` and
`refresh_odds_tail` oscillate between −102 and −104 dozens of times in a
single evening, each overwriting the other. Two sources disagreeing by one
cent, ping-ponging. Not touched here, but it is why the audit table has
8,848 pricing writes for ~2,000 signals.

## (2) `bet_locked_at` covers almost none of it

```
signals Jul-Aug on games with a real first pitch : 1222
  ever locked                                    :   32  (2.6%)

pricing writes (refresh / refresh_odds_tail)     : 8848
  after first pitch                              : 3532  (39.9%)
  of those, on a LOCKED signal                   :   67
```

The lock protects **the operator's logged bets**, not the emitted-signal
corpus that calibration reads — and 2.6% of signals are ever locked. It
was never going to cover this.

**A correction to my own first pass at this:** I initially read
`updated_at` and reported "18 locked signals updated after first pitch —
the lock did not hold." That was wrong. `updated_at` is bumped by *any*
write, including `deactivated`, `set_closing_line` and grading, all of
which are legitimate post-start. Measured on the audit trail instead — the
only instrument that distinguishes a *pricing* write — the lock does hold
on the pricing path.

## The refusal

`processGameSignals` now checks `gameHasStarted` before the signal loop
and returns, logging `refused_post_start_pricing` to the audit trail.

```
PRE-GAME      refusals 0 -> 0   proceeded
IN-PROGRESS   refusals 0 -> 1   refused
```

Verified against a real DB row put into an in-progress shape (scores
NULL, first pitch in the past) and restored afterwards — scores, first
pitch, status and audit rows all back to their prior values.

**Finished games never reach the guard**, and should not: they exit
earlier through the grading branch, which is where outcome and P&L are
written. A rescore of a completed slate produced 15 games, 0 errors, 0
refusals. The guard only fires in the live window between first pitch and
final, which is exactly the window the 3,532 writes were landing in.

