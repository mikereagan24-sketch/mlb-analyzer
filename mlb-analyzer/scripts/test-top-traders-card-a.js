#!/usr/bin/env node
'use strict';
/**
 * Top-traders card, PR A (2026-10-01): shared rules, production tables, the
 * seed upload route. Display only; nothing live.
 *
 *   a. the backtest still reproduces docs/polymarket-top-traders-results-2026-09-30.json
 *      exactly (Gate 1: 27 of 27) after the rules moved to utils/top-traders/rules.js.
 *      Needs data/polymarket.db (read-only) and a SCRATCH COPY of mlb.db via
 *      MLB_DB_PATH (the suite passes one); skipped with a NOTE otherwise.
 *   b. utils/top-traders/rules.js imports nothing; the isolation walk -- roots
 *      server.js, services/model.js, services/jobs.js, utils/pythag-win-prob.js
 *      -- passes with the new router; planted-violation self-tests.
 *   c. POST /api/upload/top-trader-seed: missing / wrong token refused, malformed
 *      rows rejected, idempotent, and streamed (flat memory on a large file).
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
const SCRATCH_COPY = process.env.MLB_DB_PATH || null;           // the suite's scratch copy (check a)
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
  console.log('a. the backtest reproduces its published artifact exactly (rules moved)');
  {
    const PM = path.join(R, 'data/polymarket.db');
    const realMlb = path.resolve(R, 'data/mlb.db');
    if (!SCRATCH_COPY || !fs.existsSync(PM)) {
      console.log('  NOTE  needs data/polymarket.db and MLB_DB_PATH=<scratch copy outside the repo> (the suite passes one)');
    } else if (path.resolve(SCRATCH_COPY) === realMlb || path.resolve(SCRATCH_COPY).startsWith(path.resolve(R) + path.sep)) {
      ok('refuses a database inside the repo (never data/mlb.db)', false, SCRATCH_COPY);
    } else {
      const out = path.join(os.tmpdir(), '__tt_repro_' + process.pid + '.json');
      const log = execFileSync(process.execPath, ['--max-old-space-size=1536', path.join(R, 'scripts/run-polymarket-top-traders-backtest.js'),
        '--pm-db', PM, '--mlb-db', SCRATCH_COPY, '--json', out], { cwd: R, encoding: 'utf8', env: Object.assign({}, process.env, { MLB_DB_PATH: SCRATCH_COPY }) });
      ok('Gate 1 still matches 27 of 27', /27 of 27 fields match/.test(log), (log.match(/GATE 1[^\n]*/) || [''])[0]);
      const A = JSON.parse(read('docs/polymarket-top-traders-results-2026-09-30.json')), B = JSON.parse(fs.readFileSync(out, 'utf8'));
      fs.unlinkSync(out);
      const skip = new Set(['generated_at', 'generated_from_commit', 'generated_with_uncommitted_tracked_changes', 'runtime_seconds', 'peak_rss_mb']);
      let fields = 0; const diffs = [];
      const walk = (x, y, p) => {
        if (x && typeof x === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y || {})])) walk(x[k], y && y[k], p + '.' + k); return; }
        fields++; if (!Object.is(x, y)) diffs.push(p);
      };
      for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (!skip.has(k)) walk(A[k], B[k], k);
      ok('every field matches (only timestamp / commit / runtime fields excluded)', diffs.length === 0, fields + ' fields' + (diffs.length ? ' | ' + diffs.slice(0, 5).join(', ') : ''));
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
    ok('malformed rows are rejected and counted; the valid ones are written',
      r3.code === 200 && r3.body.rejected === 8 && r3.body.wallet_rows_written === 2 && r3.body.ok === false
      && r3.body.rejected_samples.length === 8 && r3.body.rejected_samples.every(s => Number.isInteger(s.line) && typeof s.reason === 'string'),
      JSON.stringify(r3.body && r3.body.rejected_samples.map(s => s.line + ':' + s.reason.slice(0, 18))));
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
    ok('a fresh database gets exactly the three tables', JSON.stringify(tables) === JSON.stringify(['top_trader_lean_log', 'top_trader_qualified', 'top_trader_wallets']), tables.join(','));
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
