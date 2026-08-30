#!/usr/bin/env node
/**
 * Before/after for the wOBA park-factor source switch. (2026-08-30)
 *
 * The literal (fitted approximations, 2026-07-03) vs park_factors.woba_factor
 * (Savant index_woba, same pull as the run factor).
 *
 * TOTALS ONLY, for the reason services/park-factors.js states about the RUN
 * factor and which applies with equal force here: neutralization scales the
 * wOBA inputs of BOTH teams, so it moves the run estimate and leaves the
 * win-probability RATIO nearly untouched. An ML A/B is structurally blind
 * and would report "not significant" however wrong the factors are.
 *
 * Two things measured, because they answer different questions:
 *
 *   PER-TEAM      how far the source moved each park's factor, and what
 *                 that does to a neutralized wOBA. This is the input delta.
 *   GAME-WEIGHTED re-scoring real games both ways. This is what actually
 *                 reaches a price, and it is smaller than the input delta
 *                 because only the ACTUALS term is neutralized and it
 *                 carries weight W_ACT.
 *
 * Contamination filters match every other calibration on this corpus.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel } = require(path.join(R, 'services/model'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const { q } = require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const f = (v, d) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 4 : d);
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

(function main() {
  const settings = jobs.getSettings();
  if (!settings.PARK_NEUTRAL_INPUTS_ENABLED) {
    console.log('PARK_NEUTRAL_INPUTS_ENABLED is off — the switch is a no-op. Nothing to measure.');
    return;
  }

  // ---- per-team input delta -------------------------------------------
  const LIT = pfw.WOBA_PARK_FACTORS;
  const tbl = {};
  for (const r of q.listParkFactors.all()) if (r.woba_factor != null) tbl[r.team] = r.woba_factor;

  console.log('=== PER-TEAM: literal -> sourced ===');
  console.log('  neutralized wOBA shown for a .330 actuals input.');
  console.log('');
  console.log('  team   literal  sourced    d(factor)   neutral(lit)  neutral(src)   d(wOBA)');
  const rows = [];
  for (const t of Object.keys(tbl).sort()) {
    const lit = LIT[t], src = tbl[t];
    if (lit == null) continue;
    const nl = pfw.neutralizeWoba(0.330, lit), nsrc = pfw.neutralizeWoba(0.330, src);
    rows.push({ t, lit, src, df: src - lit, dw: nsrc - nl });
  }
  rows.sort((a, b) => Math.abs(b.dw) - Math.abs(a.dw));
  for (const r of rows) {
    console.log('  ' + r.t.padEnd(6) + r.lit.toFixed(2).padStart(7) + r.src.toFixed(3).padStart(9)
      + f(r.df, 3).padStart(12)
      + pfw.neutralizeWoba(0.330, r.lit).toFixed(4).padStart(14)
      + pfw.neutralizeWoba(0.330, r.src).toFixed(4).padStart(14)
      + f(r.dw).padStart(11));
  }
  console.log('');
  console.log('  mean |d factor| = ' + f(mean(rows.map(r => Math.abs(r.df))), 4)
    + '   mean |d wOBA| = ' + f(mean(rows.map(r => Math.abs(r.dw))), 4));
  const flipped = rows.filter(r => (r.lit - 1) * (r.src - 1) < 0);
  console.log('  parks whose factor CHANGED SIGN: ' + flipped.length
    + (flipped.length ? ' (' + flipped.map(r => r.t).join(', ') + ')' : ''));

  // ---- game-weighted impact -------------------------------------------
  // Re-score each game twice, swapping only the factor source. Everything
  // else -- lineups, settings, snapshot -- is held identical.
  console.log('');
  console.log('=== GAME-WEIGHTED: re-scored both ways ===');
  const games = ps.loadGames(db, '2026-04-01', '2026-12-31');
  const snap = new Map();
  // Override the CACHE, not the export. model.js destructures
  // getWobaParkFactor at require time, so swapping the export leaves the
  // model calling the original -- an A/B that compares two identical runs
  // and reports that nothing moved. That reads as 'safe to ship' and is
  // the same defect as an instrument wired around what it measures.
  const litMap = {};
  for (const t of Object.keys(LIT)) litMap[t] = LIT[t];
  const useLiteral = () => pfw.__setWobaFactorsForTest(litMap);
  const useSourced = () => pfw.__setWobaFactorsForTest(tbl);

  const dTot = [], dHome = [];
  let scored = 0, moved = 0;
  const real = console.log; console.log = () => {};
  for (const g of games) {
    if (!snap.has(g.game_date)) snap.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = snap.get(g.game_date); if (!idx) continue;
    const pre = ps.preScreenGame(g, idx, settings); if (!pre) continue;
    const w = hi.populateCallerInputs ? hi.populateCallerInputs(pre, g, settings) : pre;
    let a, b;
    try {
      useLiteral(); a = runModel(w || pre, idx, settings, 'opener_aware', true);
      useSourced(); b = runModel(w || pre, idx, settings, 'opener_aware', true);
    } catch (e) { continue; }
    if (!a || !b || a._suppressed || b._suppressed) continue;
    if (a.estTot == null || b.estTot == null) continue;
    scored++;
    const dt = b.estTot - a.estTot;
    if (Math.abs(dt) > 1e-9) moved++;
    dTot.push(dt);
    if (a.adjHW != null && b.adjHW != null) dHome.push(b.adjHW - a.adjHW);
  }
  pfw.__setWobaFactorsForTest(null);   // restore normal table loading
  console.log = real;

  const abs = dTot.map(Math.abs);
  console.log('  games scored both ways: ' + scored);
  console.log('  games whose total MOVED: ' + moved
    + (scored ? '  (' + (100 * moved / scored).toFixed(1) + '%)' : ''));
  console.log('');
  console.log('  d(model total), sourced - literal, in RUNS:');
  console.log('    mean ' + f(mean(dTot), 4) + '   median ' + f(med(dTot), 4));
  console.log('    mean |d| ' + f(mean(abs), 4) + '   median |d| ' + f(med(abs), 4)
    + '   p90 ' + f(abs.slice().sort((x, y) => x - y)[Math.floor(0.9 * abs.length)], 4)
    + '   max ' + f(Math.max.apply(null, abs), 4));
  console.log('');
  console.log('  d(p home win), for scale -- expected near zero because the');
  console.log('  factor scales both sides:');
  console.log('    mean |d| ' + f(mean(dHome.map(Math.abs)), 5)
    + '   max ' + f(Math.max.apply(null, dHome.map(Math.abs)), 5));
  console.log('');
  console.log('  The signed mean is the LEVEL shift: a non-zero value means the');
  console.log('  switch moves every total in one direction, which is a different');
  console.log('  thing from moving individual games and needs watching against');
  console.log('  the model\'s existing negative total bias.');
})();
