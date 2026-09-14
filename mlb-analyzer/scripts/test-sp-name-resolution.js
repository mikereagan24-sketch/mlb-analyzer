#!/usr/bin/env node
// Abbreviated SP name resolution through the shared matcher. (2026-09-14)
//   node scripts/test-sp-name-resolution.js
// Exit 1 on any failure. No DB, no network.
//
// THE GAP. game_log stores away_sp / home_sp as "F. Last" while the index
// holds full names, and resolvePitcherId did exact Map lookups only -- so
// "E. Rodriguez" missed where "Eduardo Rodriguez" hit. utils/names.js has
// carried the abbreviated-first-name stages since long before this; the
// resolver simply never called them.
//
// WHAT MUST HOLD:
//   1. the fuzzy stage is ADDITIVE -- no name that resolved before may
//      resolve to a different id now
//   2. an ambiguous abbreviation resolves to NULL and is REPORTED as
//      ambiguous, not as absent; they are different problems
//   3. the team qualifier still wins over a bare-name collision
//   4. no guess: two candidates never produce an id, with or without team
const path = require('path');
const R = path.join(__dirname, '..');
const fg = require(path.join(R, 'utils/fg-pitcher-id'));
const { normName } = require(path.join(R, 'utils/names'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}

// A fake db exposing just the two queries buildPitcherIdIndex runs.
function fakeDb(appearances, roster) {
  return {
    prepare(sql) {
      const isAppearance = /pitcher_game_log/.test(sql);
      return { all: () => (isAppearance ? appearances : roster) };
    },
  };
}
const idx = fg.buildPitcherIdIndex(fakeDb(
  [
    { name: 'Eduardo Rodriguez', id: 1, team: 'AZ' },
    { name: 'Elmer Rodriguez', id: 2, team: 'NYY' },
    { name: 'Cristopher Sanchez', id: 3, team: 'PHI' },
    { name: 'Yoshinobu Yamamoto', id: 4, team: 'LAD' },
    // Two pitchers sharing a normalised full name, on different teams --
    // the case the team qualifier exists for.
    { name: 'Luis Ortiz', id: 5, team: 'CLE' },
    { name: 'Luis Ortiz', id: 6, team: 'PIT' },
    // Diacritics on the INDEX side; the lookup below arrives without them.
    { name: 'José Ureña', id: 7, team: 'TEX' },
  ],
  [{ name: 'Matthew Liberatore', id: 8, team: 'STL' }]
));

console.log('1. the abbreviated forms that were missing');
check('C. Sanchez resolves via the fuzzy stage',
  fg.resolvePitcherId(idx, 'C. Sanchez', 'PHI'), { id: 3, how: 'fuzzy', ambiguous: false, candidates: 1 });
check('Y. Yamamoto too', fg.resolvePitcherId(idx, 'Y. Yamamoto', 'LAD').id, 4);
check('and a roster-only pitcher, M. Liberatore',
  fg.resolvePitcherId(idx, 'M. Liberatore', 'STL').id, 8);
check('an abbreviation with no team still resolves when unique',
  fg.resolvePitcherId(idx, 'C. Sanchez', null).id, 3);

console.log('');
console.log('2. exact paths are unchanged and still win');
check('full name + team is name_team, not fuzzy',
  fg.resolvePitcherId(idx, 'Eduardo Rodriguez', 'AZ'),
  { id: 1, how: 'name_team', ambiguous: false, candidates: 1 });
check('full name alone is name',
  fg.resolvePitcherId(idx, 'Yoshinobu Yamamoto', null),
  { id: 4, how: 'name', ambiguous: false, candidates: 1 });
// The FG abbreviation map must still apply before the lookup.
check('a FanGraphs team abbrev is normalised first (SDP -> SD)',
  fg.normaliseFgTeam('SDP'), 'SD');

console.log('');
console.log('3. AMBIGUITY IS REFUSED, AND NAMED');
// Four candidates in production (elmer/eduardo/erick/erian); two here.
const amb = fg.resolvePitcherId(idx, 'E. Rodriguez', 'BAL');
check('no id is invented', amb.id, null);
check('it is reported AMBIGUOUS, not absent', [amb.ambiguous, amb.candidates], [true, 2]);
// Without a team, same refusal.
check('...with no team either', fg.resolvePitcherId(idx, 'E. Rodriguez', null).ambiguous, true);
// The team qualifier DOES break the tie when the team is in the index.
check('but a team that IS in the index resolves it',
  fg.resolvePitcherId(idx, 'E. Rodriguez', 'AZ').id, 1);

console.log('');
console.log('4. a genuinely absent pitcher is absent, not ambiguous');
const gone = fg.resolvePitcherId(idx, 'Q. Nobody', 'BOS');
check('no id, not flagged ambiguous', [gone.id, gone.ambiguous, gone.candidates],
  [null, false, 0]);
// This is the Pablo Lopez / Jose Urena case from the prior-season run: the
// normaliser folds the diacritics correctly, the name simply is not there.
check('normName folds diacritics (so absence is not a normalisation bug)',
  [normName('Pablo López'), normName('José Ureña')], ['pablo lopez', 'jose urena']);
check('and a diacritic-free lookup hits a diacritic-carrying index row',
  fg.resolvePitcherId(idx, 'Jose Urena', 'TEX').id, 7);

console.log('');
console.log('5. the full-name collision still needs its team');
check('two Luis Ortizes: bare name refuses',
  fg.resolvePitcherId(idx, 'Luis Ortiz', null),
  { id: null, how: null, ambiguous: true, candidates: 2 });
check('CLE picks one', fg.resolvePitcherId(idx, 'Luis Ortiz', 'CLE').id, 5);
check('PIT picks the other', fg.resolvePitcherId(idx, 'Luis Ortiz', 'PIT').id, 6);

console.log('');
console.log('6. hostile keys cannot leak a prototype member');
const weird = fg.buildPitcherIdIndex(fakeDb(
  [{ name: 'constructor', id: 99, team: 'BOS' }], []));
check('an index key colliding with Object.prototype resolves normally',
  fg.resolvePitcherId(weird, 'constructor', 'BOS').id, 99);
check('and an unrelated prototype name does not resolve to a function',
  fg.resolvePitcherId(weird, 'toString', 'BOS').id, null);

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
