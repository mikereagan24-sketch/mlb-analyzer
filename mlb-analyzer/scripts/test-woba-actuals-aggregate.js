// The actuals pull returns ONE row per player, and a duplicate is now an
// error rather than a silent overwrite.
//
// THE DEFECT. services/fangraphs.js asked FG for strGroup:'season' over a
// rolling TWO-YEAR window. That returns one row per player per SEASON --
// ~1.5 rows per player -- and q.upsertWoba is
// ON CONFLICT(data_key, player_name) DO UPDATE, so each player's first
// season was silently overwritten by the second. Stored samples were ONE
// SEASON while services/fangraphs.js documented them as the two-year
// cumulative figure that MIN_BF=100 and MIN_PA=60 are calibrated against.
//
// Evidence it was real, both from our own data:
//   upload_log vs woba_data   804 CSV rows stored as 539 (pit-act-rhb);
//                             661 -> 418 (bat-act-rhp)
//   stored / current-season   median 0.94 across 490 pitchers, i.e. one
//   batters-faced             season, not two
//
// VERIFIED FIX, against a real FG response rather than an assumption
// (scripts/probe-fg-strgroup.js, 2026-09-22, split 5 = vs LHB):
//   strGroup='season'  723 rows  Tidwell Season 2026    TBF 123 wOBA .3813
//   strGroup='career'  466 rows  Tidwell Season "Total" TBF 154 wOBA .3878
//   'total' | 'all' | ''                                HTTP 500
// 154 / .388 matches FanGraphs' own career splits page for him vs L.
//
// WHAT THIS PINS:
//   1. the request sends strGroup:'career' and still sends the two-year
//      window (the fix is aggregation, not a range change);
//   2. a duplicate player_name is REJECTED, naming the offenders;
//   3. the rejection ROLLS BACK -- the previous good upload survives,
//      because the clear now lives inside the transaction. Before this,
//      the clear ran first in routes/api.js and a failed ingest left the
//      key empty;
//   4. expansion (bare / name+team / stripped+team) does NOT trip the
//      duplicate check, since those are different player_name values;
//   5. a clean batch still replaces the key wholesale.
//
// Synthetic data_key so no real key is touched. Takes `db` from
// db/schema -- never a second write connection.
//
// Run: node --max-old-space-size=1536 scripts/test-woba-actuals-aggregate.js

const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const { db, q } = require(path.join(R, 'db/schema'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const KEY = 'zz-test-act-rhb';
const rowsOf = () => db.prepare('SELECT player_name, woba, sample_size FROM woba_data '
  + 'WHERE data_key=? ORDER BY player_name').all(KEY);
function cleanup() {
  try { db.prepare('DELETE FROM woba_data WHERE data_key=?').run(KEY); } catch (e) {}
}

function main() {
  console.log('\n1. the request asks FG to aggregate, and keeps the two-year window');
  const fg = fs.readFileSync(path.join(R, 'services/fangraphs.js'), 'utf8');
  expect("strGroup is 'career'", /strGroup: 'career',/.test(fg));
  expect("...and 'season' is gone from the body", !/strGroup: 'season',/.test(fg));
  expect('the two-year range is still what is sent',
    /strStartDate: start,/.test(fg) && /strEndDate: end,/.test(fg)
    && /twoYearDateRange\(\)/.test(fg));
  expect('the verified response is recorded next to the change',
    /Season "Total", TBF 154/.test(fg) && /HTTP 500/.test(fg));
  // THE QUALIFIER. strAutoPt:'true' was the real cause of the shortfall:
  // it dropped whole players from the aggregate AND whole seasons from
  // the per-season response, so a client-side sum could not recover them
  // either (Tidwell summed to 99 BF against a career 146). Verified
  // 2026-09-22: career+false returns 1158 players and Tidwell vs RHB at
  // 146 / .2824, exactly FanGraphs' career page.
  expect("strAutoPt is 'false' -- FG's automatic qualifier is OFF",
    /strAutoPt: 'false',/.test(fg));
  expect("...and 'true' is gone", !/strAutoPt: 'true',/.test(fg));
  expect('the qualifier evidence is recorded at the site',
    /TBF 146  wOBA \.2824/.test(fg) && /1158/.test(fg));
  expect('and why client-side summing cannot substitute',
    fg.indexOf('returned season rows gives 99 BF') !== -1);

  cleanup();
  try {
    console.log('\n2. a clean batch writes, and replaces the key wholesale');
    q.upsertWobaBatch(KEY, [
      { name: 'Zzt Alpha', woba: 0.300, sample: 150 },
      { name: 'Zzt Alpha SEA', woba: 0.300, sample: 150 },   // expansion form
      { name: 'Zzt Beta', woba: 0.320, sample: 200 },
    ]);
    expect('3 rows written', rowsOf().length === 3, rowsOf().length + ' row(s)');
    q.upsertWobaBatch(KEY, [{ name: 'Zzt Gamma', woba: 0.280, sample: 120 }]);
    const after = rowsOf();
    expect('a second batch REPLACES rather than accumulates',
      after.length === 1 && after[0].player_name === 'Zzt Gamma',
      after.length + ' row(s): ' + after.map(r => r.player_name).join(','));

    console.log('\n3. expansion forms do not trip the duplicate check');
    let threw = null;
    try {
      q.upsertWobaBatch(KEY, [
        { name: 'Zzt Delta Jr.', woba: 0.310, sample: 111 },
        { name: 'Zzt Delta Jr. TOR', woba: 0.310, sample: 111 },
        { name: 'Zzt Delta TOR', woba: 0.310, sample: 111 },
      ]);
    } catch (e) { threw = e.message; }
    expect('three DIFFERENT name forms for one player are accepted', threw === null,
      threw || 'no throw');
    expect('...and all three landed', rowsOf().length === 3, rowsOf().length + ' row(s)');

    console.log('\n4. a duplicate player_name is REJECTED and named');
    const good = rowsOf();
    let msg = null;
    try {
      q.upsertWobaBatch(KEY, [
        { name: 'Zzt Tidwell', woba: 0.382, sample: 60 },    // the 2025 row
        { name: 'Zzt Tidwell', woba: 0.212, sample: 86 },    // the 2026 row
        { name: 'Zzt Other', woba: 0.300, sample: 150 },
      ]);
    } catch (e) { msg = e.message; }
    expect('the batch throws', !!msg, msg ? 'threw' : 'DID NOT THROW');
    expect('the message names the offending player', !!msg && /Zzt Tidwell/.test(msg));
    expect('...carries BOTH samples, so a split is distinguishable from a repeat',
      !!msg && /60 vs 86|86 vs 60/.test(msg), msg ? msg.slice(-90) : '');
    expect('...and says where to look', !!msg && /strGroup/.test(msg));
    expect('...and explains the consequence, not just the fact',
      !!msg && /subset, not the/.test(msg));

    console.log('\n5. the rejection rolls back -- the previous upload survives');
    const nowRows = rowsOf();
    expect('the key still holds the last GOOD batch, not an empty table',
      nowRows.length === good.length,
      nowRows.length + ' row(s), was ' + good.length);
    expect('...and the same rows', JSON.stringify(nowRows) === JSON.stringify(good));
    expect('no partial write from the rejected batch leaked in',
      !nowRows.some(r => /Zzt Tidwell|Zzt Other/.test(r.player_name)),
      nowRows.map(r => r.player_name).join(','));

    console.log('\n6. the clear is inside the transaction, not before the call');
    const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
    expect('ingestWobaCSV no longer clears the key itself',
      !/^\s*q\.clearWobaKey\.run\(key\);/m.test(api));
    const sch = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
    const batch = sch.slice(sch.indexOf('q.upsertWobaBatch = '),
      sch.indexOf('q.upsertWobaBatch = ') + 1800);
    expect('upsertWobaBatch deletes inside its own transaction',
      /db\.transaction\(\([\s\S]{0,120}DELETE FROM woba_data WHERE data_key/.test(batch));
  } finally {
    cleanup();
  }
  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
