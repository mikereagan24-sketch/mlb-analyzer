#!/usr/bin/env node
// A failed promote must be FATAL, and must say so.
//   node --max-old-space-size=1536 scripts/test-promote-verify.js
// Exit 1 on any failure.
//
// THE INCIDENT (2026-09-22). refresh-analysis-db.sh promoted with a bare
// `cp "${SNAP}" data/mlb.db` and never looked at the result. Steps 1-3
// passed honestly -- 889,262,080 bytes downloaded, quick_check ok,
// game_log 2260 -- and step 4 backed the old copy up. The copy then
// overwrote the LIVE database in place and stopped at exactly
// 835,006,464 bytes, the byte length the destination already had,
// 54,255,616 short. cp did not abort the script, so step 5 ran the
// remediation against the wreckage and threw SQLITE_CORRUPT.
//
// What made it the worst available outcome is that every surface reported
// success. A refresh that dies loudly costs a re-run; this one left a
// working copy that opens far enough to be measured against.
//
// Case 2 below rebuilds that file from its two halves -- a good
// database's header over a short body -- and asserts the checker rejects
// it. That is the regression test: the shipped code has to fail on the
// exact artifact the incident produced.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
const CHECKER = path.join(R, 'scripts/assert-db-promoted.js');
const SH = path.join(R, 'scripts/refresh-analysis-db.sh');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-verify-'));
const p = (n) => path.join(TMP, n);

// Run the checker and return { code, out }. Never throws.
function check(src, dst) {
  const r = spawnSync(process.execPath, [CHECKER, src, dst], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// A real SQLite file, big enough to span several pages.
function makeDb(file, rows) {
  const Database = require('better-sqlite3');
  const d = new Database(file);
  d.pragma('journal_mode = DELETE');   // one file, no -wal to confuse sizes
  d.exec('CREATE TABLE game_log (id INTEGER PRIMARY KEY, pad TEXT)');
  const ins = d.prepare('INSERT INTO game_log (pad) VALUES (?)');
  const tx = d.transaction((n) => { for (let i = 0; i < n; i++) ins.run('x'.repeat(200)); });
  tx(rows);
  d.close();
}

try {
  console.log('\n1. a correct promote verifies');
  makeDb(p('snap.db'), 4000);
  fs.copyFileSync(p('snap.db'), p('dest.db'));
  let r = check(p('snap.db'), p('dest.db'));
  expect('exit 0 on an identical copy', r.code === 0, 'exit ' + r.code);
  expect('...and it prints the numbers it checked',
    /quick_check ok/.test(r.out) && /game_log=4000/.test(r.out), r.out.trim().slice(0, 90));

  console.log('\n2. THE INCIDENT: a good header over a short body is rejected');
  // Exactly the 2026-09-22 artifact: the new database's first N bytes,
  // stopping at the byte length the old file happened to have. The header
  // still claims the full page count.
  const full = fs.readFileSync(p('snap.db'));
  const shortBy = 4096 * 7;
  fs.writeFileSync(p('trunc.db'), full.subarray(0, full.length - shortBy));
  r = check(p('snap.db'), p('trunc.db'));
  expect('exit 1', r.code === 1, 'exit ' + r.code);
  expect('...names the shortfall in bytes', r.out.indexOf(String(shortBy)) > -1,
    r.out.split('\n').filter(l => /short by/.test(l)).join('') || r.out.slice(0, 120));
  expect('...and calls it a partial copy that reported success',
    /partial copy that reported success/.test(r.out));

  console.log('\n3. ...and is rejected from the DESTINATION ALONE');
  // No snapshot to compare against: the header's own page arithmetic is
  // enough. This is the check that would have caught it even if the
  // snapshot had been deleted.
  fs.copyFileSync(p('trunc.db'), p('trunc2.db'));
  r = check(p('trunc.db'), p('trunc2.db'));   // same size -> check 1 passes
  expect('equal sizes do not excuse a corrupt file', r.code === 1, 'exit ' + r.code);
  expect('...the header arithmetic is what rejects it',
    /claims more pages than it holds/.test(r.out), r.out.split('\n')[0]);

  console.log('\n4. other ways a promote can lie');
  fs.writeFileSync(p('notdb.db'), Buffer.alloc(fs.statSync(p('snap.db')).size, 0x41));
  r = check(p('snap.db'), p('notdb.db'));
  expect('a right-sized non-database is rejected', r.code === 1, 'exit ' + r.code);
  expect('...and says it is not SQLite', /not a SQLite database/.test(r.out));

  // Same file length and same page_count, fewer rows: DELETE leaves the
  // pages on the freelist rather than shrinking the file, so checks 1-3
  // all pass and only the row count can catch it.
  fs.copyFileSync(p('snap.db'), p('fewer.db'));
  {
    const Database = require('better-sqlite3');
    const d = new Database(p('fewer.db'));
    d.pragma('journal_mode = DELETE');
    d.exec('DELETE FROM game_log WHERE id > 3000');
    d.close();
  }
  expect('the fixture really is the same size',
    fs.statSync(p('fewer.db')).size === fs.statSync(p('snap.db')).size,
    fs.statSync(p('fewer.db')).size + ' vs ' + fs.statSync(p('snap.db')).size);
  r = check(p('snap.db'), p('fewer.db'));
  expect('a database with the wrong game_log count is rejected', r.code === 1, 'exit ' + r.code);
  expect('...naming both counts',
    /4000/.test(r.out) && /3000/.test(r.out), r.out.split('\n').slice(0, 2).join(' | '));

  r = check(p('snap.db'), p('nope.db'));
  expect('a missing destination is rejected', r.code === 1, 'exit ' + r.code);

  console.log('\n5. the refresh script wires it in, in the right place');
  const src = fs.readFileSync(SH, 'utf8');
  // Comment lines are blanked: the fix's own comment quotes the command
  // it replaced, and an assertion that cannot tell code from a comment
  // would fail on the very change that fixes the defect.
  const lines = src.split(/\r?\n/).map(l => (/^\s*#/.test(l) ? '' : l));
  const at = (needle) => lines.findIndex(l => l.indexOf(needle) > -1);

  expect('the promote no longer writes onto the live file',
    at('cp "${SNAP}" data/mlb.db') === -1,
    'bare cp onto data/mlb.db is the whole defect');
  expect('it stages beside it instead', at('cp "${SNAP}" "${PROMOTE_TMP}"') > -1);
  expect('and renames into place -- a rename cannot half-succeed',
    at('mv -f "${PROMOTE_TMP}" data/mlb.db') > -1);
  expect('stale -wal/-shm are removed with the old database',
    at('rm -f data/mlb.db-wal data/mlb.db-shm') > -1);

  const iVerify = at('scripts/assert-db-promoted.js');
  const iMove = at('mv -f "${PROMOTE_TMP}" data/mlb.db');
  const iStep5 = at('=== 5/5 re-applying local-only remediation ===');
  expect('the check runs after the rename', iVerify > iMove, iMove + ' -> ' + iVerify);
  expect('...and BEFORE step 5 touches the database', iVerify < iStep5,
    iVerify + ' < ' + iStep5);
  expect('a failed verification exits non-zero', /exit 5/.test(src));
  expect('...and restores the pre-refresh copy',
    /RESTORE_TMP/.test(src) && /local-pre-refresh-\$\{STAMP\}" "\$\{RESTORE_TMP\}"/.test(src));
  expect('the restore also goes through a rename, not a write onto the live file',
    at('mv -f "${RESTORE_TMP}" data/mlb.db') > -1);

  // shell must still parse
  const bn = spawnSync('bash', ['-n', SH], { encoding: 'utf8' });
  expect('the script still parses', bn.status === 0, (bn.stderr || '').trim().slice(0, 120));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
