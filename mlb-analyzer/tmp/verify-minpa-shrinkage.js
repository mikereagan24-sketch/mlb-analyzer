'use strict';
// Verification for fix/woba-minpa-shrinkage-cliff.
//
//   A. BYTE-IDENTITY at or above the floor. Strict === on the raw
//      float, not a tolerance — this is the guard the whole change
//      rests on.
//   B. Pitchers byte-identical EVERYWHERE (no floor is passed; their
//      noise curve has not flattened by 150 BF).
//   C. Continuity across the MIN_PA join — the cliff is actually gone.
//   D. Weight total preserved at every sample size; projection weight
//      floored at wp and rising to wp+wa.
//   E. Monotone, bounded ramp.
//   F. Blast radius on the real snapshot corpus: how many lineup slots
//      move, by how much, and how much team wOBA / runs that is.
//
// Run: <node20>/node.exe tmp/verify-minpa-shrinkage.js
const path = require('path');
const Database = require('better-sqlite3');
const model = require('../services/model');
const { blendWoba, buildWobaIndex, getBatterWoba, getPitcherWoba, BATTER_ACT_FULL_WEIGHT_PA } = model;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + (detail ? ': ' + detail : ''));
};

const MIN_PA = 60, FLOOR = BATTER_ACT_FULL_WEIGHT_PA, WP = 0.45, WA = 0.55;
const mk = (woba, sample) => ({ woba, sample });

console.log('=== setup ===');
console.log('  MIN_PA=' + MIN_PA + '  floor=' + FLOOR + '  W_PROJ=' + WP + '  W_ACT=' + WA);
console.log('');

// ---- A. byte-identity at/above the floor ----------------------------
console.log('=== A. byte-identity at or above the floor (strict ===) ===');
const PROJ = [0.280, 0.305, 0.330, 0.345, 0.372, 0.410];
const ACT = [0.240, 0.295, 0.330, 0.351, 0.398, 0.455];
const SAMPLES = [150, 151, 160, 200, 275, 340, 480, 700];
let n = 0, moved = 0;
for (const p of PROJ) for (const a of ACT) for (const smp of SAMPLES) {
  const before = blendWoba(mk(p, 600), mk(a, smp), MIN_PA, WP, WA, null);
  const after = blendWoba(mk(p, 600), mk(a, smp), MIN_PA, WP, WA, null, FLOOR);
  n++;
  if (before.woba !== after.woba || before.source !== after.source) {
    moved++;
    if (moved <= 3) console.log('  MOVED proj=' + p + ' act=' + a + ' PA=' + smp + '  ' + before.woba + ' -> ' + after.woba);
  }
}
console.log('  combinations: ' + n + '   moved: ' + moved);
ok('nothing moves at or above the floor', moved === 0, moved + ' moved');

// The float trap this guards against.
console.log('  float note: 1 - ' + WA + ' = ' + (1 - WA) + ' (!== ' + WP + '), which is why');
console.log('              s===1 returns the caller weights untouched.');
ok('1-wa really is not wp', (1 - WA) !== WP);
console.log('');

// ---- B. pitchers untouched ------------------------------------------
console.log('=== B. pitcher path byte-identical everywhere ===');
const idx = buildWobaIndex([
  { data_key: 'pit-proj-rhb', player_name: 'P', woba: 0.300, sample_size: 500 },
  { data_key: 'pit-act-rhb', player_name: 'P', woba: 0.285, sample_size: 105 },
  { data_key: 'pit-proj-lhb', player_name: 'P', woba: 0.310, sample_size: 500 },
  { data_key: 'pit-act-lhb', player_name: 'P', woba: 0.295, sample_size: 130 },
]);
const pw = getPitcherWoba(idx, 'P', 'R', 'SEA', WP, WA, 100, {});
const expR = 0.300 * WP + 0.285 * WA;
ok('pitcher vsRHB unchanged at 105 BF', pw.vsRHB === expR, pw.vsRHB + ' vs ' + expR);
console.log('  pitcher vsRHB=' + pw.vsRHB + ' (expected full blend ' + expR + ')');
console.log('');

// ---- C. continuity across the join ----------------------------------
console.log('=== C. continuity across MIN_PA ===');
const P0 = 0.330, A0 = 0.400;   // deliberately large disagreement
const at = (smp) => {
  const r = blendWoba(mk(P0, 600), mk(A0, smp), MIN_PA, WP, WA, null, FLOOR);
  return r ? r.woba : null;
};
const belowGate = blendWoba(mk(P0, 600), mk(A0, MIN_PA - 1), MIN_PA, WP, WA, null, FLOOR);
const atGate = at(MIN_PA);
const justAbove = at(MIN_PA + 1);
console.log('  PA=' + (MIN_PA - 1) + ' (gate excludes actuals) -> ' + belowGate.woba.toFixed(6) + '  src=' + belowGate.source);
console.log('  PA=' + MIN_PA + '                              -> ' + atGate.toFixed(6));
console.log('  PA=' + (MIN_PA + 1) + '                              -> ' + justAbove.toFixed(6));
ok('at the gate equals pure projection', Math.abs(atGate - P0) < 1e-12, atGate + ' vs ' + P0);
ok('join is continuous', Math.abs(atGate - belowGate.woba) < 1e-12);
ok('step across the join is tiny', Math.abs(justAbove - belowGate.woba) < 0.001,
  'step=' + Math.abs(justAbove - belowGate.woba));

// what the OLD code did at the same boundary
const oldBelow = blendWoba(mk(P0, 600), mk(A0, MIN_PA - 1), MIN_PA, WP, WA, null);
const oldAbove = blendWoba(mk(P0, 600), mk(A0, MIN_PA + 1), MIN_PA, WP, WA, null);
console.log('  OLD behaviour: ' + oldBelow.woba.toFixed(6) + ' -> ' + oldAbove.woba.toFixed(6)
  + '   step = ' + Math.abs(oldAbove.woba - oldBelow.woba).toFixed(6) + ' wOBA in ONE PA');
console.log('  NEW behaviour: step = ' + Math.abs(justAbove - belowGate.woba).toFixed(6));
ok('new step is far smaller than old', Math.abs(justAbove - belowGate.woba) < Math.abs(oldAbove.woba - oldBelow.woba) / 100);
console.log('');

// ---- D + E. weight algebra ------------------------------------------
console.log('=== D/E. weight total, floor, monotonicity ===');
// Recover the implied weights from two blends with different act values.
const implied = (smp) => {
  const r1 = blendWoba(mk(0.300, 600), mk(0.400, smp), MIN_PA, WP, WA, null, FLOOR);
  const r2 = blendWoba(mk(0.300, 600), mk(0.500, smp), MIN_PA, WP, WA, null, FLOOR);
  const waEff = (r2.woba - r1.woba) / (0.500 - 0.400);
  const wpEff = (r1.woba - 0.400 * waEff) / 0.300;
  return { wpEff, waEff };
};
let badTotal = 0, badFloor = 0, lastWa = -1, nonMono = 0;
for (let smp = MIN_PA; smp <= FLOOR + 40; smp += 5) {
  const { wpEff, waEff } = implied(smp);
  if (Math.abs((wpEff + waEff) - (WP + WA)) > 1e-9) badTotal++;
  if (wpEff < WP - 1e-9 || wpEff > WP + WA + 1e-9) badFloor++;
  if (waEff < lastWa - 1e-9) nonMono++;
  lastWa = waEff;
}
ok('weight total preserved at every sample size', badTotal === 0, badTotal + ' bad');
ok('projection weight stays within [wp, wp+wa]', badFloor === 0, badFloor + ' out of range');
ok('actuals weight is monotone non-decreasing', nonMono === 0, nonMono + ' inversions');
const e60 = implied(MIN_PA), e105 = implied(105), e150 = implied(FLOOR), e300 = implied(300);
console.log('  PA=60   wProj=' + e60.wpEff.toFixed(4) + '  wAct=' + e60.waEff.toFixed(4));
console.log('  PA=105  wProj=' + e105.wpEff.toFixed(4) + '  wAct=' + e105.waEff.toFixed(4));
console.log('  PA=150  wProj=' + e150.wpEff.toFixed(4) + '  wAct=' + e150.waEff.toFixed(4) + '   <- floor, prod weights');
console.log('  PA=300  wProj=' + e300.wpEff.toFixed(4) + '  wAct=' + e300.waEff.toFixed(4));
ok('projection weight floored at 0.45 at the floor', Math.abs(e150.wpEff - WP) < 1e-9);
ok('pure projection at the gate', Math.abs(e60.wpEff - (WP + WA)) < 1e-9);
console.log('');

// ---- F. blast radius on the real corpus -----------------------------
console.log('=== F. blast radius on the snapshot corpus ===');
let db = null;
try { db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true }); }
catch (e) { console.log('  SKIPPED: ' + e.message); }
if (db) {
  const jobs = require('../services/jobs');
  const st = jobs.getSettings();
  const minPA = Number(st.MIN_PA != null ? st.MIN_PA : 60);
  const wProj = Number(st.W_PROJ), wAct = Number(st.W_ACT);
  const RUN_MULT = Number(st.RUN_MULT != null ? st.RUN_MULT : 46);
  const snapDates = new Set(db.prepare('SELECT DISTINCT snapshot_date d FROM woba_data_snapshot').all().map(r => r.d));
  const games = db.prepare(
    "SELECT game_date, game_id, away_team, home_team, away_lineup_json, home_lineup_json, away_sp_hand, home_sp_hand "
    + "FROM game_log WHERE game_date >= '2026-06-01' AND game_date <= '2026-08-07' "
    + "AND model_total IS NOT NULL AND weather_contamination_reason IS NULL ORDER BY game_date, game_id"
  ).all();
  const cache = new Map();
  const sj = (x) => { try { return JSON.parse(x) || []; } catch (e) { return []; } };
  let slots = 0, slotsMoved = 0, gamesTouched = 0;
  const slotDelta = [], teamDelta = [];
  const origBlend = model.blendWoba;
  for (const g of games) {
    if (!snapDates.has(g.game_date)) continue;
    if (!cache.has(g.game_date)) {
      const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data_snapshot WHERE snapshot_date=?').all(g.game_date);
      cache.set(g.game_date, rows.length ? buildWobaIndex(rows) : null);
    }
    const idx2 = cache.get(g.game_date);
    if (!idx2) continue;
    let touched = false;
    for (const side of ['away', 'home']) {
      const lu = sj(side === 'away' ? g.away_lineup_json : g.home_lineup_json);
      const team = side === 'away' ? g.away_team : g.home_team;
      if (!lu.length) continue;
      const oppHand = String((side === 'away' ? g.home_sp_hand : g.away_sp_hand) || 'R').toUpperCase();
      const key = oppHand === 'L' ? 'vsLHP' : 'vsRHP';
      const actKey = oppHand === 'L' ? 'bat-act-lhp' : 'bat-act-rhp';
      const projKey = oppHand === 'L' ? 'bat-proj-lhp' : 'bat-proj-rhp';
      let s0 = 0, s1 = 0, cnt = 0;
      for (const b of lu) {
        const nw = getBatterWoba(idx2, b.name, b.hand, team, wProj, wAct, minPA, st, null);
        if (!nw || nw[key] == null) continue;
        // reconstruct the pre-fix value by blending with no floor
        const pr = model._fuzzyForTest ? null : null;
        slots++;
        // find the raw rows the same way getBatterWoba does is internal;
        // instead detect movement by comparing against a no-floor blend
        // computed from the index maps directly.
        const pm = idx2[projKey] || {}, am = idx2[actKey] || {};
        const norm = model.normName(b.name);
        const pRow = pm[norm], aRow = am[norm];
        if (!pRow || !aRow) { s0 += nw[key]; s1 += nw[key]; cnt++; continue; }
        const before = origBlend(pRow, aRow, minPA, wProj, wAct, null);
        const after = origBlend(pRow, aRow, minPA, wProj, wAct, null, FLOOR);
        const bv = before ? before.woba : null, av = after ? after.woba : null;
        if (bv == null || av == null) continue;
        if (bv !== av) { slotsMoved++; slotDelta.push(Math.abs(av - bv)); touched = true; }
        s0 += bv; s1 += av; cnt++;
      }
      if (cnt) teamDelta.push(Math.abs(s0 / cnt - s1 / cnt));
    }
    if (touched) gamesTouched++;
  }
  const q = (a, p) => { if (!a.length) return 0; const x = [...a].sort((m, n2) => m - n2); return x[Math.min(x.length - 1, Math.floor(p * x.length))]; };
  console.log('  lineup slots evaluated: ' + slots);
  console.log('  slots whose wOBA moves: ' + slotsMoved + '  (' + (100 * slotsMoved / Math.max(1, slots)).toFixed(2) + '%)');
  console.log('  games with >=1 moved slot: ' + gamesTouched + ' of ' + games.length);
  if (slotDelta.length) {
    console.log('  |wOBA delta| on moved slots: p50=' + q(slotDelta, .5).toFixed(4)
      + '  p90=' + q(slotDelta, .9).toFixed(4) + '  max=' + Math.max.apply(null, slotDelta).toFixed(4));
  }
  console.log('  team-game |wOBA delta|: p50=' + q(teamDelta, .5).toFixed(5)
    + '  p90=' + q(teamDelta, .9).toFixed(5) + '  max=' + Math.max.apply(null, teamDelta).toFixed(5));
  console.log('  -> team-game run delta: p90=' + (q(teamDelta, .9) * RUN_MULT).toFixed(3)
    + '  max=' + (Math.max.apply(null, teamDelta) * RUN_MULT).toFixed(3) + ' runs');
}

console.log('');
console.log('=== TOTAL: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
