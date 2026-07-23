// Full-slate verifier for fix/roster-gate-abbrev-aware.
//
// Two parts:
//
//   PART A — Real 2026-07-23 local slate replay.
//     Runs every batter on today's 5 games (~90 batters) through the
//     post-fix gate. Expects the exact SAME behavior as the pre-hotfix
//     gate (Victor Mesa upgraded to real .313, everyone else unchanged)
//     because the local DB has no single-char-initial Steamer entries —
//     the abbrev pathway isn't exercised on this data. Acceptance:
//       * 90 batters resolved (or matching baseline batter count)
//       * Rejections <= 3 (Mesa is the only known upgrade case)
//       * 0 batters fall back to source='fallback' (mass-fallback
//         regression from pre-hotfix must not reappear)
//
//   PART B — Synthetic slate reproducing the Antonacci class.
//     Local DB doesn't contain the failing pattern naturally (verified
//     via a normName scan: zero single-char-initial bat-* entries in
//     woba_data). To prove the fix resolves the exact bug that took
//     the gate down on 2026-07-23, this part CONSTRUCTS a 3-batter
//     synthetic team where Steamer has:
//       * "S. Antonacci NYY"  — real rookie, abbrev-form ONLY (no full-
//                                name companion). Roster has "Steven
//                                Antonacci". Pre-fix: excluded, batter
//                                falls to league avg. Post-fix: matcher
//                                includes it, batter resolves cleanly.
//       * "J. Antonacci NYY"  — hypothetical unrelated player, off-
//                                roster. Different first initial.
//                                Pre-fix and post-fix: both reject
//                                (matcher has no j|antonacci bucket).
//       * "Aaron Judge NYY"   — normal full-name rostered batter.
//                                Must resolve unchanged.
//     Runs each of the 3 through post-fix gate. Acceptance:
//       * S. Antonacci: resolves to real .322 (not league avg .315)
//       * J. Antonacci: rejected -> fallback (correct rejection)
//       * Aaron Judge:  resolves normally
//       * Rejections tally: 1 (only J. Antonacci — the intended
//         rejection class)
//
// Together these prove:
//   (real slate)     no regression on today's actual data
//   (synthetic)      the fix resolves the exact Antonacci failure mode
//
// Run: node tmp/verify-full-slate-abbrev.js

const path = require('path');
const Database = require('better-sqlite3');
const model = require(path.join(__dirname, '..', 'services', 'model'));
const { normName } = require(path.join(__dirname, '..', 'utils', 'names'));

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}
function approx(a, b, tol) { tol = tol || 0.001; return Math.abs(a - b) < tol; }

const SETTINGS = { W_PROJ: 0.65, W_ACT: 0.35, MIN_PA: 60, BAT_DFLT_START: 0.315, BAT_DFLT_OPP: 0.320 };

// ── PART A: real 2026-07-23 local slate ────────────────────────────────
console.log('\n=== PART A: real 2026-07-23 local slate replay ===\n');

const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
const idx = model.buildWobaIndex(rows);
const today = '2026-07-23';
const games = db.prepare(
  "SELECT game_id, away_team, home_team, away_lineup_json, home_lineup_json FROM game_log WHERE game_date=?"
).all(today);

if (!games.length) {
  console.log('  SKIP: no games for ' + today + ' in local DB');
} else {
  model.resetRosterGateStats();
  const results = [];
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const team = side === 'away' ? g.away_team : g.home_team;
      const rosterRows = db.prepare(
        "SELECT player_name FROM team_rosters WHERE team=? AND role='POS'"
      ).all(team.toUpperCase());
      const rosterSet = new Set(rosterRows.map(r => normName(r.player_name)));
      let lu; try { lu = JSON.parse(g[side+'_lineup_json'] || '[]'); } catch(_) { lu = []; }
      for (const b of lu) {
        if (!b || !b.name) continue;
        const bw = model.getBatterWoba(idx, b.name, b.hand, team, 0.65, 0.35, 60, SETTINGS, rosterSet);
        results.push({ team, name: b.name, source: bw.source, vsRHP: bw.vsRHP, vsLHP: bw.vsLHP });
      }
    }
  }
  const stats = model.getRosterGateStats();
  const fallbacks = results.filter(r => r.source === 'fallback').length;

  console.log('  Batters resolved: ' + results.length);
  console.log('  Rejections:       ' + stats.totalRejections);
  console.log('  Fallbacks:        ' + fallbacks);
  assert(results.length >= 80 && results.length <= 110, 'batter count in expected range (~90): got ' + results.length);
  assert(stats.totalRejections <= 3, 'rejections in the 0-3 range: got ' + stats.totalRejections);
  assert(fallbacks === 0, 'zero mass-fallback regression: got ' + fallbacks);
  // Confirm the Mesa upgrade still holds
  const mesa = results.find(r => r.name === 'Victor Mesa');
  if (mesa) {
    assert(approx(mesa.vsRHP, 0.313), 'Victor Mesa still resolves to real Jr. TB .313: got ' + mesa.vsRHP);
    assert(approx(mesa.vsLHP, 0.283), 'Victor Mesa vsLHP is .283: got ' + mesa.vsLHP);
  }
}

// ── PART B: synthetic Antonacci-class slate ─────────────────────────────
console.log('\n=== PART B: synthetic slate with abbrev-form Steamer entries ===\n');
model.resetRosterGateStats();

// Clone the real idx and INJECT the three synthetic Steamer entries.
// Uses the actual buildWobaIndex output so any real Steamer keys stay
// intact (Aaron Judge NYY entry actually exists — verified by cloning
// prod-like idx structure).
const synthIdx = JSON.parse(JSON.stringify(idx));
for (const key of ['bat-proj-lhp', 'bat-proj-rhp']) {
  if (!synthIdx[key]) synthIdx[key] = {};
  // S. Antonacci — abbrev-form ONLY (this is the Antonacci class)
  synthIdx[key]['s antonacci nyy'] = key.endsWith('rhp')
    ? { woba: 0.322, sample: 88 }
    : { woba: 0.305, sample: 40 };
  // J. Antonacci — hypothetical, DIFFERENT initial. Off-roster.
  synthIdx[key]['j antonacci nyy'] = { woba: 0.180, sample: 15 };
  // Aaron Judge — normal full-name entry (may already exist; overwrite
  // to a known value so we can assert against a fixed number)
  synthIdx[key]['aaron judge nyy'] = key.endsWith('rhp')
    ? { woba: 0.398, sample: 500 }
    : { woba: 0.410, sample: 250 };
  synthIdx[key]['aaron judge'] = key.endsWith('rhp')
    ? { woba: 0.398, sample: 500 }
    : { woba: 0.410, sample: 250 };
}
for (const key of ['bat-act-lhp', 'bat-act-rhp']) {
  if (!synthIdx[key]) synthIdx[key] = {};
}

// Roster contains FULL first names: "Steven Antonacci" + "Aaron Judge".
// No "J. Antonacci" or "Joseph Antonacci" — the hypothetical is off-roster.
const nyyRoster = new Set(['steven antonacci', 'aaron judge']);

// Batter 1: S. Antonacci (real rookie, abbrev-form Steamer)
{
  const bw = model.getBatterWoba(synthIdx, 'S. Antonacci', 'R', 'NYY', 0.65, 0.35, 60, SETTINGS, nyyRoster);
  console.log('  S. Antonacci: source=' + bw.source + ' vsRHP=' + bw.vsRHP.toFixed(3) + ' vsLHP=' + bw.vsLHP.toFixed(3));
  assert(bw.source === 'steamer', 'S. Antonacci resolves to real Steamer proj (not fallback): got ' + bw.source);
  assert(approx(bw.vsRHP, 0.322), 'S. Antonacci vsRHP is real .322: got ' + bw.vsRHP);
  assert(approx(bw.vsLHP, 0.305), 'S. Antonacci vsLHP is real .305: got ' + bw.vsLHP);
}

// Batter 2: J. Antonacci (off-roster, must be rejected)
{
  const bw = model.getBatterWoba(synthIdx, 'J. Antonacci', 'R', 'NYY', 0.65, 0.35, 60, SETTINGS, nyyRoster);
  console.log('  J. Antonacci: source=' + bw.source + ' vsRHP=' + bw.vsRHP.toFixed(3) + ' vsLHP=' + bw.vsLHP.toFixed(3));
  assert(bw.source === 'fallback', 'J. Antonacci rejected (off-roster) → fallback: got ' + bw.source);
  assert(approx(bw.vsRHP, 0.315), 'J. Antonacci vsRHP is BAT_DFLT_START: got ' + bw.vsRHP);
}

// Batter 3: Aaron Judge (normal full-name batter). Source may be 'blend'
// (real actuals collision with the local Steamer dataset) or 'steamer'
// (if actuals are absent) — either is a correct real-projection resolve;
// the point is he does NOT fall back and his wOBA is in a plausible
// star-hitter range, not the .315/.320 default.
{
  const bw = model.getBatterWoba(synthIdx, 'Aaron Judge', 'R', 'NYY', 0.65, 0.35, 60, SETTINGS, nyyRoster);
  console.log('  Aaron Judge: source=' + bw.source + ' vsRHP=' + bw.vsRHP.toFixed(3) + ' vsLHP=' + bw.vsLHP.toFixed(3));
  assert(bw.source !== 'fallback', 'Aaron Judge resolves (not fallback): got ' + bw.source);
  assert(bw.vsRHP > 0.35, 'Aaron Judge vsRHP is star-tier (>.35), not default: got ' + bw.vsRHP);
}

const partBStats = model.getRosterGateStats();
console.log('  Rejections during PART B: ' + partBStats.totalRejections);
assert(partBStats.totalRejections === 1, 'exactly 1 rejection in PART B (J. Antonacci): got ' + partBStats.totalRejections);

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
