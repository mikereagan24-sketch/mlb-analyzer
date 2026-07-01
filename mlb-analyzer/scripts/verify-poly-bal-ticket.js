'use strict';
// scripts/verify-poly-bal-ticket.js — Stage 2 acceptance gate.
//
// Reproduce the owner's verified BAL trade:
//   $100 stake, taker, price 0.56 per share, ~178.57 shares, $2.56 fee
//
// Runs two checks:
//   1. polyTakerFee(0.56, 178.57) MUST equal $2.56
//   2. walkAsksForFill on a synthetic single-level book with 178.57
//      shares at 0.56 for a $100 stake MUST return:
//        filled_usd=100.00, shares=178.5714, avg_price=0.56, slippage=0
//   3. Fee applied to fill result MUST yield $2.56
// If any check fails, exit 1. Prints every value so a mismatch is
// diagnosable without re-running.
//
// Usage:  node scripts/verify-poly-bal-ticket.js

const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { polyTakerFee, polyTakerFeeRate, walkAsksForFill, POLY_TAKER_FEE_COEF } = require('../services/polymarket');

let failures = 0;
function expect(label, ok, got, want) {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${label}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
  if (!ok) failures++;
}
function approxEq(a, b, tol) { return Math.abs(a - b) <= (tol || 0.005); }

console.log('=== BAL ticket reproduction ===');
console.log('  Reference: $100 stake @ $0.56, taker, ~178.57 shares, $2.56 fee\n');

// 1) Coefficient sanity — the constant WE encoded should exactly
//    reproduce the BAL slip. Ceil-to-cent applies to the total.
const feeAt = polyTakerFee(0.56, 178.57);
console.log(`  POLY_TAKER_FEE_COEF = ${POLY_TAKER_FEE_COEF}`);
console.log(`  raw = ${POLY_TAKER_FEE_COEF} * 0.56 * 0.44 * 178.57 = ${(POLY_TAKER_FEE_COEF*0.56*0.44*178.57).toFixed(6)}`);
console.log(`  ceil-to-cent → ${feeAt}`);
expect('fee = $2.56', approxEq(feeAt, 2.56, 0.001), feeAt, 2.56);

// 2) Depth walk against a synthetic book with exactly the BAL fill.
const syntheticBook = {
  asks: [
    { price: 0.56, size: 200 },   // deep enough to fully absorb $100
  ],
  bids: [],
};
const walk = walkAsksForFill(syntheticBook, 100);
console.log(`\n  walkAsksForFill(book@0.56, $100):`);
console.log(`    filled_usd:    ${walk && walk.filled_usd}`);
console.log(`    shares_bought: ${walk && walk.shares_bought}`);
console.log(`    avg_price:     ${walk && walk.avg_price}`);
console.log(`    top_ask_price: ${walk && walk.top_ask_price}`);
console.log(`    slippage_pp:   ${walk && walk.slippage_pp}`);
console.log(`    partial:       ${walk && walk.partial}`);
expect('filled_usd = 100', approxEq(walk.filled_usd, 100.0, 1e-6), walk.filled_usd, 100.0);
expect('shares_bought ≈ 178.57', approxEq(walk.shares_bought, 178.5714, 0.01), walk.shares_bought, 178.5714);
expect('avg_price = 0.56', approxEq(walk.avg_price, 0.56, 1e-4), walk.avg_price, 0.56);
expect('slippage_pp = 0 (single-level book)', approxEq(walk.slippage_pp, 0, 1e-4), walk.slippage_pp, 0);
expect('not partial', walk.partial === false, walk.partial, false);

// 3) Fee applied to actual walk shares
const feeOnWalk = polyTakerFee(walk.avg_price, walk.shares_bought);
console.log(`\n  polyTakerFee(walk.avg_price=${walk.avg_price}, shares=${walk.shares_bought}) = $${feeOnWalk}`);
expect('applied fee = $2.56', approxEq(feeOnWalk, 2.56, 0.005), feeOnWalk, 2.56);

// 4) Multi-level slippage sanity — bet $200 into 2 levels: 100 shares
//    at 0.56 (fills $56) + 200 shares at 0.60 (needs $144 more = 240
//    shares, but only 200 available at 0.60). $200 - $56 = $144 remaining
//    at 0.60 = 240 shares needed vs 200 available. So 200 shares taken
//    for $120, remaining $24 unfilled → partial.
console.log('\n=== Multi-level walk sanity ===');
const multi = {
  asks: [
    { price: 0.56, size: 100 },
    { price: 0.60, size: 200 },
  ],
  bids: [],
};
const walk2 = walkAsksForFill(multi, 200);
console.log(`  bet $200 across (100@0.56=$56) + (200@0.60=$120) = $176 max`);
console.log(`  actual: filled_usd=${walk2.filled_usd}  shares=${walk2.shares_bought}  avg=${walk2.avg_price}  partial=${walk2.partial}`);
expect('multi partial=true', walk2.partial === true, walk2.partial, true);
expect('multi filled_usd = 176', approxEq(walk2.filled_usd, 176.0, 0.01), walk2.filled_usd, 176.0);
expect('multi shares = 300', approxEq(walk2.shares_bought, 300.0, 0.01), walk2.shares_bought, 300.0);
// avg = 176/300 = 0.5867 → slippage ≈ 2.67 percentage points vs 0.56 top
expect('avg_price ≈ 0.5867', approxEq(walk2.avg_price, 0.5867, 0.001), walk2.avg_price, 0.5867);
expect('slippage_pp ≈ 2.67', approxEq(walk2.slippage_pp, 2.67, 0.01), walk2.slippage_pp, 2.67);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
