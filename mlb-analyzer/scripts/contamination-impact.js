#!/usr/bin/env node
/**
 * What did excluding post-first-pitch-priced games actually change? (2026-08-23)
 *
 * THE PROBLEM WITH A SIMPLE BEFORE/AFTER. Excluding 15.3% of games costs
 * power everywhere. A wider CI after exclusion proves nothing on its own --
 * that is what dropping 131 games does regardless of which 131.
 *
 * THREE ARMS, so the two effects separate:
 *   A  full corpus (859)          -- contaminated, the original
 *   B  clean corpus (728)         -- contamination excluded
 *   C  n-matched control (728)    -- RANDOM 728 drawn from A, contamination
 *                                    RETAINED, repeated over many seeds
 *
 * C is the null distribution for "what does merely dropping to n=728 do".
 * If B lands INSIDE C's spread, the movement is a power effect. If B lands
 * OUTSIDE it, the movement is the contamination. A before/after alone
 * cannot tell those apart and would attribute both to contamination.
 *
 * ONE SCORING PASS. A game's model prediction does not depend on which arm
 * it sits in, so the full corpus is scored once and each arm is a re-slice.
 * That makes a 20-seed control affordable; scoring per arm would not be.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel, impliedP } = require(path.join(R, 'services/model'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-07';
const SEEDS = 20;
const BOOT = 2000;
const EPS = 1e-9;

const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });
const clamp = q => Math.min(1 - EPS, Math.max(EPS, q));

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const ll = rows => { let s = 0; for (const r of rows) s += -(r.y * Math.log(clamp(r.p)) + (1 - r.y) * Math.log(1 - clamp(r.p))); return s / rows.length; };
const llMkt = rows => { let s = 0; for (const r of rows) s += -(r.y * Math.log(clamp(r.mkt)) + (1 - r.y) * Math.log(1 - clamp(r.mkt))); return s / rows.length; };
const baseLL = rows => { const b = rows.reduce((a, r) => a + r.y, 0) / rows.length; let s = 0; for (const r of rows) s += -(r.y * Math.log(clamp(b)) + (1 - r.y) * Math.log(1 - clamp(b))); return s / rows.length; };

// Slope of realised edge on claimed edge. 1.0 = perfectly honest.
function edgeSlope(rows) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const r of rows) {
    const x = r.p - r.mkt;            // claimed edge
    const y = r.y - r.mkt;            // realised edge
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  const d = n * sxx - sx * sx;
  return d === 0 ? null : (n * sxy - sx * sy) / d;
}

// Date-clustered bootstrap on a scalar statistic of the row set.
function clusteredCI(rows, stat, seed) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.d)) byDate.set(r.d, []); byDate.get(r.d).push(r); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < n; i++) { const arr = byDate.get(dates[Math.floor(rnd() * n)]); for (const r of arr) s.push(r); }
    if (s.length) { const v = stat(s); if (v != null && isFinite(v)) out.push(v); }
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}

const f5 = v => v == null ? '  n/a  ' : (v >= 0 ? '+' : '') + v.toFixed(5);
const f3 = v => v == null ? ' n/a ' : (v >= 0 ? '+' : '') + v.toFixed(3);

(function main() {
  const settings = jobs.getSettings();
  console.log('=== contamination impact: market-vs-model and edge honesty ===');
  console.log('  window ' + FROM + ' .. ' + TO);

  // ---- score the FULL corpus once
  const all = ps.loadGames(db, FROM, TO, { includeMarketContaminated: true });
  const cache = new Map();
  const rows = [];
  const real = console.log; console.log = () => {};
  for (const g of all) {
    if (g.home_score == null || g.away_score == null) continue;
    if (g.market_home_ml == null || g.market_away_ml == null) continue;
    if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = cache.get(g.game_date); if (!idx) continue;
    const w = hi.populateCallerInputs(ps.preScreenGame(g, idx, settings), g, settings);
    if (!w) continue;
    const mr = runModel(w, idx, settings, 'opener_aware', true);
    if (!mr || mr._suppressed || mr.adjHW == null) continue;
    const ph = impliedP(g.market_home_ml), pa = impliedP(g.market_away_ml);
    if (ph == null || pa == null || (ph + pa) <= 0) continue;
    rows.push({
      d: g.game_date, y: g.home_score > g.away_score ? 1 : 0,
      p: clamp(mr.adjHW), mkt: clamp(ph / (ph + pa)),
      dirty: !!g.market_contamination_reason,
    });
  }
  console.log = real;

  const A = rows;
  const B = rows.filter(r => !r.dirty);
  console.log('  scored: A(full)=' + A.length + '   B(clean)=' + B.length
    + '   excluded=' + (A.length - B.length)
    + '  (' + (100 * (A.length - B.length) / A.length).toFixed(1) + '%)');
  console.log('');

  const metrics = [
    { k: 'model logLoss', f: ll },
    { k: 'market logLoss', f: llMkt },
    { k: 'base-rate logLoss', f: baseLL },
    { k: 'model - market', f: r => ll(r) - llMkt(r) },
    { k: 'model - base', f: r => ll(r) - baseLL(r) },
    { k: 'edge slope (ML)', f: edgeSlope },
  ];

  // ---- C: n-matched control over many seeds
  const ctrl = {};
  for (const m of metrics) ctrl[m.k] = [];
  for (let s = 0; s < SEEDS; s++) {
    const sub = ps.sampleGames(A, B.length, 1000 + s * 7919);
    for (const m of metrics) { const v = m.f(sub); if (v != null && isFinite(v)) ctrl[m.k].push(v); }
  }

  console.log('=== A (contaminated, n=' + A.length + ')  vs  B (clean, n=' + B.length + ') ===');
  console.log('  metric               A          B          B-A        C control p5..p95        verdict');
  for (const m of metrics) {
    const a = m.f(A), b = m.f(B);
    const c = ctrl[m.k].slice().sort((x, y) => x - y);
    const lo = c[Math.floor(0.05 * c.length)], hiV = c[Math.floor(0.95 * c.length)];
    const inside = (b >= lo && b <= hiV);
    console.log('  ' + m.k.padEnd(20)
      + f5(a) + '  ' + f5(b) + '  ' + f5(b - a) + '   ['
      + f5(lo) + ', ' + f5(hiV) + ']   '
      + (inside ? 'POWER (inside control)' : '*** CONTAMINATION ***'));
  }
  console.log('');
  console.log('  C = 20 random n-matched subsamples of A with contamination RETAINED.');
  console.log('  B inside C p5..p95 => the move is what dropping to n=' + B.length + ' does anyway.');
  console.log('  B outside => the move is attributable to removing the contaminated rows.');
  console.log('');

  // ---- SIGNIFICANCE RETENTION under the n-matched control.
  //
  // The component diagnostic flipped "market beats the base rate" from
  // significant to not. A point estimate moving is one question; a CI
  // crossing zero is another, and dropping 128 games widens every CI
  // regardless of which games. So: in the control subsamples -- same n,
  // contamination RETAINED -- how often does the claim survive at all?
  // If it dies most of the time at n=662 anyway, the flip is power.
  console.log('=== significance retention at n=' + B.length + ' (control, contamination RETAINED) ===');
  const claims = [
    { k: 'market beats base rate', stat: r => llMkt(r) - baseLL(r), sig: ci => ci[1] != null && ci[1] < 0 },
    { k: 'model beats base rate',  stat: r => ll(r) - baseLL(r),    sig: ci => ci[1] != null && ci[1] < 0 },
    { k: 'model worse than market',stat: r => ll(r) - llMkt(r),     sig: ci => ci[0] != null && ci[0] > 0 },
  ];
  for (const c of claims) {
    const ciA = clusteredCI(A, c.stat, 7777);
    const ciB = clusteredCI(B, c.stat, 7777);
    let held = 0;
    for (let s = 0; s < SEEDS; s++) {
      const sub = ps.sampleGames(A, B.length, 1000 + s * 7919);
      if (c.sig(clusteredCI(sub, c.stat, 7777))) held++;
    }
    console.log('  ' + c.k.padEnd(24)
      + ' A(n=' + A.length + '): ' + (c.sig(ciA) ? 'SIGNIFICANT' : 'not sig    ')
      + '   B(n=' + B.length + '): ' + (c.sig(ciB) ? 'SIGNIFICANT' : 'not sig    ')
      + '   control holds ' + held + '/' + SEEDS + ' at same n');
  }
  console.log('');
  console.log('  A claim that survives in only a minority of same-n CONTAMINATED');
  console.log('  subsamples was never robust to n; losing it on the clean corpus is');
  console.log('  a power effect, not evidence the contamination was propping it up.');
  console.log('');

  console.log('=== CIs on the headline comparisons (date-clustered, B=' + BOOT + ') ===');
  for (const [label, arm] of [['A contaminated', A], ['B clean', B]]) {
    const g = ll(arm) - llMkt(arm);
    const gc = clusteredCI(arm, r => ll(r) - llMkt(r), 4242);
    const bb = ll(arm) - baseLL(arm);
    const bc = clusteredCI(arm, r => ll(r) - baseLL(r), 5353);
    const es = edgeSlope(arm);
    const ec = clusteredCI(arm, edgeSlope, 6464);
    console.log('  ' + label);
    console.log('    model - market : ' + f5(g) + '  [' + f5(gc[0]) + ', ' + f5(gc[1]) + ']'
      + (gc[0] != null && gc[0] > 0 ? '   model WORSE, significant' : '   not significant'));
    console.log('    model - base   : ' + f5(bb) + '  [' + f5(bc[0]) + ', ' + f5(bc[1]) + ']'
      + (bc[1] != null && bc[1] < 0 ? '   model BETTER, significant' : '   not significant'));
    console.log('    edge slope     : ' + f3(es) + '  [' + f3(ec[0]) + ', ' + f3(ec[1]) + ']'
      + (ec[1] != null && ec[1] < 1 ? '   excludes 1.0 (dishonest)' : '   does not exclude 1.0'));
  }
})();
