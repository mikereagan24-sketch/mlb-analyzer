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
ok('requires only fs, path and express', JSON.stringify(requires) === JSON.stringify(['express', 'fs', 'path']), requires.join(','));
ok('points at docs/trends-results-2026-09-29.json',
  /path\.join\(__dirname,\s*'\.\.',\s*'docs',\s*'trends-results-2026-09-29\.json'\)/.test(code));
ok('no database, settings, model or computation in the route',
  !/\bdb\b|\bq\.|better-sqlite3|getSettings|runModel|getSignals|trends-backtest|utils\/trends|processGameSignals/.test(code));
ok('defines exactly one route: GET /trends/results',
  (code.match(/router\.(get|post|put|patch|delete|use)\(/g) || []).length === 1 && /router\.get\('\/trends\/results'/.test(code));
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
const FORBIDDEN_TARGET = /^(utils\/trends\/.+|services\/trends-backtest\.js|routes\/trends-results\.js|scripts\/(run|export)-trends-[\w-]+\.js)$/;
// And code (comments stripped) that names the artifact or the modules.
const FORBIDDEN_TEXT = /trends-results-2026-09-29\.json|trends-backtest|trends-results|utils\/trends\//;
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

cleanupTmpDb();
ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
