#!/usr/bin/env node
// Backfill game_log.weather_inputs_valid for historical rows (2026-09-12).
//
//   node scripts/set-weather-inputs-valid.js            # dry run, prints the plan
//   node scripts/set-weather-inputs-valid.js --apply    # writes
//
// Writes, so `db` comes from db/schema — never a second read-write
// connection on the same SQLite file (CLAUDE.md).
//
// WHAT THE FLAG MEANS: 1 = the persisted wind_*/temp_f/wind_factor/
// temp_run_adj in this row were produced by a park-local-hour-correct,
// correct-coordinates path, so a harness that RE-SCORES from these
// columns can trust them. It is NOT "the emit-time price was clean" —
// that is weather_contamination_reason, and the two came apart when the
// 2026-08-05 archive backfill corrected 738 rows that were tagged the
// next day. db/schema.js documents both senses.
//
// The predicate, its observable boundary, the UTC-vs-PT zone reasoning and
// the per-class assertions all live in utils/weather-inputs-valid.js. Read
// that file before changing anything here — this script is a reporting and
// --apply wrapper around it, and re-spelling the rule locally is the one
// way to make the two disagree.
//
// Ordinarily the boot migration in db/schema.js has already classified
// every row by the time this runs. Use this when you want the plan, the
// assertions and the corpus effect printed, or to re-classify rows whose
// flag was written wrong.
const { db } = require('../db/schema');
const wiv = require('../utils/weather-inputs-valid');

// The predicate, the boundary constants, the empty-gap assertion and the
// class mapping all live in utils/weather-inputs-valid.js -- ONE definition,
// shared with the boot migration in db/schema.js. Do not re-spell any of
// them here.
const APPLY = process.argv.includes('--apply');
const VALID_SQL = wiv.VALID_SQL;

function count(where, args) {
  const st = db.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + where);
  return (args && args.length ? st.get(...args) : st.get()).n;
}

function report() {
  console.log('\nproposed classification by contamination class:');
  const rows = db.prepare(
    "SELECT CASE WHEN weather_contamination_reason IS NULL THEN 'untagged' "
    + "WHEN weather_contamination_reason LIKE '%naive_hour%' THEN 'naive_hour' "
    + "WHEN weather_contamination_reason LIKE 'ath_%' THEN 'ath_*' "
    + "ELSE 'ari_roof_*' END cls, "
    + 'SUM(CASE WHEN ' + VALID_SQL + ' THEN 1 ELSE 0 END) valid, '
    + 'SUM(CASE WHEN ' + VALID_SQL + ' THEN 0 ELSE 1 END) invalid, COUNT(*) n '
    + 'FROM game_log GROUP BY 1 ORDER BY n DESC'
  ).all();
  for (const r of rows) {
    console.log('  ' + r.cls.padEnd(12) + ' n=' + String(r.n).padStart(5)
      + '  valid=' + String(r.valid).padStart(5) + '  invalid=' + String(r.invalid).padStart(4));
  }
  console.log('\nassertions:');
  let failed = 0;
  for (const [label, where] of wiv.CLASS_ASSERTIONS) {
    const violations = count(where);
    if (violations) failed++;
    console.log('  ' + (violations ? 'FAIL' : 'PASS') + '  ' + label + '  violations=' + violations);
  }
  return failed;
}

function corpusEffect() {
  console.log('\ncorpus effect (graded games):');
  const windows = [
    ['BsR forward window', '2026-06-16', '2026-09-10'],
    ['full season', '2026-04-01', '2026-12-31'],
  ];
  for (const [label, a, b] of windows) {
    const g = 'game_date>=? AND game_date<=? AND away_score IS NOT NULL AND home_score IS NOT NULL';
    const byTag = db.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + g
      + ' AND weather_contamination_reason IS NULL').get(a, b).n;
    const byFlag = db.prepare('SELECT COUNT(*) n FROM game_log WHERE ' + g
      + ' AND ' + VALID_SQL).get(a, b).n;
    console.log('  ' + label.padEnd(20) + ' emit-time tag filter ' + String(byTag).padStart(5)
      + '   weather_inputs_valid ' + String(byFlag).padStart(5)
      + '   +' + (byFlag - byTag));
  }
}

// Assert FIRST, then report what was actually counted. Printing a
// hardcoded "0 rows" ahead of the check would be a message that cannot
// be wrong, which is the same as no check at all.
const inGap = wiv.assertGapEmpty(db);
console.log('gap check: ' + inGap + ' rows between ' + wiv.GAP_LO_UTC + 'Z and '
  + wiv.GAP_HI_UTC + 'Z -- boundary still sited in empty space');
const failed = report();
corpusEffect();

if (failed) {
  console.error('\n' + failed + ' assertion(s) failed — refusing to write.');
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
  process.exit(0);
}

const tx = db.transaction(function () {
  db.prepare('UPDATE game_log SET weather_inputs_valid = 1 WHERE ' + VALID_SQL
    + ' AND (weather_inputs_valid IS NULL OR weather_inputs_valid <> 1)').run();
  db.prepare('UPDATE game_log SET weather_inputs_valid = 0 WHERE NOT ' + VALID_SQL
    + ' AND (weather_inputs_valid IS NULL OR weather_inputs_valid <> 0)').run();
});
tx();

const v = count('weather_inputs_valid = 1');
const i = count('weather_inputs_valid = 0');
const n = count('weather_inputs_valid IS NULL');
console.log('\nAPPLIED. weather_inputs_valid=1: ' + v + '   =0: ' + i + '   NULL: ' + n);
if (n !== 0) {
  console.error('NULL rows remain — the predicate did not cover every row. Investigate.');
  process.exit(1);
}
