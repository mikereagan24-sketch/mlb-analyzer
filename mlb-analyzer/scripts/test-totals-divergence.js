#!/usr/bin/env node
/**
 * Totals divergence: the null-arithmetic bug, and the two arms.
 * (2026-09-06)
 *
 * THE BUG. haveTot is computed from _effTotalPost, which falls back to the
 * PRESERVED DB value when this pass returned no primary total. The Δp
 * arithmetic then used o.market_total / o.over_price / o.under_price --
 * this pass's values, null in exactly that case. impP(null) is not NaN:
 * JavaScript coerces null to 0, so 100/(null+100) === 1. Δp was computed
 * against a probability of 1.0, always cleared the 0.08 bar, and always
 * flagged.
 *
 * Measured over the 30 days to 2026-09-06: 305 stored "totals divergence"
 * flags, all 305 of the form primary=null@null/null, 0 genuine. Replaying
 * the rule on final stored values across 422 rows holding BOTH a primary
 * and an xcheck total: 0 fires.
 *
 * Run: node scripts/test-totals-divergence.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== totals divergence ===');
const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- the coercion that caused it, pinned so it cannot be forgotten ----
const impP = x => x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
ok('impP(null) === 1 (null coerces to 0, it is NOT NaN)', impP(null) === 1,
   'this is the whole bug');
ok('impP(NaN) is NaN, so a NaN guard would NOT have caught it',
   Number.isNaN(impP(NaN)) && impP(null) === 1);

// ---- the fix is wired to the effective values ------------------------
ok('arm A uses _effTotalPost / _effOverPost / _effUnderPost',
   src.indexOf('const a = divergence(_effTotalPost, _effOverPost, _effUnderPost,') !== -1);
ok('the flag text uses the effective values too, not o.*',
   src.indexOf("const pTxt = _effTotalPost + '@' + _effOverPost + '/' + _effUnderPost;") !== -1);
ok('no surviving o.market_total in the divergence arithmetic',
   src.indexOf('const lineDelta = o.market_total - o.xcheck_total;') === -1);
ok('both arms share ONE rule function', (src.match(/const divergence = \(/g) || []).length === 1);
ok('arm B is tagged and writes no flag',
   src.indexOf("'[tot-divergence] arm=poly") !== -1 && src.indexOf("NOFLAG") !== -1);
ok('arm B pushes no reason',
   src.indexOf('reasons.push') !== -1
   && src.slice(src.indexOf('const b = divergence(')).indexOf('reasons.push') === -1);
ok('every genuine fire logs pass time, both sides, dp and kind',
   src.indexOf("'  pass=' + _passIso") !== -1
   && src.indexOf("'  dp=' + a.d.toFixed(3)") !== -1
   && src.indexOf("'  kind=' + (a.sameLine ? 'juice' : 'line')") !== -1);
ok('poly total is recorded before the Kalshi-primary skip',
   src.indexOf('o.poly_total       = picked.strike;')
   < src.indexOf('// Kalshi wrote first — only fill market_total when it left it NULL.'));

// ---- behaviour: the rule itself -------------------------------------
const RUNS_TO_PROB = 0.12;
const divergence = (pTot, pOver, pUnder, bTot, bOver, bUnder) => {
  if (pTot == null || pOver == null || pUnder == null) return null;
  if (bTot == null || bOver == null || bUnder == null) return null;
  const ld = pTot - bTot;
  const dO = Math.abs(impP(pOver) - (impP(bOver) - ld * RUNS_TO_PROB));
  const dU = Math.abs(impP(pUnder) - (impP(bUnder) + ld * RUNS_TO_PROB));
  return { d: Math.max(dO, dU), sameLine: pTot === bTot };
};

// THE CASE THAT WAS FIRING 305 TIMES: pass returns no primary, DB holds
// one. Under the fix the effective values are real, so no flag.
const eff = divergence(7.5, -110, -110, 7.5, -112, -108);
ok('effective values from the DB do NOT flag when the pass is empty',
   eff !== null && eff.d <= 0.08, 'dp=' + eff.d.toFixed(3));
// And the old shape, to show what it used to do.
const old = divergence(null, null, null, 7.5, -118, -102);
ok('the OLD shape (this-pass nulls) is now refused outright', old === null,
   'previously produced dp ~1.4 and always flagged');

// Genuine divergences must still fire.
const lineDiv = divergence(7.5, -132, -489, 8, -106, -114);
ok('a genuine LINE divergence still flags', lineDiv.d > 0.08 && !lineDiv.sameLine,
   'dp=' + lineDiv.d.toFixed(3) + ' -- the SF@NYM 2026-09-04 shape');
const juiceDiv = divergence(8.5, -180, 150, 8.5, -105, -115);
ok('a genuine JUICE divergence still flags', juiceDiv.d > 0.08 && juiceDiv.sameLine,
   'dp=' + juiceDiv.d.toFixed(3) + ' same line, different prices');
const agree = divergence(8.5, -110, -110, 8.5, -108, -112);
ok('close agreement does NOT flag', agree.d <= 0.08, 'dp=' + agree.d.toFixed(3));
ok('a missing book side is refused, not treated as zero',
   divergence(8.5, -110, -110, null, null, null) === null);

// ---- the corpus the fix is measured against -------------------------
const { db } = require(path.join(R, 'db/schema'));
const rows = db.prepare(
  "SELECT market_total, over_price, under_price, xcheck_total, xcheck_over_price, xcheck_under_price "
  + "FROM game_log WHERE game_date >= date('now','-30 days')").all();
let both = 0, fires = 0;
for (const r of rows) {
  const d = divergence(r.market_total, r.over_price, r.under_price,
                       r.xcheck_total, r.xcheck_over_price, r.xcheck_under_price);
  if (!d) continue;
  both++;
  if (d.d > 0.08) fires++;
}
console.log('  replay on final stored values: ' + both + ' comparable rows, ' + fires + ' fire(s)');
ok('the fixed rule does not fire on settled data', fires === 0,
   'was 305 stored flags, all spurious');
ok('the replay corpus is non-trivial', both > 100, both + ' rows');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
