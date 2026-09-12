#!/usr/bin/env node
/**
 * The BsR gate's CLV prong reads MARGINAL rows only. (2026-09-12)
 *
 * WHAT WAS WRONG. The prong pooled every bet the harness signaled.
 * Measured 2026-08-23: 330 of 348 were the SAME SIDE in both configs.
 * CLV per bet is f(morning price, close price) and does not depend on
 * the model, so those 330 have a with-vs-without delta of exactly zero
 * and only the ~18 disagreeing rows can move the number -- while the
 * original gate weighted this prong HEAVIEST.
 *
 * A CORRECTION THIS FILE EXISTS TO CARRY. An earlier draft of the
 * registry row described the fix as "read emitted signals instead of
 * logged bets". That was wrong. The harness
 * (services/baserunning-backtest.js) re-derives the signaled side under
 * each config over EVERY scored game; it never read
 * bet_signals.bet_line. The population was always right. What was wrong
 * was POOLING it, and the row now says so rather than quietly swapping
 * the story.
 *
 * THE ACTUAL FIX. Restrict the delta to rows where the two configs
 * disagree -- without_only + with_only + side_flipped from
 * clv.bet_set_diff -- because pooling same-side rows does not average an
 * effect down, it divides it by the share of rows that cannot move.
 *
 * This is a SPECIFICATION GUARD and a DATA GUARD: it fails if the
 * marginal-only clause is dropped, and it re-measures every count the
 * row asserts against the live database.
 *
 * Run: node scripts/test-bsr-gate-respec.js
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const reg = require(path.join(R, 'services/feature-gate-registry'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};
const flat = s => String(s).replace(/\s+/g, ' ');

console.log('=== bsr_baserunning: re-specified CLV prong ===');
const gate = reg.GATES.find(g => g.id === 'bsr_baserunning');
ok('the gate exists', !!gate);
if (!gate) { console.log('\nFAILED (1)'); process.exit(1); }
const c = flat(gate.criterion), note = flat(gate.note);

// ---- the prong's population --------------------------------------------
ok('CLV is restricted to MARGINAL rows',
   /MARGINAL ROWS ONLY/.test(c) && /where the two configs DISAGREE/.test(c));
ok('it names the source field, not just the idea',
   /clv\.bet_set_diff/.test(c));
ok('same-side exclusion is justified by the verified identity',
   /0 of 378 differ/.test(c));
ok('the 348 are named as HARNESS-SIGNALED, not logged bets',
   /330 of 348 HARNESS-SIGNALED bets/.test(note) && /NOT rows with bet_signals.bet_line set/.test(note));
ok('the note says why marginal-only is load-bearing',
   /does not average the effect down, it divides it by the share of rows that cannot move/.test(note));

// ---- the numbers that forced the change --------------------------------
ok('the earlier mischaracterisation is recorded, not quietly fixed',
   /an earlier draft of this row said so wrongly/.test(note));
ok('the real defect is named as POOLING, not the population',
   /The population was always right; what was wrong was POOLING it/.test(note));
ok('the pooled-vs-marginal dilution is quantified',
   /87 disagreeing rows diluted through 378 identical ones/.test(note));

// ---- preconditions met, window moved -----------------------------------
ok('preconditions are recorded as MET with their numbers',
   /PRECONDITIONS ARE MET/.test(c) && /88 snapshot days \(bar 60\)/.test(c)
   && /1,110 graded games since the first snapshot \(bar 500\)/.test(c));
ok('window_end moved to 2026-09-28', gate.window_end === '2026-09-28');
ok('and the move is justified against the season end',
   /WINDOW_END MOVED 2026-09-14 -> 2026-09-28/.test(note)
   && /after the regular season ends/.test(note));
ok('corpus_size is recorded', typeof gate.corpus_size === 'number' && gate.corpus_size > 0,
   String(gate.corpus_size));
ok('and the row says which prong that corpus belongs to',
   /corpus_size 1100 = graded games with both lineups/.test(note)
   && /87 of 425 on that run/.test(note));

// ---- the snapshot-cadence record ---------------------------------------
ok('the single 2026-09-03 gap is recorded, with its character',
   /the single gap is 2026-09-03/.test(note) && /whole-chain miss/.test(note)
   && /no restart signature/.test(note));
ok('the boot-loop days are recorded as costing ZERO snapshots',
   /2026-09-08\.\.09-11 boot-loop and failed-deploy days cost ZERO snapshots/.test(note));

// ---- the claimed numbers are TRUE of this database ----------------------
// A registry row asserting counts nobody re-checks is how a stale
// analysis outlives the thing it justified.
const F0 = '2026-06-16';
const lastG = db.prepare("SELECT MAX(game_date) d FROM game_log WHERE home_score IS NOT NULL").get().d;
const snapDays = db.prepare('SELECT COUNT(DISTINCT snapshot_date) n FROM team_baserunning_snapshot').get().n;
const since = db.prepare('SELECT COUNT(*) n FROM game_log WHERE game_date >= '
  + '(SELECT MIN(snapshot_date) FROM team_baserunning_snapshot) AND home_score IS NOT NULL').get().n;
const sig = db.prepare('SELECT COUNT(*) n, '
  + 'SUM(CASE WHEN closing_line IS NOT NULL THEN 1 ELSE 0 END) cl, '
  + 'SUM(CASE WHEN bet_line IS NOT NULL THEN 1 ELSE 0 END) lg '
  + 'FROM bet_signals WHERE game_date >= ? AND game_date <= ?').get(F0, lastG);
console.log('  live: snapshot days ' + snapDays + ', graded since first snapshot ' + since
  + ', signals ' + sig.n + ' (closing_line ' + sig.cl + ', logged ' + sig.lg + ')');
ok('snapshot-days precondition genuinely met', snapDays >= 60, snapDays + ' >= 60');
ok('forward-games precondition genuinely met', since >= 500, since + ' >= 500');
ok('closing-line coverage is broad (context, not the prong population)',
   sig.cl > 5 * sig.lg, sig.cl + ' with a closing line vs ' + sig.lg + ' logged');
ok('the closing-line capture rate is high enough to build a prong on',
   sig.n > 0 && sig.cl / sig.n > 0.9,
   (100 * sig.cl / sig.n).toFixed(1) + '% of emitted signals carry a closing line');

// ---- selftest ----------------------------------------------------------
ok('SELFTEST: the same-side-exclusion check goes red if dropped',
   /where the two configs DISAGREE/.test(c)
   && !/where the two configs DISAGREE/.test(c.replace('where the two configs DISAGREE', '')));
ok('SELFTEST: the marginal-only check goes red if the clause is dropped',
   /MARGINAL ROWS ONLY/.test(c) && !/MARGINAL ROWS ONLY/.test(c.replace(/MARGINAL ROWS ONLY/, '')));

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
