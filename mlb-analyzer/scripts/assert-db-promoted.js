#!/usr/bin/env node
// Did the promoted file actually become the snapshot? Exit 1 if not.
//
//   node scripts/assert-db-promoted.js <snapshot> <destination>
//
// THE INCIDENT THIS EXISTS FOR (2026-09-22). refresh-analysis-db.sh
// promoted with a bare `cp "${SNAP}" data/mlb.db` and never looked at the
// result. The copy wrote the new database over the live file IN PLACE and
// stopped at exactly 835,006,464 bytes -- the byte length the destination
// already had -- 54,255,616 bytes short of the 889,262,080-byte snapshot.
// cp did not abort the script, so step 5's remediation ran against the
// wreckage and threw SQLITE_CORRUPT.
//
// The forensic signature, and the reason check 2 below is worth having on
// its own: the header of the promoted file said page_count 217,105 at
// page_size 4096 = 889,262,080 bytes, while the file on disk held
// 203,859 pages. A database whose own header claims more pages than the
// file contains is corrupt by construction, and that is detectable from
// the destination alone, without the snapshot to compare against.
//
// Stopping at EXACTLY the previous file's length is the tell: the copy
// overwrote existing bytes and could not extend past the old EOF, which
// is what happens on Windows when another process holds the file open.
// The fix in refresh-analysis-db.sh is to build the new file beside the
// old one and rename it into place, so a write can never land on the live
// database -- and then to run this check, because the whole class of
// failure is "the copy reported success and the bytes are not there".
//
// WHY A SEPARATE SCRIPT. The shell needs the check and so does the test,
// and a second copy of it in either would be the thing that rots. This is
// the one implementation; scripts/test-promote-verify.js drives it
// directly, including a rebuild of the truncation above.

const fs = require('fs');

const [, , SRC, DST] = process.argv;
if (!SRC || !DST) {
  console.error('usage: node scripts/assert-db-promoted.js <snapshot> <destination>');
  process.exit(2);
}

const fail = (msg, detail) => {
  console.error('PROMOTE VERIFICATION FAILED: ' + msg);
  if (detail) console.error(detail);
  process.exit(1);
};

for (const f of [SRC, DST]) if (!fs.existsSync(f)) fail('missing file: ' + f);

// 1. the destination is byte-for-byte the size of the snapshot.
const sSize = fs.statSync(SRC).size;
const dSize = fs.statSync(DST).size;
if (sSize !== dSize) {
  fail('the promoted file is not the size of the snapshot.',
    '  snapshot    ' + SRC + '  ' + sSize + ' bytes\n'
    + '  destination ' + DST + '  ' + dSize + ' bytes\n'
    + '  short by    ' + (sSize - dSize) + ' bytes'
    + (dSize < sSize ? '   <- a partial copy that reported success' : ''));
}

// 2. the header's own page arithmetic matches the file length. Catches a
//    truncated copy from the destination alone.
const hdr = Buffer.alloc(100);
const fd = fs.openSync(DST, 'r');
try { fs.readSync(fd, hdr, 0, 100, 0); } finally { fs.closeSync(fd); }
if (hdr.toString('latin1', 0, 15) !== 'SQLite format 3') {
  fail('the promoted file is not a SQLite database.',
    '  first 16 bytes: ' + JSON.stringify(hdr.toString('latin1', 0, 16)));
}
let pageSize = hdr.readUInt16BE(16);
if (pageSize === 1) pageSize = 65536;          // SQLite encodes 65536 as 1
const pageCount = hdr.readUInt32BE(28);
const implied = pageSize * pageCount;
// page_count 0 means "ask the file length" on pre-3.7 files; skip then.
if (pageCount > 0 && implied !== dSize) {
  fail('the promoted file claims more pages than it holds.',
    '  header says page_size ' + pageSize + ' x page_count ' + pageCount
      + ' = ' + implied + ' bytes\n'
    + '  the file on disk is ' + dSize + ' bytes ('
      + Math.floor(dSize / pageSize) + ' pages)\n'
    + '  this is SQLITE_CORRUPT waiting to happen -- do not use it');
}

// 3. and it opens and passes the same check the snapshot had to pass.
let Database;
try { Database = require('better-sqlite3'); }
catch (e) { fail('cannot load better-sqlite3 to verify: ' + e.message); }

const read = (file) => {
  const d = new Database(file, { readonly: true });
  try {
    const qc = d.prepare('PRAGMA quick_check').get();
    const g = d.prepare('SELECT COUNT(*) c FROM game_log').get().c;
    return { qc: qc && qc.quick_check, games: g };
  } finally { d.close(); }
};

let dst;
try { dst = read(DST); }
catch (e) { fail('the promoted file will not open: ' + e.message); }
if (dst.qc !== 'ok') fail('quick_check on the promoted file: ' + dst.qc);

// 4. the row count the snapshot was admitted on survived the promote.
let src;
try { src = read(SRC); }
catch (e) { fail('the snapshot itself will not open: ' + e.message); }
if (src.games !== dst.games) {
  fail('game_log row count changed during the promote.',
    '  snapshot ' + src.games + '   promoted ' + dst.games);
}

console.log('  promote verified: ' + dSize + ' bytes, quick_check ok, game_log='
  + dst.games + ' (matches the snapshot)');
