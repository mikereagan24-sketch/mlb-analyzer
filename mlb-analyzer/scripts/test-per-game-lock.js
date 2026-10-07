#!/usr/bin/env node
'use strict';
/**
 * Per-game odds lock pass (#488, 2026-10-07).
 *
 * The odds lock only ran inside a lineup pull, so a game whose first pitch
 * fell between pulls (6:38-7:15 PM PT starts: after the 6 PM pull's
 * 10-minute window, before anything else) locked late or never.
 * runPerGameLockPass locks each game from its own scheduled_start_utc,
 * at T-10, through lockGameOdds -- the lineup pull's own lock step.
 *
 *   a. a game whose first pitch falls between lineup pulls is locked when
 *      its window opens (not one minute before).
 *   b. an already-locked game is not touched; postponed, cancelled,
 *      removed, placeholder and start-less rows are skipped.
 *   c. a moved start re-times the lock (later and earlier).
 *   d. the locked values equal the lineup pull's lock step (lockGameOdds
 *      with the lineup path's arguments) on an identical game; runLineupJob
 *      still calls it from its window check.
 *   e. nothing else runs: no network, no model, no signal changes beyond
 *      the closing columns, no rows anywhere but the closing audits and one
 *      cron_log row.
 *
 * Runs against a throwaway database.
 *
 *   node scripts/test-per-game-lock.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__per_game_lock_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load

// Network blocked and counted: the lock must not fetch anything.
let netCalls = 0;
for (const m of ['http', 'https']) {
  const mod = require(m);
  mod.request = () => { netCalls++; throw new Error('network blocked in test'); };
  mod.get = mod.request;
}
globalThis.fetch = async () => { netCalls++; throw new Error('network blocked in test'); };

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

const { db } = require(path.join(R, 'db/schema'));
const jobs = require(path.join(R, 'services/jobs'));
const insGl = db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, game_time, scheduled_start_utc, game_status, is_removed,
  market_away_ml, market_home_ml, market_total, over_price, under_price, ml_source, odds_locked_at, market_total_at_emit) VALUES
  (@d, @g, @a, @h, @t, @st, @status, @removed, @aml, @hml, @tot, @op, @up, 'kalshi', @lock, NULL)`);
const insSig = db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, model_line, edge_pct,
  outcome, pnl, bet_line, bet_price, bet_locked_at, is_active, cohort) VALUES
  (@gl, @d, @g, @type, @side, @cat, @mkt, @model, 0.04, 'pending', 0, @bl, @bp, @lk, 1, 'v7')`);
function addGame(o) {
  insGl.run(Object.assign({ t: '9:38 PM ET', status: 'Scheduled', removed: 0, aml: 113, hml: -137, tot: 7.5, op: -108, up: -112, lock: null }, o));
  return db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(o.d, o.g).id;
}
function addSig(gl, d, g, o) {
  insSig.run(Object.assign({ gl, d, g, model: -150, bl: null, bp: null, lk: null }, o));
  return db.prepare('SELECT id FROM bet_signals WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?').get(d, g, o.type, o.side).id;
}
const gameRow = (d, g) => db.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(d, g);
const sig = (id) => db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(id);
const closeAudits = (id) => db.prepare("SELECT action, source, detail, closing_line, clv FROM bet_signal_audit WHERE signal_id = ? ORDER BY id").all(id);
const MIN = 60000;
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const pass = (ms) => quiet(() => jobs.runPerGameLockPass(ms));
const dueIds = (ms) => jobs.dueGameLocks(ms).map(d => d.game_id);

try {
  // ---------------------------------------------------------------- a
  console.log('a. a game whose first pitch falls between lineup pulls');
  {
    // 6:38 PM PT start: the 6 PM pull is 38 min early (window opens at T-10),
    // the 11 PM pull is 262 min late (window closes at T+240).
    const D = '2099-06-01', G = 'mil-sd', START = Date.parse('2099-06-02T01:38:00Z');
    const gl = addGame({ d: D, g: G, a: 'MIL', h: 'SD', st: '2099-06-02T01:38:00Z' });
    const ml = addSig(gl, D, G, { type: 'ML', side: 'home', cat: 'fav', mkt: -135, bl: -127, lk: '2099-06-01 20:00:00' });
    const tot = addSig(gl, D, G, { type: 'Total', side: 'over', cat: 'over', mkt: 7.5, model: 8.2, bl: 7.5, bp: -110, lk: '2099-06-01 20:00:00' });
    ok('a: not due at the 6 PM PT pull (T-38)', !dueIds(START - 38 * MIN).includes(G));
    ok('a: not due one minute before the window opens (T-11)', !dueIds(START - 11 * MIN).includes(G) && pass(START - 11 * MIN).locked.length === 0 && !gameRow(D, G).odds_locked_at);
    const r = pass(START - 10 * MIN);
    const g = gameRow(D, G);
    ok('a: locked by the pass when the window opens (T-10)', r.locked.includes(G) && !!g.odds_locked_at, JSON.stringify(r));
    ok('a: market_total_at_emit frozen at lock', g.market_total_at_emit === 7.5, g.market_total_at_emit);
    ok('a: ML closing line and CLV set from the frozen row', sig(ml).closing_line === -137 && sig(ml).clv != null, sig(ml).closing_line + ' clv ' + sig(ml).clv);
    ok('a: Total closing line and price set from the frozen row', sig(tot).closing_line === 7.5 && sig(tot).closing_price === -108, sig(tot).closing_line + ' @ ' + sig(tot).closing_price);
    const au = closeAudits(ml);
    ok('a: one set_closing_line audit, source cron_closing_lock, detail names the pass', au.length === 1 && au[0].action === 'set_closing_line'
      && au[0].source === 'cron_closing_lock' && au[0].detail === 'odds locked at game start gate (per-game lock pass)', JSON.stringify(au));
    const cl = db.prepare("SELECT job_type, run_date, status, games_updated, message FROM cron_log WHERE job_type = 'odds_lock'").all();
    ok('a: one odds_lock cron_log row', cl.length === 1 && cl[0].run_date === D && cl[0].games_updated === 1 && /mil-sd/.test(cl[0].message), JSON.stringify(cl));
    ok('a: still due-free and idempotent at T-9 (no re-lock, no new audit)', pass(START - 9 * MIN).locked.length === 0 && closeAudits(ml).length === 1);
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. locked, postponed, cancelled, removed, placeholder and start-less rows');
  {
    const D = '2099-06-02', ST = '2099-06-02T20:00:00Z', NOW = Date.parse(ST) - 5 * MIN;
    const lockedGl = addGame({ d: D, g: 'nyy-bos', a: 'NYY', h: 'BOS', st: ST, lock: '2099-06-02 19:40:00' });
    const lockedSig = addSig(lockedGl, D, 'nyy-bos', { type: 'ML', side: 'away', cat: 'dog', mkt: 120, bl: 118, lk: '2099-06-02 12:00:00' });
    const before = gameRow(D, 'nyy-bos'), beforeSig = sig(lockedSig);
    addGame({ d: D, g: 'tb-tor', a: 'TB', h: 'TOR', st: ST, status: 'Postponed: Rain' });
    addGame({ d: D, g: 'kc-min', a: 'KC', h: 'MIN', st: ST, status: 'Cancelled: Rain' });
    addGame({ d: D, g: 'sea-tex', a: 'SEA', h: 'TEX', st: ST, removed: 1 });
    addGame({ d: D, g: 'atl/phi-lad', a: 'ATL/PHI', h: 'LAD', st: ST });
    addGame({ d: D, g: 'cle-det', a: 'CLE', h: 'DET', st: null });
    addGame({ d: D, g: 'chc-stl', a: 'CHC', h: 'STL', st: ST });       // the one game that should lock
    ok('b: only the plain unlocked game is due', JSON.stringify(dueIds(NOW)) === JSON.stringify(['chc-stl']), JSON.stringify(dueIds(NOW)));
    const r = pass(NOW);
    ok('b: the pass locks only it', JSON.stringify(r.locked) === JSON.stringify(['chc-stl']), JSON.stringify(r));
    const after = gameRow(D, 'nyy-bos');
    ok('b: the already-locked game is untouched (whole row, its signal, no audit)', JSON.stringify(before) === JSON.stringify(after)
      && JSON.stringify(beforeSig) === JSON.stringify(sig(lockedSig)) && closeAudits(lockedSig).length === 0);
    for (const g of ['tb-tor', 'kc-min', 'sea-tex', 'atl/phi-lad', 'cle-det']) ok('b: ' + g + ' left unlocked', gameRow(D, g).odds_locked_at == null);
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. a moved start re-times the lock');
  {
    const D = '2099-06-03', G = 'lad-sf', OLD = Date.parse('2099-06-03T23:00:00Z');
    addGame({ d: D, g: G, a: 'LAD', h: 'SF', st: '2099-06-03T23:00:00Z' });
    // delayed two hours before the old window opened
    db.prepare('UPDATE game_log SET scheduled_start_utc = ? WHERE game_date = ? AND game_id = ?').run('2099-06-04T01:00:00Z', D, G);
    const NEW = Date.parse('2099-06-04T01:00:00Z');
    ok('c: later start -- not locked at the old T-10', pass(OLD - 10 * MIN).locked.length === 0 && !gameRow(D, G).odds_locked_at);
    ok('c: later start -- not locked at the old start either', pass(OLD).locked.length === 0 && !gameRow(D, G).odds_locked_at);
    ok('c: later start -- not locked at the new T-11', pass(NEW - 11 * MIN).locked.length === 0);
    ok('c: later start -- locked at the new T-10', pass(NEW - 10 * MIN).locked.includes(G) && !!gameRow(D, G).odds_locked_at);

    const D2 = '2099-06-04', G2 = 'ari-col', OLD2 = Date.parse('2099-06-05T01:40:00Z');
    addGame({ d: D2, g: G2, a: 'ARI', h: 'COL', st: '2099-06-05T01:40:00Z' });
    db.prepare('UPDATE game_log SET scheduled_start_utc = ? WHERE game_date = ? AND game_id = ?').run('2099-06-04T22:10:00Z', D2, G2);
    const NEW2 = Date.parse('2099-06-04T22:10:00Z');
    ok('c: earlier start -- locked at the new T-10, hours before the old one', pass(NEW2 - 10 * MIN).locked.includes(G2) && NEW2 < OLD2 - 3 * 60 * MIN);
  }

  // ---------------------------------------------------------------- d
  console.log('\nd. the same values as the lineup pull\'s lock step');
  {
    const D = '2099-06-05', START = Date.parse('2099-06-05T23:10:00Z');
    const twins = {};
    for (const G of ['bal-nyy', 'bal-nyy-g2']) {
      const gl = addGame({ d: D, g: G, a: 'BAL', h: 'NYY', st: '2099-06-05T23:10:00Z', aml: 142, hml: -170, tot: 8.5, op: -102, up: -118 });
      twins[G] = [
        addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'dog', mkt: 150, bl: 148, lk: '2099-06-05 15:00:00' }),
        addSig(gl, D, G, { type: 'ML', side: 'home', cat: 'fav', mkt: -165 }),
        addSig(gl, D, G, { type: 'Total', side: 'under', cat: 'under', mkt: 8.5, model: 7.8, bl: 8.5, bp: -115, lk: '2099-06-05 15:00:00' }),
      ];
    }
    // The lineup pull's call, exactly as runLineupJob makes it.
    quiet(() => jobs.lockGameOdds(D, 'bal-nyy', '10min', 'odds locked at game start gate'));
    // The new pass for the twin (bal-nyy is now locked, so only the twin is due).
    const r = pass(START - 10 * MIN);
    ok('d: the pass locked only the twin', JSON.stringify(r.locked) === JSON.stringify(['bal-nyy-g2']), JSON.stringify(r));
    const a = gameRow(D, 'bal-nyy'), b = gameRow(D, 'bal-nyy-g2');
    const strip = (x, keys) => { const o = Object.assign({}, x); for (const k of keys) delete o[k]; return o; };
    const GL_KEYS = ['id', 'game_id', 'odds_locked_at', 'created_at', 'updated_at'];
    ok('d: game_log rows identical apart from id and lock timestamp', JSON.stringify(strip(a, GL_KEYS)) === JSON.stringify(strip(b, GL_KEYS))
      && !!a.odds_locked_at && !!b.odds_locked_at);
    const SIG_KEYS = ['id', 'game_log_id', 'game_id', 'created_at', 'updated_at'];
    for (let i = 0; i < 3; i++) {
      const x = sig(twins['bal-nyy'][i]), y = sig(twins['bal-nyy-g2'][i]);
      ok('d: ' + x.signal_type + ' ' + x.signal_side + ' closing_line / closing_price / clv identical (' + x.closing_line + ' / ' + x.closing_price + ' / ' + x.clv + ')',
        JSON.stringify(strip(x, SIG_KEYS)) === JSON.stringify(strip(y, SIG_KEYS)) && x.closing_line != null);
      const ax = closeAudits(x.id), ay = closeAudits(y.id);
      ok('d: ' + x.signal_type + ' ' + x.signal_side + ' audit identical apart from the detail suffix', ax.length === 1 && ay.length === 1
        && ax[0].closing_line === ay[0].closing_line && ax[0].clv === ay[0].clv && ax[0].source === ay[0].source
        && ax[0].detail === 'odds locked at game start gate' && ay[0].detail === 'odds locked at game start gate (per-game lock pass)');
    }
    // runLineupJob still locks through lockGameOdds, inside its own window check.
    const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
    const lj = src.slice(src.indexOf('async function runLineupJob('), src.indexOf('async function runLineupJob(') + 60000);
    ok('d: runLineupJob calls lockGameOdds with its label and detail inside minsToGame<=10&&minsToGame>=-240',
      /if\(minsToGame<=10&&minsToGame>=-240\)\{[\s\S]{0,400}lockGameOdds\(dateStr, gameId, minsToGame\+'min', 'odds locked at game start gate'\);/.test(lj));
    ok('d: the lock UPDATE exists once in lockGameOdds and nowhere in runLineupJob', !/UPDATE game_log SET odds_locked_at/.test(lj.slice(0, lj.indexOf('// SP source precedence'))));
  }

  // ---------------------------------------------------------------- e
  console.log('\ne. nothing else runs');
  {
    const D = '2099-06-06', G = 'hou-ath', START = Date.parse('2099-06-07T02:05:00Z');
    const gl = addGame({ d: D, g: G, a: 'HOU', h: 'ATH', st: '2099-06-07T02:05:00Z' });
    const s1 = addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'fav', mkt: -120, bl: -118, lk: '2099-06-06 18:00:00' });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    const counts = () => Object.fromEntries(tables.map(t => [t, db.prepare('SELECT COUNT(*) n FROM "' + t + '"').get().n]));
    const c0 = counts(), g0 = gameRow(D, G), s0 = sig(s1), net0 = netCalls;
    const r = pass(START - 10 * MIN);
    const c1 = counts(), g1 = gameRow(D, G), s1r = sig(s1);
    const grew = Object.keys(c1).filter(t => c1[t] !== c0[t]).map(t => t + ' +' + (c1[t] - c0[t]));
    ok('e: locked', r.locked.includes(G));
    ok('e: no network call', netCalls === net0, String(netCalls - net0));
    ok('e: rows added only to bet_signal_audit (+1 closing) and cron_log (+1)', JSON.stringify(grew.sort()) === JSON.stringify(['bet_signal_audit +1', 'cron_log +1']), grew.join(', '));
    const gDiff = Object.keys(g1).filter(k => !Object.is(g0[k], g1[k]));
    ok('e: game_log: only odds_locked_at and market_total_at_emit changed (model, odds, lineups untouched)', JSON.stringify(gDiff.sort()) === JSON.stringify(['market_total_at_emit', 'odds_locked_at']), gDiff.join(','));
    const sDiff = Object.keys(s1r).filter(k => !Object.is(s0[k], s1r[k]));
    ok('e: bet_signals: only closing_line and clv changed (no model or signal rerun)', JSON.stringify(sDiff.sort()) === JSON.stringify(['closing_line', 'clv']), sDiff.join(','));
    ok('e: no network call across the whole test', netCalls === 0, String(netCalls));
    // Wired into the scheduler: the tick lives in startCronJobs and goes through the job queue.
    const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
    const sc = src.slice(src.indexOf('function startCronJobs()'));
    ok('e: startCronJobs runs a one-minute tick that queues runPerGameLockPass via _queued', /setInterval\([\s\S]{0,400}dueGameLocks\(\)[\s\S]{0,400}_queued\('per-game lock[\s\S]{0,200}runPerGameLockPass\(\)[\s\S]{0,200}\}, 60000\)/.test(sc));
  }
} finally {
  try { db.close(); } catch (e) {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + s); } catch (e) {} }
}
console.log('\n' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
