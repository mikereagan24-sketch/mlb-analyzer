// Guard verification for the hard-cap floor loosen (fix/hard-cap-floor-allow-0.08).
//
// Confirms:
//   1. Pre-fix state: hard=0.08 alone → REJECTED (below the old 0.10 floor).
//      Verified via a synthetic schema with the pre-fix constraint applied.
//   2. Post-fix state: hard=0.08 alone with soft=0.10 in prod → REJECTED
//      by the new mirrored invariant (hard > soft = 0.08 > 0.10 = false).
//   3. Post-fix state: hard=0.08 + soft=0.06 posted together → ACCEPTED.
//   4. Post-fix state: hard=0.04 (below new 0.05 floor) → REJECTED by range.
//   5. Post-fix state: hard=0.25 alone (current prod value, no change) →
//      ACCEPTED (still >= 0.05 floor, and if soft = 0.10 in prod then
//      0.25 > 0.10 invariant holds).
//
// Read-only against the schema. No DB writes.

const path = require('path');
const { SETTINGS_SCHEMA, validateAll } = require(path.join(__dirname, '..', 'services', 'settings-schema.js'));

let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { console.log('  PASS  ' + desc); pass++; }
  else { console.log('  FAIL  ' + desc + (extra ? '  ' + JSON.stringify(extra) : '')); fail++; }
}

console.log('\n--- Post-fix schema state ---');
console.log('signal_edge_hard_cap_pp: min=' + SETTINGS_SCHEMA.signal_edge_hard_cap_pp.min +
            ' max=' + SETTINGS_SCHEMA.signal_edge_hard_cap_pp.max +
            ' default=' + SETTINGS_SCHEMA.signal_edge_hard_cap_pp.default +
            ' invariant=' + (SETTINGS_SCHEMA.signal_edge_hard_cap_pp.invariant ? 'yes' : 'no'));
console.log('signal_edge_soft_cap_pp: min=' + SETTINGS_SCHEMA.signal_edge_soft_cap_pp.min +
            ' max=' + SETTINGS_SCHEMA.signal_edge_soft_cap_pp.max +
            ' default=' + SETTINGS_SCHEMA.signal_edge_soft_cap_pp.default +
            ' invariant=' + (SETTINGS_SCHEMA.signal_edge_soft_cap_pp.invariant ? 'yes' : 'no'));

console.log('\n--- Scenario 1: prod at {soft: 0.10, hard: 0.25}, owner tries hard=0.08 alone ---');
const s1 = validateAll(
  { signal_edge_hard_cap_pp: 0.08 },
  { signal_edge_soft_cap_pp: 0.10, signal_edge_hard_cap_pp: 0.25 }
);
check('rejected by invariant (mirrors hard > soft)', !s1.ok);
check('error message mentions "must be > signal_edge_soft_cap_pp"',
  s1.ok === false && s1.errors.some(e => e.includes('must be > signal_edge_soft_cap_pp')), s1);

console.log('\n--- Scenario 2: prod at {soft: 0.10, hard: 0.25}, owner posts BOTH soft=0.06 + hard=0.08 ---');
const s2 = validateAll(
  { signal_edge_soft_cap_pp: 0.06, signal_edge_hard_cap_pp: 0.08 },
  { signal_edge_soft_cap_pp: 0.10, signal_edge_hard_cap_pp: 0.25 }
);
check('accepted (both invariants hold: 0.06 < 0.08)', s2.ok, s2);

console.log('\n--- Scenario 3: post-fix state, owner tries hard=0.04 (below new 0.05 floor) ---');
const s3 = validateAll(
  { signal_edge_hard_cap_pp: 0.04 },
  { signal_edge_soft_cap_pp: 0.05, signal_edge_hard_cap_pp: 0.08 }
);
check('rejected by range floor (0.04 < 0.05)', !s3.ok);
check('error message mentions range', s3.ok === false && s3.errors.some(e => e.includes('between')), s3);

console.log('\n--- Scenario 4: post-fix state, hard=0.25 alone (regression — should still work) ---');
const s4 = validateAll(
  { signal_edge_hard_cap_pp: 0.25 },
  { signal_edge_soft_cap_pp: 0.10, signal_edge_hard_cap_pp: 0.25 }
);
check('accepted (0.25 > 0.10 invariant holds)', s4.ok, s4);

console.log('\n--- Scenario 5: post-fix state, both keys flipped to invalid ordering (soft > hard) ---');
const s5 = validateAll(
  { signal_edge_soft_cap_pp: 0.09, signal_edge_hard_cap_pp: 0.08 },
  { signal_edge_soft_cap_pp: 0.10, signal_edge_hard_cap_pp: 0.25 }
);
check('rejected by invariant on at least one side', !s5.ok, s5);

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + '  (' + pass + ' pass / ' + fail + ' fail)');
process.exit(fail === 0 ? 0 : 1);
