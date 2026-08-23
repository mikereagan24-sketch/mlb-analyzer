'use strict';
// W_PIT / W_BAT swept against a CALIBRATION target instead of ROI.
//
// Per the 2026-08-21 rule ("Sweep ROI measures selection, not pricing"),
// an ROI sweep over this parameter cannot answer whether the model
// prices better — calcPnl never sees the model's numbers, so it can only
// reshuffle which near-floor bets are in the sample. The April 2026
// grid search that selected production W_PIT=0.40 / W_BAT=0.60
// (scripts/optimize-params.js, top-20 by ROI) is exactly that design.
//
// This harness scores EVERY game at EVERY grid value — no emit floor, no
// signal selection, identical game set throughout (asserted, not
// assumed). Targets are computed on the model's own probability:
//
//   log loss   -[y ln p + (1-y) ln(1-p)]        <- primary
//   Brier      (p - y)^2
//   ECE        |mean p - realised rate| per decile, sample-weighted
//   edge slope realised excess regressed on claimed edge; 1.0 = the
//              claimed edge is real, 0.0 = it is noise
//
// p = runModel().adjHW (home win prob, post-HFA, clamped).
// Market probs are de-vigged from both sides for the edge target.
//
// Discipline mirrors the W_PROJ sweep: rolling chronological folds,
// date-clustered bootstrap CIs, Val:Fit, deterministic seed.
//
// Run: <node20>/node.exe scripts/calibration-sweep.js [param] [baseline] [from] [to]
//   default: W_PIT_W_BAT 0.40 2026-06-01 2026-08-07
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
// Caller-populated model inputs (FRV, catcher framing). Without this the
// scored model is missing both defensive inputs and the absolute figures
// describe a model that never runs in production. See services/harness-inputs.js.
const hi = require('../services/harness-inputs');
const { runModel, impliedP } = require('../services/model');
const jobs = require('../services/jobs');

// Parameterised so this is the reusable calibration harness the
// CLAUDE.md rule points at, not a W_PIT one-off. Any key accepted by
// applySweepOverrides works.
//   argv: [param] [baseline] [from] [to]
const PARAM = process.argv[2] || 'W_PIT_W_BAT';
const BASELINE = process.argv[3] != null ? Number(process.argv[3]) : 0.40;
const FROM = process.argv[4] || '2026-06-01';
const TO = process.argv[5] || '2026-08-07';
const GRID0 = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];
const GRID = GRID0.includes(BASELINE) ? GRID0 : GRID0.concat([BASELINE]).sort((a, b) => a - b);
const N_FOLDS = 5, N_BOOT = 2000, TRAIN_FRACTION = 0.7, VAL_FIT_MAX = 1.5;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const baseSettings = jobs.getSettings();

let _s = 20260822;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };

console.log('=== calibration sweep: ' + PARAM + ' ===');
console.log('  window ' + FROM + '..' + TO + '   baseline ' + PARAM + '=' + BASELINE
  + ' (prod)   grid: ' + GRID.join(', '));
console.log('  target: log loss / Brier / ECE / edge slope over ALL games — no emit floor');
console.log('');

// ---- corpus (same builders the sweep engine uses) -------------------
const games = ps.loadGames(db, FROM, TO);
const cache = new Map();
for (const g of games) if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
const scoreable = [];
let noSnap = 0, preSup = 0, noMkt = 0, noScore = 0;
for (const g of games) {
  const idx = cache.get(g.game_date);
  if (!idx) { noSnap++; continue; }
  if (g.home_score == null || g.away_score == null) { noScore++; continue; }
  if (g.market_home_ml == null || g.market_away_ml == null) { noMkt++; continue; }
  const wrapped = hi.populateCallerInputs(ps.preScreenGame(g, idx, baseSettings), g, baseSettings);
  if (!wrapped) { preSup++; continue; }
  scoreable.push({ game: wrapped, wobaIdx: idx, date: g.game_date,
    y: g.home_score > g.away_score ? 1 : 0,
    mktHome: g.market_home_ml, mktAway: g.market_away_ml });
}
console.log('=== corpus ===');
console.log('  loaded=' + games.length + '  usable=' + scoreable.length
  + '  (no-snapshot ' + noSnap + ', no-score ' + noScore + ', no-market ' + noMkt + ', suppressed ' + preSup + ')');

// de-vigged market home prob
for (const s of scoreable) {
  const ph = impliedP(s.mktHome), pa = impliedP(s.mktAway);
  s.pMkt = (ph != null && pa != null && (ph + pa) > 0) ? ph / (ph + pa) : null;
}
const homeRate = scoreable.reduce((a, s) => a + s.y, 0) / scoreable.length;
console.log('  home win rate: ' + (100 * homeRate).toFixed(2) + '%');

// ---- score every grid value over every game -------------------------
const EPS = 1e-9;
const realLog = console.log;
const preds = new Map();      // w -> array aligned with `scoreable`
const supAny = new Set();
for (const w of GRID) {
  const st = ps.applySweepOverrides(baseSettings, { [PARAM]: w });
  const t0 = Date.now();
  console.log = () => {};
  const out = [];
  try {
    for (let i = 0; i < scoreable.length; i++) {
      const sg = scoreable[i];
      const mr = runModel(sg.game, sg.wobaIdx, st, 'opener_aware', true);
      if (!mr || mr._suppressed || mr.adjHW == null || !isFinite(mr.adjHW)) { out.push(null); supAny.add(i); }
      else out.push(Math.min(1 - EPS, Math.max(EPS, mr.adjHW)));
    }
  } finally { console.log = realLog; }
  preds.set(w, out);
  process.stdout.write('  scored ' + PARAM + '=' + w.toFixed(2) + '  ('
    + ((Date.now() - t0) / 1000).toFixed(1) + 's)' + String.fromCharCode(10));
}

// Identical game set at every grid value — the whole point of this design.
const keep = [];
for (let i = 0; i < scoreable.length; i++) if (!supAny.has(i)) keep.push(i);
console.log('');
console.log('  games scored at EVERY grid value: ' + keep.length
  + '   dropped (suppressed at >=1 value): ' + supAny.size);
for (const w of GRID) {
  const n = keep.filter(i => preds.get(w)[i] != null).length;
  if (n !== keep.length) { console.log('  FATAL: grid ' + w + ' has ' + n + ' != ' + keep.length); process.exit(1); }
}
console.log('  ASSERTED: identical n at all ' + GRID.length + ' grid values — no composition possible');
console.log('');

// ---- metrics ---------------------------------------------------------
const logLoss = (idxs, p) => {
  let s = 0;
  for (const i of idxs) { const y = scoreable[i].y, q = p[i]; s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
  return s / idxs.length;
};
const brier = (idxs, p) => {
  let s = 0;
  for (const i of idxs) { const d = p[i] - scoreable[i].y; s += d * d; }
  return s / idxs.length;
};
const ece = (idxs, p, bins) => {
  const B = bins || 10, cnt = new Array(B).fill(0), sp = new Array(B).fill(0), sy = new Array(B).fill(0);
  for (const i of idxs) {
    const b = Math.min(B - 1, Math.floor(p[i] * B));
    cnt[b]++; sp[b] += p[i]; sy[b] += scoreable[i].y;
  }
  let e = 0, n = idxs.length;
  for (let b = 0; b < B; b++) if (cnt[b]) e += (cnt[b] / n) * Math.abs(sp[b] / cnt[b] - sy[b] / cnt[b]);
  return e;
};
// Realised excess regressed on claimed edge (through the data, OLS slope).
const edgeSlope = (idxs, p) => {
  const xs = [], ys = [];
  for (const i of idxs) {
    const s = scoreable[i];
    if (s.pMkt == null) continue;
    xs.push(p[i] - s.pMkt);
    ys.push(s.y - s.pMkt);
  }
  if (xs.length < 20) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : null;
};

// market reference
const mktIdx = keep.filter(i => scoreable[i].pMkt != null);
const mktP = [];
for (let i = 0; i < scoreable.length; i++) mktP[i] = scoreable[i].pMkt;
console.log('=== 0. reference points ===');
console.log('  market (de-vigged) log loss: ' + logLoss(mktIdx, mktP).toFixed(5)
  + '   Brier: ' + brier(mktIdx, mktP).toFixed(5) + '   n=' + mktIdx.length);
const constP = []; for (let i = 0; i < scoreable.length; i++) constP[i] = homeRate;
console.log('  always-predict-base-rate log loss: ' + logLoss(keep, constP).toFixed(5));
console.log('  (a model above the base-rate number is worse than guessing)');
console.log('');

// ---- 1. headline -----------------------------------------------------
console.log('=== 1. calibration by grid value (ALL games, identical set) ===');
console.log('  value   logLoss    dLL vs base    Brier      ECE     edgeSlope');
const rows = [];
const baseLL = logLoss(keep, preds.get(BASELINE));
for (const w of GRID) {
  const p = preds.get(w);
  const ll = logLoss(keep, p), br = brier(keep, p), ec = ece(keep, p), es = edgeSlope(keep, p);
  rows.push({ w, ll, br, ec, es });
  console.log('   ' + w.toFixed(2).padStart(5) + ll.toFixed(5).padStart(11)
    + ((ll - baseLL) >= 0 ? '+' : '') + (ll - baseLL).toFixed(5).padStart(11)
    + br.toFixed(5).padStart(11) + ec.toFixed(4).padStart(9)
    + (es == null ? '   n/a' : es.toFixed(3).padStart(11))
    + (w === BASELINE ? '   <-- production' : ''));
}
const best = rows.reduce((a, b) => b.ll < a.ll ? b : a);
console.log('');
console.log('  lowest log loss: ' + PARAM + '=' + best.w + ' (' + best.ll.toFixed(5) + ')'
  + '   production: ' + baseLL.toFixed(5)
  + '   gap: ' + (baseLL - best.ll).toFixed(5));
console.log('');

// ---- 2. rolling folds -------------------------------------------------
const allDates = [...new Set(keep.map(i => scoreable[i].date))].sort();
const folds = [];
for (let k = 0; k < N_FOLDS; k++) {
  const lo = Math.floor(k * allDates.length / N_FOLDS), hi = Math.floor((k + 1) * allDates.length / N_FOLDS);
  folds.push(new Set(allDates.slice(lo, hi)));
}
console.log('=== 2. rolling folds — dLogLoss vs production (negative = better) ===');
console.log('  value  ' + folds.map((f, i) => ('F' + (i + 1)).padStart(10)).join('') + '   allSameSign');
const foldOk = new Map();
for (const w of GRID) {
  if (w === BASELINE) continue;
  const p = preds.get(w), pb = preds.get(BASELINE);
  const ds = folds.map(fd => {
    const idxs = keep.filter(i => fd.has(scoreable[i].date));
    return idxs.length ? logLoss(idxs, p) - logLoss(idxs, pb) : null;
  });
  const v = ds.filter(x => x != null);
  const same = v.length > 0 && (v.every(x => x > 0) || v.every(x => x < 0));
  foldOk.set(w, same);
  console.log('   ' + w.toFixed(2).padStart(5) + '  '
    + ds.map(x => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(5)).padStart(10)).join('')
    + (same ? '   YES' : '   no'));
}
console.log('');

// ---- 3. date-clustered bootstrap --------------------------------------
console.log('=== 3. date-clustered bootstrap CI on dLogLoss vs production (B=' + N_BOOT + ') ===');
console.log('  value     dLL       95% CI                    excludes 0?');
const byDate = new Map();
for (const i of keep) {
  const d = scoreable[i].date;
  if (!byDate.has(d)) byDate.set(d, []);
  byDate.get(d).push(i);
}
const bootOk = new Map();
for (const w of GRID) {
  if (w === BASELINE) continue;
  const p = preds.get(w), pb = preds.get(BASELINE);
  const obs = logLoss(keep, p) - logLoss(keep, pb);
  const reps = [];
  for (let b = 0; b < N_BOOT; b++) {
    let s = 0, sb = 0, n = 0;
    for (let k = 0; k < allDates.length; k++) {
      const idxs = byDate.get(allDates[Math.floor(rnd() * allDates.length)]) || [];
      for (const i of idxs) {
        const y = scoreable[i].y;
        s += -(y * Math.log(p[i]) + (1 - y) * Math.log(1 - p[i]));
        sb += -(y * Math.log(pb[i]) + (1 - y) * Math.log(1 - pb[i]));
        n++;
      }
    }
    if (n) reps.push(s / n - sb / n);
  }
  reps.sort((a, b) => a - b);
  const lo = reps[Math.floor(0.025 * reps.length)], hi = reps[Math.floor(0.975 * reps.length)];
  const ex = (lo > 0 && hi > 0) || (lo < 0 && hi < 0);
  bootOk.set(w, ex);
  const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(5);
  console.log('   ' + w.toFixed(2).padStart(5) + f(obs).padStart(11) + '   [' + f(lo).padStart(9)
    + ', ' + f(hi).padStart(9) + ']        ' + (ex ? '*** YES ***' : 'no'));
}
console.log('');

// ---- 4. Val:Fit -------------------------------------------------------
const cut = Math.floor(allDates.length * TRAIN_FRACTION);
const fitD = new Set(allDates.slice(0, cut)), valD = new Set(allDates.slice(cut));
const fitI = keep.filter(i => fitD.has(scoreable[i].date)), valI = keep.filter(i => valD.has(scoreable[i].date));
console.log('=== 4. Val:Fit (fit <= ' + allDates[cut - 1] + ') ===');
console.log('  value   Fit dLL     Val dLL    Val:Fit  sameSign  passes');
const vfOk = new Map();
for (const w of GRID) {
  if (w === BASELINE) continue;
  const p = preds.get(w), pb = preds.get(BASELINE);
  const fd = logLoss(fitI, p) - logLoss(fitI, pb);
  const vd = logLoss(valI, p) - logLoss(valI, pb);
  const ratio = Math.abs(fd) > 1e-12 ? Math.abs(vd) / Math.abs(fd) : null;
  const same = (fd >= 0) === (vd >= 0);
  const pass = same && ratio != null && ratio <= VAL_FIT_MAX;
  vfOk.set(w, pass);
  const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(5);
  console.log('   ' + w.toFixed(2).padStart(5) + f(fd).padStart(11) + f(vd).padStart(12)
    + (ratio == null ? '   n/a' : ratio.toFixed(2).padStart(9)) + '   ' + (same ? 'yes' : 'NO ').padStart(7)
    + '   ' + (pass ? 'yes' : 'no'));
}
console.log('');

// ---- 5. calibration curve at production vs best ------------------------
console.log('=== 5. calibration curve — production vs lowest-log-loss ===');
const curve = (p, label) => {
  const B = 10, cnt = new Array(B).fill(0), sp = new Array(B).fill(0), sy = new Array(B).fill(0);
  for (const i of keep) { const b = Math.min(B - 1, Math.floor(p[i] * B)); cnt[b]++; sp[b] += p[i]; sy[b] += scoreable[i].y; }
  console.log('  ' + label);
  console.log('    bin        n   mean p   realised   diff');
  for (let b = 0; b < B; b++) {
    if (!cnt[b]) continue;
    const mp = sp[b] / cnt[b], mr = sy[b] / cnt[b];
    console.log('    ' + (b / 10).toFixed(1) + '-' + ((b + 1) / 10).toFixed(1)
      + String(cnt[b]).padStart(7) + mp.toFixed(3).padStart(9) + mr.toFixed(3).padStart(11)
      + ((mr - mp) >= 0 ? '+' : '') + (mr - mp).toFixed(3).padStart(7));
  }
};
curve(preds.get(BASELINE), PARAM + '=' + BASELINE + ' (production)');
if (best.w !== BASELINE) { console.log(''); curve(preds.get(best.w), PARAM + '=' + best.w + ' (lowest log loss)'); }
console.log('');

// ---- 6. verdict --------------------------------------------------------
console.log('=== 6. verdict ===');
const surv = GRID.filter(w => w !== BASELINE && bootOk.get(w) && foldOk.get(w) && vfOk.get(w));
const better = GRID.filter(w => w !== BASELINE && bootOk.get(w) && foldOk.get(w) && vfOk.get(w)
  && (logLoss(keep, preds.get(w)) < baseLL));
console.log('  clearing ALL THREE gates: ' + (surv.length ? surv.join(', ') : 'NONE'));
console.log('  ...and BETTER than production: ' + (better.length ? better.join(', ') : 'NONE'));
console.log('  gate counts: bootstrapCI=' + GRID.filter(w => w !== BASELINE && bootOk.get(w)).length
  + '  folds=' + GRID.filter(w => w !== BASELINE && foldOk.get(w)).length
  + '  valfit=' + GRID.filter(w => w !== BASELINE && vfOk.get(w)).length
  + '  (of ' + (GRID.length - 1) + ')');
