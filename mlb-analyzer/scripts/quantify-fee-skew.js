#!/usr/bin/env node
/**
 * Quantify the Kalshi fee skew in ML CLV. (2026-08-23)
 *
 * THE CLAIM BEING TESTED. services/jobs.js:2323 warns that with
 * kalshi_direct_primary_enabled on, the stored market line is the
 * FEE-ADJUSTED Kalshi price, so "CLV computed here is therefore
 * fee-skewed -- systematically inflated by roughly the per-contract fee."
 * I repeated that and said it pushes net CLV below -0.45pp.
 *
 * THAT IS ONLY TRUE IF ONE SIDE IS ADJUSTED. Tracing what is actually
 * stored:
 *   game_log.market_*_ml            -- fee-adjusted (venue winner's
 *                                      net_american, jobs.js:1557-59)
 *   bet_signals.market_line         -- from the above
 *   bet_signals.bet_line            -- operator entry, defaults to
 *                                      market_line, so also adjusted
 *   empirical_market_captures       -- reads market_*_ml FROM game_log
 *     .away_price_ml/.home_price_ml    (empirical-market-capture.js:84-90)
 *                                      so ALSO adjusted
 *   closing_line (captured OR re-derived) -- from one of the above
 *
 * So BOTH sides of implied(close) - implied(bet) carry the fee and it
 * largely cancels:
 *     CLV = (C_close - C_bet) + [fee(C_close) - fee(C_bet)]
 * The residual is a DIFFERENCE of fees, not a fee. Since
 * fee(C) = 0.068*C*(1-C) is concave and peaks at C=0.5, the residual is
 * small and only systematic if prices move systematically toward or away
 * from even money.
 *
 * This measures the residual instead of assuming it.
 *
 * METHOD. Invert the adjustment to recover the raw price, recompute CLV
 * on raw prices, and difference. Given
 *     A = C + 0.068*C*(1-C)  =>  0.068C^2 - 1.068C + A = 0
 * take the root in (0,1).
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const COEF = 0.068;
const BOOT = 4000;

const impl = ml => { const n = Number(ml); if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100); };
const feeAt = C => COEF * C * (1 - C);

// Invert A = C + COEF*C*(1-C) for C in (0,1).
function rawFromAdjusted(A) {
  if (!(A > 0 && A < 1)) return null;
  const a = COEF, b = -(1 + COEF), c = A;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const r1 = (-b - Math.sqrt(disc)) / (2 * a);
  const r2 = (-b + Math.sqrt(disc)) / (2 * a);
  for (const r of [r1, r2]) if (r > 0 && r < 1) return r;
  return null;
}

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function clusteredCI(items, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it.v); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) for (const v of byDate.get(dates[Math.floor(rnd() * n)])) { s += v; c++; }
    if (c) out.push(s / c);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const f = v => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(3);

(function main() {
  console.log('=== quantifying the Kalshi fee skew in ML CLV ===');
  console.log('  fee(C) = ' + COEF + ' * C * (1-C)   max ' + (COEF * 0.25 * 100).toFixed(2)
    + 'pp at C=0.50');
  console.log('');

  const OBS = "EXISTS (SELECT 1 FROM bet_signal_audit a WHERE a.signal_id=b.id "
    + "AND a.action IN ('set_closing_line','rederived_closing_line','observed_no_audit'))";
  const rows = db.prepare(
    "SELECT b.game_date, b.bet_line, b.closing_line, b.clv FROM bet_signals b "
    + "WHERE b.signal_type='ML' AND b.clv IS NOT NULL AND " + OBS).all();
  console.log('  observed-only ML rows: ' + rows.length);

  const items = [], adjItems = [], rawItems = [];
  let skipped = 0;
  for (const r of rows) {
    const aBet = impl(r.bet_line), aClose = impl(r.closing_line);
    if (aBet == null || aClose == null) { skipped++; continue; }
    const cBet = rawFromAdjusted(aBet), cClose = rawFromAdjusted(aClose);
    if (cBet == null || cClose == null) { skipped++; continue; }
    const clvAdj = (aClose - aBet) * 100;      // what is stored
    const clvRaw = (cClose - cBet) * 100;      // fee removed from both sides
    items.push({ d: r.game_date, v: clvAdj - clvRaw });
    adjItems.push({ d: r.game_date, v: clvAdj });
    rawItems.push({ d: r.game_date, v: clvRaw });
  }
  if (skipped) console.log('  skipped (unrecoverable price): ' + skipped);

  const mAdj = mean(adjItems.map(x => x.v)), mRaw = mean(rawItems.map(x => x.v));
  const mSkew = mean(items.map(x => x.v));
  const ciSkew = clusteredCI(items, 4242);

  console.log('');
  console.log('=== the residual, measured ===');
  console.log('  CLV as stored (both sides fee-adjusted) : ' + f(mAdj) + 'pp');
  console.log('  CLV with the fee removed from both      : ' + f(mRaw) + 'pp');
  console.log('  SKEW (stored - raw)                     : ' + f(mSkew)
    + 'pp   95% CI [' + f(ciSkew[0]) + ', ' + f(ciSkew[1]) + ']');
  console.log('');

  // For contrast: what the skew WOULD be if only the closing side were adjusted.
  const oneSided = [];
  for (const r of rows) {
    const aClose = impl(r.closing_line);
    if (aClose == null) continue;
    const cClose = rawFromAdjusted(aClose);
    if (cClose == null) continue;
    oneSided.push({ d: r.game_date, v: feeAt(cClose) * 100 });
  }
  console.log('  For contrast -- if ONLY the close were adjusted, the skew would be');
  console.log('  the full fee at the closing price: ' + f(mean(oneSided.map(x => x.v))) + 'pp');
  console.log('  That is the number the jobs.js caveat describes, and it does NOT');
  console.log('  apply here because the bet side carries the same adjustment.');
  console.log('');

  // Net, corrected
  const PER_SIDE_VIG = 2.45;
  const netAdj = adjItems.map(x => ({ d: x.d, v: x.v - PER_SIDE_VIG }));
  const netRaw = rawItems.map(x => ({ d: x.d, v: x.v - PER_SIDE_VIG }));
  const ciA = clusteredCI(netAdj, 606), ciR = clusteredCI(netRaw, 707);
  console.log('=== net of the 2.45pp per-side vig ===');
  console.log('  using stored CLV : ' + f(mean(netAdj.map(x => x.v))) + 'pp  [' + f(ciA[0]) + ', ' + f(ciA[1]) + ']');
  console.log('  using raw CLV    : ' + f(mean(netRaw.map(x => x.v))) + 'pp  [' + f(ciR[0]) + ', ' + f(ciR[1]) + ']');
  console.log('');
  console.log('  NOTE ON THE VIG SIDE. The 2.45pp overround was itself computed from');
  console.log('  fee-adjusted prices, so it embeds the fee too. Removing the fee from');
  console.log('  CLV but not from the vig would double-count the correction; the raw');
  console.log('  row above is therefore an upper bound on the correction, not the');
  console.log('  corrected answer.');
})();
