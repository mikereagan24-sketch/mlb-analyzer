// Strong-favorite / big-edge decomposition
//
// Population: ML signals graded, closing_line present, model_line present,
//             recomputed |edge| >= 6pp (using model vs close), NOT corrupted,
//             game_date >= 2026-04-09.
//
// Also: 60-65% model-home-WP bucket (separate slice, all edge magnitudes).
//
// Steps:
//   1  CHARACTERIZE — fav/dog, home/away, team, temporal, opener/tandem
//   2  APPORTION by mechanism:
//        (a) Pythag lower-exponent counterfactual
//        (b) Bullpen quality bucket for the favored team
//        (c) SP-forecast rank
//        (d) proj_market extremes
//        (e) Closing-line direction (CRITICAL — did close move toward model?)
//   3  Cap-value sweep (5pp / 7 / 8 / 10 / 12) — ROI recovered vs bands touched
//   4  2-3pp band + NYM secondary read
//
// Output: docs/data/strongfav-*.tsv + console summary.

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

// ---- utility ----
const impliedP = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
const pnlOnRow = r => {
  if (r.outcome === 'push') return 0;
  if (r.outcome === 'loss') return -100;
  // win: dog pays closing_line; fav pays 100 on 100-risk
  return r.closing_line > 0 ? r.closing_line : 100;
};
const write = (name, lines) => {
  fs.writeFileSync(path.join(OUT, name), lines.join('\n'));
  console.log('  wrote docs/data/' + name);
};

// ---- Pull all clean-graded ML rows joined with game_log ----
const rows = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, "
+ "  bs.market_line, bs.closing_line, bs.model_line, bs.outcome, bs.pnl, "
+ "  bs.price_venue, bs.cohort, bs.edge_pct AS edge_pct_stored, "
+ "  gl.away_sp, gl.home_sp, "
+ "  gl.away_sp_forecast_ip, gl.home_sp_forecast_ip, "
+ "  gl.away_sp_forecast_n_priors, gl.home_sp_forecast_n_priors, "
+ "  gl.away_bullpen_woba, gl.home_bullpen_woba, "
+ "  gl.is_opener_game_away, gl.is_opener_game_home, "
+ "  gl.opener_model_away_ml, gl.opener_model_home_ml, "
+ "  gl.tandem_subtype_away, gl.tandem_subtype_home, "
+ "  gl.park_factor, "
+ "  gl.proj_market_away_ml, gl.proj_market_home_ml, "
+ "  gl.market_away_ml AS gl_mkt_away, gl.market_home_ml AS gl_mkt_home, "
+ "  gl.model_away_ml AS gl_mdl_away, gl.model_home_ml AS gl_mdl_home, "
+ "  gl.away_score, gl.home_score, "
+ "  gl.away_team, gl.home_team "
+ "FROM bet_signals bs JOIN game_log gl "
+ "  ON gl.game_date = bs.game_date AND gl.game_id = bs.game_id "
+ "WHERE bs.signal_type = 'ML' AND bs.outcome IN ('win','loss','push') "
+ "  AND bs.closing_line IS NOT NULL AND bs.model_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-04-09' "
+ "  AND NOT (bs.cohort = 'v7' AND bs.game_date IN (" + V7_EXCL + ")) "
+ "  AND NOT " + CORRUPT_SQL
).all();

console.log('Clean-graded ML row count: ' + rows.length);

// Enrich each row with recomputed edge, side label, closing-line-direction diagnostics
for (const r of rows) {
  const modelP = impliedP(r.model_line);
  const closeP = impliedP(r.closing_line);
  // Edge is model's advantage over the CLOSING line, from the signal's side.
  // If signal_side is 'away', we're betting the away side at closing_line.
  // Model backs the side, so modelP - closeP is the model's implied edge.
  r.edge_pp = Math.max(0, modelP - closeP) * 100;
  r.pnl_100 = pnlOnRow(r);
  // Favorite vs dog: which side did the signal take, was it the fav (negative ML)?
  r.side_is_fav = r.closing_line < 0;
  r.side_is_home = r.signal_side === 'home';
  // Model home WP: from gl model lines; take model_home_ml implied prob.
  r.model_home_wp = r.gl_mdl_home != null ? impliedP(r.gl_mdl_home) : null;
  // Signal team: the team the signal backed
  r.side_team = r.signal_side === 'away' ? r.away_team : r.home_team;
  // Line movement: proj_market (morning) vs closing (close)
  const projMlOnSignalSide = r.signal_side === 'away' ? r.proj_market_away_ml : r.proj_market_home_ml;
  r.proj_ml = projMlOnSignalSide;
  if (projMlOnSignalSide != null) {
    const projP = impliedP(projMlOnSignalSide);
    // Movement in IMPLIED PROB. Positive means market moved TOWARD our side
    // (implied prob went UP from morning to close). Negative means AWAY.
    // Note: our side is the one the signal took. If close moved to give
    // less good a price to the bettor, that's TOWARD (market agrees).
    // Actually: our side's implied prob at emit was projP, at close closeP.
    // The MODEL says the true prob is modelP > closeP (edge = modelP - closeP).
    // If closeP < projP, close moved AWAY from the market's morning read,
    // TOWARD what the model was saying (market lowered our side's implied
    // prob, closer to the model's view that the side is even less likely).
    //
    // Wait that's backwards. If model backs the AWAY side at edge >0,
    // model thinks away is MORE likely than market says. So modelP > marketP.
    // If close comes down (higher +American on our side), close-implied-prob
    // dropped — market moved AWAY from what the model said. That's BAD for
    // model's ML pick if model was hoping close would come around.
    //
    // Restating cleanly: for a signal, the model claims side X has prob P_m.
    // Market at emit says P_e. Market at close says P_c. Model edge = P_m - P_c.
    // If P_c > P_e: close moved TOWARD model's view (side became more likely
    // to market). GOOD for the model — market catching up.
    // If P_c < P_e: close moved AWAY (market went the OTHER way). BAD for model.
    r.line_move_pp = (closeP - projP) * 100; // positive = toward model, negative = away
  } else {
    r.line_move_pp = null;
  }
}

// ---- STEP 1 CHARACTERIZATION ----

// Big-edge subpopulation: |edge| >= 6pp
const big = rows.filter(r => r.edge_pp >= 6);
const smallMid = rows.filter(r => r.edge_pp < 6 && r.edge_pp >= 1);
console.log('\n=== STEP 1 — CHARACTERIZE the losing population ===');
console.log('big-edge (>=6pp) n=' + big.length + ', W-L-P=' +
  big.filter(x=>x.outcome==='win').length + '-' +
  big.filter(x=>x.outcome==='loss').length + '-' +
  big.filter(x=>x.outcome==='push').length);
const bigPnl = big.reduce((a,x)=>a+x.pnl_100, 0);
const bigRoi = (bigPnl / (big.length * 100)) * 100;
console.log('big-edge PnL: $' + bigPnl.toFixed(0) + ' ROI: ' + bigRoi.toFixed(1) + '%');

// (a) Fav vs dog
function slice(arr, filterFn, label) {
  const s = arr.filter(filterFn);
  if (!s.length) return { label, n: 0, w:0, l:0, p:0, pnl:0, roi: 0 };
  const w = s.filter(x=>x.outcome==='win').length;
  const l = s.filter(x=>x.outcome==='loss').length;
  const p = s.filter(x=>x.outcome==='push').length;
  const pnl = s.reduce((a,x)=>a+x.pnl_100, 0);
  return { label, n: s.length, w, l, p, pnl, roi: (pnl/(s.length*100))*100 };
}
const bigFav = slice(big, r => r.side_is_fav, 'big+FAV');
const bigDog = slice(big, r => !r.side_is_fav, 'big+DOG');
const bigHome = slice(big, r => r.side_is_home, 'big+HOME');
const bigAway = slice(big, r => !r.side_is_home, 'big+AWAY');
const bigFavHome = slice(big, r => r.side_is_fav && r.side_is_home, 'big+FAV+HOME');
const bigFavAway = slice(big, r => r.side_is_fav && !r.side_is_home, 'big+FAV+AWAY');
const bigDogHome = slice(big, r => !r.side_is_fav && r.side_is_home, 'big+DOG+HOME');
const bigDogAway = slice(big, r => !r.side_is_fav && !r.side_is_home, 'big+DOG+AWAY');

console.log('\n(a-b) Fav/Dog x Home/Away for big-edge:');
console.log('  slice           n     W-L-P    pnl$    ROI');
for (const s of [bigFav, bigDog, bigHome, bigAway, bigFavHome, bigFavAway, bigDogHome, bigDogAway]) {
  console.log('  '+s.label.padEnd(15)+' '+String(s.n).padStart(3)+'  '+(s.w+'-'+s.l+'-'+s.p).padEnd(9)+' '+String(s.pnl.toFixed(0)).padStart(6)+'  '+s.roi.toFixed(1)+'%');
}

// (c) Team clustering
const bigByTeam = {};
for (const r of big) {
  const t = r.side_team || 'unknown';
  const b = bigByTeam[t] = bigByTeam[t] || { n:0, w:0, l:0, pnl:0 };
  b.n++;
  if (r.outcome === 'win') { b.w++; b.pnl += r.pnl_100; }
  else if (r.outcome === 'loss') { b.l++; b.pnl -= 100; }
}
const teamsSorted = Object.entries(bigByTeam).map(([t, x]) =>
  ({ team: t, n: x.n, w: x.w, l: x.l, pnl: x.pnl, roi: (x.pnl/(x.n*100))*100 })
).sort((a,b) => b.n - a.n).slice(0, 10);
console.log('\n(c) Team clustering — top 10 by n in big-edge:');
console.log('  team n   W-L    pnl$    ROI');
for (const t of teamsSorted) console.log('  '+t.team.padEnd(4)+' '+String(t.n).padStart(3)+' '+(t.w+'-'+t.l).padEnd(6)+' '+String(t.pnl.toFixed(0)).padStart(6)+'  '+t.roi.toFixed(1)+'%');

// (d) Temporal
const bigByMonth = {};
for (const r of big) {
  const m = r.game_date.slice(0, 7);
  const b = bigByMonth[m] = bigByMonth[m] || { n:0, w:0, l:0, pnl:0 };
  b.n++;
  if (r.outcome === 'win') { b.w++; b.pnl += r.pnl_100; }
  else if (r.outcome === 'loss') { b.l++; b.pnl -= 100; }
}
console.log('\n(d) Temporal — big-edge by month:');
for (const [m, x] of Object.entries(bigByMonth).sort()) {
  const roi = (x.pnl/(x.n*100))*100;
  console.log('  '+m+' n='+String(x.n).padStart(3)+' W-L='+(x.w+'-'+x.l).padEnd(6)+' pnl=$'+String(x.pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}

// ---- STEP 2 — APPORTIONMENT ----
console.log('\n=== STEP 2 — MECHANISM APPORTIONMENT ===');

// (e) CRITICAL: closing-line direction on big-edge losers
const bigWithMove = big.filter(r => r.line_move_pp != null);
const towardModel = bigWithMove.filter(r => r.line_move_pp > 0);
const awayFromModel = bigWithMove.filter(r => r.line_move_pp < 0);
const flatLine = bigWithMove.filter(r => r.line_move_pp === 0);
console.log('\n(e) CLOSING-LINE-DIRECTION test (big-edge, morning proj_market → closing_line):');
console.log('  n_with_movement_data: ' + bigWithMove.length + ' of ' + big.length);
function moveStats(label, arr) {
  if (!arr.length) return console.log('  '+label+' n=0');
  const w = arr.filter(x=>x.outcome==='win').length;
  const l = arr.filter(x=>x.outcome==='loss').length;
  const pnl = arr.reduce((a,x)=>a+x.pnl_100, 0);
  const roi = (pnl/(arr.length*100))*100;
  console.log('  '+label.padEnd(28)+' n='+String(arr.length).padStart(3)+' W-L='+(w+'-'+l).padEnd(6)+' pnl=$'+String(pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}
moveStats('TOWARD model (close→edge lower)', towardModel);
moveStats('AWAY from model (close→edge bigger)', awayFromModel);
moveStats('FLAT (no morning line data)', flatLine);

// Sub-slice movement magnitude
const towardBig = bigWithMove.filter(r => r.line_move_pp > 2);
const awayBig = bigWithMove.filter(r => r.line_move_pp < -2);
moveStats('  strong TOWARD (>+2pp)', towardBig);
moveStats('  strong AWAY (<-2pp)', awayBig);

// (a) Pythag counterfactual: apply a lower exponent to the model's estimated run diff
// The model uses Pyth exp ~1.83 by default. Approximate an equivalent lower-exp WP:
// For a signal where model_line implies model_home_wp = X, an exponent shift changes X
// proportional to |X-0.5|. Test: assume model_line = f(model_home_wp) with pyth_exp=1.83;
// what if pyth_exp = 1.65? WP compression should reduce edge on extreme sides.
console.log('\n(a) Pythag exponent test — lower exp compresses extreme edges');
// Approximation: shift model_home_wp toward 0.5 by factor 1-(1.65/1.83)=0.098 (~10%)
// Then recompute model_p on signal side and compare to closeP.
function pyRecomp(r, compression) {
  if (r.model_home_wp == null) return null;
  const compressedWP = 0.5 + (r.model_home_wp - 0.5) * (1 - compression);
  const modelP = r.signal_side === 'home' ? compressedWP : (1 - compressedWP);
  const closeP = impliedP(r.closing_line);
  return { newEdge: Math.max(0, modelP - closeP) * 100, keepSignal: (modelP - closeP) * 100 >= 1 };
}
const compressions = [0.05, 0.10, 0.15, 0.20];
for (const c of compressions) {
  const still = big.filter(r => {
    const nr = pyRecomp(r, c);
    return nr && nr.newEdge >= 6;
  });
  const dropped = big.filter(r => {
    const nr = pyRecomp(r, c);
    return nr && nr.newEdge < 6;
  });
  const stillPnl = still.reduce((a,x)=>a+x.pnl_100, 0);
  const droppedPnl = dropped.reduce((a,x)=>a+x.pnl_100, 0);
  const stillRoi = still.length ? (stillPnl/(still.length*100))*100 : 0;
  const droppedRoi = dropped.length ? (droppedPnl/(dropped.length*100))*100 : 0;
  console.log('  compression '+(c*100).toFixed(0)+'%: still-big n='+still.length+' ROI='+stillRoi.toFixed(1)+'%, dropped n='+dropped.length+' ROI='+droppedRoi.toFixed(1)+'%');
}

// (b) Bullpen quality: bucket favored side's bullpen wOBA (lower=better)
console.log('\n(b) Bullpen quality — bucket by FAVORED team\'s bullpen wOBA');
const bullpenBuckets = {q1:[], q2:[], q3:[], q4:[]};
const bpVals = big.map(r => {
  const favBp = r.side_is_fav ?
    (r.side_is_home ? r.home_bullpen_woba : r.away_bullpen_woba) :
    (r.side_is_home ? r.away_bullpen_woba : r.home_bullpen_woba);
  return { r, favBp };
}).filter(x => x.favBp != null);
const sortedBp = [...bpVals].sort((a,b) => a.favBp - b.favBp);
const q1 = sortedBp.length / 4, q2 = q1*2, q3 = q1*3;
sortedBp.forEach((x, i) => {
  const key = i < q1 ? 'q1' : i < q2 ? 'q2' : i < q3 ? 'q3' : 'q4';
  bullpenBuckets[key].push(x.r);
});
console.log('  bucket (favored team bullpen wOBA, q1=best..q4=worst)');
for (const [k, arr] of Object.entries(bullpenBuckets)) {
  const w = arr.filter(x=>x.outcome==='win').length;
  const l = arr.filter(x=>x.outcome==='loss').length;
  const pnl = arr.reduce((a,x)=>a+x.pnl_100, 0);
  const roi = arr.length ? (pnl/(arr.length*100))*100 : 0;
  console.log('  '+k+': n='+String(arr.length).padStart(3)+' W-L='+(w+'-'+l).padEnd(6)+' pnl=$'+String(pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}

// (c) SP-forecast rank: bucket favored side's SP forecast IP
console.log('\n(c) SP-forecast rank — bucket by FAVORED side\'s SP forecast IP');
const spBuckets = {q1:[], q2:[], q3:[], q4:[]};
const spVals = big.map(r => {
  const favSpIp = r.side_is_fav ?
    (r.side_is_home ? r.home_sp_forecast_ip : r.away_sp_forecast_ip) :
    (r.side_is_home ? r.away_sp_forecast_ip : r.home_sp_forecast_ip);
  return { r, favSpIp };
}).filter(x => x.favSpIp != null);
const sortedSp = [...spVals].sort((a,b) => a.favSpIp - b.favSpIp);
const s1 = sortedSp.length / 4, s2 = s1*2, s3 = s1*3;
sortedSp.forEach((x, i) => {
  const key = i < s1 ? 'q1' : i < s2 ? 'q2' : i < s3 ? 'q3' : 'q4';
  spBuckets[key].push(x.r);
});
console.log('  bucket (favored SP forecast IP, q1=weakest..q4=strongest)');
for (const [k, arr] of Object.entries(spBuckets)) {
  const w = arr.filter(x=>x.outcome==='win').length;
  const l = arr.filter(x=>x.outcome==='loss').length;
  const pnl = arr.reduce((a,x)=>a+x.pnl_100, 0);
  const roi = arr.length ? (pnl/(arr.length*100))*100 : 0;
  console.log('  '+k+': n='+String(arr.length).padStart(3)+' W-L='+(w+'-'+l).padEnd(6)+' pnl=$'+String(pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}

// (d) proj_market extreme: how extreme was the morning line?
console.log('\n(d) proj_market extremes — how extreme was the morning line for the favored side?');
const projBuckets = {mild:[], moderate:[], strong:[], extreme:[]};
for (const r of big) {
  if (r.proj_ml == null) continue;
  // Use the FAVORED side's morning implied prob
  const favProjMl = r.side_is_fav ? r.proj_ml : -r.proj_ml; // approximation
  const favProjP = impliedP(r.side_is_fav ? r.proj_ml : (r.signal_side === 'away' ? r.proj_market_home_ml : r.proj_market_away_ml));
  if (favProjP >= 0.7) projBuckets.extreme.push(r);
  else if (favProjP >= 0.6) projBuckets.strong.push(r);
  else if (favProjP >= 0.55) projBuckets.moderate.push(r);
  else projBuckets.mild.push(r);
}
for (const [k, arr] of Object.entries(projBuckets)) {
  const w = arr.filter(x=>x.outcome==='win').length;
  const l = arr.filter(x=>x.outcome==='loss').length;
  const pnl = arr.reduce((a,x)=>a+x.pnl_100, 0);
  const roi = arr.length ? (pnl/(arr.length*100))*100 : 0;
  console.log('  '+k.padEnd(10)+' n='+String(arr.length).padStart(3)+' W-L='+(w+'-'+l).padEnd(6)+' pnl=$'+String(pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}

// ---- STEP 3 — CAP-VALUE SWEEP ----
console.log('\n=== STEP 3 — HARD-CAP VALUE SWEEP ===');
// If we cap edge at X pp, we suppress signals where recomputed edge_pp > X.
// Question: what's the ROI recovered vs volume lost in productive bands?
const caps = [5, 6, 7, 8, 9, 10, 12];
console.log('cap  suppress  saved$   kept    kept-ROI  kept-p&l   full-book-ROI (with cap)');
for (const cap of caps) {
  const suppressed = rows.filter(r => r.edge_pp > cap);
  const kept = rows.filter(r => r.edge_pp <= cap && r.edge_pp >= 1);
  const suppPnl = suppressed.reduce((a,x)=>a+x.pnl_100, 0);
  const keptPnl = kept.reduce((a,x)=>a+x.pnl_100, 0);
  const savedIfSuppressed = -suppPnl; // if we DIDN'T bet these, we saved the loss
  const keptRoi = kept.length ? (keptPnl/(kept.length*100))*100 : 0;
  const fullBook = keptPnl;
  const fullBookN = kept.length;
  const fullBookRoi = fullBookN ? (fullBook/(fullBookN*100))*100 : 0;
  console.log('  '+String(cap).padStart(2)+'   '+String(suppressed.length).padStart(3)+'      $'+String(savedIfSuppressed.toFixed(0)).padStart(6)+'   '+String(kept.length).padStart(3)+'   '+keptRoi.toFixed(1)+'%     $'+String(fullBook.toFixed(0)).padStart(6)+'   '+fullBookRoi.toFixed(1)+'%');
}

// Impact by band for cap at various values
console.log('\nCap impact by band (n suppressed at each cap):');
console.log('cap   1-2  2-3  3-6  6-10  10+');
for (const cap of caps) {
  const buckets = { '1-2':0, '2-3':0, '3-6':0, '6-10':0, '10+':0 };
  for (const r of rows) {
    if (r.edge_pp > cap) {
      const b = r.edge_pp < 2 ? '1-2' : r.edge_pp < 3 ? '2-3' : r.edge_pp < 6 ? '3-6' : r.edge_pp < 10 ? '6-10' : '10+';
      buckets[b]++;
    }
  }
  console.log('  '+String(cap).padStart(2)+'    '+String(buckets['1-2']).padStart(3)+'  '+String(buckets['2-3']).padStart(3)+'  '+String(buckets['3-6']).padStart(3)+'  '+String(buckets['6-10']).padStart(3)+'   '+String(buckets['10+']).padStart(3));
}

// ---- STEP 4 SECONDARY: 2-3pp band ----
console.log('\n=== STEP 4 — 2-3pp band analysis ===');
const band23 = rows.filter(r => r.edge_pp >= 2 && r.edge_pp < 3);
console.log('2-3pp n=' + band23.length);
const b23Fav = slice(band23, r => r.side_is_fav, '2-3pp FAV');
const b23Dog = slice(band23, r => !r.side_is_fav, '2-3pp DOG');
const b23Home = slice(band23, r => r.side_is_home, '2-3pp HOME');
const b23Away = slice(band23, r => !r.side_is_home, '2-3pp AWAY');
for (const s of [b23Fav, b23Dog, b23Home, b23Away]) {
  console.log('  '+s.label.padEnd(12)+' n='+String(s.n).padStart(3)+' W-L='+(s.w+'-'+s.l).padEnd(6)+' pnl=$'+String(s.pnl.toFixed(0)).padStart(6)+' ROI='+s.roi.toFixed(1)+'%');
}

// NYM audit
console.log('\n=== NYM audit — all bands ===');
const nymRows = rows.filter(r => r.side_team && r.side_team.toLowerCase() === 'nym');
console.log('NYM signals (all): n=' + nymRows.length);
const nymBands = { '1-2':[], '2-3':[], '3-6':[], '6-10':[], '10+':[] };
for (const r of nymRows) {
  if (r.edge_pp < 1) continue;
  const b = r.edge_pp < 2 ? '1-2' : r.edge_pp < 3 ? '2-3' : r.edge_pp < 6 ? '3-6' : r.edge_pp < 10 ? '6-10' : '10+';
  nymBands[b].push(r);
}
for (const [b, arr] of Object.entries(nymBands)) {
  if (!arr.length) continue;
  const w = arr.filter(x=>x.outcome==='win').length;
  const l = arr.filter(x=>x.outcome==='loss').length;
  const pnl = arr.reduce((a,x)=>a+x.pnl_100, 0);
  const roi = (pnl/(arr.length*100))*100;
  console.log('  '+b.padEnd(5)+' n='+String(arr.length).padStart(3)+' W-L='+(w+'-'+l).padEnd(6)+' pnl=$'+String(pnl.toFixed(0)).padStart(6)+' ROI='+roi.toFixed(1)+'%');
}

// ---- Save the big-edge rows for reference ----
const bigLines = ['# Big-edge (>=6pp recomputed vs closing) rows — losing population'];
bigLines.push(['id','date','game_id','side','side_team','market_line','closing_line','model_line','edge_pp','side_is_fav','side_is_home','line_move_pp','outcome','pnl_100'].join('\t'));
for (const r of big.sort((a,b) => b.edge_pp - a.edge_pp)) {
  bigLines.push([r.id, r.game_date, r.game_id, r.signal_side, r.side_team||'', r.market_line, r.closing_line, r.model_line, r.edge_pp.toFixed(2), r.side_is_fav ? 1 : 0, r.side_is_home ? 1 : 0, r.line_move_pp != null ? r.line_move_pp.toFixed(2) : '', r.outcome, r.pnl_100].join('\t'));
}
write('strongfav-bigedge-rows.tsv', bigLines);

// Save the ROI-by-cap TSV
const capLines = ['# ROI recovery vs hard-cap value (all clean-graded ML rows)'];
capLines.push(['cap_pp','suppressed_n','saved_dollars','kept_n','kept_roi_pct'].join('\t'));
for (const cap of caps) {
  const suppressed = rows.filter(r => r.edge_pp > cap);
  const kept = rows.filter(r => r.edge_pp <= cap && r.edge_pp >= 1);
  const suppPnl = suppressed.reduce((a,x)=>a+x.pnl_100, 0);
  const keptPnl = kept.reduce((a,x)=>a+x.pnl_100, 0);
  capLines.push([cap, suppressed.length, (-suppPnl).toFixed(0), kept.length, kept.length ? ((keptPnl/(kept.length*100))*100).toFixed(2) : '0'].join('\t'));
}
write('strongfav-cap-sweep.tsv', capLines);

console.log('\nDone.');
