#!/usr/bin/env node
/**
 * Remove fielding_frv rows below the ingest's own sample floor. (2026-08-27)
 *
 *   node scripts/prune-subthreshold-frv.js            # DRY RUN, the default
 *   node scripts/prune-subthreshold-frv.js --apply
 *
 * THIS IS CRITERION-BASED, NOT A FETCH DIFF. utils/prune-missing.js is the
 * wrong tool here and must not be reached for: its guard protects against a
 * TRUNCATED FETCH emptying a table, by comparing what arrived against what
 * exists. Nothing is being fetched here. The criterion is explicit,
 * checkable before and after, and derived from the producer:
 *
 *     outs_total < FRV_MIN_OUTS   (= FRV_MIN_INNINGS * 3 = 600)
 *
 * WHAT IT REMOVES, and why they are not merely old. 44 rows survived from a
 * pre-floor ingest generation -- season_start/season_end NULL where every
 * current row carries 2024-2026 -- with outs_total from 6 to 546. The
 * current fetch sends minInnings=200 and therefore CANNOT produce any of
 * them. They are not qualified fielders who dropped off the leaderboard
 * with a still-valid trailing figure; they were never eligible under the
 * rule the table is now filled by.
 *
 * The harm was noise, not staleness. total_runs/outs_total * OPPS_PER_GAME
 * turns a handful of outs into a full-game defensive adjustment: Joc
 * Pederson at 18 outs scored -0.697 runs/game and Kyle Schwarber at 51
 * scored -0.519, against a maximum of 0.208 across all 510 legitimate rows.
 *
 * SAFETY. Dry run by default. Refuses if the criterion would remove a row
 * the current ingest could have produced (season_start NOT NULL), because
 * that would mean the floor and the data have diverged and the operator
 * should look before anything is deleted. Prints every row it will remove.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { FRV_MIN_INNINGS, FRV_MIN_OUTS } = require(path.join(R, 'services/scraper'));
const { db } = require(path.join(R, 'db/schema'));

const APPLY = process.argv.includes('--apply');

(function main() {
  console.log('=== prune sub-threshold fielding_frv rows ===');
  console.log('  floor: minInnings=' + FRV_MIN_INNINGS + ' -> outs_total >= ' + FRV_MIN_OUTS
    + '   (imported from the producer, not restated)');
  console.log('  mode : ' + (APPLY ? 'APPLY' : 'DRY RUN (pass --apply to delete)'));
  console.log('');

  const before = db.prepare('SELECT COUNT(*) c FROM fielding_frv').pluck().get();
  const doomed = db.prepare(
    'SELECT mlb_id, name, position, outs_total, total_runs, season_start, updated_at '
    + 'FROM fielding_frv WHERE outs_total < ? ORDER BY outs_total').all(FRV_MIN_OUTS);

  console.log('  rows total          : ' + before);
  console.log('  rows below the floor: ' + doomed.length);
  console.log('');

  if (!doomed.length) {
    console.log('  Nothing below the floor. Either this already ran, or the ingest');
    console.log('  has been clean since. Not an error.');
    return;
  }

  // The refusal. A row carrying a season window came from the CURRENT
  // ingest, which enforces the floor server-side -- so it should be
  // impossible for one to sit below it. If that ever happens the two have
  // diverged and a human needs to look before rows are destroyed.
  const modern = doomed.filter(r => r.season_start != null);
  if (modern.length) {
    console.log('  *** REFUSING: ' + modern.length + ' row(s) below the floor carry a season');
    console.log('  window, meaning the CURRENT ingest produced them. That should be');
    console.log('  impossible when the fetch sends minInnings=' + FRV_MIN_INNINGS + '.');
    for (const r of modern.slice(0, 10)) {
      console.log('    ' + r.mlb_id + '  ' + String(r.name).padEnd(24)
        + ' outs=' + r.outs_total + '  season=' + r.season_start);
    }
    console.log('  Investigate the producer before deleting anything.');
    process.exit(2);
  }

  const opps = 25;   // DEFENSE_FRV_OPPS_PER_GAME default, for the magnitude column
  console.log('  every row to be removed (all pre-floor generation, season window NULL):');
  console.log('    mlb_id    name                      pos   outs   runs/game@' + opps);
  for (const r of doomed) {
    const perGame = r.outs_total ? (r.total_runs / r.outs_total) * opps : 0;
    console.log('    ' + String(r.mlb_id).padEnd(9) + String(r.name || '').padEnd(26)
      + String(r.position).padEnd(6) + String(r.outs_total).padStart(5)
      + '   ' + (perGame >= 0 ? '+' : '') + perGame.toFixed(3));
  }
  console.log('');

  if (!APPLY) {
    console.log('  DRY RUN — nothing deleted. Re-run with --apply.');
    return;
  }

  const info = db.prepare('DELETE FROM fielding_frv WHERE outs_total < ?').run(FRV_MIN_OUTS);
  const after = db.prepare('SELECT COUNT(*) c FROM fielding_frv').pluck().get();
  console.log('  deleted: ' + info.changes + '   rows ' + before + ' -> ' + after);

  // Post-conditions, asserted rather than assumed.
  const left = db.prepare('SELECT COUNT(*) c FROM fielding_frv WHERE outs_total < ?')
    .pluck().get(FRV_MIN_OUTS);
  const spread = db.prepare(
    'SELECT MIN(substr(updated_at,1,10)) mn, MAX(substr(updated_at,1,10)) mx FROM fielding_frv').get();
  console.log('');
  console.log('  POST-CONDITIONS');
  console.log('    rows still below the floor : ' + left + (left === 0 ? '  ok' : '  *** FAIL ***'));
  console.log('    updated_at spread          : ' + spread.mn + ' .. ' + spread.mx
    + (spread.mn === spread.mx
      ? '  ZERO -> the per-row freshness check goes green on its own'
      : '  nonzero -- per-row staleness will still report'));
  console.log('');
  console.log('  Re-run: node scripts/pipeline-freshness.js');
})();
