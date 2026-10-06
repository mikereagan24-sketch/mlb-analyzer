#!/usr/bin/env node
'use strict';
/**
 * Backtest summary cards in "Logged Bets Only" mode count every graded logged
 * bet (#520, 2026-10-05). Display only.
 *
 * The cards (public/index.html loadBacktest -> backtestSummaryTotals) used the
 * All Signals filter in logged mode too: Overs dropped, and anything below
 * today's highlight thresholds dropped. On 2026-10-05 the v7 logged cards
 * showed 201 bets at +$539.92 while all 300 graded logged bets totalled
 * -$765.56.
 *
 *   a. logged mode: the cards' totals equal GET /api/backtest's `overall` for
 *      the same selection (real route, throwaway database), on a fixture with
 *      Overs, below-threshold bets, a push, a pending bet, a Total with no
 *      bet_price, unlogged signals, another cohort and a contaminated game --
 *      with and without include_contaminated.
 *   b. All Signals mode is unchanged: same totals as the code it replaced,
 *      same threshold filter, same labels; loadBacktest passes the mode.
 *   (c. the parse test is run separately: scripts/test-index-inline-scripts-parse.js)
 *
 *   node scripts/test-backtest-cards-logged.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const vm = require('vm');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__backtest_cards_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                                // NEVER data/mlb.db: set before db/schema can load

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}

// ---------------------------------------------------------------- the page's functions, run as-is
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
function fnSource(name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found in index.html');
  let depth = 0, j = html.indexOf('{', i);
  for (; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) break; }
  return html.slice(i, j + 1);
}
const ctx = vm.createContext({});
vm.runInContext(['wageredForSignal', 'signalMeetsBacktestThreshold', 'backtestSummaryTotals'].map(fnSource).join('\n'), ctx);
const totals = (signals, thr, mode) => ctx.backtestSummaryTotals(signals, thr, mode);
const THR = { favPp: 0.02, dogPp: 0.045, underPp: 0.07 };          // production's ui_highlight_* values on 2026-10-05

// The All Signals computation exactly as it stood before this change (index.html at main d6b4338).
function oldCards(signals, thr) {
  let sumPnl = 0, sumWagered = 0, wins = 0, losses = 0, pushes = 0, plays = 0;
  for (const s of signals) {
    if (s.outcome !== 'win' && s.outcome !== 'loss' && s.outcome !== 'push') continue;
    if (!ctx.signalMeetsBacktestThreshold(s, thr)) continue;
    plays++;
    if (s.outcome === 'win') wins++; else if (s.outcome === 'loss') losses++; else pushes++;
    sumPnl += Number(s.pnl) || 0;
    if (s.outcome !== 'push') sumWagered += ctx.wageredForSignal(s);
  }
  return { plays, wins, losses, pushes, pnl: sumPnl, wagered: sumWagered, roi: sumWagered > 0 ? (sumPnl / sumWagered * 100) : 0 };
}

// ---------------------------------------------------------------- fixture
const { db } = require(path.join(R, 'db/schema'));
const insGl = db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, away_score, home_score, game_status, market_total,
  weather_contamination_reason, market_contamination_reason) VALUES (?, ?, ?, ?, ?, ?, 'Final', 8.5, ?, ?)`);
let gn = 0;
function game(d, contam) {
  const id = 'g' + (++gn) + 'a-g' + gn + 'h';
  insGl.run(d, id, 'A' + gn, 'H' + gn, 3, 5, null, contam ? 'post_first_pitch_capture' : null);
  return { d, id, gl: db.prepare('SELECT id FROM game_log WHERE game_date=? AND game_id=?').get(d, id).id };
}
const insSig = db.prepare(`INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, category, market_line, model_line, edge_pct,
  outcome, pnl, bet_line, bet_price, bet_locked_at, is_active, cohort) VALUES (@gl, @d, @id, @type, @side, @cat, @mkt, @model, @edge, @o, @pnl, @bl, @bp, @lk, @act, @cohort)`);
function sig(g, o) {
  insSig.run(Object.assign({ gl: g.gl, d: g.d, id: g.id, model: null, bp: null, lk: o.bl != null ? g.d + ' 12:00:00' : null, act: 1, cohort: 'v7' }, o));
}
const D = '2026-08-10';
// logged ML: fav above threshold (win), fav BELOW (loss), dog above (loss), dog BELOW (win), inactive fav below (win)
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -130, edge: 0.03, o: 'win', pnl: 100, bl: -130 });
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -120, edge: 0.012, o: 'loss', pnl: -120, bl: -118 });
sig(game(D), { type: 'ML', side: 'away', cat: 'dog', mkt: 140, edge: 0.06, o: 'loss', pnl: -71.43, bl: 140 });
sig(game(D), { type: 'ML', side: 'away', cat: 'dog', mkt: 125, edge: 0.02, o: 'win', pnl: 100, bl: 128 });
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -110, edge: 0.005, o: 'win', pnl: 100, bl: -110, act: 0 });
// old-style category that never matches fav/dog
sig(game(D), { type: 'ML', side: 'home', cat: '1star-dog', mkt: 105, edge: 0.05, o: 'loss', pnl: -95.24, bl: 105 });
// logged Totals: Over (win), Over (loss, plus price), under above (win), under BELOW (loss), a Total with no bet_price (loss, staked at 110)
sig(game(D), { type: 'Total', side: 'over', cat: 'over', mkt: 8.5, edge: 0.09, o: 'win', pnl: 100, bl: 8.5, bp: -112 });
sig(game(D), { type: 'Total', side: 'over', cat: 'over', mkt: 7.5, edge: 0.04, o: 'loss', pnl: -95.24, bl: 7.5, bp: 105 });
sig(game(D), { type: 'Total', side: 'under', cat: 'under', mkt: 9.5, edge: 0.08, o: 'win', pnl: 100, bl: 9.5, bp: -108 });
sig(game(D), { type: 'Total', side: 'under', cat: 'under', mkt: 8.5, edge: 0.03, o: 'loss', pnl: -115, bl: 8.5, bp: -115 });
sig(game(D), { type: 'Total', side: 'under', cat: 'under', mkt: 8.0, edge: 0.075, o: 'loss', pnl: -110, bl: 8.0, bp: null });
// a push (counted in W-L-P, no P&L, no stake) and a pending logged bet (not counted)
sig(game(D), { type: 'Total', side: 'under', cat: 'under', mkt: 8, edge: 0.08, o: 'push', pnl: 0, bl: 8, bp: -110 });
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -140, edge: 0.05, o: 'pending', pnl: 0, bl: -140 });
// unlogged signals (in All Signals only): above-threshold fav win, below-threshold dog loss, an Over
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -125, edge: 0.04, o: 'win', pnl: 100, bl: null });
sig(game(D), { type: 'ML', side: 'away', cat: 'dog', mkt: 150, edge: 0.03, o: 'loss', pnl: -66.67, bl: null });
sig(game(D), { type: 'Total', side: 'over', cat: 'over', mkt: 8.5, edge: 0.1, o: 'win', pnl: 100, bl: null });
// another cohort (excluded by cohort=v7) and a contaminated game's logged bet (excluded unless include_contaminated)
sig(game(D), { type: 'ML', side: 'home', cat: 'fav', mkt: -150, edge: 0.05, o: 'loss', pnl: -150, bl: -150, cohort: 'v6' });
sig(game(D, true), { type: 'ML', side: 'away', cat: 'dog', mkt: 160, edge: 0.07, o: 'win', pnl: 100, bl: 160 });

(async () => {
  const express = require(path.join(R, 'node_modules/express'));
  const app = express(); app.use('/api', require(path.join(R, 'routes/api')));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = (q) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/backtest?' + q }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s.slice(0, 200))); } });
    }).on('error', reject);
  });
  const same = (t, o) => t.wins === o.wins && t.losses === o.losses && Math.abs(t.pnl - o.total_pnl) < 0.005
    && Math.abs(t.wagered - o.wagered) < 0.005 && Math.abs(t.roi - o.roi) < 0.005 && t.plays - t.pushes === o.plays;
  const fmt = (t) => JSON.stringify({ plays: t.plays, w: t.wins, l: t.losses, p: t.pushes, pnl: +t.pnl.toFixed(2), wag: +t.wagered.toFixed(2), roi: +t.roi.toFixed(2) });

  // ---------------------------------------------------------------- a
  console.log('a. logged mode: the cards equal the API totals');
  for (const extra of ['', '&include_contaminated=1']) {
    const d = await get('from=2026-04-09&to=2026-10-05&cohort=v7&mode=logged' + extra);
    const t = totals(d.signals, THR, 'logged');
    ok('cards == API overall (' + (extra ? 'contaminated included' : 'contaminated excluded') + ')', same(t, d.overall),
      'cards ' + fmt(t) + ' | API ' + JSON.stringify(d.overall));
  }
  {
    const d = await get('from=2026-04-09&to=2026-10-05&cohort=v7&mode=logged');
    const t = totals(d.signals, THR, 'logged');
    // Graded logged v7 bets on clean games: 5 W, 6 L, 1 P (pending, unlogged, v6 and contaminated rows excluded).
    // P&L 100 - 120 - 71.43 + 100 + 100 - 95.24 + 100 - 95.24 + 100 - 115 - 110 + 0 = -106.91.
    ok('the fixture: all 12 graded logged v7 bets counted (5-6-1, P&L -106.91), Overs and below-threshold bets included',
      t.plays === 12 && t.wins === 5 && t.losses === 6 && t.pushes === 1 && Math.abs(t.pnl - (-106.91)) < 0.005, fmt(t));
    const old = oldCards(d.signals, THR);
    ok('the old (threshold) rule showed 5 of them at +18.57 on the same data',
      old.plays === 5 && Math.abs(old.pnl - 18.57) < 0.005, JSON.stringify({ plays: old.plays, pnl: +old.pnl.toFixed(2) }));
    const graded = d.signals.filter(s => ['win', 'loss', 'push'].includes(s.outcome));
    ok('the counted bets include both Overs and all 7 rows the threshold rule drops (the 2 Overs, 4 below-threshold bets, 1 old-style category)',
      graded.filter(s => s.signal_side === 'over').length === 2 && graded.filter(s => !ctx.signalMeetsBacktestThreshold(s, THR)).length === 7);
    ok('the cards are labelled "All logged bets" in logged mode', /'All logged bets · no edge threshold'/.test(html) && /'All logged bets · \$100\/play'/.test(html) && /' logged bets · '/.test(html));
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. All Signals mode is unchanged');
  {
    const d = await get('from=2026-04-09&to=2026-10-05&cohort=v7&mode=all');
    for (const mode of ['all', undefined, 'anything-else']) {
      const t = totals(d.signals, THR, mode), o = oldCards(d.signals, THR);
      ok('mode ' + mode + ': same totals as the replaced code', t.plays === o.plays && t.wins === o.wins && t.losses === o.losses && t.pushes === o.pushes
        && Math.abs(t.pnl - o.pnl) < 1e-9 && Math.abs(t.wagered - o.wagered) < 1e-9 && Math.abs(t.roi - o.roi) < 1e-9 && t.allLogged === false, fmt(t));
    }
    const t = totals(d.signals, THR, 'all');
    ok('All Signals still applies the threshold: 6 actionable plays (5 logged + 1 unlogged fav) of the API\'s 14 graded non-push rows',
      t.plays === 6 && d.overall.plays === 14, fmt(t) + ' vs API plays ' + d.overall.plays);
    ok('the All Signals labels are unchanged', /'\$100\/play \(actionable\)'/.test(html) && /' actionable plays · '/.test(html)
      && /'Favs ≥' \+ _ppFmt\(thr\.favPp\)/.test(html) && /' \+ Dogs ≥' \+ _ppFmt\(thr\.dogPp\)/.test(html) && /' \+ Unders ≥' \+ _ppFmt\(thr\.underPp\)/.test(html));
  }
  {
    const lb = fnSource('loadBacktest');
    ok('loadBacktest computes the cards with backtestSummaryTotals(signals, thr, btMode)', /backtestSummaryTotals\(signals, thr, btMode\)/.test(lb));
    ok('loadBacktest no longer filters the cards itself', !/signalMeetsBacktestThreshold/.test(lb));
    ok('the bucket sections, runline and signal tracking still get the same signals', /renderRunlineCompanion\(signals\)/.test(lb)
      && /renderSignalTracking\(signals\)/.test(lb) && /renderBucketSections\(signals\)/.test(lb));
  }

  await new Promise(r => server.close(r));
  try { db.close(); } catch (e) { /* closed */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
