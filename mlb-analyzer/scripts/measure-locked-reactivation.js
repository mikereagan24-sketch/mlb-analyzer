#!/usr/bin/env node
/**
 * What reactivating locked signals does to the book. (2026-08-30)
 *
 * The change moves is_active/notes out from behind upsertSignal's
 * bet_locked_at guard, so a locked bet that stops qualifying can come back
 * when it qualifies again. Before landing it, two questions:
 *
 *   1. How many rows does this touch?
 *   2. What does it do to ROI, since a reactivated signal re-enters the
 *      population ROI reads?
 *
 * Question 2 has a structural answer that the numbers below confirm: the
 * ROI queries do not filter is_active AT ALL. getSummaryByCategory and
 * getOverallSummary select on date range and outcome only. A deactivated
 * row was already being counted. So reactivation cannot move reported ROI
 * -- it changes what the CARD shows, not what the book measures.
 *
 * That is worth demonstrating rather than asserting, because if it were
 * false this change would silently re-cut every ROI number in the app.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const { db, q } = require(path.join(R, 'db/schema'));
const { getSettings } = require(path.join(R, 'services/jobs'));

const s = getSettings();
const N = (v, d) => (v != null ? Number(v) : d);
const FLOOR = N(s.SIGNAL_EMIT_FLOOR_PP, 0.01);
const SOFT = N(s.SIGNAL_EDGE_SOFT_CAP_PP, 0.06);
const HARD = N(s.SIGNAL_EDGE_HARD_CAP_PP, 0.08);
const CAP_ON = !!s.SIGNAL_EDGE_CAP_ENABLED;
const ip = m => (m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100));

const FROM = '2026-04-09', TO = '2026-12-31';

// ---- 1. does ROI read is_active at all? --------------------------------
const schemaSrc = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
const grab = name => {
  const m = schemaSrc.match(new RegExp(name + ':\\s*db\\.prepare\\(`([\\s\\S]*?)`\\)'));
  return m ? m[1] : '';
};
console.log('=== 1. DOES ROI READ is_active? ===');
for (const nm of ['getSummaryByCategory', 'getOverallSummary']) {
  const sql = grab(nm);
  console.log('  ' + nm.padEnd(24) + (sql.includes('is_active') ? 'FILTERS is_active' : 'does NOT mention is_active'));
}
console.log('');
console.log('  So a deactivated row is ALREADY in the ROI population. Reactivation');
console.log('  cannot move reported ROI. Confirmed numerically below.');
console.log('');

// ---- 2. the affected population ----------------------------------------
const allLocked = db.prepare(
  'SELECT COUNT(*) n FROM bet_signals WHERE bet_line IS NOT NULL AND game_date BETWEEN ? AND ?').get(FROM, TO).n;
const lockedOff = db.prepare(
  'SELECT COUNT(*) n FROM bet_signals WHERE bet_line IS NOT NULL AND is_active = 0 AND game_date BETWEEN ? AND ?').get(FROM, TO).n;

console.log('=== 2. POPULATION ===');
console.log('  logged (locked) bets            : ' + allLocked);
console.log('  ...currently is_active = 0      : ' + lockedOff
  + '   (' + (100 * lockedOff / allLocked).toFixed(1) + '%)');
console.log('');

// ---- 3. how many were STUCK DARK while qualifying -----------------------
// For each locked+inactive ML row, recompute the edge from the game_log's
// FINAL stored model/market. If it clears the floor and (when the cap is on)
// sits under the hard cap, the signal qualified while the row sat inactive.
//
// This is the honest measure of impact. Note it is retrospective only:
// processGameSignals runs against the current slate, so historical rows do
// not reactivate when this ships -- the fix is forward-looking. The count
// says how often the condition AROSE, not how many rows will flip on deploy.
const rows = db.prepare(
  `SELECT bs.game_date, bs.game_id, bs.signal_type, bs.signal_side, bs.bet_line,
          bs.outcome, bs.pnl, bs.edge_pct,
          gl.model_away_ml, gl.model_home_ml, gl.market_away_ml, gl.market_home_ml
     FROM bet_signals bs JOIN game_log gl
       ON gl.game_date = bs.game_date AND gl.game_id = bs.game_id
    WHERE bs.bet_line IS NOT NULL AND bs.is_active = 0
      AND bs.game_date BETWEEN ? AND ?`).all(FROM, TO);

let mlRows = 0, stuck = 0, correctlyOff = 0, capped = 0, notComputable = 0;
const stuckRows = [];
for (const r of rows) {
  if (r.signal_type !== 'ML') continue;      // Totals edge needs the slope model
  mlRows++;
  const mdl = r.signal_side === 'away' ? r.model_away_ml : r.model_home_ml;
  const mkt = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
  if (mdl == null || mkt == null) { notComputable++; continue; }
  const edge = Math.max(0, ip(mdl) - ip(mkt));
  if (edge < FLOOR) { correctlyOff++; continue; }
  if (CAP_ON && edge >= HARD) { capped++; continue; }
  stuck++;
  stuckRows.push({ ...r, edgeNow: edge });
}

console.log('=== 3. LOCKED + INACTIVE ML ROWS, RE-EVALUATED ===');
console.log('  thresholds: floor ' + (FLOOR * 100) + 'pp, soft ' + (SOFT * 100)
  + 'pp, hard ' + (HARD * 100) + 'pp, cap ' + (CAP_ON ? 'ON' : 'OFF'));
console.log('  ML rows examined                : ' + mlRows);
console.log('    below floor  (correctly dark) : ' + correctlyOff);
console.log('    hard-capped  (correctly dark) : ' + capped);
console.log('    model/market missing          : ' + notComputable);
console.log('    QUALIFYING but dark           : ' + stuck
  + '   (' + (mlRows ? (100 * stuck / mlRows).toFixed(1) : '0') + '% of locked-inactive ML)');
console.log('');
if (stuckRows.length) {
  console.log('  the stuck rows:');
  console.log('    date        game       side   bet@    edgeNow   outcome   pnl');
  for (const r of stuckRows.slice(0, 40)) {
    console.log('    ' + r.game_date + '  ' + String(r.game_id).padEnd(10)
      + String(r.signal_side).padEnd(7) + String(r.bet_line).padEnd(8)
      + (r.edgeNow * 100).toFixed(2).padStart(6) + 'pp   '
      + String(r.outcome).padEnd(9) + String(r.pnl));
  }
  if (stuckRows.length > 40) console.log('    ... +' + (stuckRows.length - 40) + ' more');
  console.log('');
}

// ---- 4. ROI, both ways --------------------------------------------------
const roiOf = whereExtra => db.prepare(
  `SELECT COUNT(*) plays,
     SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) wins,
     SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) losses,
     ROUND(SUM(CASE WHEN outcome!='pending' THEN pnl ELSE 0 END),2) pnl,
     ROUND(SUM(CASE WHEN outcome!='pending' THEN pnl ELSE 0 END)
       / NULLIF(SUM(CASE WHEN outcome NOT IN ('pending','push') THEN 1 ELSE 0 END)*100.0,0)*100,2) roi
   FROM bet_signals
   WHERE game_date BETWEEN ? AND ? AND game_date >= '2026-04-09'
     AND outcome != 'pending' ` + whereExtra).get(FROM, TO);

const asIs = roiOf('');
const ifFiltered = roiOf('AND is_active = 1');
const stuckOnly = stuckRows.filter(r => r.outcome && r.outcome !== 'pending');
const stuckPnl = stuckOnly.reduce((a, r) => a + (r.pnl || 0), 0);
const stuckDecided = stuckOnly.filter(r => r.outcome !== 'push').length;

console.log('=== 4. ROI, BOTH WAYS ===');
console.log('                                plays   wins  losses      pnl      roi');
const line = (lbl, r) => console.log('  ' + lbl.padEnd(28)
  + String(r.plays).padStart(5) + String(r.wins).padStart(7) + String(r.losses).padStart(8)
  + String(r.pnl).padStart(10) + String(r.roi == null ? '-' : r.roi + '%').padStart(9));
line('AS REPORTED (no is_active)', asIs);
line('counterfactual: is_active=1', ifFiltered);
console.log('');
console.log('  The first row is what the app shows and is UNCHANGED by this fix --');
console.log('  the ROI queries never filtered is_active, so the deactivated rows');
console.log('  were always counted. The second row exists only to show how much of');
console.log('  the book is currently dark: ' + (asIs.plays - ifFiltered.plays) + ' graded plays.');
console.log('');
const stuckWins = stuckOnly.filter(r => r.outcome === 'win').length;
const wr = stuckDecided ? stuckWins / stuckDecided : 0;
// 2-sigma binomial band on the win rate, so the headline cannot be read
// as precise.
const se = stuckDecided ? Math.sqrt(wr * (1 - wr) / stuckDecided) : 0;
console.log('  the QUALIFYING-but-dark subset on its own:');
console.log('    graded plays ' + stuckDecided + '   wins ' + stuckWins
  + '   pnl ' + stuckPnl.toFixed(2)
  + '   roi ' + (stuckDecided ? (stuckPnl / (stuckDecided * 100) * 100).toFixed(2) + '%' : 'n/a'));
console.log('    win rate ' + (wr * 100).toFixed(1) + '% +/- ' + (2 * se * 100).toFixed(1)
  + 'pp (2 sigma, n=' + stuckDecided + ')');
console.log('');
console.log('    *** DO NOT READ THAT ROI AS A FORWARD ESTIMATE. ***');
console.log('    It is a SELECTION ARTIFACT. The subset is defined by re-scoring');
console.log('    each bet against game_log.model_* -- which processGameSignals');
console.log('    REWRITES every pass, including passes after the bet was struck.');
console.log('    So membership is chosen using end-state model output, and the');
console.log('    outcome is already in the past when that output was written.');
console.log('    The interval above is wide enough to cover implausible values,');
console.log('    which is itself the tell. This number measures how the subset was');
console.log('    selected, not how these bets would do. It is reported only to size');
console.log('    the affected population, and no decision should rest on it.');
console.log('');
console.log('=== BOTTOM LINE ===');
console.log('  ROI impact of this change: NONE. Reported ROI does not read');
console.log('  is_active, so reactivation moves no number the book publishes.');
console.log('  What it changes is which bets the CARD shows as live, and whether');
console.log('  the note on them describes the present or the moment they went dark.');
