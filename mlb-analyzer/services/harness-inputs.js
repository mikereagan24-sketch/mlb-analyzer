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


// ── the bullpen term for an OFFLINE REPLAY ─────────────────────────────
//
// MEASURED 2026-09-03 over 1,171 games / 2,340 sides, June-August:
//
//   do nothing (today)      signed +0.0066   mean |d| 0.0074   max 0.0294
//   pass all 17 args        signed +0.0009   mean |d| 0.0044   max 0.0255
//   read the persisted col  exact
//
//   2,329 of 2,340 sides differed. 60.3% by more than 0.005.
//
// TWO DEFECTS WERE STACKED, and they partially CANCEL, which is why
// neither shows up as an obvious outlier:
//
//   DATE   getBullpenWobaBlended reads woba_data, wiped and reloaded
//          daily. Replaying a June game prices its bullpen off today's
//          projections. The batter and SP terms ARE date-corrected via
//          getWobaIndexAsOf against woba_data_snapshot -- the bullpen
//          term was the one input that silently was not.
//   ARITY  the harnesses passed 10 of 17 parameters, so minBF defaulted
//          to 100 against production's 50, downweight-starters was off,
//          the blend fell back to the GLOBAL 0.45/0.55 instead of the
//          bullpen's 0.25/0.75, the DH nightcap rule was inert, and no
//          park neutralisation was applied.
//
// game_log already carries what the model actually used, on 1944/1944
// rows since 2026-04-04. Reading it is exact by construction and cannot
// drift again; recomputing can only ever approximate it.
//
// The recompute path is kept for rows without a persisted value, and it
// now passes ALL 17 arguments so that fallback is the +0.0009 shape
// rather than the +0.0066 one.
function bullpenTermForReplay(q, gameRow, side, settings, opts) {
  opts = opts || {};
  const persisted = side === 'away'
    ? { woba: gameRow.away_bullpen_woba,
        vsL:  gameRow.away_bullpen_woba_vs_l,
        vsR:  gameRow.away_bullpen_woba_vs_r }
    : { woba: gameRow.home_bullpen_woba,
        vsL:  gameRow.home_bullpen_woba_vs_l,
        vsR:  gameRow.home_bullpen_woba_vs_r };
  if (persisted.woba != null) {
    return { woba: persisted.woba, vsLHB: persisted.vsL, vsRHB: persisted.vsR,
             source: 'persisted' };
  }
  if (!q || !q.getBullpenWobaBlended) return null;
  const N = (v, d) => (v != null ? Number(v) : d);
  const s = settings || {};
  try {
    const r = q.getBullpenWobaBlended(
      opts.team, opts.starter || '', opts.lineup || [],
      N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
      N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
      N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), gameRow.game_date,
      N(s.UNKNOWN_PITCHER_WOBA, 0.335),
      N(s.BULLPEN_MIN_BF, N(s.MIN_BF, 100)),
      !!(s.BULLPEN_DOWNWEIGHT_STARTERS === true || s.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
      N(s.BULLPEN_W_PROJ, N(s.W_PROJ, 0.65)),
      N(s.BULLPEN_W_ACT, N(s.W_ACT, 0.35)),
      opts.gameNumber || 1);
    return r ? { woba: r.woba, vsLHB: r.vsLHB, vsRHB: r.vsRHB, source: 'recomputed' } : null;
  } catch (e) { return null; }
}

module.exports = {
  bullpenTermForReplay,
  CALLER_POPULATED_FIELDS,
  populateCallerInputs,
  coverage,
  coverageLine,
  missingEntirely,
};
