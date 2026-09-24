#!/usr/bin/env node
'use strict';
// Stage 9: abbreviation ambiguity broken by SAMPLE then by ROSTER.
//   <node20>/node.exe --max-old-space-size=1536 scripts/test-resolver-stage9.js
// Exit 1 on any failure.
//
// WHY. Stage 6 returns a hit only on an exactly-one global match, so two
// candidates sharing a surname and an initial produce null and the batter
// falls to the projection alone. 752 lineup slots hit that in 2026.
//
// WHAT THIS PINS:
//   1. DEFAULT IS BYTE-IDENTICAL. Omit opts and stage 9 does not run. Every
//      existing caller passes three arguments, so this is the property that
//      makes the change additive;
//   2. rule 1 -- a sub-threshold row cannot be a CANDIDATE, because a row
//      below blendWoba's own gate can never contribute a term and so must not
//      be able to break a match for a player who can;
//   3. rule 1 never EMPTIES the candidate set: if every candidate is
//      sub-threshold the scan stays ambiguous rather than guessing;
//   4. rule 2 -- the lone roster-matched candidate wins. The Contreras pair
//      is the proof only the team can decide it: the SAME two rows resolve
//      OPPOSITE ways for MIL and for BOS;
//   5. stage 9 cannot change or lose a value, because it runs only after
//      every earlier stage returned null. Asserted on a lookup that resolves
//      early and on one that resolves at stage 6;
//   6. the resolver never queries -- onTeam is injected, and a throwing
//      predicate degrades to "not on the team" instead of taking the lookup
//      down.

const path = require('path');
const R = path.join(__dirname, '..');
const { fuzzyLookup } = require(path.join(R, 'utils/names'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}
const w = (woba, sample) => ({ woba, sample });
const val = (r) => (r == null ? null : Number(r.woba).toFixed(4));

// the real shape: one real player, one sub-threshold row
const RODRIGUEZ = { 'jesus rodriguez': w(0.301, 41), 'julio rodriguez': w(0.330, 977) };
// two real players, different teams -- the case only a roster can split
const CONTRERAS = { 'william contreras': w(0.335, 933), 'willson contreras': w(0.358, 807) };

console.log('\n1. the default is byte-identical -- stage 9 does not run');
expect('two candidates, no opts -> null (as before)',
  fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA') === null);
expect('...and with an empty opts object -> still null',
  fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA', {}) === null);
expect('...and with opts carrying neither key -> still null',
  fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA', { somethingElse: 1 }) === null);

console.log('\n2. rule 1: a sub-threshold row is not a candidate');
expect('minSample 60 resolves to the 977-PA row',
  val(fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA', { minSample: 60 })) === '0.3300',
  String(val(fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA', { minSample: 60 }))));
expect('at minSample 10 the 41-PA row is a candidate again, so still null',
  fuzzyLookup(RODRIGUEZ, 'J. Rodriguez', 'SEA', { minSample: 10 }) === null);
expect('rule 1 alone cannot split two REAL rows',
  fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL', { minSample: 60 }) === null);

console.log('\n3. rule 1 never empties the candidate set');
const BOTH_TINY = { 'aaron smith': w(0.200, 5), 'adam smith': w(0.210, 9) };
expect('every candidate sub-threshold -> ambiguous, not a guess',
  fuzzyLookup(BOTH_TINY, 'A. Smith', 'SF', { minSample: 60 }) === null);

console.log('\n4. rule 2: the lone roster-matched candidate wins, BOTH directions');
const milRoster = (k) => k === 'william contreras';
const bosRoster = (k) => k === 'willson contreras';
expect('MIL gets William (933 PA)',
  val(fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL', { minSample: 60, onTeam: milRoster })) === '0.3350');
expect('BOS gets Willson (807 PA) -- the SAME pair, opposite answer',
  val(fuzzyLookup(CONTRERAS, 'W. Contreras', 'BOS', { minSample: 60, onTeam: bosRoster })) === '0.3580');
expect('a roster matching BOTH leaves it ambiguous',
  fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL', { minSample: 60, onTeam: () => true }) === null);
expect('a roster matching NEITHER leaves it ambiguous',
  fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL', { minSample: 60, onTeam: () => false }) === null);
expect('onTeam works without minSample',
  val(fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL', { onTeam: milRoster })) === '0.3350');

console.log('\n5. stage 9 cannot change or lose a value');
// an exact hit resolves at stage 1/2 and must be untouched by any opts
const EXACT = { 'aaron judge': w(0.440, 600), 'a judge': w(0.111, 600) };
expect('an exact match is unaffected by opts',
  val(fuzzyLookup(EXACT, 'Aaron Judge', 'NYY')) === val(fuzzyLookup(EXACT, 'Aaron Judge', 'NYY',
    { minSample: 60, onTeam: () => false })), '0.4400 expected both ways');
// a stage-6 hit: single abbrev candidate, and it is BELOW minSample. Stage 6
// returns it before stage 9 runs, so rule 1 must NOT take it away.
const LONE_TINY = { 'endy rodriguez': w(0.344, 40) };
expect('a lone sub-threshold candidate still resolves at stage 6',
  val(fuzzyLookup(LONE_TINY, 'E. Rodriguez', 'PIT')) === '0.3440');
expect('...and minSample does NOT remove it (stage 6 already returned)',
  val(fuzzyLookup(LONE_TINY, 'E. Rodriguez', 'PIT', { minSample: 60 })) === '0.3440',
  'this is what makes the change additive rather than a filter');

console.log('\n6. the resolver never queries, and a bad predicate cannot break it');
expect('a throwing onTeam degrades to "not on the team"',
  fuzzyLookup(CONTRERAS, 'W. Contreras', 'MIL',
    { minSample: 60, onTeam: () => { throw new Error('db down'); } }) === null);
const src = require('fs').readFileSync(path.join(R, 'utils/names.js'), 'utf8');
expect('utils/names.js requires no database',
  !/require\(['"].*(schema|better-sqlite3|db\/)/.test(src));
expect('stage 9 sits after stage 8',
  src.indexOf('Stage 9 --') > src.indexOf('Stage 8 --'));
expect('minSample is documented as MIN_PA, not a literal',
  /pass MIN_PA/.test(src) && /NEVER a/.test(src));

console.log('\n7. non-abbreviated names never reach stage 9');
const FULLNAMES = { 'jesus rodriguez': w(0.301, 41), 'julio rodriguez': w(0.330, 977) };
expect('a full first name that matches nothing stays null',
  fuzzyLookup(FULLNAMES, 'Jorge Rodriguez', 'SEA', { minSample: 60, onTeam: () => true }) === null);

console.log('');
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
