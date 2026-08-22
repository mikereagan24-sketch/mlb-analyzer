'use strict';
// Does the DAY-BEFORE model beat the DAY-BEFORE market?
//
// docs/component-signal-diagnostic-2026-08-23.md scored the model at
// CLOSING state — final lineups, closing lines. That is not the state
// the operator bets in. Bets go in the day before, against projected
// lineups and early lines. This runs the same calibration on the
// projected state so the comparison matches how money is actually
// committed.
//
// Both states are read from PERSISTED columns, so no re-scoring is
// involved and the model state is the one that actually existed then:
//   projected:  proj_model_{home,away}_ml  vs  proj_market_{home,away}_ml
//   closing:    model_{home,away}_ml       vs  market_{home,away}_ml
//
// Model ML goes through rawToML + applySpread (FAV_ADJ/DOG_ADJ), so the
// two sides do NOT sum to 1. Both model and market are de-vigged from
// their own two sides, which recovers the model's implied probability
// net of its own padding and keeps model and market on one construction.
//
// *** SNAPSHOT ASYMMETRY — read before trusting the projected numbers ***
// services/jobs.js:966 writes proj_model_* unconditionally on every
// projected-lineup run (so it is the LAST projected model value) but
// writes proj_market_* through COALESCE (so it is the FIRST market seen
// while projected). The two are therefore NOT sampled at the same
// instant: the model gets a later, better-informed snapshot than the
// market it is scored against. If the market sharpens over the projected
// window, this asymmetry FLATTERS THE MODEL. Quantified in section 4.
//
// Run: <node20>/node.exe scripts/projected-vs-closing-calibration.js [from] [to]
const path = require('path');
const Database = require('better-sqlite3');

const FROM = process.argv[2] || '2026-05-01';
const TO = process.argv[3] || '2026-08-07';
const N_BOOT = 3000;
const EPS = 1e-9;

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });
let _s = 20260823;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const impl = (px) => px == null ? null : (px < 0 ? Math.abs(px) / (Math.abs(px) + 100) : 100 / (px + 100));
const clamp = (q) => Math.min(1 - EPS, Math.max(EPS, q));
const devig = (h, a) => {
  const ph = impl(h), pa = impl(a);
  if (ph == null || pa == null || (ph + pa) <= 0) return null;
  return clamp(ph / (ph + pa));
};

console.log('=== projected-state vs closing-state calibration ===');
console.log('  window ' + FROM + '..' + TO);
console.log('  all four series de-vigged from their own two sides');
console.log('');

const raw = db.prepare(
  "SELECT game_date, game_id, home_score, away_score, "
  + "proj_model_home_ml, proj_model_away_ml, proj_market_home_ml, proj_market_away_ml, "
  + "model_home_ml, model_away_ml, market_home_ml, market_away_ml "
  + "FROM game_log WHERE game_date >= ? AND game_date <= ? "
  + "AND home_score IS NOT NULL AND away_score IS NOT NULL "
  + "AND weather_contamination_reason IS NULL ORDER BY game_date, game_id"
).all(FROM, TO);

const rows = [];
for (const g of raw) {
  const pm = devig(g.proj_model_home_ml, g.proj_model_away_ml);
  const pk = devig(g.proj_market_home_ml, g.proj_market_away_ml);
  const cm = devig(g.model_home_ml, g.model_away_ml);
  const ck = devig(g.market_home_ml, g.market_away_ml);
  // Require ALL FOUR so both states are measured on an identical game set.
  if (pm == null || pk == null || cm == null || ck == null) continue;
  rows.push({ d: g.game_date, y: g.home_score > g.away_score ? 1 : 0, pm, pk, cm, ck });
}
console.log('=== corpus ===');
console.log('  games with all four series present: ' + rows.length + ' (of ' + raw.length + ' graded)');
const base = rows.reduce((a, r) => a + r.y, 0) / rows.length;
console.log('  home win rate: ' + (100 * base).toFixed(2) + '%');
console.log('  IDENTICAL game set for projected and closing — the only thing that differs is state');
console.log('');

const ll = (idxs, pick) => {
  let s = 0;
  for (const i of idxs) { const y = rows[i].y, q = clamp(pick(rows[i])); s += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); }
  return s / idxs.length;
};
const brier = (idxs, pick) => {
  let s = 0;
  for (const i of idxs) { const d = clamp(pick(rows[i])) - rows[i].y; s += d * d; }
  return s / idxs.length;
};
const auc = (pick) => {
  const pos = [], neg = [];
  for (const r of rows) (r.y ? pos : neg).push(pick(r));
  let c = 0;
  for (const a of pos) for (const b of neg) c += a > b ? 1 : a === b ? 0.5 : 0;
  return c / (pos.length * neg.length);
};
const ALL = rows.map((_, i) => i);
const byDate = new Map();
rows.forEach((r, i) => { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(i); });
const dates = [...byDate.keys()];
// Date-clustered bootstrap CI on a paired log-loss difference.
const diffCI = (pickA, pickB) => {
  const reps = [];
  for (let b = 0; b < N_BOOT; b++) {
    let sA = 0, sB = 0, n = 0;
    for (let k = 0; k < dates.length; k++) {
      for (const i of byDate.get(dates[Math.floor(rnd() * dates.length)])) {
        const y = rows[i].y, qa = clamp(pickA(rows[i])), qb = clamp(pickB(rows[i]));
        sA += -(y * Math.log(qa) + (1 - y) * Math.log(1 - qa));
        sB += -(y * Math.log(qb) + (1 - y) * Math.log(1 - qb));
        n++;
      }
    }
    if (n) reps.push(sA / n - sB / n);
  }
  reps.sort((a, b) => a - b);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
};
const f5 = (x) => (x >= 0 ? '+' : '') + x.toFixed(5);
const sig = (ci) => (ci.lo > 0 && ci.hi > 0) || (ci.lo < 0 && ci.hi < 0);

const P = {
  'proj model':   r => r.pm,
  'proj market':  r => r.pk,
  'close model':  r => r.cm,
  'close market': r => r.ck,
  'base rate':    () => base,
};

console.log('=== 1. absolute performance (lower log loss = better) ===');
console.log('  series           logLoss     Brier      AUC');
for (const [n, f] of Object.entries(P)) {
  console.log('  ' + n.padEnd(15) + ll(ALL, f).toFixed(5).padStart(9) + brier(ALL, f).toFixed(5).padStart(10)
    + (n === 'base rate' ? '        —' : auc(f).toFixed(4).padStart(9)));
}
console.log('');

console.log('=== 2. THE QUESTION: does the model beat the market, in each state? ===');
console.log('  comparison                      dLogLoss    95% CI                    ');
for (const [label, a, b] of [
  ['PROJECTED: model - market', P['proj model'], P['proj market']],
  ['CLOSING:   model - market', P['close model'], P['close market']],
]) {
  const d = ll(ALL, a) - ll(ALL, b), ci = diffCI(a, b);
  console.log('  ' + label.padEnd(30) + f5(d).padStart(10) + '   [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']  '
    + (sig(ci) ? (d < 0 ? '*** MODEL BEATS MARKET ***' : '*** model worse ***') : 'not significant'));
}
console.log('');
console.log('  vs the base rate:');
for (const [label, a] of [['proj model', P['proj model']], ['close model', P['close model']],
                          ['proj market', P['proj market']], ['close market', P['close market']]]) {
  const d = ll(ALL, a) - ll(ALL, P['base rate']), ci = diffCI(a, P['base rate']);
  console.log('  ' + (label + ' - base rate').padEnd(30) + f5(d).padStart(10) + '   [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']  '
    + (sig(ci) ? (d < 0 ? '*** better ***' : '*** worse ***') : 'not significant'));
}
console.log('');

console.log('=== 3. does the MARKET sharpen from projected to closing? ===');
{
  const d = ll(ALL, P['close market']) - ll(ALL, P['proj market']), ci = diffCI(P['close market'], P['proj market']);
  console.log('  close market - proj market   ' + f5(d) + '   [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']  '
    + (sig(ci) ? (d < 0 ? '*** market sharpens ***' : '*** market DEGRADES ***') : 'not significant'));
  const dm = ll(ALL, P['close model']) - ll(ALL, P['proj model']), cim = diffCI(P['close model'], P['proj model']);
  console.log('  close model  - proj model    ' + f5(dm) + '   [' + f5(cim.lo) + ', ' + f5(cim.hi) + ']  '
    + (sig(cim) ? (dm < 0 ? '*** model sharpens ***' : '*** model degrades ***') : 'not significant'));
  console.log('');
  console.log('  If the market sharpens while the model does not, betting early is');
  console.log('  betting into a softer line — which is the mechanism a positive CLV');
  console.log('  record would reflect.');
}
console.log('');

console.log('=== 4. SNAPSHOT ASYMMETRY — how much does it flatter the model? ===');
console.log('  proj_model_* is the LAST projected-lineup value; proj_market_* is the');
console.log('  FIRST market seen (COALESCE). They are not the same instant.');
{
  let moved = 0, sumAbs = 0;
  for (const r of rows) { const d = Math.abs(r.pk - r.ck); if (d > 0.005) moved++; sumAbs += d; }
  console.log('  |proj_market - close_market|: mean ' + (sumAbs / rows.length).toFixed(4)
    + '  moved >0.5pp on ' + moved + '/' + rows.length + ' games ('
    + (100 * moved / rows.length).toFixed(0) + '%)');
  let mm = 0, sm = 0;
  for (const r of rows) { const d = Math.abs(r.pm - r.cm); if (d > 0.005) mm++; sm += d; }
  console.log('  |proj_model  - close_model |: mean ' + (sm / rows.length).toFixed(4)
    + '  moved >0.5pp on ' + mm + '/' + rows.length + ' games ('
    + (100 * mm / rows.length).toFixed(0) + '%)');
  console.log('');
  console.log('  A LOWER-BOUND control: score the projected model against the CLOSING');
  console.log('  market. That removes the stale-market advantage entirely, so it');
  console.log('  brackets the true projected-state edge from below.');
  const d = ll(ALL, P['proj model']) - ll(ALL, P['close market']), ci = diffCI(P['proj model'], P['close market']);
  console.log('  proj model - CLOSE market    ' + f5(d) + '   [' + f5(ci.lo) + ', ' + f5(ci.hi) + ']  '
    + (sig(ci) ? (d < 0 ? '*** still beats ***' : '*** worse ***') : 'not significant'));
}
console.log('');

console.log('=== 5. edge slope by state (claimed vs realised) ===');
console.log('  slope 1.0 = claimed edge fully real | 0 = noise | <0 = backwards');
const slopeOf = (pm, pk) => {
  const xs = rows.map(r => pm(r) - pk(r)), ys = rows.map(r => r.y - pk(r));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let n = 0, dd = 0;
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); dd += (xs[i] - mx) ** 2; }
  return dd > 0 ? n / dd : null;
};
const slopeCI = (pm, pk) => {
  const reps = [];
  for (let b = 0; b < N_BOOT; b++) {
    const samp = [];
    for (let k = 0; k < dates.length; k++) for (const i of byDate.get(dates[Math.floor(rnd() * dates.length)])) samp.push(rows[i]);
    const xs = samp.map(r => pm(r) - pk(r)), ys = samp.map(r => r.y - pk(r));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let n = 0, dd = 0;
    for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); dd += (xs[i] - mx) ** 2; }
    if (dd > 0) reps.push(n / dd);
  }
  reps.sort((a, b) => a - b);
  return { lo: reps[Math.floor(0.025 * reps.length)], hi: reps[Math.floor(0.975 * reps.length)] };
};
for (const [label, pm, pk] of [
  ['PROJECTED (vs proj market)', P['proj model'], P['proj market']],
  ['CLOSING   (vs close market)', P['close model'], P['close market']],
]) {
  const s = slopeOf(pm, pk), ci = slopeCI(pm, pk);
  console.log('  ' + label.padEnd(30) + (s >= 0 ? '+' : '') + s.toFixed(3).padStart(7)
    + '   [' + ((ci.lo >= 0 ? '+' : '') + ci.lo.toFixed(3)) + ', ' + ((ci.hi >= 0 ? '+' : '') + ci.hi.toFixed(3)) + ']  '
    + (ci.lo > 0 ? '*** excludes 0 — edge is REAL ***' : ci.hi < 0 ? 'excludes 0 (backwards)' : 'spans 0')
    + (ci.hi < 1 ? ', excl 1.0' : ''));
}
