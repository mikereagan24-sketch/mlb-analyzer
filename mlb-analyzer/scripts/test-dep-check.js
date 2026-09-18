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
// stream-json / stream-chain -- the #364 packages -- were REMOVED on
// 2026-09-17 with the Unabated fetch, their only consumer. The pin checks
// that lived here become an absence check: a dependency nothing requires is
// an outage surface with no benefit. The DETECTOR SELFTEST below still
// reconstructs the #364 shape, so the checker itself keeps its teeth.
const byName = Object.fromEntries(r.deps.map(d => [d.name, d]));
const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8'));
ok('stream-json is no longer a dependency', !(pkg.dependencies || {})['stream-json']);
ok('stream-chain is no longer a dependency', !(pkg.dependencies || {})['stream-chain']);
{
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/require\(\s*['"]stream-(json|chain)/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(R, p));
    }
  };
  for (const d of ['services', 'routes', 'utils', 'db', 'scripts']) walk(path.join(R, d));
  ok('nothing in the tree still requires them', users.length === 0, users.join(', '));
}

// ---- FALSE POSITIVES: type:module with a CJS require condition -------
// The first version of this checker flagged cheerio and csv-parse purely
// because they are "type":"module". Both ship a CommonJS entry through an
// exports "require" condition and ran fine on the Node 20.11.0 target in
// production. Flagging them would have blocked a deploy for the wrong
// reason.
for (const n of ['cheerio', 'csv-parse']) {
  if (!byName[n]) continue;
  ok(n + ' is type:module but resolves to CJS — must NOT be flagged',
     byName[n].type === 'module' && byName[n].resolvesToEsm === false
     && byName[n].issues.length === 0);
}

// ---- minor-level engines is advisory, not fatal ---------------------
// PINNED TO AN EXPLICIT TARGET 2026-09-18. This used to read the live
// pin and assert that cheerio (engines >=20.18.1) produced an advisory.
// That held only while the pin sat BELOW 20.18.1; the bump to 20.20.2
// satisfies it outright, and the assertion failed for the one reason a
// test must not fail -- the thing it describes stopped being reachable
// through the door it was looking at. The BEHAVIOUR is what matters, so
// evaluate it at a target where a minor-level miss exists.
{
  const at2011 = checkDeps({ target: '20.11.0' });
  const ch = Object.fromEntries(at2011.deps.map(d => [d.name, d]))['cheerio'];
  if (ch && ch.engines) {
    ok('a minor-level engines miss is an advisory, not a failure',
       ch.issues.length === 0 && (ch.advisories || []).length > 0,
       ch.engines + ' vs an explicit 20.11.0 target');
  }
  const chLive = byName['cheerio'];
  ok('and at the CURRENT pin that same dep is clean, not advisory',
     !chLive || !chLive.engines || (chLive.advisories || []).length === 0,
     (chLive && chLive.engines ? chLive.engines : '-') + ' vs target '
       + (t ? t.version.join('.') : '?'));
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
  // THE CUTOFF IS NOW TESTED FROM BOTH SIDES. (2026-09-18)
  //
  // #364's ESM hazard is a property of a target BELOW 20.19, so it is
  // asserted at an explicit 20.11.0 -- the pin that actually shipped the
  // outage -- and not at whatever .node-version says today. The bump to
  // 20.20.2 crossed the cutoff, which made the old form of this
  // assertion fail while the checker was behaving correctly.
  //
  // The second probe is the half that keeps the first honest: at the
  // CURRENT pin the ESM hazard must NOT fire. If it does, either the pin
  // regressed below 20.19 or the cutoff logic is wrong, and both are
  // worth a red test.
  let probeOld, probeLive;
  try {
    probeOld  = checkDeps({ target: '20.11.0' });
    probeLive = checkDeps();
  } finally { fs.writeFileSync(pkgPath, orig); }

  const p = probeOld.deps.find(d => d.name === '__depcheck_probe__');
  ok('DETECTOR SELFTEST: an ESM-only dep with engines>=22 IS flagged',
     !!p && p.issues.length > 0, p ? p.issues.join(' | ') : 'probe not evaluated');
  ok('DETECTOR SELFTEST: at a 20.11.0 target it names the ESM require hazard',
     !!p && p.issues.some(i => i.indexOf('cannot require() ESM') !== -1),
     'the #364 shape, at the pin that shipped #364');
  ok('DETECTOR SELFTEST: it names the engines major mismatch',
     !!p && p.issues.some(i => i.indexOf('MAJOR level') !== -1));
  ok('DETECTOR SELFTEST: the whole run reports FAILED', probeOld.problems.length > 0);

  const pl = probeLive.deps.find(d => d.name === '__depcheck_probe__');
  const pinClearsCutoff = !!t && (t.version[0] > 20
    || (t.version[0] === 20 && (t.version[1] > 19
        || (t.version[1] === 19 && t.version[2] >= 0))));
  ok('DETECTOR SELFTEST: at the CURRENT pin the ESM hazard is correctly silent',
     !pinClearsCutoff
       || (!!pl && !pl.issues.some(i => i.indexOf('cannot require() ESM') !== -1)),
     'pin ' + (t ? t.version.join('.') : '?') + ' is '
       + (pinClearsCutoff ? 'at or past' : 'below') + ' the 20.19 require(ESM) cutoff');
  ok('DETECTOR SELFTEST: the engines>=22 miss still fails at the current pin',
     !!pl && pl.issues.some(i => i.indexOf('MAJOR level') !== -1),
     'a major-level miss is fatal at any v20 target -- the bump must not have softened that');
} finally {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
}

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
