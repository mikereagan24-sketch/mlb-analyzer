#!/usr/bin/env node
/**
 * Run every scripts/test-*.js and diff the result against
 * scripts/test-baseline.json. (2026-08-30)
 *
 * WHY. Four tests had been failing for weeks, carried in PR write-ups as
 * "unchanged from baseline" -- a count compared by eye. That is how a real
 * regression hides in an accepted failure count: the number stays 4, and
 * nobody checks WHICH 4. One of them (test-stint-weighted-neutralization)
 * turned out to have been broken by our own park-source switch and had been
 * validating nothing since.
 *
 * So the comparison is now mechanical, and it is strict in BOTH directions:
 *
 *   - a test that fails and is not in the baseline        -> REGRESSION
 *   - a baselined test whose failure COUNT moved          -> DRIFT
 *   - a baselined test that now passes                    -> FIXED, delete
 *                                                            the entry
 *
 * That last one matters as much as the first. A baseline that is never
 * pruned becomes a list of things nobody has to think about again.
 *
 * Usage:
 *   node scripts/run-tests.js            run all, diff against baseline
 *   node scripts/run-tests.js --list     show the baseline and exit
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const R = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'test-baseline.json');
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const expected = base.expected_failures || {};

if (process.argv.includes('--list')) {
  console.log('EXPECTED FAILURES (scripts/test-baseline.json)');
  console.log('');
  for (const [name, e] of Object.entries(expected)) {
    console.log('  ' + name + '   ' + e.failures + ' failing   [' + e.classification + ']'
      + (e.benign ? '' : '   <-- NOT benign'));
    console.log('      ' + e.what);
    console.log('      next: ' + e.next_step);
    console.log('');
  }
  process.exit(0);
}

// Count failures from whichever summary form a test uses. Falls back to the
// exit code, which every test in this repo sets correctly -- so an
// unparseable format degrades to "failed, count unknown" rather than to
// "passed", which is the direction that hides problems.
function countFailures(out, code) {
  let m;
  if ((m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/))) return Number(m[2]);
  if ((m = out.match(/SUMMARY:\s+(\d+)\s+FAILURES/))) return Number(m[1]);
  if ((m = out.match(/===\s+SUMMARY\s+===\s*(\d+)\s+FAILED/))) return Number(m[1]);
  if (/ALL PASS/.test(out) && code === 0) return 0;
  if (code === 0) return 0;
  const n = (out.match(/^\s*FAIL[\s:]/gm) || []).length;
  return n > 0 ? n : -1;   // -1 = failed, count not parseable
}

// REFUSE TO RUN UNDER A NODE THAT CANNOT OPEN THE DATABASE. (2026-09-18)
//
// `npm test` resolves `node` from PATH, and PATH on this machine is Node
// 24 while better-sqlite3's binding is built for Node 20 (ABI 115 vs
// 137). Every suite that touches db/schema then dies with
// ERR_DLOPEN_FAILED before printing a single assertion, and this runner
// counts that as "failures: unparseable (exit 1)".
//
// Measured on the first run of `npm test` after wiring it up: 64 suites,
// 12 clean, 50 REGRESSIONS, 2 DRIFT -- every one of them phantom. The 12
// that passed are simply the ones that never open the DB.
//
// That is worse than not having an entry point at all. A red suite that
// is red for an environmental reason trains the reader to skip the
// output, which is the failure this runner exists to prevent: it was
// built because four real failures hid inside an accepted count.
//
// So: probe the binding on an in-memory database -- no side effects, no
// touching data/mlb.db -- and abort with the command that works if it
// cannot load.
try {
  const Database = require(path.join(R, 'node_modules', 'better-sqlite3'));
  new Database(':memory:').close();
} catch (e) {
  const target = (() => {
    try { return require(path.join(R, 'utils/dep-check')).deployTarget(); }
    catch (_) { return null; }
  })();
  console.error('=== TEST RUN ABORTED ===');
  console.error('  better-sqlite3 will not load under this Node, so every suite that');
  console.error('  opens the database would fail for a reason that is not a test failure.');
  console.error('');
  console.error('  running Node : ' + process.versions.node
    + ' (modules ABI ' + process.versions.modules + ')');
  if (target) console.error('  pinned target: ' + target.version.join('.') + '  (' + target.source + ')');
  console.error('  error        : ' + String(e && e.message).split('\n')[0]);
  console.error('');
  console.error('  `npm test` takes `node` from PATH. Run the suite with Node 20:');
  console.error('    "C:\\Users\\Mike Reagan\\AppData\\Local\\nvm\\v20.20.2\\node.exe" scripts/run-tests.js');
  console.error('  or switch the shell first (nvm use 20.20.2) and re-run npm test.');
  process.exit(2);   // 2, not 1 -- this is "could not run", not "tests failed"
}

const files = fs.readdirSync(__dirname)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort();

// HEAP CAP FOR EVERY CHILD. (2026-09-18)
//
// CLAUDE.md's 2GB rule requires --max-old-space-size=1536 on local runs,
// because an unbounded run on that machine freezes Windows Explorer --
// a cost that lands on the operator and never shows up in any harness
// output. This runner spawns 60+ children; asking whoever types
// `npm test` to remember the flag is exactly the kind of rule that is
// followed until the one time it matters, so the runner sets it.
//
// NODE_OPTIONS rather than an execArgv flag: it propagates to anything
// a test itself spawns, and several of these do spawn a server or a
// second node. Merged, not replaced, so an operator who has already set
// NODE_OPTIONS for another reason keeps it.
const CHILD_ENV = Object.assign({}, process.env, {
  NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=1536']
    .filter(Boolean).join(' '),
});

const results = [];
for (const f of files) {
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, f)],
      { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
        env: CHILD_ENV });
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
    code = e.status == null ? 1 : e.status;
  }
  results.push({ file: f, failures: countFailures(out, code), code });
}

const regressions = [], drift = [], fixed = [], clean = [];
for (const r of results) {
  const exp = expected[r.file];
  if (r.failures === 0) {
    if (exp) fixed.push(r); else clean.push(r);
  } else if (!exp) {
    regressions.push(r);
  } else if (exp.failures !== r.failures) {
    drift.push({ ...r, was: exp.failures });
  }
}

console.log('=== TEST RUN ===');
console.log('  suites: ' + results.length
  + '   clean: ' + clean.length
  + '   expected-failing: ' + (results.length - clean.length - fixed.length - regressions.length)
  + '   NEW failures: ' + regressions.length
  + '   drifted: ' + drift.length
  + '   newly passing: ' + fixed.length);
console.log('');

if (regressions.length) {
  console.log('!! REGRESSION -- failing and NOT in the baseline:');
  for (const r of regressions) {
    console.log('   ' + r.file + '   failures: ' + (r.failures < 0 ? 'unparseable (exit ' + r.code + ')' : r.failures));
  }
  console.log('');
}
if (drift.length) {
  console.log('!! DRIFT -- baselined, but the failure count moved:');
  for (const r of drift) console.log('   ' + r.file + '   was ' + r.was + ', now ' + r.failures);
  console.log('   A changed count means the test is telling you something new.');
  console.log('');
}
if (fixed.length) {
  console.log('** NEWLY PASSING -- remove these from test-baseline.json:');
  for (const r of fixed) console.log('   ' + r.file);
  console.log('   A baseline that is never pruned becomes a list nobody rechecks.');
  console.log('');
}

const stillExpected = results.filter(r => expected[r.file] && r.failures === expected[r.file].failures);
if (stillExpected.length) {
  console.log('Expected failures, unchanged:');
  for (const r of stillExpected) {
    const e = expected[r.file];
    console.log('   ' + r.file.padEnd(40) + r.failures + ' failing   ['
      + e.classification + ']' + (e.benign ? '' : '   <-- NOT benign, see next_step'));
  }
  console.log('');
}

const bad = regressions.length + drift.length + fixed.length;
console.log(bad === 0
  ? 'OK -- failures match the baseline exactly.'
  : 'FAIL -- ' + bad + ' suite(s) diverge from the baseline.');
process.exit(bad === 0 ? 0 : 1);
