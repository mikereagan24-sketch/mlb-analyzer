#!/usr/bin/env node
'use strict';
/**
 * utils/local-db-guard.js: nothing opens the local data/mlb.db read-write by
 * accident. (2026-10-03)
 *
 * NEVER TOUCHES THE REAL data/mlb.db. Every case that opens a database runs in
 * a child process against a STAND-IN tree in the temp dir: a copy of db/ and
 * utils/, a stand-in server.js, and a data/mlb.db that is a throwaway copy of
 * a scratch database. The guard resolves "the local data/mlb.db" relative to
 * its own file, so inside the stand-in tree that is the stand-in copy. No
 * test-only knob is needed in the guard.
 *
 *   a. db/schema with no MLB_DB_PATH and no override refuses, with the
 *      message, and the file's fingerprint is unchanged (and no -wal/-shm).
 *      Other spellings of the same file are refused too. Every direct
 *      read-write opener in scripts/ calls the guard before it opens.
 *   b. MLB_DB_PATH pointing at a scratch copy works as before.
 *   c. MLB_ALLOW_LOCAL_DB=1 allows it (only exactly "1").
 *   d. the server entry point is allowed (by its path, not its file name),
 *      and the production path (/data/mlb.db) and read-only opens are unaffected.
 *
 *   node scripts/test-local-db-guard.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), '__local_db_guard_' + process.pid);
process.env.MLB_DB_PATH = path.join(WORK, 'parent-never-opened.db');   // NEVER data/mlb.db: this process loads no schema, but the rule holds

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null && !cond ? '   ' + detail : ''));
}

const REAL_DB = path.join(R, 'data', 'mlb.db');
const statOf = (f) => { try { const s = fs.statSync(f); return s.size + '@' + s.mtimeMs; } catch (e) { return 'absent'; } };
const realBefore = statOf(REAL_DB);

// ---- the stand-in tree
const SI = path.join(WORK, 'standin');
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
};
copyDir(path.join(R, 'db'), path.join(SI, 'db'));
copyDir(path.join(R, 'utils'), path.join(SI, 'utils'));
fs.mkdirSync(path.join(SI, 'data'), { recursive: true });
fs.mkdirSync(path.join(SI, 'scripts'), { recursive: true });
// The stand-in server.js sits where the guard expects the real one; a file of
// the same name elsewhere must not count.
fs.writeFileSync(path.join(SI, 'server.js'),
  "const s = require('./db/schema'); process.stdout.write('OPENED ' + s.DB_PATH + '\\n'); s.db.close();\n");
fs.writeFileSync(path.join(SI, 'scripts', 'server.js'),
  "const s = require('../db/schema'); process.stdout.write('OPENED ' + s.DB_PATH + '\\n'); s.db.close();\n");
const SI_DB = path.join(SI, 'data', 'mlb.db');
const SI_SCHEMA = path.join(SI, 'db', 'schema.js');

// Children get a clean environment: no MLB_DB_PATH, no override, unless a case sets one.
function run(args, extraEnv, cwd) {
  const env = Object.assign({}, process.env);
  delete env.MLB_DB_PATH;
  delete env.MLB_ALLOW_LOCAL_DB;
  env.NODE_PATH = path.join(R, 'node_modules');            // better-sqlite3 for the stand-in tree
  Object.assign(env, extraEnv || {});
  const r = spawnSync(process.execPath, args, { env, cwd: cwd || WORK, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const requireSchema = (extraEnv, cwd) => run(['-e',
  "const s = require(" + JSON.stringify(SI_SCHEMA) + "); process.stdout.write('OPENED ' + s.DB_PATH + '\\n'); s.db.close();"], extraEnv, cwd);
const fingerprint = (f) => {
  if (!fs.existsSync(f)) return 'absent';
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + statOf(f);
};
const sidecars = (f) => ['-wal', '-shm'].filter(s => fs.existsSync(f + s));

const { MESSAGE } = require(path.join(R, 'utils/local-db-guard'));

try {
  // ---------------------------------------------------------------- b (first: it makes the scratch DB the stand-in is copied from)
  console.log('b. MLB_DB_PATH pointing at a scratch copy works as before');
  const SCRATCH = path.join(WORK, 'scratch', 'mlb.db');
  fs.mkdirSync(path.dirname(SCRATCH), { recursive: true });
  const b1 = requireSchema({ MLB_DB_PATH: SCRATCH });
  ok('db/schema opens the scratch path, read-write, and migrates it', b1.code === 0 && b1.out.includes('OPENED ' + SCRATCH) && fs.existsSync(SCRATCH), b1.out);
  const b2 = run(['-e', "const s = require(" + JSON.stringify(SI_SCHEMA) + "); s.db.prepare(\"INSERT OR REPLACE INTO app_settings (key, value) VALUES ('guard_test', 'x')\").run(); s.db.close();"], { MLB_DB_PATH: SCRATCH });
  ok('...and writes to it', b2.code === 0, b2.out);
  ok('MLB_DB_PATH is honoured with no override and no server entry point', !b1.out.includes('Refusing'));

  // the stand-in "local data/mlb.db": a throwaway copy of the scratch database
  fs.copyFileSync(SCRATCH, SI_DB);
  for (const s of sidecars(SCRATCH)) fs.copyFileSync(SCRATCH + s, SI_DB + s);
  const c0 = run(['-e', "const D = require('better-sqlite3'); const d = new D(" + JSON.stringify(SI_DB) + "); d.pragma('wal_checkpoint(TRUNCATE)'); d.pragma('journal_mode = DELETE'); d.close();"]);
  ok('(setup) stand-in data/mlb.db is a self-contained copy', c0.code === 0 && sidecars(SI_DB).length === 0, c0.out);

  // ---------------------------------------------------------------- a
  console.log('\na. no MLB_DB_PATH, no override: refused, file untouched');
  const fpA = fingerprint(SI_DB);
  const a1 = requireSchema();
  ok('requiring db/schema exits non-zero', a1.code !== 0, a1.code);
  ok('with the message', a1.out.includes(MESSAGE), a1.out.split('\n').slice(0, 6).join(' | '));
  ok('the file\'s fingerprint is unchanged and no -wal/-shm appeared', fingerprint(SI_DB) === fpA && sidecars(SI_DB).length === 0, sidecars(SI_DB).join(','));
  const a2 = requireSchema({ MLB_DB_PATH: SI_DB.toUpperCase() });
  ok('MLB_DB_PATH naming the same file in other case is refused too', process.platform !== 'win32' || (a2.code !== 0 && a2.out.includes(MESSAGE)), a2.out.slice(0, 300));
  const a3 = requireSchema({ MLB_DB_PATH: path.join('standin', 'data', 'mlb.db') }, WORK);
  ok('...and as a relative path', a3.code !== 0 && a3.out.includes(MESSAGE), a3.out.slice(0, 300));
  const a4 = requireSchema({ MLB_DB_PATH: path.join(SI, 'data', '..', 'data', 'mlb.db') });
  ok('...and through a .. segment', a4.code !== 0 && a4.out.includes(MESSAGE), a4.out.slice(0, 300));
  const a5 = requireSchema({ MLB_ALLOW_LOCAL_DB: 'true' });
  const a6 = requireSchema({ MLB_ALLOW_LOCAL_DB: '0' });
  ok('an override other than exactly "1" does not count', a5.code !== 0 && a6.code !== 0 && a5.out.includes(MESSAGE) && a6.out.includes(MESSAGE));
  ok('fingerprint still unchanged after every refusal', fingerprint(SI_DB) === fpA && sidecars(SI_DB).length === 0);
  // the direct openers: the guard sits before their own new Database(...data/mlb.db...)
  const direct = ['backfill-first-pitch', 'backfill-pitcher-usage', 'backfill-totals-bet-price', 'fix-corrupt-totals-rows',
    'null-fabricated-totals-closing', 'tag-park-factor-regime', 'tag-post-start-pricing', 'verify-totals-closing-capture'];
  const unguarded = direct.filter((f) => {
    const s = fs.readFileSync(path.join(R, 'scripts', f + '.js'), 'utf8');
    const g = s.indexOf('assertLocalDbOpenAllowed(');
    const o = s.search(/const db = new Database\(/);
    return g < 0 || o < 0 || g > o;
  });
  ok('each direct read-write opener in scripts/ calls the guard before it opens', unguarded.length === 0, unguarded.join(', '));
  // and no NEW direct read-write opener of data/mlb.db has appeared without it
  // (the literal path.join(R, 'data/mlb.db') form, which is what these scripts use)
  const rwOpeners = fs.readdirSync(path.join(R, 'scripts')).filter(f => f.endsWith('.js')).filter((f) => {
    const s = fs.readFileSync(path.join(R, 'scripts', f), 'utf8');
    return /new Database\([^)]*data\/mlb\.db'\)(?!\s*,\s*\{\s*readonly:\s*true)/.test(s);
  });
  const missing = rwOpeners.filter(f => !/assertLocalDbOpenAllowed\(/.test(fs.readFileSync(path.join(R, 'scripts', f), 'utf8')));
  ok('no script opens data/mlb.db read-write without the guard', missing.length === 0, missing.join(', '));
  const schemaSrc = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
  ok('db/schema calls the guard before its one connection', (() => {
    const g = schemaSrc.indexOf("assertLocalDbOpenAllowed(DB_PATH)"), o = schemaSrc.indexOf('const db = new Database(DB_PATH)');
    return g > 0 && o > g;
  })());

  // ---------------------------------------------------------------- c
  console.log('\nc. MLB_ALLOW_LOCAL_DB=1 allows it');
  const c1 = run(['-e', "const s = require(" + JSON.stringify(SI_SCHEMA) + "); s.db.prepare(\"INSERT OR REPLACE INTO app_settings (key, value) VALUES ('guard_test_override', 'y')\").run(); process.stdout.write('OPENED ' + s.DB_PATH + '\\n'); s.db.close();"],
    { MLB_ALLOW_LOCAL_DB: '1' });
  ok('db/schema opens the stand-in data/mlb.db read-write', c1.code === 0 && c1.out.includes('OPENED ' + SI_DB), c1.out.slice(0, 300));
  ok('...and the write landed in it (it was this file that was opened)', fingerprint(SI_DB) !== fpA);

  // ---------------------------------------------------------------- d
  console.log('\nd. the server entry point; production; read-only');
  const d1 = run([path.join(SI, 'server.js')]);
  ok('server.js as the entry point opens the local data/mlb.db with no override', d1.code === 0 && d1.out.includes('OPENED ' + SI_DB), d1.out.slice(0, 300));
  const d2 = run([path.join(SI, 'scripts', 'server.js')]);
  ok('a different file that happens to be named server.js is refused', d2.code !== 0 && d2.out.includes(MESSAGE), d2.out.slice(0, 300));
  const d3 = run(['-e', "require(" + JSON.stringify(path.join(SI, 'server.js')) + ")"]);
  ok('requiring server.js from another entry point is refused (it is the entry point that counts)', d3.code !== 0 && d3.out.includes(MESSAGE), d3.out.slice(0, 300));
  const guard = require(path.join(SI, 'utils', 'local-db-guard'));
  let prodErr = null;
  try { guard.assertLocalDbOpenAllowed('/data/mlb.db'); } catch (e) { prodErr = e; }
  ok('the production path /data/mlb.db is not the local copy, and is allowed', prodErr === null && !guard.isLocalDb('/data/mlb.db'), prodErr && prodErr.message);
  const PROD_LIKE = path.join(WORK, 'prod', 'data', 'mlb.db');
  fs.mkdirSync(path.dirname(PROD_LIKE), { recursive: true });
  const d4 = requireSchema({ MLB_DB_PATH: PROD_LIKE });
  ok('another directory\'s data/mlb.db is allowed (the guard matches this repo\'s file, not the name)', d4.code === 0 && d4.out.includes('OPENED ' + PROD_LIKE), d4.out.slice(0, 300));
  ok('db/schema still picks /data on Render exactly as before', /if \(process\.env\.RENDER\) \{\s*DATA_DIR = fs\.existsSync\('\/data'\) \? '\/data' : path\.join\(__dirname, '\.\.\/data'\);/.test(schemaSrc));
  let roErr = null;
  try { guard.assertLocalDbOpenAllowed(SI_DB, { readonly: true }); } catch (e) { roErr = e; }
  ok('a { readonly: true } open of the local file is out of scope and allowed', roErr === null);
  let rwErr = null;
  const saved = process.env.MLB_ALLOW_LOCAL_DB; delete process.env.MLB_ALLOW_LOCAL_DB;
  try { guard.assertLocalDbOpenAllowed(SI_DB, { readonly: false }); } catch (e) { rwErr = e; }
  if (saved != null) process.env.MLB_ALLOW_LOCAL_DB = saved;
  ok('a direct { readonly: false } open (a script\'s --apply) is refused', rwErr && rwErr.code === 'LOCAL_DB_REFUSED');
} finally {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
}

// ---------------------------------------------------------------- the real file
console.log('\nthe real data/mlb.db');
ok('size and modified time unchanged by this test', statOf(REAL_DB) === realBefore, realBefore + ' -> ' + statOf(REAL_DB));

console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
