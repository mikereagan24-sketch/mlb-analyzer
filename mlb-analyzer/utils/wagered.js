'use strict';
/**
 * Amount risked on a bet, to-win-$100 convention. (2026-08-23)
 *
 * WHAT WAS WRONG. Totals returned a FLAT 110 regardless of price, in four
 * separate implementations (services/frv-backtest.js, services/parameter-sweep.js,
 * public/index.html wageredForSignal, and a SQL CASE in routes/api.js). 110
 * is the stake at -110; a totals bet struck at -127 risks 127 and one at
 * +107 risks 93.46. Using 110 for all of them makes every totals ROI
 * denominator an approximation, and the error is not symmetric -- it
 * understates the stake on favourites and overstates it on dogs.
 *
 * PRICE PRECEDENCE for totals:
 *   1. bet_price   -- the juice actually struck (captured since 2026-08-23)
 *   2. over_price / under_price for the bet side -- the market's price
 *   3. -110        -- last resort, and now genuinely last
 *
 * ML is unchanged: the line IS the price, so bet_line (or market_line)
 * gives the stake directly.
 *
 * SQL PARITY. routes/api.js computes the same quantity in a SQL CASE for
 * bulk aggregates. If this function changes, that must change in lockstep;
 * both sites carry a comment pointing at the other. Same arrangement
 * services/clv.js already uses for CLV.
 */

// Plausibility bound on a TOTALS juice, matching MLB_TOTAL_MAX_JUICE_ABS in
// services/unabated.js rather than inventing a second number. Real MLB O/U
// juice sits inside +/-200; anything beyond is corrupt feed data.
//
// This guard is not decorative. game_log carries over_price=99900 on
// lad-sf 2026-04-23 -- the same game as the corrupt ML sentinel. Without
// the bound, stake = 10000/99900 = $0.10, and that row would silently
// contribute a near-zero denominator to every totals ROI. It showed up as
// a -109.9 outlier in the per-bet stake change when this function was
// first switched from the flat 110.
const MAX_TOTAL_JUICE_ABS = 200;

// Stake to win $100 at an American price.
function stakeForPrice(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? (10000 / n) : Math.abs(n);
}

function saneTotalsPrice(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return false;
  return Math.abs(n) <= MAX_TOTAL_JUICE_ABS;
}

/**
 * @param sig  a bet_signals row OR a sweep signal. Accepts both shapes:
 *             snake_case (signal_type/bet_line/bet_price/over_price) and
 *             the sweep's camelCase (type/marketLine/overPrice/underPrice).
 */
function wageredFor(sig) {
  if (!sig) return 0;
  const type = String(sig.signal_type || sig.type || '').toLowerCase();

  if (type === 'ml') {
    const ln = (sig.bet_line != null ? sig.bet_line
             : (sig.marketLine != null ? sig.marketLine : sig.market_line));
    const s = stakeForPrice(ln);
    return s == null ? 0 : s;
  }

  // Totals: line and price are different quantities. Never use bet_line
  // here -- on a Total that holds the TOTAL (8.5), not a price.
  const isOver = String(sig.signal_side || sig.side || '').toLowerCase() === 'over';
  const candidates = [
    sig.bet_price,
    isOver ? sig.over_price : sig.under_price,
    isOver ? sig.overPrice : sig.underPrice,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    if (!saneTotalsPrice(c)) continue;      // corrupt price -> fall through
    const s = stakeForPrice(c);
    if (s != null) return s;
  }
  return 110;   // -110 stake, last resort
}

module.exports = { wageredFor, stakeForPrice, saneTotalsPrice, MAX_TOTAL_JUICE_ABS };
