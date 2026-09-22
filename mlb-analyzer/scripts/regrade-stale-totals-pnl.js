#!/usr/bin/env node
/**
 * Re-grade the logged totals rows whose stored P&L predates bet_price.
 * (2026-08-23).  Dry run by default; --apply to write.
 *
 * WHY, AND WHY NOW. Historical P&L was deliberately NOT re-graded when
 * bet_price landed -- re-grading settled records is a real cost. But
 * fixing wageredFor() in the same window changed the DENOMINATOR of every
 * totals ROI while leaving the NUMERATOR at its market-price value. The
 * page then divided a market-price P&L by a struck-price stake.
 *
 * Each half is defensible. The combination is not. So the choice is not
 * "re-grade or don't" any more -- it is "make both halves market-price"
 * or "make both halves struck-price", and struck price is the one that
 * describes the bets that were actually placed.
 *
 * SCOPE. Only rows where stored pnl disagrees with calcPnl under the
 * current precedence (bet_price -> market price -> -110). Outcome is NOT
 * touched: win/loss depends on the total, which did not change. Only the
 * stake risked on a loss moves, which is why every affected row is a loss
 * -- a win pays +100 at any price.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const { calcPnl } = require(path.join(R, 'services/model'));

const APPLY = process.argv.includes('--apply');

(function main() {
  const rows = db.prepare(
    "SELECT b.*, g.over_price, g.under_price, g.away_score, g.home_score "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='Total' AND b.bet_line IS NOT NULL "
    + "AND b.outcome IN ('win','loss') ORDER BY b.game_date").all();

  const stale = [], refused = [];
  for (const r of rows) {
    const sig = { type: 'Total', side: r.signal_side, marketLine: r.bet_line,
      bet_line: r.bet_line, bet_price: r.bet_price,
      overPrice: r.over_price, underPrice: r.under_price };
    const res = calcPnl(sig, r.away_score, r.home_score, r.bet_line);
    const nw = Number(res.pnl), old = Number(r.pnl);
    if (!Number.isFinite(nw)) continue;
    if (Math.abs(nw - old) < 0.01) continue;
    // Outcome must not move -- if it does, something other than price changed
    // and this script is the wrong tool.
    if (res.outcome !== r.outcome) {
      console.log('  *** REFUSING id=' + r.id + ': outcome would change '
        + r.outcome + ' -> ' + res.outcome + '. Not a pricing-only correction.');
      refused.push({ r, was: r.outcome, would: res.outcome });
      continue;
    }
    stale.push({ r, old, nw });
  }

  console.log('=== re-grade stale totals P&L ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  logged totals graded rows: ' + rows.length + '   stale: ' + stale.length);
  console.log('');
  console.log('  date        game       side   total  struck  market   old P&L    new P&L    delta');
  let d = 0;
  for (const s of stale) {
    const r = s.r;
    const mkt = r.signal_side === 'over' ? r.over_price : r.under_price;
    d += s.nw - s.old;
    console.log('  ' + r.game_date + '  ' + String(r.game_id).padEnd(10) + String(r.signal_side).padEnd(6)
      + String(r.bet_line).padStart(5) + String(r.bet_price == null ? '--' : r.bet_price).padStart(8)
      + String(mkt == null ? '--' : mkt).padStart(8)
      + String(s.old.toFixed(2)).padStart(10) + String(s.nw.toFixed(2)).padStart(11)
      + String((s.nw - s.old).toFixed(2)).padStart(9));
  }
  console.log('');
  console.log('  net delta: ' + d.toFixed(2));
  console.log('  every affected row is a LOSS -- a win pays +100 at any price, so only');
  console.log('  the stake risked on a loss can move.');

  if (refused.length) {
    console.log('');
    console.log('  REFUSED (outcome would move, so not a pricing correction): '
      + refused.map(x => 'id=' + x.r.id + ' ' + x.was + '->' + x.would).join(', '));
  }

  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  const upd = db.prepare('UPDATE bet_signals SET pnl=? WHERE id=?');
  let n = 0;
  db.transaction(() => {
    for (const s of stale) {
      upd.run(s.nw, s.r.id);
      n++;
      try {
        const { q } = require(path.join(R, 'db/schema'));
        q.insertBetSignalAudit({
          signal_id: s.r.id, game_date: s.r.game_date, game_id: s.r.game_id,
          signal_type: s.r.signal_type, signal_side: s.r.signal_side,
          action: 'regraded_at_struck_price',
          bet_line: s.r.bet_line, closing_line: s.r.closing_line, clv: s.r.clv,
          source: 'regrade-stale-totals-pnl',
          detail: 'pnl ' + s.old.toFixed(2) + ' -> ' + s.nw.toFixed(2)
            + ' (struck price ' + s.r.bet_price + ' replaces market price). '
            + 'Outcome unchanged; only the stake risked on a loss moved.',
        });
      } catch (e) { /* audit must not abort the correction */ }
    }
  })();
  console.log('');
  console.log('  rows re-graded: ' + n);

  // VERIFY WHAT THIS SCRIPT CAN ACT ON, NOT WHAT IT DECLINED. (2026-09-23)
  //
  // This loop re-scanned every graded totals row, including the ones the
  // refusal above deliberately skipped. So a correct refusal made the
  // script report `must be 0: 1` -- permanently, on a row it had just
  // decided on purpose not to touch. The check was counting its own
  // refusal against itself.
  //
  // That is the §"Scope a check to what it can act on" failure: a check
  // that can never pass on part of its input trains the reader to skip
  // the line, and the skipping generalises to the runs where something
  // is genuinely wrong. It surfaced the moment the first such row existed
  // -- id=178727, TOR@TEX 2026-09-19, logged under 7.5 against a market
  // that was 8.5 all day -- which arrived with the 2026-09-22 refresh.
  //
  // Refusals are EXCLUDED from the failure count and REPORTED on their
  // own line with their ids, never dropped silently. A refusal is a
  // finding the operator has to resolve against the book; it is not a
  // failure of the re-grade.
  const refusedIds = new Set(refused.map(x => x.r.id));
  let left = 0;
  for (const r of db.prepare(
    "SELECT b.*, g.over_price, g.under_price, g.away_score, g.home_score "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='Total' AND b.bet_line IS NOT NULL AND b.outcome IN ('win','loss')").all()) {
    if (refusedIds.has(r.id)) continue;
    const sig = { type: 'Total', side: r.signal_side, marketLine: r.bet_line, bet_line: r.bet_line,
      bet_price: r.bet_price, overPrice: r.over_price, underPrice: r.under_price };
    const nw = Number(calcPnl(sig, r.away_score, r.home_score, r.bet_line).pnl);
    if (Number.isFinite(nw) && Math.abs(nw - Number(r.pnl)) >= 0.01) left++;
  }
  console.log('  rows still disagreeing with calcPnl (must be 0): ' + left);
  console.log('  rows REFUSED and left alone (a finding, not a failure): ' + refused.length
    + (refused.length ? ' -- ' + refused.map(x => 'id=' + x.r.id + ' ' + x.was + '->' + x.would).join(', ') : ''));
  if (refused.length) {
    console.log('    A refusal means the stored outcome and the stored bet_line');
    console.log('    disagree. Settle it against what the book actually shows;');
    console.log('    this script only ever moves the stake, never the result.');
  }
})();
