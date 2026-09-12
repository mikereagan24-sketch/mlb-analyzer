# Wind badge: direction from angle, strength from speed — and a fixed-dome flag (2026-09-12)

Two changes. One is display-only. One touches the pricing path and is
deliberately narrow.

## 1. The badge (display only)

**Before**, `public/index.html:1682` derived the direction word by
thresholding the model's own number:

```js
if(fac>=0.08){label='↗ Out '...}  else if(fac<=-0.08){label='↙ In '...}  else{'↔ Cross '...}
```

`wind_factor` is `cos(theta) * speedFactor * sens`, so that test is not a
direction test — its implied cone is a function of **speed** and of
**park `sens`**. Measured over 2026-08-13 → 09-12 (114 games, wind ≥ 8 mph,
roof not closed):

| ours / ±60° cone | n |
|---|---|
| Cross / Out | 43 |
| Cross / In | 17 |
| Cross / Cross | 25 |
| Out / Out | 20 |
| In / In | 9 |

**49 games** labelled Cross that a ±60° cone calls directional (37 Out,
12 In) once the 11 placeholder-bearing games are set aside; mean
`|wind_factor|` on them 0.0268. Below roughly 9–12 mph — park-dependent —
*every* wind read Cross, including dead-straight-out. Worst single case:
`col-sf 2026-08-14`, 13.6 mph at **theta = 9°**, read Cross because Oracle
Park's `sens` is 0.3.

**After**, the two questions are answered separately:

- **Direction** from the angle between where the wind is blowing *to* and
  the park's measured home-plate→CF bearing: `|theta| ≤ 60°` Out,
  `≥ 120°` In, else Cross.
- **Strength** from speed alone: `< 8` weak, `8–14` moderate, `15+` strong.
  The speed stays on the badge next to the arrow; strength drives emphasis
  (`.wind-weak` / `.wind-strong`).

The classification lives in **one** place, `utils/wind-badge.js`, and is
served as `g.wind_badge` by `GET /api/games/:date`. It is computed
server-side because `cfDir` lives in `PARKS` and the browser must not
carry a second copy of it — a client-side bearing table would be the
fourth wind classifier in the codebase.

The founding case, `PIT @ CHC 2026-09-12`: wind FROM 254° → blowing TO
74°, Wrigley `cfDir` 38° → **theta 36°**, 12.8 mph → `↗ Out 13mph ·
moderate`. RotoWire, RotoGrinders and baseballwx all call that blowing out
to right-center. Under the old test the same bearing flipped to Cross
below 9.19 mph.

**`wind_factor` and every pricing path are untouched.** The helper has no
`wind_factor` parameter; `scripts/test-wind-badge.js` asserts that
structurally (no reference in the helper, the API call site, or the card
block, comments excluded) and behaviourally (passing an absurd
`wind_factor` changes nothing). The `fac` binding was removed from the
card so the value is not even in scope.

### Two rendering decisions worth naming

- **Roof closed → no wind badge.** For a genuinely closed retractable
  roof the existing roof badge already renders `🔒 Roof Closed`, so the
  wind slot stays blank rather than printing a second identical badge.
  The `🔒 Roof closed` text in the wind slot fires **only** for a fixed
  dome, which is not in that badge's `RETRACTABLE` map and would
  otherwise show nothing at all.
- **Placeholder-bearing parks show strength only.** The 8 roofed parks sit
  on `cfDir = 45` by design (`docs/park-bearings-audit.md`), so with the
  roof open there is no measured angle. The badge renders `· 8mph ·
  moderate (bearing n/a)` rather than inventing a direction. 15 roof-open
  games at those parks fell in the 30-day window.

## 2. `fixedDome` on PARKS (pricing path, narrow)

`services/roof-prior.js` says of its sealed set: *"this is an enumeration
of retractable parks, NOT a registry of every sealed venue. Tropicana
Field (12) is a fixed dome and is not in here."* That registry never
existed. This adds it as one flag on the park, not a fourth roof
mechanism, and `calcWindFactor` returns 0 for it **without consulting
`roof_status`** — because consulting `roof_status` is exactly what let
outdoor wind into a dome.

**Founding instance.** The roof scraper wrote `roof_status='open'` at
confidence `estimated` on all 15 Tropicana home games from 2026-08-14 to
2026-09-12. Three cleared the 8 mph deadband and carried a live factor:

```
bal-tb 2026-08-17   9.0 mph  dir 263   wind_factor +0.016
tor-tb 2026-08-18   9.0 mph  dir 264   wind_factor +0.016
nym-tb 2026-09-01   8.5 mph  dir  90   wind_factor -0.007
```

At `WIND_SCALE = 2.0` that is at most **0.032 runs** on the total, so the
exposure is small. The point is that the classification was wrong; the
guard makes it structurally impossible rather than incidentally harmless.

A **venue override clears the flag**: `fixedDome` is a property of the
team's home building, so a Rays game at a neutral outdoor site is
outdoors. Both override branches in `services/jobs.js` now set it
explicitly (`fixedDome: !!ov.fixedDome`) instead of inheriting it through
`Object.assign`. Without that, relocating TB would silently hold wind at 0
for an open-air game — the mirror image of the bug being fixed.

Naming: the flag is `fixedDome`, camelCase, to match the surrounding
`PARKS` keys (`cfDir`, `sens`, `lat`, `lng`) rather than the `fixed_dome`
spelling in the brief. Same concept; say so if you want the snake_case.

## 3. NOT in this PR: the temperature channel at the same park

The wind error above is the small half. The same 'open' misclassification
feeds the **temperature** channel, and `services/model.js:1389` is

```js
const estTot = Math.max(0, aRuns + hRuns + windRunAdj + tempRunAdj);
```

so `temp_run_adj` lands directly on the total, once, at full strength:

```
TB home games with roof_status='open', 2026-04-06 .. 2026-09-12
  games                     72   (69 graded)
  with non-zero temp_run_adj 72
  mean temp_run_adj       0.558 runs
  summed                   40.2 runs
```

**+0.56 runs of outdoor-heat adjustment per game, on 72 games, inside a
climate-controlled building — roughly 20× the wind error this PR fixes,
and on the totals line.** The established treatment for a sealed venue is
temp ×0 (`roofChannelMults`, with SEA's canopy the only allowlisted
exception), so a fixed dome should almost certainly be gated the same way.

It is not in this PR because it is a real pricing change of material size,
it was not what the brief asked for, and per the guard-removal and
demotion-pre-flight rules it needs its own measurement, registration, and
a decision about whether the 69 graded historical rows get re-scored or
tagged. `calcWindFactor` carries a comment pointing here so the next
reader does not conclude the temp side was considered and dismissed.

## 4. Surfaced while verifying: a bearing-regime boundary in the wind channel

Asserting "stored `wind_factor` re-derives from stored dir/speed" found 8
rows in the 30-day window that do not. None is caused by this PR. All 8
are at the **7 parks whose `cfDir` changed in bearing batch 3**
(`nym min atl col lad laa sd`, 2026-08-18): their stored factors were
computed under the old bearing and cannot re-derive under the new one.
Worked example, `mil-lad 2026-08-15`, 9.5 mph dir 246 → stored 0.029,
which is exactly `cos(21°) × 0.0625 × 0.5` at the old `cfDir = 45`, versus
0.024 at the measured 25°.

This is a **regime boundary**, the same shape as the `park_factor_source`
boundary already documented in CLAUDE.md, and it is not recorded anywhere
today. The boundary is also intra-day: `lad-col 2026-08-19` has
`weather_quality_at 2026-08-20 00:00:43Z` (17:00 PT on 08-19) and still
matches the old bearing. Any analysis that re-derives wind from stored
bearings across 2026-08-18 is pooling two regimes. Not fixed here —
flagged, and the test excludes those rows by name with the count printed
rather than dropping them silently.

## 5. Checked against the three bearing batches

The brief asked that this not undo them. It does not:

- **No bearing changed.** Wrigley stays at the measured 38° (batch 1
  fixed it, batch 2 refined it from home-plate + CF-fence coordinates),
  and the ±60° cone at theta 36° now *agrees* with the external sources —
  a bearing edit would break that agreement, not improve it.
- **The 45° placeholders stay placeholders.** The badge reports
  `bearing_measured: false` and shows strength only. Nothing here creates
  pressure to invent bearings for roofed parks, which the audit calls
  intentional.
- **Direction no longer depends on `sens`.** The audit notes `sens` came
  from an external paste (commit `6cb8f32`) and has never been validated
  against our residuals. The old badge inherited it; the new one keys on
  the angle, which is measured. That makes the display *less* dependent on
  the unvalidated parameter, and leaves the pending sens audit unaffected.

## Verification

```
node scripts/test-wind-badge.js     # 24 checks, all pass, exit 0
```

Covers the classification table and cone/strength edges, the founding
`PIT @ CHC` case at several speeds, roof and placeholder handling, the
three structural + one behavioural "cannot read `wind_factor`" assertions,
the prod-shaped no-drift assertion over stable-bearing parks (328 rows
re-derived, 63 roof-gated and 8 bearing-regime rows excluded with counts
printed), the three founding games by name, and the venue-override clear.

Today's slate rendered through the new helper: `pit-chc → ↗ Out 13mph ·
moderate (theta=36)`, `hou-tb → Roof closed` despite `roof_status='open'`,
`bal-tor → · 8mph · moderate (bearing n/a)`.
