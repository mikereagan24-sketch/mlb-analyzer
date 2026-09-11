#!/usr/bin/env node
/**
 * Candidate runline model margin_model_B: frozen, coherent, invisible.
 * (2026-09-12)
 *
 * THREE THINGS THIS DEFENDS, each of which would destroy the candidate
 * quietly rather than loudly:
 *
 *  1. THE COEFFICIENTS ARE FROZEN. The whole value of
 *     spread_candidate_predictions is that every row was produced by a
 *     model that never saw the game it predicts. A refit on accumulated
 *     data -- tempting once the sample grows -- converts a forward test
 *     into an in-sample one, and NOTHING DOWNSTREAM COULD TELL. The
 *     numbers are pinned here so a refit has to be deliberate and land
 *     as a new candidate id.
 *
 *  2. THE MODEL IS COHERENT. Ordinal-with-shared-slopes was chosen over
 *     six separate logistics precisely so P(win by 2+) >= P(win by 3+)
 *     >= P(win by 4+) and the two directions sum to <= 1. Those hold by
 *     construction -- this asserts they actually hold, across the real
 *     input range, because "by construction" is a claim about code.
 *
 *  3. IT IS NOT A DISPLAY PATH. The candidate must not reach the card,
 *     the slate API, or any signal table. A candidate that leaks into
 *     the UI is an adopted model nobody voted for.
 *
 * Run: node scripts/test-spread-candidate-margin-model.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const M = require(path.join(R, 'services/spread-candidate-margin-model'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== candidate runline model: margin_model_B ===');

// ---- 1. frozen coefficients ------------------------------------------
ok('candidate id', M.CANDIDATE_ID === 'margin_model_B', M.CANDIDATE_ID);
ok('fit window recorded', M.FIT_THROUGH === '2026-07-31' && M.FIT_N_GAMES === 1482,
   'fitted on ' + M.FIT_N_GAMES + ' games through ' + M.FIT_THROUGH);
const THETAS = [-1.300824, -0.905952, -0.454869, 0.004755, 0.684741, 1.114551, 1.524960];
const BETA = [0.729130, -0.098210, 0.044276];
ok('thetas are the pre-2026-08-01 fit, unchanged',
   M.THETAS.length === 7 && M.THETAS.every((t, i) => Math.abs(t - THETAS[i]) < 1e-9),
   'a refit must land as a NEW candidate id, not edit these');
ok('beta is the pre-2026-08-01 fit, unchanged',
   M.BETA.length === 3 && M.BETA.every((b, i) => Math.abs(b - BETA[i]) < 1e-9));
ok('cutpoints cover exactly the 1.5 / 2.5 / 3.5 ladder, both directions',
   JSON.stringify(M.CUTPOINTS) === JSON.stringify([-4, -3, -2, -1, 1, 2, 3]));
ok('cutpoints are monotone increasing (a cumulative link requires it)',
   M.THETAS.every((t, i) => i === 0 || t > M.THETAS[i - 1]));

// The module must not refit. A fit needs the outcome; a scorer does not.
const src = fs.readFileSync(path.join(R, 'services/spread-candidate-margin-model.js'), 'utf8');
ok('the module never reads a final score',
   src.indexOf('home_score') === -1 && src.indexOf('away_score') === -1,
   'it scores; it does not fit, and cannot grade itself');
ok('and says the coefficients must not be refitted',
   /COEFFICIENTS ARE FROZEN/.test(src) && /MUST NOT be refitted/.test(src));

// ---- 2. coherence across the real input range ------------------------
// Sweep the observed market wp x total grid and assert the ordering
// properties the ordinal form is supposed to guarantee.
let swept = 0, monoHome = 0, monoAway = 0, sums = 0, ranged = 0;
for (let wp = 0.20; wp <= 0.80001; wp += 0.02) {
  for (let tot = 6.5; tot <= 12.5001; tot += 0.5) {
    // build a moneyline pair that yields this no-vig wp
    const hm = wp >= 0.5 ? -Math.round(100 * wp / (1 - wp)) : Math.round(100 * (1 - wp) / wp);
    const am = wp >= 0.5 ? Math.round(100 * wp / (1 - wp)) : -Math.round(100 * (1 - wp) / wp);
    const eta = M.etaOf(hm, am, tot);
    if (eta == null) continue;
    swept++;
    const h = [1.5, 2.5, 3.5].map(L => M.layProb(eta, L, true));
    const a = [1.5, 2.5, 3.5].map(L => M.layProb(eta, L, false));
    if (h[0] >= h[1] && h[1] >= h[2]) monoHome++;
    if (a[0] >= a[1] && a[1] >= a[2]) monoAway++;
    // the two directions at the same line cannot both happen
    if ([0, 1, 2].every(i => h[i] + a[i] <= 1 + 1e-12)) sums++;
    if (h.concat(a).every(p => p > 0 && p < 1)) ranged++;
  }
}
ok('swept the real input range', swept > 300, swept + ' (wp, total) points');
ok('P(cover) is MONOTONE in the line, home side', monoHome === swept,
   monoHome + '/' + swept + ' — P(win by 2+) >= P(win by 3+) >= P(win by 4+)');
ok('P(cover) is MONOTONE in the line, away side', monoAway === swept,
   monoAway + '/' + swept);
ok('home and away at the same line never sum above 1', sums === swept,
   sums + '/' + swept + ' — independent per-threshold fits can violate this');
ok('every probability is strictly inside (0,1)', ranged === swept, ranged + '/' + swept);

// Direction sanity: a bigger home favourite must be likelier to cover.
const strong = M.etaOf(-250, 210, 8.5), weak = M.etaOf(130, -150, 8.5);
ok('a stronger home favourite covers -1.5 more often',
   M.layProb(strong, 1.5, true) > M.layProb(weak, 1.5, true),
   (100 * M.layProb(strong, 1.5, true)).toFixed(1) + '% vs '
   + (100 * M.layProb(weak, 1.5, true)).toFixed(1) + '%');

// REFUSES rather than guessing.
ok('no market ML pair -> no prediction', M.etaOf(null, 120, 8.5) === null);
ok('no market total -> no prediction', M.etaOf(-130, 110, null) === null);

// ---- 3. it is not a display path -------------------------------------
const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
ok('routes/api.js never reads the candidate',
   api.indexOf('spread_candidate_predictions') === -1
   && api.indexOf('margin_model_B') === -1);
ok('the card never reads the candidate',
   html.indexOf('spread_candidate') === -1 && html.indexOf('margin_model') === -1);
ok('the module writes ONE table and it is the side table',
   (src.match(/INSERT OR REPLACE INTO (\w+)/g) || []).join() === 'INSERT OR REPLACE INTO spread_candidate_predictions');
ok('it does not import the display engine',
   src.indexOf("require('./empirical-spread-edge')") === -1,
   'duplicated americanToProb on purpose — no coupling to the gated path');
ok('no outcome column: the margin is joined at evaluation time',
   src.indexOf('NO OUTCOME COLUMN') !== -1);

const jobs = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
ok('the odds pass generates it', jobs.indexOf('spread-candidate-margin-model') !== -1);
// Structural, not a proximity regex: the first version of this arm used
// a bounded [\s\S]{0,600} window and failed on correct code purely
// because the explanatory comment between the two blocks is longer than
// the window. Assert the nesting instead -- the candidate's require must
// come after the display block's catch closes, with exactly one `try {`
// opened in between.
const catchIdx = jobs.indexOf("console.warn('[empirical-spreads] generation failed");
const candIdx = jobs.indexOf("require('./spread-candidate-margin-model')");
const between = (catchIdx !== -1 && candIdx > catchIdx)
  ? jobs.slice(catchIdx, candIdx) : '';
ok('in its OWN try block, not sharing the display block\'s',
   catchIdx !== -1 && candIdx > catchIdx
   && (between.match(/\btry \{/g) || []).length === 1,
   'a failure in either must not take out the other');
// Siblings, not nested: both `try {` sit at the SAME indent. (The first
// attempt tested for `} catch (e) {` inside a slice that began in the
// middle of that very catch, so the opener was never in range -- the
// code was right and the assertion was looking in the wrong window.)
const indentOf = (hay, needle) => {
  const i = hay.lastIndexOf('\n', hay.indexOf(needle)) + 1;
  return (hay.slice(i).match(/^[ \t]*/) || [''])[0];
};
const dispTry = jobs.lastIndexOf('try {', jobs.indexOf('generateEmpiricalSpreadSignals(db, dateStr)'));
const candTry = jobs.lastIndexOf('try {', candIdx);
ok('the display block\'s catch closes before the candidate block opens',
   candTry > catchIdx
   && indentOf(jobs, jobs.slice(dispTry)) === indentOf(jobs, jobs.slice(candTry)),
   'the two are siblings, not nested');
ok('failures are non-fatal', jobs.indexOf('[spread-candidate] generation failed (non-fatal)') !== -1);

// ---- 4. the table, and a real round-trip -----------------------------
const cols = db.prepare('PRAGMA table_info(spread_candidate_predictions)').all().map(c => c.name);
ok('the side table exists with the expected columns',
   ['game_date','game_id','spread_team','spread_line','side','candidate','generated_at',
    'prob_pct','implied_pct','edge_pp','price_ml','input_market_home_wp','input_market_total']
     .every(c => cols.indexOf(c) !== -1), cols.length + ' columns');
ok('candidate is part of the primary key',
   db.prepare('PRAGMA table_info(spread_candidate_predictions)').all()
     .filter(c => c.pk > 0).map(c => c.name).indexOf('candidate') !== -1,
   'so a refit lands beside this one instead of overwriting it');
ok('no outcome/pnl column on the table',
   cols.indexOf('outcome') === -1 && cols.indexOf('pnl_per_100') === -1);

const d = db.prepare('SELECT game_date d FROM kalshi_spread_markets '
  + 'GROUP BY 1 ORDER BY 1 DESC LIMIT 1').get();
if (d) {
  const gen = M.generateCandidatePredictions(db, d.d);
  console.log('  generated ' + gen.rows.length + ' prediction(s) for ' + d.d
    + (gen.skippedNoEta ? ', ' + gen.skippedNoEta + ' game(s) skipped' : ''));
  ok('generation produces rows on a real slate', gen.rows.length > 0);
  ok('every row is tagged with the candidate id',
     gen.rows.every(r => r.candidate === 'margin_model_B'));
  ok('edge_pp is exactly prob - implied',
     gen.rows.every(r => Math.abs(r.edge_pp - (r.prob_pct - r.implied_pct)) < 1e-9));
  ok('lay and take at a line sum to 100 (complementary by construction)',
     (function () {
       const by = new Map();
       for (const r of gen.rows) {
         const k = r.game_id + '|' + r.spread_line + '|' + r.spread_team;
         if (!by.has(k)) by.set(k, {});
         by.get(k)[r.side] = r.prob_pct;
       }
       let n = 0, good = 0;
       for (const [, v] of by) {
         if (v.lay == null || v.take == null) continue;
         n++; if (Math.abs(v.lay + v.take - 100) < 1e-9) good++;
       }
       return n > 0 && good === n;
     })());
  ok('the inputs that produced each row are stored with it',
     gen.rows.every(r => r.input_market_home_wp != null && r.input_market_total != null),
     'so a row stays re-derivable after market_* moves');
}

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
