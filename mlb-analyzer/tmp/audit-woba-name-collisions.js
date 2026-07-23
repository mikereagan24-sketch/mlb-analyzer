// Audit: is the batter wOBA resolver returning wrong-team / near-empty
// entries from woba_data because it has no active-roster filter?
//
// Background: bullpen resolution filters woba_data → team_rosters WHERE
// role='RP' (db/schema.js:3136). Batter resolution (services/model.js:120
// getBatterWoba → utils/names.js fuzzyLookup) has NO equivalent gate,
// so woba_data's Steamer projections for minor leaguers / retirees /
// released players can shadow real hitters via the fuzzyLookup cascade.
//
// Concrete case that triggered this audit: 'Victor Mesa MIA' (proj .246
// / .238, sample 0.3 / 0.7 — effectively empty) coexists with
// 'Victor Mesa Jr. TB' (real player: .283 / .313, sample 24 / 85).
// Neither is on any MLB active roster today — the MIA entry is
// Steamer's minor-league Victor Victor Mesa (MIA farmhand), a
// DIFFERENT person from Victor Mesa Jr. Any lookup path that lands
// on the MIA entry for a "Victor Mesa" lineup name is pricing a
// non-rostered player into the game.
//
// This script:
//   Sweep 1 — enumerates woba_data collisions where stripSfx(normName)
//             matches across ≥2 rows in the same data_key (i.e., the
//             fuzzyLookup Stage 4/7 space) AND at least one row has
//             sample_size < 5 (the shadow-risk class).
//   Sweep 2 — replays fuzzyLookup for every batter on today's lineups
//             and flags resolutions whose entry team-suffix ≠ the
//             game's team, or whose sample_size < 5.
//
// Run: node tmp/audit-woba-name-collisions.js

const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at ' + DB_PATH);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });

const { normName, stripSfx, fuzzyLookup } = require(path.join(__dirname, '..', 'utils', 'names'));

// ── Helpers ─────────────────────────────────────────────────────────────
// woba_data.player_name looks like "Victor Mesa Jr. TB" (uppercase 2-3
// letter team suffix). Extract that suffix and the "core" name.
function splitTeamSuffix(playerName) {
  const m = (playerName || '').match(/^(.*?)\s+([A-Z]{2,3})$/);
  if (m) return { core: m[1], teamSfx: m[2] };
  return { core: playerName || '', teamSfx: null };
}

// ── Sweep 1: woba_data collisions ───────────────────────────────────────
console.log('\n=== Sweep 1: woba_data collisions (stripSfx bucket, one side sample_size<5) ===\n');

const BATTER_KEYS = ['bat-proj-lhp', 'bat-proj-rhp', 'bat-act-lhp', 'bat-act-rhp'];

const collisionsByKey = {};
for (const dk of BATTER_KEYS) {
  const rows = db.prepare('SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(dk);
  // Bucket by stripSfx(normName(core-without-team-suffix)) so that
  // "Victor Mesa Jr. TB" and "Victor Mesa MIA" and "Victor Mesa Sr." all land
  // in the same bucket. This is exactly the collision surface fuzzyLookup
  // Stage 7 sees when teamHint fails to disambiguate.
  const bucket = new Map();
  for (const r of rows) {
    const { core } = splitTeamSuffix(r.player_name);
    const key = stripSfx(normName(core));
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(r);
  }
  const collisions = [];
  for (const [k, entries] of bucket.entries()) {
    if (entries.length < 2) continue;
    // Only interested if at least one entry looks like a "shadow": very
    // low sample. High-sample-vs-high-sample collisions are usually real
    // father/son pairs the model actually needs to disambiguate.
    const minSample = Math.min(...entries.map(e => e.sample_size || 0));
    if (minSample >= 5) continue;
    collisions.push({ key: k, entries });
  }
  collisionsByKey[dk] = collisions;
}

for (const dk of BATTER_KEYS) {
  const cs = collisionsByKey[dk];
  console.log(`  [${dk}] ${cs.length} collision buckets`);
  // Print the top 10 by min-sample-size ascending (biggest shadow risk first).
  const sorted = cs.slice().sort((a, b) => {
    const aMin = Math.min(...a.entries.map(e => e.sample_size || 0));
    const bMin = Math.min(...b.entries.map(e => e.sample_size || 0));
    return aMin - bMin;
  });
  for (const c of sorted.slice(0, 10)) {
    console.log(`    bucket "${c.key}":`);
    for (const e of c.entries) {
      console.log(`      ${e.player_name.padEnd(35)}  sample=${(e.sample_size||0).toFixed(1).padStart(6)}  wOBA=${e.woba.toFixed(3)}`);
    }
  }
  console.log();
}

// Specifically confirm the Victor Mesa case
console.log('\n=== Focus: Victor Mesa entries across all keys ===\n');
for (const dk of BATTER_KEYS) {
  const rows = db.prepare(
    "SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=? AND player_name LIKE '%Mesa%'"
  ).all(dk);
  if (!rows.length) continue;
  console.log(`  [${dk}]`);
  for (const r of rows) {
    console.log(`    ${r.player_name.padEnd(35)}  sample=${(r.sample_size||0).toFixed(1).padStart(6)}  wOBA=${r.woba.toFixed(3)}`);
  }
  console.log();
}

// ── Sweep 2: today's lineup resolution ──────────────────────────────────
console.log('\n=== Sweep 2: today\'s lineup batter resolutions ===\n');

const today = new Date().toISOString().slice(0, 10);
console.log(`  Slate date: ${today}`);

const games = db.prepare(
  'SELECT game_id, away_team, home_team, away_lineup_json, home_lineup_json FROM game_log WHERE game_date=?'
).all(today);
console.log(`  Games: ${games.length}\n`);

// Build the batter index the same way jobs.js does (subset — just the four
// batter keys, no pitcher_woba_override which doesn't apply to batters).
function buildBatterIdx() {
  const idx = {};
  for (const dk of BATTER_KEYS) {
    idx[dk] = {};
    const rows = db.prepare('SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=?').all(dk);
    for (const r of rows) {
      idx[dk][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size, _pname: r.player_name };
    }
  }
  return idx;
}
const idx = buildBatterIdx();

// Look up which entry a fuzzyLookup returns by scanning the idx for the
// value we got back (buildWobaIndex loses the source key). This is O(N)
// per lookup but N ~ 1500 rows and we run it a couple hundred times.
function findEntryPname(keyMap, hit) {
  if (!hit) return null;
  for (const [k, v] of Object.entries(keyMap)) {
    if (v === hit) return { normKey: k, pname: v._pname };
  }
  return null;
}

const totals = { batters: 0, resolved: 0, teamMismatch: 0, lowSample: 0, notResolved: 0 };
const flags = [];

for (const g of games) {
  for (const side of ['away', 'home']) {
    const teamHint = side === 'away' ? g.away_team : g.home_team;
    let lineup;
    try { lineup = JSON.parse(g[side + '_lineup_json'] || '[]'); } catch (_) { lineup = []; }
    if (!Array.isArray(lineup)) continue;

    for (const b of lineup) {
      if (!b || !b.name) continue;
      totals.batters++;

      // Match production: try RHP-facing proj key (most common exposure);
      // fall back through the other three if that misses. Any hit is a
      // "resolved" batter for this audit.
      let hit = null, hitKey = null;
      for (const dk of ['bat-proj-rhp', 'bat-proj-lhp', 'bat-act-rhp', 'bat-act-lhp']) {
        hit = fuzzyLookup(idx[dk], b.name, teamHint);
        if (hit) { hitKey = dk; break; }
      }
      if (!hit) { totals.notResolved++; continue; }
      totals.resolved++;

      const entryInfo = findEntryPname(idx[hitKey], hit);
      const pname = entryInfo ? entryInfo.pname : '(unknown)';
      const { teamSfx } = splitTeamSuffix(pname);
      const teamMismatch = teamSfx && teamSfx.toUpperCase() !== (teamHint || '').toUpperCase();
      const lowSample = (hit.sample || 0) < 5;

      if (teamMismatch) totals.teamMismatch++;
      if (lowSample) totals.lowSample++;
      if (teamMismatch || lowSample) {
        flags.push({
          game: `${g.away_team}@${g.home_team} (${g.game_id})`,
          side,
          lineupName: b.name,
          resolvedTo: pname,
          resolvedTeamSfx: teamSfx,
          expectedTeam: teamHint,
          sample: hit.sample,
          hitKey,
          reason: [teamMismatch ? 'TEAM_MISMATCH' : null, lowSample ? 'LOW_SAMPLE' : null].filter(Boolean).join(','),
        });
      }
    }
  }
}

console.log(`  Batters seen: ${totals.batters}`);
console.log(`  Resolved:     ${totals.resolved}`);
console.log(`  Unresolved:   ${totals.notResolved}`);
console.log(`  Team mismatch: ${totals.teamMismatch}`);
console.log(`  Low sample (<5): ${totals.lowSample}\n`);

if (flags.length) {
  console.log('  === Flagged resolutions ===');
  for (const f of flags) {
    console.log(`    [${f.reason}] ${f.game} ${f.side}`);
    console.log(`      lineup: "${f.lineupName}" → woba: "${f.resolvedTo}"`);
    console.log(`      expected team ${f.expectedTeam}, got suffix ${f.resolvedTeamSfx}, sample ${f.sample}, key ${f.hitKey}`);
  }
}
console.log();

// ── Fix strategy note ────────────────────────────────────────────────────
console.log('=== Fix strategy ===');
console.log('  Add active-roster gate to getBatterWoba, mirroring the RP pool filter at db/schema.js:3136.');
console.log('  Options considered:');
console.log('    A) Pre-filter idx per team at build-time: NO — buildWobaIndex is one-time; teamHint varies per call.');
console.log('    B) Post-filter fuzzyLookup hit: REJECT if resolved entry\'s team-suffix ∉ team_rosters WHERE team=teamHint AND role=\'POS\'.');
console.log('       Simple, minimal blast radius; falls back to league-avg default (same behavior as unresolved names today).');
console.log('    C) Pass roster set into fuzzyLookup so cascade stages skip off-roster entries: cleaner, but touches shared util.');
console.log('  Recommendation: B in getBatterWoba only (leave fuzzyLookup untouched for backtest paths that use season roster).');
