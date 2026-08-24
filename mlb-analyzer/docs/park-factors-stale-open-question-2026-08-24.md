# PARK_FACTORS has not been refreshed in 127 days — open question (2026-08-24)

> **Filed, not started.**
>
> `PARK_FACTORS` is a hardcoded 30-team object at `services/scraper.js:296`
> that multiplies **both sides' run estimates on every game**. It was last
> touched **2026-04-19**. Today is 2026-08-24. **127 days.**
>
> A stranded April branch (`2f29110`, 2026-04-25) would have changed 10 of
> the 30. Measured against real games, that disagreement is worth a
> **game-weighted mean |Δtotal| of 0.359 runs across 626 of 1861 games**,
> peaking at **+0.748 (BAL)** and **−0.557 (SEA)**.
>
> **That is larger than every effect measured this week** — lineup
> projection error (0.130 runs median), catcher framing (0.048 mean
> |value|) — and it is not a measurement of error. It is a measurement of
> how much two four-month-old guesses disagree, which is a lower bound on
> what a fresh pull could move.
>
> **The requirement is a fresh pull, not landing the April branch.** Both
> versions are stale.

## Why this is not just another stale constant

`model.js:1272` computes each side's raw runs as
`max(0, (teamWoba − WOBA_BASELINE) × RUN_MULT × pf)`. **Runs scale
linearly in `pf`**, and both sides of a game share the home park's factor,
so the *total* scales by the same ratio. A park factor 9% wrong makes the
total 9% wrong on every game at that venue.

Note that `PARK_NEUTRAL_INPUTS_ENABLED = true` does **not** neutralise
this. That flag park-neutralises the *batter projections*; the venue
factor still multiplies the run estimate afterwards. `PARK_FACTORS` is
live on every game without a `VENUE_ID_OVERRIDES` entry.

## The measurement

Live values (`main`) versus the stranded April refresh, against each
team's real home-game model totals:

```
  team  live   alt    ratio    home games   mean total   implied d(total)
  COL   1.25  1.28  1.0240        62         10.78          +0.259
  ARI   1.10  1.08  0.9818        63          9.24          -0.168
  CIN   1.10  1.06  0.9636        65          9.10          -0.331
  BOS   1.06  1.08  1.0189        64          7.90          +0.149
  MIA   1.01  1.02  1.0099        59          7.91          +0.078
  DET   0.98  1.02  1.0408        64          7.80          +0.318
  MIN   0.97  1.06  1.0928        62          7.91          +0.734
  PIT   0.97  1.00  1.0309        63          7.98          +0.247
  BAL   0.96  1.05  1.0938        64          7.98          +0.748
  SEA   0.95  0.88  0.9263        60          7.55          -0.557

  affected home games                         626 of 1861  (33.6%)
  game-weighted mean |d(total)| on affected     0.359 runs
```

### What this number is and is not

It **is** a lower bound on the sensitivity: two people looking at
FanGraphs six days apart in April produced values that disagree by a third
of a run on a third of the schedule.

It is **not** an error estimate. Neither set has been checked against
2026 data. The April branch is not "the right answer" — it is a second
guess of the same vintage, and landing it would be substituting one
127-day-old constant for another.

## The requirement: a fresh pull, with provenance

1. **Pull FanGraphs 3-year R factors as of today**, the same source the
   2026-04-19 commit used (`4a2cff2`, "switch PARK_FACTORS to FanGraphs
   3-yr R with manual adjustments"), so the comparison is like-for-like.
2. **Preserve the four documented manual adjustments** or re-justify each.
   They are annotated in place at `scraper.js:280-294` and are *not*
   straight FG values:
   - `ATH 1.19` — the 3-yr FG factor still averages in Oakland Coliseum
     years and understates Sutter Health Park;
   - `TB 0.95` — excludes the 2025 temporary Steinbrenner Field season;
   - `KC 1.02` — bumped for the 2024 fence move-in, not yet through three
     full seasons;
   - and the Mexico City venue override at `model.js:48` (`parkFactor 1.20`)
     which bypasses this table entirely.
3. **Record the pull date and source URL in the code**, which the current
   block does not carry. "Last touched 2026-04-19" had to be recovered
   from `git log -S`.
4. **Re-run the calibration A/B before and after.** A change of this
   magnitude on 34% of games must not go in unmeasured — it is exactly the
   size that would move the sweeps and gate evaluations, and those were
   all re-run on 2026-08-24 against the *current* values.

## What would make this recur

Nothing schedules it, nothing reports it, and the constant carries no
as-of date. That is the same shape as the framing table before
2026-08-24: a pricing-path input refreshed by hand, with no cadence and no
check. **The freshness registry (`utils/pipeline-freshness.js`) cannot see
it, because it is a literal in source rather than a table with a
timestamp.**

Worth considering as part of the fix: move `PARK_FACTORS` into a table
with an `updated_at`, so it becomes visible to the same check that now
covers `catcher_framing` and `fielding_frv`. That is a larger change than
the refresh and should be a separate decision.

## Not scheduled

No trigger, no owner, no window. Filed because it is a live pricing
constant with a measured sensitivity larger than anything else examined
this week, and because the alternative — carrying it silently for another
127 days — is how it got here.

## Related

- `services/scraper.js:296` — the constant, and the manual-adjustment notes above it.
- `services/model.js:1272` — where `pf` multiplies the run estimate.
- `services/model.js:48` — `VENUE_ID_OVERRIDES`, which bypasses the table.
- `4a2cff2` (2026-04-19) — the last refresh.
- `2f29110` — the stranded April branch; see `docs/stranded-branch-dispositions-2026-08-24.md`.
