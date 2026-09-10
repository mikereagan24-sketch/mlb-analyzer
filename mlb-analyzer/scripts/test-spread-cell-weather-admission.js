#!/usr/bin/env node
/**
 * buildCellIndex admits weather-contamination-tagged rows. (2026-09-10)
 *
 * WHY THE FILTER CAME OFF. It was added 2026-08-06 for an index keyed on
 * (win_prob, model_total): a contaminated row's biased model_total sent
 * it to the wrong bucket. The axis moved to the MARKET total earlier the
 * same day, and weather reaches neither axis -- it enters
 * services/model.js only at estTot, downstream of aML/hML.
 *
 * WHAT THIS TEST DEFENDS. Three things, each of which has been got wrong
 * somewhere in this codebase before:
 *   1. The filter is actually gone, and the corpus grew by the tagged
 *      rows rather than by something else drifting.
 *   2. The cell n table matches the counts the decision was made on. A
 *      migration argued from numbers nobody re-checks is how a stale
 *      analysis outlives the thing it justified.
 *   3. The claim itself -- weather does not move the win-prob tier -- is
 *      RE-MEASURED here against live code, not quoted from a report.
 *      This is the arm that can go red if model.js ever routes weather
 *      into the moneyline.
 *
 * The sibling filters in services/empirical-spread-roi.js stay; they
 * read emitted signals from the old six-cell partition. Asserted below
 * so "drop it there too" is a deliberate act with a failing test, not a
 * tidy-up.
 *
 * Run: node scripts/test-spread-cell-weather-admission.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const E = require(path.join(R, 'services/empirical-spread-edge'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== spread cells: weather-tagged rows are admitted ===');

// ---- 1. the filter is gone from the index, and only from it ---------
const eng = fs.readFileSync(path.join(R, 'services/empirical-spread-edge.js'), 'utf8');
ok('buildCellIndex no longer filters on weather_contamination_reason',
   eng.indexOf('AND weather_contamination_reason IS NULL') === -1);
ok('the removal is explained, not silent',
   eng.indexOf('NO WEATHER-CONTAMINATION FILTER HERE') !== -1
   && eng.indexOf('0 of 780') !== -1);

const roi = fs.readFileSync(path.join(R, 'services/empirical-spread-roi.js'), 'utf8');
const roiFilters = (roi.match(/g\.weather_contamination_reason IS NULL/g) || []).length;
ok('empirical-spread-roi.js KEEPS both of its filters', roiFilters === 2,
   roiFilters + ' of 2 — they read emitted signals from the old partition');
ok('and says why it keeps them',
   (roi.match(/KEPT DELIBERATELY/g) || []).length === 2);

// ---- 2. the cell n table the decision was made on -------------------
// Expected counts measured 2026-09-10 against the corpus graded through
// 2026-09-04. Later dates only add games, so these are FLOORS, not
// equalities -- an equality assert here would fail every night for the
// right reason and teach everyone to ignore it.
const EXPECTED_FLOOR = {
  'Underdog home / Low':     284,
  'Underdog home / Average': 279,
  'Underdog home / High':    236,
  'Balanced / Low':          205,
  'Balanced / Average':      293,
  'Balanced / High':         148,
  'Strong fav / Low':        191,
  'Strong fav / Average':    196,
  'Strong fav / High':       106,
};
// What the same cells held under the filter, for the before/after table.
const BEFORE = {
  'Underdog home / Low':     166, 'Underdog home / Average': 155,
  'Underdog home / High':    103, 'Balanced / Low':          137,
  'Balanced / Average':      191, 'Balanced / High':          81,
  'Strong fav / Low':        131, 'Strong fav / Average':     134,
  'Strong fav / High':        60,
};

const idx = E.buildCellIndex(db);
console.log('');
console.log('  cell                          before   after   >=150');
let over150 = 0, over250 = 0, floorsOk = true;
for (const c of E.ALL_CELLS) {
  const n = (idx.cells.get(c) || []).length;
  if (n >= 150) over150++;
  if (n >= 250) over250++;
  if (n < EXPECTED_FLOOR[c]) floorsOk = false;
  console.log('  ' + c.padEnd(28) + String(BEFORE[c]).padStart(6)
    + String(n).padStart(8) + (n >= 150 ? '     yes' : '      no'));
}
console.log('  corpus: ' + idx.totalGraded + ' rows, ' + idx.skipped + ' skipped, '
  + idx.usedFallback + ' on the market_total fallback');

ok('every cell is at or above its measured 2026-09-10 count', floorsOk,
   'floors, not equalities — the corpus only grows');
ok('7 of 9 cells clear the 150 display floor', over150 === 7,
   over150 + ' of 9   (was 3 of 9 under the filter)');
ok('3 of 9 cells clear 250', over250 === 3, over250 + ' of 9   (was 0 of 9)');
ok('corpus is at least the 1938 the decision was measured on',
   idx.totalGraded >= 1938, idx.totalGraded + ' rows   (was 1158)');

// The growth must be the TAGGED rows specifically, not unrelated drift.
const tagged = db.prepare(
  "SELECT COUNT(*) n FROM game_log "
  + "WHERE home_score IS NOT NULL AND away_score IS NOT NULL "
  + "  AND model_home_ml IS NOT NULL AND model_away_ml IS NOT NULL "
  + "  AND COALESCE(market_total_at_emit, market_total) IS NOT NULL "
  + "  AND weather_contamination_reason IS NOT NULL").get().n;
const clean = db.prepare(
  "SELECT COUNT(*) n FROM game_log "
  + "WHERE home_score IS NOT NULL AND away_score IS NOT NULL "
  + "  AND model_home_ml IS NOT NULL AND model_away_ml IS NOT NULL "
  + "  AND COALESCE(market_total_at_emit, market_total) IS NOT NULL "
  + "  AND weather_contamination_reason IS NULL").get().n;
ok('the corpus grew by exactly the tagged rows',
   idx.totalGraded === clean + tagged && tagged > 0,
   tagged + ' tagged + ' + clean + ' clean = ' + idx.totalGraded);

// ---- 3. re-measure the claim against live code ----------------------
// Weather must not reach the moneyline. Read model.js rather than trust
// the note: every weather reference has to sit at or after the estTot
// line, which is itself after aML/hML are final.
const mdl = fs.readFileSync(path.join(R, 'services/model.js'), 'utf8');
const lines = mdl.split(/\r?\n/);
const estTotLine = lines.findIndex(l => /const estTot\s*=/.test(l));
const mlLine = lines.findIndex(l => /const \{ adjA:aML, adjH:hML \}/.test(l));
ok('model.js still computes aML/hML BEFORE estTot',
   mlLine !== -1 && estTotLine !== -1 && mlLine < estTotLine,
   'aML/hML at line ' + (mlLine + 1) + ', estTot at ' + (estTotLine + 1));

// A weather READ is `game.wind_factor` / `game.temp_run_adj`, or one of
// the derived terms used as an operand. It is NOT `windFactor: 0` in an
// object literal -- runModel's two early-return stubs (incomplete_lineup,
// bullpen_unavailable) carry that key beside `aML: null`, writing a
// constant into a suppressed result. Counting those as reads flagged
// lines 723 and 766 on the first run of this test; they compute nothing.
const weatherRead = l => {
  const code = l.replace(/\b(windFactor|windRunAdj|tempRunAdj)\s*:/g, ''); // drop object keys
  return /game\.(wind_factor|temp_run_adj)/.test(code)
      || /\b(windRunAdj|tempRunAdj|windFactor)\b/.test(code);
};
const weatherRefs = [];
lines.forEach((l, i) => {
  if (/^\s*(\/\/|\*)/.test(l)) return;                    // comments don't compute
  if (weatherRead(l)) weatherRefs.push(i);
});
const early = weatherRefs.filter(i => i < mlLine);
ok('no weather term is READ before the moneyline is final',
   early.length === 0,
   early.length ? 'lines ' + early.map(i => i + 1).join(', ') + ' — WEATHER NOW REACHES THE ML'
                : weatherRefs.length + ' weather reads, all at/after line ' + (mlLine + 1));

// SELFTEST arms: a checker that cannot go red is not a checker. Prove
// BOTH halves detect the failure they exist to catch.
const mlSrc = '  const { adjA:aML, adjH:hML } = applySpread(rawAML, rawHML, FAV_ADJ, DOG_ADJ);';
// Delete the real ML line before re-appending it below estTot, or
// findIndex just re-finds the original and the arm passes vacuously.
const broken = lines.slice(0, estTotLine + 1)
  .filter(l => !/const \{ adjA:aML, adjH:hML \}/.test(l))
  .concat([mlSrc]);                                              // ML now AFTER estTot
const bmMl = broken.findIndex(l => /const \{ adjA:aML, adjH:hML \}/.test(l));
const bmEst = broken.findIndex(l => /const estTot\s*=/.test(l));
ok('SELFTEST: ordering arm goes red when the ML is priced after estTot',
   bmMl !== -1 && bmEst !== -1 && !(bmMl < bmEst),
   'ML at ' + (bmMl + 1) + ', estTot at ' + (bmEst + 1) + ' in the mutated source');
ok('SELFTEST: read arm goes red on a real weather read above the ML',
   weatherRead('  const wf = game.wind_factor || 0;') === true
   && weatherRead('  const hRuns = hRunsRaw * windFactor;') === true,
   'a genuine read is still caught after excluding object keys');
ok('SELFTEST: read arm ignores the suppressed-stub object keys',
   weatherRead('      windFactor: 0, windRunAdj: 0,') === false,
   'lines 723 / 766 are writes of a constant, not reads');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
