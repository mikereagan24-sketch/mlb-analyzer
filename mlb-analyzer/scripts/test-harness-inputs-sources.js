#!/usr/bin/env node
'use strict';
// Every field runModel reads but does not compute has a stated source, and
// the offline harness reads each one FROM that source. (2026-09-16)
//
//   node scripts/test-harness-inputs-sources.js
//
// Exit 1 on any failure. Reads data/mlb.db read-only for the schema and one
// real row; no network.
//
// WHY THE REQUIRED SET IS DERIVED. CALLER_POPULATED_FIELDS was a
// hand-maintained list of 4 when runModel read 21 such fields, and nothing
// noticed for three weeks. So the test does not trust the list: it takes
// every game.X runModel reads, removes what a game_log row spread and the
// two parsed lineups supply, and requires FIELD_SOURCES to cover the rest.
// A new caller-populated read fails here, not in a silently-inert A/B.
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const quiet = (fn) => {
  const L = console.log, W = console.warn;
  console.log = console.warn = () => {};
  try { return fn(); } finally { console.log = L; console.warn = W; }
};

const saved = process.env.HARNESS_INPUTS;
delete process.env.HARNESS_INPUTS;
const hi = require(path.join(R, 'services/harness-inputs'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });
const columns = new Set(db.prepare('PRAGMA table_info(game_log)').all().map(c => c.name));

console.log('1. the source table covers every caller-populated read in runModel');
const modelSrc = fs.readFileSync(path.join(R, 'services/model.js'), 'utf8');
const start = modelSrc.indexOf('function runModel(');
const body = modelSrc.slice(start, modelSrc.indexOf('\nfunction ', start + 20));
const reads = [...new Set((body.match(/\bgame\.([A-Za-z_][A-Za-z0-9_]*)/g) || []).map(s => s.slice(5)))];
// A row spread supplies every game_log column; preScreenGame adds the lineups.
const suppliedByRow = new Set([...columns, 'awayLineup', 'homeLineup']);
const callerOnly = reads.filter(f => !suppliedByRow.has(f)).sort();
const listed = new Set(hi.CALLER_POPULATED_FIELDS);
check('runModel reads found (sanity: the scan is not empty)', reads.length > 20, true);
check('every read a row does not supply is in FIELD_SOURCES',
  callerOnly.filter(f => !listed.has(f)), []);
check('CALLER_POPULATED_FIELDS has 21 unique fields',
  [hi.CALLER_POPULATED_FIELDS.length, new Set(hi.CALLER_POPULATED_FIELDS).size], [21, 21]);
check('every listed field is actually read by runModel',
  hi.CALLER_POPULATED_FIELDS.filter(f => reads.indexOf(f) === -1), []);
check('every source column exists in game_log',
  hi.FIELD_SOURCES.filter(f => f.column && !columns.has(f.column)).map(f => f.column)
    .concat(hi.FIELD_SOURCES.filter(f => f.stateColumn && !columns.has(f.stateColumn)).map(f => f.stateColumn)), []);
check('every field has exactly one of column / source / unavailable',
  hi.FIELD_SOURCES.filter(f => [f.column, f.source, f.unavailable].filter(Boolean).length !== 1).map(f => f.field), []);
check('the no-source fields are exactly roster x2 + availability',
  hi.FIELD_SOURCES.filter(f => f.unavailable).map(f => f.field),
  ['awayRosterSet', 'homeRosterSet', 'bullpenAvailability']);

console.log('');
console.log('2. the mode switch');
check('default is persisted', hi.harnessInputsMode(), 'persisted');
process.env.HARNESS_INPUTS = 'legacy';
check('legacy', hi.harnessInputsMode(), 'legacy');
process.env.HARNESS_INPUTS = 'persist';
let threw = false;
try { hi.harnessInputsMode(); } catch (e) { threw = true; }
check('a typo THROWS rather than silently scoring one of the two', threw, true);
delete process.env.HARNESS_INPUTS;

console.log('');
console.log('3. populate reads each field from its source (synthetic row: exact values)');
// FRV and the framing RECOMPUTE touch the DB through frv-backtest; the row
// below is built so neither can supply the values being checked.
const row = {
  game_date: '2026-07-01', game_id: 'zzz-yyy', away_team: 'ZZZ', home_team: 'YYY',
  away_lineup_json: '[]', home_lineup_json: '[]',
  away_bullpen_woba: 0.311, away_bullpen_woba_vs_l: 0.301, away_bullpen_woba_vs_r: 0.321,
  home_bullpen_woba: 0.333, home_bullpen_woba_vs_l: 0.323, home_bullpen_woba_vs_r: 0.343,
  away_catcher_framing_rv_per_game: 0.042, away_catcher_framing_state: 'applied',
  home_catcher_framing_rv_per_game: null,  home_catcher_framing_state: 'no_roster_match',
  away_opener_forecast_ip: 1.2, home_opener_forecast_ip: null,
  away_bulk_forecast_ip: 4.4, home_bulk_forecast_ip: null,
  bulk_guy_away: 'Some Bulk', bulk_guy_home: null,
  tandem_subtype_away: 'opener_bulk', tandem_subtype_home: null,
};
hi.resetHarnessInputsStats();
const w = quiet(() => hi.populateCallerInputs({}, row, {}));
for (const f of hi.FIELD_SOURCES) {
  if (!f.column) continue;
  check('persisted: ' + f.field + ' = row.' + f.column, w[f.field], row[f.column]);
}
check('framing NULL with an emit state stays NULL (a real no-framing, not a gap)',
  w.homeCatcherFramingRvPerGame, null);
check('roster and availability are left undefined, not invented',
  [w.awayRosterSet, w.homeRosterSet, w.bullpenAvailability], [undefined, undefined, undefined]);
check('counters: 2 bullpen sides persisted, 2 framing sides persisted, 0 recomputed',
  [hi.harnessInputsStats().bullpenPersisted, hi.harnessInputsStats().framingPersisted,
   hi.harnessInputsStats().framingRecomputed], [2, 2, 0]);

const noState = Object.assign({}, row, { away_catcher_framing_state: null, home_catcher_framing_state: null });
hi.resetHarnessInputsStats();
quiet(() => hi.populateCallerInputs({}, noState, {}));
check('framing with NO emit state falls back to the recompute, and is counted',
  hi.harnessInputsStats().framingRecomputed, 2);

const noBp = Object.assign({}, row, { away_bullpen_woba: null, home_bullpen_woba: null });
hi.resetHarnessInputsStats();
const wNoBp = quiet(() => hi.populateCallerInputs({}, noBp, {}));
check('no persisted bullpen: left undefined and counted, NOT recomputed from today',
  [wNoBp.awayBullpenWoba, hi.harnessInputsStats().bullpenMissing], [undefined, 2]);

process.env.HARNESS_INPUTS = 'legacy';
const wl = quiet(() => hi.populateCallerInputs({}, row, {}));
check('legacy: the bullpen is NOT populated (reproduces the 4-field harness)',
  wl.awayBullpenWoba, undefined);
check('legacy: framing is recomputed, not read from the column',
  wl.awayCatcherFramingRvPerGame === row.away_catcher_framing_rv_per_game, false);
delete process.env.HARNESS_INPUTS;

console.log('');
console.log('4. settings that act only through a frozen input are refused; shared ones are flagged');
check('BULLPEN_W_PROJ is whole-frozen', (hi.persistedInputConflict('BULLPEN_W_PROJ') || {}).whole, true);
check('BP_STRONG_WEIGHT_R is whole-frozen', (hi.persistedInputConflict('BP_STRONG_WEIGHT_R') || {}).whole, true);
check('CATCHER_FRAMING_TAKES_PER_GAME is whole-frozen',
  (hi.persistedInputConflict('CATCHER_FRAMING_TAKES_PER_GAME') || {}).whole, true);
check('CATCHER_FRAMING_MUTE is NOT frozen (runModel applies it to the raw rv)',
  hi.persistedInputConflict('CATCHER_FRAMING_MUTE'), null);
check('CATCHER_FRAMING_ENABLED is NOT frozen', hi.persistedInputConflict('CATCHER_FRAMING_ENABLED'), null);
check('DEFENSE_FRV_ENABLED is NOT frozen (FRV is computed as-of, not copied)',
  hi.persistedInputConflict('DEFENSE_FRV_ENABLED'), null);
check('W_PROJ is partial', (hi.persistedInputConflict('W_PROJ') || {}).whole, false);
// The two keys that each exposed a stripper bug, in the direction each went wrong.
check('BULLPEN_AVG is NOT frozen: runModel reads settings.BULLPEN_AVG '
  + '(a `/*` inside a `//` comment once deleted 36,560 chars of model.js)',
  hi.persistedInputConflict('BULLPEN_AVG'), null);
check('CATCHER_FRAMING_MIN_PITCHES_2026 IS whole-frozen: only COMMENTS on the runModel path mention it '
  + '(a quote inside a regex literal once turned those comments into a string)',
  (hi.persistedInputConflict('CATCHER_FRAMING_MIN_PITCHES_2026') || {}).whole, true);
const S = hi.stripJsComments;
check('strip: a line comment containing /* does not open a block',
  S('a = 1; // x/* y\nb = KEEP;\n/* z */'), 'a = 1; \nb = KEEP;\n');
check('strip: // and /* inside strings survive',
  S("u = 'http://x/*y'; // gone"), "u = 'http://x/*y'; ");
check('strip: a quote inside a regex literal does not open a string',
  S("r = /['\"]/g; // KEY in comment\nk = 1;"), "r = /['\"]/g; \nk = 1;");
check('strip: division is not mistaken for a regex', S('x = a / b; // c\ny = 2 / 3;'), 'x = a / b; \ny = 2 / 3;');
{
  const vm = require('vm');
  const bad = [];
  for (const f of ['services/model.js', 'services/scraper.js', 'services/park-factors.js',
                   'services/park-factors-woba.js', 'services/stint-cache.js', 'utils/names.js']) {
    const out = S(fs.readFileSync(path.join(R, f), 'utf8'));
    try { new vm.Script('(function(require,module,exports,__dirname){' + out + '\n})'); }
    catch (e) { bad.push(f + ': ' + e.message); }
  }
  check('stripped runModel-path sources still PARSE (a stripper that deletes code breaks this)', bad, []);
}
process.env.HARNESS_INPUTS = 'legacy';
check('legacy mode reports no conflict (nothing is frozen there)',
  hi.persistedInputConflict('BULLPEN_W_PROJ'), null);
delete process.env.HARNESS_INPUTS;

// Fail-closed direction: every setting the frozen computations read must be
// classified. The bullpen wiring in processGameSignals runs from the _wProj
// read to the getBullpenWobaBlended calls; framing reads live in
// utils/framing-rate.js.
const jobsSrc = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
const a = jobsSrc.indexOf('const _wProj = ');
const b = jobsSrc.indexOf('const awayBp = q.getBullpenWobaBlended(');
check('bullpen wiring anchors found in jobs.js', a > 0 && b > a, true);
const frSrc = fs.readFileSync(path.join(R, 'utils/framing-rate.js'), 'utf8');
const computationKeys = [...new Set(
  ((jobsSrc.slice(a, b) + '\n' + frSrc).match(/settings\.([A-Z][A-Z0-9_]+)|\bs\.([A-Z][A-Z0-9_]+)/g) || [])
    .map(m => m.replace(/^(settings|s)\./, '')))].sort();
check('the scan finds the computation settings (sanity)', computationKeys.length >= 10, true);
check('every setting a frozen computation reads is classified (whole or partial)',
  computationKeys.filter(k => !hi.persistedInputConflict(k)), []);
check('PARK_NEUTRAL_INPUTS_ENABLED reaches the bullpen via resolveNeutralizationFactor',
  /resolveNeutralizationFactor/.test(jobsSrc.slice(b - 2000, b)) && /PARK_NEUTRAL_INPUTS_ENABLED/.test(modelSrc), true);

console.log('');
console.log('5. the harnesses use it');
const abSrc = fs.readFileSync(path.join(R, 'scripts/calibration-ab.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(R, 'scripts/calibration-sweep.js'), 'utf8');
const inSrc = fs.readFileSync(path.join(R, 'scripts/calibration-ab-inputs.js'), 'utf8');
check('calibration-ab.js refuses a whole-frozen param', /persistedInputConflict\(PARAM\)/.test(abSrc), true);
check('calibration-sweep.js refuses a whole-frozen param (checked over the keys the grid changes)',
  /persistedInputConflict\(/.test(swSrc) && /applySweepOverrides\(baseSettings, \{ \[PARAM\]: GRID\[0\] \}\)/.test(swSrc), true);
check('calibration-ab.js echoes the input mode', /harnessInputsLine\(\)/.test(abSrc), true);
check('calibration-sweep.js echoes the input mode', /harnessInputsLine\(\)/.test(swSrc), true);
check('calibration-ab-inputs.js pins the legacy baseline it measures against',
  /process\.env\.HARNESS_INPUTS = 'legacy'/.test(inSrc), true);
check('calibration-ab-inputs.js injects through the shared helper', /hi\.injectGroup\(/.test(inSrc), true);

console.log('');
console.log('6. on a real row, the persisted inputs reach runModel');
const ps = require(path.join(R, 'services/parameter-sweep'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel } = require(path.join(R, 'services/model'));
const settings = quiet(() => jobs.getSettings());
const cands = db.prepare(
  "SELECT * FROM game_log WHERE away_bullpen_woba IS NOT NULL AND home_bullpen_woba IS NOT NULL "
  + "AND away_catcher_framing_state IS NOT NULL AND model_total IS NOT NULL "
  + "AND home_score IS NOT NULL AND market_home_ml IS NOT NULL ORDER BY game_date DESC LIMIT 200").all();
let probe = null;
for (const c of cands) {
  const idx = ps.loadWobaSnapshot(db, c.game_date);
  if (!idx) continue;
  const pre = quiet(() => ps.preScreenGame(c, idx, settings));
  if (pre) { probe = { c, idx }; break; }
}
check('found a probe row preScreenGame accepts', !!probe, true);
if (probe) {
  const persisted = quiet(() => hi.populateCallerInputs(ps.preScreenGame(probe.c, probe.idx, settings), probe.c, settings));
  process.env.HARNESS_INPUTS = 'legacy';
  const legacy = quiet(() => hi.populateCallerInputs(ps.preScreenGame(probe.c, probe.idx, settings), probe.c, settings));
  delete process.env.HARNESS_INPUTS;
  check('persisted bullpen equals the column on ' + probe.c.game_date + ' ' + probe.c.game_id,
    [persisted.awayBullpenWoba, persisted.homeBullpenWoba],
    [probe.c.away_bullpen_woba, probe.c.home_bullpen_woba]);
  check('persisted framing equals the column',
    [persisted.awayCatcherFramingRvPerGame, persisted.homeCatcherFramingRvPerGame],
    [probe.c.away_catcher_framing_rv_per_game, probe.c.home_catcher_framing_rv_per_game]);
  const pP = quiet(() => runModel(persisted, probe.idx, settings, 'opener_aware', true));
  const pL = quiet(() => runModel(legacy, probe.idx, settings, 'opener_aware', true));
  check('runModel p(home) differs between legacy and persisted inputs (the swap is seen)',
    !!(pP && pL && pP.adjHW != null && pL.adjHW != null && Math.abs(pP.adjHW - pL.adjHW) > 1e-12), true);
}

console.log('');
console.log('7. the registry marks the rows whose evidence predates this change');
const reg = require(path.join(R, 'services/feature-gate-registry'));
const marked = reg.GATES.filter(g => g.evidence_predates);
// PINNED on purpose, in BOTH directions. Removing a row is correct only when
// it has been re-run and its new figures recorded; adding one is correct only
// when a run that predates 2026-09-16 is actually being quoted. Either edit
// has to touch this test, which is the point of pinning the set rather than
// counting it.
//
// catcher_framing_mute ADDED 2026-09-23: its two A/B runs (2026-08-22 n=790
// on an 82-day-stale framing table, 2026-08-24 n=349 on fresh) both read
// framing RECOMPUTED from current state rather than from persisted emit-time
// game_log values. harness-inputs.js names CATCHER_FRAMING_MUTE as the
// parameter that reported "0 of 790 -- the flag is inert" under the old
// path, so this row is squarely in the rebaselined set.
check('the rows measured through populateCallerInputs before 2026-09-16', marked.map(g => g.id).sort(), [
  'bullpen_woba_neutralization', 'catcher_framing_mute', 'defense_frv_enabled',
  'defense_frv_split', 'park_neutral_inputs_enabled', 'signal_edge_cap_enabled',
  'signal_edge_hard_cap_pp', 'use_hand_conditional_sp_weight',
]);
check('every marker names a known event and carries measured/harness/figures',
  marked.filter(g => !reg.REBASELINE_EVENTS[g.evidence_predates.event]
    || !g.evidence_predates.measured || !g.evidence_predates.harness || !g.evidence_predates.figures)
    .map(g => g.id), []);
check('every harness a marker cites exists',
  marked.filter(g => !fs.existsSync(path.join(R, g.evidence_predates.harness))).map(g => g.id), []);
const ev = reg.evaluateGates(db, { today: '2026-09-16' });
check('evaluateGates passes the marker through, with the event date',
  ev.gates.filter(g => g.evidence_predates).map(g => g.evidence_predates.event_date),
  marked.map(() => '2026-09-16'));
check('the marker alone never raises needs_attention',
  ev.gates.filter(g => g.evidence_predates && g.needs_attention
    && g.status === reg.STATUS.DECIDED && !g.blocked_reason).map(g => g.id), []);
const lines = [];
{
  const L = console.log, W = console.warn;
  console.log = (m) => lines.push(String(m)); console.warn = () => {};
  try { reg.logGateHealth(db, { today: '2026-09-16' }); } finally { console.log = L; console.warn = W; }
}
check('the 6AM gate-health pass lists them on one line',
  lines.some(l => /8 gate\(s\) quote evidence measured before the 2026-09-16 harness_inputs_persisted/.test(l)), true);

if (saved === undefined) delete process.env.HARNESS_INPUTS; else process.env.HARNESS_INPUTS = saved;
console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
