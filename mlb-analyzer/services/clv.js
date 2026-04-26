'use strict';
// Single source of truth for closing-line-value (CLV) math.
//
// Previously CLV was computed inline in 7+ sites with the formula
//   clv = isFav ? (closingLine - bet_line) : (bet_line - closingLine)
// where isFav was derived from `bet_line < 0`. Two bugs:
//   1) Both branches were wrong — the formula computes American-cents
//      distance, which doesn't actually translate to "how much better did
//      I do at the locked price" because cents-per-implied-prob is not
//      linear (especially around the +100/-100 pivot).
//   2) The fav/dog detection used bet_line only, so the cross-sign case
//      (lock +110, close -120) tripped the wrong branch entirely.
//
// Correct semantics: CLV measures how much better the LOCKED price is
// vs the CLOSING price in implied-probability space. Positive CLV means
// "your team got more favored after you locked" = you got value.
// Sign rule: pClose > pBet → positive CLV (closing book made your side
// more likely to win, so your locked-price implied a worse line at lock
// time — you beat the close).
//
// Output is in percentage points (×1000 / 10 → 1 decimal place), giving
// values like +1.5 / -2.0 / +6.9. Magnitude scale is comparable to the
// old American-cents formula in the typical -150..+150 range, so legacy
// dashboards/UI that grew expectations around that scale still read
// reasonably without changes. The +/- coloring in the UI works
// unchanged.
//
// SQL parity: the same math is replicated in SQL CASE expressions in
// routes/api.js (bulk recompute queries). If THIS function changes, the
// SQL must change in lockstep — both sites are commented to point at
// each other.

function americanToImplied(p) {
  if (p == null) return null;
  return p < 0 ? Math.abs(p) / (Math.abs(p) + 100) : 100 / (p + 100);
}

function calcCLV(bet_line, closing_line) {
  if (bet_line == null || closing_line == null) return null;
  const pBet = americanToImplied(bet_line);
  const pClose = americanToImplied(closing_line);
  if (pBet == null || pClose == null) return null;
  return Math.round((pClose - pBet) * 1000) / 10;
}

module.exports = { americanToImplied, calcCLV };
