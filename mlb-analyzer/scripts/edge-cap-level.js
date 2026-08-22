#!/usr/bin/env node
/**
 * Edge-cap level analysis (2026-08-22).
 *
 * WHY ROI IS THE RIGHT INSTRUMENT HERE, unlike every other sweep.
 * -----------------------------------------------------------------
 * docs/sweep-selection-effect-2026-08-21.md establishes that ROI over
 * emitted signals measures WHICH BETS GET PLACED, not pricing, because
 * calcPnl never sees a model number. That makes ROI invalid for pricing
 * parameters (W_PIT, SP_WEIGHT, ...).
 *
 * The hard cap is not a pricing parameter. model.js:1546 does
 *   if (s.edge >= HARD) continue;
 * -- it SUPPRESSES the signal. Changing the cap changes exactly one
 * thing: the bet set. Selection IS the mechanism, so ROI measures the
 * intended effect directly. The caveat that invalidates other sweeps
 * does not apply.
 *
 * The open question is therefore not "is ROI valid" but "why 8pp".
 *
 * DESIGN. Score the corpus ONCE with the cap disabled, retaining every
 * signal. Any cap level is then a post-hoc filter over that fixed set,
 * so all levels are compared on an identical population -- no re-run
 * drift, and the suppressed population is directly observable.
 *
 * The decisive question a cap must answer:
 *   do the signals it throws away perform WORSE than the ones it keeps?
 * If not, the cap is discarding bets for no measured reason.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const jobs = require(path.join(R, 'services/jobs'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const START = process.argv[2] || '2026-04-01';
const END   = process.argv[3] || '2026-08-07';
const BOOT  = 2000;

const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Date-clustered bootstrap: resample DATES, not signals. Same-slate
// signals share market state and model version, so treating them as
// independent understates the interval.
function clusteredCI(sigs, seed) {
  if (!sigs.length) return [null, null];
  const byDate = new Map();
  for (const s of sigs) {
    if (!byDate.has(s.game_date)) byDate.set(s.game_date, []);
    byDate.get(s.game_date).push(s);
  }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    let pnl = 0, wag = 0;
    for (let i = 0; i < n; i++) {
      for (const s of byDate.get(dates[Math.floor(rnd() * n)])) { pnl += s.pnl; wag += s.wagered; }
    }
    if (wag > 0) out.push(100 * pnl / wag);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}

const roi = a => { let p = 0, w = 0; for (const s of a) { p += s.pnl; w += s.wagered; } return w > 0 ? 100 * p / w : null; };
const fmt = v => v == null ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(2);
const fmtCI = c => c[0] == null ? '' : '  [' + fmt(c[0]) + ', ' + fmt(c[1]) + ']';

(function main() {
  const settings = jobs.getSettings();
  console.log('=== edge-cap level analysis ===');
  console.log('window: ' + START + ' .. ' + END);
  console.log('prod: HARD=' + settings.SIGNAL_EDGE_HARD_CAP_PP + '  SOFT=' + settings.SIGNAL_EDGE_SOFT_CAP_PP + '  ENABLED=' + settings.SIGNAL_EDGE_CAP_ENABLED);
  console.log('code defaults (model.js:1541-43): SOFT=0.10  HARD=0.25');
  console.log('');

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

  // Score ONCE, cap disabled -> retains the full pre-cap population.
  const uncapped = Object.assign({}, settings, { SIGNAL_EDGE_CAP_ENABLED: false });
  const real = console.log; console.log = () => {};
  const res = ps.scoreGames(uncapped, games, null);
  console.log = real;

  // parameter-sweep.js:483 stores `edge_pp: Number(s.edge)` -- despite the
  // _pp suffix the value is a FRACTION (0.08 = 8pp). Normalise once here so
  // every comparison below is unambiguous; see the units note in the doc.
  const sigs = (res.signals || []).filter(s => s.edge_pp != null).map(s => Object.assign({}, s, { edge: Number(s.edge_pp) }));
  console.log('scoreable games: ' + games.length + '   signals emitted with cap OFF: ' + sigs.length);
  console.log('');

  // --- 1. realized ROI by edge band (the shape the cap is supposed to exploit)
  console.log('=== 1. realized ROI by edge band (uncapped population) ===');
  console.log('  edge (pp)        n     ROI%          95% CI (date-clustered)');
  const bands = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10], [10, 15], [15, 25], [25, 1e9]];
  for (const b of bands) {
    const lo = b[0], hi = b[1];
    const a = sigs.filter(s => s.edge * 100 >= lo && s.edge * 100 < hi);
    const label = hi > 1e8 ? (lo + '+') : (lo + '-' + hi);
    if (!a.length) { console.log('  ' + label.padEnd(12) + '     0'); continue; }
    console.log('  ' + label.padEnd(12) + String(a.length).padStart(5) + '   ' + fmt(roi(a)).padStart(7) + fmtCI(clusteredCI(a, lo * 1000 + 7)));
  }
  console.log('');

  // --- 2. the decisive comparison: kept vs suppressed, at each candidate cap
  console.log('=== 2. at each candidate HARD cap: kept vs thrown away ===');
  console.log('  A cap is justified only if SUPPRESSED performs worse than KEPT.');
  console.log('');
  console.log('  cap     kept_n  kept_ROI                    supp_n supp_ROI                    delta');
  const levels = [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 999];
  const rows = [];
  for (const c of levels) {
    const kept = sigs.filter(s => s.edge < c), supp = sigs.filter(s => s.edge >= c);
    const rk = roi(kept), rs = roi(supp);
    rows.push({ c: c, kept: kept, supp: supp, rk: rk, rs: rs });
    const tag = Math.abs(c - Number(settings.SIGNAL_EDGE_HARD_CAP_PP)) < 1e-9 ? '  <- PROD' : (c === 999 ? '  (no cap)' : '');
    console.log('  ' + (c === 999 ? 'none' : c.toFixed(2)).padEnd(7)
      + String(kept.length).padStart(6) + '  ' + (fmt(rk).padStart(7) + fmtCI(clusteredCI(kept, Math.round(c * 1000) + 1))).padEnd(27)
      + String(supp.length).padStart(6) + ' ' + (fmt(rs).padStart(7) + fmtCI(clusteredCI(supp, Math.round(c * 1000) + 2))).padEnd(27)
      + (rk != null && rs != null ? fmt(rk - rs) : '   n/a') + tag);
  }
  console.log('');

  // --- 3. does the cap level change the bottom line at all?
  console.log('=== 3. overall book ROI as a function of cap level ===');
  console.log('  (kept-only ROI is the book you actually run)');
  const noCap = rows.filter(r => r.c === 999)[0];
  console.log('  cap     kept_n    ROI%     vs no-cap');
  for (const r of rows) {
    console.log('  ' + (r.c === 999 ? 'none' : r.c.toFixed(2)).padEnd(7) + String(r.kept.length).padStart(6)
      + '   ' + fmt(r.rk).padStart(7) + '   ' + (r.c === 999 ? '    --' : fmt(r.rk - noCap.rk).padStart(6))
      + (Math.abs(r.c - Number(settings.SIGNAL_EDGE_HARD_CAP_PP)) < 1e-9 ? '  <- PROD' : ''));
  }
  console.log('');

  // --- 4. sign test across windows for prod cap vs no cap
  const K = 5;
  const dates = [...new Set(sigs.map(s => s.game_date))].sort();
  const per = Math.ceil(dates.length / K);
  const PROD = Number(settings.SIGNAL_EDGE_HARD_CAP_PP);
  console.log('=== 4. window sign test: prod cap (' + PROD + ') vs no cap, K=' + K + ' ===');
  let better = 0, valid = 0;
  for (let k = 0; k < K; k++) {
    const ds = new Set(dates.slice(k * per, (k + 1) * per));
    const w = sigs.filter(s => ds.has(s.game_date));
    const a = roi(w.filter(s => s.edge < PROD)), b = roi(w);
    if (a == null || b == null) { console.log('  W' + (k + 1) + '  n/a'); continue; }
    valid++; if (a > b) better++;
    console.log('  W' + (k + 1) + ' ' + (a > b ? '+' : '-') + ' capped ' + fmt(a) + ' vs uncapped ' + fmt(b));
  }
  console.log('  cap better in ' + better + ' / ' + valid + ' windows');
  console.log('');
  console.log('NOTE: ROI is valid here because the cap only ever changes the bet');
  console.log('set. It remains invalid for any parameter that moves a price.');
})();
