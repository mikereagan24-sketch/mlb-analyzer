#!/usr/bin/env node
'use strict';
// Proves utils/pythag-win-prob.js is arithmetically IDENTICAL to the four
// copies it replaced, rather than merely similar.
//
//   services/model.js:1422-1425          standard price      (** form)
//   services/model.js:1452-1455          opener/Alt price    (** form)
//   services/baserunning-backtest.js:148 pythagHomeWp()      (Math.pow form)
//   routes/api.js:7906-7909              /debug/model-trace  (Math.pow form)
//
// Two independent checks, because neither alone is enough:
//
//   1. UNIT GRID. The old expressions are written out literally below and
//      compared to the shared function with ===, not a tolerance. Covers the
//      degenerate branches (0, negative, equal runs) that real slates never
//      produce -- the forward corpus has min aRuns 2.29, so a corpus-only
//      test would never execute three of the four branches.
//   2. END-TO-END on real data. Every game in the forward corpus and on the
//      current slate: runModel's rawHW/adjHW/adjAW must exactly equal the old
//      arithmetic recomputed from the same aRuns/hRuns. This is what catches
//      a wiring mistake (wrong argument order, a swapped clamp bound) that a
//      unit test on the function alone would pass.
//
// Run: <node>/node.exe scripts/test-pythag-consolidation.js [--full]
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const hi = require('../services/harness-inputs');
const jobs = require('../services/jobs');
const model = require('../services/model');
const { pythagWinProb } = require('../utils/pythag-win-prob');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mlb.db');
const db = new Database(DB_PATH, { readonly: true });
const FULL = process.argv.includes('--full');

let failures = 0;
function fail(msg) { failures++; console.log('  FAIL ' + msg); }
function ok(msg) { console.log('  ok   ' + msg); }

// ---------------------------------------------------------------- old forms
// Verbatim arithmetic from the replaced copies. Do not "clean these up" --
// their value is being character-for-character what shipped before.
function oldModelForm(aRuns, hRuns, E, HFA, LO, HI) {
  const rawHW = (aRuns <= 0 && hRuns <= 0) ? 0.5 : hRuns <= 0 ? 0.25 : aRuns <= 0 ? 0.75 :
    hRuns ** E / (hRuns ** E + aRuns ** E);
  const adjHW = Math.min(Math.max(rawHW + HFA, LO), HI);
  return { rawHW: rawHW, adjHW: adjHW, adjAW: 1 - adjHW };
}
function oldPowForm(aRuns, hRuns, E, HFA, LO, HI) {
  const rawHW = (aRuns <= 0 && hRuns <= 0) ? 0.5 : hRuns <= 0 ? 0.25 : aRuns <= 0 ? 0.75 :
    Math.pow(hRuns, E) / (Math.pow(hRuns, E) + Math.pow(aRuns, E));
  const adjHW = Math.min(Math.max(rawHW + HFA, LO), HI);
  return { rawHW: rawHW, adjHW: adjHW, adjAW: 1 - adjHW };
}

// ============================================================ 1. UNIT GRID
console.log('1. unit grid: shared function === both old spellings, exactly');
const RUNVALS = [-3, -0.5, 0, 1e-12, 0.25, 1, 2.2706, 3.5, 4.44, 5, 8.125, 13, 1e6];
const EXPS = [1.65, 1.75, 1.83, 1.9, 2];
const HFAS = [0, 0.02, 0.05];
const CLAMPS = [[0.10, 0.90], [0.05, 0.95], [0.45, 0.55]];
let gridN = 0, gridBad = 0, branchHits = { both0: 0, h0: 0, a0: 0, normal: 0 };
for (const a of RUNVALS) for (const h of RUNVALS) for (const E of EXPS)
  for (const HFA of HFAS) for (const c of CLAMPS) {
    gridN++;
    if (a <= 0 && h <= 0) branchHits.both0++;
    else if (h <= 0) branchHits.h0++;
    else if (a <= 0) branchHits.a0++;
    else branchHits.normal++;
    const got = pythagWinProb(a, h, E, HFA, c[0], c[1]);
    for (const ref of [oldModelForm(a, h, E, HFA, c[0], c[1]),
                       oldPowForm(a, h, E, HFA, c[0], c[1])]) {
      // NaN-safe exact comparison: Object.is so NaN === NaN counts as equal
      // and +0 vs -0 counts as different, which is stricter than ===.
      if (!Object.is(got.rawHW, ref.rawHW) || !Object.is(got.adjHW, ref.adjHW)
          || !Object.is(got.adjAW, ref.adjAW)) {
        gridBad++;
        if (gridBad <= 5) {
          console.log('    mismatch a=' + a + ' h=' + h + ' E=' + E + ' HFA=' + HFA
            + ' clamp=[' + c[0] + ',' + c[1] + ']  got ' + JSON.stringify(got)
            + '  ref ' + JSON.stringify(ref));
        }
      }
    }
  }
if (gridBad) fail(gridN + ' grid points, ' + gridBad + ' mismatch(es)');
else ok(gridN + ' grid points, 0 mismatches (both ** and Math.pow spellings)');
// A grid that never reaches the degenerate branches proves less than it looks.
for (const k of Object.keys(branchHits)) {
  if (branchHits[k] === 0) fail('branch "' + k + '" was never exercised by the grid');
}
if (Object.keys(branchHits).every((k) => branchHits[k] > 0)) {
  ok('all four branches exercised: ' + JSON.stringify(branchHits));
}

// ====================================================== 2. END-TO-END, REAL
console.log('');
console.log('2. end-to-end: runModel output === old arithmetic, every game');
const settings = jobs.getSettings();
const E   = Number(settings.PYTH_EXP    != null ? settings.PYTH_EXP    : 1.83);
const HFA = Number(settings.HFA_BOOST   != null ? settings.HFA_BOOST   : 0.02);
const LO  = Number(settings.WP_CLAMP_LO != null ? settings.WP_CLAMP_LO : 0.10);
const HI  = Number(settings.WP_CLAMP_HI != null ? settings.WP_CLAMP_HI : 0.90);

const quiet = (fn) => { const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; } };

// Current slate = newest date the harness can actually re-score. A date with
// no wOBA snapshot yet (tomorrow's games) returns null from loadWobaSnapshot
// and would silently contribute zero games.
const cand = db.prepare("SELECT DISTINCT game_date FROM game_log "
  + "WHERE model_total IS NOT NULL ORDER BY game_date DESC LIMIT 6").all().map((r) => r.game_date);
let slateDate = null;
for (const d of cand) { if (quiet(() => ps.loadWobaSnapshot(db, d))) { slateDate = d; break; } }

const FROM = db.prepare('SELECT MIN(snapshot_date) v FROM team_baserunning_snapshot').get().v;
const TO   = db.prepare('SELECT MAX(game_date) v FROM game_log WHERE home_score IS NOT NULL').get().v;

function sweep(label, from, to, stride) {
  const games = quiet(() => ps.loadGames(db, from, to, {}));
  const cache = new Map();
  let n = 0, bad = 0, skipped = 0, minA = Infinity;
  for (let i = 0; i < games.length; i += stride) {
    const g = games[i];
    if (!cache.has(g.game_date)) cache.set(g.game_date, quiet(() => ps.loadWobaSnapshot(db, g.game_date)));
    const idx = cache.get(g.game_date);
    if (!idx) { skipped++; continue; }
    const wrapped = quiet(() => hi.populateCallerInputs(ps.preScreenGame(g, idx, settings), g, settings));
    if (!wrapped) { skipped++; continue; }
    const mr = quiet(() => model.runModel(wrapped, idx, settings, 'standard'));
    if (!mr || mr._suppressed) { skipped++; continue; }
    n++;
    if (mr.aRuns < minA) minA = mr.aRuns;
    const ref = oldModelForm(mr.aRuns, mr.hRuns, E, HFA, LO, HI);
    if (!Object.is(mr.rawHW, ref.rawHW) || !Object.is(mr.adjHW, ref.adjHW)
        || !Object.is(mr.adjAW, ref.adjAW)) {
      bad++;
      if (bad <= 5) console.log('    ' + g.game_date + ' ' + g.game_id
        + '  aRuns=' + mr.aRuns + ' hRuns=' + mr.hRuns
        + '  got rawHW=' + mr.rawHW + ' adjHW=' + mr.adjHW
        + '  ref rawHW=' + ref.rawHW + ' adjHW=' + ref.adjHW);
    }
  }
  if (bad) fail(label + ': ' + n + ' games, ' + bad + ' mismatch(es)');
  else ok(label + ': ' + n + ' games, 0 mismatches (skipped ' + skipped
    + ', min aRuns ' + (minA === Infinity ? 'n/a' : minA.toFixed(4)) + ')');
  return n;
}

if (slateDate) sweep('current slate ' + slateDate, slateDate, slateDate, 1);
else fail('no priceable slate found in the last 6 dates');

const stride = FULL ? 1 : 3;
console.log('  forward corpus ' + FROM + ' .. ' + TO
  + (FULL ? ' (every game)' : ' (stride ' + stride + '; pass --full for every game)'));
sweep('forward corpus', FROM, TO, stride);

console.log('');
if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
console.log('ALL CHECKS PASSED');
