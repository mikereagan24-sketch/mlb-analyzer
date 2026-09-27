'use strict';

/**
 * Pythagorean home win probability, with the HFA boost and the WP clamp.
 *
 * ONE implementation. This existed as FOUR verbatim copies:
 *
 *   services/model.js:1422-1425          standard price
 *   services/model.js:1452-1455          opener/Alt price
 *   services/baserunning-backtest.js:148 pythagHomeWp(), the backtest
 *   routes/api.js:7906-7909              /debug/model-trace
 *
 * The backtest copy and the model copies are the reason this hoist happened
 * now rather than later: a term added to the price has to be added to every
 * copy or the harness stops measuring what production computes, and the debug
 * trace stops explaining it. `utils/framing-rate.js` records the same lesson
 * from five copies that all carried one bug, where the pitch floor checked
 * volume and never age.
 *
 * The arithmetic is unchanged from those copies, deliberately down to the
 * branch order and the clamp order:
 *
 *   - Degenerate run expectations short-circuit BEFORE the power, because
 *     0 ** exp is 0 and would make the ratio 0/0 = NaN. The 0.25 / 0.75
 *     constants are the historical values, not a derivation.
 *   - HFA is added to the RAW probability and the clamp is applied AFTER,
 *     so the clamp bounds the returned number and not the pre-boost one.
 *     Reversing those two changes prices at the clamp edges.
 *
 * `**` in the model copies and `Math.pow` in the other two are the same
 * operation (both are ECMAScript Number::exponentiate), so the consolidation
 * is exact rather than approximate. scripts/test-pythag-consolidation.js
 * asserts that empirically over the forward corpus and the current slate
 * instead of relying on that argument.
 *
 * @param {number} aRuns    away expected runs (post framing/defense adj)
 * @param {number} hRuns    home expected runs (post framing/defense adj)
 * @param {number} pythExp  PYTH_EXP
 * @param {number} hfaBoost HFA_BOOST, added to rawHW
 * @param {number} wpLo     WP_CLAMP_LO
 * @param {number} wpHi     WP_CLAMP_HI
 * @returns {{rawHW: number, adjHW: number, adjAW: number}}
 *   rawHW — pre-boost, pre-clamp home win prob. Callers persist this.
 *   adjHW — post-boost, post-clamp home win prob. The price.
 *   adjAW — 1 - adjHW.
 */
function pythagWinProb(aRuns, hRuns, pythExp, hfaBoost, wpLo, wpHi) {
  let rawHW;
  if (aRuns <= 0 && hRuns <= 0) rawHW = 0.5;
  else if (hRuns <= 0)          rawHW = 0.25;
  else if (aRuns <= 0)          rawHW = 0.75;
  else rawHW = Math.pow(hRuns, pythExp) / (Math.pow(hRuns, pythExp) + Math.pow(aRuns, pythExp));
  const adjHW = Math.min(Math.max(rawHW + hfaBoost, wpLo), wpHi);
  return { rawHW: rawHW, adjHW: adjHW, adjAW: 1 - adjHW };
}

module.exports = { pythagWinProb };
