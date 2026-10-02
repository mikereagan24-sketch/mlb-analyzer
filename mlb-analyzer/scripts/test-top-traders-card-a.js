#!/usr/bin/env node
'use strict';
/**
 * Top-traders card, PR A (2026-10-01): shared rules, production tables, the
 * seed upload route. Display only; nothing live.
 *
 *   a. the committed runner reproduces both result artifacts exactly:
 *      - --corrected on data/polymarket.db (repeats restored, #496) ->
 *        docs/polymarket-top-traders-results-2026-09-30-corrected.json;
 *      - the default mode on data/polymarket-before-repeats.db (the pre-fix
 *        store) -> docs/polymarket-top-traders-results-2026-09-30.json; skipped
 *        with a "backup not present" NOTE when that file is absent.
 *      Self-tests: one figure altered in either artifact is caught.
 *      Needs data/polymarket.db (read-only). (2026-10-02, #486) The game_log
 *      side is the PINNED pre-#486 copy, data/mlb-before-486.db, opened
 *      read-only -- the published artifacts were computed before the game_log
 *      repair, so a refreshed data/mlb.db must not be what reproduces them.
 *      Skipped with a "pre-#486 copy not present" NOTE when it is absent.
 *   b. utils/top-traders/rules.js imports nothing; the isolation walk -- roots
 *      server.js, services/model.js, services/jobs.js, utils/pythag-win-prob.js
 *      -- passes with the new router; planted-violation self-tests.
 *   c. POST /api/upload/top-trader-seed: missing / wrong token refused; a second
 *      upload leaves exactly the second file's contents (replace, not upsert);
 *      any rejected row (or a cut-off body) changes nothing; one upload at a
 *      time; idempotent; streamed (flat memory on a large file).
 *   d. no route returns a wallet address.
 *   e. the table migration runs twice cleanly.
 *
 *   node scripts/test-top-traders-card-a.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..');
const SCRATCH_COPY = process.env.MLB_DB_PATH || null;           // the suite's scratch copy (MLB_DB_PATH for the runner's environment)
const PRE486 = path.join(R, 'data/mlb-before-486.db');           // the pinned pre-#486 game_log copy (check a), read-only
const TMP_DB = path.join(os.tmpdir(), '__tt_card_a_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
process.env.DB_DOWNLOAD_TOKEN = TOKEN;
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. the committed runner reproduces both result artifacts exactly');
  {
    const PM = path.join(R, 'data/polymarket.db');
    const BACKUP = path.join(R, 'data/polymarket-before-repeats.db');
    const ORIGINAL = 'docs/polymarket-top-traders-results-2026-09-30.json';
    const CORRECTED = 'docs/polymarket-top-traders-results-2026-09-30-corrected.json';
    const realMlb = path.resolve(R, 'data/mlb.db');
    // Every field compared; only timestamp, commit, runtime and memory fields are excluded.
    const SKIP = new Set(['generated_at', 'generated_from_commit', 'generated_with_uncommitted_tracked_changes', 'runtime_seconds', 'peak_rss_mb']);
    const compare = (A, B) => {
      let fields = 0; const diffs = [];
      const walk = (x, y, p) => {
        if (x && typeof x === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y || {})])) walk(x[k], y && y[k], p + '.' + k); return; }
        fields++; if (!Object.is(x, y)) diffs.push(p);
      };
      for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (!SKIP.has(k)) walk(A[k], B[k], k);
      return { fields, diffs };
    };
    // -> { status, log, json }   (status 3 = Gate 1 stopped the run before outcomes)
    const runRunner = (pmDb, extra) => {
      const out = path.join(os.tmpdir(), '__tt_repro_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.json');
      let status = 0, log;
      try {
        log = execFileSync(process.execPath, ['--max-old-space-size=1536', path.join(R, 'scripts/run-polymarket-top-traders-backtest.js'),
          '--pm-db', pmDb, '--mlb-db', PRE486, '--json', out, ...extra],
        { cwd: R, encoding: 'utf8', env: Object.assign({}, process.env, { MLB_DB_PATH: SCRATCH_COPY || path.join(os.tmpdir(), '__tt_card_a_runner_' + process.pid + '.db') }) });
      } catch (e) { status = e.status; log = String(e.stdout || '') + String(e.stderr || ''); }
      const json = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
      try { fs.unlinkSync(out); } catch (e) { /* not written */ }
      return { status, log, json };
    };
    const gateLine = (log) => (log.match(/GATE 1[^\n]*/) || [''])[0];
    // Self-test: one figure altered in the reference artifact must be caught by the comparison.
    const altered = (ref) => { const x = JSON.parse(JSON.stringify(ref)); x.results[0].W += 1; return x; };
    if (!fs.existsSync(PRE486)) {
      console.log('  NOTE  pre-#486 copy not present (data/mlb-before-486.db): reproduction skipped, not failed');
    } else if (!fs.existsSync(PM)) {
      console.log('  NOTE  needs data/polymarket.db: reproduction skipped, not failed');
    } else if (path.resolve(PRE486) === realMlb) {
      ok('refuses the live data/mlb.db (only the pinned pre-#486 copy reproduces the artifacts)', false, PRE486);
    } else {
      // The corrected data: --corrected mode must reproduce the corrected artifact.
      const C = JSON.parse(read(CORRECTED));
      const rc = runRunner(PM, ['--corrected']);
      ok('--corrected on data/polymarket.db: Gate 1 matches 27 of 27 (11 game_log-only fields vs §10, the rest vs the corrected artifact)',
        rc.status === 0 && /27 of 27 fields match/.test(rc.log), gateLine(rc.log) || 'exit ' + rc.status);
      const dc = rc.json ? compare(C, rc.json) : { fields: 0, diffs: ['no output'] };
      ok('--corrected reproduces ' + CORRECTED + ' exactly', dc.diffs.length === 0, dc.fields + ' fields' + (dc.diffs.length ? ' | ' + dc.diffs.slice(0, 5).join(', ') : ''));
      ok('SELF-TEST: the corrected artifact with one figure altered (results[0].W + 1) is caught', rc.json && compare(altered(C), rc.json).diffs.length === 1);
      // A trade-dependent Gate 1 value altered in a copy of the corrected artifact stops the run before outcomes.
      const tmpRef = path.join(os.tmpdir(), '__tt_ref_' + process.pid + '.json');
      const bad = JSON.parse(JSON.stringify(C)); bad.feasibility.qualified_by_month['2026-09'].last_qualified += 1;
      fs.writeFileSync(tmpRef, JSON.stringify(bad));
      const rg = runRunner(PM, ['--corrected', '--corrected-artifact', tmpRef, '--gate1-only']);
      fs.unlinkSync(tmpRef);
      ok('SELF-TEST: one Gate 1 figure altered in the corrected artifact -> Gate 1 fails and stops before outcomes (exit 3)',
        rg.status === 3 && /FAILED: 1 field\(s\) differ/.test(rg.log), gateLine(rg.log));
      // The pre-fix store: the default mode must reproduce the original artifact.
      if (!fs.existsSync(BACKUP)) {
        console.log('  NOTE  backup not present (data/polymarket-before-repeats.db): reproduction of ' + ORIGINAL + ' skipped, not failed');
      } else {
        const O = JSON.parse(read(ORIGINAL));
        const ro = runRunner(BACKUP, []);
        ok('default mode on the pre-fix backup: Gate 1 matches 27 of 27 against §10', ro.status === 0 && /27 of 27 fields match/.test(ro.log), gateLine(ro.log) || 'exit ' + ro.status);
        const dO = ro.json ? compare(O, ro.json) : { fields: 0, diffs: ['no output'] };
        ok('default mode reproduces ' + ORIGINAL + ' exactly', dO.diffs.length === 0, dO.fields + ' fields' + (dO.diffs.length ? ' | ' + dO.diffs.slice(0, 5).join(', ') : ''));
        ok('SELF-TEST: the original artifact with one figure altered (results[0].W + 1) is caught', ro.json && compare(altered(O), ro.json).diffs.length === 1);
      }
    }
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. the shared rules import nothing; isolation with server.js as a root');
  const { stripJsComments } = require(path.join(R, 'services/harness-inputs'));
  {
    const rulesSrc = stripJsComments(read('utils/top-traders/rules.js'));
    ok('utils/top-traders/rules.js has no require at all (pure)', !/require\(/.test(rulesSrc));
    const btSrc = stripJsComments(read('services/polymarket-top-traders-backtest.js'));
    ok('the backtest calls the shared rules and no longer defines them',
      /require\('\.\.\/utils\/top-traders\/rules'\)/.test(btSrc)
      && !/function (priceStep|leanFrom|qualified)\(/.test(btSrc) && !/const (topN|parseUtc) =/.test(btSrc));
    const exportSrc = stripJsComments(read('scripts/export-top-trader-seed.js'));
    ok('the seed export uses the backtest\'s history inputs and the shared rules (no re-implementation)',
      /bt\.loadHistoryInputs\(/.test(exportSrc) && /RULES\.qualified\(/.test(exportSrc) && /RULES\.addWalletGame\(/.test(exportSrc)
      && !/s\.games\+\+/.test(exportSrc));
    const realFs = { exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(), read: (p) => fs.readFileSync(p, 'utf8') };
    function graph(roots, fsLike) {
      const seen = new Set(), stack = roots.map(r => path.join(R, r)).filter(f => fsLike.exists(f));
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const x of stripJsComments(fsLike.read(f)).matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          const p = path.resolve(path.dirname(f), x[1]);
          const hit = [p, p + '.js', path.join(p, 'index.js')].find(c => fsLike.exists(c));
          if (hit) stack.push(hit);
        }
      }
      return new Set([...seen].map(f => path.relative(R, f).replace(/\\/g, '/')));
    }
    const appGraph = graph(['server.js', 'services/model.js', 'services/jobs.js', 'utils/pythag-win-prob.js'], realFs);
    const LOCAL_ONLY = ['services/polymarket-top-traders-backtest.js', 'scripts/run-polymarket-top-traders-backtest.js',
      'scripts/export-top-trader-seed.js', 'services/polymarket-backfill.js'];
    ok('the app graph (server.js included) is walked and contains the new router', appGraph.has('routes/top-traders-upload.js') && appGraph.size > 50, appGraph.size + ' files');
    ok('nothing the server loads reaches the local-only backtest, backfill or seed export',
      LOCAL_ONLY.every(f => !appGraph.has(f)), LOCAL_ONLY.filter(f => appGraph.has(f)).join(',') || 'none');
    const nameDb = [...appGraph].filter(f => /polymarket\.db/.test(stripJsComments(fs.readFileSync(path.join(R, f), 'utf8'))));
    ok('no file the server loads names data/polymarket.db in code', nameDb.length === 0, nameDb.join(',') || 'none');
    const pricing = graph(['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js'], realFs);
    const CARD = ['routes/top-traders-upload.js', 'utils/top-traders/rules.js', 'db/top-traders-ddl.js'];
    // db/top-traders-ddl.js IS reached from the pricing graph through db/schema.js (it creates the tables); the
    // pricing code must not otherwise depend on the card, and must not READ its tables.
    ok('the pricing graph does not reach the upload router or the shared rules',
      !pricing.has('routes/top-traders-upload.js') && !pricing.has('utils/top-traders/rules.js'));
    const readsTables = [...pricing].filter(f => f !== 'db/top-traders-ddl.js'
      && /top_trader_(wallets|qualified|lean_log)/.test(stripJsComments(fs.readFileSync(path.join(R, f), 'utf8'))));
    ok('no pricing-path file references the top-traders tables (only their DDL module does)', readsTables.length === 0, readsTables.join(',') || 'none');
    const routeGraph = graph(['routes/top-traders-upload.js'], realFs);
    ok('the upload router reaches nothing in the pricing path (model, pythag, jobs, routes/api)',
      ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js', 'routes/api.js'].every(f => !routeGraph.has(f)));
    // Self-tests on a planted graph.
    const planted = {
      [path.join(R, 'server.js')]: "require('./routes/x');",
      [path.join(R, 'routes/x.js')]: "require('../services/polymarket-top-traders-backtest');",
      [path.join(R, 'services/polymarket-top-traders-backtest.js')]: '',
    };
    const pfs = { exists: (p) => Object.prototype.hasOwnProperty.call(planted, p), read: (p) => planted[p] };
    ok('SELF-TEST: a route requiring the backtest is caught', graph(['server.js'], pfs).has('services/polymarket-top-traders-backtest.js'));
    planted[path.join(R, 'routes/x.js')] = "// require('../services/polymarket-top-traders-backtest') -- comment only";
    ok('SELF-TEST: the same words in a comment are not a dependency', !graph(['server.js'], pfs).has('services/polymarket-top-traders-backtest.js'));
    const srv = read('server.js');
    const iUp = srv.indexOf("app.use('/api', require('./routes/top-traders-upload'));"), iApi = srv.indexOf("app.use('/api', require('./routes/api'));");
    ok('server.js mounts the upload router before routes/api.js (whose POST /upload/:key? would take the path)', iUp > 0 && iApi > iUp);
    ok('routes/api.js gets requireAdminToken from utils/admin-auth.js and no longer defines it',
      /require\('\.\.\/utils\/admin-auth'\)/.test(read('routes/api.js')) && !/function requireAdminToken\(/.test(read('routes/api.js')));
  }

  // ---------------------------------------------------------------- c, d, e: a real server on the throwaway database
  const schema = require(path.join(R, 'db/schema'));       // TMP_DB: runs every migration, incl. the new tables
  const db = schema.db;
  const express = require(path.join(R, 'node_modules/express'));
  const app = express();
  app.use(express.json({ limit: '25mb' }));                   // as server.js does: must not swallow text/csv
  app.use('/api', require(path.join(R, 'routes/top-traders-upload')));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const { SEED_HEADER } = require(path.join(R, 'db/top-traders-ddl'));
  const post = (bodyOrGen, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/upload/top-trader-seed', headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve({ code: res.statusCode, body: j, raw: s }); });
    });
    req.on('error', reject);
    if (typeof bodyOrGen === 'function') {
      const gen = bodyOrGen();
      const pump = () => { for (;;) { const n = gen.next(); if (n.done) { req.end(); return; } if (!req.write(n.value)) { req.once('drain', pump); return; } } };
      pump();
    } else req.end(bodyOrGen);
  });
  const H = (extra) => Object.assign({ 'Content-Type': 'text/csv', 'X-Admin-Token': TOKEN }, extra || {});
  const addr = (i) => '0x' + crypto.createHash('sha1').update('w' + i).digest('hex');
  const wrow = (i, asOf) => ['wallet', i, addr(i), 50, (i % 7) - 2.5 + 0.123456789, 1000 + i, i % 5, asOf || '2026-09-28'].join(',');
  const goodCsv = [SEED_HEADER, ...Array.from({ length: 300 }, (_, k) => wrow(k + 1)),
    ...[5, 10, 15].map(i => ['qualified', i, '', '', '', '', '', '2026-09-28'].join(','))].join('\n') + '\n';
  const tableHash = () => crypto.createHash('sha256').update(JSON.stringify([
    db.prepare('SELECT * FROM top_trader_wallets ORDER BY wallet_id').all(),
    db.prepare('SELECT * FROM top_trader_qualified ORDER BY as_of, wallet_id').all()])).digest('hex');

  console.log('\nc. the upload route');
  {
    const none = await post(goodCsv, { 'Content-Type': 'text/csv' });
    const wrong = await post(goodCsv, H({ 'X-Admin-Token': TOKEN.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) }));
    ok('missing token -> 401, nothing written', none.code === 401 && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 0);
    ok('wrong token -> 401, nothing written', wrong.code === 401 && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 0);
    const saved = process.env.DB_DOWNLOAD_TOKEN; delete process.env.DB_DOWNLOAD_TOKEN;
    const unset = await post(goodCsv, H());
    process.env.DB_DOWNLOAD_TOKEN = saved;
    ok('token not configured on the server -> 503 (never silently open)', unset.code === 503);
    const json = await post(JSON.stringify({ rows: [] }), H({ 'Content-Type': 'application/json' }));
    ok('a non-CSV content type -> 415', json.code === 415);
    const badHeader = await post('type,wallet_id\n' + wrow(1) + '\n', H());
    ok('a wrong header -> 400, nothing written', badHeader.code === 400 && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 0);
    const r1 = await post(goodCsv, H());
    ok('valid file: 300 wallet rows and 3 qualified rows written, 0 rejected',
      r1.code === 200 && r1.body.wallet_rows_written === 300 && r1.body.qualified_rows_written === 3 && r1.body.rejected === 0 && r1.body.ok === true, JSON.stringify(r1.body && { w: r1.body.wallet_rows_written, q: r1.body.qualified_rows_written, ms: r1.body.duration_ms }));
    const h1 = tableHash();
    const r2 = await post(goodCsv, H());
    ok('idempotent: re-uploading the same file leaves identical table contents', r2.code === 200 && tableHash() === h1
      && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 300 && db.prepare('SELECT COUNT(*) c FROM top_trader_qualified').get().c === 3);
    const bad = [SEED_HEADER,
      'wallet,9001,' + addr(9001) + ',x,1,2,0,2026-09-28',                      // games not an integer
      'wallet,9002,0xNOTHEX,10,1,2,0,2026-09-28',                                // bad address
      'wallet,9003,' + addr(9003) + ',10,1,-5,0,2026-09-28',                     // negative volume
      'wallet,9004,' + addr(9004) + ',3,1,2,9,2026-09-28',                       // both_teams > games
      'wallet,9005,' + addr(9005) + ',10,1,2,0,2026-09-29',                      // as_of differs
      'bogus,9006,,,,,,2026-09-28',                                              // unknown type
      'wallet,9007,' + addr(9007) + ',10,1,2,0',                                 // 7 fields
      'qualified,9008,' + addr(9008) + ',,,,,2026-09-28',                        // qualified with an address
      wrow(9009)].join('\n') + '\n';
    const r3 = await post(bad.replace(SEED_HEADER + '\n', SEED_HEADER + '\n' + wrow(9010) + '\n'), H());
    ok('malformed rows are rejected and counted (422), and NOTHING changes -- not even the 2 valid rows',
      r3.code === 422 && r3.body.rejected === 8 && r3.body.wallet_rows_written === 0 && r3.body.ok === false && r3.body.replaced === false
      && tableHash() === h1
      && r3.body.rejected_samples.length === 8 && r3.body.rejected_samples.every(s => Number.isInteger(s.line) && typeof s.reason === 'string'),
      JSON.stringify(r3.body && r3.body.rejected_samples.map(s => s.line + ':' + s.reason.slice(0, 18))));

    // REPLACE: a second upload leaves exactly the second file's contents.
    // (2026-10-01 regression: the first version upserted, so wallets missing from a second upload stayed.)
    const tableRows = () => ({ w: db.prepare('SELECT wallet_id, addr, games, profit, volume, both_teams, as_of FROM top_trader_wallets ORDER BY wallet_id').all(),
      q: db.prepare("SELECT wallet_id FROM top_trader_qualified WHERE as_of = '2026-09-28' ORDER BY wallet_id").all().map(r => r.wallet_id) });
    const fileRows = (csv) => {
      const w = [], q = [];
      for (const l of csv.split('\n').slice(1).filter(Boolean)) {
        const f = l.split(',');
        if (f[0] === 'wallet') w.push({ wallet_id: +f[1], addr: f[2], games: +f[3], profit: +f[4], volume: +f[5], both_teams: +f[6], as_of: f[7] });
        else q.push(+f[1]);
      }
      return { w: w.sort((a, b) => a.wallet_id - b.wallet_id), q: q.sort((a, b) => a - b) };
    };
    db.prepare("INSERT INTO top_trader_qualified (as_of, wallet_id) VALUES ('2026-09-20', 7)").run();   // another date's set
    const second = [SEED_HEADER,
      ...Array.from({ length: 250 }, (_, k) => k + 1 === 2 ? ['wallet', 2, addr(2), 61, 9.5, 4321.25, 3, '2026-09-28'].join(',') : wrow(k + 1)),
      wrow(400),
      ...[5, 400].map(i => ['qualified', i, '', '', '', '', '', '2026-09-28'].join(','))].join('\n') + '\n';
    const r4 = await post(second, H());
    const after = tableRows(), want = fileRows(second);
    ok('second upload: the tables hold exactly the second file (wallets 251-300 and qualified 10, 15 gone; wallet 2 updated; wallet 400 added)',
      r4.code === 200 && r4.body.replaced === true && JSON.stringify(after) === JSON.stringify(want)
      && after.w.length === 251 && !after.w.some(r => r.wallet_id > 250 && r.wallet_id !== 400)
      && JSON.stringify(after.q) === '[5,400]' && after.w[1].games === 61 && after.w[1].profit === 9.5 && after.w[1].volume === 4321.25,
      JSON.stringify(r4.body && { w: r4.body.wallet_rows_written, q: r4.body.qualified_rows_written, wr: r4.body.wallets_removed, qr: r4.body.qualified_removed }));
    ok('second upload reports what it removed (50 wallets, 2 qualified rows)', r4.body.wallets_removed === 50 && r4.body.qualified_removed === 2);
    ok("another as_of date's qualified set is untouched",
      db.prepare("SELECT COUNT(*) c FROM top_trader_qualified WHERE as_of = '2026-09-20' AND wallet_id = 7").get().c === 1);
    db.prepare("DELETE FROM top_trader_qualified WHERE as_of = '2026-09-20'").run();
    const h2 = tableHash();

    // ALL OR NOTHING: one bad row in an otherwise valid file changes nothing.
    const oneBad = goodCsv.replace(wrow(150) + '\n', 'wallet,150,' + addr(150) + ',50,1,2,77,2026-09-28\n');   // both_teams > games
    const r5 = await post(oneBad, H());
    ok('a file with one bad row (line 151) changes nothing and returns that row', r5.code === 422 && r5.body.rejected === 1 && r5.body.replaced === false
      && r5.body.wallet_rows_written === 0 && tableHash() === h2 && r5.body.rejected_samples[0].line === 151,
      JSON.stringify(r5.body && r5.body.rejected_samples));
    const dupId = goodCsv.replace(wrow(9) + '\n', wrow(9) + '\n' + ['wallet', 9, addr(99999), 1, 1, 1, 0, '2026-09-28'].join(',') + '\n');
    const dupAddr = goodCsv.replace(wrow(9) + '\n', wrow(9) + '\n' + ['wallet', 99999, addr(9), 1, 1, 1, 0, '2026-09-28'].join(',') + '\n');
    const orphan = goodCsv + ['qualified', 4242, '', '', '', '', '', '2026-09-28'].join(',') + '\n';
    const [r6, r7, r8] = [await post(dupId, H()), await post(dupAddr, H()), await post(orphan, H())];
    ok('a repeated wallet_id, a repeated address, or a qualified row with no wallet row is rejected and changes nothing',
      [r6, r7, r8].every(r => r.code === 422 && r.body.rejected === 1 && r.body.replaced === false) && tableHash() === h2,
      [r6, r7, r8].map(r => r.code + ' ' + (r.body && r.body.rejected_samples.map(s => s.line + ':' + s.reason).join(';'))).join(' | '));
    // A body cut off mid-upload changes nothing; a second upload meanwhile is refused (409); the lock is released after.
    const cut = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/upload/top-trader-seed', headers: H() });
      rq.on('error', () => { /* we cut it */ });
      rq.write(SEED_HEADER + '\n' + Array.from({ length: 5000 }, (_, k) => wrow(k + 1)).join('\n') + '\n');
      setTimeout(async () => {
        const during = await post(goodCsv, H());
        rq.destroy();
        setTimeout(() => resolve(during), 300);
      }, 300);
    });
    ok('a second upload while one is in progress -> 409, nothing changed', cut.code === 409 && tableHash() === h2, String(cut.code));
    ok('an upload cut off mid-body changes nothing', tableHash() === h2);
    const r9 = await post(goodCsv, H());
    ok('the lock is released after a cut-off upload, and a valid upload then replaces (back to the first file)',
      r9.code === 200 && tableHash() === h1 && r9.body.wallets_removed === 1 && r9.body.qualified_removed === 1, String(r9.code));
    ok('the staging tables are empty between uploads',
      db.prepare('SELECT (SELECT COUNT(*) FROM top_trader_seed_stage_wallets) + (SELECT COUNT(*) FROM top_trader_seed_stage_qualified) c').get().c === 0);
    // Streaming: synthetic files built by a generator (never held whole), small then 5x larger.
    // Flat = (1) nothing retained once the upload ends (heap after GC back to its start), and
    // (2) peak growth does NOT scale with the file: a 5x larger upload must not grow memory ~5x.
    // Client and server share this process, so peak heap includes the client's own short-lived strings.
    require('v8').setFlagsFromString('--expose-gc');
    const gc = require('vm').runInNewContext('gc');
    const gen = (N, off) => function* () { yield SEED_HEADER + '\n'; let buf = ''; for (let i = 1; i <= N; i++) { buf += wrow(off + i) + '\n'; if (i % 2000 === 0) { yield buf; buf = ''; } } if (buf) yield buf; };
    const measure = async (N, off) => {
      gc(); await new Promise(r => setTimeout(r, 30)); gc();
      const base = process.memoryUsage();
      let peakHeap = base.heapUsed, peakRss = base.rss;
      const t = setInterval(() => { const m = process.memoryUsage(); if (m.heapUsed > peakHeap) peakHeap = m.heapUsed; if (m.rss > peakRss) peakRss = m.rss; }, 10);
      const r = await post(gen(N, off), H());
      clearInterval(t);
      gc(); const after = process.memoryUsage();
      let bytes = 0; for (const c of gen(N, off)()) bytes += Buffer.byteLength(c);
      return { N, r, mb: bytes / 1e6, heapPeak: (peakHeap - base.heapUsed) / 1e6, rssPeak: (peakRss - base.rss) / 1e6, retained: (after.heapUsed - base.heapUsed) / 1e6 };
    };
    await measure(20000, 500000);                               // warm-up (JIT, statement caches)
    const small = await measure(50000, 600000), large = await measure(250000, 700000);
    const fmt = (x) => x.N + ' rows / ' + x.mb.toFixed(1) + ' MB: peak heap +' + x.heapPeak.toFixed(1) + ' MB, peak RSS +' + x.rssPeak.toFixed(1)
      + ' MB, retained after GC ' + x.retained.toFixed(1) + ' MB, ' + x.r.body.duration_ms + ' ms';
    ok('large file written in full (' + large.N + ' rows, ' + large.mb.toFixed(1) + ' MB)',
      large.r.code === 200 && large.r.body.wallet_rows_written === large.N && large.r.body.rejected === 0 && small.r.body.wallet_rows_written === small.N);
    ok('streams: nothing retained after either upload (heap back within 5 MB after GC)', small.retained < 5 && large.retained < 5, fmt(small) + ' | ' + fmt(large));
    ok('streams: a 5x larger file does not grow peak memory ~5x (peak heap large < 2 x small + 10 MB)',
      large.heapPeak < 2 * small.heapPeak + 10, 'small +' + small.heapPeak.toFixed(1) + ' MB, large +' + large.heapPeak.toFixed(1) + ' MB');
  }

  console.log('\nd. no route returns a wallet address');
  {
    const ADDR = /0x[0-9a-fA-F]{40}/;
    const probe = await post([SEED_HEADER, 'wallet,77,' + addr(77) + ',notanint,1,2,0,2026-09-28', wrow(78)].join('\n') + '\n', H());
    ok('responses (success and rejection) contain no address, even when a rejected row had one', !ADDR.test(probe.raw) && probe.body.rejected === 1, probe.raw.slice(0, 120));
    const routeFiles = ['server.js', ...fs.readdirSync(path.join(R, 'routes')).filter(f => f.endsWith('.js')).map(f => 'routes/' + f)];
    const selects = routeFiles.filter(f => {
      const src = stripJsComments(read(f));
      return /SELECT[\s\S]{0,200}?\baddr\b[\s\S]{0,200}?FROM\s+top_trader_wallets/i.test(src) || /SELECT\s+\*\s+FROM\s+top_trader_wallets/i.test(src)
        || /FROM\s+wallets\b/i.test(src);
    });
    ok('no route or server.js SELECTs an address from top_trader_wallets (or any wallets table)', selects.length === 0, selects.join(',') || routeFiles.length + ' files checked');
    const touch = routeFiles.filter(f => /top_trader_wallets/.test(stripJsComments(read(f))));
    ok('the only route that touches top_trader_wallets is the seed upload (writes only)', JSON.stringify(touch) === JSON.stringify(['routes/top-traders-upload.js']), touch.join(','));
    ok('the rule is stated in code: the DDL and the router both say addresses are never served',
      /NEVER SERVED/.test(read('db/top-traders-ddl.js')) && /NO ROUTE EVER RETURNS A WALLET ADDRESS/.test(read('routes/top-traders-upload.js')));
  }

  console.log('\ne. the table migration runs twice cleanly');
  {
    const { applyTopTradersDdl } = require(path.join(R, 'db/top-traders-ddl'));
    const before = db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c;
    let threw = null;
    try { applyTopTradersDdl(db); applyTopTradersDdl(db); } catch (e) { threw = e.message; }
    ok('applying the DDL again (twice more) on a populated database does not throw or change data',
      threw === null && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === before, threw || before + ' rows kept');
    const fresh = new Database(':memory:');
    applyTopTradersDdl(fresh); applyTopTradersDdl(fresh);
    const tables = fresh.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'top_trader_%' ORDER BY name").all().map(r => r.name);
    // + PR B (2026-10-01): the live job's three tables (scripts/test-top-traders-card-b.js covers them).
    ok('a fresh database gets exactly the three tables, the two seed staging tables and the live job\'s three tables', JSON.stringify(tables) === JSON.stringify(['top_trader_lean_log',
      'top_trader_live_fills', 'top_trader_live_markets', 'top_trader_live_state',
      'top_trader_qualified', 'top_trader_seed_stage_qualified', 'top_trader_seed_stage_wallets', 'top_trader_wallets']), tables.join(','));
    const cols = fresh.prepare('PRAGMA table_info(top_trader_lean_log)').all().map(c => c.name);
    const want = ['game_date', 'game_id', 'shown_at', 'cut_utc', 'lean_team', 'lean_dollars', 'other_dollars', 'wallets_with_money', 'top_wallet_share',
      'qualified_count', 'away_ml_shown', 'home_ml_shown', 'price_source', 'kind', 'phase', 'locked_away_ml', 'locked_home_ml'];
    ok('the lean log carries every decision-8 column', want.every(c => cols.includes(c)), want.filter(c => !cols.includes(c)).join(',') || cols.length + ' columns');
    let refused = false;
    try { fresh.prepare("INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, lean_team, lean_dollars, other_dollars, wallets_with_money, qualified_count, kind, phase, locked_away_ml) VALUES ('2026-10-01','a-b','x',1,'A',1,0,1,25,'provisional','postseason',120)").run(); } catch (e) { refused = true; }
    ok('a provisional row cannot carry a locked price (CHECK)', refused);
    ok('the lean log starts empty', db.prepare('SELECT COUNT(*) c FROM top_trader_lean_log').get().c === 0);
  }

  await new Promise(r => server.close(r));
  try { db.close(); } catch (e) { /* closed */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
