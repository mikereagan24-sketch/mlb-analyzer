# The outage that was not: a stale analysis copy, and the check that now says so (2026-08-24)

> **There was no outage. Production has been healthy the whole time —
> complete, fully scored, current to the hour.** The "18-day-stale
> pipeline" I reported yesterday was the *local analysis copy* of the
> database, not the system that produces it.
>
> **Blast radius is zero.** No signal was priced on stale wOBA in
> production, and the eight that were priced on stale wOBA locally were
> never real and were never logged as bets.
>
> **What did break is worse than a dead cron, and it is mine.** I measured
> for a full day against a corpus that ended 2026-08-06, then blamed the
> wrong system for it — and the local copy turns out not to be a stale
> subset of production but a *divergent* database that disagrees with it
> about `model_total` on 95% of shared games.

## What I got wrong, stated plainly

Yesterday I reported that scores, pitcher logs, wOBA snapshots and market
captures "all stopped around 2026-08-06", that "signals are still being
emitted while nothing grades them", and that every signal since ~08-07 was
"priced on batter data from before that date".

Every one of those statements is false about production. They were true
statements about a file on this laptop, and I presented them as facts
about the system.

The evidence I used — `MAX(game_date)` per table — was correct for the
file being read and **says nothing whatsoever about the health of the
thing that produced it.** That is the whole error, and it is not subtle.

## (1) Which jobs ran, which stopped

Production, from `/health` at 2026-08-24 16:22 UTC:

```
status                     ok
odds_coverage 2026-08-24   scheduled 10   ml_priced 10   totals_priced 10
woba_freshness             8/8 keys present, all uploaded 2026-08-24 15:28, age 0.9h
park_map_gaps              none
```

Production `game_log` across the window I called an outage:

```
2026-08-07  15 games  15 scored     2026-08-16  15 games  15 scored
2026-08-08  15        15            2026-08-17  11        11
2026-08-09  15        15            2026-08-18  15        15
2026-08-10  10        10            2026-08-19  15        15
2026-08-11  15        15            2026-08-20   9         9
2026-08-12  15        15            2026-08-21  15        15
2026-08-13   9         9            2026-08-22  15        15
2026-08-14  14        14            2026-08-23  15        15
2026-08-15  15        15            2026-08-24  10         0  <- today, correct
```

**Not one missing date. Not one ungraded game.** The dates I reported as
having "no `game_log` rows at all" — 08-09, 08-10, 08-11, 08-13 through
08-22 — are all present and scored.

### What the local `cron_log` actually shows

The cron chain lives inside the Express process (`node-cron`, registered
at `services/jobs.js:3525`, called once from `server.js:320`). **No node
process is running on this machine.** No server, no cron.

The local `cron_log` tail is unambiguous:

```
2026-08-07 15:00:00  lineups  error  getaddrinfo ENOTFOUND www.rotowire.com   x6
2026-08-07 15:00:18  weather  error  updated 0, skipped 15                    x3
2026-08-07 15:00:0x  odds     ok     "Updated 0 game(s) from no source"       x6
2026-08-07 15:14-15:16  everything succeeds again for run_date 2026-08-08
2026-08-11 17:42:53  odds     ok     Updated 15 game(s)   <- single, not the usual triple
2026-08-22 20:02:39  odds     ok     Updated 15 game(s)   <- single
2026-08-22 20:02:59  lineups  ok     Pulled 15 games
```

A brief DNS outage at 15:00 on 08-07, recovered by 15:14. Then the
scheduler stops entirely. **Every scheduled job fires in triplicate** in
this log — three rows at the same second — so the two later entries
firing *singly* are the tell: those are not the scheduler. They are two
occasions when the app was opened by hand.

That triplication is itself local-only, and it is probably the mechanism
behind the divergence in §"the copy has DIVERGED". Production's
`cron_log` has **zero same-second duplicates**; this laptop was running
**three server processes at once**, each with its own `node-cron`
registration and its own write handle on the same SQLite file, all
re-scoring the same games concurrently. That is the process-level version
of the second-write-connection trap already in CLAUDE.md, and it ran for
months.

**So the answer to "silent errors or the chain not executing" is: the
chain was not executing, locally, and that is a property of this laptop,
not of the pipeline.**

## (2) Why some things looked current and others did not

**They didn't. Nothing was current.** My question was built on a false
premise and the premise came from reading `MAX()` on the wrong axis.

`bet_signals` and `game_log` *looked* current because their maximum
**`game_date`** was 2026-08-23. But by **`created_at`**:

```
created 2026-08-07   27 signals
created 2026-08-22    8 signals   <- the manual run
(nothing else after 08-07)
```

Those two hand-run sessions wrote next-day rows into the local copy:
15 games dated 08-12 (odds only, no model, no lineups) from the 08-11 run,
and 15 dated 08-23 (model + lineups, no ML prices) from the 08-22 run.
**That is what made a completely dead local server look like a partially
working pipeline.** It was not partially working. It was off, and someone
opened the app twice.

The distinction that matters and that I missed: **rows written by a
scheduler versus rows written by a person opening the app.** They are
indistinguishable in a `MAX(game_date)` and obvious in a `created_at`
histogram.

## (3) Blast radius: zero

The eight signals emitted locally on 2026-08-22 for the 08-23 slate, i.e.
the ones priced against a 15-day-old `woba_data_snapshot`:

```
124910 tb-bal  ML away   124914 sf-bos  ML away
124911 was-mia ML away   124915 chc-sea ML away
124912 nym-cws ML home   124916 pit-lad ML away
124913 det-kc  ML home   124917 min-sd  ML away
```

**All eight: `bet_line` NULL, `bet_price` NULL, `bet_locked_at` NULL,
outcome `pending`.** None was logged as a bet. They exist only in the
local copy; production emitted its own signals for that slate against
wOBA data uploaded that morning.

The last bet logged in the local copy is **2026-07-09**. The last bet
logged in **production is 2026-08-24 15:54 — today**. Production holds
**333** logged bets to the local copy's 312.

**No bet was ever exposed to stale inputs. The exposure is zero and it was
never non-zero.**

## The finding underneath: the copy has DIVERGED, not merely aged

This is the part that matters going forward, and it is worse than
staleness.

I assumed `data/mlb.db` was an old snapshot of production — a subset,
safe to overwrite. It is not.

```
                                          LOCAL      PROD
game_log rows                              1678      1876
bet_signals                                1815      2211
logged bets                                 312       333
weather_contamination_reason NOT NULL        27       797
market_contamination_reason NOT NULL        134         0
first_pitch_utc NOT NULL                   1378        30
pitcher_debut rows                          438         0
```

Both directions are populated. Production carries **five weather-
contamination reason codes the local copy has none of**:

```
central_naive_hour_pre_2026_07_30                        402
pacific_naive_hour_pre_2026_07_30                        237
mountain_naive_hour_pre_2026_07_30                        99
ath_coliseum_coords_pre_2026_07_27                        50
ath_vegas_venue_override_not_propagated_pre_2026_07_27      6
```

— a timezone-hour correction backfilled on production around 2026-07-30
that never reached the copy. And the copy carries this week's remediation
(`market_contamination_reason`, `first_pitch_utc`, `pitcher_debut`) which
never reached production.

### And the values themselves disagree

Across the **1678 games present in both**:

```
temp_f      differs on 1586 (94.5%)   median |diff| 1.90-3.50 F   max 22.4 F
model_total differs on 1595 (95.1%)   median |diff| 0.32-0.34 runs
```

Split by whether production tagged the game as weather-contaminated:

```
                         n     temp_f differs   median      model_total differs   median
prod-tagged            797     648  (81%)       3.50 F      762  (96%)            0.34 r
prod-untagged          881     787  (89%)       1.90 F      784  (89%)            0.32 r
```

**The disagreement is not confined to the corrected rows.** Untagged games
differ too.

### What that does to this week's numbers

I have to say this rather than let it sit: **a median `model_total`
disagreement of ~0.33 runs between the two databases is larger than the
0.130-run median lineup impact that was this week's headline finding.**

That does not make yesterday's lineup result wrong — it is a *within-copy*
comparison (projected vs confirmed scoring of the same game in the same
database), so a level shift affecting both sides largely cancels. But it
does mean:

- every measurement this week describes the **local copy**, not
  production;
- any result whose magnitude is near 0.3 runs, or which depends on
  absolute `temp_f`, should be **re-run on the refreshed base** before it
  is relied on;
- the contamination-excluded calibration re-runs used an exclusion set of
  **27 weather-tagged games when production had 797**. Those re-runs need
  redoing. That is the most affected item and I am flagging it rather
  than quietly re-running it, because the conclusions were reported.

## The fix

### 1. A freshness check, in three places

`utils/pipeline-freshness.js` — a declarative registry of ten pipelines,
each declaring its own **expected lag** rather than sharing a flat
threshold. Yesterday's scores land at 4AM PT, so `game_log scored` is
*always* a day behind and a flat rule would measure cadence, not health;
the slate runs a day *ahead* because of the 8PM prefetch. Thresholds apply
to the excess over each baseline.

Every entry states the **zone** of the column it reads. `datetime('now')`
columns are UTC and get shifted before truncation; `nowPtIso()` columns
are already PT. Mixing them produces a one-day error, which is the same
size as the signal.

Wired into:

- **the 6AM cron chain**, beside the gate-health and settings-sync checks
  (`services/jobs.js`), non-fatal by construction;
- **`GET /health`** as `pipeline_freshness`, escalating `status` to
  `degraded`/`critical` — so the answer is one request away, which is
  exactly what was missing yesterday;
- **`scripts/pipeline-freshness.js`**, a CLI with `--compare`, exit 1 on
  CRITICAL.

Run against both copies today:

```
pipeline                    LOCAL(before)   PROD        verdict
cron_log                    2026-08-22      2026-08-24
game_log slate              2026-08-23      2026-08-25
game_log scored             2026-08-06      2026-08-23  17d apart
pitcher_game_log            2026-08-06      2026-08-23  17d apart
woba_data_snapshot          2026-08-07      2026-08-24  17d apart
empirical_market_captures   2026-08-07      2026-08-24  17d apart
bet_signals                 2026-08-22      2026-08-24
team_rosters                2026-08-22      2026-08-24
fielding_frv                2026-08-07      2026-08-24  17d apart
catcher_framing             2026-06-03      2026-06-03  SAME - see below

  THE REFERENCE IS NEWER ON ALL 9 DIFFERING PIPELINE(S).
  This is a STALE COPY, not an outage. Refresh before measuring.
```

**The verdict is decided by direction, not by staleness.** The reference
being newer *everywhere they differ* is what makes it a stale copy. If
each were newer somewhere, the verdict is `MIXED` — diverged, neither a
superset, reconcile before overwriting. That distinction is the one I
needed yesterday and did not have.

It would have fired on **2026-08-09**.

### 2. A refresh procedure that does not destroy work

`scripts/refresh-analysis-db.sh` — downloads to a **dated** file, never
onto `mlb.db`; runs `PRAGMA quick_check` and a row-count floor before the
download is allowed near the working copy; prints the freshness
comparison; backs up the current copy under a dated name; promotes; then
**re-applies the local-only remediation**.

That last step is the one that is easy to forget and the one that makes a
naive refresh destructive: production has the schema but not the data, so
every remediation script's output silently reverts unless they are re-run.
All six are dry-run-by-default and idempotent, which is what makes this
repeatable.

The token is read from `MLB_ADMIN_TOKEN`, deliberately — see the security
note below.

### 3. The lesson in CLAUDE.md

New section, **"Know which database you are measuring"**: run the check
before measuring; never conclude an outage from a local DB alone; separate
scheduler-written rows from person-written rows; and the direction rule
for stale-vs-diverged.

## The backfill

Done, reversibly:

```
1. downloaded production               -> data/mlb.db.prod-20260824  (671 MB)
2. PRAGMA quick_check                  -> ok; game_log 1876; logged bets 333
3. backed up the current copy          -> data/mlb.db.local-pre-refresh-20260824
4. promoted the snapshot               -> data/mlb.db
5. re-ran the remediation
```

Undo is a single `cp` from the dated backup.

### Final state

```
game_log rows                        1876   (was 1678)
  scored                             1812   (was 1579)
logged bets                           333   (was 312)
  logged totals carrying bet_price     40   (was 3 in production)
weather_contamination_reason tagged   797   (was 27)
market_contamination_reason tagged    219   (was 134)
first_pitch_utc                      1569   of 1876; the misses are 08-24/08-25 Scheduled
pitcher_debut rows                    448   (was 438)
freshness                            9 ok, 1 critical (catcher_framing, below)
```

### The re-apply list was wrong, and it failed quietly

I ran six scripts. There are **eight**, and the two I omitted —
`backfill-totals-bet-price.js` and `fix-corrupt-totals-rows.js` — are
*upstream* of one I did run.

The failure mode is the point. `regrade-stale-totals-pnl` prices each bet
at what was struck, which lives in `bet_price`. Run before the migration
that populates `bet_price`, it reported:

```
logged totals graded rows: 41   stale: 0
rows re-graded: 0
rows still disagreeing with calcPnl (must be 0): 23
*** REFUSING id=9547: outcome would change win -> loss.  (x14)
```

**"stale: 0" reads as success.** Only the refusal guard and the
non-zero verification line said otherwise — and the 14 refusals were
correct: `bet_line` on those rows held a *price*, not a total, so the
script's recomputation was comparing a score against −105. **The guard
prevented fourteen bad writes.**

Run in the right order, after the migration:

```
rows re-graded: 11   net delta +56.78
rows still disagreeing with calcPnl (must be 0): 0
```

`scripts/refresh-analysis-db.sh` now carries all eight in dependency order
with the two dependencies stated in the file, because this is exactly the
kind of thing that is obvious once and forgotten by the next refresh.

### Two verification numbers that did not reach zero, and what they are

**`ML closing lines with NO provenance tag (target 0): 22`** — not a
defect. All 22 are April–May rows where `closing_line != market_line`
(genuine movement, so not the fabrication pattern) and 20 are logged bets.
They predate `bet_signal_audit`. They are real closes with no audit row,
which is a provenance gap on the oldest data, not fabricated data.

**`totals with a closing_line: 5`** after nulling 939 — 4 genuine captures
the null script correctly skipped, plus one recovered by
`fix-corrupt-totals-rows`. All five are legitimate.

### Numbers that moved on the complete corpus

Worth recording because several were reported this week off the smaller,
diverged copy:

```
                                        reported this week   on the full corpus
post-first-pitch ML exposure (upper)                   178                  252
  ... with a real price move                        (varies)                226
  ... distinct games tagged                              134                  219
fabricated totals closing lines nulled                 762                  939
ML CLV, observed-only              2.00pp on n=86     1.97pp on n=89
```

The CLV figure is the reassuring one: **the finding this week's CLV thread
rested on survives the corpus change essentially unmoved.** The exposure
and fabrication counts are larger simply because the corpus is larger.

## Two things found while looking, neither of them asked for

### `catcher_framing` is 82 days stale — on production

```
catcher_framing   last updated 2026-06-03   +82 days   CRITICAL in BOTH copies
```

Stale in both copies means it is a property of the **source system**, not
of the copy — the freshness check separates those automatically, and this
is the first thing it caught.

**No cron refreshes it.** `runCatcherFramingJob` exists and is not on any
schedule; the table is populated by hand. Every framing value in the model
has been fixed since 2026-06-03.

This lands directly on work from earlier in the week: `CATCHER_FRAMING_MUTE`
was evaluated against a `catcher_framing` table that had not moved in
eleven weeks. Not necessarily fatal — framing runs are a slow-moving,
strongly-regressed quantity — but the evaluation assumed a live input and
it was not one.

I have not scheduled the job. Adding a cron is a change to the pricing
path and that is yours to call.

### The admin token is committed in the repo

`refresh-db.sh` contains a live `X-Admin-Token` in plaintext, committed.
That token authorises `/api/admin/download-db` — the entire database,
including every logged bet — plus the write endpoints behind
`requireAdminToken`.

I have not rotated it; that needs the Render dashboard. The new refresh
script reads from the environment instead of copying the pattern.
**Worth rotating.**

## What I would do differently

The check is the durable part, but the process failure is worth naming
separately: I reported an outage without ever asking the system whether it
was up. `/health` was one request away, returned in 235 ms, and answers the
question completely. I inferred a production failure from a local file for
a full day and never validated the inference against the thing itself.

The a-priori-ordering method that settled the timezone bugs earlier this
week is the same tool: **validate a claim against a source whose answer is
fixed independently of your evidence.** For "is the pipeline running", that
source is the running pipeline.

## Related

- `utils/pipeline-freshness.js` — the registry and thresholds.
- `scripts/pipeline-freshness.js` — CLI, `--compare` for stale-vs-diverged.
- `scripts/refresh-analysis-db.sh` — the non-destructive refresh.
- `docs/lineup-horizon-coverage-and-a-stale-pipeline-2026-08-24.md` — §4 of that page is retracted by this one.
- `CLAUDE.md` — "Know which database you are measuring".
