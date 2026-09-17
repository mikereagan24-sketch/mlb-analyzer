# Harness inputs: all 21 caller-populated fields, from their persisted source (2026-09-16)

## Registration

**Change.** `services/harness-inputs.js` `populateCallerInputs` reads every
field runModel uses but does not compute from its persisted emit-time
source, instead of the 4 it populated before. `HARNESS_INPUTS=legacy`
reproduces the old harness exactly.

**This is a re-baseline event.** Every number an offline calibration harness
produces changes level, so figures recorded before it are about a different
model. Registry rows quoting such figures now carry `evidence_predates`.
**None of them has been re-run.**

**Not a pricing change.** Nothing in `services/jobs.js` or the live path
moves; production already computes all of these per game.

## The 21 fields, and what the old harness actually supplied

runModel reads 41 fields off `game`. A `game_log` row spread plus the two
parsed lineups supplies 20, leaving 21 that the caller must populate.
`scripts/test-harness-inputs-sources.js` derives that set from runModel's
own reads and fails if a new one appears without a source.

Probe over the calibration corpus (2026-06-01..08-07, weather valid,
calibration-ab usability rules, **658 games**):

```
group         field                          harness-has  persisted  inject-changes  max|d|
frv           away/homeFieldingRunsPerGame      619/619   no column (as-of snapshot read, unchanged)
framing       awayCatcherFramingRvPerGame        651        627           619        0.1961
framing       homeCatcherFramingRvPerGame        653        630           623        0.1961
bullpen       6 fields                             0        658           658
opener        6 fields (forecast ip, bulk guy)   41-48      41-48           0
tandem        tandem_subtype_away / _home          0 / 1     0 / 1          0
roster        away/homeRosterSet                   0        no source
availability  bullpenAvailability                  0        no source
```

**"4 of 21" was an undercount.** `preScreenGame` spreads the whole row, so
the 8 snake_case opener and tandem columns always reached runModel; the old
harness supplied 12. The real gaps were **bullpen (6, absent)** and
**framing (2, recomputed from current state and different from emit on
~99% of sides, by up to 0.196 runs/game)**.

Framing nulls are real: every null `rv_per_game` in the window carries an
emit-time state (`no_roster_match` 24/21, `no_framing_data` 24/21 away/home),
and states begin 2026-04-04, before any wOBA snapshot. So a persisted null is
kept as null. A row with no state (none scorable today) falls back to the
recompute and is counted.

Bullpen is persisted on 1495 of 1495 graded games since 2026-05-20. A row
without it is left undefined and counted, **not** recomputed from today's
`woba_data`, which is the date defect `bullpenTermForReplay` exists to avoid.

## Measurement, per group

`node --max-old-space-size=1536 scripts/calibration-ab-inputs.js <group> DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07`.
Weather filter valid, FRV read asof, 658 games, identical set on both arms.
Each group is added to the **legacy** baseline.

```
group     OFF logLoss  ON logLoss   edge slope OFF/ON   d(ON-OFF) [95% CI]
none        0.69010     0.68921      +0.009 / +0.130    -0.00088 [-0.00237, +0.00067]
bullpen     0.68917     0.68848      +0.063 / +0.191    -0.00069 [-0.00222, +0.00091]
framing     0.68972     0.68880      +0.061 / +0.180    -0.00092 [-0.00241, +0.00063]
opener      identical to none on every result line
tandem      identical to none on every result line
all         0.68874     0.68800      +0.125 / +0.250    -0.00074 [-0.00227, +0.00086]
```

**The new default** (`scripts/calibration-ab.js`, no env), same corpus:

```
persisted   0.68877     0.68803      +0.120 / +0.245    -0.00074 [-0.00229, +0.00086]
```

Against the legacy baseline its level moves **-0.00133 (OFF) / -0.00118
(ON)** and its edge slope **+0.111 / +0.115**. Those are larger than most
effects this harness has been asked to resolve.

The default is close to `all` but **not identical**, and the difference is
fully accounted for. The group injection copied framing only where the
column was non-null. The default copies the emit value including NULL when
emit recorded a state. That differs on **47 sides / 46 games**, and those 46
are every game where p(home) differs: 92 of 92 differing game-arm pairs, 0
unexplained. The default is the faithful one, because production priced
those sides with no framing.

Opener and tandem reproducing legacy to every digit is the identical-digits
tell from CLAUDE.md, and here it is the correct reading: the values
injected were already present.

### Framing's own flag

`CATCHER_FRAMING_ENABLED false true`, same corpus:

```
input              OFF        ON        d(ON-OFF) [95% CI]              mean |dp|
recomputed (old)   0.69030    0.69010   -0.00020 [-0.00164, +0.00134]   0.00714
persisted (new)    0.69030    0.68972   -0.00058 [-0.00195, +0.00091]   0.00775
```

The OFF arm is byte-identical, as it must be (the flag zeroes the term).
Not significant either way, and not a verdict. The point estimate moves
from -0.00020 to -0.00058 once the term is the value the model actually
priced with.

### The earlier bullpen figure: a different corpus, same direction

**Corrected 2026-09-17.** This section first recorded the bullpen figure as
"+0.0022 on both arms" whose source was unidentified. Both halves of that were
wrong:

- **The figure is -0.0022**, a log-loss reduction. The "+" came from how
  the request was written, not from the measurement.
- **Its source is known:** the 2026-09-05 scratchpad run, 2026-06-01 ->
  08-07, **n=439**, the **pre-#382** weather filter (tag, before
  `weather_inputs_valid`), and the **legacy FRV term** (one summed row per
  player, before the 2026-09-12 position split).

On the current filters it is smaller and points the same way:

```
corpus                                          bullpen effect on log loss, OFF / ON
2026-09-05 run: n=439, pre-#382, legacy FRV    -0.0022 (both arms)
tag filter, FRV_READ=current, n=349 (today)    -0.00179 / -0.00171   (0.69451 -> 0.69272, 0.69277 -> 0.69106)
valid, FRV asof, n=658 (current filters)       -0.0009  / -0.0007    (0.69010 -> 0.68917, 0.68921 -> 0.68848)
```

So this is **not a lost source**. It is the same measurement on a different
corpus, and the magnitude shrinks as the corpus moves to the current filters.
Of the three, only the 658-game row is on the corpus the harness now scores.

The tag-filter corpus is 349 today, not 439, because
`market_contamination_reason` tagging has grown since 2026-09-05. So even
that row does not reproduce the 09-05 corpus exactly. The edge-slope figure
quoted alongside the original (-0.025) is not reconciled here. On both
re-runs above the slope rises with the bullpen (+0.009 -> +0.063 / +0.130 ->
+0.191 at n=658).

## Settings that act only through a frozen input

Reading bullpen and framing from emit FREEZES them at production's
settings. An A/B on a setting whose whole effect goes through those
computations would score two identical arms. That was already silently
true for every bullpen setting under the legacy harness, which never
populated the bullpen. Both calibration harnesses now refuse it:

```
WHOLE (refused, exit 2)   BULLPEN_W_PROJ BULLPEN_W_ACT BULLPEN_MIN_BF BULLPEN_DOWNWEIGHT_STARTERS
                          BP_{STRONG,WEAK}_WEIGHT_{R,L}
                          CATCHER_FRAMING_{TAKES_PER_GAME,ABS_FACTOR,MIN_PITCHES_2026}
PARTIAL (runs, labelled)  W_PROJ W_ACT MIN_BF UNKNOWN_PITCHER_WOBA PARK_NEUTRAL_INPUTS_ENABLED
not frozen                CATCHER_FRAMING_{ENABLED,MUTE} BULLPEN_AVG DEFENSE_FRV_* SP_WEIGHT ...
```

WHOLE is derived (family prefix, and absent from the comment-stripped source
of runModel and the modules it requires), not listed. The test also asserts
the fail-closed direction: every setting the bullpen wiring or
`utils/framing-rate.js` reads must be classified.

The stripper failed twice while building this, both times in a direction a
plain test would not have caught: a `/*` inside a `//` comment deleted 36,560
characters of model.js (so `BULLPEN_AVG` read as frozen), and a quote inside
a regex literal turned scraper.js comments into a string (so
`CATCHER_FRAMING_MIN_PITCHES_2026` read as not frozen). Both are pinned, and
the test requires the stripped sources to still parse.

`bullpen_w_proj_w_act` is therefore **not measurable by these harnesses at
all** under persisted inputs. It needs a harness that supplies both bullpen
arms itself, the way `scripts/bullpen-neutral-ab.js` does.

## Registry rows whose evidence predates this (listed, not re-run)

| row | harness | measured | figures |
|---|---|---|---|
| `park_neutral_inputs_enabled` | park-neutral-paired-floor.js | 2026-08-30 | +/-0.000608 at n=801, -0.00055, the 979 trigger |
| `defense_frv_enabled` | calibration-ab.js | 2026-08-23 | -0.00087, five metrics, slope -0.313 -> -0.218 |
| `defense_frv_split` | calibration-ab.js | 2026-09-13..14 | -0.00154 n=797, -0.00066 n=1158, hindsight -0.00010, resamples |
| `use_hand_conditional_sp_weight` | calibration-ab.js | 2026-08-22..23 | +0.00009, +0.00008, 2/5, Tier 4 |
| `bullpen_woba_neutralization` | bullpen-neutral-ab.js | 2026-08-31 | +0.000019 +/-0.000217 (bullpen supplied by the script; framing differs) |
| `signal_edge_cap_enabled` | edge-honesty-scope.js | 2026-08-22 | the note's calibration finding (the ROI decision is unaffected) |
| `signal_edge_hard_cap_pp` | edge-honesty-scope.js | 2026-08-22 | same |

Checked and **not** affected: mechanism and precondition rows,
`totals_selection_edge` (logged bets), `ui_highlight_*` (frozen emit-time
`model_line`, no re-scoring), `spread_*` (empirical spread engine),
`sp_weight_l` (a 0/790 identity check with the flag off),
`bsr_baserunning` (`services/baserunning-backtest.js` builds its own game
object and never calls `populateCallerInputs`), and rows with no measurement.

**`park_neutral_inputs_enabled` changes shape, not only level.** The bullpen
column was written with neutralization ON since 2026-08-31, so both arms of a
re-run carry a neutralized bullpen and only the batter/SP half of the flag
varies. The harness labels it PARTIAL.

### Outside the registry, also measured through populateCallerInputs

- CLAUDE.md's calibration floor tables (`scripts/resolution-floor.js
  --calibration`) and the paired half-width **+/-0.000608**
  (`scripts/park-neutral-paired-floor.js`).
- `component-signal-diagnostic.js`, `edge-honesty-scope.js`,
  `rookie-roi-and-calibration.js`, `woba-park-source-ab.js`,
  `contamination-impact.js`, and `calibration-sweep.js` results in docs/.

Not edited here. They need the same treatment when next quoted.

## Reproduction

- `HARNESS_INPUTS=legacy node scripts/calibration-ab.js DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07`
  reproduces the `none` row **on all 22 result lines**, run on the new code.
  Old figures remain reproducible.
- The default run gives the `persisted` row above. Its difference from `all`
  is the 46 framing games, verified game by game.
- `node scripts/calibration-ab-inputs.js --selftest` passes on the new code.
- `node scripts/test-harness-inputs-sources.js` covers the rest.
