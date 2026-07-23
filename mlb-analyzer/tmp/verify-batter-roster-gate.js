// Verifier for fix/batter-woba-active-roster-gate.
//
// Builds an in-memory woba_data-shaped idx that mirrors the shadow case
// found in prod (Victor Mesa 4-way ambiguity), then exercises getBatterWoba
// under three rosterSet conditions:
//
//   Case 1: rosterSet = null            → gate OFF (backtest path).
//                                         Must return VVM MIA shadow's
//                                         wOBA (.238 vsRHP, sample 0.7)
//                                         — proving pre-fix behavior
//                                         is preserved.
//   Case 2: rosterSet = { "victor mesa jr" }  → gate ON, real player rostered.
//                                         Must return .313 vsRHP,
//                                         sample 85 (the Jr. TB entry).
//                                         And must record 1 rejection.
//   Case 3: rosterSet = new Set()       → gate ON, empty roster.
//                                         All entries filtered out.
//                                         Result is BAT_DFLT_START / _OPP
//                                         fallback (source='fallback').
//                                         Rejection counter increments.
//
// Also asserts:
//   - Ronald Acuña-style case: base name matches with jr variant in idx
//     (roster has "ronald acuna jr", idx has "ronald acuna atl" — this
//     entry has a DIFFERENT base "ronald acuna" and should be REJECTED
//     because the roster is strict about jr).
//   - Same-name-no-jr case: base name in roster, idx has "player name"
//     and "player name atl" — both pass because base ∈ roster and no
//     suffix / suffix==teamHint.
//   - Cross-team shadow: "victor mesa mia" is filtered out because
//     suffix 'mia' ≠ teamHint 'tb'.
//
// Also asserts the /health-facing accessors:
//   - getRosterGateStats() returns { totalRejections, recent: [...] }
//   - resetRosterGateStats() zeroes the counter
//   - recent[] preserves rejection info (batter, teamHint, sample, key)
//
// Run: node tmp/verify-batter-roster-gate.js

const path = require('path');
const model = require(path.join(__dirname, '..', 'services', 'model'));
const { normName } = require(path.join(__dirname, '..', 'utils', 'names'));

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else      { failed++; console.log('  FAIL: ' + msg); }
}
function approx(a, b, tol) { tol = tol || 0.001; return Math.abs(a - b) < tol; }

// ── Fixture: mirrors production woba_data for the Mesa cluster ──────────
// Actual values pulled from 2026-07-22 snapshot in prod DB.
function buildIdx() {
  const idx = {
    'bat-proj-lhp': {},
    'bat-act-lhp': {},
    'bat-proj-rhp': {},
    'bat-act-rhp': {},
  };
  // Victor Mesa Jr. TB — the real rostered player. Sample 24 vs LHP,
  // 85 vs RHP, wOBA .283 / .313. All four forms present, exactly as
  // ingested into woba_data.
  const jr_lhp = { woba: 0.283, sample: 24.0 };
  const jr_rhp = { woba: 0.313, sample: 85.1 };
  idx['bat-proj-lhp'][normName('Victor Mesa Jr. TB')] = jr_lhp;
  idx['bat-proj-lhp'][normName('Victor Mesa Jr.')]    = jr_lhp;
  idx['bat-proj-rhp'][normName('Victor Mesa Jr. TB')] = jr_rhp;
  idx['bat-proj-rhp'][normName('Victor Mesa Jr.')]    = jr_rhp;

  // VVM (Victor Victor Mesa) — MIA farmhand. Sample 0.3 / 0.7, wOBA
  // .246 / .238. Both no-suffix and MIA-suffix variants.
  const vvm_lhp = { woba: 0.246, sample: 0.3 };
  const vvm_rhp = { woba: 0.238, sample: 0.7 };
  idx['bat-proj-lhp'][normName('Victor Mesa MIA')] = vvm_lhp;
  idx['bat-proj-lhp'][normName('Victor Mesa')]     = vvm_lhp;
  idx['bat-proj-rhp'][normName('Victor Mesa MIA')] = vvm_rhp;
  idx['bat-proj-rhp'][normName('Victor Mesa')]     = vvm_rhp;

  // A second team's plausible player for the cross-team shadow test.
  // "Michael Mesa TOR" — sample 0.8, wOBA .210 / .210.
  const mm = { woba: 0.210, sample: 0.8 };
  idx['bat-proj-lhp'][normName('Michael Mesa TOR')] = mm;
  idx['bat-proj-lhp'][normName('Michael Mesa')]     = mm;
  idx['bat-proj-rhp'][normName('Michael Mesa TOR')] = mm;
  idx['bat-proj-rhp'][normName('Michael Mesa')]     = mm;

  // A no-jr player on ATL for the non-suffix case.
  const rr = { woba: 0.360, sample: 300.0 };
  idx['bat-proj-lhp'][normName('Ronald Acuna ATL')] = rr;
  idx['bat-proj-lhp'][normName('Ronald Acuna')]     = rr;
  idx['bat-proj-rhp'][normName('Ronald Acuna ATL')] = rr;
  idx['bat-proj-rhp'][normName('Ronald Acuna')]     = rr;

  return idx;
}

const settings = {
  W_PROJ: 0.65, W_ACT: 0.35, MIN_PA: 60,
  BAT_DFLT_START: 0.315, BAT_DFLT_OPP: 0.320,
};

// ── Case 1: gate OFF (rosterSet=null). Reproduces the shadow bug. ───────
console.log('\n=== Case 1: gate OFF (rosterSet=null) — pre-fix behavior ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  const bw = model.getBatterWoba(idx, 'Victor Mesa', 'L', 'TB', 0.65, 0.35, 60, settings, null);
  assert(bw != null, 'result is non-null');
  assert(approx(bw.vsRHP, 0.238), 'vsRHP is VVM shadow .238 (bug reproduced): got ' + bw.vsRHP);
  assert(approx(bw.vsLHP, 0.246), 'vsLHP is VVM shadow .246 (bug reproduced): got ' + bw.vsLHP);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 0, 'gate-off produces zero rejections: ' + stats.totalRejections);
}

// ── Case 2: gate ON, Jr. rostered. Fix works. ───────────────────────────
console.log('\n=== Case 2: gate ON, "victor mesa jr" in rosterSet — fix ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  const roster = new Set(['victor mesa jr']);
  const bw = model.getBatterWoba(idx, 'Victor Mesa', 'L', 'TB', 0.65, 0.35, 60, settings, roster);
  assert(bw != null, 'result is non-null');
  assert(approx(bw.vsRHP, 0.313), 'vsRHP is real Jr. .313: got ' + bw.vsRHP);
  assert(approx(bw.vsLHP, 0.283), 'vsLHP is real Jr. .283: got ' + bw.vsLHP);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 1, 'exactly one rejection recorded: got ' + stats.totalRejections);
  assert(stats.recent.length === 1, 'recent[] holds one entry');
  const r = stats.recent[0];
  assert(r.batter === 'Victor Mesa', 'rejected batter name recorded');
  assert(r.teamHint === 'TB', 'rejected teamHint recorded');
  // Two shadow keys carry the same VVM projection value ("victor mesa" and
  // "victor mesa mia"); either is a correct rejectedKey. Fixture shares the
  // value ref between them exactly as the ingest does in prod.
  assert(
    r.rejectedKey === 'victor mesa' || r.rejectedKey === 'victor mesa mia',
    'rejected key is a VVM shadow entry: got ' + r.rejectedKey
  );
  assert(r.gateResolved === true, 'gateResolved flag is true (upgrade path): got ' + r.gateResolved);
  assert(approx(r.rejectedSample, 0.7), 'rejected sample 0.7 recorded: got ' + r.rejectedSample);
}

// ── Case 3: gate ON, empty roster. All filtered → fallback default. ─────
console.log('\n=== Case 3: gate ON, empty rosterSet — all filtered ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  const bw = model.getBatterWoba(idx, 'Victor Mesa', 'L', 'TB', 0.65, 0.35, 60, settings, new Set());
  assert(bw != null, 'result is non-null (fallback path)');
  assert(bw.source === 'fallback', 'source is fallback: got ' + bw.source);
  // With BAT_DFLT_START=.315 / BAT_DFLT_OPP=.320 and batter hand 'L':
  //   eff='L' → vsLHP = start (.315), vsRHP = opp (.320)
  assert(approx(bw.vsLHP, 0.315), 'vsLHP is BAT_DFLT_START: got ' + bw.vsLHP);
  assert(approx(bw.vsRHP, 0.320), 'vsRHP is BAT_DFLT_OPP: got ' + bw.vsRHP);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 1, 'one rejection recorded (empty-set path): got ' + stats.totalRejections);
}

// ── Case 4: cross-team shadow rejected ──────────────────────────────────
console.log('\n=== Case 4: Michael Mesa lookup with TB teamHint — TOR entry rejected ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  // TB rosters have neither VVM nor Michael Mesa. Empty-ish roster
  // scoped to TB. The idx has "michael mesa tor" — should be filtered
  // out because suffix 'tor' ≠ teamHint 'tb'.
  const roster = new Set(['some rando tb']);
  const bw = model.getBatterWoba(idx, 'Michael Mesa', 'L', 'TB', 0.65, 0.35, 60, settings, roster);
  assert(bw.source === 'fallback', 'Michael Mesa TOR shadow rejected → fallback: got ' + bw.source);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 1, 'one rejection: got ' + stats.totalRejections);
}

// ── Case 5: rostered no-jr player resolves correctly with gate ON ───────
console.log('\n=== Case 5: Ronald Acuña (no jr) rostered on ATL — resolves cleanly ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  const roster = new Set(['ronald acuna']);
  const bw = model.getBatterWoba(idx, 'Ronald Acuna', 'R', 'ATL', 0.65, 0.35, 60, settings, roster);
  assert(bw != null, 'result is non-null');
  assert(approx(bw.vsRHP, 0.360), 'vsRHP is ATL entry .360: got ' + bw.vsRHP);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 0, 'no rejection when gated resolution succeeds: got ' + stats.totalRejections);
}

// ── Case 6: reset zeros the counter ─────────────────────────────────────
console.log('\n=== Case 6: resetRosterGateStats zeros counter + recent[] ===');
{
  const idx = buildIdx();
  model.getBatterWoba(idx, 'Victor Mesa', 'L', 'TB', 0.65, 0.35, 60, settings, new Set(['victor mesa jr']));
  let stats = model.getRosterGateStats();
  assert(stats.totalRejections === 1, 'setup: recorded 1 rejection');
  model.resetRosterGateStats();
  stats = model.getRosterGateStats();
  assert(stats.totalRejections === 0, 'post-reset counter is 0');
  assert(stats.recent.length === 0, 'post-reset recent[] is empty');
}

// ── Case 7: null/undefined rosterSet both opt out ───────────────────────
console.log('\n=== Case 7: undefined rosterSet also opts out ===');
model.resetRosterGateStats();
{
  const idx = buildIdx();
  const bw = model.getBatterWoba(idx, 'Victor Mesa', 'L', 'TB', 0.65, 0.35, 60, settings);
  // Undefined rosterSet — same behavior as null.
  assert(approx(bw.vsRHP, 0.238), 'undefined rosterSet reproduces pre-fix VVM shadow: got ' + bw.vsRHP);
  const stats = model.getRosterGateStats();
  assert(stats.totalRejections === 0, 'gate stays off for undefined rosterSet');
}

console.log();
console.log('=== Summary ===');
console.log('  Passed: ' + passed);
console.log('  Failed: ' + failed);
process.exit(failed === 0 ? 0 : 1);
