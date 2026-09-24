#!/usr/bin/env node
'use strict';
// PRODUCTION AND HARNESS MUST RESOLVE THE SAME SLOT THE SAME WAY.
//   <node20>/node.exe --max-old-space-size=1536 scripts/test-harness-prod-roster-agreement.js
// Exit 1 on any disagreement, or if LOST or CHANGED is non-zero.
//
// WHY THIS IS THE GATE AND NOT A NICETY. Stage 9 (utils/names.js) breaks an
// abbreviation tie using an injected roster predicate, and getBatterWoba
// derives that predicate from game.awayRosterSet / game.homeRosterSet. Those
// fields are filled by DIFFERENT CODE in the two paths:
//
//   production   services/jobs.js processGameSignals
//   harness      services/harness-inputs.js populateCallerInputs
//
// If those two ever disagree, production prices 548 lineup slots off actuals
// that no backtest can see, and every calibration number afterwards describes
// a model that is not the one running. That is precisely the
// harness_inputs_persisted failure -- a whole rebaseline event on 2026-09-16,
// recorded in services/feature-gate-registry.js as evidence_predates on eight
// rows. This file exists so the next instance is caught by a test instead of
// by a rebaseline.
//
// THREE THINGS IT CHECKS
//   1. the roster SETS are identical, per team, both builders;
//   2. every 2026 lineup slot resolves to the same wOBA under a
//      production-built game object and a harness-populated one;
//   3. the change is additive: GAINED may be anything, LOST and CHANGED are 0,
//      and every priced move is explained by a lookup gain on that platoon side.

const path = require('path');
const R = path.join(__dirname, '..');
const { fuzzyLookup } = require(path.join(R, 'utils/names'));
const sr = require(path.join(R, 'services/season-roster'));
const hi = require(path.join(R, 'services/harness-inputs'));
const model = require(path.join(R, 'services/model'));
const jobs = require(path.join(R, 'services/jobs'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

// SAMPLED BY DEFAULT. scripts/run-tests.js caps each test at 300s and the full
// season sweep takes ~10 minutes -- it was killed and reported as
// "unparseable (exit 1)", which is what a timeout looks like from the runner.
// A stride keeps this a gate that actually runs; --full does the whole season
// and is what the PR figures come from.
const FULL = process.argv.includes('--full');
const STRIDE = FULL ? 1 : 6;

const settings = quiet(() => jobs.getSettings());

// Memoised: seasonRosterSet is a pure function of the team, and the loop below
// would otherwise re-query it once per side per game (~2,800 times).
const _rosterMemo = new Map();
function rosterFor(team) {
  const k = String(team || '').toUpperCase();
  if (!_rosterMemo.has(k)) _rosterMemo.set(k, sr.seasonRosterSet(k));
  return _rosterMemo.get(k);
}
const MIN_PA = Number(settings.MIN_PA) || 60;
const W_PROJ = Number(settings.W_PROJ), W_ACT = Number(settings.W_ACT);

// ---------------------------------------------------------------- 1. the sets
console.log('\n1. the roster sets are identical in both builders');
const teams = db.prepare("SELECT DISTINCT team FROM team_rosters_season WHERE role='POS' ORDER BY team").all()
  .map(r => r.team);
console.log('   teams with a season roster: ' + teams.length);
const mismatched = [];
for (const t of teams) {
  const prod = rosterFor(t);
  const w = quiet(() => hi.populateCallerInputs({}, {
    game_date: '2026-07-01', game_id: 'agree', away_team: t, home_team: t }, settings));
  const a = [...(prod || [])].sort().join('|');
  const b = [...(w.awayRosterSet || [])].sort().join('|');
  if (a !== b) mismatched.push(t);
}
check('every team: production set === harness set', mismatched, []);
check('...and the sets are non-empty', teams.length > 0 && !!sr.seasonRosterSet(teams[0]), true);

// ---------------------------------------------------------------- 2/3. slots
console.log('\n2. every 2026 lineup slot resolves identically, and the change is additive');
const games = db.prepare(
  'SELECT game_date, away_team, home_team, away_sp_hand, home_sp_hand, '
  + 'away_lineup_json, home_lineup_json FROM game_log '
  + "WHERE game_date >= '2026-01-01' "
  + 'AND (away_lineup_json IS NOT NULL OR home_lineup_json IS NOT NULL) ORDER BY game_date').all();

let slots = 0, disagree = 0, same = 0;
// Counted at the LOOKUP level -- (slot x platoon side) -- because that is the
// unit stage 9 acts on and the unit #464 measured 548 of. Classifying at the
// getBatterWoba level instead reported 122 spurious "CHANGED": its `source` is
// already 'blend' whenever EITHER platoon side has actuals, so a gain on the
// second side keeps the source and only moves a value.
let lkGained = 0, lkLost = 0, lkChanged = 0;
// And the consistency property: a priced value may only move on a side whose
// actuals LOOKUP gained. Anything else would mean the change came from
// somewhere other than stage 9.
let priceMoved = 0, priceUnexplained = 0;
const dis = new Map(), gl = new Map(), un = new Map();
let curDate = null, idx = null;

let gi = -1;
for (const g of games) {
  gi++;
  if (gi % STRIDE) continue;
  if (g.game_date !== curDate) { curDate = g.game_date; idx = quiet(() => ps.loadWobaSnapshot(db, curDate)); }
  if (!idx) continue;
  // ONCE per game, not once per side: populateCallerInputs recomputes FRV for
  // both teams on every call, which was the bulk of the runtime.
  const hw = quiet(() => hi.populateCallerInputs({}, g, settings));
  for (const side of ['away', 'home']) {
    const raw = g[side + '_lineup_json']; if (!raw) continue;
    let lu = null; try { lu = JSON.parse(raw); } catch (e) { continue; }
    const team = g[side + '_team'];
    // PRODUCTION builds it in processGameSignals; HARNESS in populateCallerInputs.
    const prodSet = rosterFor(team);
    const harnSet = side === 'away' ? hw.awayRosterSet : hw.homeRosterSet;
    const onTeamProd = sr.onTeamPredicate(prodSet);
    for (const b of (lu || [])) {
      if (!b || !b.name) continue;
      slots++;
      const hand = b.hand || 'R';

      // ---- 1. prod vs harness, on the priced output
      const prodV = quiet(() => model.getBatterWoba(idx, b.name, hand, team, W_PROJ, W_ACT, MIN_PA, settings, prodSet));
      const harnV = quiet(() => model.getBatterWoba(idx, b.name, hand, team, W_PROJ, W_ACT, MIN_PA, settings, harnSet));
      // getBatterWoba returns { vsLHP, vsRHP, source } -- there is NO .woba on
      // it. Reading .woba compared undefined to undefined on every slot and
      // reported 29,052 identical, which is what a broken measurement looks
      // like from the outside.
      const fmt = (r) => (r == null ? null
        : [r.vsLHP == null ? 'x' : Number(r.vsLHP).toFixed(6),
           r.vsRHP == null ? 'x' : Number(r.vsRHP).toFixed(6), r.source].join('/'));
      const pv = fmt(prodV), hv = fmt(harnV);
      if (pv !== hv) {
        disagree++;
        const k = b.name + ' [' + team + '] prod=' + pv + ' harness=' + hv;
        dis.set(k, (dis.get(k) || 0) + 1);
      }

      // ---- 2. the lookup level: what stage 9 actually did, per platoon side
      const gainedSide = { lhp: false, rhp: false };
      for (const [tag, key] of [['lhp', 'bat-act-lhp'], ['rhp', 'bat-act-rhp']]) {
        const km = idx[key]; if (!km) continue;
        const before = fuzzyLookup(km, b.name, team);
        const after = fuzzyLookup(km, b.name, team, { minSample: MIN_PA, onTeam: onTeamProd });
        const bv = before ? Number(before.woba).toFixed(6) : null;
        const av = after ? Number(after.woba).toFixed(6) : null;
        if (bv === av) continue;
        if (bv == null) {
          lkGained++; gainedSide[tag] = true;
          const k = b.name + ' [' + team + '] ' + key + '  -> ' + av
            + ' (' + after.sample + ' PA)';
          gl.set(k, (gl.get(k) || 0) + 1);
        } else if (av == null) lkLost++;
        else lkChanged++;
      }

      // ---- 3. a priced value may only move where its side gained
      const off = quiet(() => model.getBatterWoba(idx, b.name, hand, team, W_PROJ, W_ACT, MIN_PA, settings, null));
      const ov = fmt(off);
      if (ov === pv) { same++; continue; }
      priceMoved++;
      const movedL = !off || !prodV || String(off.vsLHP) !== String(prodV.vsLHP);
      const movedR = !off || !prodV || String(off.vsRHP) !== String(prodV.vsRHP);
      if ((movedL && !gainedSide.lhp) || (movedR && !gainedSide.rhp)) {
        priceUnexplained++;
        const k = b.name + ' [' + team + '] ' + ov + ' -> ' + pv
          + '  gainedL=' + gainedSide.lhp + ' gainedR=' + gainedSide.rhp;
        un.set(k, (un.get(k) || 0) + 1);
      }
    }
  }
}

console.log('   games ' + (FULL ? 'ALL' : 'every ' + STRIDE + 'th (sample)')
  + '   lineup slots compared : ' + slots);
if (!FULL) {
  console.log('   full-season figures: node --max-old-space-size=1536 '
    + 'scripts/test-harness-prod-roster-agreement.js --full');
}
check('production and harness agree on every slot', disagree, 0);
if (dis.size) {
  for (const [k, n] of [...dis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log('      ' + String(n).padStart(4) + '  ' + k);
  }
}

console.log('');
console.log('   STAGE 9 AT THE LOOKUP LEVEL (slot x platoon side):');
console.log('      GAINED  ' + lkGained + '   an actuals row resolved where it used to be ambiguous');
console.log('      LOST    ' + lkLost);
console.log('      CHANGED ' + lkChanged);
for (const [k, n] of [...gl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('      ' + String(n).padStart(4) + '  ' + k);
}
check('lookup LOST is zero', lkLost, 0);
check('lookup CHANGED is zero', lkChanged, 0);

console.log('');
console.log('   PRICED OUTPUT:');
console.log('      unchanged            ' + same);
console.log('      moved                ' + priceMoved);
console.log('      moved UNEXPLAINED    ' + priceUnexplained + '   (a value moved on a side whose lookup did not gain)');
for (const [k, n] of [...un.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log('      ' + String(n).padStart(4) + '  ' + k);
}
check('every priced move is explained by a lookup gain on that side', priceUnexplained, 0);

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
