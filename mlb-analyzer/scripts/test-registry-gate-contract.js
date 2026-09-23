#!/usr/bin/env node
/**
 * The feature-gate registry's own contract, enforced. (2026-09-23)
 *
 * The registry is the stated source of truth for "why is this off", and
 * until now its contract lived entirely in prose at the top of the file.
 * evaluateGates() reports a gate whose window has ELAPSED with no decision;
 * it says nothing about a gate that never had a window, so "nobody set a
 * deadline" and "no deadline is appropriate" looked identical.
 *
 * THREE ARMS:
 *
 *   1. DEADLINE OR DECISION. Every row has a decision, OR an unelapsed
 *      window_end, OR an entry in NO_DEADLINE_ACKNOWLEDGED. That list is
 *      seeded with exactly the six rows already in that state and is a
 *      RECORD OF WHAT WAS THERE, not an escape hatch: a new row with
 *      neither a decision nor a window fails this arm.
 *
 *      Every entry also needs a non-empty reason. If a reason cannot be
 *      written, the row wants a window rather than an exemption -- which is
 *      why two of the six carry wants_window:true and are reported on every
 *      run as a standing finding.
 *
 *   2. corpus_size, the #360 standard. Delegated to checkCorpusSize() so
 *      there is one implementation; scripts/test-registry-corpus-size.js
 *      exercises it in depth and this arm asserts the headline.
 *
 *   3. NO DECISION WITHOUT A CRITERION. A recorded outcome against a null
 *      criterion is a decision nobody can re-derive -- the same defect as a
 *      criterion with no n, one field over.
 *
 * BOTH-DIRECTIONS, like the corpus_size arm: an acknowledged row that GAINS
 * a decision or a window must be pruned from the list, or the exemption
 * outlives the reason for it.
 *
 * Run: node --max-old-space-size=1536 scripts/test-registry-gate-contract.js
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { GATES, checkCorpusSize, NO_DEADLINE_ACKNOWLEDGED } =
  require(path.join(R, 'services/feature-gate-registry'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

// Today, as a date string, so an elapsed window is decided by the clock
// rather than by a hardcoded date that itself goes stale.
const TODAY = new Date().toISOString().slice(0, 10);
const ackById = new Map(NO_DEADLINE_ACKNOWLEDGED.map((e) => [e.id, e]));
const hasDecision = (g) => !!(g.decision && g.decision.outcome);
const windowUnelapsed = (g) => !!(g.window_end && String(g.window_end) >= TODAY);

console.log('=== registry gate contract ===');
console.log('  ' + GATES.length + ' rows, ' + ackById.size
  + ' acknowledged as deadline-less, today ' + TODAY);

// ---------------------------------------------------------------- arm 1
console.log('\n1. every row has a decision, an unelapsed window, or an acknowledgement');
const naked = GATES.filter((g) =>
  !hasDecision(g) && !windowUnelapsed(g) && !ackById.has(g.id));
ok('no row has neither a decision nor a deadline nor an entry',
   naked.length === 0,
   naked.length ? 'NAKED: ' + naked.map((g) => g.id).join(', ') : 'none');

// elapsed window with no decision is what evaluateGates already reports;
// assert it here too so the contract is stated in one place.
const elapsedUndecided = GATES.filter((g) =>
  !hasDecision(g) && g.window_end && String(g.window_end) < TODAY);
ok('no row has an ELAPSED window and no decision',
   elapsedUndecided.length === 0,
   elapsedUndecided.length
     ? 'ELAPSED: ' + elapsedUndecided.map((g) => g.id + ' (' + g.window_end + ')').join(', ')
     : 'none');

console.log('\n2. the acknowledgement list is honest and current');
const noReason = NO_DEADLINE_ACKNOWLEDGED.filter((e) =>
  !e.reason || !String(e.reason).trim());
ok('every acknowledged row carries a reason',
   noReason.length === 0,
   noReason.length ? 'NO REASON: ' + noReason.map((e) => e.id).join(', ')
                   : 'all ' + NO_DEADLINE_ACKNOWLEDGED.length + ' have one');
const ghosts = NO_DEADLINE_ACKNOWLEDGED.filter((e) => !GATES.some((g) => g.id === e.id));
ok('no acknowledged id has left the registry',
   ghosts.length === 0,
   ghosts.length ? 'GONE: ' + ghosts.map((e) => e.id).join(', ') : 'all present');
// both-directions: a row that gained a decision or a window must be pruned
const outgrown = NO_DEADLINE_ACKNOWLEDGED.filter((e) => {
  const g = GATES.find((x) => x.id === e.id);
  return g && (hasDecision(g) || g.window_end);
});
ok('no acknowledged row has gained a decision or a window (prune it if it has)',
   outgrown.length === 0,
   outgrown.length ? 'PRUNE: ' + outgrown.map((e) => e.id).join(', ') : 'list still accurate');
const dupes = NO_DEADLINE_ACKNOWLEDGED.map((e) => e.id)
  .filter((id, i, a) => a.indexOf(id) !== i);
ok('no duplicate entries', dupes.length === 0, dupes.join(', '));

// ---------------------------------------------------------------- arm 2
console.log('\n3. corpus_size, the #360 standard');
const cs = checkCorpusSize();
ok('every non-grandfathered row carries corpus_size',
   cs.missing.length === 0,
   cs.missing.length ? 'MISSING: ' + cs.missing.join(', ')
                     : (cs.total - cs.grandfathered) + ' rows under the standard, none missing');
ok('no grandfathered row has gained corpus_size',
   cs.unexpected.length === 0,
   cs.unexpected.length ? 'PRUNE: ' + cs.unexpected.join(', ') : 'list still accurate');

// ---------------------------------------------------------------- arm 3
console.log('\n4. no decision without a criterion');
const decidedNoCriterion = GATES.filter((g) =>
  hasDecision(g) && (g.criterion == null || !String(g.criterion).trim()));
ok('every row carrying a decision states the criterion it was decided against',
   decidedNoCriterion.length === 0,
   decidedNoCriterion.length
     ? 'NO CRITERION: ' + decidedNoCriterion.map((g) => g.id).join(', ')
     : GATES.filter(hasDecision).length + ' decided rows, all with a criterion');
// a decision also needs a date and an outcome to be re-derivable
const thinDecision = GATES.filter((g) => g.decision
  && (!g.decision.date || !g.decision.outcome));
ok('every decision carries a date and an outcome',
   thinDecision.length === 0,
   thinDecision.length ? 'THIN: ' + thinDecision.map((g) => g.id).join(', ') : 'none thin');

// ---------------------------------------------------------- selftests
// A checker that has never failed is one being trusted on inspection.
console.log('\n5. DETECTOR SELFTESTS');
{
  const fake = { id: 'zz_new_gate_no_deadline', decision: null, window_end: null };
  const probe = [...GATES, fake].filter((g) =>
    !hasDecision(g) && !windowUnelapsed(g) && !ackById.has(g.id));
  ok('a NEW row with no decision and no window is caught',
     probe.length === 1 && probe[0].id === fake.id,
     'flagged ' + probe.length + ' row(s)');
}
{
  const fake = { id: 'zz_decided_no_criterion', criterion: null,
    decision: { date: '2026-09-23', outcome: 'enabled' } };
  const probe = [...GATES, fake].filter((g) =>
    hasDecision(g) && (g.criterion == null || !String(g.criterion).trim()));
  ok('a decision against a null criterion is caught',
     probe.length === 1 && probe[0].id === fake.id, 'flagged ' + probe.length);
}
{
  const fake = { id: 'zz_elapsed', decision: null, window_end: '2020-01-01' };
  const probe = [...GATES, fake].filter((g) =>
    !hasDecision(g) && g.window_end && String(g.window_end) < TODAY);
  ok('an elapsed window with no decision is caught',
     probe.length === 1 && probe[0].id === fake.id, 'flagged ' + probe.length);
}

// ------------------------------------------------ standing finding
// Not a failure. A check that fails on a state nobody can fix today trains
// the reader to skip it; a state nobody has decided still has to stay
// visible, and this is how.
const wantWindow = NO_DEADLINE_ACKNOWLEDGED.filter((e) => e.wants_window);
console.log('\n=== STANDING FINDING: ' + wantWindow.length
  + ' acknowledged row(s) want a window, not an exemption ===');
for (const e of wantWindow) {
  console.log('  ' + e.id);
  console.log('     ' + e.reason);
}
if (wantWindow.length) {
  console.log('  These are exempted to keep the check green while they are undecided.');
  console.log('  Each needs either a window_end or a recorded decision; when one lands,');
  console.log('  arm 2 above FAILS until the entry is pruned.');
}

console.log('\n' + (failures === 0 ? 'OK' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
