#!/usr/bin/env node
/**
 * What did excluding contaminated games actually change?
 * (2026-08-23; CORRECTED AND EXTENDED 2026-08-24)
 *
 * THE PROBLEM WITH A SIMPLE BEFORE/AFTER. Excluding a large slice of games
 * costs power everywhere. A wider CI after exclusion proves nothing on its
 * own -- that is what dropping N games does regardless of which N.
 *
 * THREE ARMS, so the two effects separate:
 *   A  FULL corpus     -- both contamination classes RETAINED
 *   B  clean corpus    -- both classes excluded
 *   C  n-matched ctrl  -- RANDOM |B| drawn from A, contamination RETAINED,
 *                         repeated over many seeds
 *
 * C is the null distribution for "what does merely dropping to n=|B| do".
 * If B lands INSIDE C's spread the movement is a power effect; OUTSIDE, it
 * is the contamination. A before/after alone cannot tell those apart and
 * would attribute both to contamination.
 *
 * WHY THIS WAS RE-RUN (2026-08-24). The 2026-08-23 version was measured
 * against a database in which only 27 games carried a weather-contamination
 * tag. The corrected corpus has 797. Worse, loadGames filtered weather
 * UNCONDITIONALLY, so arm A -- the arm labelled "full, contaminated" -- had
 * already had one contamination class silently removed, and ~770 known-bad-
 * weather games sat in BOTH arms. Neither the exclusion cost nor the
 * contamination effect could be bounded by that design.
 *
 *   exclusion measured on 2026-08-23 :  128 games,  16.2%
 *   exclusion on the corrected corpus:  492 games,  56.4%   (same window)
 *
 * FOUR ARMS NOW, because there are two contamination classes and only one
 * was ever measured. Each partial arm gets its own n-matched control:
 *   B_all      both excluded            <- the production filter
 *   B_market   post-first-pitch only    <- what 2026-08-23 believed it ran
 *   B_weather  known-bad weather only   <- the newly visible 770
 * The decomposition is the point: it says whether the weather class, which
 * was invisible last time, moves anything on its own.
 *
 * ONE SCORING PASS. A game's model prediction does not depend on which arm
 * it sits in, so the full corpus is scored once and each arm is a re-slice.
 * That makes a 20-seed control per arm affordable; scoring per arm would not.
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

  // ---- score the FULL corpus once. BOTH classes retained -- see header;
  // omitting includeWeatherContaminated is what made the 2026-08-23 run
  // measure a "full" arm that had already been weather-filtered.
  const all = ps.loadGames(db, FROM, TO,
    { includeMarketContaminated: true, includeWeatherContaminated: true });
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
      dirtyMkt: !!g.market_contamination_reason,
      dirtyWx:  !!g.weather_contamination_reason,
    });
  }
  console.log = real;

  const A = rows;
  const B = rows.filter(r => !r.dirtyMkt && !r.dirtyWx);
  const Bm = rows.filter(r => !r.dirtyMkt);              // market class only
  const Bw = rows.filter(r => !r.dirtyWx);               // weather class only
  const pct = x => (100 * (A.length - x.length) / A.length).toFixed(1) + '%';
  console.log('  scored A (FULL, both classes retained) : ' + A.length);
  console.log('    market-contaminated in A            : ' + A.filter(r => r.dirtyMkt).length);
  console.log('    weather-contaminated in A           : ' + A.filter(r => r.dirtyWx).length);
  console.log('    BOTH classes on the same game       : ' + A.filter(r => r.dirtyMkt && r.dirtyWx).length);
  console.log('  B_all     both excluded  n=' + B.length + '   drops ' + pct(B));
  console.log('  B_market  market only    n=' + Bm.length + '   drops ' + pct(Bm));
  console.log('  B_weather weather only   n=' + Bw.length + '   drops ' + pct(Bw));
  console.log('');

  const metrics = [
    { k: 'model logLoss', f: ll },
    { k: 'market logLoss', f: llMkt },
    { k: 'base-rate logLoss', f: baseLL },
    { k: 'model - market', f: r => ll(r) - llMkt(r) },
    { k: 'model - base', f: r => ll(r) - baseLL(r) },
    { k: 'edge slope (ML)', f: edgeSlope },
  ];

  // ---- Each B arm gets its OWN n-matched control, because the arms have
  // different n and a control built for one does not bound another.
  function controlFor(target) {
    const c = {};
    for (const m of metrics) c[m.k] = [];
    for (let s = 0; s < SEEDS; s++) {
      const sub = ps.sampleGames(A, target.length, 1000 + s * 7919);
      for (const m of metrics) { const v = m.f(sub); if (v != null && isFinite(v)) c[m.k].push(v); }
    }
    return c;
  }

  const ARMS = [
    { key: 'B_all',     label: 'both classes excluded',       rows: B  },
    { key: 'B_market',  label: 'post-first-pitch only',       rows: Bm },
    { key: 'B_weather', label: 'known-bad weather only',      rows: Bw },
  ];

  for (const arm of ARMS) {
    const ctrl = controlFor(arm.rows);
    console.log('=== A (FULL, n=' + A.length + ')  vs  ' + arm.key
      + ' (' + arm.label + ', n=' + arm.rows.length + ') ===');
    console.log('  metric               A          B          B-A        C control p5..p95        verdict');
    for (const m of metrics) {
      const a = m.f(A), b = m.f(arm.rows);
      const c = ctrl[m.k].slice().sort((x, y) => x - y);
      const lo = c[Math.floor(0.05 * c.length)], hiV = c[Math.floor(0.95 * c.length)];
      const inside = (b >= lo && b <= hiV);
      console.log('  ' + m.k.padEnd(20)
        + f5(a) + '  ' + f5(b) + '  ' + f5(b - a) + '   ['
        + f5(lo) + ', ' + f5(hiV) + ']   '
        + (inside ? 'POWER (inside control)' : '*** CONTAMINATION ***'));
    }
    console.log('');
  }
  console.log('  C = ' + SEEDS + ' random n-matched subsamples of A, contamination RETAINED.');
  console.log('  B inside C p5..p95 => the move is what dropping to that n does anyway.');
  console.log('  B outside => the move is attributable to removing the contaminated rows.');
  console.log('');

  // ---- SIGNIFICANCE RETENTION under the n-matched control.
  //
  // A point estimate moving is one question; a CI crossing zero is another,
  // and dropping games widens every CI regardless of which games. So: in the
  // control subsamples -- same n, contamination RETAINED -- how often does
  // the claim survive at all? If it dies most of the time at that n anyway,
  // a flip on the clean corpus is power.
  const claims = [
    { k: 'market beats base rate', stat: r => llMkt(r) - baseLL(r), sig: ci => ci[1] != null && ci[1] < 0 },
    { k: 'model beats base rate',  stat: r => ll(r) - baseLL(r),    sig: ci => ci[1] != null && ci[1] < 0 },
    { k: 'model worse than market',stat: r => ll(r) - llMkt(r),     sig: ci => ci[0] != null && ci[0] > 0 },
  ];
  console.log('=== significance retention (control = same n, contamination RETAINED) ===');
  for (const c of claims) {
    const ciA = clusteredCI(A, c.stat, 7777);
    let line = '  ' + c.k.padEnd(24) + ' A(n=' + A.length + '): '
      + (c.sig(ciA) ? 'SIGNIFICANT' : 'not sig    ');
    for (const arm of ARMS) {
      const ciB = clusteredCI(arm.rows, c.stat, 7777);
      let held = 0;
      for (let s = 0; s < SEEDS; s++) {
        const sub = ps.sampleGames(A, arm.rows.length, 1000 + s * 7919);
        if (c.sig(clusteredCI(sub, c.stat, 7777))) held++;
      }
      line += '   | ' + arm.key + '(n=' + arm.rows.length + '): '
        + (c.sig(ciB) ? 'SIG    ' : 'not sig')
        + ' ctrl ' + String(held).padStart(2) + '/' + SEEDS;
    }
    console.log(line);
  }
  console.log('');
  console.log('  A claim that survives in only a minority of same-n CONTAMINATED');
  console.log('  subsamples was never robust to n; losing it on the clean corpus is');
  console.log('  a power effect, not evidence the contamination was propping it up.');
  console.log('');

  console.log('=== CIs on the headline comparisons (date-clustered, B=' + BOOT + ') ===');
  const armsForCI = [['A FULL (both retained)', A]].concat(
    ARMS.map(a => [a.key + ' (' + a.label + ')', a.rows]));
  for (const [label, arm] of armsForCI) {
    const g = ll(arm) - llMkt(arm);
    const gc = clusteredCI(arm, r => ll(r) - llMkt(r), 4242);
    const bb = ll(arm) - baseLL(arm);
    const bc = clusteredCI(arm, r => ll(r) - baseLL(r), 5353);
    const es = edgeSlope(arm);
    const ec = clusteredCI(arm, edgeSlope, 6464);
    console.log('  ' + label + '   n=' + arm.length);
    console.log('    model - market : ' + f5(g) + '  [' + f5(gc[0]) + ', ' + f5(gc[1]) + ']'
      + (gc[0] != null && gc[0] > 0 ? '   model WORSE, significant' : '   not significant'));
    console.log('    model - base   : ' + f5(bb) + '  [' + f5(bc[0]) + ', ' + f5(bc[1]) + ']'
      + (bc[1] != null && bc[1] < 0 ? '   model BETTER, significant' : '   not significant'));
    console.log('    edge slope     : ' + f3(es) + '  [' + f3(ec[0]) + ', ' + f3(ec[1]) + ']'
      + (ec[1] != null && ec[1] < 1 ? '   excludes 1.0 (dishonest)' : '   does not exclude 1.0'));
  }
})();
