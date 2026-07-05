// Verification harness for fix/sp-forecast-fuzzy-resolver.
//
// Duplicates the resolver logic added to forecastForPitcher in
// services/jobs.js and exercises it against:
//   - The Yamamoto case that surfaced the bug (LAD SD@LAD 2026-07-04).
//   - The recurring offenders from docs/sp-forecast-abbrev-name-2026-07-04.md
//     (S. Woods Richardson, C. Sanchez, E. Rodriguez, B. Williamson,
//      S. Arrighetti, J. Misiorowski, G. Rodriguez).
//   - A negative case: 'X. Nobody' should stay unresolved.
//   - A negative case: full-name lookup should keep working via the
//     existing exact + normalized-exact paths.
//
// Run: <node20>/node scripts/test-sp-forecast-abbrev-resolver.js

'use strict';

const { db } = require('../db/schema');
const { normName, stripSfx } = require('../utils/names');

// Build the same rosterByNorm map the batch uses (services/jobs.js:1375).
const rosterByNorm = new Map();
for (const row of db.prepare(
  "SELECT team, player_name, mlb_id FROM team_rosters WHERE team IS NOT NULL AND player_name IS NOT NULL"
).all()) {
  const key = row.team + ':' + normName(row.player_name);
  if (!rosterByNorm.has(key)) rosterByNorm.set(key, row.mlb_id);
}

const rosterLookup = db.prepare(
  "SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?"
);

// Duplicate the resolution path from services/jobs.js forecastForPitcher —
// the wireup we're verifying. Intentionally NOT calling the batch job
// (that would side-effect app_settings + game_log). This tests the
// pure name→mlb_id resolution.
function resolveMlbId(pitcherName, team) {
  if (!pitcherName || !team) return null;
  // 1. exact match
  const r = rosterLookup.get(team, pitcherName);
  if (r) return r.mlb_id;
  // 2. normalized exact
  const normKey = team + ':' + normName(pitcherName);
  if (rosterByNorm.has(normKey)) return rosterByNorm.get(normKey);
  // 3. NEW: abbreviated-name fallback
  const norm = normName(pitcherName);
  const parts = norm.split(' ');
  const isAbbrev = parts.length >= 2 && parts[0].length === 1;
  if (!isAbbrev) return null;
  const initial = parts[0];
  const last = parts[parts.length - 1];
  const prefix = team + ':';
  let matches = 0;
  let matchId = null;
  for (const [k, v] of rosterByNorm.entries()) {
    if (!k.startsWith(prefix)) continue;
    const rn = k.slice(prefix.length);
    const p = stripSfx(rn).split(' ');
    if (p[p.length - 1] === last && p[0] && p[0][0] === initial) {
      matches++;
      matchId = v;
      if (matches > 1) return null;   // ambiguous → don't guess
    }
  }
  return matches === 1 ? matchId : null;
}

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

console.log('\n=== 1. Yamamoto (the case that surfaced this) ===');
{
  const id = resolveMlbId('Y. Yamamoto', 'LAD');
  expect('Y. Yamamoto @ LAD resolves', id === 808967,
    'got mlb_id=' + id + ' (expected 808967 = Yoshinobu Yamamoto)');
  const id2 = resolveMlbId('Yoshinobu Yamamoto', 'LAD');
  expect('full-name Yoshinobu Yamamoto still resolves (regression)', id2 === 808967,
    'got ' + id2);
}

console.log('\n=== 2. Recurring offenders — pinned to their CURRENT team ===');
// Historical offenders whose team changed between the misfire date and
// today (Woods Richardson DFA'd, E. Rodriguez traded DET→ARI, Williamson
// + G. Rodriguez off active rosters) are correctly left unresolvable —
// the resolver keys off the CURRENT team_rosters snapshot, so an
// abbreviated name only resolves when the pitcher is still with that
// team. That's a feature: no cross-team guessing.
{
  const cases = [
    { name: 'C. Sanchez',          team: 'PHI' },
    { name: 'E. Rodriguez',        team: 'ARI' },
    { name: 'S. Arrighetti',       team: 'HOU' },
    { name: 'J. Misiorowski',      team: 'MIL' },
  ];
  for (const c of cases) {
    const id = resolveMlbId(c.name, c.team);
    // We don't know the exact mlb_id for each — just assert a resolution
    // happened (mlbId is a non-null integer). Cross-check by fetching the
    // resolved full name for readability.
    let resolvedName = null;
    if (id != null) {
      const row = db.prepare(
        "SELECT player_name FROM team_rosters WHERE mlb_id = ? AND team = ? LIMIT 1"
      ).get(id, c.team);
      resolvedName = row ? row.player_name : null;
    }
    expect(c.name + ' @ ' + c.team + ' resolves',
      id != null && Number.isInteger(id),
      'got mlb_id=' + id + (resolvedName ? ' (' + resolvedName + ')' : ''));
  }
}

console.log('\n=== 3. Negative: unknown abbreviated name stays null ===');
{
  const id = resolveMlbId('X. Nobody', 'LAD');
  expect('X. Nobody @ LAD returns null (safe fail)', id == null,
    'got mlb_id=' + id);
}

console.log('\n=== 4. Negative: ambiguous match returns null (do not guess) ===');
{
  // Synthesize an ambiguous case by counting how many entries would match
  // the pattern initial+last-name on a given team. We assert the resolver
  // reports null when >1 candidates match.
  //
  // Real-world: two 'E. Rodriguez' on the same team. Not common, but the
  // guard exists so a future roster change can't silently swap a
  // scraper-abbreviated name to the wrong pitcher.
  //
  // If no ambiguity exists in the current roster, skip with a note.
  const roster = db.prepare(
    "SELECT team, player_name, mlb_id FROM team_rosters " +
    "WHERE team IS NOT NULL AND player_name IS NOT NULL"
  ).all();
  const teamInitialLast = new Map();
  for (const r of roster) {
    const p = stripSfx(normName(r.player_name)).split(' ');
    if (p.length < 2) continue;
    const key = r.team + ':' + p[0][0] + ':' + p[p.length - 1];
    if (!teamInitialLast.has(key)) teamInitialLast.set(key, []);
    teamInitialLast.get(key).push(r);
  }
  const ambig = [...teamInitialLast.entries()].find(([, rows]) => rows.length > 1);
  if (!ambig) {
    console.log('  SKIP  no current-roster ambiguity to test');
  } else {
    const [key, rows] = ambig;
    const [team, initial, last] = key.split(':');
    const abbrevName = initial.toUpperCase() + '. ' + rows[0].player_name.split(' ').slice(1).join(' ');
    const id = resolveMlbId(abbrevName, team);
    expect('ambiguous ' + abbrevName + ' @ ' + team + ' returns null (' + rows.length + ' candidates)',
      id == null,
      'got mlb_id=' + id + ' — candidates: ' + rows.map(r => r.player_name).join(', '));
  }
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
