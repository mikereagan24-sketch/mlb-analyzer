#!/usr/bin/env node
/**
 * What effect size can a cohort of size n actually resolve? (2026-08-26)
 *
 * RUN THIS BEFORE WRITING A PRE-REGISTRATION, not after reading the
 * result. The rookie-ROI run (b52c101 / a9fbf43) set a 15pp confirmation
 * bar and then produced a +/-19.0pp interval, so neither verdict was
 * reachable on that leg regardless of what the data did. The bar was
 * decided before the test ran and nobody could tell, because nobody had
 * measured the floor.
 *
 * The floor is measurable, so measure it. Attach a number, not a comment.
 *
 *   node scripts/resolution-floor.js                    # the n-ladder
 *   node scripts/resolution-floor.js --n 128 --bar 15   # one proposed design
 *   node scripts/resolution-floor.js --calibration      # + the log-loss ladder
 *
 * METHOD. Two independent estimates, printed side by side because they
 * can disagree and the disagreement is informative:
 *
 *   CI half-width -- assign a random pseudo-cohort of size n, then run
 *     the SAME date-clustered bootstrap the real test runs, and record
 *     how wide its interval on the gap comes out. This is the number the
 *     pre-registered verdict rule actually consumes.
 *
 *   null spread -- the 2.5/97.5 quantiles of the gap itself across many
 *     random pseudo-cohorts of size n, with no effect present by
 *     construction. This is how far the statistic wanders on its own.
 *
 * A bar inside EITHER band is not a test. If the two disagree materially,
 * trust the wider one and say which was used.
 *
 * The pseudo-cohort is assigned at the GAME level, matching how real
 * cohorts here are defined (a rookie start is one game, not a date), while
 * the interval is still date-clustered, matching how the real test is
 * computed. Assigning by date instead would inflate the floor and make
 * every proposed design look unresolvable.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { wageredFor } = require(path.join(R, 'utils/wagered'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

function argOf(n, d) { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; }
const ONE_N = argOf('--n', null);
const BAR = argOf('--bar', 15);
const WITH_CAL = process.argv.includes('--calibration');
const BOOT = ONE_N ? 3000 : 1200;
const REPS = ONE_N ? 40 : 15;
const LADDER = [50, 75, 100, 128, 200, 300, 400, 600, 800];

function mulberry(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const roi = rows => { let w = 0, p = 0; for (const r of rows) { w += r.wag; p += r.pnl; } return w > 0 ? 100 * p / w : null; };
const logLoss = rows => { let s = 0; for (const r of rows) s += -(r.y * Math.log(r.p) + (1 - r.y) * Math.log(1 - r.p)); return rows.length ? s / rows.length : null; };

// Date-clustered bootstrap of a gap statistic over items already carrying
// an `inC` flag. Same resampling the real tests use.
function gapCI(items, gapOf, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it); }
  const dates = [...byDate.keys()], nD = dates.length, rnd = mulberry(seed), out = [];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < nD; i++) for (const x of byDate.get(dates[Math.floor(rnd() * nD)])) s.push(x);
    const v = gapOf(s); if (v != null && isFinite(v)) out.push(v);
  }
  if (out.length < 50) return null;
  out.sort((a, b) => a - b);
  return [q(out, 0.025), q(out, 0.975)];
}

// Assign a pseudo-cohort of ~n items at the GAME level and return the
// tagged array. Real cohort membership is per game, so several signals on
// one game move together -- reproduced here rather than sampling signals
// independently, which would understate the floor.
function tagPseudoCohort(items, n, rnd) {
  const byGame = new Map();
  for (const it of items) { if (!byGame.has(it.g)) byGame.set(it.g, []); byGame.get(it.g).push(it); }
  const games = [...byGame.keys()];
  for (let i = games.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = games[i]; games[i] = games[j]; games[j] = t; }
  const chosen = new Set();
  let got = 0;
  for (const g of games) { if (got >= n) break; chosen.add(g); got += byGame.get(g).length; }
  return { tagged: items.map(it => ({ ...it, inC: chosen.has(it.g) })), actual: got };
}

// The floor at one n: median CI half-width across REPS pseudo-cohorts,
// plus the spread of the null gap itself.
function floorAt(items, n, gapOf, seed) {
  const rnd = mulberry(seed);
  const halves = [], gaps = [];
  for (let r = 0; r < REPS; r++) {
    const { tagged } = tagPseudoCohort(items, n, rnd);
    const g = gapOf(tagged);
    if (g != null && isFinite(g)) gaps.push(g);
    const ci = gapCI(tagged, gapOf, (seed * 131 + r * 17) >>> 0);
    if (ci) halves.push((ci[1] - ci[0]) / 2);
  }
  // More pseudo-cohorts for the null spread -- it is cheap, no bootstrap.
  for (let r = 0; r < 400; r++) {
    const { tagged } = tagPseudoCohort(items, n, rnd);
    const g = gapOf(tagged);
    if (g != null && isFinite(g)) gaps.push(g);
  }
  halves.sort((a, b) => a - b); gaps.sort((a, b) => a - b);
  return {
    half: halves.length ? q(halves, 0.5) : null,
    nullLo: gaps.length ? q(gaps, 0.025) : null,
    nullHi: gaps.length ? q(gaps, 0.975) : null,
  };
}

const roiGap = a => {
  const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
  const ri = roi(i), ro = roi(o);
  return (ri != null && ro != null) ? ri - ro : null;
};
const llGap = a => {
  const i = a.filter(x => x.inC), o = a.filter(x => !x.inC);
  return (i.length > 5 && o.length > 5) ? logLoss(i) - logLoss(o) : null;
};

function loadRoiItems() {
  const clean = new Set(ps.loadGames(db, '2026-04-01', '2026-12-31')
    .map(g => g.game_date + '|' + g.game_id));
  const out = [];
  for (const s of db.prepare(
    "SELECT game_date d, game_id gi, signal_type, signal_side, market_line, bet_line, "
    + "bet_price, outcome, pnl FROM bet_signals WHERE outcome IN ('win','loss','push')").all()) {
    const key = s.d + '|' + s.gi;
    if (!clean.has(key)) continue;
    const wag = s.outcome === 'push' ? 0 : wageredFor(s);
    if (!(wag > 0)) continue;
    out.push({ d: s.d, g: key, wag, pnl: Number(s.pnl) || 0 });
  }
  return out;
}

function loadCalItems() {
  const hi = require(path.join(R, 'services/harness-inputs'));
  const jobs = require(path.join(R, 'services/jobs'));
  const { runModel, impliedP } = require(path.join(R, 'services/model'));
  const settings = jobs.getSettings();
  const EPS = 1e-9, clamp = x => Math.min(1 - EPS, Math.max(EPS, x));
  const snap = new Map(), out = [];
  const realLog = console.log; console.log = () => {};
  for (const g of ps.loadGames(db, '2026-04-01', '2026-12-31')) {
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
    out.push({ d: g.game_date, g: g.game_date + '|' + g.game_id,
               y: g.home_score > g.away_score ? 1 : 0, p: clamp(mr.adjHW) });
  }
  console.log = realLog;
  return out;
}

function report(label, items, gapOf, unit, dp, seed) {
  console.log('=== ' + label + ' ===');
  console.log('  population: ' + items.length + ' items across '
    + new Set(items.map(i => i.d)).size + ' dates');
  console.log('');
  if (ONE_N) {
    const f = floorAt(items, ONE_N, gapOf, seed);
    const wider = Math.max(f.half, Math.max(Math.abs(f.nullLo), Math.abs(f.nullHi)));
    console.log('  proposed cohort n = ' + ONE_N + ',  proposed bar = ' + BAR + unit);
    console.log('    CI half-width at this n : +/-' + f.half.toFixed(dp) + unit);
    console.log('    null gap spans          : [' + f.nullLo.toFixed(dp) + ', ' + f.nullHi.toFixed(dp) + ']' + unit);
    console.log('');
    console.log('  ' + (BAR >= wider
      ? 'RESOLVABLE. The bar sits outside the floor (' + wider.toFixed(dp) + unit + '). Proceed as a test.'
      : 'NOT RESOLVABLE. The bar (' + BAR + unit + ') sits INSIDE the floor ('
        + wider.toFixed(dp) + unit + ').'));
    if (BAR < wider) {
      console.log('    Either raise the bar above ' + wider.toFixed(dp) + unit
        + ', grow the cohort, or declare the run');
      console.log('    DESCRIPTIVE rather than a test -- in the pre-registration, before it runs.');
    }
    console.log('');
    return;
  }
  console.log('     n     CI half-width      null gap 95% span      smallest resolvable');
  for (const n of LADDER) {
    if (n > items.length * 0.7) continue;
    const f = floorAt(items, n, gapOf, seed + n);
    const wider = Math.max(f.half, Math.max(Math.abs(f.nullLo), Math.abs(f.nullHi)));
    console.log('  ' + String(n).padStart(4)
      + '     +/-' + f.half.toFixed(dp).padStart(7) + unit
      + '     [' + f.nullLo.toFixed(dp).padStart(7) + ', ' + f.nullHi.toFixed(dp).padStart(7) + ']' + unit
      + '     ' + wider.toFixed(dp).padStart(7) + unit);
  }
  console.log('');
}

(function main() {
  console.log('=== resolution floor: what a cohort of size n can actually resolve ===');
  console.log('  bootstrap ' + BOOT + ' x ' + REPS + ' pseudo-cohorts per n; game-level assignment,');
  console.log('  date-clustered intervals -- matching the real tests.');
  console.log('');
  report('ROI gap, percentage points (emitted signals, clean corpus)',
    loadRoiItems(), roiGap, 'pp', 1, 7);
  if (WITH_CAL) {
    report('log-loss gap (all scored games, clean corpus)',
      loadCalItems(), llGap, '', 5, 13);
  } else {
    console.log('  (--calibration adds the log-loss ladder; it re-runs the model and is slower)');
  }
})();
