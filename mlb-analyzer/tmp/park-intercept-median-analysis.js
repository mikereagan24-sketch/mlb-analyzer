'use strict';

// Per-park residual level analysis — median-first per CLAUDE.md
// skewed-residual rule.
//
// Prompted by the pooled-sens-fit intercepts (was +3.11, pit +3.06,
// nym +2.28, nyy +2.10, bal +1.93 sens-audit run) which look like a
// per-park under-forecast pattern but on the same right-skewed
// residual distribution that produced the 2026-08-06 C1 retraction.
//
// Reports per park:
//   - n (games passing filters)
//   - mean residual (actual_total - model_total)
//   - MEDIAN residual (CLAUDE.md rule: report median FIRST)
//   - sign split (% > 0 vs < 0, with binomial 95% CI)
//   - blowout-excluded mean (drop rows with actual_total >= 15)
//   - n of blowouts and their contribution to the mean
//   - 5%/5% and 10%/10% trimmed means (tail-driven vs level check)
//
// Verdict rubric:
//   - median near 0 (|·| < 0.2), sign split near 50/50, blowout-
//     excluded mean small (|·| < 0.3): TAIL ARTIFACT — no action
//   - median clearly positive (> 0.3), sign split > 55/45, blowout-
//     excluded mean also positive (> 0.3): GENUINE PER-PARK LEVEL
//     shift — worth investigating as a park-factor question
//   - mixed signals (e.g. positive median but centered sign split):
//     ambiguous — needs more data
//
// Filter set (broader than the sens fit — no wind-speed constraint,
// this is about the residual LEVEL not the wind response):
//   - home_score / actual_total / model_total NOT NULL
//   - roof_status IS NULL or 'open'
//   - weather_contamination_reason IS NULL
//   - manual isNaiveHour / isAthVegas / isAthColiseum proxy false
//
// Universe: 11 open-air ET parks (same set as the retired harness's
// ET_ONLY methodology check — the parks with enough post-filter n).

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
const { PARKS } = require('../services/weather');

const BLOWOUT_THRESHOLD = 15;
const ROOFED_KEYS = new Set(['ari','hou','tex','tor','mia','mil','sea','tb']);
const NON_ET = new Set(['COL','ARI','LAD','LAA','SD','SF','SEA','ATH','CHC','CWS','MIL','MIN','STL','HOU','TEX','KC']);
const ET_KEYS = new Set(['nyy','nym','bos','det','cle','bal','was','phi','pit','cin','atl']);

function isNaiveHour(r){ return r.game_date < '2026-07-30' && NON_ET.has((r.home_team||'').toUpperCase()); }
function isAthVegas(r){ return r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && (r.home_team||'').toUpperCase() === 'ATH' && r.venue_id === 5355; }
function isAthColiseum(r){ return r.game_date < '2026-07-27' && (r.home_team||'').toUpperCase() === 'ATH' && !isAthVegas(r); }

function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n-1)/2] : (s[n/2 - 1] + s[n/2]) / 2;
}
function trimmedMean(a, p) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  const drop = Math.floor(n * p);
  const t = s.slice(drop, n - drop);
  return t.length ? mean(t) : NaN;
}

// Wilson score interval for binomial proportion — better than
// normal approx at small n or extreme proportions.
function wilsonCI(k, n, z = 1.96) {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = k / n;
  const denom = 1 + z*z/n;
  const center = (p + z*z/(2*n)) / denom;
  const halfW  = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / denom;
  return { lo: Math.max(0, center - halfW), hi: Math.min(1, center + halfW) };
}

// ---------------------------------------------------------- pipeline

const rows = db.prepare(
    "SELECT g.game_date, g.game_id, g.home_team, g.venue_id, "
  + "  g.model_total, g.actual_total, g.home_score, g.away_score, "
  + "  g.roof_status, g.weather_contamination_reason "
  + "FROM game_log g "
  + "WHERE g.home_score IS NOT NULL AND g.actual_total IS NOT NULL "
  + "  AND g.model_total IS NOT NULL "
  + "  AND (g.roof_status IS NULL OR lower(g.roof_status) = 'open') "
  + "  AND g.weather_contamination_reason IS NULL"
).all();
const clean = rows.filter(r => !isNaiveHour(r) && !isAthVegas(r) && !isAthColiseum(r));

const perPark = {};
for (const r of clean) {
  const parts = String(r.game_id).split('-');
  const key = parts[1];
  if (!key) continue;
  const park = PARKS[key];
  if (!park) continue;
  if (ROOFED_KEYS.has(key)) continue;
  if (park.cfDir === 45) continue;
  if (!ET_KEYS.has(key)) continue;
  (perPark[key] ||= { park, residuals: [], actuals: [] });
  perPark[key].residuals.push(r.actual_total - r.model_total);
  perPark[key].actuals.push(r.actual_total);
}

// -------------------------------------------------------- diagnostics

const results = [];
for (const [key, d] of Object.entries(perPark)) {
  const n = d.residuals.length;
  const resids = d.residuals;
  const acts = d.actuals;

  const m  = mean(resids);
  const md = median(resids);
  const t5 = trimmedMean(resids, 0.05);
  const t10 = trimmedMean(resids, 0.10);

  const nPos = resids.filter(v => v > 0).length;
  const nNeg = resids.filter(v => v < 0).length;
  const nZero = n - nPos - nNeg;
  const signPct = 100 * nPos / n;
  const signCI = wilsonCI(nPos, n);

  const blowoutIdx = acts.map((a, i) => a >= BLOWOUT_THRESHOLD ? i : -1).filter(i => i >= 0);
  const nBlowouts = blowoutIdx.length;
  const blowoutResids = blowoutIdx.map(i => resids[i]);
  const nbResids = resids.filter((_, i) => !blowoutIdx.includes(i));
  const nbMean = nbResids.length ? mean(nbResids) : NaN;
  const nbMedian = nbResids.length ? median(nbResids) : NaN;
  const blowoutMean = nBlowouts ? mean(blowoutResids) : NaN;

  // Contribution of blowouts to the mean: (mean_all - mean_nb) tells us
  // how much of the mean is being pulled by the top ~15% tail.
  const meanShiftFromBlowouts = m - nbMean;

  // Verdict rubric.
  let verdict = 'AMBIGUOUS';
  if (Math.abs(md) < 0.2 && signPct >= 45 && signPct <= 55 && Math.abs(nbMean) < 0.3) {
    verdict = 'TAIL_ARTIFACT (median near 0, sign split centered, blowout-excluded mean small)';
  } else if (md > 0.3 && signPct > 55 && nbMean > 0.3) {
    verdict = 'GENUINE_POS_LEVEL (median positive, sign split > 55, blowout-excluded mean positive)';
  } else if (md < -0.3 && signPct < 45 && nbMean < -0.3) {
    verdict = 'GENUINE_NEG_LEVEL (median negative, sign split < 45, blowout-excluded mean negative)';
  }

  results.push({
    key, name: d.park.name, cfDir: d.park.cfDir, sens: d.park.sens, n,
    mean: m, median: md, t5, t10,
    signPct, signCI, nPos, nNeg, nZero,
    nBlowouts, blowoutMean, meanShiftFromBlowouts,
    nbN: nbResids.length, nbMean, nbMedian,
    verdict,
  });
}

results.sort((a, b) => b.median - a.median);

// --------------------------------------------------------- reporting

console.log('=== per-park residual level (median-first) — ET open-air parks ===');
console.log('Universe: ' + clean.length + ' clean rows post-filter league-wide; ' +
  Object.values(perPark).reduce((s, d) => s + d.residuals.length, 0) + ' rows in ET open-air fit.');
console.log('Blowout threshold: actual_total >= ' + BLOWOUT_THRESHOLD);
console.log();
console.log('Table sorted by MEDIAN residual (descending, per CLAUDE.md rule):');
console.log();
const hdr = 'park  n   sens | mean   median | sign%_pos [95% CI]  | trim5% trim10% | n_blow  blow_mean  shift_from_tail | no_blow_n  no_blow_mean  no_blow_median | verdict';
console.log(hdr);
console.log('-'.repeat(hdr.length));
for (const r of results) {
  console.log(
    r.key.padEnd(4) + '  ' +
    String(r.n).padStart(3) + '  ' +
    r.sens.toFixed(1) + ' | ' +
    (r.mean >= 0 ? '+' : '') + r.mean.toFixed(2).padStart(5) + '  ' +
    (r.median >= 0 ? '+' : '') + r.median.toFixed(2).padStart(5) + '  | ' +
    r.signPct.toFixed(0).padStart(3) + '%   [' + (r.signCI.lo*100).toFixed(0).padStart(2) + '%, ' + (r.signCI.hi*100).toFixed(0).padStart(2) + '%]  | ' +
    (r.t5 >= 0 ? '+' : '') + r.t5.toFixed(2).padStart(5) + '  ' +
    (r.t10 >= 0 ? '+' : '') + r.t10.toFixed(2).padStart(5) + '  | ' +
    String(r.nBlowouts).padStart(2) + '     ' +
    (Number.isFinite(r.blowoutMean) ? (r.blowoutMean >= 0 ? '+' : '') + r.blowoutMean.toFixed(2) : ' NA').padStart(6) + '     ' +
    (r.meanShiftFromBlowouts >= 0 ? '+' : '') + r.meanShiftFromBlowouts.toFixed(2).padStart(5) + '        | ' +
    String(r.nbN).padStart(3) + '        ' +
    (Number.isFinite(r.nbMean) ? (r.nbMean >= 0 ? '+' : '') + r.nbMean.toFixed(2) : ' NA').padStart(6) + '        ' +
    (Number.isFinite(r.nbMedian) ? (r.nbMedian >= 0 ? '+' : '') + r.nbMedian.toFixed(2) : ' NA').padStart(6) + '   | ' +
    r.verdict
  );
}

// --------------------------------------------------------- summary
console.log();
console.log('=== summary ===');
const buckets = { TAIL_ARTIFACT: 0, GENUINE_POS_LEVEL: 0, GENUINE_NEG_LEVEL: 0, AMBIGUOUS: 0 };
for (const r of results) {
  const key = r.verdict.split(' ')[0];
  buckets[key] = (buckets[key] || 0) + 1;
}
for (const [k, v] of Object.entries(buckets)) {
  if (v > 0) console.log('  ' + k + ': ' + v);
}
console.log();
console.log('Cross-check vs the pooled-fit intercepts (which came from an OLS run with wind_speed>=8 restriction — smaller n per park):');
console.log('  If parks flagged with high sens-audit intercept (was +3.11, pit +3.06, nym +2.28, nyy +2.10, bal +1.93)');
console.log('  show TAIL_ARTIFACT here on the wider dataset, the sens-audit intercept was reading blowout skew,');
console.log('  not a genuine level shift.');
console.log();
console.log('*** Report only — no model changes shipped. ***');
