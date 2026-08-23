#!/usr/bin/env node
/**
 * Re-grade the logged totals at struck prices and test the edge. (2026-08-23)
 *
 * PRIOR: 23W-14L-1P, +$775.82, realised win rate 62.2% vs price-implied
 * 51.6% -- a +10.6pp gap on n=37.
 *
 * EXPECT IT TO SHRINK. Three known defects all plausibly inflate it:
 *   - graded at the MARKET price rather than the struck price;
 *   - wageredFor() returned a flat 110 for totals regardless of price;
 *   - bet_line held the juice, not the total, on 37 of 38 rows until the
 *     2026-08-23 migration.
 * And 1.3 SD on n=37 is squarely the regime the subset-sign-flip rule
 * covers, where a conditional subset can invert a full-sample effect.
 *
 * So this is written to look for shrinkage, not to confirm the number.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const { wageredFor, stakeForPrice } = require(path.join(R, 'utils/wagered'));

const BOOT = 10000;
const impl = ml => { const n = Number(ml); if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100); };

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Date-clustered bootstrap over a statistic of the row set.
function ci(rows, stat, seed) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.game_date)) byDate.set(r.game_date, []); byDate.get(r.game_date).push(r); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < n; i++) for (const r of byDate.get(dates[Math.floor(rnd() * n)])) s.push(r);
    const v = stat(s);
    if (v != null && isFinite(v)) out.push(v);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const f = (v, d) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d);

(function main() {
  const rows = db.prepare(
    "SELECT b.*, g.market_total, g.over_price, g.under_price, g.away_score, g.home_score, "
    + "       g.market_contamination_reason "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='Total' AND b.bet_line IS NOT NULL ORDER BY b.game_date").all();

  console.log('=== (1) re-grade logged totals at STRUCK prices ===');
  console.log('  logged totals bets: ' + rows.length);

  const graded = [];
  let pushes = 0, skipped = 0;
  for (const r of rows) {
    if (r.away_score == null || r.home_score == null) { skipped++; continue; }
    const total = Number(r.bet_line);          // post-migration: bet_line IS the total
    if (!(total >= 4 && total <= 20)) { skipped++; continue; }
    const act = r.away_score + r.home_score;
    if (act === total) { pushes++; continue; }
    const isOver = String(r.signal_side).toLowerCase() === 'over';
    const won = isOver ? act > total : act < total;

    const struck = r.bet_price != null ? Number(r.bet_price) : null;
    const market = isOver ? r.over_price : r.under_price;
    const usedStruck = struck != null;
    const price = usedStruck ? struck : (market != null ? Number(market) : -110);

    const stake = stakeForPrice(price);
    graded.push({
      game_date: r.game_date, game_id: r.game_id, side: r.signal_side,
      total, act, won, price, usedStruck,
      marketPrice: market, pnl: won ? 100 : -stake, wagered: stake,
      impliedP: impl(price),
      oldPnl: Number(r.pnl) || 0,
      oldWagered: 110,                       // what the flat-110 denominator gave
      contaminated: !!r.market_contamination_reason,
    });
  }
  console.log('  graded: ' + graded.length + '   pushes: ' + pushes + '   skipped: ' + skipped);
  console.log('  priced at the STRUCK price: ' + graded.filter(x => x.usedStruck).length
    + '   fell back to market: ' + graded.filter(x => !x.usedStruck).length);

  const W = graded.filter(x => x.won).length, L = graded.length - W;
  const roiOf = a => { let p = 0, w = 0; for (const x of a) { p += x.pnl; w += x.wagered; } return w > 0 ? 100 * p / w : null; };
  const roiOld = (() => { let p = 0, w = 0; for (const x of graded) { p += x.oldPnl; w += x.oldWagered; } return 100 * p / w; })();
  const gapOf = a => {
    if (!a.length) return null;
    const wr = a.filter(x => x.won).length / a.length;
    const ip = a.reduce((s, x) => s + x.impliedP, 0) / a.length;
    return (wr - ip) * 100;
  };

  console.log('');
  console.log('=== before / after ===');
  console.log('  BEFORE  (market price, flat-110 denominator) : ' + f(roiOld) + '% ROI, pnl '
    + f(graded.reduce((s, x) => s + x.oldPnl, 0)));
  console.log('  AFTER   (struck price, real denominator)     : ' + f(roiOf(graded)) + '% ROI, pnl '
    + f(graded.reduce((s, x) => s + x.pnl, 0)) + ', wagered ' + f(graded.reduce((s, x) => s + x.wagered, 0)));
  console.log('');

  console.log('=== (3) the win-rate gap, with a CI ===');
  const wr = 100 * W / graded.length;
  const ip = 100 * graded.reduce((s, x) => s + x.impliedP, 0) / graded.length;
  const gap = wr - ip;
  const gapCI = ci(graded, gapOf, 3131);
  const roiCI = ci(graded, roiOf, 4242);
  console.log('  ' + W + 'W-' + L + 'L  (n=' + graded.length + ', ' + pushes + ' push)');
  console.log('  realised win rate : ' + wr.toFixed(1) + '%');
  console.log('  price-implied     : ' + ip.toFixed(1) + '%');
  console.log('  GAP               : ' + f(gap) + 'pp   95% CI [' + f(gapCI[0]) + ', ' + f(gapCI[1]) + ']'
    + (gapCI[0] != null && gapCI[0] > 0 ? '   excludes 0' : '   SPANS 0'));
  console.log('  ROI               : ' + f(roiOf(graded)) + '%   95% CI [' + f(roiCI[0]) + ', ' + f(roiCI[1]) + ']'
    + (roiCI[0] != null && roiCI[0] > 0 ? '   excludes 0' : '   SPANS 0'));

  // binomial sanity: how many SD is W above the implied expectation?
  const expW = graded.reduce((s, x) => s + x.impliedP, 0);
  const varW = graded.reduce((s, x) => s + x.impliedP * (1 - x.impliedP), 0);
  console.log('  wins ' + W + ' vs expected ' + expW.toFixed(1)
    + '  -> ' + ((W - expW) / Math.sqrt(varW)).toFixed(2) + ' SD');

  // contamination split
  const clean = graded.filter(x => !x.contaminated);
  if (clean.length !== graded.length) {
    console.log('');
    console.log('  excluding market-contaminated games (n=' + (graded.length - clean.length) + '):');
    console.log('    gap ' + f(gapOf(clean)) + 'pp   ROI ' + f(roiOf(clean)) + '%   on n=' + clean.length);
  }

  console.log('');
  console.log('=== (4) cross-check against the Under-lean ===');
  const byside = {};
  for (const x of graded) { const k = x.side; byside[k] = byside[k] || []; byside[k].push(x); }
  for (const [k, a] of Object.entries(byside)) {
    const c = ci(a, gapOf, 5151);
    console.log('  ' + k.padEnd(6) + ' n=' + String(a.length).padStart(3)
      + '  ' + a.filter(x => x.won).length + 'W-' + (a.length - a.filter(x => x.won).length) + 'L'
      + '   gap ' + f(gapOf(a)) + 'pp [' + f(c[0]) + ', ' + f(c[1]) + ']'
      + '   ROI ' + f(roiOf(a)) + '%');
  }
  console.log('');
  console.log('  The Under-lean says the model over-projects Overs, i.e. UNDER should');
  console.log('  carry the edge. If the gap lives on OVER instead, the logged totals');
  console.log('  edge and the Under-lean are not the same phenomenon.');
})();
