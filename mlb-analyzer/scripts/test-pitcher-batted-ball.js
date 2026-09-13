#!/usr/bin/env node
// Pitcher batted-ball ingest (2026-09-12).
//   node scripts/test-pitcher-batted-ball.js
// Exit 1 on any failure.
//
// WHAT THIS CAN AND CANNOT PROVE. Reaching the FanGraphs splits endpoint
// needs an authenticated Member session, so the live payload shape is NOT
// verified here -- that is what the first cron run and the freshness row
// are for. What IS verified: the client extension leaves every existing
// caller byte-identical, the parser fails LOUDLY on a shape it does not
// recognise rather than writing nulls, the unit normalisation is decided by
// the GB+FB+LD identity rather than by an assumption, and the storage keeps
// the two splits apart with an as-of lookup that cannot see the future.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const fg = require('../services/fangraphs');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('1. the client was EXTENDED, not duplicated');
const fgSrc = read('services/fangraphs.js');
check('one fetcher for the splits endpoint',
  (fgSrc.match(/async function fetchActualSplit\b/g) || []).length, 1);
check('strType is overridable, default unchanged',
  /strType: o\.strType != null \? String\(o\.strType\) : \(position === 'P' \? '1' : '2'\)/.test(fgSrc), true);
// Not a guessed ceiling: count the authenticated fetch sites on main and
// assert this branch added none. A magic number here would either pass
// vacuously or break the next time an unrelated endpoint is added.
let fetchSitesOnMain = null;
try {
  const { execFileSync } = require('child_process');
  const mainSrc = execFileSync('git', ['show', 'origin/main:mlb-analyzer/services/fangraphs.js'],
    { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  fetchSitesOnMain = (mainSrc.match(/await fetch\(url/g) || []).length;
} catch (e) {
  failures++;
  console.log('  FAIL  could not read fangraphs.js from origin/main: ' + e.message.split('\n')[0]);
}
if (fetchSitesOnMain != null) {
  check('added no new authenticated fetch site (' + fetchSitesOnMain + ' on main)',
    (fgSrc.match(/await fetch\(url/g) || []).length, fetchSitesOnMain);
}
// Asserted on the ARGUMENTS, not the line layout — the first version of
// this pinned the exact one-line formatting and broke the moment the call
// gained the start/end passthrough, which told me nothing true.
const bbCall = fgSrc.slice(fgSrc.indexOf('const rows = await fetchActualSplit('),
  fgSrc.indexOf('const rows = await fetchActualSplit(') + 220);
check('batted-ball goes through fetchActualSplit', /fetchActualSplit\(/.test(bbCall), true);
check('  asking for the batted-ball panel', /strType: '3'/.test(bbCall), true);
check('  as raw rows', /raw: true/.test(bbCall), true);
check('  for pitchers', /'P'/.test(bbCall), true);

console.log('\n2. units are decided by GB+FB+LD, not by assumption');
const n = fg._normaliseShares;
check('percent points (44.2/31.1/24.7) -> fractions',
  n(44.2, 31.1, 24.7).scale, 'pct_points');
check('  and the values divide by 100', Number(n(44.2, 31.1, 24.7).gb.toFixed(4)), 0.442);
check('fractions (0.442/0.311/0.247) pass through',
  [n(0.442, 0.311, 0.247).scale, n(0.442, 0.311, 0.247).gb], ['fraction', 0.442]);
check('a set summing to neither is REJECTED, not coerced', n(44.2, 3.1, 2.4), null);
check('and so is a zero row', n(0, 0, 0), null);

console.log('\n3. storage: splits kept apart, as-of cannot see the future');
const mem = new Database(':memory:');
mem.exec(`CREATE TABLE pitcher_batted_ball_snapshot (
  snapshot_date TEXT NOT NULL, mlb_id INTEGER NOT NULL, split TEXT NOT NULL,
  name TEXT, gb_pct REAL, fb_pct REAL, ld_pct REAL, sample_tbf INTEGER,
  PRIMARY KEY (snapshot_date, mlb_id, split))`);
const ins = mem.prepare('INSERT INTO pitcher_batted_ball_snapshot VALUES (?,?,?,?,?,?,?,?)');
ins.run('2026-08-01', 700, 'vs_lhb', 'P', 0.55, 0.25, 0.20, 300);
ins.run('2026-08-01', 700, 'vs_rhb', 'P', 0.40, 0.38, 0.22, 320);
ins.run('2026-09-01', 700, 'vs_lhb', 'P', 0.60, 0.21, 0.19, 420);
const asOf = mem.prepare('SELECT gb_pct, snapshot_date FROM pitcher_batted_ball_snapshot '
  + 'WHERE mlb_id=? AND split=? AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1');
check('the two splits are stored separately, not blended',
  mem.prepare("SELECT COUNT(DISTINCT split) c FROM pitcher_batted_ball_snapshot WHERE mlb_id=700").get().c, 2);
check('as-of 2026-08-15 returns the AUGUST profile',
  asOf.get(700, 'vs_lhb', '2026-08-15').snapshot_date, '2026-08-01');
check('as-of 2026-09-15 returns the SEPTEMBER profile',
  asOf.get(700, 'vs_lhb', '2026-09-15').snapshot_date, '2026-09-01');
check('as-of a date before any snapshot returns nothing',
  asOf.get(700, 'vs_lhb', '2026-07-01'), undefined);
check('a missing date reaches BACK, never forward — the quiet failure the gap hook exists for',
  asOf.get(700, 'vs_lhb', '2026-08-31').snapshot_date, '2026-08-01');

console.log('\n4. the live schema and statements');
const { db, q } = require('../db/schema');
for (const t of ['pitcher_batted_ball', 'pitcher_batted_ball_snapshot']) {
  check(t + ' exists',
    !!db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(t), true);
}
const pk = db.prepare('PRAGMA table_info(pitcher_batted_ball)').all().filter((c) => c.pk > 0).map((c) => c.name);
check('live PK is (mlb_id, split)', pk, ['mlb_id', 'split']);
const snapPk = db.prepare('PRAGMA table_info(pitcher_batted_ball_snapshot)').all().filter((c) => c.pk > 0).map((c) => c.name);
check('snapshot PK is (snapshot_date, mlb_id, split)', snapPk, ['snapshot_date', 'mlb_id', 'split']);
for (const k of ['upsertPitcherBattedBall', 'getPitcherBattedBall', 'getPitcherBattedBallAsOf', 'snapshotPitcherBattedBall']) {
  check('q.' + k + ' prepared', !!q[k], true);
}

console.log('\n5. the job rides the wOBA cadence and cannot sink it');
const jobsSrc = read('services/jobs.js');
check('called from the wOBA sync', /await runPitcherBattedBallJob\(cookieValue\)/.test(jobsSrc), true);
check('wrapped so a failure cannot propagate',
  /try \{ battedBall = await runPitcherBattedBallJob\(cookieValue\); \}[\s\S]{0,120}catch/.test(jobsSrc), true);
check('writes its own cron_log row', /logCron\.run\('fg-batted-ball'/.test(jobsSrc), true);
check('no separate schedule was added', /cron\.schedule[^\n]*batted/i.test(jobsSrc), false);

console.log('\n6. freshness + gap hook, same treatment as woba_data_snapshot');
const { PIPELINES } = require('../utils/pipeline-freshness');
const p = PIPELINES.filter((x) => x.key === 'pitcher_batted_ball_snapshot')[0];
check('pipeline declared', !!p, true);
check('has the gap hook', !!(p && p.gaps && p.gaps.sql), true);
check('gap query comes from the shared builder', /WITH dates AS \(SELECT DISTINCT snapshot_date/.test(p.gaps.sql), true);
check('same recent-window policy as the rest', [p.gaps.recentDays, p.gaps.warnCount, p.gaps.critCount], [7, 1, 2]);

console.log('\n7. an unpopulated new capture is STALE, not CRITICAL');
// Shipping a capture before its first cron fires must not turn the whole
// freshness check red — that would exit 1, mark /health critical and fail
// an existing green test, for a table nothing has had a chance to write.
const { checkPipelineFreshness } = require('../utils/pipeline-freshness');
check('declared awaitingFirstRun', !!p.awaitingFirstRun, true);
const liveRun = checkPipelineFreshness(db, '2026-09-12');
const pbbRow = liveRun.rows.filter((x) => x.key === 'pitcher_batted_ball_snapshot')[0];
check('empty table reports STALE', pbbRow.level, 'STALE');
check('and says why', /awaiting its first run/.test(pbbRow.detail), true);
check('the run has no criticals because of it', liveRun.crit, 0);
// A dropped table and a job that never ran look identical downstream, so
// only one of them is excused. Point the check at a DB with no such table.
const broken = new Database(':memory:');
broken.exec('CREATE TABLE game_log (game_date TEXT)');
const brokenRow = checkPipelineFreshness(broken, '2026-09-12')
  .rows.filter((x) => x.key === 'pitcher_batted_ball_snapshot')[0];
check('a QUERY ERROR is still CRITICAL despite the flag', brokenRow.level, 'CRITICAL');

console.log('\n8. the 2025 prior-season backfill');
const prior = require('../services/backfill-tasks/pitcher-batted-ball-prior-season');
check('stamped 2026-03-31 so every 2026 game date resolves to it', prior.SNAPSHOT_DATE, '2026-03-31');
check('tagged prior_season', prior.SOURCE, 'prior_season');
// A FIXED window, not derived from today: a rolling one would return a
// different corpus on every re-run, which is the opposite of a
// reproducible historical load.
check('window is fixed 2025, not rolling',
  [prior.PRIOR_SEASON_START, prior.PRIOR_SEASON_END], ['2025-03-01', '2025-11-30']);
const bj = require('../services/backfill-jobs');
check('reachable via POST /admin/backfill/...',
  !!bj.getBackfillTask('pitcher_batted_ball_prior_season'), true);
check('source column exists on the live table',
  db.prepare('PRAGMA table_info(pitcher_batted_ball_snapshot)').all()
    .map((c) => c.name).indexOf('source') > -1, true);
// The date-range override must not disturb the default path.
check('fetchActualSplit keeps the rolling window when start/end are absent',
  /\(o\.start && o\.end\) \? \{ start: o\.start, end: o\.end \} : twoYearDateRange\(\)/.test(fgSrc), true);
check('the live job tags its own rows live',
  /snapshotPitcherBattedBall\(dateStr, rows, 'live'\)/.test(read('services/jobs.js')), true);

console.log('\n9. as-of resolution across the prior/live boundary');
const mem2 = new Database(':memory:');
mem2.exec(`CREATE TABLE pitcher_batted_ball_snapshot (
  snapshot_date TEXT NOT NULL, mlb_id INTEGER NOT NULL, split TEXT NOT NULL,
  name TEXT, gb_pct REAL, fb_pct REAL, ld_pct REAL, sample_tbf INTEGER, source TEXT,
  PRIMARY KEY (snapshot_date, mlb_id, split))`);
const ins2 = mem2.prepare('INSERT INTO pitcher_batted_ball_snapshot VALUES (?,?,?,?,?,?,?,?,?)');
// Pitcher 701: a 2025 profile plus a live capture in September.
ins2.run('2026-03-31', 701, 'vs_rhb', 'GB guy', 0.52, 0.27, 0.21, 400, 'prior_season');
ins2.run('2026-09-12', 701, 'vs_rhb', 'GB guy', 0.47, 0.32, 0.21, 250, 'live');
// Pitcher 702: a 2025 profile only — a different pitcher, so BETWEEN-pitcher
// variation exists from opening day.
ins2.run('2026-03-31', 702, 'vs_rhb', 'FB guy', 0.33, 0.46, 0.21, 380, 'prior_season');
// Pitcher 999: a 2026 rookie, no row anywhere.
const asOf2 = mem2.prepare('SELECT gb_pct, snapshot_date, source FROM pitcher_batted_ball_snapshot '
  + 'WHERE mlb_id=? AND split=? AND snapshot_date<=? ORDER BY snapshot_date DESC LIMIT 1');
check('an April 2026 game resolves to the 2025 profile',
  [asOf2.get(701, 'vs_rhb', '2026-04-15').source, asOf2.get(701, 'vs_rhb', '2026-04-15').gb_pct],
  ['prior_season', 0.52]);
check('a game after the first live capture resolves to the live one',
  [asOf2.get(701, 'vs_rhb', '2026-09-13').source, asOf2.get(701, 'vs_rhb', '2026-09-13').gb_pct],
  ['live', 0.47]);
check('BETWEEN-pitcher variation exists in April (0.52 vs 0.33 GB%)',
  asOf2.get(701, 'vs_rhb', '2026-04-15').gb_pct !== asOf2.get(702, 'vs_rhb', '2026-04-15').gb_pct, true);
// The constraint the methodology note exists for: across the pre-live
// stretch a given pitcher's value never moves.
check('NO within-season drift before the first live capture',
  [asOf2.get(701, 'vs_rhb', '2026-04-15').gb_pct, asOf2.get(701, 'vs_rhb', '2026-08-31').gb_pct],
  [0.52, 0.52]);
check('a rookie with no 2025 row resolves to nothing — null, not zero',
  asOf2.get(999, 'vs_rhb', '2026-04-15'), undefined);
check('a game before the prior-season stamp resolves to nothing',
  asOf2.get(701, 'vs_rhb', '2026-03-01'), undefined);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
