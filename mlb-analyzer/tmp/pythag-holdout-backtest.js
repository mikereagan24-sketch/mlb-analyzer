// Pythag exponent 1.83 → 1.65 fit/holdout backtest + hard-cap-8pp companion
//
// Owner criteria (from 2026-07-13 message):
//   - Fit: Apr-Jun 2026
//   - Validate: Jul 2026
//   - Report BOTH in-sample and out-of-sample book ROI
//   - 1-2pp band safety gate — must not damage
//   - Report effect on +18.5% big-FAV signals — must not kill real fav edges
//   - Ship BOTH (Pythag primary + hard cap 8pp insurance) if Pythag holdout holds
//
// Pythag exponent mapping to my WP-compression proxy:
//   pyth_exp 1.83 → 1.65 corresponds to WP compression c ≈ 0.08.
//   Derivation: for a 5.5/4.0 runs-for/against split (common strong fav),
//   E=1.83 gives WP=0.633; E=1.65 gives WP=0.622 (delta 1.1pp).
//   Compression c=0.08 on WP=0.633 → newP=0.5+0.133*(0.92)=0.622 — matches.
//
// Cap: signals with recomputed edge > 8pp are suppressed entirely.

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

for (const r of rows) {
  r.side_is_home = r.signal_side === 'home';
  r.side_is_fav = r.closing_line < 0;
  r.pnl_100 = r.outcome === 'push' ? 0 : (r.outcome === 'loss' ? -100 : (r.closing_line > 0 ? r.closing_line : 100));
  r.close_p = impliedP(r.closing_line);
  r.model_p_side = r.signal_side === 'home' ? impliedP(r.gl_mdl_home) : impliedP(r.gl_mdl_away);
  r.edge_base_pp = Math.max(0, r.model_p_side - r.close_p) * 100;
}

// Owner's split
const fit = rows.filter(r => r.game_date >= '2026-04-09' && r.game_date <= '2026-06-30');
const val = rows.filter(r => r.game_date >= '2026-07-01');
console.log('Clean-graded ML rows: ' + rows.length);
console.log('Fit  (Apr-Jun): n=' + fit.length);
console.log('Val  (Jul):     n=' + val.length);

// Score under transform + optional cap. Returns book stats + 1-2pp band +
// big-FAV subset ROI (rows where signal took a fav, edge >= 6pp).
function scoreSplit(pool, compressionC, cap) {
  const transformed = pool.map(r => {
    const newP = 0.5 + (r.model_p_side - 0.5) * (1 - compressionC);
    const edge = Math.max(0, newP - r.close_p) * 100;
    return { r, newP, edge };
  });
  // Emit floor 1pp AND cap
  const kept = transformed.filter(x => x.edge >= 1 && (cap === null || x.edge <= cap));
  const bookN = kept.length;
  const bookPnl = kept.reduce((a,x) => a + x.r.pnl_100, 0);
  const bookRoi = bookN ? (bookPnl / (bookN * 100)) * 100 : 0;
  // Bands
  const bands = { '1-2':[], '2-3':[], '3-6':[], '6-10':[], '10+':[] };
  for (const x of kept) {
    const b = x.edge < 2 ? '1-2' : x.edge < 3 ? '2-3' : x.edge < 6 ? '3-6' : x.edge < 10 ? '6-10' : '10+';
    bands[b].push(x);
  }
  const band12 = bands['1-2'];
  const roi12 = band12.length ? (band12.reduce((a,x)=>a+x.r.pnl_100,0) / (band12.length * 100)) * 100 : 0;
  // Big-FAV subset: kept signals where side was fav AND edge >= 6pp
  const bigFav = kept.filter(x => x.r.side_is_fav && x.edge >= 6);
  const bigFavRoi = bigFav.length ? (bigFav.reduce((a,x)=>a+x.r.pnl_100,0) / (bigFav.length * 100)) * 100 : 0;
  // Big-DOG-home subset: the losing bucket, sanity
  const bigDogHome = kept.filter(x => !x.r.side_is_fav && x.r.side_is_home && x.edge >= 6);
  const bigDogHomeRoi = bigDogHome.length ? (bigDogHome.reduce((a,x)=>a+x.r.pnl_100,0) / (bigDogHome.length * 100)) * 100 : 0;
  return {
    book_n: bookN, book_roi: bookRoi,
    band12_n: band12.length, band12_roi: roi12,
    bigfav_n: bigFav.length, bigfav_roi: bigFavRoi,
    bigdoghome_n: bigDogHome.length, bigdoghome_roi: bigDogHomeRoi,
    band_ns: { '1-2': bands['1-2'].length, '2-3': bands['2-3'].length, '3-6': bands['3-6'].length, '6-10': bands['6-10'].length, '10+': bands['10+'].length },
  };
}

// -------- Baseline --------
console.log('\n=== BASELINE (pyth_exp=1.83, no cap) — proves the harness ===');
const bF = scoreSplit(fit, 0, null);
const bV = scoreSplit(val, 0, null);
console.log('  Fit: book n=' + bF.book_n + ' ROI=' + bF.book_roi.toFixed(2) + '% | 1-2pp: n=' + bF.band12_n + ' ROI=' + bF.band12_roi.toFixed(2) + '% | big+FAV: n=' + bF.bigfav_n + ' ROI=' + bF.bigfav_roi.toFixed(2) + '% | big+DOG+HOME: n=' + bF.bigdoghome_n + ' ROI=' + bF.bigdoghome_roi.toFixed(2) + '%');
console.log('  Val: book n=' + bV.book_n + ' ROI=' + bV.book_roi.toFixed(2) + '% | 1-2pp: n=' + bV.band12_n + ' ROI=' + bV.band12_roi.toFixed(2) + '% | big+FAV: n=' + bV.bigfav_n + ' ROI=' + bV.bigfav_roi.toFixed(2) + '% | big+DOG+HOME: n=' + bV.bigdoghome_n + ' ROI=' + bV.bigdoghome_roi.toFixed(2) + '%');

// -------- Owner recommendation grid --------
// pyth 1.83->1.65 ~= c=0.08. Bracket with 0.05, 0.08, 0.10, 0.12.
// cap: off vs 8pp.
console.log('\n=== PYTHAG × CAP GRID (fit=Apr-Jun, val=Jul) ===');
console.log('  compression 0=pyth_exp 1.83, ~0.05=1.75, ~0.08=1.65, ~0.12=1.55, ~0.15=1.50');
console.log('  cap | comp  | Fit book n/ROI  | Val book n/ROI  | 1-2pp Val n/ROI | big+FAV Val n/ROI | big+DOG+HOME Val n/ROI');
const compressions = [0, 0.05, 0.08, 0.10, 0.12, 0.15];
const caps = [null, 8];
const results = [];
for (const cap of caps) {
  for (const c of compressions) {
    const f = scoreSplit(fit, c, cap);
    const v = scoreSplit(val, c, cap);
    const capLabel = cap === null ? 'off' : String(cap);
    console.log('  ' + capLabel.padEnd(3) + ' | ' + (c*100).toFixed(0).padStart(2) + '%   | ' + String(f.book_n).padStart(3) + ' / ' + f.book_roi.toFixed(1).padStart(6) + '% | ' + String(v.book_n).padStart(3) + ' / ' + v.book_roi.toFixed(1).padStart(6) + '% | ' + String(v.band12_n).padStart(2) + ' / ' + v.band12_roi.toFixed(1).padStart(6) + '% | ' + String(v.bigfav_n).padStart(2) + ' / ' + v.bigfav_roi.toFixed(1).padStart(6) + '% | ' + String(v.bigdoghome_n).padStart(2) + ' / ' + v.bigdoghome_roi.toFixed(1).padStart(6) + '%');
    results.push({ cap: capLabel, compression: c, ...{ fit_book_n: f.book_n, fit_book_roi: f.book_roi }, ...{ val_book_n: v.book_n, val_book_roi: v.book_roi }, ...{ val_12_n: v.band12_n, val_12_roi: v.band12_roi }, ...{ val_bigfav_n: v.bigfav_n, val_bigfav_roi: v.bigfav_roi }, ...{ val_bigdoghome_n: v.bigdoghome_n, val_bigdoghome_roi: v.bigdoghome_roi } });
  }
}

// Persist results
const tsvLines = ['# Pythag × cap grid — fit Apr-Jun, val Jul'];
tsvLines.push(['cap','pyth_compression','fit_book_n','fit_book_roi','val_book_n','val_book_roi','val_12_n','val_12_roi','val_bigfav_n','val_bigfav_roi','val_bigdoghome_n','val_bigdoghome_roi'].join('\t'));
for (const r of results) tsvLines.push([r.cap, r.compression, r.fit_book_n, r.fit_book_roi.toFixed(2), r.val_book_n, r.val_book_roi.toFixed(2), r.val_12_n, r.val_12_roi.toFixed(2), r.val_bigfav_n, r.val_bigfav_roi.toFixed(2), r.val_bigdoghome_n, r.val_bigdoghome_roi.toFixed(2)].join('\t'));
fs.writeFileSync(path.join(OUT, 'pythag-holdout-grid.tsv'), tsvLines.join('\n'));
console.log('\nWrote docs/data/pythag-holdout-grid.tsv');

// -------- Ship-decision synthesis --------
console.log('\n=== SHIP DECISION SYNTHESIS ===');
console.log('Owner criteria:');
console.log('  (a) Val book ROI > baseline (currently ' + bV.book_roi.toFixed(2) + '%)');
console.log('  (b) Val 1-2pp band ROI not damaged (baseline ' + bV.band12_roi.toFixed(2) + '%)');
console.log('  (c) Val big+FAV subset ROI stays positive (baseline ' + bV.bigfav_roi.toFixed(2) + '%)');
console.log('  (d) Val big+DOG+HOME ROI improves (baseline ' + bV.bigdoghome_roi.toFixed(2) + '%)');
console.log('');
const target = results.find(r => r.compression === 0.08 && r.cap === 'off');
const targetWithCap = results.find(r => r.compression === 0.08 && r.cap === '8');
console.log('Recommended cell (pyth_exp=1.65, cap=off — Pythag alone):');
console.log('  Fit ROI: ' + target.fit_book_roi.toFixed(2) + '% (in-sample)');
console.log('  Val ROI: ' + target.val_book_roi.toFixed(2) + '% (out-of-sample)  — vs baseline ' + bV.book_roi.toFixed(2) + '% (' + (target.val_book_roi - bV.book_roi).toFixed(2) + 'pp)');
console.log('  Val 1-2pp: ' + target.val_12_roi.toFixed(2) + '% (n=' + target.val_12_n + ')  — vs baseline ' + bV.band12_roi.toFixed(2) + '% (' + (target.val_12_roi - bV.band12_roi).toFixed(2) + 'pp)');
console.log('  Val big+FAV: ' + target.val_bigfav_roi.toFixed(2) + '% (n=' + target.val_bigfav_n + ')');
console.log('  Val big+DOG+HOME: ' + target.val_bigdoghome_roi.toFixed(2) + '% (n=' + target.val_bigdoghome_n + ')');
console.log('');
console.log('Recommended cell (pyth_exp=1.65 + cap=8pp — both):');
console.log('  Fit ROI: ' + targetWithCap.fit_book_roi.toFixed(2) + '%');
console.log('  Val ROI: ' + targetWithCap.val_book_roi.toFixed(2) + '%  — vs baseline (' + (targetWithCap.val_book_roi - bV.book_roi).toFixed(2) + 'pp)');
console.log('  Val 1-2pp: ' + targetWithCap.val_12_roi.toFixed(2) + '% (n=' + targetWithCap.val_12_n + ')');
console.log('  Val big+FAV: ' + targetWithCap.val_bigfav_roi.toFixed(2) + '% (n=' + targetWithCap.val_bigfav_n + ')');
console.log('  Val big+DOG+HOME: ' + targetWithCap.val_bigdoghome_roi.toFixed(2) + '% (n=' + targetWithCap.val_bigdoghome_n + ')');

// Ship-gate boolean
const gateA = target.val_book_roi > bV.book_roi;
const gateB = target.val_12_roi >= bV.band12_roi - 2; // ±2pp tolerance
const gateC = target.val_bigfav_roi >= 0;
const gateD = target.val_bigdoghome_roi > bV.bigdoghome_roi;
console.log('\nGates (Pythag only, c=0.08):');
console.log('  (a) Val book ROI improves: ' + (gateA ? 'PASS' : 'FAIL'));
console.log('  (b) Val 1-2pp not damaged (>=-2pp): ' + (gateB ? 'PASS' : 'FAIL'));
console.log('  (c) Val big+FAV positive: ' + (gateC ? 'PASS' : 'FAIL'));
console.log('  (d) Val big+DOG+HOME improved: ' + (gateD ? 'PASS' : 'FAIL'));
console.log('\nSHIP DECISION: ' + ((gateA && gateB && gateC && gateD) ? '✓ ALL GATES PASS — safe to ship' : '✗ ONE OR MORE GATES FAIL — do NOT ship'));
