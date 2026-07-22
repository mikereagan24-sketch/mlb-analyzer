# PARKS.cfDir audit (2026-07-22)

Home-plate-to-CF compass bearing in `services/weather.js`. Used by
`calcWindFactor` to compute in/out/cross alignment against wind
direction. Wrong `cfDir` values silently attenuate (or, worst-case,
invert) the wind signal on aligned winds — worst at the highest-
sensitivity parks (Wrigley `sens=2.0`, Fenway `sens=1.5`, Citizens
Bank `sens=1.5`).

## Current state

Audit tool: `tmp/audit-park-cf-bearings.js`. 32 entries in `PARKS`
(30 physical parks + 2 duplicate keys — `oak`/`ath` both point at
Oakland Coliseum, `kan`/`kc` both point at Kauffman). Breakdown:

| Flag                     | Count | Notes                                                        |
|--------------------------|-------|--------------------------------------------------------------|
| `[OK]` verified          | 2     | Fenway 75°, Oracle 90° cross-checked against Wikipedia       |
| `[SUSPICIOUS]`           | 1     | Wrigley 60° → fixed to 33° in this PR                        |
| `[UNAUDITED]` non-45°    | 3     | PIT, CWS, STL — set explicitly at some point but unverified  |
| `[PLACEHOLDER 45°]`      | 26    | Default scaffold value; needs per-park verification          |

## Fixed in this PR

- **Wrigley Field (chc)**: `60° → 33°`. Wikipedia's Wrigley Field
  infobox and multiple ballpark-survey references put home-plate-to-CF
  at ~33° NNE (the field faces NE with foul lines at roughly 20°/106°
  and CF between them). Old 60° was ~27° off, which attenuated aligned
  in/out signal by ~10-15%. Not a direction flip — cos(152°) ≈ -0.88
  vs cos(180°) = -1.0 — so wind-blowing-in still registered as blowing
  in, just with reduced magnitude. Effect scaled by the sens=2.0
  multiplier, so this was silently muting the highest-leverage wind
  signal in the league.

## Not fixed in this PR — needs verification against authoritative source

For each row below: **look up the park's Wikipedia infobox
"orientation" field** (or equivalent from ballparks.com / OSM survey
diagram / MLB.com stadium factsheet). Enter the verified bearing in
the `Verified` column with the source in `Source`. Once every row is
filled, ship a follow-up PR updating `services/weather.js` in one
batch with the change log.

**Prioritize by sensitivity** (higher = more wind leverage per game):

### Tier 1 (sens ≥ 1.5) — highest leverage

| Team | Park                | Current | Verified | Source | Notes                                    |
|------|---------------------|---------|----------|--------|------------------------------------------|
| phi  | Citizens Bank Park  | 45°     |          |        | Placeholder. Public survey suggests ~35°? |
| bos  | Fenway Park         | 75°     | ✅ 75°   | Wikipedia infobox | Cross-checked; do not change. |

### Tier 2 (sens 1.0–1.3) — significant leverage

| Team | Park              | Current | Verified | Source | Notes                                              |
|------|-------------------|---------|----------|--------|----------------------------------------------------|
| det  | Comerica Park     | 45°     |          |        | Placeholder                                        |
| cle  | Progressive Field | 45°     |          |        | Placeholder                                        |
| oak  | Oakland Coliseum  | 45°     |          |        | Placeholder — mirror value to `ath` key            |
| ath  | Oakland Coliseum  | 45°     |          |        | Same physical park as `oak`; keep values in sync   |
| kan  | Kauffman Stadium  | 45°     |          |        | Placeholder — mirror value to `kc` key             |
| kc   | Kauffman Stadium  | 45°     |          |        | Same physical park as `kan`; keep values in sync   |
| pit  | PNC Park          | 30°     |          |        | Explicit but unverified. PNC faces NE toward downtown/Ohio River; if survey shows ~60°, this is 30° off. |
| nyy  | Yankee Stadium    | 45°     |          |        | Placeholder. Wikipedia gives an orientation figure. |
| bal  | Camden Yards      | 45°     |          |        | Placeholder                                        |
| was  | Nationals Park    | 45°     |          |        | Placeholder                                        |
| cin  | Great American    | 45°     |          |        | Placeholder                                        |
| cws  | Guaranteed Rate   | 5°      |          |        | Explicit but unverified. 5° is very close to due N — plausible for a S-side ballpark but worth confirming. |
| stl  | Busch Stadium     | 25°     |          |        | Explicit but unverified. Gateway Arch alignment gives HP roughly SE-facing → CF ~NNE, ~15-30° plausible. |

### Tier 3 (sens 0.5–0.8) — moderate

| Team | Park           | Current | Verified | Source | Notes         |
|------|----------------|---------|----------|--------|---------------|
| atl  | Truist Park    | 45°     |          |        | Placeholder   |
| min  | Target Field   | 45°     |          |        | Placeholder   |
| laa  | Angel Stadium  | 45°     |          |        | Placeholder   |
| sea  | T-Mobile Park  | 45°     |          |        | Placeholder (retractable roof — bearing still matters when open) |
| col  | Coors Field    | 45°     |          |        | Placeholder   |
| lad  | Dodger Stadium | 45°     |          |        | Placeholder   |
| tb   | Tropicana      | 45°     |          |        | Placeholder (dome — sens 0.5 already low) |

### Tier 4 (sens ≤ 0.4) — low leverage

| Team | Park           | Current | Verified | Source | Notes                                          |
|------|----------------|---------|----------|--------|------------------------------------------------|
| sfg  | Oracle Park    | 90°     | ✅ 90°   | Wikipedia infobox | East-facing toward SF Bay; verified |
| tor  | Rogers Centre  | 45°     |          |        | Dome                                           |
| sd   | Petco Park     | 45°     |          |        | Placeholder                                    |
| nym  | Citi Field     | 45°     |          |        | Placeholder                                    |
| mil  | American Family| 45°     |          |        | Dome                                           |
| ari  | Chase Field    | 45°     |          |        | Dome                                           |
| mia  | LoanDepot Park | 45°     |          |        | Dome, sens 0.1                                 |
| tex  | Globe Life     | 45°     |          |        | Retractable, sens 0.1                          |
| hou  | Minute Maid    | 45°     |          |        | Retractable, sens 0.1                          |

## Follow-up PR template

Once verifications are entered above, the follow-up ships as one diff
to `services/weather.js` with per-line comments like:

```js
// cfDir corrected 2026-XX-XX (audit/park-cf-bearings follow-up):
// was 45° placeholder → NN° per <source>. Attenuation impact:
// <estimate based on median wind angle × sens>.
'det': { lat:..., lng:..., cfDir: NN, sens:1.2, name:'Comerica Park' },
```

Change log at the bottom of the PR body — one row per park with
`before → after` and source. `audit/park-cf-bearings` PR structure is
the template.

## Notes on methodology

1. **Bearing convention**: compass degrees from true north, measured
   clockwise, in the direction from home plate toward center field.
   Wikipedia's stadium infoboxes use this convention explicitly under
   "orientation".
2. **When multiple sources disagree**: prefer OSM survey diagrams
   (physical measurements from aerial imagery) over Wikipedia
   (sometimes cites older park configurations).
3. **When re-checking Wrigley or Fenway** (parks with famous
   orientation quirks): the compass bearing FROM home plate TOWARD CF
   is what we store, NOT the foul-line bearing or the outfield-fence
   normal. Wrigley's foul lines run roughly N-S / E-W but the CF
   direction lands at ~33° due to the field's rotation within the
   block.
4. **Duplicate keys** (`oak`+`ath`, `kan`+`kc`): keep the two rows
   IDENTICAL. When we verify Oakland or Kauffman, update both keys in
   the same edit. Consider consolidating in a future refactor —
   `services/weather.js` already normalizes team key at read time
   (`teamKey = homeTeam.toLowerCase().replace(/[^a-z]/g, '')`), so
   the alias only exists because someone was defensive.

## Post-audit wind-attribution note

Per PR `fix/weather-tz-park-local`: all pre-TZ-fix wind data on
non-ET parks was fetched for the wrong hour. The `cfDir` fixes here
compound with that — the run-conversion audit's small wind
attribution should NOT be re-measured until (a) TZ fix has been live
long enough for fresh data to accumulate AND (b) at least Tier 1 +
Tier 2 `cfDir` values are verified. Mixing corrupt-hour + wrong-bearing
data with correct-hour + correct-bearing data would give a
meaningless average.
