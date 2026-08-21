# SEA canopy roof — scope, evidence, and the per-channel gate (2026-08-20)

**Status:** shipped. Branch `fix/unsealed-closed-temp-multiplier`.
Verification harness: `tmp/verify-per-channel-roof-gate.js`.

Scoping question was: does T-Mobile Park's retractable roof need
special treatment, and if so what treatment — given `roofMult = 0` is
wrong per `roof-prior.js`, but full outdoor weather is also wrong.

Short answer: **yes for temperature, no for wind.** The single
`roofMult` was doing one thing to two channels that behave differently.
Temperature at a closed SEA game is measurably outdoors. Wind is not
measurable at all from any source we have.

## 1. Historical roof state was not trustworthy

`data/mlb.db` snapshot 2026-08-11, 54 SEA home rows:

| roof_confidence | roof_status | n |
|---|---|---|
| estimated | open | 28 |
| actual | open | 24 |
| estimated | (null) | 2 |

Zero closed — which is wrong. The universal corrector
(`services/roof-correct.js`, invoked from `jobs.js` inside
`runWeatherJob`) wrote its first SEA `actual` on **2026-06-16**. SEA's
last real closure was **2026-05-29**. Every 2026 closure happened
before ground truth existed, and the June–August window the corrector
does cover is Seattle's dry season.

The `estimated` rows carry no information either: `rollForwardPrior`
hard-codes SEA to default-open, so `estimated/open` means "never
looked", not "observed open".

Two further gaps: 10 April SEA rows have `venue_id` and `game_pk` NULL,
so `selectCandidates` cannot see them at all; and the DB starts
2026-04-10 while the season started 2026-03-26.

## 2. statsapi `weather.condition` is reliable, not inference

Pulled all 442 completed home games at the 7 retractable parks for
2026. The vocabulary is small and disjoint:

- Closed → `"Roof Closed"` (441 of 442 closed cases) or `"Dome"` (1, MIA).
- Open → sky condition: `Clear`, `Partly Cloudy`, `Sunny`, `Cloudy`, `Overcast`.

No open-state string contains `"closed"` or `"dome"`, so the
corrector's substring match produced **zero false positives** across the
season. The field *replaces* sky condition when the roof is closed, so
sky is lost, but `weather.temp` and `weather.wind` arrive separately.

## 3. Closure counts — 4 seasons, not a rounding error

| season | closed / home games |
|---|---|
| 2023 | 17 / 81 (21.0%) |
| 2024 | 15 / 81 (18.5%) |
| 2025 | 10 / 81 (12.3%) |
| 2026 | 8 / 62 (12.9%) |
| **total** | **50 / 305 (16.4%)** |

2026 closures by month: Mar 1/6, Apr 4/11, May 3/15, **Jun–Aug 0/30**.
Closures are a spring phenomenon and disappear entirely after May.

As a *historical* cleanup this is small — 6 mislabeled rows exist in the
DB (2 of the 8 predate it), carrying ~2.75 runs of total weather
adjustment, and weather only feeds `estTot`, never the moneyline. That
alone would not justify a fix.

## 4. The bug was dormant, not historical

The corrector runs daily with a 14-day lookback. It never fired on a
closed SEA game in 2026 purely because it went live *after* the last
closure. Next March–May it will fire on ~7-8 games, flip them
open→closed, and the old single `roofMult` would have zeroed both
channels — the exact treatment `roof-prior.js` documents as wrong for
SEA. The DB currently holds the *full-outdoor* treatment by accident,
because the label is wrong. Correcting the label without fixing the
multiplier would have made those games worse.

That deadline is what justified the fix.

## 5. Temperature: ×1, measured

50 closed SEA games spanning 2023-2026, each paired with ERA5 outdoor
reanalysis at the same park-local hour via the production fetcher
(`fetchWindAtCoords`, `archive: true`) so both sources use identical
hour indexing:

| subset | n | median(statsapi temp − ERA5 outdoor) |
|---|---|---|
| SEA closed | 50 | **+0.2°F** |
| SEA open | 255 | +0.3°F |

A closed SEA game is thermally identical to an open one. For contrast,
on closed games the sealed parks report a fixed indoor temperature —
HOU 73°F on all 64, TEX 74°F on all 56, MIA 72°F on all 59 — and MIL
runs +10.0°F over ERA5, TOR +14.2°F.

So `tempMult = 1` for a canopy venue is an observation, not a chosen
constant.

## 6. Wind: left at ×0, and deliberately not measured

See `docs/unsealed-roof-wind-multiplier-open-question-2026-08-20.md`.
Summary: statsapi reports 0 mph on 70% of closed SEA games while ERA5
shows 8.1 mph median outdoors at the same hour, so those zeros are
nulls rather than readings; and the 15 games that do carry a non-zero
reading are statistically indistinguishable from open games
(permutation p = 0.34). No multiplier is extractable. Wind stays at the
historical ×0 and the question is logged.

## 7. What shipped

`services/weather.js:roofChannelMults` — new shared per-channel table,
the single source of truth for the roof gate:

| roof state | windMult | tempMult |
|---|---|---|
| closed, venue on canopy allowlist (SEA) | 0 | **1** |
| closed, anything else (incl. NULL venue) | 0 | 0 |
| partial | 0.5 | 0.5 |
| open / null / unrecognized | 1 | 1 |

`services/roof-prior.js:UNSEALED_ROOF_VENUE_IDS` — explicit allowlist,
`{680}`. It is an allowlist by design; see §8.

`services/temp-backtest.js:gateByRoof` — was a second, independent copy
of the gate (`closed → 0`, no sealed check). Now delegates to
`roofChannelMults`. Without this the temp-formula sweep would have
gated differently from production and measured the gate rather than the
formula.

## 8. The mistake worth recording

The first draft derived "unsealed" as *absent from
`SEALED_DOME_VENUE_IDS`*. The DB replay in the verification harness
caught it immediately: **26 rows changed, none of them SEA.** They were
19 closed Tropicana Field rows (a *fixed* dome — that set enumerates
the seven retractables and has never contained it) plus 7 rows carrying
a NULL `venue_id`. All would have been handed full outdoor temperature
adjustment inside climate-controlled buildings.

The fix is the allowlist: anything not explicitly listed keeps the
historical ×0, so an unrecognized, fixed-dome, or NULL venue fails safe.
`Number(null) === 0` and `Number(undefined) === NaN`, neither in the
set.

Generalized: **`SEALED_DOME_VENUE_IDS` is an enumeration of
retractables, not a registry of sealed venues, and must never be
inverted.** See `docs/roof-gate-inert-sealed-set-2026-08-20.md`.

## 9. Verification

`tmp/verify-per-channel-roof-gate.js` — 27 assertions, all passing:

- **A** multiplier table across all 7 roofed venues, Tropicana, a
  non-roofed park, and null/unknown status and venue.
- **B** old-vs-new differential over a 7,680-combination synthetic grid.
  `wind_factor` changes in **0**; the only changed key is
  `sea/closed/temp`.
- **C** replay over all 1,518 weather-bearing DB rows: **0 stored rows
  change**, confirming zero regression (and confirming §1 — the DB holds
  no SEA-closed rows to change).
- **D** dormant-bug replay: the 6 in-DB 2026 SEA closures scored under
  the label the corrector will write. 5 of 6 keep a −0.5 `temp_run_adj`
  that the old gate zeroed; all 6 keep `wind_factor` at 0.

`scripts/test-roof-stage2.js` also re-run — all passing, unchanged.

## 10. Not done

- **The 6 mislabeled 2026 rows are not backfilled.** They sit outside
  the corrector's 14-day lookback so nothing will revisit them. Now
  safe to correct if wanted; low value on its own.
- **Pre-2026 seasons are not in the DB**, so the 2023-2025 closures are
  evidence only, not rows to fix.
- **Wind multiplier** — logged, see §6.

## Related

- `docs/unsealed-roof-wind-multiplier-open-question-2026-08-20.md`
- `docs/roof-gate-inert-sealed-set-2026-08-20.md`
- `docs/mil-sealed-dome-classification-2026-08-20.md`
- `services/roof-correct.js` — the post-game corrector.
- `services/roof-prior.js` — priors + both venue sets.
