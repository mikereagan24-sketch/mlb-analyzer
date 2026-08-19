'use strict';

// Per-park wind-sens audit harness.
//
// STATUS: RETIRED as a per-park estimator (2026-08-19). Methodology
// check on the 11 best-sampled open-air ET parks (n=18-34, ~50-game
// post-TZ-fix data window) returned:
//   - 1 of 11 parks converges across the three fits (spread ≤ 0.3 sens
//     units); the other 10 diverge by 0.7 to 11.4 sens units.
//   - 0 of 11 parks show a distinguishable Δ from current sens
//     (all OLS+int 95% CIs include zero).
//   - CI-half-width scaling implies n ≈ 4,600 per park needed to
//     resolve a ±0.5 sens delta — unreachable at MLB season game
//     counts even with decades of data.
// The OLS-on-residual-vs-wind-vec design is noise-limited at MLB
// game-count scales, not sample-blocked. Waiting for organic
// accumulation on non-ET parks (Oracle, etc.) will not help.
//
// This file is kept as the reproducibility artifact for that
// methodology check. Successor is a pooled league fit (tmp/… TBD)
// that trades per-park resolution for effective n ~ 400.
//
// -----------------------------------------------------------------
//
// Refined design (post user's C1-skew feedback, 2026-08-11):
//   - Three fits per park, all with INTERCEPT (never no-intercept):
//       (a) OLS with intercept — base
//       (b) Theil-Sen (median pairwise slopes) — robust to blowout tail
//       (c) OLS with intercept, EXCLUDING blowouts (actual_total >= 15) —
//           CLAUDE.md skewed-residual cross-check
//   - Bootstrap 95% CI on each slope (2000 resamples, seeded)
//   - Convert slope γ → sens delta via WIND_SCALE=2.0 (confirmed in
//     app_settings): proposed_sens = current_sens + γ / WIND_SCALE
//   - Stability flag: if |Δ β_max - Δ β_min| across the three fits
//     exceeds 0.3 sens units, the estimate is tail-driven not wind-
//     driven; report but don't recommend.
//   - Under-powered flag: n < 40 games OR bootstrap CI span > 1.0 in
//     sens units → not enough data to distinguish.
//
// Fit spec:
//   Y = actual_total - model_total  (runs; residual after current wind adj)
//   X = alignment * speedFactor     (dimensionless, sens-free wind projection)
//   fit: Y ~ intercept + γ · X
//   γ interpretation: runs of unattributed wind response the current
//                     sens is missing (positive → sens too low)
//   proposed_sens = park.sens + γ / WIND_SCALE
//
// Prerequisite guards:
//   - park.cfDir NOT the 45° placeholder (fitting sens with wrong bearing
//     confounds bearing error into γ — same reason batch 3 must land first)
//   - Open-air only: 8 roofed venues (ARI, HOU, TEX, TOR, MIA, MIL, SEA,
//     TB) skipped entirely — closed-roof games have wind_factor=0 by
//     design and open-roof samples are small
//
// Universe:
//   - cohort IN ('v6','v7') — post-cutover
//   - home_score IS NOT NULL AND actual_total IS NOT NULL
//   - wind_speed IS NOT NULL AND wind_dir IS NOT NULL
//   - model_total IS NOT NULL
//   - roof_status IS NULL or 'open' (defensive against retractable open-days)
//   - weather_contamination_reason IS NULL, plus manual prod-equivalent
//     proxy (naive-hour, ATH-vegas, ATH-coliseum) since local is stale on
//     tagging
//   - wind_speed >= 8mph (engine's deadband; below → engine returns 0 which
//     would anchor the fit at the noise floor)

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

// PARKS lookup — read from the module so we pick up the LATEST cfDir + sens.
const { PARKS } = require('../services/weather');

const WIND_SCALE = 2.0;
const BOOT_N = 2000;
const SEED = 42;
const BLOWOUT_THRESHOLD = 15;
const MIN_N_PARK = 40;
const CI_SPAN_UNPOWERED_SENS = 1.0;
const BETA_STABILITY_THRESHOLD_SENS = 0.3;

// 8 roofed venues to exclude entirely.
const ROOFED_KEYS = new Set(['ari','hou','tex','tor','mia','mil','sea','tb']);

// ET-only methodology-check mode. Restricts to the 11 open-air ET parks.
// Rationale (2026-08-19 report to user): non-ET parks' pre-2026-07-30 wind
// values were populated by the naive-ET-hour scraper and are wrong; the
// backfill task deliberately preserves the wrong values on contaminated
// rows (services/backfill-tasks/weather-backfill-season.js:22-35). Local
// DB tagging is stale (only 27 ARI-roof-cohort tags), so the manual
// isNaiveHour proxy is what actually excludes them. ET-only sidesteps
// this entirely — ET parks were unaffected by the naive-hour bug and
// have full-season correct-hour data. The question this mode answers:
// at the best-sampled parks (n≈20-34, ~50-game data window), do the
// three fits (OLS+int, Theil-Sen, blowout-excluded OLS+int) converge
// on a single sens estimate, and does any park show a distinguishable
// Δ from current? If no, the approach is under-powered irrespective of
// eventual data volume for other parks.
const ET_ONLY = true;
const ET_KEYS = new Set(['nyy','nym','bos','det','cle','bal','was','phi','pit','cin','atl']);

// Manual prod-equivalent contamination filter (local is stale on tagging).
const NON_ET = new Set(['COL','ARI','LAD','LAA','SD','SF','SEA','ATH','CHC','CWS','MIL','MIN','STL','HOU','TEX','KC']);
function isNaiveHour(r){ return r.game_date < '2026-07-30' && NON_ET.has((r.home_team||'').toUpperCase()); }
function isAthVegas(r){ return r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && (r.home_team||'').toUpperCase() === 'ATH' && r.venue_id === 5355; }
function isAthColiseum(r){ return r.game_date < '2026-07-27' && (r.home_team||'').toUpperCase() === 'ATH' && !isAthVegas(r); }

// PRNG — mulberry32, matches prior sweeps.
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

// OLS with intercept: fits y = a + b·x. Returns { slope, intercept }.
// Returns { slope: NaN } when x has zero variance.
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

// Theil-Sen: median of pairwise slopes. Robust to blowout tail because
// pairwise slopes involving outliers are extreme and get pushed to the
// tails of the sorted slope distribution. Intercept via median of
// (y_i - slope·x_i).
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

// Bootstrap 95% CI on the slope of a given fit function.
function bootstrapSlopeCI(xs, ys, fitFn, N, rng) {
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

// Wind feature: dimensionless (alignment × speedFactor). Sens-free.
// Matches calcWindFactor's internal math but omits the ×park.sens step.
function windVecForGame(row, park) {
  if (row.wind_speed == null || row.wind_dir == null) return null;
  if (row.wind_speed < 8) return 0;  // engine deadband; return 0 so it's excluded by the >0 filter downstream
  const speedFactor = Math.min((row.wind_speed - 8) / 24, 0.75);
  const windTo = (row.wind_dir + 180) % 360;
  const diff = windTo - park.cfDir;
  return Math.cos(diff * Math.PI / 180) * speedFactor;
}

// ================================================================ pipeline

// Universe pull.
const rows = db.prepare(
    "SELECT g.game_date, g.game_id, g.home_team, g.venue_id, "
  + "  g.model_total, g.actual_total, g.home_score, g.away_score, "
  + "  g.wind_speed, g.wind_dir, g.temp_f, "
  + "  g.roof_status, g.weather_contamination_reason "
  + "FROM game_log g "
  + "WHERE g.home_score IS NOT NULL AND g.actual_total IS NOT NULL "
  + "  AND g.model_total IS NOT NULL "
  + "  AND g.wind_speed IS NOT NULL AND g.wind_dir IS NOT NULL "
  + "  AND (g.roof_status IS NULL OR lower(g.roof_status) = 'open') "
  + "  AND g.weather_contamination_reason IS NULL"
).all();
const clean = rows.filter(r => !isNaiveHour(r) && !isAthVegas(r) && !isAthColiseum(r));

// Bucket by park key. Skip roofed venues + placeholder cfDirs.
const perPark = {};
const skippedPlaceholder = [];
const skippedRoofed = [];
for (const r of clean) {
  const parts = String(r.game_id).split('-');
  const key = parts[1];  // home team key
  if (!key) continue;
  const park = PARKS[key];
  if (!park) continue;
  if (ROOFED_KEYS.has(key)) { skippedRoofed.push(key); continue; }
  if (park.cfDir === 45) {
    if (!skippedPlaceholder.includes(key)) skippedPlaceholder.push(key);
    continue;
  }
  if (ET_ONLY && !ET_KEYS.has(key)) continue;
  const wv = windVecForGame(r, park);
  if (wv == null) continue;
  if (wv === 0) continue;  // engine deadband: exclude below-8mph games from the fit
  const y = r.actual_total - r.model_total;
  (perPark[key] ||= { park, xs: [], ys: [], rows: [] });
  perPark[key].xs.push(wv);
  perPark[key].ys.push(y);
  perPark[key].rows.push(r);
}

// ================================================================ per-park fits

const results = [];
for (const [key, data] of Object.entries(perPark)) {
  const { park, xs, ys, rows: parkRows } = data;
  const n = xs.length;
  const rng = makeRng(SEED + key.charCodeAt(0));

  // Fit (a): OLS with intercept
  const olsFit = olsWithIntercept(xs, ys);
  const olsCI = bootstrapSlopeCI(xs, ys, olsWithIntercept, BOOT_N, rng);

  // Fit (b): Theil-Sen (median slope, robust)
  const tsFit = theilSen(xs, ys);
  const tsCI = bootstrapSlopeCI(xs, ys, theilSen, BOOT_N, makeRng(SEED + key.charCodeAt(0) + 1));

  // Fit (c): OLS with intercept, excluding blowouts
  const nbIdx = parkRows.map((r, i) => r.actual_total < BLOWOUT_THRESHOLD ? i : -1).filter(i => i >= 0);
  const xsNb = nbIdx.map(i => xs[i]);
  const ysNb = nbIdx.map(i => ys[i]);
  const nbFit = olsWithIntercept(xsNb, ysNb);
  const nbCI  = xsNb.length >= 3
    ? bootstrapSlopeCI(xsNb, ysNb, olsWithIntercept, BOOT_N, makeRng(SEED + key.charCodeAt(0) + 2))
    : { lo: NaN, hi: NaN };

  // Convert slopes → sens deltas.
  const toSensDelta = g => g / WIND_SCALE;
  const currentSens = park.sens;
  const olsSens  = Number.isFinite(olsFit.slope)  ? currentSens + toSensDelta(olsFit.slope)  : NaN;
  const tsSens   = Number.isFinite(tsFit.slope)   ? currentSens + toSensDelta(tsFit.slope)   : NaN;
  const nbSens   = Number.isFinite(nbFit.slope)   ? currentSens + toSensDelta(nbFit.slope)   : NaN;
  const olsSensLo = currentSens + toSensDelta(olsCI.lo);
  const olsSensHi = currentSens + toSensDelta(olsCI.hi);
  const tsSensLo  = currentSens + toSensDelta(tsCI.lo);
  const tsSensHi  = currentSens + toSensDelta(tsCI.hi);

  // Flags.
  const sensValues = [olsSens, tsSens, nbSens].filter(v => Number.isFinite(v));
  const sensSpread = sensValues.length ? Math.max(...sensValues) - Math.min(...sensValues) : NaN;
  const tailDriven = sensSpread > BETA_STABILITY_THRESHOLD_SENS;
  const underpowered = n < MIN_N_PARK || (olsSensHi - olsSensLo) > CI_SPAN_UNPOWERED_SENS;

  results.push({
    key, name: park.name, cfDir: park.cfDir, currentSens, n,
    olsSens, olsIntercept: olsFit.intercept, olsSensLo, olsSensHi,
    tsSens, tsIntercept: tsFit.intercept, tsSensLo, tsSensHi,
    nbSens, nbN: xsNb.length,
    sensSpread, tailDriven, underpowered,
    blowoutCount: n - xsNb.length,
  });
}

results.sort((a, b) => {
  const da = Math.abs(a.olsSens - a.currentSens);
  const db = Math.abs(b.olsSens - b.currentSens);
  return db - da;
});

// ================================================================ report

console.log('=== sens audit — ET-only methodology check (' + (ET_ONLY ? 'ET_ONLY=true' : 'ET_ONLY=false') + ') ===');
if (ET_ONLY) console.log('Universe restricted to 11 open-air ET parks: ' + [...ET_KEYS].sort().join(', '));
console.log('Total clean rows in universe: ' + clean.length);
console.log('Parks with fitted sens: ' + results.length);
console.log('Skipped (cfDir 45° placeholder, awaiting batch 3): ' + skippedPlaceholder.sort().join(', '));
console.log('Skipped (roofed, always): ' + [...new Set(skippedRoofed)].sort().join(', '));
console.log();
console.log('WIND_SCALE = ' + WIND_SCALE + ' (confirmed in app_settings)');
console.log('Blowout threshold: actual_total >= ' + BLOWOUT_THRESHOLD);
console.log('Bootstrap resamples: ' + BOOT_N + ', PRNG seed ' + SEED);
console.log();
console.log('Table sorted by |Δ| (OLS proposed − current sens):');
console.log();
const hdr = 'park cfDir  n   blowouts | cur   | OLS+int  [95% CI]         intercept | Theil-Sen [95% CI]      | OLS no-blowout (n)  | spread | flags';
console.log(hdr);
console.log('-'.repeat(hdr.length + 20));
for (const r of results) {
  const flags = [];
  if (r.underpowered) flags.push('LOW-N');
  if (r.tailDriven)   flags.push('TAIL-DRIVEN');
  const flagStr = flags.length ? flags.join('+') : '';
  console.log(
    r.key.padEnd(4) + ' ' + String(r.cfDir).padStart(3) + '° ' +
    String(r.n).padStart(3) + '  ' +
    String(r.blowoutCount).padStart(2) + '       | ' +
    r.currentSens.toFixed(2).padStart(5) + ' | ' +
    (Number.isFinite(r.olsSens) ? r.olsSens.toFixed(2) : ' NaN').padStart(6) +
      '  [' + (Number.isFinite(r.olsSensLo) ? r.olsSensLo.toFixed(2) : 'NaN').padStart(6) + ', ' +
      (Number.isFinite(r.olsSensHi) ? r.olsSensHi.toFixed(2) : 'NaN').padStart(6) + ']  ' +
      (Number.isFinite(r.olsIntercept) ? (r.olsIntercept >= 0 ? '+' : '') + r.olsIntercept.toFixed(3) : ' NaN').padStart(7) + ' | ' +
    (Number.isFinite(r.tsSens) ? r.tsSens.toFixed(2) : ' NaN').padStart(6) +
      '  [' + (Number.isFinite(r.tsSensLo) ? r.tsSensLo.toFixed(2) : 'NaN').padStart(6) + ', ' +
      (Number.isFinite(r.tsSensHi) ? r.tsSensHi.toFixed(2) : 'NaN').padStart(6) + '] | ' +
    (Number.isFinite(r.nbSens) ? r.nbSens.toFixed(2) : ' NaN').padStart(6) + ' (' + String(r.nbN).padStart(3) + ')     | ' +
    (Number.isFinite(r.sensSpread) ? r.sensSpread.toFixed(2) : 'NaN').padStart(4) + '  | ' + flagStr
  );
}

// Oracle deep-dive.
const sfg = results.find(r => r.key === 'sfg' || r.key === 'sf');
if (sfg) {
  console.log();
  console.log('=== Oracle Park (sfg) deep-dive ===');
  console.log('Prior: sens 1.8 (initial) → 0.3 (6× cut in commit 6cb8f32, 2026-04-12, external research).');
  console.log('Current sens: ' + sfg.currentSens);
  console.log('Empirical sens (this fit):');
  console.log('  OLS with intercept: ' + sfg.olsSens.toFixed(2) + ' [' + sfg.olsSensLo.toFixed(2) + ', ' + sfg.olsSensHi.toFixed(2) + '], intercept=' + sfg.olsIntercept.toFixed(3));
  console.log('  Theil-Sen:          ' + sfg.tsSens.toFixed(2) + ' [' + sfg.tsSensLo.toFixed(2) + ', ' + sfg.tsSensHi.toFixed(2) + ']');
  console.log('  OLS no-blowouts:    ' + sfg.nbSens.toFixed(2) + '  (n=' + sfg.nbN + ' of ' + sfg.n + ')');
  console.log('  Spread across fits: ' + sfg.sensSpread.toFixed(2) + '  ' + (sfg.tailDriven ? '(TAIL-DRIVEN — reject read)' : '(stable)'));
  console.log('  Flags: ' + [sfg.underpowered ? 'LOW-N' : '', sfg.tailDriven ? 'TAIL-DRIVEN' : ''].filter(Boolean).join(', ') || '(none)');
}

// Summary counts
console.log();
console.log('=== summary ===');
const distinguishable = results.filter(r => !r.underpowered && !r.tailDriven && (Math.abs(r.olsSens - r.currentSens) > 0.2));
console.log('Parks with distinguishable Δ (>0.2 sens units, not flagged): ' + distinguishable.length + ' of ' + results.length);
if (distinguishable.length) {
  distinguishable.sort((a, b) => Math.abs(b.olsSens - b.currentSens) - Math.abs(a.olsSens - a.currentSens));
  for (const r of distinguishable) {
    console.log('  ' + r.key + ': ' + r.currentSens + ' → ' + r.olsSens.toFixed(2)
      + '  (Δ ' + (r.olsSens >= r.currentSens ? '+' : '') + (r.olsSens - r.currentSens).toFixed(2) + ')');
  }
}
console.log();
console.log('*** Report only — no sens values shipped. Local DB snapshot: mlb.db mtime above. ***');
