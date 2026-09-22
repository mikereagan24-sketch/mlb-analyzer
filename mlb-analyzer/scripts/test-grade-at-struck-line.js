#!/usr/bin/env node
// Grading reads the line and price the operator actually struck.
//   node --max-old-space-size=1536 scripts/test-grade-at-struck-line.js
// Exit 1 on any failure.
//
// THE DEFECT (found 2026-09-22, fixed 2026-09-23). calcPnl's Total branch
// took its line from `marketTotal` and never looked at bet_line, while
// the ML branch had preferred the struck value through effectiveLine
// since it was written. The comment beside the Total price even said
// "bet_line holds the total on Total rows" -- and the line above it
// ignored exactly that.
//
// It surfaced on TOR@TEX 2026-09-19: logged under 7.5, market 8.5 on all
// 18 captures that day, game landed on 8. Graded at the market line that
// is a win (+100); at the line actually taken it is a loss (-103). A
// 203-unit swing decided entirely by which number the grader read.
//
// FIVE PLACES GRADED, and they disagreed with each other:
//   services/model.js  calcPnl              the canonical one
//   services/jobs.js   graded-game branch   passed market_line only
//   services/jobs.js   score job            hand-rolled; no bet_price
//   routes/api.js      /signals/manual      passed bet_line, not bet_price
//   routes/api.js      {recalc:true}        hand-rolled; forced -110
// The recalc branch was the loaded gun: it rewrote P&L for EVERY graded
// row at the market price, so pressing it would have silently undone
// regrade-stale-totals-pnl. It now calls calcPnl like everything else.
//
// WHAT MUST NOT CHANGE: every backtest. parameter-sweep, frv-, temp-,
// runmult-totals- and under-selection- build signals from getSignals(),
// which never sets bet_line, so they must score byte-identically. Case 3
// pins that.

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { calcPnl } = require(path.join(R, 'services/model'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}
const g = (sig, away, home, mt) => calcPnl(sig, away, home, mt);

console.log('\n1. the incident row: a Total graded at the line the operator took');
// TOR@TEX 2026-09-19. market 8.5, struck 7.5 at -103, final 2-6 = 8.
const tor = { type: 'Total', side: 'under', marketLine: 8.5, bet_line: 7.5,
  bet_price: -103, overPrice: 123, underPrice: -149 };
let r = g(tor, 2, 6, 8.5);
expect('under 7.5 with a total of 8 is a LOSS', r.outcome === 'loss', r.outcome);
expect('...and the stake is the struck price, not the market -149',
  Math.abs(Number(r.pnl) - (-103)) < 0.01, String(r.pnl));
// the same row without a bet_line is the market bet, and still a win
r = g({ type: 'Total', side: 'under', marketLine: 8.5, overPrice: 123, underPrice: -149 }, 2, 6, 8.5);
expect('the same game at the MARKET line 8.5 is still a win', r.outcome === 'win', r.outcome);

console.log('\n2. the other two logged Totals keep their outcome');
r = g({ type: 'Total', side: 'over', marketLine: 7.5, bet_line: 8.5 }, 9, 7, 7.5);
expect('col-was: over, market 7.5 -> struck 8.5, actual 16, still a win',
  r.outcome === 'win', r.outcome);
r = g({ type: 'Total', side: 'under', marketLine: 10.5, bet_line: 9.5 }, 7, 7, 10.5);
expect('atl-was: under, market 10.5 -> struck 9.5, actual 14, still a loss',
  r.outcome === 'loss', r.outcome);

console.log('\n3. a push is decided on the STRUCK line too');
r = g({ type: 'Total', side: 'over', marketLine: 8.5, bet_line: 9 }, 4, 5, 8.5);
expect('struck 9, actual 9 -> push', r.outcome === 'push', r.outcome);
r = g({ type: 'Total', side: 'over', marketLine: 9, bet_line: 8.5 }, 4, 5, 9);
expect('market 9 but struck 8.5, actual 9 -> a win, not a push',
  r.outcome === 'win', r.outcome);

console.log('\n4. BACKTESTS ARE INERT -- no bet_line means nothing moves');
// getSignals() never sets bet_line, so every sweep and backtest signal
// takes this path. If this breaks, every historical score moves.
for (const [side, away, home, mt, want] of [
  ['over', 5, 5, 8.5, 'win'], ['under', 5, 5, 8.5, 'loss'],
  ['over', 2, 2, 8.5, 'loss'], ['under', 2, 2, 8.5, 'win'],
  ['over', 4, 5, 9, 'push'],
]) {
  const res = g({ type: 'Total', side, marketLine: mt }, away, home, mt);
  expect('no bet_line: ' + side + ' ' + mt + ' with ' + (away + home) + ' runs -> ' + want,
    res.outcome === want, res.outcome);
}
// bet_line 0 / null / '' must all fall back rather than grading at zero
for (const bl of [null, 0, '', undefined]) {
  const res = g({ type: 'Total', side: 'under', marketLine: 8.5, bet_line: bl }, 2, 6, 8.5);
  expect('bet_line=' + JSON.stringify(bl) + ' falls back to the market line',
    res.outcome === 'win', res.outcome);
}

console.log('\n5. ML is unchanged -- it always preferred the struck price');
// to-win-100: a WIN pays 100 whatever the price. The price decides what
// was RISKED, so only a loss can move -- which is why every row this
// class of fix touches is a loss.
r = g({ type: 'ML', side: 'home', marketLine: 122, bet_line: 133 }, 3, 5, null);
expect('a win pays 100 at any price', Math.abs(Number(r.pnl) - 100) < 0.01, String(r.pnl));
r = g({ type: 'ML', side: 'home', marketLine: 122, bet_line: 133 }, 5, 3, null);
expect('a loss risks the struck price', r.outcome === 'loss' && Number(r.pnl) < 0,
  r.outcome + '/' + r.pnl);
expect('id=13381 reconciles: market 122 -> struck 133 gives -75.19',
  Math.abs(Number(r.pnl) - (-75.19)) < 0.01, String(r.pnl));

console.log('\n6. every grading call site hands over the struck values');
// Comment lines are blanked before scanning. The fix's own comment
// quotes the code it replaced, and an assertion that cannot tell code
// from a comment fails on the very change that fixes the defect -- which
// is exactly what happened here on the first run, and on the first run
// of scripts/test-promote-verify.js before it.
const decomment = (s) => s.split(/\r?\n/)
  .map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
const jobs = decomment(fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8'));
const api = decomment(fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8'));
const model = decomment(fs.readFileSync(path.join(R, 'services/model.js'), 'utf8'));
expect('calcPnl derives the Total line through effectiveLine',
  /const tot = effectiveLine\(parseFloat\(marketTotal\)/.test(model));
expect('the graded-game branch passes bet_line and bet_price',
  /marketLine:ex\.market_line,\s*\n\s*bet_line:ex\.bet_line, bet_price:ex\.bet_price/.test(jobs));
expect('the score job prefers sig.bet_price for the Total price',
  /const _price = \(sig\.bet_price != null && sig\.bet_price !== ''\)/.test(jobs));
expect('/signals/manual passes bet_price',
  /bet_price: bet_price != null \? Number\(bet_price\) : null,/.test(api));
expect('the recalc branch calls calcPnl instead of re-deriving',
  /recalc[\s\S]{0,2000}?const r = calcPnl\(\{/.test(api)
  && !/Default to -110/.test(api), 'hand-rolled recalc must be gone');
expect('...and refuses to rewrite a row whose OUTCOME would move',
  /if \(r\.outcome !== sig\.outcome\) \{ flipped\.push\(sig\.id\); skipped\+\+; continue; \}/.test(api));
expect('calcPnl is required ABOVE the recalc branch (temporal dead zone)',
  api.indexOf("const { calcPnl } = require('../services/model');")
    < api.indexOf('if (req.body.recalc)'));
expect('...and only once in that handler',
  (api.match(/const \{ calcPnl \} = require\('\.\.\/services\/model'\);/g) || []).length === 1);

console.log('\n7. id=178727 is not touched by any of this');
// Live grading only ever writes rows whose outcome is 'pending', and the
// recalc branch now skips a row whose outcome would move. Both are the
// reason this fix does not decide a question that is Mike's to settle
// against the book.
expect('live grading only writes pending rows',
  /if \(ex\.outcome !== 'pending'\) continue;/.test(jobs));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
