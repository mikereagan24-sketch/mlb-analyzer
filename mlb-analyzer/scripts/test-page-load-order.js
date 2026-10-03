#!/usr/bin/env node
'use strict';
/**
 * Page boot (#485) and lineup-order PA weights (2026-10-03). No server, no
 * database: the real functions are extracted from public/index.html by brace
 * matching and run in a sandbox where any page helper not under test is a
 * no-op, with a fake document and a stubbed api().
 *
 *   a. the Matchups card's PA column and "Wtd avg" footer, and the game-detail
 *      breakdown, show the SAVED weights after load -- including when the
 *      settings arrive after the cards rendered with the fallback.
 *   b. init() runs once (a second call does nothing), loads each thing once,
 *      pre-fills the date, and is called exactly once, last, by the page.
 *   c. every fallback is the one shared constant (utils/pa-weights.js), equal
 *      to the production setting; no copy of the old default is left.
 *   d. (the inline-script parse test is scripts/test-index-inline-scripts-parse.js)
 *
 *   node scripts/test-page-load-order.js
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const R = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

const html = read('public/index.html');
function extract(name) {
  const i = html.search(new RegExp('(^|\\n)(async )?function ' + name + '\\('));
  if (i < 0) return '';
  const start = html.indexOf('function', i) - (html.slice(i, html.indexOf('function', i)).includes('async') ? 6 : 0);
  let depth = 0, j = html.indexOf('{', start);
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (depth === 0) return html.slice(start, k + 1); }
  }
  return '';
}

const SHARED = require(path.join(R, 'utils/pa-weights'));
const SAVED = [4.65, 4.6, 4.55, 4.5, 4.25, 4.13, 4, 3.85, 3.65];          // production pa_weights, 2026-10-03
const OLD = [4.65, 4.55, 4.5, 4.5, 4.25, 4.13, 4, 3.85, 3.7];             // the old hard-coded default

// ---------------------------------------------------------------- the sandbox
function makePage(opts) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', value: '', textContent: '', placeholder: '', style: {}, dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } },
    addEventListener() {}, remove() {} });
  const calls = {};
  const order = [];
  const count = (n) => { calls[n] = (calls[n] || 0) + 1; order.push(n); };
  const game = { game_id: 'nyy-bos', away_team: 'NYY', home_team: 'BOS', away_sp: 'Away SP', home_sp: 'Home SP', away_sp_hand: 'R', home_sp_hand: 'R',
    away_lineup: [], home_lineup: [] };
  const batters = (t) => Array.from({ length: 9 }, (_, i) => ({ name: t + ' Batter ' + (i + 1), hand: 'R', woba: 0.300 + i * 0.005 }));
  const settingsDelay = opts.settingsDelay || 0;
  const ctx = {
    console, Math, JSON, Number, String, Array, Object, Date, Promise, setTimeout, isNaN, parseFloat, parseInt, isFinite, Set, Map, RegExp, Error,
    document: { getElementById: el, querySelectorAll: () => [], createElement: () => el('_tmp') },
    window: {},
    currentGames: [game], currentGame: null, muSelectedGame: null, gDate: '2026-10-03',
    todayStr: () => '2026-10-03',
    api: async (p) => {
      count('api ' + p.split('/').slice(0, 2).join('/'));
      if (p === '/settings') { await new Promise(r => setTimeout(r, settingsDelay)); return { pa_weights: JSON.stringify(opts.saved || SAVED) }; }
      if (p.startsWith('/woba/game/')) return { away_batters: batters('A'), home_batters: batters('H'), away_sp_woba: { vsLHB: 0.31, vsRHB: 0.30 }, home_sp_woba: { vsLHB: 0.32, vsRHB: 0.31 } };
      return {};
    },
    refreshWobaStatus: async () => { count('refreshWobaStatus'); el('hdr-sub').textContent = 'status shown'; },
    loadGamesFromDB: async () => { count('loadGamesFromDB'); },
    fetchServerWoba: async () => { count('fetchServerWoba'); },
    refreshHealth: () => { count('refreshHealth'); },
    _applySettingsSchema: async () => {},
  };
  ctx.window.PaWeights = SHARED;
  ctx.window.PA_WEIGHTS = SHARED.PA_WEIGHTS_DEFAULT.slice();
  // Any page helper not provided above is a no-op returning '' (renderMatchupGame calls many).
  const known = new Set(Object.keys(ctx));
  const sandbox = new Proxy(ctx, {
    has: () => true,
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      if (k === 'undefined') return undefined;
      return function () { return ''; };
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  vm.createContext(ctx);
  ctx.__sb = sandbox;
  const fns = ['init', 'loadSettings', '_redrawForPaWeights', '_renderBreakdowns', 'renderMatchupGame'];
  const src = fns.map(extract);
  if (src.some(s => !s)) throw new Error('could not extract: ' + fns.filter((f, i) => !src[i]).join(', '));
  // window.PA_WEIGHTS in the page is a global; the sandbox's `window` is the same object as its globals here
  ctx.window = new Proxy(ctx.window, { get: (t, k) => (k === 'PA_WEIGHTS' ? ctx.__paw : t[k]), set: (t, k, v) => { if (k === 'PA_WEIGHTS') ctx.__paw = v; else t[k] = v; return true; } });
  ctx.__paw = SHARED.PA_WEIGHTS_DEFAULT.slice();
  vm.runInContext('with (__sb) {\n' + 'var _initStarted = false;\n' + src.join('\n') + '\n'
    + 'this.init = init; this.loadSettings = loadSettings; this._redrawForPaWeights = _redrawForPaWeights; this._renderBreakdowns = _renderBreakdowns; this.renderMatchupGame = renderMatchupGame;\n}', ctx);
  void known;
  return { ctx, els, el, calls, order, game };
}
// the PA column and the footer of the rendered Matchups card
function paColumn(htmlStr) {
  const rows = [...htmlStr.matchAll(/<tr><td>(\d)<\/td><td>[\s\S]*?<\/td><td>([\d.]+)<\/td>/g)].map(m => Number(m[2]));
  const foot = [...htmlStr.matchAll(/Wtd avg<\/td><td[^>]*>([\d.]+)<\/td>/g)].map(m => Number(m[1]));
  return { rows: rows.slice(0, 9), foot };
}
const fmt = (a) => a.map(x => x.toFixed(2)).join(',');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. the PA column, the footer and the breakdown show the saved weights');
  {
    // settings arrive 80 ms AFTER the Matchups card and the breakdown rendered with the fallback
    const P = makePage({ settingsDelay: 80, saved: SAVED });
    P.ctx.muSelectedGame = 'nyy-bos';
    P.el('sec-matchups').classList.add('active');
    P.ctx.currentGame = P.game;
    P.game.away_lineup = Array.from({ length: 9 }, (_, i) => ({ name: 'A' + i, hand: 'R' }));
    P.game.home_lineup = Array.from({ length: 9 }, (_, i) => ({ name: 'H' + i, hand: 'R' }));
    P.ctx.__paw = OLD.slice();                               // what a page showed before this change
    await P.ctx.renderMatchupGame('nyy-bos');
    P.ctx._renderBreakdowns(P.game);
    const before = paColumn(P.el('mu-content').innerHTML);
    ok('before settings arrive: the card is drawn with the old weights (the reported bug)', fmt(before.rows) === fmt(OLD) && before.foot[0] === 38.1,
      fmt(before.rows) + ' / footer ' + before.foot.join(','));
    const ls = P.ctx.loadSettings();                          // arrives later
    await wait(10);
    ok('...still the old ones while /api/settings is in flight', fmt(paColumn(P.el('mu-content').innerHTML).rows) === fmt(OLD));
    await ls; await wait(20);
    const after = paColumn(P.el('mu-content').innerHTML);
    ok('after they arrive: the open card redraws, PA column = the saved weights', fmt(after.rows) === fmt(SAVED), fmt(after.rows));
    ok('...and the "Wtd avg" PA footer = their sum (38.2)', after.foot[0] === 38.2, after.foot.join(','));
    const bd = P.el('a-bd').innerHTML;
    ok('the game-detail breakdown redraws with the saved weights too', SAVED.every(w => bd.includes('>' + w + '</span>')) && !bd.includes('>3.7</span>'));
    // no redraw when nothing changed
    const n0 = P.calls['api /woba'] || 0;
    await P.ctx.loadSettings();
    ok('a second settings load with the same weights does not redraw', (P.calls['api /woba'] || 0) === n0);
    // the card is not open: no fetch, no redraw
    const Q = makePage({ saved: SAVED });
    Q.ctx.muSelectedGame = 'nyy-bos';
    Q.ctx.__paw = OLD.slice();
    await Q.ctx.loadSettings();
    ok('Matchups tab not open: no redraw (it renders from the saved weights when opened)', !Q.calls['api /woba'] && fmt(Q.ctx.__paw) === fmt(SAVED));
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. init() runs once and loads each thing once');
  {
    const P = makePage({ saved: SAVED });
    await Promise.all([P.ctx.init(), P.ctx.init()]);
    await wait(20);
    const c = P.calls;
    ok('a second init() call does nothing: each loader ran exactly once',
      c.refreshWobaStatus === 1 && c.loadGamesFromDB === 1 && c.fetchServerWoba === 1 && c.refreshHealth === 1 && c['api /settings'] === 1, JSON.stringify(c));
    ok('the date and the backtest range are pre-filled', P.el('games-date').value === '2026-10-03' && P.el('bt-to').value === '2026-10-03' && P.el('bt-from').value === '2026-04-09');
    ok('the header shows the real status (refreshWobaStatus ran)', P.el('hdr-sub').textContent === 'status shown');
    ok('settings are requested FIRST, before the status and the games',
      P.order.indexOf('api /settings') === 0 && P.order.indexOf('refreshWobaStatus') > 0 && P.order.indexOf('loadGamesFromDB') > 0, P.order.join(' > '));
    // not awaited: a settings response that never comes does not hold the games back
    const H = makePage({ settingsDelay: 60000 });
    const t0 = Date.now(); await H.ctx.init();
    ok('...and never awaited: with /api/settings hanging, the games still load at once', H.calls.loadGamesFromDB === 1 && Date.now() - t0 < 1000, (Date.now() - t0) + ' ms');
    // the page calls init() exactly once, at the end of the last script block
    const lastScript = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
    const topLevelCalls = html.split(/\r?\n/).filter(l => /^init\(\);\s*$/.test(l));
    ok('the page calls init() once, as the last statement of the last script block', topLevelCalls.length === 1 && /\ninit\(\);\s*$/.test(lastScript));
    ok('nothing else loads games, settings or status at page load (no other top-level call)',
      !html.split(/\r?\n/).some(l => /^(loadGamesFromDB|loadSettings|refreshWobaStatus|refreshHealth)\(\);/.test(l))
      && !/DOMContentLoaded|window\.onload|<body[^>]*onload/.test(html));
    ok('every function init() calls is defined before that last line', ['loadSettings', 'refreshWobaStatus', 'loadGamesFromDB', 'fetchServerWoba', 'refreshHealth']
      .every(f => { const i = html.search(new RegExp('function ' + f + '\\(')); return i > 0 && i < html.lastIndexOf('\ninit();'); }));

    // "Today" is the PT slate date. 6:30 PM PT on 2026-10-03 is already 01:30 UTC on 10-04.
    const NOW = Date.parse('2026-10-04T01:30:00Z');
    class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }
    const dctx = { Date: FakeDate };
    vm.createContext(dctx);
    vm.runInContext(extract('todayStr') + '\nthis.todayStr = todayStr;', dctx);
    ok('todayStr() at 6:30 PM PT returns the PT date (2026-10-03), not the UTC one', dctx.todayStr() === '2026-10-03', dctx.todayStr());
    ok('...where the old browser-zone rule, in a UTC-zoned browser, gave the next day (2026-10-04)',
      new FakeDate().toLocaleDateString('en-CA', { timeZone: 'UTC' }) === '2026-10-04');
    ok('todayStr() names America/Los_Angeles, as services/jobs.js todayStr() does',
      /toLocaleDateString\('en-CA',\{timeZone:'America\/Los_Angeles'\}\)/.test(extract('todayStr'))
      && /toLocaleDateString\('en-CA', \{ timeZone: 'America\/Los_Angeles' \}\)/.test(read('services/jobs.js')));
    const T = makePage({ saved: SAVED });
    T.ctx.todayStr = dctx.todayStr;
    await T.ctx.init();
    ok('init() at 6:30 PM PT fills the date box and the backtest end with 2026-10-03',
      T.el('games-date').value === '2026-10-03' && T.el('bt-to').value === '2026-10-03', T.el('games-date').value + ' / ' + T.el('bt-to').value);

    // 9:30 PM PT on 2026-10-03 = 04:30 UTC on 10-04 (and already 10-04 in New York, where the old fallback looked).
    const NIGHT = Date.parse('2026-10-04T04:30:00Z');
    class NightDate extends Date { constructor(...a) { if (a.length === 0) super(NIGHT); else super(...a); } static now() { return NIGHT; } }
    const nels = {};
    const nel = (id) => nels[id] || (nels[id] = { value: '', classList: { add() {} } });
    const nctx = { Date: NightDate, document: { getElementById: nel }, loadManualGames: () => {} };
    vm.createContext(nctx);
    vm.runInContext([extract('todayStr'), extract('openManualModal'), extract('_clvDefaultRange')].join('\n')
      + '\nthis.openManualModal = openManualModal; this._clvDefaultRange = _clvDefaultRange;', nctx);
    nel('bt-from').value = '';                                  // nothing to copy: the fallback decides
    nctx.openManualModal();
    ok('manual-bet form at 9:30 PM PT, empty backtest "from": the date is the PT date (2026-10-03)', nels['mb-date'].value === '2026-10-03', nels['mb-date'].value);
    ok('...where the old New York fallback gave the next day (2026-10-04)', new NightDate().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === '2026-10-04');
    nel('bt-from').value = '2026-09-01'; nctx.openManualModal();
    ok('...and a filled backtest "from" still wins, as before', nels['mb-date'].value === '2026-09-01');
    const clv = nctx._clvDefaultRange();
    ok('the CLV tab\'s default range ends on the PT date at 9:30 PM PT (2026-09-03 .. 2026-10-03), not the UTC one',
      clv.to === '2026-10-03' && clv.from === '2026-09-03', JSON.stringify(clv));
    ok('no slate or game date in the page is computed in another zone (no America/New_York, no toLocaleDateString without one)',
      !/America\/New_York/.test(html) && !/toLocaleDateString\('en-CA'\)/.test(html));
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. one shared fallback');
  {
    ok('utils/pa-weights.js PA_WEIGHTS_DEFAULT = the production setting, frozen', fmt(SHARED.PA_WEIGHTS_DEFAULT) === fmt(SAVED) && Object.isFrozen(SHARED.PA_WEIGHTS_DEFAULT));
    const files = ['services/model.js', 'services/jobs.js', 'routes/api.js', 'db/schema.js', 'public/index.html', 'server.js'];
    const oldLit = /4\.65,\s*4\.55,\s*4\.5,\s*4\.5,\s*4\.25,\s*4\.13,\s*4,\s*3\.85,\s*3\.7\b/;
    const left = files.filter(f => oldLit.test(read(f).replace(/\/\/.*$/gm, '')));
    ok('no copy of the old default is left in the pricing, settings, route, seed or page code', left.length === 0, left.join(', '));
    ok('services/model.js falls back to the shared constant', /const \{ PA_WEIGHTS_DEFAULT \} = require\('\.\.\/utils\/pa-weights'\)/.test(read('services/model.js')));
    ok('services/jobs.js getSettings falls back to it (both the raw default and the parse failure)',
      /JSON\.stringify\(PA_WEIGHTS_DEFAULT\)/.test(read('services/jobs.js')) && /return PA_WEIGHTS_DEFAULT\.slice\(\);/.test(read('services/jobs.js')));
    ok('the model-trace route falls back to it', /require\('\.\.\/utils\/pa-weights'\)\.PA_WEIGHTS_DEFAULT/.test(read('routes/api.js')));
    ok('a new database is seeded from it (INSERT OR IGNORE: existing settings untouched)',
      /INSERT OR IGNORE INTO app_settings VALUES \('pa_weights', \?\)"\)\.run\(JSON\.stringify\(require\('\.\.\/utils\/pa-weights'\)\.PA_WEIGHTS_DEFAULT\)\)/.test(read('db/schema.js')));
    ok('the page loads /pa-weights.js before the main script and seeds window.PA_WEIGHTS from it',
      html.indexOf('<script src="/pa-weights.js"></script>') > 0 && html.indexOf('<script src="/pa-weights.js"></script>') < html.indexOf('window.PA_WEIGHTS = window.PA_WEIGHTS ||')
      && /window\.PA_WEIGHTS = window\.PA_WEIGHTS \|\| window\.PaWeights\.PA_WEIGHTS_DEFAULT\.slice\(\);/.test(html));
    ok('server.js serves that same file at /pa-weights.js', /app\.get\('\/pa-weights\.js'[\s\S]{0,300}sendFile\(path\.join\(__dirname, 'utils', 'pa-weights\.js'\)\)/.test(read('server.js')));
    ok('the UMD footer defines window.PaWeights in a page', (() => { const c = { self: {} }; vm.createContext(c); vm.runInContext(read('utils/pa-weights.js'), c); return c.self.PaWeights && fmt(c.self.PaWeights.PA_WEIGHTS_DEFAULT) === fmt(SAVED); })());
    ok('the BsR backtest default is deliberately separate (changing it would move backtest output)',
      /const DEFAULT_PA_WEIGHTS = \[4\.65, 4\.55, 4\.5, 4\.5, 4\.25, 4\.13, 4, 3\.85, 3\.7\];/.test(read('services/baserunning-util.js')));
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
