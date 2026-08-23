'use strict';
/**
 * Caller-populated model inputs, in one place. (2026-08-22)
 *
 * THE PROBLEM THIS EXISTS TO STOP.
 * runModel() reads several fields off `game` that it does not compute.
 * In production jobs.js populates them before calling. Offline harnesses
 * build their own corpora via parameter-sweep.preScreenGame(), which
 * does NOT populate them -- so every such field silently arrives
 * `undefined` and the feature reading it is inert.
 *
 * That has now produced two false negatives:
 *   - DEFENSE_FRV_ENABLED reported 0/790 games changed ("FRV does
 *     nothing, leave it off forever") -- the opposite of the truth.
 *   - CATCHER_FRAMING_MUTE reported 0/790 ("the flag is inert").
 *
 * and one silent contamination: four standalone harnesses
 * (edge-honesty-scope, component-signal-diagnostic,
 * projected-vs-closing-calibration, calibration-sweep) scored a model
 * missing BOTH defensive inputs, so their absolute figures describe a
 * model that has never run in production.
 *
 * Patching each script separately is what produced five copies of
 * computeFramingRvPerGame. One helper, used by every harness, is the
 * only version of this fix that stays fixed.
 *
 * KEEP IN SYNC with the population block in services/jobs.js (~636-815).
 * If runModel starts reading a new caller-populated field, it goes here
 * AND in the guard table in scripts/calibration-ab.js.
 */

let _frvForTeam = () => null;
let _framingForTeam = () => null;
try {
  const fb = require('./frv-backtest');
  _frvForTeam = fb.computeTeamFieldingRunsPerGame || _frvForTeam;
  _framingForTeam = fb.computeFramingRvPerGame || _framingForTeam;
} catch (e) { /* harness still runs; populate() reports zero coverage */ }

/**
 * The fields runModel reads but never computes. Anything listed here is
 * a field whose absence silently disables a feature rather than raising.
 */
const CALLER_POPULATED_FIELDS = [
  'awayFieldingRunsPerGame', 'homeFieldingRunsPerGame',
  'awayCatcherFramingRvPerGame', 'homeCatcherFramingRvPerGame',
];

/**
 * Populate caller-computed inputs on a pre-screened game, the way prod
 * does. Mutates and returns `wrapped`.
 *
 * @param wrapped  the object preScreenGame() returned (passed to runModel)
 * @param gameRow  the raw game_log row (carries the lineup JSON)
 * @param settings getSettings() output
 */
function populateCallerInputs(wrapped, gameRow, settings) {
  if (!wrapped || !gameRow) return wrapped;
  try {
    wrapped.awayFieldingRunsPerGame = _frvForTeam(gameRow.away_team, gameRow.away_lineup_json, settings);
    wrapped.homeFieldingRunsPerGame = _frvForTeam(gameRow.home_team, gameRow.home_lineup_json, settings);
  } catch (e) { /* leave undefined; coverage() will report it */ }
  try {
    // Each team's OWN catcher. model.js:1288 crosses the sides
    // deliberately (the home catcher frames against the away offense),
    // but that crossing happens inside runModel -- mirroring jobs.js:815.
    wrapped.awayCatcherFramingRvPerGame = _framingForTeam(gameRow.away_team, gameRow.away_lineup_json, settings);
    wrapped.homeCatcherFramingRvPerGame = _framingForTeam(gameRow.home_team, gameRow.home_lineup_json, settings);
  } catch (e) { /* ditto */ }
  return wrapped;
}

/**
 * Coverage report over a built corpus. Harnesses should print this so a
 * silently-empty input is visible in the output rather than inferred
 * later from a suspicious null result.
 *
 * @param rows array of objects each exposing the wrapped game
 * @param pick fn(row) -> wrapped game (default: identity)
 */
function coverage(rows, pick) {
  const get = pick || (r => r);
  return CALLER_POPULATED_FIELDS.map(f => ({
    field: f,
    present: rows.filter(r => { const g = get(r); return g && g[f] != null; }).length,
    total: rows.length,
  }));
}

function coverageLine(rows, pick) {
  return coverage(rows, pick).map(c => c.field + '=' + c.present + '/' + c.total).join('  ');
}

/**
 * True when every listed field is null on every row -- i.e. the harness
 * is about to measure a model with the feature structurally disabled.
 */
function missingEntirely(rows, fields, pick) {
  const get = pick || (r => r);
  return (fields || CALLER_POPULATED_FIELDS)
    .filter(f => !rows.some(r => { const g = get(r); return g && g[f] != null; }));
}

module.exports = {
  CALLER_POPULATED_FIELDS,
  populateCallerInputs,
  coverage,
  coverageLine,
  missingEntirely,
};
