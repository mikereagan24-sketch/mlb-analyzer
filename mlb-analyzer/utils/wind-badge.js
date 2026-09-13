// Wind badge classification for the game card (2026-09-12). DISPLAY ONLY.
//
// WHY THIS EXISTS. The card used to derive its direction word by
// thresholding |wind_factor| >= 0.08 (public/index.html:1682). That is not
// a direction test: wind_factor is cos(theta) * speedFactor * sens, so the
// implied cone was a function of SPEED and PARK SENS. Consequences, both
// measured over 2026-08-13..09-12 (114 games, wind >= 8, roof not closed):
//
//   - 49 games labelled "Cross" that a +/-60 degree cone calls Out or In
//     (37 Out, 12 In), mean |wind_factor| 0.0268.
//   - Below roughly 9-12 mph (park-dependent) EVERY wind read Cross,
//     including dead-straight-out. A 13.6 mph wind at theta=9 degrees at
//     Oracle Park (sens=0.3) read Cross (col-sf 2026-08-14).
//   - sens is an unvalidated external paste (docs/park-bearings-audit.md),
//     so the old cone width inherited a number nobody has checked.
//
// So direction now comes from the ANGLE, which is measured, and strength
// comes from the SPEED. Two separate questions, two separate outputs.
//
// THIS MODULE MUST NEVER READ wind_factor. It does not accept it as an
// argument, and scripts/test-wind-badge.js asserts both that the source
// contains no reference to it and that the output is invariant to it.
// wind_factor and every pricing path are untouched by this file.

const DIRECTION_CONE_DEG = 60;      // |theta| <= 60 -> out, >= 120 -> in
const STRENGTH_MODERATE_MPH = 8;    // < 8 weak
const STRENGTH_STRONG_MPH = 15;     // >= 15 strong

// The 8 parks deliberately left on the 45-degree placeholder cfDir
// (retractables + Tropicana) per docs/park-bearings-audit.md: a closed
// roof means no wind reaches the field, so the bearing is unused for
// those cohorts and leaving the placeholder is intentional. With the roof
// OPEN the placeholder is live and theta is meaningless, so the badge
// reports strength only rather than inventing a direction. Do NOT "fix"
// these bearings to make a direction appear — that would undo a
// deliberate choice from the three bearing batches.
// BATCH 4a (2026-09-12) removed sea and mil: both are measured now (48deg
// and 128deg), so they get a real arrow. They were the two that most
// needed it -- sea plays roof-open on 97% of home games and mil on 55%,
// and mil's placeholder had the wind backwards on 5 of its 19 roof-open
// windy games.
const PLACEHOLDER_BEARING_KEYS = new Set(['tor', 'mia', 'ari', 'tex', 'hou', 'tb']);

function angleDiffDeg(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// SIGNED bearing difference, normalised to (-180, 180]. This is the ONE
// number the whole widget turns on (2026-09-12): the diamond's arrow is
// rotated by it and the direction word is derived from its magnitude, so
// the arrow and the label cannot disagree by construction. Do not add a
// second angle computation anywhere — scripts/test-wind-diamond.js asserts
// |rotation_deg| === theta_deg and that the word matches the rotation.
//
// Sign convention: compass bearings increase CLOCKWISE from north, and
// SVG's rotate() is also clockwise, with centre field drawn straight up.
// So a wind blowing 40 degrees clockwise of centre field is rotate(+40)
// and needs no sign flip at the render site.
function signedDiffDeg(a, b) {
  let d = ((a - b) % 360 + 360) % 360;   // [0, 360)
  if (d > 180) d -= 360;                 // (-180, 180]
  return d;
}

// 16-point compass abbreviation. Used for the TEXT beside the diamond,
// which names the direction the wind comes FROM -- the meteorological
// convention every public source uses ("a WSW wind"). The ARROW points
// where the wind is blowing TO, relative to centre field. Both are
// exposed so the render site never has to do trigonometry.
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass16(deg) {
  if (!Number.isFinite(deg)) return null;
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[i];
}

// Arrow geometry per strength tier. Length AND weight both scale so the
// tier reads at a glance on a 46px glyph; length alone is too subtle at
// this size and weight alone reads as a colour change.
const ARROW_GEOMETRY = {
  weak:     { len: 9,  width: 1.5 },
  moderate: { len: 13, width: 2.25 },
  strong:   { len: 17, width: 3 },
};

function strengthFor(mph) {
  if (mph < STRENGTH_MODERATE_MPH) return 'weak';
  if (mph < STRENGTH_STRONG_MPH) return 'moderate';
  return 'strong';
}

function directionFor(theta) {
  if (theta <= DIRECTION_CONE_DEG) return 'out';
  if (theta >= 180 - DIRECTION_CONE_DEG) return 'in';
  return 'cross';
}

// homeKey: lowercase home-team key as it appears in PARKS.
// Returns a flat, render-ready descriptor. `show:false` means the card
// draws no wind badge and `reason` says why.
function windBadge(opts) {
  opts = opts || {};
  const { PARKS } = require('../services/weather');   // lazy: avoids any load-order coupling
  const homeKey = String(opts.homeKey || '').toLowerCase();
  const park = PARKS[homeKey] || null;
  const speed = Number(opts.windSpeed);
  const dir = Number(opts.windDir);
  const roofStatus = opts.roofStatus || null;

  const base = {
    show: false, reason: null, direction: null, theta_deg: null,
    strength: null, speed_mph: Number.isFinite(speed) ? speed : null,
    cf_dir: park ? park.cfDir : null, bearing_measured: null,
    arrow: null, label: null,
    // Diamond additions (2026-09-12). rotation_deg is the SIGNED angle the
    // arrow is rotated by; dome asks the card for the dome glyph instead.
    rotation_deg: null, from_abbr: null, to_abbr: null,
    temp_f: Number.isFinite(Number(opts.tempF)) ? Number(opts.tempF) : null,
    // Humidity is NOT stored: game_log has no humidity column and the
    // Open-Meteo fetch never requests relative_humidity_2m. Carried as an
    // explicit null so the card renders nothing rather than "undefined",
    // and so adding it later is an ingest change with one render site.
    humidity_pct: null,
    dome: false, diamond: null,
  };

  // A park that cannot open is indoors on every date, whatever
  // roof_status says. Tropicana has been writing roof_status='open' at
  // confidence 'estimated' all season; see the fixedDome note in
  // services/weather.js.
  if (park && park.fixedDome) {
    return Object.assign(base, { reason: 'fixed_dome', label: 'Roof closed', dome: true });
  }
  if (roofStatus === 'closed') {
    return Object.assign(base, { reason: 'roof_closed', label: 'Roof closed', dome: true });
  }
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(dir) || !park) {
    return Object.assign(base, { reason: 'no_wind_data' });
  }

  const strength = strengthFor(speed);
  const measured = !PLACEHOLDER_BEARING_KEYS.has(homeKey);
  const mph = Math.round(speed);

  const windTo = (dir + 180) % 360;             // wind FROM -> blowing TO

  // Placeholder bearing: strength only, no invented direction, and NO
  // diamond -- there is no measured centre-field bearing to rotate
  // against, so an arrow would be a drawing of a number we do not have.
  if (!measured) {
    return Object.assign(base, {
      show: true, strength: strength, bearing_measured: false,
      arrow: '·', label: '· ' + mph + 'mph',
      from_abbr: compass16(dir), to_abbr: compass16(windTo),
    });
  }

  // ONE angle, signed, from which both the arrow and the word follow.
  const rotation = signedDiffDeg(windTo, park.cfDir);
  const theta = Math.abs(rotation);
  const direction = directionFor(theta);
  const arrow = direction === 'out' ? '↗' : direction === 'in' ? '↙' : '↔';
  const word = direction === 'out' ? 'Out' : direction === 'in' ? 'In' : 'Cross';
  const geom = ARROW_GEOMETRY[strength] || ARROW_GEOMETRY.moderate;

  return Object.assign(base, {
    show: true,
    direction: direction,
    theta_deg: Math.round(theta * 10) / 10,
    rotation_deg: Math.round(rotation * 10) / 10,
    strength: strength,
    bearing_measured: true,
    arrow: arrow,
    label: arrow + ' ' + word + ' ' + mph + 'mph',
    from_abbr: compass16(dir),
    to_abbr: compass16(windTo),
    diamond: {
      // Consumed verbatim by the card's <g transform="rotate(...)">.
      rotation_deg: Math.round(rotation * 10) / 10,
      arrow_len: geom.len,
      arrow_width: geom.width,
      tone: direction,          // 'out' | 'in' | 'cross' -> CSS palette
    },
  });
}

module.exports = {
  windBadge,
  DIRECTION_CONE_DEG, STRENGTH_MODERATE_MPH, STRENGTH_STRONG_MPH,
  PLACEHOLDER_BEARING_KEYS, ARROW_GEOMETRY,
  _internal: { angleDiffDeg, signedDiffDeg, strengthFor, directionFor, compass16 },
};
