// REFUSE TO OPEN THE LOCAL data/mlb.db READ-WRITE BY ACCIDENT. (2026-10-03)
//
// data/mlb.db is the owner's local analysis copy, separately evolved from
// production and carrying local-only remediation (CLAUDE.md, "data/mlb.db is
// not production"). The rule has been "set MLB_DB_PATH to a scratch copy
// before anything loads db/schema" since 2026-10-01, and it has still been
// broken by checks that looked harmless: a one-line require during PR #493,
// and again later, when an accidental open changed the file's fingerprint. A rule that
// depends on remembering it is followed until the one time it is not, so
// this makes the default refuse instead.
//
// A read-write open of THIS REPO's data/mlb.db is refused unless:
//   - the process is the real server (server.js is the entry point, which
//     covers `npm start` and `nodemon server.js`), or
//   - MLB_ALLOW_LOCAL_DB=1 is set explicitly -- for deliberate use only, e.g.
//     scripts/refresh-analysis-db.sh's promote and remediation steps.
//
// Not affected: production (/data/mlb.db on Render is a different path), any
// other path given through MLB_DB_PATH, and { readonly: true } opens.
//
// Called by db/schema.js before it opens its connection, and by every script
// that opens data/mlb.db read-write directly. Those scripts need their own
// call: several load db/schema (which an MLB_DB_PATH scratch copy satisfies)
// and then open data/mlb.db by its literal path.

const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');
const LOCAL_DB = path.join(REPO, 'data', 'mlb.db');
const SERVER_ENTRY = path.join(REPO, 'server.js');
const OVERRIDE = 'MLB_ALLOW_LOCAL_DB';
const MESSAGE = 'Refusing to open the local data/mlb.db: set MLB_DB_PATH to a scratch copy, '
  + 'or set MLB_ALLOW_LOCAL_DB=1 if you really mean it';

// One spelling per file: absolute, symlinks/junctions and Windows 8.3 short
// names (MIKERE~1) resolved, case-folded on Windows. A file that does not exist
// yet is resolved through its directory.
function canonical(p) {
  const abs = path.resolve(String(p));
  let real;
  try { real = fs.realpathSync.native(abs); }
  catch (e) {
    try { real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); }
    catch (e2) { real = abs; }
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function isLocalDb(file) {
  return canonical(file) === canonical(LOCAL_DB);
}

function isServerEntry() {
  const m = require.main;
  return !!(m && m.filename) && canonical(m.filename) === canonical(SERVER_ENTRY);
}

// Throws before the caller's `new Database(file, opts)` when that open would be
// a refused read-write open of the local data/mlb.db. Returns nothing otherwise.
function assertLocalDbOpenAllowed(file, opts) {
  if (opts && opts.readonly) return;
  if (!isLocalDb(file)) return;
  if (process.env[OVERRIDE] === '1') return;
  if (isServerEntry()) return;
  const e = new Error(MESSAGE);
  e.code = 'LOCAL_DB_REFUSED';
  throw e;
}

module.exports = { assertLocalDbOpenAllowed, isLocalDb, LOCAL_DB, OVERRIDE, MESSAGE };
