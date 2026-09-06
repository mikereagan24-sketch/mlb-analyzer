#!/usr/bin/env node
/**
 * checkBookDivergence's cross-check book moves to a DIRECT Polymarket
 * quote. (2026-09-06)
 *
 * PR 2a of the Unabated removal. The guard's second opinion was
 * xcheck_*_ml, which arrives via the Unabated feed. Measured over the 30
 * days to 2026-09-06, xcheck_ml_source was 'polymarket' on 322 of 332
 * Kalshi-primary rows (97.0%) -- so this is the same book by a surviving
 * source, not a different comparison.
 *
 * The assertion that matters is the REPLAY: over the last 30 days the
 * guard must flag the same population either way. It currently flags
 * nothing (0 vs 0), and the 10 non-Poly xcheck rows must lose nothing.
 *
 * A 0-vs-0 match is weak evidence on its own -- two broken things also
 * agree at zero -- so the replay ALSO asserts the rule can still fire, by
 * feeding it a constructed favourite-flip.
 *
 * Run: node scripts/test-book-divergence-poly.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== checkBookDivergence -> direct Polymarket ===');
const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- wiring ---------------------------------------------------------
ok('Poly ML is recorded even when Kalshi wins the slot',
   src.indexOf('o.poly_away_ml = awayMl;') !== -1
   && src.indexOf('o.poly_home_ml = homeMl;') !== -1);
ok('recorded BEFORE the Kalshi-primary skip',
   src.indexOf('o.poly_away_ml = awayMl;')
   < src.indexOf('// Kalshi wrote first — only fill when it left the field NULL.'));
ok('divergence prefers poly, falls back to xcheck',
   src.indexOf('const _xAway = o.poly_away_ml != null ? o.poly_away_ml : o.xcheck_away_ml;') !== -1);
ok('the source label follows the value',
   src.indexOf("const _xSrc  = o.poly_away_ml != null ? 'polymarket' : o.xcheck_ml_source;") !== -1);
ok('poly_*_ml is in-memory only (never persisted)',
   src.indexOf('poly_away_ml=?') === -1 && src.indexOf('poly_away_ml INTEGER') === -1);

// ---- the rule, replayed --------------------------------------------
const impP = x => x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
function diverges(a, h, ca, ch) {
  a = parseFloat(a); h = parseFloat(h); ca = parseFloat(ca); ch = parseFloat(ch);
  if ([a, h, ca, ch].some(v => isNaN(v) || v === 0)) return false;
  const kalFav = a < h ? 'away' : 'home';
  const xFav = ca < ch ? 'away' : 'home';
  if (kalFav === xFav) return false;
  return (xFav === 'away' ? impP(ca) : impP(ch)) > 0.535;
}

// The detector must be able to fire, or 0-vs-0 proves nothing.
ok('DETECTOR SELFTEST: a constructed favourite-flip DOES flag',
   diverges(-200, 170, 150, -180) === true,
   'Kalshi favours away, book favours home at 64% implied');
ok('DETECTOR SELFTEST: agreement does NOT flag', diverges(-200, 170, -190, 160) === false);
ok('DETECTOR SELFTEST: a pick-em flip is ignored (<= 0.535)',
   diverges(-105, -105, 102, -108) === false);

const rows = db.prepare(
  "SELECT xcheck_ml_source, market_away_ml, market_home_ml, xcheck_away_ml, xcheck_home_ml "
  + "FROM game_log WHERE game_date >= date('now','-30 days') AND ml_source='kalshi' "
  + 'AND market_away_ml IS NOT NULL AND xcheck_away_ml IS NOT NULL').all();

if (!rows.length) {
  console.log('  SKIP  no Kalshi-primary rows with an xcheck ML in the last 30 days');
} else {
  const flag = r => diverges(r.market_away_ml, r.market_home_ml, r.xcheck_away_ml, r.xcheck_home_ml);
  const all = rows.filter(flag);
  const poly = rows.filter(r => r.xcheck_ml_source === 'polymarket');
  const polyFlag = poly.filter(flag);
  const nonPoly = rows.filter(r => r.xcheck_ml_source !== 'polymarket');
  const nonPolyFlag = nonPoly.filter(flag);

  console.log('  replay corpus: ' + rows.length + ' Kalshi-primary rows'
    + '   poly-sourced xcheck ' + poly.length + '   other ' + nonPoly.length);
  ok('Poly coverage on Kalshi-primary rows is >= 90%',
     poly.length / rows.length >= 0.90,
     (100 * poly.length / rows.length).toFixed(1) + '%');
  ok('flags are IDENTICAL between the full xcheck set and the Poly subset',
     all.length === polyFlag.length, all.length + ' vs ' + polyFlag.length);
  ok('the non-Poly rows lose nothing', nonPolyFlag.length === 0,
     nonPolyFlag.length + ' flag(s) on ' + nonPoly.length + ' non-Poly rows');
  console.log('  NOTE the guard currently flags ' + all.length
    + ' row(s) in 30 days. Production record: last "disagree on favorite"'
    + ' was 2026-07-06. This change preserves an inert guard exactly.');
}

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
