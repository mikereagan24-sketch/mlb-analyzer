// Fixture tests for fix/park-neutral-stint-weighted.
//
// 1. Single-team player: PA-weighted factor === current-team factor
//    (regression — must be byte-identical to PR #144).
// 2. Synthetic multi-team: 200 games at COL + 100 at LAD
//    → factor = (200*COL + 100*LAD)/300, factors read from the live table.
// 3. Toggle OFF: no neutralization applied even for multi-team players.
// 4. Missing stint data: falls back to current-team factor (never fails).
// 5. Pitcher weighting: 300 TBF at COL + 200 TBF at SF
//    → factor = (300*COL + 200*SF)/500, factors read from the live table.
//
// Run: node scripts/test-stint-weighted-neutralization.js

const model = require('../services/model');
const { getWobaParkFactor, computeStintWeightedFactor } = require('../services/park-factors-woba');
const stintCache = require('../services/stint-cache');

// PARK FACTORS ARE READ, NOT HARDCODED. (2026-08-30)
//
// This file used to hardcode COL=1.10, LAD=1.00, SF=0.94. The wOBA park
// SOURCE switch moved them to 1.12 / 1.01 / 0.97, and all seven assertions
// began failing -- not because the stint weighting broke, but because the
// expected values were literals of a table that had changed underneath
// them. The suite carried that as an accepted failure count for weeks,
// which is precisely how a real regression hides.
//
// The subject of these tests is the WEIGHTING MATH, not the contents of
// the park table. So read the factors from the same source the code reads
// and assert the arithmetic over them. A future source change moves both
// sides together and these keep testing what they are for.
const F = t => getWobaParkFactor(t);

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
  // COL is the most extreme hitter park; assert the SHAPE, not the value.
  expect('current-team factor for COL resolves and is a hitter park (>1)',
    factor != null && isFinite(factor) && factor > 1, 'got ' + factor);
}

// ── Test 2: synthetic multi-team COL/LAD 200/100 PA ──────────────────
console.log('\n=== Test 2: synthetic multi-team COL/LAD 200/100 PA ===');
{
  const teamMap = new Map([['COL', 200], ['LAD', 100]]);
  const weighted = computeStintWeightedFactor(teamMap);
  const expected = (200 * F('COL') + 100 * F('LAD')) / 300;
  expect('multi-team returns PA-weighted average',
    weighted != null && Math.abs(weighted - expected) < 1e-9,
    'got ' + weighted + ', expected ' + expected);
  // The blend must land strictly between the two parks -- the property
  // that actually defines a weighted average, and one no literal can fake.
  expect('the weighted factor lies strictly between LAD and COL',
    weighted != null && weighted > Math.min(F('COL'), F('LAD'))
      && weighted < Math.max(F('COL'), F('LAD')),
    'got ' + (weighted != null ? weighted.toFixed(8) : 'null')
      + ' for LAD=' + F('LAD') + ' COL=' + F('COL'));
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
  // factor is the PA-weighted blend of the two parks.
  const wMulti = model.getBatterWoba(idx, PLAYER_MULTI, 'R', 'COL',
    W_PROJ, W_ACT, 60, settingsOn);
  // Neutralized act term: RAW_ACT / (1 + (weightedFactor - 1) / 2).
  const multiFactor = (200 * F('COL') + 100 * F('LAD')) / 300;
  const expectedActNeutr = RAW_ACT / (1 + (multiFactor - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('multi-team hitter uses the stint-weighted factor (' + multiFactor.toFixed(4) + ')',
    Math.abs(wMulti.vsRHP - expectedBlend) < 1e-6,
    'got ' + wMulti.vsRHP.toFixed(6) + ', expected ' + expectedBlend.toFixed(6));

  // Single-team hitter: teamHint='LAD' — no stint weighting, his own
  // park factor is applied directly.
  const wSingle = model.getBatterWoba(idx, PLAYER_SINGLE, 'R', 'LAD',
    W_PROJ, W_ACT, 60, settingsOn);
  const rawBlend = RAW_PROJ * W_PROJ + RAW_ACT * W_ACT;
  // The old form asserted 'LAD is 1.00, so the blend is untouched'. That
  // premise died with the source switch (LAD is 1.01). Assert the real
  // rule instead: a SINGLE-team player is neutralized by his own park,
  // with no stint weighting involved.
  const ladNeutr = RAW_ACT / (1 + (F('LAD') - 1) / 2);
  const ladBlend = RAW_PROJ * W_PROJ + ladNeutr * W_ACT;
  expect('single-team LAD hitter uses the plain LAD factor (' + F('LAD') + ')',
    Math.abs(wSingle.vsRHP - ladBlend) < 1e-6,
    'got ' + wSingle.vsRHP.toFixed(6) + ', expected ' + ladBlend.toFixed(6));

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
  const expectedFactor = (300 * F('COL') + 200 * F('SF')) / 500;
  const expectedActNeutr = RAW_ACT / (1 + (expectedFactor - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('pitcher weighted factor is (300×COL + 200×SF)/500 = ' + expectedFactor.toFixed(4),
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
  const currentTeamFactor = F('COL');
  const expectedActNeutr = RAW_ACT / (1 + (currentTeamFactor - 1) / 2);
  const expectedBlend = RAW_PROJ * W_PROJ + expectedActNeutr * W_ACT;
  expect('missing stint → current-team COL factor (' + currentTeamFactor + ') applied',
    Math.abs(w.vsRHP - expectedBlend) < 1e-6,
    'got ' + w.vsRHP.toFixed(6) + ', expected ' + expectedBlend.toFixed(6));
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
