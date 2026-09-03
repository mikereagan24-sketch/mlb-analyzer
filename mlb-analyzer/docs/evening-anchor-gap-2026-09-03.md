# The evening anchor gap costs nothing (2026-09-03)

> **Do not add evening lineup crons.** Measured over 1,647 games
> (2026-04-04 → 2026-08-29): **zero** evening games were delayed enough for
> a lineup pass to fall inside the delay window, and **zero** signals were
> written in one.
>
> The 262-minute worst-case wait is real and entirely theoretical.

## The question

The capped live first-pitch refresh leaves late-starting games waiting for
the 11PM PT lineup pass, because there is no pass for *today* between
18:00 and 23:00 PT. Worst simulated wait on the 09-02 slate: 262 minutes
on the `scheduled_start_utc` fallback.

That is only a cost if the fallback is ever **wrong** in that window. It
reports "started" the moment the scheduled time passes — correct for an
on-time game, and the anchor adds nothing. So the question is not *how
long do late games wait*, it is **how often was a late game delayed enough
that we refused something we should have emitted.**

## The answer: never, this season

```
scheduled 18:00-23:00 PT           : 257 games  (15.6% of the season)
evening games delayed >2m          :   7
...with a lineup pass inside the gap:   0
signals written inside a delay window: 0
```

## And the gap sits where delays don't happen

```
band            n     >2m       >=10m   >=60m   worst
09:00-13:00   420   69 (16%)      19      13    200m
13:00-16:00   398   55 (14%)      30      13    131m
16:00-18:00   571  100 (18%)      25      11    180m
18:00-23:00 * 257    7 ( 3%)       2       0     19m
```

**The evening band is the most punctual of the day** — 3% late against
14–18% elsewhere, and **zero** delays of an hour or more all season
against 11–13 in every other band. Worst evening delay is 19 minutes.

Meanwhile the bands where delays actually happen (09:00–18:00) already
carry a pass every hour or two. The current schedule is well matched to
where the risk is. Adding 8PM/9PM passes would buy coverage precisely
where the failure it protects against does not occur — on a 512MB
instance that OOM-crash-looped yesterday.

## A correction to how this was framed

I described the anchor as disambiguating *"scheduled says started but the
game may be delayed."* That is not quite what it does.

`hasStarted()` checks three things in order: `first_pitch_utc`, then
`game_status ∈ LIVE_OR_DONE`, then `scheduled_start_utc`. And
`LIVE_OR_DONE` **already contains `Delayed Start` and `Delayed`** — a
deliberate choice, per its comment: *"Anything here means a market quote is
NOT a pre-game price."*

So for a delayed game with a fresh status, the second branch already
returns true. The anchor does not rescue the delayed case; the status
does. What the live refresh really buys is **`game_status` freshness** —
`refreshFirstPitch` writes status alongside the timestamp — plus an exact
rather than approximate start time.

That does not change the conclusion. It sharpens why the evening gap is
cheap: the branch that resolves delays is the status branch, and the
evening band has essentially no delays to resolve.

## On the existing 8PM cron

It runs at 20:00 PT and targets **tomorrow's** slate
(`runOddsJob → runWeatherJob → runLineupJob`, all on `tomorrowStr()`).

It **could** carry today's anchors — one added
`refreshFirstPitch(todayStr(), { onlyMissing: true })` call, bounded to
`FP_LIVE_CAP` (3) statsapi calls. That is the cheap option, and strictly
cheaper than a new cron, since the process is already awake and doing
sequential network work.

**But the measurement says don't.** Zero exposure means this is load with
no benefit. Recorded here so that if the picture changes — more late
games, a rule change, or the fallback's conservatism starting to cost
emitted signals — the cheap fix is already identified and does not need
re-deriving.

## Re-run

```
node scripts/measure-evening-anchor-gap.js
```

Re-run before adding evening passes. The argument for adding them is a
non-zero "passes inside the gap" count; until then this is settled.
