#!/usr/bin/env node
'use strict';
/**
 * Score-job retry + daily score catch-up (#505, 2026-10-02), on a throwaway
 * database and a FAKE statsapi (no network). The real runScoreJob and the real
 * catch-up run end to end; node-fetch and the first-pitch feed are replaced
 * before any module loads them, and every function export of the model,
 * weather, Kalshi, Polymarket and scraper modules is wrapped in a spy.
 *
 *   a. a transient error (ETIMEDOUT, 5xx, 429) is retried and then succeeds;
 *      a 4xx other than 429 is not retried; giving up after the last attempt
 *      is logged. Every retry writes a cron_log row.
 *   b. the catch-up finds a date with finished-but-unscored games and a date
 *      with no score run logged, and runs the score job for each (and grades
 *      the locked bet on the first).
 *   c. the catch-up never calls model, odds, weather, lineup or signal code
 *      (spies + source check), never re-runs a fully scored date, and skips
 *      postponed duplicates, removed rows and placeholders.
 *   d. a date that stays unscored is a 'scores_catchup' warning in
 *      GET /api/health/:date, once.
 *
 *   node scripts/test-score-retry-catchup.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__score_catchup_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), '__score_catchup_cwd_'));
process.chdir(TMP_CWD);                                          // score snapshots (data/snapshots under cwd) land here, not in the repo
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- fake statsapi
const TODAY = '2026-09-10';
const NAMES = { NYM: 'New York Mets', TB: 'Tampa Bay Rays', NYY: 'New York Yankees', LAA: 'Los Angeles Angels', SEA: 'Seattle Mariners',
  TEX: 'Texas Rangers', BOS: 'Boston Red Sox', TOR: 'Toronto Blue Jays', BAL: 'Baltimore Orioles', CHC: 'Chicago Cubs', MIL: 'Milwaukee Brewers',
  LAD: 'Los Angeles Dodgers', SD: 'San Diego Padres', CLE: 'Cleveland Guardians', KC: 'Kansas City Royals' };
let pk = 5000;
const sg = (date, away, home, as, hs, status, o) => Object.assign({ gamePk: ++pk, gameType: 'R', officialDate: (o && o.official) || date,
  gameDate: date + 'T23:05:00Z', gameNumber: 1,
  status: { detailedState: status || 'Final', abstractGameState: /^(Final|Completed|Game Over|Postponed|Cancelled)/.test(status || 'Final') ? 'Final' : 'Live' },
  teams: { away: { team: { abbreviation: away, name: NAMES[away] }, score: as }, home: { team: { abbreviation: home, name: NAMES[home] }, score: hs } } }, (o && o.extra) || {});
const SCHED = {
  // sea-tex: a finished game the score job cannot score -- its away team name is one the parser's TEAM_MAP does not
  // know (the All-Star mechanism). It was a "Completed Early" game until #504 taught the score job to score those.
  '2026-09-04': [sg('2026-09-04', 'SEA', 'TEX', 6, 2), sg('2026-09-04', 'BOS', 'TOR', 3, 1)],
  '2026-09-05': [sg('2026-09-05', 'CLE', 'KC', 5, 4)],
  '2026-09-06': [sg('2026-09-06', 'LAD', 'SD', 2, 1)],
  '2026-09-07': [sg('2026-09-07', 'CHC', 'MIL', 4, 3), sg('2026-09-07', 'TOR', 'BAL', null, null, 'Postponed', { official: '2026-09-08' })],
  '2026-09-08': [sg('2026-09-08', 'NYM', 'TB', 10, 4), sg('2026-09-08', 'NYY', 'LAA', 6, 3)],
  '2026-09-09': [sg('2026-09-09', 'LAD', 'SD', 7, 0)],
};
SCHED['2026-09-04'][0].teams.away.team.name = 'Seattle Mariners (unmapped name)';
const net = { urls: [], foreign: [], plan: [] };      // plan: queued failures for the score fetch, consumed in order
function jsonResp(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function sockErr(code) { const e = new Error('request to https://statsapi.mlb.com/ failed, reason: connect ' + code); e.code = code; e.type = 'system'; return e; }
async function fakeFetch(url) {
  net.urls.push(String(url));
  const u = new URL(String(url));
  if (u.hostname !== 'statsapi.mlb.com') { net.foreign.push(String(url)); throw new Error('test: network to ' + u.hostname + ' is forbidden'); }
  const hydrate = u.searchParams.get('hydrate') || '';
  let d = u.searchParams.get('date') || '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) d = d.slice(6) + '-' + d.slice(0, 2) + '-' + d.slice(3, 5);
  if (hydrate === 'linescore' && net.plan.length) {                // the score fetch (fetchScoresRaw)
    const step = net.plan.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'number') return jsonResp(step, {});
  }
  if (/pitchers/.test(hydrate)) return jsonResp(200, { dates: [] });   // pitcher usage: nothing to record
  return jsonResp(200, { dates: SCHED[d] ? [{ date: d, games: SCHED[d] }] : [] });
}
// node-fetch is replaced in the require cache BEFORE scraper / jobs load it.
const nfPath = require.resolve('node-fetch', { paths: [R] });
const fakeMod = new Module(nfPath); fakeMod.filename = nfPath; fakeMod.loaded = true; fakeMod.exports = fakeFetch;
fakeFetch.default = fakeFetch;
require.cache[nfPath] = fakeMod;
const realGlobalFetch = globalThis.fetch;
globalThis.fetch = async (url) => { net.foreign.push('global fetch: ' + url); throw new Error('test: global fetch is forbidden'); };

// ---------------------------------------------------------------- spies
const spied = {};
function spyOn(rel, label) {
  const m = require(path.join(R, rel));
  for (const k of Object.keys(m)) {
    const orig = m[k];
    if (typeof orig !== 'function') continue;
    m[k] = function (...a) { (spied[label] = spied[label] || []).push(k); return new.target ? Reflect.construct(orig, a, new.target) : orig.apply(this, a); };
  }
}
const firstPitch = require(path.join(R, 'services/first-pitch'));
firstPitch.fetchFirstPitch = async () => null;                    // the feed: nothing (refreshFirstPitch is non-fatal)
spyOn('services/model', 'model');
spyOn('services/weather', 'weather');
spyOn('services/kalshi', 'kalshi');
spyOn('services/polymarket', 'polymarket');
spyOn('services/scraper', 'scraper');

const schema = require(path.join(R, 'db/schema'));
const { db } = schema;
const jobs = require(path.join(R, 'services/jobs'));
const { isTransient } = require(path.join(R, 'utils/transient-retry'));

// ---------------------------------------------------------------- the throwaway database
function addRow(r) {
  const o = Object.assign({ game_number: 1, away_score: null, home_score: null, game_status: null, is_removed: 0,
    scheduled_start_utc: r.game_date + 'T23:05:00Z', first_pitch_utc: r.game_date + 'T23:06:00.000Z' }, r);
  const cols = Object.keys(o);
  db.prepare('INSERT INTO game_log (' + cols.join(', ') + ') VALUES (' + cols.map(c => '@' + c).join(', ') + ')').run(o);
}
const row = (d, id, away, home, extra) => Object.assign({ game_date: d, game_id: id, away_team: away, home_team: home }, extra || {});
const pkOf = (d, away) => SCHED[d].find(g => g.teams.away.team.abbreviation === away).gamePk;
// 09-04: a finished game the score job cannot score (an unmapped team name, see SCHED), plus a scored game. Run logged.
addRow(row('2026-09-04', 'sea-tex', 'SEA', 'TEX', { game_pk: pkOf('2026-09-04', 'SEA'), game_status: 'Final' }));
addRow(row('2026-09-04', 'bos-tor', 'BOS', 'TOR', { game_pk: pkOf('2026-09-04', 'BOS'), away_score: 3, home_score: 1, game_status: 'Final' }));
// 09-05: scored, but NO score run logged (the 9/02 pattern) -- e.g. pitcher usage never recorded.
addRow(row('2026-09-05', 'cle-kc', 'CLE', 'KC', { game_pk: pkOf('2026-09-05', 'CLE'), away_score: 5, home_score: 4, game_status: 'Final' }));
// 09-06 and 09-09: fully scored, run logged. Must never be re-run.
addRow(row('2026-09-06', 'lad-sd', 'LAD', 'SD', { game_pk: pkOf('2026-09-06', 'LAD'), away_score: 2, home_score: 1, game_status: 'Final' }));
addRow(row('2026-09-09', 'lad-sd', 'LAD', 'SD', { game_pk: pkOf('2026-09-09', 'LAD'), away_score: 7, home_score: 0, game_status: 'Final' }));
// 09-07: scored real game + an unscored POSTPONED duplicate, PLACEHOLDER and REMOVED row. Run logged. Must not be re-run.
addRow(row('2026-09-07', 'chc-mil', 'CHC', 'MIL', { game_pk: pkOf('2026-09-07', 'CHC'), away_score: 4, home_score: 3, game_status: 'Final' }));
addRow(row('2026-09-07', 'tor-bal', 'TOR', 'BAL', { game_pk: pkOf('2026-09-07', 'TOR'), game_status: 'Scheduled' }));
addRow(row('2026-09-07', 'atl/phi-lad', 'ATL/PHI', 'LAD', { game_status: 'Scheduled' }));
addRow(row('2026-09-07', 'nyy-bos', 'NYY', 'BOS', { is_removed: 1 }));
// 09-08: both games finished in statsapi, unscored here, statuses stuck mid-slate; the score run ERRORED (the 7/23 pattern).
addRow(row('2026-09-08', 'nym-tb', 'NYM', 'TB', { game_pk: pkOf('2026-09-08', 'NYM'), game_status: 'In Progress' }));
addRow(row('2026-09-08', 'nyy-laa', 'NYY', 'LAA', { game_pk: pkOf('2026-09-08', 'NYY'), game_status: 'Scheduled' }));
// 09-01: unscored, but outside the 7-day window. Must not be touched.
addRow(row('2026-09-01', 'sea-tex', 'SEA', 'TEX', { game_status: 'Scheduled' }));
const glId = (d, id) => db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(d, id).id;
db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, bet_line, is_active, outcome)
  VALUES (?, '2026-09-08', 'nym-tb', 'ML', 'home', 'ml', -150, -150, 1, 'pending')`).run(glId('2026-09-08', 'nym-tb'));
for (const [d, st] of [['2026-09-04', 'success'], ['2026-09-06', 'success'], ['2026-09-07', 'success'], ['2026-09-08', 'error'], ['2026-09-09', 'success'],
  ['2026-09-01', 'error']]) {
  schema.q.logCron.run('scores', d, st, st === 'error' ? 'request to https://statsapi.mlb.com/... failed, reason: connect ETIMEDOUT' : 'seeded', 0);
}
const cronRows = (type, d) => db.prepare('SELECT status, message, games_skipped_ids FROM cron_log WHERE job_type = ?' + (d ? ' AND run_date = ?' : '') + ' ORDER BY id').all(...[type].concat(d ? [d] : []));
const score = (d, id) => { const r = db.prepare('SELECT away_score, home_score FROM game_log WHERE game_date = ? AND game_id = ?').get(d, id); return r.away_score + '-' + r.home_score; };

function getJson(port, p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let s = ''; r.on('data', c => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
  }).on('error', rej));
}

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. the score fetch retries transient failures only, and logs every retry');
  {
    ok('transient: ETIMEDOUT, ECONNRESET, socket hang up, node-fetch timeout, HTTP 500/502/503, 429',
      [sockErr('ETIMEDOUT'), sockErr('ECONNRESET'), new Error('socket hang up'), Object.assign(new Error('network timeout at: x'), { type: 'request-timeout' }),
        { status: 500 }, { status: 502 }, { status: 503 }, { status: 429 }].every(isTransient));
    ok('not transient: HTTP 400/401/403/404, a JSON parse error, nothing',
      ![{ status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, new SyntaxError('Unexpected token < in JSON'), null].some(isTransient));
    ok('the retry policy is 3 attempts, waiting 30s then 120s', JSON.stringify(jobs.SCORE_RETRY_DELAYS_MS) === '[30000,120000]');

    // through fetchScoresWithRetry, with the real fetchScoresRaw on the fake statsapi and a recorded sleep
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    const D = '2026-09-06';
    net.plan = [sockErr('ETIMEDOUT')];
    const r1 = await jobs.fetchScoresWithRetry(D, { sleep });
    ok('ETIMEDOUT once, then success: 2 attempts, one 30s wait, payload returned',
      r1.attempts === 2 && JSON.stringify(sleeps) === '[30000]' && r1.value.dates[0].games.length === 1, JSON.stringify({ attempts: r1.attempts, sleeps }));
    ok('the retry is logged to cron_log (scores-retry / retry)', cronRows('scores-retry', D).length === 1 && cronRows('scores-retry', D)[0].status === 'retry'
      && /attempt 1\/3 failed .*ETIMEDOUT.*retrying in 30s/.test(cronRows('scores-retry', D)[0].message), JSON.stringify(cronRows('scores-retry', D)));

    sleeps.length = 0; net.plan = [404];
    const n0 = net.urls.length;
    let e404 = null; try { await jobs.fetchScoresWithRetry('2026-09-05', { sleep }); } catch (e) { e404 = e; }
    ok('HTTP 404 is not retried: one request, no wait, no retry row, error thrown with status 404',
      e404 && e404.status === 404 && net.urls.length - n0 === 1 && sleeps.length === 0 && cronRows('scores-retry', '2026-09-05').length === 0);

    sleeps.length = 0; net.plan = [503, 429, sockErr('ECONNRESET')];
    let eGive = null; try { await jobs.fetchScoresWithRetry('2026-09-04', { sleep }); } catch (e) { eGive = e; }
    const rows = cronRows('scores-retry', '2026-09-04');
    ok('503, 429, ECONNRESET: 3 attempts (30s, 120s waits), then gives up',
      eGive && eGive.attempts === 3 && JSON.stringify(sleeps) === '[30000,120000]', JSON.stringify({ attempts: eGive && eGive.attempts, sleeps }));
    ok('both retries and the give-up are logged to cron_log', rows.map(r => r.status).join(',') === 'retry,retry,gave-up'
      && /gave up after 3 attempts: .*ECONNRESET/.test(rows[2].message), JSON.stringify(rows.map(r => r.status + ': ' + r.message)));

    // end to end through runScoreJob: the outcome lands in its 'scores' row. The waits are shortened in place
    // (runScoreJob reads this array), then restored.
    const saved = jobs.SCORE_RETRY_DELAYS_MS.slice();
    jobs.SCORE_RETRY_DELAYS_MS.splice(0, 2, 5, 5);
    try {
      net.plan = [500];
      const before = cronRows('scores', '2026-09-06').length;
      const ok1 = await jobs.runScoreJob('2026-09-06');
      const last = cronRows('scores', '2026-09-06').slice(-1)[0];
      ok('runScoreJob: a 500 then success -> success row says it succeeded on attempt 2',
        ok1.success && cronRows('scores', '2026-09-06').length === before + 1 && last.status === 'success' && /succeeded on attempt 2/.test(last.message), last && last.message);
      net.plan = [502, 502, 502];
      const bad = await jobs.runScoreJob('2026-09-06');
      const last2 = cronRows('scores', '2026-09-06').slice(-1)[0];
      ok('runScoreJob: three 502s -> error row "(after 3 attempts)" and a gave-up row',
        bad.success === false && last2.status === 'error' && /MLB API error: 502 \(after 3 attempts\)/.test(last2.message)
        && cronRows('scores-retry', '2026-09-06').slice(-1)[0].status === 'gave-up', last2 && last2.message);
      net.plan = [403];
      const n1 = net.urls.length;
      const forb = await jobs.runScoreJob('2026-09-06');
      const last3 = cronRows('scores', '2026-09-06').slice(-1)[0];
      ok('runScoreJob: a 403 fails at once, error row has no attempts suffix',
        forb.success === false && last3.message === 'MLB API error: 403' && net.urls.filter((u, i) => i >= n1 && /hydrate=linescore(&|$)/.test(u)).length === 1, last3 && last3.message);
    } finally { jobs.SCORE_RETRY_DELAYS_MS.splice(0, 2, ...saved); }
    // put 09-06 back to "fully scored, last run success" for part c
    schema.q.logCron.run('scores', '2026-09-06', 'success', 'seeded', 0);
    net.plan = [];
  }

  // ---------------------------------------------------------------- b + c
  console.log('\nb/c. the catch-up: what it re-runs, and what it never touches');
  const calls = [];
  const spyRun = (D) => { calls.push(D); return jobs.runScoreJob(D); };
  for (const k of Object.keys(spied)) delete spied[k];
  const urls0 = net.urls.length;
  const out1 = await jobs.runScoreCatchupJob({ today: TODAY, runScoreJob: spyRun });
  ok('window = the 7 dates before today (09-03 .. 09-09)', out1.dates.join(',') === '2026-09-03,2026-09-04,2026-09-05,2026-09-06,2026-09-07,2026-09-08,2026-09-09', out1.dates.join(','));
  ok('runs the score job for exactly: 09-04 (a finished game it cannot score), 09-05 (no run logged), 09-08 (unscored finished games)',
    calls.join(',') === '2026-09-04,2026-09-05,2026-09-08', calls.join(','));
  ok('09-08: both games scored by the score job, statuses no longer stuck', score('2026-09-08', 'nym-tb') === '10-4' && score('2026-09-08', 'nyy-laa') === '6-3');
  const bet = db.prepare("SELECT outcome, pnl FROM bet_signals WHERE game_date = '2026-09-08' AND game_id = 'nym-tb'").get();
  ok('09-08: the locked bet is graded by the score job (TB -150 home, lost 10-4: loss, -150)', bet.outcome === 'loss' && bet.pnl === -150, JSON.stringify(bet));
  ok('09-05: now has a successful score run logged', cronRows('scores', '2026-09-05').some(r => r.status === 'success'));
  ok('caught up: 09-05, 09-08; still unscored: 09-04 sea-tex only',
    out1.caught_up.join(',') === '2026-09-05,2026-09-08' && JSON.stringify(out1.still_unscored) === JSON.stringify([{ date: '2026-09-04', game_ids: ['sea-tex'] }]),
    JSON.stringify({ caught_up: out1.caught_up, still: out1.still_unscored, errors: out1.errors }));
  ok('fully scored dates (09-06, 09-09) are never re-run', !calls.includes('2026-09-06') && !calls.includes('2026-09-09'));
  ok('09-07 is not re-run: its unscored postponed duplicate, placeholder and removed row are skipped', !calls.includes('2026-09-07')
    && score('2026-09-07', 'tor-bal') === 'null-null' && score('2026-09-07', 'atl/phi-lad') === 'null-null');
  ok('09-01 (outside the window) is not touched, and nothing asks statsapi about it',
    score('2026-09-01', 'sea-tex') === 'null-null' && !net.urls.slice(urls0).some(u => /2026-09-01|09\/01\/2026/.test(u)));
  ok('09-03 (no games) asks statsapi nothing', !net.urls.slice(urls0).some(u => /2026-09-03|09\/03\/2026/.test(u)));
  ok('no network except statsapi; no global fetch', net.foreign.length === 0, net.foreign.join(' | '));
  const scraperCalls = [...new Set(spied.scraper || [])].sort();
  const modelCalls = [...new Set(spied.model || [])].sort();
  ok('spy: no weather, Kalshi or Polymarket call', !spied.weather && !spied.kalshi && !spied.polymarket, JSON.stringify({ w: spied.weather, k: spied.kalshi, p: spied.polymarket }));
  ok('spy: scraper calls are only the score fetch and parse (no lineups, schedule, odds)',
    scraperCalls.every(k => ['fetchScoresRaw', 'parseScoresJson', 'makeGameId'].includes(k)), scraperCalls.join(','));
  ok('spy: model calls are only bet-grading arithmetic (calcPnl, calcRunlinePnl): no runModel, no getSignals',
    modelCalls.every(k => ['calcPnl', 'calcRunlinePnl'].includes(k)), modelCalls.join(',') || '(none)');
  // source check for jobs.js-internal functions a module spy cannot see
  const src = read('services/jobs.js');
  const body = (name) => { const i = src.indexOf('function ' + name + '('); const j = src.indexOf('\nasync function ', i + 10), k = src.indexOf('\nfunction ', i + 10);
    return src.slice(i, Math.min(j < 0 ? Infinity : j, k < 0 ? Infinity : k)).replace(/\/\/.*$/gm, ''); };
  const FORBIDDEN = /\b(runModel|getSignals|processGameSignals|processOddsArray|runOddsJob|runWeatherJob|runLineupJob|runMorningCaptureJob|detectOpeners|fetchParkWind|fetchLineups|fetchLineupsRaw|fetchKalshiDirect|fetchSchedule|getKalshiMlb\w*|getPolymarketMlb\w*)\b/;
  const bodies = ['runScoreJob', 'fetchScoresWithRetry', 'runScoreCatchupJob', '_statsapiJson', 'gradeBetSignalsForGame'];
  ok('source: runScoreJob, the retry, the catch-up wiring and bet grading name no model / odds / weather / lineup / signal function',
    bodies.every(n => body(n).length > 50 && !FORBIDDEN.test(body(n))), bodies.filter(n => FORBIDDEN.test(body(n))).join(','));
  const catchSrc = read('services/score-catchup.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const reqs = [...catchSrc.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  ok('services/score-catchup.js requires only the read-only compareDate module', JSON.stringify(reqs) === '["./game-log-repair"]', reqs.join(','));
  ok('the catch-up cron is queued (never nested in another job) and calls only runScoreCatchupJob',
    /cron\.schedule\('30 4 \* \* \*'[\s\S]{0,200}_queued\('score-catchup', \(\) => runScoreCatchupJob\(\)\)/.test(src));

  // a second morning: nothing new to do
  calls.length = 0;
  const out2 = await jobs.runScoreCatchupJob({ today: TODAY, runScoreJob: spyRun });
  ok('second run: re-runs nothing (09-05 and 09-08 now fully scored; 09-04 already reported)',
    calls.length === 0 && out2.already_reported.join(',') === '2026-09-04', JSON.stringify({ calls, already: out2.already_reported }));

  // ---------------------------------------------------------------- d
  console.log('\nd. a date that stays unscored is a health-check warning, once');
  {
    const warnRows = cronRows('score-catchup', '2026-09-04').filter(r => r.status === 'warn');
    ok('exactly one warn row for 09-04 after two catch-up mornings, naming sea-tex',
      warnRows.length === 1 && warnRows[0].games_skipped_ids === 'sea-tex' && /still unscored after the catch-up score run: sea-tex$/.test(warnRows[0].message), JSON.stringify(warnRows));
    const express = require(path.join(R, 'node_modules/express'));
    const app = express();
    app.use('/api', require(path.join(R, 'routes/api')));
    const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const port = srv.address().port;
    try {
      const h4 = await getJson(port, '/api/health/2026-09-04');
      const c4 = (h4.checks || []).filter(c => c.id === 'scores_catchup');
      ok('GET /api/health/2026-09-04: one scores_catchup check, warn, affected_games [sea-tex]',
        c4.length === 1 && c4[0].status === 'warn' && JSON.stringify(c4[0].affected_games) === '["sea-tex"]', JSON.stringify(c4));
      const h8 = await getJson(port, '/api/health/2026-09-08');
      const c8 = (h8.checks || []).filter(c => c.id === 'scores_catchup');
      ok('GET /api/health/2026-09-08 (caught up): scores_catchup passes', c8.length === 1 && c8[0].status === 'pass', JSON.stringify(c8));
      db.prepare("UPDATE game_log SET away_score = 6, home_score = 2 WHERE game_date = '2026-09-04' AND game_id = 'sea-tex'").run();
      const h4b = await getJson(port, '/api/health/2026-09-04');
      const c4b = (h4b.checks || []).filter(c => c.id === 'scores_catchup');
      ok('once the game is scored some other way (e.g. the #486 repair), the warning clears without another catch-up',
        c4b.length === 1 && c4b[0].status === 'pass', JSON.stringify(c4b));
    } finally { await new Promise(res => srv.close(res)); }
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
  cleanup();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); failures++; cleanup(); process.exit(1); });

function cleanup() {
  globalThis.fetch = realGlobalFetch;
  try { db.close(); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  try { process.chdir(os.tmpdir()); fs.rmSync(TMP_CWD, { recursive: true, force: true }); } catch (e) {}
}
