#!/usr/bin/env node
/**
 * Re-grade logged ML rows whose stored P&L was computed at the MARKET
 * price instead of the struck one. (2026-09-23)
 * Dry run by default; --apply to write.
 *
 * WHY THERE IS ONE OF THESE FOR ML AS WELL. The totals sibling
 * (regrade-stale-totals-pnl.js) landed on 2026-08-23 when bet_price
 * arrived. ML never got the same pass, because the score job already
 * honoured the struck value -- `parseFloat(sig.bet_line || sig.market_line)`
 * -- so ML looked clean. It is very nearly clean: 458 of 459 graded ML
 * rows carrying a bet_line already agree with struck-price grading.
 *
 * The exception is what this is for. Rows graded before the score job
 * started preferring bet_line kept a market-price P&L, and nothing has
 * ever gone back for them. Measured 2026-09-23: exactly one,
 * id=13381 (2026-04-25 nyy-hou home, market 122 / struck 133),
 * pnl -81.97 -> -75.19, +6.78.
 *
 * SAME REFUSAL AS THE TOTALS SCRIPT, for the same reason. An ML price
 * cannot change win/loss -- the side won or it did not -- so an outcome
 * that moves means something other than price differs, and this is the
 * wrong tool. It refuses and says so rather than writing.
 *
 * Run: node --max-old-space-size=1536 scripts/regrade-stale-ml-pnl.js
 */
const path = require('path');
const R = path.join(__dirname, '..');
// db/schema's connection, never a second one -- see the note in
// rederive-ml-closing-lines.js for what two writers on one file costs.
const { db, q } = require(path.join(R, 'db/schema'));
const { calcPnl } = require(path.join(R, 'services/model'));

const APPLY = process.argv.includes('--apply');

(function main() {
  const rows = db.prepare(
    "SELECT b.*, g.away_score, g.home_score, g.market_total "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='ML' AND b.bet_line IS NOT NULL "
    + "AND b.outcome IN ('win','loss') ORDER BY b.game_date").all();

  const stale = [], refused = [];
  for (const r of rows) {
    const res = calcPnl(
      { type: 'ML', side: r.signal_side, marketLine: r.market_line, bet_line: r.bet_line },
      r.away_score, r.home_score, r.market_total);
    const nw = Number(res.pnl), old = Number(r.pnl);
    if (!Number.isFinite(nw)) continue;
    if (Math.abs(nw - old) < 0.01) continue;
    if (res.outcome !== r.outcome) {
      refused.push({ r, was: r.outcome, would: res.outcome });
      continue;
    }
    stale.push({ r, old, nw });
  }

  console.log('=== re-grade stale ML P&L ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  logged ML graded rows: ' + rows.length + '   stale: ' + stale.length
    + '   refused: ' + refused.length);
  console.log('');
  for (const x of refused) {
    console.log('  *** REFUSING id=' + x.r.id + ': outcome would change '
      + x.was + ' -> ' + x.would + '. A price cannot move win/loss; this is not'
      + ' a pricing-only correction and this script is the wrong tool.');
  }
  if (refused.length) console.log('');

  console.log('  date        game       side   market  struck    old P&L    new P&L    delta');
  let d = 0;
  for (const s of stale) {
    const r = s.r;
    d += s.nw - s.old;
    console.log('  ' + r.game_date + '  ' + String(r.game_id).padEnd(10)
      + String(r.signal_side).padEnd(6) + String(r.market_line).padStart(7)
      + String(r.bet_line).padStart(8)
      + String(s.old.toFixed(2)).padStart(11) + String(s.nw.toFixed(2)).padStart(11)
      + String((s.nw - s.old).toFixed(2)).padStart(9));
  }
  console.log('');
  console.log('  net delta: ' + d.toFixed(2));

  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  const upd = db.prepare('UPDATE bet_signals SET pnl=? WHERE id=?');
  let n = 0;
  db.transaction(() => {
    for (const s of stale) {
      upd.run(s.nw, s.r.id);
      n++;
      try {
        q.insertBetSignalAudit({
          signal_id: s.r.id, game_date: s.r.game_date, game_id: s.r.game_id,
          signal_type: 'ML', signal_side: s.r.signal_side,
          action: 'regraded_at_struck_price',
          bet_line: s.r.bet_line, closing_line: s.r.closing_line, clv: s.r.clv,
          source: 'regrade-stale-ml-pnl',
          detail: 'pnl ' + s.old.toFixed(2) + ' -> ' + s.nw.toFixed(2)
            + ' (struck price ' + s.r.bet_line + ' replaces market price '
            + s.r.market_line + '). Outcome unchanged.',
        });
      } catch (e) { /* audit must not abort the correction */ }
    }
  })();
  console.log('');
  console.log('  rows re-graded: ' + n);

  // Verify, scoped to what this script can act on: a row it REFUSED is
  // not a failure of the re-grade, and counting it as one would leave the
  // check reporting a permanent non-zero on a row it deliberately
  // declined. Refusals are reported on their own line.
  const refusedIds = new Set(refused.map(x => x.r.id));
  let left = 0;
  for (const r of db.prepare(
    "SELECT b.*, g.away_score, g.home_score, g.market_total "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='ML' AND b.bet_line IS NOT NULL AND b.outcome IN ('win','loss')").all()) {
    if (refusedIds.has(r.id)) continue;
    const nw = Number(calcPnl(
      { type: 'ML', side: r.signal_side, marketLine: r.market_line, bet_line: r.bet_line },
      r.away_score, r.home_score, r.market_total).pnl);
    if (Number.isFinite(nw) && Math.abs(nw - Number(r.pnl)) >= 0.01) left++;
  }
  console.log('  rows still disagreeing with calcPnl (must be 0): ' + left);
  console.log('  rows refused and left alone (reported, not a failure): ' + refused.length);
})();
