#!/usr/bin/env node
// The ingest's team tag follows the current roster, and declines to guess.
//   node --max-old-space-size=1536 scripts/test-ingest-team-tag-roster.js
// Exit 1 on any failure.
//
// THE DEFECT. woba_data rows carry the team FanGraphs listed when the file
// was built. When a player moves, that tag goes stale and a team-scoped
// lookup for the team he is on NOW cannot reach the row. 36 lineup slots
// across 9 players missed for exactly this reason over the 2026 season:
// "buddy kennedy was" looked up as SF, "kyler fedko pit" as MIN,
// "chuckie robinson atl" as LAD.
//
// WHY AT INGEST AND NOT IN THE RESOLVER. A resolver fallback -- "if the
// team-scoped lookup misses, accept any team" -- cannot tell "buddy
// kennedy was looked up as SF", the same player, from "blake perkins cle
// answering a lookup for Brice Perkins MIL", which is a different one.
// That is the Victor Mesa failure mode on the pricing hot path, and two
// attempts at the resolver version caused prod-wide mass rejections. A
// stale tag is wrong at write time, so it is fixed at write time.
//
// WHAT THIS PINS:
//   1. exactly one roster row and a different team -> RETAG;
//   2. more than one roster row -> LEAVE ALONE. Ambiguity is where
//      guessing costs a wrong player, and the whole point of doing this
//      at ingest is to not be the thing that guesses;
//   3. no roster row -> LEAVE ALONE. Usually a minor-leaguer no lineup
//      asks for;
//   4. an untagged row is never given a tag -- this corrects tags, it does
//      not invent them, so #438's collision-only rule stays intact;
//   5. a missing or empty roster table changes NOTHING. A missing
//      authority must not rewrite data;
//   6. FanGraphs' "6 Tms" multi-team marker is repaired, because a key
//      like "luis garcia 6 tms" is one no teamHint can ever match.
//
// MEASURED EFFECT ON THE 2026 CORPUS: 0 gained, 0 lost, 0 changed across
// all 160,200 lineup lookups, retagging 3 rows. That is not the fix being
// inert -- it is September. All 9 affected players have since left every
// roster, so today's snapshot cannot exhibit their case. Each of the 36
// slots WOULD have been caught on its own date, because a player who
// appears in a lineup is on a roster that day by definition.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = path.join(os.tmpdir(), 'roster-tag-' + process.pid + '.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
process.env.MLB_DB_PATH = TMP;

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

try {
  const { db } = require(path.join(R, 'db/schema'));
  const { rosterCorrectTeams } = require(path.join(R, 'routes/api'));

  const addRoster = (team, name, id) => db.prepare(
    'INSERT INTO team_rosters (team, player_name, mlb_id, role) VALUES (?,?,?,?)'
  ).run(team, name, id, 'POS');

  db.prepare('DELETE FROM team_rosters').run();
  addRoster('SF', 'Buddy Kennedy', 700001);        // moved: FG still says WAS
  addRoster('MIN', 'Kyler Fedko', 700002);         // moved: FG still says PIT
  addRoster('NYY', 'Aaron Judge', 700003);         // tag already correct
  addRoster('CIN', 'Yunior Marte', 700004);        // two rosters, same name
  addRoster('SF', 'Yunior Marte', 700005);
  addRoster('SF', 'Luis García Jr.', 700006);      // suffix + accent + "6 Tms"

  console.log('\n1. one roster row, different team -> retag');
  let rows = [{ name: 'Buddy Kennedy', team: 'WAS' }, { name: 'Kyler Fedko', team: 'PIT' }];
  let st = rosterCorrectTeams(rows, 'bat-proj-rhp');
  expect('both retagged', st.retagged === 2, JSON.stringify(st));
  expect('Kennedy WAS -> SF', rows[0].team === 'SF', rows[0].team);
  expect('Fedko PIT -> MIN', rows[1].team === 'MIN', rows[1].team);

  console.log('\n2. tag already correct -> untouched, and not counted as a retag');
  rows = [{ name: 'Aaron Judge', team: 'NYY' }];
  st = rosterCorrectTeams(rows, 'bat-proj-rhp');
  expect('still NYY', rows[0].team === 'NYY', rows[0].team);
  expect('retagged 0', st.retagged === 0, String(st.retagged));

  console.log('\n3. AMBIGUOUS -> leave alone, and say so');
  rows = [{ name: 'Yunior Marte', team: 'ATL' }];
  st = rosterCorrectTeams(rows, 'pit-act-rhb');
  expect('tag unchanged', rows[0].team === 'ATL', rows[0].team);
  expect('counted as ambiguous, not retagged',
    st.ambiguous === 1 && st.retagged === 0, JSON.stringify(st));

  console.log('\n4. no roster row -> leave alone');
  rows = [{ name: 'Some Minorleaguer', team: 'TB' }];
  st = rosterCorrectTeams(rows, 'bat-proj-rhp');
  expect('tag unchanged', rows[0].team === 'TB', rows[0].team);
  expect('counted as unmatched', st.unmatched === 1 && st.retagged === 0, JSON.stringify(st));

  console.log('\n5. an UNTAGGED row is never given a tag');
  // #438 deliberately leaves non-colliding actuals rows bare. This
  // correction must not undo that by inventing a tag.
  rows = [{ name: 'Buddy Kennedy', team: null }];
  st = rosterCorrectTeams(rows, 'bat-act-rhp');
  expect('still null', rows[0].team === null, String(rows[0].team));
  expect('not counted at all', st.retagged === 0 && st.unmatched === 0 && st.ambiguous === 0,
    JSON.stringify(st));

  console.log('\n6. the multi-team marker is repaired');
  // normName("6 Tms") reduces to the token "tms", and "luis garcia 6 tms"
  // is a key no teamHint can reach. The suffix and the accent both have
  // to survive the roster match for this to work.
  rows = [{ name: 'Luis García Jr.', team: '6 Tms' }];
  st = rosterCorrectTeams(rows, 'pit-act-rhb');
  expect('"6 Tms" -> SF', rows[0].team === 'SF', String(rows[0].team));
  expect('...counted as a retag', st.retagged === 1, String(st.retagged));

  console.log('\n7. an empty roster table changes nothing');
  db.prepare('DELETE FROM team_rosters').run();
  rows = [{ name: 'Buddy Kennedy', team: 'WAS' }, { name: 'Kyler Fedko', team: 'PIT' }];
  st = rosterCorrectTeams(rows, 'bat-proj-rhp');
  expect('no retags', st.retagged === 0, String(st.retagged));
  expect('tags untouched', rows[0].team === 'WAS' && rows[1].team === 'PIT',
    rows[0].team + '/' + rows[1].team);

  console.log('\n8. it runs BEFORE the collision pass, and is wired into the response');
  const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
  const lines = api.split(/\r?\n/).map(l => (/^\s*\/\//.test(l) ? '' : l));
  const at = (s) => lines.findIndex(l => l.indexOf(s) > -1);
  const iFix = at('const rosterFix = rosterCorrectTeams(rows, key);');
  const iColl = at("if (key.includes('-act-')) {");
  const iExpand = at('const expandedRows = [];');
  expect('the correction is called', iFix > -1);
  expect('...before the collision pass', iFix < iColl, iFix + ' < ' + iColl);
  expect('...and before the expansion writes the team into the key',
    iFix < iExpand, iFix + ' < ' + iExpand);
  expect('the retag count reaches the upload response',
    /retagged: rosterFix\.retagged/.test(api));
  expect('the roster query is a q.* prepared statement, not a second connection',
    /q\.allRosterPlayers\.all\(\)/.test(api)
    && /q\.allRosterPlayers = db\.prepare/.test(fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8')));
} finally {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* best effort */ } }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
