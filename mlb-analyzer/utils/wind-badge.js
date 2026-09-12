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
const PLACEHOLDER_BEARING_KEYS = new Set(['tor', 'mia', 'mil', 'ari', 'sea', 'tex', 'hou', 'tb']);

function angleDiffDeg(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

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
  };

  // A park that cannot open is indoors on every date, whatever
  // roof_status says. Tropicana has been writing roof_status='open' at
  // confidence 'estimated' all season; see the fixedDome note in
  // services/weather.js.
  if (park && park.fixedDome) {
    return Object.assign(base, { reason: 'fixed_dome', label: 'Roof closed' });
  }
  if (roofStatus === 'closed') {
    return Object.assign(base, { reason: 'roof_closed', label: 'Roof closed' });
  }
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(dir) || !park) {
    return Object.assign(base, { reason: 'no_wind_data' });
  }

  const strength = strengthFor(speed);
  const measured = !PLACEHOLDER_BEARING_KEYS.has(homeKey);
  const mph = Math.round(speed);

  // Placeholder bearing: strength only, no invented direction.
  if (!measured) {
    return Object.assign(base, {
      show: true, strength: strength, bearing_measured: false,
      arrow: '·', label: '· ' + mph + 'mph',
    });
  }

  const windTo = (dir + 180) % 360;             // wind FROM -> blowing TO
  const theta = angleDiffDeg(windTo, park.cfDir);
  const direction = directionFor(theta);
  const arrow = direction === 'out' ? '↗' : direction === 'in' ? '↙' : '↔';
  const word = direction === 'out' ? 'Out' : direction === 'in' ? 'In' : 'Cross';

  return Object.assign(base, {
    show: true,
    direction: direction,
    theta_deg: Math.round(theta * 10) / 10,
    strength: strength,
    bearing_measured: true,
    arrow: arrow,
    label: arrow + ' ' + word + ' ' + mph + 'mph',
  });
}

module.exports = {
  windBadge,
  DIRECTION_CONE_DEG, STRENGTH_MODERATE_MPH, STRENGTH_STRONG_MPH,
  PLACEHOLDER_BEARING_KEYS,
  _internal: { angleDiffDeg, strengthFor, directionFor },
};
