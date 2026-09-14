#!/usr/bin/env node
/**
 * Tag games whose market price moved AFTER real first pitch. (2026-08-22)
 *
 * THE WRITER MOVED TO PRODUCTION. (2026-09-14) This script is now a LOCAL
 * REPORTER and no longer writes by default. The tag is written by the
 * registered backfill task
 * services/backfill-tasks/market-contamination-post-first-pitch.js, so
 * production and the analysis copy agree on a column they disagreed about
 * for months: 273 games tagged locally, 0 on prod, with byte-identical
 * capture data on both. Prod's 0 was an unrun job, not a different finding.
 *
 * --apply still works and is still idempotent, for the case where a local
 * copy predates the prod backfill. It is no longer part of
 * scripts/refresh-analysis-db.sh step 5: once prod carries the tag, the
 * refresh brings it down with the rest of the data and re-deriving it
 * locally would be a second source of truth for one column.
 *
 * THE CRITERION LIVES IN utils/post-start-pricing.js, shared with
 * post-start-price-change.js. It used to be a verbatim copy of that
 * script's narrowing block -- the header said it was "derived from
 * post-start-price-change.js so the tagging criterion and the measured
 * criterion cannot drift apart", which is the right intent expressed as a
 * copy. Timezones are documented in the module, once.
 *
 * Writes game_log.market_contamination_reason. Does NOT modify
 * market_*_ml, bet_signals, or anything on the live path -- the stored line
 * still records what the model actually saw, and logged bets keep the price
 * they were logged at. No bet_signals field is touched, so the post-lock
 * immutability rule does not bind here.
 *
 * TWO REASONS, see the module: priced_post_first_pitch (measured movement)
 * and no_prestart_capture (could not be measured). The second is currently
 * inert on both copies -- every exposed signal had a usable capture -- and
 * exists so an unmeasurable game stops reading as clean if captures lapse.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const psp = require(path.join(R, 'utils/post-start-pricing'));
const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: !APPLY });

(function main() {
  const cov = psp.captureCoverage(db);
  console.log('=== capture coverage (measured) ===');
  console.log('  ' + cov.rows + ' priced ml rows, ' + cov.games + ' games, '
    + cov.from + ' .. ' + cov.to);
  console.log('');

  const exposed = psp.exposedMlSignals(db);
  const cls = psp.classifyExposed(db, exposed);
  console.log('=== narrowing the exposure to genuine price movement ===');
  console.log('  exposed ML signals (upper bound): ' + exposed.size);
  console.log('  unmeasurable (no usable capture): ' + cls.unmeasurable.length);
  console.log('  price IDENTICAL (no-op refresh) : ' + cls.noChange.length);
  console.log('  price CHANGED after first pitch : ' + cls.changed.length);
  console.log('');

  const g = psp.gamesToTag(db, cls, cov);
  console.log('=== games by reason ===');
  console.log('  ' + psp.REASON_PRICED_POST_FIRST_PITCH + ': ' + g.contaminated.size
    + '   ' + JSON.stringify(psp.monthCounts([...g.contaminated])));
  console.log('  ' + psp.REASON_NO_PRESTART_CAPTURE + '    : ' + g.noCapture.size
    + '   ' + JSON.stringify(psp.monthCounts([...g.noCapture])));
  console.log('  left NULL (outside the coverage window): ' + g.outsideCoverage.size);

  const already = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE market_contamination_reason IS NOT NULL').get().n;
  console.log('  already tagged before this run  : ' + already);

  if (!APPLY) {
    console.log('');
    console.log('  REPORT ONLY. The production backfill task owns the write:');
    console.log('    POST /api/admin/backfill/market_contamination_post_first_pitch');
    console.log('  Pass --apply to write to the LOCAL copy anyway (idempotent).');
    return;
  }

  const upd = db.prepare(
    'UPDATE game_log SET market_contamination_reason = ? '
    + 'WHERE game_date = ? AND game_id = ? AND market_contamination_reason IS NULL');
  let n = 0;
  const tx = db.transaction(() => {
    for (const pair of [[g.contaminated, psp.REASON_PRICED_POST_FIRST_PITCH],
                        [g.noCapture, psp.REASON_NO_PRESTART_CAPTURE]]) {
      for (const k of pair[0]) {
        const p = k.split('|');
        n += upd.run(pair[1], p[0], p[1]).changes;
      }
    }
  });
  tx();
  console.log('');
  console.log('  rows tagged this run: ' + n);
  const after = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE market_contamination_reason IS NOT NULL').get().n;
  const tot = db.prepare('SELECT COUNT(*) n FROM game_log').get().n;
  console.log('  game_log rows now tagged: ' + after + ' of ' + tot);
  console.log('  UNDO: UPDATE game_log SET market_contamination_reason = NULL WHERE '
    + "market_contamination_reason IN ('" + psp.REASON_PRICED_POST_FIRST_PITCH
    + "','" + psp.REASON_NO_PRESTART_CAPTURE + "');");
})();
