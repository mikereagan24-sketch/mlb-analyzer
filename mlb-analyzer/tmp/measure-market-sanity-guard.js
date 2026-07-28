'use strict';
// Measure the market-sanity guard against a real slate.
//
// Usage: node tmp/measure-market-sanity-guard.js [YYYY-MM-DD]
//
// Calls services/odds-comparison.runComparison for the given date (default
// today PT), replicates the exact _pickBestML logic used by
// services/jobs.js:812-817, then reports per-game:
//   - which venue supplied best-away vs best-home
//   - implied prob per side + implied-sum for the pair
//   - guard verdict (pass / reject) with reason
// Also emits histogram + summary stats so the [0.95, 1.20] band can be
// calibrated against actual venue-pair distributions rather than guessed.

const { runComparison } = require('../services/odds-comparison');
const { checkMarketMLPairSanity } = require('../utils/market-sanity');

function impP(ml) {
  const x = Number(ml);
  if (!Number.isFinite(x) || x === 0) return null;
  return x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
}
function fmtAm(n) { return n == null ? 'null' : (n > 0 ? '+' + n : String(n)); }
function fmtP(p)  { return p  == null ? '  n/a' : p.toFixed(3); }

// Mirror of jobs.js:_pickBestML — kept in-sync manually. Returns
// {ml, venue} or null.
function pickBestML(rowForGame, side) {
  if (!rowForGame) return null;
  const P = rowForGame.poly && rowForGame.poly[side];
  const K = rowForGame.kalshi && rowForGame.kalshi[side];
  const polyOK = P && P.net_american != null && !P.partial;
  const kalOK  = K && K.net_american != null && !K.partial;
  if (!polyOK && !kalOK) return null;
  if (polyOK && !kalOK)  return { ml: P.net_american, venue: 'poly' };
  if (kalOK && !polyOK)  return { ml: K.net_american, venue: 'kalshi' };
  return P.net_american >= K.net_american
    ? { ml: P.net_american, venue: 'poly' }
    : { ml: K.net_american, venue: 'kalshi' };
}

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

(async function main() {
  const date = process.argv[2] || todayPT();
  console.log('MEASURE market-sanity guard for slate ' + date);
  console.log('(runs live Poly + Kalshi comparison — one shot; no writes)');
  console.log('');

  const cmp = await runComparison(date, { onProgress: () => {} });
  if (cmp.poly_error)   console.warn('  poly_error: '   + cmp.poly_error);
  if (cmp.kalshi_error) console.warn('  kalshi_error: ' + cmp.kalshi_error);
  console.log('slate rows: ' + cmp.rows.length);
  console.log('');

  const perGame = [];
  for (const row of cmp.rows) {
    const bA = pickBestML(row, 'away');
    const bH = pickBestML(row, 'home');
    const aMl = bA ? bA.ml : null;
    const hMl = bH ? bH.ml : null;
    const pa = impP(aMl);
    const ph = impP(hMl);
    const sum = (pa != null && ph != null) ? pa + ph : null;
    const reason = checkMarketMLPairSanity(aMl, hMl);
    perGame.push({
      game_id: row.game_id,
      away_ml: aMl, away_venue: bA ? bA.venue : null,
      home_ml: hMl, home_venue: bH ? bH.venue : null,
      pa, ph, sum,
      pass: reason == null,
      reason,
    });
  }

  // Per-game table
  console.log('per-game:');
  console.log('  game_id        away_ml (venue)   home_ml (venue)     impP away  impP home   sum   verdict');
  const rows = perGame.slice().sort((a, b) => (a.sum || 99) - (b.sum || 99));
  for (const g of rows) {
    const line = '  ' + g.game_id.padEnd(14, ' ')
      + ' ' + fmtAm(g.away_ml).padStart(6, ' ') + ' (' + (g.away_venue || '  ?  ').padEnd(6, ' ') + ')'
      + '  ' + fmtAm(g.home_ml).padStart(6, ' ') + ' (' + (g.home_venue || '  ?  ').padEnd(6, ' ') + ')'
      + '     ' + fmtP(g.pa)
      + '     ' + fmtP(g.ph)
      + '   ' + (g.sum == null ? '  n/a' : g.sum.toFixed(3))
      + '   ' + (g.pass ? 'PASS' : 'REJECT: ' + g.reason);
    console.log(line);
  }

  // Summary
  const rejected = perGame.filter(g => !g.pass);
  const withSum = perGame.filter(g => g.sum != null).map(g => g.sum);
  const splitVenue = perGame.filter(g => g.away_venue && g.home_venue && g.away_venue !== g.home_venue);
  console.log('');
  console.log('summary:');
  console.log('  games total:               ' + perGame.length);
  console.log('  games with sum available:  ' + withSum.length);
  console.log('  rejected by guard:         ' + rejected.length + '  ' +
    (rejected.length ? '(' + rejected.map(r => r.game_id).join(', ') + ')' : ''));
  console.log('  split-venue pairs:         ' + splitVenue.length + '  (best-away and best-home from DIFFERENT venues)');
  if (withSum.length) {
    const s = withSum.slice().sort((a, b) => a - b);
    const q = f => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * (s.length - 1))))];
    console.log('  implied-sum distribution:');
    console.log('    min      ' + s[0].toFixed(3));
    console.log('    p10      ' + q(0.10).toFixed(3));
    console.log('    p25      ' + q(0.25).toFixed(3));
    console.log('    median   ' + q(0.50).toFixed(3));
    console.log('    p75      ' + q(0.75).toFixed(3));
    console.log('    p90      ' + q(0.90).toFixed(3));
    console.log('    max      ' + s[s.length - 1].toFixed(3));
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    console.log('    mean     ' + mean.toFixed(3));
  }

  // Bucket histogram for calibration
  const buckets = [
    [0.00, 0.90], [0.90, 0.94], [0.94, 0.96], [0.96, 0.98],
    [0.98, 1.00], [1.00, 1.02], [1.02, 1.04], [1.04, 1.06],
    [1.06, 1.08], [1.08, 1.10], [1.10, 1.15], [1.15, 1.20], [1.20, 99],
  ];
  const counts = buckets.map(() => 0);
  for (const s of withSum) {
    const i = buckets.findIndex(([lo, hi]) => s >= lo && s < hi);
    if (i >= 0) counts[i]++;
  }
  console.log('');
  console.log('  implied-sum histogram (guard band [0.95, 1.20]):');
  const maxCount = Math.max(1, ...counts);
  buckets.forEach(([lo, hi], i) => {
    const bar = '#'.repeat(Math.round((counts[i] / maxCount) * 32));
    const flag = (hi <= 0.95 || lo >= 1.20) ? '   [OUT-OF-BAND]' : '';
    const label = '    [' + lo.toFixed(2) + ', ' + hi.toFixed(2) + ')';
    console.log(label.padEnd(20, ' ') + counts[i].toString().padStart(3, ' ') + '  ' + bar + flag);
  });
  console.log('');
  console.log('  DONE. Verdict: ' + rejected.length + '/' + perGame.length + ' rejected.');
})().catch(e => {
  console.error('measurement failed: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
