#!/usr/bin/env node
// A 2-3 letter trailing token is a team tag only if it IS a team.
//   node --max-old-space-size=1536 scripts/test-team-tag-membership.js
// Exit 1 on any failure.
//
// THE DEFECT. Three of fuzzyLookup's stages skip index entries carrying a
// team tag, because the team-scoped stages reach those instead. The test
// was a SHAPE -- /\s[a-z]{2,3}$/ -- true of any short trailing token, and
// most short trailing tokens in woba_data are not teams:
//
//   suffixes   jr (40 entries), iii (7), ii (3), iv (2)
//   surnames   lee (13), kim (12), paz (4), gil (4), oca (3), fry, cox,
//              son, ha, woo, may, ray, ryu, oh, bae, lux, puk, baz, fox,
//              orr, seo ... 64 distinct non-team tokens in all
//   FG marker  tms, from its "6 Tms" multi-team spelling
//
// Every one of those was invisible to stages 6, 6.5-global and 7. The
// measured cost of the suffix half alone: "L. Gurriel" + ARI could not
// reach "Lourdes Gurriel Jr." -- 558 PA of real actuals -- so 48 ARI
// lineup slots from 2026-04-18 to 2026-09-11 priced an everyday hitter at
// the league-average default.
//
// A team-TAGGED entry survives either way, because stage 5 matches on the
// tag itself. The ones that broke are UNTAGGED entries, where the global
// scans were the only route to them.
//
// WHAT THIS PINS, in the order it could regress:
//   1. the suffix and short-surname cases resolve;
//   2. a team-tagged entry is still excluded from the global scans, so no
//      cross-team promotion appears -- that exclusion is the reason the
//      test exists at all and must not be lost while fixing it;
//   3. TEAM_TOKENS covers every team the database actually spells, so a
//      rebrand or expansion team fails HERE rather than silently
//      re-opening the bug;
//   4. nothing that resolved before stops resolving.

const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, fuzzyLookup, TEAM_TOKENS, hasTeamTag } = require(path.join(R, 'utils/names'));

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
const raw = (h) => (h ? h._raw : null);

console.log('\n1. hasTeamTag asks whether the token IS a team');
for (const [n, want] of [
  ['aaron judge nyy', true], ['lourdes gurriel jr', false], ['jung hoo lee', false],
  ['ha seong kim', false], ['michael harris ii', false], ['bobby witt jr', false],
  ['luis garcia 6 tms', false],   // FG's multi-team marker is not a team
  ['judge', false],               // single token, nothing to tag
  ['shota imanaga chc', true], ['yuli gurriel sd', true], ['someone oak', true],
]) {
  expect('hasTeamTag("' + n + '") === ' + want, hasTeamTag(n) === want, String(hasTeamTag(n)));
}

console.log('\n2. THE INCIDENT: an abbreviated lookup reaches a suffixed, untagged entry');
const gur = mk(['Lourdes Gurriel Jr.']);
expect('"L. Gurriel" + ARI resolves', raw(fuzzyLookup(gur, 'L. Gurriel', 'ARI')) === 'Lourdes Gurriel Jr.',
  String(raw(fuzzyLookup(gur, 'L. Gurriel', 'ARI'))));
expect('...and with no team hint at all',
  raw(fuzzyLookup(gur, 'L. Gurriel', null)) === 'Lourdes Gurriel Jr.');
expect('the full name still resolves, as it always did',
  raw(fuzzyLookup(gur, 'Lourdes Gurriel', null)) === 'Lourdes Gurriel Jr.');
for (const n of ['Bobby Witt Jr.', 'Michael Harris II', 'Fernando Tatis Jr.', 'Luis Robert Jr.']) {
  const p = stripSfx(normName(n)).split(' ');
  const ab = p[0][0] + ' ' + p[p.length - 1];
  expect('"' + ab + '" reaches "' + n + '"', raw(fuzzyLookup(mk([n]), ab, null)) === n);
}

console.log('\n3. short surnames are names, not tags');
for (const [full, ab] of [
  ['Jung Hoo Lee', 'j lee'], ['Ha-Seong Kim', 'h kim'], ['Hyun Jin Ryu', 'h ryu'],
  ['Shohei Oh', 's oh'], ['Ji Man Choi', 'j choi'], ['Gavin Lux', 'g lux'],
]) {
  expect('"' + ab + '" reaches "' + full + '"', raw(fuzzyLookup(mk([full]), ab, null)) === full,
    String(raw(fuzzyLookup(mk([full]), ab, null))));
}

console.log('\n4. a TEAM-TAGGED entry is still excluded from the global scans');
// This exclusion is the whole point of the predicate. Losing it would
// promote a cross-team match on a bare lookup, which is the failure the
// stage-6 "exactly one" gate and this filter exist to prevent.
const tagged = mk(['Aaron Judge NYY']);
expect('"A. Judge" with NO team hint does not reach "Aaron Judge NYY"',
  fuzzyLookup(tagged, 'A. Judge', null) === null, String(raw(fuzzyLookup(tagged, 'A. Judge', null))));
expect('...but WITH the right hint it does, via stage 5',
  raw(fuzzyLookup(tagged, 'A. Judge', 'NYY')) === 'Aaron Judge NYY');
expect('a bare full-name lookup does not reach a tagged entry either',
  fuzzyLookup(tagged, 'Aaron Judge', null) === null);
// two teams, same surname+initial: must stay ambiguous, not pick one
const two = mk(['Aaron Judge NYY', 'Adam Judge BOS']);
expect('two same-initial same-surname tagged entries stay unresolved bare',
  fuzzyLookup(two, 'A. Judge', null) === null);

console.log('\n5. nothing that resolved before stops resolving');
for (const [idxNames, lookup, hint, want] of [
  [['Aaron Judge NYY'], 'Aaron Judge', 'NYY', 'Aaron Judge NYY'],
  [['Aaron Judge'], 'Aaron Judge', 'NYY', 'Aaron Judge'],
  [['Aaron Judge'], 'A. Judge', 'NYY', 'Aaron Judge'],
  [['Steven Antonacci NYY'], 'Steven Antonacci', 'NYY', 'Steven Antonacci NYY'],
  [['s antonacci nyy'], 'Steven Antonacci', 'NYY', 's antonacci nyy'],
  [['Ronald Acuna Jr. ATL'], 'R. Acuna', 'ATL', 'Ronald Acuna Jr. ATL'],
  [['Ronald Acuna Jr. ATL'], 'Ronald Acuna', 'ATL', 'Ronald Acuna Jr. ATL'],
  [['Victor Mesa Jr. TB'], 'Victor Mesa Jr.', 'TB', 'Victor Mesa Jr. TB'],
  [['Jackson Merrill SD'], 'J. Merrill', 'SD', 'Jackson Merrill SD'],
  [['Bjørn Johnson'], 'Bjorn Johnson', null, 'Bjørn Johnson'],
  [['S. Woods Richardson MIN'], 'Simeon Woods Richardson', 'MIN', 'S. Woods Richardson MIN'],
]) {
  const got = raw(fuzzyLookup(mk(idxNames), lookup, hint));
  expect('"' + lookup + '"' + (hint ? '+' + hint : '') + ' -> ' + want, got === want, String(got));
}

console.log('\n6. TEAM_TOKENS covers every team the database spells');
let db = null;
try { db = new (require(path.join(R, 'node_modules/better-sqlite3')))(path.join(R, 'data/mlb.db'), { readonly: true }); }
catch (e) { console.log('  SKIP  no readable data/mlb.db (' + e.message.slice(0, 50) + ')'); }
if (db) {
  const missing = [];
  const seen = new Set();
  for (const r of db.prepare('SELECT DISTINCT team t FROM team_rosters').all()) seen.add(r.t);
  for (const r of db.prepare('SELECT DISTINCT away_team a, home_team h FROM game_log').all()) {
    seen.add(r.a); seen.add(r.h);
  }
  for (const t of seen) {
    const k = normName(t);
    if (k && !TEAM_TOKENS.has(k)) missing.push(t);
  }
  expect('every game_log / team_rosters team is in TEAM_TOKENS (' + seen.size + ' seen)',
    missing.length === 0, missing.length ? 'MISSING: ' + missing.join(', ') : '');
  // and the inverse sanity: no obvious surname smuggled into the set
  const SURNAMES = ['lee', 'kim', 'cox', 'fry', 'ray', 'woo', 'ryu', 'oh', 'bae', 'lux',
    'puk', 'baz', 'fox', 'orr', 'seo', 'jr', 'sr', 'ii', 'iii', 'iv', 'tms'];
  const smuggled = SURNAMES.filter(s => TEAM_TOKENS.has(s));
  expect('no suffix or known short surname is in TEAM_TOKENS',
    smuggled.length === 0, smuggled.join(', '));
  db.close();
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
