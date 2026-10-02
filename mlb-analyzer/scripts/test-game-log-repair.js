#!/usr/bin/env node
'use strict';
/**
 * game_log repair (#486, 2026-10-02): POST /api/admin/game-log-repair and
 * services/game-log-repair.js, on a throwaway database and SYNTHETIC statsapi
 * fixtures (no network).
 *
 *   a. each category: diff finds it; apply of that category alone fixes exactly
 *      it and leaves every other category's findings as they were.
 *   b. protected columns are untouched (prices, locks, model outputs, lineups,
 *      signals, captures, bets); the route takes only withMemLog and
 *      gradeBetSignalsForGame from services/jobs.js (spy), and the repair module
 *      requires nothing that runs the model, odds, weather, lineups or signals.
 *   c. a second apply writes nothing; category and date filters are respected.
 *   d. X-Admin-Token required; mounted in server.js before routes/api.js (its
 *      POST /upload/:key? catch-all) and the other routers.
 *   e. grade mode grades bet_signals only, through gradeBetSignalsForGame; diff
 *      mode writes nothing.
 *
 *   node scripts/test-game-log-repair.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__game_log_repair_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
process.env.DB_DOWNLOAD_TOKEN = TOKEN;
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- fixtures
const D1 = '2026-05-10', D2 = '2026-05-15', D3 = '2026-05-20', FROM = '2026-05-10', TO = '2026-05-20';
const sg = (pk, away, home, o) => Object.assign({ gamePk: pk, gameType: 'R', officialDate: o.date, gameDate: o.start, gameNumber: o.gn || 1,
  status: { detailedState: o.status || 'Final', abstractGameState: o.abstract || (/^(Final|Completed|Game Over|Postponed|Cancelled)/.test(o.status || 'Final') ? 'Final' : 'Live') },
  teams: { away: { team: { abbreviation: away }, score: o.as }, home: { team: { abbreviation: home }, score: o.hs } } }, o.extra || {});
const SCHED = {
  [D1]: [
    sg(1001, 'NYY', 'BOS', { date: D1, start: '2026-05-10T17:05:00Z', as: 3, hs: 2 }),
    sg(1002, 'LAD', 'SD', { date: D1, start: '2026-05-10T20:10:00Z', as: 5, hs: 1 }),
    sg(1003, 'SEA', 'TEX', { date: D1, start: '2026-05-11T00:05:00Z', as: 6, hs: 2, status: 'Completed Early: Rain' }),
    sg(1005, 'CHC', 'MIL', { date: D1, start: '2026-05-10T18:10:00Z', as: 2, hs: 0, gn: 1 }),
    sg(1004, 'CHC', 'MIL', { date: D1, start: '2026-05-10T23:10:00Z', as: 1, hs: 0, gn: 2 }),
    sg(1006, 'TOR', 'BAL', { date: '2026-05-11', start: '2026-05-11T17:05:00Z', status: 'Postponed' }),   // listed on D1, officialDate = the make-up's
    sg(1007, 'CIN', 'PIT', { date: '2026-05-11', start: '2026-05-11T17:05:00Z', status: 'Postponed' }),
    sg(1008, 'WSH', 'OAK', { date: D1, start: '2026-05-10T20:05:00Z', as: 4, hs: 1 }),              // abbreviation normalisation
    sg(1300, 'MIN', 'KC', { date: '2026-05-09', start: '2026-05-10T15:00:00Z', as: 2, hs: 1 }),      // a resumption listed here, officially 05-09
  ],
  [D2]: [sg(1100, 'AL', 'NL', { date: D2, start: '2026-05-16T00:00:00Z', as: 4, hs: 0, extra: { gameType: 'A' } })],
  [D3]: [sg(1200, 'SF', 'ATL', { date: D3, start: '2026-05-20T23:15:00Z', status: 'Suspended: Rain', abstract: 'Live' })],
};
const BY_PK = { 1200: [{ date: D3, games: [SCHED[D3][0]] },
  { date: '2026-05-21', games: [sg(1200, 'SF', 'ATL', { date: D3, start: '2026-05-21T18:00:00Z', as: 7, hs: 2 })] }] };
const calls = { urls: [], firstPitch: [] };
async function fetchJson(url) {
  calls.urls.push(url);
  const u = new URL(url);
  if (u.hostname !== 'statsapi.mlb.com') throw new Error('unexpected host ' + u.hostname);
  if (u.searchParams.get('gamePk')) return { dates: BY_PK[u.searchParams.get('gamePk')] || [] };
  const d = u.searchParams.get('date');
  return { dates: SCHED[d] ? [{ date: d, games: SCHED[d] }] : [] };
}
async function fetchFirstPitch(pk) { calls.firstPitch.push(pk); return { first_pitch_utc: '2026-05-10T17:0' + (pk % 10) + ':00.000Z', scheduled_start_utc: null, game_status: 'Final' }; }

// ---------------------------------------------------------------- the throwaway database
const schema = require(path.join(R, 'db/schema'));
const base = schema.db;
const PROTECT = { market_away_ml: -120, market_home_ml: 110, market_total: 8.5, odds_locked_at: '2026-05-10 16:55:00', model_away_ml: -115, model_home_ml: 105,
  model_total: 8.7, ml_source: 'kalshi', away_lineup_json: '["a"]', home_lineup_json: '["b"]', over_price: -110, under_price: -110, proj_model_total: 8.4 };
function addRow(db, r) {
  const o = Object.assign({ game_number: 1, game_pk: null, scheduled_start_utc: null, first_pitch_utc: null, away_score: null, home_score: null,
    game_status: null, is_removed: 0 }, PROTECT, r);
  const cols = Object.keys(o);
  db.prepare('INSERT INTO game_log (' + cols.join(', ') + ') VALUES (' + cols.map(c => '@' + c).join(', ') + ')').run(o);
}
const row = (date, id, away, home, extra) => Object.assign({ game_date: date, game_id: id, away_team: away, home_team: home }, extra || {});
addRow(base, row(D1, 'nyy-bos', 'NYY', 'BOS', { game_pk: 1001, scheduled_start_utc: '2026-05-10T17:05:00Z', away_score: 2, home_score: 3, game_status: 'Final' }));
addRow(base, row(D1, 'lad-sd', 'LAD', 'SD'));
addRow(base, row(D1, 'chc-mil', 'CHC', 'MIL', { game_pk: 1005, scheduled_start_utc: '2026-05-10T18:10:00Z', first_pitch_utc: '2026-05-10T18:12:00.000Z', away_score: 2, home_score: 0 }));
addRow(base, row(D1, 'chc-mil-2', 'CHC', 'MIL', { game_number: 2 }));
addRow(base, row(D1, 'tor-bal', 'TOR', 'BAL', { game_pk: 1006, scheduled_start_utc: '2026-05-11T17:05:00Z' }));
addRow(base, row(D1, 'cin-pit', 'CIN', 'PIT', { game_pk: 1007 }));
addRow(base, row(D1, 'atl/phi-lad', 'ATL/PHI', 'LAD', { game_pk: 1001 }));
addRow(base, row(D1, 'was-ath', 'WAS', 'ATH', { game_pk: 1008, scheduled_start_utc: '2026-05-10T20:05:00Z', first_pitch_utc: '2026-05-10T20:06:00.000Z', away_score: 4, home_score: 1 }));
addRow(base, row(D2, 'al-nl', 'AL', 'NL', { game_pk: 1100 }));
addRow(base, row(D3, 'sf-atl', 'SF', 'ATL', { game_pk: 1200, scheduled_start_utc: '2026-05-21T18:00:00Z', first_pitch_utc: '2026-05-20T23:20:00.000Z' }));
const glId = (db, d, id) => db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(d, id).id;
const addSignal = (db, d, id, side, line) => db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, bet_line, is_active)
  VALUES (?, ?, ?, 'ML', ?, 'ml', ?, ?, 1)`).run(glId(db, d, id), d, id, side, line, line);
addSignal(base, D1, 'nyy-bos', 'away', '+120');                    // graded only by grade mode
addSignal(base, D1, 'cin-pit', 'home', '-130');                    // keeps the postponed row from being retired
base.pragma('journal_mode = DELETE');                              // a WAL-mode image cannot be opened from memory
const SNAP = base.serialize();
const fresh = () => new (require(path.join(R, 'node_modules/better-sqlite3')))(SNAP);
const repair = require(path.join(R, 'services/game-log-repair'));
const deps = (db) => ({ db, fetchJson, fetchFirstPitch, grade: () => { throw new Error('grade called outside grade mode'); } });
const run = (db, body) => repair.run(Object.assign({ from: FROM, to: TO }, body), deps(db));
const hashOf = (db, sql) => crypto.createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
const ALLOWED = new Set(['game_id', 'game_number', 'game_pk', 'scheduled_start_utc', 'first_pitch_utc', 'game_status', 'away_score', 'home_score', 'actual_total',
  'scores_source', 'scores_quality', 'scores_quality_at', 'is_removed', 'removed_at', 'removed_reason', 'updated_at']);
const glCols = base.prepare('PRAGMA table_info(game_log)').all().map(c => c.name);
const rowsById = (db) => new Map(db.prepare('SELECT * FROM game_log').all().map(r => [r.id, r]));
const changedCols = (a, b) => { const s = new Set(); for (const [id, r] of a) { const r2 = b.get(id); if (!r2) { s.add('<deleted row>'); continue; } for (const c of glCols) if (!Object.is(r[c], r2[c])) s.add(c); } return s; };
const CAPTURE_TABLES = ['empirical_spread_signals', 'empirical_spread_outcomes', 'empirical_market_captures', 'lineup_captures', 'morning_capture_state'];

(async () => {
  const EXPECT = { missing_game: 1, wrong_score: 1, missing_score: 3, start_time: 3, game_pk: 2, first_pitch: 3, postponed_duplicate: 2, placeholder: 1, dh_assignment: 1 };

  // ---------------------------------------------------------------- a
  console.log('a. each category: diff finds it, apply fixes exactly it');
  {
    const db = fresh();
    const d0 = await run(db, {});
    ok('diff finds every planted difference, by category', JSON.stringify(d0.counts) === JSON.stringify(EXPECT), JSON.stringify(d0.counts));
    const it = (c) => d0.items[c].map(x => x.game_id + (x.row_game_id && x.row_game_id !== x.game_id ? '<' + x.row_game_id : '')).sort().join(',');
    ok('the findings are the planted ones', it('missing_game') === 'sea-tex' && it('wrong_score') === 'nyy-bos' && it('missing_score') === 'chc-mil-g2<chc-mil-2,lad-sd,sf-atl'
      && it('start_time') === 'chc-mil-g2<chc-mil-2,lad-sd,sf-atl' && it('game_pk') === 'chc-mil-g2<chc-mil-2,lad-sd' && it('postponed_duplicate') === 'cin-pit,tor-bal'
      && it('placeholder') === 'atl/phi-lad' && it('dh_assignment') === 'chc-mil-g2<chc-mil-2', JSON.stringify(Object.fromEntries(Object.keys(EXPECT).map(c => [c, it(c)]))));
    ok('a wrong winner is labelled', d0.items.wrong_score[0].detail.includes('WRONG WINNER'));
    ok('"Completed Early" counts as final (inserted with its score); WSH/OAK normalise to was-ath (no difference)',
      d0.items.missing_game[0].detail.includes('Completed Early') && !Object.values(d0.items).some(l => l.some(x => x.game_id === 'was-ath')));
    ok('a game listed on D1 but officially another date is not D1\'s (no finding for min-kc)', !Object.values(d0.items).some(l => l.some(x => x.game_id === 'min-kc')));
    ok('the All-Star game and its row are out of scope, never a finding', d0.out_of_scope.length === 2 && !Object.values(d0.items).some(l => l.some(x => x.game_id === 'al-nl')));
    ok('the suspended game: final state read by gamePk (7-2), scheduled start = the ORIGINAL date\'s',
      d0.items.missing_score.some(x => x.game_id === 'sf-atl' && /7-2/.test(x.detail)) && d0.items.start_time.some(x => x.game_id === 'sf-atl' && x.detail.endsWith('2026-05-20T23:15:00Z')));
    const SOLO = {
      missing_game: (db) => db.prepare("SELECT away_score || '-' || home_score s, game_pk, scheduled_start_utc, game_status, market_away_ml, odds_locked_at, model_total, away_lineup_json FROM game_log WHERE game_date = ? AND game_id = 'sea-tex'").get(D1),
    };
    for (const cat of Object.keys(EXPECT)) {
      const db2 = fresh(), before = rowsById(db2), betH = hashOf(db2, 'SELECT * FROM bet_signals ORDER BY id');
      const a = await run(db2, { mode: 'apply', categories: [cat] });
      const after = await run(db2, {});
      const others = Object.keys(EXPECT).filter(c => c !== cat);
      const expectAfter = cat === 'postponed_duplicate' ? 1 : 0;                          // cin-pit has a signal: reported, never retired
      // An inserted final game has no first pitch yet: with first_pitch not requested, it becomes one more first_pitch finding.
      const expectOther = (c) => d0.counts[c] + (cat === 'missing_game' && c === 'first_pitch' ? 1 : 0);
      const cols = [...changedCols(before, rowsById(db2))].filter(c => !ALLOWED.has(c));
      ok('apply [' + cat + ']: fixes it (' + (a.written[cat] || 0) + ' written), leaves the other categories exactly as found, touches no other column, no bet',
        after.counts[cat] === expectAfter && others.every(c => after.counts[c] === expectOther(c))
        && cols.length === 0 && hashOf(db2, 'SELECT * FROM bet_signals ORDER BY id') === betH,
        JSON.stringify({ written: a.written, after: after.counts[cat], bad_cols: cols, skipped: a.skipped.map(s => s.game_id) }));
    }
    const db3 = fresh(); await run(db3, { mode: 'apply', categories: ['missing_game'] });
    const ins = SOLO.missing_game(db3);
    ok('an inserted game carries schedule + score fields only: no price, lock, model output or lineup',
      ins.s === '6-2' && ins.game_pk === 1003 && ins.scheduled_start_utc === '2026-05-11T00:05:00Z' && /Completed Early/.test(ins.game_status)
      && ins.market_away_ml == null && ins.odds_locked_at == null && ins.model_total == null && ins.away_lineup_json == null, JSON.stringify(ins));
  }

  // ---------------------------------------------------------------- b + c
  console.log('\nb/c. protected columns, the spy, idempotency, filters');
  {
    const db = fresh(), before = rowsById(db);
    const protH = hashOf(db, 'SELECT id, ' + glCols.filter(c => !ALLOWED.has(c)).join(', ') + ' FROM game_log ORDER BY id');
    const betH = hashOf(db, 'SELECT * FROM bet_signals ORDER BY id');
    const capH = CAPTURE_TABLES.map(t => hashOf(db, 'SELECT * FROM ' + t));
    calls.urls.length = 0; calls.firstPitch.length = 0;
    const a1 = await run(db, { mode: 'apply' });
    const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
    ok('apply all: the expected writes (first_pitch includes the inserted game)', sortedJson(a1.written) === sortedJson({ placeholder: 1, postponed_duplicate: 1, dh_assignment: 1, missing_game: 1, wrong_score: 1,
      missing_score: 3, start_time: 3, game_pk: 2, first_pitch: 4 }) && a1.skipped.length === 1 && a1.skipped[0].game_id === 'cin-pit', JSON.stringify(a1.written) + ' skipped ' + JSON.stringify(a1.skipped));
    ok('protected game_log columns (prices, locks, model, lineups, ...) of every existing row are untouched',
      hashOf(db, 'SELECT id, ' + glCols.filter(c => !ALLOWED.has(c)).join(', ') + ' FROM game_log WHERE id IN (' + [...before.keys()].join(',') + ') ORDER BY id') === protH);
    ok('bet_signals and every capture table are untouched by apply', hashOf(db, 'SELECT * FROM bet_signals ORDER BY id') === betH
      && CAPTURE_TABLES.every((t, i) => hashOf(db, 'SELECT * FROM ' + t) === capH[i]));
    ok('only statsapi was called (schedule by date, one by-gamePk lookup for the suspended game) and the game feed for first pitches',
      calls.urls.every(u => u.startsWith('https://statsapi.mlb.com/api/v1/schedule?')) && calls.urls.filter(u => /gamePk=/.test(u)).length === 1 && calls.firstPitch.length === 4,
      calls.urls.length + ' schedule requests, ' + calls.firstPitch.length + ' feed requests');
    const d2 = await run(db, {});
    const a2 = await run(db, { mode: 'apply' });
    ok('after apply, diff is zero except the reported, unretired cin-pit (it has a bet_signals row)',
      Object.entries(d2.counts).every(([c, n]) => n === (c === 'postponed_duplicate' ? 1 : 0)), JSON.stringify(d2.counts));
    ok('a second apply writes nothing', JSON.stringify(a2.written) === '{}', JSON.stringify(a2.written));
    const s = (id, d) => db.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(d || D1, id);
    ok('end state: scores corrected / filled, the doubleheader leg renamed, the placeholder and postponed row retired, cin-pit kept',
      s('nyy-bos').away_score === 3 && s('lad-sd').game_pk === 1002 && s('chc-mil-g2') && s('chc-mil-g2').game_number === 2 && s('chc-mil-g2').away_score === 1
      && s('atl/phi-lad').is_removed === 1 && s('atl/phi-lad').removed_reason === 'repair_placeholder' && s('tor-bal').removed_reason === 'repair_postponed_original'
      && s('cin-pit').is_removed === 0 && s('sf-atl', D3).away_score === 7 && s('sf-atl', D3).scheduled_start_utc === '2026-05-20T23:15:00Z'
      && s('sf-atl', D3).first_pitch_utc === '2026-05-20T23:20:00.000Z' && s('al-nl', D2).away_score == null);
    // filters
    const dbF = fresh();
    const aF = await run(dbF, { mode: 'apply', categories: ['wrong_score'] });
    ok('category filter: only wrong_score written', JSON.stringify(aF.written) === '{"wrong_score":1}');
    const dbD = fresh();
    const aD = await run(dbD, { mode: 'apply', from: D3, to: D3 });
    ok('date filter: a D3-only apply writes only the suspended game; D1 rows untouched',
      sortedJson(aD.written) === sortedJson({ missing_score: 1, start_time: 1 }) &&dbD.prepare("SELECT away_score FROM game_log WHERE game_date = ? AND game_id = 'nyy-bos'").get(D1).away_score === 2,
      JSON.stringify(aD.written));
    ok('more than 31 dates in one call is refused', !!(await run(fresh(), { from: '2026-04-01', to: '2026-05-15' })).error);
    ok('an unknown category is refused', /unknown categories/.test((await run(fresh(), { categories: ['prices'] })).error || ''));
    // the module's own require graph
    const src = read('services/game-log-repair.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    ok('the repair module requires only utils/statsapi-ids (no model, odds, weather, lineup, signal or jobs code)', JSON.stringify(reqs) === '["../utils/statsapi-ids"]', reqs.join(','));
    const fnSrc = ((read('services/jobs.js').match(/function gradeBetSignalsForGame\([\s\S]*?\n\}\r?\n/) || [''])[0]).replace(/\/\/.*$/gm, '');   // code, not comments
    ok('gradeBetSignalsForGame only grades: it calls calcPnl / calcRunlinePnl and writes bet_signals, nothing else',
      fnSrc.length > 0 && /calcPnl\(/.test(fnSrc) && !/runModel|processGameSignals|getSignals|runOddsJob|runWeatherJob|runLineupJob|fetch|UPDATE game_log|INSERT/.test(fnSrc)
      && (fnSrc.match(/UPDATE (\w+)/g) || []).every(x => x === 'UPDATE bet_signals'));
  }

  // ---------------------------------------------------------------- d + e (the route, real jobs.js behind a spy)
  console.log('\nd/e. the route: auth, mount order, grade mode, diff mode');
  {
    const jobsPath = require.resolve(path.join(R, 'services/jobs'));
    const realJobs = require(jobsPath);
    const touched = new Set();
    require.cache[jobsPath].exports = new Proxy(realJobs, { get(t, k) { if (typeof k === 'string') touched.add(k); return t[k]; } });
    const router = require(path.join(R, 'routes/game-log-repair'));
    router._setDeps({ db: base, fetchJson, fetchFirstPitch });                 // queue + grade come from (the spied) services/jobs.js
    const express = require(path.join(R, 'node_modules/express'));
    const app = express(); app.use('/api', router);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const post = (body, headers) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/admin/game-log-repair',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
        let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* */ } resolve({ code: res.statusCode, body: j }); });
      });
      rq.on('error', reject); rq.end(JSON.stringify(body));
    });
    const tc0 = base.prepare('SELECT total_changes() c').get().c;
    const noTok = await post({ from: FROM, to: TO }), badTok = await post({ from: FROM, to: TO }, { 'X-Admin-Token': TOKEN + 'x' });
    ok('no token / wrong token -> 401, nothing written', noTok.code === 401 && badTok.code === 401 && base.prepare('SELECT total_changes() c').get().c === tc0);
    const bad = await post({ from: '2026-05-10', to: '2026-04-01' }, { 'X-Admin-Token': TOKEN });
    ok('a bad range -> 400', bad.code === 400);
    const diff = await post({ from: FROM, to: TO }, { 'X-Admin-Token': TOKEN });
    ok('diff (the default mode) through the route writes nothing', diff.code === 200 && diff.body.mode === 'diff' && JSON.stringify(diff.body.counts) === JSON.stringify(EXPECT)
      && base.prepare('SELECT total_changes() c').get().c === tc0, JSON.stringify(diff.body.counts));
    const ap = await post({ mode: 'apply', from: FROM, to: TO }, { 'X-Admin-Token': TOKEN });
    const sigBefore = base.prepare("SELECT outcome, pnl FROM bet_signals WHERE game_id = 'nyy-bos'").get();
    ok('apply through the route repairs and grades nothing', ap.code === 200 && ap.body.written.wrong_score === 1 && sigBefore.outcome == null);
    const glH = hashOf(base, 'SELECT * FROM game_log ORDER BY id');
    const gr = await post({ mode: 'grade', from: D1, to: D1 }, { 'X-Admin-Token': TOKEN });
    const sig = base.prepare("SELECT outcome, pnl FROM bet_signals WHERE game_id = 'nyy-bos'").get();
    const sigPp = base.prepare("SELECT outcome FROM bet_signals WHERE game_id = 'cin-pit'").get();
    ok('grade mode grades the finished game\'s bet (NYY +120 won 3-2 -> win, +100) and leaves game_log untouched',
      gr.code === 200 && sig.outcome === 'win' && sig.pnl === 100 && sigPp.outcome == null && hashOf(base, 'SELECT * FROM game_log ORDER BY id') === glH,
      JSON.stringify(gr.body) + ' ' + JSON.stringify(sig));
    ok('SPY: the route took exactly withMemLog and gradeBetSignalsForGame from services/jobs.js (no model, odds, weather, lineup or signal function)',
      JSON.stringify([...touched].filter(k => !['__esModule', 'then', 'default'].includes(k)).sort()) === '["gradeBetSignalsForGame","withMemLog"]', [...touched].join(','));
    await new Promise(r => server.close(r));
    require.cache[jobsPath].exports = realJobs;
    const srv = read('server.js').replace(/\/\/.*$/gm, '');
    const iR = srv.indexOf("app.use('/api', require('./routes/game-log-repair'));"), iApi = srv.indexOf("app.use('/api', require('./routes/api'));");
    ok('server.js mounts the repair router before routes/api.js (and its POST /upload/:key? catch-all)', iR > 0 && iApi > iR);
    const routeSrc = read('routes/game-log-repair.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok('the route is admin-gated and is the only route on its path', /router\.post\('\/admin\/game-log-repair', requireAdminToken/.test(routeSrc)
      && !/game-log-repair/.test(read('routes/api.js')));
    ok('from services/jobs.js the route names only withMemLog and gradeBetSignalsForGame',
      JSON.stringify([...new Set([...routeSrc.matchAll(/jobs\.(\w+)/g)].map(m => m[1]))].sort()) === '["gradeBetSignalsForGame","withMemLog"]');
  }

  try { base.close(); } catch (e) { /* closed */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
