'use strict';

// Cell-migration quantification for the spread-edge cell index.
//
// For every graded game currently in the buildCellIndex universe
// (game_log rows with home_score, away_score, model_*_ml, model_total
// populated, and no weather contamination):
//   1. Compute CURRENT cell using current game_log.model_* values.
//   2. Reconstruct EMIT-TIME cell where bet_signals gives us a
//      frozen ML side (signal_side='home' or 'away' with signal_type='ML')
//      and/or a Total signal_line.
//   3. Compare buckets. Report:
//      - # games with emit-time reference (any / total-only / wp-only / both)
//      - # games where current cell ≠ emit-time cell
//      - Breakdown by which dimension flipped
//
// Also boundary sensitivity: how many games sit within a few points of
// the hardcoded 0.500/0.575 wp cuts or the 8.5 total cut. Those are the
// ones that migrate on the smallest model shift.
//
// Emit-time wp reconstruction from ONE side's ML:
//   home ML known → emit_wp ≈ americanToProb(home_ml_at_emit)
//   away ML known → emit_wp ≈ 1 − americanToProb(away_ml_at_emit)
// The model's paired probs sum to ~1.009 on average (rounding overround),
// so this approximation is ±0.005. Small compared to bucket bandwidth
// (0.500→0.575 = 7.5pp wide).
//
// Local db is stale on tagging vs prod; the same manual contamination
// exclusions (naive-hour, ath-vegas, ath-coliseum) used in prior
// analyses are applied here so the numbers are prod-comparable.

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

const NON_ET = new Set(['COL','ARI','LAD','LAA','SD','SF','SEA','ATH','CHC','CWS','MIL','MIN','STL','HOU','TEX','KC']);
function isNaiveHour(r){ return r.game_date < '2026-07-30' && NON_ET.has((r.home_team||'').toUpperCase()); }
function isAthVegas(r){ return r.game_date >= '2026-06-08' && r.game_date <= '2026-06-14' && (r.home_team||'').toUpperCase() === 'ATH' && r.venue_id === 5355; }
function isAthColiseum(r){ return r.game_date < '2026-07-27' && (r.home_team||'').toUpperCase() === 'ATH' && !isAthVegas(r); }
function americanToProb(ml){ if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return null; return ml > 0 ? 100/(ml+100) : -ml/(-ml+100); }
function noVigHomeProb(h, a){ const pH = americanToProb(h), pA = americanToProb(a); if (pH == null || pA == null) return null; const s = pH + pA; return s > 0 ? pH/s : null; }

const WP_BALANCED_LOW = 0.500;
const WP_HIGH = 0.575;
const TOTAL_THRESHOLD = 8.5;
function wpBucket(wp) { return wp < WP_BALANCED_LOW ? 'Underdog home' : wp < WP_HIGH ? 'Balanced' : 'Strong fav'; }
function totBucket(t) { return t < TOTAL_THRESHOLD ? 'Low total' : 'High total'; }
function cellLabel(wp, t) { return wpBucket(wp) + ' / ' + totBucket(t); }

// ----- Pull the buildCellIndex universe (same filter as prod, plus manual contamination proxy).
const games = db.prepare(
    "SELECT g.game_date, g.game_id, g.home_team, g.venue_id, "
  + "  g.model_home_ml, g.model_away_ml, g.model_total, "
  + "  g.home_score, g.away_score, g.weather_contamination_reason "
  + "FROM game_log g "
  + "WHERE g.home_score IS NOT NULL AND g.away_score IS NOT NULL "
  + "  AND g.model_home_ml IS NOT NULL AND g.model_away_ml IS NOT NULL "
  + "  AND g.model_total IS NOT NULL "
  + "  AND g.weather_contamination_reason IS NULL"
).all();
const clean = games.filter(r => !isNaiveHour(r) && !isAthVegas(r) && !isAthColiseum(r));
console.log('Games in current cell index (prod-equivalent filter): ' + clean.length);

// ----- Fetch bet_signals for these games: home/away ML + Total per game.
const sigStmt = db.prepare(
    "SELECT signal_type, signal_side, model_line FROM bet_signals "
  + "WHERE game_date=? AND game_id=? AND signal_type IN ('ML','Total') "
  + "  AND model_line IS NOT NULL AND cohort IN ('v6','v7')"
);

let bucket = {
  bothRef: 0, mlRef: 0, totRef: 0, noRef: 0,
  cellsSame: 0, cellsDiff: 0,
  wpFlip: 0, totFlip: 0, bothFlip: 0,
  driftedGames: [],
};
// Boundary sensitivity (current values)
let nearWp500 = 0, nearWp575 = 0, nearTot85 = 0;
const NEAR_WP = 0.02;   // 2 percentage points
const NEAR_TOT = 0.25;  // quarter of a run

for (const g of clean) {
  const curWp = noVigHomeProb(g.model_home_ml, g.model_away_ml);
  const curTot = g.model_total;
  if (curWp == null) continue;
  const curCell = cellLabel(curWp, curTot);

  // Boundary sensitivity — current-value proximity
  if (Math.abs(curWp - WP_BALANCED_LOW) < NEAR_WP) nearWp500++;
  if (Math.abs(curWp - WP_HIGH) < NEAR_WP) nearWp575++;
  if (Math.abs(curTot - TOTAL_THRESHOLD) < NEAR_TOT) nearTot85++;

  // Emit-time reconstruction from bet_signals
  const sigs = sigStmt.all(g.game_date, g.game_id);
  let emitWp = null, emitTot = null;
  for (const s of sigs) {
    if (s.signal_type === 'ML' && s.signal_side === 'home') {
      const p = americanToProb(s.model_line);
      if (p != null) emitWp = p;         // approx (paired probs sum ~1.009)
    } else if (s.signal_type === 'ML' && s.signal_side === 'away') {
      const p = americanToProb(s.model_line);
      if (p != null) emitWp = 1 - p;
    } else if (s.signal_type === 'Total') {
      emitTot = s.model_line;
    }
  }
  const hasML = emitWp != null;
  const hasTot = emitTot != null;
  if (hasML && hasTot) bucket.bothRef++;
  else if (hasML) bucket.mlRef++;
  else if (hasTot) bucket.totRef++;
  else { bucket.noRef++; continue; }

  // For dimensions we don't have emit for, assume current value → cell match on that axis.
  const useWp = hasML ? emitWp : curWp;
  const useTot = hasTot ? emitTot : curTot;
  const emitCell = cellLabel(useWp, useTot);
  const wpFlipped = wpBucket(useWp) !== wpBucket(curWp);
  const totFlipped = totBucket(useTot) !== totBucket(curTot);

  if (emitCell === curCell) {
    bucket.cellsSame++;
  } else {
    bucket.cellsDiff++;
    if (wpFlipped && totFlipped) bucket.bothFlip++;
    else if (wpFlipped) bucket.wpFlip++;
    else bucket.totFlip++;
    bucket.driftedGames.push({
      game_date: g.game_date, game_id: g.game_id,
      emit: emitCell, cur: curCell,
      emit_wp: useWp.toFixed(4), cur_wp: curWp.toFixed(4),
      emit_tot: useTot, cur_tot: curTot,
      ref: hasML && hasTot ? 'both' : hasML ? 'ml_only' : 'tot_only',
    });
  }
}

console.log('\n=== Reference availability ===');
console.log('  Both ML + Total emit-frozen:  ' + bucket.bothRef);
console.log('  ML only:                       ' + bucket.mlRef);
console.log('  Total only:                    ' + bucket.totRef);
console.log('  No emit reference (no signals): ' + bucket.noRef);
const refTotal = bucket.bothRef + bucket.mlRef + bucket.totRef;
console.log('  Sub-total with any reference:  ' + refTotal + ' of ' + clean.length + ' (' + (100 * refTotal / clean.length).toFixed(1) + '%)');

console.log('\n=== Cell migration (games with any emit reference) ===');
console.log('  Cell unchanged: ' + bucket.cellsSame);
console.log('  Cell changed:   ' + bucket.cellsDiff
  + '  (' + (100 * bucket.cellsDiff / refTotal).toFixed(1) + '% of reference set)');
console.log('    ...of which:');
console.log('    wp bucket flipped only:   ' + bucket.wpFlip);
console.log('    total bucket flipped only:' + bucket.totFlip);
console.log('    both flipped:              ' + bucket.bothFlip);

console.log('\n=== Boundary proximity (current values, whole clean set) ===');
console.log('  Within ±' + NEAR_WP + ' of wp 0.500:  ' + nearWp500 + '  (' + (100 * nearWp500 / clean.length).toFixed(1) + '%)');
console.log('  Within ±' + NEAR_WP + ' of wp 0.575:  ' + nearWp575 + '  (' + (100 * nearWp575 / clean.length).toFixed(1) + '%)');
console.log('  Within ±' + NEAR_TOT + ' of total 8.5: ' + nearTot85 + '  (' + (100 * nearTot85 / clean.length).toFixed(1) + '%)');
console.log('  Also computing a tighter band:');
for (const w of [0.005, 0.01, 0.015]) {
  let n500 = 0, n575 = 0;
  for (const g of clean) {
    const wp = noVigHomeProb(g.model_home_ml, g.model_away_ml);
    if (wp == null) continue;
    if (Math.abs(wp - 0.500) < w) n500++;
    if (Math.abs(wp - 0.575) < w) n575++;
  }
  console.log('  Within ±' + w + ' of wp 0.500:  ' + n500 + '  (' + (100 * n500 / clean.length).toFixed(1) + '%)');
  console.log('  Within ±' + w + ' of wp 0.575:  ' + n575 + '  (' + (100 * n575 / clean.length).toFixed(1) + '%)');
}
for (const t of [0.05, 0.10, 0.15]) {
  let nT = 0;
  for (const g of clean) if (Math.abs(g.model_total - 8.5) < t) nT++;
  console.log('  Within ±' + t + ' of total 8.5: ' + nT + '  (' + (100 * nT / clean.length).toFixed(1) + '%)');
}

console.log('\n=== Sample of drifted games (first 15) ===');
for (const g of bucket.driftedGames.slice(0, 15)) {
  console.log('  ' + g.game_date + ' ' + g.game_id
    + ' emit=[' + g.emit + '] cur=[' + g.cur + ']'
    + ' | wp: ' + g.emit_wp + '→' + g.cur_wp
    + ' | tot: ' + g.emit_tot + '→' + g.cur_tot
    + ' | ref=' + g.ref);
}
