#!/usr/bin/env node
/**
 * Did the post-first-pitch price actually MOVE? (2026-08-22)
 *
 * scripts/post-start-exposure.js produced an UPPER BOUND: signals with a
 * price-affecting audit event after real first pitch. That counts
 * opportunities to be mispriced, not mispricings -- COALESCE and the odds
 * lock make many refreshes no-ops.
 *
 * This narrows it to signals whose stored line actually DIFFERS from the
 * last capture taken before first pitch, and reports the distribution of
 * |change| -- a 2-point drift and a 40-point drift are not the same
 * finding and must not be collapsed into one count.
 *
 * THE CRITERION NOW LIVES IN utils/post-start-pricing.js. (2026-09-14) It
 * was duplicated verbatim here, in post-start-exposure.js and in
 * tag-post-start-pricing.js, and registering the tagger as a production
 * backfill would have made a fourth copy. Timezone handling (captures are
 * PT, first_pitch_utc is UTC) is documented there, once.
 *
 * COVERAGE IS NOW MEASURED, NOT ASSERTED. This header used to state
 * "empirical_market_captures spans 2026-06-11..2026-08-07 and 755 games".
 * By 2026-09-14 the captures reached 09-13 and covered 1249 games, and the
 * comment had been two months stale while still reading as current. The
 * number is printed from captureCoverage() at the top of every run instead.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const psp = require(path.join(R, 'utils/post-start-pricing'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

(function main() {
  const cov = psp.captureCoverage(db);
  console.log('=== capture coverage (measured, not remembered) ===');
  console.log('  empirical_market_captures ml: ' + cov.rows + ' priced rows, '
    + cov.games + ' games, ' + cov.from + ' .. ' + cov.to);
  console.log('  a signal outside that window has no pre-first-pitch capture to');
  console.log('  compare against and is reported unmeasurable, not assumed clean.');
  console.log('');

  const exposed = psp.exposedMlSignals(db);
  console.log('=== narrowing the exposure to genuine price movement ===');
  console.log('  exposed ML signals (upper bound): ' + exposed.size);

  const cls = psp.classifyExposed(db, exposed);
  const changed = cls.changed;
  console.log('  no usable pre-first-pitch capture (unmeasurable)         : '
    + cls.unmeasurable.length);
  console.log('  price IDENTICAL to last pre-first-pitch capture (no-op)  : '
    + cls.noChange.length);
  console.log('  price CHANGED after first pitch                          : '
    + changed.length);
  console.log('');

  if (!changed.length) { console.log('  nothing moved.'); return; }

  const abs = changed.map((c) => Math.abs(c.d)).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  console.log('=== distribution of |change| in American odds points ===');
  console.log('  n=' + abs.length + '   min ' + abs[0] + '   p25 ' + q(0.25) + '   median ' + q(0.5)
    + '   p75 ' + q(0.75) + '   p90 ' + q(0.90) + '   max ' + abs[abs.length - 1]);
  console.log('');
  const bands = [[1, 5], [5, 10], [10, 20], [20, 40], [40, 100], [100, 1e9]];
  console.log('  |change|      n    share   still_active');
  for (const b of bands) {
    const lo = b[0], hi = b[1];
    const g = changed.filter((c) => Math.abs(c.d) >= lo && Math.abs(c.d) < hi);
    const act = g.filter((c) => c.active === 1).length;
    const lbl = hi > 1e8 ? (lo + '+') : (lo + '-' + hi);
    console.log('  ' + lbl.padEnd(11) + String(g.length).padStart(4) + '   '
      + (100 * g.length / changed.length).toFixed(1).padStart(5) + '%   ' + act);
  }
  console.log('');
  console.log('  A 2-point drift is ordinary market noise. A 40-point move on a game');
  console.log('  already in progress is the price reacting to the score.');
  console.log('');
  console.log('=== largest moves ===');
  changed.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12).forEach((c) =>
    console.log('    ' + c.gd + ' ' + c.gi.padEnd(9) + c.side.padEnd(5)
      + ' pre ' + String(c.pre).padStart(6) + ' -> stored ' + String(c.stored).padStart(6)
      + '   d=' + (c.d > 0 ? '+' : '') + c.d + (c.active === 1 ? '   [ACTIVE]' : '')));
  console.log('');
  console.log('  still active among CHANGED: ' + changed.filter((c) => c.active === 1).length);
})();
