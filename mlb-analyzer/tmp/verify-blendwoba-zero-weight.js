'use strict';
// Verification for fix/blendwoba-zero-weight.
//
//   A. weightOr semantics: 0 preserved, null/undefined/''/NaN -> default.
//   B. BYTE-IDENTITY for every weight production or any existing sweep
//      has ever used. This is the guard that matters — the fix must not
//      move a single historical number.
//   C. The endpoints now do what they say: W_PROJ=0 -> exactly the
//      actuals wOBA, W_PROJ=1 -> exactly the projection.
//   D. Weights sum to 1 across the whole range (they did not at 0/1).
//   E. Same behaviour through the real getBatterWoba / getPitcherWoba
//      entry points, not just the arithmetic.
//
// Run: <node20>/node.exe tmp/verify-blendwoba-zero-weight.js
const model = require('../services/model');
const { weightOr, buildWobaIndex, getBatterWoba, getPitcherWoba } = model;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + (detail ? ': ' + detail : ''));
};
const near = (a, b) => Math.abs(a - b) < 1e-12;

// ---- A. weightOr ----------------------------------------------------
console.log('=== A. weightOr semantics ===');
ok('0 preserved', weightOr(0, 0.65) === 0, 'got ' + weightOr(0, 0.65));
ok('1 preserved', weightOr(1, 0.35) === 1);
ok('0.45 preserved', weightOr(0.45, 0.65) === 0.45);
ok('numeric string coerced', weightOr('0.2', 0.65) === 0.2);
ok('null -> default', weightOr(null, 0.65) === 0.65);
ok('undefined -> default', weightOr(undefined, 0.65) === 0.65);
ok("'' -> default", weightOr('', 0.65) === 0.65);
ok('NaN -> default', weightOr(NaN, 0.65) === 0.65);
ok('garbage string -> default', weightOr('abc', 0.65) === 0.65);
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');

// ---- old vs new blend arithmetic ------------------------------------
// Verbatim pre-fix resolution, kept ONLY as the differential baseline.
const oldResolve = (wProj, wAct) => ({ wp: wProj || 0.65, wa: wAct || 0.35 });
const newResolve = (wProj, wAct) => ({ wp: weightOr(wProj, 0.65), wa: weightOr(wAct, 0.35) });

// ---- B. byte-identity over every weight ever used --------------------
console.log('=== B. byte-identity for all non-zero weights ===');
// BLEND_GRID from services/parameter-sweep.js:99 + production + the
// legacy schema defaults + the bullpen pair.
const USED = [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9];
const PROJ_WOBA = [0.280, 0.310, 0.330, 0.345, 0.380, 0.420];
const ACT_WOBA = [0.250, 0.300, 0.330, 0.355, 0.400, 0.460];
let checked = 0, moved = 0;
for (const wp of USED) {
  const wa = Math.round((1 - wp) * 100) / 100;
  if (wa === 0) continue;                     // endpoints covered in C
  const o = oldResolve(wp, wa), n = newResolve(wp, wa);
  for (const p of PROJ_WOBA) for (const a of ACT_WOBA) {
    const oldV = p * o.wp + a * o.wa;
    const newV = p * n.wp + a * n.wa;
    checked++;
    if (oldV !== newV) { moved++; if (moved <= 3) console.log('  MOVED wp=' + wp + ' proj=' + p + ' act=' + a + ' ' + oldV + ' -> ' + newV); }
  }
}
console.log('  combinations checked: ' + checked + '   values that MOVED: ' + moved);
ok('no historical value moves', moved === 0, moved + ' moved');
// The legacy fallbacks must also still fire for missing weights.
for (const miss of [null, undefined, '']) {
  const o = oldResolve(miss, miss), n = newResolve(miss, miss);
  ok('missing weight ' + JSON.stringify(miss) + ' keeps legacy 0.65/0.35',
    o.wp === n.wp && o.wa === n.wa, JSON.stringify(o) + ' vs ' + JSON.stringify(n));
}
console.log('');

// ---- C. endpoints now correct ---------------------------------------
console.log('=== C. endpoints ===');
const P = 0.330, A = 0.345;
const at = (wp) => { const r = newResolve(wp, Math.round((1 - wp) * 100) / 100); return P * r.wp + A * r.wa; };
ok('W_PROJ=0 returns exactly the actuals wOBA', near(at(0), A), at(0) + ' vs ' + A);
ok('W_PROJ=1 returns exactly the projection', near(at(1), P), at(1) + ' vs ' + P);
const oldAt = (wp) => { const r = oldResolve(wp, Math.round((1 - wp) * 100) / 100); return P * r.wp + A * r.wa; };
console.log('  W_PROJ=0  before=' + oldAt(0).toFixed(4) + '  after=' + at(0).toFixed(4) + '  (intended ' + A + ')');
console.log('  W_PROJ=1  before=' + oldAt(1).toFixed(4) + '  after=' + at(1).toFixed(4) + '  (intended ' + P + ')');
console.log('');

// ---- D. weights sum to 1 across the range ---------------------------
console.log('=== D. weight sum ===');
let badSum = 0, badSumOld = 0;
for (let i = 0; i <= 100; i++) {
  const wp = i / 100, wa = Math.round((1 - wp) * 100) / 100;
  const n = newResolve(wp, wa), o = oldResolve(wp, wa);
  if (Math.abs(n.wp + n.wa - 1) > 1e-9) badSum++;
  if (Math.abs(o.wp + o.wa - 1) > 1e-9) badSumOld++;
}
console.log('  wp in 0.00..1.00 step 0.01 -> sum != 1:  before=' + badSumOld + '  after=' + badSum);
ok('all weights sum to 1 after fix', badSum === 0, badSum + ' bad');
ok('the fix actually changed something', badSumOld > 0, 'expected pre-fix failures');
console.log('');

// ---- E. through the real entry points -------------------------------
console.log('=== E. getBatterWoba / getPitcherWoba ===');
const idx = buildWobaIndex([
  { data_key: 'bat-proj-rhp', player_name: 'Test Batter', woba: 0.330, sample_size: 500 },
  { data_key: 'bat-act-rhp', player_name: 'Test Batter', woba: 0.345, sample_size: 400 },
  { data_key: 'bat-proj-lhp', player_name: 'Test Batter', woba: 0.320, sample_size: 500 },
  { data_key: 'bat-act-lhp', player_name: 'Test Batter', woba: 0.360, sample_size: 300 },
  { data_key: 'pit-proj-rhb', player_name: 'Test Pitcher', woba: 0.300, sample_size: 500 },
  { data_key: 'pit-act-rhb', player_name: 'Test Pitcher', woba: 0.285, sample_size: 400 },
  { data_key: 'pit-proj-lhb', player_name: 'Test Pitcher', woba: 0.310, sample_size: 500 },
  { data_key: 'pit-act-lhb', player_name: 'Test Pitcher', woba: 0.295, sample_size: 300 },
]);
const stg = {};
const b0 = getBatterWoba(idx, 'Test Batter', 'R', 'SEA', 0, 1, 60, stg, null);
const b1 = getBatterWoba(idx, 'Test Batter', 'R', 'SEA', 1, 0, 60, stg, null);
const bProd = getBatterWoba(idx, 'Test Batter', 'R', 'SEA', 0.45, 0.55, 60, stg, null);
ok('batter W_PROJ=0 -> actuals', near(b0.vsRHP, 0.345), 'got ' + b0.vsRHP);
ok('batter W_PROJ=1 -> projection', near(b1.vsRHP, 0.330), 'got ' + b1.vsRHP);
ok('batter production blend unchanged', near(bProd.vsRHP, 0.330 * 0.45 + 0.345 * 0.55), 'got ' + bProd.vsRHP);
const p0 = getPitcherWoba(idx, 'Test Pitcher', 'R', 'SEA', 0, 1, 100, stg);
const p1 = getPitcherWoba(idx, 'Test Pitcher', 'R', 'SEA', 1, 0, 100, stg);
ok('pitcher W_PROJ=0 -> actuals', near(p0.vsRHB, 0.285), 'got ' + p0.vsRHB);
ok('pitcher W_PROJ=1 -> projection', near(p1.vsRHB, 0.300), 'got ' + p1.vsRHB);
console.log('  batter  @0=' + b0.vsRHP.toFixed(4) + '  @1=' + b1.vsRHP.toFixed(4)
  + '  @prod=' + bProd.vsRHP.toFixed(4) + ' (src=' + bProd.source + ')');
console.log('  pitcher @0=' + p0.vsRHB.toFixed(4) + '  @1=' + p1.vsRHB.toFixed(4));
console.log('');

console.log('=== TOTAL: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
