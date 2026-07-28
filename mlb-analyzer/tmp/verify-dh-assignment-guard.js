'use strict';
const {
  parseEtWallClockStringMin,
  parseKalshiHhmmMin,
  parseIsoToEtMin,
  checkSourceStartMatchesSchedule,
} = require('../utils/dh-assignment-guard');

const cases = [
  // The exact incident: Kalshi ticker 1910 vs statsapi "1:40 PM ET"
  { desc: 'CLE-CIN incident: Kalshi 1910 vs statsapi 1:40 PM ET (Δ 330 min)',
    src: parseKalshiHhmmMin('1910'),
    sch: parseEtWallClockStringMin('1:40 PM ET'),
    expect: 'reject' },
  // Same-time match (single game, exact match)
  { desc: 'exact match: Kalshi 1305 vs 1:05 PM ET',
    src: parseKalshiHhmmMin('1305'),
    sch: parseEtWallClockStringMin('1:05 PM ET'),
    expect: 'accept' },
  // 15-min drift (within tolerance)
  { desc: '15-min drift: Kalshi 1320 vs 1:05 PM ET',
    src: parseKalshiHhmmMin('1320'),
    sch: parseEtWallClockStringMin('1:05 PM ET'),
    expect: 'accept' },
  // 45-min drift (outside tolerance)
  { desc: '45-min drift: Kalshi 1350 vs 1:05 PM ET',
    src: parseKalshiHhmmMin('1350'),
    sch: parseEtWallClockStringMin('1:05 PM ET'),
    expect: 'reject' },
  // Missing schedule → pass (unknown, no mismatch to flag)
  { desc: 'missing schedule → pass',
    src: parseKalshiHhmmMin('1910'), sch: null, expect: 'accept' },
  // Missing source → pass
  { desc: 'missing source → pass',
    src: null, sch: parseEtWallClockStringMin('1:40 PM ET'), expect: 'accept' },
  // Poly ISO start match
  { desc: 'Poly ISO 17:40 UTC (13:40 ET) vs 1:40 PM ET',
    src: parseIsoToEtMin('2026-07-28T17:40:00Z'),
    sch: parseEtWallClockStringMin('1:40 PM ET'),
    expect: 'accept' },
  // Border: exactly 30 min → still accept
  { desc: 'exactly 30 min drift → accept',
    src: parseKalshiHhmmMin('1335'),
    sch: parseEtWallClockStringMin('1:05 PM ET'),
    expect: 'accept' },
  // Border: 31 min → reject
  { desc: '31-min drift → reject',
    src: parseKalshiHhmmMin('1336'),
    sch: parseEtWallClockStringMin('1:05 PM ET'),
    expect: 'reject' },
];

let fails = 0;
for (const c of cases) {
  const r = checkSourceStartMatchesSchedule(c.src, c.sch, 'kalshi', 'test-gid');
  const got = r ? 'reject' : 'accept';
  const ok = got === c.expect;
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + c.desc + '  →  ' + got + (r ? '  (' + r.slice(0, 80) + '…)' : '')
    + (ok ? '' : '  (expected ' + c.expect + ')'));
}
console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
