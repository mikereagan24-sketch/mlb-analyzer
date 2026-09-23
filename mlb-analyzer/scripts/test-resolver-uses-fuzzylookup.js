#!/usr/bin/env node
// resolveCatcherMlbId matches names through the SHARED resolver, and there
// is no second copy of name matching left in it.
//   node --max-old-space-size=1536 scripts/test-resolver-uses-fuzzylookup.js
// Exit 1 on any failure.
//
// THE FORK. Three passes each hand-rolled `last === last &&
// first[0] === firstInit`, and resolveBacktestMlbId carried a third copy of
// the same rule inline. utils/names.js fuzzyLookup is the repo's one name
// matcher; the same drift was deleted from routes/api.js in July
// (fix/matchup-woba-use-shared-resolver) where a ~40-line copy had lost
// stages 4 and 6.
//
// WHAT THE SWAP ACTUALLY BOUGHT, measured over all 902 distinct
// (team, lineup name) pairs in 2026:
//
//   identical  885      both unresolved  16
//   GAINED       0      LOST              0      CHANGED  1
//
// GAINED IS ZERO, and an earlier claim of "56 distinct misses recovered"
// was WRONG. That number came from probing a roster index built across ALL
// teams with bare keys, which let fuzzyLookup's bare-name stage reach
// another team's player. The shipped index is per-team -- that is the
// scoping the fork got from its own `.all(team)` query -- and with it the
// shared resolver recovers nothing. The fork was not losing matches; it was
// making a wrong one.
//
// THE ONE CHANGE IS A FIX, and it is the reason to ship this.
// "Adolis Garcia" on a PHI lineup resolved to mlb_id 605244 -- ARAMIS
// Garcia, a catcher on ARI -- because last-name-plus-first-initial matches
// "adolis" to "aramis" and catcher_framing is not team-scoped. It now
// resolves to 666969, Adolis Garcia on PHI. That is the Victor Mesa
// failure mode: a loose matcher preferring the wrong player.
//
// WHAT THIS PINS:
//   1. last+initial alone must NOT match two different first names;
//   2. the index is per-team, so no cross-team bare-name leak;
//   3. an ambiguous duplicate name is dropped, not picked by insertion order;
//   4. 1b (unique last, ANY initial) is KEPT -- fuzzyLookup has no such
//      stage and removing it would lose resolutions;
//   5. resolveBacktestMlbId is a delegation, with no matching of its own;
//   6. no hand-rolled last+initial comparison survives in the resolver.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = path.join(os.tmpdir(), 'fuzzy-resolver-' + process.pid + '.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
process.env.MLB_DB_PATH = TMP;

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

try {
  const { db } = require(path.join(R, 'db/schema'));
  const jobs = require(path.join(R, 'services/jobs'));
  const realWarn = console.warn;
  const r = (t, n) => {
    console.warn = () => {};
    try { return jobs.resolveCatcherMlbId(t, n); } finally { console.warn = realWarn; }
  };
  const rb = (t, n) => {
    console.warn = () => {};
    try { return jobs.resolveBacktestMlbId(t, n); } finally { console.warn = realWarn; }
  };
  const live = (team, name, id) => db.prepare(
    'INSERT INTO team_rosters (team, player_name, mlb_id, role) VALUES (?,?,?,?)').run(team, name, id, 'POS');
  const season = (team, name, id) => db.prepare(
    'INSERT INTO team_rosters_season (team, player_name, mlb_id, role) VALUES (?,?,?,?)').run(team, name, id, 'POS');
  const framing = (name, id) => db.prepare(
    'INSERT INTO catcher_framing (mlb_id, name) VALUES (?,?)').run(id, name);

  for (const t of ['team_rosters', 'team_rosters_season', 'catcher_framing']) {
    try { db.prepare('DELETE FROM ' + t).run(); } catch (e) { /* may not exist */ }
  }

  console.log('\n1. THE INCIDENT: last name + initial must not match two different names');
  // Exactly the shipped case. catcher_framing is not team-scoped, so the
  // old rule reached an ARI catcher for a PHI outfielder.
  framing('Garcia, Aramis', 605244);
  season('PHI', 'Adolis García', 666969);
  season('ARI', 'Aramis Garcia', 605244);
  expect('"Adolis Garcia" + PHI resolves to the PHI Garcia', r('PHI', 'Adolis Garcia') === 666969,
    String(r('PHI', 'Adolis Garcia')));
  expect('...not to Aramis Garcia via catcher_framing', r('PHI', 'Adolis Garcia') !== 605244);
  expect('and Aramis still resolves on his own team', r('ARI', 'Aramis Garcia') === 605244,
    String(r('ARI', 'Aramis Garcia')));

  console.log('\n2. the index is per-team: no cross-team bare-name leak');
  live('NYY', 'Aaron Judge', 592450);
  expect('"Aaron Judge" + NYY resolves', r('NYY', 'Aaron Judge') === 592450);
  expect('"Aaron Judge" + BOS does NOT', r('BOS', 'Aaron Judge') === null,
    String(r('BOS', 'Aaron Judge')));
  expect('"A. Judge" + BOS does NOT either', r('BOS', 'A. Judge') === null);

  console.log('\n3. an ambiguous duplicate name is dropped, not picked by order');
  // team_rosters is UNIQUE(team, player_name), so a RAW duplicate cannot
  // exist -- the collision only appears after normalisation, which is
  // exactly where buildRosterNameIndex has to handle it. Two spellings that
  // differ as text and collapse to the same key:
  live('TB', 'Wíll Simpson', 700301);
  live('TB', 'Will Simpson', 700302);
  expect('two spellings collapsing to one key -> null',
    r('TB', 'Will Simpson') === null, String(r('TB', 'Will Simpson')));
  expect('...and the abbreviated form is refused too',
    r('TB', 'W. Simpson') === null, String(r('TB', 'W. Simpson')));

  console.log('\n4. 1b is kept: unique last name, ANY first initial');
  live('COL', 'Brett Sullivan', 700401);
  expect('"S. Sullivan" + COL resolves via the unique-last fallback',
    r('COL', 'S. Sullivan') === 700401, String(r('COL', 'S. Sullivan')));
  live('COL', 'Sam Sullivan', 700402);         // now two Sullivans
  expect('...and stops once the last name is ambiguous',
    r('COL', 'Q. Sullivan') === null, String(r('COL', 'Q. Sullivan')));

  console.log('\n5. fuzzyLookup stages the fork never had');
  live('MIN', 'Simeon Woods Richardson', 700501);
  expect('compound surname, abbreviated: "S. Woods Richardson"',
    r('MIN', 'S. Woods Richardson') === 700501, String(r('MIN', 'S. Woods Richardson')));
  live('CIN', "Ke'Bryan Hayes", 700601);
  expect('de-spaced first name (#448 stage 8): "Ke Bryan Hayes"',
    r('CIN', 'Ke Bryan Hayes') === 700601, String(r('CIN', 'Ke Bryan Hayes')));
  live('ATL', 'Ronald Acuna Jr.', 700701);
  expect('suffix append: "Ronald Acuna"', r('ATL', 'Ronald Acuna') === 700701);

  console.log('\n6. resolveBacktestMlbId delegates and matches nothing itself');
  expect('it returns what resolveCatcherMlbId returns',
    rb('PHI', 'Adolis Garcia') === r('PHI', 'Adolis Garcia')
    && rb('NYY', 'Aaron Judge') === r('NYY', 'Aaron Judge'));
  const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
  const body = src.slice(src.indexOf('function resolveBacktestMlbId'),
    src.indexOf('function resolveBacktestMlbId') + 400);
  expect('its body is a single delegation', /return resolveCatcherMlbId\(team, lineupName\);/.test(body));
  expect('...with no matching of its own', !/candidatesStrict|firstInit/.test(body), body.slice(0, 80));

  console.log('\n7. no hand-rolled last+initial comparison survives');
  const noComments = src.split(/\r?\n/).map(l => (/^\s*(\/\/|\*)/.test(l) ? '' : l)).join('\n');
  expect('no `pp[0][0] === firstInit` anywhere', !/pp\[0\]\[0\] === firstInit/.test(noComments));
  expect('no `rFirst[0] === firstInit` anywhere', !/rFirst\[0\] === firstInit/.test(noComments));
  expect('the resolver imports fuzzyLookup',
    /const \{ normName, stripSfx, fuzzyLookup \} = require\('\.\.\/utils\/names'\);/.test(noComments));
  expect('all three passes call it',
    (noComments.match(/fuzzyLookup\(buildRosterNameIndex\(/g) || []).length === 3,
    String((noComments.match(/fuzzyLookup\(buildRosterNameIndex\(/g) || []).length));
} finally {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* best effort */ } }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
