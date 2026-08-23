'use strict';

// Market-sanity guard for two-outcome moneyline pairs.
//
// Fired by the 2026-07-28 CLE-CIN DH incident: the game-1 row landed with
// market_away_ml=+136 and market_home_ml=+105 — both positive, which no
// real two-outcome book can quote (sum of implied probabilities 0.912 <
// 1.0). Root cause was jobs.js:812-817 picking best-away from one venue
// and best-home from another independently, producing an incoherent pair
// that neither venue ever quoted together. checkOddsSanity in jobs.js
// documented a "same-sign impossible" check but never actually
// implemented it — only the extreme-implied case fired, which +136/+105
// passes cleanly (max implied 0.488).
//
// Semantics: return a short reason string when the pair is structurally
// impossible for a real book; return null when it looks like a plausible
// two-outcome market. Callers decide how to react:
//   - jobs.js checkOddsSanity: attaches reason to odds_flag_reason so
//     the DB row is tagged for review.
//   - jobs.js signalsForGame: nulls the runtime market_*_ml on the
//     `game` object so getSignals falls through its null-market
//     suppression path — no signals emitted against garbage. Does NOT
//     write to game_log (post-lock immutability preserved).
//   - jobs.js refreshSignalBaselines: skips the market_line update
//     when a fresh cmpRow pair fails sanity — the row keeps its prior
//     last-good baseline until the next cron.
//   - model.js getSignals: belt-and-suspenders — treats a bad pair as
//     null-market so no downstream call site can accidentally bypass
//     the runtime nulling in signalsForGame.
//
// Thresholds:
//   - Both sides same sign → impossible. A two-outcome market must have
//     one favorite and one dog (or an exact pick'em, in which case both
//     sides quote near +100, distinct signs by convention). +136/+105
//     and -110/-110 are opposite cases: the -110/-110 pair is the
//     canonical pick'em juice and IS legal — that's why the sign check
//     needs the "both dogs" (both positive) short-circuit exemption for
//     equal-juice pick'ems. Kept simple: only the both-POSITIVE case is
//     flagged as sign-based impossible; both-negative is legal juice.
//   - Implied-sum band [0.95, 1.20]. Real books quote 1.02-1.08 vig; a
//     sum below 0.95 means the book is betting against itself, and
//     above 1.20 means one side is deeply mispriced. The 0.95 floor
//     catches the 0.912 CLE-CIN case; the 1.20 ceiling catches
//     data-scale bugs (e.g. a -800 line paired against another -800).

// Sum-of-implied-probs plausibility band. Real two-outcome books quote
// 1.02-1.08 vig — anything wildly outside is a data bug, not a market.
// Absolute magnitude ceiling on a single American moneyline. (2026-08-22)
//
// WHY THIS EXISTS, AND WHY THE OTHER TWO CHECKS MISS IT.
// The feed emits placeholder/no-liquidity values as real numbers: +94400,
// +89373, +88237, +80672, +79452 and similar were observed on 28 separate
// dates between 2026-07-07 and 2026-08-06. Paired against a matching deep
// favorite (e.g. -99900) such a pair passes BOTH existing checks:
//   - signs are opposite, so the both-positive test does not fire;
//   - implied p sum is 0.00106 + 0.99900 = 1.000, comfortably inside the
//     [0.95, 1.20] vig band.
// So 279 corrupt-line signals reached getSignals and were stopped only by
// the edge cap, which was never meant to be the sole backstop.
//
// THE THRESHOLD IS EMPIRICAL, NOT A GUESS. Over 1643 game_log rows with
// both moneylines present, the per-game max |ML| distribution is:
//   p50=137  p90=186  p99=279  p99.5=299  p99.9=403  max=99900
// Real MLB lines top out near 400 and the distribution is BIMODAL -- there
// is nothing between 403 and 99900. 1000 sits in that empty gap at ~2.5x
// the observed real maximum, so it rejects the corrupt population with no
// plausible false positive. Measured: |ML| > 1000 rejects 2 of 1643 rows,
// and both are corrupt.
//
// DELIBERATELY NOT the implied-p > 0.80 test that checkOddsSanity uses for
// FLAGGING. p > 0.80 is ML -400, which is inside the real range (p99.9 is
// 403) -- promoting that threshold to a block would suppress legitimate
// heavy favorites. A flag threshold and a block threshold are different
// numbers and must not be conflated.
const MAX_ABS_ML = 1000;

const IMPLIED_SUM_MIN = 0.95;
const IMPLIED_SUM_MAX = 1.20;

function _impliedP(ml) {
  const x = Number(ml);
  if (!Number.isFinite(x) || x === 0) return null;
  return x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
}

// Returns a reason string when the (awayMl, homeMl) pair is structurally
// impossible for a two-outcome book, or null when the pair is plausible.
// Missing / zero on either side → returns null (caller's null-market
// guard handles the missing case separately; this function is only for
// detecting structurally-invalid PAIRS that happen to be non-null).
function checkMarketMLPairSanity(awayMl, homeMl) {
  const a = Number(awayMl);
  const h = Number(homeMl);
  if (!Number.isFinite(a) || !Number.isFinite(h)) return null;
  if (a === 0 || h === 0) return null;
  // Both positive → both sides are dogs, no favorite. Real two-outcome
  // books can't quote this — one side must be favored or the market is
  // pick'em with matched negative juice like -110/-110. Both-negative is
  // legal (pick'em with juice on both sides), so only flag both-positive.
  if (a > 0 && h > 0) {
    return 'impossible line pair: both sides positive (' +
      _fmtAmerican(a) + ' / ' + _fmtAmerican(h) + ') — no favorite in a two-outcome market';
  }
  // Magnitude ceiling. Checked BEFORE the implied-sum band because a
  // corrupt line paired with a matching deep favorite produces a sum of
  // almost exactly 1.0 and would otherwise pass.
  if (Math.abs(a) > MAX_ABS_ML || Math.abs(h) > MAX_ABS_ML) {
    return 'implausible line magnitude: ' + _fmtAmerican(a) + ' / ' + _fmtAmerican(h) +
      '  exceeds +/-' + MAX_ABS_ML + ' (real MLB lines peak near 400); treating as corrupt feed data';
  }
  const pa = _impliedP(a);
  const ph = _impliedP(h);
  if (pa == null || ph == null) return null;
  const sum = pa + ph;
  if (sum < IMPLIED_SUM_MIN || sum > IMPLIED_SUM_MAX) {
    return 'impossible line pair: implied p sum=' + sum.toFixed(3) +
      ' outside plausible book range [' + IMPLIED_SUM_MIN + ', ' + IMPLIED_SUM_MAX + '] (' +
      _fmtAmerican(a) + ' / ' + _fmtAmerican(h) + ')';
  }
  return null;
}

function _fmtAmerican(n) {
  return n > 0 ? '+' + n : String(n);
}

// Single-price sanity for a moneyline. (2026-08-22)
//
// Hoisted here from services/unabated.js, where it lived as isSaneML with
// its own ML_MAX_ABS_PRICE = 1000. That constant and MAX_ABS_ML above were
// derived INDEPENDENTLY -- one from Unabated's 99900 "no active contract"
// sentinel, one from the game_log distribution (real lines peak at 403;
// nothing exists between 403 and 99900) -- and landed on the same number.
// Two modules agreeing on 1000 by coincidence is exactly how the sixth
// copy of a function gets written, so there is now one definition.
//
// unabated.js, kalshi.js and scraper.js all use this. Before 2026-08-22
// only unabated.js had any magnitude bound at all, which is why live
// in-game Kalshi prices reached the signal path unchecked.
function isSaneML(price) {
  if (price == null) return false;
  const n = Number(price);
  if (!Number.isFinite(n)) return false;
  if (n === 0) return false;              // 0 is not a price
  return Math.abs(n) <= MAX_ABS_ML;
}

module.exports = {
  checkMarketMLPairSanity,
  IMPLIED_SUM_MIN,
  IMPLIED_SUM_MAX,
  MAX_ABS_ML,
  isSaneML,
};
