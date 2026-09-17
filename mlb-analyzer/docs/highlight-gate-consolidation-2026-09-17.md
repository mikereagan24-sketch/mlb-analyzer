# The highlight gate: eight copies to one

2026-09-17. Consolidates every implementation of the UI highlight rule
into `utils/highlight-gate.js`, renames the harnesses' reporting bucket
to `above_ui_floor`, adds a `by_category_bet` bucket keyed on the
operator's own bet log, and corrects two things this repo had recorded
wrongly about the gate.

Nothing about pricing or betting changes. No settings change. The floors
are the same numbers they were this morning.

## The count was eight, not five

The measurement that preceded this PR said five. That was wrong, and the
error was in the same direction as the two earlier undercounts recorded
in `scripts/rank-parallel-implementations.js` ("four", then "six, not
four"). The full inventory:

| # | Site | Thresholds | Notes |
|---|---|---|---|
| 1 | `services/frv-backtest.js:163` | app_settings | `isHighlightedSignal` + own loader |
| 2 | `services/temp-backtest.js:178` | app_settings | byte-identical copy |
| 3 | `services/runmult-totals-backtest.js:217` | app_settings | byte-identical copy |
| 4 | `services/parameter-sweep.js:236` | app_settings | same rule, routed via `categoryFor` |
| 5 | `public/index.html:812` `signalMeetsHighlightThreshold` | **hardcoded 2.0 / 4.5 / 7.0** | the game card |
| 6 | `public/index.html:2450` `_shouldHighlight` | app_settings ×100 | matchup comparison panel |
| 7 | `public/index.html:4698` `_bktThresholds` | app_settings | needs the numbers, not the predicate |
| 8 | `public/index.html:5513` manual-bet preview | app_settings, inline | computes its own edge, then the floors |

Why a grep for duplicates missed 7 and 8: they are not same-named
functions, they are *the same rule under different names*. The ranking
tool in `scripts/rank-parallel-implementations.js` looks for
`function NAME`, so it structurally cannot see them. That is why this PR
ships a grep-based no-duplicates assertion in
`scripts/test-highlight-gate.js` instead of trusting the ranking.

## What was actually broken

The eight agreed — today. Production `app_settings` held 0.02 / 0.045 /
0.07 / overs-false, which is exactly the client's hardcoded 2.0 / 4.5 /
7.0. So no drift was visible, and none had occurred.

The defect was that an operator editing `ui_highlight_ml_fav_min_pp` on
the settings card would have moved seven of the eight sites and left the
game card on 2.0. The card is the thing the operator looks at. A setting
that silently fails to move the only surface it exists to control is the
failure mode here, not a wrong number.

## Two records corrected

**1. The gate is not on the pricing path.** `PRICING` in
`scripts/rank-parallel-implementations.js:45` matched all of `utils/` and
all of `services/`, so it classified the gate — and the four backtest
harnesses — as able to misprice, and doubled their risk radius
accordingly. Nothing in the gate gates a price, a signal write, or a bet.
Emission is `SIGNAL_EMIT_FLOOR_PP` in `services/model.js` `getSignals`.
The predicate now names an explicit `REPORT_ONLY` set rather than
inferring the pricing path from a directory.

**2. "What the user actually bets" was never that.** Three places said
the above-floor aggregate was the population the operator bets:
`parameter-sweep.js`'s `scoreGames` doc comment, its `betSelection`
documentation, and the same text in `routes/api.js`. Measured against
`bet_signals WHERE bet_line IS NOT NULL`:

```
logged bets                                  515
  star-label era                             266
  continuous-edge era                        249
    above the UI floor                       173
    BELOW it                                  76

by category (continuous-edge)  logged / above floor / median emit pp
  ML fav                          107 / 102 / 3.33
  ML dog                          100 /  67 / 5.44
  Total under                      29 /   4 / 2.49
  Total over                       13 /   0 / 5.23
```

31% of logged continuous-edge bets are below the floor the harnesses were
reporting as the bet population. All 13 logged overs are unreachable by a
gate with `overs_enabled=false` — no edge admits them, ever.

## `above_ui_floor`, and why not just fix the name

Renaming `ui_highlight` → `above_ui_floor` in the three replay harnesses
(and `by_category_highlight` → `by_category_above_ui_floor` in the sweep)
is not cosmetic. A harness **cannot** evaluate what was highlighted:

- the star-label bypass needs a label the continuous-edge era doesn't have;
- the ML display path compares the **live** edge, and there is no history
  of the market as it stood when the operator looked.

So the honest name for what a replay can compute is "cleared the UI's
floor at emit time". `highlightsOnFrozenEdge` is that; `highlightsForDisplay`
is the card's rule, and only the browser can call it meaningfully.

Back-compat: `betSelection: 'ui_highlight'` is still accepted (normalised
at both the route and the engine), and `aboveFloorBuckets()` in
`routes/api.js` reads either key, so the two stored June runs still
summarize. Without that, their summaries would have silently reported a
0-0 record rather than failing.

## `by_category_bet`

New bucket in the three replay harnesses, keyed on `bet_line IS NOT NULL`
joined on `(game_date, game_id, signal_type, signal_side)` — the values
match exactly, verified before shipping (ML away 835 / home 683, Total
over 487 / under 727). Implementation in `utils/logged-bets.js`.

Measured n per category (local copy promoted from prod 2026-09-14):

**frv, 2026-08-01..08-31, 414 games scored, 95 logged bets in window**

| track | all | ml_fav | ml_dog | tot_over | tot_under |
|---|---|---|---|---|---|
| emit_floor (B) | 436 | 109 | 120 | 132 | 75 |
| above_ui_floor (B) | 137 | 85 | 49 | **0** | **3** |
| by_category_bet (B) | 62 | 22 | 24 | 8 | 8 |
| emit_floor (C) | 426 | 87 | 128 | 143 | 68 |
| above_ui_floor (C) | 120 | 63 | 55 | 0 | 2 |
| by_category_bet (C) | 58 | 19 | 23 | 8 | 8 |

ROI on config B, same window: **2.14%** on bets placed, **16.62%** above
the UI floor, 10.92% at the emit floor. Three populations, three answers.

**temp, 2026-08-20..08-31** — `emit_floor` 82, `above_ui_floor` **0**,
`by_category_bet` 16 (8 over / 8 under).

**runmult, 2026-08-24..08-31** — `emit_floor` 51, `above_ui_floor` **1**,
`by_category_bet` 13 (6 over / 7 under).

Those last two are the finding in its sharpest form: the two totals
harnesses' above-floor track is empty or near-empty on a recent window,
because `overs_enabled=false` deletes every over and 7.0pp admits almost
no unders — while 16 and 13 totals bets respectively were actually placed
in those same windows. A bucket with n=0 cannot be read as "what was
bet", and for months it sat beside the emit-floor numbers as though it
could.

62 of 95 logged bets matched config B's signals in the frv window; the
other 33 are bets on (date, game, side) pairs this config does not
re-emit. `by_category_bet` is an intersection, not a replay of the bet
log, and the n is small: read the counts before the ROI.

**Not added to `parameter-sweep`.** A sweep scores counterfactual
settings; the bets were placed under production settings. Intersecting a
hypothetical config with the real bet log would credit that config with
choices it never produced.

## What changes in published numbers

Populations are unchanged. The equivalence test compares the retired
harness rule and the retired client rule against the module over all
2,732 `bet_signals` rows: **zero disagreements**.

One intentional divergence, inert on this corpus: an ML signal whose
`market_line` is 0 or NULL used to take the dog branch in the harnesses
(so a large enough edge cleared a direction floor with no direction) and
returned false in the client. The module follows the client. There are
**0** such rows in `bet_signals`; `game_log` has 20 rows with a NULL
`market_away_ml`, none of which produce such a signal.

Every result the three replay harnesses have published keeps its numbers.
What changes is the key those numbers arrive under, and what the key
claims.

## Two stored sweep runs, marked

`run_id 66790616` (2026-06-10 12:16, ml, 05-20..06-04) and `8c6bac11`
(2026-06-10 12:34, ml, 05-20..06-09) ranked with
`betSelection='ui_highlight'`. They ranked combos on the display
population. Not re-run, numbers not restated — they are valid above-floor
rankings. `summarizeSweepRunRow` now attaches a `bet_selection_caveat` to
any read of a run ranked that way, which is the only place a correction
can ride on a result already stored in the prod DB.

## Files

New: `utils/highlight-gate.js`, `utils/logged-bets.js`,
`scripts/test-highlight-gate.js`, this doc,
`docs/mojibake-star-labels-open-question-2026-09-17.md`.

Changed: the four harnesses, `routes/api.js`, `public/index.html`,
`server.js` (serves the module at `/highlight-gate.js` from `utils/`, no
copy in `public/`), `scripts/test-live-edge-highlight.js` (stopped being a
ninth copy — it now requires the module),
`scripts/rank-parallel-implementations.js`,
`services/feature-gate-registry.js` (three rows amended).
