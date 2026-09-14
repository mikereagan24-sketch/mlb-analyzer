#!/usr/bin/env node
// As-of FRV read for the replay path. (2026-09-14)
//   node scripts/test-frv-asof.js
// Exit 1 on any failure.
//
// WHAT THIS PROTECTS. utils/fielding-frv-term.js read current-state
// fielding_frv for every caller, so a harness replaying a June game priced
// it with FRV that already knew how those fielders turned out -- 96-116
// days of hindsight in W1 of the 2026 season run. Production still reads
// current state, correctly: for tonight's game current state IS the as-of
// value. Only replay changes.
//
// THE THREE FAILURE MODES, each with an assertion below:
//   1. substituting current state for an as-of miss. Changed 2026-09-14:
//      a miss now resolves as MISSING. "No as-of row" does not mean "data
//      unavailable", it means the player had not crossed FRV_MIN_OUTS yet,
//      and current state there is hindsight on exactly the slots where it
//      is largest -- a player who qualified later is one whose sample grew
//      most since. Measured on the 2026-09-14 hindsight run: 535 slot-
//      instances over 1594 sides, 4.8%, all from snapshot roster growth
//      (480 players on 06-16 to 521 on 09-12), none from missing dates.
//   2. vintage mixing in the position fallback -- ordering by outs_total
//      ACROSS dates can return a bigger-sample row from a LATER snapshot,
//      which is hindsight sneaking in through the fallback branch
//   3. production drifting onto the as-of path, which would price tonight
//      off a stale snapshot instead of the current table
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { fieldingRunsPerGame } = require(path.join(R, 'utils/fielding-frv-term'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}

// ---- a fixture with two vintages and a deliberate trap ----------------
// Player 1 (SS, code 6): a small-sample June row and a big-sample
// September row. An as-of June read must return the JUNE number. If the
// primary lookup orders by outs_total across dates it returns September's,
// which is failure mode 2.
const mem = new Database(':memory:');
mem.exec(
  'CREATE TABLE fielding_frv (mlb_id INTEGER, name TEXT, total_runs REAL, outs_total INTEGER, '
  + 'position TEXT, season_start TEXT, season_end TEXT, PRIMARY KEY (mlb_id, position));'
  + 'CREATE TABLE fielding_frv_snapshot (snapshot_date TEXT, mlb_id INTEGER, name TEXT, '
  + 'total_runs REAL, outs_total INTEGER, position TEXT, season_start TEXT, season_end TEXT, '
  + 'PRIMARY KEY (snapshot_date, mlb_id, position));');
const insCur = mem.prepare('INSERT INTO fielding_frv VALUES (?,?,?,?,?,NULL,NULL)');
const insSnap = mem.prepare('INSERT INTO fielding_frv_snapshot VALUES (?,?,?,?,?,?,NULL,NULL)');

// current state: player 1 at SS, +12 runs over 3000 outs
insCur.run(1, 'Asof Tester', 12.0, 3000, '6');
// current state: player 2 at 2B, present ONLY in current state (no snapshot)
insCur.run(2, 'No Snapshot', 6.0, 1200, '4');
// snapshots: June (small sample, NEGATIVE) and September (big, positive)
insSnap.run('2026-06-10', 1, 'Asof Tester', -3.0, 900, '6');
insSnap.run('2026-09-12', 1, 'Asof Tester', 12.0, 3000, '6');
// the trap for mode 2: in September player 1 also has a BIGGER row at 3B.
// A June as-of read of a 3B start must not reach the September row.
insSnap.run('2026-09-12', 1, 'Asof Tester', 20.0, 9000, '5');

const q = {
  getFieldingFrvByIdPos: mem.prepare(
    'SELECT * FROM fielding_frv WHERE mlb_id=? AND position=?'),
  getFieldingFrvPrimary: mem.prepare(
    'SELECT * FROM fielding_frv WHERE mlb_id=? ORDER BY outs_total DESC LIMIT 1'),
  getFieldingFrvAsOfIdPos: mem.prepare(
    'SELECT * FROM fielding_frv_snapshot WHERE mlb_id=? AND position=? AND snapshot_date<=? '
    + 'ORDER BY snapshot_date DESC LIMIT 1'),
  getFieldingFrvAsOfPrimary: mem.prepare(
    'SELECT * FROM fielding_frv_snapshot WHERE mlb_id=? AND snapshot_date=('
    + '  SELECT MAX(snapshot_date) FROM fielding_frv_snapshot WHERE mlb_id=? AND snapshot_date<=?'
    + ') ORDER BY outs_total DESC LIMIT 1'),
};
const OPPS = 25;
function run(lineup, asOfDate) {
  return fieldingRunsPerGame({
    q: q, team: 'TST', lineupJson: lineup, settings: { DEFENSE_FRV_OPPS_PER_GAME: OPPS },
    resolveId: (t, name) => (name === 'Asof Tester' ? 1 : (name === 'No Snapshot' ? 2 : null)),
    onWarn: function () {},
    asOfDate: asOfDate,
  });
}
const SS = [{ name: 'Asof Tester', pos: 'SS' }];

console.log('1. the vintage actually changes the number');
const cur = run(SS, null);
const jun = run(SS, '2026-06-10');
const sep = run(SS, '2026-09-12');
// (12/3000)*25 = +0.10 ;  (-3/900)*25 = -0.0833
check('current state reads the current table', Number(cur.value.toFixed(4)), 0.1);
check('as-of June reads the JUNE row (sign flips)', Number(jun.value.toFixed(4)), -0.0833);
check('as-of September matches current state here', Number(sep.value.toFixed(4)), 0.1);
check('asOfDate is reported back on the result', [cur.asOfDate, jun.asOfDate],
  [null, '2026-06-10']);
check('neither read had an as-of miss', [jun.asofMissing, sep.asofMissing], [0, 0]);

console.log('');
console.log('2. a date BEFORE the snapshot era resolves MISSING, not current state');
// 2026-05-01 predates every snapshot row. Current state EXISTS for this
// player (+0.10) and is deliberately not substituted.
const pre = run(SS, '2026-05-01');
check('the side value is null, not the current-state 0.10', pre.value, null);
check('the miss is counted', pre.asofMissing, 1);
check('it counts as missing, so the team value scales over what resolved',
  [pre.missing, pre.resolved], [1, 0]);
check('the detail names why',
  pre.details.filter((d) => d.why === 'asof_no_row_at_date').length, 1);
// If current state had been consulted the slot would have landed in exact
// or fallback. Neither may move.
check('current state was not consulted at all', [pre.exact, pre.fallback], [0, 0]);

console.log('');
console.log('3. THE TRAP: the position fallback must not mix vintages');
// Player 1 has no June row at 3B. His biggest-sample row overall is the
// SEPTEMBER 3B row (9000 outs). A June as-of read must fall back WITHIN
// June -- to the June SS row -- not forward to September.
const junAt3B = run([{ name: 'Asof Tester', pos: '3B' }], '2026-06-10');
check('June 3B start falls back to the JUNE row, not September',
  Number(junAt3B.value.toFixed(4)), -0.0833);
check('it is recorded as a position fallback', junAt3B.fallback, 1);
check('and the vintage on the detail is the June snapshot',
  junAt3B.details.filter((d) => d.why === 'position_fallback')[0].vintage, '2026-06-10');
// The September read SHOULD reach the 20.0/9000 row: (20/9000)*25 = 0.0556
const sepAt3B = run([{ name: 'Asof Tester', pos: '3B' }], '2026-09-12');
check('September 3B start DOES use the September 3B row (exact match)',
  [Number(sepAt3B.value.toFixed(4)), sepAt3B.exact], [0.0556, 1]);

console.log('');
console.log('4. a player absent from the snapshots entirely');
const noSnap = run([{ name: 'No Snapshot', pos: '2B' }], '2026-09-12');
check('resolves missing even though current state has him at +0.125',
  [noSnap.value, noSnap.asofMissing, noSnap.missing], [null, 1, 1]);

console.log('');
console.log('4b. a PARTIAL side scales over the slots that resolved');
// The case the old current-state substitution hid: one resolvable slot,
// one as-of miss. The team value must be the resolved slot mean scaled to
// the full complement -- (0.10 / 1) * 2 = 0.20 -- and must NOT be the
// two-slot sum that treats the missing fielder as league-average.
const partial = run([{ name: 'Asof Tester', pos: 'SS' },
                     { name: 'No Snapshot', pos: '2B' }], '2026-09-12');
check('scaled over the resolved slot, not summed with an implied average',
  Number(partial.value.toFixed(4)), 0.2);
check('counts line up', [partial.fielders, partial.resolved, partial.missing,
  partial.asofMissing], [2, 1, 1, 1]);

console.log('');
console.log('5. PRODUCTION STAYS ON CURRENT STATE');
const fs = require('fs');
const strip = (src) => src.split('\n').filter(
  (l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const jobsSrc = strip(fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8'));
// The production call site must not pass an as-of date. It builds the term
// via teamFieldingRunsPerGame with 6 args; an as-of date would be a 8th.
const prodCalls = jobsSrc.match(/teamFieldingRunsPerGame\([^)]*\)/g) || [];
check('production calls the term', prodCalls.length > 0, true);
check('and passes no asOfDate (current state is correct for tonight)',
  prodCalls.some((c) => /asOf/i.test(c)), false);
// The harness path, conversely, must pass one.
const hiSrc = strip(fs.readFileSync(path.join(R, 'services/harness-inputs.js'), 'utf8'));
check('the harness path computes an as-of date', /asOf/.test(hiSrc), true);
check('default mode is asof, not current',
  /process\.env\.FRV_READ \|\| 'asof'/.test(hiSrc), true);

console.log('');
console.log('6. the mode switch refuses a value it does not understand');
const hi = require(path.join(R, 'services/harness-inputs'));
const saved = process.env.FRV_READ;
process.env.FRV_READ = 'asof';
check('asof', hi.frvReadMode(), { mode: 'asof', pinned: null });
process.env.FRV_READ = 'current';
check('current', hi.frvReadMode(), { mode: 'current', pinned: null });
process.env.FRV_READ = 'asof:2026-09-12';
check('pinned vintage parses', hi.frvReadMode(), { mode: 'asof-pinned', pinned: '2026-09-12' });
process.env.FRV_READ = 'as-of';
let threw = false;
try { hi.frvReadMode(); } catch (e) { threw = true; }
check('a typo THROWS rather than silently scoring current state', threw, true);
process.env.FRV_READ = 'asof:09-12-2026';
threw = false;
try { hi.frvReadMode(); } catch (e) { threw = true; }
check('a wrong-order date throws too', threw, true);
if (saved === undefined) delete process.env.FRV_READ; else process.env.FRV_READ = saved;

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
