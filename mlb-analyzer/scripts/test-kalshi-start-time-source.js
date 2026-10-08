#!/usr/bin/env node
'use strict';
// The DH-assignment guard decides only on a doubleheader day.
// (kalshi-start-time-source, 2026-10-08)
//
//   node scripts/test-kalshi-start-time-source.js
//
// Exit 1 on any failure. No network (all fetch is blocked and counted), and
// data/mlb.db is never opened: MLB_DB_PATH points db/schema at a temp file.
//
// WHY. 2026-10-08 CLE @ CWS: "kalshi start-time mismatch ... ticker/event=
// 17:00 ET vs schedule=20:00 ET ... write REJECTED". Kalshi's ticker HHMM is
// the ORIGINALLY scheduled time and never changes, and Kalshi publishes no
// real start time (occurrence_datetime and expected_expiration_time are the
// ticker time + 3h). Polymarket's gameStartTime is the venue's own start and
// is usually right, but also misses MLB's time moves. So:
//   - times agree (±30 min)                 -> accept, as before;
//   - times disagree, ONE game between the
//     two teams today                        -> accept by teams and date, logged;
//   - times disagree on a doubleheader day   -> reject, as before.
//
// THE SLATE (one runOddsJob pass, every venue stubbed BEFORE jobs.js loads,
// because jobs.js destructures them at require time):
//   cle-cws      single game 8:00 PM ET; Kalshi ticker 1700, no real time   (b)
//   hou-tex      single game; Kalshi silent; Poly gameStartTime correct      (a)
//   sea-ath      single game; Kalshi silent; Poly gameStartTime 3h early     (b, Poly)
//   cle-cin(-g2) doubleheader 1:40 / 7:10 PM ET; Kalshi's unsuffixed 1910
//                market lands on game 1; Kalshi's G2 market is correct      (c)
//   pit-nyy(-g2) doubleheader; Kalshi silent; Poly's game-1 quote carries
//                game 2's start                                              (c, Poly)
//   nyy-bos      normal game, Kalshi ticker matches                          (d)

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-start-time-'));
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
const section = (s) => results.push('', s);

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
const calls = { schedule: 0, kalshiLines: 0, poly: 0 };
const GAMES = [
  { game_id: 'cle-cws',    away_team: 'CLE', home_team: 'CWS', time: '8:00 PM ET', game_number: 1 },
  { game_id: 'hou-tex',    away_team: 'HOU', home_team: 'TEX', time: '8:05 PM ET', game_number: 1 },
  { game_id: 'sea-ath',    away_team: 'SEA', home_team: 'ATH', time: '9:40 PM ET', game_number: 1 },
  { game_id: 'cle-cin',    away_team: 'CLE', home_team: 'CIN', time: '1:40 PM ET', game_number: 1 },
  { game_id: 'cle-cin-g2', away_team: 'CLE', home_team: 'CIN', time: '7:10 PM ET', game_number: 2 },
  { game_id: 'pit-nyy',    away_team: 'PIT', home_team: 'NYY', time: '1:05 PM ET', game_number: 1 },
  { game_id: 'pit-nyy-g2', away_team: 'PIT', home_team: 'NYY', time: '7:05 PM ET', game_number: 2 },
  { game_id: 'nyy-bos',    away_team: 'NYY', home_team: 'BOS', time: '7:10 PM ET', game_number: 1 },
];

let scheduleGames = GAMES;   // section e drops a Final game from it
const scraper = require(path.join(R, 'services/scraper'));
scraper.fetchSchedule = async () => {
  calls.schedule++;
  return scheduleGames.map((g) => GAMES.indexOf(g)).map((i) => ({ ...GAMES[i], game_pk: 900000 + i, venue_id: null, venue_name: null,
    away_sp: { name: 'Away Starter ' + i, hand: 'R', id: 100 + i },
    home_sp: { name: 'Home Starter ' + i, hand: 'L', id: 200 + i } }));
};
const kalshi = require(path.join(R, 'services/kalshi'));
const kRow = (game_id, away_team, home_team, start_et) => ({ game_id, away_team, home_team, start_et,
  away: { ask_ml: -150, ask_dollars: 0.60 }, home: { ask_ml: 130, ask_dollars: 0.43 },
  volume_24h_away: 1000, volume_24h_home: 1000 });
let kalshiG2Start = '1910';   // section e gives cle-cin-g2 game 1's time
kalshi.getKalshiMlbLines = async () => {
  calls.kalshiLines++;
  return [
    kRow('cle-cws', 'CLE', 'CWS', '1700'),       // ticker 17:00 ET, MLB 20:00 ET
    kRow('cle-cin', 'CLE', 'CIN', '1910'),       // the nightcap without its G2 suffix
    kRow('cle-cin-g2', 'CLE', 'CIN', kalshiG2Start),   // the nightcap, correctly suffixed
    kRow('nyy-bos', 'NYY', 'BOS', '1910'),       // matches 7:10 PM ET
  ];
};
kalshi.getKalshiMlbTotals = async () => [];
kalshi.getKalshiMlbSpreads = async () => [];
const poly = require(path.join(R, 'services/polymarket'));
poly.getPolymarketMlbLines = async () => {
  calls.poly++;
  const p = (game_id, iso) => ({ game_id, game_start_time_iso: iso,
    away: { top_ask: { price: 0.58 } }, home: { top_ask: { price: 0.44 } }, totals_ladder: [] });
  return [
    p('hou-tex', '2026-10-21T00:05:00Z'),   // 8:05 PM ET, correct
    p('sea-ath', '2026-10-20T22:40:00Z'),   // 6:40 PM ET vs 9:40 PM ET
    p('pit-nyy', '2026-10-20T23:05:00Z'),   // 7:05 PM ET = game 2's start
  ];
};

// ---- console capture --------------------------------------------------------
const logs = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const capture = () => { for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(' ')); };
const release = () => Object.assign(console, real);

(async () => {
  capture();
  try {
    const g = require(path.join(R, 'utils/dh-assignment-guard'));
    const { db } = require(path.join(R, 'db/schema'));
    const jobs = require(path.join(R, 'services/jobs'));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kalshi_direct_primary_enabled','true')").run();

    const res = await jobs.runOddsJob(DATE, { skipChainedMorningCapture: true });
    release();
    const row = (id) => db.prepare('SELECT * FROM game_log WHERE game_date=? AND game_id=?').get(DATE, id);
    const has = (re) => logs.some(l => re.test(l));
    const flagged = (r) => /start-time mismatch|DH-crossed|wrong-leg market/.test((r && r.odds_flag_reason) || '');

    section('0. the run');
    check('runOddsJob succeeded', res && res.success, true);
    check('schedule, Kalshi lines and Poly stubs were reached', [calls.schedule >= 1, calls.kalshiLines, calls.poly], [true, 1, 1]);

    section('a. single game, mismatched ticker, the venue has a correct real start');
    // Kalshi publishes no real start time (measured over the season), so the
    // venue with one is Polymarket: its gameStartTime matches and decides.
    const ht = row('hou-tex');
    check('hou-tex priced from Poly', [ht.ml_source, ht.market_away_ml != null, ht.market_home_ml != null], ['polymarket', true, true]);
    check('...on the time check itself: no teams-and-date note, no flag',
      [has(/\[dh-guard\] polymarket hou-tex/), flagged(ht)], [false, false]);
    check('unit: correct real start accepts with no note whatever the game count',
      [g.checkSourceAssignment(g.parseIsoToEtMin('2026-10-21T00:05:00Z'), g.parseEtWallClockStringMin('8:05 PM ET'), 'polymarket', 'hou-tex', 1),
       g.checkSourceAssignment(g.parseIsoToEtMin('2026-10-21T00:05:00Z'), g.parseEtWallClockStringMin('8:05 PM ET'), 'polymarket', 'hou-tex', 2)],
      [{ rejected: null, note: null }, { rejected: null, note: null }]);

    section('b. single game, no reliable time: accepted by teams and date');
    const cc = row('cle-cws');
    check('cle-cws (ticker 17:00 ET, MLB 20:00 ET) priced from Kalshi',
      [cc.ml_source, cc.market_away_ml != null, cc.market_home_ml != null], ['kalshi', true, true]);
    check('...not flagged as DH-crossed', flagged(cc), false);
    check('...and the log says it was matched by teams and date',
      has(/\[dh-guard\] kalshi cle-cws matched by teams and date: ticker\/event 17:00 ET vs schedule 20:00 ET \(Δ=-180 min\)/), true);
    check('...and no REJECTED line for it', has(/start-time mismatch for cle-cws/), false);
    const sa = row('sea-ath');
    check('sea-ath (Poly gameStartTime 3h early, single game) priced from Poly', sa.ml_source, 'polymarket');
    check('...not flagged, logged as matched by teams and date',
      [flagged(sa), has(/\[dh-guard\] polymarket sea-ath matched by teams and date/)], [false, true]);

    section('c. a real doubleheader: the other game\'s market is still rejected');
    const c1 = row('cle-cin'), c2 = row('cle-cin-g2');
    check('cle-cin (game 1, 1:40 PM ET) does NOT take the unsuffixed 19:10 market',
      [c1.ml_source, c1.market_away_ml, c1.market_home_ml], [null, null, null]);
    check('...and is stamped with the DH-crossed rejection',
      /kalshi start-time mismatch for cle-cin: ticker\/event=19:10 ET vs schedule=13:40 ET .*write REJECTED/.test(c1.odds_flag_reason || ''), true);
    check('...no teams-and-date note for it', has(/\[dh-guard\] kalshi cle-cin matched/), false);
    check('cle-cin-g2 takes its own correctly suffixed market', [c2.ml_source, flagged(c2)], ['kalshi', false]);
    const p1 = row('pit-nyy'), p2 = row('pit-nyy-g2');
    check('Poly: pit-nyy (game 1) does NOT take a quote carrying game 2\'s start',
      [p1.ml_source, p1.market_away_ml, flagged(p1)], [null, null, true]);
    check('...the flag names Polymarket', /polymarket start-time mismatch for pit-nyy/.test(p1.odds_flag_reason || ''), true);
    check('pit-nyy-g2 untouched (nobody quoted it)', [p2.ml_source, flagged(p2)], [null, false]);
    check('unit: a mismatch on a doubleheader day (2 games) or an unknown count (0) rejects',
      [!!g.checkSourceAssignment(1150, 820, 'kalshi', 'x', 2).rejected, !!g.checkSourceAssignment(1150, 820, 'kalshi', 'x', 0).rejected,
       g.checkSourceAssignment(1150, 820, 'kalshi', 'x', 2).rejected === g.checkSourceStartMatchesSchedule(1150, 820, 'kalshi', 'x')],
      [true, true, true]);

    section('d. a normal game with matching times is unchanged');
    const nb = row('nyy-bos');
    check('nyy-bos priced from Kalshi, no flag, no note',
      [nb.ml_source, flagged(nb), has(/\[dh-guard\] kalshi nyy-bos/)], ['kalshi', false, false]);
    check('Kalshi wrote the same fee-adjusted prices on nyy-bos and cle-cws (same stub quote)',
      [nb.market_away_ml, nb.market_home_ml], [cc.market_away_ml, cc.market_home_ml]);
    check('unit: within ±30 min the decision is the old one, with no note',
      [[815, 785], [816, 785], [1150, 1150]].map(([s, t]) => {
        const r = g.checkSourceAssignment(s, t, 'kalshi', 'x', 2);
        return [!!r.rejected, r.note];
      }),
      [[false, null], [true, null], [false, null]]);

    section('e. counting games between two teams');
    const log = [{ game_id: 'bal-bos', away_team: 'BAL', home_team: 'BOS' }, { game_id: 'bal-bos-g2', away_team: 'BAL', home_team: 'BOS' }];
    const schedAfterG1Final = [{ game_id: 'bal-bos-g2', away_team: 'BAL', home_team: 'BOS' }];   // fetchSchedule drops Finals
    check('a doubleheader still counts 2 after game 1 is final (game_log rows + schedule)',
      g.countGamesBetween('BAL', 'BOS', log, schedAfterG1Final), 2);
    check('the schedule alone would have said 1', g.countGamesBetween('BAL', 'BOS', schedAfterG1Final), 1);
    check('home/away order and case are ignored, ids de-duplicated',
      [g.countGamesBetween('bos', 'bal', log, log), g.countGamesBetween('BAL', 'NYY', log), g.countGamesBetween(null, 'BOS', log)], [2, 0, 0]);
    // Second pass: game 1 of cle-cin is Final, so fetchSchedule no longer
    // returns it (and the odds job no longer prices it: oddsRaw is seeded
    // from the schedule). Game 2 is still on the schedule, and its market
    // now carries game 1's 13:40 time. Only game 1's game_log row says there
    // are two games today: counting from the schedule alone would say 1 and
    // accept the market by teams and date. (jobs.js holds the stubs from
    // load time, so they read these variables rather than being replaced.)
    scheduleGames = GAMES.filter(x => x.game_id !== 'cle-cin');
    kalshiG2Start = '1340';
    logs.length = 0;
    capture();
    const res2 = await jobs.runOddsJob(DATE, { skipChainedMorningCapture: true });
    release();
    check('the odds job counts game_log rows too: after game 1 leaves the schedule, a game-2 market with game 1\'s time is still rejected',
      [res2 && res2.success && !has(/\[bootstrap\] cle-cin write/),
       has(/kalshi start-time mismatch for cle-cin-g2: ticker\/event=13:40 ET vs schedule=19:10 ET .*write REJECTED/),
       has(/\[dh-guard\] kalshi cle-cin-g2 matched/)],
      [true, true, false]);
    check('no network was attempted by the guard path', netCalls.filter(u => /kalshi|polymarket|statsapi/i.test(u)), []);

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
