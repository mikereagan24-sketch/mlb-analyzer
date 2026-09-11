#!/usr/bin/env node
/**
 * The spread-edge re-enable bar is four measures, not one. (2026-09-12)
 *
 * WHAT HAPPENED. PR #374 registered spread_edge_display_enabled with a
 * single-measure criterion: mean |bin error| below the market's, out of
 * sample, n >= 2,000. Hours later an ISOTONIC recalibration of
 * empirical_pct MET IT -- 3.16pp against the market's 4.72pp on 4,776
 * held-out plays -- while being worse on Brier (0.1990 vs 0.1987), log
 * loss (0.6288 vs 0.5876) and AUC (0.7477 vs 0.7560).
 *
 * WHY THAT IS NOT A NEAR MISS. Calibration is half of forecast quality.
 * A constant base-rate predictor is perfectly calibrated and worthless,
 * so a bar written only on calibration can be cleared by throwing away
 * sharpness. The amended bar requires all four measures.
 *
 * THE CLAUSE THAT MATTERS is AUC. Isotonic and Platt are monotone, and
 * AUC depends only on ranking, so neither can move it -- both scored
 * EXACTLY the raw engine's 0.7477. It is the one clause a post-hoc map
 * cannot game, which is why a re-enable path has to go through the cell
 * definition instead.
 *
 * This test is a SPECIFICATION GUARD, not a code guard: it fails if the
 * criterion ever loses a clause, because the cost of that is a feature
 * turned back on for a reason that has already been shown insufficient.
 *
 * Run: node scripts/test-spread-edge-reenable-criterion.js
 */
const path = require('path');
const R = path.join(__dirname, '..');
const reg = require(path.join(R, 'services/feature-gate-registry'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== spread-edge re-enable criterion ===');

const gate = reg.GATES.find(g => g.id === 'spread_edge_display_enabled');
ok('the gate exists', !!gate);
if (!gate) { console.log('\nFAILED (1)'); process.exit(1); }

const c = gate.criterion, note = gate.note;

// ---- the gate is still off, on a calibration criterion ---------------
ok('still OFF', gate.on_expected === false);
ok('criterion_type is calibration', gate.criterion_type === 'calibration');
ok('corpus_size recorded', typeof gate.corpus_size === 'number' && gate.corpus_size > 0,
   String(gate.corpus_size));

// ---- all four clauses, and the ALL-of framing ------------------------
ok('the bar is explicitly ALL FOUR, not any one',
   /ALL FOUR/.test(c) && /not any one/.test(c));
ok('clause 1: mean |bin error| below the market', /\(1\)[^\n]*mean \|bin error\| BELOW the market/.test(c));
ok('clause 2: Brier no worse than the market', /\(2\)[^\n]*Brier NO WORSE than the market/.test(c));
ok('clause 3: log loss no worse than the market', /\(3\)[^\n]*log loss NO WORSE than the market/.test(c));
ok('clause 4: AUC at least the market', /\(4\)[^\n]*AUC AT LEAST the market/.test(c));

// ---- the window spec survived the amendment -------------------------
ok('forward window of n >= 2,000 distinct plays',
   /n >= 2,000 distinct plays/.test(c) && /NOT per odds pass/.test(c));
ok('fitted strictly before the window', /fitted strictly before that window/.test(c));
ok('the MARKET is the bar, not the raw engine',
   /beat the MARKET out of sample/.test(c)
   && /Beating the RAW engine is not the bar/.test(c));

// ---- the reasoning is recorded, not just the rule --------------------
ok('the criterion says WHY clause 4 is load-bearing',
   /monotone recalibration cannot game/.test(c) && /cannot reorder/.test(c));
ok('and why (2) and (3) exist',
   /buys calibration with sharpness/.test(c)
   && /constant base-rate predictor is\s+perfectly calibrated and worthless/.test(c.replace(/\n/g, ' ')));

ok('the note records that isotonic MET the original bar',
   /MET IT -- 3\.16pp against the market's\s+4\.72pp/.test(note.replace(/\n/g, ' ')));
ok('and that it lost on Brier, log loss and AUC',
   /0\.1990 vs 0\.1987/.test(note) && /0\.6288 vs 0\.5876/.test(note)
   && /0\.7477 vs 0\.7560/.test(note));
ok('the note records that monotone maps cannot change AUC',
   /MONOTONE/.test(note) && /AUC depends only on ranking/.test(note)
   && /EXACTLY 0\.7477/.test(note));
ok('the AUC gap is named as THE target',
   /THE TARGET IS THE AUC GAP: 0\.7477 vs 0\.7560/.test(note));
ok('and the path is the cell definition, not post-processing',
   /runs through the CELL DEFINITION/.test(note)
   && /not through post-processing/.test(note));

// ---- the amendment did not quietly drop #374's content ---------------
// PR #374's own test asserts these substrings. If the amendment loses
// one, that test goes red AFTER both land -- which is the worst time to
// find out. Assert them here too so this branch fails first.
ok('founding calibration figures survive the amendment',
   note.indexOf('ENGINE 5.84pp vs MARKET 4.03pp') !== -1);
ok('the ROI evidence is still SUPPORTING, not deciding',
   /SUPPORTING, NOT DECIDING/.test(note) && /is NOT the criterion/.test(note));
ok('the ask-vs-mid caveat survives', /transact at the ask/.test(note));
ok('the "cell work is not what failed" paragraph survives',
   /THE CELL WORK IS NOT WHAT FAILED/.test(note));

// ---- a clause cannot be silently deleted ----------------------------
// SELFTEST: prove the clause checks can actually go red. A criterion
// missing clause 4 must fail the clause-4 arm.
const stripped = c.replace(/\(4\)[^\n]*\n?/, '');
ok('SELFTEST: the clause-4 check goes red when clause 4 is removed',
   /\(4\)[^\n]*AUC AT LEAST the market/.test(c)
   && !/\(4\)[^\n]*AUC AT LEAST the market/.test(stripped));

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
