#!/usr/bin/env node
'use strict';
/**
 * Totals line/price repair (2026-10-04): POST /api/admin/totals-line-repair and
 * services/totals-line-repair.js, on a throwaway database seeded with the 37
 * production rows as they stand (bet_line holding the price), plus decoys.
 *
 *   a. diff writes nothing and reports all 37 (would write).
 *   b. apply fixes exactly the listed columns on exactly the listed ids, with
 *      one audit row each; a second apply writes nothing.
 *   c. a row whose current values differ from the expected ones (or that is not
 *      the expected bet) is skipped and reported, never overwritten.
 *   d. nothing else changes: bet_signals fingerprinted outside the 37 rows'
 *      listed columns, game_log, and the audit table beyond the new rows.
 *   e. no grading or P&L code is reached (the service requires nothing; the
 *      route takes only withMemLog from services/jobs.js, spied); X-Admin-Token
 *      required; mounted before routes/api.js and its POST /upload/:key?.
 *   f. after apply, the existing grader (gradeBetSignalsForGame) gives the
 *      correct outcome and P&L for each of the 37: 0 outcome changes from what
 *      is stored, exactly the 11 P&L corrections. (Before the fix, the grader's
 *      line rule would flip 24 outcomes: checked too.)
 *
 *   node scripts/test-totals-line-repair.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__totals_line_repair_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
process.env.DB_DOWNLOAD_TOKEN = TOKEN;
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- fixtures: production as of 2026-10-04
// [id, date, game_id, side, bet_line (a price), market_line, closing_line, edge_pct, away, home, stored outcome, stored pnl, correct outcome, correct pnl]
const PROD = [
  [5639, '2026-04-09', 'ari-nym', 'over', -110, 6.5, 6.5, 0.049, 7, 1, 'win', 100, 'win', 100],
  [5641, '2026-04-09', 'cws-kc', 'under', -108, 9.5, 9.5, 0.1171, 2, 0, 'win', 100, 'win', 100],
  [5777, '2026-04-10', 'pit-chc', 'over', -113, 6.5, 6.5, 0.0766, 2, 0, 'loss', -120, 'loss', -113],
  [6002, '2026-04-11', 'pit-chc', 'over', -113, 6.5, 6.5, 0.0419, 4, 3, 'win', 100, 'win', 100],
  [7133, '2026-04-13', 'hou-sea', 'under', -103, 8, 8, 0.0682, 2, 6, 'push', 0, 'push', 0],
  [7134, '2026-04-13', 'chc-phi', 'over', -110, 8.5, 8.5, 0.0622, 7, 13, 'win', 100, 'win', 100],
  [7140, '2026-04-13', 'nym-lad', 'under', -100, 8.5, 8.5, 0.0412, 0, 4, 'win', 100, 'win', 100],
  [7262, '2026-04-14', 'kc-det', 'over', -100, 7.5, 7.5, 0.0543, 1, 2, 'loss', -100, 'loss', -100],
  [7458, '2026-04-14', 'nym-lad', 'under', -103, null, null, 0.0988, 1, 2, 'win', 100, 'win', 100],
  [7739, '2026-04-14', 'chc-phi', 'over', -127, 9.5, 9.5, 0.0788, 10, 4, 'win', 100, 'win', 100],
  [8002, '2026-04-15', 'cle-stl', 'over', -108, 9, 9, 0.0701, 3, 5, 'loss', -98.04, 'loss', -108],
  [8047, '2026-04-15', 'chc-phi', 'over', -108, 8.5, 8.5, 0.0995, 11, 2, 'win', 100, 'win', 100],
  [9194, '2026-04-17', 'kc-nyy', 'over', -110, 7.5, 7.5, 0.0643, 2, 4, 'loss', -125, 'loss', -110],
  [9203, '2026-04-17', 'cin-min', 'under', -110, 8.5, 8.5, 0.1705, 2, 1, 'win', 100, 'win', 100],
  [9204, '2026-04-17', 'tex-sea', 'under', -110, 6.5, 6.5, 0.0482, 5, 0, 'win', 100, 'win', 100],
  [9542, '2026-04-18', 'cin-min', 'under', -110, 8.5, 8.5, 0.0823, 5, 4, 'loss', -135, 'loss', -110],
  [9543, '2026-04-18', 'tb-pit', 'over', 125, 7.5, 7.5, 0.0628, 8, 7, 'win', 100, 'win', 100],
  [9547, '2026-04-18', 'det-bos', 'under', -105, 6.5, 6.5, 0.0707, 4, 1, 'win', 100, 'win', 100],
  [9556, '2026-04-18', 'lad-col', 'under', -113, 10.5, 10.5, 0.1229, 3, 4, 'win', 100, 'win', 100],
  [9558, '2026-04-18', 'sd-laa', 'under', -113, 9.5, 9.5, 0.0578, 4, 1, 'win', 100, 'win', 100],
  [11196, '2026-04-21', 'min-nym', 'under', -108, 7.5, 7.5, 0.0457, 5, 3, 'loss', -133, 'loss', -108],
  [11508, '2026-04-21', 'nyy-bos', 'under', -104, 8.5, 8.5, 0.0471, 4, 0, 'win', 100, 'win', 100],
  [13378, '2026-04-25', 'was-cws', 'under', -117, 8.5, 8.5, 0.1122, 6, 3, 'loss', -108, 'loss', -117],
  [13484, '2026-04-25', 'min-tb', 'under', -104, -104, -104, 42, 1, 6, 'win', 100, 'win', 100],
  [13492, '2026-04-26', 'ath-tex', 'over', -113, 8.5, 8.5, 0.0672, 2, 1, 'loss', -122, 'loss', -113],
  [13552, '2026-04-26', 'min-tb', 'under', -113, 8.5, 8.5, 0.0698, 2, 4, 'win', 100, 'win', 100],
  [13585, '2026-04-26', 'laa-kc', 'under', -104, 8.5, 8.5, 0.0582, 9, 11, 'loss', -104, 'loss', -104],
  [13688, '2026-04-27', 'tb-cle', 'under', -113, 8.5, 8.5, 0.0697, 3, 2, 'win', 100, 'win', 100],
  [13820, '2026-04-27', 'sea-min', 'under', 104, 8.5, 8.5, 0.1406, 4, 11, 'loss', -88.5, 'loss', -96.15],
  [14122, '2026-04-28', 'hou-bal', 'under', -125, 9.5, 9.5, 0.0515, 3, 5, 'win', 100, 'win', 100],
  [14126, '2026-04-28', 'sea-min', 'under', -103, 7.5, 7.5, 0.0606, 7, 1, 'loss', -104, 'loss', -103],
  [14128, '2026-04-28', 'nyy-tex', 'over', 110, 7.5, 7.5, 0.0785, 3, 2, 'loss', -96.15, 'loss', -90.91],
  [14479, '2026-04-29', 'laa-cws', 'under', -103, 8.5, 8.5, 0.1055, 2, 3, 'win', 100, 'win', 100],
  [14706, '2026-04-30', 'sf-phi-g2', 'over', 100, 7.5, 7.5, 0.0516, 5, 6, 'win', 100, 'win', 100],
  [15334, '2026-05-01', 'ari-chc', 'over', -110, 7.5, 7.5, 0.1175, 5, 6, 'win', 100, 'win', 100],
  [16299, '2026-05-02', 'ari-chc', 'over', 100, 7.5, 7.5, 0.0715, 0, 2, 'loss', -96.15, 'loss', -100],
  [18965, '2026-05-08', 'col-phi', 'over', 107, 7.5, 7.5, 0.0886, 9, 7, 'win', 100, 'win', 100],
];
const IDS = PROD.map(r => r[0]);
// game_log's market total for the two corrupt rows' games (where the script recovered 7.5 / 8.5 from).
const GL_TOTAL = { '2026-04-14|nym-lad': 7.5, '2026-04-25|min-tb': 8.5 };

// ---------------------------------------------------------------- the throwaway database
const schema = require(path.join(R, 'db/schema'));
const base = schema.db;
const glIdOf = {};
function seed(db) {
  const insGl = db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, game_number, away_score, home_score, game_status,
    market_total, over_price, under_price) VALUES (?, ?, ?, ?, ?, ?, ?, 'Final', ?, -112, -108)`);
  const insSig = db.prepare(`INSERT INTO bet_signals (id, game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, model_line,
    edge_pct, outcome, pnl, bet_line, bet_price, bet_locked_at, closing_line, clv, is_active, cohort, created_at)
    VALUES (@id, @gl, @d, @g, @type, @side, @cat, @mkt, @model, @edge, @outcome, @pnl, @bl, @bp, '2026-04-01 12:00:00', @close, @clv, 1, 'v3', '2026-04-01 11:00:00')`);
  const gl = (d, g, a, h) => {
    const k = d + '|' + g;
    if (glIdOf[k]) return glIdOf[k];
    const [aw, hm] = g.replace(/-g\d$/, '').split('-');
    insGl.run(d, g, aw.toUpperCase(), hm.toUpperCase(), /-g2$/.test(g) ? 2 : 1, a, h, GL_TOTAL[k] != null ? GL_TOTAL[k] : 8.5);
    return (glIdOf[k] = db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(d, g).id);
  };
  for (const [id, d, g, side, bl, mkt, close, edge, a, h, so, sp] of PROD) {
    insSig.run({ id, gl: gl(d, g, a, h), d, g, type: 'Total', side, cat: side, mkt, model: 8.9, edge, outcome: so, pnl: sp, bl, bp: null, close, clv: null });
  }
  // Decoys: a price-shaped Total NOT on the list, a correct Total, ML bets (logged and not), all on the same games.
  insSig.run({ id: 900001, gl: gl('2026-04-18', 'cin-min', 5, 4), d: '2026-04-18', g: 'cin-min', type: 'Total', side: 'over', cat: 'over', mkt: 8.5, model: 8.0, edge: 0.05, outcome: 'win', pnl: 100, bl: -115, bp: null, close: 8.5, clv: null });
  insSig.run({ id: 900002, gl: gl('2026-05-08', 'col-phi', 9, 7), d: '2026-05-08', g: 'col-phi', type: 'Total', side: 'under', cat: 'under', mkt: 7.5, model: 7.0, edge: 0.07, outcome: 'loss', pnl: -110, bl: 7.5, bp: -110, close: null, clv: null });
  insSig.run({ id: 900003, gl: gl('2026-04-25', 'min-tb', 1, 6), d: '2026-04-25', g: 'min-tb', type: 'ML', side: 'home', cat: 'fav', mkt: -140, model: -160, edge: 0.04, outcome: 'win', pnl: 100, bl: -140, bp: null, close: -150, clv: 2.1 });
  insSig.run({ id: 900004, gl: gl('2026-04-09', 'ari-nym', 7, 1), d: '2026-04-09', g: 'ari-nym', type: 'ML', side: 'away', cat: 'dog', mkt: 120, model: 105, edge: 0.03, outcome: 'win', pnl: 100, bl: null, bp: null, close: 118, clv: null });
}
seed(base);
base.pragma('journal_mode = DELETE');                              // a WAL-mode image cannot be opened from memory
const SNAP = base.serialize();
const Sqlite = require(path.join(R, 'node_modules/better-sqlite3'));
const fresh = () => new Sqlite(SNAP);
const repair = require(path.join(R, 'services/totals-line-repair'));
const hashOf = (db, sql) => crypto.createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex');
const sigCols = base.prepare('PRAGMA table_info(bet_signals)').all().map(c => c.name);
const LISTED = new Map(repair.FIXES.map(f => [f.id, new Set(Object.keys(f.target))]));
// bet_signals with every listed column of every listed id blanked out: must not move.
const outsideHash = (db) => crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM bet_signals ORDER BY id').all()
  .map(r => sigCols.map(c => (LISTED.has(r.id) && LISTED.get(r.id).has(c)) ? '<listed>' : r[c])))).digest('hex');
const sig = (db, id) => db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(id);

(async () => {
  // ---------------------------------------------------------------- a
  console.log('a. diff writes nothing and reports all 37');
  {
    const db = fresh();
    const h0 = hashOf(db, 'SELECT * FROM bet_signals ORDER BY id'), a0 = hashOf(db, 'SELECT * FROM bet_signal_audit ORDER BY id');
    const tc0 = db.prepare('SELECT total_changes() c').get().c;
    const d = repair.run({}, { db });
    ok('the list is exactly the 37 ids (35 backfill + 7458, 13484)', repair.FIXES.length === 37 && JSON.stringify(repair.FIXES.map(f => f.id)) === JSON.stringify([...IDS].sort((x, y) => x - y))
      && repair.FIXES.filter(f => f.script === 'fix-corrupt-totals-rows').map(f => f.id).join(',') === '7458,13484');
    ok('diff (default mode): 37 would write, 0 skip', d.mode === 'diff' && d.ids === 37 && d.would_write === 37 && d.would_skip === 0, JSON.stringify({ w: d.would_write, s: d.would_skip }));
    ok('each item carries current, expected and target values and the action',
      d.items.length === 37 && d.items.every(i => i.current && i.expected && i.target && i.action === 'write'));
    const i5639 = d.items.find(i => i.id === 5639), i13484 = d.items.find(i => i.id === 13484);
    ok('e.g. 5639: bet_line -110 -> 6.5, bet_price null -> -110; 13484 also market_line/closing_line -104 -> 8.5, edge_pct 42 -> null',
      i5639.current.bet_line === -110 && i5639.target.bet_line === 6.5 && i5639.target.bet_price === -110
      && i13484.target.market_line === 8.5 && i13484.target.closing_line === 8.5 && i13484.target.edge_pct === null && i13484.current.edge_pct === 42);
    ok('diff wrote nothing (no change, bet_signals and audit identical)', db.prepare('SELECT total_changes() c').get().c === tc0
      && hashOf(db, 'SELECT * FROM bet_signals ORDER BY id') === h0 && hashOf(db, 'SELECT * FROM bet_signal_audit ORDER BY id') === a0);
    ok('an unknown mode is refused', /mode must be/.test(repair.run({ mode: 'grade' }, { db }).error || ''));
  }

  // ---------------------------------------------------------------- b + d
  console.log('\nb/d. apply fixes exactly the listed columns on exactly the listed ids; nothing else moves; a second apply writes nothing');
  {
    const db = fresh();
    const out0 = outsideHash(db), gl0 = hashOf(db, 'SELECT * FROM game_log ORDER BY id'), aud0 = db.prepare('SELECT COUNT(*) n FROM bet_signal_audit').get().n;
    const before = new Map(IDS.map(id => [id, sig(db, id)]));
    const a1 = repair.run({ mode: 'apply' }, { db });
    ok('apply: 37 written, 0 skipped', a1.written === 37 && a1.skipped === 0, JSON.stringify({ w: a1.written, s: a1.skipped, sk: a1.skipped_items }));
    const bad = repair.FIXES.filter(f => { const r = sig(db, f.id); return !Object.entries(f.target).every(([k, v]) => (r[k] == null && v == null) || Number(r[k]) === v); });
    ok('every listed id now holds its target values', bad.length === 0, bad.map(f => f.id).join(','));
    ok('35 rows: bet_line = the old market_line, bet_price = the old bet_line (the price)', repair.FIXES.filter(f => f.script === 'backfill-totals-bet-price')
      .every(f => { const b = before.get(f.id), r = sig(db, f.id); return r.bet_line === b.market_line && r.bet_price === b.bet_line && r.market_line === b.market_line; }));
    const r7458 = sig(db, 7458), r13484 = sig(db, 13484);
    ok('7458: market_line/bet_line 7.5, bet_price -103, edge_pct 0.0988 and closing_line NULL kept (as fix-corrupt-totals-rows)',
      r7458.market_line === 7.5 && r7458.bet_line === 7.5 && r7458.bet_price === -103 && r7458.edge_pct === 0.0988 && r7458.closing_line === null);
    ok('13484: market_line/bet_line/closing_line 8.5, bet_price -104, edge_pct NULL', r13484.market_line === 8.5 && r13484.bet_line === 8.5
      && r13484.closing_line === 8.5 && r13484.bet_price === -104 && r13484.edge_pct === null);
    ok('outcome and pnl untouched on all 37 (no grading)', IDS.every(id => { const b = before.get(id), r = sig(db, id); return r.outcome === b.outcome && r.pnl === b.pnl; }));
    ok('d: bet_signals outside the 37 rows\' listed columns is byte-identical (decoys, other columns, every other row)', outsideHash(db) === out0);
    ok('d: game_log is byte-identical', hashOf(db, 'SELECT * FROM game_log ORDER BY id') === gl0);
    const aud = db.prepare('SELECT * FROM bet_signal_audit WHERE id > 0 ORDER BY id').all().slice(aud0);
    ok('one audit row per changed bet, action totals_line_repair, source naming the route, before/after in detail',
      aud.length === 37 && aud.every(r => r.action === 'totals_line_repair' && r.source === 'admin_totals_line_repair' && r.signal_type === 'Total')
      && JSON.stringify(aud.map(r => r.signal_id).sort((x, y) => x - y)) === JSON.stringify([...IDS].sort((x, y) => x - y))
      && JSON.parse(aud.find(r => r.signal_id === 5639).detail).before.bet_line === -110 && JSON.parse(aud.find(r => r.signal_id === 5639).detail).after.bet_line === 6.5);
    ok('the decoy price-shaped Total not on the list (900001) is untouched', sig(db, 900001).bet_line === -115 && sig(db, 900001).bet_price === null);
    const snapAfter = hashOf(db, 'SELECT * FROM bet_signals ORDER BY id'), audN = db.prepare('SELECT COUNT(*) n FROM bet_signal_audit').get().n;
    const a2 = repair.run({ mode: 'apply' }, { db });
    ok('a second apply writes nothing (37 skipped as already repaired, no audit rows)', a2.written === 0 && a2.skipped === 37
      && a2.skipped_items.every(s => /already repaired/.test(s.reason)) && hashOf(db, 'SELECT * FROM bet_signals ORDER BY id') === snapAfter
      && db.prepare('SELECT COUNT(*) n FROM bet_signal_audit').get().n === audN);
    const d2 = repair.run({}, { db });
    ok('diff after apply: 0 would write', d2.would_write === 0 && d2.would_skip === 37);
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. a row that is not as expected is skipped and reported, never overwritten');
  {
    const db = fresh();
    db.prepare('UPDATE bet_signals SET bet_line = -111 WHERE id = 9542').run();                       // someone edited the price
    db.prepare('UPDATE bet_signals SET market_line = 9.0 WHERE id = 7262').run();                      // the source of the target total moved
    db.prepare('UPDATE bet_signals SET bet_price = -105 WHERE id = 13378').run();                      // a price already recorded
    db.prepare('UPDATE bet_signals SET edge_pct = 0.5 WHERE id = 13484').run();                        // a corrupt row with a different edge
    db.prepare("UPDATE bet_signals SET game_id = 'zzz-yyy' WHERE id = 14706").run();                  // not the expected bet
    db.prepare('DELETE FROM bet_signals WHERE id = 18965').run();                                      // gone
    const TAMPERED = [9542, 7262, 13378, 13484, 14706, 18965];
    const before = new Map(TAMPERED.map(id => [id, sig(db, id)]));
    const d = repair.run({}, { db });
    ok('diff: 31 would write, the 6 tampered rows skip with a reason', d.would_write === 31 && d.would_skip === 6
      && TAMPERED.every(id => { const i = d.items.find(x => x.id === id); return i.action === 'skip' && i.reason; }), JSON.stringify(d.items.filter(i => i.action === 'skip').map(i => i.id + ': ' + i.reason)));
    const a = repair.run({ mode: 'apply' }, { db });
    ok('apply: 31 written, the 6 skipped and reported', a.written === 31 && a.skipped === 6
      && JSON.stringify(a.skipped_items.map(s => s.id).sort((x, y) => x - y)) === JSON.stringify([...TAMPERED].sort((x, y) => x - y)));
    ok('each skipped row is exactly as it was (not overwritten)', TAMPERED.every(id => JSON.stringify(sig(db, id)) === JSON.stringify(before.get(id))));
    const rs = (id) => a.skipped_items.find(s => s.id === id).reason;
    ok('the reasons name what differs', /bet_line=-111 \(expected -110\)/.test(rs(9542)) && /market_line=9 \(expected 7.5\)/.test(rs(7262))
      && /bet_price=-105/.test(rs(13378)) && /edge_pct=0.5 \(expected 42\)/.test(rs(13484)) && /not the expected bet/.test(rs(14706)) && /no bet_signals row/.test(rs(18965)),
      JSON.stringify(a.skipped_items.map(s => s.reason)));
  }

  // ---------------------------------------------------------------- e (the route, real jobs.js behind a spy)
  console.log('\ne. no grading or P&L code; auth; mount order');
  {
    const src = read('services/totals-line-repair.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    ok('the service requires nothing (no model, grading, odds or signal code can run)', reqs.length === 0, reqs.join(','));
    ok('the service names no grading or P&L function and writes no outcome / pnl / clv column',
      !/calcPnl|gradeBetSignals|calcRunlinePnl|toWin100|clvForSignal|processGameSignals|runModel/.test(src) && !/SET[^'"]*\b(outcome|pnl|clv)\b\s*=/.test(src));
    const jobsPath = require.resolve(path.join(R, 'services/jobs'));
    const realJobs = require(jobsPath);
    const modelPath = require.resolve(path.join(R, 'services/model'));
    const realModel = require(modelPath);
    const touched = new Set(), modelTouched = new Set();
    require.cache[jobsPath].exports = new Proxy(realJobs, { get(t, k) { if (typeof k === 'string') touched.add(k); return t[k]; } });
    require.cache[modelPath].exports = new Proxy(realModel, { get(t, k) { if (typeof k === 'string') modelTouched.add(k); return t[k]; } });
    const router = require(path.join(R, 'routes/totals-line-repair'));
    const db = fresh();
    router._setDeps({ db });                                               // the queue comes from (the spied) services/jobs.js
    const express = require(path.join(R, 'node_modules/express'));
    const app = express(); app.use('/api', router);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const post = (body, headers) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/admin/totals-line-repair',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
        let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* */ } resolve({ code: res.statusCode, body: j }); });
      });
      rq.on('error', reject); rq.end(JSON.stringify(body));
    });
    const tc0 = db.prepare('SELECT total_changes() c').get().c;
    const noTok = await post({ mode: 'apply' }), badTok = await post({ mode: 'apply' }, { 'X-Admin-Token': TOKEN + 'x' });
    ok('no token / wrong token -> 401, nothing written', noTok.code === 401 && badTok.code === 401 && db.prepare('SELECT total_changes() c').get().c === tc0);
    const badMode = await post({ mode: 'grade' }, { 'X-Admin-Token': TOKEN });
    ok('an unknown mode -> 400', badMode.code === 400);
    const diff = await post({}, { 'X-Admin-Token': TOKEN });
    ok('diff (the default) through the route: 37 would write, nothing written', diff.code === 200 && diff.body.mode === 'diff' && diff.body.would_write === 37
      && db.prepare('SELECT total_changes() c').get().c === tc0);
    const ap = await post({ mode: 'apply' }, { 'X-Admin-Token': TOKEN });
    const ap2 = await post({ mode: 'apply' }, { 'X-Admin-Token': TOKEN });
    ok('apply through the route: 37 written, then 0', ap.code === 200 && ap.body.written === 37 && ap2.body.written === 0, JSON.stringify([ap.body.written, ap2.body.written]));
    ok('SPY: from services/jobs.js the route took exactly withMemLog (no grader, no model, odds, lineup or signal function)',
      JSON.stringify([...touched].filter(k => !['__esModule', 'then', 'default'].includes(k)).sort()) === '["withMemLog"]', [...touched].join(','));
    ok('SPY: nothing in services/model.js (calcPnl, calcRunlinePnl, runModel) was touched', modelTouched.size === 0, [...modelTouched].join(','));
    await new Promise(r => server.close(r));
    require.cache[jobsPath].exports = realJobs;
    require.cache[modelPath].exports = realModel;
    const srv = read('server.js').replace(/\/\/.*$/gm, '');
    const iR = srv.indexOf("app.use('/api', require('./routes/totals-line-repair'));"), iApi = srv.indexOf("app.use('/api', require('./routes/api'));");
    ok('server.js mounts the router before routes/api.js (and its POST /upload/:key? catch-all)', iR > 0 && iApi > iR);
    ok('routes/api.js still holds the /upload/:key? catch-all this order protects against, and no route on this path',
      /router\.post\('\/upload\/:key\?'/.test(read('routes/api.js')) && !/totals-line-repair/.test(read('routes/api.js')));
    const routeSrc = read('routes/totals-line-repair.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok('the route is admin-gated and names only withMemLog from services/jobs.js',
      /router\.post\('\/admin\/totals-line-repair', requireAdminToken/.test(routeSrc)
      && JSON.stringify([...new Set([...routeSrc.matchAll(/jobs'\)\.(\w+)/g)].map(m => m[1]))]) === '["withMemLog"]');
  }

  // ---------------------------------------------------------------- f (on the schema db: the grader writes through it)
  console.log('\nf. after apply, the existing grader gives the correct outcome and P&L');
  {
    const jobs = require(path.join(R, 'services/jobs'));
    const { calcPnl } = require(path.join(R, 'services/model'));
    const glOf = (d, g) => base.prepare('SELECT * FROM game_log WHERE game_date = ? AND game_id = ?').get(d, g);
    // Before the fix: what today's line rule would do to the stored rows (calcPnl is what the grader calls for the outcome).
    let flips = 0;
    for (const id of IDS) { const s = sig(base, id), g = glOf(s.game_date, s.game_id);
      const o = calcPnl({ type: 'Total', side: s.signal_side, marketLine: s.market_line, bet_line: s.bet_line }, g.away_score, g.home_score, g.market_total).outcome;
      if (o !== s.outcome) flips++; }
    ok('before the fix, the grader\'s line rule would flip 24 of the 37 outcomes', flips === 24, String(flips));
    const a = repair.run({ mode: 'apply' }, { db: base });
    ok('apply on the schema db: 37 written', a.written === 37);
    const stored = new Map(IDS.map(id => [id, sig(base, id)]));
    const games = [...new Set(PROD.map(r => r[1] + '|' + r[2]))];
    for (const k of games) { const [d, g] = k.split('|'); const row = glOf(d, g); jobs.gradeBetSignalsForGame(d, g, row, row.away_score, row.home_score); }
    const wrong = PROD.filter(([id, , , , , , , , , , , , co, cp]) => { const r = sig(base, id); return r.outcome !== co || Math.abs(r.pnl - cp) > 0.005; });
    ok('every one of the 37 grades to the correct outcome and P&L from the table', wrong.length === 0,
      wrong.map(([id, , , , , , , , , , , , co, cp]) => id + ' got ' + sig(base, id).outcome + ' ' + sig(base, id).pnl + ' want ' + co + ' ' + cp).join('; '));
    const outcomeChanges = IDS.filter(id => sig(base, id).outcome !== stored.get(id).outcome);
    const pnlChanges = IDS.filter(id => Math.abs(sig(base, id).pnl - stored.get(id).pnl) > 0.005);
    ok('0 outcome changes from what is stored', outcomeChanges.length === 0, outcomeChanges.join(','));
    ok('exactly the 11 P&L corrections', JSON.stringify(pnlChanges.sort((x, y) => x - y)) === JSON.stringify([5777, 8002, 9194, 9542, 11196, 13378, 13492, 13820, 14126, 14128, 16299]),
      pnlChanges.join(','));
    ok('their net effect is +$56.78', Math.abs(pnlChanges.reduce((x, id) => x + sig(base, id).pnl - stored.get(id).pnl, 0) - 56.78) < 0.005);
  }

  try { base.close(); } catch (e) { /* closed */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
