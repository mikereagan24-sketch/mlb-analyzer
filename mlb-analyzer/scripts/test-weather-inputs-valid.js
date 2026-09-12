#!/usr/bin/env node
// Invariants for weather_inputs_valid (2026-09-12).
//   node scripts/test-weather-inputs-valid.js
// Exit 1 on any failure, so it can gate a "done" claim.
//
// Catches, in order of how badly each would hurt:
//   1. new rows landing NULL -> every `weather_inputs_valid = 1` filter
//      silently drops the current slate (both weather writers must set it)
//   2. the ROI/CLV population moving -> this PR must not touch emit-time
//      filtering, and a graded row leaving that set would mean it did
//   3. loadGames failing open on an unrecognised weatherFilter
//   4. the boundary constant drifting out of its measured empty gap
const { db } = require('../db/schema');
const wiv = require('../utils/weather-inputs-valid');
const ps = require('../services/parameter-sweep');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '   got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const count = (where) => db.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + where).get().n;

console.log('1. every row carries a verdict (NULL here means a dropped slate, not a gap)');
check('no NULL weather_inputs_valid', count('weather_inputs_valid IS NULL'), 0);

console.log('\n2. both weather writers set the flag — grep, because a missed writer is invisible at runtime');
const fs = require('fs');
for (const [file, needle] of [
  ['db/schema.js', 'q.updateWindData'],
  ['services/jobs.js', "weather_quality_at=datetime('now')"],
]) {
  const src = fs.readFileSync(require('path').join(__dirname, '..', file), 'utf8');
  const lines = src.split('\n').filter((l) => l.includes(needle) && l.includes('UPDATE game_log SET wind_speed'));
  const allFlagged = lines.length > 0 && lines.every((l) => l.includes('weather_inputs_valid=1'));
  check(file + ' weather write sets weather_inputs_valid', allFlagged, true);
}

console.log('\n3. the emit-time (ROI/CLV) population is UNCHANGED by this PR');
// A graded row that the tag admits but the flag rejects would be a row
// dropped from an ROI path. There must be none: the only tag-clean
// non-valid row is the 2026-07-14 all-star row, which has no temp_f and
// no final score.
check('graded rows admitted by tag but not by flag',
  count("weather_contamination_reason IS NULL AND weather_inputs_valid <> 1 "
    + 'AND away_score IS NOT NULL AND home_score IS NOT NULL'), 0);
check('tag-clean rows rejected by flag are ungraded only',
  count("weather_contamination_reason IS NULL AND weather_inputs_valid <> 1 "
    + 'AND (away_score IS NULL OR home_score IS NULL)'),
  count("weather_contamination_reason IS NULL AND weather_inputs_valid <> 1"));

console.log('\n4. loadGames filter modes');
const FROM = '2026-06-16', TO = '2026-09-10';
const nValid = ps.loadGames(db, FROM, TO).length;
const nTag = ps.loadGames(db, FROM, TO, { weatherFilter: 'tag' }).length;
const nNone = ps.loadGames(db, FROM, TO, { weatherFilter: 'none' }).length;
const nAlias = ps.loadGames(db, FROM, TO, { includeWeatherContaminated: true }).length;
console.log('     inputs_valid=' + nValid + '  tag=' + nTag + '  none=' + nNone + '  alias=' + nAlias);
check('default is wider than the tag filter', nValid > nTag, true);
check('none is widest', nNone >= nValid, true);
check('includeWeatherContaminated still aliases none', nAlias, nNone);
let threw = false;
try { ps.loadGames(db, FROM, TO, { weatherFilter: 'clean' }); } catch (e) { threw = true; }
check('unrecognised weatherFilter THROWS rather than failing open', threw, true);

console.log('\n5. boundary still sited in measured empty space');
let gapOk = true;
try { wiv.assertGapEmpty(db); } catch (e) { gapOk = false; console.log('     ' + e.message); }
check('empty-gap assertion holds', gapOk, true);

console.log('\n6. class mapping assertions');
for (const [label, where] of wiv.CLASS_ASSERTIONS) check(label, count(where), 0);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
