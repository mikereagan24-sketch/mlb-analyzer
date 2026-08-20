'use strict';

// Pooled league sens fit — successor to the retired per-park harness.
//
// Question: does the league-average of the current sens paste under-
// or over-attribute wind, in aggregate? A single γ estimated on all
// open-air post-batch-3 games with wind_speed >= 8.
//
// Y = actual_total - model_total   (residual after current per-park
//                                    sens is applied)
// X = alignment · speedFactor      (dimensionless, sens-free wind
//                                    projection; same as retired
//                                    harness)
// Fit: Y = α + γ · X               (γ = league-average unattributed
//                                    wind response; γ ≈ 0 → paste's
//                                    aggregate calibration is right,
//                                    γ > 0 → sens too low on average,
//                                    γ < 0 → too high)
// Sens interpretation: Δ_global_sens = γ / WIND_SCALE
//
// Same three fits per the CLAUDE.md skewed-residual rule:
//   (a) OLS with intercept
//   (b) Theil-Sen (robust)
//   (c) OLS with intercept, blowouts (actual_total >= 15) excluded
//
// Two bootstrap CIs on γ:
//   (i)  iid resample (baseline)
//   (ii) cluster-by-park resample (accounts for within-park
//        correlation — per-park sens deltas mean residuals at a
//        given park aren't independent of the wind projection)

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const { PARKS } = require('../services/weather');

const WIND_SCALE = 2.0;
const BOOT_N = 2000;
const SEED = 42;
const BLOWOUT_THRESHOLD = 15;

const ROOFED_KEYS = new Set(['ari','hou','tex','tor','mia','mil','sea','tb']);
const NON_ET = new Set(['COL','ARI','LAD','LAA','SD','SF','SEA','ATH','CHC','CWS','MIL','MIN','STL','HOU','TEX','KC']);
function isNaiveHour(r){ return r.game_date < '2026-07-30' && NON_ET.has((r.home_team||'').toUpperCase()); }
function isAthVegas(r){ return r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && (r.home_team||'').toUpperCase() === 'ATH' && r.venue_id === 5355; }
function isAthColiseum(r){ return r.game_date < '2026-07-27' && (r.home_team||'').toUpperCase() === 'ATH' && !isAthVegas(r); }

function makeRng(seed) {
  let s = seed >>> 0;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n-1)/2] : (s[n/2 - 1] + s[n/2]) / 2;
}

function olsWithIntercept(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: NaN, intercept: NaN };
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (!(den > 0)) return { slope: NaN, intercept: NaN };
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

function theilSen(xs, ys) {
  const n = xs.length;
  if (n < 3) return { slope: NaN, intercept: NaN };
  const slopes = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return { slope: NaN, intercept: NaN };
  const slope = median(slopes);
  const intercept = median(ys.map((y, i) => y - slope * xs[i]));
  return { slope, intercept };
}

function bootstrapSlopeCI_iid(xs, ys, fitFn, N, rng) {
  const n = xs.length;
  if (n < 3) return { lo: NaN, hi: NaN };
  const samples = new Array(N);
  const xb = new Array(n), yb = new Array(n);
  for (let b = 0; b < N; b++) {
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      xb[i] = xs[idx]; yb[i] = ys[idx];
    }
    const s = fitFn(xb, yb).slope;
    samples[b] = Number.isFinite(s) ? s : 0;
  }
  samples.sort((a, b) => a - b);
  return { lo: samples[Math.floor(N * 0.025)], hi: samples[Math.floor(N * 0.975)] };
}

// Cluster-by-park bootstrap: resample entire parks (with replacement),
// concatenate their observations, fit. Preserves within-park
// correlation structure that iid ignores.
function bootstrapSlopeCI_cluster(perParkData, fitFn, N, rng) {
  const keys = Object.keys(perParkData);
  const K = keys.length;
  if (K < 3) return { lo: NaN, hi: NaN };
  const samples = new Array(N);
  for (let b = 0; b < N; b++) {
    const xb = [];
    const yb = [];
    for (let i = 0; i < K; i++) {
      const k = keys[Math.floor(rng() * K)];
      const d = perParkData[k];
      for (let j = 0; j < d.xs.length; j++) { xb.push(d.xs[j]); yb.push(d.ys[j]); }
    }
    if (xb.length < 3) { samples[b] = 0; continue; }
    const s = fitFn(xb, yb).slope;
    samples[b] = Number.isFinite(s) ? s : 0;
  }
  samples.sort((a, b) => a - b);
  return { lo: samples[Math.floor(N * 0.025)], hi: samples[Math.floor(N * 0.975)] };
}

function windVecForGame(row, park) {
  if (row.wind_speed == null || row.wind_dir == null) return null;
  if (row.wind_speed < 8) return 0;
  const speedFactor = Math.min((row.wind_speed - 8) / 24, 0.75);
  const windTo = (row.wind_dir + 180) % 360;
  const diff = windTo - park.cfDir;
  return Math.cos(diff * Math.PI / 180) * speedFactor;
}

// ---------------------------------------------------------- pipeline

const rows = db.prepare(
    "SELECT g.game_date, g.game_id, g.home_team, g.venue_id, "
  + "  g.model_total, g.actual_total, g.home_score, g.away_score, "
  + "  g.wind_speed, g.wind_dir, "
  + "  g.roof_status, g.weather_contamination_reason "
  + "FROM game_log g "
  + "WHERE g.home_score IS NOT NULL AND g.actual_total IS NOT NULL "
  + "  AND g.model_total IS NOT NULL "
  + "  AND g.wind_speed IS NOT NULL AND g.wind_dir IS NOT NULL "
  + "  AND (g.roof_status IS NULL OR lower(g.roof_status) = 'open') "
  + "  AND g.weather_contamination_reason IS NULL"
).all();
const clean = rows.filter(r => !isNaiveHour(r) && !isAthVegas(r) && !isAthColiseum(r));

const perParkData = {};
const xs = [], ys = [], parkKeys = [], parkSensAtGame = [];
let dropped_no_park = 0, dropped_roofed = 0, dropped_placeholder = 0, dropped_deadband = 0;
for (const r of clean) {
  const parts = String(r.game_id).split('-');
  const key = parts[1];
  if (!key) { dropped_no_park++; continue; }
  const park = PARKS[key];
  if (!park) { dropped_no_park++; continue; }
  if (ROOFED_KEYS.has(key)) { dropped_roofed++; continue; }
  if (park.cfDir === 45) { dropped_placeholder++; continue; }
  const wv = windVecForGame(r, park);
  if (wv == null) { dropped_no_park++; continue; }
  if (wv === 0) { dropped_deadband++; continue; }
  const y = r.actual_total - r.model_total;
  xs.push(wv); ys.push(y);
  parkKeys.push(key); parkSensAtGame.push(park.sens);
  (perParkData[key] ||= { xs: [], ys: [], park }).xs.push(wv);
  perParkData[key].ys.push(y);
}
const n = xs.length;

// -------------------------------------------------------------- fits

const rngOls  = makeRng(SEED);
const rngTs   = makeRng(SEED + 1);
const rngNb   = makeRng(SEED + 2);
const rngOlsC = makeRng(SEED + 100);
const rngTsC  = makeRng(SEED + 101);
const rngNbC  = makeRng(SEED + 102);

const olsFit = olsWithIntercept(xs, ys);
const olsCI_iid     = bootstrapSlopeCI_iid(xs, ys, olsWithIntercept, BOOT_N, rngOls);
const olsCI_cluster = bootstrapSlopeCI_cluster(perParkData, olsWithIntercept, BOOT_N, rngOlsC);

const tsFit = theilSen(xs, ys);
const tsCI_iid     = bootstrapSlopeCI_iid(xs, ys, theilSen, BOOT_N, rngTs);
const tsCI_cluster = bootstrapSlopeCI_cluster(perParkData, theilSen, BOOT_N, rngTsC);

// Blowout-excluded fit. Re-walk clean rows to align actual_total with
// the fit-index order (same filter chain as above).
const actualByIdx = [];
{
  let k = 0;
  for (const r of clean) {
    const parts = String(r.game_id).split('-');
    const key = parts[1];
    if (!key) continue;
    const park = PARKS[key];
    if (!park) continue;
    if (ROOFED_KEYS.has(key)) continue;
    if (park.cfDir === 45) continue;
    const wv = windVecForGame(r, park);
    if (wv == null || wv === 0) continue;
    actualByIdx[k++] = r.actual_total;
  }
}
const nbMask = actualByIdx.map(a => a < BLOWOUT_THRESHOLD);
const xsNb = xs.filter((_, i) => nbMask[i]);
const ysNb = ys.filter((_, i) => nbMask[i]);
const nbFit = olsWithIntercept(xsNb, ysNb);
const nbCI_iid = bootstrapSlopeCI_iid(xsNb, ysNb, olsWithIntercept, BOOT_N, rngNb);
// cluster CI on blowout-excluded: rebuild perParkData filtered
const nbPerPark = {};
for (const key of Object.keys(perParkData)) {
  const d = perParkData[key];
  const xN = [], yN = [];
  // rebuild by index — need actual_total per obs. Add tag to perParkData earlier? cleanest: cache actual per obs
  // Simpler: rebuild by re-filtering clean rows for this park under the mask.
  // Use a running index into actualByIdx.
  // Actually since perParkData indices are in the same natural order as clean-filtered iteration,
  // we can reconstruct the mask per park too.
  // Cheap redo: re-walk clean for this park.
  for (const r of clean) {
    const parts = String(r.game_id).split('-');
    if (parts[1] !== key) continue;
    const park = PARKS[key];
    if (!park || ROOFED_KEYS.has(key) || park.cfDir === 45) continue;
    const wv = windVecForGame(r, park);
    if (wv == null || wv === 0) continue;
    if (r.actual_total >= BLOWOUT_THRESHOLD) continue;
    xN.push(wv); yN.push(r.actual_total - r.model_total);
  }
  if (xN.length) nbPerPark[key] = { xs: xN, ys: yN };
}
const nbCI_cluster = bootstrapSlopeCI_cluster(nbPerPark, olsWithIntercept, BOOT_N, rngNbC);

// --------------------------------------------------------- reporting

const nBlowouts = actualByIdx.filter(a => a >= BLOWOUT_THRESHOLD).length;
const parkCounts = {};
for (const k of parkKeys) parkCounts[k] = (parkCounts[k] || 0) + 1;

console.log('=== pooled league sens fit — 2026-08-19 ===');
console.log();
console.log('Universe (after filters):');
console.log('  clean rows in game_log (all filters): ' + clean.length);
console.log('  post-filter fit rows (wind_speed >= 8, open-air, cfDir != 45): ' + n);
console.log('  drops: no_park/no_key=' + dropped_no_park + ', roofed=' + dropped_roofed
  + ', cfDir=45 (should be 0 post-batch-3)=' + dropped_placeholder + ', below-deadband(wind<8)=' + dropped_deadband);
console.log('  blowouts (actual_total >= ' + BLOWOUT_THRESHOLD + '): ' + nBlowouts + ' (' + (100*nBlowouts/n).toFixed(1) + '%)');
console.log('  parks contributing rows (K=' + Object.keys(perParkData).length + '):');
for (const k of Object.keys(parkCounts).sort()) {
  console.log('    ' + k.padEnd(4) + ' n=' + String(parkCounts[k]).padStart(3) + '  current_sens=' + PARKS[k].sens);
}
console.log();

function line(label, γ, intercept, iid, cluster) {
  const dSens = γ / WIND_SCALE;
  const dSensIidLo = iid.lo / WIND_SCALE, dSensIidHi = iid.hi / WIND_SCALE;
  const dSensClsLo = cluster.lo / WIND_SCALE, dSensClsHi = cluster.hi / WIND_SCALE;
  const iidDistinguishable = (iid.lo > 0 && iid.hi > 0) || (iid.lo < 0 && iid.hi < 0);
  const clsDistinguishable = (cluster.lo > 0 && cluster.hi > 0) || (cluster.lo < 0 && cluster.hi < 0);
  console.log(label);
  console.log('  γ (slope):            ' + γ.toFixed(4) + '  →  Δ_global_sens = ' + dSens.toFixed(3));
  if (intercept != null) console.log('  intercept (residual at wind_vec=0): ' + (intercept >= 0 ? '+' : '') + intercept.toFixed(3) + ' runs');
  console.log('  iid bootstrap 95% CI on γ:     [' + iid.lo.toFixed(4) + ', ' + iid.hi.toFixed(4) + ']');
  console.log('    → sens delta CI:             [' + dSensIidLo.toFixed(3) + ', ' + dSensIidHi.toFixed(3) + ']  ' + (iidDistinguishable ? '(EXCLUDES 0 — directionally distinguishable)' : '(includes 0)'));
  console.log('  cluster-by-park 95% CI on γ:   [' + cluster.lo.toFixed(4) + ', ' + cluster.hi.toFixed(4) + ']');
  console.log('    → sens delta CI:             [' + dSensClsLo.toFixed(3) + ', ' + dSensClsHi.toFixed(3) + ']  ' + (clsDistinguishable ? '(EXCLUDES 0 — directionally distinguishable)' : '(includes 0)'));
  console.log();
}

line('OLS + intercept (base):', olsFit.slope, olsFit.intercept, olsCI_iid, olsCI_cluster);
line('Theil-Sen (robust):    ', tsFit.slope, tsFit.intercept, tsCI_iid, tsCI_cluster);
line('OLS + intercept, blowouts excluded (n=' + xsNb.length + '):', nbFit.slope, nbFit.intercept, nbCI_iid, nbCI_cluster);

// Convergence check across the three point estimates
const est = [olsFit.slope, tsFit.slope, nbFit.slope].filter(Number.isFinite);
const sensDeltas = est.map(g => g / WIND_SCALE);
const spread = Math.max(...sensDeltas) - Math.min(...sensDeltas);
console.log('=== convergence across fits ===');
console.log('sens-delta point estimates: ' + sensDeltas.map(d => d.toFixed(3)).join(', '));
console.log('spread (max - min):         ' + spread.toFixed(3) + ' sens units  ' + (spread <= 0.3 ? '(CONVERGED, threshold 0.3)' : '(diverged)'));
console.log();
console.log('=== interpretation ===');
console.log('γ ≈ 0 with CI including 0     → current per-park sens paste is aggregately calibrated');
console.log('γ > 0 with CI excluding 0     → sens is on average too LOW (should scale up)');
console.log('γ < 0 with CI excluding 0     → sens is on average too HIGH (should scale down)');
console.log();
console.log('*** Report only — no sens values shipped. ***');
