# Same-day lineup capture (2026-08-26)

> **Both pre-build checks came back, and one of them changes the job.**
>
> **(1) No horizon spread. The question is not recoverable.** 1,586 of
> 1,588 rows carrying `proj_lineup_captured_at` are next-day; **exactly 2
> are same-day**. Median lead 32.2h, p10 26.9h. Confirmed.
>
> **(2) The two URLs return materially different shapes** — three ways,
> one of which is a contamination risk that had to be handled before any
> capture was worth storing.
>
> **And the finding that reframes the build: same-day lineups have been
> fetched all season and thrown away.** `runLineupJob(todayStr())` fires
> nine times a day. Every one of those pulls is same-day. They never
> persisted because `game_log`'s projected snapshot is written through
> `COALESCE` and the 8PM PT tomorrow-slate prefetch always claims the slot
> first. **This was a storage problem, not a fetching problem.**
>
> **Separately — the baseline you quoted has moved.** See §6. Median model
> impact is **0.300 runs on the corrected corpus, not 0.130**.

## 1. Check one: does `proj_lineup_captured_at` spread across horizons?

No.

```
calendar days between capture (ET) and game_date
  d=+0        2      <- same-day
  d=+1     1586      <- next-day

lead before first pitch (1560 rows with a real first pitch)
  min 2.9h   p10 26.9h   median 32.2h   p90 35.2h
  under 12h:  2      under 18h:  2      under 24h: 28
```

The 28 under 24h are early-afternoon games captured the previous evening,
not same-day pulls. **Two rows is not a recoverable sample**, so the
same-day-vs-next-day question begins the day capture starts and not
before.

### Why, mechanically

`services/jobs.js` writes the projected snapshot as:

```sql
proj_lineup_captured_at = COALESCE(proj_lineup_captured_at, ?),
```

First non-empty write wins. The 8PM PT tomorrow-slate prefetch calls
`runLineupJob(tomorrow)`, which lands first. Every same-day pull the next
day — 8AM, noon through 6PM hourly, 11PM PT — is a no-op against those
columns.

**That COALESCE is correct and is left exactly as it is.** It is the
post-lock snapshot: the projection the model was actually scored on. The
fix is a second place to write, not a change to that one.

## 2. Check two: does the bare URL return a different shape?

Yes, three ways. Fetched live 2026-08-26 21:26 UTC (2:26PM PT):

```
                        SAME-DAY (bare)        NEXT-DAY (?date=tomorrow)
  html bytes                  572,864                     464,721
  .lineup.is-mlb blocks            16                           8
  confirmed / projected         15 / 1                      0 / 8
  status strings        "Confirmed Lineup"          "Expected Lineup"
                        "Expected Lineup"
  block class variants  ...has-started...            (no has-started)
```

**(a) `has-started`.** The same-day page marks in-progress games with a
`has-started` class. The next-day page has no such variant. This is the
one that mattered: **6 of 15 same-day blocks carried it** at 2:26PM PT.
A capture of a game already underway is not a forecast — it is a record of
what happened, the lineup equivalent of a post-first-pitch price. Left
unhandled it would have produced a "same-day is dramatically more
accurate" result that was partly measuring completed games.

Now extracted in `parseLineupsHtml` as `page_has_started`, stored on every
capture, and **excluded from the comparison with the count printed** —
excluded, not dropped silently, because dropping rows changes the coverage
denominator.

**(b) `lineup_status` already discriminates.** The parser has extracted
confirmed-vs-projected since May. Same-day is overwhelmingly `confirmed`;
next-day is 100% `projected`. No new parsing needed.

**(c) Slate size differs at a given hour.** 16 vs 8 blocks — tomorrow's
slate is not fully published mid-afternoon. That is a coverage difference
between horizons, not a bug, and it is why coverage is one of the metrics
rather than an assumption.

## 3. What was built

**`lineup_captures`** — the schema specced in
`docs/lineup-source-recon-2026-08-23.md` §5, keyed
`(game_date, game_id, source, horizon, capture_time, side)`, source-agnostic,
append-only. `source` is a column so a second provider slots in without a
migration; populated with one today.

**Horizon is stored, not inferred.** It is computed at fetch time from the
requested date against the America/New_York calendar date — the same
classification `fetchLineupsRaw` uses to choose the URL, so the stored
horizon and the page actually fetched cannot drift apart.

Deriving it later from `capture_time` vs `game_date` would be a guess, and
the test suite has the case that breaks it: **an 11PM PT same-day pull is
already the next calendar day in ET.** DST moves the boundary twice a
year. This repo has already paid once for a remembered filter instead of a
column — the park-factor regime — and this is the same shape.

**`lead_minutes` is stored alongside horizon, not instead of it.** Horizon
is which page was fetched; lead is how close to the start. A 6PM PT
same-day pull for a 4PM ET game has a *negative* lead. Both are needed and
they answer different questions.

**The anchor for that lead is `scheduled_start_utc`, not `first_pitch_utc`
— a defect in the first version of this, found and fixed the same day.**
See section 10.

Wired into `runLineupJob` after team normalisation and `game_id`
recomputation — capturing earlier would store pre-normalisation ids
(`OAK`/`WSH`, no doubleheader suffix) that no join could match. The call is
**non-fatal by construction**: a capture failure must never take down a
lineup pull, because the pull feeds pricing and the capture feeds an
analysis that does not exist yet.

**Registered in the freshness registry on day one**, before there is data
to be stale. Forward capture is the one thing here where a missed day is
*unrecoverable* — there is no backfill for what RotoWire said at 10AM on a
date that has passed. The `perRow` dimension is the important half: the
aggregate stays green as long as *some* horizon is landing, so next-day
capture alone would mask same-day silently stopping.

## 4. Timing

The existing grid was already better than "one 6AM pull": 8AM, noon–6PM
hourly, 11PM PT — nine same-day pulls spanning the whole confirmation
window.

**Added 10AM PT**, closing the one real hole. Nothing ran between 8AM and
noon PT (11AM–3PM ET), and early-afternoon ET starts have first pitch
inside that gap — those games were the only ones with no capture during
the hours their lineup actually firms up.

**The analysis does not bucket by clock hour.** Every capture stores
`lead_minutes`, and a 3PM PT pull is a 1-hour lead for a 7PM ET game and an
8-hour lead for a 10PM ET game. Lead is the meaningful axis; the clock is
an artifact of the cron.

## 5. The measurement

`scripts/lineup-horizon-compare.js` — same five metrics, per horizon,
recomputed rather than quoted:

- exact-slot, roster, handedness-as-composition, coverage;
- **model impact as the headline**, paired on the same game.

**The comparison is paired**, which is what makes it answerable at a few
hundred games rather than a few thousand: same game, both horizons, each
scored against the same confirmed lineup, so the day-to-day variance
cancels.

It reports nothing today, correctly, and prints its own distance instead.

## 6. A correction to the baseline in the brief

The brief quotes roster 85.5%, exact-slot 52.5%, median model impact 0.130
runs. Those are from `docs/lineup-accuracy-historical-2026-08-23.md`, which
was computed **before the corpus correction**. Re-run today on the same
date range (`≤ 2026-08-22`):

```
                        2026-08-23 doc     today       
  exact-slot                  52.5%        51.1%
  roster                      85.5%        85.3%
  median model impact         0.130        0.300 runs   <- 2.3x
  mean model impact             n/a        0.393 runs
```

Accuracy barely moved. **Model impact more than doubled**, and it is not
new games — restricting to `≤ 2026-08-22` gives 0.300 on 1,819 games. It
is the refreshed corpus re-scoring `proj_model_total` / `model_total`.

That matters beyond bookkeeping: the 08-23 doc closed with *"none of those
is urgent at a 0.13-run median impact."* **That conclusion does not
survive its own number.** At 0.300 runs median — with p75 0.560 and p90
0.870 — lineup error is a materially larger input error than it looked.
It raises the value of this capture rather than lowering it.

The 08-23 doc has been annotated, not rewritten.

### The deprioritization rested on a number that did not survive

Stated plainly, because it is the consequential part: **lineup work was
deprioritized on the 0.13-run figure, and that figure did not survive
corpus correction.** The 08-23 doc concluded *"none of those is urgent at
a 0.13-run median impact"*, and that sentence is the whole basis on which
this was set aside. On the corrected corpus the same statistic, over the
same date range, is **0.300 runs**.

Against the largest effect this project has measured — same statistic,
same units:

| | mean \|Δ model_total\| |
|---|---|
| park factors, ON vs OFF arm | **0.3025 runs** |
| park factors, stale → fresh switch (sensitivity) | **0.432 runs** |
| **lineup error, next-day projection vs confirmed** | **0.393 runs** |

The lineup median is 0.300, p75 0.560, p90 0.870 — reported alongside the
mean because the distribution is right-skewed and the mean alone would
overstate the typical game.

So lineup error is **the same order as park factors, and larger than the
ON/OFF arm**, measured the same way. Park factors got a sourced table, a
monthly cron, three guards and a regime column. Lineup accuracy got
shelved. The two decisions were made on numbers that differ by 2.3×, and
only one of those numbers was real.

**This is not a claim that same-day will turn out better.** That is the
open question and it is unmeasured. It is a claim about priority: the
input error is large enough to be worth measuring, and the reason it was
judged not to be has been withdrawn.
### The deprioritization rested on a number that did not survive

Stated plainly, because it is the consequential part: **lineup work was
deprioritized on the 0.13-run figure, and that figure did not survive
corpus correction.** The 08-23 doc concluded *"none of those is urgent at
a 0.13-run median impact"*, and that sentence is the whole basis on which
this was set aside. On the corrected corpus the same statistic, over the
same date range, is **0.300 runs**.

Against the largest effect this project has measured, on the same
statistic and in the same units:

| | mean |d model_total| |
|---|---|
| park factors, ON vs OFF arm | **0.3025 runs** |
| park factors, stale -> fresh switch (sensitivity) | **0.432 runs** |
| **lineup error, next-day projection vs confirmed** | **0.393 runs** |

Median for the lineup figure is 0.300, p75 0.560, p90 0.870 -- reported
alongside the mean because the distribution is right-skewed and a mean
alone would overstate the typical game.

So lineup error is **the same order as park factors and larger than the
ON/OFF arm**, measured the same way. The park-factor work got a sourced
table, a monthly cron, three guards and a regime column. Lineup accuracy
got shelved. The two decisions were made on numbers that differ by 2.3x,
and only one of those numbers was real.

**This is not a claim that the capture will show same-day is better.**
That is the open question and it is unmeasured. It is a claim about
priority: the input error is large enough to be worth measuring, and the
reason it was judged not to be has been withdrawn.


## 7. What n the model-impact comparison needs

Derived from observed dispersion rather than the ~150–200 estimate in the
recon doc, which that doc explicitly asked to have re-derived.

```
observed next-day |impact|: n=1859   median 0.290   mean 0.383   sd 0.3562 runs
date clustering: ICC 0.1477 over 139 dates (13.4 games/date) -> design effect 2.827

paired games needed, 80% power, alpha .05 two-sided, clustering included:

  detect a        rho=0.0    rho=0.5    rho=0.7
  0.15 runs           251        126         76
  0.10 runs           563        282        169    <- the headline target
  0.05 runs          2252       1126        676
```

`rho` is the same-game correlation between the two horizons and **cannot
be observed until both exist** — so it is bracketed, not guessed. The
0.10-run target is the headline because it is a third of the observed
next-day median, which is roughly the smallest improvement that could
change when to bet.

**Midpoint: ~282 paired games, about 22 full slates at both horizons.**

**No trigger date is set**, per the brief. The script prints its own
distance every time it runs, and re-derives the number from real `rho` the
moment paired games exist — at which point the bracket collapses to a
single figure and this estimate should be discarded.

## 8. What is not built

- **No second source.** `source` is a column and nothing populates it but
  `rotowire`. The three-way comparison remains blocked on access, as
  `docs/lineup-source-recon-2026-08-23.md` describes.
- **No backfill.** There is none to run.
- **`lead_minutes` will be NULL for most production captures** until the
  `first_pitch_utc` backfill runs there — it is populated on the analysis
  copy (1,569 rows) and largely absent in production (30 rows). This is
  why `page_has_started` exists as an independent in-progress signal: it
  comes from the page itself and needs no local backfill. Worth running
  that backfill in production; it is not a blocker.

## 9. Verification

```
node scripts/test-lineup-capture.js       38 passed, 0 failed
node scripts/pipeline-freshness.js        lineup_captures registered, CRITICAL (empty, correct)
node scripts/lineup-horizon-compare.js    reports 0 of ~282, no crash on empty
```

End-to-end against the live pages, into a scratch DB:

```
2026-08-26  horizon=same_day  games=15  rows=30  started_blocks=6
2026-08-27  horizon=next_day  games=7   rows=14  started_blocks=0

  next_day  projected  started=0  n=14  avg_slots=9.0
  same_day  confirmed  started=0  n=18  avg_slots=9.0
  same_day  confirmed  started=1  n=12  avg_slots=9.0
```

## 10. The anchor defect, and the two production items

### The defect

The first version of this computed `lead_minutes` from `first_pitch_utc`
alone. **First pitch does not exist until the game begins.** Verified
directly against statsapi on a scheduled game:

```
gamePk 822694, status Scheduled
  -> { scheduled_start_utc: '2026-08-27T17:05:00Z',
       first_pitch_utc: null,
       game_status: 'Scheduled' }
```

Every capture is pre-game by construction, so **every row would have
carried `lead_minutes = NULL`** — on exactly the rows the analysis is
built from. And no backfill could have repaired it: the value did not
exist at the moment the row describes. That is a different failure from
the sparse production coverage reported earlier, and the more serious one,
because it would have applied locally and in production alike while
looking healthy in every row count.

Fixed: `pickAnchor` prefers first pitch **when it exists** — a
rain-delayed game should measure against when play actually began, and
that is also what makes a post-start capture read negative — and falls
back to the scheduled start otherwise. Both timestamps and the anchor used
are stored, so the comparison script can recompute an exact post-hoc lead
while the stored one remains what a bettor could have known.

Verified end-to-end against the live slate: `no_anchor=0`, **0 of 30
captures with a NULL lead**, where the pre-fix code would have produced 30
of 30.

### (1) The anchor has to reach game_log before the capture reads it

`refreshFirstPitch` only ever ran for **yesterday**, inside the 4AM score
job — so today's slate had no scheduled start when the lineup crons fired.
`runLineupJob` now calls it with a new `onlyMissing` option before
capturing: one statsapi call per game on the first pull of the day, a
no-op on the other nine.

### (2) Production backfill, as a job rather than a script

`scripts/backfill-first-pitch.js` opens `data/mlb.db` directly, which
makes it a laptop tool; the rows that need it are on Render. Production
carries the anchor on **30 of ~1876** rows against 1,569 locally.

So it is now `runFirstPitchBackfillJob`, deliberately in the
**park-factor shape**: a boot-time establishing run
(`runFirstPitchBackfillIfMissing`, bounded to 400 rows, fire-and-forget so
four minutes of statsapi does not sit in front of a Render boot) plus a
3AM PT cron that finishes the rest. That table shipped with a monthly cron
and no bootstrap, came up empty, and priced every park neutral until
somebody looked — **a job that only maintains state needs a partner that
establishes it.**

Newest dates first, since recent slates are what the comparison pairs
against. Resumable by construction: the query selects only rows still
missing an anchor, so a partial run resumes exactly where it stopped.

### Confirming it in production

```
ADMIN_TOKEN=... node scripts/verify-capture-in-prod.js
```

A green deploy proves nothing about a scheduled job that has never fired.
This asks production over the admin API — the analysis copy is a
separately-evolved database and cannot answer a question about prod.
Three checks, each able to fail independently:

1. captures exist, at **both** horizons;
2. the **10AM PT hour specifically** produced rows — the new cron;
3. **`lead_minutes` populated on ≥90%** of captures, i.e. the anchor
   reached `game_log` before the capture read it.

(3) is the one most likely to fail quietly: captures would still land and
look healthy in every count while being useless for lead-bucketing.

Two whitelisted admin queries back it — `lineup-capture-health`
(per-horizon, per-PT-hour inventory with anchor coverage) and
`first-pitch-anchor-coverage` (the backfill's progress).

## Related

- `docs/lineup-source-recon-2026-08-23.md` — the schema spec this implements.
- `docs/lineup-accuracy-historical-2026-08-23.md` — the next-day baseline, annotated in §6.
- `docs/lineup-horizon-coverage-and-a-stale-pipeline-2026-08-24.md` — the horizon gap that started this.
