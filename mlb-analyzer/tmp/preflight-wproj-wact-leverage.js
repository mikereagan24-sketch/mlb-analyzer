'use strict';
// PRE-FLIGHT for a W_PROJ/W_ACT sweep. Answers, before any sweep runs:
//
//   1. What fraction of real lineup slots actually reach source='blend'?
//      blendWoba only blends when the player has an actuals row clearing
//      MIN_PA; otherwise it returns the projection and W_PROJ/W_ACT is a
//      NO-OP for that slot. This bounds the whole sweep.
//   2. Given that, how far does a batter's blended wOBA move across the
//      full W_PROJ range? That is the effect size in wOBA points.
//   3. Translated to team wOBA -> runs, is it big enough to move a
//      signal at all?
//
// Uses per-date woba_data_snapshot (as-of-morning; verified look-ahead
// safe) exactly as services/parameter-sweep.js does — NOT current
// woba_data.
//
// Run: <node20>/node.exe tmp/preflight-wproj-wact-leverage.js
const path = require('path');
const Database = require('better-sqlite3');
const { buildWobaIndex, getBatterWoba, getPitcherWoba } = require('../services/model');

const db = new Database(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-07';

const jobs = require('../services/jobs');
const baseSettings = jobs.getSettings();
const MIN_PA = Number(baseSettings.MIN_PA != null ? baseSettings.MIN_PA : 60);
const W_PROJ_BASE = Number(baseSettings.W_PROJ);
const W_ACT_BASE = Number(baseSettings.W_ACT);
const RUN_MULT = Number(baseSettings.RUN_MULT != null ? baseSettings.RUN_MULT : 48);
const WOBA_BASELINE = 0.320;

console.log('=== settings in play ===');
console.log('  W_PROJ=' + W_PROJ_BASE + '  W_ACT=' + W_ACT_BASE + '  MIN_PA=' + MIN_PA + '  RUN_MULT=' + RUN_MULT);
console.log('  window ' + FROM + ' .. ' + TO);
console.log('');

const snapDates = new Set(
  db.prepare('SELECT DISTINCT snapshot_date d FROM woba_data_snapshot').all().map(r => r.d)
);
const games = db.prepare(
  "SELECT game_date, game_id, away_team, home_team, away_lineup_json, home_lineup_json, "
  + "away_sp_hand, home_sp_hand "
  + "FROM game_log WHERE game_date >= ? AND game_date <= ? AND model_total IS NOT NULL "
  + "AND weather_contamination_reason IS NULL ORDER BY game_date, game_id"
).all(FROM, TO);

const loadSnap = (d) => {
  const rows = db.prepare(
    'SELECT data_key, player_name, woba, sample_size FROM woba_data_snapshot WHERE snapshot_date=?'
  ).all(d);
  return rows.length ? buildWobaIndex(rows) : null;
};

const safeJson = (s) => { try { return JSON.parse(s) || []; } catch (e) { return []; } };

// Sweep grid for the leverage measurement. Endpoints are 0.1/0.9, NOT
// 0/1: services/model.js:283-284 does `wProj || 0.65` / `wAct || 0.35`,
// so a zero weight is falsy and silently reverts to the legacy default,
// producing weights that sum to 1.65 (at W_PROJ=0) or 1.35 (at W_PROJ=1)
// and a wildly inflated wOBA. This matches BLEND_GRID in
// services/parameter-sweep.js, which avoids the endpoints for the same
// reason. See docs/blendwoba-zero-weight-open-question-2026-08-21.md
const GRID = [0.10, 0.20, 0.35, 0.45, 0.50, 0.65, 0.80, 0.90];

const cache = new Map();
const srcCount = {};
let slots = 0, gamesUsed = 0, gamesSkipped = 0;
// per-slot wOBA under each grid value, for slots that BLEND
const spread = [];       // max-min blended wOBA per blending slot
const teamDelta = [];    // per-team-game: |teamWoba(W_PROJ=0.1) - teamWoba(W_PROJ=0.9)|

for (const g of games) {
  if (!snapDates.has(g.game_date)) { gamesSkipped++; continue; }
  if (!cache.has(g.game_date)) cache.set(g.game_date, loadSnap(g.game_date));
  const idx = cache.get(g.game_date);
  if (!idx) { gamesSkipped++; continue; }
  gamesUsed++;

  for (const side of ['away', 'home']) {
    const lu = safeJson(side === 'away' ? g.away_lineup_json : g.home_lineup_json);
    const team = side === 'away' ? g.away_team : g.home_team;
    if (!lu.length) continue;
    // team wOBA at the two extremes, simple mean over slots (the model
    // PA-weights slots; a flat mean is fine for an order-of-magnitude
    // leverage bound and avoids importing the PA weight vector).
    // The batter's relevant split is the one facing the OPPOSING
    // starter's hand. getBatterWoba returns {vsLHP, vsRHP, source}.
    const oppHand = String((side === 'away' ? g.home_sp_hand : g.away_sp_hand) || 'R').toUpperCase();
    const pick = (r) => (r == null ? null : (oppHand === 'L' ? r.vsLHP : r.vsRHP));
    let sum0 = 0, sum1 = 0, n = 0;
    for (const b of lu) {
      const at0 = getBatterWoba(idx, b.name, b.hand, team, 0.1, 0.9, MIN_PA, baseSettings, null);
      const at1 = getBatterWoba(idx, b.name, b.hand, team, 0.9, 0.1, MIN_PA, baseSettings, null);
      const src = at0 && at0.source ? at0.source : 'null';
      srcCount[src] = (srcCount[src] || 0) + 1;
      slots++;
      const v0 = pick(at0), v1 = pick(at1);
      if (v0 == null || v1 == null || isNaN(v0) || isNaN(v1)) continue;
      sum0 += Number(v0); sum1 += Number(v1); n++;
      if (src === 'blend') {
        const vals = GRID.map(w => {
          const r = getBatterWoba(idx, b.name, b.hand, team, w, 1 - w, MIN_PA, baseSettings, null);
          const v = pick(r);
          return (v == null || isNaN(v)) ? null : Number(v);
        }).filter(v => v != null);
        if (vals.length) spread.push(Math.max.apply(null, vals) - Math.min.apply(null, vals));
      }
    }
    if (n) teamDelta.push(Math.abs(sum0 / n - sum1 / n));
  }
}

const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

console.log('=== 1. slot coverage ===');
console.log('  games used: ' + gamesUsed + '   skipped (no snapshot): ' + gamesSkipped);
console.log('  lineup slots evaluated: ' + slots);
const order = Object.keys(srcCount).sort((a, b) => srcCount[b] - srcCount[a]);
for (const k of order) {
  console.log('    ' + k.padEnd(10) + String(srcCount[k]).padStart(7)
    + '  (' + (100 * srcCount[k] / slots).toFixed(1) + '%)');
}
const blendPct = 100 * (srcCount.blend || 0) / slots;
console.log('  --> W_PROJ/W_ACT is a NO-OP on ' + (100 - blendPct).toFixed(1) + '% of slots');
console.log('');

console.log('=== 2. per-slot wOBA leverage (blending slots only, n=' + spread.length + ') ===');
console.log('  |max-min| wOBA across W_PROJ in [0.1,0.9]:');
console.log('    p10=' + (q(spread, .10) || 0).toFixed(4) + '  p25=' + (q(spread, .25) || 0).toFixed(4)
  + '  p50=' + (q(spread, .50) || 0).toFixed(4) + '  p75=' + (q(spread, .75) || 0).toFixed(4)
  + '  p90=' + (q(spread, .90) || 0).toFixed(4) + '  max=' + (spread.length ? Math.max.apply(null, spread).toFixed(4) : 'n/a'));
console.log('');

console.log('=== 3. team-level leverage (n=' + teamDelta.length + ' team-games) ===');
console.log('  |teamWoba(W_PROJ=0.1) - teamWoba(W_PROJ=0.9)|:');
console.log('    p50=' + (q(teamDelta, .50) || 0).toFixed(4) + '  p90=' + (q(teamDelta, .90) || 0).toFixed(4)
  + '  max=' + (teamDelta.length ? Math.max.apply(null, teamDelta).toFixed(4) : 'n/a'));
const medRuns = (q(teamDelta, .50) || 0) * RUN_MULT;
const p90Runs = (q(teamDelta, .90) || 0) * RUN_MULT;
console.log('  translated via RUN_MULT=' + RUN_MULT + ':');
console.log('    median team-game run swing across W_PROJ 0.1->0.9: ' + medRuns.toFixed(3) + ' runs');
console.log('    p90    team-game run swing across W_PROJ 0.1->0.9: ' + p90Runs.toFixed(3) + ' runs');
console.log('');
console.log('  Production sits at W_PROJ=' + W_PROJ_BASE + '. A realistic candidate move is a');
console.log('  fraction of the 0.1->0.9 span, so the per-game swing is smaller still.');
