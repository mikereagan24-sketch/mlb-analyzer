// Edge-vs-outcome calibration curve for bet_signals.
//
// Data-driven basis for SIGNAL_EDGE_SOFT_CAP / SIGNAL_EDGE_HARD_CAP
// (feat/edge-sanity-cap). If claimed edge tracks realized edge in the
// low buckets and decouples somewhere in the tail, the soft cap goes
// where decoupling starts and the hard cap goes where realized
// performance clearly collapses.
//
// Scale normalization: bet_signals cohorts v1..v4 stored edge_pct on
// the 0-100 percentage scale (e.g. 41 = 41pp). v5 onwards uses the
// 0-1 fraction (0.041 = 4.1pp). Normalized to fraction here so buckets
// share a scale.
//
// Also excludes v3-pretuning rows with edge > 1.0 post-normalization
// (garbage from a market_line=99900 odds-ingest bug — real signals
// don't hit 99000pp).
//
// Run: node scripts/edge-calibration-curve.js

var _schema = require('../db/schema');
var db = _schema.db;

// Cohort → scale of stored edge_pct. v1..v4 pre-cutover kept the
// human-friendly percentage form; v5 flipped to fraction to match
// getSignals' internal representation.
var PP_COHORTS = new Set(['v1','v2-tainted','v3','v3-pretuning','v4']);

function normEdge(row) {
  var raw = row.edge_pct;
  if (raw == null) return null;
  var frac = PP_COHORTS.has(row.cohort) ? raw / 100 : raw;
  return frac;
}

// Buckets in fractional pp (0.02 = 2pp, etc.)
var BUCKETS = [
  { lo: 0.00,  hi: 0.01,  label: '  <1pp   ' },
  { lo: 0.01,  hi: 0.02,  label: '  1-2pp  ' },
  { lo: 0.02,  hi: 0.04,  label: '  2-4pp  ' },
  { lo: 0.04,  hi: 0.06,  label: '  4-6pp  ' },
  { lo: 0.06,  hi: 0.10,  label: '  6-10pp ' },
  { lo: 0.10,  hi: 0.15,  label: ' 10-15pp ' },
  { lo: 0.15,  hi: 0.20,  label: ' 15-20pp ' },
  { lo: 0.20,  hi: 0.30,  label: ' 20-30pp ' },
  { lo: 0.30,  hi: 0.40,  label: ' 30-40pp ' },
  { lo: 0.40,  hi: 999,   label: '  40+pp  ' },
];

function bucketFor(edge) {
  for (var b of BUCKETS) if (edge >= b.lo && edge < b.hi) return b;
  return null;
}

// "To win $100" ROI: bet stake = max($100 to win, or $100 stake risking
// the ML). Matches services/model.calcPnl semantics used elsewhere.
function stakeFor(row) {
  if (row.signal_type === 'ML') {
    var ml = row.market_line != null ? Number(row.market_line) : null;
    if (ml == null || ml === 0) return 0;
    return ml > 0 ? (10000 / ml) : Math.abs(ml);
  }
  // Total: assume juice ~-110 → stake $110 per $100 win.
  return 110;
}

// Implied market probability (for realized-edge calc on ML). Fraction.
function impliedP(ml) {
  if (ml == null) return null;
  var m = Number(ml);
  if (isNaN(m) || m === 0) return null;
  return m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100);
}

console.log('=== Edge-vs-outcome calibration curve ===');
console.log('Source: bet_signals; scope: rows with outcome IS NOT NULL');
console.log('Normalization: v1..v4 edge_pct / 100 → fractional scale (v5+ already fractional)');
console.log('Excluded: v3-pretuning rows with normalized edge > 1.0 (data-quality garbage)\n');

var rows = db.prepare(
  "SELECT signal_type, signal_side, cohort, market_line, edge_pct, outcome, pnl, game_id, game_date "
  + "FROM bet_signals WHERE outcome IS NOT NULL AND edge_pct IS NOT NULL"
).all();
console.log('Total resolved rows:', rows.length);

var kept = [];
var garbage = 0;
for (var r of rows) {
  var e = normEdge(r);
  if (e == null) continue;
  if (e > 1.0) { garbage++; continue; }  // 100pp+ = broken
  kept.push({ row: r, edge: e });
}
console.log('Kept after normalization + garbage filter:', kept.length, '(dropped ' + garbage + ' garbage rows)');
console.log();

function emitTable(label, subset) {
  console.log('== ' + label + ' (n=' + subset.length + ') ==');
  console.log('bucket     | n    | wins | losses | push | winRate | ROI     | claimed_avg | realized_avg | Δcalib');
  console.log('-'.repeat(105));
  for (var b of BUCKETS) {
    var n = 0, w = 0, l = 0, p = 0, stake = 0, pnl = 0, sumClaim = 0, sumRealized = 0, nMl = 0;
    for (var s of subset) {
      if (s.edge < b.lo || s.edge >= b.hi) continue;
      n++;
      var out = String(s.row.outcome).toLowerCase();
      if (out === 'win')   w++;
      else if (out === 'loss') l++;
      else if (out === 'push') p++;
      var st = stakeFor(s.row);
      stake += st;
      pnl += Number(s.row.pnl) || 0;
      sumClaim += s.edge;
      if (s.row.signal_type === 'ML') {
        var imp = impliedP(s.row.market_line);
        if (imp != null) {
          // realized winning fraction of this bucket for THIS signal
          var winFrac = out === 'win' ? 1 : (out === 'push' ? 0.5 : 0);
          // For the calibration comparison we care about aggregate
          // bucket, but we compute per-signal to sum & divide.
          sumRealized += (winFrac - imp);
          nMl++;
        }
      }
    }
    if (n === 0) continue;
    var winRate = w / (w + l + p);
    var roi = stake > 0 ? (pnl / stake * 100) : 0;
    var claimAvg = sumClaim / n;
    var realizedAvg = nMl > 0 ? sumRealized / nMl : null;
    var calibDelta = realizedAvg != null ? (realizedAvg - claimAvg) : null;
    console.log(b.label + '| ' + String(n).padStart(4)
      + ' | ' + String(w).padStart(4)
      + ' | ' + String(l).padStart(6)
      + ' | ' + String(p).padStart(4)
      + ' | ' + (winRate*100).toFixed(1).padStart(6) + '%'
      + ' | ' + (roi>=0?'+':'') + roi.toFixed(1).padStart(6) + '%'
      + ' | ' + (claimAvg*100).toFixed(2).padStart(8) + 'pp'
      + ' | ' + (realizedAvg != null ? ((realizedAvg*100).toFixed(2)+'pp').padStart(9) : ' — '.padStart(11))
      + ' | ' + (calibDelta != null ? ((calibDelta*100 >= 0 ? '+' : '') + (calibDelta*100).toFixed(2) + 'pp') : ' — '));
  }
  console.log();
}

// All resolved signals combined
emitTable('ALL signals', kept);

// Split by type
emitTable('ML only', kept.filter(s => s.row.signal_type === 'ML'));
emitTable('Total only', kept.filter(s => s.row.signal_type === 'Total'));

// Split by cohort scale group so we can see if the pattern differs
emitTable('Legacy cohorts (v1..v4, percentage scale)', kept.filter(s => PP_COHORTS.has(s.row.cohort)));
emitTable('Current cohorts (v5, v6, fractional scale)', kept.filter(s => !PP_COHORTS.has(s.row.cohort)));

// KC-specific slice — the motivating case
var kc = kept.filter(s => (s.row.game_id||'').split('-').indexOf('kc') >= 0 && s.row.signal_type === 'ML');
emitTable('KC ML (motivating case: 40pp+ Apr-May cluster)', kc);

console.log('=== Threshold pick (from the curves above) ===');
console.log('Look for the bucket where realized edge stops tracking claimed edge — that is where the cap belongs.');
console.log('SOFT cap: buckets above are edge_suspect but still emitted.');
console.log('HARD cap: buckets above are suppressed entirely + audit-logged.');
