#!/usr/bin/env node
/**
 * Did every commit I pushed actually reach main? (2026-08-24)
 *
 * WHY THIS EXISTS. Seven times now, work has been committed, pushed, and
 * reported as delivered while sitting on a branch `main` never absorbed.
 * On 2026-08-24 four commits stranded in one afternoon, and the timing
 * shows the cause exactly:
 *
 *   commit 0d57066 pushed 22:19Z   PR #288 had merged at 21:27Z   (+52 min)
 *   commit d5c0078 pushed 23:25Z   PR #291 had merged at 23:03Z   (+22 min)
 *   commit 47a9329 pushed 00:19Z   PR #291 had merged at 23:03Z   (+76 min)
 *   commit 5a91e04 pushed 00:37Z   PR #291 had merged at 23:03Z   (+94 min)
 *
 * Every one was pushed AFTER its PR had already merged. This is not a race
 * with the reviewer and it is not fixed by anyone waiting: it is treating
 * an open PR's branch as a scratch workspace and appending to it, without
 * re-checking whether the PR is still open. A merged PR does not notice
 * later pushes, and `git push` succeeds, and the branch still exists, so
 * every surface says "fine".
 *
 * THE RULE THIS ENFORCES: one PR, one push. If there is more work, branch
 * from main again. Then run this.
 *
 *   node scripts/check-stranded-commits.js            # every local branch
 *   node scripts/check-stranded-commits.js <branch>   # just one
 *   node scripts/check-stranded-commits.js --since 2026-08-01
 *
 * Exit 1 if anything is stranded, so it can gate "done".
 */
const { execSync } = require('child_process');

function sh(cmd) {
  try { return execSync(cmd, { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return ''; }
}

// Same as sh() but reports whether the command SUCCEEDED. sh() swallowing
// failures is fine for reads and dangerous for writes.
function shOk(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since');
const since = sinceIdx > -1 ? args[sinceIdx + 1] : null;
// Guard the index arithmetic: with no --since, sinceIdx is -1 and
// `sinceIdx + 1` is 0, which would silently drop the FIRST positional arg
// — i.e. the branch name. Caught by the self-test below, not by reading.
const skipIdx = sinceIdx > -1 ? sinceIdx + 1 : -1;
const only = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx)[0] || null;

sh('git fetch --quiet origin');
const mainRef = sh('git rev-parse --verify --quiet origin/main') ? 'origin/main' : 'main';
if (!sh('git rev-parse --verify --quiet ' + mainRef)) {
  console.error('cannot resolve ' + mainRef); process.exit(2);
}

// Ask git ONCE which branches even have unmerged work, instead of running
// a git log per branch. On this repo that is ~22 branches rather than
// ~300, and the difference is a five-minute scan versus a two-second one.
// A check nobody runs because it is slow is a check that does not exist.
const candidates = only
  ? [only]
  // LF via char code, then trim -- this file contains no backslash escapes
  // by design. Two earlier edits to this exact line were turned into
  // literal CR/LF bytes by the tooling in between, each producing a file
  // that either would not parse or, worse, parsed and reported OK for
  // every branch forever.
  : sh('git branch --no-merged ' + mainRef + ' --format=%(refname:short)')
      .split(String.fromCharCode(10));
const branches = candidates.map(b => b.trim()).filter(b => b && b !== 'main');

const stranded = [];
for (const b of branches) {
  const range = mainRef + '..' + b;
  const fmt = since ? ('--since=' + since + ' ') : '';
  // QUOTE THE FORMAT. Unquoted, the `|` separators are shell PIPES, git
  // log receives `--format=%h`, the rest becomes a pipeline into commands
  // that do not exist, sh() swallows the error and returns '' — and this
  // tool reports OK for every branch, forever. A checker that cannot fail
  // is worse than no checker, which is the whole reason it exists.
  const out = sh('git log ' + fmt + '--format="%h|%cI|%s" ' + range);
  if (!out) continue;
  for (const line of out.split('\n')) {
    const [sha, when, ...rest] = line.split('|');
    stranded.push({ branch: b, sha, when, subject: rest.join('|') });
  }
}

// --selftest proves the DETECTION works, on a throwaway branch it creates
// and removes. Without it the only evidence of correctness is "it printed
// OK", which is precisely what a broken checker prints.
if (args.includes('--selftest')) {
  // SAFETY FIRST, learned the hard way: the first version ran
  // `git checkout -b <tmp> <ref>` through sh(), which SWALLOWS errors. On a
  // dirty tree the checkout failed, the run continued, and the empty
  // selftest commit landed on the CURRENT BRANCH -- the tool exhibiting the
  // exact fail-quiet behaviour it exists to catch. Every step is now
  // checked, and a dirty tree is refused outright.
  const dirty = sh('git status --porcelain --untracked-files=no');
  if (dirty) {
    console.log('SELFTEST SKIPPED - working tree has uncommitted changes.');
    console.log('It creates a throwaway branch and commit; refusing to do that');
    console.log('on a dirty tree, because a failed checkout would put the commit');
    console.log('on YOUR branch. Commit or stash first.');
    process.exit(2);
  }
  const name = 'tmp/verify-selftest-' + process.pid;
  const cur = sh('git rev-parse --abbrev-ref HEAD');
  const madeBranch = shOk('git checkout -q -b ' + name + ' ' + mainRef);
  if (!madeBranch) {
    console.log('SELFTEST FAIL - could not create the throwaway branch.');
    process.exit(2);
  }
  const madeCommit = shOk('git commit -q --allow-empty -m "selftest: deliberately not in main"');
  // Split on non-hex: short hashes are hex, and this file carries no
  // backslash escapes by design (two edits to a CR/LF escape here were
  // silently mangled into literal control bytes).
  const found = (sh('git log --format="%h" ' + mainRef + '..' + name) || '')
    .split(/[^0-9a-f]+/).filter(Boolean);
  shOk('git checkout -q ' + cur);
  shOk('git branch -q -D ' + name);
  if (!madeCommit) {
    console.log('SELFTEST FAIL - could not create the throwaway commit.');
    process.exit(2);
  }
  if (found.length === 1) { console.log('SELFTEST PASS - detects an unmerged commit'); process.exit(0); }
  console.log('SELFTEST FAIL - created 1 unmerged commit, detected ' + found.length
    + '. This tool cannot be trusted to report stranding.');
  process.exit(2);
}

if (!stranded.length) {
  console.log('OK  every commit on every local branch is an ancestor of ' + mainRef
    + (since ? '  (since ' + since + ')' : ''));
  process.exit(0);
}

// Group by branch so the output reads as "this branch has work outstanding"
// rather than a flat list of hashes.
const byBranch = new Map();
for (const s of stranded) {
  if (!byBranch.has(s.branch)) byBranch.set(s.branch, []);
  byBranch.get(s.branch).push(s);
}

console.log('*** ' + stranded.length + ' commit(s) on ' + byBranch.size
  + ' branch(es) are NOT in ' + mainRef + ' ***');
console.log('');
for (const [b, cs] of [...byBranch.entries()].sort()) {
  console.log('  ' + b);
  for (const c of cs) console.log('      ' + c.sha + '  ' + c.when.slice(0, 19) + '  ' + c.subject.slice(0, 62));
}
console.log('');
console.log('  Not every one of these is a defect -- an abandoned experiment belongs');
console.log('  here. What matters is that NONE of them is work you reported as');
console.log('  delivered. Check each against what you said was shipped.');
console.log('');
console.log('  To re-land one:  git checkout main && git pull --ff-only');
console.log('                   git checkout -b relanded/<name> && git cherry-pick <sha>');
process.exit(1);
