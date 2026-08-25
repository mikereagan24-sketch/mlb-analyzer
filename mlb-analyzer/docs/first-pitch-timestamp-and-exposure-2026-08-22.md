# Real first-pitch timestamps, and the exposure they make measurable (2026-08-22)
> ---
> **TWO FIGURES ON THIS PAGE ARE WITHDRAWN (2026-08-25).**
>
> **1. The 15.6% / 284-signal exposure is not comparable to anything
> measured since.** It was computed on the pre-refresh corpus (1,678
> games) with a criterion that has since changed. On the corrected corpus
> the same script tags **219 games** and finds **226 signals with a real
> price move out of 252 exposed**. Do not carry 15.6% forward.
>
> **2. Any claim resting on April-June `created_at` is withdrawn.**
> `bet_signals.created_at` in those months is NOT an emit time: **433 of
> ~454 June signals carry `created_at` at hour 01 PT**, a single nightly
> batch window matching the `auto_delete` / `set_closing_line` crons of
> that era. Rows were REWRITTEN at 1AM, not emitted then. Read as emit
> times they produce "87%, 94%, 99.8% of signals priced after first
> pitch", which is an artifact, not a finding. July onward is
> interpretable because `updated_at` exists and the hour distribution
> spreads across the cron schedule.
>
> Full re-measurement:
> `docs/corrupt-feed-and-post-start-recheck-2026-08-25.md`.
> ---

> **The number you asked for: 284 signals — 15.6% of the season — were
> priced against a post-first-pitch market that looked completely
> plausible. 178 of them are still active.**
>
> The 134 from the previous pass was what the display string could see.
> This is what the real timestamp sees.

## 1. The prerequisite: a real timestamp

### What statsapi provides

Verified against `pk=824804` (2026-08-06 laa-bal) before building anything:

```
gameData.datetime.dateTime    = 2026-08-06T16:35:00Z      scheduled
gameData.gameInfo.firstPitch  = 2026-08-06T16:36:00.000Z  ACTUAL
gameData.status.detailedState = Final
```

Corroborated independently by `liveData.plays.allPlays[0].about.startTime`
= `16:36:33Z`. `firstPitch` is on the **v1.1 `feed/live`** endpoint under
`gameData.gameInfo` — it is **not** on the v1 boxscore endpoint (checked:
`undefined`), which is worth recording because that is the obvious place
to look.

It is absent until a game actually begins, and it **reflects delays** —
which is the property that makes it correct.

### Three new columns, distinct from the display string

`game_log.game_time` is left untouched. It is what the UI renders, and
rewriting it would be a display change riding along with a data fix.

| column | source | meaning |
|---|---|---|
| `scheduled_start_utc` | `datetime.dateTime` | what the schedule says |
| `first_pitch_utc` | `gameInfo.firstPitch` | when the game actually started |
| `game_status` | `status.detailedState` | authority on live-right-now |

`services/first-pitch.js` owns fetching and the `hasStarted()` precedence:

1. `first_pitch_utc` — authoritative, reflects delays
2. `game_status` — covers the window after the ball is in play but before
   `firstPitch` has been written to our row
3. `scheduled_start_utc` + buffer — last resort

**It never falls back to `game_time`, and it returns `null` when nothing
usable is known** so callers can distinguish "not started" from "cannot
tell". A guard must treat `null` as unsafe, not as permission.

### Backfill

```
rows with game_pk: 1397
first_pitch_utc written : 1378
no firstPitch in feed   : 19
fetch errors            : 0
```

The 19 misses are **enumerated, not summarised** — a systematic gap would
bias every number below. All 19 are `status=Scheduled`: 15 are today's
slate and 4 are earlier games still showing Scheduled (postponements).
**No game that has actually been played is missing a first pitch.**

Note `game_pk` covers 1397 of 1678 `game_log` rows (83.3%), earliest
2026-04-26. April games before that date have no `game_pk` and cannot be
backfilled — which happens to exclude the two April corrupt rows from
this analysis, but those are separately understood.

### Staying fresh

`refreshFirstPitch(dateStr)` runs at the head of `runScoreJob`, before the
score parse, non-fatal. Idempotent by design: `firstPitch` does not exist
until a game begins and `status` changes all day, so re-running must
overwrite with fresher values.

## 2. The guard now uses it

`jobs.js:gameHasStarted()` already existed and already did the right
thing — on a started game it locks odds, **skips the price update**, and
captures closing lines. It was simply reading the display string.

It now prefers `hasStarted()` and falls through to the legacy parse only
when the real timestamp is unavailable. The call site is unchanged.

Precedence verified case-by-case:

```
real first pitch 3h ago              -> true
real first pitch later today         -> false
delayed but status "In Progress"     -> true
scheduled, not yet                   -> false
nothing known                        -> null   (caller falls through, does not assume safe)
```

## 3. Interim mitigation and the shared bound

**`GAME_START_BUFFER_MIN` 0 → 15** in `services/kalshi.js`.

Recorded in the comment as a *mitigation, not a fix*: it narrows the
window and cannot close it. A rain-delayed game sits "pre-game" for hours
after its scheduled start and a fixed buffer wrongly excludes it, while a
game starting early is still exposed. Only `first_pitch_utc` resolves
both.

**`isSaneML` now lives in `utils/market-sanity.js`** and is used by
`unabated.js`, `kalshi.js` and `scraper.js`.

`unabated.js` had `ML_MAX_ABS_PRICE = 1000` derived from Unabated's 99900
sentinel; `market-sanity.js` had `MAX_ABS_ML = 1000` derived independently
from the `game_log` distribution (real lines peak at 403; nothing exists
between 403 and 99900). **Two modules agreeing on 1000 by coincidence is
exactly how a sixth copy of a function gets written**, so there is now one
definition. `kalshi.js` and `scraper.js` previously had **no bound at
all**.

`scraper.js` also gains a real zero-check: `awayOut?.price || null` cannot
distinguish a price of `0` from an absent one.

## 4. The exposure — the number that was previously unmeasurable

```
audit events joined to a game with a real first pitch : 30493
  after real first pitch : 17404   before : 13089   (57.1% after)

price-affecting events after first pitch (insert/refresh/refresh_odds_tail):
  refresh            2080
  refresh_odds_tail   248
  insert              131
  TOTAL              2459

of those:
  line implausible -> CAUGHT by existing guards :     0
  line plausible   -> INVISIBLE to every guard  :  2453
  distinct games affected                       :   326

neutralised by post-lock immutability:
  odds_locked_at set BEFORE first pitch (safe)  :  1219
  NOT locked before first pitch -> REAL EXPOSURE:  1234
```

**Per signal, which is the denominator that means anything:**

```
bet_signals total: 1815   active: 1359
DISTINCT SIGNALS with post-start plausible pricing: 284  (15.6%)
  ... still active today: 178
```

**Zero of the 2459 post-start price events carried an implausible line.**
That is the whole point: the extreme cases never persist, so every guard
we have reports clean while 15.6% of the season carries prices captured
after the ball was in play.

Post-lock immutability is doing real work — it neutralises half the events
— but it is not a start-time guard and was never meant to be one.

### Two caveats, both real

- **This is an upper bound, not a count of mispriced bets.** An audit
  event after first pitch does not prove the price *changed*: `COALESCE`
  and the lock make many refreshes no-ops. What it proves is that 284
  signals had a price-affecting event on a market that was live at the
  time, with nothing checking.
- **57.1% of all audit events land after first pitch, and that is normal** —
  closing lines, deactivations and deletions legitimately happen then.
  The exposure figure counts only price-affecting actions on unlocked
  games.

### The timezone trap, again

`bet_signal_audit.created_at` is **PT**; `game_log.odds_locked_at` is
**UTC** (written by SQL `datetime('now')` at `jobs.js:3815`). They look
identical and are seven hours apart.

Determined empirically rather than assumed. `set_closing_line` can only
occur after a game ends, so:

```
created_at read as UTC : 369 after first pitch, 367 before   <- coin flip, wrong
created_at read as PT  : 727 after first pitch,   9 before   <- correct
```

The tell for `odds_locked_at` was that applying the PT shift produced
"0 signals locked before first pitch" — an impossible result that would
otherwise have inflated the exposure figure to 2453.

This is the third timestamp-comparison bug in this investigation. The
first two produced confident wrong answers before being caught. Anything
comparing two timestamps in this schema should state the zone of each in
a comment.

## 5. What is still not fixed

The corrupt lines are still arriving. These changes stop them reaching a
price, and now measure what was previously invisible — they do not stop
the feed emitting them.

The 178 still-active signals with post-start pricing have **not** been
invalidated or re-priced. Doing so is a data change on live signals and
is a separate decision.

## Related

- `docs/corrupt-line-source-trace-2026-08-22.md` — the trace that established the cause.
- `docs/cap-as-sanity-bound-2026-08-22.md` — the audit evidence.
- `CLAUDE.md` §"Guard-removal rule" — why the backtest could not see any of this.
- `services/first-pitch.js`, `scripts/backfill-first-pitch.js`, `scripts/post-start-exposure.js`.
