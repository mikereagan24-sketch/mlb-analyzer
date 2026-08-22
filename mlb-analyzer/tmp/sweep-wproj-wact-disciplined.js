'use strict';
// W_PROJ/W_ACT sweep on the per-date wOBA snapshot corpus.
//
// This weight was Phase-3-blocked in the 2026-07-14 sensitivity pass
// because the harness of the day (scripts/sweep-look-ahead-safe-weights.js,
// line 88: jobs.getWobaIndex()) scored historical games against TODAY's
// season-cumulative woba_data. W_ACT is the weight ON that contaminated
// quantity, so the contamination did not cancel across candidates.
//
// That blocker is resolved for the snapshot window: woba_data_snapshot
// carries per-date rows captured as-of-morning (verified — see
// docs/wproj-wact-snapshot-sweep-2026-08-21.md §2), and
// services/parameter-sweep.js binds each game to its own game-date
// snapshot. This harness reuses that engine's corpus builder and
// scorer rather than reimplementing either.
//
// Discipline implemented here, on top of the engine:
//   - rolling chronological folds + per-fold sign stability
//   - date-clustered bootstrap CIs on dROI vs the production baseline
//   - Val:Fit ratio gate (<= 1.5x)
//   - per-band effects (category and edge band)
//
// Score-once-then-resample: each grid value is scored ONCE over the
// full corpus into a signal table carrying game_date; every fold and
// bootstrap replicate is then a pure resample of that table. Exact,
// and avoids re-running runModel per replicate.
//
// Run: <node20>/node.exe tmp/sweep-wproj-wact-disciplined.js [from] [to]
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const jobs = require('../services/jobs');

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-07';
const BASELINE = 0.45;                       // production W_PROJ
const GRID = [0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9];
const N_FOLDS = 5;
const N_BOOT = 2000;
const VAL_FIT_MAX = 1.5;
const TRAIN_FRACTION = 0.7;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const baseSettings = jobs.getSettings();

// Deterministic LCG so reruns reproduce exactly.
let _seed = 20260821;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

console.log('=== W_PROJ/W_ACT sweep — snapshot corpus ===');
console.log('  window ' + FROM + ' .. ' + TO + '   baseline W_PROJ=' + BASELINE);
console.log('  grid: ' + GRID.join(', '));
console.log('  folds=' + N_FOLDS + '  bootstrap=' + N_BOOT + '  Val:Fit gate <= ' + VAL_FIT_MAX + 'x');
console.log('');

// ---- corpus (reuses the engine's own builders) ----------------------
const games = ps.loadGames(db, FROM, TO);
const wobaCache = new Map();
for (const g of games) {
  if (!wobaCache.has(g.game_date)) wobaCache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
}
const scoreable = [];
let noSnap = 0, suppressed = 0;
for (const g of games) {
  const wobaIdx = wobaCache.get(g.game_date);
  if (!wobaIdx) { noSnap++; continue; }
  const wrapped = ps.preScreenGame(g, wobaIdx, baseSettings);
  if (!wrapped) { suppressed++; continue; }
  scoreable.push({ game: wrapped, wobaIdx, snapshotDate: g.game_date });
}
console.log('=== corpus ===');
console.log('  games loaded=' + games.length + '  scoreable=' + scoreable.length
  + '  no-snapshot=' + noSnap + '  suppressed=' + suppressed);

const allDates = Array.from(new Set(scoreable.map(s => s.snapshotDate))).sort();
console.log('  distinct dates=' + allDates.length);
console.log('');

const uiThresholds = ps.loadUiHighlightThresholds(db);

// ---- score once per grid value --------------------------------------
// signal.edge is a FRACTION of probability (services/model.js:1364,
// and SIGNAL_EMIT_FLOOR_PP defaults to 0.01 = 1 probability point),
// NOT already-scaled percentage points. Scale before banding — the
// first run of this harness banded the raw fraction and dropped all
// 742 signals into one bucket.
const bandOf = (e) => {
  const a = Math.abs(Number(e)) * 100;
  if (a < 2) return '1-2pp';
  if (a < 3) return '2-3pp';
  if (a < 5) return '3-5pp';
  return '5pp+';
};
// runModel's SP_WEIGHT hand-conditional shadow logger
// (services/model.js:1242) is NOT gated by the quiet flag that
// suppresses the opener logs, so it emits one long line per game per
// combo — ~8k lines here, which dominates runtime. Silence console.log
// for the scoring loop only; console.warn/error stay live so real
// problems still surface.
const tables = new Map();
const _realLog = console.log;
for (const w of GRID) {
  const settings = ps.applySweepOverrides(baseSettings, { W_PROJ_W_ACT: w });
  const t0 = Date.now();
  console.log = () => {};
  let res;
  try { res = ps.scoreGames(settings, scoreable, uiThresholds); }
  finally { console.log = _realLog; }
  tables.set(w, res.signals);
  process.stdout.write('  scored W_PROJ=' + w.toFixed(2) + ' -> ' + res.signals.length
    + ' signals  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)' + String.fromCharCode(10));
}
// Persist the scored signal tables. Scoring is ~20 min; every section
// below is a pure resample of these tables, so any change to folds,
// bands or CIs can be re-derived offline without re-scoring.
try {
  const outDir = process.env.SWEEP_DUMP_DIR || require('os').tmpdir();
  require('fs').writeFileSync(
    require('path').join(outDir, 'wproj-signal-tables.json'),
    JSON.stringify({ from: FROM, to: TO, baseline: BASELINE, grid: GRID,
      tables: GRID.map(w => ({ w, signals: tables.get(w) })) })
  );
  console.log('  signal tables dumped to ' + outDir + '/wproj-signal-tables.json');
} catch (e) { console.log('  (table dump failed, non-fatal: ' + e.message + ')'); }
console.log('');

// ---- aggregation helpers --------------------------------------------
// ROI over a signal subset. Returns null when nothing was wagered.
function roiOf(sigs) {
  let pnl = 0, wag = 0;
  for (const s of sigs) { pnl += s.pnl; wag += s.wagered; }
  return wag > 0 ? (pnl / wag) * 100 : null;
}
const isML = (s) => s.category === 'favs' || s.category === 'dogs';
const isTOT = (s) => s.category === 'overs' || s.category === 'unders';

function byDate(sigs) {
  const m = new Map();
  for (const s of sigs) {
    if (!m.has(s.game_date)) m.set(s.game_date, []);
    m.get(s.game_date).push(s);
  }
  return m;
}

// ---- 1. headline ROI per grid value ---------------------------------
console.log('=== 1. headline ROI by grid value (full corpus) ===');
console.log('  W_PROJ   nSig    ROI%      nML   ML ROI%     nTOT  TOT ROI%');
for (const w of GRID) {
  const t = tables.get(w);
  const ml = t.filter(isML), tot = t.filter(isTOT);
  const f = (x) => x == null ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(2);
  console.log('   ' + w.toFixed(2).padStart(5) + String(t.length).padStart(7)
    + f(roiOf(t)).padStart(9) + String(ml.length).padStart(8) + f(roiOf(ml)).padStart(10)
    + String(tot.length).padStart(9) + f(roiOf(tot)).padStart(10)
    + (w === BASELINE ? '   <-- production' : ''));
}
console.log('');

// ---- 2. rolling chronological folds ---------------------------------
// Contiguous date blocks, so a fold is a real time period rather than a
// random shuffle. Sign stability across folds is the honest test of
// whether a direction is real or one lucky stretch.
const folds = [];
for (let i = 0; i < N_FOLDS; i++) {
  const lo = Math.floor(i * allDates.length / N_FOLDS);
  const hi = Math.floor((i + 1) * allDates.length / N_FOLDS);
  folds.push(new Set(allDates.slice(lo, hi)));
}
console.log('=== 2. rolling folds (' + N_FOLDS + ' contiguous date blocks) ===');
console.log('  dROI vs baseline W_PROJ=' + BASELINE + ', per fold, ML+TOT combined');
console.log('  W_PROJ  ' + folds.map((f, i) => ('F' + (i + 1)).padStart(8)).join('') + '   signFlips  allSameSign');
const foldStability = new Map();
for (const w of GRID) {
  if (w === BASELINE) continue;
  const cur = byDate(tables.get(w)), base = byDate(tables.get(BASELINE));
  const deltas = folds.map(fd => {
    const a = [], b = [];
    for (const d of fd) { if (cur.has(d)) a.push(...cur.get(d)); if (base.has(d)) b.push(...base.get(d)); }
    const ra = roiOf(a), rb = roiOf(b);
    return (ra == null || rb == null) ? null : ra - rb;
  });
  const valid = deltas.filter(d => d != null);
  const pos = valid.filter(d => d > 0).length, neg = valid.filter(d => d < 0).length;
  const allSame = valid.length > 0 && (pos === 0 || neg === 0);
  foldStability.set(w, { deltas, allSame, pos, neg });
  console.log('   ' + w.toFixed(2).padStart(5) + '  '
    + deltas.map(d => (d == null ? 'n/a' : (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(8)).join('')
    + String(Math.min(pos, neg)).padStart(11) + '  ' + (allSame ? 'YES' : 'no'));
}
console.log('');

// ---- 3. date-clustered bootstrap CIs --------------------------------
// Resample DATES with replacement, not signals: signals on the same
// slate share lineups, weather and market state, so signal-level
// resampling would understate the CI.
console.log('=== 3. date-clustered bootstrap CIs on dROI vs baseline (B=' + N_BOOT + ') ===');
console.log('  W_PROJ    dROI%     95% CI                  excludes 0?');
const bootResult = new Map();
const baseByDate = byDate(tables.get(BASELINE));
for (const w of GRID) {
  if (w === BASELINE) continue;
  const curByDate = byDate(tables.get(w));
  const obs = roiOf(tables.get(w)) - roiOf(tables.get(BASELINE));
  const reps = [];
  for (let b = 0; b < N_BOOT; b++) {
    let pA = 0, wA = 0, pB = 0, wB = 0;
    for (let k = 0; k < allDates.length; k++) {
      const d = allDates[Math.floor(rnd() * allDates.length)];
      const sa = curByDate.get(d), sb = baseByDate.get(d);
      if (sa) for (const s of sa) { pA += s.pnl; wA += s.wagered; }
      if (sb) for (const s of sb) { pB += s.pnl; wB += s.wagered; }
    }
    if (wA > 0 && wB > 0) reps.push((pA / wA) * 100 - (pB / wB) * 100);
  }
  reps.sort((a, b) => a - b);
  const lo = reps[Math.floor(0.025 * reps.length)];
  const hi = reps[Math.floor(0.975 * reps.length)];
  const excl = (lo > 0 && hi > 0) || (lo < 0 && hi < 0);
  bootResult.set(w, { obs, lo, hi, excl });
  const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  console.log('   ' + w.toFixed(2).padStart(5) + f(obs).padStart(10) + '     ['
    + f(lo).padStart(7) + ', ' + f(hi).padStart(7) + ']        ' + (excl ? '*** YES ***' : 'no'));
}
console.log('');

// ---- 4. Val:Fit ------------------------------------------------------
const splitIdx = Math.floor(allDates.length * TRAIN_FRACTION);
const fitDates = new Set(allDates.slice(0, splitIdx));
const valDates = new Set(allDates.slice(splitIdx));
console.log('=== 4. Val:Fit ratio (fit <= ' + allDates.slice(0, splitIdx).pop()
  + ', val > that; gate |Val|/|Fit| <= ' + VAL_FIT_MAX + 'x) ===');
console.log('  W_PROJ   Fit dROI%   Val dROI%   Val:Fit   sameSign  passes');
const valfit = new Map();
for (const w of GRID) {
  if (w === BASELINE) continue;
  const cur = tables.get(w), base = tables.get(BASELINE);
  const sub = (t, ds) => t.filter(s => ds.has(s.game_date));
  const fitD = roiOf(sub(cur, fitDates)) - roiOf(sub(base, fitDates));
  const valD = roiOf(sub(cur, valDates)) - roiOf(sub(base, valDates));
  const ratio = Math.abs(fitD) > 1e-9 ? Math.abs(valD) / Math.abs(fitD) : null;
  const sameSign = (fitD >= 0) === (valD >= 0);
  const passes = sameSign && ratio != null && ratio <= VAL_FIT_MAX;
  valfit.set(w, { fitD, valD, ratio, sameSign, passes });
  const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  console.log('   ' + w.toFixed(2).padStart(5) + f(fitD).padStart(11) + f(valD).padStart(12)
    + (ratio == null ? '    n/a' : ratio.toFixed(2).padStart(9)) + '   '
    + (sameSign ? 'yes' : 'NO ').padStart(7) + '   ' + (passes ? 'yes' : 'no'));
}
console.log('');

// ---- 5. per-band effects --------------------------------------------
console.log('=== 5. per-band dROI vs baseline ===');
const CATS = ['favs', 'dogs', 'overs', 'unders'];
const BANDS = ['1-2pp', '2-3pp', '3-5pp', '5pp+'];
console.log('  -- by category --');
console.log('  W_PROJ  ' + CATS.map(c => c.padStart(10)).join(''));
for (const w of GRID) {
  if (w === BASELINE) continue;
  const cur = tables.get(w), base = tables.get(BASELINE);
  const cells = CATS.map(c => {
    const ra = roiOf(cur.filter(s => s.category === c));
    const rb = roiOf(base.filter(s => s.category === c));
    return (ra == null || rb == null) ? 'n/a' : ((ra - rb) >= 0 ? '+' : '') + (ra - rb).toFixed(2);
  });
  console.log('   ' + w.toFixed(2).padStart(5) + '  ' + cells.map(c => c.padStart(10)).join(''));
}
console.log('');
console.log('  -- by edge band (n at baseline in parens) --');
const baseBandN = {};
for (const s of tables.get(BASELINE)) { const b = bandOf(s.edge_pp); baseBandN[b] = (baseBandN[b] || 0) + 1; }
console.log('  W_PROJ  ' + BANDS.map(b => (b + '(' + (baseBandN[b] || 0) + ')').padStart(14)).join(''));
for (const w of GRID) {
  if (w === BASELINE) continue;
  const cur = tables.get(w), base = tables.get(BASELINE);
  const cells = BANDS.map(bd => {
    const ra = roiOf(cur.filter(s => bandOf(s.edge_pp) === bd));
    const rb = roiOf(base.filter(s => bandOf(s.edge_pp) === bd));
    return (ra == null || rb == null) ? 'n/a' : ((ra - rb) >= 0 ? '+' : '') + (ra - rb).toFixed(2);
  });
  console.log('   ' + w.toFixed(2).padStart(5) + '  ' + cells.map(c => c.padStart(14)).join(''));
}
console.log('');

// ---- 6. verdict ------------------------------------------------------
console.log('=== 6. verdict ===');
const survivors = GRID.filter(w => w !== BASELINE
  && bootResult.get(w) && bootResult.get(w).excl
  && foldStability.get(w) && foldStability.get(w).allSame
  && valfit.get(w) && valfit.get(w).passes);
console.log('  candidates clearing ALL THREE gates');
console.log('  (bootstrap CI excludes 0 + all folds same sign + Val:Fit <= ' + VAL_FIT_MAX + 'x):');
console.log('    ' + (survivors.length ? survivors.map(w => 'W_PROJ=' + w).join(', ') : 'NONE'));
console.log('');
console.log('  gate-by-gate counts across ' + (GRID.length - 1) + ' non-baseline candidates:');
console.log('    bootstrap CI excludes 0 : ' + GRID.filter(w => w !== BASELINE && bootResult.get(w).excl).length);
console.log('    all folds same sign     : ' + GRID.filter(w => w !== BASELINE && foldStability.get(w).allSame).length);
console.log('    Val:Fit passes          : ' + GRID.filter(w => w !== BASELINE && valfit.get(w).passes).length);
