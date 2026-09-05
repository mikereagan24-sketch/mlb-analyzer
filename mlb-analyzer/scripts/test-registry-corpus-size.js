#!/usr/bin/env node
/**
 * corpus_size is required on new feature-gate registry rows. (2026-09-05)
 *
 * A recorded criterion without an n is not re-runnable and not falsifiable.
 * The FRV row forced this: its figures were recorded on 790 games, the
 * weather-contamination backfill later cut the same window to 439, and
 * nothing on the row said which corpus produced the numbers -- so "not
 * significant" could not be told apart from "not significant on a corpus
 * that no longer exists".
 *
 * The check is a BASELINE ARM and fails in both directions:
 *   - a new row without corpus_size  -> the standard was ignored
 *   - a grandfathered row that GAINS one -> prune the exemption list
 *
 * The second half matters as much as the first. An accepted-failure list
 * nobody prunes is how a real regression hides inside a carried count.
 *
 * Run: node scripts/test-registry-corpus-size.js
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { GATES, checkCorpusSize, CORPUS_SIZE_GRANDFATHERED } =
  require(path.join(R, 'services/feature-gate-registry'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== registry corpus_size standard ===');

const r = checkCorpusSize();
console.log('  ' + r.total + ' rows, ' + r.grandfathered + ' grandfathered, '
  + (r.total - r.grandfathered) + ' under the standard');

ok('every non-grandfathered row carries corpus_size',
   r.missing.length === 0,
   r.missing.length ? 'MISSING: ' + r.missing.join(', ') : 'none missing');
ok('no grandfathered row has gained corpus_size (prune the list if it has)',
   r.unexpected.length === 0,
   r.unexpected.length ? 'PRUNE: ' + r.unexpected.join(', ') : 'list still accurate');
ok('every corpus_size is a positive number or an explicit null',
   r.bad.length === 0,
   r.bad.length ? 'MALFORMED: ' + r.bad.join(', ') : 'none malformed');

// The grandfather list must describe the registry, not drift from it.
const ids = GATES.map(g => g.id);
const stale = CORPUS_SIZE_GRANDFATHERED.filter(id => ids.indexOf(id) === -1);
ok('grandfather list contains no ids that left the registry',
   stale.length === 0, stale.length ? 'STALE: ' + stale.join(', ') : 'all present');

// The detector must be able to fail. A check that cannot go red is not a
// check -- this is the same reason verify-commits-landed.js has --selftest.
const synthetic = GATES.concat([{ id: '__synthetic_new_row__', criterion: 'x' }]);
const s = checkCorpusSize(synthetic);
ok('DETECTOR SELFTEST: a new row with no corpus_size is caught',
   s.missing.indexOf('__synthetic_new_row__') !== -1 && !s.ok,
   'flagged ' + s.missing.length + ' row(s)');
const s2 = checkCorpusSize(GATES.concat([{ id: '__synthetic_bad__', corpus_size: 'lots' }]));
ok('DETECTOR SELFTEST: a malformed corpus_size is caught',
   s2.bad.some(x => x.indexOf('__synthetic_bad__') === 0) && !s2.ok);
const s3 = checkCorpusSize(GATES.concat([{ id: '__synthetic_null__', corpus_size: null }]));
ok('an explicit null is ACCEPTED (a gate with no corpus yet is honest)',
   !s3.missing.length && !s3.bad.length);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
