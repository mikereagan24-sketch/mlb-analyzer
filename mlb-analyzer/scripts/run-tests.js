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

const files = fs.readdirSync(__dirname)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort();

const results = [];
for (const f of files) {
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, f)],
      { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
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
