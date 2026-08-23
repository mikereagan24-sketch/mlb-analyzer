'use strict';
// DIAGNOSIS: why does a model with real inputs fail to beat a constant?
//
// docs/edge-honesty-scope-2026-08-22.md established that the assembled
// model is significantly WORSE than the market and NOT significantly
// better than predicting a constant 51.65%. This decomposes that.
//
// Each input is tested IN ISOLATION against outcomes on the calibration
// target, then against the assembled model:
//
//   sp      starting-pitcher quality differential
//   bp      bullpen quality differential
//   bat     lineup wOBA differential
//   pf      park factor
//   hfa     home-field advantage (degenerate for ML — it IS the
//           intercept, so it is reported as the base-rate test)
//   all4    optimal linear combination of sp/bp/bat/pf
//   model   the assembled model, as-is
//   model*  the assembled model RECALIBRATED (1-param logistic on its
//           own logit) — separates "wrong ordering" from "right
//           ordering, wrong scale"
//   market  de-vigged market probability (the ceiling)
//
// The two readings this is built to separate:
//   components beat base rate, assembled model does not
//     -> the COMBINATION is at fault (Pythag, weighting, runs->prob)
//   no component beats base rate either
//     -> the INPUTS carry no signal; a more fundamental problem
//
// HONESTY OF THE TEST. Every fitted predictor is scored ONLY on data it
// was not fitted to: 5 contiguous date-blocked folds, fit on 4, predict
// the held-out one, accumulate out-of-sample predictions over all games.
// The base rate is cross-fitted the same way. Fitting and scoring on the
// same rows would make every component look predictive.
//
// Run: <node20>/node.exe scripts/component-signal-diagnostic.js [from] [to]
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
// Caller-populated model inputs (FRV, catcher framing). Without this the
// scored model is missing both defensive inputs and the absolute figures
// describe a model that never runs in production. See services/harness-inputs.js.
const hi = require('../services/harness-inputs');
const { runModel, getBatterWoba, getPitcherWoba } = require('../services/model');
const jobs = require('../services/jobs');

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-07';
const N_FOLDS = 5, N_BOOT = 3000, RIDGE = 1e-3;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const st = jobs.getSettings();
const MIN_PA = Number(st.MIN_PA != null ? st.MIN_PA : 60);
const MIN_BF = Number(st.MIN_BF != null ? st.MIN_BF : 100);
const EPS = 1e-9;

let _s = 20260823;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const impl = (px) => px == null ? null : (px < 0 ? Math.abs(px) / (Math.abs(px) + 100) : 100 / (px + 100));
const clamp = (q) => Math.min(1 - EPS, Math.max(EPS, q));
const logit = (q) => Math.log(clamp(q) / (1 - clamp(q)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

console.log('=== component signal diagnostic ===');
console.log('  window ' + FROM + '..' + TO + '   folds=' + N_FOLDS + ' (date-blocked, out-of-sample)');
console.log('');

// ---- build per-game component vector --------------------------------
const games = ps.loadGames(db, FROM, TO);
const cache = new Map();
for (const g of games) if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));

const rows = [];
const realLog = console.log; console.log = () => {};
for (const g of games) {
  const idx = cache.get(g.game_date);
  if (!idx || g.home_score == null || g.away_score == null) continue;
  if (g.market_home_ml == null || g.market_away_ml == null) continue;
  const w = hi.populateCallerInputs(ps.preScreenGame(g, idx, st), g, st);
  if (!w) continue;
  const mr = runModel(w, idx, st, 'opener_aware', true);
  if (!mr || mr._suppressed || mr.adjHW == null || !isFinite(mr.adjHW)) continue;

  // SP quality. getPitcherWoba returns {vsLHB, vsRHB}; take the split
  // the opposing lineup mostly presents by using the simple mean, which
  // avoids importing the lineup-handedness mix into a single-component test.
  const spH = g.home_sp ? getPitcherWoba(idx, g.home_sp, g.home_sp_hand, g.home_team, st.W_PROJ, st.W_ACT, MIN_BF, st) : null;
  const spA = g.away_sp ? getPitcherWoba(idx, g.away_sp, g.away_sp_hand, g.away_team, st.W_PROJ, st.W_ACT, MIN_BF, st) : null;
  const mean2 = (o) => o == null ? null : ((Number(o.vsLHB) + Number(o.vsRHB)) / 2);
  const spHw = mean2(spH), spAw = mean2(spA);

  // Lineup wOBA. Same-mean treatment across the two platoon splits.
  const luWoba = (json, team) => {
    let lu = []; try { lu = JSON.parse(json) || []; } catch (e) { lu = []; }
    if (!lu.length) return null;
    let s = 0, n = 0;
    for (const b of lu) {
      const r = getBatterWoba(idx, b.name, b.hand, team, st.W_PROJ, st.W_ACT, MIN_PA, st, null);
      if (!r) continue;
      const v = (Number(r.vsLHP) + Number(r.vsRHP)) / 2;
      if (isFinite(v)) { s += v; n++; }
    }
    return n ? s / n : null;
  };
  const batH = luWoba(g.home_lineup_json, g.home_team);
  const batA = luWoba(g.away_lineup_json, g.away_team);

  const ph = impl(g.market_home_ml), pa = impl(g.market_away_ml);
  if (ph == null || pa == null || (ph + pa) <= 0) continue;

  // All features oriented so POSITIVE = home advantage.
  const feat = {
    sp:  (spAw != null && spHw != null) ? (spAw - spHw) : null,      // away SP worse => home edge
    bp:  (g.away_bullpen_woba != null && g.home_bullpen_woba != null)
           ? (g.away_bullpen_woba - g.home_bullpen_woba) : null,
    bat: (batH != null && batA != null) ? (batH - batA) : null,
    pf:  g.park_factor != null ? Number(g.park_factor) : null,
  };
  if (Object.values(feat).some(v => v == null || !isFinite(v))) continue;

  rows.push({
    d: g.game_date, y: g.home_score > g.away_score ? 1 : 0,
    sp: feat.sp, bp: feat.bp, bat: feat.bat, pf: feat.pf,
    model: clamp(mr.adjHW), market: clamp(ph / (ph + pa)),
  });
}
console.log = realLog;
console.log('=== corpus ===');
console.log('  usable games: ' + rows.length);
const baseRate = rows.reduce((a, r) => a + r.y, 0) / rows.length;
const seHome = Math.sqrt(0.25 / rows.length);
console.log('  home win rate: ' + (100 * baseRate).toFixed(2) + '%'
  + '   vs 50%: ' + ((baseRate - 0.5) / seHome).toFixed(2) + ' SE'
  + (Math.abs(baseRate - 0.5) / seHome > 1.96 ? '  (significant)' : '  (NOT significant — HFA itself is not established here)'));
console.log('');

// ---- tiny logistic regression (IRLS + ridge) -------------------------
function solve(A, b) {                       // Gaussian elimination, p<=6
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function fitLogistic(X, y) {
  const p = X[0].length;
  let w = new Array(p).fill(0);
  for (let it = 0; it < 40; it++) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      let z = 0;
      for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const mu = sigmoid(z), wt = Math.max(mu * (1 - mu), 1e-6);
      for (let j = 0; j < p; j++) {
        g[j] += (y[i] - mu) * X[i][j];
        for (let k = 0; k < p; k++) H[j][k] += wt * X[i][j] * X[i][k];
      }
    }
    for (let j = 0; j < p; j++) { g[j] -= RIDGE * w[j]; H[j][j] += RIDGE; }
    const step = solve(H, g);
    if (!step) break;
    let mx = 0;
    for (let j = 0; j < p; j++) { w[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-9) break;
  }
  return w;
}

// ---- date-blocked cross-fitted out-of-sample predictions -------------
const allDates = [...new Set(rows.map(r => r.d))].sort();
const foldOf = new Map();
allDates.forEach((d, i) => foldOf.set(d, Math.min(N_FOLDS - 1, Math.floor(i * N_FOLDS / allDates.length))));

// featFn(r) -> array of raw feature values (intercept added here)
function crossFitted(featFn) {
  const out = new Array(rows.length).fill(null);
  for (let f = 0; f < N_FOLDS; f++) {
    const tr = [], trY = [], teIdx = [];
    rows.forEach((r, i) => {
      if (foldOf.get(r.d) === f) teIdx.push(i);
      else { tr.push([1].concat(featFn(r))); trY.push(r.y); }
    });
    if (!tr.length || !teIdx.length) continue;
    // standardise on TRAIN stats only
    const p = tr[0].length, mu = new Array(p).fill(0), sd = new Array(p).fill(1);
    for (let j = 1; j < p; j++) {
      mu[j] = tr.reduce((a, x) => a + x[j], 0) / tr.length;
      const v = tr.reduce((a, x) => a + (x[j] - mu[j]) ** 2, 0) / tr.length;
      sd[j] = v > 1e-18 ? Math.sqrt(v) : 1;
    }
    const Z = tr.map(x => x.map((v, j) => j === 0 ? 1 : (v - mu[j]) / sd[j]));
    const w = fitLogistic(Z, trY);
    for (const i of teIdx) {
      const x = [1].concat(featFn(rows[i])).map((v, j) => j === 0 ? 1 : (v - mu[j]) / sd[j]);
      let z = 0;
      for (let j = 0; j < w.length; j++) z += w[j] * x[j];
      out[i] = clamp(sigmoid(z));
    }
  }
  return out;
}

const llOf = (pred, idxs) => {
  let s = 0, n = 0;
  for (const i of (idxs || pred.map((_, k) => k))) {
    if (pred[i] == null) continue;
    const y = rows[i].y, q = pred[i];
    s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); n++;
  }
  return n ? s / n : null;
};

// cross-fitted intercept-only = the honest base-rate benchmark
const predBase = crossFitted(() => []);
const preds = {
  'sp (SP quality)':      crossFitted(r => [r.sp]),
  'bp (bullpen)':         crossFitted(r => [r.bp]),
  'bat (lineup wOBA)':    crossFitted(r => [r.bat]),
  'pf (park factor)':     crossFitted(r => [r.pf]),
  'all4 combined':        crossFitted(r => [r.sp, r.bp, r.bat, r.pf]),
  'model* recalibrated':  crossFitted(r => [logit(r.model)]),
};
const rawModel = rows.map(r => r.model);
const rawMarket = rows.map(r => r.market);

// ---- date-clustered bootstrap on dLogLoss vs base --------------------
const byDate = new Map();
rows.forEach((r, i) => { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(i); });
function diffCI(pred) {
  const ds = [...byDate.keys()], reps = [];
  for (let b = 0; b < N_BOOT; b++) {
    let sA = 0, sB = 0, n = 0;
    for (let k = 0; k < ds.length; k++) {
      for (const i of byDate.get(ds[Math.floor(rnd() * ds.length)])) {
        if (pred[i] == null || predBase[i] == null) continue;
        const y = rows[i].y;
        sA += -(y * Math.log(pred[i]) + (1 - y) * Math.log(1 - pred[i]));
        sB += -(y * Math.log(predBase[i]) + (1 - y) * Math.log(1 - predBase[i]));
        n++;
      }
    }
    if (n) reps.push(sA / n - sB / n);
  }
  reps.sort((a, b) => a - b);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
}

const f5 = (x) => (x >= 0 ? '+' : '') + x.toFixed(5);
console.log('=== out-of-sample log loss vs cross-fitted base rate ===');
console.log('  (negative delta = BETTER than a constant)');
console.log('  predictor              logLoss    d vs base    95% CI                   beats base?');
const llBase = llOf(predBase);
console.log('  ' + 'base rate (constant)'.padEnd(22) + llBase.toFixed(5).padStart(9) + '        —');
const verdict = [];
for (const [name, pr] of Object.entries(preds)) {
  const ll = llOf(pr), d = ll - llBase, ci = diffCI(pr);
  const beats = ci.hi < 0;
  verdict.push({ name, ll, d, ci, beats });
  console.log('  ' + name.padEnd(22) + ll.toFixed(5).padStart(9) + f5(d).padStart(13)
    + ('  [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']').padEnd(26)
    + (beats ? '  *** YES ***' : (ci.lo > 0 ? '  no (WORSE)' : '  no')));
}
for (const [name, pr] of [['model as-is', rawModel], ['market (ceiling)', rawMarket]]) {
  const ll = llOf(pr), d = ll - llBase, ci = diffCI(pr);
  console.log('  ' + name.padEnd(22) + ll.toFixed(5).padStart(9) + f5(d).padStart(13)
    + ('  [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']').padEnd(26)
    + (ci.hi < 0 ? '  *** YES ***' : (ci.lo > 0 ? '  no (WORSE)' : '  no')));
}
console.log('');

// ---- fold-level coefficient stability --------------------------------
console.log('=== fitted direction per component (sign stability across folds) ===');
console.log('  positive coefficient = the component points the right way');
console.log('  component        ' + Array.from({ length: N_FOLDS }, (_, i) => ('F' + (i + 1)).padStart(9)).join('') + '   consistent');
for (const [name, fn] of [['sp', r => [r.sp]], ['bp', r => [r.bp]], ['bat', r => [r.bat]], ['pf', r => [r.pf]]]) {
  const cs = [];
  for (let f = 0; f < N_FOLDS; f++) {
    const tr = [], trY = [];
    rows.forEach(r => { if (foldOf.get(r.d) !== f) { tr.push([1].concat(fn(r))); trY.push(r.y); } });
    const p = tr[0].length, mu = new Array(p).fill(0), sd = new Array(p).fill(1);
    for (let j = 1; j < p; j++) {
      mu[j] = tr.reduce((a, x) => a + x[j], 0) / tr.length;
      const v = tr.reduce((a, x) => a + (x[j] - mu[j]) ** 2, 0) / tr.length;
      sd[j] = v > 1e-18 ? Math.sqrt(v) : 1;
    }
    const w = fitLogistic(tr.map(x => x.map((v, j) => j === 0 ? 1 : (v - mu[j]) / sd[j])), trY);
    cs.push(w[1]);
  }
  const pos = cs.filter(c => c > 0).length;
  console.log('  ' + name.padEnd(17) + cs.map(c => ((c >= 0 ? '+' : '') + c.toFixed(3)).padStart(9)).join('')
    + '   ' + (pos === N_FOLDS || pos === 0 ? 'YES (' + (pos === N_FOLDS ? 'all +' : 'all -') + ')' : 'no (' + pos + '/' + N_FOLDS + ' positive)'));
}
console.log('');

// ---- ordering vs calibration -----------------------------------------
console.log('=== ordering vs calibration: does the model rank games correctly? ===');
const auc = (pred) => {
  const pos = [], neg = [];
  rows.forEach((r, i) => { if (pred[i] == null) return; (r.y ? pos : neg).push(pred[i]); });
  if (!pos.length || !neg.length) return null;
  let c = 0;
  for (const a of pos) for (const b of neg) c += a > b ? 1 : a === b ? 0.5 : 0;
  return c / (pos.length * neg.length);
};
console.log('  model as-is      AUC = ' + auc(rawModel).toFixed(4));
console.log('  model recalib.   AUC = ' + auc(preds['model* recalibrated']).toFixed(4));
console.log('  all4 combined    AUC = ' + auc(preds['all4 combined']).toFixed(4));
console.log('  market           AUC = ' + auc(rawMarket).toFixed(4));
console.log('  (0.500 = no ordering information at all)');
console.log('');
console.log('  AUC is scale-free: it measures whether the model RANKS games');
console.log('  correctly, independent of whether its probabilities are on the');
console.log('  right scale. Log loss penalises both. Comparing the two locates');
console.log('  the failure — bad AUC means the inputs or their combination carry');
console.log('  no ordering signal; good AUC with bad log loss means the ordering');
console.log('  is fine and the runs->probability conversion is miscalibrated.');
