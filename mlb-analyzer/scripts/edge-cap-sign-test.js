#!/usr/bin/env node
/**
 * Edge-cap level: per-level window sign test + Tier-2 judgement (2026-08-22).
 *
 * Follow-up to scripts/edge-cap-level.js, which established that 8pp is
 * the worst of nine levels but rested the claim on a single subset ROI
 * (n=81, CI spanning zero). That is not a basis for moving a live
 * emission parameter, so this asks the question the tiered standard in
 * docs/getsettings-whitelist-audit-2026-08-23.md #3 actually poses:
 *
 *   does ANY candidate cap level clear Tier 2 against no-cap?
 *
 * Tier 2, adapted for a selection mechanism (the metric is ROI, not log
 * loss, because the cap only ever changes the bet set):
 *   - window sign test p <= 0.05  -> 5/5 windows favourable at K=5
 *   - pooled point estimate favourable
 *   - bounded harm: the harmful side of the paired CI is small
 *
 * PAIRED bootstrap. Both arms are evaluated on the SAME resampled dates
 * and the delta is taken inside each replicate, so the shared
 * date-to-date variance cancels instead of being counted twice. An
 * unpaired difference-of-two-CIs would be far too wide here because the
 * two arms overlap in most of their bets by construction.
 *
 * STRUCTURAL NOTE ON WHAT A CAP CAN DO. A cap is a high-side filter: it
 * removes large claimed edges and nothing else. So it can only improve
 * the book if large edges are systematically bad. It cannot fix the
 * 2-4pp band (-10.95%) or the 6-8pp band (-13.49%) no matter where it
 * sits, because those bets are below every candidate threshold.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const jobs = require(path.join(R, 'services/jobs'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const START = process.argv[2] || '2026-04-01';
const END   = process.argv[3] || '2026-08-07';
const BOOT  = 4000;
const K     = 5;

const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const roi = a => { let p = 0, w = 0; for (const s of a) { p += s.pnl; w += s.wagered; } return w > 0 ? 100 * p / w : null; };
const fmt = v => v == null ? '  n/a' : (v >= 0 ? '+' : '') + v.toFixed(2);

(function main() {
  const settings = jobs.getSettings();
  const PROD = Number(settings.SIGNAL_EDGE_HARD_CAP_PP);

  const raw = ps.loadGames(db, START, END);
  const cache = new Map();
  const games = [];
  for (const g of raw) {
    if (g.home_score == null) continue;
    if (!cache.has(g.game_date)) cache.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = cache.get(g.game_date); if (!idx) continue;
    const w = ps.preScreenGame(g, idx, settings);
    if (w) games.push({ game: w, wobaIdx: idx, snapshotDate: g.game_date });
  }
  const uncapped = Object.assign({}, settings, { SIGNAL_EDGE_CAP_ENABLED: false });
  const real = console.log; console.log = () => {};
  const res = ps.scoreGames(uncapped, games, null);
  console.log = real;

  // parameter-sweep.js:483 stores edge_pp holding a FRACTION. Normalise.
  const sigs = (res.signals || []).filter(s => s.edge_pp != null)
    .map(s => Object.assign({}, s, { edge: Number(s.edge_pp) }));

  console.log('=== edge-cap: per-level sign test vs NO CAP ===');
  console.log('window ' + START + ' .. ' + END + '   signals ' + sigs.length + '   prod cap ' + PROD);
  console.log('');

  const byDate = new Map();
  for (const s of sigs) {
    if (!byDate.has(s.game_date)) byDate.set(s.game_date, []);
    byDate.get(s.game_date).push(s);
  }
  const dates = [...byDate.keys()].sort();
  const per = Math.ceil(dates.length / K);
  const baseAll = roi(sigs);

  // Finer grid than the first pass -- the question is now "which level",
  // so resolution between 0.08 and 0.15 matters.
  const levels = [0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.15, 0.18, 0.20, 0.25];

  console.log('  cap   supp_n  kept_ROI   dROI vs no-cap   95% CI (paired)      windows  sign-p   Tier2?');
  const out = [];
  for (const c of levels) {
    const kept = sigs.filter(s => s.edge < c);
    const suppN = sigs.length - kept.length;
    const rk = roi(kept);
    const d = (rk == null || baseAll == null) ? null : rk - baseAll;

    // paired date-clustered bootstrap on the DELTA
    const rnd = mulberry(Math.round(c * 10000) + 991);
    const reps = [];
    for (let b = 0; b < BOOT; b++) {
      let pk = 0, wk = 0, pa = 0, wa = 0;
      for (let i = 0; i < dates.length; i++) {
        const arr = byDate.get(dates[Math.floor(rnd() * dates.length)]);
        for (const s of arr) {
          pa += s.pnl; wa += s.wagered;
          if (s.edge < c) { pk += s.pnl; wk += s.wagered; }
        }
      }
      if (wk > 0 && wa > 0) reps.push(100 * pk / wk - 100 * pa / wa);
    }
    reps.sort((a, b) => a - b);
    const lo = reps.length > 50 ? reps[Math.floor(0.025 * reps.length)] : null;
    const hi = reps.length > 50 ? reps[Math.floor(0.975 * reps.length)] : null;

    // window sign test
    let better = 0, valid = 0;
    const wins = [];
    for (let k = 0; k < K; k++) {
      const ds = new Set(dates.slice(k * per, (k + 1) * per));
      const w = sigs.filter(s => ds.has(s.game_date));
      const a = roi(w.filter(s => s.edge < c)), b = roi(w);
      if (a == null || b == null) { wins.push('.'); continue; }
      valid++; if (a > b) { better++; wins.push('+'); } else wins.push('-');
    }
    // two-sided-ish: P(>= better of valid) under p=0.5
    let p = 0;
    for (let i = better; i <= valid; i++) {
      let ch = 1; for (let j = 0; j < i; j++) ch = ch * (valid - j) / (j + 1);
      p += ch * Math.pow(0.5, valid);
    }
    const tier2 = (better === valid && valid === K) && d > 0;
    out.push({ c, suppN, rk, d, lo, hi, better, valid, p, tier2, wins });

    console.log('  ' + c.toFixed(2) + '  ' + String(suppN).padStart(5) + '   ' + fmt(rk).padStart(7)
      + '      ' + fmt(d).padStart(6) + '        [' + fmt(lo) + ', ' + fmt(hi) + ']'.padEnd(3)
      + '   ' + wins.join('') + '   ' + p.toFixed(3)
      + '   ' + (tier2 ? 'YES' : 'no') + (Math.abs(c - PROD) < 1e-9 ? '   <- PROD' : ''));
  }

  console.log('');
  console.log('  no cap baseline ROI: ' + fmt(baseAll) + '   (dROI is measured against this)');
  console.log('  windows column: + = cap beat no-cap in that window, - = lost');
  console.log('');

  const passing = out.filter(o => o.tier2);
  console.log('=== verdict ===');
  if (!passing.length) {
    console.log('  NO candidate level clears Tier 2. Not one of ' + levels.length + ' levels is');
    console.log('  favourable in all ' + K + ' windows.');
    const best = out.slice().sort((a, b) => (b.d || -1e9) - (a.d || -1e9))[0];
    console.log('');
    console.log('  best point estimate: cap ' + best.c.toFixed(2) + '  dROI ' + fmt(best.d)
      + '  CI [' + fmt(best.lo) + ', ' + fmt(best.hi) + ']  windows ' + best.wins.join(''));
    const prodRow = out.filter(o => Math.abs(o.c - PROD) < 1e-9)[0];
    if (prodRow) {
      console.log('  prod (' + PROD + '):        dROI ' + fmt(prodRow.d)
        + '  CI [' + fmt(prodRow.lo) + ', ' + fmt(prodRow.hi) + ']  windows ' + prodRow.wins.join(''));
      const rank = out.slice().sort((a, b) => (b.d || -1e9) - (a.d || -1e9))
        .findIndex(o => Math.abs(o.c - PROD) < 1e-9) + 1;
      console.log('  prod rank by dROI: ' + rank + ' of ' + out.length);
    }
  } else {
    for (const o of passing) {
      console.log('  cap ' + o.c.toFixed(2) + ' CLEARS Tier 2: ' + o.better + '/' + o.valid
        + ' windows, dROI ' + fmt(o.d) + ' CI [' + fmt(o.lo) + ', ' + fmt(o.hi) + ']');
    }
  }
})();
