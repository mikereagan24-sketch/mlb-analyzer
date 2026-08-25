#!/usr/bin/env node
/**
 * Synthetic test for the delete-missing guard. (2026-08-24)
 *
 * WHY THIS EXISTS. The guard's failure mode is emptying a pricing-path
 * table: a truncated fetch, a parser returning [] on an unexpected
 * header, or an upstream stub, and `catcher_framing` goes to zero. Every
 * consumer then silently falls through to the 2023-25 baseline at x0.80,
 * or to no adjustment at all — and nothing reports it, because an empty
 * table and a table of legitimately-absent catchers are indistinguishable
 * downstream.
 *
 * That branch could previously only be exercised by Savant actually
 * serving a bad response, which is to say never. This drives the SAME
 * function the cron calls, against inputs we control.
 *
 * TWO LAYERS, because the pure predicate and the wiring can each be wrong
 * independently:
 *   1. shouldPrune()  — every branch, on numbers, no I/O
 *   2. pruneMissing() — against a SCRATCH COPY of the real table, asserting
 *                       the table survives a truncated fetch and that a
 *                       legitimate fetch still removes what it should
 *
 * The scratch DB is a temp file built here and deleted after; nothing in
 * this script can touch data/mlb.db.
 *
 *   node scripts/test-prune-missing.js
 *
 * Exit 1 on any failure, so it can gate a commit.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { shouldPrune, pruneMissing, DEFAULTS } = require(path.join(R, 'utils/prune-missing'));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n          expected ' + JSON.stringify(expected)
    + '\n          actual   ' + JSON.stringify(actual)); }
}

console.log('=== 1. shouldPrune() — the pure guard ===');
console.log('    floors: minRows=' + DEFAULTS.minRows + '  minFraction=' + DEFAULTS.minFraction);

// The realistic good case: today's fetch, 100 ids against 66 rows.
check('normal refresh 100 vs 66 -> prune', shouldPrune(100, 66).ok, true);
// The realistic bad cases. These are the ones that matter.
check('EMPTY fetch 0 vs 66 -> REFUSE', shouldPrune(0, 66).ok, false);
check('truncated fetch 5 vs 66 -> REFUSE', shouldPrune(5, 66).ok, false);
check('just under the floor 39 vs 66 -> REFUSE', shouldPrune(39, 66).ok, false);
check('exactly the floor 40 vs 66 -> prune', shouldPrune(40, 66).ok, true);
// The half-rule, which catches a fetch that is large in absolute terms but
// small relative to what we hold — a partial page, not a bad request.
check('half-rule 50 vs 200 -> REFUSE', shouldPrune(50, 200).ok, false);
check('half-rule boundary 100 vs 200 -> prune', shouldPrune(100, 200).ok, true);
check('half-rule just under 99 vs 200 -> REFUSE', shouldPrune(99, 200).ok, false);
// A first-ever run must not divide by zero and must not be blocked.
check('first run 100 vs 0 -> prune (nothing to remove)', shouldPrune(100, 0).ok, true);
// Garbage in.
check('NaN fetched -> REFUSE', shouldPrune(NaN, 66).ok, false);
check('negative fetched -> REFUSE', shouldPrune(-1, 66).ok, false);
check('undefined fetched -> REFUSE', shouldPrune(undefined, 66).ok, false);

// The refusal must say WHY. A guard that blocks without a reason is a
// guard nobody will trust the next time it fires.
const why = shouldPrune(5, 66).reason;
check('refusal carries a reason', typeof why === 'string' && why.length > 20, true);
console.log('        reason text: "' + why + '"');

console.log('');
console.log('=== 2. pruneMissing() — against a scratch DB ===');

const tmp = path.join(os.tmpdir(), 'prune-test-' + process.pid + '.db');
function freshDb(n) {
  try { fs.unlinkSync(tmp); } catch (e) {}
  const d = new Database(tmp);
  d.exec('CREATE TABLE catcher_framing (mlb_id INTEGER PRIMARY KEY, name TEXT, rv_tot REAL, pitches INTEGER)');
  const ins = d.prepare('INSERT INTO catcher_framing VALUES (?,?,?,?)');
  d.transaction(() => { for (let i = 1; i <= n; i++) ins.run(i, 'Catcher ' + i, 0.1, 1000 + i); })();
  return d;
}
const count = d => d.prepare('SELECT COUNT(*) c FROM catcher_framing').get().c;

// THE HEADLINE TEST. A truncated fetch must leave the table alone.
{
  const d = freshDb(66);
  const res = pruneMissing(d, 'catcher_framing', 'mlb_id', [1, 2, 3, 4, 5]);
  check('truncated fetch: table NOT wiped', count(d), 66);
  check('truncated fetch: reports skipped', res.skipped, true);
  check('truncated fetch: deleted nothing', res.pruned, 0);
  d.close();
}
// The degenerate version of the same thing.
{
  const d = freshDb(66);
  pruneMissing(d, 'catcher_framing', 'mlb_id', []);
  check('EMPTY fetch: table NOT wiped', count(d), 66);
  d.close();
}
{
  const d = freshDb(66);
  pruneMissing(d, 'catcher_framing', 'mlb_id', null);
  check('null fetch: table NOT wiped', count(d), 66);
  d.close();
}
// And the guard must not be so cautious that it never prunes. A real
// refresh that legitimately drops a few entities has to go through.
{
  const d = freshDb(66);
  const kept = []; for (let i = 1; i <= 60; i++) kept.push(i);
  const res = pruneMissing(d, 'catcher_framing', 'mlb_id', kept);
  check('legitimate refresh: 6 removed', res.pruned, 6);
  check('legitimate refresh: 60 remain', count(d), 60);
  check('legitimate refresh: names enumerated', res.prunedRows.map(r => r.name),
    ['Catcher 61', 'Catcher 62', 'Catcher 63', 'Catcher 64', 'Catcher 65', 'Catcher 66']);
  d.close();
}
// A wider fetch than the table (the 2026-08-24 minPitches=100 case) must
// prune nothing and error on nothing.
{
  const d = freshDb(66);
  const wide = []; for (let i = 1; i <= 100; i++) wide.push(i);
  const res = pruneMissing(d, 'catcher_framing', 'mlb_id', wide);
  check('wider fetch: nothing pruned', res.pruned, 0);
  check('wider fetch: table intact', count(d), 66);
  d.close();
}
// Duplicate ids in the fetch must not inflate the count past the guard.
// A source repeating one row 200 times is a bad fetch, not a big one.
{
  const d = freshDb(66);
  const dupes = []; for (let i = 0; i < 200; i++) dupes.push(7);
  const res = pruneMissing(d, 'catcher_framing', 'mlb_id', dupes);
  check('200 duplicate ids: counted as 1, REFUSED', res.skipped, true);
  check('200 duplicate ids: table intact', count(d), 66);
  d.close();
}
try { fs.unlinkSync(tmp); } catch (e) {}

console.log('');
console.log('=== ' + pass + ' passed, ' + fail + ' failed ===');
if (fail) {
  console.log('The guard is the only thing standing between a bad fetch and an');
  console.log('empty pricing-path table. Do not ship it red.');
}
process.exit(fail ? 1 : 0);
