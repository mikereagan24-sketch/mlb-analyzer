'use strict';
// Verifies the gzip-negotiated DB download (utils/db-download-stream.js) and
// the refresh script's decode step, end to end over loopback. (2026-09-15)
//
//   node scripts/test-download-db-gzip.js
//       checks on a small fixture, including running
//       scripts/refresh-analysis-db.sh against a local server
//
//   node --max-old-space-size=1536 scripts/test-download-db-gzip.js --file data/mlb.db.prod-YYYYMMDD
//       measure bytes on the wire, identity vs gzip, for a real snapshot
//
// Run under Node 20 (better-sqlite3). The server here mirrors the route:
// db.backup() to a side file, stream that file, unlink on completion.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { streamDbFile, acceptsGzip } = require('../utils/db-download-stream');

const ROOT = path.join(__dirname, '..');
const fileArg = process.argv.indexOf('--file');
const REAL_FILE = fileArg > 0 ? path.resolve(process.argv[fileArg + 1]) : null;

let fails = 0;
function ok(label, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '   ' + extra : ''));
  if (!cond) fails++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function shaFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// ---------------------------------------------------------------- server
// state.mode: 'normal' | 'identity' (a server without this change) |
// 'truncate' (gzip body cut in half, Content-Length matching the cut, so
// curl itself exits 0 and only the script's own checks can catch it).
function startServer(srcDbPath, state) {
  const app = express();
  app.get('/api/admin/download-db', async (req, res) => {
    const tempPath = path.join(state.dir, 'backup-' + Date.now() + '-'
      + crypto.randomBytes(4).toString('hex') + '.db');
    const src = new Database(srcDbPath, { readonly: true });
    try { await src.backup(tempPath); } finally { src.close(); }
    state.backupSize = fs.statSync(tempPath).size;
    state.backupSha = await shaFile(tempPath);
    state.cleaned = false;
    state.last = null;
    const cleanup = () => fs.unlink(tempPath, () => { state.cleaned = !fs.existsSync(tempPath); });

    if (state.mode === 'truncate') {
      const gz = zlib.gzipSync(fs.readFileSync(tempPath));
      const cut = gz.subarray(0, Math.floor(gz.length / 2));
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Uncompressed-Length', String(state.backupSize));
      res.setHeader('Content-Length', String(cut.length));
      res.end(cut);
      return cleanup();
    }
    if (state.mode === 'identity') delete req.headers['accept-encoding'];
    streamDbFile(req, res, tempPath, { filename: 'mlb-test.db' }, (r) => { state.last = r; cleanup(); });
  });
  return new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------- client
// Counts raw wire bytes and hashes the DECODED body, with backpressure, so
// an 800MB snapshot never sits in memory.
function fetchDb(port, headers, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: '/api/admin/download-db', headers }, (res) => {
      if (o.abortAfterFirstChunk) {
        res.once('data', () => { req.destroy(); resolve({ aborted: true }); });
        return;
      }
      let wire = 0;
      res.on('data', d => { wire += d.length; });
      const h = crypto.createHash('sha256');
      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      let decoded = 0;
      body.on('data', d => { decoded += d.length; h.update(d); });
      body.on('end', () => resolve({ status: res.statusCode, headers: res.headers, wire, decoded,
        sha: h.digest('hex'), ms: Date.now() - t0 }));
      body.on('error', reject);
    });
    req.on('error', (e) => { if (!o.abortAfterFirstChunk) reject(e); });
  });
}

// ---------------------------------------------------------------- fixture
// game_log >= 1000 rows and a bet_signals table, because the script's step-2
// integrity check refuses anything smaller. The random blob makes the file
// large enough that an abort lands mid-stream.
function buildFixture(p) {
  const d = new Database(p);
  d.exec('CREATE TABLE game_log (game_id TEXT, game_date TEXT, notes TEXT);'
    + 'CREATE TABLE bet_signals (id INTEGER PRIMARY KEY, bet_locked_at TEXT);'
    + 'CREATE TABLE filler (b BLOB);');
  const ins = d.prepare('INSERT INTO game_log VALUES (?, ?, ?)');
  const blob = d.prepare('INSERT INTO filler VALUES (?)');
  d.transaction(() => {
    for (let i = 0; i < 1500; i++) ins.run('nyy-bos-' + i, '2026-09-01', 'repeated text '.repeat(40));
    d.prepare("INSERT INTO bet_signals (bet_locked_at) VALUES ('2026-09-01 12:00:00')").run();
    for (let i = 0; i < 24; i++) blob.run(crypto.randomBytes(512 * 1024));
  })();
  d.close();
}

function findBash() {
  if (process.env.BASH_BIN) return process.env.BASH_BIN;
  // On Windows a bare `bash` can resolve to WSL's System32 shim, which cannot
  // see this filesystem the same way. Prefer Git Bash when it is there.
  const git = 'C:/Program Files/Git/bin/bash.exe';
  return fs.existsSync(git) ? git : 'bash';
}
const fwd = (p) => p.replace(/\\/g, '/');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-gzip-'));
  const state = { dir, mode: 'normal' };
  const src = REAL_FILE || path.join(dir, 'fixture.db');
  if (!REAL_FILE) buildFixture(src);
  const srv = await startServer(src, state);
  const port = srv.address().port;

  try {
    if (REAL_FILE) {
      console.log('measuring ' + REAL_FILE);
      // The unlink is async and lands after the response ends; wait for it
      // before asserting, or the check races the callback.
      const waitCleaned = async () => { for (let i = 0; i < 50 && !state.cleaned; i++) await sleep(100); return state.cleaned; };
      const id = await fetchDb(port, {});
      const idSha = state.backupSha;
      const idCleaned = await waitCleaned();
      const gz = await fetchDb(port, { 'Accept-Encoding': 'gzip' });
      const gzSha = state.backupSha;
      const gzCleaned = await waitCleaned();
      console.log('  backup size        ' + state.backupSize + ' bytes');
      console.log('  identity on wire   ' + id.wire + ' bytes   ' + id.ms + 'ms');
      console.log('  gzip on wire       ' + gz.wire + ' bytes   ' + gz.ms + 'ms   '
        + (gz.wire / state.backupSize * 100).toFixed(1) + '% of backup');
      ok('identity body is the backup, byte for byte', id.sha === idSha && id.decoded === state.backupSize);
      ok('gzip body decodes to the backup, byte for byte', gz.sha === gzSha && gz.decoded === state.backupSize);
      ok('the temp backup was removed after each stream', idCleaned && gzCleaned);
      return;   // falls to the finally, which owns the exit code for both modes
    }

    console.log('1. Accept-Encoding parsing');
    ok('gzip', acceptsGzip('gzip'));
    ok('gzip, deflate, br', acceptsGzip('gzip, deflate, br'));
    ok('br;q=1.0, gzip;q=0.8', acceptsGzip('br;q=1.0, gzip;q=0.8'));
    ok('gzip;q=0 is a refusal', !acceptsGzip('gzip;q=0'));
    ok('absent header', !acceptsGzip(undefined));
    ok('identity only', !acceptsGzip('identity'));

    console.log('\n2. gzip when asked');
    const gz = await fetchDb(port, { 'Accept-Encoding': 'gzip' });
    ok('200', gz.status === 200);
    ok('Content-Encoding: gzip', gz.headers['content-encoding'] === 'gzip');
    ok('Vary: Accept-Encoding', /accept-encoding/i.test(gz.headers.vary || ''));
    ok('no Content-Length on a compressed body', gz.headers['content-length'] === undefined);
    ok('X-Uncompressed-Length is the backup size',
      gz.headers['x-uncompressed-length'] === String(state.backupSize));
    ok('decodes to the backup byte for byte', gz.sha === state.backupSha);
    ok('smaller on the wire', gz.wire < state.backupSize, gz.wire + ' < ' + state.backupSize);
    ok('helper reported success and gzip', state.last && state.last.ok && state.last.gzip);
    await sleep(100);
    ok('temp backup removed', state.cleaned);

    console.log('\n3. identity when not asked -- the old contract, unchanged');
    const id = await fetchDb(port, {});
    ok('no Content-Encoding', id.headers['content-encoding'] === undefined);
    ok('Content-Length is the backup size', id.headers['content-length'] === String(state.backupSize));
    ok('body is the backup byte for byte', id.sha === state.backupSha && id.wire === state.backupSize);
    const q0 = await fetchDb(port, { 'Accept-Encoding': 'gzip;q=0' });
    ok('gzip;q=0 gets identity', q0.headers['content-encoding'] === undefined);

    console.log('\n4. client abort mid-stream still removes the temp file');
    await fetchDb(port, { 'Accept-Encoding': 'gzip' }, { abortAfterFirstChunk: true });
    for (let i = 0; i < 30 && !state.cleaned; i++) await sleep(100);
    ok('temp backup removed after abort', state.cleaned);
    ok('helper reported the abort as not-ok', state.last && state.last.ok === false);

    console.log('\n5. the route still backs up before it streams');
    const api = fs.readFileSync(path.join(ROOT, 'routes', 'api.js'), 'utf8');
    const start = api.indexOf("router.get('/admin/download-db'");
    const handler = api.slice(start, api.indexOf('\n});', start));
    ok('handler found', start > 0);
    ok('db.backup(tempPath) precedes streamDbFile(',
      handler.indexOf('db.backup(tempPath)') > 0
      && handler.indexOf('db.backup(tempPath)') < handler.indexOf('streamDbFile('));
    ok('handler never opens a read stream of its own', handler.indexOf('createReadStream') < 0);

    console.log('\n6. refresh-analysis-db.sh end to end against this server');
    const sandbox = path.join(dir, 'repo');
    fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, 'data'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'refresh-analysis-db.sh'),
      path.join(sandbox, 'scripts', 'refresh-analysis-db.sh'));
    // Step 3 is not under test; a stub keeps it from reading a real DB.
    fs.writeFileSync(path.join(sandbox, 'scripts', 'pipeline-freshness.js'), 'console.log("freshness stub");\n');
    const env = Object.assign({}, process.env, {
      MLB_HOST: 'http://127.0.0.1:' + port,
      DB_DOWNLOAD_TOKEN: 'test-token',
      MLB_ADMIN_TOKEN: '',
      NODE_BIN: fwd(process.execPath),
      NODE_PATH: path.join(ROOT, 'node_modules'),
    });
    const bash = findBash();
    // ASYNC spawn, not spawnSync: the server answering the script lives in
    // THIS process, and spawnSync blocks its event loop -- the script's curl
    // waits on a server that cannot run until the script exits.
    const run = () => new Promise((resolve) => {
      for (const f of fs.readdirSync(path.join(sandbox, 'data'))) fs.unlinkSync(path.join(sandbox, 'data', f));
      const child = spawn(bash, [fwd(path.join(sandbox, 'scripts', 'refresh-analysis-db.sh'))], { env });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      const timer = setTimeout(() => child.kill(), 120000);
      child.on('close', (code) => {
        clearTimeout(timer);
        const files = fs.readdirSync(path.join(sandbox, 'data'));
        const snap = files.find(f => /^mlb\.db\.prod-\d{8}$/.test(f));
        resolve({ code, out, files, snap });
      });
    });

    for (const mode of ['normal', 'identity']) {
      state.mode = mode;
      const r = await run();
      const want = mode === 'normal' ? 'encoding=gzip' : 'encoding=identity';
      ok(mode + ': exit 0', r.code === 0, r.code !== 0 ? r.out.slice(-600) : '');
      ok(mode + ': reports ' + want, r.out.indexOf(want) >= 0);
      ok(mode + ': step-2 integrity check ran and passed', r.out.indexOf('quick_check ok') >= 0);
      ok(mode + ': snapshot is the backup byte for byte',
        !!r.snap && await shaFile(path.join(sandbox, 'data', r.snap)) === state.backupSha);
      ok(mode + ': the snapshot is the only file left (no .download/.headers)',
        !!r.snap && r.files.length === 1, r.files.join(','));
    }

    state.mode = 'truncate';
    const t = await run();
    ok('truncated gzip: exit 3', t.code === 3, 'exit=' + t.code);
    ok('truncated gzip: says why', /TRUNCATED|integrity/i.test(t.out));
    ok('truncated gzip: no snapshot, no partial files', t.files.length === 0, t.files.join(','));
    ok('truncated gzip: never reached the step-2 check', t.out.indexOf('=== 2/5') < 0);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    // Exit here, not after the try: the --file branch returns early, and a
    // trailing exit was skipped -- a FAIL in that mode used to exit 0.
    console.log('\n' + (fails ? fails + ' FAILED' : 'all checks passed'));
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
