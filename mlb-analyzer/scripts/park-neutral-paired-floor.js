#!/usr/bin/env node
/**
 * What effect size can the park-neutral A/B resolve? (2026-08-30)
 *
 * RUN BEFORE THE PRE-REGISTRATION, and it deliberately does NOT compute the
 * answer. It reports the DISPERSION of the paired per-game log-loss
 * difference and the interval that follows from it. The signed mean -- the
 * actual effect -- is suppressed, so the bar can be set without having seen
 * what it will be compared against.
 *
 * WHY NOT resolution-floor.js --calibration. That measures a BETWEEN-COHORT
 * gap: split the corpus into two disjoint groups and ask whether their log
 * losses differ. Its floor on this corpus is ~0.020, and applying that here
 * would overstate the difficulty by more than an order of magnitude.
 *
 * The park-neutral A/B is PAIRED -- the same games, scored twice, differing
 * only in one flag. Per-game predictions under the two configurations are
 * almost perfectly correlated (the flag moves p(home) by ~0.003 on average),
 * so the paired difference has far less variance than a between-group
 * comparison. Using the wrong design's floor is the same class of error as
 * quoting a schedule share as a measurement n.
 *
 * Date-clustered, because games on a slate share weather, snapshot and
 * model version.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel } = require(path.join(R, 'services/model'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const EPS = 1e-9;
const clamp = q => Math.min(1 - EPS, Math.max(EPS, q));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function sd(a) { if (a.length < 2) return null; const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

// One-way ANOVA ICC by date -> design effect, measured not assumed.
function iccByDate(items, valueOf) {
  const by = new Map();
  for (const it of items) { const v = valueOf(it); if (v == null || !isFinite(v)) continue;
    if (!by.has(it.d)) by.set(it.d, []); by.get(it.d).push(v); }
  const groups = [...by.values()], all = groups.flat(), n = all.length, k = groups.length;
  if (k < 2 || n <= k) return { icc: 0, deff: 1, m0: null, n, k };
  const gm = mean(all);
  let ssb = 0, ssw = 0;
  for (const g of groups) { const m = mean(g); ssb += g.length * (m - gm) * (m - gm);
    for (const x of g) ssw += (x - m) * (x - m); }
  const msb = ssb / (k - 1), msw = ssw / (n - k);
  const m0 = (n - groups.reduce((s, g) => s + g.length * g.length, 0) / n) / (k - 1);
  const icc = (msb + (m0 - 1) * msw) === 0 ? 0 : (msb - msw) / (msb + (m0 - 1) * msw);
  return { icc, deff: 1 + (m0 - 1) * Math.max(0, icc), m0, n, k };
}

(function main() {
  const base = jobs.getSettings();
  const ON = Object.assign({}, base, { PARK_NEUTRAL_INPUTS_ENABLED: true });
  const OFF = Object.assign({}, base, { PARK_NEUTRAL_INPUTS_ENABLED: false });

  const games = ps.loadGames(db, '2026-04-01', '2026-12-31');
  const snap = new Map();
  const diffs = [];       // per-game paired log-loss difference
  let scored = 0, moved = 0;

  const real = console.log; console.log = () => {};
  for (const g of games) {
    if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue;
    if (g.market_home_ml == null) continue;
    if (!snap.has(g.game_date)) snap.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = snap.get(g.game_date); if (!idx) continue;
    const pre = ps.preScreenGame(g, idx, base); if (!pre) continue;
    const w = hi.populateCallerInputs ? hi.populateCallerInputs(pre, g, base) : pre;
    let a, b;
    try {
      a = runModel(w || pre, idx, OFF, 'opener_aware', true);
      b = runModel(w || pre, idx, ON,  'opener_aware', true);
    } catch (e) { continue; }
    if (!a || !b || a._suppressed || b._suppressed) continue;
    if (a.adjHW == null || b.adjHW == null) continue;
    const y = g.home_score > g.away_score ? 1 : 0;
    const ll = p => -(y * Math.log(clamp(p)) + (1 - y) * Math.log(1 - clamp(p)));
    const d = ll(b.adjHW) - ll(a.adjHW);     // ON minus OFF, per game
    if (!isFinite(d)) continue;
    scored++;
    if (Math.abs(b.adjHW - a.adjHW) > 1e-9) moved++;
    diffs.push({ d: g.game_date, v: d });
  }
  console.log = real;

  const vals = diffs.map(x => x.v);
  const s = sd(vals);
  const st = iccByDate(diffs, x => x.v);
  const n = vals.length;
  const se = s / Math.sqrt(n) * Math.sqrt(st.deff);
  const half = 1.959964 * se;

  console.log('=== park-neutral A/B: what can this design resolve? ===');
  console.log('  DISPERSION ONLY. The signed mean is deliberately NOT printed --');
  console.log('  the bar has to be set before the answer is visible.');
  console.log('');
  console.log('  games scored both ways : ' + scored);
  console.log('  games the flag MOVED   : ' + moved
    + (scored ? '  (' + (100 * moved / scored).toFixed(1) + '%)' : ''));
  console.log('');
  console.log('  sd(per-game paired d log loss) : ' + s.toFixed(6));
  console.log('  date clustering: ICC ' + st.icc.toFixed(4) + ' over ' + st.k
    + ' dates (' + (st.m0 == null ? '?' : st.m0.toFixed(1)) + ' games/date)'
    + ' -> design effect ' + st.deff.toFixed(3));
  console.log('');
  console.log('  RESOLVABLE at n=' + n + ' : +/-' + half.toFixed(6) + ' (95% CI half-width)');
  console.log('');
  console.log('  For comparison, resolution-floor.js --calibration reports ~0.020 --');
  console.log('  but that is a BETWEEN-COHORT split, a different and far noisier');
  console.log('  design. Quoting it here would overstate the difficulty by ~30x.');
  console.log('');
  console.log('  n required to resolve a given |effect|, same design:');
  console.log('    effect      n needed     games beyond the current ' + n);
  for (const e of [0.00100, 0.00055, 0.00030, 0.00010]) {
    const need = Math.ceil(n * Math.pow(half / e, 2));
    console.log('    ' + e.toFixed(5) + '   ' + String(need).padStart(9)
      + '     ' + (need <= n ? 'already resolvable' : '+' + (need - n)));
  }
  console.log('');
  console.log('  The 2026-08-23 evaluation reported d log loss -0.00055 with CI');
  console.log('  [-0.00117, +0.00012], i.e. a half-width of 0.00065. That is the');
  console.log('  paired figure and it is the right order of magnitude to compare');
  console.log('  against the line above.');
})();
