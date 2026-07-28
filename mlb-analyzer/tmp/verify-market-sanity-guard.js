'use strict';
// Verify checkMarketMLPairSanity behavior against the 2026-07-28 CLE-CIN
// incident and neighboring plausible cases.
const { checkMarketMLPairSanity } = require('../utils/market-sanity');

const cases = [
  // Incident: both positive, impossible.
  { name: 'CLE-CIN 7/28 incident +136/+105', a: 136, h: 105, expect: 'reject' },
  // Real line for game 1 (CIN -168), plausible.
  { name: 'CIN -168 real line (+142/-168)', a: 142, h: -168, expect: 'accept' },
  // Canonical pick-em with matched juice.
  { name: 'pick-em -110/-110', a: -110, h: -110, expect: 'accept' },
  // Normal juice both dogs (impossible in real book).
  { name: 'both dogs +105/+120', a: 105, h: 120, expect: 'reject' },
  // Both heavy favorites — implied-sum way over 1.20 ceiling.
  { name: 'both huge favorites -800/-800', a: -800, h: -800, expect: 'reject' },
  // Standard favorite/dog.
  { name: 'standard -150/+130', a: -150, h: 130, expect: 'accept' },
  // Extreme but real.
  { name: 'blowout -400/+320', a: -400, h: 320, expect: 'accept' },
  // Missing side → skip check.
  { name: 'null away', a: null, h: -110, expect: 'accept' },
  // Zero → skip.
  { name: 'zero home', a: -150, h: 0, expect: 'accept' },
];

let fails = 0;
for (const c of cases) {
  const r = checkMarketMLPairSanity(c.a, c.h);
  const got = r ? 'reject' : 'accept';
  const ok = got === c.expect;
  if (!ok) fails++;
  console.log(
    (ok ? 'PASS' : 'FAIL') + '  ' + c.name +
    '  → ' + got + (r ? '  reason: ' + r : '') +
    (ok ? '' : '  (expected ' + c.expect + ')')
  );
}
console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
