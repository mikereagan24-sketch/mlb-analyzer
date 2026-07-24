// Blast-radius scoping for the pre-existing stripSfx regex bug.
//
// The ingest at routes/api.js:ingestWobaCSV previously used
// /\b(Jr\.|Sr\.|II|III|IV)\b/gi to detect trailing suffix tokens.
// The trailing \b never fires after "." (both "." and end-of-string
// are non-word chars), so every "Player Name Jr." / "Player Name Sr."
// silently skipped the stripped+team companion row. Roman-numeral
// suffixes (II/III/IV) DID work because they end on word chars.
//
// Effect: for every Jr./Sr. player with a team, the idx has
//   "Bobby Witt Jr."          — bare full name
//   "Bobby Witt Jr. KC"       — full name + team
// but NOT
//   "Bobby Witt KC"           — stripped + team
//
// The stripped+team companion was intended so a lineup lookup that
// dropped the Jr. ("Bobby Witt" + teamHint "kc") would hit at
// fuzzyLookup Stage 1 immediately. Without it, the lookup has to
// walk to Stage 4 (suffix-append), which tries "bobby witt jr kc" —
// still finds the real player. So the FUNCTIONAL impact for the
// common lineup name form is nil; the missing companion is
// belt-and-suspenders that never got worn.
//
// The concerning cases are:
//   * Lineups that drop Jr. AND provide no teamHint (never happens
//     in production — teamHint is always game.away_team or
//     game.home_team) → Stage 1 miss, Stage 2 miss on "bobby witt"
//     (no bare shadow because the DB has "bobby witt jr" not
//     "bobby witt"), Stage 4 miss without team, Stage 7 (stripSfx
//     scan) picks up. Still resolves.
//   * Lineups that use FIRST INITIAL ("B. Witt") — Stage 5 with
//     teamHint scans for entries ending in " kc" where stripSfx(base)
//     last=="witt" and first[0]=="b". "bobby witt jr kc" has
//     stripSfx(base)="bobby witt", split=["bobby","witt"], first[0]="b"
//     ✓, last="witt" ✓ → HIT. Resolves.
//   * Cross-team collisions — a rookie with same last name as a real
//     Jr. player on a different team. If the rookie's Steamer row is
//     "Bobby Wittfoo NYY" and lineup emits "B. Witt" + teamHint "nyy",
//     Stage 5 could hit "Bobby Wittfoo NYY" (stripSfx base "bobby
//     wittfoo" — DOESN'T match last "witt", so no collision).
//     Different-last-name rookie names don't create the collision.
//
// This script confirms the theory by replaying every Jr./Sr. player
// in the DB against fuzzyLookup with several plausible lineup name
// forms, on their actual team, and reports:
//   * How many Jr./Sr. players in bat-proj-rhp
//   * Of those, how many are missing the stripped+team companion (all)
//   * For each, simulate lookups and check resolution:
//     - "Full Name" + team (matches DB directly) → should hit Stage 1
//     - "Full Name Without Jr." + team (common lineup form) → Stage 4
//     - "F. LastName" + team (initial-abbrev form) → Stage 5
//     - "LastName" alone + team (last-name-only, rare) → Stage 7
//   * Any batter whose resolution returns null or a wrong entry.
//
// Also cross-references bet_signals: for the players where any
// lookup form returned null/wrong, count games+signals affected.
//
// Run: node tmp/audit-jr-sr-companion-gap.js

const path = require('path');
const Database = require('better-sqlite3');
const { normName, fuzzyLookup } = require(path.join(__dirname, '..', 'utils', 'names'));

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

// Load bat-proj-rhp — the densest and most-consulted batter key.
const rows = db.prepare("SELECT player_name, woba, sample_size FROM woba_data WHERE data_key='bat-proj-rhp'").all();
const idx = {};
for (const r of rows) {
  idx[normName(r.player_name)] = { woba: r.woba, sample: r.sample_size, _pname: r.player_name };
}
console.log('bat-proj-rhp rows:', rows.length);

// Enumerate every player_name in the DB that has a trailing Jr./Sr./roman suffix.
// Team-tagged form: "Bobby Witt Jr. KC" → we want to find the JR ones with team codes.
const SUFFIX_TOKENS = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);
const MLB_TEAM_CODES = new Set(['ari','atl','ath','bal','bos','chc','chw','cin','cle','col','det','hou','kc','lad','laa','mia','mil','min','nym','nyy','phi','pit','sd','sea','sf','stl','tb','tex','tor','was']);

function extractTeam(playerName) {
  // Match trailing space + 2-3 alpha chars; require uppercase to avoid
  // false positives (real last names don't usually end in 2-3 CAPS)
  const m = playerName.match(/^(.+)\s+([A-Z]{2,3})$/);
  if (m && MLB_TEAM_CODES.has(m[2].toLowerCase())) return { core: m[1], team: m[2] };
  return { core: playerName, team: null };
}
function hasSuffix(coreName) {
  const parts = coreName.trim().split(/\s+/);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  return SUFFIX_TOKENS.has(last);
}
function stripSfx(coreName) {
  const parts = coreName.trim().split(/\s+/);
  while (parts.length > 1 && SUFFIX_TOKENS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts.join(' ');
}

// Identify all Jr./Sr./roman-numeral players (team-tagged variants)
const jrPlayers = [];
for (const r of rows) {
  const { core, team } = extractTeam(r.player_name);
  if (!team) continue;
  if (!hasSuffix(core)) continue;
  const strippedCore = stripSfx(core);
  const strippedTeamName = strippedCore + ' ' + team;
  const strippedTeamKey = normName(strippedTeamName);
  const hasStrippedCompanion = !!idx[strippedTeamKey];
  jrPlayers.push({
    fullName: r.player_name, core, team, strippedCore, strippedTeamName, strippedTeamKey,
    hasCompanion: hasStrippedCompanion,
    sample: r.sample_size, woba: r.woba,
  });
}

// Bucket by suffix type
const bySfx = { jr: [], sr: [], roman: [] };
for (const p of jrPlayers) {
  const parts = p.core.trim().split(/\s+/);
  const last = (parts[parts.length - 1] || '').toLowerCase();
  if (last === 'jr' || last === 'jr.') bySfx.jr.push(p);
  else if (last === 'sr' || last === 'sr.') bySfx.sr.push(p);
  else bySfx.roman.push(p);
}
console.log();
console.log('=== Jr./Sr./roman players in bat-proj-rhp ===');
console.log('  Jr.:', bySfx.jr.length, '(missing companion:', bySfx.jr.filter(p => !p.hasCompanion).length + ')');
console.log('  Sr.:', bySfx.sr.length, '(missing companion:', bySfx.sr.filter(p => !p.hasCompanion).length + ')');
console.log('  II/III/IV:', bySfx.roman.length, '(missing companion:', bySfx.roman.filter(p => !p.hasCompanion).length + ')');

// Simulate lookups for each Jr. player under 4 plausible lineup name forms
console.log();
console.log('=== Lookup resolution simulation (Jr. players only, sample >= 20) ===');
console.log('Forms tested:');
console.log('  1. "Full Name Jr." + team  — Steamer full form');
console.log('  2. "Full Name" + team      — lineup dropped the Jr.');
console.log('  3. "F. Last" + team        — initial-abbrev form');
console.log('  4. "Last" + team           — last-only (rare)');
console.log();
let resolvedCorrect = 0, resolvedWrong = 0, resolvedNull = 0;
const troubled = [];
const relevantJrs = bySfx.jr.filter(p => p.sample >= 20);  // real players, not scrubs
for (const p of relevantJrs) {
  const nameParts = p.core.trim().split(/\s+/);
  const firstFull = nameParts[0];
  const initial = firstFull[0];
  const lastBeforeJr = nameParts[nameParts.length - 2] || nameParts[nameParts.length - 1];

  const forms = [
    { label: 'full+Jr.',    input: p.core,                                       },
    { label: 'no-Jr.',      input: nameParts.slice(0, -1).join(' '),             },
    { label: 'initial',     input: initial + '. ' + nameParts.slice(1, -1).join(' '), },
    { label: 'last-only',   input: lastBeforeJr,                                 },
  ];
  const resolutions = {};
  const realWoba = p.woba;
  for (const f of forms) {
    const hit = fuzzyLookup(idx, f.input, p.team);
    if (!hit) { resolutions[f.label] = { pname: null }; resolvedNull++; continue; }
    resolutions[f.label] = { pname: hit._pname, woba: hit.woba, sample: hit.sample };
    if (Math.abs(hit.woba - realWoba) < 0.0005) resolvedCorrect++;
    else resolvedWrong++;
  }
  // Track any player where ANY form resolves wrong or null
  const problems = Object.entries(resolutions).filter(([_, r]) => !r.pname || Math.abs((r.woba || 0) - realWoba) >= 0.0005);
  if (problems.length) troubled.push({ p, resolutions, problems });
}
console.log('  Total form-resolutions attempted:', relevantJrs.length * 4);
console.log('  Correct:', resolvedCorrect);
console.log('  Wrong (resolved to a different entry):', resolvedWrong);
console.log('  Null (defaulted):', resolvedNull);
console.log('  Players with ANY problem form:', troubled.length, '/', relevantJrs.length);
console.log();

if (troubled.length) {
  console.log('=== Problem players (any lookup form resolved wrong/null) ===');
  for (const t of troubled.slice(0, 20)) {
    console.log('  ' + t.p.fullName + ' (real woba=' + t.p.woba.toFixed(3) + ', sample=' + t.p.sample.toFixed(1) + '):');
    for (const [label, r] of Object.entries(t.resolutions)) {
      const status = !r.pname ? 'NULL' : (Math.abs(r.woba - t.p.woba) < 0.0005 ? 'ok' : 'WRONG');
      console.log('    ' + label.padEnd(12) + ' -> ' + status.padEnd(6) + (r.pname ? ' ' + r.pname + ' (' + r.woba.toFixed(3) + ')' : ''));
    }
  }
  if (troubled.length > 20) console.log('  ... +' + (troubled.length - 20) + ' more');
}

// If any troubled resolution manifested, cross-reference bet_signals for
// games where those players appeared in lineups.
if (troubled.length) {
  console.log();
  console.log('=== Games where troubled players appeared in lineups ===');
  const games = db.prepare("SELECT game_id, game_date, away_team, home_team, away_lineup_json, home_lineup_json FROM game_log WHERE game_date >= '2026-04-01'").all();
  let totalAffectedGames = new Set();
  let totalAffectedSigs = 0;
  for (const t of troubled) {
    const affected = new Set();
    for (const g of games) {
      for (const luJson of [g.away_lineup_json, g.home_lineup_json]) {
        let lu; try { lu = JSON.parse(luJson || '[]'); } catch (_) { continue; }
        for (const b of lu) {
          if (!b || !b.name) continue;
          // Match lineup name against ANY of the 4 form variants for this troubled player
          const bn = normName(b.name);
          for (const [label, r] of Object.entries(t.resolutions)) {
            if (!r.pname || Math.abs(r.woba - t.p.woba) < 0.0005) continue; // only wrong/null forms
            // We need to know if the LINEUP would have hit the wrong form.
            // Simpler proxy: does lineup name normalize to something that
            // would fuzzyLookup differently on this player's team?
            const wouldHit = fuzzyLookup(idx, b.name, luJson === g.away_lineup_json ? g.away_team : g.home_team);
            if (wouldHit && Math.abs(wouldHit.woba - t.p.woba) >= 0.0005) {
              // lineup resolves to something OTHER than this troubled player's real value
              // But only meaningful if the lineup NAME is a form of this player
              if (bn.includes(t.p.strippedCore.toLowerCase().split(' ').pop().toLowerCase())) {
                affected.add(g.game_date + '|' + g.game_id);
              }
            }
          }
        }
      }
    }
    if (affected.size) {
      console.log('  ' + t.p.fullName + ':', affected.size, 'games');
      for (const key of affected) totalAffectedGames.add(key);
    }
  }
  console.log();
  console.log('Total unique (date, gid) affected:', totalAffectedGames.size);
}
