#!/usr/bin/env node
'use strict';
// Lock correctness (2026-10-26, #528, #525).
//
//   node scripts/test-lock-correctness.js
//
// Exit 1 on any failure. No network (all fetch is blocked and counted), and
// data/mlb.db is never opened: MLB_DB_PATH points db/schema at a temp file.
//
// WHY. (1) The per-game lock locked 2026-10-08 CLE @ CWS at 20:50Z, T-10 of
// a stale scheduled_start_utc (21:00Z, the original 5:00 PM ET), 3 hours
// before its 8:00 PM ET first pitch; game_time already said 8:00 PM. When the
// two stored start times disagree, the pass now asks MLB (one fetchSchedule
// for the date) and locks at T-10 of MLB's start; with no answer it uses the
// later of the two. (2) The odds job's second lock site wrote closes from the
// odds it had just fetched, in-game prices for a started game; it now locks
// from the stored row, and withholds the close when that row's last odds
// write came after first pitch.
//
//   a. disagreeing start times: no early lock; the lock lands at T-10 of the
//      correct start (MLB's, or the later one when MLB can't be reached);
//      one schedule fetch, not one per minute.
//   b. agreeing start times: unchanged (T-10, no fetch, same values).
//   c. second lock site: closes from the stored row, not the fetched odds; a
//      row written after first pitch gets no close and a withheld audit, and
//      the ML backfill leaves it empty.
//   d. nothing else changes: no model calls, no signal changes beyond the
//      closing columns, no fetch but the start checks, rows added only where
//      expected.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-correctness-'));
process.env.MLB_DB_PATH = path.join(TMP, 'test.db');   // NEVER data/mlb.db: set before db/schema can load
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

// ---- network: blocked and counted -------------------------------------------
const netCalls = [];
const blocked = (u) => { netCalls.push(String(u)); throw new Error('network blocked in test: ' + u); };
global.fetch = async (u) => blocked(u);
for (const m of ['http', 'https']) { const mod = require(m); mod.request = (u) => blocked(m + ' ' + u); mod.get = mod.request; }
{
  const nf = require.resolve('node-fetch', { paths: [R] });
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: async (u) => blocked(u) };
}

// ---- stubs and spies, BEFORE jobs.js (it destructures them at require time) --
const mlbSchedule = {};          // date -> rows, or an Error to throw
const scheduleCalls = [];
const scraper = require(path.join(R, 'services/scraper'));
scraper.fetchSchedule = async (date) => {
  scheduleCalls.push(date);
  const v = mlbSchedule[date];
  if (v instanceof Error) throw v;
  return (v || []).map((g, i) => ({ game_number: 1, game_pk: g.game_pk || 700000 + i, venue_id: null, venue_name: null,
    away_sp: { name: 'Away SP ' + g.game_id, hand: 'R', id: 1000 + i }, home_sp: { name: 'Home SP ' + g.game_id, hand: 'L', id: 2000 + i },
    away_lineup: [], home_lineup: [], lineup_status: 'projected', ...g }));
};
let kalshiRows = [];
const kalshi = require(path.join(R, 'services/kalshi'));
kalshi.getKalshiMlbLines = async () => kalshiRows;
kalshi.getKalshiMlbTotals = async () => [];
kalshi.getKalshiMlbSpreads = async () => [];
const poly = require(path.join(R, 'services/polymarket'));
poly.getPolymarketMlbLines = async () => [];
const modelCalls = [];
const model = require(path.join(R, 'services/model'));
for (const k of Object.keys(model)) {
  if (typeof model[k] !== 'function') continue;
  const f = model[k];
  model[k] = function (...a) { modelCalls.push(k); return f.apply(this, a); };
}

// ---- console capture ----------------------------------------------------------
const logs = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const capture = () => { for (const k of Object.keys(real)) console[k] = (...a) => logs.push(a.map(String).join(' ')); };
const release = () => Object.assign(console, real);

const MIN = 60000;
const etOf = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

(async () => {
  capture();
  try {
    const { db } = require(path.join(R, 'db/schema'));
    const jobs = require(path.join(R, 'services/jobs'));

    const insGl = db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, game_time, scheduled_start_utc, first_pitch_utc,
      game_status, game_pk, market_away_ml, market_home_ml, market_total, over_price, under_price, ml_source, odds_quality_at)
      VALUES (@d, @g, @a, @h, @t, @st, @fp, @status, @pk, @aml, @hml, @tot, @op, @up, 'kalshi', @q)`);
    const addGame = (o) => {
      insGl.run(Object.assign({ fp: null, status: 'Scheduled', pk: null, aml: 113, hml: -137, tot: 7.5, op: -108, up: -112, q: null }, o));
      return db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(o.d, o.g).id;
    };
    const insSig = db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, model_line,
      edge_pct, outcome, pnl, bet_line, bet_price, bet_locked_at, is_active, cohort)
      VALUES (@gl, @d, @g, @type, @side, @cat, @mkt, @model, 0.04, @outcome, 0, @bl, @bp, '2099-01-01 12:00:00', 1, 'v7')`);
    const addSig = (gl, d, g, o) => {
      insSig.run(Object.assign({ gl, d, g, model: -150, outcome: 'pending', bl: null, bp: null }, o));
      return db.prepare('SELECT id FROM bet_signals WHERE game_date = ? AND game_id = ? AND signal_type = ? AND signal_side = ?').get(d, g, o.type, o.side).id;
    };
    const row = (d, g) => db.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(d, g);
    const sig = (id) => db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(id);
    const audits = (id) => db.prepare('SELECT action, source, detail, closing_line, clv FROM bet_signal_audit WHERE signal_id = ? ORDER BY id').all(id);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
    const counts = () => Object.fromEntries(tables.map(t => [t, db.prepare('SELECT COUNT(*) n FROM "' + t + '"').get().n]));
    const grew = (c0, c1) => Object.keys(c1).filter(t => c1[t] !== c0[t]).map(t => t + ' +' + (c1[t] - c0[t])).sort();
    const diffCols = (x, y) => Object.keys(y).filter(k => !Object.is(x[k], y[k])).sort();

    // The production tick, minute by minute: when anything is due, the queued
    // job runs refreshLockStarts then runPerGameLockPass. -> first lock time per game.
    async function tickRun(fromIso, toIso) {
      const first = {};
      for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += MIN) {
        if (!jobs.dueGameLocks(t).length) continue;
        await jobs.refreshLockStarts(t);
        for (const g of jobs.runPerGameLockPass(t).locked) if (!first[g]) first[g] = new Date(t).toISOString().slice(11, 16) + 'Z';
      }
      return first;
    }

    // ------------------------------------------------------------------ a
    section('a. disagreeing start times: no early lock');
    {
      // The 2026-10-08 CLE @ CWS shape: stale 21:00Z (the original 5:00 PM ET)
      // in scheduled_start_utc, game_time 8:00 PM ET, MLB 00:00Z.
      const D = '2099-10-08', G = 'cle-cws';
      const gl = addGame({ d: D, g: G, a: 'CLE', h: 'CWS', st: '2099-10-08T21:00:00Z', t: '8:00 PM ET', pk: 849832, aml: -116, hml: -103 });
      const ml = addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'fav', mkt: -116, bl: -106 });
      mlbSchedule[D] = [{ game_id: G, away_team: 'CLE', home_team: 'CWS', game_pk: 849832, time: '8:00 PM ET', start_utc: '2099-10-09T00:00:00Z' }];
      jobs._resetLockStartChecks();
      const due = jobs.dueGameLocks(Date.parse('2099-10-08T20:50:00Z'));
      check('due at T-10 of the stale time, but only to check it', due.map(d => [d.game_id, d.start_basis, d.mins_to_start, d.mins_to_latest]), [[G, 'check', 10, 190]]);
      check('the pass alone (start never checked) does not lock on the earlier time',
        [jobs.runPerGameLockPass(Date.parse('2099-10-08T20:50:00Z')).locked, row(D, G).odds_locked_at], [[], null]);
      const calls0 = scheduleCalls.length;
      const first = await tickRun('2099-10-08T20:40:00Z', '2099-10-09T00:30:00Z');
      check('locked at T-10 of MLB\'s 8:00 PM ET start (23:50Z), not at 20:50Z', first, { [G]: '23:50Z' });
      check('one schedule fetch for the date, not one per minute', scheduleCalls.slice(calls0), [D]);
      check('scheduled_start_utc corrected to MLB\'s start', row(D, G).scheduled_start_utc, '2099-10-09T00:00:00Z');
      check('the close comes from the stored row at lock (-116), audited as a per-game lock',
        [sig(ml).closing_line, audits(ml).map(a => [a.action, a.detail])], [-116, [['set_closing_line', 'odds locked at game start gate (per-game lock pass)']]]);
      check('the log says why', logs.some(l => /cle-cws: scheduled_start_utc 2099-10-08T21:00:00Z disagrees with game_time 8:00 PM ET; MLB says 2099-10-09T00:00:00Z/.test(l)), true);

      // Doubleheader shape: game_time carries the other leg's time (later); MLB
      // agrees with scheduled_start_utc. The lock must not wait for game_time.
      const D2 = '2099-10-09', G2 = 'pit-cle';
      const gl2 = addGame({ d: D2, g: G2, a: 'PIT', h: 'CLE', st: '2099-10-09T17:10:00Z', t: '7:10 PM ET', pk: 824412 });
      addSig(gl2, D2, G2, { type: 'ML', side: 'home', cat: 'fav', mkt: -137 });
      mlbSchedule[D2] = [{ game_id: G2, away_team: 'PIT', home_team: 'CLE', game_pk: 824412, time: '1:10 PM ET', start_utc: '2099-10-09T17:10:00Z' }];
      const calls1 = scheduleCalls.length;
      check('wrong game_time, right scheduled_start_utc: MLB confirms it, locked at its T-10 (17:00Z)',
        await tickRun('2099-10-09T16:30:00Z', '2099-10-09T23:30:00Z'), { [G2]: '17:00Z' });
      check('...one schedule fetch, scheduled_start_utc unchanged', [scheduleCalls.length - calls1, row(D2, G2).scheduled_start_utc], [1, '2099-10-09T17:10:00Z']);

      // MLB unreachable: the later of the two decides; retries at most every 5 minutes.
      const D3 = '2099-10-10', G3 = 'tb-cle';
      addGame({ d: D3, g: G3, a: 'TB', h: 'CLE', st: '2099-10-10T21:00:00Z', t: '8:00 PM ET', pk: 849817 });
      mlbSchedule[D3] = new Error('statsapi schedule HTTP 503');
      const calls2 = scheduleCalls.length;
      check('MLB unreachable: no lock until T-10 of the later time (23:50Z)', await tickRun('2099-10-10T20:40:00Z', '2099-10-11T00:30:00Z'), { [G3]: '23:50Z' });
      const tries = scheduleCalls.length - calls2;
      check('...retried at most once per 5 minutes (<= 37 in 3 hours), scheduled_start_utc untouched',
        [tries >= 1 && tries <= 37, row(D3, G3).scheduled_start_utc], [true, '2099-10-10T21:00:00Z']);
    }

    // ------------------------------------------------------------------ b
    section('b. agreeing start times: unchanged');
    {
      const D = '2099-10-11', G = 'mil-sd', ST = '2099-10-12T01:38:00Z';
      const gl = addGame({ d: D, g: G, a: 'MIL', h: 'SD', st: ST, t: etOf(ST) });
      const ml = addSig(gl, D, G, { type: 'ML', side: 'home', cat: 'fav', mkt: -135, bl: -127 });
      const tot = addSig(gl, D, G, { type: 'Total', side: 'over', cat: 'over', mkt: 7.5, model: 8.2, bl: 7.5, bp: -110 });
      const calls0 = scheduleCalls.length;
      check('due list exactly as before (plus the basis): at T-10, mins 10, basis scheduled',
        jobs.dueGameLocks(Date.parse(ST) - 10 * MIN).map(d => [d.game_id, d.scheduled_start_utc, d.mins_to_start, d.start_basis]), [[G, ST, 10, 'scheduled']]);
      check('not due at T-11', jobs.dueGameLocks(Date.parse(ST) - 11 * MIN).length, 0);
      check('locked at T-10 (01:28Z)', await tickRun('2099-10-12T00:30:00Z', '2099-10-12T02:00:00Z'), { [G]: '01:28Z' });
      check('no schedule fetch', scheduleCalls.length - calls0, 0);
      check('closes from the stored row: ML -137, Total 7.5 @ -108',
        [sig(ml).closing_line, sig(tot).closing_line, sig(tot).closing_price], [-137, 7.5, -108]);
    }

    // ------------------------------------------------------------------ c
    section('c. the odds job\'s second lock site uses the stored row');
    {
      // Real runOddsJob on today's date. Both games started 30 minutes ago and
      // were never locked. Kalshi now quotes in-game prices (+268 / -330).
      const now = Date.now();
      const TODAY = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const FP = new Date(now - 30 * MIN).toISOString();
      const g1 = addGame({ d: TODAY, g: 'sea-tor', a: 'SEA', h: 'TOR', st: FP, fp: FP, t: etOf(FP), status: 'In Progress', pk: 801,
        aml: -143, hml: 120, tot: 8.5, op: -110, up: -110, q: sqlUtc(now - 75 * MIN) });          // last odds write before first pitch
      const g2 = addGame({ d: TODAY, g: 'tb-det', a: 'TB', h: 'DET', st: FP, fp: FP, t: etOf(FP), status: 'In Progress', pk: 802,
        aml: 105, hml: -122, tot: 7.5, op: -104, up: -116, q: sqlUtc(now - 10 * MIN) });          // last odds write AFTER first pitch
      const s1ml = addSig(g1, TODAY, 'sea-tor', { type: 'ML', side: 'away', cat: 'fav', mkt: -143, bl: -117 });
      const s1tot = addSig(g1, TODAY, 'sea-tor', { type: 'Total', side: 'over', cat: 'over', mkt: 8.5, model: 9.1, bl: 8.5, bp: -104 });
      const s2ml = addSig(g2, TODAY, 'tb-det', { type: 'ML', side: 'home', cat: 'fav', mkt: -122, bl: -116 });
      const s2tot = addSig(g2, TODAY, 'tb-det', { type: 'Total', side: 'over', cat: 'over', mkt: 7.5, model: 8.0, bl: 7.5, bp: -104 });
      // A graded never-locked control the ML backfill should still fill.
      const g3 = addGame({ d: '2099-10-01', g: 'kc-min', a: 'KC', h: 'MIN', st: '2099-10-01T23:40:00Z', t: '7:40 PM ET', aml: 130, hml: -150 });
      const s3ml = addSig(g3, '2099-10-01', 'kc-min', { type: 'ML', side: 'away', cat: 'dog', mkt: 130, bl: 125, outcome: 'win' });

      mlbSchedule[TODAY] = [
        { game_id: 'sea-tor', away_team: 'SEA', home_team: 'TOR', game_pk: 801, time: etOf(FP), start_utc: FP },
        { game_id: 'tb-det', away_team: 'TB', home_team: 'DET', game_pk: 802, time: etOf(FP), start_utc: FP },
      ];
      const kRow = (game_id, away_team, home_team) => ({ game_id, away_team, home_team, start_et: '1910',
        away: { ask_ml: 268, ask_dollars: 0.27 }, home: { ask_ml: -330, ask_dollars: 0.77 }, volume_24h_away: 1000, volume_24h_home: 1000 });
      kalshiRows = [kRow('sea-tor', 'SEA', 'TOR'), kRow('tb-det', 'TB', 'DET')];
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kalshi_direct_primary_enabled','true')").run();

      const before = { s1ml: sig(s1ml), s1tot: sig(s1tot), s2ml: sig(s2ml), s2tot: sig(s2tot), g1: row(TODAY, 'sea-tor'), g2: row(TODAY, 'tb-det') };
      const m0 = modelCalls.length, c0 = counts();
      const res = await jobs.runOddsJob(TODAY, { skipChainedMorningCapture: true });
      check('runOddsJob succeeded', !!(res && res.success), true);
      check('both started games locked', [!!row(TODAY, 'sea-tor').odds_locked_at, !!row(TODAY, 'tb-det').odds_locked_at], [true, true]);
      check('sea-tor (written before first pitch): closes are the stored row\'s, not the fetched +268',
        [sig(s1ml).closing_line, sig(s1tot).closing_line, sig(s1tot).closing_price], [-143, 8.5, -110]);
      check('...CLV from the stored close (bet -117 vs -143)', sig(s1ml).clv, 4.9);
      check('...audited as the started-game lock from the stored row',
        audits(s1ml).map(a => [a.action, a.source, a.detail]), [['set_closing_line', 'cron_closing_lock', 'odds-job started-game lock (stored row)']]);
      check('tb-det (written after first pitch): no closing line, no CLV',
        [sig(s2ml).closing_line, sig(s2ml).clv, sig(s2tot).closing_line, sig(s2tot).closing_price], [null, null, null, null]);
      const wa = audits(s2ml);
      check('...a withheld_closing_line audit saying why', [wa.length, wa[0] && wa[0].action, wa[0] && wa[0].closing_line,
        /^odds-job started-game lock \(stored row\): the stored row's last odds write \(.+ UTC\) came after first pitch \(.+\); no closing line set$/.test(wa[0] && wa[0].detail || '')],
        [1, 'withheld_closing_line', null, true]);
      check('stored prices untouched on both rows', [row(TODAY, 'sea-tor').market_away_ml, row(TODAY, 'tb-det').market_home_ml], [-143, -122]);

      // Graded later: the ML backfill must not guess the withheld close.
      db.prepare("UPDATE bet_signals SET outcome = 'win' WHERE id = ?").run(s2ml);
      jobs.backfillMlClosingLines();
      check('ML backfill leaves the withheld close empty and still fills a normal never-locked bet',
        [sig(s2ml).closing_line, sig(s3ml).closing_line], [null, 130]);

      section('d. nothing else changes');
      check('second site: bet_signals only closing columns changed (sea-tor)', [diffCols(before.s1ml, sig(s1ml)), diffCols(before.s1tot, sig(s1tot))],
        [['closing_line', 'clv'], ['closing_line', 'closing_price', 'clv']]);
      check('second site: withheld signals unchanged until graded (tb-det Total)', diffCols(before.s2tot, sig(s2tot)), []);
      // Audit +5: 2 set_closing_line (sea-tor), 2 withheld_closing_line
      // (tb-det), 1 backfilled_closing_line (the kc-min control). The rest is
      // the odds pass's own Kalshi log and snapshot, one row per game.
      check('second site: no new signals; rows added only to the audits and the odds pass\'s own logs',
        grew(c0, counts()), ['bet_signal_audit +5', 'cron_log +1', 'kalshi_ml_markets_log +2', 'kalshi_ml_markets_snapshot +2']);
      // The odds pass builds its wOBA index once for the slate (buildWobaIndex);
      // the model and signal functions must not run for a started game.
      check('second site: no runModel / getSignals call, only the pass\'s one wOBA index build', modelCalls.slice(m0), ['buildWobaIndex']);
    }
    {
      const D = '2099-10-12', G = 'hou-ath', ST = '2099-10-13T02:05:00Z';
      const gl = addGame({ d: D, g: G, a: 'HOU', h: 'ATH', st: '2099-10-13T00:05:00Z', t: etOf(ST), pk: 901 });   // stale by 2 hours
      const s = addSig(gl, D, G, { type: 'ML', side: 'away', cat: 'fav', mkt: -120, bl: -118 });
      mlbSchedule[D] = [{ game_id: G, away_team: 'HOU', home_team: 'ATH', game_pk: 901, time: etOf(ST), start_utc: ST }];
      const c0 = counts(), g0 = row(D, G), s0 = sig(s), m0 = modelCalls.length, n0 = netCalls.length, f0 = scheduleCalls.length;
      const first = await tickRun('2099-10-12T23:50:00Z', '2099-10-13T02:30:00Z');
      check('per-game lock with a start check: locked at MLB\'s T-10', first, { [G]: '01:55Z' });
      check('...one schedule fetch, no other network, no model call', [scheduleCalls.length - f0, netCalls.length - n0, modelCalls.length - m0], [1, 0, 0]);
      check('...rows added only to bet_signal_audit (+1) and cron_log (+1)', grew(c0, counts()), ['bet_signal_audit +1', 'cron_log +1']);
      check('...game_log: only the lock columns and the corrected start changed', diffCols(g0, row(D, G)), ['market_total_at_emit', 'odds_locked_at', 'scheduled_start_utc']);
      check('...bet_signals: only closing_line and clv changed', diffCols(s0, sig(s)), ['closing_line', 'clv']);
      const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
      check('the tick\'s queued job checks starts, then runs the pass',
        /_queued\('per-game lock[\s\S]{0,200}async \(\) => \{ await refreshLockStarts\(\); return runPerGameLockPass\(\); \}/.test(src), true);
      check('no network attempted anywhere in the test', netCalls, []);
    }
  } catch (e) {
    release();
    console.error('TEST HARNESS ERROR: ' + (e && e.stack || e));
    failures++;
  } finally {
    release();
  }
  console.log(results.join('\n'));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all passed') + '   (network attempts blocked: ' + netCalls.length + ')');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(failures ? 1 : 0);
})();
