#!/usr/bin/env node
'use strict';
// The wOBA ingest admission rule, driven through the REAL parseCSV.
//   <node20>/node.exe --max-old-space-size=1536 scripts/test-woba-ingest-admission.js
// Exit 1 on any failure.
//
// WHY THIS EXISTS. This rule has now been wrong twice, in opposite directions,
// inside one day:
//
//   #461  removed the 0.210 wOBA floor for batter ACTUALS. The first upload
//         admitted 266 rows -- 80 of them wOBA exactly 0.0000 -- including
//         five real pitchers at 1-2 PA, and broke 81 lineup lookups because
//         `aramis garcia` (.0495, 18 PA) made fuzzyLookup's exactly-one
//         abbrev gate ambiguous against `adolis garcia` (.2750, 607 PA).
//   #462  reverted it.
//
// Both mistakes were invisible to the suite because nothing tested the
// admission rule at all: it lived inside a route module, rejected rows before
// any table, and its only observable was a row count nobody was diffing.
//
// WHAT THIS PINS, and each one is a specific way it went wrong:
//   1. batter ACTUALS admit on SAMPLE, not on value -- a weak platoon split
//      with a real sample is exactly what the old floor was discarding;
//   2. batter ACTUALS reject below MIN_PA, which is where the pitchers and
//      the hitless 1-PA rows actually live;
//   3. batter PROJECTIONS keep the 0.210 value floor;
//   4. pitcher files keep the 0.05 floor and NO sample floor;
//   5. the floors argument FAILS SAFE -- omit it and the strict legacy rule
//      applies. #461's first draft defaulted to the loose rule, and that
//      direction is the whole reason a forgotten argument is dangerous;
//   6. the rejection counters are wired, because they are the only thing that
//      makes the next change to this rule observable at all.

const path = require('path');
const R = path.join(__dirname, '..');
const api = require(path.join(R, 'routes/api'));
const parseCSV = api.parseCSV;

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}
const csv = (rows) => Buffer.from(
  'Name,Team,wOBA,PA\n' + rows.map(r => r.join(',')).join('\n'), 'utf-8');
const byName = (rows) => {
  const o = {}; for (const r of rows) o[r.name] = r; return o;
};

expect('parseCSV is exported', typeof parseCSV === 'function');
if (typeof parseCSV !== 'function') { console.log('\n1 FAILED'); process.exit(1); }

// The shape the real files have: a weak split with a real sample, a hitless
// 1-PA line, a pitcher's batting line, and an ordinary hitter.
const BATTERS = [
  ['Ordinary Hitter', 'PHI', '0.330', '500'],
  ['Weak Split Guy', 'KC', '0.207', '120'],   // below 0.210, real sample
  ['Hitless Callup', 'SF', '0.000', '1'],     // below 0.210, no sample
  ['Aramis Garcia', 'ARI', '0.0495', '18'],   // the row that broke #461
  ['Jack Leiter', 'TEX', '0.000', '1'],       // a pitcher's batting line
];

console.log('\n1. batter ACTUALS: admit on SAMPLE, not on value');
let rows = parseCSV(csv(BATTERS), false, { minWoba: 0, minSample: 60 });
let m = byName(rows);
expect('a sub-0.210 row with a real sample is KEPT',
  !!m['Weak Split Guy'] && Math.abs(m['Weak Split Guy'].woba - 0.207) < 1e-9,
  JSON.stringify(m['Weak Split Guy'] || null));
expect('the ordinary hitter is kept', !!m['Ordinary Hitter']);
expect('a hitless 1-PA row is REJECTED', !m['Hitless Callup']);
expect('the row that broke #461 (.0495 on 18 PA) is REJECTED', !m['Aramis Garcia']);
expect("a pitcher's 1-PA batting line is REJECTED", !m['Jack Leiter']);
expect('exactly the two real hitters survive', rows.length === 2, String(rows.length));

console.log('\n2. the sample floor is MIN_PA, so it moves with the setting');
rows = parseCSV(csv(BATTERS), false, { minWoba: 0, minSample: 10 });
m = byName(rows);
expect('at minSample 10 the 18-PA row comes back', !!m['Aramis Garcia']);
expect('...and the 1-PA rows still do not', !m['Hitless Callup'] && !m['Jack Leiter']);
rows = parseCSV(csv(BATTERS), false, { minWoba: 0, minSample: 200 });
expect('at minSample 200 only the 500-PA hitter survives',
  rows.length === 1 && rows[0].name === 'Ordinary Hitter', JSON.stringify(rows.map(r => r.name)));

console.log('\n3. batter PROJECTIONS keep the 0.210 value floor');
rows = parseCSV(csv(BATTERS), false, { minWoba: 0.210, minSample: 0 });
m = byName(rows);
expect('the 0.207 row is rejected on value', !m['Weak Split Guy']);
expect('the ordinary hitter is kept', !!m['Ordinary Hitter']);
expect('no sample floor applies -- a 1-PA row at 0.330 would survive',
  parseCSV(csv([['Tiny Sample', 'SF', '0.330', '1']]), false,
    { minWoba: 0.210, minSample: 0 }).length === 1);

console.log('\n4. pitcher files: 0.05 floor, no sample floor');
const PITCHERS = [['Elite Arm', 'LAD', '0.180', '600'], ['Broken Row', 'SF', '0.010', '5']];
rows = parseCSV(csv(PITCHERS), true, { minWoba: 0.05, minSample: 0 });
m = byName(rows);
expect('a 0.180 wOBA-allowed row is kept (would fail the batter floor)', !!m['Elite Arm']);
expect('a 0.010 row is rejected', !m['Broken Row']);

console.log('\n5. THE FLOORS ARGUMENT FAILS SAFE');
// #461's first draft made the loose rule the default. A forgotten argument
// must reproduce the OLD behaviour, never acquire a looser one.
rows = parseCSV(csv(BATTERS), false);
m = byName(rows);
expect('omitted floors -> the strict 0.210 batter rule', !m['Weak Split Guy'] && !!m['Ordinary Hitter'],
  JSON.stringify(rows.map(r => r.name)));
rows = parseCSV(csv(BATTERS), false, {});
expect('empty floors object -> also strict', rows.length === 1 && rows[0].name === 'Ordinary Hitter',
  JSON.stringify(rows.map(r => r.name)));
rows = parseCSV(csv(BATTERS), false, { minSample: 60 });
expect('partial floors (sample only) -> value floor still 0.210',
  !rows.some(r => r.name === 'Weak Split Guy'), JSON.stringify(rows.map(r => r.name)));

console.log('\n6. malformed rows are rejected by the bounds, not by the floors');
rows = parseCSV(csv([
  ['', 'SF', '0.300', '500'],               // empty NAME, which is the guard
  ['Over Cap', 'SF', '0.900', '500'],
  ['Negative', 'SF', '-0.100', '500'],
  ['Not A Number', 'SF', 'abc', '500'],
]), false, { minWoba: 0, minSample: 0 });
expect('name/range/NaN rows all dropped even with both floors at 0',
  rows.length === 0, JSON.stringify(rows.map(r => r.name)));

console.log('\n7. the ingest derives the rule from the KEY, and reads MIN_PA');
const src = require('fs').readFileSync(path.join(R, 'routes/api.js'), 'utf8');
expect('ingestWobaCSV classifies actuals from the key', /const isActuals = \/-act\(-\|\$\)\/\.test\(key\)/.test(src));
expect('...and reads MIN_PA rather than writing a second literal',
  /getSettings\(\) \|\| \{\}\)\.MIN_PA/.test(src));
expect('the actuals arm uses minSample, not a value floor',
  /isActuals \? \{ minWoba: 0, minSample: minPa \}/.test(src));
expect('the projection arm keeps 0.210', /\{ minWoba: 0\.210, minSample: 0 \}/.test(src));
expect('rejections are counted, so the next change is observable',
  /rejected\.belowSample\+\+/.test(src) && /below sample floor/.test(src));

console.log('');
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
