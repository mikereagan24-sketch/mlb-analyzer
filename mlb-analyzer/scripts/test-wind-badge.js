#!/usr/bin/env node
// Wind badge + fixed-dome guard (2026-09-12).
//   node scripts/test-wind-badge.js
// Exit 1 on any failure.
//
// The two load-bearing assertions:
//   (3) the badge CANNOT read wind_factor — asserted structurally (source
//       grep over the helper, the API call site and the card block) and
//       behaviourally (same inputs, absurd wind_factor, identical output)
//   (4) PRICING IS UNTOUCHED — every stored wind_factor in the last 30
//       days re-derives byte-identically from its stored dir/speed, except
//       at the fixed dome where it must now be 0
// Assertion (4) runs on prod-shaped rows rather than synthetic ones,
// because a pricing guard verified against fixtures is not verified
// (CLAUDE.md, ingest-not-hot-path rule 4).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const weather = require('../services/weather');
const { PARKS, calcWindFactor } = weather;
const wb = require('../utils/wind-badge');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('1. direction from the angle, strength from the speed');
// Wrigley cfDir=38. Wind FROM 254 -> blowing TO 74 -> theta 36 -> Out.
// This is the founding case: RotoWire / RotoGrinders / baseballwx all call
// a WSW wind at Wrigley "blowing out", and the old |wind_factor|>=0.08
// test called it Cross below 9.19 mph.
const chc = (dir, spd) => wb.windBadge({ homeKey: 'chc', windDir: dir, windSpeed: spd, roofStatus: 'open' });
check('PIT@CHC WSW 12.8mph -> out/moderate', [chc(254, 12.8).direction, chc(254, 12.8).strength, chc(254, 12.8).theta_deg], ['out', 'moderate', 36]);
check('same bearing at 8.5mph is STILL out (old test said Cross)', chc(254, 8.5).direction, 'out');
check('same bearing at 5mph is still out, strength weak', [chc(254, 5).direction, chc(254, 5).strength], ['out', 'weak']);
check('same bearing at 20mph -> strong', chc(254, 20).strength, 'strong');
check('straight in (wind TO 218 = FROM 38) -> in', chc(38, 12).direction, 'in');
check('theta 90 (wind TO 128 = FROM 308) -> cross', chc(308, 12).direction, 'cross');
check('cone edge: theta 60 inclusive -> out', wb._internal.directionFor(60), 'out');
check('cone edge: theta 60.1 -> cross', wb._internal.directionFor(60.1), 'cross');
check('cone edge: theta 120 inclusive -> in', wb._internal.directionFor(120), 'in');
check('strength edges: 7.9 weak, 8 moderate, 14.9 moderate, 15 strong',
  [7.9, 8, 14.9, 15].map(wb._internal.strengthFor), ['weak', 'moderate', 'moderate', 'strong']);

console.log('\n2. roof and bearing handling');
check('roof closed -> no badge, reason roof_closed',
  [chc(254, 12) && wb.windBadge({ homeKey: 'chc', windDir: 254, windSpeed: 12, roofStatus: 'closed' }).show,
    wb.windBadge({ homeKey: 'chc', windDir: 254, windSpeed: 12, roofStatus: 'closed' }).reason], [false, 'roof_closed']);
const tbBadge = wb.windBadge({ homeKey: 'tb', windDir: 263, windSpeed: 9, roofStatus: 'open' });
check('fixed dome reports closed even when roof_status=open',
  [tbBadge.show, tbBadge.reason, tbBadge.label], [false, 'fixed_dome', 'Roof closed']);
// Fixture repointed from mil to tor by batch 4a (2026-09-12): mil now has
// a measured bearing (128°) and would fail a placeholder assertion. tor is
// still a placeholder — and the assertion is written against the EXPORTED
// set rather than a hardcoded key, so the next batch moves it again
// without silently turning this check into a no-op.
const placeholderKey = [...wb.PLACEHOLDER_BEARING_KEYS].filter((k) => k !== 'tb')[0];
check('there is still an unmeasured retractable to test with', !!placeholderKey, true);
const milBadge = wb.windBadge({ homeKey: placeholderKey, windDir: 200, windSpeed: 11, roofStatus: 'open' });
check('placeholder-bearing park (' + placeholderKey + '): strength only, no invented direction',
  [milBadge.show, milBadge.direction, milBadge.bearing_measured, milBadge.strength],
  [true, null, false, 'moderate']);
check('and a MEASURED retractable now gets a real direction',
  wb.windBadge({ homeKey: 'mil', windDir: 200, windSpeed: 11, roofStatus: 'open' }).bearing_measured, true);
check('no wind data -> no badge', wb.windBadge({ homeKey: 'chc', windSpeed: 0, roofStatus: 'open' }).show, false);

console.log('\n3. the badge cannot read wind_factor');
const helperSrc = read('utils/wind-badge.js');
const codeOnly = helperSrc.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
check('utils/wind-badge.js has no wind_factor in CODE', /wind_factor|windFactor/.test(codeOnly), false);
const apiSrc = read('routes/api.js');
const callSite = apiSrc.slice(apiSrc.indexOf('wind_badge: _windBadge('), apiSrc.indexOf('wind_badge: _windBadge(') + 400);
check('api.js call site passes no wind_factor', /wind_factor/.test(callSite), false);
const cardSrc = read('public/index.html');
const cardBlock = cardSrc.slice(cardSrc.indexOf('// Wind badge —'), cardSrc.indexOf('// Roof badge'));
const cardCode = cardBlock.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
check('card wind block has no wind_factor in CODE', /wind_factor/.test(cardCode), false);
// Behavioural: the helper has no wind_factor parameter, so passing an
// absurd one must change nothing.
const a = wb.windBadge({ homeKey: 'chc', windDir: 254, windSpeed: 12.8, roofStatus: 'open' });
const b = wb.windBadge({ homeKey: 'chc', windDir: 254, windSpeed: 12.8, roofStatus: 'open', windFactor: -99, wind_factor: -99 });
check('output invariant to a wind_factor argument', a, b);

console.log('\n4. pricing untouched — stored factors re-derive on prod-shaped rows');
// Two populations are EXCLUDED, with reasons, rather than dropped silently:
//
//   closed/partial roof — computeEffectiveWeather gates wind to 0 for
//     every closed game, so the stored 0 is not a calcWindFactor output
//     and re-deriving it proves nothing.
//
//   the 7 batch-3 bearing parks — cfDir changed for nym/min/atl/col/lad/
//     laa/sd on the 2026-08-18 bearing cutover (docs/park-bearings-audit.md).
//     Rows whose weather was written before their park's cutover hold a
//     factor computed under the OLD bearing, so they cannot re-derive
//     under the new one. This is a REGIME BOUNDARY in the wind channel,
//     the same shape as the park_factor_source boundary in CLAUDE.md, and
//     it is reported rather than asserted away.
//
// The assertion that actually proves this PR changed no pricing is over
// the 15 open-air parks whose bearings did NOT move: any drift there would
// have to come from the code.
const db = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
// Parks whose cfDir has ever moved, from the ONE definition in
// utils/bearing-regimes.js. Their stored rows were computed under a
// bearing the code no longer holds and cannot re-derive. Excluding them is
// not weakening the check: the assertion is over the parks whose bearing
// did NOT move, and that set is what proves the code changed nothing.
const { BEARING_REGIME_PARKS } = require('../utils/bearing-regimes');
const BATCH3_PARKS = BEARING_REGIME_PARKS;
const rows = db.prepare(
  'SELECT game_date, game_id, roof_status, wind_speed, wind_dir, wind_factor FROM game_log '
  + "WHERE game_date >= '2026-08-13' AND game_date <= '2026-09-12' "
  + 'AND wind_speed IS NOT NULL AND wind_dir IS NOT NULL AND wind_factor IS NOT NULL'
).all();
let mismatch = 0, domeRows = 0, domeNonZeroBefore = 0, stable = 0;
const regimeParks = new Set();
let skippedRoof = 0, bearingRegime = 0;
for (const r of rows) {
  const key = (r.game_id.split('-')[1] || '').toLowerCase();
  const park = PARKS[key];
  if (!park) continue;
  if (park.fixedDome) {
    domeRows++;
    if (Math.abs(r.wind_factor) > 0) domeNonZeroBefore++;
    if (calcWindFactor(r.wind_dir, r.wind_speed, park) !== 0) {
      mismatch++; console.log('        FIXED DOME NOT ZEROED ' + r.game_date + ' ' + r.game_id);
    }
    continue;
  }
  if (r.roof_status === 'closed' || r.roof_status === 'partial') { skippedRoof++; continue; }
  const now = calcWindFactor(r.wind_dir, r.wind_speed, park);
  const drift = Math.abs(now - r.wind_factor) > 1e-9;
  if (BATCH3_PARKS.has(key)) { if (drift) { bearingRegime++; regimeParks.add(key); } else stable++; continue; }
  if (drift) {
    mismatch++;
    if (mismatch <= 5) console.log('        drift ' + r.game_date + ' ' + r.game_id
      + ' stored ' + r.wind_factor + ' now ' + now);
  } else stable++;
}
console.log('     stable-bearing rows re-derived: ' + stable
  + '   excluded: ' + skippedRoof + ' roof-gated, ' + bearingRegime + ' pre-cutover bearing-regime');
console.log('     fixed-dome rows: ' + domeRows + ', of which ' + domeNonZeroBefore
  + ' carried a non-zero factor before this change');
check('no drift at any park whose bearing did not move', mismatch, 0);
check('the founding instance is real: dome rows had non-zero factors', domeNonZeroBefore > 0, true);
// The invariant, not a magic count: every non-re-deriving row must sit at a
// park whose bearing actually moved. A count needs editing on every batch
// and passes for the wrong reason when it does — batch 4a pushed the old
// `<= 10` bound over without saying anything true about the boundary.
check('every drifting park is a known bearing regime',
  [...regimeParks].filter((k) => !BEARING_REGIME_PARKS.has(k)), []);
check('and at least one drifting row exists, so the exclusion is not vacuous',
  bearingRegime > 0, true);

// The three named games, by name.
console.log('\n5. founding instance, per game');
for (const [date, gid] of [['2026-08-17', 'bal-tb'], ['2026-08-18', 'tor-tb'], ['2026-09-01', 'nym-tb']]) {
  const r = db.prepare('SELECT wind_speed, wind_dir, wind_factor, roof_status FROM game_log WHERE game_date=? AND game_id=?').get(date, gid);
  if (!r) { failures++; console.log('  FAIL  ' + date + ' ' + gid + ' not found'); continue; }
  const now = calcWindFactor(r.wind_dir, r.wind_speed, PARKS['tb']);
  console.log('  ' + (now === 0 ? 'PASS' : 'FAIL') + '  ' + date + ' ' + gid
    + '  roof_status=' + r.roof_status + '  stored ' + r.wind_factor + ' -> now ' + now);
  if (now !== 0) failures++;
}

// A relocated fixed-dome team is OUTDOORS: the flag must not survive a
// venue override. Mirrors the Object.assign in services/jobs.js.
console.log('\n6. venue override clears fixedDome');
const relocated = Object.assign({}, PARKS['tb'], { lat: 27.98, lng: -82.5, fixedDome: false });
check('relocated TB game prices wind again', calcWindFactor(263, 12, relocated) !== 0, true);
const jobsSrc = read('services/jobs.js');
check('jobs.js override branches set fixedDome explicitly',
  (jobsSrc.match(/fixedDome: !!(venueIdOv|teamDateOv)\.fixedDome/g) || []).length, 2);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
