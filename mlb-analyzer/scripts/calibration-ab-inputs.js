#!/usr/bin/env node
/**
 * calibration-ab.js, with a chosen group of caller-populated inputs swapped
 * in from their persisted emit-time values.  (2026-09-04, re-based 2026-09-16)
 *
 * WHY THIS EXISTS
 * ---------------
 * runModel reads 21 fields off `game` that it does not compute -- the
 * caller does, and services/jobs.js is the caller in production. Offline
 * harnesses build their game object with parameter-sweep.preScreenGame(),
 * which spreads the game_log row, so any field that is not a column arrives
 * as `undefined` and runModel silently takes a constant fallback.
 *
 * This is not hypothetical. It has produced two wrong readings already:
 *
 *   DEFENSE_FRV_ENABLED reported inert, 0 of 790 games changed. The cause
 *   was {away,home}FieldingRunsPerGame arriving null, not the flag doing
 *   nothing.
 *
 *   CATCHER_FRAMING_MUTE, same shape, 0 of 790.
 *
 * WHAT CHANGED ON 2026-09-16
 * --------------------------
 * harness-inputs.populateCallerInputs now reads EVERY field with a persisted
 * source by default, so the groups below are already in every harness. This
 * script is kept to reproduce the per-group measurement that justified that:
 * it pins HARNESS_INPUTS=legacy (the 4-field harness) as its baseline, and
 * `<group>` adds one group on top of it. `none` is the legacy harness.
 *
 * Measured 2026-09-16, DEFENSE_FRV_ENABLED false/true, 2026-06-01..08-07,
 * weather filter valid, FRV read asof, 658 games (full table in
 * docs/harness-inputs-persisted-2026-09-16.md):
 *
 *   group     OFF logLoss  ON logLoss  edge slope OFF/ON  d(ON-OFF) [95% CI]
 *   none        0.69010     0.68921     +0.009 / +0.130   -0.00088 [-0.00237, +0.00067]
 *   bullpen     0.68917     0.68848     +0.063 / +0.191   -0.00069 [-0.00222, +0.00091]
 *   framing     0.68972     0.68880     +0.061 / +0.180   -0.00092 [-0.00241, +0.00063]
 *   opener      identical to none on every result line
 *   tandem      identical to none on every result line
 *   all         0.68874     0.68800     +0.125 / +0.250   -0.00074 [-0.00227, +0.00086]
 *
 * `all` is NOT byte-identical to the persisted default (0.68877 / 0.68803,
 * +0.120 / +0.245, CI [-0.00229, +0.00086]). hi.injectGroup copies a framing
 * NULL when emit recorded a state; the 2026-09-04 group map copied only
 * non-null values and so kept the recompute on 47 sides / 46 games. Every
 * differing game is one of those 46.
 * Re-run: node --max-old-space-size=1536 scripts/calibration-ab-inputs.js <group> DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It changes nothing in the shipping path. populateCallerInputs is swapped
 * on the module object for the duration of one run and the process exits.
 * Production reads these fields from services/jobs.js and never from here.
 *
 * USAGE
 *   node scripts/calibration-ab-inputs.js --list
 *   node scripts/calibration-ab-inputs.js --selftest
 *   node scripts/calibration-ab-inputs.js <group> [PARAM] [OFF] [ON] [FROM] [TO]
 *
 * <group> is one of the keys below, `none` for the legacy baseline, or
 * `all` for every group that has a persisted source -- which equals the
 * default (persisted) harness.
 *
 * READ THE INJECTION SUMMARY, NOT JUST THE DELTA. A group whose persisted
 * columns are null across the corpus injects nothing, and the run is then
 * a baseline wearing a group's name. The summary prints per-field
 * populated counts and exits 1 if the selected group injected zero.
 */
// PIN THE BASELINE BEFORE ANYTHING READS IT. The groups are defined as
// additions to the legacy harness; run against the persisted default, `none`
// would already contain every group and each delta would read as zero.
if (process.env.HARNESS_INPUTS && process.env.HARNESS_INPUTS !== 'legacy') {
  console.error('calibration-ab-inputs measures groups against HARNESS_INPUTS=legacy; got "'
    + process.env.HARNESS_INPUTS + '". Unset it, or use scripts/calibration-ab.js for the persisted harness.');
  process.exit(2);
}
process.env.HARNESS_INPUTS = 'legacy';

const path = require('path');
const R = path.join(__dirname, '..');
const fs = require('fs');
const NL = String.fromCharCode(10);

const hi = require(path.join(R, 'services/harness-inputs'));
const { db } = require(path.join(R, 'db/schema'));

// --- group table -----------------------------------------------------
//
// Fields, sources and injection all come from harness-inputs.FIELD_SOURCES
// and hi.injectGroup -- ONE table, ONE implementation. This used to carry
// its own column map, which is the copy that would have drifted.
//
// NOTE ON opener AND tandem: preScreenGame spreads the whole game_log row,
// so these columns already reached runModel under the legacy harness. The
// injection changed 0 of 658 games' values on 2026-06-01..08-07 and the
// runs reproduce the baseline to every printed digit. They are listed
// because the question was asked, not because they move anything.
const LABELS = {
  bullpen: 'bullpen strength',
  framing: 'catcher framing (persisted rather than recomputed)',
  opener: 'opener / bulk forecast',
  tandem: 'tandem subtype',
  roster: 'roster membership sets',
  availability: 'bullpen availability',
};
const GROUPS = {};
for (const g of hi.INPUT_GROUPS) {
  if (g === 'frv') continue;   // computed as-of in every mode; not a swap
  const rows = hi.FIELD_SOURCES.filter(f => f.group === g);
  GROUPS[g] = {
    label: LABELS[g] || g,
    fields: rows.map(f => f.field),
    source: rows.filter(f => f.column).map(f => 'game_log.' + f.column).join(', '),
    unavailable: rows.every(f => f.unavailable) ? rows[0].unavailable : null,
  };
}

// --- selftest --------------------------------------------------------
//
// CLAUDE.md, review checklist: "A/B that swaps a module export -- a
// consumer that DESTRUCTURES at require time never sees the swap, so the
// A/B compares two identical runs and reports 'nothing moved', which reads
// as 'safe to ship'." That is the exact failure this script could have, so
// it is asserted rather than assumed. Two halves: the consumer must resolve
// the export at CALL time, and the swap must actually reach runModel's
// input object on a real row.

function selftest() {
  let failures = 0;
  const ok = (name, cond, detail) => {
    console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
    if (!cond) failures++;
  };
  console.log('=== calibration-ab-inputs selftest ===');

  const src = fs.readFileSync(path.join(R, 'scripts/calibration-ab.js'), 'utf8');
  ok('consumer calls hi.populateCallerInputs() by property',
     src.indexOf('hi.populateCallerInputs(') !== -1);
  ok('consumer does NOT destructure populateCallerInputs at require time',
     src.indexOf('populateCallerInputs }') === -1
     && src.indexOf('populateCallerInputs,') === -1);
  ok('consumer passes the patched object to runModel',
     src.indexOf('rows.push({ g: w') !== -1 && src.indexOf('runModel(rows[i].g') !== -1);
  ok('this process is pinned to the legacy baseline', hi.harnessInputsMode() === 'legacy');

  const ps = require(path.join(R, 'services/parameter-sweep'));
  const jobs = require(path.join(R, 'services/jobs'));
  const settings = jobs.getSettings();
  // Walk candidates rather than taking the newest row: a recent date has
  // persisted bullpen values but may have no wOBA snapshot yet, and
  // preScreenGame then returns null. That is a property of the probe row,
  // not of the thing under test, so it must not read as a failure.
  const cands = db.prepare(
    'SELECT * FROM game_log WHERE away_bullpen_woba IS NOT NULL '
    + 'AND home_bullpen_woba IS NOT NULL AND model_total IS NOT NULL '
    + 'AND home_score IS NOT NULL AND market_home_ml IS NOT NULL '
    + 'ORDER BY game_date DESC LIMIT 200').all();
  let row = null, idx = null, before = null;
  for (const c of cands) {
    const i = ps.loadWobaSnapshot(db, c.game_date);
    if (!i) continue;
    const w = ps.preScreenGame(c, i, settings);
    if (!w) continue;
    row = c; idx = i; before = w; break;
  }
  ok('found a probe row that preScreenGame accepts', !!before,
     row ? row.game_date + ' ' + row.game_id + '  (of ' + cands.length + ' candidates)' : 'none');
  if (!before) { console.log(NL + 'selftest FAILED'); process.exit(1); }
  hi.populateCallerInputs(before, row, settings);
  ok('legacy baseline really is missing the bullpen fields',
     before.awayBullpenWoba === undefined && before.homeBullpenWoba === undefined,
     'away=' + JSON.stringify(before.awayBullpenWoba));

  const tally = {};
  const after = ps.preScreenGame(row, idx, settings);
  hi.populateCallerInputs(after, row, settings);
  hi.injectGroup(after, row, 'bullpen', tally);
  ok('injection sets the fields runModel reads',
     after.awayBullpenWoba != null && after.homeBullpenWoba != null,
     'away=' + after.awayBullpenWoba + ' home=' + after.homeBullpenWoba);
  ok('injected values equal the persisted emit-time columns',
     after.awayBullpenWoba === row.away_bullpen_woba
     && after.homeBullpenWoba === row.home_bullpen_woba);

  // The point of the whole exercise: the swap must change what runModel
  // returns. If p(home) is identical the harness is not seeing it.
  const { runModel } = require(path.join(R, 'services/model'));
  const quiet = fn => {
    const L = console.log; console.log = () => {};
    try { return fn(); } finally { console.log = L; }
  };
  const pB = quiet(() => runModel(before, idx, settings, 'opener_aware', true));
  const pA = quiet(() => runModel(after, idx, settings, 'opener_aware', true));
  const moved = pB && pA && pB.adjHW != null && pA.adjHW != null
    && Math.abs(pB.adjHW - pA.adjHW) > 1e-12;
  ok('runModel p(home) MOVES with the group injected', !!moved,
     pB && pA ? pB.adjHW + ' -> ' + pA.adjHW : 'runModel returned null');

  console.log(NL + (failures ? 'selftest FAILED (' + failures + ')' : 'selftest OK'));
  process.exit(failures ? 1 : 0);
}

// --- main ------------------------------------------------------------

const arg = process.argv[2];

if (arg === '--list' || !arg) {
  console.log('=== input groups ===');
  console.log('  runModel reads ' + hi.CALLER_POPULATED_FIELDS.length + ' fields it does not compute.');
  console.log('  The legacy harness (the baseline here) supplies 12: FRV x2 (as-of), framing x2');
  console.log('  (recomputed), and opener x6 / tandem x2 via the row spread. The persisted default');
  console.log('  supplies 18. These are the swappable groups and their sources.');
  console.log('');
  for (const k of Object.keys(GROUPS)) {
    const G = GROUPS[k];
    console.log('  ' + k.padEnd(14) + G.label);
    console.log('  ' + ''.padEnd(14) + 'fields : ' + G.fields.join(', '));
    console.log('  ' + ''.padEnd(14) + (G.unavailable
      ? 'NO SOURCE: ' + G.unavailable
      : 'source : ' + G.source));
    console.log('');
  }
  console.log('  none   the legacy baseline, nothing swapped -- run this for the before half');
  console.log('  all    every group above that has a persisted source (= the persisted default)');
  process.exit(0);
}

if (arg === '--selftest') selftest();

const wanted = arg === 'all'
  ? Object.keys(GROUPS).filter(k => !GROUPS[k].unavailable)
  : (arg === 'none' ? [] : [arg]);

for (const k of wanted) {
  if (!GROUPS[k]) {
    console.error('unknown group "' + k + '" -- run --list');
    process.exit(2);
  }
  if (GROUPS[k].unavailable) {
    console.error('group "' + k + '" has no persisted source:');
    console.error('  ' + GROUPS[k].unavailable);
    process.exit(2);
  }
}

const tally = {};
let gamesTouched = 0;

if (wanted.length) {
  const ORIG = hi.populateCallerInputs;
  hi.populateCallerInputs = function (w, g, settings) {
    const r = ORIG.apply(this, arguments);
    gamesTouched++;
    for (const k of wanted) hi.injectGroup(w, g, k, tally);
    return r;
  };
}

process.on('exit', function (code) {
  if (code !== 0) return;
  const out = [];
  out.push('');
  out.push('=== injection summary ===');
  out.push('  group(s): ' + (wanted.length ? wanted.join(', ') : 'none (legacy baseline)'));
  if (!wanted.length) {
    // Do not print a games counter here. Nothing is patched on this path, so
    // the counter would read 0 and invite "the harness saw no games" -- which
    // is false; calibration-ab called the unpatched original for every game.
    out.push('  nothing swapped -- this is the BEFORE arm.');
    process.stdout.write(out.join(NL) + NL);
    return;
  }
  out.push('  games passed through populateCallerInputs: ' + gamesTouched);
  const all = [];
  for (const k of wanted) for (const f of GROUPS[k].fields) all.push(f);
  out.push('  field                            games populated');
  let total = 0;
  for (const f of all) {
    const n = tally[f] || 0;
    total += n;
    out.push('    ' + f.padEnd(32) + String(n).padStart(6)
      + (n === 0 ? '   <-- NEVER SET; persisted column is null across the corpus' : ''));
  }
  if (total === 0) {
    out.push('');
    out.push('  ZERO fields injected. This run is the baseline wearing a group name --');
    out.push('  any delta against `none` is noise, not the group. Exiting 1.');
    process.stdout.write(out.join(NL) + NL);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(out.join(NL) + NL);
});

// calibration-ab.js reads process.argv and runs on require. Shift our group
// argument out so it sees exactly its own interface.
process.argv = [process.argv[0], 'calibration-ab'].concat(process.argv.slice(3));
require(path.join(R, 'scripts/calibration-ab.js'));
