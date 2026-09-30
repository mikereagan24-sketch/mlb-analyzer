#!/usr/bin/env node
'use strict';
// Export one recorded trends run to the committed artifact the Trends tab
// reads (docs/trends-results-2026-09-29.json). Display only.
//
//   <node> --max-old-space-size=1536 scripts/export-trends-results.js --db <copy.db> [--run <id>] [--out <path>]
//
// Reads a database READ-ONLY (never data/mlb.db: the run is recorded on a
// scratch copy with `run-trends-backtest.js --write`, then exported from it).
// Adds the OTHER SIDE of each scenario -- the opposite bet on the same
// in-sample games -- computed with the backtest's own buildRows / summarize /
// bootRoi. It is not a separate test: the pre-registered test is two-sided
// against no-vig implied %, so the other side has the identical p-value.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const tb = require(path.join(R, 'services/trends-backtest'));
const { SCENARIOS } = require(path.join(R, 'utils/trends/scenarios'));
const { summarize, bootRoi } = tb._internals;

const arg = (k) => { const i = process.argv.indexOf(k); return i === -1 ? null : process.argv[i + 1]; };
const DB = arg('--db');
const OUT = arg('--out') || path.join(R, 'docs/trends-results-2026-09-29.json');
if (!DB) { console.error('usage: export-trends-results.js --db <copy.db> [--run <id>] [--out <path>]'); process.exit(2); }
if (path.resolve(DB) === path.resolve(R, 'data/mlb.db')) {
  console.error('refusing data/mlb.db: export from the scratch copy the run was recorded on'); process.exit(2);
}
const db = new Database(DB, { readonly: true, fileMustExist: true });
const runId = Number(arg('--run')) || db.prepare('SELECT MAX(id) id FROM trend_runs').get().id;
const run = db.prepare('SELECT * FROM trend_runs WHERE id = ?').get(runId);
if (!run) { console.error('no trend_runs row ' + runId); process.exit(1); }
const results = db.prepare('SELECT * FROM trend_results WHERE run_id = ? ORDER BY scenario_id, variant, split').all(runId);

// ---- the other side, in-sample primary, same games
const built = tb.buildRows(db);
const mlByKey = new Map();
for (const r of built.mlRows) { if (!mlByKey.has(r.key)) mlByKey.set(r.key, []); mlByKey.get(r.key).push(r); }
const totByKeyBet = new Map(built.totRows.map(r => [r.key + '|' + r.bet, r]));
const otherSide = [];
for (const s of SCENARIOS) {
  // The same selection runTrendsBacktest makes, restricted to in-sample.
  const orig = (s.kind === 'ml'
    ? built.mlRows.filter(r => s.test(r.c))
    : built.totRows.filter(r => r.bet === s.bet && s.test(r.x))).filter(r => r.split === 'in');
  const origIds = new Set(orig.map(r => r.key + '|' + (r.team || r.bet)));
  const opp = [];
  let missing = 0, bothRows = 0;
  for (const r of orig) {
    const o = s.kind === 'ml'
      ? (mlByKey.get(r.key) || []).find(x => x.team !== r.team)
      : totByKeyBet.get(r.key + '|' + (r.bet === 'over' ? 'under' : 'over'));
    if (!o) { missing++; continue; }
    if (origIds.has(o.key + '|' + (o.team || o.bet))) bothRows++;
    opp.push(o);
  }
  const st = summarize(opp);
  const [roiLo, roiHi] = bootRoi(st.prof);
  otherSide.push({
    scenario_id: s.id, bet: s.kind === 'ml' ? 'opponent ML' : (s.bet === 'over' ? 'under' : 'over'),
    this_side_bet: s.kind === 'ml' ? 'team ML' : s.bet,
    n: st.n, w: st.W, l: st.L, pushes: st.P, win_pct: st.winPct, win_lo: st.winLo, win_hi: st.winHi,
    implied_pct: st.implied, edge: st.edge, roi: st.roi, roi_lo: roiLo, roi_hi: roiHi, dollars: st.dollars,
    p_value: st.pValue, missing_opposite_rows: missing,
    both_teams_rows: bothRows, both_teams_games: bothRows / 2,
  });
}

let commit = null, dirty = null;
try {
  commit = execSync('git rev-parse HEAD', { cwd: R }).toString().trim();
  dirty = execSync('git status --porcelain --untracked-files=no', { cwd: R }).toString().trim().split('\n').filter(Boolean);
} catch (e) { /* not a checkout */ }

const artifact = {
  artifact: 'trends-results', version: 1, display_only: true,
  generated_at: new Date().toISOString(),
  generated_from_commit: commit,
  generated_with_uncommitted_tracked_changes: dirty,
  prereg_path: run.prereg_path, prereg_commit: run.prereg_commit, prereg_sha256: run.prereg_sha256,
  window_from: run.window_from, window_to: run.window_to, holdout_from: run.holdout_from,
  summary_json: run.summary_json,
  trend_run: run,
  trend_results: results,
  other_side: {
    note: 'DERIVED, NOT SEPARATELY PRE-REGISTERED. The opposite bet on the same in-sample games '
      + '(opponent moneyline; under for S30, over for S31), scored with the backtest\'s own '
      + 'buildRows / summarize / bootRoi (seed 20260929). It comes from the same two-sided test: '
      + 'against no-vig implied %, every row\'s implied becomes 1 - p and W and L swap, so z '
      + 'changes sign and the two-sided p-value is identical. ROI differs because both sides pay the vig.',
    split: 'in', variant: 'primary',
    rows: otherSide,
  },
};
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 1) + '\n');
console.log('run ' + runId + ': ' + results.length + ' trend_results rows, ' + otherSide.length
  + ' other-side rows -> ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
