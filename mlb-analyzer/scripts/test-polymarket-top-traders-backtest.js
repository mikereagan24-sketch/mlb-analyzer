#!/usr/bin/env node
'use strict';
/**
 * Polymarket top-traders backtest (services/polymarket-top-traders-backtest.js)
 * on SYNTHETIC data only: no real outcome is read, no network, and data/mlb.db
 * is never opened (a throwaway MLB_DB_PATH is set before anything can load
 * db/schema).
 *
 *   a. as-of qualification uses only games dated strictly before D; a same-date
 *      doubleheader game 1 is not history for game 2
 *   b. the lean: dollar-weighted, sells subtract, net-short fills count, both
 *      nets <= 0, a tie to the cent, the cut at min(lock, cutoff), the top-25
 *      tie-break by wallet id
 *   c. step order: eligibility -> price -> lean -> tested
 *   d. the confirmed set, incl. a game with no first_pitch_utc falling outside
 *   e. sensitivity runs are outside BH and cannot set significance
 *   f. the pre-registration hash pin refuses a modified document
 *   g. isolation from the pricing path, with self-tests
 *
 *   node scripts/test-polymarket-top-traders-backtest.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__pm_toptraders_test_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                  // before anything can load db/schema
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const bt = require(path.join(R, 'services/polymarket-top-traders-backtest'));
const bf = require(path.join(R, 'services/polymarket-backfill'));

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}
const U = (iso) => Math.floor(Date.parse(iso) / 1000);
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);

// ---- a synthetic world: 30 wallets build 40 games of history over 40 days,
// then each test game sits on its own later date.
function makeWorld() {
  const pm = bf.openStore(Database, ':memory:');
  const mlb = new Database(':memory:');
  mlb.exec(`CREATE TABLE game_log (game_date TEXT, game_id TEXT, odds_locked_at TEXT, market_away_ml INTEGER,
    market_home_ml INTEGER, market_contamination_reason TEXT, ml_source TEXT, first_pitch_utc TEXT, is_removed INTEGER);
    CREATE TABLE empirical_market_captures (game_date TEXT, game_id TEXT, market_type TEXT, away_price_ml INTEGER,
    home_price_ml INTEGER, generated_at TEXT);`);
  let cid = 0;
  const w = {
    pm, mlb,
    market(date, gid, cutoffIso, o0home) {
      return pm.prepare(`INSERT INTO markets (condition_id, slug, status, game_date, game_id, cutoff_utc, outcome0_is_home, resolved, winner_idx)
        VALUES (?, ?, 'done', ?, ?, ?, ?, 1, 0)`).run('0x' + (++cid), 'mlb-' + gid + '-' + date, date, gid, U(cutoffIso), o0home ? 1 : 0).lastInsertRowid;
    },
    game(date, gid, o) {
      mlb.prepare('INSERT INTO game_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)').run(date, gid, o.lock || null,
        o.away === undefined ? 120 : o.away, o.home === undefined ? -140 : o.home, o.contam || null, o.src === undefined ? 'kalshi' : o.src, o.fp || null);
    },
    capture(date, gid, a, h, ptStamp) {
      mlb.prepare("INSERT INTO empirical_market_captures VALUES (?, ?, 'ml', ?, ?, ?)").run(date, gid, a, h, ptStamp);
    },
    wg(mid, wallet, profit, volume) { pm.prepare('INSERT INTO wallet_game VALUES (?, ?, 0, 0, 0, ?, ?, 1)').run(mid, wallet, profit, volume); },
    fill(mid, wallet, ts, side, outcome, usd) { pm.prepare('INSERT INTO fills VALUES (?, ?, ?, ?, ?, 0.5, ?)').run(mid, wallet, ts, side, outcome, usd / 0.5); },
  };
  const D0 = '2026-05-01';
  for (let d = 0; d < 40; d++) {
    const date = addDays(D0, d);
    const mid = w.market(date, 'his-tor', date + 'T23:00:00Z', 1);
    for (let k = 1; k <= 30; k++) w.wg(mid, k, 1, 10);       // profit 1, volume 10 -> 10x, qualifies at 40 games
    if (d < 39) w.wg(mid, 31, 1, 10);                       // wallet 31: only 39 games of history
  }
  return w;
}
// A standard priced test game: cutoff 23:10Z, lock 23:00Z, first pitch 23:12Z.
function testGame(w, date, gid, o) {
  const opt = Object.assign({ lock: date + ' 23:00:00', fp: date + 'T23:12:00.000Z', cutoff: date + 'T23:10:00Z' }, o || {});
  const mid = w.market(date, gid, opt.cutoff, 1);            // outcome 0 = home
  w.game(date, gid, opt);
  return { mid, cutoff: U(opt.cutoff), lock: opt.lock ? U(opt.lock.replace(' ', 'T') + 'Z') : null };
}
const rowOf = (res, gid, variant) => res.rows.find(r => r.game_id === gid && r.variant === (variant || 'primary'));

(async () => {
  const w = makeWorld();
  const T = (d) => U(d + 'T20:00:00Z');                       // a pre-game fill time
  // ---- a: the doubleheader on 06-10; wallet 31 bets big on outcome 1
  const g1 = testGame(w, '2026-06-10', 'aaa-bbb'), g2 = testGame(w, '2026-06-10', 'aaa-bbb-g2', { cutoff: '2026-06-10T23:11:00Z' });
  w.wg(g1.mid, 31, 1, 10);                                     // wallet 31's 40th game is DH game 1
  for (const g of [g1, g2]) { for (let k = 1; k <= 30; k++) w.fill(g.mid, k, T('2026-06-10'), 1, 0, 1); w.fill(g.mid, 31, T('2026-06-10'), 1, 1, 1000); }
  const n1 = testGame(w, '2026-06-11', 'ccc-ddd');
  for (let k = 1; k <= 30; k++) w.fill(n1.mid, k, T('2026-06-11'), 1, 0, 1);
  w.fill(n1.mid, 31, T('2026-06-11'), 1, 1, 1000);
  // ---- b: lean math, one game per date
  const day = (k) => addDays('2026-06-12', k);
  const gs = {};
  gs.sell = testGame(w, day(0), 'sel-ll'); w.fill(gs.sell.mid, 1, T(day(0)), 1, 0, 10); w.fill(gs.sell.mid, 1, T(day(0)), -1, 0, 8); w.fill(gs.sell.mid, 2, T(day(0)), 1, 1, 3);
  gs.short = testGame(w, day(1), 'net-sho'); w.fill(gs.short.mid, 1, T(day(1)), 1, 0, 5); w.fill(gs.short.mid, 2, T(day(1)), -1, 0, 10); w.fill(gs.short.mid, 3, T(day(1)), 1, 1, 1);
  gs.neg = testGame(w, day(2), 'bot-neg'); w.fill(gs.neg.mid, 1, T(day(2)), -1, 0, 5); w.fill(gs.neg.mid, 2, T(day(2)), -1, 1, 2);
  gs.tie = testGame(w, day(3), 'tie-tie'); w.fill(gs.tie.mid, 1, T(day(3)), 1, 0, 5.001); w.fill(gs.tie.mid, 2, T(day(3)), 1, 1, 5.004);
  gs.notie = testGame(w, day(4), 'not-tie'); w.fill(gs.notie.mid, 1, T(day(4)), 1, 0, 5.000); w.fill(gs.notie.mid, 2, T(day(4)), 1, 1, 5.006);
  gs.dollar = testGame(w, day(5), 'dol-lar'); w.fill(gs.dollar.mid, 1, T(day(5)), 1, 1, 1000); for (let k = 2; k <= 21; k++) w.fill(gs.dollar.mid, k, T(day(5)), 1, 0, 10);
  gs.cutlock = testGame(w, day(6), 'cut-lok');                 // lock 23:00 < cutoff 23:10
  w.fill(gs.cutlock.mid, 1, gs.cutlock.lock - 1, 1, 0, 5); w.fill(gs.cutlock.mid, 2, gs.cutlock.lock, 1, 1, 100);
  gs.cutcut = testGame(w, day(7), 'cut-cut', { lock: day(7) + ' 23:30:00' });   // lock after cutoff
  w.fill(gs.cutcut.mid, 1, gs.cutcut.cutoff - 1, 1, 0, 5); w.fill(gs.cutcut.mid, 2, gs.cutcut.cutoff, 1, 1, 100);
  gs.top = testGame(w, day(8), 'top-tie'); w.fill(gs.top.mid, 30, T(day(8)), 1, 1, 50);   // wallet 30 is outside the top 25
  // ---- c: step order
  gs.nolock = testGame(w, day(9), 'no-lock', { lock: null });   // no lock AND no fills -> a PRICE skip
  gs.contam = testGame(w, day(10), 'con-tam', { contam: 'priced_post_first_pitch' }); w.fill(gs.contam.mid, 1, T(day(10)), 1, 0, 5);
  gs.nomoney = testGame(w, day(11), 'no-mon');                 // priced, no fills -> a LEAN skip
  // ---- d: confirmed set
  const cd = (k) => addDays('2026-07-01', k);
  const fpOf = (d) => d + 'T23:12:00.000Z';                     // = 16:12 PT
  gs.cBefore = testGame(w, cd(0), 'c-bef'); w.fill(gs.cBefore.mid, 1, T(cd(0)), 1, 0, 5);
  gs.cEqual = testGame(w, cd(1), 'c-equ', { lock: cd(1) + ' 23:20:00' }); w.fill(gs.cEqual.mid, 1, T(cd(1)), 1, 0, 5);
  w.capture(cd(1), 'c-equ', 130, -150, cd(1) + ' 09:00:00');   // older, different
  w.capture(cd(1), 'c-equ', 120, -140, cd(1) + ' 16:00:00');   // last before first pitch: EQUAL
  w.capture(cd(1), 'c-equ', 999, -999, cd(1) + ' 16:30:00');   // after first pitch: ignored
  gs.cDiff = testGame(w, cd(2), 'c-dif', { lock: cd(2) + ' 23:20:00' }); w.fill(gs.cDiff.mid, 1, T(cd(2)), 1, 0, 5);
  w.capture(cd(2), 'c-dif', 120, -140, cd(2) + ' 09:00:00');   // older, equal
  w.capture(cd(2), 'c-dif', 125, -145, cd(2) + ' 16:00:00');   // last before first pitch: DIFFERS
  gs.cNoCap = testGame(w, cd(3), 'c-noc', { lock: cd(3) + ' 23:20:00' }); w.fill(gs.cNoCap.mid, 1, T(cd(3)), 1, 0, 5);
  w.capture(cd(3), 'c-noc', 120, -140, cd(3) + ' 16:30:00');   // only after first pitch
  gs.cNoFp = testGame(w, cd(4), 'c-nfp', { lock: cd(4) + ' 23:20:00', fp: null }); w.fill(gs.cNoFp.mid, 1, T(cd(4)), 1, 0, 5);
  w.capture(cd(4), 'c-nfp', 120, -140, cd(4) + ' 16:00:00');   // equal, but no first pitch to anchor it

  const res = bt.buildOutcomeBlind(w.pm, w.mlb);
  const c = res.feasibility.counts.primary.in, cs = res.feasibility.counts.secondary.in;

  console.log('a. as-of qualification (strictly before D)');
  ok('DH game 2: wallet 31 (39 games + same-date game 1) is NOT qualified -> lean follows the 30 small buyers',
    rowOf(res, 'aaa-bbb-g2').lean_outcome === 0, 'lean ' + rowOf(res, 'aaa-bbb-g2').lean_outcome);
  ok('DH game 1: same result', rowOf(res, 'aaa-bbb').lean_outcome === 0);
  ok('next day: game 1 is now history, wallet 31 qualifies, its $1,000 decides the lean', rowOf(res, 'ccc-ddd').lean_outcome === 1);
  ok('the 40 history days were not eligible (fewer than 25 qualified before day 41)', res.feasibility.not_eligible.in === 40, res.feasibility.not_eligible.in);
  ok('first eligible date is the 41st day, with 30 qualified', res.feasibility.first_eligible.date === '2026-06-10' && res.feasibility.first_eligible.qualified === 30,
    JSON.stringify(res.feasibility.first_eligible));

  console.log('\nb. the lean');
  ok('sells subtract: buy $10 / sell $8 of home (net $2) vs $3 on away -> away (outcome 1)', rowOf(res, 'sel-ll').lean_outcome === 1);
  ok('net-short fills count: $5 bought, $10 sold by another wallet that never bought -> N0 = -5 < N1 = 1 -> outcome 1',
    rowOf(res, 'net-sho').lean_outcome === 1);
  ok('both nets <= 0: N0 = -5, N1 = -2 -> the larger, outcome 1; counted', rowOf(res, 'bot-neg').lean_outcome === 1 && c.neg_lean === 1);
  ok('tie to the cent: $5.001 vs $5.004 -> skipped as a tie', !rowOf(res, 'tie-tie') && c.lean_skip.tie === 1);
  ok('$5.000 vs $5.006 is not a tie -> outcome 1', rowOf(res, 'not-tie').lean_outcome === 1);
  ok('dollar-weighted: one wallet\'s $1,000 beats 20 wallets x $10', rowOf(res, 'dol-lar').lean_outcome === 1);
  ok('cut at the lock (lock before cutoff): a fill AT the lock is excluded', rowOf(res, 'cut-lok').lean_outcome === 0);
  ok('cut at the cutoff (lock after cutoff): a fill AT the cutoff is excluded', rowOf(res, 'cut-cut').lean_outcome === 0);
  ok('top 25 by profit, ties by wallet id: wallet 30 is outside -> secondary has no qualified money, primary has a lean',
    rowOf(res, 'top-tie', 'primary').lean_outcome === 1 && !rowOf(res, 'top-tie', 'secondary'));
  ok('lean price and no-vig p are the lean side\'s (home -140 vs away +120)', (() => {
    const r = rowOf(res, 'cut-lok');                           // lean outcome 0 = home
    return r.lean_is_home === true && r.price === -140 && Math.abs(r.p - (140 / 240) / ((140 / 240) + (100 / 220))) < 1e-12;
  })());

  console.log('\nc. step order: eligibility -> price -> lean -> tested');
  ok('no lock and no fills -> counted as a PRICE skip, not a lean skip', c.price_skip.no_odds_locked_at === 1 && !rowOf(res, 'no-lock'));
  ok('contaminated with fills -> price skip, never reaches the lean', c.price_skip.contaminated === 1 && !rowOf(res, 'con-tam'));
  ok('priced with no fills -> lean skip (no qualified money)', c.lean_skip.no_qualified_money === 1 && !rowOf(res, 'no-mon'));
  ok('eligible = price skips + lean skips + tested', c.eligible === c.price_skip.no_odds_locked_at + c.price_skip.contaminated
    + c.price_skip.moneyline_missing + c.lean_skip.no_qualified_money + c.lean_skip.tie + c.tested, JSON.stringify(c));
  ok('secondary: same eligibility and price skips as primary', cs.eligible === c.eligible && JSON.stringify(cs.price_skip) === JSON.stringify(c.price_skip));

  console.log('\nd. the confirmed set');
  const cst = (gid) => rowOf(res, gid).confirmed_status;
  ok('lock before first pitch -> confirmed', cst('c-bef') === 'confirmed_lock_before_first_pitch' && rowOf(res, 'c-bef').confirmed);
  ok('lock after first pitch, LAST pre-first-pitch capture equal (a later capture ignored) -> confirmed', cst('c-equ') === 'confirmed_equals_capture');
  ok('last pre-first-pitch capture differs (an older equal one does not count) -> outside', cst('c-dif') === 'outside_differs' && !rowOf(res, 'c-dif').confirmed);
  ok('only a capture after first pitch -> outside, no capture', cst('c-noc') === 'outside_no_capture');
  ok('no first_pitch_utc (even with an equal capture) -> outside', cst('c-nfp') === 'outside_no_first_pitch' && !rowOf(res, 'c-nfp').confirmed);
  ok('PT capture times are converted (16:00 PT = 23:00Z is before a 23:12Z first pitch)', cst('c-equ') === 'confirmed_equals_capture');

  console.log('\ne. sensitivity runs are outside BH and cannot set significance');
  {
    const mk = (variant, split, n, wins, confirmed) => Array.from({ length: n }, (_, k) => ({ variant, split, market_id: k, p: 0.5,
      price: 100, source: 'kalshi', confirmed, result: k < wins ? 'W' : 'L' }));
    // main in-sample: 100 confirmed all W + 100 unconfirmed all L -> 50% vs 50% implied (p = 1); confirmed alone: 100/100 (p ~ 0)
    const rows = [...mk('primary', 'in', 100, 100, true), ...mk('primary', 'in', 100, 0, false),
      ...mk('secondary', 'in', 100, 50, true), ...mk('primary', 'hold', 20, 10, true), ...mk('secondary', 'hold', 20, 10, true)];
    const out = bt.computeResults(rows);
    const g = (set, v, s) => out.find(r => r.set === set && r.variant === v && r.split === s && r.sourceFilter === 'all');
    ok('BH applied to exactly the 2 main in-sample tests', ['primary', 'secondary'].every(v => g('main', v, 'in').qValue !== undefined)
      && ['primary', 'secondary'].every(v => g('main', v, 'hold').qValue === undefined));
    ok('main primary not significant (p = 1)', g('main', 'primary', 'in').significant === false && g('main', 'primary', 'in').holdout === null);
    const s = g('confirmed', 'primary', 'in');
    ok('the confirmed-set run clears q < 0.10 for display, but sets no significance and no holdout label',
      s.clearsQ10ForDisplayOnly === true && s.significant === null && s.holdout === undefined, JSON.stringify({ q: s.qValue, sig: s.significant }));
    ok('the sensitivity q comes from BH over the 2 sensitivity p-values only', (() => {
      const ps = ['primary', 'secondary'].map(v => g('confirmed', v, 'in').pValue);
      const q = require(path.join(R, 'services/trends-backtest'))._internals.bhQ(ps);
      return Math.abs(q[0] - g('confirmed', 'primary', 'in').qValue) < 1e-15;
    })());
    // a significant main test gets a holdout label
    const rows2 = [...mk('primary', 'in', 200, 200, true), ...mk('secondary', 'in', 100, 50, true),
      ...mk('primary', 'hold', 20, 5, true), ...mk('secondary', 'hold', 20, 10, true)];
    const out2 = bt.computeResults(rows2);
    const m2 = out2.find(r => r.set === 'main' && r.variant === 'primary' && r.split === 'in' && r.sourceFilter === 'all');
    ok('a significant main test gets HOLDS / FAILS_HOLDOUT (here September edge flips: FAILS_HOLDOUT)', m2.significant === true && m2.holdout === 'FAILS_HOLDOUT');
    const TRI = require(path.join(R, 'services/trends-backtest'))._internals;
    const mixed = [...mk('primary', 'in', 60, 31, true)].map((r, k) => Object.assign(r, { price: k % 3 ? -150 : 130 }));
    const prof = TRI.summarize(mixed).prof;
    const ours = bt._internals.stats(mixed), seeded = TRI.bootRoi(prof, 20260930), trendsSeed = TRI.bootRoi(prof);
    ok('bootstrap is the trends bootRoi with the registered seed 20260930 (and differs from the trends seed)',
      ours.roiLo === seeded[0] && ours.roiHi === seeded[1] && (seeded[0] !== trendsSeed[0] || seeded[1] !== trendsSeed[1]),
      JSON.stringify({ ours: [ours.roiLo, ours.roiHi], trendsSeed }));
  }

  console.log('\nf. the pre-registration hash pin');
  {
    ok('the committed document matches the pin', bt.assertPrereg(R) === bt.PREREG_SHA256);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-'));
    fs.mkdirSync(path.join(tmp, 'docs'));
    const orig = fs.readFileSync(path.join(R, bt.PREREG_PATH), 'utf8');
    fs.writeFileSync(path.join(tmp, bt.PREREG_PATH), orig.replace('games ≥ 40', 'games ≥ 30'));
    let refused = false;
    try { bt.assertPrereg(tmp); } catch (e) { refused = /pre-registration mismatch/.test(e.message); }
    ok('a modified document is refused', refused);
    fs.writeFileSync(path.join(tmp, bt.PREREG_PATH), orig.replace(/\r\n/g, '\n'));
    ok('line endings alone do not change the hash (CRLF normalised)', bt.preregHash(tmp) === bt.PREREG_SHA256);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\ng. isolation from the pricing path');
  {
    const { stripJsComments } = require(path.join(R, 'services/harness-inputs'));
    const ROOTS = ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js', 'server.js'];
    const FORBIDDEN_TARGET = /^(services\/polymarket-top-traders-backtest\.js|scripts\/run-polymarket-top-traders-backtest\.js)$/;
    const FORBIDDEN_TEXT = /polymarket-top-traders-backtest|polymarket\.db/;
    function violations(roots, fsLike, root) {
      const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
      const seen = new Set(), stack = roots.map(r => path.join(root, r)).filter(f => fsLike.exists(f)), bad = [];
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        const code = stripJsComments(fsLike.read(f));
        const t = code.match(FORBIDDEN_TEXT);
        if (t) bad.push(rel(f) + ' names ' + t[0]);
        for (const x of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          const p = path.resolve(path.dirname(f), x[1]);
          const hit = [p, p + '.js', path.join(p, 'index.js')].find(c2 => fsLike.exists(c2));
          if (!hit) continue;
          if (FORBIDDEN_TARGET.test(rel(hit))) bad.push(rel(f) + ' requires ' + rel(hit));
          else stack.push(hit);
        }
      }
      return { files: seen, bad };
    }
    const realFs = { exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(), read: (p) => fs.readFileSync(p, 'utf8') };
    const iso = violations(ROOTS, realFs, R);
    ok('the pricing graph was walked (sanity)', iso.files.size > 20, iso.files.size + ' files');
    ok('no file in the pricing graph references the backtest or data/polymarket.db', iso.bad.length === 0, iso.bad.join(' | ') || 'none');
    const planted = {
      [path.join(R, 'services/model.js')]: "require('./odds');",
      [path.join(R, 'services/odds.js')]: "const b = require('./polymarket-top-traders-backtest');",
      [path.join(R, 'services/polymarket-top-traders-backtest.js')]: '',
    };
    const pfs = { exists: (p) => Object.prototype.hasOwnProperty.call(planted, p), read: (p) => planted[p] };
    const v1 = violations(['services/model.js'], pfs, R);
    ok('SELF-TEST: a require of the backtest one hop deep is caught', v1.bad.some(b => /requires services\/polymarket-top-traders-backtest\.js/.test(b)), v1.bad.join(' | '));
    planted[path.join(R, 'services/odds.js')] = "// data/polymarket.db in a comment is fine\nconst p = 'data/polymarket.db';";
    const v2 = violations(['services/model.js'], pfs, R);
    ok('SELF-TEST: the database path in code is caught; in a comment it is not', v2.bad.length === 1 && /names polymarket\.db/.test(v2.bad[0]), v2.bad.join(' | '));
  }

  try { require(path.join(R, 'db/schema')).db.close(); } catch (e) { /* not loaded */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
