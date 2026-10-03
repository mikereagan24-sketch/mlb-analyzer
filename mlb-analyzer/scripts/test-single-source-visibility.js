#!/usr/bin/env node
'use strict';
/**
 * #484 visibility (2026-10-02): the self-cross-check fix, the price-source tag
 * on signals and logged bets, and book depth at signal time. Throwaway
 * database; no network (node-fetch and global fetch are replaced and fail).
 *
 *   a. a same-venue comparison is single-source; two venues is cross-checked
 *      (mlCrossCheck, and processOddsArray end to end: the stored status and
 *      the flag text). The flag change only ADDS the single-source text; every
 *      reason the old rule produced -- including the signal-suppressing
 *      "disagree on favorite" -- is still produced.
 *   b. a new ML signal stores its source, cross-check status and depth, or
 *      null with a reason (venue winner, venue-aware off, depth missing from
 *      older comparison data, status not yet recorded); a Total stores none.
 *   c. the UI shows the tag on signals and logged bets, Kalshi first, and
 *      "not recorded" on old rows; neutral styling.
 *   d. no decision reads the new data: nothing outside the writers and the
 *      display reads the new columns, provenance is computed after every
 *      pricing variable, and the depth field leaves the comparison's prices
 *      unchanged. (The main-vs-branch replay on real data is
 *      scripts/replay-single-source-visibility.js; see the PR.)
 *
 *   node scripts/test-single-source-visibility.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const Module = require('module');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__single_source_vis_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), '__single_source_vis_cwd_'));
process.chdir(TMP_CWD);
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- no network
const netCalls = [];
const deny = async (url) => { netCalls.push(String(url)); throw new Error('test: network is forbidden'); };
const nfPath = require.resolve('node-fetch', { paths: [R] });
const fm = new Module(nfPath); fm.filename = nfPath; fm.loaded = true; fm.exports = deny; deny.default = deny;
require.cache[nfPath] = fm;
const realGlobalFetch = globalThis.fetch;
globalThis.fetch = deny;

// ---------------------------------------------------------------- model: real runModel, chosen signals
const model = require(path.join(R, 'services/model'));
const realRunModel = model.runModel;
// A synthetic game is suppressed (no lineups / park factor); give it plausible numbers so the rest of the real
// pipeline runs. The signals themselves come from getSignals below.
model.runModel = function (...a) {
  const m = realRunModel.apply(this, a);
  if (m && m._suppressed) {
    delete m._suppressed; delete m._suppressed_detail;
    Object.assign(m, { aTeamWoba: 0.315, hTeamWoba: 0.32, aRuns: 4.2, hRuns: 4.4, rawHW: 0.53, adjHW: 0.53, adjAW: 0.47, aML: -113, hML: 104, estTot: 8.6 });
  }
  return m;
};
let nextSignals = [];
model.getSignals = () => nextSignals.map(s => Object.assign({}, s));

// the venue comparison the override reads (tier b: the in-memory cache peek)
const cmp = require(path.join(R, 'services/odds-comparison'));
let venueRows = null;
cmp.peekCachedRowsByGid = () => venueRows;

const schema = require(path.join(R, 'db/schema'));
const { db, q } = schema;
const jobs = require(path.join(R, 'services/jobs'));
const ps = require(path.join(R, 'utils/price-source'));

const D = '2027-04-01';                                          // future: never "started", never locked
let n = 0;
function addGame(id, extra) {
  const [a, h] = id.split('-');
  const o = Object.assign({ game_date: D, game_id: id, away_team: a.toUpperCase(), home_team: h.toUpperCase(), game_number: 1,
    scheduled_start_utc: D + 'T23:0' + (n++ % 10) + ':00Z', game_time: '7:05 PM ET', is_removed: 0 }, extra || {});
  const cols = Object.keys(o);
  db.prepare('INSERT INTO game_log (' + cols.join(', ') + ') VALUES (' + cols.map(c => '@' + c).join(', ') + ')').run(o);
}
const gl = (id) => db.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(D, id);
const sigRow = (id, type, side) => db.prepare('SELECT * FROM bet_signals WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?').get(D, id, type, side);
const SETTINGS = Object.assign({}, jobs.getSettings(), { SIGNAL_VENUE_AWARE_ENABLED: true });

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. cross-checked means two distinct venues');
  {
    const X = (o) => ps.mlCrossCheck(Object.assign({ haveMarket: true, primaryAway: -120, primaryHome: 110, xcheckAway: -118, xcheckHome: 108 }, o)).status;
    ok('Kalshi priced, Polymarket quoted: cross-checked', X({ primarySource: 'kalshi', xcheckSource: 'polymarket' }) === 'cross-checked');
    ok('Polymarket priced, Polymarket quoted: single-source', X({ primarySource: 'polymarket', xcheckSource: 'polymarket' }) === 'single-source');
    ok("'poly' and 'polymarket' are the same venue", X({ primarySource: 'poly', xcheckSource: 'polymarket' }) === 'single-source');
    ok('no second quote: single-source', X({ primarySource: 'kalshi', xcheckSource: null }) === 'single-source');
    ok('the 8/04-9/16 case -- primary unknown this pass (null) vs Polymarket: single-source, not cross-checked',
      X({ primarySource: null, xcheckSource: 'polymarket' }) === 'single-source');
    ok('a stored Kalshi label but no fresh primary price: single-source (no comparison actually ran)',
      X({ primarySource: 'kalshi', xcheckSource: 'polymarket', primaryAway: null, primaryHome: null }) === 'single-source');
    ok('no market at all: no-market', ps.mlCrossCheck({ haveMarket: false, primarySource: 'kalshi', xcheckSource: 'polymarket' }).status === 'no-market');
    ok('Kalshi first in any venue list', JSON.stringify(ps.kalshiFirst(['polymarket', 'kalshi', 'poly', 'novig'])) === '["kalshi","novig","polymarket"]');

    // processOddsArray end to end. Each row: what this pass carries, and the reasons main's rule produced
    // (copied from services/jobs.js at e071e42: singleSource = haveMarket && (!_xSrc || _xSrc === o.ml_source)).
    nextSignals = [];
    const base = { market_total: 8.5, over_price: -110, under_price: -110, total_source: 'kalshi' };
    const cases = [
      { id: 'nyy-bos', o: { ml_source: 'kalshi', market_away_ml: -130, market_home_ml: 115, poly_away_ml: -128, poly_home_ml: 112 },
        status: 'cross-checked', mainMl: [] },
      { id: 'sea-tex', o: { ml_source: 'polymarket', market_away_ml: -140, market_home_ml: 125, poly_away_ml: -140, poly_home_ml: 125 },
        status: 'single-source', mainMl: ['single-source, no cross-check available'] },
      { id: 'lad-sd', o: { ml_source: 'kalshi', market_away_ml: -150, market_home_ml: 130 },
        status: 'single-source', mainMl: ['single-source, no cross-check available'] },
      // a pass with no primary price (e.g. Kalshi absent, Poly rejected by the DH guard) on a row already priced
      // from Polymarket: main called this cross-checked ('polymarket' !== null), with no reason at all
      { id: 'chc-mil', existing: { ml_source: 'polymarket', market_away_ml: -110, market_home_ml: -105 },
        o: { ml_source: null, market_away_ml: null, market_home_ml: null, poly_away_ml: -112, poly_home_ml: -102 },
        status: 'single-source', mainMl: [] },
      // a real two-venue disagreement: the suppression reason must survive unchanged
      { id: 'tor-bal', o: { ml_source: 'kalshi', market_away_ml: -150, market_home_ml: 130, poly_away_ml: 140, poly_home_ml: -160 },
        status: 'cross-checked', mainMl: ['Kalshi vs polymarket disagree on favorite: Kalshi favors away (-150) polymarket favors home (-160)'] },
    ];
    for (const c of cases) addGame(c.id, c.existing || {});
    jobs.processOddsArray(D, cases.map(c => Object.assign({ game_id: c.id }, base, c.o)), SETTINGS);
    for (const c of cases) {
      const r = gl(c.id);
      const frags = String(r.odds_flag_reason || '').split(' | ').filter(Boolean).filter(f => !/total/.test(f));
      const extra = frags.filter(f => !c.mainMl.includes(f));
      const missing = c.mainMl.filter(f => !frags.includes(f));
      ok(c.id + ': stored ml_xcheck_status = ' + c.status + '; every reason main produced is still there; the only addition is the single-source text',
        r.ml_xcheck_status === c.status && missing.length === 0 && extra.every(f => f === 'single-source, no cross-check available')
        && (c.status === 'cross-checked' ? !frags.includes('single-source, no cross-check available') : frags.includes('single-source, no cross-check available')),
        JSON.stringify({ status: r.ml_xcheck_status, xsrc: r.ml_xcheck_source, frags }));
    }
    ok('cross-checked rows name the second venue; single-source rows name none',
      gl('nyy-bos').ml_xcheck_source === 'polymarket' && gl('sea-tex').ml_xcheck_source == null && gl('chc-mil').ml_xcheck_source == null);
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. a new signal records source, cross-check and depth');
  {
    const run = (id, settings) => jobs.processGameSignals(gl(id), {}, settings || SETTINGS);
    const vside = (net, depth, extra) => Object.assign({ net_american: net, partial: false, top_ask_ml: net }, depth === undefined ? {} : { depth_usd: depth }, extra || {});
    // 1. venue winner on the home side is Polymarket (better net), with depth recorded
    venueRows = { 'nyy-bos': { game_id: 'nyy-bos', poly: { away: vside(-125, 900), home: vside(118, 1503.2) }, kalshi: { away: vside(-122, 4200), home: vside(112, 2600) } } };
    nextSignals = [{ type: 'ML', side: 'home', edge: 0.03, category: 'dog', label: null },
                   { type: 'Total', side: 'under', edge: 0.02, category: 'under', label: null }];
    run('nyy-bos');
    const s1 = sigRow('nyy-bos', 'ML', 'home');
    ok('venue winner Polymarket: source polymarket, cross-checked vs polymarket (the game\'s status), depth $1,503.20, no reason',
      s1 && s1.price_venue === 'poly' && s1.ml_price_source === 'polymarket' && s1.ml_xcheck_status === 'cross-checked'
      && s1.ml_xcheck_source === 'polymarket' && s1.ml_depth_usd === 1503.2 && s1.ml_depth_reason == null, JSON.stringify(s1 && pick(s1)));
    ok('the price itself is the venue winner\'s net, exactly as before (market_line 118, venue_stale 0)', s1 && s1.market_line === 118 && s1.venue_stale === 0);
    const t1 = sigRow('nyy-bos', 'Total', 'under');
    ok('a Total signal stores no moneyline provenance', t1 && t1.ml_price_source == null && t1.ml_xcheck_status == null && t1.ml_depth_usd == null && t1.ml_depth_reason == null,
      JSON.stringify(t1 && pick(t1)));

    // 2. venue-aware off: the stored market price, its stored source, no book read
    nextSignals = [{ type: 'ML', side: 'away', edge: 0.03, category: 'fav', label: null }];
    run('lad-sd', Object.assign({}, SETTINGS, { SIGNAL_VENUE_AWARE_ENABLED: false }));
    const s2 = sigRow('lad-sd', 'ML', 'away');
    ok('venue-aware off: source kalshi (game_log.ml_source), single-source, depth null with the reason',
      s2 && s2.ml_price_source === 'kalshi' && s2.ml_xcheck_status === 'single-source' && s2.ml_depth_usd == null
      && /venue-aware pricing off/.test(s2.ml_depth_reason || ''), JSON.stringify(s2 && pick(s2)));

    // 3. comparison data captured before depth existed (no depth_usd field)
    venueRows = { 'sea-tex': { game_id: 'sea-tex', poly: { away: vside(-138), home: vside(122) }, kalshi: { away: null, home: null } } };
    nextSignals = [{ type: 'ML', side: 'away', edge: 0.03, category: 'fav', label: null }];
    run('sea-tex');
    const s3 = sigRow('sea-tex', 'ML', 'away');
    ok('venue data without depth: depth null, reason says it was not captured; source polymarket, single-source',
      s3 && s3.ml_price_source === 'polymarket' && s3.ml_xcheck_status === 'single-source' && s3.ml_depth_usd == null
      && /not in the comparison data/.test(s3.ml_depth_reason || ''), JSON.stringify(s3 && pick(s3)));

    // 4. no comparison row at all: stored market price
    venueRows = {};
    addGame('cle-kc', { ml_source: 'kalshi', market_away_ml: -115, market_home_ml: 102 });   // never through the odds job: status not recorded
    nextSignals = [{ type: 'ML', side: 'home', edge: 0.03, category: 'dog', label: null }];
    run('cle-kc');
    const s4 = sigRow('cle-kc', 'ML', 'home');
    ok('no venue comparison and a game the odds job has not recorded: source kalshi, status null (shown "not recorded"), depth reason given',
      s4 && s4.ml_price_source === 'kalshi' && s4.ml_xcheck_status == null && s4.ml_depth_usd == null
      && /no venue comparison available/.test(s4.ml_depth_reason || ''), JSON.stringify(s4 && pick(s4)));
    ok('no network was touched', netCalls.length === 0, netCalls.join(' | '));
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. the tag on signals and logged bets');
  {
    const html = read('public/index.html');
    const fnSrc = (name) => {
      const i = html.indexOf('function ' + name + '(');
      if (i < 0) return '';
      let depth = 0, j = html.indexOf('{', i);
      for (let k = j; k < html.length; k++) { if (html[k] === '{') depth++; else if (html[k] === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); } }
      return '';
    };
    const varLine = (html.match(/var _PS_LABEL = [^\n]+/) || [''])[0];
    const ctx = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
    vm.createContext(ctx);
    vm.runInContext([varLine, fnSrc('_psLabel'), fnSrc('_priceSourceText'), fnSrc('_priceSourceTitle'), fnSrc('_priceSourceTag'), fnSrc('renderLoggedBets')].join('\n'), ctx);
    const T = (s) => ctx._priceSourceText(s);
    ok('cross-checked: "Source: Kalshi · cross-checked · $4,200 at this price"',
      T({ signal_type: 'ML', ml_price_source: 'kalshi', ml_xcheck_status: 'cross-checked', ml_xcheck_source: 'polymarket', ml_depth_usd: 4200 }) === 'Source: Kalshi · cross-checked · $4,200 at this price');
    ok('single source: "Source: Polymarket · single source"',
      T({ signal_type: 'ML', ml_price_source: 'polymarket', ml_xcheck_status: 'single-source', ml_depth_usd: null, ml_depth_reason: 'x' }) === 'Source: Polymarket · single source');
    ok('an old row: "Source: not recorded"', T({ signal_type: 'ML', ml_price_source: null }) === 'Source: not recorded');
    ok('a status not yet recorded says so', T({ signal_type: 'ML', ml_price_source: 'kalshi', ml_xcheck_status: null }) === 'Source: Kalshi · cross-check not recorded');
    ok('a Total gets no tag', T({ signal_type: 'Total', ml_price_source: null }) === '');
    const title = ctx._priceSourceTitle({ signal_type: 'ML', ml_price_source: 'polymarket', ml_xcheck_status: 'cross-checked', ml_xcheck_source: 'kalshi', ml_depth_usd: null, ml_depth_reason: 'game started' });
    ok('the hover lists venues Kalshi first, gives the depth reason, and says nothing is blocked',
      /^Venues: Kalshi, Polymarket\. Depth not recorded: game started\. Nothing is blocked/.test(title), title);
    const tag = ctx._priceSourceTag({ signal_type: 'ML', ml_price_source: 'kalshi', ml_xcheck_status: 'single-source' });
    ok('neutral styling: the muted text colour, no warning colour', /color:var\(--text3\)/.test(tag) && !/amber|red|warn/.test(tag), tag);
    const lb = ctx.renderLoggedBets({ logged_bets: [
      { signal_type: 'ML', signal_side: 'home', bet_line: -148, outcome: 'pending', notes: 'n', ml_price_source: 'kalshi', ml_xcheck_status: 'single-source' },
      { signal_type: 'ML', signal_side: 'away', bet_line: 120, outcome: 'win', notes: 'n', ml_price_source: null } ] });
    ok('logged bets show the tag, and "not recorded" for an old bet',
      lb.includes('Source: Kalshi · single source') && lb.includes('Source: not recorded'));
    ok('the game-card signal row (logBetControlFor) carries the tag, on both the unlogged and logged states',
      /venueBits \+= _priceSourceTag\(sig\);/.test(fnSrc('logBetControlFor')) && (fnSrc('logBetControlFor').match(/venueBits/g) || []).length >= 5);
    ok('the Signals tab ML row carries the tag', /mdl: '\+modelML\+'<\/span>'\s*\+_priceSourceTag\(s\)/.test(html));
  }

  // ---------------------------------------------------------------- d
  console.log('\nd. nothing that decides a signal or a price reads the new data');
  {
    const COLS = /\b(ml_price_source|ml_xcheck_status|ml_xcheck_source|ml_depth_usd|ml_depth_reason|depth_usd)\b/;
    const hits = [];
    const walk = (dir) => { for (const f of fs.readdirSync(path.join(R, dir))) {
      const p = path.join(dir, f), st = fs.statSync(path.join(R, p));
      if (st.isDirectory()) walk(p); else if (/\.js$/.test(f)) read(p).split(/\r?\n/).forEach((l, i) => {
        const code = l.replace(/\/\/.*$/, '');
        if (COLS.test(code)) hits.push(p.replace(/\\/g, '/') + ':' + (i + 1));
      }); } };
    for (const d of ['services', 'routes', 'utils', 'db']) walk(d);
    const files = [...new Set(hits.map(h => h.split(':')[0]))].sort();
    ok('the new names appear only in the writers (jobs.js, schema.js, odds-comparison.js) and the helper',
      JSON.stringify(files) === JSON.stringify(['db/schema.js', 'services/jobs.js', 'services/odds-comparison.js', 'utils/price-source.js']), files.join(', '));
    const src = read('services/jobs.js');
    const iProv = src.indexOf('const _prov = {'), iUpsert = src.indexOf('q.upsertSignal.run({');
    const pricing = ['let _mktLineOut', 'let _edgeOut', 'let _venueOut', 'let _staleOut', 'const _sigMarketLine', 'const { outcome, pnl }'];
    ok('provenance is computed after every pricing variable and just before the upsert',
      iProv > 0 && iProv < iUpsert && pricing.every(p => src.indexOf(p) > 0 && src.indexOf(p) < iProv));
    const provBlock = src.slice(iProv, iUpsert);
    ok('the provenance block assigns only _prov fields', !/\b(_mktLineOut|_edgeOut|_venueOut|_staleOut|game\.market_\w+|sig\.\w+)\s*=[^=]/.test(provBlock));
    // the depth field does not move the comparison's price
    const book = { asks: [{ price: 0.45, size: 150 }, { price: 0.46, size: 1000 }, { price: 0.5, size: 5000 }] };
    const poly = require(path.join(R, 'services/polymarket'));
    const walkR = poly.walkAsksForFill(book, 100);
    ok('depth at the fill price: the $100 walk reached 0.46, so depth = 0.45*150 + 0.46*1000 = $527.50',
      ps.depthAtFillPrice(book.asks, walkR.levels_consumed) === 527.5, String(ps.depthAtFillPrice(book.asks, walkR.levels_consumed)));
    ok('odds-comparison adds depth_usd as one more field; net_american and the walk are untouched',
      /depth_usd:\s+depthAtFillPrice\(/.test(read('services/odds-comparison.js')) && /net_american:\s+priceToAmerican\(effP\)/.test(read('services/odds-comparison.js')));
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  cleanup();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });

function pick(r) { const o = {}; for (const k of ['market_line', 'price_venue', 'venue_stale', 'ml_price_source', 'ml_xcheck_status', 'ml_xcheck_source', 'ml_depth_usd', 'ml_depth_reason']) o[k] = r[k]; return o; }
function cleanup() {
  globalThis.fetch = realGlobalFetch;
  try { db.close(); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  try { process.chdir(os.tmpdir()); fs.rmSync(TMP_CWD, { recursive: true, force: true }); } catch (e) {}
}
