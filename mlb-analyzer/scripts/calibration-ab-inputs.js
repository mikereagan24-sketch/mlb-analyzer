#!/usr/bin/env node
/**
 * calibration-ab.js, with a chosen group of caller-populated inputs swapped
 * in from their persisted emit-time values.  (2026-09-04)
 *
 * WHY THIS EXISTS
 * ---------------
 * runModel reads 41 fields off `game`. It COMPUTES none of them -- the
 * caller does, and services/jobs.js is the caller in production. Offline
 * harnesses build their game object with parameter-sweep.preScreenGame(),
 * which populates a subset. Every field it misses arrives as `undefined`
 * and runModel silently takes a constant fallback, so the feature under
 * test is priced against league average on BOTH arms.
 *
 * This is not hypothetical. It has produced two wrong readings already:
 *
 *   DEFENSE_FRV_ENABLED reported inert, 0 of 790 games changed. The cause
 *   was {away,home}FieldingRunsPerGame arriving null, not the flag doing
 *   nothing. Reported as-is it would have read "FRV does nothing, leave it
 *   off forever" -- backwards from what the data says once wired.
 *
 *   CATCHER_FRAMING_MUTE, same shape, 0 of 790.
 *
 * harness-inputs.populateCallerInputs was added to close those two. It
 * still covers only 4 of the 21 fields production sets, so the same class
 * of false-inert reading is live for every group listed below.
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
 * <group> is one of the keys below, `none` for the untouched baseline, or
 * `all` for every group that has a persisted source. Remaining arguments
 * are handed to calibration-ab.js unchanged, so a paired before/after is:
 *
 *   node scripts/calibration-ab-inputs.js none    DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07
 *   node scripts/calibration-ab-inputs.js bullpen DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07
 *
 * READ THE INJECTION SUMMARY, NOT JUST THE DELTA. A group whose persisted
 * columns are null across the corpus injects nothing, and the run is then
 * a baseline wearing a group's name. The summary prints per-field
 * populated counts and exits 1 if the selected group injected zero.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const fs = require('fs');
const NL = String.fromCharCode(10);

const hi = require(path.join(R, 'services/harness-inputs'));
const { q, db } = require(path.join(R, 'db/schema'));

// --- group table -----------------------------------------------------
//
// `columns` groups are a straight copy off the raw game_log row, which
// loadGames selects with `SELECT *` -- so the value is already in hand and
// preScreenGame simply does not carry it across. `derive` groups need a
// helper because the persisted shape differs from what runModel reads.

const GROUPS = {
  bullpen: {
    label: 'bullpen strength',
    source: 'game_log.{away,home}_bullpen_woba{,_vs_l,_vs_r}',
    fields: ['awayBullpenWoba', 'awayBullpenVsL', 'awayBullpenVsR',
             'homeBullpenWoba', 'homeBullpenVsL', 'homeBullpenVsR'],
    derive: function (w, g, settings, tally) {
      for (const side of ['away', 'home']) {
        const t = hi.bullpenTermForReplay(q, g, side, settings, {});
        if (!t || t.woba == null) continue;
        set(w, side + 'BullpenWoba', t.woba, tally);
        if (t.vsLHB != null) set(w, side + 'BullpenVsL', t.vsLHB, tally);
        if (t.vsRHB != null) set(w, side + 'BullpenVsR', t.vsRHB, tally);
      }
    },
  },
  opener: {
    label: 'opener / bulk forecast',
    source: 'game_log, same column names',
    columns: {
      away_opener_forecast_ip: 'away_opener_forecast_ip',
      home_opener_forecast_ip: 'home_opener_forecast_ip',
      away_bulk_forecast_ip:   'away_bulk_forecast_ip',
      home_bulk_forecast_ip:   'home_bulk_forecast_ip',
      bulk_guy_away:           'bulk_guy_away',
      bulk_guy_home:           'bulk_guy_home',
    },
  },
  tandem: {
    label: 'tandem subtype',
    source: 'game_log, same column names',
    columns: {
      tandem_subtype_away: 'tandem_subtype_away',
      tandem_subtype_home: 'tandem_subtype_home',
    },
  },
  framing: {
    label: 'catcher framing (persisted rather than recomputed)',
    source: 'game_log.{away,home}_catcher_framing_rv_per_game',
    columns: {
      awayCatcherFramingRvPerGame: 'away_catcher_framing_rv_per_game',
      homeCatcherFramingRvPerGame: 'home_catcher_framing_rv_per_game',
    },
  },
  roster: {
    label: 'roster membership sets',
    fields: ['awayRosterSet', 'homeRosterSet'],
    unavailable: 'no persisted column. jobs.js builds these from the live '
      + 'roster tables, which hold TODAY state and are not snapshotted per '
      + 'game date, so there is nothing to replay. Reconstructing them needs '
      + 'a new emit-time capture, not a harness change.',
  },
  availability: {
    label: 'bullpen availability',
    fields: ['bullpenAvailability'],
    unavailable: 'no persisted column. Same reason as roster: derived at '
      + 'emit time from recent usage and never written to game_log.',
  },
};

function set(w, field, value, tally) {
  w[field] = value;
  tally[field] = (tally[field] || 0) + 1;
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
  ok('baseline really is missing the bullpen fields (the defect is real)',
     before.awayBullpenWoba === undefined && before.homeBullpenWoba === undefined,
     'away=' + JSON.stringify(before.awayBullpenWoba));

  const tally = {};
  const after = ps.preScreenGame(row, idx, settings);
  hi.populateCallerInputs(after, row, settings);
  GROUPS.bullpen.derive(after, row, settings, tally);
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
  console.log('  runModel reads 41 fields off `game`; the offline harness supplies 24.');
  console.log('  These are the groups it does not, and what stands in instead.');
  console.log('');
  for (const k of Object.keys(GROUPS)) {
    const G = GROUPS[k];
    const fields = G.fields || Object.keys(G.columns);
    console.log('  ' + k.padEnd(14) + G.label);
    console.log('  ' + ''.padEnd(14) + 'fields : ' + fields.join(', '));
    console.log('  ' + ''.padEnd(14) + (G.unavailable
      ? 'NO SOURCE: ' + G.unavailable
      : 'source : ' + G.source));
    console.log('');
  }
  console.log('  none   baseline, nothing swapped -- run this for the before half');
  console.log('  all    every group above that has a persisted source');
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
    for (const k of wanted) {
      const G = GROUPS[k];
      if (G.derive) { G.derive(w, g, settings, tally); continue; }
      for (const field of Object.keys(G.columns)) {
        const v = g[G.columns[field]];
        if (v != null) set(w, field, v, tally);
      }
    }
    return r;
  };
}

process.on('exit', function (code) {
  if (code !== 0) return;
  const out = [];
  out.push('');
  out.push('=== injection summary ===');
  out.push('  group(s): ' + (wanted.length ? wanted.join(', ') : 'none (baseline)'));
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
  for (const k of wanted) {
    const G = GROUPS[k];
    for (const f of (G.fields || Object.keys(G.columns))) all.push(f);
  }
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
