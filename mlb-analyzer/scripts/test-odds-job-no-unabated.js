#!/usr/bin/env node
'use strict';
// runOddsJob end to end with every fetch stubbed, on a throwaway database,
// after the Unabated removal. (2026-09-17)
//
//   node scripts/test-odds-job-no-unabated.js
//
// Exit 1 on any failure. No network (all fetch is blocked and counted), and
// data/mlb.db is never opened: MLB_DB_PATH points db/schema at a temp file.
//
// WHY A REAL RUN AND NOT SOURCE ASSERTIONS. The other odds tests read
// jobs.js as text. This removal changes what reaches processOddsArray, and
// two of the defects it could introduce produce no error at all: the ML
// cross-check going dark (single-source on every row) and the runline
// columns going NULL. Only running the job shows those.
//
// STUBS ARE INSTALLED BEFORE jobs.js IS REQUIRED. jobs.js destructures
// getKalshiMlb*, getPolymarketMlbLines and fetchSchedule at require time, so
// swapping them afterwards would be invisible (CLAUDE.md review checklist).
// Every stub counts its calls and the test asserts they were reached.
//
// THE SLATE, four games, each built to exercise one path:
//   nyy-bos  Kalshi ML + totals + 1.5 spreads; Poly quotes ML + total.
//            A Kalshi line 8.5 is PERSISTED from an earlier pass while this
//            pass's auto rung is 9.5 -> sticky rung holds 8.5.
//            Pre-seeded unabated_total/xcheck_total must be left untouched.
//   lad-sf   Kalshi ML + totals, auto rung 7.5; Poly does not quote it;
//            its 1.5 spread price is insane -> runline refused.
//   hou-tex  Kalshi silent; Poly ML + total, no Kalshi line anywhere ->
//            liquidity_fallback, NO KALSHI ANCHOR warning.
//   sea-ath  Kalshi silent this pass but a Kalshi total 9.5 is persisted ->
//            Poly anchors on it (persisted), not on liquidity.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-no-unabated-'));
process.env.MLB_DB_PATH = path.join(TMP, 'test.db');
delete process.env.RENDER;

let failures = 0;
const results = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  results.push('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}

// ---- network: blocked and counted ---------------------------------------
const netCalls = [];
global.fetch = async (url) => { netCalls.push(String(url)); throw new Error('network blocked in test: ' + url); };
{
  const nf = require.resolve('node-fetch', { paths: [R] });
  require.cache[nf] = { id: nf, filename: nf, loaded: true,
    exports: async (url) => { netCalls.push(String(url)); throw new Error('network blocked in test: ' + url); } };
}

// ---- stubs, BEFORE jobs.js ------------------------------------------------
const DATE = '2026-10-20';
const calls = { schedule: 0, kalshiLines: 0, kalshiTotals: 0, kalshiSpreads: 0, poly: 0 };
const GAMES = [
  { game_id: 'nyy-bos', away_team: 'NYY', home_team: 'BOS' },
  { game_id: 'lad-sf',  away_team: 'LAD', home_team: 'SF' },
  { game_id: 'hou-tex', away_team: 'HOU', home_team: 'TEX' },
  { game_id: 'sea-ath', away_team: 'SEA', home_team: 'ATH' },
];
const START_TXT = '7:05 PM ET', START_HHMM = '1905', START_ISO = DATE + 'T23:05:00Z';
let spreadsSilent = false;

const scraper = require(path.join(R, 'services/scraper'));
scraper.fetchSchedule = async () => {
  calls.schedule++;
  return GAMES.map((g, i) => ({ ...g, time: START_TXT, game_number: 1, game_pk: 900000 + i,
    venue_id: null, venue_name: null,
    away_sp: { name: 'Away Starter ' + i, hand: 'R', id: 100 + i },
    home_sp: { name: 'Home Starter ' + i, hand: 'L', id: 200 + i } }));
};
const kalshi = require(path.join(R, 'services/kalshi'));
kalshi.getKalshiMlbLines = async () => {
  calls.kalshiLines++;
  return ['nyy-bos', 'lad-sf'].map(id => {
    const g = GAMES.find(x => x.game_id === id);
    return { game_id: id, away_team: g.away_team, home_team: g.home_team, start_et: START_HHMM,
      away: { ask_ml: -150, ask_dollars: 0.60 }, home: { ask_ml: 130, ask_dollars: 0.43 },
      volume_24h_away: 1000, volume_24h_home: 1000 };
  });
};
kalshi.getKalshiMlbTotals = async () => {
  calls.kalshiTotals++;
  return [
    { game_id: 'nyy-bos', away_team: 'NYY', home_team: 'BOS', line: 9.5, implied_total: 9.4,
      over: { ask_dollars: 0.50 }, under: { ask_dollars: 0.52 },
      ladder: [{ strike: 8.5, over_ask: 0.58, under_ask: 0.45 }, { strike: 9.5, over_ask: 0.50, under_ask: 0.52 }] },
    { game_id: 'lad-sf', away_team: 'LAD', home_team: 'SF', line: 7.5, implied_total: 7.5,
      over: { ask_dollars: 0.50 }, under: { ask_dollars: 0.52 },
      ladder: [{ strike: 7.5, over_ask: 0.50, under_ask: 0.52 }] },
  ];
};
kalshi.getKalshiMlbSpreads = async () => {
  calls.kalshiSpreads++;
  if (spreadsSilent) return [];
  const row = (gid, team, yes, yesMl, noMl) => ({ game_date: DATE, game_id: gid, spread_team: team,
    spread_line: 1.5, yes_ask_dollars: yes, yes_bid_dollars: null, no_ask_dollars: 1 - yes, no_bid_dollars: null,
    yes_ask_ml: yesMl, no_ask_ml: noMl, volume_24h: 10, event_ticker: 'E-' + gid, ticker: 'T-' + gid + team });
  return [
    row('nyy-bos', 'NYY', 0.45, 120, -145),   // NYY more likely to win by 2 -> NYY -1.5
    row('nyy-bos', 'BOS', 0.30, 230, -290),
    row('lad-sf', 'LAD', 0.40, 99900, -150),  // insane YES price -> refused
    row('lad-sf', 'SF', 0.20, 99900, -150),
  ];
};
const poly = require(path.join(R, 'services/polymarket'));
poly.getPolymarketMlbLines = async () => {
  calls.poly++;
  const q = (gid, ladder) => ({ game_id: gid, game_start_time_iso: START_ISO,
    away: { top_ask: { price: 0.58 } }, home: { top_ask: { price: 0.44 } }, totals_ladder: ladder });
  const rung = (strike, liq) => ({ strike, over_price_str: '0.50', under_price_str: '0.52', market_liquidity_clob: liq });
  return [
    q('nyy-bos', [rung(8.5, 50), rung(9.5, 60)]),
    q('hou-tex', [rung(7.5, 100), rung(8.5, 900)]),   // no Kalshi line -> liquidity 8.5
    q('sea-ath', [rung(8.5, 900), rung(9.5, 5)]),     // persisted Kalshi 9.5 beats liquidity
  ];
};

// ---- console capture --------------------------------------------------------
const logs = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const capture = () => { for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(' ')); };
const release = () => Object.assign(console, real);

(async () => {
  capture();
  let jobs, db, runResult1, runResult2;
  try {
    ({ db } = require(path.join(R, 'db/schema')));
    jobs = require(path.join(R, 'services/jobs'));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kalshi_direct_primary_enabled','true')").run();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kalshi_direct_totals_enabled','true')").run();
    // Earlier-pass state: persisted Kalshi totals, plus Unabated-era reference
    // values that nothing may touch now.
    const seed = db.prepare("INSERT INTO game_log (game_date, game_id, away_team, home_team, game_time, "
      + "market_total, over_price, under_price, total_source, unabated_total, xcheck_total) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    seed.run(DATE, 'nyy-bos', 'NYY', 'BOS', START_TXT, 8.5, -115, -105, 'kalshi', 99, 42);
    seed.run(DATE, 'sea-ath', 'SEA', 'ATH', START_TXT, 9.5, -110, -110, 'kalshi', null, null);

    const row = (id) => db.prepare('SELECT * FROM game_log WHERE game_date=? AND game_id=?').get(DATE, id);
    runResult1 = await jobs.runOddsJob(DATE, { skipChainedMorningCapture: true });
    const pass1Logs = logs.length;
    // Pass-1 state, read BEFORE pass 2 runs.
    const a1 = row('nyy-bos'), b1 = row('lad-sf'), c1 = row('hou-tex'), d1 = row('sea-ath');
    spreadsSilent = true;
    runResult2 = await jobs.runOddsJob(DATE, { skipChainedMorningCapture: true });

    release();
    const log1 = logs.slice(0, pass1Logs);
    const log2 = logs.slice(pass1Logs);
    const has = (re, arr) => (arr || logs).some(l => re.test(l));

    console.log('1. the stubs were reached and nothing Unabated remains');
    check('schedule / kalshi lines / totals / spreads / poly were each called on both passes',
      [calls.schedule >= 2, calls.kalshiLines, calls.kalshiTotals, calls.kalshiSpreads, calls.poly], [true, 2, 2, 2, 2]);
    check('services/unabated.js is gone from the tree', fs.existsSync(path.join(R, 'services/unabated.js')), false);
    check('and was never loaded', Object.keys(require.cache).some(k => /[\\/]unabated\.js$/.test(k)), false);
    check('no Unabated fetch was attempted', netCalls.filter(u => /unabated/i.test(u)), []);
    check('both passes succeeded', [runResult1 && runResult1.success, runResult2 && runResult2.success], [true, true]);

    console.log('');
    console.log('2. ML: Kalshi first, Poly second, cross-check on the Poly quote');
    check('nyy-bos / lad-sf ML from Kalshi, hou-tex / sea-ath from Poly',
      [a1.ml_source, b1.ml_source, c1.ml_source, d1.ml_source], ['kalshi', 'kalshi', 'polymarket', 'polymarket']);
    check('nyy-bos has a Poly quote -> NOT flagged single-source',
      /single-source, no cross-check available/.test(a1.odds_flag_reason || ''), false);
    check('lad-sf has no Poly quote -> flagged single-source',
      /single-source, no cross-check available/.test(b1.odds_flag_reason || ''), true);
    check('Poly-primary hou-tex has no second book -> single-source',
      /single-source, no cross-check available/.test(c1.odds_flag_reason || ''), true);

    console.log('');
    console.log('3. totals: sticky Kalshi rung, Poly anchor paths, per-pass counts');
    check('nyy-bos holds the PERSISTED Kalshi rung 8.5 over the auto 9.5', [a1.market_total, a1.total_source], [8.5, 'kalshi']);
    check('lad-sf takes the auto rung 7.5 (nothing persisted)', [b1.market_total, b1.total_source], [7.5, 'kalshi']);
    check('hou-tex: Poly at the liquidity rung 8.5', [c1.market_total, c1.total_source], [8.5, 'polymarket']);
    check('sea-ath: Poly anchored on the persisted Kalshi 9.5, not liquidity 8.5', [d1.market_total, d1.total_source], [9.5, 'polymarket']);
    check('NO KALSHI ANCHOR warns for hou-tex on pass 1', has(/NO KALSHI ANCHOR for hou-tex/, log1), true);
    check('...and not for sea-ath', has(/NO KALSHI ANCHOR for sea-ath/, log1), false);
    check('per-row anchor line names the source', has(/\[poly-anchor-row\] sea-ath .*kalshi_line=9\.5\(persisted\)/, log1), true);
    const cron = db.prepare("SELECT message FROM cron_log WHERE job_type='odds' AND run_date=? ORDER BY id").all(DATE);
    check('two odds cron rows', cron.length, 2);
    check('pass-1 cron message carries the anchor counts',
      /poly totals by anchor: kalshi pass=0 persisted=1 liquidity_fallback=1; kalshi totals rung: persisted=1 auto=1/.test(cron[0] && cron[0].message), true);
    check('[odds] pass summary logged with the NO KALSHI ANCHOR count', has(/\[odds\] pass summary 2026-10-20: .*PRICED WITH NO KALSHI ANCHOR/, log1), true);
    check('no xcheck totals arm is logged', has(/arm=xcheck/), false);

    // KNOWN GAP, pre-existing (#369), pinned so a fix must update this test.
    // The persisted-Kalshi anchor reads existing.total_source === 'kalshi'.
    // Pass 1 prices sea-ath from that persisted 9.5 and writes it with
    // total_source 'polymarket' -- which ERASES the marker. Pass 2, Kalshi
    // still silent, finds no persisted Kalshi line and falls to liquidity:
    // the line flips 9.5 -> 8.5. With Unabated gone this anchor is the only
    // reference, so the gap matters more than it did. Not fixed here.
    const d2 = row('sea-ath');
    check('KNOWN GAP: sea-ath pass 2 loses the persisted anchor once Poly owned the row (9.5 -> 8.5)',
      [d2.market_total, d2.total_source, has(/NO KALSHI ANCHOR for sea-ath/, log2)], [8.5, 'polymarket', true]);
    check('nyy-bos: Poly comparison runs against Kalshi (not single-source total)',
      /single-source total/.test(a1.odds_flag_reason || ''), false);

    console.log('');
    console.log('4. runline from Kalshi 1.5 markets, COALESCE on a silent pass');
    const a2 = row('nyy-bos'), b2 = row('lad-sf');
    check('pass 1: NYY lays -1.5 (higher YES ask), src kalshi, quality fresh',
      [a1.market_away_spread, a1.market_home_spread, a1.market_spread_src, a1.market_away_spread_quality],
      [-1.5, 1.5, 'kalshi', 'fresh']);
    check('pass 1: prices are the fee-adjusted YES (fav) and NO (dog) asks, both sane',
      [typeof a1.market_away_spread_price, Math.abs(a1.market_away_spread_price) <= 400,
       Math.abs(a1.market_home_spread_price) <= 400, a1.market_away_spread_price > 0, a1.market_home_spread_price < 0],
      ['number', true, true, true, true]);
    check('lad-sf: insane price -> runline refused, nothing written', [b1.market_away_spread, b1.market_spread_src], [null, null]);
    check('pass 1 logs the refusal', has(/Kalshi runline: 1\/4 .*refused: lad-sf/, log1), true);
    check('pass 2 (Kalshi spreads silent): runline KEPT, quality drops to null',
      [a2.market_away_spread, a2.market_away_spread_price, a2.market_spread_src, a2.market_away_spread_quality],
      [-1.5, a1.market_away_spread_price, 'kalshi', null]);
    check('lad-sf stays empty on pass 2', b2.market_away_spread, null);

    console.log('');
    console.log('5. the Unabated-era columns stay, and nothing writes them');
    check('nyy-bos unabated_total / xcheck_total untouched', [a2.unabated_total, a2.xcheck_total], [99, 42]);
    check('no other game gained one', [b2.unabated_total, b2.xcheck_total, row('hou-tex').xcheck_total], [null, null, null]);
    check('no odds snapshot directory was written for the date',
      fs.existsSync(path.join(R, 'data', 'snapshots', DATE)) && fs.readdirSync(path.join(R, 'data', 'snapshots', DATE)).some(f => /^odds/.test(f)), false);

    console.log(results.join('\n'));
  } catch (e) {
    release();
    console.error('TEST HARNESS ERROR: ' + (e && e.stack || e));
    failures++;
  } finally {
    release();
    if (failures) {
      console.log('\n--- captured job output (' + logs.length + ' lines) ---');
      for (const l of logs.slice(-120)) console.log('   ' + l);
    }
    try { require(path.join(R, 'db/schema')).db.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed')
      + '   (network attempts blocked: ' + netCalls.length + ')');
    process.exit(failures ? 1 : 0);
  }
})();
