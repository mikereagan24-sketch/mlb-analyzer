'use strict';
// Is the ML-up / totals-down pattern across the W_PROJ grid a real
// opposing response, or an artifact of the signal mix shifting?
//
// ML count falls 400 -> 361 and totals rise 367 -> 382 across the grid,
// so the marginal signals crossing the emit floor could be doing the
// work rather than any repricing of the bets that stayed.
//
// Three separate cuts, all off the dumped signal tables (no re-scoring):
//
//   1. FIXED CORE. Signals present at ALL 10 grid values. A fixed bet
//      set, so any ROI movement here is pure repricing. If the pattern
//      survives this, it is real.
//   2. STAY / ENTER / LEAVE vs baseline, per grid value per bucket.
//      Separates "same bets, repriced" from "different bets".
//   3. Edge profile of the marginal signals — are enterers/leavers in
//      fact near-floor, as the mix-shift hypothesis assumes?
//
// Run: <node20>/node.exe tmp/decompose-wproj-signal-mix.js <tables.json>
const file = process.argv[2];
if (!file) { console.error('usage: decompose-wproj-signal-mix.js <wproj-signal-tables.json>'); process.exit(2); }
const data = require(file);
const GRID = data.grid, BASE = data.baseline;

const bucketOf = (s) => (s.category === 'favs' || s.category === 'dogs') ? 'ML' : 'TOT';
// Keyed by market type, not category: a model side-flip (favs <-> dogs
// on the same game) is a CHANGED bet, not a new one, and keying on
// category would misfile it as leave+enter. Flips are counted separately.
const key = (s) => s.game_date + '|' + s.game_id + '|' + bucketOf(s);
const roi = (arr) => {
  let p = 0, w = 0;
  for (const s of arr) { p += s.pnl; w += s.wagered; }
  return w > 0 ? (p / w) * 100 : null;
};
const f = (x, d) => x == null ? '   n/a' : ((x >= 0 ? '+' : '') + x.toFixed(d == null ? 2 : d));

const byW = new Map();
for (const t of data.tables) {
  const m = new Map();
  for (const s of t.signals) m.set(key(s), s);
  byW.set(t.w, m);
}
const baseMap = byW.get(BASE);

// ---- 1. fixed core --------------------------------------------------
let core = null;
for (const w of GRID) {
  const ks = new Set(byW.get(w).keys());
  core = core === null ? ks : new Set([...core].filter(k => ks.has(k)));
}
const coreML = [...core].filter(k => k.endsWith('|ML')).length;
const coreTOT = core.size - coreML;
console.log('=== 1. FIXED CORE — signals present at ALL 10 grid values ===');
console.log('  core size: ' + core.size + '  (ML ' + coreML + ', TOT ' + coreTOT + ')');
console.log('  vs baseline total ' + baseMap.size + ' -> core is '
  + (100 * core.size / baseMap.size).toFixed(1) + '% of the baseline bet set');
console.log('');
console.log('  Same bets at every grid point, so any movement here is REPRICING:');
console.log('  W_PROJ    core ROI%    core ML ROI%   core TOT ROI%');
const coreRows = [];
for (const w of GRID) {
  const m = byW.get(w);
  const all = [...core].map(k => m.get(k));
  const ml = all.filter(s => bucketOf(s) === 'ML');
  const tot = all.filter(s => bucketOf(s) === 'TOT');
  coreRows.push({ w, all: roi(all), ml: roi(ml), tot: roi(tot) });
  console.log('   ' + w.toFixed(2).padStart(5) + f(roi(all)).padStart(11)
    + f(roi(ml)).padStart(15) + f(roi(tot)).padStart(16)
    + (w === BASE ? '   <-- production' : ''));
}
const span = (sel) => {
  const v = coreRows.map(sel).filter(x => x != null);
  return Math.max(...v) - Math.min(...v);
};
console.log('');
console.log('  core ML  ROI span across the grid: ' + span(r => r.ml).toFixed(2) + 'pp');
console.log('  core TOT ROI span across the grid: ' + span(r => r.tot).toFixed(2) + 'pp');
console.log('  (compare: full-population ML span 4.33pp, TOT span 2.62pp)');
console.log('');

// ---- 2. stay / enter / leave ----------------------------------------
console.log('=== 2. STAY / ENTER / LEAVE vs baseline W_PROJ=' + BASE + ' ===');
for (const bucket of ['ML', 'TOT']) {
  console.log('');
  console.log('  -- ' + bucket + ' --');
  console.log('  W_PROJ  nStay  ROIstay@w  ROIstay@base   dStay   nEnter  ROIent  nLeave  ROIlv    dTotal   dStay%ofTotal');
  for (const w of GRID) {
    if (w === BASE) continue;
    const m = byW.get(w);
    const inB = (k) => baseMap.has(k);
    const wKeys = [...m.keys()].filter(k => k.endsWith('|' + bucket));
    const bKeys = [...baseMap.keys()].filter(k => k.endsWith('|' + bucket));
    const stayK = wKeys.filter(inB);
    const enterK = wKeys.filter(k => !inB(k));
    const leaveK = bKeys.filter(k => !m.has(k));
    const stayW = stayK.map(k => m.get(k));
    const stayB = stayK.map(k => baseMap.get(k));
    const enter = enterK.map(k => m.get(k));
    const leave = leaveK.map(k => baseMap.get(k));
    const rw = roi(wKeys.map(k => m.get(k)));
    const rb = roi(bKeys.map(k => baseMap.get(k)));
    const dTotal = (rw == null || rb == null) ? null : rw - rb;
    const dStay = (roi(stayW) == null || roi(stayB) == null) ? null : roi(stayW) - roi(stayB);
    const share = (dTotal && Math.abs(dTotal) > 1e-9 && dStay != null)
      ? (100 * dStay / dTotal) : null;
    console.log('   ' + w.toFixed(2).padStart(5) + String(stayK.length).padStart(7)
      + f(roi(stayW)).padStart(11) + f(roi(stayB)).padStart(12) + f(dStay).padStart(9)
      + String(enterK.length).padStart(8) + f(roi(enter)).padStart(9)
      + String(leaveK.length).padStart(8) + f(roi(leave)).padStart(9)
      + f(dTotal).padStart(10)
      + (share == null ? '      n/a' : (share.toFixed(0) + '%').padStart(9)));
  }
}
console.log('');

// ---- 3. edge profile of the marginal signals ------------------------
console.log('=== 3. edge profile — are the marginal signals near-floor? ===');
console.log('  edge in probability points (emit floor = 1.0pp)');
console.log('');
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pp = (s) => Math.abs(Number(s.edge_pp)) * 100;
for (const bucket of ['ML', 'TOT']) {
  console.log('  -- ' + bucket + ' --');
  console.log('  W_PROJ   stay p50   enter p50  enter p90   leave p50  leave p90   enter<1.5pp  leave<1.5pp');
  for (const w of GRID) {
    if (w === BASE) continue;
    const m = byW.get(w);
    const wKeys = [...m.keys()].filter(k => k.endsWith('|' + bucket));
    const bKeys = [...baseMap.keys()].filter(k => k.endsWith('|' + bucket));
    const stay = wKeys.filter(k => baseMap.has(k)).map(k => pp(m.get(k)));
    const enter = wKeys.filter(k => !baseMap.has(k)).map(k => pp(m.get(k)));
    const leave = bKeys.filter(k => !m.has(k)).map(k => pp(baseMap.get(k)));
    const nearE = enter.length ? (100 * enter.filter(x => x < 1.5).length / enter.length) : null;
    const nearL = leave.length ? (100 * leave.filter(x => x < 1.5).length / leave.length) : null;
    const g = (x) => x == null ? '  n/a' : x.toFixed(2);
    console.log('   ' + w.toFixed(2).padStart(5) + g(q(stay, .5)).padStart(11)
      + g(q(enter, .5)).padStart(12) + g(q(enter, .9)).padStart(11)
      + g(q(leave, .5)).padStart(12) + g(q(leave, .9)).padStart(11)
      + (nearE == null ? '   n/a' : (nearE.toFixed(0) + '%')).padStart(14)
      + (nearL == null ? '   n/a' : (nearL.toFixed(0) + '%')).padStart(13));
  }
  console.log('');
}

// ---- 4. side flips ---------------------------------------------------
// A "flip" = same game + same market, but a DIFFERENT bet. Comparing
// `category` alone under-counts: in a tight game both sides can carry
// negative American odds (e.g. -112 / -108), so a genuine away->home
// switch keeps category='favs' and looks like the same bet. Compare the
// realised bet instead — category, outcome, pnl and stake together.
const changedBet = (a, b) => a.category !== b.category || a.outcome !== b.outcome
  || a.pnl !== b.pnl || a.wagered !== b.wagered;
console.log('=== 4. changed bets among stayers (same game+market, different bet) ===');
console.log('  W_PROJ   ML   TOT   total   dStay!=0 explained?');
for (const w of GRID) {
  if (w === BASE) continue;
  const m = byW.get(w);
  let mlF = 0, totF = 0;
  for (const [k, s] of m) {
    const b = baseMap.get(k);
    if (!b) continue;
    if (changedBet(s, b)) { if (bucketOf(s) === 'ML') mlF++; else totF++; }
  }
  // recompute dStay for ML to confirm it is zero exactly when flips are zero
  const stayK = [...m.keys()].filter(k => baseMap.has(k) && k.endsWith('|ML'));
  const dStayML = roi(stayK.map(k => m.get(k))) - roi(stayK.map(k => baseMap.get(k)));
  console.log('   ' + w.toFixed(2).padStart(5) + String(mlF).padStart(5) + String(totF).padStart(6)
    + String(mlF + totF).padStart(8) + '     ML dStay=' + f(dStayML)
    + ((mlF === 0) === (Math.abs(dStayML) < 1e-9) ? '  consistent' : '  MISMATCH'));
}
