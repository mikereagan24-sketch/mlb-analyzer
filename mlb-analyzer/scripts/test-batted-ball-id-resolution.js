#!/usr/bin/env node
// Batted-ball id resolution + the refresh script's token handling.
// (2026-09-13)
//   node scripts/test-batted-ball-id-resolution.js
// Exit 1 on any failure.
//
// THE FAILURE THIS REPRODUCES. Job 2af5998d, live:
//   "FG batted-ball split 5: parsed 0 usable rows from 362
//    (362 without an MLBAM id)"
// The strType=3 Batted Ball panel does not carry xMLBAMID. Section 3 below
// feeds the parser a payload of exactly that shape -- names and teams, no
// id column -- through a stubbed fetch, so the regression is exercised end
// to end with no network and no credential.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const fgId = require('../utils/fg-pitcher-id');

console.log('1. there was no playerid mapping to reuse — the wOBA sync is name-keyed');
// Recorded as an assertion because the fix's whole shape depends on it: if
// someone later adds a real playerid->MLBAM table, this check should fail
// and send them to the resolver instead of leaving two identity spaces.
const apiSrc = read('routes/api.js');
const parseCsvBlock = apiSrc.slice(apiSrc.indexOf('function parseCSV('),
  apiSrc.indexOf('function parseCSV(') + 1800);
check('parseCSV reads no id column', /playerid|MLBAMID|mlb_id/i.test(parseCsvBlock), false);
check('the FG team map has ONE definition, imported by parseCSV',
  /FG_TEAM_MAP: FG_MAP \} = require\('\.\.\/utils\/fg-pitcher-id'\)/.test(apiSrc), true);
check('FG abbreviations that differ from ours are mapped',
  ['KCR', 'SDP', 'SFG', 'TBR', 'WSN', 'CHW'].map(fgId.normaliseFgTeam),
  ['KC', 'SD', 'SF', 'TB', 'WAS', 'CWS']);
check('an already-correct abbreviation passes through', fgId.normaliseFgTeam('NYY'), 'NYY');

console.log('\n2. the resolver: name (+ team) -> mlb_id, ambiguity -> null');
const mem = new Database(':memory:');
mem.exec('CREATE TABLE pitcher_game_log (pitcher_name TEXT, pitcher_mlb_id INTEGER, team TEXT);'
  + 'CREATE TABLE team_rosters (name TEXT, mlb_id INTEGER, team TEXT, position TEXT)');
const gl = mem.prepare('INSERT INTO pitcher_game_log VALUES (?,?,?)');
gl.run('Dustin May', 111, 'LAD');
gl.run('Jack Flaherty', 222, 'DET');
// Two pitchers whose normalised names collide, on different teams.
gl.run('Luis Ortiz', 333, 'CLE');
gl.run('Luis Ortiz', 444, 'PIT');
mem.prepare("INSERT INTO team_rosters VALUES (?,?,?,'P')").run('Roster Only Guy', 555, 'SEA');
const idx = fgId.buildPitcherIdIndex(mem);
check('appearance-derived name resolves', fgId.resolvePitcherId(idx, 'Dustin May', 'LAD'),
  { id: 111, how: 'name_team' });
check('resolves without a team when unambiguous', fgId.resolvePitcherId(idx, 'Jack Flaherty', null),
  { id: 222, how: 'name' });
check('roster-only pitcher resolves too', fgId.resolvePitcherId(idx, 'Roster Only Guy', 'SEA').id, 555);
check('FG team abbreviation is normalised before matching',
  fgId.resolvePitcherId(idx, 'Jack Flaherty', 'DET').id, 222);
// The ambiguity rule: two ids for one name is NOT a coin flip.
check('ambiguous name + team disambiguates', fgId.resolvePitcherId(idx, 'Luis Ortiz', 'PIT'),
  { id: 444, how: 'name_team' });
check('ambiguous name with NO team resolves to null, never a guess',
  fgId.resolvePitcherId(idx, 'Luis Ortiz', null), { id: null, how: null });
check('unknown pitcher resolves to null', fgId.resolvePitcherId(idx, 'Nobody At All', 'LAD'),
  { id: null, how: null });
// Suffix / accent folding comes from the shared name machinery, not a
// second implementation.
check('suffixes and case fold via utils/names', fgId.resolvePitcherId(idx, 'dustin may jr.', 'LAD').id, 111);

console.log('\n3. the parser, against a payload with NO id column (the regression)');
const fgPath = require.resolve('../services/fangraphs.js');
delete require.cache[fgPath];
const realFetch = global.fetch;
// 4 rows, FG Batted Ball shape: Name/Team/GB%/FB%/LD%/BIP, no xMLBAMID.
// Shares are percent points, which the GB+FB+LD identity must detect.
const payload = { data: [
  { PlayerName: 'Dustin May', Team: 'LAD', 'GB%': 48.5, 'FB%': 30.2, 'LD%': 21.3, BIP: 300 },
  { PlayerName: 'Jack Flaherty', Team: 'DET', 'GB%': 35.1, 'FB%': 43.6, 'LD%': 21.3, BIP: 280 },
  { PlayerName: 'Luis Ortiz', Team: null, 'GB%': 44.0, 'FB%': 34.0, 'LD%': 22.0, BIP: 200 },
  { PlayerName: 'Nobody At All', Team: 'LAD', 'GB%': 40.0, 'FB%': 38.0, 'LD%': 22.0, BIP: 150 },
] };
global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
const fg = require('../services/fangraphs.js');
let result = null, threw = null;
(async () => {
  try {
    result = await fg.fetchPitcherBattedBall('fake-cookie', {
      splits: [{ code: 5, split: 'vs_lhb' }],
      resolveId: (name, team) => fgId.resolvePitcherId(idx, name, team),
    });
  } catch (e) { threw = e; }

  check('no throw — rows resolve by name now', threw === null ? 'no throw' : threw.message, 'no throw');
  check('returns { rows, stats }', !!(result && result.rows && result.stats), true);
  check('4 fetched, 2 resolved', [result.stats.fetched, result.stats.resolved], [4, 2]);
  // Luis Ortiz has no team here so he is ambiguous; Nobody At All is absent.
  check('2 unresolved: the ambiguous one and the unknown one', result.stats.unresolved, 2);
  check('none came from a payload id (the panel has none)', result.stats.from_payload_id, 0);
  check('both resolved came from the name resolver', result.stats.from_name_resolver, 2);
  check('unresolved are NAMED in the sample, not just counted',
    result.stats.unresolved_sample.map((u) => u.name).sort(),
    ['Luis Ortiz', 'Nobody At All']);
  check('percent points detected and stored as fractions',
    Number(result.rows[0].gb_pct.toFixed(3)), 0.485);
  check('ids attached', result.rows.map((r) => r.mlb_id).sort(), [111, 222]);
  check('BIP carried through', result.rows[0].bip, 300);

  // And with NO resolver injected, the old failure reappears — which is
  // what makes the injection the fix rather than a coincidence.
  let threw2 = null;
  try {
    await fg.fetchPitcherBattedBall('fake-cookie', { splits: [{ code: 5, split: 'vs_lhb' }] });
  } catch (e) { threw2 = e; }
  check('without a resolver it still fails LOUDLY, naming the count',
    !!(threw2 && /parsed 0 usable rows from 4/.test(threw2.message)), true);
  check('and names examples so the next panel change is diagnosable',
    /Sample: /.test(threw2.message), true);

  global.fetch = realFetch;

  console.log('\n4. the dry run fetches and reports resolved N of M');
  const taskSrc = read('services/backfill-tasks/pitcher-batted-ball-prior-season.js');
  const dryIdx = taskSrc.indexOf('if (dryRun) {');
  const fetchIdx = taskSrc.indexOf('await fetchPitcherBattedBall(');
  check('the fetch happens BEFORE the dryRun branch', fetchIdx > -1 && fetchIdx < dryIdx, true);
  check('dry run reports resolution', /dry_run: true,[\s\S]{0,120}resolution: resStats/.test(taskSrc), true);
  check('dry run says how many it would write', /would_write: rows\.length/.test(taskSrc), true);
  check('only ONE fetch call in the task (dry and live share it)',
    (taskSrc.match(/await fetchPitcherBattedBall\(/g) || []).length, 1);
  check('the live job also reports resolution',
    /resolution: resStats/.test(read('services/jobs.js')), true);

  console.log('\n5. refresh-analysis-db.sh accepts the token the server documents');
  const sh = read('scripts/refresh-analysis-db.sh');
  check('reads DB_DOWNLOAD_TOKEN', /DB_DOWNLOAD_TOKEN:-/.test(sh), true);
  check('still reads MLB_ADMIN_TOKEN', /MLB_ADMIN_TOKEN:-/.test(sh), true);
  check('DB_DOWNLOAD_TOKEN takes precedence',
    sh.indexOf('TOKEN="${DB_DOWNLOAD_TOKEN}"') < sh.indexOf('TOKEN="${MLB_ADMIN_TOKEN}"'), true);
  check('echoes WHICH variable supplied the token', /token from \\\$\$\{TOKEN_VAR\}/.test(sh), true);
  check('warns when the two are set and differ', /they DIFFER/.test(sh), true);
  check('401 names the variable rather than failing bare', /DOWNLOAD REJECTED \(401\)/.test(sh), true);
  check('a rejected download is deleted, never left as a snapshot',
    /rm -f "\$\{SNAP\}"/.test(sh), true);
  check('still never hardcodes a token',
    /X-Admin-Token: \$\{TOKEN\}/.test(sh) && !/X-Admin-Token: [A-Za-z0-9]{8}/.test(sh), true);

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})();
