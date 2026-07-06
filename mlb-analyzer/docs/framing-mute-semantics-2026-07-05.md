# Catcher framing mute semantics — 2026-07-05

Follow-up to `docs/run-conversion-audit-2026-07-05.md` which reported
framing contribution = 0.000 in every bucket. Verifies the code semantics
of `CATCHER_FRAMING_MUTE=1.0` and reports the actual production state.
No settings flipped.

## Code semantics (services/model.js:1653)

```js
function applyCatcherFramingDelta(rvPerGame, settings) {
  if (!settings || !settings.CATCHER_FRAMING_ENABLED) return 0;
  if (typeof rvPerGame !== 'number' || isNaN(rvPerGame)) return 0;
  const raw = settings.CATCHER_FRAMING_MUTE;
  let mute = 0.5;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!isNaN(n)) mute = n;
  }
  return rvPerGame * mute;
}
```

**`mute` is a linear multiplier on the run-value effect.** So the
name is confusing:

- `MUTE = 0` → returns 0 (fully muted, no effect)
- `MUTE = 0.5` (default) → half the framing effect applied
- **`MUTE = 1.0` (prod) → 100% of the framing effect applied**

The name reads like "how much to suppress" but the arithmetic is "how
much to apply." A future rename to `CATCHER_FRAMING_SCALE` (or
`_WEIGHT`) would remove the ambiguity — noted for follow-up, not
this pass.

## Production state

`GET /api/settings` (2026-07-05):

```
catcher_framing_enabled = true
catcher_framing_mute    = 1.0
```

Both toggles are on. In principle, the model IS applying the full
framing effect on every game where the ingest supplies a run-value.

## Data coverage — actual contribution across the season

Ingest started later than the settings. `game_log.away_catcher_framing_rv_per_game`
populated:

| Month | Games | With framing_rv | Coverage |
|--:|--:|--:|--:|
| 2026-04 | 333 | 0 | **0.0%** |
| 2026-05 | 426 | 0 | **0.0%** |
| 2026-06 | 86 | 12 | 14.0% |
| 2026-07 | 37 | 28 | **75.7%** |

Earliest game with framing data: **2026-06-17**. Most recent: 2026-07-04.

Framing state distribution across all game rows since 2026-04-01
(n=882):

```
<null>            831   (94.2%)
applied            40   (4.5%)
no_framing_data    11   (1.2%)
```

**~95% of the season's games had a null framing state**, meaning the
model's `game.homeCatcherFramingRvPerGame` was null → `applyCatcherFramingDelta`
returned 0 for those games (line 1655). The settings toggle had no
runtime effect on those games because there was no data to scale.

## What the audit measured vs what actually ran

The run-conversion audit reported "framing contribution = 0.000 in
every bucket." Two overlapping reasons:

1. **Data-coverage reality**: ~95% of the sampled 768 games (Apr-Jul)
   had no framing_rv populated. Framing genuinely contributed 0 to
   those games' `estTot`, matching the audit result.

2. **Measurement-side artifact**: `tmp/measure-run-conversion.js` passed
   raw `game_log` rows to `model.runModel`. game_log stores
   `home_catcher_framing_rv_per_game` (snake_case); the model reads
   `game.homeCatcherFramingRvPerGame` (camelCase; aliased in
   `services/jobs.js processGameSignals` line 576-577 during live
   scoring). The audit didn't alias → the model saw undefined →
   returned 0 even on the ~40 games where the data WAS populated in
   game_log. Missed ~0.05-0.15 runs of framing effect on those games,
   which is a rounding error at the aggregate level given <5% coverage.

The audit's "framing contribution = 0" finding was substantially
correct, just not for the reason implied. Corrections noted here for
the record.

## Enable/disable impact estimate

**What enabling would change**: with mute already at 1.0, the setting
is already enabled at full effect. What changed is the *data flow*,
not the setting. As July's 76% coverage extends to full slate coverage
in coming weeks, framing will start moving `estTot` by ~0.05-0.15 runs
per game on average.

Sample from prod 2026-07-05 slate (one game):

```
away_catcher_framing_rv_per_game = 0.0589   (LHB, framer)
home_catcher_framing_rv_per_game = -0.0140  (RHB, cost runs)
```

At mute=1.0:
- home offense adjusted: -0.0589 runs (opposing catcher steals strikes)
- away offense adjusted: +0.0140 runs (opposing catcher loses strikes)
- **net estTot delta = -0.045 runs** on this game

Typical population effect: framing_rv distributes roughly symmetric
around zero, so aggregate over lots of games nets small. Per-game the
effect is small (P95 magnitude ~0.15 runs). Doesn't materially change
the LO→HI compression story from the earlier audit; framing is
noise-level relative to park factor (+0.78 runs LO→HI) or temp (+0.33).

**Would flipping mute to 0.5 (halving) change PnL?** With ~28 July
games affected (n=28 with data × 0.05 avg runs = ~1.4 total-runs of
adjustment across those games), halving to 0.5 would cut that to 0.7
total-runs. That's not enough to move signal populations or W/L. Not
worth a flip until the population grows.

## Answer to the framing-mute question

- Semantics: **MUTE is a SCALE factor.** 1.0 = full effect, 0 = fully
  muted. Misleadingly named.
- Setting state: `enabled=true`, `mute=1.0` → framing effect is
  supposed to be fully applied at prod scoring.
- Actual season contribution: essentially zero for April/May (0%
  coverage), rising to material for late June/July (14% → 76%).
- Not flipping anything. When July's slate has full coverage, mute=1.0
  IS the right value — this is the desired production state. If a
  future backtest shows framing hurts, dropping mute to 0.5 or 0 is a
  cheap dial. For now: leave it.

## Follow-ups (not in this pass)

- Rename `CATCHER_FRAMING_MUTE` → `CATCHER_FRAMING_SCALE` (or
  `_WEIGHT`) to remove the semantic-inversion trap. Would touch the
  settings key, schema entry, UI label, and the docstring in
  `applyCatcherFramingDelta`. Owner's call whether to disturb.
- Fix `tmp/measure-run-conversion.js` to alias framing/defense fields
  before calling runModel — bug in the audit measurement pipeline
  itself. Non-blocking; noted for future reruns.
- Chase why framing coverage didn't backfill to April-May. If the
  ingest is date-forward only, historical backtests understate
  framing's contribution.
