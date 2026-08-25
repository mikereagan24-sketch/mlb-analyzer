# Tracing the corrupt moneylines to their source (2026-08-22)
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

> **It is not a sentinel. It is live in-game pricing polled after first
> pitch and treated as a pre-game market.**
>
> **761 of 761 corrupt-line events occurred at or after first pitch.
> Zero before.**
>
> Your hypothesis was right and it is worse than the guards suggest: the
> corrupt values are the extreme *tail of a continuum*, and the middle of
> that continuum lands squarely inside the plausible range where nothing
> catches it.

## Answers to the four questions

| question | answer |
|---|---|
| Which source / code path? | Live market prices reaching the ML path after the game starts. `isSaneML` (bound 1000) exists **only in `services/unabated.js`**; `services/kalshi.js` and `services/scraper.js` have **no magnitude bound at all** |
| One book / market type / time pattern? | **ML only** (279/279, zero totals). **Time pattern is absolute**: events only in hours 18:00–02:00, **zero in 03:00–17:00** |
| A sentinel we convert rather than reject? | **No.** `99900` *is* a documented Unabated "no active contract" sentinel — and that path is already guarded. The July–August population is different: **112 distinct values** forming a continuum from p=0.00106 to p=0.08993 |
| Did we discard a legitimate line? | **For the two April rows, yes.** For all 279 July–August cases, **no** — every one maps to a `game_log` row with a sane stored line, and **zero emittable signals were lost** |

## 1. It is not a sentinel — the values are a continuum

A sentinel repeats. These do not:

```
94400, 89373, 88237, 88039, 80672, 80053, 79452, 76306, 62105, 60579, ...
112 distinct values across 761 events
implied p:  min 0.00106   median 0.01067   max 0.08993
```

That is a smooth distribution of *small but varying* probabilities — a team at 0.1%, 1%, 5%, 9%. It is what a market looks like when one side is losing badly and the price is still moving. A null-to-number conversion bug would produce one value, or a handful.

**`99900` specifically IS a sentinel**, and it is already handled.
`services/unabated.js:216` names it:

> *"to reject the 99900 'no active contract' sentinel that Unabated
> sometimes returns when a book's side is delisted"*

That guard (`isSaneML`, `ML_MAX_ABS_PRICE = 1000`) was added **2026-04-24**
— the day after the only two corrupt rows ever persisted to `game_log`
(2026-04-22 and 2026-04-23). It worked: `game_log` has had no corrupt row
since. The July–August population is a **different failure with a
different cause.**

## 2. The time signature is absolute

Corrupt-line suppression events by hour of `created_at` (PT):

```
hh    corrupt   ordinary   corrupt%
00        90        586      13%
01        64        163      28%
02        14         18      44%
03-17      0       1881       0%     <-- not one, all day
18         5        381       1%
19        85        308      22%
20        94        271      26%
21       160        391      29%
22       212        508      29%
23        37        154      19%
```

Fifteen consecutive hours with zero corrupt events, then the entire
population inside the evening window. That is a game-clock signature, not
a feed-outage signature.

Comparing each event against the game's real first pitch confirms it:

```
corrupt-line   after first pitch: 761   before: 0     -> 100.0% after
ordinary       after first pitch: 2738  before: 1923  ->  58.7% after
```

Post-start audit activity is *normal* — closing lines, deactivations and
deletions all legitimately happen after a game starts, which is why the
ordinary rate is 59%. **What is not normal is 100% with zero exceptions.**

### A correction on how this was measured

My first pass reported the same 100% figure and it was **invalid**.
`game_log.game_time` is a display string (`"2:10 PM ET"`), not a
timestamp, so `slice(11,16)` returned `""` and every same-date event
compared as "after" against an empty string. That pass also produced a
"15–20% of all events are post-start" table which was equally
meaningless.

Redone by parsing `"H:MM AM/PM ET"` into minutes and converting ET→PT to
match `created_at` (PT, per `nowPtIso`). **The corrupt finding survived;
the 15–20% table did not** and is withdrawn — the real per-action figures
are in the corrected run above, and they are much higher because post-start
activity is normal.

## 3. The code path, and why the existing guard misses

`services/kalshi.js:44` documents this exact failure mode already:

> *"Kalshi keeps a market status='active' DURING the game, so without an
> explicit start-time check the client returns in-progress prices (a 4:05
> ET game appeared at 9:30 PT today with HOU-CHC **-9900** and SEA-KC
> -300 — those are live, not pre-game)."*

`-9900` is a $0.99 ask: the market saying 99%. Its complement is the
`+94400`-class number on the other side. **The failure is understood and
written down; the guard against it is `GAME_START_BUFFER_MIN`, and it
defaults to `0`.**

Zero means a game is excluded only from the *instant* its scheduled start
passes — no margin. Two ways that leaks:

- **Scheduled start ≠ actual first pitch.** Rain delays, TV holds and
  doubleheader shifts all move real first pitch later; a market can go
  live-ish before the scheduled time or stay pre-game well after it.
- **No slack for clock skew** between the feed's notion of start and ours.

And the magnitude bound that would catch the result is in the wrong file:

| module | has a magnitude bound? |
|---|---|
| `services/unabated.js` | **yes** — `isSaneML`, 1000 |
| `services/kalshi.js` | **no** |
| `services/scraper.js` | **no** |

`isSaneML` is applied at four sites, all inside `unabated.js`. Nothing
equivalent protects the Kalshi or Odds-API paths.

## 4. Did we lose a good bet? Almost — but no

This was the important question and the answer is reassuring, with one
real exception.

**The two April rows: yes, a legitimate line was discarded.** `lad-sf`,
2026-04-23:

```
proj_market_away_ml = -194     proj_market_home_ml =  186   <-- morning capture, perfectly sane
market_away_ml      = -150     market_home_ml      = 99900  <-- later capture, home side replaced
xcheck_away_ml      = -150     xcheck_home_ml      = 99900  <-- cross-check corrupted identically
odds_flagged        = 0
```

The morning capture held a valid `-194 / +186`. A later capture
overwrote the home side with the sentinel and **kept the sane away
side**, producing an incoherent pair with an implied sum of 0.601. It was
not flagged because the pair-sanity guard did not exist until July.
Today `checkMarketMLPairSanity` catches it twice over — on the sum band
and on the new magnitude ceiling.

**The 279 July–August cases: no loss.** Measured rather than assumed:

- All **279** map to a `game_log` row with a **sane** stored line
  (0 corrupt). The corruption was transient in the runtime path and never
  persisted, exactly as `signalsForGame` is designed to behave.
- Of **154** distinct (game, side) pairs suppressed, **91 emitted a real
  ML signal anyway** on a later refresh.
- The remaining **63** were checked against the sane stored line:
  **0 had an edge at or above the 1.00pp emit floor.** All 63 correctly
  produced no signal.

**So the guard cost us nothing.** It suppressed bets that either arrived
anyway at a correct price, or would never have qualified.

## 5. The part that actually matters — plausible-range contamination

You called this and it is the real finding.

The corrupt population is only the **tail** of the live-price
distribution — the cases extreme enough to trip a magnitude check. The
same mechanism, on a game that is merely 2–0 in the fourth, produces a
price like **−250**: completely plausible, passes `checkMarketMLPairSanity`,
passes the magnitude ceiling, passes the edge cap, and prices as a real
pre-game market.

**Those are invisible to every guard we have**, because every guard we
have tests *plausibility*, and a live price is perfectly plausible. It is
just wrong — it embeds information about a game already in progress.

Measured exposure:

```
signals INSERTED after first pitch : 134
  ... on games with odds_locked_at set : 124   (price frozen pre-start; safe)
  ... on games with NO lock            :  10   <-- genuine live-price exposure
still active in bet_signals today     :  63
```

Post-lock immutability is doing most of the work: once `odds_locked_at`
is set, `market_line` and `edge_pct` are frozen, so a post-start refresh
cannot rewrite the price a signal was created at. **The 10 unlocked
post-start inserts are the real hole** — small, but they are exactly the
case where a live price becomes a priced edge.

## Recommended fixes — none applied

Reported, not built, since this is the odds ingestion path and each is a
behaviour change.

1. **Set `GAME_START_BUFFER_MIN` above zero** (10–15 minutes). The
   cheapest fix, in the file that already documents the problem. Zero
   leaves no margin for delayed first pitch or clock skew.
2. **Move the magnitude bound somewhere shared.** `isSaneML` should not
   live only in `unabated.js`. `utils/market-sanity.js` now has
   `MAX_ABS_ML = 1000` — the same number, arrived at independently from
   the `game_log` distribution. **The two should be one constant**, used
   by Unabated, Kalshi and the Odds API alike. This is the sixth-copy
   problem in advance, and it is cheap to avoid now.
3. **Refuse any market write for a game past first pitch** unless it is
   an explicit closing-line capture. That is the fix that addresses
   plausible-range contamination rather than just the tail — a bound on
   magnitude can never catch a live −250.
4. **Use real first pitch, not scheduled.** `game_time` is a display
   string; a delayed game has no accurate start time in the DB at all.
   Item 3 cannot be implemented rigorously until there is a real
   timestamp to compare against.

Item 3 is the one that matters. Items 1 and 2 narrow the tail; only 3
addresses the population you identified — the live prices that look fine.

## Related

- `docs/cap-as-sanity-bound-2026-08-22.md` — the audit evidence that started this.
- `docs/odds-sanity-block-and-failopen-sweep-2026-08-22.md` — the magnitude ceiling.
- `services/kalshi.js:44` — the failure mode, documented before it was measured.
- `services/unabated.js:216` — the real sentinel, already guarded.
- `CLAUDE.md` §"Guard-removal rule" — why the backtest could not see any of this.
