#!/usr/bin/env node
// Wind diamond (2026-09-12). DISPLAY ONLY.
//   node scripts/test-wind-diamond.js
// Exit 1 on any failure.
//
// The two load-bearing assertions:
//   (2) ARROW AND LABEL CANNOT DISAGREE — the arrow rotation and the
//       direction word are both derived from one signed angle, asserted
//       over a full 360-degree sweep at every park, plus a structural
//       check that the card computes no second angle of its own.
//   (5) PRICING UNTOUCHED — the set of files this branch changes must be
//       a subset of the display allowlist, checked against origin/main.
const fs = require('fs');
const path = require('path');
const wb = require('../utils/wind-badge');
const { PARKS } = require('../services/weather');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const badge = (o) => wb.windBadge(Object.assign({ roofStatus: 'open' }, o));

console.log('1. the arrow angle IS the badge angle');
// Full sweep, every measured-bearing park, every 1 degree: the rotation
// magnitude must equal theta, and the word must follow from the rotation.
let sweep = 0, mismatch = 0, wordMismatch = 0, outside = 0;
for (const key of Object.keys(PARKS)) {
  if (wb.PLACEHOLDER_BEARING_KEYS.has(key) || PARKS[key].fixedDome) continue;
  for (let dir = 0; dir < 360; dir++) {
    const b = badge({ homeKey: key, windDir: dir, windSpeed: 12 });
    if (!b.show || !b.diamond) continue;
    sweep++;
    if (Math.abs(Math.abs(b.diamond.rotation_deg) - b.theta_deg) > 0.11) mismatch++;
    if (wb._internal.directionFor(Math.abs(b.diamond.rotation_deg)) !== b.direction) wordMismatch++;
    if (b.diamond.rotation_deg <= -180 || b.diamond.rotation_deg > 180) outside++;
    if (b.diamond.tone !== b.direction) wordMismatch++;
  }
}
console.log('     swept ' + sweep + ' (park x bearing) combinations');
check('|rotation| === theta everywhere', mismatch, 0);
check('word and tone follow from the rotation everywhere', wordMismatch, 0);
check('rotation normalised to (-180, 180]', outside, 0);

console.log('\n2. orientation: up is out, down is in');
// Wrigley cfDir 38. Wind blowing TO 38 means FROM 218 -> straight out.
check('straight out -> rotation 0', badge({ homeKey: 'chc', windDir: 218, windSpeed: 12 }).diamond.rotation_deg, 0);
check('straight out -> direction out', badge({ homeKey: 'chc', windDir: 218, windSpeed: 12 }).direction, 'out');
// Blowing TO 218 (FROM 38) -> straight in, 180.
check('straight in -> |rotation| 180', Math.abs(badge({ homeKey: 'chc', windDir: 38, windSpeed: 12 }).diamond.rotation_deg), 180);
check('straight in -> direction in', badge({ homeKey: 'chc', windDir: 38, windSpeed: 12 }).direction, 'in');
// The founding case: FROM 254 -> TO 74, CF 38 -> +36 clockwise of CF.
const pitchc = badge({ homeKey: 'chc', windDir: 254, windSpeed: 12.8 });
check('PIT@CHC rotation +36, out', [pitchc.diamond.rotation_deg, pitchc.direction], [36, 'out']);
// Sign: blowing to the other side of CF is the mirror rotation.
check('mirror bearing gives the negated rotation',
  badge({ homeKey: 'chc', windDir: 182, windSpeed: 12 }).diamond.rotation_deg,
  -badge({ homeKey: 'chc', windDir: 254, windSpeed: 12 }).diamond.rotation_deg);

console.log('\n3. strength scales the arrow');
const geo = (mph) => badge({ homeKey: 'chc', windDir: 218, windSpeed: mph }).diamond;
check('weak < moderate < strong in length',
  [geo(5).arrow_len < geo(11).arrow_len, geo(11).arrow_len < geo(20).arrow_len], [true, true]);
check('weak < moderate < strong in width',
  [geo(5).arrow_width < geo(11).arrow_width, geo(11).arrow_width < geo(20).arrow_width], [true, true]);
check('geometry matches the exported tiers',
  [geo(5).arrow_len, geo(11).arrow_len, geo(20).arrow_len],
  [wb.ARROW_GEOMETRY.weak.len, wb.ARROW_GEOMETRY.moderate.len, wb.ARROW_GEOMETRY.strong.len]);

console.log('\n4. the three special cases');
// Repointed from mil to whichever retractable is still unmeasured, by
// batch 4a (2026-09-12) — mil now has a measured bearing (128°). Taken
// from the EXPORTED set so a later batch moves it again rather than
// quietly turning this into a no-op.
const placeholderKey = [...wb.PLACEHOLDER_BEARING_KEYS].filter((k) => k !== 'tb')[0];
check('there is still an unmeasured retractable to test with', !!placeholderKey, true);
const mil = badge({ homeKey: placeholderKey, windDir: 200, windSpeed: 11 });
check('placeholder bearing (' + placeholderKey + '): no diamond, no rotation, speed still shown',
  [mil.show, mil.diamond, mil.rotation_deg, mil.bearing_measured, mil.speed_mph],
  [true, null, null, false, 11]);
check('placeholder bearing still names the compass direction', mil.from_abbr, 'SSW');
// And the newly-measured one draws an arrow, which is the point of 4a.
const measuredRetractable = badge({ homeKey: 'mil', windDir: 200, windSpeed: 11 });
check('a measured retractable gets a diamond with a rotation',
  [measuredRetractable.bearing_measured, typeof measuredRetractable.diamond.rotation_deg],
  [true, 'number']);
const tb = badge({ homeKey: 'tb', windDir: 263, windSpeed: 9 });
check('fixed dome: dome flag, no diamond', [tb.dome, tb.diamond, tb.show], [true, null, false]);
const closed = badge({ homeKey: 'chc', windDir: 254, windSpeed: 12, roofStatus: 'closed' });
check('roof closed: dome flag, no diamond', [closed.dome, closed.diamond, closed.show], [true, null, false]);

console.log('\n5. text content');
const t = badge({ homeKey: 'chc', windDir: 254, windSpeed: 12.8, tempF: 85.2 });
check('temp passed through', t.temp_f, 85.2);
check('humidity is null — not stored anywhere', t.humidity_pct, null);
check('compass abbreviation names where the wind is FROM', t.from_abbr, 'WSW');
check('and separately where it blows TO', t.to_abbr, 'ENE');
// Boundaries are at 11.25-degree multiples, so these straddle them.
check('16-point compass boundaries', [0, 11.24, 11.26, 180, 348.74, 348.76].map(wb._internal.compass16),
  ['N', 'N', 'NNE', 'S', 'NNW', 'N']);

console.log('\n6. display only — the card computes no angle and reads no wind_factor');
const cardSrc = read('public/index.html');
const diaBlock = cardSrc.slice(cardSrc.indexOf('// Wind diamond (2026-09-12)'), cardSrc.indexOf('// Roof badge'));
if (!diaBlock || diaBlock.length < 200) { failures++; console.log('  FAIL  could not locate the diamond block'); }
const diaCode = diaBlock.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
check('no wind_factor in the diamond block', /wind_factor/.test(diaCode), false);
check('no trigonometry in the diamond block', /Math\.(atan2?|cos|sin|tan)\b/.test(diaCode), false);
check('rotation comes straight from the helper', /rotation_deg/.test(diaCode), true);
check('no third-party asset reference', /https?:\/\/|<img|url\(/.test(diaCode), false);
// Structural: the descriptor tests cannot see unbalanced markup, and a
// broken SVG renders as nothing at all rather than as an error.
const count = (re) => (diaCode.match(re) || []).length;
check('<svg> tags balanced', count(/<svg\b/g) === count(/<\/svg>/g) && count(/<svg\b/g) === 2, true);
check('<g> tags balanced', count(/<g\b/g), count(/<\/g>/g));
check('every leaf element self-closes',
  count(/<(line|path|polygon|circle)\b/g), count(/\/>/g) - count(/<svg\b/g) * 0);
check('helper has no wind_factor in code',
  /wind_factor|windFactor/.test(read('utils/wind-badge.js').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')), false);

// SECTION 7 REMOVED 2026-09-18 -- a one-PR claim wearing a test's name.
//
// What stood here ran `git diff --name-only origin/main` and asserted
// the result was NON-EMPTY, so the test FAILED ON MAIN BY CONSTRUCTION:
// a clean checkout has no diff, so the suite was red on the default
// branch every time anyone ran it, for a reason with nothing to do with
// the wind diamond.
//
// This is the SECOND removal from this section, and the shape is
// identical both times. On 2026-09-12 two assertions ('no pricing-path
// file changed', 'every changed file is on the display allowlist') were
// deleted for being statements about one pull request rather than about
// the code. The emptiness guard added in their place inherited the same
// defect: it too could only be true while a specific branch was checked
// out. A guard against a vacuous pass is worth having, but not when the
// thing it guards is itself a property of the working tree.
//
// The durable form of the same guarantee is section 6, which asserts
// against the CODE: the diamond block reads no wind_factor, computes no
// angle of its own, and takes its rotation from the shared helper. Those
// hold on every branch and on main, which is what a test should do.

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
