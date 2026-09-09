#!/usr/bin/env node
/**
 * The Poly rung anchor must survive a pass where Kalshi returns nothing.
 * (2026-09-08)
 *
 * WHAT HAPPENED. On the 2026-09-08 3PM PT pass, getKalshiMlbTotals returned
 * zero rows. kalshiLineByGid is populated inside the `else` branch of
 * `if (!kalshiTotals.length)`, so it stayed empty, every row logged
 * kalshi_line=- and fell to liquidity_fallback, and 2 of 15 disagreed with
 * the old unabated anchor (cle-bal and tex-sea, 7.5 vs 8.5).
 *
 * WHY IT MATTERS. unabated_total was never NULL across 30 days. An anchor
 * that only exists when the same pass's Kalshi fetch succeeds is not a
 * replacement for it, and PR 3 would have shipped a regression on any pass
 * where Kalshi came back empty.
 *
 * THE FIX. Fall back to the persisted Kalshi line for the same game -- an
 * earlier pass's market_total where total_source says Kalshi wrote it --
 * before dropping to liquidity. And when a row is priced with no anchor at
 * all, say so loudly instead of leaving it to a per-row field nobody greps.
 *
 * Run: node scripts/test-poly-anchor-fallback.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== poly anchor: fallback when Kalshi returns nothing ===');
const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- wiring ---------------------------------------------------------
ok('same-pass map is still tried first',
   src.indexOf('let kalshiLine = kalshiLineByGid.has(p.game_id)') !== -1);
ok('falls back to the PERSISTED Kalshi line',
   src.indexOf("existing.total_source === 'kalshi' && existing.market_total != null") !== -1);
ok('the fallback only accepts a Kalshi-sourced total',
   src.indexOf("existing.total_source === 'kalshi'") !== -1
   && src.indexOf("existing.total_source === 'polymarket'") === -1);
ok('the anchor source is recorded and logged',
   src.indexOf('kalshiLineSrc') !== -1
   && src.indexOf("'(' + (kalshiLineSrc || 'none') + ')'") !== -1);
ok('every A/B row says whether Poly actually prices it',
   src.indexOf("'  priced=' + (willPrice ? 'yes' : 'no')") !== -1);
ok('pricing with no anchor warns loudly',
   src.indexOf('NO KALSHI ANCHOR for') !== -1 && src.indexOf('noAnchorPriced++') !== -1);
ok('the run summary carries the no-anchor count',
   src.indexOf('PRICED WITH NO KALSHI ANCHOR') !== -1);

// ---- the cascade ----------------------------------------------------
const pickFrom = (ladder, line, exactTier, nearTier) => {
  if (line == null) return { rung: null, tier: null };
  const exact = ladder.find(r => Math.abs(r.strike - line) < 0.001);
  if (exact) return { rung: exact, tier: exactTier };
  let best = null, bestDist = Infinity;
  for (const r of ladder) {
    const d = Math.abs(r.strike - line);
    if (d < bestDist) { best = r; bestDist = d; }
  }
  if (best && bestDist <= 0.5) return { rung: best, tier: nearTier };
  return { rung: null, tier: null };
};
const liquidity = l => l.reduce((b, r) =>
  (r.market_liquidity_clob || 0) > (b ? (b.market_liquidity_clob || 0) : -1) ? r : b, null);
const anchorOf = (passMap, gid, existing) => {
  if (passMap.has(gid)) return { line: passMap.get(gid), src: 'pass' };
  if (existing && existing.total_source === 'kalshi' && existing.market_total != null) {
    return { line: existing.market_total, src: 'persisted' };
  }
  return { line: null, src: null };
};
const cascade = (ladder, passMap, gid, existing) => {
  const a = anchorOf(passMap, gid, existing);
  const nw = pickFrom(ladder, a.line, 'kalshi_exact', 'kalshi_nearest');
  if (nw.rung) return { ...nw, src: a.src };
  return { rung: liquidity(ladder), tier: 'liquidity_fallback', src: a.src };
};

// The 2026-09-08 shape: ladder brackets both 7.5 and 8.5, Kalshi silent
// this pass, unabated said 8.5.
const L = [
  { strike: 7.5, market_liquidity_clob: 900 },
  { strike: 8.5, market_liquidity_clob: 10 },
];
const empty = new Map();

const noAnchor = cascade(L, empty, 'cle-bal', null);
ok('with NO anchor at all, liquidity wins (the 09-08 behaviour)',
   noAnchor.tier === 'liquidity_fallback' && noAnchor.rung.strike === 7.5,
   'picks 7.5, while unabated_exact said 8.5 — the observed disagreement');

const persisted = cascade(L, empty, 'cle-bal', { total_source: 'kalshi', market_total: 8.5 });
ok('with a PERSISTED Kalshi line, the anchor wins over liquidity',
   persisted.tier === 'kalshi_exact' && persisted.rung.strike === 8.5
   && persisted.src === 'persisted',
   'picks 8.5 — matches unabated_exact, agree=yes');

const pass = cascade(L, new Map([['cle-bal', 8.5]]), 'cle-bal',
  { total_source: 'kalshi', market_total: 7.5 });
ok('the same-pass line takes precedence over the persisted one',
   pass.rung.strike === 8.5 && pass.src === 'pass',
   'fresher line wins when both exist');

ok('a persisted POLY total is NOT used as a Kalshi anchor',
   cascade(L, empty, 'x', { total_source: 'polymarket', market_total: 8.5 })
     .tier === 'liquidity_fallback',
   'otherwise Poly would anchor on itself');

ok('nearest-within-0.5 still applies to the persisted line',
   cascade([{ strike: 9.0, market_liquidity_clob: 1 }], empty, 'x',
     { total_source: 'kalshi', market_total: 8.6 }).tier === 'kalshi_nearest');

// ---- would the fallback have had data? ------------------------------
// The honest question: on games Poly actually priced, was a Kalshi line
// persisted for the same game from an earlier pass?
const { db } = require(path.join(R, 'db/schema'));
const rows = db.prepare(
  "SELECT game_date, game_id, total_source, market_total FROM game_log "
  + "WHERE game_date >= date('now','-30 days') AND market_total IS NOT NULL").all();
const poly = rows.filter(r => r.total_source === 'polymarket');
console.log('  last 30 days: ' + rows.length + ' priced totals, '
  + poly.length + ' by Poly');
console.log('  NOTE the persisted fallback needs an EARLIER pass on the same');
console.log('  date to have written a Kalshi total for that game. This copy');
console.log('  stores only the final state per game, so it can show whether');
console.log('  Kalshi ever priced the slate, not whether it had by 3PM.');
const kalshiDates = new Set(rows.filter(r => r.total_source === 'kalshi').map(r => r.game_date));
const polyOnDatesKalshiAlsoPriced = poly.filter(r => kalshiDates.has(r.game_date));
ok('most Poly-priced rows sit on dates where Kalshi priced other games',
   poly.length === 0 || polyOnDatesKalshiAlsoPriced.length / poly.length >= 0.5,
   polyOnDatesKalshiAlsoPriced.length + ' of ' + poly.length
     + ' — Kalshi was reachable on those dates, so a persisted line is plausible');

// ---- full-slate accounting (2026-09-09) -----------------------------
// The A/B line lives inside the polyRows loop, so a game Poly never quoted
// produced no line at all -- 10 lines against 13 games on the 2026-09-08
// slate, and the 3 silent ones were read as the rows where the anchor
// decides a price. Every oddsRaw game must now appear exactly once.
ok('games Poly did not quote emit a [poly-anchor-none] line',
   src.indexOf("'[poly-anchor-none] '") !== -1);
ok('that line states whether the game was priced anyway',
   src.indexOf("priced=' + (o.market_total != null ? 'yes' : 'no')") !== -1);
ok('it distinguishes locked / kalshi-priced / no-total-at-all',
   src.indexOf("'locked'") !== -1 && src.indexOf('NO TOTAL FROM ANY SOURCE') !== -1);
ok('a game with no total from any source warns',
   src.indexOf('have NO total from Kalshi or Poly') !== -1);
ok('the summary reconciles slate size against A/B line count',
   src.indexOf("' [slate: ' + oddsRaw.length") !== -1);
ok('the no-quote scan skips games Poly DID quote (no double-count)',
   src.indexOf('if (quoted.has(o.game_id)) continue;') !== -1);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
