#!/usr/bin/env node
// Mid-era gap checks on the whole 6AM snapshot chain (2026-09-12).
//   node scripts/test-snapshot-chain-gaps.js
// Exit 1 on any failure.
//
// Deliberately a SEPARATE file from test-weather-filter-and-gaps.js: that
// one covers the weatherFilter family and is edited by an open PR, and two
// PRs touching one test file is a merge conflict nobody needs.
//
// The load-bearing assertions:
//   (1) all five chain tables carry a gap check, not just woba
//   (2) the era starts at the DAILY REGIME, not the first row ever --
//       without which catcher_framing_snapshot reports 81 phantom gaps
//   (3) 2026-09-03 is named on every chain table (the whole-chain miss)
const Database = require('better-sqlite3');
const { checkPipelineFreshness, PIPELINES, SNAPSHOT_CHAIN, snapshotGapSql }
  = require('../utils/pipeline-freshness');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const db = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
const CHAIN = SNAPSHOT_CHAIN.map((t) => t.key);

console.log('1. the whole chain is declared, not just woba');
check('five chain tables', CHAIN.length, 5);
for (const k of CHAIN) {
  const p = PIPELINES.filter((x) => x.key === k)[0];
  check(k + ' is a pipeline with a gap check', !!(p && p.gaps && p.gaps.sql), true);
}
check('woba still has one too',
  !!PIPELINES.filter((x) => x.key === 'woba_data_snapshot')[0].gaps, true);
// One builder, six callers: a second spelling is how these drift apart.
const distinctSql = new Set(PIPELINES.filter((p) => p.gaps).map((p) => p.gaps.sql.replace(/\w+_snapshot/g, 'T')));
check('every gap query comes from the one builder', distinctSql.size, 1);

console.log('\n2. the era starts at the daily regime, not the first row');
// catcher_framing_snapshot: one lone capture 2026-06-03, an 83-day desert,
// then daily from 2026-08-25. This is the whole reason for the cadence rule.
const naiveSql = (t) =>
  'WITH era AS (SELECT MIN(snapshot_date) lo, MAX(snapshot_date) hi FROM ' + t + ') '
  + 'SELECT g.game_date AS d, COUNT(*) AS n FROM game_log g, era '
  + 'WHERE g.game_date > era.lo AND g.game_date < era.hi '
  + '  AND NOT EXISTS (SELECT 1 FROM ' + t + ' s WHERE s.snapshot_date = g.game_date) '
  + 'GROUP BY g.game_date';
const naive = db.prepare(naiveSql('catcher_framing_snapshot')).all().length;
const cadence = db.prepare(snapshotGapSql('catcher_framing_snapshot')).all().length;
console.log('     catcher_framing_snapshot: MIN..MAX era reports ' + naive
  + ' gaps, daily-regime era reports ' + cadence);
check('the MIN..MAX rule really does cry wolf here', naive > 50, true);
check('the cadence rule reports exactly the real one', cadence, 1);
check('and the woba result is UNCHANGED by the new rule (backward compatible)',
  db.prepare(snapshotGapSql('woba_data_snapshot')).all().length,
  db.prepare(naiveSql('woba_data_snapshot')).all().length);

console.log('\n3. 2026-09-03 is named on every chain table');
const r = checkPipelineFreshness(db, '2026-09-12');
for (const k of CHAIN) {
  const row = r.rows.filter((x) => x.key === k)[0];
  const dates = row.gaps && row.gaps.missing ? row.gaps.missing.map((g) => g.date) : [];
  check(k + ' names 2026-09-03', dates.indexOf('2026-09-03') > -1, true);
  check(k + ' gap check did not error', !!(row.gaps && !row.gaps.error), true);
}
const frv = r.rows.filter((x) => x.key === 'fielding_frv_snapshot')[0];
check('fielding_frv_snapshot also carries its own extra gap 2026-08-09',
  frv.gaps.missing.map((g) => g.date), ['2026-08-09', '2026-09-03']);

console.log('\n4. historical gaps do not turn the chain red');
for (const k of CHAIN) {
  const row = r.rows.filter((x) => x.key === k)[0];
  check(k + ' level ok (gaps are historical)', [row.gaps.level, row.gaps.recentCount], ['ok', 0]);
}
check('the run as a whole reports no new critical', r.crit, 0);

console.log('\n5. a RECENT chain miss escalates');
// Synthetic so the assertion does not depend on the calendar. Includes the
// lone-early-capture shape, so the cadence rule is exercised end to end.
const mem = new Database(':memory:');
mem.exec('CREATE TABLE game_log (game_date TEXT);'
  + CHAIN.map((k) => 'CREATE TABLE ' + k + ' (snapshot_date TEXT);').join('')
  + 'CREATE TABLE woba_data_snapshot (snapshot_date TEXT);');
const days = ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01'];
const addGame = mem.prepare('INSERT INTO game_log VALUES (?)');
for (const d of days) for (let i = 0; i < 12; i++) addGame.run(d);
for (const k of CHAIN.concat(['woba_data_snapshot'])) {
  const ins = mem.prepare('INSERT INTO ' + k + ' VALUES (?)');
  ins.run('2026-05-01');                 // lone early capture, must be ignored
  for (const d of days) if (d !== '2026-08-30') ins.run(d);   // one real hole
}
const memRun = checkPipelineFreshness(mem, '2026-09-01');
for (const k of CHAIN) {
  const row = memRun.rows.filter((x) => x.key === k)[0];
  check('synthetic ' + k, [row.gaps.missing.map((g) => g.date), row.gaps.recentCount, row.gaps.level],
    [['2026-08-30'], 1, 'STALE']);
}
check('synthetic: the lone 2026-05-01 capture produced no phantom gaps',
  memRun.rows.filter((x) => x.key === CHAIN[0])[0].gaps.missingCount, 1);

console.log('');
console.log('6. pitcher_batted_ball_snapshot freshness counts LIVE captures only');
// FOUNDING INSTANCE 2026-09-13: the prior_season backfill landed 626 rows
// stamped 2026-03-31 and /health went CRITICAL +166d on a pipeline whose
// live sync had never run once. An unfiltered MAX(snapshot_date) cannot
// tell a fixed historical load from a capture of that day.
const pbb = PIPELINES.filter((x) => x.key === 'pitcher_batted_ball_snapshot')[0];
check('the freshness query filters on source',
  pbb.sql.indexOf("source = 'live'") > -1, true);
check('it is still flagged awaitingFirstRun', pbb.awaitingFirstRun, true);

// The states, on the real column shape. APRIL GAME DATES MATTER: they are
// what a wrongly-placed era start would report as phantom gaps, so a
// fixture without them cannot tell the era rule working from the fixture
// simply having nothing to find.
function pbbFixture(rows, gameDates) {
  const m = new Database(':memory:');
  m.exec('CREATE TABLE game_log (game_date TEXT);'
    + 'CREATE TABLE pitcher_batted_ball_snapshot (snapshot_date TEXT, source TEXT);');
  const ag = m.prepare('INSERT INTO game_log VALUES (?)');
  const days = gameDates
    || ['2026-04-15', '2026-06-20', '2026-09-10', '2026-09-11', '2026-09-12'];
  for (const d of days) for (let i = 0; i < 12; i++) ag.run(d);
  const ins = m.prepare('INSERT INTO pitcher_batted_ball_snapshot VALUES (?,?)');
  for (const r of rows) ins.run(r[0], r[1]);
  const run = checkPipelineFreshness(m, '2026-09-12');
  return run.rows.filter((x) => x.key === 'pitcher_batted_ball_snapshot')[0];
}

const priorOnly = pbbFixture([['2026-03-31', 'prior_season']]);
check('prior_season only -> STALE (awaiting), not the +166d CRITICAL',
  [priorOnly.level, priorOnly.last], ['STALE', null]);
// The message is the other half of the fix: 626 rows ARE in the table, so
// the generic no-rows text would be a sentence that reads true and is not.
check('...and its detail does not claim the table is empty',
  [priorOnly.detail.indexOf('no LIVE capture yet') > -1,
   priorOnly.detail.indexOf('no rows') > -1], [true, false]);

const withLive = pbbFixture([['2026-03-31', 'prior_season'], ['2026-09-12', 'live']]);
check('a live capture today -> ok, and the live date is what was read',
  [withLive.level, withLive.last], ['ok', '2026-09-12']);

const staleLive = pbbFixture([['2026-03-31', 'prior_season'], ['2026-09-05', 'live']]);
check('a LATE live capture still escalates -- the filter did not mute the check',
  staleLive.level, 'CRITICAL');

// The gap query is deliberately NOT filtered; the era rule already
// excludes 2026-03-31 because the first live capture is ~166 days from it.
// This pair is what keeps that true: same April and June game dates in
// both, and the only difference is a second prior_season date.
const gapShape = pbbFixture([['2026-03-31', 'prior_season'],
  ['2026-09-10', 'live'], ['2026-09-11', 'live'], ['2026-09-12', 'live']]);
check('one prior_season date -> no phantom gaps, though April and June games exist',
  [gapShape.gaps.missingCount, gapShape.gaps.level], [0, 'ok']);
const twoPrior = pbbFixture([['2026-03-31', 'prior_season'], ['2026-04-02', 'prior_season'],
  ['2026-09-10', 'live'], ['2026-09-11', 'live'], ['2026-09-12', 'live']]);
check('DOCUMENTED LIMIT: two prior_season dates within cadence start the era early',
  twoPrior.gaps.missing.map(function (g) { return g.date; }),
  ['2026-04-15', '2026-06-20']);
console.log('     (one fixed SNAPSHOT_DATE per historical load keeps that unreachable;'
  + ' a second load would need a source predicate in the gap query)');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
