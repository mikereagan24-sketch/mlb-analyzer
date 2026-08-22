'use strict';
// TWO-ARM CALIBRATION A/B for a boolean (or any) settings override.
//
// The companion to scripts/calibration-sweep.js. That one sweeps a
// numeric parameter across a grid; this one compares exactly two arms —
// the shape a feature FLAG needs.
//
// WHY THIS AND NOT AN ROI A/B. Per the 2026-08-21 rule, an ROI A/B
// measures SELECTION, not pricing: calcPnl never sees the model's
// numbers, so a signal emitted on the same side under both arms has
// byte-identical pnl, and only composition can move the aggregate.
// Every historical feature A/B in this repo is ROI-based and therefore
// cannot establish that a feature prices better. This harness scores
// EVERY game under both arms on targets computed from the model's own
// probability, so composition cannot move anything:
//
//   log loss   primary
//   Brier      secondary
//   ECE        calibration error over deciles
//   AUC        scale-free ordering quality
//   edge slope realised excess regressed on claimed edge
//
// The game set is ASSERTED identical across arms — that assertion is
// the whole point, and it is the claim an ROI A/B cannot make.
//
// Usage:
//   node scripts/calibration-ab.js <SETTING_KEY> <offValue> <onValue> [from] [to]
//   node scripts/calibration-ab.js PARK_NEUTRAL_INPUTS_ENABLED false true
//
// Values are parsed as JSON when possible ("true"/"false"/"0.65"),
// otherwise passed through as strings.
const path = require('path');
const Database = require('better-sqlite3');
const ps = require('../services/parameter-sweep');
const { runModel, impliedP } = require('../services/model');
const jobs = require('../services/jobs');

const PARAM = process.argv[2] || 'PARK_NEUTRAL_INPUTS_ENABLED';
const parseVal = (v) => { try { return JSON.parse(v); } catch (e) { return v; } };
const OFF = process.argv[3] != null ? parseVal(process.argv[3]) : false;
const ON = process.argv[4] != null ? parseVal(process.argv[4]) : true;
const FROM = process.argv[5] || '2026-06-01';
const TO = process.argv[6] || '2026-08-07';
const N_BOOT = 3000, EPS = 1e-9;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

// Flags whose effect depends on a field the CALLER populates rather than
// anything runModel derives. If the harness does not fill these, the arms
// come out identical and the run reports a false negative — the most
// dangerous failure mode this script has. Extend this table when adding
// a flag of that shape.
const CALLER_POPULATED_INPUTS = {
  DEFENSE_FRV_ENABLED: ['awayFieldingRunsPerGame', 'homeFieldingRunsPerGame'],
  CATCHER_FRAMING_ENABLED: ['awayCatcherFramingRvPerGame', 'homeCatcherFramingRvPerGame'],
};
let frvForTeam = () => null;
try { ({ computeTeamFieldingRunsPerGame: frvForTeam } = require('../services/frv-backtest')); } catch (e) {}
const baseSettings = jobs.getSettings();

let _s = 20260823;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const clamp = (q) => Math.min(1 - EPS, Math.max(EPS, q));

console.log('=== calibration A/B: ' + PARAM + ' ===');
console.log('  arms: OFF=' + JSON.stringify(OFF) + '   ON=' + JSON.stringify(ON));
console.log('  window ' + FROM + '..' + TO + '   prod value=' + JSON.stringify(baseSettings[PARAM]));
console.log('  target: log loss / Brier / ECE / AUC over ALL games — no emit floor, no selection');
console.log('');

// ---- corpus --------------------------------------------------------
const games = ps.loadGames(db, FROM, TO);
const cache = new Map();
for (const g of games) if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
const rows = [];
let noSnap = 0, noScore = 0, noMkt = 0;
for (const g of games) {
  const idx = cache.get(g.game_date);
  if (!idx) { noSnap++; continue; }
  if (g.home_score == null || g.away_score == null) { noScore++; continue; }
  if (g.market_home_ml == null || g.market_away_ml == null) { noMkt++; continue; }
  const w = ps.preScreenGame(g, idx, baseSettings);
  if (!w) continue;
  // CALLER-COMPUTED INPUTS. runModel does NOT compute team FRV — it reads
  // game.{away,home}FieldingRunsPerGame, which services/jobs.js builds
  // before calling it. preScreenGame does not, so without this a
  // DEFENSE_FRV_ENABLED A/B silently produces IDENTICAL arms and reports a
  // false "flag is inert". Populate it the same way prod does.
  try {
    w.awayFieldingRunsPerGame = frvForTeam(g.away_team, g.away_lineup_json, baseSettings);
    w.homeFieldingRunsPerGame = frvForTeam(g.home_team, g.home_lineup_json, baseSettings);
  } catch (e) { /* leave null; the guard below reports it */ }
  const ph = impliedP(g.market_home_ml), pa = impliedP(g.market_away_ml);
  if (ph == null || pa == null || (ph + pa) <= 0) continue;
  rows.push({ g: w, idx, d: g.game_date, y: g.home_score > g.away_score ? 1 : 0, mkt: clamp(ph / (ph + pa)) });
}
console.log('=== corpus ===');
console.log('  usable: ' + rows.length + '  (no-snapshot ' + noSnap + ', no-score ' + noScore + ', no-market ' + noMkt + ')');
const base = rows.reduce((a, r) => a + r.y, 0) / rows.length;
console.log('  home win rate: ' + (100 * base).toFixed(2) + '%');
console.log('');

// ---- score both arms ------------------------------------------------
const realLog = console.log;
function scoreArm(value) {
  const st = Object.assign({}, baseSettings, { [PARAM]: value });
  const out = new Array(rows.length).fill(null);
  const t0 = Date.now();
  console.log = () => {};
  try {
    for (let i = 0; i < rows.length; i++) {
      const mr = runModel(rows[i].g, rows[i].idx, st, 'opener_aware', true);
      out[i] = (mr && !mr._suppressed && mr.adjHW != null && isFinite(mr.adjHW)) ? clamp(mr.adjHW) : null;
    }
  } finally { console.log = realLog; }
  process.stdout.write('  scored ' + PARAM + '=' + JSON.stringify(value)
    + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)' + String.fromCharCode(10));
  return out;
}
const pOff = scoreArm(OFF);
const pOn = scoreArm(ON);

// Identical game set across arms — the assertion an ROI A/B cannot make.
const keep = [];
for (let i = 0; i < rows.length; i++) if (pOff[i] != null && pOn[i] != null) keep.push(i);
console.log('');
console.log('  scored under BOTH arms: ' + keep.length + ' / ' + rows.length
  + '   dropped: ' + (rows.length - keep.length));
console.log('  ASSERTED identical game set — composition cannot move any number below');
// Guard against the false-negative class: if this flag depends on a
// caller-populated field and that field is null everywhere, the arms are
// identical for a harness reason, not a model reason.
const needs = CALLER_POPULATED_INPUTS[PARAM];
if (needs) {
  const missing = needs.filter(f => !rows.some(r => r.g[f] != null));
  if (missing.length) {
    console.log('');
    console.log('  *** HARNESS CANNOT TEST THIS FLAG ***');
    console.log('      ' + PARAM + ' reads caller-populated field(s) ' + needs.join(', ')
      + ', and ' + missing.join(', ') + ' is null on every game.');
    console.log('      Both arms will be identical for a HARNESS reason, not a model reason.');
    console.log('      Any "no effect" result below would be a false negative. Aborting.');
    process.exit(2);
  }
  const cov = needs.map(f => f + '=' + rows.filter(r => r.g[f] != null).length + '/' + rows.length).join('  ');
  console.log('  caller-populated inputs present: ' + cov);
}
// How often does the flag actually change the number?
let moved = 0, sumAbs = 0;
for (const i of keep) { const d = Math.abs(pOn[i] - pOff[i]); if (d > 1e-9) moved++; sumAbs += d; }
console.log('  games where the flag changes p(home): ' + moved + ' / ' + keep.length
  + ' (' + (100 * moved / keep.length).toFixed(1) + '%)   mean |Δp| = ' + (sumAbs / keep.length).toFixed(5));
if (!moved) {
  console.log('');
  console.log('  *** THE FLAG IS INERT ON THIS CORPUS — both arms produce identical');
  console.log('      probabilities. Nothing below can distinguish them. ***');
}
console.log('');

// ---- metrics --------------------------------------------------------
const ll = (idxs, p) => {
  let s = 0;
  for (const i of idxs) { const y = rows[i].y; s += -(y * Math.log(p[i]) + (1 - y) * Math.log(1 - p[i])); }
  return s / idxs.length;
};
const brier = (idxs, p) => {
  let s = 0;
  for (const i of idxs) { const d = p[i] - rows[i].y; s += d * d; }
  return s / idxs.length;
};
const ece = (idxs, p, B) => {
  B = B || 10;
  const c = new Array(B).fill(0), sp = new Array(B).fill(0), sy = new Array(B).fill(0);
  for (const i of idxs) { const b = Math.min(B - 1, Math.floor(p[i] * B)); c[b]++; sp[b] += p[i]; sy[b] += rows[i].y; }
  let e = 0;
  for (let b = 0; b < B; b++) if (c[b]) e += (c[b] / idxs.length) * Math.abs(sp[b] / c[b] - sy[b] / c[b]);
  return e;
};
const auc = (p) => {
  const pos = [], neg = [];
  for (const i of keep) (rows[i].y ? pos : neg).push(p[i]);
  let n = 0;
  for (const a of pos) for (const b of neg) n += a > b ? 1 : a === b ? 0.5 : 0;
  return n / (pos.length * neg.length);
};
const slope = (p) => {
  const xs = keep.map(i => p[i] - rows[i].mkt), ys = keep.map(i => rows[i].y - rows[i].mkt);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let n = 0, d = 0;
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d > 0 ? n / d : null;
};
const byDate = new Map();
for (const i of keep) { const d = rows[i].d; if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(i); }
const dates = [...byDate.keys()];
// Paired, date-clustered: same-slate games share market state.
const diffCI = (a, b) => {
  const reps = [];
  for (let k = 0; k < N_BOOT; k++) {
    let sa = 0, sb = 0, n = 0;
    for (let j = 0; j < dates.length; j++) {
      for (const i of byDate.get(dates[Math.floor(rnd() * dates.length)])) {
        const y = rows[i].y;
        sa += -(y * Math.log(a[i]) + (1 - y) * Math.log(1 - a[i]));
        sb += -(y * Math.log(b[i]) + (1 - y) * Math.log(1 - b[i]));
        n++;
      }
    }
    if (n) reps.push(sa / n - sb / n);
  }
  reps.sort((x, y) => x - y);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
};
const f5 = (x) => (x >= 0 ? '+' : '') + x.toFixed(5);
const constP = rows.map(() => base);

console.log('=== results (ALL games, identical set) ===');
console.log('  arm            logLoss     Brier      ECE      AUC     edgeSlope');
const show = (label, p) => console.log('  ' + label.padEnd(15) + ll(keep, p).toFixed(5).padStart(9)
  + brier(keep, p).toFixed(5).padStart(10) + ece(keep, p).toFixed(4).padStart(9)
  + auc(p).toFixed(4).padStart(9) + (slope(p) == null ? '   n/a' : ((slope(p) >= 0 ? '+' : '') + slope(p).toFixed(3)).padStart(11)));
show('OFF', pOff);
show('ON', pOn);
console.log('  ' + 'base rate'.padEnd(15) + ll(keep, constP).toFixed(5).padStart(9));
const mktLL = (() => {
  let s = 0;
  for (const i of keep) { const y = rows[i].y, q = rows[i].mkt; s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
  return s / keep.length;
})();
console.log('  ' + 'market'.padEnd(15) + mktLL.toFixed(5).padStart(9) + '   (reference ceiling)');
console.log('');

const dOn = ll(keep, pOn) - ll(keep, pOff);
const ciOn = diffCI(pOn, pOff);
const sig = (c) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
// ---------------------------------------------------------------------
// WINDOW SIGN TEST (2026-08-23)
//
// A CI excluding zero is not reachable in one season for effects of the
// size this model produces (~0.0005-0.001 log loss against SE ~0.0006-
// 0.001 — roughly 4x the data needed). A bar that cannot be met is a bar
// that guarantees permanent deferral.
//
// The sign test is the honest alternative: split the corpus into K
// non-overlapping chronological windows and ask only which arm wins each
// one. It DISCARDS MAGNITUDE, which is exactly where the noise lives, and
// under a null of no effect P(all K windows agree in one direction) =
// 0.5^K — so K=5 gives p=0.031 and K=4 gives p=0.0625, both reachable
// inside a single season.
//
// Caveat carried in the output: windows inside one season are not fully
// independent (same rosters, same model version, correlated market
// regime), so treat 0.5^K as a floor on the p-value, not an exact one.
const K = Number(process.env.SIGN_TEST_WINDOWS || 5);
{
  const ds = [...new Set(keep.map(i => rows[i].d))].sort();
  const wins = [];
  for (let w = 0; w < K; w++) {
    const lo = Math.floor(w * ds.length / K), hi = Math.floor((w + 1) * ds.length / K);
    const set = new Set(ds.slice(lo, hi));
    const idxs = keep.filter(i => set.has(rows[i].d));
    if (!idxs.length) { wins.push(null); continue; }
    wins.push(ll(idxs, pOn) - ll(idxs, pOff));   // negative = ON better
  }
  const valid = wins.filter(x => x != null);
  const nBetter = valid.filter(x => x < 0).length;
  const allSame = valid.length > 0 && (nBetter === valid.length || nBetter === 0);
  const pFloor = Math.pow(0.5, valid.length);
  console.log('=== window sign test (K=' + K + ') ===');
  console.log('  per-window d logLoss (negative = ON better):');
  console.log('   ' + wins.map((x, i) => 'W' + (i + 1) + ' ' + (x == null ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(5))).join('   '));
  console.log('  ON better in ' + nBetter + ' / ' + valid.length + ' windows'
    + (allSame ? '   *** UNANIMOUS (sign-test p <= ' + pFloor.toFixed(3) + ') ***' : '   (not unanimous)'));
  console.log('');
}

console.log('=== the question: does ON beat OFF? ===');
console.log('  d logLoss (ON - OFF) = ' + f5(dOn) + '   95% CI [' + f5(ciOn.lo) + ', ' + f5(ciOn.hi) + ']');
console.log('  -> ' + (sig(ciOn)
  ? (dOn < 0 ? '*** ON IS BETTER (significant) ***' : '*** ON IS WORSE (significant) ***')
  : 'NOT SIGNIFICANT — the flag is not distinguishable on this target'));
console.log('');
for (const [lab, p] of [['OFF', pOff], ['ON', pOn]]) {
  const d = ll(keep, p) - ll(keep, constP), ci = diffCI(p, constP);
  console.log('  ' + (lab + ' - base rate').padEnd(18) + f5(d) + '   [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']  '
    + (sig(ci) ? (d < 0 ? 'better than a constant' : 'WORSE than a constant') : 'not significant'));
}
