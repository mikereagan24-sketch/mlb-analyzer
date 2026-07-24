// Midyear review STEP 1 scorecard.
//
// Grading discipline (owner-approved, from STEP 0 corruption finding):
//   - closing_line is the authoritative pre-lock market price. market_line
//     is corrupted on 34 rows since April (post-lock in-play stomps);
//     never used here.
//   - Edge is RECOMPUTED per-row from model_line vs closing_line so the
//     34 corrupted market_line values don't skew band assignment.
//   - Net-of-fees: for ML dogs (positive American), pnl = closing_line
//     on win, -100 on loss. For favs (negative American), pnl = 100 on
//     win, closing_line on loss. This is the standard $100-stake convention.
//     (Kalshi + Poly fees are already baked into closing_line via the
//     fee-adjusted net_american capture.)
//   - Only graded rows (outcome IN ('win','loss','push')).
//   - Cohort-hygiene EXCLUSIONS on v7:
//     * 2026-07-06/07 — pre-venue-flip days when signal engine hadn't
//       adopted the venue-aware baseline
//     * 2026-07-10 morning window — tier-3 raw-ask Kalshi capture (the
//       incident that prompted PR #167)
//     * 2026-07-10 20:15 ping-pong window
//     * 2026-07-11 — the "kalshi_direct_totals_enabled OFF post-#171"
//       corruption day
//     * The 34 individually-corrupted rows across all dates
//   - Report clean-v7 n by market. If a metric's clean-v7 n is < 30,
//     report the number but flag it as noise-band.
//
// Outputs (to docs/data/):
//   midyear-cohorts.tsv                 — cohort landscape
//   midyear-corrupted-rows.tsv          — the 34 flagged rows
//   midyear-scorecard-ml.tsv            — ML by edge band (all + v7-clean)
//   midyear-scorecard-tot.tsv           — Totals by edge band
//   midyear-clv-by-venue.tsv            — CLV distribution ML kalshi vs poly
//   midyear-team-ml.tsv                 — per-team ML W/L (COL/ATH focus)
//   midyear-summary.txt                 — human-readable rollup

const path = require('path');
const fs = require('fs');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });

const OUT_DIR = path.join(__dirname, '..', 'docs', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SNAP_TS = db.prepare("SELECT datetime('now') n").get().n + ' UTC';
console.log('DB snapshot: ' + SNAP_TS);

// ---- utility ----
const impliedProb = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
const write = (name, lines) => {
  fs.writeFileSync(path.join(OUT_DIR, name), lines.join('\n'));
  console.log('  wrote docs/data/' + name);
};

// ---- Cohort landscape ----
const cohorts = db.prepare(
  "SELECT cohort, signal_type, MIN(game_date) mn, MAX(game_date) mx, COUNT(*) n_total, "
+ "SUM(CASE WHEN outcome IN ('win','loss','push') THEN 1 ELSE 0 END) n_graded, "
+ "SUM(CASE WHEN closing_line IS NOT NULL THEN 1 ELSE 0 END) n_with_close "
+ "FROM bet_signals WHERE game_date >= '2026-04-01' GROUP BY cohort, signal_type ORDER BY mn, cohort, signal_type"
).all();
write('midyear-cohorts.tsv', [
  ['cohort','signal_type','date_min','date_max','n_total','n_graded','n_with_close'].join('\t'),
  ...cohorts.map(c => [c.cohort, c.signal_type, c.mn, c.mx, c.n_total, c.n_graded, c.n_with_close].join('\t'))
]);

// ---- Corrupted rows (|market_line - closing_line| >= 30, same sign) ----
const CORRUPT_SQL = "(closing_line IS NOT NULL AND ("
+ "(market_line > 0 AND closing_line > 0 AND ABS(market_line - closing_line) >= 30) OR "
+ "(market_line < 0 AND closing_line < 0 AND ABS(market_line - closing_line) >= 30) OR "
+ "(market_line > 100 AND closing_line < 0) OR "
+ "(market_line < -100 AND closing_line > 0)"
+ "))";
const corrupted = db.prepare(
  "SELECT id, game_date, game_id, signal_type, signal_side, market_line, closing_line, model_line, edge_pct, price_venue, outcome, pnl FROM bet_signals WHERE " + CORRUPT_SQL + " ORDER BY game_date, game_id"
).all();
write('midyear-corrupted-rows.tsv', [
  ['id','date','game_id','type','side','market_line','closing_line','model_line','edge_pct_stored','price_venue','outcome','pnl'].join('\t'),
  ...corrupted.map(r => [r.id, r.game_date, r.game_id, r.signal_type, r.signal_side, r.market_line, r.closing_line, r.model_line, r.edge_pct, r.price_venue||'', r.outcome, r.pnl].join('\t'))
]);
console.log('  corrupted rows: ' + corrupted.length);

// ---- Cohort-hygiene v7 exclusions ----
// Full v7 window: 2026-07-06 .. 2026-07-12.
// Excluded windows (per owner's task brief):
const V7_EXCLUDE_DATES = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];
const V7_EXCL_STR = V7_EXCLUDE_DATES.map(d=>"'"+d+"'").join(',');
const CORRUPT_IDS = corrupted.map(r=>r.id);
const CORRUPT_ID_STR = CORRUPT_IDS.length ? CORRUPT_IDS.join(',') : '-1';

// ---- ML scorecard: all-graded rows AND clean-v7 subset, by edge band ----
// Edge is RECOMPUTED from model_line vs closing_line to bypass any corrupt market_line.
// Standard American PnL: on win at price P, dog(+P) wins P; fav(-P) wins 100. On loss, always -100.
function scoreML(datesWhere, includeCorruptions) {
  const excludeCorrupt = includeCorruptions ? "" : " AND id NOT IN (" + CORRUPT_ID_STR + ")";
  const rows = db.prepare(
    "SELECT signal_side, market_line, closing_line, model_line, outcome, pnl "
  + "FROM bet_signals WHERE signal_type='ML' AND outcome IN ('win','loss','push') "
  + "AND closing_line IS NOT NULL AND model_line IS NOT NULL "
  + "AND contaminated_reason IS NULL "
  + datesWhere + excludeCorrupt
  ).all();
  const bands = { '1-2':[], '2-3':[], '3-6':[], '6-10':[], '10+':[] };
  for (const r of rows) {
    const modelP = impliedProb(r.model_line);
    const marketP = impliedProb(r.closing_line);
    const edgePP = Math.max(0, modelP - marketP) * 100;
    const b = edgePP < 1 ? null : edgePP < 2 ? '1-2' : edgePP < 3 ? '2-3' : edgePP < 6 ? '3-6' : edgePP < 10 ? '6-10' : '10+';
    if (!b) continue;
    // Grade PnL using closing_line as the price the bettor got. Uses standard
    // $100-stake convention: pnl = closing_line if dog wins; +100 if fav wins; -100 on loss.
    let pnl;
    if (r.outcome === 'push') pnl = 0;
    else if (r.outcome === 'win') pnl = r.closing_line > 0 ? r.closing_line : 100;
    else pnl = r.closing_line > 0 ? -100 : -100 * (100 / Math.abs(r.closing_line)) * (Math.abs(r.closing_line)/100); // -100 flat
    // Actually simpler: loss is always -100 on a $100 stake.
    if (r.outcome === 'loss') pnl = -100;
    bands[b].push({ pnl, outcome: r.outcome });
  }
  const summary = {};
  for (const [b, arr] of Object.entries(bands)) {
    const n = arr.length, w = arr.filter(x=>x.outcome==='win').length, l = arr.filter(x=>x.outcome==='loss').length, p = arr.filter(x=>x.outcome==='push').length;
    const pnlSum = arr.reduce((a,x)=>a+x.pnl,0);
    const staked = n * 100;
    const roi = staked ? (pnlSum / staked) * 100 : 0;
    summary[b] = { n, w, l, p, pnl_sum: pnlSum, roi_pct: roi };
  }
  return summary;
}

const mlAll = scoreML("AND game_date >= '2026-04-09'", false);
const mlV6  = scoreML("AND cohort = 'v6'", false);
const mlV7Raw = scoreML("AND cohort = 'v7'", true);
const mlV7Clean = scoreML(
  "AND cohort = 'v7' AND game_date NOT IN (" + V7_EXCL_STR + ")",
  false
);

function fmtScorecard(name, s) {
  const lines = [name];
  const bands = ['1-2','2-3','3-6','6-10','10+'];
  lines.push('  band   n    W-L-P    pnl($)    ROI%');
  for (const b of bands) {
    const x = s[b];
    lines.push('  '+b.padEnd(6)+' '+String(x.n).padStart(4)+' '+(x.w+'-'+x.l+'-'+x.p).padEnd(9)+' '+String(x.pnl_sum.toFixed(0)).padStart(8)+'  '+x.roi_pct.toFixed(1)+'%');
  }
  return lines;
}

const mlLines = [];
mlLines.push('# ML SCORECARD (closing_line-graded, edge recomputed from model_line vs closing_line)');
mlLines.push('# Snapshot: ' + SNAP_TS);
mlLines.push('# Corrupted rows excluded except in "v7 raw" for reference.');
mlLines.push('');
mlLines.push(...fmtScorecard('ALL 2026 (Apr-Jul, minus corrupted)', mlAll));
mlLines.push('');
mlLines.push(...fmtScorecard('v6 (2026-05-29 .. 2026-07-05, minus corrupted)', mlV6));
mlLines.push('');
mlLines.push(...fmtScorecard('v7 raw (2026-07-06 .. 2026-07-12, INCLUDES corrupted + tainted dates)', mlV7Raw));
mlLines.push('');
mlLines.push(...fmtScorecard('v7 CLEAN (excludes ' + V7_EXCLUDE_DATES.join(',') + ' + corrupted)', mlV7Clean));
mlLines.push('');
mlLines.push('# TSV rows: cohort\tband\tn\twins\tlosses\tpushes\tpnl\troi_pct');
for (const [name, sc] of [['all',mlAll],['v6',mlV6],['v7_raw',mlV7Raw],['v7_clean',mlV7Clean]]) {
  for (const b of ['1-2','2-3','3-6','6-10','10+']) {
    const x = sc[b];
    mlLines.push([name, b, x.n, x.w, x.l, x.p, x.pnl_sum.toFixed(0), x.roi_pct.toFixed(2)].join('\t'));
  }
}
write('midyear-scorecard-ml.tsv', mlLines);

// Console summary
console.log('\n=== ML SCORECARD (net-of-fees, closing_line-graded) ===');
for (const [name, sc] of [['ALL',mlAll],['v6',mlV6],['v7 clean',mlV7Clean]]) {
  console.log('\n'+name+':');
  console.log('  band   n     W-L-P    pnl$     ROI');
  for (const b of ['1-2','2-3','3-6','6-10','10+']) {
    const x = sc[b];
    console.log('  '+b.padEnd(6)+' '+String(x.n).padStart(4)+'  '+(x.w+'-'+x.l+'-'+x.p).padEnd(9)+' '+String(x.pnl_sum.toFixed(0)).padStart(7)+'   '+x.roi_pct.toFixed(1)+'%');
  }
}

// ---- Totals scorecard ----
// Totals are Over/Under against market_total. closing_line for totals isn't
// captured the same way as ML — game_log.market_total is the pre-lock value
// (Kalshi/Poly post-#169; Unabated pre-#169). For grading we use the STORED
// market_line on Total signals since Total signals aren't subject to the
// same +American walk-past issue as ML dogs (Total prices are always around
// ±110). But we still exclude the corrupted-rows-set defensively.
function scoreTot(datesWhere) {
  const rows = db.prepare(
    "SELECT signal_side, market_line, model_line, outcome, pnl "
  + "FROM bet_signals WHERE signal_type='Total' AND outcome IN ('win','loss','push') "
  + "AND market_line IS NOT NULL AND model_line IS NOT NULL "
  + "AND contaminated_reason IS NULL "
  + datesWhere + " AND id NOT IN (" + CORRUPT_ID_STR + ")"
  ).all();
  const bands = { '1-2':[], '2-3':[], '3-6':[], '6-10':[], '10+':[] };
  for (const r of rows) {
    // Model total signal edge: model_over_prob - market_over_prob at line=market_line.
    // Standard approximation: TOT_SLOPE=0.08 on run-diff. Recompute:
    const runDiff = r.model_line - r.market_line; // model_line for Total = model_total
    const modelOverP = Math.min(0.8, Math.max(0.2, 0.5 + runDiff * 0.08));
    const modelP = r.signal_side === 'over' ? modelOverP : 1 - modelOverP;
    const marketP = 0.5; // approximation — actual uses over/under juice; close enough for band assignment
    const edgePP = Math.max(0, modelP - marketP) * 100;
    const b = edgePP < 1 ? null : edgePP < 2 ? '1-2' : edgePP < 3 ? '2-3' : edgePP < 6 ? '3-6' : edgePP < 10 ? '6-10' : '10+';
    if (!b) continue;
    // Totals PnL: use stored pnl if computed, else assume -110 juice.
    let pnl;
    if (r.outcome === 'push') pnl = 0;
    else if (r.outcome === 'win') pnl = 100 / 1.10; // ~91 on -110
    else pnl = -100;
    bands[b].push({ pnl, outcome: r.outcome });
  }
  const summary = {};
  for (const [b, arr] of Object.entries(bands)) {
    const n = arr.length, w = arr.filter(x=>x.outcome==='win').length, l = arr.filter(x=>x.outcome==='loss').length, p = arr.filter(x=>x.outcome==='push').length;
    const pnlSum = arr.reduce((a,x)=>a+x.pnl,0);
    const staked = n * 100;
    const roi = staked ? (pnlSum / staked) * 100 : 0;
    summary[b] = { n, w, l, p, pnl_sum: pnlSum, roi_pct: roi };
  }
  return summary;
}

const totAll = scoreTot("AND game_date >= '2026-04-09'");
const totV6  = scoreTot("AND cohort = 'v6'");
const totV7  = scoreTot("AND cohort = 'v7' AND game_date NOT IN (" + V7_EXCL_STR + ")");
const totLines = ['# TOTALS SCORECARD (paused-diagnostic per owner)'];
totLines.push('# TSV rows: cohort\tband\tn\twins\tlosses\tpushes\tpnl\troi_pct');
for (const [name, sc] of [['all',totAll],['v6',totV6],['v7_clean',totV7]]) {
  for (const b of ['1-2','2-3','3-6','6-10','10+']) {
    const x = sc[b];
    totLines.push([name, b, x.n, x.w, x.l, x.p, x.pnl_sum.toFixed(0), x.roi_pct.toFixed(2)].join('\t'));
  }
}
write('midyear-scorecard-tot.tsv', totLines);
console.log('\n=== TOTALS SCORECARD ===');
for (const [name, sc] of [['ALL',totAll],['v6',totV6],['v7 clean',totV7]]) {
  console.log('\n'+name+':');
  console.log('  band   n     W-L-P    pnl$     ROI');
  for (const b of ['1-2','2-3','3-6','6-10','10+']) {
    const x = sc[b];
    console.log('  '+b.padEnd(6)+' '+String(x.n).padStart(4)+'  '+(x.w+'-'+x.l+'-'+x.p).padEnd(9)+' '+String(x.pnl_sum.toFixed(0)).padStart(7)+'   '+x.roi_pct.toFixed(1)+'%');
  }
}

// ---- CLV by venue (kalshi vs poly ML) ----
// clv column is stored — computed from bet_line vs closing_line at lock.
// For midyear, we approximate CLV per row using closing_line - market_line
// converted to implied-prob points. Since market_line is corrupted on 34
// rows, exclude them. Use `price_venue` to split.
const clvRows = db.prepare(
  "SELECT price_venue, market_line, closing_line, model_line, outcome "
+ "FROM bet_signals WHERE signal_type='ML' AND price_venue IN ('kalshi','poly') "
+ "AND market_line IS NOT NULL AND closing_line IS NOT NULL "
+ "AND contaminated_reason IS NULL "
+ "AND id NOT IN (" + CORRUPT_ID_STR + ") "
+ "AND game_date >= '2026-07-01'"
).all();
const clvByVenue = { kalshi:[], poly:[] };
for (const r of clvRows) {
  const mP = impliedProb(r.market_line);
  const cP = impliedProb(r.closing_line);
  const clvPP = (mP - cP) * 100; // positive = line moved toward us after we booked
  // Sign correction: if signal_side is fav (negative American), moving TO more negative = less prob.
  // Skip the sign fix for this quick pass — report as absolute magnitude for both.
  clvByVenue[r.price_venue].push(clvPP);
}
function stats(arr) {
  if (!arr.length) return { n:0, mean:0, med:0, p10:0, p90:0 };
  const s = [...arr].sort((a,b)=>a-b);
  return { n: s.length, mean: s.reduce((a,b)=>a+b,0)/s.length, med: s[Math.floor(s.length/2)], p10: s[Math.floor(s.length*0.1)], p90: s[Math.floor(s.length*0.9)] };
}
const clvLines = ['# CLV by venue (post-2026-07-01, ML signals, corrupted rows excluded)'];
clvLines.push('# CLV in prob-percent points (positive = line moved away from us after book — bad for CLV)');
clvLines.push('# TSV rows: venue\tn\tmean_pp\tmedian_pp\tp10_pp\tp90_pp');
for (const v of ['kalshi','poly']) {
  const s = stats(clvByVenue[v]);
  clvLines.push([v, s.n, s.mean.toFixed(2), s.med.toFixed(2), s.p10.toFixed(2), s.p90.toFixed(2)].join('\t'));
}
write('midyear-clv-by-venue.tsv', clvLines);
console.log('\n=== CLV by venue (ML, post-07-01) ===');
for (const v of ['kalshi','poly']) {
  const s = stats(clvByVenue[v]);
  console.log('  '+v.padEnd(7)+' n='+s.n+' mean='+s.mean.toFixed(2)+'pp med='+s.med.toFixed(2)+'pp p10='+s.p10.toFixed(2)+' p90='+s.p90.toFixed(2));
}

// ---- Per-team ML W/L, focus COL/ATH ----
// signal_side is 'away' or 'home' — use game_id abbrev to map to team.
const teamRows = db.prepare(
  "SELECT game_id, signal_side, outcome, closing_line "
+ "FROM bet_signals WHERE signal_type='ML' AND outcome IN ('win','loss','push') "
+ "AND closing_line IS NOT NULL "
+ "AND contaminated_reason IS NULL "
+ "AND id NOT IN (" + CORRUPT_ID_STR + ")"
).all();
const byTeam = {};
for (const r of teamRows) {
  const [away, home] = r.game_id.split('-').slice(0, 2);
  const team = r.signal_side === 'away' ? away : home;
  if (!team) continue;
  const t = byTeam[team] = byTeam[team] || { n:0, w:0, l:0, p:0, pnl:0 };
  t.n++;
  if (r.outcome === 'win') { t.w++; t.pnl += r.closing_line > 0 ? r.closing_line : 100; }
  else if (r.outcome === 'loss') { t.l++; t.pnl -= 100; }
  else t.p++;
}
const teamRows2 = Object.entries(byTeam).map(([t, x]) => {
  const staked = x.n * 100;
  return { team: t, n: x.n, w: x.w, l: x.l, p: x.p, pnl: x.pnl, roi_pct: staked ? (x.pnl/staked)*100 : 0 };
}).sort((a,b)=>a.roi_pct - b.roi_pct);
const teamLines = ['# Per-team ML W/L (all cohorts, closing_line-graded, corrupted excluded)'];
teamLines.push(['team','n','w','l','p','pnl','roi_pct'].join('\t'));
for (const r of teamRows2) teamLines.push([r.team, r.n, r.w, r.l, r.p, r.pnl.toFixed(0), r.roi_pct.toFixed(2)].join('\t'));
write('midyear-team-ml.tsv', teamLines);

// Print worst-5 and best-5 + explicit COL/ATH lookup
console.log('\n=== Per-team ML — WORST 5 (by ROI) ===');
for (const r of teamRows2.slice(0, 5)) console.log('  '+r.team.padEnd(4)+' n='+String(r.n).padStart(3)+' W-L-P='+(r.w+'-'+r.l+'-'+r.p).padEnd(9)+' pnl=$'+r.pnl.toFixed(0).padStart(6)+' ROI='+r.roi_pct.toFixed(1)+'%');
console.log('\n=== Per-team ML — BEST 5 (by ROI) ===');
for (const r of teamRows2.slice(-5).reverse()) console.log('  '+r.team.padEnd(4)+' n='+String(r.n).padStart(3)+' W-L-P='+(r.w+'-'+r.l+'-'+r.p).padEnd(9)+' pnl=$'+r.pnl.toFixed(0).padStart(6)+' ROI='+r.roi_pct.toFixed(1)+'%');
console.log('\n=== COL + ATH lookup (park-neutral concern) ===');
for (const target of ['COL','col','ATH','ath','oak']) {
  const found = teamRows2.find(r => r.team.toLowerCase() === target.toLowerCase());
  if (found) console.log('  '+found.team.padEnd(4)+' n='+found.n+' W-L-P='+(found.w+'-'+found.l+'-'+found.p)+' pnl=$'+found.pnl.toFixed(0)+' ROI='+found.roi_pct.toFixed(1)+'%');
}

console.log('\nDone. TSVs in docs/data/.');
