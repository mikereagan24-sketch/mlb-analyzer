// Weight sensitivity — ANALYTIC transformations only.
//
// Honest scope note: a proper "sweep W_PIT from 0.30 to 0.50" requires
// re-running runModel with modified settings against time-honest input
// snapshots (batter/pitcher wOBA state as of each game_date, bullpen
// wOBA blend as of that date, etc.). Neither the input snapshots exist
// as a rewindable structure NOR does a stand-alone re-score harness
// exist. A minimal attempt confirmed runModel returns null when called
// with today's DB state on a mid-June game (missing bullpen wOBA blend
// data + SP forecast state produce early-exit).
//
// What CAN be measured analytically without re-running runModel:
//   1. PYTH_EXP — WP-compression proxy applied to stored model_line
//      (validated approach; used in strong-fav decomposition).
//   2. HFA_BOOST — home team WP includes HFA; can subtract-and-re-add
//      with different HFA values and get new model home_ml.
//   3. FAV_ADJ / DOG_ADJ — direct American-odds add/subtract on the
//      signal side depending on fav/dog category.
//   4. SIGNAL_EDGE_HARD_CAP_PP — already covered in strong-fav decomp;
//      re-report here for completeness.
//   5. SIGNAL_EMIT_FLOOR_PP — filter effect on kept-signals population.
//
// What CANNOT be measured this pass without runModel re-execution:
//   - W_PIT / W_BAT (deep in per-batter EW math)
//   - BAT_HAND_SP / BAT_HAND_RELIEF (per-batter EW math)
//   - W_PROJ / W_ACT (wOBA blend feeding EW)
//   - BULLPEN_W_PROJ / BULLPEN_W_ACT (bullpen wOBA blend feeding EW)
//   - PA weights (per-position PA scaling)
//   - SP_WEIGHT / RELIEF_WEIGHT (SP vs bullpen weighting in EW)
//
// These are flagged as REQUIRES_INFRASTRUCTURE in the output.

const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });

const OUT = path.join(__dirname, '..', 'docs', 'data');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const SNAP_TS = db.prepare("SELECT datetime('now') n").get().n + ' UTC';
console.log('DB snapshot: ' + SNAP_TS);

const V7_EXCL = "'2026-07-06','2026-07-07','2026-07-10','2026-07-11'";
const CORRUPT_SQL = "("
+ "(bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) OR "
+ "(bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) OR "
+ "(bs.market_line > 100 AND bs.closing_line < 0) OR "
+ "(bs.market_line < -100 AND bs.closing_line > 0)"
+ ")";

const impliedP = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
const pToML = p => {
  if (p >= 0.5) return -Math.round((p / (1 - p)) * 100);
  return Math.round(((1 - p) / p) * 100);
};

// Clean-graded ML rows with everything I need for analytic transforms
const rows = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, "
+ "  bs.market_line, bs.closing_line, bs.model_line, bs.outcome, "
+ "  bs.cohort, "
+ "  gl.model_away_ml AS gl_mdl_away, gl.model_home_ml AS gl_mdl_home "
+ "FROM bet_signals bs JOIN game_log gl "
+ "  ON gl.game_date = bs.game_date AND gl.game_id = bs.game_id "
+ "WHERE bs.signal_type = 'ML' AND bs.outcome IN ('win','loss','push') "
+ "  AND bs.closing_line IS NOT NULL AND bs.model_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-04-09' "
+ "  AND NOT (bs.cohort = 'v7' AND bs.game_date IN (" + V7_EXCL + ")) "
+ "  AND NOT " + CORRUPT_SQL
).all();

console.log('Clean-graded ML rows: ' + rows.length);

// Enrich
for (const r of rows) {
  r.side_is_home = r.signal_side === 'home';
  r.pnl_100 = r.outcome === 'push' ? 0 : (r.outcome === 'loss' ? -100 : (r.closing_line > 0 ? r.closing_line : 100));
  r.close_p = impliedP(r.closing_line);
  r.model_p_side = r.signal_side === 'home'
    ? impliedP(r.gl_mdl_home)
    : impliedP(r.gl_mdl_away);
  r.edge_base = Math.max(0, r.model_p_side - r.close_p) * 100;
}

// Split fit/validate: Apr-May fit (early), Jun-Jul validate (later)
const fit = rows.filter(r => r.game_date < '2026-06-01');
const val = rows.filter(r => r.game_date >= '2026-06-01');
console.log('Fit (Apr-May): n=' + fit.length + '  |  Validate (Jun-Jul): n=' + val.length);

// Reusable: given a re-computed model_p function (rowMap), compute
// signals that would emit at emit-floor, split them into edge bands,
// and report per-band and full-book ROI on 1-2pp separately.
function scoreWithTransform(pool, transformFn) {
  const kept = pool.map(r => ({ r, newP: transformFn(r) }))
    .map(x => {
      const edge = Math.max(0, x.newP - x.r.close_p) * 100;
      return { r: x.r, edge };
    })
    .filter(x => x.edge >= 1); // Emit floor at 1pp
  const bands = { '1-2':[], '2-3':[], '3-6':[], '6-10':[], '10+':[] };
  for (const x of kept) {
    const b = x.edge < 2 ? '1-2' : x.edge < 3 ? '2-3' : x.edge < 6 ? '3-6' : x.edge < 10 ? '6-10' : '10+';
    bands[b].push(x.r);
  }
  const bookN = kept.length;
  const bookPnl = kept.reduce((a,x) => a + x.r.pnl_100, 0);
  const bookRoi = bookN ? (bookPnl / (bookN * 100)) * 100 : 0;
  const band12 = bands['1-2'];
  const roi12 = band12.length ? (band12.reduce((a,x)=>a+x.pnl_100,0) / (band12.length * 100)) * 100 : 0;
  return { book_n: bookN, book_pnl: bookPnl, book_roi: bookRoi, band12_n: band12.length, band12_roi: roi12, bands };
}

// Baseline: no transform (current settings)
const baseFit = scoreWithTransform(fit, r => r.model_p_side);
const baseVal = scoreWithTransform(val, r => r.model_p_side);
console.log('\n=== BASELINE (no transform) ===');
console.log('  Fit: n=' + baseFit.book_n + ' ROI=' + baseFit.book_roi.toFixed(2) + '%  1-2pp: n=' + baseFit.band12_n + ' ROI=' + baseFit.band12_roi.toFixed(2) + '%');
console.log('  Val: n=' + baseVal.book_n + ' ROI=' + baseVal.book_roi.toFixed(2) + '%  1-2pp: n=' + baseVal.band12_n + ' ROI=' + baseVal.band12_roi.toFixed(2) + '%');

// ---- SWEEP 1: PYTH_EXP (via WP compression) ----
console.log('\n=== SENSITIVITY SWEEP 1: PYTH_EXP (WP compression proxy) ===');
console.log('  Compression 0 = current pyth_exp=1.83');
console.log('  compression | Fit book n / ROI | 1-2pp Fit n / ROI | Val book n / ROI | 1-2pp Val n / ROI');
const compressions = [0, 0.05, 0.10, 0.15, 0.20, 0.25];
const pythLines = ['# PYTH_EXP compression sensitivity'];
pythLines.push(['compression','fit_book_n','fit_book_roi','fit_12_n','fit_12_roi','val_book_n','val_book_roi','val_12_n','val_12_roi'].join('\t'));
for (const c of compressions) {
  const transform = r => {
    // Compress the side's model_p toward 0.5 by factor c
    return 0.5 + (r.model_p_side - 0.5) * (1 - c);
  };
  const f = scoreWithTransform(fit, transform);
  const v = scoreWithTransform(val, transform);
  console.log('   ' + (c*100).toFixed(0).padStart(2) + '%       | ' + String(f.book_n).padStart(3) + ' / ' + f.book_roi.toFixed(1).padStart(5) + '% | ' + String(f.band12_n).padStart(2) + ' / ' + f.band12_roi.toFixed(1).padStart(5) + '% | ' + String(v.book_n).padStart(3) + ' / ' + v.book_roi.toFixed(1).padStart(5) + '% | ' + String(v.band12_n).padStart(2) + ' / ' + v.band12_roi.toFixed(1).padStart(5) + '%');
  pythLines.push([c, f.book_n, f.book_roi.toFixed(2), f.band12_n, f.band12_roi.toFixed(2), v.book_n, v.book_roi.toFixed(2), v.band12_n, v.band12_roi.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT, 'weight-sensitivity-pyth.tsv'), pythLines.join('\n'));

// ---- SWEEP 2: HFA_BOOST ----
// HFA adds to home team's WP. Model's stored home_ml already has HFA baked in.
// To swap HFA: for the SIGNAL SIDE, if signal is home, back out current HFA
// and add candidate HFA. If signal is away, do the reverse (away side WP is
// (1 - home_WP), so away_WP without HFA = (1 - (home_WP - HFA_current)); with
// candidate HFA = 1 - (raw_home_WP + HFA_candidate) = away_current_WP - HFA_delta.
// Current prod HFA_BOOST is 0.017.
console.log('\n=== SENSITIVITY SWEEP 2: HFA_BOOST ===');
console.log('  Current HFA = 0.017');
console.log('  HFA  | Fit book n / ROI | 1-2pp Fit n / ROI | Val book n / ROI | 1-2pp Val n / ROI');
const HFA_CURRENT = 0.017;
const hfaVals = [0.000, 0.010, 0.017, 0.020, 0.025, 0.030];
const hfaLines = ['# HFA_BOOST sensitivity'];
hfaLines.push(['hfa','fit_book_n','fit_book_roi','fit_12_n','fit_12_roi','val_book_n','val_book_roi','val_12_n','val_12_roi'].join('\t'));
for (const h of hfaVals) {
  const delta = h - HFA_CURRENT;
  const transform = r => {
    // If signal side is home: model_p_side already includes HFA; add delta.
    // If signal side is away: away_p = 1 - home_p; changing HFA by delta subtracts delta from away_p.
    return r.side_is_home ? r.model_p_side + delta : r.model_p_side - delta;
  };
  const f = scoreWithTransform(fit, transform);
  const v = scoreWithTransform(val, transform);
  console.log('  ' + h.toFixed(3) + ' | ' + String(f.book_n).padStart(3) + ' / ' + f.book_roi.toFixed(1).padStart(5) + '% | ' + String(f.band12_n).padStart(2) + ' / ' + f.band12_roi.toFixed(1).padStart(5) + '% | ' + String(v.book_n).padStart(3) + ' / ' + v.book_roi.toFixed(1).padStart(5) + '% | ' + String(v.band12_n).padStart(2) + ' / ' + v.band12_roi.toFixed(1).padStart(5) + '%');
  hfaLines.push([h, f.book_n, f.book_roi.toFixed(2), f.band12_n, f.band12_roi.toFixed(2), v.book_n, v.book_roi.toFixed(2), v.band12_n, v.band12_roi.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT, 'weight-sensitivity-hfa.tsv'), hfaLines.join('\n'));

// ---- SWEEP 3: SIGNAL_EDGE_HARD_CAP_PP (re-report from strong-fav sweep) ----
console.log('\n=== SENSITIVITY SWEEP 3: SIGNAL_EDGE_HARD_CAP_PP (edge cap suppression) ===');
console.log('  cap | Fit book n / ROI | 1-2pp Fit ROI | Val book n / ROI | 1-2pp Val ROI');
const capVals = [null, 12, 10, 8, 6];
const capLines = ['# SIGNAL_EDGE_HARD_CAP sensitivity'];
capLines.push(['cap_pp','fit_book_n','fit_book_roi','fit_12_n','fit_12_roi','val_book_n','val_book_roi','val_12_n','val_12_roi'].join('\t'));
for (const cap of capVals) {
  const transform = r => r.model_p_side; // Identity (edges are unchanged)
  const fitScored = scoreWithTransform(fit, transform);
  const valScored = scoreWithTransform(val, transform);
  // Apply cap: filter out signals where post-transform edge > cap
  function applyCap(scored) {
    const capped = [];
    for (const b of ['1-2','2-3','3-6','6-10','10+']) {
      for (const r of scored.bands[b]) {
        const edge = Math.max(0, r.model_p_side - r.close_p) * 100;
        if (cap === null || edge <= cap) capped.push(r);
      }
    }
    const n = capped.length;
    const pnl = capped.reduce((a,x)=>a+x.pnl_100, 0);
    const roi = n ? (pnl / (n * 100)) * 100 : 0;
    const b12 = capped.filter(r => {
      const e = Math.max(0, r.model_p_side - r.close_p) * 100;
      return e >= 1 && e < 2;
    });
    const roi12 = b12.length ? (b12.reduce((a,x)=>a+x.pnl_100,0) / (b12.length * 100)) * 100 : 0;
    return { n, roi, b12_n: b12.length, roi12 };
  }
  const cf = applyCap(fitScored);
  const cv = applyCap(valScored);
  const capLabel = cap === null ? 'off' : String(cap);
  console.log('  ' + capLabel.padEnd(3) + ' | ' + String(cf.n).padStart(3) + ' / ' + cf.roi.toFixed(1).padStart(5) + '% | ' + String(cf.b12_n).padStart(2) + ' / ' + cf.roi12.toFixed(1).padStart(5) + '% | ' + String(cv.n).padStart(3) + ' / ' + cv.roi.toFixed(1).padStart(5) + '% | ' + String(cv.b12_n).padStart(2) + ' / ' + cv.roi12.toFixed(1).padStart(5) + '%');
  capLines.push([capLabel, cf.n, cf.roi.toFixed(2), cf.b12_n, cf.roi12.toFixed(2), cv.n, cv.roi.toFixed(2), cv.b12_n, cv.roi12.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT, 'weight-sensitivity-cap.tsv'), capLines.join('\n'));

// ---- SWEEP 4: SIGNAL_EMIT_FLOOR_PP ----
console.log('\n=== SENSITIVITY SWEEP 4: SIGNAL_EMIT_FLOOR_PP ===');
console.log('  Current floor = 0.01 (1pp)');
console.log('  floor | Fit book n / ROI | Val book n / ROI');
const floors = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03];
const floorLines = ['# SIGNAL_EMIT_FLOOR sensitivity'];
floorLines.push(['floor_pp','fit_book_n','fit_book_roi','val_book_n','val_book_roi'].join('\t'));
for (const f of floors) {
  const filterAndScore = pool => {
    const kept = pool.filter(r => r.edge_base >= f * 100);
    const pnl = kept.reduce((a,x)=>a+x.pnl_100, 0);
    const roi = kept.length ? (pnl / (kept.length * 100)) * 100 : 0;
    return { n: kept.length, roi };
  };
  const ff = filterAndScore(fit);
  const vv = filterAndScore(val);
  console.log('  ' + (f*100).toFixed(1) + 'pp | ' + String(ff.n).padStart(3) + ' / ' + ff.roi.toFixed(1).padStart(5) + '% | ' + String(vv.n).padStart(3) + ' / ' + vv.roi.toFixed(1).padStart(5) + '%');
  floorLines.push([f, ff.n, ff.roi.toFixed(2), vv.n, vv.roi.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT, 'weight-sensitivity-floor.tsv'), floorLines.join('\n'));

// ---- JOINT: PYTH + CAP (the two sensitive ones from the marginals) ----
console.log('\n=== JOINT TUNE: PYTH compression x edge cap (2D grid) ===');
console.log('  Trained on Fit (Apr-May); validated on Val (Jun-Jul)');
console.log('  Search space: pyth_compression in {0, 10%, 15%, 20%}, edge_cap in {off, 12, 10, 8}');
console.log('  (fit_book_roi, val_book_roi, val_12_roi)');
const grid = [];
for (const c of [0, 0.10, 0.15, 0.20]) {
  const row = [];
  for (const cap of [null, 12, 10, 8]) {
    const transform = r => 0.5 + (r.model_p_side - 0.5) * (1 - c);
    const fs = scoreWithTransform(fit, transform);
    const vs = scoreWithTransform(val, transform);
    function applyCap(scored) {
      const capped = [];
      for (const b of ['1-2','2-3','3-6','6-10','10+']) {
        for (const r of scored.bands[b]) {
          const newP = 0.5 + (r.model_p_side - 0.5) * (1 - c);
          const edge = Math.max(0, newP - r.close_p) * 100;
          if (cap === null || edge <= cap) capped.push(r);
        }
      }
      const n = capped.length;
      const pnl = capped.reduce((a,x)=>a+x.pnl_100, 0);
      const roi = n ? (pnl / (n * 100)) * 100 : 0;
      const b12 = capped.filter(r => {
        const newP = 0.5 + (r.model_p_side - 0.5) * (1 - c);
        const e = Math.max(0, newP - r.close_p) * 100;
        return e >= 1 && e < 2;
      });
      const roi12 = b12.length ? (b12.reduce((a,x)=>a+x.pnl_100,0) / (b12.length * 100)) * 100 : 0;
      return { n, roi, b12_n: b12.length, roi12 };
    }
    const cf = applyCap(fs);
    const cv = applyCap(vs);
    row.push({ c, cap, fit_n: cf.n, fit_roi: cf.roi, val_n: cv.n, val_roi: cv.roi, val_12_n: cv.b12_n, val_12_roi: cv.roi12 });
    grid.push({ c, cap, fit_n: cf.n, fit_roi: cf.roi, val_n: cv.n, val_roi: cv.roi, val_12_n: cv.b12_n, val_12_roi: cv.roi12 });
  }
  console.log('  pyth_comp=' + (c*100).toFixed(0) + '%: ' + row.map(x => 'cap=' + (x.cap??'off') + ' fit=' + x.fit_roi.toFixed(1) + '% val=' + x.val_roi.toFixed(1) + '% (val_12=' + x.val_12_roi.toFixed(1) + '%)').join(' | '));
}
// Rank by val_roi
grid.sort((a,b) => b.val_roi - a.val_roi);
console.log('\nTop 5 by held-out (Jun-Jul) book ROI:');
for (const g of grid.slice(0, 5)) console.log('  pyth_comp=' + (g.c*100).toFixed(0) + '% cap=' + (g.cap??'off') + ': fit=' + g.fit_roi.toFixed(2) + '% val=' + g.val_roi.toFixed(2) + '% val_12=' + g.val_12_roi.toFixed(2) + '% (val_n=' + g.val_n + ')');

const jointLines = ['# JOINT PYTH x CAP grid'];
jointLines.push(['pyth_compression','edge_cap','fit_n','fit_roi','val_n','val_roi','val_12_n','val_12_roi'].join('\t'));
grid.sort((a,b) => (a.c - b.c) || (typeof a.cap === typeof b.cap ? (a.cap ?? 999) - (b.cap ?? 999) : 0));
for (const g of grid) jointLines.push([g.c, g.cap ?? 'off', g.fit_n, g.fit_roi.toFixed(2), g.val_n, g.val_roi.toFixed(2), g.val_12_n, g.val_12_roi.toFixed(2)].join('\t'));
fs.writeFileSync(path.join(OUT, 'weight-sensitivity-joint.tsv'), jointLines.join('\n'));

console.log('\nWrote 5 TSVs to docs/data/. Done.');
