# PARKS.cfDir audit

Home-plate-to-CF compass bearing in `services/weather.js`. Used by
`calcWindFactor` to compute in/out/cross alignment against wind
direction. Wrong `cfDir` values silently attenuate (or, worst-case,
invert) the wind signal on aligned winds — worst at the highest-
sensitivity parks (Wrigley `sens=2.0`, Fenway `sens=1.5`, Citizens
Bank `sens=1.5`).

## Current state — see the code

The per-park bearings and their per-batch history live in the
`PARKS` comment block at the top of `services/weather.js`. **That
comment is the authoritative log.** Prior versions of this document
carried tier tables and per-park status, but they went two batches
out of date; the tables have been removed to prevent divergence.

Summary as of 2026-08-18:

- **22 open-air parks — all with measured bearings.** Batch 1
  (2026-07-22) fixed Wrigley; batch 2 (2026-08-11) measured 9 parks +
  refined Wrigley from home-plate + CF-fence coordinates; batch 3
  (2026-08-18) measured the remaining 7 open-air parks (nym, min,
  atl, col, lad, laa, sd).
- **8 roofed / fixed-dome parks — intentionally on 45° placeholder**
  (tor, mia, mil, ari, sea, tex, hou, tb). Closed roofs mean no wind
  reaches the field, so `cfDir` is unused for those cohorts.
- **Method:** great-circle initial bearing from home-plate to
  center-field coordinates read off Google Maps satellite,
  `atan2(sin(Δλ)·cos(φ₂), cos(φ₁)·sin(φ₂) − sin(φ₁)·cos(φ₂)·cos(Δλ))`.
  Home→CF haversine distance used as a sanity check — every measured
  bearing landed in the 395–415 ft window that MLB CF distances
  span. Home-plate coords also pinned into `PARKS[key].lat/lng` so
  the weather-fetch cell is centered on the field, not the ~1 km
  Open-Meteo grid centroid.
- **Reproducibility artifacts:** `tmp/audit-park-cf-bearings.js`
  (batch 1/2 tool) and `tmp/verify-batch3-bearings.js` (batch 3
  coord pairs + independent atan2/haversine verification).

## Methodology

1. **Bearing convention:** compass degrees from true north, measured
   clockwise, in the direction from home plate toward center field.
   Wikipedia's stadium infoboxes use this convention explicitly under
   "orientation".
2. **When multiple sources disagree:** prefer direct satellite
   measurement of home-plate and CF-fence coordinates (physical
   ground truth) over Wikipedia (sometimes cites older park
   configurations). This is the method used by batches 2 and 3.
3. **When re-checking Wrigley or Fenway** (parks with famous
   orientation quirks): the compass bearing FROM home plate TOWARD CF
   is what we store, NOT the foul-line bearing or the outfield-fence
   normal. Wrigley's foul lines run roughly N-S / E-W but the CF
   direction lands at ~38° due to the field's rotation within the
   block.
4. **Duplicate keys** (`oak`+`ath`, `kan`+`kc`, `sfg`+`sf`): keep
   the aliased rows IDENTICAL. When we verify or re-measure one,
   update both keys in the same edit. Aliases exist because
   `services/weather.js` reads by raw home-team key at read time and
   several team keys have multiple canonical spellings across data
   sources.

## Downstream — sens audit is now unblocked

The per-park `sens` values in `PARKS` came from an external paste
(commit `6cb8f32`, BallparkPal / KevinRothWx research) and have
never been validated against our own residuals. That audit was
deliberately gated on batch 3 landing, because fitting `sens` with
placeholder `cfDir=45` confounds bearing error into the wind-
sensitivity coefficient — a park whose true bearing is 159° being
scored against a 45° reference would show a near-zero or inverted
wind response even if its true `sens` were correct.

With batch 3 landed, all 22 open-air parks have measured bearings
and the audit can run. Harness: `tmp/sens-audit-harness.js`. Design
notes at the top of that file. Report only until the numbers are
reviewed.
