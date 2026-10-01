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
// Check h re-runs the backtest on the SCRATCH COPY the suite passes in
// (MLB_DB_PATH, outside the repo) -- captured here, before it is redirected.
const SCRATCH_COPY = process.env.MLB_DB_PATH || null;
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
ok('defines exactly two routes: GET /trends/results and GET /trends/slate',
  (code.match(/router\.(get|post|put|patch|delete|use)\(/g) || []).length === 2
  && /router\.get\('\/trends\/results'/.test(code) && /router\.get\('\/trends\/slate'/.test(code));
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
const FORBIDDEN_TEXT = /trends-results-2026-09-29\.json|trends-backtest|trends-slate|trends-results|utils\/trends\//;
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
  const realDb = path.resolve(R, 'data/mlb.db');
  if (!SCRATCH_COPY) {
    console.log('  NOTE  no MLB_DB_PATH scratch copy given -- run with MLB_DB_PATH=<copy outside the repo> (the suite does)');
  } else if (path.resolve(SCRATCH_COPY) === realDb || path.resolve(SCRATCH_COPY).startsWith(path.resolve(R) + path.sep)) {
    ok('refuses a database inside the repo (never data/mlb.db)', false, SCRATCH_COPY);
  } else {
    const Database = require(path.join(R, 'node_modules/better-sqlite3'));
    const tb = require(path.join(R, 'services/trends-backtest'));
    const sdb = new Database(SCRATCH_COPY, { readonly: true, fileMustExist: true });
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
    ok('every result row and figure matches docs/trends-results-2026-09-29.json exactly (scratch copy, read-only)',
      bad2.length === 0 && run.results.length === A3.trend_results.length, run.results.length + ' rows, ' + fields + ' fields' + (bad2.length ? ' | ' + bad2.slice(0, 5).join(' | ') : ''));
  }
}

cleanupTmpDb();
ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
