#!/usr/bin/env node
/**
 * Production dependency pre-flight. (2026-09-08)
 *
 * Run this before opening any PR that adds or bumps a dependency.
 *
 *   node scripts/preflight-deps.js
 *
 * Exit 1 if any production dependency cannot load, or is incompatible with
 * the DEPLOY TARGET in .node-version -- which is the half that matters.
 *
 * WHY IT EXISTS. #364 added stream-json 3.6.0 and stream-chain 4.2.5. Both
 * are "type": "module"; stream-chain 4.x declares engines >= 22. Requiring
 * ESM from CommonJS needs Node >= 20.19, and Render pins Node 20.11.0.
 * The build succeeded, the process died at startup with a bare "Exited with
 * status 1", and production sat on the previous deploy for four attempts.
 *
 * It passed pre-merge verification because that ran on Node 20.20.2 --
 * same MAJOR as the deploy target, past the 20.19 cutoff, different
 * behaviour. Checking a require against "some Node 20" is not the same as
 * checking it against the Node the platform will run.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { checkDeps } = require(path.join(R, 'utils/dep-check'));

const r = checkDeps();
console.log('=== production dependency pre-flight ===');
console.log('  runtime Node      : ' + r.runtime);
console.log('  deploy target Node: '
  + (r.target ? r.target.version.join('.') + '   (' + r.target.source + ')'
              : 'NONE PINNED — add .node-version'));
if (r.target && r.target.version.join('.') !== r.runtime) {
  console.log('  NOTE: runtime != deploy target. That gap is what shipped the');
  console.log('        #364 outage, so the engines/ESM checks below are');
  console.log('        evaluated against the TARGET, not against this runtime.');
}
console.log('');
console.log('  dependency                     type      loads  engines        status');
for (const d of r.deps) {
  console.log('  ' + d.name.padEnd(32)
    + (d.type || '?').padEnd(10) + (d.resolvesToEsm===true?'ESM  ':d.resolvesToEsm===false?'CJS  ':'?    ')
    + (d.engines || '-').padEnd(15)
    + (d.issues.length ? 'PROBLEM' : (d.required ? 'ok' : '-')));
  for (const i of d.issues) console.log('      - ' + i);
  for (const a of (d.advisories||[])) console.log('      ~ advisory: ' + a);
}
console.log('');
if (!r.target) {
  console.log('  WARNING: no deploy target pinned. Add .node-version so this');
  console.log('  check has something to verify against.');
}
console.log(r.problems.length
  ? 'FAILED (' + r.problems.length + ' dependency problem(s))'
  : 'OK — ' + r.deps.length + ' production dependencies');
process.exit(r.problems.length ? 1 : 0);
