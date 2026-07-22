// Verify the demote-completion invariants in services/jobs.js's
// runOddsJob rewrite. Not a live-fetch test (that would require
// mocking three network services); instead this is a structural
// verification that:
//   1. The old demote loop (NULLing market_*_ml on unabated rows) is gone.
//   2. The old statsapi-authoritative filter gate is gone.
//   3. oddsRaw is now seeded from scheduleRows via a .map(...).
//   4. A Poly write path exists (getPolymarketMlbLines is called).
//   5. Coverage instrumentation ([odds-coverage] MISS) is present.
//   6. server.js /health includes odds_coverage.
//
// Plus a small direct exercise of the merge shape:
//   - Given a synthetic scheduleRows [{game_id, away, home}], build the
//     seeded oddsRaw shape and confirm all price fields start null.
//   - Given a synthetic unabatedRow, confirm the merge writes to
//     unabated_*/xcheck_* and leaves market_*_ml null.
//
// Run: node tmp/verify-demote-completion.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function assert(ok, label) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label);
  if (!ok) failed++;
}

console.log('\n== jobs.js structural checks ==');
const jobsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');

// 1. Old demote loop gone — the giveaway line was `o.market_away_ml = null;` inside a for-of over oddsRaw.
assert(!/for \(const o of oddsRaw\)[\s\S]{0,600}o\.market_away_ml = null;/.test(jobsSrc),
  'old demote loop (for o of oddsRaw { ... o.market_away_ml = null }) removed');

// 2. Old statsapi-authoritative gate removed. The signature was
//    `oddsRaw = oddsRaw.filter(o => { if (validIds.has(o.game_id)) return true; ...`
assert(!/oddsRaw = oddsRaw\.filter\(o => \{[\s\S]{0,120}validIds\.has\(o\.game_id\)/.test(jobsSrc),
  'old statsapi-authoritative filter gate removed');

// 3. New seed pattern present: oddsRaw = scheduleRows.map(g => ({ game_id: g.game_id, ...
assert(/oddsRaw\s*=\s*scheduleRows\.map\(g\s*=>\s*\(\{[\s\S]{0,80}game_id:\s*g\.game_id/.test(jobsSrc),
  'oddsRaw is seeded from scheduleRows.map(...)');

// 4. Poly-direct write path present — getPolymarketMlbLines call + market_away_ml assignment.
assert(/getPolymarketMlbLines\(dateStr\)/.test(jobsSrc),
  'jobs.js calls getPolymarketMlbLines');
assert(/o\.market_away_ml\s*=\s*awayMl[\s\S]{0,120}o\.ml_source\s*=\s*'polymarket'/.test(jobsSrc),
  'Poly-direct block writes market_away_ml and sets ml_source=polymarket');

// 5. Coverage instrumentation present.
assert(/\[odds-coverage\] MISS/.test(jobsSrc),
  'permanent [odds-coverage] MISS instrumentation present');

// 6. Unabated merge writes to unabated_*/xcheck_* but NOT market_*_ml.
assert(/o\.unabated_away_ml\s*=\s*u\.market_away_ml/.test(jobsSrc),
  'Unabated merge routes market_away_ml into unabated_away_ml (demote respected)');
{
  // Find the Unabated merge block and confirm it has no assignment to o.market_away_ml.
  const mergeMatch = jobsSrc.match(/Merge Unabated data into seeded oddsRaw[\s\S]{0,3000}/);
  const mergeSrc = mergeMatch ? mergeMatch[0] : '';
  assert(mergeMatch != null, 'Unabated merge block located');
  assert(!/o\.market_away_ml\s*=/.test(mergeSrc),
    'Unabated merge block does NOT assign to o.market_away_ml (demote intact)');
  assert(!/o\.market_home_ml\s*=/.test(mergeSrc),
    'Unabated merge block does NOT assign to o.market_home_ml');
  assert(!/o\.market_total\s*=/.test(mergeSrc),
    'Unabated merge block does NOT assign to o.market_total');
}

console.log('\n== server.js /health check extension ==');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(/odds_coverage/.test(serverSrc),
  '/health returns odds_coverage field');
assert(/market_away_ml IS NULL OR|market_away_ml != null && r\.market_home_ml != null/.test(serverSrc)
    || /market_away_ml.*IS NULL|market_away_ml == null|market_away_ml == null \|\| r\.market_home_ml == null/.test(serverSrc),
  '/health filters missing rows by market_away_ml/home_ml NULL check');

console.log('\n== end-to-end merge shape (isolated helper exercise) ==');
// Simulate the seed step and unabated merge without loading jobs.js
// (which pulls DB/cron/etc). Copy of the shape used in the fix.
function seedOddsRaw(scheduleRows) {
  return scheduleRows.map(g => ({
    game_id: g.game_id, awayTeam: g.away_team, homeTeam: g.home_team,
    market_away_ml: null, market_home_ml: null, market_total: null,
    over_price: null, under_price: null,
    ml_source: null, total_source: null,
    unabated_away_ml: null, unabated_home_ml: null, unabated_ml_source: null,
    xcheck_away_ml: null, xcheck_home_ml: null, xcheck_ml_source: null,
  }));
}
function mergeUnabated(oddsRaw, unabatedRows) {
  const byId = new Map();
  for (const o of oddsRaw) byId.set(o.game_id, o);
  for (const u of unabatedRows) {
    const o = byId.get(u.game_id);
    if (!o) continue;
    o.unabated_away_ml = u.market_away_ml != null ? u.market_away_ml : null;
    o.unabated_home_ml = u.market_home_ml != null ? u.market_home_ml : null;
    o.unabated_ml_source = u.ml_source || null;
    o.xcheck_away_ml = u.xcheck_away_ml != null ? u.xcheck_away_ml : null;
    o.xcheck_home_ml = u.xcheck_home_ml != null ? u.xcheck_home_ml : null;
    o.xcheck_ml_source = u.xcheck_ml_source || null;
    // note: does NOT assign to market_away_ml/market_home_ml
  }
}

// Scenario: statsapi has 4 games including a DH nightcap. Unabated only
// has 2 of them (missed the -g2 pair). Confirm oddsRaw retains all 4
// and market_*_ml stays null on the missed ones.
const scheduleRows = [
  { game_id: 'pit-nyy',    away_team: 'PIT', home_team: 'NYY' },
  { game_id: 'pit-nyy-g2', away_team: 'PIT', home_team: 'NYY' },
  { game_id: 'bal-bos',    away_team: 'BAL', home_team: 'BOS' },
  { game_id: 'bal-bos-g2', away_team: 'BAL', home_team: 'BOS' },
];
const unabatedRows = [
  { game_id: 'pit-nyy',    market_away_ml: 150, market_home_ml: -170, ml_source: 'novig',
    xcheck_away_ml: 148, xcheck_home_ml: -168, xcheck_ml_source: 'pinnacle' },
  { game_id: 'bal-bos',    market_away_ml: 120, market_home_ml: -140, ml_source: 'novig',
    xcheck_away_ml: 122, xcheck_home_ml: -142, xcheck_ml_source: 'pinnacle' },
];
const oddsRaw = seedOddsRaw(scheduleRows);
mergeUnabated(oddsRaw, unabatedRows);

assert(oddsRaw.length === 4, 'oddsRaw has all 4 scheduled games (including -g2 nightcaps Unabated missed)');
assert(oddsRaw.every(o => o.market_away_ml == null && o.market_home_ml == null),
  'market_*_ml is NULL on every row after Unabated merge (demote respected — even for rows Unabated DID cover)');

// Merged rows should have unabated_* populated; missed rows should have null unabated_*.
const g1 = oddsRaw.find(o => o.game_id === 'pit-nyy');
const g2 = oddsRaw.find(o => o.game_id === 'pit-nyy-g2');
assert(g1.unabated_away_ml === 150 && g1.unabated_home_ml === -170,
  'pit-nyy row has unabated_* filled from Unabated');
assert(g2.unabated_away_ml == null && g2.unabated_home_ml == null,
  'pit-nyy-g2 row (missed by Unabated) has unabated_* still null');
assert(g1.xcheck_away_ml === 148 && g1.xcheck_ml_source === 'pinnacle',
  'pit-nyy xcheck_* populated');
assert(g2.xcheck_away_ml == null && g2.xcheck_ml_source == null,
  'pit-nyy-g2 xcheck_* still null');

// Regression gate — an unabated_row for a phantom (not in schedule)
// should be dropped, not smuggled in.
const phantom = [{ game_id: 'xxx-yyy', market_away_ml: 100, market_home_ml: -100 }];
const oddsRaw2 = seedOddsRaw(scheduleRows);
mergeUnabated(oddsRaw2, [...unabatedRows, ...phantom]);
assert(oddsRaw2.length === 4, 'phantom Unabated game_id (xxx-yyy) is NOT added to oddsRaw');
assert(!oddsRaw2.find(o => o.game_id === 'xxx-yyy'), 'phantom row not present after merge');

console.log();
if (failed === 0) {
  console.log('✓ all invariants hold — demote completion is structurally sound');
  process.exit(0);
}
console.log(`✗ ${failed} assertion(s) failed`);
process.exit(1);
