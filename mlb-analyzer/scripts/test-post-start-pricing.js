#!/usr/bin/env node
// The post-first-pitch pricing criterion, now shared. (2026-09-14)
//   node scripts/test-post-start-pricing.js
// Exit 1 on any failure.
//
// WHAT THIS PROTECTS. The criterion existed three times verbatim and was
// about to exist a fourth time as a production backfill. The assertions
// below are the ones a copy would have drifted on:
//   - exposure requires a PRICE-AFFECTING action after first pitch
//   - a pre-first-pitch odds lock makes the game safe whatever the audit says
//   - movement is measured against the LAST capture before first pitch
//   - an unmeasurable game is NOT clean, and gets its own reason
//   - that reason is scoped to the measured coverage window, so a game from
//     before the instrument existed is left NULL rather than condemned
//   - there is exactly one spelling of the criterion in the repo
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const psp = require(path.join(R, 'utils/post-start-pricing'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}

// ---- fixture ----------------------------------------------------------
// first pitch 2026-07-01 23:05 UTC. Captures are PT (UTC-7), so a capture
// stamped 15:00 PT = 22:00 UTC is BEFORE first pitch and 17:00 PT = 00:00
// UTC (next day) is after.
const mem = new Database(':memory:');
mem.exec(
  'CREATE TABLE game_log (game_date TEXT, game_id TEXT, first_pitch_utc TEXT, '
  + 'odds_locked_at TEXT, market_away_ml INTEGER, market_home_ml INTEGER);'
  + 'CREATE TABLE bet_signal_audit (action TEXT, created_at TEXT, game_date TEXT, '
  + 'game_id TEXT, signal_type TEXT, signal_side TEXT);'
  + 'CREATE TABLE empirical_market_captures (market_type TEXT, game_date TEXT, '
  + 'game_id TEXT, away_price_ml INTEGER, home_price_ml INTEGER, generated_at TEXT);'
  + 'CREATE TABLE bet_signals (game_date TEXT, game_id TEXT, signal_type TEXT, '
  + 'signal_side TEXT, market_line INTEGER, bet_line INTEGER, is_active INTEGER);');

const G = mem.prepare('INSERT INTO game_log VALUES (?,?,?,?,?,?)');
const A = mem.prepare('INSERT INTO bet_signal_audit VALUES (?,?,?,?,?,?)');
const C = mem.prepare('INSERT INTO empirical_market_captures VALUES (?,?,?,?,?,?)');
const S = mem.prepare('INSERT INTO bet_signals VALUES (?,?,?,?,?,?,?)');
const FP = '2026-07-01T23:05:00Z';

// 1. MOVED: refresh after first pitch, stored line differs from last pre cap
G.run('2026-07-01', 'aaa-bbb', FP, null, -150, 130);
A.run('refresh', '2026-07-01 17:30:00', '2026-07-01', 'aaa-bbb', 'ML', 'away');
C.run('ml', '2026-07-01', 'aaa-bbb', -120, 100, '2026-07-01 15:00:00');
S.run('2026-07-01', 'aaa-bbb', 'ML', 'away', -150, null, 1);

// 2. NO-OP: refresh after first pitch, stored line identical to capture
G.run('2026-07-01', 'ccc-ddd', FP, null, -120, 100);
A.run('refresh', '2026-07-01 17:30:00', '2026-07-01', 'ccc-ddd', 'ML', 'away');
C.run('ml', '2026-07-01', 'ccc-ddd', -120, 100, '2026-07-01 15:00:00');
S.run('2026-07-01', 'ccc-ddd', 'ML', 'away', -120, null, 1);

// 3. LOCKED PRE-START: audit event after first pitch but odds froze before it
G.run('2026-07-01', 'eee-fff', FP, '2026-07-01 22:00:00', -150, 130);
A.run('refresh', '2026-07-01 17:30:00', '2026-07-01', 'eee-fff', 'ML', 'away');
C.run('ml', '2026-07-01', 'eee-fff', -120, 100, '2026-07-01 15:00:00');
S.run('2026-07-01', 'eee-fff', 'ML', 'away', -150, null, 1);

// 4. NOT PRICE-AFFECTING: a grade event after first pitch is not exposure
G.run('2026-07-01', 'ggg-hhh', FP, null, -150, 130);
A.run('grade', '2026-07-01 17:30:00', '2026-07-01', 'ggg-hhh', 'ML', 'away');
C.run('ml', '2026-07-01', 'ggg-hhh', -120, 100, '2026-07-01 15:00:00');

// 5. UNMEASURABLE, INSIDE COVERAGE: exposed, but its only capture is AFTER
//    first pitch, so there is nothing to compare against.
G.run('2026-07-02', 'iii-jjj', '2026-07-02T23:05:00Z', null, -150, 130);
A.run('refresh', '2026-07-02 17:30:00', '2026-07-02', 'iii-jjj', 'ML', 'away');
C.run('ml', '2026-07-02', 'iii-jjj', -130, 110, '2026-07-02 17:20:00');
S.run('2026-07-02', 'iii-jjj', 'ML', 'away', -150, null, 1);

// 6. UNMEASURABLE, OUTSIDE COVERAGE: same shape, but dated before the
//    earliest capture in the table. No instrument existed; must stay NULL.
G.run('2026-05-01', 'kkk-lll', '2026-05-01T23:05:00Z', null, -150, 130);
A.run('refresh', '2026-05-01 17:30:00', '2026-05-01', 'kkk-lll', 'ML', 'away');
S.run('2026-05-01', 'kkk-lll', 'ML', 'away', -150, null, 1);

console.log('1. coverage is measured from the data, not remembered');
const cov = psp.captureCoverage(mem);
check('window comes from the capture rows', [cov.from, cov.to], ['2026-07-01', '2026-07-02']);
check('counts priced ml rows and games', [cov.rows, cov.games], [5, 5]);

console.log('');
console.log('2. exposure');
const exposed = psp.exposedMlSignals(mem);
const keys = [...exposed.keys()].sort();
check('a grade event is not exposure, a pre-start lock is not exposure',
  keys, ['2026-05-01|kkk-lll|away', '2026-07-01|aaa-bbb|away',
         '2026-07-01|ccc-ddd|away', '2026-07-02|iii-jjj|away']);

console.log('');
console.log('3. movement, measured against the last pre-first-pitch capture');
const cls = psp.classifyExposed(mem, exposed);
check('one moved', cls.changed.map((c) => c.gi), ['aaa-bbb']);
check('and by the right amount (-150 stored vs -120 captured)',
  cls.changed[0].d, -30);
check('one was a no-op', cls.noChange.map((c) => c.gi), ['ccc-ddd']);
check('two were unmeasurable', cls.unmeasurable.map((c) => c.gi).sort(),
  ['iii-jjj', 'kkk-lll']);

console.log('');
console.log('4. the two reasons, and the coverage scoping');
const g = psp.gamesToTag(mem, cls, cov);
check('measured movement gets priced_post_first_pitch',
  [...g.contaminated], ['2026-07-01|aaa-bbb']);
check('unmeasurable INSIDE coverage gets its own reason, not NULL',
  [...g.noCapture], ['2026-07-02|iii-jjj']);
// The scoping decision that keeps this from emptying the corpus: a game
// from before the instrument existed is not condemned by its absence.
check('unmeasurable OUTSIDE coverage is left NULL',
  [...g.outsideCoverage], ['2026-05-01|kkk-lll']);
check('a no-op refresh is tagged with nothing at all',
  [g.contaminated.has('2026-07-01|ccc-ddd'), g.noCapture.has('2026-07-01|ccc-ddd')],
  [false, false]);
check('the reasons are distinct strings',
  psp.REASON_PRICED_POST_FIRST_PITCH !== psp.REASON_NO_PRESTART_CAPTURE, true);
check('month counts group by YYYY-MM',
  psp.monthCounts(['2026-07-01|a', '2026-07-09|b', '2026-08-02|c']),
  { '2026-07': 2, '2026-08': 1 });

console.log('');
console.log('5. a game with BOTH a move and an unmeasurable side takes the stronger reason');
// Same game as 1, second side unmeasurable: it must not appear twice.
A.run('refresh', '2026-07-01 17:31:00', '2026-07-01', 'aaa-bbb', 'ML', 'home');
const ex2 = psp.exposedMlSignals(mem);
const cls2 = psp.classifyExposed(mem, ex2);
const g2 = psp.gamesToTag(mem, cls2, psp.captureCoverage(mem));
check('appears under priced_post_first_pitch only',
  [g2.contaminated.has('2026-07-01|aaa-bbb'), g2.noCapture.has('2026-07-01|aaa-bbb')],
  [true, false]);

console.log('');
console.log('6. ONE SPELLING of the criterion in the repo');
const fs = require('fs');
const files = ['scripts/post-start-price-change.js', 'scripts/tag-post-start-pricing.js',
  'services/backfill-tasks/market-contamination-post-first-pitch.js'];
for (const f of files) {
  const src = fs.readFileSync(path.join(R, f), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');
  check(f + ' imports the module', /post-start-pricing/.test(code), true);
  // The tell-tale line of the old copies: the exposed-set query built inline.
  check(f + ' does not rebuild the exposed set itself',
    /FROM bet_signal_audit/.test(code), false);
}
// And the writer is singular: only the task and the (now manual) script may
// write the column.
const writers = [];
for (const f of fs.readdirSync(path.join(R, 'services/backfill-tasks'))) {
  const src = fs.readFileSync(path.join(R, 'services/backfill-tasks', f), 'utf8');
  if (/UPDATE game_log SET market_contamination_reason/.test(src)) writers.push(f);
}
check('exactly one backfill task writes the column', writers,
  ['market-contamination-post-first-pitch.js']);

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
