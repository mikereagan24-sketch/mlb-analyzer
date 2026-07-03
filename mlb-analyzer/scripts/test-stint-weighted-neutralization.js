// Fixture tests for fix/park-neutral-stint-weighted.
//
// 1. Single-team player: PA-weighted factor === current-team factor
//    (regression — must be byte-identical to PR #144).
// 2. Synthetic multi-team: 200 games at COL (1.10) + 100 at LAD (1.00)
//    → factor = (200*1.10 + 100*1.00)/300 = 1.0667.
// 3. Toggle OFF: no neutralization applied even for multi-team players.
// 4. Missing stint data: falls back to current-team factor (never fails).
// 5. Pitcher weighting: 300 TBF at COL + 200 TBF at SF (0.94)
//    → factor = (300*1.10 + 200*0.94)/500 = 1.036.
//
// Run: node scripts/test-stint-weighted-neutralization.js

const model = require('../services/model');
const { getWobaParkFactor, computeStintWeightedFactor } = require('../services/park-factors-woba');
const stintCache = require('../services/stint-cache');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

// ── Test 1: single-team player is byte-identical to current-team ───────
console.log('\n=== Test 1: single-team player → identical to current-team factor ===');
{
  const teamMap = new Map([['COL', 150]]);
  const weighted = computeStintWeightedFactor(teamMap);
  expect('single-team returns null (caller falls back to current-team)',
    weighted === null, 'got ' + weighted);
  const factor = getWobaParkFactor('COL');
  expect('current-team factor for COL is 1.10', Math.abs(factor - 1.10) < 1e-9);
}

// ── Test 2: synthetic multi-team COL/LAD 200/100 → 1.0667 ────────────
console.log('\n=== Test 2: synthetic multi-team COL/LAD 200/100 → 1.0667 ===');
{
  const teamMap = new Map([['COL', 200], ['LAD', 100]]);
  const weighted = computeStintWeightedFactor(teamMap);
  const expected = (200 * 1.10 + 100 * 1.00) / 300;
  expect('multi-team returns PA-weighted average',
    weighted != null && Math.abs(weighted - expected) < 1e-9,
    'got ' + weighted + ', expected ' + expected);
  expect('the weighted factor is 1.0667 exactly',
    weighted != null && Math.abs(weighted - 1.06666666666667) < 1e-6,
    'got ' + (weighted != null ? weighted.toFixed(8) : 'null'));
}

// ── Test 3: end-to-end via resolveNeutralizationFactor + getBatterWoba ─
console.log('\n=== Test 3: end-to-end getBatterWoba with synthetic cache ===');
{
  // Inject a synthetic stint cache so the DB lookup returns our
  // controlled distribution.
  const batterCache = new Map();
  batterCache.set('multi team hitter', new Map([['COL', 200], ['LAD', 100]]));
  batterCache.set('single team hitter', new Map([['LAD', 150]]));
  stintCache._injectCache(batterCache, new Map());

  const { normName } = require('../utils/names');
  const PLAYER_MULTI  = 'Multi Team Hitter';
  const PLAYER_SINGLE = 'Single Team Hitter';
  const RAW_PROJ = 0.320, RAW_ACT = 0.340;
  const W_PROJ = 0.45, W_ACT = 0.55;

  // Build a wOBA index with the same raw values for both hands
  const idx = {};
  const keys = ['bat-proj-lhp','bat-proj-rhp','bat-act-lhp','bat-act-rhp'];
  for (const k of keys) {
    idx[k] = {};
    const woba = k.includes('proj') ? RAW_PROJ : RAW_ACT;
    idx[k][normName(PLAYER_MULTI)]  = { woba, sample: 500 };
    idx[k][normName(PLAYER_SINGLE)] = { woba, sample: 500 };
  }
  const settingsOn = { W_PROJ, W_ACT, MIN_PA: 60, PARK_NEUTRAL_INPUTS_ENABLED: true };
  const settingsOff = { W_PROJ, W_ACT, MIN_PA: 60, PARK_NEUTRAL_INPUTS_ENABLED: false };

  // Multi-team hitter: teamHint='COL' (current team) but stint-weighted
  // factor is 1.0667.
  const wMulti = model.getBatterWoba(idx, PLAYER_MULTI, 'R', 'COL',
    W_PROJ, W_ACT, 60, settingsOn);
  // Neutralized act term: 0.340 / (1 + (1.0667-1)/2) = 0.340 / 1.03333 = 0.329032
  const expectedActNeutr = RAW_ACT / (1 + (1.0666666666666667 - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('multi-team hitter uses stint-weighted factor (~1.067)',
    Math.abs(wMulti.vsRHP - expectedBlend) < 1e-6,
    'got ' + wMulti.vsRHP.toFixed(6) + ', expected ' + expectedBlend.toFixed(6));

  // Single-team hitter: teamHint='LAD' (neutral 1.00) — actuals stay
  // raw because factor is 1.00.
  const wSingle = model.getBatterWoba(idx, PLAYER_SINGLE, 'R', 'LAD',
    W_PROJ, W_ACT, 60, settingsOn);
  const rawBlend = RAW_PROJ * W_PROJ + RAW_ACT * W_ACT;
  expect('single-team LAD hitter → factor 1.00 → raw blend unchanged',
    Math.abs(wSingle.vsRHP - rawBlend) < 1e-9,
    'got ' + wSingle.vsRHP.toFixed(6) + ', expected ' + rawBlend.toFixed(6));

  // Same call with toggle OFF: neutralization is a no-op regardless of
  // stint data — byte-identical to raw.
  const wMultiOff = model.getBatterWoba(idx, PLAYER_MULTI, 'R', 'COL',
    W_PROJ, W_ACT, 60, settingsOff);
  expect('toggle OFF: multi-team returns raw blend (byte-identical)',
    Math.abs(wMultiOff.vsRHP - rawBlend) < 1e-9,
    'got ' + wMultiOff.vsRHP.toFixed(6));
}

// ── Test 4: pitcher stint weighting (COL/SF 300/200 TBF) ─────────────
console.log('\n=== Test 4: pitcher stint weighting COL/SF 300/200 TBF ===');
{
  const pitcherCache = new Map();
  pitcherCache.set('multi team pitcher', new Map([['COL', 300], ['SF', 200]]));
  stintCache._injectCache(new Map(), pitcherCache);

  const { normName } = require('../utils/names');
  const NAME = 'Multi Team Pitcher';
  const RAW_PROJ = 0.310, RAW_ACT = 0.330;
  const W_PROJ = 0.45, W_ACT = 0.55;
  const idx = {};
  const keys = ['pit-proj-lhb','pit-proj-rhb','pit-act-lhb','pit-act-rhb'];
  for (const k of keys) {
    idx[k] = {};
    const woba = k.includes('proj') ? RAW_PROJ : RAW_ACT;
    idx[k][normName(NAME)] = { woba, sample: 500 };
  }
  const settings = { W_PROJ, W_ACT, MIN_BF: 100, PARK_NEUTRAL_INPUTS_ENABLED: true };
  const w = model.getPitcherWoba(idx, NAME, 'R', 'COL',
    W_PROJ, W_ACT, 100, settings);
  const expectedFactor = (300 * 1.10 + 200 * 0.94) / 500;   // 1.036
  const expectedActNeutr = RAW_ACT / (1 + (expectedFactor - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('pitcher weighted factor is (300×1.10 + 200×0.94)/500 = ' + expectedFactor.toFixed(4),
    Math.abs(w.vsLHB - expectedBlend) < 1e-6,
    'got ' + w.vsLHB.toFixed(6) + ', expected ' + expectedBlend.toFixed(6));
}

// ── Test 5: missing stint data → fallback to current-team ────────────
console.log('\n=== Test 5: missing stint data → fallback ===');
{
  stintCache._injectCache(new Map(), new Map());
  const { normName } = require('../utils/names');
  const NAME = 'Unknown Player';
  const RAW_PROJ = 0.320, RAW_ACT = 0.340;
  const W_PROJ = 0.45, W_ACT = 0.55;
  const idx = {};
  const keys = ['bat-proj-lhp','bat-proj-rhp','bat-act-lhp','bat-act-rhp'];
  for (const k of keys) {
    idx[k] = {};
    const woba = k.includes('proj') ? RAW_PROJ : RAW_ACT;
    idx[k][normName(NAME)] = { woba, sample: 500 };
  }
  const settings = { W_PROJ, W_ACT, MIN_PA: 60, PARK_NEUTRAL_INPUTS_ENABLED: true };
  // No stint entry for this player → falls back to current-team COL
  const w = model.getBatterWoba(idx, NAME, 'R', 'COL',
    W_PROJ, W_ACT, 60, settings);
  const currentTeamFactor = 1.10;
  const expectedActNeutr = RAW_ACT / (1 + (currentTeamFactor - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('missing stint → current-team COL factor 1.10 applied',
    Math.abs(w.vsRHP - expectedBlend) < 1e-6,
    'got ' + w.vsRHP.toFixed(6) + ', expected ' + expectedBlend.toFixed(6));
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
