#!/usr/bin/env node
/**
 * The dependency pre-flight must catch the #364 class. (2026-09-08)
 *
 * A checker that cannot go red is not a checker, so this feeds it the
 * actual shapes that shipped the outage and asserts it flags them --
 * and feeds it the shapes that look similar but are fine, and asserts it
 * does NOT.
 *
 * Run: node scripts/test-dep-check.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { checkDeps, deployTarget } = require(path.join(R, 'utils/dep-check'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== dependency pre-flight ===');

const t = deployTarget();
ok('a deploy target is pinned', !!t, t ? t.version.join('.') + ' via ' + t.source : 'NONE');
ok('the target is read from .node-version, not from process.versions',
   !!t && t.source === '.node-version',
   'runtime is ' + process.versions.node + ', target is ' + (t ? t.version.join('.') : '?'));

const r = checkDeps();
ok('the current tree passes', r.problems.length === 0,
   r.problems.length ? r.problems.map(p => p.name).join(', ') : r.deps.length + ' deps');

// ---- the shapes that mattered ---------------------------------------
const byName = Object.fromEntries(r.deps.map(d => [d.name, d]));
ok('stream-json is pinned to the CommonJS line',
   byName['stream-json'] && byName['stream-json'].resolvesToEsm === false,
   'resolves to ' + (byName['stream-json'] || {}).type);
ok('stream-chain is pinned to the CommonJS line',
   byName['stream-chain'] && byName['stream-chain'].resolvesToEsm === false);
ok('stream-chain no longer declares an engines floor above the target',
   !byName['stream-chain'].issues.length,
   'engines=' + (byName['stream-chain'].engines || 'none'));

// ---- FALSE POSITIVES: type:module with a CJS require condition -------
// The first version of this checker flagged cheerio and csv-parse purely
// because they are "type":"module". Both ship a CommonJS entry through an
// exports "require" condition and run fine on Node 20.11 in production
// today. Flagging them would have blocked a deploy for the wrong reason.
for (const n of ['cheerio', 'csv-parse']) {
  if (!byName[n]) continue;
  ok(n + ' is type:module but resolves to CJS — must NOT be flagged',
     byName[n].type === 'module' && byName[n].resolvesToEsm === false
     && byName[n].issues.length === 0);
}

// ---- minor-level engines is advisory, not fatal ---------------------
const ch = byName['cheerio'];
if (ch && ch.engines) {
  ok('a minor-level engines miss is an advisory, not a failure',
     ch.issues.length === 0 && (ch.advisories || []).length > 0,
     ch.engines + ' vs target ' + (t ? t.version.join('.') : '?'));
}

// ---- DETECTOR SELFTEST ----------------------------------------------
// Recreate the exact #364 shape in a scratch package and assert it fails.
const scratch = path.join(R, 'node_modules', '__depcheck_probe__');
try {
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
    name: '__depcheck_probe__', version: '1.0.0', type: 'module',
    main: './index.js', exports: { '.': './index.js' },
    engines: { node: '>=22' },
  }));
  fs.writeFileSync(path.join(scratch, 'index.js'), 'export const x = 1;\n');

  const pkgPath = path.join(R, 'package.json');
  const orig = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(orig);
  pkg.dependencies['__depcheck_probe__'] = '1.0.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  let probe;
  try { probe = checkDeps(); } finally { fs.writeFileSync(pkgPath, orig); }

  const p = probe.deps.find(d => d.name === '__depcheck_probe__');
  ok('DETECTOR SELFTEST: an ESM-only dep with engines>=22 IS flagged',
     !!p && p.issues.length > 0, p ? p.issues.join(' | ') : 'probe not evaluated');
  ok('DETECTOR SELFTEST: it names the ESM require hazard',
     !!p && p.issues.some(i => i.indexOf('cannot require() ESM') !== -1));
  ok('DETECTOR SELFTEST: it names the engines major mismatch',
     !!p && p.issues.some(i => i.indexOf('MAJOR level') !== -1));
  ok('DETECTOR SELFTEST: the whole run reports FAILED', probe.problems.length > 0);
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
