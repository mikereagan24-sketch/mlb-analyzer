#!/usr/bin/env node
/**
 * Refuse to keep working on a branch whose PR has already merged.
 * (2026-08-30)
 *
 *   node scripts/assert-branch-open.js            # current branch
 *   node scripts/assert-branch-open.js <branch>
 *
 * RUN IT BEFORE COMMITTING, not after pushing. By the time
 * verify-commits-landed.js finds the problem the work is already stranded;
 * this is the same check moved to the point where it can still prevent it.
 *
 * WHY. Nine strandings, and the mechanism is now measured rather than
 * guessed. Three of them -- 85d011a, 5bff49c, and both of 2026-08-29 --
 * were the FINAL commit of a PR, which looked like a cached PR head on
 * GitHub's side. The timestamps say otherwise:
 *
 *   3865bbc committed 21:59:10Z   PR #320 merged 22:03:11Z   ( -4 min) landed
 *   0f3d8a8 committed 22:11:27Z   PR #320 merged 22:03:11Z   ( +8 min) STRANDED
 *   1ee0486 committed 22:26:34Z   PR #321 merged 22:30:58Z   ( -4 min) landed
 *   1366bf0 committed 22:41:35Z   PR #321 merged 22:30:58Z   (+11 min) STRANDED
 *
 * Every stranded commit was written AFTER its PR had already merged. A
 * merged PR does not absorb later pushes; `git push` still succeeds, the
 * branch still exists and moves ahead of main, and every surface says
 * fine. Nothing on the reviewer's side can catch it either -- the commit
 * did not exist when they merged, so re-reading the PR page finds nothing
 * missing.
 *
 * The rule was already written down ("One PR, one push", CLAUDE.md) and
 * followed for months; it failed twice in one afternoon because there was
 * nothing to notice the violation. A rule you have to remember at the
 * moment you are absorbed in something else is not a control.
 *
 * Exit 1 when the branch's PR is merged or closed, so it can gate a commit.
 */
const { execSync } = require('child_process');

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (e) { return ''; }
}

const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
const branch = arg || sh('git rev-parse --abbrev-ref HEAD');

if (!branch || branch === 'HEAD') {
  console.log('Detached HEAD — nothing to check.');
  process.exit(0);
}
if (branch === 'main' || branch === 'master') {
  console.log('OK  on ' + branch + ' — commit here goes through a new branch anyway.');
  process.exit(0);
}

// gh is the only source that knows PR state. Its absence must not block
// work, but it also must not read as a pass -- say which happened.
const raw = sh('gh pr list --head ' + branch + ' --state all --limit 5 '
  + '--json number,state,mergedAt,headRefName,baseRefName');
if (!raw) {
  console.log('UNKNOWN  could not query GitHub for ' + branch + '.');
  console.log('  Not a pass. If gh is unavailable, check the PR by hand before committing.');
  process.exit(0);
}

let prs = [];
try { prs = JSON.parse(raw); } catch (e) { prs = []; }
prs = prs.filter(p => p.headRefName === branch);

if (!prs.length) {
  // No PR yet -- check what this branch was CUT FROM, because that is what
  // the PR will default its base to. Catching it here is cheaper than
  // catching it after a merge that reported success.
  // The BRANCH, not HEAD. Using HEAD ignored the branch argument, so
  // `assert-branch-open.js <other-branch>` silently checked the current
  // one instead — a checker that reports on the wrong subject is worse
  // than no checker, which is the whole reason this file exists.
  const mergeBase = sh('git merge-base ' + branch + ' origin/main');
  const mainHead = sh('git rev-parse origin/main');
  if (mergeBase && mainHead && mergeBase !== mainHead) {
    const behind = sh('git rev-list --count ' + mergeBase + '..' + mainHead);
    console.log('WARNING  ' + branch + ' is not cut from current origin/main'
      + (behind ? ' (' + behind + ' commit(s) behind)' : '') + '.');
    console.log('  If it was branched from another feature branch, the PR will');
    console.log('  default its base there -- and a stacked base that merges first');
    console.log('  reports MERGED while main receives nothing. Rebuild from main.');
    process.exit(1);
  }
  console.log('OK  ' + branch + ' has no PR yet, cut from current origin/main — safe to commit.');
  process.exit(0);
}

const merged = prs.filter(p => p.state === 'MERGED');
const open = prs.filter(p => p.state === 'OPEN');

if (open.length) {
  const p = open[0];
  // A STACKED PR IS WORSE THAN A STRANDED COMMIT. (2026-08-30)
  //
  // PR #323 was opened against another feature branch rather than main.
  // When that base merged first, merging #323 put the commit into an
  // already-merged branch -- so GitHub reported MERGED, main never
  // received 9e39575, and a manual deploy re-triggered the base's commit
  // because it was already main's head.
  //
  // That is strictly worse than the earlier strandings. There the PR was
  // at least honest about what it contained; here the PR STATE ITSELF
  // lies, so neither the commit count nor the merge status can catch it.
  if (p.baseRefName && p.baseRefName !== 'main' && p.baseRefName !== 'master') {
    console.log('*** STOP — PR #' + p.number + ' is based on "' + p.baseRefName + '", not main.');
    console.log('');
    console.log('  Merging it will merge into that branch, not into main. If the base');
    console.log('  has already merged, GitHub will report MERGED while main receives');
    console.log('  nothing — exactly what happened to #323 / 9e39575.');
    console.log('');
    console.log('  Re-target the PR to main, or rebuild the branch from main:');
    console.log('    git checkout main && git pull --ff-only');
    console.log('    git checkout -b <new-branch> && git cherry-pick <sha>...');
    console.log('');
    process.exit(1);
  }
  console.log('OK  ' + branch + ' → PR #' + p.number + ' is OPEN, based on ' + p.baseRefName + '.');
  console.log('  Pushing here still reaches the PR. Verify the commit count in the');
  console.log('  body after merge with: node scripts/verify-commits-landed.js');
  process.exit(0);
}

if (merged.length) {
  const p = merged[0];
  console.log('*** STOP — PR #' + p.number + ' for ' + branch + ' ALREADY MERGED at ' + p.mergedAt + '.');
  console.log('');
  console.log('  A merged PR does not absorb later pushes. Committing here will');
  console.log('  succeed, push will succeed, the branch will sit ahead of main,');
  console.log('  and the work will be stranded — nine times so far, most recently');
  console.log('  0f3d8a8 and 1366bf0 on 2026-08-29.');
  console.log('');
  console.log('  Do this instead:');
  console.log('    git stash                     # if you have uncommitted work');
  console.log('    git checkout main && git pull --ff-only');
  console.log('    git checkout -b <new-branch>');
  console.log('    git stash pop');
  console.log('');
  process.exit(1);
}

console.log('OK  ' + branch + ' → PR #' + prs[0].number + ' is ' + prs[0].state + '.');
process.exit(0);
