// Fixture tests for fix/opener-detection-rr-consult.
//
// Isolates the SP-rotation-slot gate + freshness check from the rest of
// detectOpeners so we can exercise Gilbert-type / opener / override /
// stale-role cases without a full lineup fixture. The gate is a small,
// self-contained function; test it directly.
//
// Cases:
//   1. Fresh RR SP1..SP5 → protected (isFreshRotationSp = true).
//   2. Fresh RR SP but role_detail is empty / non-slot ("SP") → NOT protected.
//   3. Fresh RR RP + rotation-shape detail (edge case) → NOT protected.
//   4. Stale RR SP1..SP5 (role_at > 7 days) → NOT protected (falls back).
//   5. No RR row at all → NOT protected.
//   6. Malformed role_at → NOT protected.
//
// Run: node scripts/test-opener-detection-rr.js

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

// Reproduce the isFreshRotationSp inner function from services/jobs.js
// detectOpeners so we can exercise it standalone. Any drift here vs the
// live function is a regression this harness should catch — keep them
// synchronized.
function makeGate(fakeGetFgRoleByMlbId) {
  const q = { getFgRoleByMlbId: { get: fakeGetFgRoleByMlbId } };
  return function isFreshRotationSp(mlbId) {
    if (!mlbId) return false;
    const fg = q.getFgRoleByMlbId.get(mlbId);
    if (!fg || fg.role !== 'SP') return false;
    const detail = String(fg.role_detail || '').trim().toUpperCase();
    if (!/^SP[1-5]$/.test(detail)) return false;
    if (!fg.role_at) return false;
    const roleT = Date.parse(String(fg.role_at).replace(' ', 'T') + 'Z');
    if (isNaN(roleT)) return false;
    const ageDays = (Date.now() - roleT) / 86400000;
    return ageDays <= 7;
  };
}

function ymd(d) { return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 19); }
function daysAgo(n) { const t = new Date(Date.now() - n * 86400000); return ymd(t); }

console.log('\n=== Test 1: Gilbert-type — fresh RR SP1 → protected ===');
{
  const gate = makeGate((id) => id === 669302
    ? { mlb_id: 669302, role: 'SP', role_detail: 'SP1', role_at: daysAgo(1) }
    : null);
  expect('Gilbert (fresh SP1) is protected', gate(669302) === true);
}

console.log('\n=== Test 2: Fresh RR SP but no rotation-slot detail → NOT protected ===');
{
  const gate = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP', role_at: daysAgo(1) }));
  expect('role_detail="SP" (no slot number) → not protected', gate(1) === false);
  const gate2 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: null,  role_at: daysAgo(1) }));
  expect('role_detail=null → not protected', gate2(1) === false);
  const gate3 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'IL-15', role_at: daysAgo(1) }));
  expect('role_detail="IL-15" → not protected', gate3(1) === false);
}

console.log('\n=== Test 3: RR RP with rotation-shape detail (edge) → NOT protected ===');
{
  // Contrived edge: some upstream oddity where role='RP' but detail
  // happens to be "SP2" (shouldn't occur with the RR ingest but the
  // gate must not fire on a non-SP role regardless of detail).
  const gate = makeGate((id) => ({ mlb_id: id, role: 'RP', role_detail: 'SP2', role_at: daysAgo(1) }));
  expect('RP with detail SP2 → not protected (role gate)', gate(1) === false);
}

console.log('\n=== Test 4: Stale RR SP1 (>7 days) → NOT protected ===');
{
  const gate = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: daysAgo(8) }));
  expect('SP1 with role_at 8d ago → not protected (stale)', gate(1) === false);
  const gate2 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: daysAgo(30) }));
  expect('SP1 with role_at 30d ago → not protected (very stale)', gate2(1) === false);
  // Boundary: "just under 7 days" must protect. Use 6.9 days to avoid
  // sub-millisecond scheduling flake at exactly 7d (Date.now() drifts
  // between test construction and the gate's read).
  const gate3 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: daysAgo(6.9) }));
  expect('SP1 with role_at 6.9d ago → protected (just under boundary)', gate3(1) === true);
}

console.log('\n=== Test 5: No RR row at all → NOT protected ===');
{
  const gate = makeGate((_id) => undefined);
  expect('missing pitcher_fg_role row → not protected', gate(1) === false);
}

console.log('\n=== Test 6: Malformed role_at → NOT protected ===');
{
  const gate = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: 'not-a-date' }));
  expect('role_at="not-a-date" → not protected', gate(1) === false);
  const gate2 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: '' }));
  expect('role_at="" → not protected', gate2(1) === false);
  const gate3 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP1', role_at: null }));
  expect('role_at=null → not protected', gate3(1) === false);
}

console.log('\n=== Test 7: null mlbId → NOT protected ===');
{
  const gate = makeGate((_id) => ({ role: 'SP', role_detail: 'SP1', role_at: daysAgo(1) }));
  expect('null mlbId → not protected', gate(null) === false);
  expect('undefined mlbId → not protected', gate(undefined) === false);
}

console.log('\n=== Test 8: Coverage of all SP1..SP5 ===');
{
  for (const detail of ['SP1', 'SP2', 'SP3', 'SP4', 'SP5']) {
    const gate = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: detail, role_at: daysAgo(1) }));
    expect('rotation slot ' + detail + ' → protected', gate(1) === true);
  }
  const gate6 = makeGate((id) => ({ mlb_id: id, role: 'SP', role_detail: 'SP6', role_at: daysAgo(1) }));
  expect('SP6 (out of range) → not protected', gate6(1) === false);
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
