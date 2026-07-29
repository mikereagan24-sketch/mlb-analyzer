'use strict';
// Unit-test the widened parseGameTimeToEtHm parser against every
// observed game_time shape in game_log + hypothetical shapes a future
// bootstrap path might emit.

const { _internal } = require('../services/weather');
const { parseGameTimeToEtHm } = _internal;

const cases = [
  // === Currently observed shapes (from survey-game-time-formats) ===
  { desc: '"9:40 PM ET" (dominant statsapi/RW shape)',      in: '9:40 PM ET',      expect: { hour: 21, minute: 40 } },
  { desc: '"12:10 PM ET" (2-digit hour)',                   in: '12:10 PM ET',     expect: { hour: 12, minute: 10 } },
  { desc: '"2:10 PM ET"',                                   in: '2:10 PM ET',      expect: { hour: 14, minute: 10 } },
  { desc: '"10:05 PM ET"',                                  in: '10:05 PM ET',     expect: { hour: 22, minute: 5 } },
  { desc: '"7:15 PM" (no tz suffix)',                       in: '7:15 PM',         expect: { hour: 19, minute: 15 } },
  { desc: '"10:45 AM" (no tz)',                             in: '10:45 AM',        expect: { hour: 10, minute: 45 } },

  // === Boundary cases for AM/PM ===
  { desc: '"12:00 AM" (midnight → 0)',                      in: '12:00 AM',        expect: { hour: 0, minute: 0 } },
  { desc: '"12:00 PM" (noon → 12)',                         in: '12:00 PM',        expect: { hour: 12, minute: 0 } },
  { desc: '"12:30 AM"',                                     in: '12:30 AM',        expect: { hour: 0, minute: 30 } },
  { desc: '"12:30 PM"',                                     in: '12:30 PM',        expect: { hour: 12, minute: 30 } },
  { desc: '"11:59 PM"',                                     in: '11:59 PM',        expect: { hour: 23, minute: 59 } },

  // === Case / whitespace robustness ===
  { desc: '"9:40 pm ET" (lowercase am/pm)',                 in: '9:40 pm ET',      expect: { hour: 21, minute: 40 } },
  { desc: '"9:40PM ET" (no space before AM/PM)',            in: '9:40PM ET',       expect: { hour: 21, minute: 40 } },
  { desc: '"  9:40 PM ET  " (leading/trailing whitespace)', in: '  9:40 PM ET  ',  expect: { hour: 21, minute: 40 } },
  { desc: '"9:40:00 PM ET" (with seconds)',                 in: '9:40:00 PM ET',   expect: { hour: 21, minute: 40 } },

  // === 24-hour shapes ===
  { desc: '"21:40 ET" (24-hour with ET suffix)',            in: '21:40 ET',        expect: { hour: 21, minute: 40 } },
  { desc: '"21:40" (bare 24-hour)',                         in: '21:40',           expect: { hour: 21, minute: 40 } },
  { desc: '"09:40" (24-hour, leading zero)',                in: '09:40',           expect: { hour: 9, minute: 40 } },
  { desc: '"00:00" (24-hour midnight)',                     in: '00:00',           expect: { hour: 0, minute: 0 } },
  { desc: '"23:59"',                                        in: '23:59',           expect: { hour: 23, minute: 59 } },
  { desc: '"18:40 PT" (24-hour, non-ET suffix)',            in: '18:40 PT',        expect: { hour: 18, minute: 40 } },

  // === ISO shapes ===
  { desc: 'ISO UTC "2026-07-29T21:40:00Z" (statsapi gameDate)', in: '2026-07-29T21:40:00Z',       expect: { hour: 17, minute: 40 } },  // 21:40 UTC = 17:40 EDT
  { desc: 'ISO with tz offset -04:00',                          in: '2026-07-29T21:40:00-04:00',  expect: { hour: 21, minute: 40 } },
  { desc: 'ISO naive (assume ET)',                              in: '2026-07-29T21:40:00',        expect: { hour: 21, minute: 40 } },
  { desc: 'ISO with fractional seconds',                        in: '2026-07-29T21:40:00.000Z',   expect: { hour: 17, minute: 40 } },

  // === Legitimately unparseable ===
  { desc: 'null',                                          in: null,               expect: null },
  { desc: 'empty string',                                  in: '',                 expect: null },
  { desc: 'whitespace only',                               in: '   ',              expect: null },
  { desc: '"TBD"',                                         in: 'TBD',              expect: null },
  { desc: '"TBD ET"',                                      in: 'TBD ET',           expect: null },
  { desc: '"pending"',                                     in: 'pending',          expect: null },
  { desc: '"9:60 PM ET" (invalid minute)',                 in: '9:60 PM ET',       expect: null },
  { desc: '"13:00 PM" (13 with PM is invalid)',            in: '13:00 PM',         expect: null },
  { desc: '"25:00" (invalid 24-hour)',                     in: '25:00',            expect: null },
  { desc: '"garbage input"',                               in: 'garbage input',    expect: null },
];

let fail = 0;
for (const c of cases) {
  const got = parseGameTimeToEtHm(c.in);
  const ok = (got === null && c.expect === null)
    || (got != null && c.expect != null && got.hour === c.expect.hour && got.minute === c.expect.minute);
  if (!ok) fail++;
  console.log(
    (ok ? 'PASS' : 'FAIL') + '  ' + c.desc
    + '  →  ' + (got ? '{ h:' + got.hour + ', m:' + got.minute + ' }' : 'null')
    + (ok ? '' : '  (expected ' + (c.expect ? '{ h:' + c.expect.hour + ', m:' + c.expect.minute + ' }' : 'null') + ')')
  );
}
console.log('\n' + (fail ? fail + ' FAILURE(S) of ' + cases.length : 'ALL ' + cases.length + ' PASS'));
process.exit(fail ? 1 : 0);
