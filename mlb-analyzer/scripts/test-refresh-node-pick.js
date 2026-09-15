#!/usr/bin/env node
// refresh-analysis-db.sh must pick a Node that can open the database, and
// must find that out BEFORE the download. (2026-09-14)
//   node scripts/test-refresh-node-pick.js
// Exit 1 on any failure.
//
// THE INCIDENT. On 2026-09-13 the script ran NODE="${NODE_BIN:-node}". PATH
// resolved to Node v24.18.0 (installed outside nvm), step 2 died on
// better-sqlite3 NODE_MODULE_VERSION 115 vs 137, and `set -euo pipefail`
// aborted AFTER the 560MB download and BEFORE the step-4 backup and step-5
// promote. The refresh looked done; the working copy was untouched.
//
// FOUR THINGS MUST HOLD, and each has cost something already:
//   1. the probe CONSTRUCTS a Database. require() alone exits 0 on Node 24
//      -- the native binding is lazy -- so a require probe would select the
//      exact Node that broke the refresh.
//   2. the pick happens before step 1 downloads anything.
//   3. no unquoted command substitution over paths: "C:/Users/Mike Reagan"
//      word-splits, and that bug silently disabled the same-major lookup
//      during development of this very change.
//   4. NODE_BIN still wins, because it is the documented escape hatch and
//      the 09-13 recovery used it.
const path = require('path');
const R = path.join(__dirname, '..');
const fs = require('fs');
const { execFileSync } = require('child_process');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}
const SH = path.join(R, 'scripts/refresh-analysis-db.sh');
const src = fs.readFileSync(SH, 'utf8');
const lines = src.split(/\r?\n/);
const lineOf = (needle) => lines.findIndex((l) => l.indexOf(needle) > -1);

console.log('1. the probe constructs a Database, not just a require');
const probeLine = lines.find((l) => l.indexOf('ABI_PROBE=') === 0);
check('ABI_PROBE exists', !!probeLine, true);
check('it constructs', /new \(require\("better-sqlite3"\)\)\(":memory:"\)/.test(probeLine || ''), true);
// The distinction is not theoretical: prove both halves on this machine.
function probe(nodeBin) {
  try {
    execFileSync(nodeBin, ['-e', 'new (require("better-sqlite3"))(":memory:").close()'],
      { cwd: R, stdio: 'ignore' });
    return 'PASS';
  } catch (e) { return 'FAIL'; }
}
function requireOnly(nodeBin) {
  try {
    execFileSync(nodeBin, ['-e', 'require("better-sqlite3")'], { cwd: R, stdio: 'ignore' });
    return 'PASS';
  } catch (e) { return 'FAIL'; }
}
check('this node passes the construct probe', probe(process.execPath), 'PASS');
// Find any installed node with a DIFFERENT major to demonstrate the gap.
const nvmRoots = [process.env.NVM_HOME, process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'nvm') : null].filter(Boolean)
  .map((p) => p.replace(/\\/g, '/'));
let other = null;
for (const root of nvmRoots) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { continue; }
  for (const e of entries) {
    if (!/^v(\d+)\./.test(e)) continue;
    if (e.split('.')[0] === 'v' + process.versions.node.split('.')[0]) continue;
    const cand = path.join(root, e, 'node.exe');
    if (fs.existsSync(cand)) { other = cand; break; }
  }
  if (other) break;
}
if (other) {
  const v = execFileSync(other, ['--version']).toString().trim();
  const r = requireOnly(other), p = probe(other);
  console.log('     cross-major node found: ' + v + '   require=' + r + '  construct=' + p);
  // This is the whole reason for the probe shape. If a future rebuild makes
  // both pass, the assertion below fails and the comment above needs
  // revisiting -- which is the right outcome, not a silent pass.
  check('a wrong-ABI node passes require but FAILS construct', [r, p], ['PASS', 'FAIL']);
} else {
  console.log('     (no cross-major node installed; the require-vs-construct gap '
    + 'cannot be demonstrated here)');
}

console.log('');
console.log('2. the pick happens before anything is downloaded');
const iPick = lineOf('PICK THE NODE THAT CAN ACTUALLY');
const iDownload = lineOf('=== 1/5 downloading production');
const iCurl = lineOf('curl -sS --max-time 1800');
check('resolver block exists', iPick > -1, true);
check('it precedes the download banner', iPick < iDownload, true);
check('and precedes the curl itself', iPick < iCurl, true);
// The failure exit must also come before the download.
const iExit4 = lineOf('exit 4');
check('the no-usable-node exit is before the download too',
  iExit4 > -1 && iExit4 < iCurl, true);

console.log('');
console.log('3. no unquoted command substitution over paths');
// The bug this caught during development: for v in $(ls -1d "$root"/v20.*)
// splits "C:/Users/Mike Reagan/..." into two half-paths.
const forOverSubst = lines.filter((l) => /^\s*for\s+\w+\s+in\s+\$\(/.test(l));
check('no `for x in $(...)` anywhere in the script', forOverSubst, []);
// And the same-major lookup must actually be reachable: it reads with a
// while loop instead.
check('the same-major lookup uses a read loop',
  /while IFS= read -r v; do/.test(src), true);

console.log('');
console.log('4. NODE_BIN is still honoured, and first');
const iCandidates = lineOf('candidates() {');
const body = lines.slice(iCandidates, iCandidates + 6).join('\n');
check('NODE_BIN is the first candidate emitted', /NODE_BIN/.test(body), true);
check('PATH node is the LAST candidate', /printf "%s\\\\n" "node"/.test(src)
  || /printf "%s.n" "node"/.test(src), true);
const iNodeLast = src.lastIndexOf('"node"');
const iNodeBin = src.indexOf('NODE_BIN:-');
check('...and appears after NODE_BIN in the list', iNodeBin < iNodeLast, true);

console.log('');
console.log('5. the stale-pin case is reported, not silently accepted');
check('.node-version is read', /NODE_VERSION_FILE=/.test(src), true);
check('a mismatch between pin and running version warns',
  /pins v\$\{PINNED\}, which is not what is running/.test(src), true);
// Recorded so the next reader knows the pin is not what runs today.
const pinned = fs.readFileSync(path.join(R, '.node-version'), 'utf8').trim();
console.log('     .node-version pins ' + pinned + '; this process is v'
  + process.versions.node + (pinned === process.versions.node ? '' : '  <- stale pin'));

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
