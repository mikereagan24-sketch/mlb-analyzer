#!/usr/bin/env node
'use strict';
/**
 * Top-traders card, PR C (2026-10-01): the display-only card in Matchups and
 * on the slate cards, fed only by GET /api/top-traders/:date (#500).
 *
 *   a. both renderers are wired in and are JavaScript, not CSS (the
 *      test-logged-bets-render-callsite lesson): the Matchups placeholder
 *      right after renderPolyKalshiOdds in renderMatchupGame, filled
 *      asynchronously like loadOddsComparison; the slate anchor tt-lean-<id>
 *      (its own, not gcard-play-venue) inside renderGameGrid's card template.
 *   b. one fetch per loaded date, started after the cards render and never
 *      awaited by them, shared by the slate and Matchups.
 *   c. rendering synthetic route rows: provisional, final, each skip reason,
 *      flagged, postseason, no row, and the route unavailable.
 *   d. the label comes from the route, never the page; no address is rendered
 *      even when a row carries one; no figure is hard-coded; neutral styling.
 *   e. the block only talks to /api/top-traders, and nothing in the pricing
 *      path or routes/api.js references it.
 *
 *   node scripts/test-top-traders-card-c.js
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
const lines = html.split(/\r?\n/);
const styleRanges = [];
let open = false;
lines.forEach((l, i) => {
  if (/<style[ >]/i.test(l)) { open = true; styleRanges.push([i + 1, null]); }
  if (/<\/style>/i.test(l) && open) { open = false; styleRanges[styleRanges.length - 1][1] = i + 1; }
});
const insideStyle = (n) => styleRanges.some(([a, b]) => n >= a && n <= (b == null ? Infinity : b));
const linesWith = (re) => lines.map((l, i) => (re.test(l) ? i + 1 : 0)).filter(Boolean);
const B0 = html.indexOf('// TOP-TRADERS CARD (PR C'), B1 = html.indexOf('// END TOP-TRADERS CARD');
const block = B0 > 0 && B1 > B0 ? html.slice(B0, B1) : '';

// ---------------------------------------------------------------- a
console.log('a. wired in, as JavaScript');
{
  ok('the card block is present once', B0 > 0 && B1 > B0 && html.indexOf('// TOP-TRADERS CARD (PR C', B0 + 1) < 0);
  for (const fn of ['loadTopTradersCard', 'refreshTopTradersCard', 'ttSlateLine', 'paintTopTradersSlate', 'renderTopTradersCard', 'renderTopTradersCardBody', 'loadTopTradersCardInto']) {
    const defs = linesWith(new RegExp('function\\s+' + fn + '\\s*\\('));
    ok(fn + ' is defined exactly once, outside <style>', defs.length === 1 && !insideStyle(defs[0]), defs.join(','));
  }
  const mu = (html.match(/async function renderMatchupGame\(id\)\{[\s\S]*?\n\}\r?\n/) || [''])[0];
  ok('Matchups: renderTopTradersCard(g) is concatenated immediately after renderPolyKalshiOdds(g)', /\+renderPolyKalshiOdds\(g\)\s*\+renderTopTradersCard\(g\)/.test(mu));
  ok('Matchups: filled asynchronously right after loadOddsComparison (not awaited)',
    /loadOddsComparison\(g\.game_id, date, _oddsCompStake, g\.market_total\);[\s\S]{0,200}loadTopTradersCardInto\(g\.game_id, date\);/.test(mu) && !/await\s+loadTopTradersCardInto/.test(mu));
  const callMu = linesWith(/\+renderTopTradersCard\(g\)/), callFill = linesWith(/loadTopTradersCardInto\(g\.game_id, date\)/);
  ok('the Matchups call sites are outside <style>', callMu.length === 1 && callFill.length === 1 && !insideStyle(callMu[0]) && !insideStyle(callFill[0]));
  const gridIdx = lines.findIndex(l => l.includes("document.getElementById('game-grid').innerHTML=games.map"));
  const anchor = linesWith(/id="tt-lean-'\+g\.game_id\+'"/);
  ok('slate: the tt-lean-<game_id> anchor is inside renderGameGrid\'s card template, outside <style>',
    gridIdx >= 0 && anchor.length === 1 && anchor[0] > gridIdx + 1 && anchor[0] < gridIdx + 250 && !insideStyle(anchor[0]), 'template ' + (gridIdx + 1) + ', anchor ' + anchor.join(','));
  ok('slate: the anchor is its own (not gcard-play-venue) and is not gated on signals', !/gcard-play-venue/.test(lines[anchor[0] - 1] || '')
    && !/sigs\.length\s*(\?|&&)/.test(lines[anchor[0] - 1] || ''));
}

// ---------------------------------------------------------------- b
console.log('\nb. one fetch per loaded date, after render');
const load = (html.match(/async function loadGamesFromDB\(\)\{[\s\S]*?\n\}\r?\n/) || [''])[0];
{
  const iGrid = load.indexOf('renderGameGrid(games,date);'), iTT = load.indexOf('refreshTopTradersCard(date);');
  ok('loadGamesFromDB starts the fetch after renderGameGrid, and does not await it', iGrid > 0 && iTT > iGrid && !/await\s+refreshTopTradersCard/.test(load));
  ok('the fetch is the only top-traders call in the load path', (load.match(/TopTraders/g) || []).length === 1);
}
// A harness: the block evaluated with a stub api() and a minimal document.
function harness(apiImpl) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', innerHTML: '', style: { display: 'none' } });
  const calls = [];
  const ctx = vm.createContext({
    console, Object, Promise, String, Number, Math, JSON, encodeURIComponent,
    todayStr: () => '2026-10-02',
    api: (p) => { calls.push(p); return apiImpl(p); },
    document: {
      getElementById: (id) => (id === 'games-date' ? { value: ctx.__date } : (els[id] || null)),
      querySelectorAll: (sel) => (sel === '[id^="tt-lean-"]' ? Object.values(els).filter(e => e.id.startsWith('tt-lean-')) : []),
    },
    __date: '2026-10-02',
  });
  vm.runInContext(block + '\nthis.__x = { loadTopTradersCard, refreshTopTradersCard, ttSlateLine, paintTopTradersSlate, renderTopTradersCard, renderTopTradersCardBody, loadTopTradersCardInto };', ctx);
  return { x: ctx.__x, calls, el, els, ctx };
}
const LABEL = 'LABEL-FROM-THE-ROUTE ' + Math.random().toString(36).slice(2);
const NOTE = 'NOTE-FROM-THE-ROUTE';
const row = (o) => Object.assign({ game_id: 'nyy-bos', kind: 'provisional', lean_team: 'NYY', lean_dollars: 12345.6, other_dollars: -789.4, wallets_with_money: 41,
  largest_wallet_share: 0.623, concentration_flag: false, qualified_count: 1047, snapshot_as_of: '2026-09-28', postseason: false, skip_reason: null,
  prices: { away_ml: -120, home_ml: 110, source: 'kalshi' }, label: LABEL, note: null }, o);
const ROWS = [
  row({ game_id: 'nyy-bos' }),
  row({ game_id: 'lad-sd', kind: 'final', lean_team: 'SD', lean_dollars: 98000, other_dollars: 40000, largest_wallet_share: 0.81, concentration_flag: true }),
  row({ game_id: 'chc-mil', kind: 'final', lean_team: null, lean_dollars: null, other_dollars: null, wallets_with_money: null, largest_wallet_share: null, skip_reason: 'no_odds_locked_at' }),
  row({ game_id: 'phi-atl', kind: 'final', lean_team: null, lean_dollars: null, other_dollars: null, wallets_with_money: null, largest_wallet_share: null, skip_reason: 'contaminated' }),
  row({ game_id: 'cws-hou', kind: 'final', lean_team: null, lean_dollars: null, other_dollars: null, wallets_with_money: null, largest_wallet_share: null, skip_reason: 'moneyline_missing' }),
  row({ game_id: 'tor-bal', postseason: true, note: NOTE, addr: '0x' + 'ab'.repeat(20), wallet: '0x' + 'cd'.repeat(20) }),
];
const routeBody = { date: '2026-10-02', label: LABEL, games: ROWS };
(async () => {
  {
    const h = harness(async () => routeBody);
    await Promise.all([h.x.loadTopTradersCard('2026-10-02'), h.x.loadTopTradersCard('2026-10-02'), h.x.loadTopTradersCardInto('nyy-bos', '2026-10-02')]);
    ok('Matchups and repeated calls for the same date share ONE fetch', h.calls.length === 1 && h.calls[0] === '/top-traders/2026-10-02', JSON.stringify(h.calls));
    await h.x.refreshTopTradersCard('2026-10-02');
    ok('a new games load for the date fetches once more (fresh data per load), and only that', h.calls.length === 2);
    await h.x.loadTopTradersCard('2026-10-03');
    ok('another date gets its own single fetch', h.calls.length === 3 && h.calls[2] === '/top-traders/2026-10-03');
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. rendering from route rows');
  const h = harness(async () => routeBody);
  for (const r of ROWS.concat([{ game_id: 'sea-tex' }])) h.el('tt-lean-' + r.game_id);
  await h.x.refreshTopTradersCard('2026-10-02');
  const slate = (id) => h.els['tt-lean-' + id];
  ok('slate, provisional: "Top traders: NYY (provisional)"', slate('nyy-bos').textContent === 'Top traders: NYY (provisional)' && slate('nyy-bos').style.display === '');
  ok('slate, final + flagged: "Top traders: SD (final) · one wallet ≥75%"', slate('lad-sd').textContent === 'Top traders: SD (final) · one wallet ≥75%');
  ok('slate, a final skip row: "Top traders: no lean (final)"', slate('chc-mil').textContent === 'Top traders: no lean (final)');
  ok('slate, no row: nothing at all (empty and hidden)', slate('sea-tex').textContent === '' && slate('sea-tex').style.display === 'none');
  const d = await h.x.loadTopTradersCard('2026-10-02');
  const text = (gid) => h.x.renderTopTradersCardBody(d, gid).replace(/<div[^>]*>/g, '').split('</div>').filter(Boolean);
  const prov = text('nyy-bos');
  ok('Matchups, provisional: label, lean, both dollar sides, wallets, qualified count, share %, "Provisional (updates before first pitch)"',
    JSON.stringify(prov) === JSON.stringify([LABEL, 'Lean: NYY', 'Net on the lean side: $12,346 · on the other side: −$789', 'Wallets with money: 41 · qualified wallets: 1047',
      'Largest wallet\'s share of the lean side: 62%', 'Provisional (updates before first pitch)']), JSON.stringify(prov));
  const fin = text('lad-sd');
  ok('Matchups, final + flagged: "Final" and the plain flag "One wallet supplies most of this lean."',
    fin.includes('Final') && fin.includes('One wallet supplies most of this lean.') && fin.includes('Largest wallet\'s share of the lean side: 81%'), JSON.stringify(fin));
  ok('Matchups, an unflagged row carries no flag line', !prov.some(l => /One wallet/.test(l)));
  for (const [gid, txt] of [['chc-mil', 'No final lean: odds never locked'], ['phi-atl', 'No final lean: price not usable'], ['cws-hou', 'No final lean: no price recorded']]) {
    ok('Matchups, skip -> "' + txt + '" (no lean, no dollars)', text(gid).includes(txt) && !text(gid).some(l => /^Lean:|Net on the lean/.test(l)), JSON.stringify(text(gid)));
  }
  ok('Matchups, postseason: the route\'s note is shown', text('tor-bal').includes(NOTE));
  ok('Matchups, no row: "No top-trader data for this game."', JSON.stringify(text('sea-tex')) === JSON.stringify(['No top-trader data for this game.']));
  {
    const bad = harness(async () => { throw new Error('HTTP 503'); });
    bad.el('tt-lean-nyy-bos');
    let threw = false;
    try { await bad.x.refreshTopTradersCard('2026-10-02'); await bad.x.loadTopTradersCardInto('nyy-bos', '2026-10-02'); } catch (e) { threw = true; }
    const dd = await bad.x.loadTopTradersCard('2026-10-02');
    ok('route unavailable: nothing thrown, nothing on the slate card, "Top-trader data unavailable" in Matchups',
      !threw && bad.els['tt-lean-nyy-bos'].textContent === '' && bad.x.renderTopTradersCardBody(dd, 'nyy-bos') === '<div>Top-trader data unavailable</div>');
  }
  {
    const h2 = harness(async () => routeBody);
    h2.el('tt-lean-nyy-bos');
    h2.ctx.__date = '2026-10-05';                               // the user moved on to another date before the data arrived
    await h2.x.refreshTopTradersCard('2026-10-02');
    ok('slate lines are not painted onto a grid now showing another date', h2.els['tt-lean-nyy-bos'].textContent === '');
  }

  // ---------------------------------------------------------------- d
  console.log('\nd. label, addresses, figures, styling');
  const allHtml = ROWS.map(r => h.x.renderTopTradersCardBody(d, r.game_id)).join('') + ROWS.map(r => h.x.ttSlateLine(r)).join('');
  ok('the label shown is exactly the route\'s (a random one round-trips)', allHtml.includes(LABEL));
  ok('the page does not carry the label text itself', !/Not used by the model|Tested on 2026 regular season/.test(block));
  ok('no wallet address is rendered, even from a row that carries one', !/0x[0-9a-fA-F]{40}/.test(allHtml));
  ok('the renderer reads only named fields (no generic iteration over a row\'s keys)', !/Object\.(keys|entries|values)\(\s*r\b|for\s*\(\s*const\s+\w+\s+in\s+r\b/.test(block));
  ok('no figure is hard-coded: no dollar amount, share, count or q value literal in the block',
    !/\$\d|\b(1047|76701|0\.\d{3})\b|\b\d{2,3}%/.test(block.replace(/≥75%/, '').replace(/fewer than 25 qualified/, '')));
  ok('neutral styling: no green / red, no colour literal, no background highlight, no bold in the card',
    !/\b(green|red)\b|#[0-9a-f]{3,6}\b|rgb\(|font-weight\s*:\s*(bold|[6-9]00)|<b>|<strong>/i.test(block)
    && !/background:(?!var\(--bg2\))/.test(block));
  ok('the lean is written in the same type as every other line (no size or weight of its own)', /'<div>Lean: '/.test(block));

  // ---------------------------------------------------------------- e
  console.log('\ne. scope and isolation');
  ok('the block calls only /api/top-traders (via api()), no other endpoint and no direct fetch',
    (block.match(/api\(/g) || []).length === 1 && /api\('\/top-traders\/'/.test(block) && !/\bfetch\(|adminGet\(|XMLHttpRequest/.test(block));
  const apiSrc = read('routes/api.js'), jobs = read('services/jobs.js'), model = read('services/model.js');
  ok('routes/api.js, services/jobs.js and services/model.js do not mention the card', !/top-traders-card|TopTradersCard|tt-lean-/.test(apiSrc + jobs + model));
  ok('the page requests the card data in exactly one place (the \'/top-traders/\' literal)', (html.match(/'\/top-traders\/'/g) || []).length === 1);

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
