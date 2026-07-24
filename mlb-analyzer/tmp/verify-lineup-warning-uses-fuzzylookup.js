// Verifier for fix/lineup-warning-uses-fuzzylookup.
//
// Reproduces the SEA prod failure: user saved a lineup where the
// scraped-from-RotoWire names were abbreviated ("J. Crawford" style)
// while woba_data had the players under full names ("J.P. Crawford
// SEA"). The old warning-check at routes/api.js:1848-1871 did
// exact-key + startsWith prefix scan only — never invoked
// fuzzyLookup — so it flagged abbreviated names as unresolved even
// though fuzzyLookup Stage 5 (abbrev + teamHint) resolves them
// cleanly at model score time. False positive warning fired on 3 of
// 9 SEA core starters.
//
// This verifier:
//   1. Replicates the OLD warning-check logic inline.
//   2. Replicates the NEW warning-check (uses fuzzyLookup).
//   3. For a set of realistic prod-form names against the actual
//      local woba_data, asserts: OLD flags them (baseline of bug),
//      NEW does not flag them (bug fixed).
//   4. Also confirms that genuinely-unresolvable names (typos,
//      never-was-a-real-player) STILL flag under NEW — the warning
//      should tighten precision without losing recall on real
//      failures.
//
// Not tested here: the roster-vs-scraped mismatch that causes the
// dropdown to render "(off-roster)" for abbreviated scraped-lineup
// names. That's cosmetic-only and a separate follow-up
// (fix/lineup-dropdown-abbrev-to-roster-form). fuzzyLookup resolves
// both forms identically at score time.
//
// Run: node tmp/verify-lineup-warning-uses-fuzzylookup.js

const path = require('path');
const Database = require('better-sqlite3');
const { normName, fuzzyLookup } = require(path.join(__dirname, '..', 'utils', 'names'));

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}

// ── Load prod-shape idx ─────────────────────────────────────────────────
const wobaRows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
const idx = {};
for (const r of wobaRows) {
  if (!idx[r.data_key]) idx[r.data_key] = {};
  idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size, _pname: r.player_name };
}

// ── OLD warning-check (verbatim from git HEAD~1 routes/api.js) ─────────
function oldWarningCheck(name) {
  const lhp = idx['bat-proj-lhp'] || {};
  const rhp = idx['bat-proj-rhp'] || {};
  const lhpAct = idx['bat-act-lhp'] || {};
  const rhpAct = idx['bat-act-rhp'] || {};
  const k = normName(name);
  const hit = idx['bat-proj-lhp']
    && (lhp[k] || rhp[k] || lhpAct[k] || rhpAct[k]
        || Object.keys(lhp).some(kk => kk === k || kk.startsWith(k + ' '))
        || Object.keys(rhp).some(kk => kk === k || kk.startsWith(k + ' ')));
  return !!hit;
}

// ── NEW warning-check (uses fuzzyLookup on all four sub-maps) ──────────
function newWarningCheck(name, teamHint) {
  const hit = fuzzyLookup(idx['bat-proj-lhp'] || {}, name, teamHint)
           || fuzzyLookup(idx['bat-act-lhp']  || {}, name, teamHint)
           || fuzzyLookup(idx['bat-proj-rhp'] || {}, name, teamHint)
           || fuzzyLookup(idx['bat-act-rhp']  || {}, name, teamHint);
  return !!hit;
}

// ── Test 1: exact prod-reported failure — SEA abbreviated core starters ─
console.log('\n=== Test 1: SEA prod-reported false positives ===');
{
  const cases = [
    { name: 'J. Crawford', team: 'SEA', realPlayer: 'J.P. Crawford SEA' },
    { name: 'J. Rodriguez', team: 'SEA', realPlayer: 'Julio Rodríguez SEA' },
    { name: 'V. Robles', team: 'SEA', realPlayer: 'Victor Robles SEA' },
  ];
  for (const c of cases) {
    const oldFlagged = !oldWarningCheck(c.name);
    const newFlagged = !newWarningCheck(c.name, c.team);
    // Real resolution at score time (what getBatterWoba would do):
    const scoreHit = fuzzyLookup(idx['bat-proj-rhp'] || {}, c.name, c.team);
    const scoreOk = scoreHit && scoreHit._pname === c.realPlayer;
    console.log('  ' + JSON.stringify(c.name) + ' + ' + c.team + ': '
      + 'OLD flags=' + oldFlagged
      + ', NEW flags=' + newFlagged
      + ', score-time resolves to=' + (scoreHit ? scoreHit._pname : 'null'));
    assert(oldFlagged, 'OLD check flags "' + c.name + '" (baseline of bug)');
    assert(!newFlagged, 'NEW check does NOT flag "' + c.name + '" (fix works)');
    assert(scoreOk, 'score-time actually resolves "' + c.name + '" to real ' + c.realPlayer);
  }
}

// ── Test 2: Julio Rodríguez with and without accent — diacritic case ────
console.log('\n=== Test 2: diacritic handling (Julio Rodríguez vs Julio Rodriguez) ===');
{
  const withAccent = 'Julio Rodríguez';
  const noAccent   = 'Julio Rodriguez';
  const teamHint   = 'SEA';
  const wa = newWarningCheck(withAccent, teamHint);
  const na = newWarningCheck(noAccent, teamHint);
  assert(wa, 'NEW resolves "Julio Rodríguez" (accented)');
  assert(na, 'NEW resolves "Julio Rodriguez" (ASCII) equivalently');
}

// ── Test 3: J.P. Crawford (full form) still resolves ────────────────────
console.log('\n=== Test 3: J.P. Crawford full form still resolves ===');
{
  const full = 'J.P. Crawford';
  const oldFlagged = !oldWarningCheck(full);
  const newFlagged = !newWarningCheck(full, 'SEA');
  assert(!oldFlagged, 'OLD does not flag "J.P. Crawford" (baseline sanity)');
  assert(!newFlagged, 'NEW does not flag "J.P. Crawford" (no regression)');
}

// ── Test 4: genuinely unresolvable name — must still flag ──────────────
console.log('\n=== Test 4: genuinely unresolvable names still flag ===');
{
  const cases = [
    // Total nonsense — no real player
    { name: 'Xxblahblah Nonexist', team: 'SEA' },
    // Wrong-initial — J. Crawford exists (JP), but Q. Crawford doesn't
    { name: 'Q. Crawford', team: 'SEA' },
  ];
  for (const c of cases) {
    const newFlagged = !newWarningCheck(c.name, c.team);
    assert(newFlagged, 'NEW check DOES flag "' + c.name + '" (still catches real problems)');
  }
}

// ── Test 5: sweep — how many false positives did the OLD check produce ─
// across today's slate lineups? Confirms this fix has slate-wide value,
// not just for the 3 SEA cases the user reported.
console.log('\n=== Test 5: sweep — false positive rate on today\'s slate ===');
{
  const today = '2026-07-23';  // last date with lineups in local DB
  const games = db.prepare("SELECT game_id, away_team, home_team, away_lineup_json, home_lineup_json FROM game_log WHERE game_date=?").all(today);
  let oldFalsePos = 0, allBatters = 0, oldFlagged = 0, newFlagged = 0;
  const oldOnlyExamples = [];
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const team = side === 'away' ? g.away_team : g.home_team;
      let lu;
      try { lu = JSON.parse(g[side + '_lineup_json'] || '[]'); } catch (_) { lu = []; }
      for (const b of lu) {
        if (!b || !b.name) continue;
        allBatters++;
        const oldHit = oldWarningCheck(b.name);
        const newHit = newWarningCheck(b.name, team);
        if (!oldHit) oldFlagged++;
        if (!newHit) newFlagged++;
        if (!oldHit && newHit) {
          oldFalsePos++;
          if (oldOnlyExamples.length < 20) oldOnlyExamples.push({ team, name: b.name });
        }
      }
    }
  }
  console.log('  batters on 2026-07-23 slate: ' + allBatters);
  console.log('  OLD check flagged: ' + oldFlagged);
  console.log('  NEW check flagged: ' + newFlagged);
  console.log('  false positives eliminated by fix: ' + oldFalsePos);
  if (oldFalsePos > 0) {
    console.log('  examples of names OLD wrongly flagged (NEW resolves):');
    for (const e of oldOnlyExamples) console.log('   ', e.team, e.name);
  }
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
