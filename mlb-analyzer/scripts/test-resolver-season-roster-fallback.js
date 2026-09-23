#!/usr/bin/env node
// A name the LIVE roster no longer carries resolves from the season roster,
// and nothing that already resolved changes.
//   node --max-old-space-size=1536 scripts/test-resolver-season-roster-fallback.js
// Exit 1 on any failure.
//
// THE DEFECT. `team_rosters` is an 840-row snapshot refreshed daily,
// holding only currently-active players. `team_rosters_season` is 1665 rows
// and deliberately keeps IL'd ones (db/schema.js:3416). Every historical
// replay -- backtest, calibration A/B, sweep -- resolves an April lineup
// against today's roster, so a player since optioned, traded or shut down
// does not exist to it. Shohei Ohtani, Rafael Devers, Jung Hoo Lee, Jazz
// Chisholm Jr. and Byron Buxton were all in that state.
//
// Measured on the FRV gate's own corpus (fielding_frv_snapshot era,
// 2026-06-04..2026-09-22, 1433 games, FRV read as-of each game date):
//
//   fielder slots        20062
//   resolved, before     15707  (78.29%)
//   resolved, after      18244  (90.94%)
//   RECOVERED             2537
//
// WHY IT RUNS LAST. PASS 3 sits after PASS 1 (live roster) and PASS 2
// (catcher_framing), which makes "zero changed" structural instead of
// measured. The first attempt put it between them and resolved 7 slots
// MORE -- by substituting a season-roster id for a catcher_framing one on
// names both could answer. Seven unexplained differences is not a better
// result than seven fewer.
//
// WHAT THIS PINS:
//   1. a live-roster name still resolves, and to the same id;
//   2. a season-only name now resolves;
//   3. ordering -- PASS 3 is after PASS 2, so no existing answer moves;
//   4. ambiguity is refused, and per-team scoping holds;
//   5. a missing season table changes nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = path.join(os.tmpdir(), 'season-fallback-' + process.pid + '.db');
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
  const resolve = (t, n) => {
    console.warn = () => {};
    try { return jobs.resolveCatcherMlbId(t, n); } finally { console.warn = realWarn; }
  };

  const live = (team, name, id) => db.prepare(
    'INSERT INTO team_rosters (team, player_name, mlb_id, role) VALUES (?,?,?,?)'
  ).run(team, name, id, 'POS');
  const season = (team, name, id) => db.prepare(
    'INSERT INTO team_rosters_season (team, player_name, mlb_id, role) VALUES (?,?,?,?)'
  ).run(team, name, id, 'POS');

  db.prepare('DELETE FROM team_rosters').run();
  db.prepare('DELETE FROM team_rosters_season').run();

  live('NYY', 'Aaron Judge', 592450);                 // on both
  season('NYY', 'Aaron Judge', 592450);
  season('LAD', 'Shohei Ohtani', 660271);             // season only
  season('SF', 'Jung Hoo Lee', 808982);
  season('SF', 'Rafael Devers', 646240);
  season('MIA', 'Abrahan Ramirez', 700101);           // two same-surname
  season('MIA', 'Agustin Ramirez', 700102);
  season('TB', 'Wander Franco', 700201);              // unique last only
  live('BOS', 'Aaron Judge', 999999);                 // same name, other team

  console.log('\n1. a live-roster name still resolves, unchanged');
  expect('"A. Judge" + NYY -> the live id', resolve('NYY', 'A. Judge') === 592450,
    String(resolve('NYY', 'A. Judge')));
  expect('...full name too', resolve('NYY', 'Aaron Judge') === 592450);
  expect('per-team scoping holds: BOS gets the BOS row',
    resolve('BOS', 'A. Judge') === 999999, String(resolve('BOS', 'A. Judge')));

  console.log('\n2. a season-only name now resolves');
  for (const [t, n, id] of [
    ['LAD', 'S. Ohtani', 660271], ['LAD', 'Shohei Ohtani', 660271],
    ['SF', 'Jung Hoo Lee', 808982], ['SF', 'R. Devers', 646240],
  ]) {
    expect('"' + n + '" + ' + t + ' -> ' + id, resolve(t, n) === id, String(resolve(t, n)));
  }
  expect('a unique last name resolves via the 1b-style fallback',
    resolve('TB', 'Q. Franco') === 700201, String(resolve('TB', 'Q. Franco')));

  console.log('\n3. ambiguity is refused, not guessed');
  expect('two same-surname season rows, same initial -> null',
    resolve('MIA', 'A. Ramirez') === null, String(resolve('MIA', 'A. Ramirez')));
  expect('a name on NO roster -> null', resolve('NYY', 'Nobody Here') === null);
  expect('a team with no rows at all -> null', resolve('ZZZ', 'A. Judge') === null);

  console.log('\n4. the ordering is what makes "zero changed" structural');
  const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
  const lines = src.split(/\r?\n/).map(l => (/^\s*\/\//.test(l) ? '' : l));
  const at = (s) => lines.findIndex(l => l.indexOf(s) > -1);
  const iP1 = at('const players = q.getPositionPlayers.all(team);');
  const iP2 = at('const matchCatcherFraming = (rows) => {');
  const iP3 = at('const sp = q.getSeasonPositionPlayers.all(team);');
  const iMiss = at("'[framing] catcher resolution miss: team='");
  expect('PASS 1 (live roster) is first', iP1 > -1 && iP1 < iP2, iP1 + ' < ' + iP2);
  expect('PASS 2 (catcher_framing) is second', iP2 < iP3, iP2 + ' < ' + iP3);
  expect('PASS 3 (season roster) is LAST, before the miss log',
    iP3 > iP2 && iP3 < iMiss, iP2 + ' < ' + iP3 + ' < ' + iMiss);
  expect('it uses the real query name', /q\.getSeasonPositionPlayers/.test(src)
    && !/q\.getSeasonRoster/.test(src), 'getSeasonRoster does not exist');

  console.log('\n5. a missing or empty season table changes nothing');
  db.prepare('DELETE FROM team_rosters_season').run();
  expect('the live-roster name still resolves', resolve('NYY', 'A. Judge') === 592450);
  expect('the season-only name goes back to null', resolve('LAD', 'S. Ohtani') === null,
    String(resolve('LAD', 'S. Ohtani')));
} finally {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* best effort */ } }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
