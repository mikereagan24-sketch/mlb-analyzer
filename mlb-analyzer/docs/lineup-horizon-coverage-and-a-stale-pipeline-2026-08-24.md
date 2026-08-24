# Horizon, source, coverage — and a pipeline that stopped 18 days ago (2026-08-24)

> **The coverage gap does not exist. Coverage on completed games since
> capture began is 100.00%.** My recommendation to pursue it was wrong.
>
> **All historical projections are next-day. There is no same-day capture
> at all** — which corrects yesterday's conclusion that forward capture is
> no longer a priority. It is, for the horizon that has never been captured.
>
> **And, found while checking: scores, pitcher logs, wOBA snapshots and
> market captures all stopped around 2026-08-06.** Signals are still
> emitting. That is the urgent item on this page.

## (1) Horizon — no split, and it is all next-day

```
lead time, capture -> first pitch (n=1357)
  p5 25.3h   p25 28.6h   median 32.2h   p75 33.5h   p90 35.2h   p95 35.7h

  <6h  (same-day, late)        2   0.1%
  6-18h (same-day, morning)    0   0.0%
  18-30h (next-day)          499  36.8%
  >30h  (earlier)            856  63.1%

capture hour (UTC): 14:00 -> 767 of 1375   (07:00 PT, one morning cron)
```

**Essentially zero same-day captures.** The mechanism is visible in the
code: `services/scraper.js:219` fetches
`rotowire.com/baseball/daily-lineups.php?date=tomorrow`, and the bare
same-day URL exists on the next line but is not what feeds the projection
snapshot.

### This corrects yesterday's conclusion

Yesterday I measured exact-slot 52.5%, roster 85.5%, model impact median
0.130 runs — and concluded forward capture was no longer time-critical.

**Those numbers are the next-day horizon specifically, which is the
worst case.** A lineup fetched ~32 hours out has had a full extra day to
change. Same-day projections would presumably be markedly more accurate,
and *that horizon has never been captured*.

So the original same-day-vs-next-day question is **not** answerable
historically — it is the one piece of the original brief that genuinely
requires forward capture. The correction matters: I said the urgency was
gone, and for this horizon it was never addressed.

## (2) Source — RotoWire, by code inspection, not by data

```
lineup_source:  auto 1643   manual 35
```

**`lineup_source` describes the CONFIRMED lineup, not the projection**, and
there is no per-row column recording where a projection came from. The
projection snapshot is written by `services/jobs.js:2217` inside
`updateLineup`, wrapped in `COALESCE` so the first non-empty projected
write wins.

The only lineup fetcher in the codebase is
`services/scraper.js:fetchLineupsRaw`, which is RotoWire-only. So the
projections are RotoWire — **established by reading the code, not by
anything in the data.** If a second source is ever added, a
`proj_lineup_source` column has to come with it or this becomes
unanswerable retroactively.

## (3) The coverage gap — it is not there

```
first game with a projected lineup : 2026-04-27
April misses BEFORE that date      : 284
April misses ON/AFTER              :   0

completed games since capture began : 1303
... missing a projection            :    0
coverage                            : 100.00%
```

The 18.1% decomposes entirely into:

- **284 games before 2026-04-27**, the day capture started — a startup
  artifact, not a failure;
- **15 games on 2026-08-12** that were never played (no score, no confirmed
  lineup, no model output, no signals — but they do have odds);
- 4 others.

**On completed games since capture began, not one is missing a projected
lineup.**

So the premise behind the question — *"a missing lineup is plausibly a
much larger error than a wrong one, and it's 18% of games"* — is false on
the second half. It is 0% of games. The first half remains untested and
now has almost no population to test it on, which is the right outcome.

**My recommendation that coverage was the item worth pursuing was wrong**,
and wrong in a way I could have caught yesterday by splitting the 18.1% by
month before recommending anything.

## (4) The thing that actually needs attention

Found while establishing that the August misses were an unplayed slate.

```
pipeline                     last data     vs today (2026-08-24)
game_log rows                2026-08-23    current
bet_signals                  2026-08-23    current
bet_signal_audit             2026-08-23    current
game_log SCORED              2026-08-06    18 DAYS STALE
pitcher_game_log             2026-08-06    18 DAYS STALE
woba_data_snapshot           2026-08-07    17 DAYS STALE
empirical_market_captures    2026-08-08    16 DAYS STALE
```

Dates 2026-08-09, 08-10, 08-11 and 08-13 through 08-22 have **no
`game_log` rows at all**. Only 45 rows exist across 08-07..08-22 where a
full schedule would be ~240.

**Signals are still being emitted while nothing grades them and the batter
inputs are seventeen days old.** `woba_data_snapshot` feeding the model at
17 days stale means every signal since ~08-07 was priced on batter data
from before that date.

This is the same shape as the ARI scraper — a job that stopped and nothing
reported its own silence. The gate-health and settings-sync checks added
this week cover feature gates and settings; **nothing watches ingest
freshness.**

I have not diagnosed the cause and have changed nothing. Two obvious
candidates, both unverified: the cron chain stopped running after
2026-08-06, or the score/schedule jobs are failing while the odds and
signal jobs continue.

**Recommended next step, and it is not lineup work:** find out why, then
add a freshness check to the morning chain that reports any pipeline whose
newest row is more than ~2 days behind the current date. That check would
have surfaced this on 2026-08-09.

## Related

- `docs/lineup-accuracy-historical-2026-08-23.md` — the accuracy numbers, now known to be next-day-only.
- `docs/lineup-source-recon-2026-08-23.md` — why the source comparison is blocked.
- `services/scraper.js:219` — the `?date=tomorrow` fetch that fixes the horizon.
