# Wind diamond on the game card (2026-09-12) — display only

A small inline SVG beside the wind badge from #383: a baseball diamond
seen from above with **centre field at the top**, and an arrow rotated to
where the wind is blowing relative to that bearing. Straight up = straight
out, straight down = straight in. Original artwork, our own markup, no
third-party assets and no network references.

## One angle, so the arrow and the label cannot disagree

`utils/wind-badge.js` now computes a **signed** bearing difference once:

```
rotation_deg = signedDiffDeg(windTo, park.cfDir)   // (-180, 180]
theta_deg    = |rotation_deg|
direction    = directionFor(theta_deg)             // <=60 out, >=120 in, else cross
```

The badge's word comes from `theta_deg`; the arrow's `transform="rotate(...)"`
consumes `rotation_deg` verbatim. There is deliberately **no second angle
computed in the card**, and `scripts/test-wind-diamond.js` asserts that
three ways: `|rotation| === theta` and `directionFor(|rotation|) === direction`
over a **full 360° sweep at every measured-bearing park** (7,920
park × bearing combinations), plus a source check that the card block
contains no `Math.atan2/cos/sin/tan` at all.

Sign convention, stated because getting it wrong is invisible: compass
bearings increase clockwise from north, SVG `rotate()` is also clockwise,
and centre field is drawn straight up — so the value needs no flip at the
render site. `rotate(+36)` for the `PIT @ CHC` case puts the arrow 36°
clockwise of straight-up, which is out toward right-centre.

## Strength

Length **and** weight both scale, because at a 46px glyph length alone is
too subtle and weight alone reads as a colour change:

| tier | speed | arrow length | stroke width |
|---|---|---|---|
| weak | < 8 mph | 9 | 1.5 |
| moderate | 8–14 mph | 13 | 2.25 |
| strong | ≥ 15 mph | 17 | 3 |

Exported as `ARROW_GEOMETRY` so the test asserts against the same constants
the renderer uses rather than re-stating them.

## The three special cases

- **`bearing_measured: false`** (the 8 roofed parks on the deliberate 45°
  placeholder, `docs/park-bearings-audit.md`) → **no arrow**, speed and
  compass direction only, with a small italic *"bearing unverified"* hint.
  An arrow there would be a drawing of a number we do not have.
- **Roof closed or `fixedDome`** → **dome glyph** (an arc, a base line and a
  centre post), no arrow, text *"Indoors / no wind"*. Nothing is blowing on
  the field, so there is no direction to draw.
- **No wind data** → nothing renders.

## Text beside the glyph

Line 1 is `<b>13 mph</b> WSW`, line 2 is `85°F`.

**The compass abbreviation names where the wind comes FROM** — the
meteorological convention every public source uses ("a WSW wind") — while
the **arrow** points where it is blowing TO, relative to centre field. Both
are exposed on the descriptor (`from_abbr`, `to_abbr`) so the render site
never does trigonometry, and the tooltip spells out the whole chain:
`wind from WSW, blowing to ENE · CF bearing 38° · rotation 36°`.

**Humidity is omitted because it is not stored.** `game_log` has no
humidity column and `fetchWindAtCoords` never requests
`relative_humidity_2m` from Open-Meteo. The descriptor carries
`humidity_pct: null` explicitly so the card renders nothing rather than
`undefined`, and so adding it later is an ingest change with exactly one
render site to update.

## Colour: one palette, and it repaints the badge

The brief asked for green Out / red In / neutral Cross **matching the
badge**. Those could not both hold: #383 shipped the badge as Out = red
`#b91c1c`, In = blue `#1d4ed8`. Rather than leave the two glyphs
disagreeing, both now read from one set of CSS custom properties:

```css
:root{
  --wind-out-bg:rgba(22,163,74,.12); --wind-out-fg:#15803d; --wind-out-br:rgba(22,163,74,.3);
  --wind-in-bg:rgba(220,38,38,.12);  --wind-in-fg:#b91c1c;  --wind-in-br:rgba(220,38,38,.3);
}
```

So **the badge changes colour in this PR**: Out red → green, In blue → red.
That is the one thing here that goes beyond "add a diamond", and it is the
only way to satisfy "matching the badge". To revert, restore
`--wind-out-*` to `rgba(220,38,38,*)` / `#b91c1c` and `--wind-in-*` to
`rgba(37,99,235,*)` / `#1d4ed8` — nothing else references these colours.

## Pricing untouched

`wind_factor` is not read by the helper, the API call site or the card
block, and the diamond derives from the measured bearing rather than from
`sens`. The test asserts the file-level claim directly: the set of files
changed against `origin/main` must contain no pricing-path file
(`services/model.js`, `services/weather.js`, `db/schema.js`,
`services/jobs.js`, `services/parameter-sweep.js`, `services/roof-prior.js`,
the four backtest harnesses) and must be a subset of a display allowlist.

That check initially **passed vacuously**: written as
`git diff origin/main...HEAD` it returned an empty list before the commit
existed, so both assertions were evaluated on nothing. It now diffs the
working tree against `origin/main` and **fails when it has nothing to
inspect**, because a checker that reports OK after looking at nothing is
the failure mode CLAUDE.md names.

## Known duplication, not fixed here

For an open-roof game the card now shows the temperature twice: the
existing temp badge (`☀️ 85°F`) and the diamond's second line. The brief
asked for temperature beside the diamond, so it is there; dropping the
separate badge is a one-line follow-up if you want it. The temp badge
already hides itself on closed roofs, so the dome case shows it once.

## Verification

```
node scripts/test-wind-diamond.js     # 31 checks, exit 0
```

Full 360° × 22-park rotation/word sweep; up-is-out and down-is-in
orientation including the exact 0° and 180° cases; the `PIT @ CHC +36 out`
founding case; mirror-bearing sign check; strength monotonicity against the
exported constants; all three special cases; compass boundaries at the
11.25° multiples; the display-only source checks; SVG tag balance; and the
changed-file allowlist.

Both inline `<script>` blocks in `public/index.html` were syntax-checked
with `node --check` after the edit (284,551 chars across 2 blocks, both
parse), since a broken template string would render the whole card blank.

Today's slate through the descriptor, as a spot check:

```
pit-chc  13mph from WSW  rot  +36  out    moderate  len13/w2.25
sd-sf    18mph from WNW  rot  +18  out    strong    len17/w3
col-det   4mph from SSW  rot -121  in     weak      len9/w1.5
laa-was   8mph from ESE  rot  -92  cross  moderate  len13/w2.25
bal-tor   8mph from E    (placeholder bearing — speed only, no arrow)
hou-tb    4mph           (fixed dome — dome glyph)
```
