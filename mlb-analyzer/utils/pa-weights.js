// LINEUP-ORDER PA WEIGHTS: THE ONE FALLBACK. (2026-10-03)
//
// Pricing reads the saved setting (app_settings.pa_weights, parsed by
// services/jobs.js getSettings into settings.PA_WEIGHTS). This constant is
// used only when that setting is missing or malformed -- and before this
// file it was hard-coded in seven places, all still holding the ORIGINAL
// default (4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7) after the production
// setting moved on. The browser's copy was what the Matchups card showed.
//
// It now equals the current production setting, so wherever the setting is
// valid nothing changes. services/baserunning-util.js DEFAULT_PA_WEIGHTS is
// deliberately NOT this constant: it feeds only the BsR backtest's
// 'pa_weighted' construction, and moving it would change backtest output.
//
// Same file for server and page: server.js serves it as /pa-weights.js and
// the UMD footer defines module.exports under require() and
// window.PaWeights in the page -- the pattern of utils/highlight-gate.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaWeights = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PA_WEIGHTS_DEFAULT = Object.freeze([4.65, 4.6, 4.55, 4.5, 4.25, 4.13, 4, 3.85, 3.65]);
  // A parsed setting is usable when it is exactly nine finite numbers.
  function isValidPaWeights(a) {
    return Array.isArray(a) && a.length === 9 && a.every(function (x) { return typeof x === 'number' && isFinite(x); });
  }
  return { PA_WEIGHTS_DEFAULT: PA_WEIGHTS_DEFAULT, isValidPaWeights: isValidPaWeights };
}));
