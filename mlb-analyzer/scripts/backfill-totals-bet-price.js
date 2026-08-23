#!/usr/bin/env node
/**
 * Migrate historical totals bet prices out of bet_line into bet_price.
 * (2026-08-23).  Dry run by default; --apply to write.
 *
 * WHY. bet_line held different quantities on different totals rows:
 *   - 37 of 38 logged totals bets contain a PRICE (-127..+125).
 *   - 1 contains a TOTAL (bet_line=9, 2026-04-15 was-pit, market_line=9).
 * services/model.js:1607 asserts bet_line is the LINE and grades using
 * game_log's market price instead, so the logged price was captured and
 * then ignored.
 *
 * Settled semantics: Total rows use bet_line = the total, bet_price = the
 * juice. This moves each price-shaped bet_line into bet_price and sets
 * bet_line to the total actually bet.
 *
 * WHICH TOTAL? market_line is the emit-time total and is post-lock
 * immutable, so it is the total the operator saw on the card when they
 * logged. That is the correct value, and it is exactly what the one-click
 * button already writes for totals today.
 *
 * CLASSIFICATION IS EXPLICIT, NOT HEURISTIC-BY-VIBE:
 *   price-shaped : |v| >= 100          (American odds; no real juice sits below 100)
 *   total-shaped : 4 <= v <= 20        (an MLB total)
 * Anything matching neither is left ALONE and enumerated, because a value
 * that is neither is a data problem this script should surface rather than
 * silently coerce.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: !APPLY });

const isPrice = v => v != null && Math.abs(Number(v)) >= 100;
const isTotal = v => v != null && Number(v) >= 4 && Number(v) <= 20;

(function main() {
  const rows = db.prepare(
    "SELECT id, game_date, game_id, signal_side, market_line, bet_line, bet_price "
    + "FROM bet_signals WHERE signal_type='Total' AND bet_line IS NOT NULL ORDER BY game_date"
  ).all();

  console.log('=== totals bet_price backfill ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  logged totals rows: ' + rows.length);

  const toMove = [], alreadyTotal = [], odd = [], done = [];
  for (const r of rows) {
    if (r.bet_price != null) { done.push(r); continue; }
    if (isPrice(r.bet_line)) toMove.push(r);
    else if (isTotal(r.bet_line)) alreadyTotal.push(r);
    else odd.push(r);
  }
  console.log('  price-shaped bet_line -> move to bet_price : ' + toMove.length);
  console.log('  already total-shaped, leave bet_line as is : ' + alreadyTotal.length);
  console.log('  neither shape (needs a human)              : ' + odd.length);
  console.log('  already migrated                           : ' + done.length);
  console.log('');

  if (alreadyTotal.length) {
    console.log('  total-shaped rows (bet_price stays NULL -- the price was never captured):');
    alreadyTotal.forEach(r => console.log('    ' + r.game_date + ' ' + r.game_id + ' ' + r.signal_side
      + '  bet_line=' + r.bet_line + '  market_line=' + r.market_line));
    console.log('');
  }
  if (odd.length) {
    console.log('  *** UNCLASSIFIED -- left untouched, inspect manually:');
    odd.forEach(r => console.log('    id=' + r.id + ' ' + r.game_date + ' ' + r.game_id
      + '  bet_line=' + r.bet_line + '  market_line=' + r.market_line));
    console.log('');
  }

  // Rows we cannot give a total to would lose information; refuse them.
  const noTotal = toMove.filter(r => !isTotal(r.market_line));
  if (noTotal.length) {
    console.log('  *** REFUSING ' + noTotal.length + ' row(s): price-shaped bet_line but market_line');
    console.log('      is not a usable total, so there is nothing to put in bet_line.');
    noTotal.forEach(r => console.log('    id=' + r.id + ' ' + r.game_date + ' ' + r.game_id
      + '  bet_line=' + r.bet_line + '  market_line=' + r.market_line));
    console.log('');
  }
  const safe = toMove.filter(r => isTotal(r.market_line));

  console.log('  migrating ' + safe.length + ' row(s):');
  safe.slice(0, 10).forEach(r => console.log('    ' + r.game_date + ' ' + String(r.game_id).padEnd(10)
    + r.signal_side.padEnd(6) + ' bet_line ' + String(r.bet_line).padStart(5)
    + ' -> bet_price ' + String(r.bet_line).padStart(5)
    + ' , bet_line := market_line ' + r.market_line));
  if (safe.length > 10) console.log('    ... and ' + (safe.length - 10) + ' more');

  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  const upd = db.prepare('UPDATE bet_signals SET bet_price=?, bet_line=? WHERE id=?');
  let n = 0;
  db.transaction(() => { for (const r of safe) n += upd.run(r.bet_line, r.market_line, r.id).changes; })();
  console.log('');
  console.log('  rows migrated: ' + n);

  const after = db.prepare(
    "SELECT COUNT(*) n, SUM(CASE WHEN bet_price IS NOT NULL THEN 1 ELSE 0 END) p "
    + "FROM bet_signals WHERE signal_type='Total' AND bet_line IS NOT NULL").get();
  console.log('  totals logged rows now: ' + after.n + ', with bet_price: ' + after.p);
  const ml = db.prepare(
    "SELECT COUNT(*) n FROM bet_signals WHERE signal_type='ML' AND bet_price IS NOT NULL").get().n;
  console.log('  ML rows touched (must be 0): ' + ml);
})();
