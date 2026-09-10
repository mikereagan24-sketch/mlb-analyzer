#!/usr/bin/env node
/**
 * Spread-cell partition: market total axis, frozen, 9 cells. (2026-09-10)
 *
 * The total axis moved from model_total to the market total. It keyed on
 * a model output -- the same quantity whose calibration collapsed on
 * 2026-08-03 -- so a cell definition moved whenever the model did.
 *
 * Three things have to hold and each has failed somewhere in this codebase
 * before:
 *   1. The bands are where we say they are, and nothing sits on a cut.
 *   2. The axis is FROZEN write-once, so a bucket cannot change after the
 *      bet is placed (the mixed-moments problem).
 *   3. Sub-floor cells still COMPUTE; only the display gate excludes them.
 *
 * Run: node scripts/test-spread-cell-axis.js
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

console.log('=== spread-cell axis ===');

// ---- 1. bands ------------------------------------------------------
ok('bounds are 8.25 / 8.75', E.TOTAL_LOW_MAX === 8.25 && E.TOTAL_HIGH_MIN === 8.75);
ok('nine cells', E.ALL_CELLS.length === 9, E.ALL_CELLS.length + ' labels');
ok('labels changed shape so old rows cannot be mistaken for new',
   E.ALL_CELLS.every(c => !/total$/.test(c)),
   'no label ends in "total" any more');

const k = (wp, t) => E.cellKey(wp, t);
ok('7.5 is Low', k(0.4, 7.5) === 'Underdog home / Low');
ok('8.0 is Low', k(0.4, 8.0) === 'Underdog home / Low');
ok('8.25 is Average (inclusive lower bound)', k(0.4, 8.25) === 'Underdog home / Average');
ok('8.5 is Average', k(0.4, 8.5) === 'Underdog home / Average');
ok('8.75 is High (inclusive lower bound)', k(0.4, 8.75) === 'Underdog home / High');
ok('9.5 is High', k(0.4, 9.5) === 'Underdog home / High');
ok('wp tiers unchanged',
   k(0.499, 8.5) === 'Underdog home / Average'
   && k(0.500, 8.5) === 'Balanced / Average'
   && k(0.574, 8.5) === 'Balanced / Average'
   && k(0.575, 8.5) === 'Strong fav / Average');
ok('cellKey REFUSES rather than guessing when the total is missing',
   k(0.4, null) === null && k(0.4, undefined) === null && k(null, 8.5) === null,
   'a game with no market total has no cell');

// No posted rung sits on a boundary -- that is the whole stability claim.
const posted = db.prepare(
  "SELECT DISTINCT market_total t FROM game_log WHERE market_total IS NOT NULL").all()
  .map(r => r.t).filter(t => t != null).sort((a, b) => a - b);
const onEdge = posted.filter(t => t === 8.25 || t === 8.75);
ok('no posted market total lands exactly on a band edge', onEdge.length === 0,
   posted.length + ' distinct lines, none at 8.25 or 8.75');

// ---- 2. the axis is frozen -----------------------------------------
const cols = db.prepare('PRAGMA table_info(game_log)').all().map(c => c.name);
ok('game_log.market_total_at_emit exists', cols.indexOf('market_total_at_emit') !== -1);

const eng = fs.readFileSync(path.join(R, 'services/empirical-spread-edge.js'), 'utf8');
ok('the freeze is WRITE-ONCE',
   eng.indexOf('AND market_total_at_emit IS NULL') !== -1,
   'a later pass with a moved line must not overwrite it');
ok('the axis prefers the frozen column over the live one',
   eng.indexOf('game.market_total_at_emit != null') !== -1
   && eng.indexOf('? game.market_total_at_emit : game.market_total') !== -1);
ok('buildCellIndex coalesces frozen-then-live',
   eng.indexOf('COALESCE(market_total_at_emit, market_total)') !== -1);
ok('the fallback is counted, not silent', eng.indexOf('usedFallback') !== -1);
ok('computeGameEdges reports which axis value chose the cell',
   eng.indexOf('axis_total:') !== -1 && eng.indexOf('axis_total_frozen:') !== -1);
ok('model_total no longer decides the cell',
   eng.indexOf('cellKey(wp, game.model_total)') === -1
   && eng.indexOf('cellKey(wp, r.model_total)') === -1);

// ---- 3. the index still builds, and the floor is display-only -------
const idx = E.buildCellIndex(db);
const sizes = E.ALL_CELLS.map(c => (idx.cells.get(c) || []).length);
const total = sizes.reduce((a, b) => a + b, 0);
console.log('  index: ' + idx.totalGraded + ' rows, ' + total + ' bucketed, '
  + idx.skipped + ' skipped, ' + idx.usedFallback + ' on the market_total fallback');
ok('every graded row lands in exactly one cell', total + idx.skipped === idx.totalGraded);
ok('all nine cells exist in the index', E.ALL_CELLS.every(c => idx.cells.has(c)));
ok('sub-floor cells still COMPUTE (they are populated, not empty)',
   sizes.filter(n => n > 0 && n < 150).length > 0,
   sizes.filter(n => n < 150).length + ' of 9 are under the display floor');

const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
ok('display floor is 150', api.indexOf('const EMP_SPREAD_MIN_SAMPLE   = 150;') !== -1);
ok('the floor gates DISPLAY only, not computation',
   api.indexOf('r.cell_sample_size < EMP_SPREAD_MIN_SAMPLE) continue;') !== -1
   && eng.indexOf('EMP_SPREAD_MIN_SAMPLE') === -1,
   'the engine does not know the floor exists');

// A floor that excludes everything would be a silent outage, so state the
// count rather than only asserting a bound.
const surfacing = sizes.filter(n => n >= 150).length;
console.log('  cells clearing the 150 floor: ' + surfacing + ' of 9');
ok('at least one cell still surfaces', surfacing > 0,
   surfacing + ' of 9 — was 6 of 6 under the old 6-cell grid at floor 50');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
