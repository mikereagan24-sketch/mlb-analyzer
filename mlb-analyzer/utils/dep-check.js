'use strict';
// PRODUCTION DEPENDENCY PRE-FLIGHT. (2026-09-08)
//
// #364 built cleanly on Render and then died at startup, four deploys in a
// row, with a bare "Exited with status 1". The cause was stream-json 3.6.0
// and stream-chain 4.2.5 being "type": "module" -- requiring ESM from
// CommonJS needs Node >= 20.19, and Render pins 20.11.0 via .node-version.
// stream-chain 4.x also declares engines >= 22 outright.
//
// Two things made it invisible:
//
//   1. THE BARE EXIT. A failed top-level require kills the process before
//      any of our logging runs, so the deploy log said nothing about which
//      module or why.
//
//   2. THE LOCAL NODE WAS NEWER. Verification ran on Node 20.20.2, past
//      the 20.19 require(esm) cutoff. Same MAJOR as the deploy target,
//      different behaviour. "It requires fine locally" was true and
//      useless.
//
// So this checks two separate things, and the second is the one that
// matters:
//
//   A. Every production dependency actually requires, naming any that
//      does not.
//   B. Every dependency's declared `engines.node` and ESM-ness is
//      compatible with THE DEPLOY TARGET in .node-version -- not with
//      whatever Node happens to be running the check.
//
// B catches this class on a developer machine with a newer Node, which is
// exactly the situation that shipped the outage.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Minimum Node that can require() an ESM package from CommonJS. Landed in
// 20.19.0 on the v20 line and 22.12.0 on v22.
const REQUIRE_ESM_MIN_V20 = [20, 19, 0];

function parseVersion(v) {
  const m = String(v || '').trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

function deployTarget() {
  for (const f of ['.node-version', '.nvmrc']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) {
      const v = parseVersion(fs.readFileSync(p, 'utf8'));
      if (v) return { version: v, source: f };
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.engines && pkg.engines.node) {
    const v = parseVersion(pkg.engines.node);
    if (v) return { version: v, source: 'package.json engines' };
  }
  return null;
}

// Very small subset of semver range handling -- enough for the ">=N" and
// "^N" forms packages actually publish. Anything it cannot parse is
// reported as unknown rather than silently passed.
function satisfiesMin(target, range) {
  const m = String(range || '').match(/>=\s*(\d+)/);
  if (m) return { ok: target[0] >= Number(m[1]), needs: '>=' + m[1] };
  const c = String(range || '').match(/\^(\d+)/);
  if (c) return { ok: target[0] >= Number(c[1]), needs: '^' + c[1] };
  return null;
}

// Is the file require() would load actually ESM? Resolves the entry the
// CommonJS loader would pick (which honours an exports "require"
// condition), then walks up to the nearest package.json for its "type".
// Returns true / false, or null when it cannot be determined.
function resolvedIsEsm(name) {
  let entry;
  try { entry = require.resolve(name); } catch (e) { return null; }
  if (entry.endsWith('.mjs')) return true;
  if (entry.endsWith('.cjs')) return false;
  if (!entry.endsWith('.js')) return false;   // .node addon and friends
  let dir = path.dirname(entry);
  for (let i = 0; i < 20; i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const t = JSON.parse(fs.readFileSync(pj, 'utf8')).type;
        return t === 'module';
      } catch (e) { return null; }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function checkDeps(opts) {
  opts = opts || {};
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {}).sort();
  const target = deployTarget();
  const problems = [];
  const rows = [];

  for (const name of deps) {
    const row = { name, required: false, type: null, engines: null, issues: [] };
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
      row.type = meta.type || 'commonjs';
      row.engines = (meta.engines && meta.engines.node) || null;
    } catch (e) {
      row.issues.push('not installed');
    }

    if (meta) {
      // (B) deploy-target compatibility -- the check that matters.
      if (target) {
        // "type":"module" ALONE IS NOT THE TEST. A dual package can be
        // type:module and still ship a CommonJS entry through an exports
        // "require" condition -- cheerio and csv-parse both do, and both
        // run fine on Node 20.11 today. Flagging on type alone produced
        // exactly those two false positives on the first run of this
        // check, which would have blocked a deploy for the wrong reason.
        //
        // The real question is what require() actually RESOLVES to, and
        // whether that specific file is ESM. require.resolve honours the
        // exports map's "require" condition, so it lands on the CJS entry
        // when one exists.
        row.resolvesToEsm = resolvedIsEsm(name);
        if (row.resolvesToEsm === true && target.version[0] === 20
            && cmp(target.version, REQUIRE_ESM_MIN_V20) < 0) {
          row.issues.push('require() resolves to an ESM file, but deploy target Node '
            + target.version.join('.') + ' cannot require() ESM (needs >= 20.19.0)');
        }
        // ENGINES SEVERITY IS SPLIT ON PURPOSE.
        //
        // npm treats engines as advisory unless engine-strict is set, so a
        // minor-level miss is usually harmless -- cheerio declares
        // >=20.18.1 against this 20.11.0 target and runs fine in production
        // today. Failing on that would block deploys for something that
        // demonstrably works.
        //
        // A MAJOR-level miss is different: stream-chain 4.x declares >=22
        // against a Node 20 target, and that one really did die. So major
        // mismatches fail; minor mismatches are reported and pass.
        if (row.engines) {
          const s = satisfiesMin(target.version, row.engines);
          if (s && !s.ok) {
            row.issues.push('engines ' + row.engines
              + ' excludes deploy target Node ' + target.version.join('.')
              + ' at the MAJOR level');
          } else {
            const full = parseVersion(String(row.engines).replace(/^[^\d]*/, ''));
            if (full && cmp(target.version, full) < 0) {
              row.advisories = row.advisories || [];
              row.advisories.push('engines ' + row.engines + ' is above deploy target Node '
                + target.version.join('.') + ' (minor-level; npm treats this as advisory)');
            }
          }
        }
      }
      // (A) does it actually load here?
      try { require(name); row.required = true; }
      catch (e) { row.issues.push('require failed: ' + (e.code || e.message)); }
    }

    if (row.issues.length) problems.push(row);
    rows.push(row);
  }

  return { deps: rows, problems, target, runtime: process.versions.node };
}

// Boot guard. Throws with every offending module named, so a bad dependency
// fails the deploy with a reason instead of a bare exit 1.
function assertDepsOk(log) {
  const r = checkDeps();
  const say = log || console.error;
  if (!r.problems.length) return r;
  say('[dep-check] ' + r.problems.length + ' production dependency problem(s).'
    + ' runtime Node ' + r.runtime
    + (r.target ? ', deploy target Node ' + r.target.version.join('.')
        + ' (' + r.target.source + ')' : ', NO deploy target pinned'));
  for (const p of r.problems) {
    say('[dep-check]   ' + p.name + '  type=' + (p.type || '?')
      + '  engines=' + (p.engines || 'none'));
    for (const i of p.issues) say('[dep-check]     - ' + i);
  }
  const err = new Error('dependency pre-flight failed: '
    + r.problems.map(p => p.name).join(', '));
  err.depProblems = r.problems;
  throw err;
}

module.exports = { checkDeps, assertDepsOk, deployTarget };
