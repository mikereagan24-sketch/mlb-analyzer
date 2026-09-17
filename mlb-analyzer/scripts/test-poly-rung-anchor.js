#!/usr/bin/env node
/**
 * Poly totals rung anchor: Kalshi's line, liquidity fallback. (2026-09-06)
 *
 * The anchor moved off unabated_total (#365). The Unabated fetch was then
 * removed (2026-09-17), and the OLD-vs-NEW comparison arm went with it, so
 * these assertions now check it is GONE rather than observation-only.
 *
 * The cascade is inline in runOddsJob and not separately exported, so the
 * SHAPE is asserted against the source and the BEHAVIOUR is asserted
 * against a re-declared copy of the same cascade. That is weaker than
 * calling the real function and it is called out rather than hidden: the
 * source assertions exist so the copy cannot drift silently.
 *
 * Run: node scripts/test-poly-rung-anchor.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== poly totals rung anchor ===');
const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- shape: the new anchor is wired and the old one is observation ----
ok('kalshiLineByGid is declared OUTSIDE the KALSHI_DIRECT_TOTALS block',
   src.indexOf('const kalshiLineByGid = new Map();') <
   src.indexOf('if (settings.KALSHI_DIRECT_TOTALS_ENABLED)'));
ok('the map is populated from k.line before any skip/override decision',
   src.indexOf('if (k.line != null) kalshiLineByGid.set(gameId, k.line);') !== -1);
ok('the PRICED pick comes from the Kalshi anchor',
   src.indexOf("const nw = pickFrom(kalshiLine, 'kalshi_exact', 'kalshi_nearest');") !== -1
   && src.indexOf('let picked = nw.rung, anchorTier = nw.tier;') !== -1);
{
  // Code lines only: the comments record where the anchor came from.
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  ok('the unabated anchor is GONE (no writer since the fetch was removed)',
     code.indexOf('unabated_total') === -1 && code.indexOf("'unabated_exact'") === -1);
}
ok('the OLD-vs-NEW line is gone and a per-row anchor line replaces it',
   src.indexOf("'[poly-anchor-ab] '") === -1 && src.indexOf("'[poly-anchor-row] '") !== -1);
ok('the run summary no longer carries an A/B tally',
   src.indexOf('anchor A/B vs unabated') === -1);
ok('anchor tiers are kalshi_*',
   src.indexOf('kalshi_exact: 0, kalshi_nearest: 0, liquidity_fallback: 0') !== -1);

// ---- behaviour: the cascade itself -----------------------------------
const pickFrom = (ladder, anchorLine, exactTier, nearTier) => {
  if (anchorLine == null) return { rung: null, tier: null };
  const exact = ladder.find(r => Math.abs(r.strike - anchorLine) < 0.001);
  if (exact) return { rung: exact, tier: exactTier };
  let best = null, bestDist = Infinity;
  for (const r of ladder) {
    const d = Math.abs(r.strike - anchorLine);
    if (d < bestDist) { best = r; bestDist = d; }
  }
  if (best && bestDist <= 0.5) return { rung: best, tier: nearTier };
  return { rung: null, tier: null };
};
const liquidity = (ladder) => {
  let best = null, bestLiq = -1;
  for (const r of ladder) {
    const liq = r.market_liquidity_clob != null ? r.market_liquidity_clob : 0;
    if (liq > bestLiq) { best = r; bestLiq = liq; }
  }
  return best;
};
const cascade = (ladder, kalshiLine) => {
  const nw = pickFrom(ladder, kalshiLine, 'kalshi_exact', 'kalshi_nearest');
  if (nw.rung) return nw;
  return { rung: liquidity(ladder), tier: 'liquidity_fallback' };
};

const L = [
  { strike: 7.5, market_liquidity_clob: 10 },
  { strike: 8.5, market_liquidity_clob: 900 },
  { strike: 9.0, market_liquidity_clob: 50 },
];
ok('exact Kalshi line wins', (() => { const r = cascade(L, 8.5);
  return r.tier === 'kalshi_exact' && r.rung.strike === 8.5; })());
ok('nearest within 0.5 wins over liquidity', (() => { const r = cascade(L, 9.4);
  return r.tier === 'kalshi_nearest' && r.rung.strike === 9.0; })(),
  'anchor 9.4 -> rung 9.0, not the 8.5 liquidity rung');
ok('beyond 0.5 falls back to liquidity', (() => { const r = cascade(L, 6.0);
  return r.tier === 'liquidity_fallback' && r.rung.strike === 8.5; })(),
  'anchor 6.0 is 1.5 away -> liquidity 8.5');
ok('NO Kalshi line falls back to liquidity -- the removal case',
   (() => { const r = cascade(L, null);
     return r.tier === 'liquidity_fallback' && r.rung.strike === 8.5; })(),
   'this is what every row does once Unabated is gone and Kalshi is silent');
ok('empty ladder yields no rung (caller skips)', cascade([], 8.5).rung == null);
ok('tie on liquidity is deterministic (first wins, not undefined)',
   liquidity([{ strike: 7.5, market_liquidity_clob: 5 },
              { strike: 8.5, market_liquidity_clob: 5 }]).strike === 7.5);
ok('a rung with null liquidity is treated as zero, not skipped',
   liquidity([{ strike: 7.5 }]).strike === 7.5);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
