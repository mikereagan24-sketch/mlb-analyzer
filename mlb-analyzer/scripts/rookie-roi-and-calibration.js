#!/usr/bin/env node
/**
 * Rookie-cohort ROI and calibration. (2026-08-26)
 *
 * Prediction committed FIRST: docs/rookie-roi-prediction-2026-08-26.md
 * (b52c101, 2026-08-26T11:44:42-07:00). CONFIRMATION requires rookie ROI
 * >= 15pp worse than the rest AND a date-clustered CI on the difference
 * excluding zero. REFUTATION is a CI excluding -15pp. Everything between
 * is INCONCLUSIVE, which the pre-registration names as the most likely
 * outcome. This script prints the verdict from those rules rather than
 * leaving it to be read off the point estimate afterwards.
 *
 * TWO LEGS, because they answer different questions:
 *   ROI          - over EMITTED signals, so it measures SELECTION, not
 *                  pricing (the 2026-08-21 rule -- calcPnl never sees a
 *                  model number).
 *   CALIBRATION  - log loss and edge slope over ALL scored games in the
 *                  cohort, emitted or not. This is the leg that speaks to
 *                  whether the model prices these games badly.
 *
 * Cohort assignment is NOT re-implemented here. It comes from
 * scripts/build-rookie-cohorts.js -- as-of-date accumulation, spring
 * training excluded, career IP backed out of the as-of-fetch figure, the
 * AZ/WSH remap. A second copy of that logic is exactly the failure mode
 * the duplicate-implementation rule exists for.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { build, gamesFromRows, ROOKIE_IP } = require(path.join(R, 'scripts/build-rookie-cohorts'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel, impliedP } = require(path.join(R, 'services/model'));
const { wageredFor } = require(path.join(R, 'utils/wagered'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const BOOT = 3000, EPS = 1e-9;
const BAR = -15;                       // pre-registered, in ROI percentage points
const clamp = q => Math.min(1 - EPS, Math.max(EPS, q));

function mulberry(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// Date-clustered. Games on one date share a slate, weather, model version
// and odds pull, so resampling rows independently would understate every
// interval here -- the same reason build-rookie-cohorts.js clusters.
function clusteredCI(items, stat, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed), out = [];
  if (!n) return [null, null];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < n; i++) for (const x of byDate.get(dates[Math.floor(rnd() * n)])) s.push(x);
    const v = stat(s); if (v != null && isFinite(v)) out.push(v);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const roi = rows => { let w = 0, p = 0; for (const r of rows) { w += r.wag; p += r.pnl; } return w > 0 ? 100 * p / w : null; };
const logLoss = rows => { let s = 0; for (const r of rows) s += -(r.y * Math.log(r.p) + (1 - r.y) * Math.log(1 - r.p)); return rows.length ? s / rows.length : null; };
// Realised excess regressed on claimed edge. Slope 1.0 = the claimed edge
// is fully realised; 0.0 = the claimed edge carries no information.
function edgeSlope(rows) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const r of rows) { const x = r.p - r.mkt, y = r.y - r.mkt; sx += x; sy += y; sxx += x * x; sxy += x * y; n++; }
  const d = n * sxx - sx * sx;
  return d === 0 ? null : (n * sxy - sx * sy) / d;
}
const f = (v, d) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d == null ? 2 : d);
const ci = (a, d) => '[' + f(a[0], d) + ', ' + f(a[1], d) + ']';

(function main() {
  const settings = jobs.getSettings();
  const { MIN_BF, rows: startRows } = build();
  const cohorts = gamesFromRows(startRows);          // key: 'YYYY-MM-DD|game_id'

  console.log('=== rookie cohort: ROI and calibration ===');
  console.log('  prediction on record: docs/rookie-roi-prediction-2026-08-26.md (b52c101)');
  console.log('  MIN_BF=' + MIN_BF + '   rookie = as-of career IP < ' + ROOKIE_IP);
  console.log('  bar: CONFIRM if gap <= ' + BAR + 'pp AND CI excludes 0; REFUTE if CI excludes ' + BAR + 'pp');
  console.log('');

  // Clean corpus. loadGames already applies both contamination filters.
  const games = ps.loadGames(db, '2026-04-01', '2026-12-31');
  const regime = {};
  for (const g of games) regime[g.game_date + '|' + g.game_id] = g.park_factor_source || 'legacy_unsourced';
  const clean = new Set(Object.keys(regime));

  const legs = [['rookie', c => c.rookie], ['low_bf', c => c.low_bf], ['vet_callup', c => c.vet_callup]];

  // ---------------- LEG 1: ROI over emitted, graded signals ----------------
  const sigs = db.prepare(
    "SELECT game_date d, game_id gi, signal_type, signal_side, market_line, "
    + "bet_line, bet_price, outcome, pnl FROM bet_signals "
    + "WHERE outcome IN ('win','loss','push')").all();

  const rows = [];
  for (const s of sigs) {
    const key = s.d + '|' + s.gi;
    const c = cohorts.get(key);
    if (!c || !clean.has(key)) continue;      // uncohorted or contaminated
    const wag = s.outcome === 'push' ? 0 : wageredFor(s);
    if (!(wag > 0)) continue;
    rows.push({ d: s.d, type: s.signal_type, wag, pnl: Number(s.pnl) || 0, c, reg: regime[key] });
  }

  console.log('=== LEG 1 - ROI over EMITTED signals (measures SELECTION, not pricing) ===');
  console.log('  graded, staked signals on the clean cohort-eligible corpus: ' + rows.length);
  console.log('');
  for (const [name, pred] of legs) {
    const inC = rows.filter(r => pred(r.c)), out = rows.filter(r => !pred(r.c));
    if (inC.length < 10 || out.length < 10) { console.log('  ' + name + ': too few (' + inC.length + ')'); continue; }
    const rIn = roi(inC), rOut = roi(out), gap = rIn - rOut;
    const ciIn = clusteredCI(inC, roi, 11);
    const tagged = rows.map(r => ({ ...r, inC: pred(r.c) }));
    const ciGap = clusteredCI(tagged, a => {
      const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
      const ri = roi(i), ro = roi(o);
      return (ri != null && ro != null) ? ri - ro : null;
    }, 23);
    let verdict = 'INCONCLUSIVE';
    if (ciGap[0] != null) {
      if (gap <= BAR && ciGap[1] < 0) verdict = 'CONFIRMED';
      else if (ciGap[0] > BAR) verdict = 'REFUTED (a ' + BAR + 'pp effect is ruled out)';
    }
    console.log('  ' + name);
    console.log('    cohort   n=' + String(inC.length).padStart(4)
      + '  wagered ' + String(Math.round(inC.reduce((s, x) => s + x.wag, 0))).padStart(6)
      + '  pnl ' + String(Math.round(inC.reduce((s, x) => s + x.pnl, 0))).padStart(6)
      + '  ROI ' + f(rIn) + 'pp  ' + ci(ciIn));
    console.log('    rest     n=' + String(out.length).padStart(4)
      + '  ROI ' + f(rOut) + 'pp');
    console.log('    GAP (cohort - rest): ' + f(gap) + 'pp   95% CI ' + ci(ciGap));
    console.log('    -> ' + verdict);
    console.log('');
  }

  // SUPPLEMENTARY, not pre-registered. The pre-registered contrast is
  // cohort-vs-rest, and "rest" for the rookie leg still contains low_bf
  // and vet_callup games -- the cohorts nest. rookie-vs-established is the
  // disjoint contrast, reported alongside so the nesting is visible rather
  // than buried, and labelled so it is not read as the registered test.
  {
    const rk = rows.filter(r => r.c.rookie);
    const est = rows.filter(r => !r.c.rookie && !r.c.low_bf);
    if (rk.length > 10 && est.length > 10) {
      const g = roi(rk) - roi(est);
      const tagged = rows.filter(r => r.c.rookie || (!r.c.rookie && !r.c.low_bf))
        .map(r => ({ ...r, inC: r.c.rookie }));
      const c2 = clusteredCI(tagged, a => {
        const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
        const ri = roi(i), ro = roi(o);
        return (ri != null && ro != null) ? ri - ro : null;
      }, 29);
      console.log("  SUPPLEMENTARY (disjoint contrast, not the registered test):");
      console.log("    rookie n=" + rk.length + " ROI " + f(roi(rk)) + "pp  vs  established n="
        + est.length + " ROI " + f(roi(est)) + "pp   GAP " + f(g) + "pp  " + ci(c2));
      console.log("");
    }
  }

  // Composition check. A ROI gap between cohorts can be a difference in
  // WHICH BET TYPES got emitted rather than in how they settled, and the
  // types do not share a staking rule. Printed so the gap above is not
  // read as a settlement effect without checking the mix first.
  {
    const mix = {};
    for (const r of rows) {
      const k = (r.c.rookie ? "rookie" : "rest  ") + "  " + r.type;
      mix[k] = (mix[k] || 0) + 1;
    }
    console.log("  signal-type composition (rookie vs rest):");
    for (const k of Object.keys(mix).sort()) console.log("    " + k.padEnd(20) + mix[k]);
    console.log("");
  }

  // Resolvable effect size. Half-width of the registered CI, stated
  // BEFORE the verdicts are read, because a bar set inside the noise
  // floor cannot be confirmed no matter what the data does.
  {
    const tagged = rows.map(r => ({ ...r, inC: r.c.rookie }));
    const c2 = clusteredCI(tagged, a => {
      const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
      const ri = roi(i), ro = roi(o);
      return (ri != null && ro != null) ? ri - ro : null;
    }, 23);
    if (c2[0] != null) {
      const hw = (c2[1] - c2[0]) / 2;
      console.log("  RESOLUTION: the rookie GAP interval is +/-" + hw.toFixed(1)
        + "pp wide. The pre-registered bar is " + Math.abs(BAR) + "pp.");
      console.log("    " + (hw > Math.abs(BAR)
        ? "The bar sits INSIDE the noise floor -- neither verdict was reachable."
        : "The bar sits outside the noise floor -- the test could resolve it."));
      console.log("");
    }
  }

  // Regime split, reported and not pooled -- the boundary is 2026-08-25.
  console.log('  park-factor regime split (reported, not pooled):');
  const byReg = {};
  for (const r of rows) {
    const k = r.reg + '  ' + (r.c.rookie ? 'rookie' : 'rest');
    byReg[k] = byReg[k] || { n: 0, w: 0, p: 0 };
    byReg[k].n++; byReg[k].w += r.wag; byReg[k].p += r.pnl;
  }
  for (const k of Object.keys(byReg).sort()) {
    const b = byReg[k];
    console.log('    ' + k.padEnd(30) + 'n=' + String(b.n).padStart(4)
      + '  ROI ' + f(b.w > 0 ? 100 * b.p / b.w : null) + 'pp');
  }

  // ---------------- LEG 2: calibration over ALL scored games ----------------
  console.log('');
  console.log('=== LEG 2 - CALIBRATION over ALL scored games (the pricing leg) ===');
  const snap = new Map(), cal = [];
  const realLog = console.log; console.log = () => {};      // runModel is chatty
  for (const g of games) {
    const key = g.game_date + '|' + g.game_id;
    const c = cohorts.get(key);
    if (!c) continue;
    if (g.home_score == null || g.away_score == null || g.home_score === g.away_score) continue;
    if (g.market_home_ml == null || g.market_away_ml == null) continue;
    if (!snap.has(g.game_date)) snap.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = snap.get(g.game_date); if (!idx) continue;
    const pre = ps.preScreenGame(g, idx, settings); if (!pre) continue;
    const w = hi.populateCallerInputs ? hi.populateCallerInputs(pre, g, settings) : pre;
    let mr; try { mr = runModel(w || pre, idx, settings, 'opener_aware', true); } catch (e) { continue; }
    if (!mr || mr._suppressed || mr.adjHW == null) continue;
    const ph = impliedP(g.market_home_ml), pa = impliedP(g.market_away_ml);
    if (ph == null || pa == null || (ph + pa) <= 0) continue;
    cal.push({ d: g.game_date, y: g.home_score > g.away_score ? 1 : 0,
               p: clamp(mr.adjHW), mkt: clamp(ph / (ph + pa)), c });
  }
  console.log = realLog;
  console.log('  games scored: ' + cal.length);
  console.log('');
  console.log('  cohort         n     logLoss    d vs rest   95% CI                    edge slope   95% CI');
  for (const [name, pred] of legs) {
    const inC = cal.filter(x => pred(x.c)), out = cal.filter(x => !pred(x.c));
    if (inC.length < 30 || out.length < 30) { console.log('  ' + name.padEnd(13) + ' too few'); continue; }
    const d = logLoss(inC) - logLoss(out);
    const ciD = clusteredCI(cal.map(x => ({ ...x, inC: pred(x.c) })), a => {
      const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
      return (i.length > 5 && o.length > 5) ? logLoss(i) - logLoss(o) : null;
    }, 37);
    console.log('  ' + name.padEnd(13) + String(inC.length).padStart(5)
      + '   ' + logLoss(inC).toFixed(5)
      + '   ' + f(d, 5).padStart(9)
      + '   ' + ci(ciD, 5).padEnd(24)
      + '   ' + f(edgeSlope(inC), 3).padStart(7)
      + '   ' + ci(clusteredCI(inC, edgeSlope, 41), 3));
  }
  const base = cal.filter(x => !x.c.rookie);
  console.log('');
  console.log('  reference: rest-of-corpus log loss ' + (base.length ? logLoss(base).toFixed(5) : 'n/a')
    + ', edge slope ' + f(edgeSlope(base), 3));
})();
