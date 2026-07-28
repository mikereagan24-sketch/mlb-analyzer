'use strict';
// Verify getSignals suppresses ML signals when passed an impossible pair.
const { getSignals } = require('../services/model');

const badGame = {
  market_away_ml: 136,
  market_home_ml: 105,
  market_total: 8.5,
  over_price: -110,
  under_price: -110,
  xcheck_total: null,
};
const modelResult = {
  aML: -140,
  hML: 130,
  estTot: 9.0,
  _suppressed: false,
};
const settings = { SIGNAL_EMIT_FLOOR_PP: 0.001, TOT_SLOPE: 0.08, TOT_PROB_LO: 0.2, TOT_PROB_HI: 0.8, MARKET_TOTAL_DFLT: 8.5 };

const sigs = getSignals(badGame, modelResult, settings);
const mlSigs = sigs.filter(s => s.type === 'ML');
if (mlSigs.length === 0) {
  console.log('PASS: getSignals emitted 0 ML signals for the impossible +136/+105 pair');
} else {
  console.log('FAIL: getSignals emitted ML signals against garbage market:');
  console.log(JSON.stringify(mlSigs, null, 2));
  process.exit(1);
}

// Sanity: same call with a legal pair should emit an ML signal.
const goodGame = { ...badGame, market_away_ml: 142, market_home_ml: -168 };
const sigsGood = getSignals(goodGame, modelResult, settings);
const mlGood = sigsGood.filter(s => s.type === 'ML');
if (mlGood.length > 0) {
  console.log('PASS: legal pair (+142/-168) with edge → ' + mlGood.length + ' ML signal(s) emitted');
} else {
  console.log('FAIL: legal pair did not emit any ML signal (guard is too strict)');
  console.log(JSON.stringify(sigsGood, null, 2));
  process.exit(1);
}
