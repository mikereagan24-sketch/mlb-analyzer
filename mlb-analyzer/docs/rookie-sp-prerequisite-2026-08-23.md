# Rookie-SP prerequisite: debut backfill complete (2026-08-23)

> **§P is done. 403 of 438 starters carry a debut date and career line.**
>
> **The 35 misses looked exactly like the bias the acceptance criterion
> was written to catch — and are not.** Every one is spring-training-only.
>
> **And the backfill surfaced a trap that would have silently corrupted
> the cohort: `pitcher_game_log` includes spring training, 20.8% of its
> rows.**

The pre-registration in
`docs/rookie-low-sample-sp-open-question-2026-08-22.md` §PR is committed
(2026-08-22) and **has not been edited**. No measurement has been run.

## What was fetched

One statsapi call per starter:
`/api/v1/people/{id}?hydrate=stats(group=[pitching],type=[career])`
returns `mlbDebutDate` **and** career `inningsPitched` / `battersFaced` /
`gamesStarted` together — so both cohort definitions come from one pass.

```
distinct starters : 438
complete          : 403   (debut date + career line)
missing debut     :  35
fetch errors      :   0
```

New table `pitcher_debut` (`pitcher_mlb_id` PK, name, `mlb_debut_date`,
`career_ip`, `career_bf`, `career_gs`, `fetched_at`).

## The 35 misses — enumerated, and why they are not a bias

The ticket's acceptance criterion required enumerating misses rather than
counting them, because *"a systematic miss (e.g. every 2026-debut pitcher)
would bias the cohort in exactly the direction the hypothesis predicts,
which is the one failure mode that could manufacture a false positive."*

On the first look the misses were alarming:

```
of the 35, actually have >= 1 start : 35
season BF < 100                     : 35  (100%)
for contrast, all starters < 100 BF : 232 of 438  (53%)
```

**100% below the gate, against a 53% base rate.** That is precisely the
shape of a cohort-biasing miss.

It is not one. Every start they have is in **March**:

```
the 35 missing-debut pitchers, by month of their starts:
  2026-03   37
```

These are spring-training appearances by non-roster pitchers who have
**never made an MLB debut** — so statsapi is right to have no debut date,
and they never appear in the regular season the cohort will be built over.
37 starts of 4,120 (0.9%), all outside the model corpus.

**Verified rather than assumed**, because the alternative reading —
"the backfill systematically loses rookies" — would have been fatal and
looks identical until you check the dates.

## The trap the backfill surfaced

```
pitcher_game_log by month:
  2026-03   apps 4527   starts 806     <- SPRING TRAINING
  2026-04   apps 3391   starts 796
  2026-05   apps 3499   starts 838
  2026-06   apps 3322   starts 788
  2026-07   apps 3159   starts 734
  2026-08   apps  688   starts 158

game_log (the model corpus) spans : 2026-04-04 .. 2026-08-23
appearances before 2026-03-26     : 3863 of 18586  (20.8%)
```

**`pitcher_game_log` includes spring training, and March carries more
starts (806) than any regular-season month.** The model corpus begins
2026-04-04 and never scored those games.

This matters directly for cohort definition (1a), "below `MIN_BF`".
Accumulating as-of-date BF from `pitcher_game_log` without excluding
spring training would credit a pitcher with up to a month of batters
faced that the model's actuals never counted — `woba_data` comes from
FanGraphs regular-season lines. A pitcher genuinely below the gate in
April would read as established, **removing him from the very cohort the
hypothesis is about**.

That is a silent, direction-specific corruption: it shrinks the cohort by
exactly its most rookie-like members.

**Decision, recorded before any measurement:** as-of-date BF accumulation
will be restricted to dates present in `game_log`. The cohort is defined
over games the model actually scored, which is self-consistent and needs
no separate opening-day constant.

## Career figures are as-of-fetch — the look-ahead note

`career_ip` / `career_bf` / `career_gs` are **current totals and include
2026**. Using them raw for an as-of-game-date cohort is look-ahead: a
pitcher with 60 career IP today may have had 5 at the start being scored.

The as-of-date value is
`career_ip_today − Σ(2026 IP on or after the game date)`, taken from
`pitcher_game_log`. This is the same discipline `woba_data_snapshot`
enforces for batters and the same error the ticket flags for season BF.
It is noted in the schema comment beside the table, not only here.

## State

- **Done:** §P prerequisite.
- **Not started:** all four measurements. Nothing has been run against the
  pre-registered predictions.
- **Unchanged:** §PR, committed 2026-08-22.

Next is cohort construction with as-of-date discipline, then the four
measurements in the ticket's order — with the over-representation count
first among them, since it is the leg most likely to be conclusive and
does not depend on the calibration leg having power.

## Related

- `docs/rookie-low-sample-sp-open-question-2026-08-22.md` — the ticket and §PR.
- `scripts/backfill-pitcher-debut.js` — the backfill and its enumeration.
- `db/schema.js` — `pitcher_debut`, with the look-ahead warning.
