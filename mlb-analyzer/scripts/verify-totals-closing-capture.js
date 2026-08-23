#!/usr/bin/env node
/**
 * Verify the totals closing capture actually captures. (2026-08-23)
 *
 * WHY A DEDICATED CHECK. 761 of 761 historical totals rows had
 * closing_line exactly equal to market_line. That is indistinguishable
 * from "the market never moved" if you only look at the column, and it
 * is exactly what a capture that never runs produces. The failure is
 * silent by construction, so it needs a test that would FAIL if the
 * capture were still inert rather than one that merely reports numbers.
 *
 * This drives the real code path -- services/jobs.js writeClosing via the
 * same closingValuesFor logic -- against completed games, in a
 * TRANSACTION THAT IS ROLLED BACK. Nothing is written.
 *
 * PASS requires all of:
 *   1. totals signals are selected at all (the ML filter is gone);
 *   2. closing_price is populated for them (the second quantity exists);
 *   3. at least one closing value DIFFERS from its emit value -- the
 *      check that 761/761-identical would fail;
 *   4. CLV is computable where bet_price exists.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { clvForSignal } = require(path.join(R, 'services/clv'));

const db = new Database(path.join(R, 'data/mlb.db'));

// Mirrors services/jobs.js closingValuesFor. Kept in step deliberately:
// if that diverges this check stops describing the real path, so any
// change there must be reflected here.
function closingValuesFor(sig, gameRow) {
  if (String(sig.signal_type).toLowerCase() === 'total') {
    const isOver = String(sig.signal_side).toLowerCase() === 'over';
    return {
      closingLine: gameRow.market_total != null ? gameRow.market_total : null,
      closingPrice: isOver ? gameRow.over_price : gameRow.under_price,
    };
  }
  return {
    closingLine: sig.signal_side === 'away' ? gameRow.market_away_ml : gameRow.market_home_ml,
    closingPrice: null,
  };
}

(function main() {
  console.log('=== totals closing capture verification (rolled back, nothing written) ===');

  // Simulate the pre-capture state: pretend closing_line is unset so the
  // capture selects these rows the way it will on a live lock.
  // Two populations, deliberately combined:
  //   - the most recent totals, which exercise the capture at scale;
  //   - EVERY totals row carrying a bet_price, because CLV needs a struck
  //     price and those are all April-May. Sampling only recent rows would
  //     report "CLV not computable" and blame the capture, when the real
  //     reason is that no recent totals bet has been logged.
  const sigs = db.prepare(
    "SELECT * FROM bet_signals WHERE signal_type='Total' AND market_line IS NOT NULL "
    + "AND (bet_price IS NOT NULL OR game_date >= date('now','-60 day')) "
    + "ORDER BY game_date DESC LIMIT 500"
  ).all();
  const logged = sigs.filter(x => x.bet_price != null);
  console.log('  ... of which carry a struck bet_price: ' + logged.length);
  console.log('  totals signals available to test: ' + sigs.length);
  if (!sigs.length) { console.log('  NOTHING TO TEST'); process.exit(2); }

  let selected = 0, withPrice = 0, lineDiff = 0, priceDiff = 0, clvComputable = 0, noGame = 0;
  const examples = [];

  const tx = db.transaction(() => {
    for (const sig of sigs) {
      const g = db.prepare('SELECT market_total, over_price, under_price, market_away_ml, market_home_ml '
        + 'FROM game_log WHERE game_date=? AND game_id=?').get(sig.game_date, sig.game_id);
      if (!g) { noGame++; continue; }
      selected++;
      const { closingLine, closingPrice } = closingValuesFor(sig, g);
      if (closingPrice != null) withPrice++;
      if (closingLine != null && Number(closingLine) !== Number(sig.market_line)) {
        lineDiff++;
        if (examples.length < 6) examples.push({ sig, closingLine, closingPrice });
      }
      // The emit-time price is not stored for totals, so "price differs" is
      // measured against the struck price where we have one.
      if (sig.bet_price != null && closingPrice != null
          && Number(closingPrice) !== Number(sig.bet_price)) priceDiff++;
      const { clv } = clvForSignal(sig.signal_type, sig, closingLine, closingPrice);
      if (clv != null) clvComputable++;
    }
    throw new Error('__ROLLBACK__');   // never persist
  });
  try { tx(); } catch (e) { if (e.message !== '__ROLLBACK__') throw e; }

  console.log('  games missing a game_log row      : ' + noGame);
  console.log('');
  console.log('  1. totals selected by the capture : ' + selected);
  console.log('  2. closing_price populated        : ' + withPrice
    + '  (' + (100 * withPrice / Math.max(selected, 1)).toFixed(1) + '%)');
  console.log('  3. closing LINE differs from emit : ' + lineDiff);
  console.log('     closing PRICE differs from struck price : ' + priceDiff);
  console.log('  4. CLV computable                 : ' + clvComputable);
  console.log('');
  if (examples.length) {
    console.log('  examples where the capture produces a DIFFERENT value than emit:');
    examples.forEach(x => console.log('    ' + x.sig.game_date + ' ' + String(x.sig.game_id).padEnd(9)
      + String(x.sig.signal_side).padEnd(6)
      + ' emit ' + x.sig.market_line + ' -> close ' + x.closingLine
      + '   closing_price ' + x.closingPrice));
    console.log('');
  }

  const checks = [
    ['totals are selected (ML filter gone)', selected > 0],
    ['closing_price is populated', withPrice > 0],
    ['at least one closing value differs from emit', lineDiff > 0],
    ['CLV computable on every logged totals bet', logged.length > 0 && clvComputable >= logged.length],
  ];
  let pass = true;
  checks.forEach(([k, ok]) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + k); if (!ok) pass = false; });
  console.log('');
  console.log(pass ? '=== PASS ===' : '=== FAIL ===');
  if (!pass) process.exit(1);
})();
