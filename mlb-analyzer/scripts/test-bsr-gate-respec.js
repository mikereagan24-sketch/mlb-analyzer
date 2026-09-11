#!/usr/bin/env node
/**
 * The BsR gate's CLV prong reads emitted signals, not logged bets.
 * (2026-09-12)
 *
 * WHAT WAS WRONG. The prong measured with-vs-without BsR over LOGGED
 * bets. Measured 2026-08-23: 330 of 348 logged bets were the SAME SIDE
 * in both configs and contribute exactly zero to the delta, leaving ~41
 * marginal bets to carry a prong the original gate weighted HEAVIEST.
 *
 * WHY WAITING COULD NOT FIX IT. Logged bets arrive at roughly 2.2/day,
 * so the marginal subset grows by about a quarter of a bet per day.
 * Neither this season nor the next reaches a resolvable n. It is the
 * wrong population, not a small one.
 *
 * THE FIX. Read every EMITTED signal against the closing line captured
 * for it at lock -- 1,812 rows in the forward window against 191 logged
 * bets -- and restrict the delta to MARGINAL rows, the ones whose side
 * or price actually differs between configs.
 *
 * This is a SPECIFICATION GUARD. It fails if the prong drifts back to
 * logged bets, or if "marginal rows only" is dropped, because pooling
 * same-side rows does not average an effect down -- it divides it by
 * the share of rows that cannot move.
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
ok('CLV reads ALL EMITTED SIGNALS against captured closing lines',
   /FORWARD-HONEST CLV over ALL EMITTED SIGNALS against their captured closing lines/.test(c));
ok('it names the columns, not just the idea',
   /bet_signals\.closing_line \/ clv/.test(c));
ok('it explicitly STOPS reading logged bets',
   /no longer reads LOGGED BETS \(bet_line IS NOT NULL\)/.test(c));
ok('MARGINAL ROWS ONLY is in the criterion, not only the note',
   /MARGINAL ROWS ONLY/.test(c) && /side or price actually differs/.test(c));
ok('the note says why marginal-only is load-bearing',
   /does not average the effect down, it divides it by the share of rows that cannot move/.test(note));

// ---- the numbers that forced the change --------------------------------
ok('the 330-of-348 finding is recorded',
   /330 of 348 logged bets were the SAME SIDE/.test(note) && /~41 marginal bets/.test(note));
ok('and that it is unresolvable at any reachable n',
   /cannot deliver a resolvable n/.test(note)
   && /wrong population/.test(note));
ok('the two populations are quantified side by side',
   /1,812 rows with a closing line against 191 logged bets/.test(note));

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
   && /CLV prong s population is the 1,812/.test(note));

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
ok('emitted-with-closing-line dwarfs logged bets', sig.cl > 5 * sig.lg,
   sig.cl + ' vs ' + sig.lg + ' — the reason the population changed');
ok('the closing-line capture rate is high enough to build a prong on',
   sig.n > 0 && sig.cl / sig.n > 0.9,
   (100 * sig.cl / sig.n).toFixed(1) + '% of emitted signals carry a closing line');

// ---- selftest ----------------------------------------------------------
ok('SELFTEST: the logged-bets check goes red if the prong drifts back',
   /no longer reads LOGGED BETS/.test(c)
   && !/no longer reads LOGGED BETS/.test(c.replace(/no longer reads LOGGED BETS[^.]*\./, '')));
ok('SELFTEST: the marginal-only check goes red if the clause is dropped',
   /MARGINAL ROWS ONLY/.test(c) && !/MARGINAL ROWS ONLY/.test(c.replace(/MARGINAL ROWS ONLY/, '')));

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
