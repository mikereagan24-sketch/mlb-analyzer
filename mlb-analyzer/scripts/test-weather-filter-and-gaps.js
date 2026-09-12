#!/usr/bin/env node
// weatherFilter option + mid-era snapshot gap check (2026-09-12).
//   node scripts/test-weather-filter-and-gaps.js
// Exit 1 on any failure.
//
// The load-bearing assertions:
//   (1) 'tag' really reproduces the pre-#382 corpus, and 'valid' really
//       does not — asserted by COUNTING both, not by reading the SQL
//   (2) an unrecognised filter THROWS in both harnesses
//   (3) the gap check NAMES the founding instances, and its level is
//       driven by recent gaps only so unrepairable history cannot make it
//       permanently red
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const { checkPipelineFreshness, PIPELINES } = require('../utils/pipeline-freshness');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const db = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
const FROM = '2026-04-01', TO = '2026-09-12';

console.log('1. loadGames: valid vs tag are genuinely different corpora');
const nValid = ps.loadGames(db, FROM, TO).length;
const nValidExplicit = ps.loadGames(db, FROM, TO, { weatherFilter: 'valid' }).length;
const nAlias = ps.loadGames(db, FROM, TO, { weatherFilter: 'inputs_valid' }).length;
const nTag = ps.loadGames(db, FROM, TO, { weatherFilter: 'tag' }).length;
const nNone = ps.loadGames(db, FROM, TO, { weatherFilter: 'none' }).length;
console.log('     valid=' + nValid + '  tag=' + nTag + '  none=' + nNone);
check('default is valid', nValid, nValidExplicit);
check("'inputs_valid' from #382 still resolves to the same corpus", nAlias, nValid);
check('tag is a SMALLER corpus than valid', nTag < nValid, true);
check('none is the widest', nNone >= nValid, true);
let threw = 0;
for (const bad of ['clean', 'VALID', 'inputs-valid']) {
  try { ps.loadGames(db, FROM, TO, { weatherFilter: bad }); } catch (e) { threw++; }
}
check('3 unrecognised spellings all throw (incl. wrong case)', threw, 3);
// An EMPTY value means "unset" and takes the default, which is how an
// unset env var arrives (`process.env.WEATHER_FILTER || 'valid'`) and how
// the route passes it (`|| undefined`). Asserted rather than left implicit,
// because "empty silently means valid" is the kind of thing that should be
// a decision on the record, not an accident of falsiness.
check('empty means unset, not an error', ps.loadGames(db, FROM, TO, { weatherFilter: '' }).length, nValid);

console.log('\n2. baserunning-backtest accepts the same option');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services/baserunning-backtest.js'), 'utf8');
check('declares both filters', /valid: 'AND weather_inputs_valid = 1 '/.test(src)
  && /tag:   'AND weather_contamination_reason IS NULL '/.test(src), true);
check('throws on an unrecognised value', /unrecognised weatherFilter/.test(src), true);
check('reports the filter in its result', /weather_filter: weatherFilter/.test(src), true);
// Behavioural: the harness is heavy, so assert the option reaches the SQL
// by counting the rows each filter selects with the harness's own predicate.
const bsrCount = (extra) => db.prepare(
  'SELECT COUNT(*) n FROM game_log WHERE game_date >= ? AND game_date <= ? '
  + 'AND away_score IS NOT NULL AND home_score IS NOT NULL ' + extra).get('2026-06-16', '2026-09-10').n;
const bsrValid = bsrCount('AND weather_inputs_valid = 1');
const bsrTag = bsrCount('AND weather_contamination_reason IS NULL');
console.log('     BsR window: valid=' + bsrValid + '  tag=' + bsrTag + '  delta=' + (bsrValid - bsrTag));
check('the two BsR arms differ', bsrValid !== bsrTag, true);

console.log('\n2b. every loadGames caller can now select its corpus');
// The gap this closes: #382 documented weatherFilter:'tag' and no script
// could pass it, so the FRV before/after was measured through a local
// patch. Asserted per file rather than in aggregate, so a caller added
// later without the switch is visibly missing rather than averaged away.
const fsx = require('fs'), pathx = require('path');
for (const f of ['scripts/calibration-ab.js', 'scripts/calibration-sweep.js',
  'scripts/component-signal-diagnostic.js', 'scripts/bullpen-neutral-ab.js']) {
  const s = fsx.readFileSync(pathx.join(__dirname, '..', f), 'utf8');
  check(f + ' reads WEATHER_FILTER', /process\.env\.WEATHER_FILTER \|\| 'valid'/.test(s), true);
  check(f + ' passes it to loadGames', /weatherFilter: WEATHER_FILTER/.test(s), true);
  check(f + ' echoes it into its own output', /weather filter: ' \+ WEATHER_FILTER/.test(s), true);
}

console.log('\n2c. the BsR harness carries an n-matched control');
const bsrSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'services/baserunning-backtest.js'), 'utf8');
check('accepts sampleN / sampleSeed', /opts\.sampleN/.test(bsrSrc) && /opts\.sampleSeed/.test(bsrSrc), true);
check('reuses parameter-sweep sampleGames, not a second shuffle',
  /require\('\.\/parameter-sweep'\)\.sampleGames/.test(bsrSrc), true);
// No source regex for "is the field top-level" — a proximity match on the
// surrounding text is brittle and would have passed while the field sat
// nested inside baserunning_coverage, which is the bug that actually
// happened. The behavioural checks below read the returned object instead.
check('sample is null when the run was not downsampled, so an uncontrolled '
  + 'run cannot look controlled', /sample: sampledFrom$/m.test(bsrSrc), true);
// Determinism of the shared sampler, which is what makes the control
// reproducible across the two arms.
const pool = Array.from({ length: 50 }, (_, i) => ({ i }));
const s1 = ps.sampleGames(pool, 12, 20260912).map((r) => r.i);
const s2 = ps.sampleGames(pool, 12, 20260912).map((r) => r.i);
const s3 = ps.sampleGames(pool, 12, 7).map((r) => r.i);
check('same seed -> same subsample', s1, s2);
check('different seed -> different subsample', s1.join() === s3.join(), false);
check('subsample keeps chronological order', s1.slice().sort((a, b) => a - b), s1);

// BEHAVIOURAL, on a 3-day window so it stays cheap: the result must carry
// the filter it was run under. Source checks cannot catch the failure this
// had -- the echo was present but nested inside baserunning_coverage, so
// the top-level field a caller reads came back undefined.
const { runBaserunningBacktest } = require('../services/baserunning-backtest');
const tiny = (o) => runBaserunningBacktest(Object.assign(
  { fromDate: '2026-07-01', toDate: '2026-07-03', level: 'player', window: 'trailing', forwardHonest: true }, o));
const rTag = tiny({ weatherFilter: 'tag' });
const rValid = tiny({ weatherFilter: 'valid' });
check('tag arm echoes its filter at the top level', rTag.weather_filter, 'tag');
check('valid arm echoes its filter at the top level', rValid.weather_filter, 'valid');
check('an un-sampled run reports sample: null', [rTag.sample, rValid.sample], [null, null]);
check('valid admits at least as many games as tag',
  rValid.games_considered >= rTag.games_considered, true);
const rCtl = tiny({ weatherFilter: 'valid', sampleN: 5, sampleSeed: 3 });
check('a sampled run reports its sample block',
  [rCtl.sample.n, rCtl.sample.seed, rCtl.sample.drawn_from > 5], [5, 3, true]);
check('sampling actually reduces what was scored', rCtl.games_considered, 5);
let bsrThrew = false;
try { tiny({ weatherFilter: 'nonsense' }); } catch (e) { bsrThrew = true; }
check('BsR throws on an unrecognised filter', bsrThrew, true);

console.log('\n3. the mid-era gap check is declared on woba_data_snapshot');
const snap = PIPELINES.filter((p) => p.key === 'woba_data_snapshot')[0];
check('gaps hook declared', !!(snap && snap.gaps && snap.gaps.sql), true);
check('level driven by recent gaps only (recentDays set)', snap.gaps.recentDays, 7);

console.log('\n4. it names the founding instances');
const r = checkPipelineFreshness(db, '2026-09-12');
const row = r.rows.filter((x) => x.key === 'woba_data_snapshot')[0];
const dates = row.gaps && row.gaps.missing ? row.gaps.missing.map((g) => g.date) : [];
console.log('     missing in-era dates: ' + (dates.join(', ') || '(none)')
  + '   games lost: ' + (row.gaps ? row.gaps.gamesLost : '-'));
check('no gap-check error', row.gaps && !row.gaps.error, true);
check('2026-06-26 is named', dates.indexOf('2026-06-26') > -1, true);
check('2026-07-19 is named', dates.indexOf('2026-07-19') > -1, true);
check('today is NOT reported as a gap (its capture may be pending)',
  dates.indexOf('2026-09-12') > -1, false);
check('pre-era dates are never reported (era-bounded query)',
  dates.filter((d) => d < '2026-05-20'), []);

console.log('\n5. unrepairable history does not make it permanently red');
// As of a date long after the gaps, nothing is recent, so the gap level is
// ok while the dates are still listed. That is the whole design.
check('gap level ok when all gaps are historical', row.gaps.level, 'ok');
check('recent count is 0 as of 2026-09-12', row.gaps.recentCount, 0);
check('but the dates are still reported', row.gaps.missingCount > 0, true);
// And a date INSIDE the recent window must raise it. Proven on a temp DB
// so the assertion does not depend on the live data's calendar.
const mem = new Database(':memory:');
mem.exec('CREATE TABLE woba_data_snapshot (snapshot_date TEXT, data_key TEXT, player_name TEXT, woba REAL, sample_size INT);'
  + 'CREATE TABLE game_log (game_date TEXT)');
const addSnap = mem.prepare("INSERT INTO woba_data_snapshot VALUES (?, 'k', 'p', 0.3, 10)");
const addGame = mem.prepare('INSERT INTO game_log VALUES (?)');
for (const d of ['2026-09-01', '2026-09-02', '2026-09-05']) addSnap.run(d);
for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
  for (let i = 0; i < 15; i++) addGame.run(d);
}
const memRow = checkPipelineFreshness(mem, '2026-09-05').rows.filter((x) => x.key === 'woba_data_snapshot')[0];
const memDates = memRow.gaps.missing.map((g) => g.date);
check('synthetic: the two interior holes are found', memDates, ['2026-09-03', '2026-09-04']);
check('synthetic: 30 games counted lost', memRow.gaps.gamesLost, 30);
check('synthetic: 2 recent gaps -> CRITICAL', [memRow.gaps.recentCount, memRow.gaps.level], [2, 'CRITICAL']);
check('synthetic: the pipeline row inherits the gap level', memRow.level, 'CRITICAL');

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
