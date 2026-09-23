#!/usr/bin/env node
// Stage 8: a first name split differently on the two sides still resolves,
// and the compound-surname path is untouched.
//   node --max-old-space-size=1536 scripts/test-resolver-despaced-first-name.js
// Exit 1 on any failure.
//
// THE TWO CASES. Found in the 2026 season scan
// (docs/name-resolution-failures-2026-09-23.md):
//   "Ke Bryan Hayes" [CIN]  vs  "Ke'Bryan Hayes" / "KeBryan Hayes"
//   "Ji Hwan Bae"    [MIL]  vs  "Jihwan Bae"
// normName drops the apostrophe but keeps the space, so the two strings
// differ by whitespace alone and no earlier stage compares them: 1-3 need
// equality, 5/6/6.5 need one side abbreviated to a single character, and 7
// needs exact equality after suffix-stripping.
//
// These are the same NAME, so this is normalization, not aliasing. That is
// why it is a stage rather than a mapping table -- and it is the reason the
// alias table stayed unbuilt (3 slots, and one built from the failure scan
// would have encoded 22 April feed errors as real names).
//
// WHAT THIS PINS, in the order it could regress:
//   1. both cases resolve, in BOTH directions;
//   2. the compound-surname path stage 6 relies on is unchanged -- the
//      canonical form keeps the LAST token intact, so "simeon woods
//      richardson" and "s woods richardson" do not converge;
//   3. stage 8 runs LAST, so it cannot preempt an earlier stage's answer;
//   4. an ambiguous canonical form is REFUSED, not guessed -- the same
//      exactly-one gate stages 6 and 6.5 use;
//   5. a team-tagged entry is still only reachable with the right hint.
//
// MEASURED over every 2026 lineup lookup (160,200 across 40,050 slots),
// pre-stage-8 resolver against this one:
//   identical 151789   GAINED 11   LOST 0   CHANGED 0
// The 11 are the two cases above. The real index holds 89 canonical-form
// collisions and every one is the expansion's own suffixed/stripped pair
// for the SAME player, identical wOBA on both rows, so zero genuinely
// different players collide.

const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, fuzzyLookup } = require(path.join(R, 'utils/names'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}
const mk = (names) => {
  const o = {};
  for (const n of names) o[normName(n)] = { _raw: n };
  return o;
};
const got = (idxNames, lookup, hint) => {
  const h = fuzzyLookup(mk(idxNames), lookup, hint);
  return h ? h._raw : null;
};

console.log('\n1. the two cases, both directions');
for (const [entry, lookup, hint] of [
  ["Ke'Bryan Hayes CIN", 'Ke Bryan Hayes', 'CIN'],
  ['KeBryan Hayes CIN', 'Ke Bryan Hayes', 'CIN'],
  ["Ke'Bryan Hayes", 'Ke Bryan Hayes', null],
  ['Ke Bryan Hayes CIN', "Ke'Bryan Hayes", 'CIN'],
  ['Jihwan Bae MIL', 'Ji Hwan Bae', 'MIL'],
  ['Ji Hwan Bae MIL', 'Jihwan Bae', 'MIL'],
  ['Jihwan Bae', 'Ji Hwan Bae', null],
]) {
  expect('idx "' + entry + '"  lookup "' + lookup + '"' + (hint ? '+' + hint : ''),
    got([entry], lookup, hint) === entry, String(got([entry], lookup, hint)));
}
// three-token first names too
expect('"Jung Hoo Lee" reaches "Junghoo Lee"',
  got(['Junghoo Lee SF'], 'Jung Hoo Lee', 'SF') === 'Junghoo Lee SF');

console.log('\n2. THE COMPOUND-SURNAME PATH IS UNTOUCHED');
// The canonical form keeps the last token, so these never converge.
for (const [entry, lookup, hint, want] of [
  ['S. Woods Richardson MIN', 'Simeon Woods Richardson', 'MIN', 'S. Woods Richardson MIN'],
  ['Simeon Woods Richardson MIN', 'S. Woods Richardson', 'MIN', 'Simeon Woods Richardson MIN'],
  ['S. Woods Richardson', 'S. Woods Richardson', 'MIN', 'S. Woods Richardson'],
  ['Elly De La Cruz CIN', 'E. De La Cruz', 'CIN', 'Elly De La Cruz CIN'],
  ['Elly De La Cruz CIN', 'Elly De La Cruz', 'CIN', 'Elly De La Cruz CIN'],
  ['Lourdes Gurriel Jr.', 'L. Gurriel', 'ARI', 'Lourdes Gurriel Jr.'],
  ['Ha-Seong Kim SD', 'H. Kim', 'SD', 'Ha-Seong Kim SD'],
]) {
  expect('"' + lookup + '"' + (hint ? '+' + hint : '') + ' -> ' + want,
    got([entry], lookup, hint) === want, String(got([entry], lookup, hint)));
}
// and the surname halves must NOT merge into each other
expect('a de-spaced SURNAME is not matched: "woodsrichardson" stays unreachable',
  got(['Simeon Woods Richardson MIN'], 'Simeon Woodsrichardson', 'MIN') === null,
  String(got(['Simeon Woods Richardson MIN'], 'Simeon Woodsrichardson', 'MIN')));
expect('...and the reverse direction too',
  got(['Simeon Woodsrichardson MIN'], 'Simeon Woods Richardson', 'MIN') === null);

console.log('\n3. stage 8 runs LAST -- an earlier stage always wins');
// Both an exact match and a de-spaced candidate present: the exact one
// must win, or stage 8 has been promoted above stage 1.
expect('an exact hit beats a de-spaced candidate',
  got(['Ke Bryan Hayes CIN', 'Kebryan Hayes CIN'], 'Ke Bryan Hayes', 'CIN') === 'Ke Bryan Hayes CIN',
  String(got(['Ke Bryan Hayes CIN', 'Kebryan Hayes CIN'], 'Ke Bryan Hayes', 'CIN')));
expect('a bare exact hit beats it too',
  got(['Ke Bryan Hayes', 'Kebryan Hayes'], 'Ke Bryan Hayes', null) === 'Ke Bryan Hayes');
// the abbrev stages still win over stage 8
expect('stage 5 still wins on an abbreviated lookup',
  got(['Kebryan Hayes CIN'], 'K. Hayes', 'CIN') === 'Kebryan Hayes CIN');

console.log('\n4. an ambiguous canonical form is REFUSED, not guessed');
// Reaching the gate takes care. If the lookup matches EITHER entry
// exactly it resolves at stage 2 and never gets here -- which is correct,
// and is what the first draft of this case accidentally tested. So both
// index entries must differ from the lookup while sharing its canonical
// form. And neither may begin with a single-character token, or stage 6.5
// claims it as an abbreviated first name and returns before stage 8 -- the
// second thing the first draft of this case got wrong. "ke bryan hayes"
// and "keb ryan hayes" both canonicalise to "kebryan hayes", both start
// with a multi-character token, and neither equals the lookup.
expect('a lookup matching one entry exactly resolves at stage 2, not here',
  got(['Ke Bryan Hayes', 'Kebryan Hayes'], 'KeBryan Hayes', null) === 'Kebryan Hayes',
  String(got(['Ke Bryan Hayes', 'Kebryan Hayes'], 'KeBryan Hayes', null)));
expect('two entries sharing a canonical form, neither exact -> REFUSED',
  got(['Ke Bryan Hayes', 'Keb Ryan Hayes'], 'Kebryan Hayes', null) === null,
  String(got(['Ke Bryan Hayes', 'Keb Ryan Hayes'], 'Kebryan Hayes', null)));
expect('...while one alone resolves',
  got(['Ke Bryan Hayes'], 'Kebryan Hayes', null) === 'Ke Bryan Hayes');
// a single-token lookup has no first name to de-space
expect('a single-token lookup returns null rather than throwing',
  got(['Hayes CIN'], 'Hayes', null) === null);
expect('...and a single-token INDEX entry is not reached by it',
  got(['Hayes'], 'Ke Bryan Hayes', null) === null);

console.log('\n5. team scoping still binds');
expect('a tagged entry is not reached without the hint',
  got(['Kebryan Hayes CIN'], 'Ke Bryan Hayes', null) === null,
  String(got(['Kebryan Hayes CIN'], 'Ke Bryan Hayes', null)));
expect('...nor with the WRONG hint',
  got(['Kebryan Hayes CIN'], 'Ke Bryan Hayes', 'PIT') === null);
expect('...and IS reached with the right one',
  got(['Kebryan Hayes CIN'], 'Ke Bryan Hayes', 'CIN') === 'Kebryan Hayes CIN');

console.log('\n6. the canonical form is first-name-only, by construction');
const canon = (n) => {
  const p = stripSfx(normName(n)).split(' ');
  return p.length < 2 ? null : p.slice(0, -1).join('') + ' ' + p[p.length - 1];
};
expect('"Ke Bryan Hayes" -> "kebryan hayes"', canon('Ke Bryan Hayes') === 'kebryan hayes',
  String(canon('Ke Bryan Hayes')));
expect('"Simeon Woods Richardson" -> "simeonwoods richardson"',
  canon('Simeon Woods Richardson') === 'simeonwoods richardson', String(canon('Simeon Woods Richardson')));
expect('...which does NOT equal "swoods richardson"',
  canon('Simeon Woods Richardson') !== canon('S. Woods Richardson'));
expect('a suffix is stripped before canonicalising',
  canon('Bobby Witt Jr.') === canon('Bobby Witt'), canon('Bobby Witt Jr.'));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
