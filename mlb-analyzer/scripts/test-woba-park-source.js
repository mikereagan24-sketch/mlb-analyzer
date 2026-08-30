#!/usr/bin/env node
/**
 * The wOBA park factor comes from the table, not the literal. (2026-08-30)
 *
 * WHY. services/park-factors-woba.js held a 30-team hardcoded table
 * described as "FanGraphs 5-year rolling", which it was not -- the values
 * were approximations fitted so a set of expected spot-checks held. No
 * timestamp, invisible to pipeline-freshness, last touched 2026-07-03.
 * The same shape as the PARK_FACTORS literal replaced on 2026-08-25, and
 * it survived that work because nobody grepped for a second copy.
 *
 * Savant publishes index_woba in the SAME blob as index_runs. The parser
 * read only index_runs regardless of the `stat` param, so the field was
 * always available and never used.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
const near = (a, b, tol, l) => ok(a != null && Math.abs(a - b) <= tol,
  l + '  (got ' + JSON.stringify(a) + ', want ~' + b + ' +/-' + tol + ')');

// ---- the transform constant, and that it is only a fallback ------------
const pf = require(path.join(R, 'services/park-factors'));
near(pf.WOBA_FROM_RUN_K, 0.497, 0.001, 'k is the measured 0.497, not the old 0.60-0.80 claim');
near(pf.wobaFromRun(1.25), 1 + 0.25 * 0.497, 1e-9, 'wobaFromRun applies the constant');
eq(pf.wobaFromRun(null), null, 'wobaFromRun(null) is null, not 1.0');
eq(pf.wobaFromRun(undefined), null, 'wobaFromRun(undefined) is null');
// A wOBA factor that silently became the RUN factor would over-neutralize
// by ~2x, which is the specific error the null-not-fallback rule prevents.
ok(Math.abs(pf.wobaFromRun(1.25) - 1.25) > 0.1,
   'the derived wOBA factor is materially compressed vs the run factor');

// ---- the manual override carries both, and they are consistent ---------
const ath = pf.MANUAL.ATH;
ok(ath.woba_factor != null, 'ATH has a manual wOBA factor, not just a run factor');
ok(ath.woba_reason && ath.woba_reason.length > 40, 'and its own recorded reason');
near(ath.woba_factor, pf.wobaFromRun(ath.factor), 0.002,
     'the ATH manual wOBA is DERIVED from its run factor, so the two cannot drift');

// ---- the table is the source, the literal is the fallback --------------
const pfw = require(path.join(R, 'services/park-factors-woba'));
const { q } = require(path.join(R, 'db/schema'));
const tbl = {};
for (const r of q.listParkFactors.all()) if (r.woba_factor != null) tbl[r.team] = r.woba_factor;

eq(Object.keys(tbl).length, 30, 'all 30 teams carry a woba_factor in park_factors');
ok(q.getParkFactor.get('ATH').woba_manual_reason != null,
   'the ATH wOBA reason is persisted on the row, not only in code');

for (const t of ['TEX', 'CHC', 'COL']) {
  eq(pfw.getWobaParkFactor(t), tbl[t], t + ': the consumer returns the TABLE value');
  ok(pfw.getWobaParkFactor(t) !== pfw.WOBA_PARK_FACTORS[t],
     t + ': and that differs from the frozen literal, so the switch is live');
}

// Unknown teams stay a no-op rather than throwing or neutralizing wildly.
eq(pfw.getWobaParkFactor('ZZZ'), 1.00, 'unknown team -> 1.00 no-op');
eq(pfw.getWobaParkFactor(null), 1.00, 'null team -> 1.00 no-op');

// ---- the literal is frozen, not maintained -----------------------------
const src = fs.readFileSync(path.join(R, 'services/park-factors-woba.js'), 'utf8');
ok(src.includes('FROZEN FALLBACK'), 'the literal is marked frozen');
ok(!src.includes('SOURCE: FanGraphs 5-year rolling'),
   'the stale FanGraphs source claim is gone -- it named a source the values did not come from');
ok(src.includes('0.497') || src.includes('0.50'),
   'the header states the measured compression ratio');
ok(!/roughly ~0\.60-0\.80/.test(src), 'the incorrect 0.60-0.80 claim is gone');

// ---- the parser reads index_woba, and null stays null -------------------
const pfSrc = fs.readFileSync(path.join(R, 'services/park-factors.js'), 'utf8');
ok(pfSrc.includes('r.index_woba'), 'the parser reads index_woba from the blob');
ok(pfSrc.includes('woba_factor:'), 'and emits it on the row');
// The assertion must cover the new column, or a team could resolve its run
// factor while silently losing its wOBA factor -- a MIXED table.
ok(pfSrc.includes('missingWoba'), 'assertAllTeamsResolve checks the wOBA column too');
const chk = pf.assertAllTeamsResolve({ COL: { factor: 1.25, woba_factor: null } });
ok(chk.ok === false, 'a null wOBA factor fails the assertion');
ok(chk.missingWoba && chk.missingWoba.includes('COL'), 'and names the team');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
