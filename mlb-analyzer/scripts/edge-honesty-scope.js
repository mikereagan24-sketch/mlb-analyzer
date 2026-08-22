'use strict';
// Scope of the edge-calibration finding: claimed edge does not translate
// into realised edge (2026-08-22 W_PIT calibration sweep found an OLS
// slope of -0.313, CI [-0.907, +0.548] — spans 0, excludes 1.0).
//
// Question this answers: is that slope uniform, or is there a regime
// where the claimed edge IS honest?
//
//   1. ML vs totals — separately, since they are different markets.
//   2. By claimed-edge MAGNITUDE — does it degrade with size? If it
//      collapses above ~8pp that independently justifies the existing
//      SIGNAL_EDGE_HARD_CAP=0.08, which was set from a different
//      analysis.
//   3. By month, by park run-environment.
//   4. Implied shrinkage: slope s is the multiplier that would make the
//      claimed edge honest.
//
// Framing, chosen to avoid ANY selection:
//   one observation per game per market, always the same side (home for
//   ML, over for totals), so no conditioning on what the model picked.
//     x = p_model(side)  - p_market_devig(side)      claimed edge
//     y = outcome(side)  - p_market_devig(side)      realised excess
//   slope 1.0 = claimed edge fully real, 0.0 = pure noise, <0 = backwards.
//   The away/under side is the exact mirror, so this is unconditional.
//
// Market probs are DE-VIGGED from both sides. Note production's own
// `edge` field compares against the RAW vigged implied price, so the
// edges the model reports are systematically smaller than the honest
// ones measured here.
//
// Run: <node20>/node.exe scripts/edge-honesty-scope.js [from] [to]
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const { runModel } = require('../services/model');
const jobs = require('../services/jobs');

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-07';
const N_BOOT = 3000;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const st = jobs.getSettings();
const TOT_SLOPE = Number(st.TOT_SLOPE != null ? st.TOT_SLOPE : 0.08);
const TOT_PROB_LO = 0.15, TOT_PROB_HI = 0.85;

let _s = 20260822;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const impl = (px) => px == null ? null : (px < 0 ? Math.abs(px) / (Math.abs(px) + 100) : 100 / (px + 100));

console.log('=== edge-honesty scope ===');
console.log('  window ' + FROM + '..' + TO + '   TOT_SLOPE=' + TOT_SLOPE);
console.log('  one observation per game per market, fixed side — no selection');
console.log('');

const games = ps.loadGames(db, FROM, TO);
const cache = new Map();
for (const g of games) if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));

const ml = [], tot = [];
const real = console.log; console.log = () => {};
for (const g of games) {
  const idx = cache.get(g.game_date);
  if (!idx || g.home_score == null || g.away_score == null) continue;
  const w = ps.preScreenGame(g, idx, st);
  if (!w) continue;
  const mr = runModel(w, idx, st, 'opener_aware', true);
  if (!mr || mr._suppressed) continue;
  const meta = { d: g.game_date, id: g.game_id, team: g.home_team, pf: g.park_factor };

  // ---- ML, home side ----
  const ph = impl(g.market_home_ml), pa = impl(g.market_away_ml);
  if (ph != null && pa != null && (ph + pa) > 0 && mr.adjHW != null && isFinite(mr.adjHW)) {
    const m = ph / (ph + pa);
    ml.push(Object.assign({ x: mr.adjHW - m, y: (g.home_score > g.away_score ? 1 : 0) - m, mkt: m }, meta));
  }
  // ---- totals, over side ----
  const po = impl(g.over_price), pu = impl(g.under_price);
  const at = g.actual_total != null ? g.actual_total : (g.away_score + g.home_score);
  if (po != null && pu != null && (po + pu) > 0 && g.market_total != null
      && mr.estTot != null && isFinite(mr.estTot) && at !== g.market_total) {
    const m = po / (po + pu);
    const pOver = Math.min(Math.max(0.5 + (mr.estTot - g.market_total) * TOT_SLOPE, TOT_PROB_LO), TOT_PROB_HI);
    tot.push(Object.assign({ x: pOver - m, y: (at > g.market_total ? 1 : 0) - m, mkt: m }, meta));
  }
}
console.log = real;

const slope = (a) => {
  if (a.length < 15) return null;
  const mx = a.reduce((p, r) => p + r.x, 0) / a.length, my = a.reduce((p, r) => p + r.y, 0) / a.length;
  let n = 0, d = 0;
  for (const r of a) { n += (r.x - mx) * (r.y - my); d += (r.x - mx) ** 2; }
  return d > 0 ? n / d : null;
};
// Date-clustered bootstrap: same-slate observations share market state.
const slopeCI = (a, B) => {
  if (a.length < 15) return null;
  const byD = new Map();
  for (const r of a) { if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(r); }
  const ds = [...byD.keys()];
  const reps = [];
  for (let b = 0; b < (B || N_BOOT); b++) {
    const s = [];
    for (let k = 0; k < ds.length; k++) s.push(...byD.get(ds[Math.floor(rnd() * ds.length)]));
    const v = slope(s);
    if (v != null) reps.push(v);
  }
  if (reps.length < 50) return null;
  reps.sort((p, q) => p - q);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
};
const fmt = (x, d) => x == null ? '   n/a' : ((x >= 0 ? '+' : '') + x.toFixed(d == null ? 3 : d));
const line = (label, a, pad) => {
  const s = slope(a), ci = slopeCI(a);
  console.log('  ' + String(label).padEnd(pad || 22) + String(a.length).padStart(6)
    + fmt(s).padStart(9) + '   '
    + (ci ? ('[' + fmt(ci.lo) + ', ' + fmt(ci.hi) + ']').padEnd(20) : 'n/a'.padEnd(20))
    + (ci ? (ci.lo > 0 ? '  excl 0 (real)' : ci.hi < 0 ? '  excl 0 (BACKWARDS)' : '  spans 0')
          + (ci.hi < 1 ? ', excl 1.0' : '') : ''));
};

console.log('=== 1. by market ===');
console.log('  group                     n    slope   95% CI');
line('ML (home side)', ml);
line('Totals (over side)', tot);
line('pooled', ml.concat(tot));
console.log('');

console.log('=== 2. by claimed-edge magnitude — does it degrade with size? ===');
console.log('  SIGNAL_EDGE_HARD_CAP = 0.08 (8pp). If honesty collapses above');
console.log('  that, the cap is independently justified.');
for (const [name, arr] of [['ML', ml], ['TOT', tot]]) {
  console.log('  -- ' + name + ' --');
  console.log('  |claimed edge|            n    slope   95% CI');
  for (const [lo, hi] of [[0, 0.02], [0.02, 0.04], [0.04, 0.08], [0.08, 1]]) {
    line((lo * 100).toFixed(0) + '-' + (hi > 0.5 ? '+' : (hi * 100).toFixed(0)) + 'pp',
      arr.filter(r => Math.abs(r.x) >= lo && Math.abs(r.x) < hi));
  }
  // straight split at the cap
  line('BELOW cap (<8pp)', arr.filter(r => Math.abs(r.x) < 0.08));
  line('ABOVE cap (>=8pp)', arr.filter(r => Math.abs(r.x) >= 0.08));
  console.log('');
}

console.log('=== 3. binned realised vs claimed (ML) — more robust than within-bin slope ===');
console.log('  claimed bin              n   mean claimed   mean realised    ratio');
for (const [lo, hi] of [[-1, -0.08], [-0.08, -0.04], [-0.04, -0.02], [-0.02, 0.02], [0.02, 0.04], [0.04, 0.08], [0.08, 1]]) {
  const g = ml.filter(r => r.x >= lo && r.x < hi);
  if (g.length < 12) { console.log('  ' + (lo + '..' + hi).padEnd(22) + String(g.length).padStart(5) + '   (too few)'); continue; }
  const mc = g.reduce((p, r) => p + r.x, 0) / g.length, mr = g.reduce((p, r) => p + r.y, 0) / g.length;
  const se = Math.sqrt(g.reduce((p, r) => p + (r.y - mr) ** 2, 0) / g.length) / Math.sqrt(g.length);
  console.log('  ' + (lo + '..' + hi).padEnd(22) + String(g.length).padStart(5)
    + fmt(mc, 4).padStart(15) + fmt(mr, 4).padStart(15) + ' +/-' + se.toFixed(3)
    + (Math.abs(mc) > 1e-6 ? fmt(mr / mc, 2).padStart(9) : '     n/a'));
}
console.log('');

console.log('=== 4. by month ===');
console.log('  group                     n    slope   95% CI');
for (const m of [...new Set(ml.map(r => r.d.slice(0, 7)))].sort()) {
  line('ML ' + m, ml.filter(r => r.d.slice(0, 7) === m));
}
for (const m of [...new Set(tot.map(r => r.d.slice(0, 7)))].sort()) {
  line('TOT ' + m, tot.filter(r => r.d.slice(0, 7) === m));
}
console.log('');

console.log('=== 5. by park run environment (park_factor tertile) ===');
const pfs = ml.map(r => r.pf).filter(x => x != null).sort((a, b) => a - b);
if (pfs.length > 30) {
  const t1 = pfs[Math.floor(pfs.length / 3)], t2 = pfs[Math.floor(2 * pfs.length / 3)];
  console.log('  tertile cuts: pf < ' + t1.toFixed(3) + ' | ' + t1.toFixed(3) + '-' + t2.toFixed(3) + ' | >= ' + t2.toFixed(3));
  console.log('  group                     n    slope   95% CI');
  for (const [name, f] of [['pitcher parks', r => r.pf != null && r.pf < t1],
                           ['neutral parks', r => r.pf != null && r.pf >= t1 && r.pf < t2],
                           ['hitter parks', r => r.pf != null && r.pf >= t2]]) {
    line('ML ' + name, ml.filter(f));
    line('TOT ' + name, tot.filter(f));
  }
} else console.log('  insufficient park_factor coverage');
console.log('');

console.log('=== 6. implied shrinkage ===');
const sML = slope(ml), sT = slope(tot), cML = slopeCI(ml), cT = slopeCI(tot);
const rec = (n, s, ci) => {
  if (s == null) { console.log('  ' + n + ': n/a'); return; }
  console.log('  ' + n.padEnd(8) + ' slope=' + fmt(s) + '  => honest edge is about '
    + (s * 100).toFixed(0) + '% of claimed'
    + (ci ? '  (CI ' + (ci.lo * 100).toFixed(0) + '%..' + (ci.hi * 100).toFixed(0) + '%)' : ''));
};
rec('ML', sML, cML);
rec('Totals', sT, cT);
console.log('');
console.log('  A shrinkage multiplier is only actionable if its CI excludes BOTH');
console.log('  0 and 1 — otherwise "shrink to nothing" and "do not shrink" are');
console.log('  both inside the interval and the data cannot choose.');
console.log('');

// ---- 7. the two framing facts, with CIs -----------------------------
// The slope is low-power by construction (it asks a second-order
// question). These two are higher-power and decide the interpretation:
//   does the model have ANY skill?      model vs base rate
//   is it worse than the market?        model vs de-vigged market
console.log('=== 7. framing facts: log loss, date-clustered CIs ===');
const EPS = 1e-9;
const clamp = (q) => Math.min(1 - EPS, Math.max(EPS, q));
const llOf = (rows, pick) => {
  let t = 0;
  for (const r of rows) { const q = clamp(pick(r)), y = r.yBin; t += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
  return t / rows.length;
};
// rebuild per-row absolute probabilities for the ML set
const mlAbs = ml.map(r => ({ d: r.d, pModel: r.mkt + r.x, pMkt: r.mkt, yBin: r.y + r.mkt }));
const baseRate = mlAbs.reduce((a, r) => a + r.yBin, 0) / mlAbs.length;
const diffCI = (pickA, pickB, B) => {
  const byD = new Map();
  for (const r of mlAbs) { if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(r); }
  const ds = [...byD.keys()], reps = [];
  for (let b = 0; b < (B || N_BOOT); b++) {
    const s2 = [];
    for (let k = 0; k < ds.length; k++) s2.push(...byD.get(ds[Math.floor(rnd() * ds.length)]));
    reps.push(llOf(s2, pickA) - llOf(s2, pickB));
  }
  reps.sort((a, b) => a - b);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
};
const llModel = llOf(mlAbs, r => r.pModel), llMkt = llOf(mlAbs, r => r.pMkt), llBase = llOf(mlAbs, () => baseRate);
console.log('  n=' + mlAbs.length + '  base rate=' + (100 * baseRate).toFixed(2) + '%');
console.log('    model  log loss = ' + llModel.toFixed(5));
console.log('    market log loss = ' + llMkt.toFixed(5));
console.log('    base   log loss = ' + llBase.toFixed(5));
const d1 = diffCI(r => r.pModel, () => baseRate);
const d2 = diffCI(r => r.pModel, r => r.pMkt);
const verdict = (c) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0) ? '*** significant ***' : 'not significant';
console.log('    model - base   = ' + fmt(llModel - llBase, 5)
  + '   CI [' + fmt(d1.lo, 5) + ', ' + fmt(d1.hi, 5) + ']   ' + verdict(d1)
  + (llModel < llBase ? '  (negative = model better)' : ''));
console.log('    model - market = ' + fmt(llModel - llMkt, 5)
  + '   CI [' + fmt(d2.lo, 5) + ', ' + fmt(d2.hi, 5) + ']   ' + verdict(d2)
  + (llModel > llMkt ? '  (positive = model worse)' : ''));
console.log('');
console.log('  Skill and edge-honesty are different questions: a model can be');
console.log('  genuinely better than the base rate while its DEVIATIONS from a');
console.log('  sharper market carry no exploitable information.');
console.log('');

// ---- 8. what would it take -------------------------------------------
console.log('=== 8. power ===');
const seFrom = (ci) => (ci.hi - ci.lo) / 3.92;
for (const [n2, a, ci] of [['ML', ml, cML], ['Totals', tot, cT]]) {
  if (!ci) continue;
  const se = seFrom(ci);
  const needDetect = Math.pow(se / 0.107, 2);   // 80% power to call slope 0.3 non-zero
  console.log('  ' + n2.padEnd(8) + 'slope SE ~ ' + se.toFixed(3) + ' at n=' + a.length
    + '  ->  ~' + needDetect.toFixed(1) + 'x the data ('
    + Math.round(a.length * needDetect) + ' games, ~'
    + (a.length * needDetect / 2430 * 1).toFixed(1) + ' full seasons) to resolve a true slope of 0.30');
}
