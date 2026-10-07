#!/usr/bin/env node
'use strict';
/**
 * Signal cleanup never deactivates a logged bet (#519, 2026-10-07).
 *
 * Logged = bet_line IS NOT NULL (utils/logged-bets.js; getLoggedInactiveByDate;
 * backtest mode=logged). The cleanup at the end of processGameSignals used to
 * set is_active = 0 on any row the model stopped emitting, logged or not: 266
 * logged bets this season, including 10/01 phi-atl (ATL ML -103) on a
 * doubleheader-guard false positive, and after first pitch on manual reruns.
 *
 *   a. a logged bet the model stops emitting stays active, gets a
 *      'no_longer_emitted' audit row and a short note, and keeps its outcome,
 *      P&L, lines and lock (every other column byte-identical); a second pass
 *      with the same reason writes nothing more.
 *   b. an unlogged signal is still deactivated exactly as before.
 *   c. a manual rerun of a past date (POST /api/games/:date/rerun): a finished game is
 *      untouched (as on main); a started, not-yet-locked game keeps its logged bet active.
 *   d. the 10/01 phi-atl shape (doubleheader-guard flag, logged home ML -103,
 *      before first pitch, odds not locked) keeps the bet active; the guard's gate reads as
 *      "market rejected by the doubleheader guard".
 *   e. backstop: q.deactivateSignal itself refuses a logged row.
 *
 * Runs against a throwaway database. The model is made to emit nothing by
 * leaving the lineups empty (runModel -> _suppressed 'incomplete_lineup').
 *
 *   node scripts/test-keep-logged-bets-active.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__keep_logged_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
process.env.DB_DOWNLOAD_TOKEN = TOKEN;

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

const { db, q } = require(path.join(R, 'db/schema'));
const jobs = require(path.join(R, 'services/jobs'));
const settings = jobs.getSettings();
const wobaIdx = jobs.getWobaIndex();
const insGl = db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, game_time, scheduled_start_utc, away_score, home_score, game_status,
  market_away_ml, market_home_ml, market_total, over_price, under_price, ml_source, odds_flag_reason, odds_locked_at) VALUES
  (@d, @g, @a, @h, @t, @st, @as, @hs, @status, -111, -107, 8.5, -110, -110, 'polymarket', @flag, @lock)`);
const insSig = db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, model_line, edge_pct,
  outcome, pnl, bet_line, bet_price, bet_locked_at, closing_line, clv, is_active, cohort, notes, price_venue) VALUES
  (@gl, @d, @g, @type, @side, @cat, @mkt, @model, @edge, @o, @pnl, @bl, @bp, @lk, @close, @clv, 1, 'v7', NULL, @venue)`);
function addGame(o) {
  insGl.run(Object.assign({ t: '7:05 PM ET', as: null, hs: null, status: 'Scheduled', flag: null, lock: null }, o));
  return db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(o.d, o.g).id;
}
function addSig(gl, d, g, o) {
  insSig.run(Object.assign({ gl, d, g, model: -125, edge: 0.04, o: 'pending', pnl: 0, bl: null, bp: null, lk: null, close: null, clv: null, venue: 'poly' }, o));
  return db.prepare('SELECT id FROM bet_signals WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?').get(d, g, o.type, o.side).id;
}
const row = (id) => db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(id);
const audits = (id) => db.prepare('SELECT action, source, detail FROM bet_signal_audit WHERE signal_id = ? ORDER BY id').all(id);
const gameRow = (d, g) => db.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(d, g);
const ALLOWED = new Set(['notes', 'updated_at']);
const sameExcept = (a, b) => Object.keys(a).filter(k => !ALLOWED.has(k) && !Object.is(a[k], b[k]));

(async () => {
  // ---------------------------------------------------------------- a + b: pre-game pass, the model emits nothing
  console.log('a/b. pre-game pass: the model stops emitting both rows');
  {
    const D = '2099-06-01', G = 'nyy-bos';                       // future date: the game has not started
    const gl = addGame({ d: D, g: G, a: 'NYY', h: 'BOS', st: '2099-06-01T23:05:00Z' });
    const logged = addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'dog', mkt: 120, bl: 118, lk: '2099-06-01 12:00:00', close: 115, clv: 1.2 });
    const unlogged = addSig(gl, D, G, { type: 'Total', side: 'under', cat: 'under', mkt: 8.5, model: 7.9 });
    const before = row(logged), beforeU = row(unlogged);
    jobs.processGameSignals(gameRow(D, G), wobaIdx, settings);
    const after = row(logged), afterU = row(unlogged);
    ok('a: the logged bet stays active', after.is_active === 1);
    ok('a: it carries a short note saying why', after.notes === 'Model no longer recommends: model suppressed (lineup incomplete)', after.notes);
    ok('a: every other column is byte-identical (outcome, pnl, bet_line, lock, closing, clv, prices, edge)', sameExcept(before, after).length === 0, sameExcept(before, after).join(','));
    const au = audits(logged);
    ok('a: one no_longer_emitted audit row (no deactivated row), naming the route and the full reason', au.length === 1 && au[0].action === 'no_longer_emitted'
      && au[0].source === 'process_game_signals_upsert' && /model suppressed \(lineup incomplete\) \| Lineup incomplete/.test(au[0].detail), JSON.stringify(au));
    jobs.processGameSignals(gameRow(D, G), wobaIdx, settings);
    ok('a: a second pass with the same reason writes nothing more', audits(logged).length === 1 && row(logged).is_active === 1 && sameExcept(after, row(logged)).length === 0);
    ok('b: the unlogged signal is deactivated as before', afterU.is_active === 0 && /model output suppressed, signal deactivated/.test(afterU.notes || ''), afterU.notes);
    ok('b: with a deactivated audit row, and nothing else on it changed', audits(unlogged).length === 1 && audits(unlogged)[0].action === 'deactivated'
      && sameExcept(beforeU, afterU).filter(k => k !== 'is_active').length === 0, JSON.stringify(audits(unlogged).map(x => x.action)));
  }

  // ---------------------------------------------------------------- c + d: manual rerun of a past date (the route), phi-atl shape
  // processGameSignals returns early once odds are locked or the game is scored
  // (services/jobs.js, "if (gl.odds_locked_at && gl.away_score == null) return" and the
  // graded-game branch), so on main a FINISHED game already never reached the cleanup.
  // The exposed window is a game that has STARTED but is not yet locked or scored --
  // where all six after-first-pitch deactivations in #519 happened (7/09-7/10, 9/23).
  console.log('\nc. manual rerun of a past date (POST /api/games/:date/rerun)');
  {
    const D = '2026-10-01';
    // a finished game: logged Total + unlogged ML (already safe on main; must stay so)
    const glB = addGame({ d: D, g: 'cws-hou', a: 'CWS', h: 'HOU', st: '2026-10-01T21:00:00Z', as: 3, hs: 4, status: 'Final', lock: '2026-10-01 21:00:07' });
    const lt = addSig(glB, D, 'cws-hou', { type: 'Total', side: 'over', cat: 'over', mkt: 7.5, model: 8.3, edge: 0.05, o: 'loss', pnl: -110, bl: 7.5, bp: -110, lk: '2026-10-01 15:00:00' });
    const um = addSig(glB, D, 'cws-hou', { type: 'ML', side: 'away', cat: 'dog', mkt: 130, model: 115, edge: 0.03, o: 'loss', pnl: -76.92 });
    // a started game, not yet locked or scored (the exposed window): logged ML + unlogged Total
    const glC = addGame({ d: D, g: 'sd-mil', a: 'SD', h: 'MIL', st: '2026-10-01T23:10:00Z', status: 'In Progress' });
    const lm = addSig(glC, D, 'sd-mil', { type: 'ML', side: 'home', cat: 'fav', mkt: -125, model: -140, edge: 0.03, bl: -122, lk: '2026-10-01 18:00:00', close: null });
    const ut = addSig(glC, D, 'sd-mil', { type: 'Total', side: 'under', cat: 'under', mkt: 8.5, model: 7.8, edge: 0.07 });
    const b4 = { lt: row(lt), um: row(um), lm: row(lm), ut: row(ut) };
    const express = require(path.join(R, 'node_modules/express'));
    const app = express(); app.use(express.json()); app.use('/api', require(path.join(R, 'routes/api')));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const post = (p) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: p, headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' } }, (res) => {
        let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* */ } resolve({ code: res.statusCode, body: j }); });
      });
      rq.on('error', reject); rq.end('{}');
    });
    const r1 = await post('/api/games/' + D + '/rerun');
    const r2 = await post('/api/games/' + D + '/rerun');
    await new Promise(r => server.close(r));
    ok('the rerun route ran on both games, twice', r1.code === 200 && r1.body.updated === 2 && r2.code === 200, JSON.stringify([r1.body, r2.body]));
    const A = { lt: row(lt), um: row(um), lm: row(lm), ut: row(ut) };
    ok('c: finished game: the logged Total is untouched (active, outcome / P&L / line / price unchanged, no audit)',
      A.lt.is_active === 1 && sameExcept(b4.lt, A.lt).length === 0 && A.lt.notes === null && audits(lt).length === 0);
    ok('c: finished game: the unlogged signal is untouched too, as on main (the graded-game branch freezes it)', JSON.stringify(A.um) === JSON.stringify(b4.um));
    ok('c: started, unlocked game: the logged ML stays active, every other column unchanged', A.lm.is_active === 1 && sameExcept(b4.lm, A.lm).length === 0,
      sameExcept(b4.lm, A.lm).join(','));
    ok('c: ...with one no_longer_emitted record across both reruns, never deactivated', audits(lm).filter(x => x.action === 'no_longer_emitted').length === 1
      && !audits(lm).some(x => x.action === 'deactivated') && /^Model no longer recommends: /.test(A.lm.notes || ''), JSON.stringify(audits(lm).map(x => x.action)) + ' ' + A.lm.notes);
    ok('c: started, unlocked game: the unlogged signal is deactivated as before', A.ut.is_active === 0 && audits(ut).some(x => x.action === 'deactivated'));
  }

  console.log('\nd. the 10/01 phi-atl shape: doubleheader-guard flag on a logged bet, before first pitch, not locked');
  {
    // On 10/01 the bet was deactivated at 06:00 UTC: before first pitch, odds not locked, the row stamped
    // with a venue start-time mismatch. A future date stands in for "before first pitch".
    const D = '2099-10-01';
    const gl = addGame({ d: D, g: 'phi-atl', a: 'PHI', h: 'ATL', t: '8:00 PM ET', st: '2099-10-02T00:00:00Z',
      flag: 'polymarket start-time mismatch for phi-atl (source 14:00 vs schedule 20:00)' });
    const pa = addSig(gl, D, 'phi-atl', { type: 'ML', side: 'home', cat: 'fav', mkt: -106, model: -123, edge: 0.037, bl: -103, lk: '2099-10-01 00:25:47' });
    const before = row(pa);
    jobs.processGameSignals(gameRow(D, 'phi-atl'), wobaIdx, settings);
    jobs.processGameSignals(gameRow(D, 'phi-atl'), wobaIdx, settings);
    const after = row(pa);
    ok('d: the logged ATL ML -103 stays active; line, lock, outcome and P&L unchanged', after.is_active === 1 && after.bet_line === -103
      && after.bet_locked_at === '2099-10-01 00:25:47' && sameExcept(before, after).length === 0, JSON.stringify({ act: after.is_active, notes: after.notes }));
    ok('d: not deactivated; one no_longer_emitted record', !audits(pa).some(x => x.action === 'deactivated') && audits(pa).filter(x => x.action === 'no_longer_emitted').length === 1,
      JSON.stringify(audits(pa).map(x => x.action)));
    // With empty lineups the model is suppressed before the guard's gate is what removes the ML side, so the
    // note above names the suppression. The guard's own gate record (getSignals, side 'both') is named like this:
    const dhRec = [{ type: 'ML', side: 'both', reason: 'DH-crossed source rejected', gate: true }];
    ok('d: the doubleheader-guard gate is named on the note', jobs._notEmittedShortReason(false, null, {}, 'ML', 'home', dhRec) === 'market rejected by the doubleheader guard');
    ok('the other reasons read as intended', jobs._notEmittedShortReason(false, null, {}, 'ML', 'away', []) === 'edge below floor'
      && /hard cap/.test(jobs._notEmittedShortReason(false, null, {}, 'ML', 'away', [{ type: 'ML', side: 'away', reason: 'edge_hard_cap' }]))
      && /disagree on favorite/.test(jobs._notEmittedShortReason(false, null, {}, 'ML', 'away', [{ type: 'ML', side: 'both', reason: 'sources disagree on favorite', gate: true }])));
  }

  // ---------------------------------------------------------------- e: the backstop
  console.log('\ne. q.deactivateSignal refuses a logged row');
  {
    const D = '2099-06-02', G = 'sea-tex';
    const gl = addGame({ d: D, g: G, a: 'SEA', h: 'TEX', st: '2099-06-02T23:05:00Z' });
    const lg = addSig(gl, D, G, { type: 'ML', side: 'home', cat: 'fav', mkt: -140, bl: -140, lk: '2099-06-02 12:00:00' });
    const ul = addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'dog', mkt: 130 });
    const r1 = q.deactivateSignal.run('x', D, G, 'ML', 'home'), r2 = q.deactivateSignal.run('x', D, G, 'ML', 'away');
    ok('a logged row: 0 changes, still active', r1.changes === 0 && row(lg).is_active === 1);
    ok('an unlogged row: deactivated', r2.changes === 1 && row(ul).is_active === 0);
  }

  try { db.close(); } catch (e) { /* closed */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
