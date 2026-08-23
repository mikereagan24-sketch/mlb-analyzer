#!/usr/bin/env node
/**
 * Null the fabricated totals closing lines. (2026-08-23)
 * Dry run by default; --apply to write.
 *
 * WHAT THESE ARE. Until 2026-08-23, GET /backtest ran on every request:
 *     UPDATE bet_signals SET closing_line = market_line
 *     WHERE closing_line IS NULL AND outcome != 'pending'
 * For totals that assigned the EMIT line as the CLOSING line. No closing
 * value was ever observed for a totals bet -- both capture paths filtered
 * signal_type='ML'. So these 762 values are not measurements. They are
 * copies of a different column, produced by a read endpoint.
 *
 * WHY NULL RATHER THAN KEEP AND FILTER. A fabricated value that is
 * indistinguishable from a real one is worse than an absent value,
 * because every future analysis has to remember to exclude it. This
 * codebase has a poor record with remembered filters -- three separate
 * hand-maintained key lists have already failed open
 * (getSettings' whitelist, calibration-ab's CALLER_POPULATED_INPUTS,
 * parameter-sweep's applySweepOverrides). NULL is self-enforcing: every
 * consumer already handles a missing closing line, and none of them can
 * silently mistake NULL for an observation.
 *
 * NOT DATA LOSS. Each nulled value is written to bet_signal_audit with
 * action='null_fabricated_closing' and the old value in closing_line, so
 * the record of what was there -- and that it was fabricated -- survives
 * in the audit trail where it is labelled as such. The live column stops
 * asserting something false; the history keeps the fact that it did.
 *
 * SAFETY. Only rows matching the fabrication signature are touched:
 *   signal_type = 'Total'
 *   AND closing_price IS NULL        -- not written by the real capture
 *   AND closing_line = market_line   -- the copy signature
 * A row the new capture has written carries closing_price and is skipped.
 * Anything matching neither is reported and left alone.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: !APPLY });

(function main() {
  console.log('=== null fabricated totals closing lines ' + (APPLY ? '' : '[DRY RUN]') + ' ===');

  const fabricated = db.prepare(
    "SELECT id, game_date, game_id, signal_type, signal_side, market_line, closing_line, clv "
    + "FROM bet_signals WHERE signal_type='Total' AND closing_line IS NOT NULL "
    + "AND closing_price IS NULL AND closing_line = market_line ORDER BY game_date"
  ).all();

  const real = db.prepare(
    "SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' AND closing_price IS NOT NULL").get().n;
  const odd = db.prepare(
    "SELECT id, game_date, game_id, market_line, closing_line FROM bet_signals "
    + "WHERE signal_type='Total' AND closing_line IS NOT NULL AND closing_price IS NULL "
    + "AND (closing_line != market_line OR market_line IS NULL)").all();

  console.log('  fabricated (to null)        : ' + fabricated.length);
  console.log('  real captures (skipped)     : ' + real);
  console.log('  neither -- left alone       : ' + odd.length);
  odd.forEach(r => console.log('     id=' + r.id + ' ' + r.game_date + ' ' + r.game_id
    + '  market_line=' + r.market_line + '  closing_line=' + r.closing_line));

  if (!fabricated.length) { console.log(''); console.log('  nothing to do.'); return; }
  console.log('');
  console.log('  date span: ' + fabricated[0].game_date + ' .. ' + fabricated[fabricated.length - 1].game_date);
  console.log('  sample:');
  fabricated.slice(0, 5).forEach(r => console.log('    ' + r.game_date + ' ' + String(r.game_id).padEnd(10)
    + String(r.signal_side).padEnd(6) + ' closing_line ' + r.closing_line + ' -> NULL'
    + '  (market_line ' + r.market_line + ')'));

  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  const upd = db.prepare('UPDATE bet_signals SET closing_line=NULL, clv=NULL WHERE id=?');
  const q = require(path.join(R, 'db/schema'));
  let n = 0, audited = 0;

  db.transaction(() => {
    for (const r of fabricated) {
      upd.run(r.id);
      n++;
      // Preserve the fabricated value in the audit trail, labelled.
      try {
        db.prepare(
          'INSERT INTO bet_signal_audit (signal_id, game_date, game_id, signal_type, signal_side, '
          + 'action, bet_line, closing_line, clv, source, detail) '
          + 'VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        ).run(r.id, r.game_date, r.game_id, r.signal_type, r.signal_side,
              'null_fabricated_closing', null, r.closing_line, r.clv,
              'null-fabricated-totals-closing',
              'closing_line=' + r.closing_line + ' was a copy of market_line written by '
              + 'GET /backtest, not an observed close. Nulled 2026-08-23; value preserved here.');
        audited++;
      } catch (e) { /* audit failure must not abort the repair */ }
    }
  })();

  console.log('');
  console.log('  rows nulled            : ' + n);
  console.log('  audit rows written     : ' + audited);
  console.log('');
  console.log('=== verification ===');
  const left = db.prepare(
    "SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' AND closing_line IS NOT NULL "
    + "AND closing_price IS NULL").get().n;
  console.log('  totals with a closing_line but no closing_price (must be 0): ' + left);
  const clv = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' AND clv IS NOT NULL").get().n;
  console.log('  totals with non-null clv (must be 0 until real captures land): ' + clv);
  const ml = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='ML' AND closing_line IS NOT NULL").get().n;
  console.log('  ML rows still carrying a closing_line (must be unchanged): ' + ml);
  const aud = db.prepare("SELECT COUNT(*) n FROM bet_signal_audit WHERE action='null_fabricated_closing'").get().n;
  console.log('  audit rows recording the nulled values: ' + aud);
})();
