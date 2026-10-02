#!/usr/bin/env node
'use strict';
/**
 * The Trends tab: wired in, fed only by its artifact, and isolated from
 * pricing. (2026-09-29) Display only.
 *
 *   a. the renderer is defined once, is JavaScript (outside <style>), and is
 *      actually called -- by loadTrendsResults, which sw('trends') calls, from
 *      a tab button that exists.
 *   b. GET /api/trends/results reads the committed artifact and nothing else:
 *      no database, settings, model or trends computation; a missing or
 *      corrupt artifact answers with an error JSON instead of throwing.
 *   c. the artifact is the pre-registered run: its prereg_sha256 is the hash
 *      pinned in services/trends-backtest.js, its scenarios are exactly
 *      S01-S31, every scenario has an other-side block, and the other side is
 *      the same two-sided test (p equal within 1e-12, implied = 1 - original
 *      within 1e-9).
 *   d. STRUCTURAL ISOLATION: no file in the pricing path -- services/model.js
 *      (runModel, getSignals), utils/pythag-win-prob.js, services/jobs.js
 *      (getSettings, processGameSignals) and EVERYTHING THEY REQUIRE,
 *      transitively -- references the trends modules, the trends router or
 *      the artifact. That graph includes routes/api.js (jobs.js requires it
 *      for ingestWobaCSV), which is why the route lives in its own router.
 *      A self-test proves the check catches a planted violation.
 *
 *   (2026-09-30) d-h: the route graph, sorting, the shared context, a
 *      synthetic slate, and the backtest reproduction -- since #486
 *      (2026-10-02) on the pinned pre-fix copy data/mlb-before-486.db,
 *      read-only, skipped with a NOTE when that copy is absent.
 *   (2026-10-01) i. the Polymarket top-traders section: wired in, its route
 *      reads only its artifact, every figure comes from the artifact (whose
 *      pre-registration hash matches the pinned one), q only on the main
 *      in-sample rows, sensitivity collapsed and display only.
 *      Since #498: the route returns { corrected, original } (either missing ->
 *      the error JSON); the main table, verdict and sensitivity are the
 *      corrected artifact, the correction note reads its count and fix PR from
 *      it, and the collapsed "Original result (superseded)" table is the
 *      original artifact; no figure from either is written into the renderer.
 *
 *   node scripts/test-trends-results-tab.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const R = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

// NEVER OPEN data/mlb.db. Check (d) reuses harness-inputs.stripJsComments,
// and loading harness-inputs loads db/schema, which opens the database and
// runs its idempotent migrations. Point it at a throwaway file first, and
// remove that file on the way out.
const TMP_DB = path.join(os.tmpdir(), '__trends_results_tab_' + process.pid + '.db');
// Check h re-runs the backtest on the pinned pre-#486 copy (data/mlb-before-486.db),
// read-only -- not on MLB_DB_PATH, which is redirected to the throwaway file here.
process.env.MLB_DB_PATH = TMP_DB;
function cleanupTmpDb() {
  try { require(path.join(R, 'db/schema')).db.close(); } catch (e) { /* never opened */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
}

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- a
console.log('a. the Trends tab renderer is wired into public/index.html');
const html = read('public/index.html');
const lines = html.split(/\r?\n/);
const styleRanges = [];
let open = false;
lines.forEach((l, i) => {
  if (/<style[ >]/i.test(l)) { open = true; styleRanges.push([i + 1, null]); }
  if (/<\/style>/i.test(l) && open) { open = false; styleRanges[styleRanges.length - 1][1] = i + 1; }
});
const insideStyle = (n) => styleRanges.some(([a, b]) => n >= a && n <= (b == null ? Infinity : b));
const where = (re) => lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
const defR = where(/function\s+renderTrendsResults\s*\(/);
const defL = where(/function\s+loadTrendsResults\s*\(/);
const callR = where(/[^\w]renderTrendsResults\(d\)/).filter(n => defR.indexOf(n) === -1);
const callL = where(/if\(name==='trends'\)loadTrendsResults\(\)/);
const btn = where(/<button class="tab" onclick="sw\('trends'\)">Trends<\/button>/);
const sec = where(/<div id="sec-trends" class="sec">/);
ok('found <style> blocks to check against', styleRanges.length > 0);
ok('renderTrendsResults defined exactly once, outside <style>', defR.length === 1 && !insideStyle(defR[0]), defR.join(','));
ok('loadTrendsResults defined exactly once, outside <style>', defL.length === 1 && !insideStyle(defL[0]), defL.join(','));
ok('loadTrendsResults CALLS renderTrendsResults(d)', callR.length === 1 && callR[0] > defL[0] && callR[0] < defR[0], callR.join(','));
ok('sw() calls loadTrendsResults for the trends tab, outside <style>', callL.length === 1 && !insideStyle(callL[0]));
ok('a Trends tab button exists (next to Backtest)', btn.length === 1
  && /sw\('backtest'\)/.test(lines[btn[0] - 2] || ''), btn.join(','));
ok('a sec-trends section exists with the trends-body mount point', sec.length === 1 && html.includes('id="trends-body"'));
ok('the tab fetches /api/trends/results', /fetch\('\/api\/trends\/results'\)/.test(html));
// The two card renderers must not have gained a trends reference.
for (const fn of ['renderGameGrid', 'renderMatchupGame']) {
  const i = html.indexOf('function ' + fn + '(');
  const j = html.indexOf('\nfunction ', i + 10);
  const body = html.slice(i, j === -1 ? undefined : j);
  ok(fn + ' does not reference trends', i !== -1 && !/trend/i.test(body));
}

// ---------------------------------------------------------------- b
console.log('\nb. GET /api/trends/results reads the artifact and nothing else');
const routeSrc = read('routes/trends-results.js');
const code = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]).sort();
// 2026-09-30: the router also serves GET /trends/slate (the slate-fit column), which needs game_log.
ok('requires exactly: express, fs, path, the slate service, better-sqlite3 and db/schema (for its path)',
  JSON.stringify(requires) === JSON.stringify(['../db/schema', '../services/trends-slate', 'better-sqlite3', 'express', 'fs', 'path']), requires.join(','));
ok('points at docs/trends-results-2026-09-29.json',
  /path\.join\(__dirname,\s*'\.\.',\s*'docs',\s*'trends-results-2026-09-29\.json'\)/.test(code));
const resultsHandler = (code.match(/router\.get\('\/trends\/results'[\s\S]*?\n\}\);/) || [''])[0];
ok('GET /trends/results still reads only the artifact (no database, settings, model or computation)',
  resultsHandler.length > 0 && /load\(\)/.test(resultsHandler)
  && !/readDb|slateFits|\bdb\b|better-sqlite3|getSettings|runModel|getSignals|trends-backtest|processGameSignals/.test(resultsHandler));
ok('the slate database handle is READ-ONLY', /new Database\(require\('\.\.\/db\/schema'\)\.DB_PATH,\s*\{\s*readonly:\s*true,\s*fileMustExist:\s*true\s*\}\)/.test(code)
  && (code.match(/new Database\(/g) || []).length === 1);
ok('nothing from the pricing path is named in the route',
  !/getSettings|runModel|getSignals|processGameSignals|pythag|services\/model|services\/jobs|routes\/api/.test(code));
ok('defines exactly three routes: GET /trends/results, /trends/top-traders and /trends/slate',
  (code.match(/router\.(get|post|put|patch|delete|use)\(/g) || []).length === 3
  && /router\.get\('\/trends\/results'/.test(code) && /router\.get\('\/trends\/top-traders'/.test(code) && /router\.get\('\/trends\/slate'/.test(code));
const serverSrc = read('server.js');
ok('server.js mounts it under /api', /app\.use\('\/api',\s*require\('\.\/routes\/trends-results'\)\)/.test(serverSrc));
ok('routes/api.js does not reference trends', !/trends/i.test(read('routes/api.js')));

// Behaviour: the real artifact, a missing file, and a corrupt file.
function loadRouteWith(artifactExpr) {
  const src = routeSrc.replace("path.join(__dirname, '..', 'docs', 'trends-results-2026-09-29.json')", artifactExpr);
  const fname = path.join(R, 'routes', '__trends_results_probe.js');
  const m = new Module(fname, module);
  m.filename = fname; m.paths = Module._nodeModulePaths(path.dirname(fname));
  m._compile(src, fname);
  return m.exports;
}
function call(router) {
  const layer = router.stack.find(l => l.route && l.route.path === '/trends/results');
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  layer.route.stack[0].handle({}, res);
  return res;
}
const real = call(require(path.join(R, 'routes/trends-results')));
ok('real artifact: 200 with 192 trend_results rows', real.code === 200 && real.body.trend_results.length === 192);
const missing = call(loadRouteWith(JSON.stringify(path.join(os.tmpdir(), '__no_such_trends_artifact__.json'))));
ok('missing artifact: 503 with an error JSON, no throw', missing.code === 503 && /not found/.test(missing.body.detail || ''), missing.body.detail);
const bad = path.join(os.tmpdir(), '__corrupt_trends_artifact__.json');
fs.writeFileSync(bad, '{ not json');
const corrupt = call(loadRouteWith(JSON.stringify(bad)));
fs.unlinkSync(bad);
ok('corrupt artifact: 503 with an error JSON, no throw', corrupt.code === 503 && /unreadable/.test(corrupt.body.detail || ''), corrupt.body.detail);

// ---------------------------------------------------------------- c
console.log('\nc. the artifact is the pre-registered run, with both sides of one test');
const A = JSON.parse(read('docs/trends-results-2026-09-29.json'));
const pinned = (read('services/trends-backtest.js').match(/const PREREG_SHA256 = '([0-9a-f]{64})'/) || [])[1];
ok('prereg_sha256 matches the hash pinned in services/trends-backtest.js', !!pinned && A.prereg_sha256 === pinned, (pinned || '').slice(0, 12));
ok('trend_run carries the same hash and commit', A.trend_run && A.trend_run.prereg_sha256 === pinned && A.trend_run.prereg_commit === A.prereg_commit);
const want = Array.from({ length: 31 }, (_, i) => 'S' + String(i + 1).padStart(2, '0'));
const inPrim = A.trend_results.filter(r => r.variant === 'primary' && r.split === 'in');
ok('scenario IDs are exactly S01-S31', JSON.stringify(inPrim.map(r => r.scenario_id).sort()) === JSON.stringify(want)
  && JSON.stringify([...new Set(A.trend_results.map(r => r.scenario_id))].sort()) === JSON.stringify(want));
const os_ = {}; (A.other_side && A.other_side.rows || []).forEach(o => { os_[o.scenario_id] = o; });
ok('every scenario has an other-side block', want.every(id => os_[id]) && A.other_side.rows.length === 31);
ok('the other side is labelled derived, not separately pre-registered', /NOT SEPARATELY PRE-REGISTERED/.test(A.other_side.note || ''));
let maxDp = 0, maxDi = 0, sameN = true;
for (const r of inPrim) {
  const o = os_[r.scenario_id];
  maxDp = Math.max(maxDp, Math.abs(o.p_value - r.p_value));
  maxDi = Math.max(maxDi, Math.abs(o.implied_pct - (1 - r.implied_pct)));
  if (o.n !== r.n) sameN = false;
}
ok('every other-side p equals the original within 1e-12', maxDp <= 1e-12, 'max ' + maxDp.toExponential(2));
ok('every other-side implied = 1 - original within 1e-9', maxDi <= 1e-9, 'max ' + maxDi.toExponential(2));
ok('each other side covers the same n', sameN);

// ---------------------------------------------------------------- d
console.log('\nd. structural isolation of the pricing path');
const { stripJsComments } = require(path.join(R, 'services/harness-inputs'));
const PRICING_ROOTS = ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js'];
// A require that RESOLVES to one of these is a violation wherever it is
// written from (a require('./trends/scenarios') inside utils/ never contains
// the text "utils/trends/" -- the self-test below plants exactly that).
const FORBIDDEN_TARGET = /^(utils\/trends\/.+|services\/trends-backtest\.js|services\/trends-slate\.js|routes\/trends-results\.js|scripts\/(run|export)-trends-[\w-]+\.js)$/;
// And code (comments stripped) that names the artifact or the modules.
const FORBIDDEN_TEXT = /trends-results-2026-09-29\.json|polymarket-top-traders-results|trends-backtest|trends-slate|trends-results|utils\/trends\//;
// fsLike: { exists(abs), read(abs) } -- the real filesystem, or a planted one.
function isolationViolations(roots, fsLike, root) {
  const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
  const seen = new Set(), stack = roots.map(r => path.join(root, r)), bad = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const code = stripJsComments(fsLike.read(f));
    const t = code.match(FORBIDDEN_TEXT);
    if (t) bad.push(rel(f) + ' names ' + t[0]);
    for (const x of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const p = path.resolve(path.dirname(f), x[1]);
      const hit = [p, p + '.js', path.join(p, 'index.js')].find(c => fsLike.exists(c));
      if (!hit) continue;
      if (FORBIDDEN_TARGET.test(rel(hit))) bad.push(rel(f) + ' requires ' + rel(hit));
      else stack.push(hit);
    }
  }
  return { files: seen, bad };
}
const realFs = { exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(), read: (p) => fs.readFileSync(p, 'utf8') };
const iso = isolationViolations(PRICING_ROOTS, realFs, R);
ok('the pricing graph is non-trivial (sanity: the walk ran)', iso.files.size > 20, iso.files.size + ' files');
ok('routes/api.js is inside that graph (why the route has its own router)', iso.files.has(path.join(R, 'routes/api.js')));
ok('no file in the pricing graph references the trends modules, router or artifact', iso.bad.length === 0, iso.bad.join(' | ') || 'none');

// Self-test: the same function, on a planted graph, must catch the violation.
const planted = {
  [path.join(R, 'services/model.js')]: "const x = require('./helper');",
  [path.join(R, 'services/helper.js')]: "const t = require('../utils/deep');",
  [path.join(R, 'utils/deep.js')]: "const s = require('./trends/scenarios');",
  [path.join(R, 'utils/trends/scenarios.js')]: '',
};
const plantedFs = { exists: (p) => Object.prototype.hasOwnProperty.call(planted, p), read: (p) => planted[p] };
const caught = isolationViolations(['services/model.js'], plantedFs, R);
ok('SELF-TEST: a relative trends require two hops deep is caught',
  caught.bad.length === 1 && caught.bad[0] === 'utils/deep.js requires utils/trends/scenarios.js', caught.bad.join(' | '));
planted[path.join(R, 'services/helper.js')] = "// require('../utils/trends/scenarios') -- a comment, not a dependency\nconst t = require('../utils/deep');";
planted[path.join(R, 'utils/deep.js')] = "const a = 'docs/trends-results-2026-09-29.json';";
const caught2 = isolationViolations(['services/model.js'], plantedFs, R);
ok('SELF-TEST: the artifact named in code is caught; the same words in a comment are not',
  caught2.bad.length === 1 && /^utils\/deep\.js names trends-results/.test(caught2.bad[0]), caught2.bad.join(' | '));
planted[path.join(R, 'utils/deep.js')] = "const s = require('./other');";
planted[path.join(R, 'utils/other.js')] = '';
const clean = isolationViolations(['services/model.js'], plantedFs, R);
ok('SELF-TEST: the same graph without either passes', clean.bad.length === 0 && clean.files.size === 4);
// The other direction (2026-09-30): the route's own require graph -- now
// including services/trends-slate.js and db/schema -- reaches nothing in the
// pricing path.
function requireGraph(roots, fsLike, root) {
  const seen = new Set(), stack = roots.map(r => path.join(root, r));
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
  return new Set([...seen].map(f => path.relative(root, f).replace(/\\/g, '/')));
}
const routeGraph = requireGraph(['routes/trends-results.js'], realFs, R);
const pricingFiles = ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js', 'routes/api.js'];
ok('the route graph includes the slate service and the shared context (sanity)',
  routeGraph.has('services/trends-slate.js') && routeGraph.has('utils/trends/context.js'), routeGraph.size + ' files');
ok('the route graph reaches nothing in the pricing path (model, pythag, jobs/getSettings/processGameSignals, routes/api)',
  pricingFiles.every(f => !routeGraph.has(f)), pricingFiles.filter(f => routeGraph.has(f)).join(',') || 'none');
const slateGraph = requireGraph(['services/trends-slate.js'], realFs, R);
ok('services/trends-slate.js imports no database module and nothing from the pricing path',
  !slateGraph.has('db/schema.js') && pricingFiles.every(f => !slateGraph.has(f)), [...slateGraph].join(','));

// ---------------------------------------------------------------- e
console.log('\ne. sorting is wired in and defaults to ID order');
{
  const vm = require('vm');
  const a = html.indexOf('let _trendsLoaded = false;'), b = html.indexOf('// --- Pitcher IP projections UI ---');
  ok('the trends block is found', a > 0 && b > a);
  const block = html.slice(a, b);
  ok('header cells call trendsSortBy (16 sortable columns, incl. "Fits the slate")',
    (block.match(/thS\('[a-z_]+', '/g) || []).length === 16 && /function trendsSortBy\(col\)/.test(block) && /onclick="trendsSortBy\(/.test(block));
  ok('default sort is ID ascending', /let _trendsSort = \{ col: 'id', dir: 1 \};/.test(block));
  const ctx = vm.createContext({ document: { getElementById: () => null }, fetch: async () => ({}), console });
  vm.runInContext(block, ctx);
  const A2 = JSON.parse(read('docs/trends-results-2026-09-29.json'));
  const render = () => vm.runInContext('renderTrendsResults(__d)', Object.assign(ctx, { __d: A2 }));
  const order = (h) => [...h.matchAll(/<tr><td style="[^"]*">(S\d\d)<\/td>/g)].map(m => m[1]);
  const inP = Object.fromEntries(A2.trend_results.filter(r => r.variant === 'primary' && r.split === 'in').map(r => [r.scenario_id, r]));
  const h0 = render();
  ok('rendered with no click: rows in ID order S01..S31', JSON.stringify(order(h0)) === JSON.stringify(want), order(h0).slice(0, 5).join(','));
  ok('the ID header carries the sort arrow by default', /ID ▲<\/th>/.test(h0));
  const smallLast = (ids) => { const f = ids.findIndex(id => inP[id].n < 30); return f === -1 || ids.slice(f).every(id => inP[id].n < 30); };
  vm.runInContext("trendsSortBy('n')", ctx);
  const hN = render(), oN = order(hN), big = oN.filter(id => inP[id].n >= 30);
  ok('click n: ascending numerically, "too small to read" rows last',
    big.every((id, i) => i === 0 || inP[big[i - 1]].n <= inP[id].n) && smallLast(oN) && /n ▲<\/th>/.test(hN), oN.slice(0, 4).map(id => id + ':' + inP[id].n).join(' '));
  vm.runInContext("trendsSortBy('n')", ctx);
  const hN2 = render(), oN2 = order(hN2), big2 = oN2.filter(id => inP[id].n >= 30);
  ok('second click reverses; "too small" rows still last',
    big2.every((id, i) => i === 0 || inP[big2[i - 1]].n >= inP[id].n) && smallLast(oN2) && /n ▼<\/th>/.test(hN2));
  vm.runInContext("trendsSortBy('p')", ctx);
  const oP = order(render()), bigP = oP.filter(id => inP[id].n >= 30);
  ok('click p: numeric ascending (not text order)', bigP.every((id, i) => i === 0 || inP[bigP[i - 1]].p_value <= inP[id].p_value) && smallLast(oP));
  vm.runInContext("trendsSortBy('slate')", ctx);
  ok('slate column before the slate loads: every key blank -> all "last", kept in ID order', JSON.stringify(order(render())) === JSON.stringify(want));
  vm.runInContext("_trendsSlate = { date: '2026-09-30', postseason: true, scenarios: [{ id: 'S05', name: '', fits: [{ game: 'A@B', team: 'B', status: 'fit', notes: [] }, { game: 'C@D', team: 'D', status: 'provisional', notes: [] }], noReliablePrice: [], noPrice: [], pendingLock: [] }].concat(" + JSON.stringify(want.filter(x => x !== 'S05')) + ".map(id => ({ id, name: '', fits: [], noReliablePrice: [], noPrice: [], pendingLock: [] }))) };", ctx);
  vm.runInContext("_trendsSort = { col: 'slate', dir: -1 };", ctx);
  const hS = render(), oS = order(hS);
  ok('click "Fits the slate" (descending): the scenario with fits first, with its labelled cell',
    oS[0] === 'S05' && /A@B \(B\)/.test(hS) && /C@D \(D\) <span[^>]*>provisional — price not locked<\/span>/.test(hS));
  ok('slate date and the interest-only line are shown above the table',
    /Fits the slate: 2026-09-30 \(PT\)/.test(hS) && /Fits are for interest only\. No trend passed the test\./.test(hS));
  ok('neutral styling: no colour classes or highlight in the sortable header', !/background:|color:(?!var\(--text2\))/.test((hS.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0].replace(/color:var\(--text\)/g, '')));
}

// ---------------------------------------------------------------- f
console.log('\nf. the slate route uses the scenario tests and the SHARED context (no copy)');
{
  const slateSrc = stripJsComments(read('services/trends-slate.js'));
  const btSrc = stripJsComments(read('services/trends-backtest.js'));
  ok('trends-slate requires utils/trends/scenarios and utils/trends/context',
    /require\('\.\.\/utils\/trends\/scenarios'\)/.test(slateSrc) && /require\('\.\.\/utils\/trends\/context'\)/.test(slateSrc));
  ok('trends-slate calls the shared teamContexts / teamGameContext / gameTotalsContext and the scenario predicates (s.test)',
    /CX\.teamContexts\(/.test(slateSrc) && /CX\.teamGameContext\(/.test(slateSrc) && /CX\.gameTotalsContext\(/.test(slateSrc) && /s\.test\(/.test(slateSrc));
  ok('the backtest calls the same shared functions', /teamContexts\(/.test(btSrc) && /teamGameContext\(/.test(btSrc) && /gameTotalsContext\(/.test(btSrc));
  // The context logic exists once: its distinctive lines appear only in utils/trends/context.js.
  const dirs = ['services', 'utils', 'routes', 'scripts'];
  const owners = [];
  for (const d of dirs) for (const f of fs.readdirSync(path.join(R, d), { recursive: true })) {
    const rel = (d + '/' + String(f)).replace(/\\/g, '/');
    if (!/\.js$/.test(rel) || /^scripts\/test-/.test(rel)) continue;
    const src = stripJsComments(fs.readFileSync(path.join(R, rel), 'utf8'));
    if (/lossStreak\+\+/.test(src) || /seriesLast: i === list\.length - 1/.test(src)) owners.push(rel);
  }
  ok('the streak / series logic is defined in exactly one file: utils/trends/context.js', JSON.stringify(owners) === JSON.stringify(['utils/trends/context.js']), owners.join(','));
  ok('the slate does not use the backtest\'s date window (WINDOW_FROM / inPopulation)', !/WINDOW_FROM|inPopulation/.test(slateSrc));
}

// ---------------------------------------------------------------- g
console.log('\ng. a synthetic slate');
{
  const Database = require(path.join(R, 'node_modules/better-sqlite3'));
  const sl = require(path.join(R, 'services/trends-slate'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE game_log (game_date TEXT, game_id TEXT, away_team TEXT, home_team TEXT, away_score INTEGER, home_score INTEGER,
    market_away_ml INTEGER, market_home_ml INTEGER, ml_source TEXT, odds_locked_at TEXT, market_contamination_reason TEXT,
    odds_flagged INTEGER DEFAULT 0, odds_flag_reason TEXT, first_pitch_utc TEXT, scheduled_start_utc TEXT,
    is_opener_game_away INTEGER DEFAULT 0, is_opener_game_home INTEGER DEFAULT 0, is_removed INTEGER DEFAULT 0);
    CREATE TABLE empirical_market_captures (game_date TEXT, game_id TEXT, market_type TEXT, capture_track TEXT,
    away_price_ml INTEGER, home_price_ml INTEGER, generated_at TEXT);`);
  const G = (o) => db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, away_score, home_score, market_away_ml,
    market_home_ml, ml_source, odds_locked_at, market_contamination_reason, odds_flagged, odds_flag_reason, scheduled_start_utc)
    VALUES (@d, @id, @a, @h, @as, @hs, @am, @hm, 'kalshi', @lock, NULL, @flag, @why, @start)`).run(Object.assign(
      { as: null, hs: null, am: null, hm: null, lock: null, flag: 0, why: null, start: null }, o));
  // P games (2026-09-29: postseason, OUTSIDE the backtest's 04-09..09-27 window), locked and priced.
  G({ d: '2026-09-29', id: 'bos-nyy', a: 'BOS', h: 'NYY', as: 3, hs: 0, am: -140, hm: 120, lock: '2026-09-29 23:00:00', start: '2026-09-29T23:08:00Z' });
  G({ d: '2026-09-29', id: 'cws-hou', a: 'CWS', h: 'HOU', as: 2, hs: 4, am: 150, hm: -170, lock: '2026-09-29 23:00:00', start: '2026-09-29T23:10:00Z' });
  G({ d: '2026-09-29', id: 'chc-sd', a: 'CHC', h: 'SD', as: 5, hs: 1, am: 110, hm: -130, lock: '2026-09-29 23:00:00', start: '2026-09-29T23:10:00Z' });
  G({ d: '2026-09-29', id: 'phi-atl', a: 'PHI', h: 'ATL', as: 1, hs: 2, am: 120, hm: -140, lock: '2026-09-29 23:00:00', start: '2026-09-29T23:10:00Z' });
  G({ d: '2026-09-29', id: 'tb-min', a: 'TB', h: 'MIN', as: 4, hs: 3, am: -110, hm: -110, lock: '2026-09-29 23:00:00', start: '2026-09-29T23:10:00Z' });
  // Slate 2026-09-30
  G({ d: '2026-09-30', id: 'bos-nyy', a: 'BOS', h: 'NYY', am: -150, hm: 130, lock: '2026-09-30 22:50:00', start: '2026-09-30T23:08:00Z' });  // NYY home dog again; NYY shut out in P
  G({ d: '2026-09-30', id: 'cws-hou', a: 'CWS', h: 'HOU', am: 190, hm: -230, start: '2026-09-30T23:10:00Z' });                                // not locked: CWS big dog -> provisional
  G({ d: '2026-09-30', id: 'chc-sd', a: 'CHC', h: 'SD', am: 200, hm: -240, flag: 1, why: 'single-source, no cross-check available', start: '2026-09-30T23:10:00Z' });
  G({ d: '2026-09-30', id: 'phi-atl', a: 'PHI', h: 'ATL', am: 130, hm: -150, lock: '2026-09-30 22:50:00', start: '2026-09-30T23:10:00Z' });   // ATL home fav, no next game
  G({ d: '2026-09-30', id: 'tb-min', a: 'TB', h: 'MIN', start: '2026-09-30T23:10:00Z' });                                                       // no price yet
  db.prepare("INSERT INTO empirical_market_captures VALUES ('2026-09-30', 'phi-atl', 'ml', 'morning', 105, -120, '2026-09-30 07:30:39')").run();
  // A regular-season date for the no-note contrast.
  G({ d: '2026-09-26', id: 'ari-sd', a: 'ARI', h: 'SD', as: 0, hs: 6, am: 120, hm: -140, lock: '2026-09-26 22:00:00', start: '2026-09-26T22:10:00Z' });
  G({ d: '2026-09-27', id: 'ari-sd', a: 'ARI', h: 'SD', am: 125, hm: -145, lock: '2026-09-27 22:00:00', start: '2026-09-27T22:10:00Z' });
  const s = sl.slateFits(db, '2026-09-30');
  const sc = Object.fromEntries(s.scenarios.map(x => [x.id, x]));
  const fit = (id, game, team) => sc[id].fits.find(f => f.game === game && f.team === team);
  ok('31 scenarios, 5 slate games, flagged postseason', s.scenarios.length === 31 && s.games === 5 && s.postseason === true);
  ok('known fit: S13 After being shut out -> BOS@NYY (NYY)', !!fit('S13', 'BOS@NYY', 'NYY') && fit('S13', 'BOS@NYY', 'NYY').status === 'fit');
  ok('S01 Home dog again matches NYY with its previous game (09-29) OUTSIDE the backtest window',
    !!fit('S01', 'BOS@NYY', 'NYY') && fit('S01', 'BOS@NYY', 'NYY').status === 'fit', JSON.stringify(fit('S01', 'BOS@NYY', 'NYY')));
  ok('the live "previous game priced" rule is the population rule without the window', /without its 2026-04-09\.\.2026-09-27 window/.test(s.rules.previous_game_priced)
    && sl.livePriced({ market_away_ml: 1, market_home_ml: 1, odds_locked_at: 'x', market_contamination_reason: null })
    && !sl.livePriced({ market_away_ml: 1, market_home_ml: 1, odds_locked_at: null, market_contamination_reason: null })
    && !sl.livePriced({ market_away_ml: 1, market_home_ml: 1, odds_locked_at: 'x', market_contamination_reason: 'priced_post_first_pitch' }));
  ok('provisional: S10 Big dog on an unlocked game -> CWS@HOU (CWS) provisional', fit('S10', 'CWS@HOU', 'CWS') && fit('S10', 'CWS@HOU', 'CWS').status === 'provisional');
  ok('no reliable price: the odds-flagged (single-source) game is listed, not classified',
    sc.S10.noReliablePrice.includes('CHC@SD') && !sc.S10.fits.some(f => f.game === 'CHC@SD'));
  ok('no price yet: a game with no stored moneyline is listed, not classified', sc.S10.noPrice.includes('TB@MIN') && !sc.S10.fits.some(f => f.game === 'TB@MIN'));
  ok('S23 unknown: ATL home favourite with no next game in game_log', fit('S23', 'PHI@ATL', 'ATL') && fit('S23', 'PHI@ATL', 'ATL').status === 'unknown');
  ok('S25/S26 pending lock on the unlocked game', sc.S25.pendingLock.includes('CWS@HOU') && sc.S26.pendingLock.includes('CWS@HOU'));
  ok('S25 fires on a locked game whose line moved toward the team (open -120 -> lock -150 for ATL)', !!fit('S25', 'PHI@ATL', 'ATL'));
  ok('postseason: every fit carries "tested on regular season only"',
    s.scenarios.every(x => x.fits.every(f => (f.notes || []).includes('tested on regular season only'))) && s.scenarios.some(x => x.fits.length));
  // "No reliable price" only for MONEYLINE problems (2026-09-30).
  const F = (o) => db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, market_away_ml, market_home_ml, ml_source,
    odds_locked_at, odds_flagged, odds_flag_reason, scheduled_start_utc) VALUES ('2026-09-25', @id, @a, @h, 200, -240, 'kalshi',
    '2026-09-25 22:50:00', 1, @why, '2026-09-25T23:10:00Z')`).run(o);
  F({ id: 'sea-laa', a: 'SEA', h: 'LAA', why: 'single-source total, no cross-check available' });                       // totals only
  F({ id: 'mil-stl', a: 'MIL', h: 'STL', why: 'totals divergence: primary=null@null/null, fanduel=8.5@-110/-110 (Δp=1.496)' });   // totals only (historical text)
  F({ id: 'kc-det', a: 'KC', h: 'DET', why: 'single-source, no cross-check available | single-source total, no cross-check available' });  // moneyline
  F({ id: 'cin-pit', a: 'CIN', h: 'PIT', why: 'kalshi start-time mismatch for cin-pit: source 19:05 vs schedule 13:05' });         // unattributable
  F({ id: 'tex-sea', a: 'TEX', h: 'SEA', why: null });                                                                              // flagged, no reason text
  const fl = Object.fromEntries(sl.slateFits(db, '2026-09-25').scenarios.map(x => [x.id, x]));
  const s10 = (game) => fl.S10.fits.find(f => f.game === game && f.team === game.split('@')[0]);
  ok('a totals-only flag does not block a moneyline fit (single-source TOTAL -> SEA big dog classified)', !!s10('SEA@LAA') && !fl.S10.noReliablePrice.includes('SEA@LAA'));
  ok('a historical totals-divergence flag does not block either', !!s10('MIL@STL') && !fl.S10.noReliablePrice.includes('MIL@STL'));
  ok('a single-source MONEYLINE still shows "no reliable price" (even alongside a totals flag)', fl.S10.noReliablePrice.includes('KC@DET') && !s10('KC@DET'));
  ok('an unattributable flag (double-header start-time guard) still blocks', fl.S10.noReliablePrice.includes('CIN@PIT') && !s10('CIN@PIT'));
  ok('a flag with no reason text still blocks', fl.S10.noReliablePrice.includes('TEX@SEA') && !s10('TEX@SEA'));
  ok('flag attribution table: every rule names its source, and the classes are as stated',
    sl.FLAG_RULES.every(r => /\.js:\d/.test(r.src))
    && sl.classifyFlagFragment('impossible line pair: both sides positive (+120 / +105)') === 'moneyline'
    && sl.classifyFlagFragment('extreme line: home at -450 (implied p=0.818)') === 'moneyline'
    && sl.classifyFlagFragment('Kalshi vs polymarket disagree on favorite: Kalshi favors home (-130) polymarket favors away (-125)') === 'moneyline'
    && sl.classifyFlagFragment('no sane odds') === 'moneyline'
    && sl.classifyFlagFragment('no sane totals: no source provided matching-line O/U') === 'totals'
    && sl.classifyFlagFragment('totals juice divergence: polymarket=-110/-110, fanduel=-130/+105 (Δp=0.09)') === 'totals'
    && sl.classifyFlagFragment('no primary totals; Totals signal SUPPRESSED (xcheck reference-only)') === 'totals'
    && sl.classifyFlagFragment('polymarket start-time mismatch for x') === 'unattributed');
  ok('contamination alone still blocks', sl.moneylineUnreliable({ odds_flagged: 0, market_contamination_reason: 'priced_post_first_pitch' }));
  const reg = sl.slateFits(db, '2026-09-27');
  const regFit = reg.scenarios.find(x => x.id === 'S13').fits.find(f => f.game === 'ARI@SD');
  ok('regular season: a fit carries no postseason note', !!regFit && regFit.notes.length === 0 && reg.postseason === false);
  // The route itself, on the throwaway database (empty game_log).
  const router = require(path.join(R, 'routes/trends-results'));
  const layer = router.stack.find(l => l.route && l.route.path === '/trends/slate');
  const callSlate = (q) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; layer.route.stack[0].handle({ query: q }, res); return res; };
  const r1 = callSlate({ date: '2026-09-30' }), r2 = callSlate({ date: '2026-09-30' }), r3 = callSlate({ date: 'yesterday' });
  ok('GET /trends/slate: 200 with 31 scenarios and the interest-only note; cached on a repeat; bad date 400',
    r1.code === 200 && r1.body.scenarios.length === 31 && r1.body.note === 'Fits are for interest only. No trend passed the test.'
    && r1.body.cached === false && r2.body.cached === true && r3.code === 400, JSON.stringify({ c: r1.code, ms: r1.body.compute_ms }));
  router._closeSlateDb();
}

// ---------------------------------------------------------------- h
console.log('\nh. the backtest still reproduces the committed artifact exactly (context refactor)');
{
  // (2026-10-02, #486) Reproduced from the PINNED pre-#486 copy, read-only: the
  // artifact was computed before the game_log repair, so a refreshed
  // data/mlb.db must not be what reproduces it. Absent -> a NOTE, not a failure.
  const realDb = path.resolve(R, 'data/mlb.db');
  const PRE486 = path.join(R, 'data/mlb-before-486.db');
  if (!fs.existsSync(PRE486)) {
    console.log('  NOTE  pre-#486 copy not present (data/mlb-before-486.db): reproduction skipped, not failed');
  } else if (path.resolve(PRE486) === realDb) {
    ok('refuses the live data/mlb.db (only the pinned pre-#486 copy reproduces the artifact)', false, PRE486);
  } else {
    const Database = require(path.join(R, 'node_modules/better-sqlite3'));
    const tb = require(path.join(R, 'services/trends-backtest'));
    const sdb = new Database(PRE486, { readonly: true, fileMustExist: true });
    const run = tb.runTrendsBacktest(sdb, { root: R });
    sdb.close();
    const A3 = JSON.parse(read('docs/trends-results-2026-09-29.json'));
    const art = new Map(A3.trend_results.map(r => [r.scenario_id + '|' + r.variant + '|' + r.split, r]));
    const map = { n: 'n', W: 'w', L: 'l', P: 'pushes', winPct: 'win_pct', winLo: 'win_lo', winHi: 'win_hi', implied: 'implied_pct', edge: 'edge',
      pValue: 'p_value', roi: 'roi', roiLo: 'roi_lo', roiHi: 'roi_hi', dollars: 'dollars', bothTeamsGames: 'both_teams_games' };
    let fields = 0; const bad2 = [];
    for (const r of run.results) {
      const a2 = art.get(r.scenario + '|' + r.variant + '|' + r.split);
      if (!a2) { bad2.push('missing ' + r.scenario + '|' + r.variant + '|' + r.split); continue; }
      for (const [k, ak] of Object.entries(map)) { fields++; if (!Object.is(r[k], a2[ak])) bad2.push(r.scenario + '|' + r.variant + '|' + r.split + ' ' + k + ' ' + r[k] + ' vs ' + a2[ak]); }
      fields++; if (!Object.is(r.qValue != null ? r.qValue : null, a2.q_value)) bad2.push(r.scenario + ' q');
      fields++; if ((r.tooSmall ? 1 : 0) !== a2.too_small) bad2.push(r.scenario + ' tooSmall');
      fields++; if ((r.holdout || null) !== a2.holdout) bad2.push(r.scenario + ' holdout');
      fields++; if (JSON.stringify(r.mix) !== a2.source_mix_json) bad2.push(r.scenario + ' mix');
    }
    ok('every result row and figure matches docs/trends-results-2026-09-29.json exactly (pinned pre-#486 copy, read-only)',
      bad2.length === 0 && run.results.length === A3.trend_results.length, run.results.length + ' rows, ' + fields + ' fields' + (bad2.length ? ' | ' + bad2.slice(0, 5).join(' | ') : ''));
  }
}

// ---------------------------------------------------------------- i
console.log('\ni. the Polymarket top-traders section (2026-10-01; corrected beside the original since 2026-10-01, #498)');
{
  const vm = require('vm');
  const ORIG_FILE = 'docs/polymarket-top-traders-results-2026-09-30.json', CORR_FILE = 'docs/polymarket-top-traders-results-2026-09-30-corrected.json';
  const TO = JSON.parse(read(ORIG_FILE)), TC = JSON.parse(read(CORR_FILE));
  // wired in
  const defS = where(/function\s+renderTopTradersSection\s*\(/), defLT = where(/async function\s+loadTopTradersSection\s*\(/);
  ok('renderTopTradersSection and loadTopTradersSection each defined once, outside <style>',
    defS.length === 1 && defLT.length === 1 && !insideStyle(defS[0]) && !insideStyle(defLT[0]));
  ok('loadTrendsResults calls loadTopTradersSection; it fetches /api/trends/top-traders and renders the section',
    /async function loadTrendsResults\(\)\{[\s\S]*?loadTopTradersSection\(\);[\s\S]*?\n\}/.test(html)
    && /fetch\('\/api\/trends\/top-traders'\)/.test(html) && /renderTopTradersSection\(d\)/.test(html));
  const secStart = html.indexOf('<div id="sec-trends" class="sec">');
  const iBody = html.indexOf('id="trends-body"', secStart), iTT = html.indexOf('id="trends-tt-body"', secStart);
  ok('its mount point sits in the Trends section, below the 31-scenario table', secStart > 0 && iBody > secStart && iTT > iBody && iTT - iBody < 400);

  // (c) the route reads only the two artifacts; either missing or unreadable -> the error JSON
  const ttHandler = (code.match(/router\.get\('\/trends\/top-traders'[\s\S]*?\n\}\);/) || [''])[0];
  const ORIG_EXPR = "path.join(__dirname, '..', 'docs', 'polymarket-top-traders-results-2026-09-30.json')";
  const CORR_EXPR = "path.join(__dirname, '..', 'docs', 'polymarket-top-traders-results-2026-09-30-corrected.json')";
  const docsNamed = [...code.matchAll(/path\.join\(__dirname,\s*'\.\.',\s*'docs',\s*'([^']+)'\)/g)].map(m => m[1]).sort();
  ok('the route names exactly three docs files: the trends artifact and the two top-traders artifacts',
    JSON.stringify(docsNamed) === JSON.stringify(['polymarket-top-traders-results-2026-09-30-corrected.json', 'polymarket-top-traders-results-2026-09-30.json', 'trends-results-2026-09-29.json']),
    docsNamed.join(','));
  ok('GET /trends/top-traders reads only the two cached artifacts (no database, settings, model or computation)',
    /loadTopTradersCorrected\(\)/.test(ttHandler) && /loadTopTraders\(\)/.test(ttHandler)
    && !/readDb|slateFits|\bdb\b|better-sqlite3|getSettings|runModel|getSignals|processGameSignals|readFileSync/.test(ttHandler)
    && code.includes(ORIG_EXPR) && code.includes(CORR_EXPR));
  const callTT = (router) => { const l = router.stack.find(x => x.route && x.route.path === '/trends/top-traders');
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; l.route.stack[0].handle({}, res); return res; };
  const realTT = callTT(require(path.join(R, 'routes/trends-results')));
  ok('real artifacts: 200 with { corrected, original }, each exactly its file',
    realTT.code === 200 && JSON.stringify(Object.keys(realTT.body).sort()) === '["corrected","original"]'
    && JSON.stringify(realTT.body.corrected) === JSON.stringify(TC) && JSON.stringify(realTT.body.original) === JSON.stringify(TO));
  const loadTTWith = (origExpr, corrExpr) => {
    const src = routeSrc.replace(ORIG_EXPR, origExpr).replace(CORR_EXPR, corrExpr);
    const fname = path.join(R, 'routes', '__tt_results_probe.js');
    const m = new Module(fname, module); m.filename = fname; m.paths = Module._nodeModulePaths(path.dirname(fname)); m._compile(src, fname);
    return m.exports;
  };
  const NO = JSON.stringify(path.join(os.tmpdir(), '__no_such_tt_artifact__.json'));
  const badTT = path.join(os.tmpdir(), '__corrupt_tt_artifact__.json'); fs.writeFileSync(badTT, '{ nope');
  const missC = callTT(loadTTWith(ORIG_EXPR, NO)), missO = callTT(loadTTWith(NO, CORR_EXPR));
  const corC = callTT(loadTTWith(ORIG_EXPR, JSON.stringify(badTT))), corO = callTT(loadTTWith(JSON.stringify(badTT), CORR_EXPR));
  fs.unlinkSync(badTT);
  ok('corrected artifact missing / corrupt: 503 with an error JSON naming it, no throw',
    missC.code === 503 && /not found/.test(missC.body.detail) && /corrected/.test(missC.body.error)
    && corC.code === 503 && /unreadable/.test(corC.body.detail) && /corrected/.test(corC.body.error), missC.body.error + ' | ' + corC.body.error);
  ok('original artifact missing / corrupt: 503 with an error JSON naming it, no throw',
    missO.code === 503 && /not found/.test(missO.body.detail) && /original/.test(missO.body.error)
    && corO.code === 503 && /unreadable/.test(corO.body.detail) && /original/.test(corO.body.error), missO.body.error + ' | ' + corO.body.error);

  // both artifacts are the pinned pre-registration
  const pinnedTT = (read('services/polymarket-top-traders-backtest.js').match(/const PREREG_SHA256 = '([0-9a-f]{64})'/) || [])[1];
  const docHash = require('crypto').createHash('sha256').update(read(TC.prereg_path).replace(/\r\n/g, '\n')).digest('hex');
  ok('both artifacts carry the pre-registration hash pinned in the backtest code, equal to the document\'s own hash',
    !!pinnedTT && TC.prereg_sha256 === pinnedTT && TO.prereg_sha256 === pinnedTT && docHash === pinnedTT, (pinnedTT || '').slice(0, 12));

  // (a) render: main table + verdict = corrected; superseded table + its verdict = original
  const a = html.indexOf('let _trendsLoaded = false;'), b = html.indexOf('// --- Pitcher IP projections UI ---');
  const ctx = vm.createContext({ document: { getElementById: () => null }, fetch: async () => ({}), console });
  vm.runInContext(html.slice(a, b), ctx);
  const render = (d) => vm.runInContext('renderTopTradersSection(__tt)', Object.assign(ctx, { __tt: d }));
  const out = render({ corrected: TC, original: TO });
  const P = (v, dp) => (100 * v).toFixed(dp == null ? 1 : dp);
  const S = (v, dp) => (v >= 0 ? '+' : '−') + Math.abs(100 * v).toFixed(dp == null ? 1 : dp);
  const p3 = (v) => (v < 0.001 ? '<0.001' : v.toFixed(3));
  const M = (v) => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
  const rowCells = (key) => { const tr = (out.match(new RegExp('<tr data-tt="' + key + '">[\\s\\S]*?</tr>')) || [''])[0];
    return [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '')); };
  const want = (r) => [String(r.n), r.W + '–' + r.L, P(r.winPct) + '% [' + P(r.winLo, 0) + ', ' + P(r.winHi, 0) + ']', P(r.implied) + '%', S(r.edge),
    S(r.roi) + '% [' + S(r.roiLo, 0) + ', ' + S(r.roiHi, 0) + ']', M(r.dollars), p3(r.pValue)];
  const checkRows = (art, sets, prefix) => {
    let good = 0; const bad = [];
    for (const r of art.results.filter(x => x.sourceFilter === 'all' && sets.includes(x.set))) {
      const key = prefix + r.set + '-' + r.variant + '-' + r.split, cells = rowCells(key);
      if (JSON.stringify(cells.slice(2, 10)) === JSON.stringify(want(r))) good++; else bad.push(key + ' ' + JSON.stringify(cells.slice(2, 10)));
    }
    return { good, bad };
  };
  const mainC = checkRows(TC, ['main', 'confirmed'], ''), supO = checkRows(TO, ['main'], 'original-');
  ok('main table and sensitivity rows show exactly the CORRECTED artifact\'s figures', mainC.good === 8, mainC.bad.join(' | ') || '8 of 8 rows');
  ok('the superseded table shows exactly the ORIGINAL artifact\'s main figures', supO.good === 4, supO.bad.join(' | ') || '4 of 4 rows');
  ok('the superseded table has no sensitivity rows (it is the original main table)', !/data-tt="original-confirmed-/.test(out));
  const qIn = (art) => p3(art.results.find(x => x.set === 'main' && x.variant === 'primary' && x.split === 'in' && x.sourceFilter === 'all').qValue);
  const verdictText = (art) => 'No edge after correction (q = ' + qIn(art) + ' for both tests). No holdout label applies. Display only — not used by the model.';
  const vC = (out.match(/data-tt-verdict="corrected">([^<]*)</) || [])[1], vO = (out.match(/data-tt-verdict="original">([^<]*)</) || [])[1];
  ok('the verdict reads the corrected artifact\'s q values', vC === verdictText(TC) && qIn(TC) !== qIn(TO), vC);
  ok('the superseded table carries the original verdict as published', vO === verdictText(TO), vO);
  const cnote = (out.match(/data-tt-correction="1">([^<]*)</) || [])[1];
  const wantNote = 'Corrected: the first backfill dropped ' + TC.correction.store.trades_dropped_by_the_old_run.toLocaleString('en-US')
    + ' real trades (identical repeats). Restoring them (#' + TC.correction.data_fix.pr + ', #498) left the verdict unchanged.';
  ok('the correction note sits directly under the verdict and reads its count and fix PR from the corrected artifact',
    cnote === wantNote
    && /^<div[^>]*data-tt-correction="1">/.test(out.slice(out.indexOf('</div>', out.indexOf('data-tt-verdict="corrected">')) + 6)), cnote);
  const altered = JSON.parse(JSON.stringify(TC)); altered.multiple_comparisons.significant = ['primary'];
  ok('SELF-TEST: the note says "changed the verdict" when the two artifacts\' verdicts differ',
    /changed the verdict\./.test(render({ corrected: altered, original: TO })));
  ok('"Original result (superseded)" is a collapsed <details>, after the main table and before the sensitivity sub-section',
    /<details style="[^"]*" data-tt-superseded="1"><summary[^>]*>Original result \(superseded\)<\/summary>/.test(out)
    && !/data-tt-superseded="1"[^>]*\bopen\b/.test(out)
    && out.indexOf('data-tt="main-secondary-hold"') < out.indexOf('data-tt-superseded') && out.indexOf('data-tt-superseded') < out.indexOf('Sensitivity: games'));
  ok('pre-registration, windows and the #488 link come from the corrected artifact',
    out.includes(TC.prereg_commit.slice(0, 7)) && out.includes(TC.prereg_sha256) && out.includes(TC.window.in_sample) && out.includes(TC.window.holdout)
    && /issues\/488/.test(out) && /Polymarket top traders — pre-registered test/.test(out));
  // q only on the main in-sample rows, in both tables
  const qCell = (key) => { const c = rowCells(key); return c[c.length - 1]; };
  const withQ = ['main-primary-in', 'main-secondary-in', 'original-main-primary-in', 'original-main-secondary-in'];
  const noQ = ['main-primary-hold', 'main-secondary-hold', 'confirmed-primary-in', 'confirmed-primary-hold', 'confirmed-secondary-in', 'confirmed-secondary-hold',
    'original-main-primary-hold', 'original-main-secondary-hold'];
  ok('q is shown only on the main in-sample rows (both tables); every other row shows "—"',
    withQ.every(k => /^\d\.\d{3}$/.test(qCell(k))) && noQ.every(k => qCell(k) === '—'), withQ.map(qCell).join(',') + ' | ' + noQ.map(qCell).join(','));
  ok('the sensitivity sub-section is collapsed (<details>), labelled display only, says it cannot set significance, and is the corrected run',
    /<details[^>]*><summary[^>]*>Sensitivity: games with a confirmed pre-game locked price \(display only\)<\/summary>/.test(out)
    && /Outside the multiple-comparison correction; it cannot set significance\./.test(out) && /Unrecorded price source excluded: /.test(out)
    && out.includes('Confirmed set secondary Apr–Aug: n ' + TC.results.find(x => x.set === 'confirmed' && x.variant === 'secondary' && x.split === 'in' && x.sourceFilter === 'recorded_only').n));
  ok('neutral styling: no green / red, no colour literal, no background highlight in the section',
    !/\b(green|red)\b|#[0-9a-f]{6}\b|rgb\(|background:/i.test(out.replace(/var\(--[a-z0-9-]+\)/g, '')));
  ok('the footnotes say the lean is dollar-weighted and ROI is at the locked price with the vig',
    /dollar-weighted/.test(out) && /one wallet supplies most of the lean-side money/.test(out) && /includes the vig/.test(out));

  // (b) no distinctive figure from either artifact is written into the renderer
  const src = html.slice(html.indexOf('function renderTopTradersSection('), b);
  const figures = new Set();
  for (const T of [TC, TO]) {
    for (const r of T.results) for (const f of [String(r.n), String(r.W), String(r.L), p3(r.pValue), r.qValue != null ? p3(r.qValue) : null,
      P(r.winPct), P(r.implied), M(r.dollars).replace(/^−\$|^\$/, ''), Math.round(Math.abs(r.dollars)).toString()]) if (f && f.length >= 3) figures.add(f);
    figures.add(T.prereg_sha256.slice(0, 12)); figures.add(T.prereg_commit.slice(0, 7));
  }
  const dr = TC.correction.store.trades_dropped_by_the_old_run;
  figures.add(String(dr)); figures.add(dr.toLocaleString('en-US')); figures.add('#' + TC.correction.data_fix.pr);
  figures.delete('100');   // also the renderer's own constant (100 * v, "a flat $100"); an artifact W of 100 is not a hard-coded figure
  const hard = [...figures].filter(f => src.includes(f));
  ok('no figure from either artifact (results, q, hashes, the 18,671 count, the fix PR) is hard-coded in the renderer', hard.length === 0, hard.join(',') || figures.size + ' figures checked');
  ok('SELF-TEST: the figure scan catches a planted figure', [...figures].some(f => (src + '\nconst x = "' + qIn(TC) + '";').includes(f)));
}

cleanupTmpDb();
ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
