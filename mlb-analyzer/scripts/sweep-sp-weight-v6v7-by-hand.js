#!/usr/bin/env node
'use strict';

// SP_WEIGHT sweep, restricted to v6/v7 cohorts, split by opposing-SP hand.
//
// Companion to sweep-sp-weight-rolling-cv-by-hand.js. Fixes two problems
// with the earlier hand-split sweep:
//   1. Universe spanned 2026-04-09 → 2026-07-22 (v1-v7 mixed). April
//      had SP_PIT_WEIGHT=0.62 across all games (docs/sp-forecast-ip-
//      blast-radius-2026-07-26.md). v6→v7 stack changed materially:
//      park-neutral inputs, edge caps, opener detection, RUN_MULT 46,
//      venue-aware pricing (v7 only). Fitting on one model and testing
//      on another was baked in.
//   2. 47% of signals fell into 'Unknown' SP-hand bucket because
//      team_rosters name-join missed pitchers. Added team_rosters_season
//      fallback + abbreviation lookup (first-initial + last-name unique
//      match, same pattern as services/jobs.js forecastForPitcher).
//
// Universe restriction:
//   v6: game_date 2026-05-29 → 2026-07-05
//   v7: game_date 2026-07-06 → 2026-07-22
//   Excluded v7 sub-cohort dates: {2026-07-06, 2026-07-07, 2026-07-10,
//     2026-07-11} — v7 birth + early venue-aware transition + known
//     unclean days (per V7_EXCL in earlier sweep).
//
// Report structure (per cohort, per hand):
//   n, test ROI, bootstrap 95% CI (1000 resamples).
//   NO ROLLING-CV: v7 window (17 days minus 4 excluded = 13 days) is too
//   thin. v6 window (~38 days) could support a small fit/test split but
//   the honest report is single-window per cohort with wide CIs.
//
// The user's n<200 rule: if n<200 for a hand-subset, we ALWAYS
// report the bootstrap CI alongside the point estimate. Direction
// claims require CI-informed reading, not point estimates.
//
// USAGE: node scripts/sweep-sp-weight-v6v7-by-hand.js
// Output: docs/data/sweep-sp-weight-v6v7-by-hand.tsv

var fs = require('fs');
var path = require('path');
var q_db  = require('../db/schema');
var q     = q_db.q;
var db    = q_db.db;
var model = require('../services/model');
var jobs  = require('../services/jobs');

var OUT_DIR = path.join(__dirname, '..', 'docs', 'data');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

var SNAP_TS = db.prepare("SELECT datetime('now') n").get().n;
console.log('DB snapshot: ' + SNAP_TS + ' UTC');
console.log('SP_WEIGHT sweep — v6/v7 restricted, hand-split, single-window per cohort');
console.log('');

// V7 excluded dates: birth-days and early transition; keeping 2026-07-08+
var V7_EXCL = ['2026-07-06','2026-07-07','2026-07-10','2026-07-11'];

// === Three-stage SP-hand lookup ===
// (1) team_rosters exact match; (2) team_rosters_season exact match;
// (3) abbreviation fallback (first-initial + last, uniquely matched
// against roster entries). Same pattern as services/jobs.js
// forecastForPitcher (2000-2026).
var handByName = {};  // populated first from team_rosters
db.prepare("SELECT DISTINCT player_name, hand FROM team_rosters WHERE role IN ('SP','RP') AND hand IN ('R','L')").all().forEach(function (r) {
  handByName[r.player_name] = r.hand;
});
var t1 = Object.keys(handByName).length;
console.log('Stage 1 (team_rosters):        ' + t1 + ' pitcher names resolved');

// Fallback: team_rosters_season for names not yet resolved
db.prepare("SELECT DISTINCT player_name, hand FROM team_rosters_season WHERE role IN ('SP','RP') AND hand IN ('R','L')").all().forEach(function (r) {
  if (!handByName[r.player_name]) handByName[r.player_name] = r.hand;
});
var t2 = Object.keys(handByName).length;
console.log('Stage 2 (+team_rosters_season): ' + t2 + ' resolved (+' + (t2 - t1) + ')');

// Prebuild an abbreviation index: initial + last-name → [{ fullName, hand }, ...]
// Only entries with role SP/RP considered. Used for stage 3.
var abbrevIdx = {};  // key = firstInitial + '|' + lastName-lower
db.prepare("SELECT DISTINCT player_name, hand FROM team_rosters_season WHERE role IN ('SP','RP') AND hand IN ('R','L')").all().forEach(function (r) {
  var parts = r.player_name.split(/\s+/);
  if (parts.length < 2) return;
  var initial = parts[0][0].toUpperCase();
  var last = parts[parts.length - 1].toLowerCase();
  var key = initial + '|' + last;
  if (!abbrevIdx[key]) abbrevIdx[key] = [];
  abbrevIdx[key].push({ fullName: r.player_name, hand: r.hand });
});

// Stage-3 lookup wrapper. Resolves 'C. Sanchez' → Cristopher Sanchez
// (or similar) when unambiguous within the season roster.
function resolveHand(spName) {
  if (!spName) return 'U';
  if (handByName[spName]) return handByName[spName];
  // Abbreviation pattern: single-letter initial + '.', then last name
  var m = spName.match(/^([A-Z])\.?\s+(.+)$/);
  if (m) {
    var initial = m[1];
    var last = m[2].split(/\s+/).pop().toLowerCase();
    var key = initial + '|' + last;
    var cands = abbrevIdx[key] || [];
    if (cands.length === 1) return cands[0].hand;
    // ambiguous → give up (safer than guessing)
  }
  return 'U';
}

// Warm the resolver's cache by resolving every SP name once
var allSpNames = db.prepare(
  "SELECT DISTINCT away_sp AS n FROM game_log WHERE game_date >= '2026-05-29' AND away_sp IS NOT NULL " +
  "UNION SELECT DISTINCT home_sp FROM game_log WHERE game_date >= '2026-05-29' AND home_sp IS NOT NULL"
).all().map(function (r) { return r.n; });
var stage3Adds = 0;
allSpNames.forEach(function (n) {
  if (!handByName[n]) {
    var h = resolveHand(n);
    if (h !== 'U') { handByName[n] = h; stage3Adds++; }
  }
});
console.log('Stage 3 (abbreviation fallback): +' + stage3Adds + ' resolved');
console.log('Total resolved: ' + Object.keys(handByName).length + ' pitcher names');

// Resolution rate check on v6+v7 SPs
var totalDistinct = allSpNames.length;
var stillMissing = allSpNames.filter(function (n) { return !handByName[n]; });
console.log('v6+v7 distinct SPs: ' + totalDistinct + ', still missing: ' + stillMissing.length + ' (' + (100 * stillMissing.length / totalDistinct).toFixed(1) + '%)');
if (stillMissing.length > 0 && stillMissing.length <= 25) {
  console.log('  missing names: ' + stillMissing.join(', '));
}
console.log('');

// === Cohort universes ===
var v6Sigs = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, bs.market_line, bs.closing_line, bs.outcome AS bs_outcome " +
  "FROM bet_signals bs " +
  "WHERE bs.signal_type='ML' AND bs.outcome IN ('win','loss','push') " +
  "  AND bs.closing_line IS NOT NULL " +
  "  AND bs.cohort='v6' " +
  "  AND bs.contaminated_reason IS NULL " +
  "  AND NOT ((bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) " +
  "        OR (bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) " +
  "        OR (bs.market_line > 100 AND bs.closing_line < 0) " +
  "        OR (bs.market_line < -100 AND bs.closing_line > 0))"
).all();
var v7Sigs = db.prepare(
  "SELECT bs.id, bs.game_date, bs.game_id, bs.signal_side, bs.market_line, bs.closing_line, bs.outcome AS bs_outcome " +
  "FROM bet_signals bs " +
  "WHERE bs.signal_type='ML' AND bs.outcome IN ('win','loss','push') " +
  "  AND bs.closing_line IS NOT NULL " +
  "  AND bs.cohort='v7' " +
  "  AND bs.contaminated_reason IS NULL " +
  "  AND NOT ((bs.market_line > 0 AND bs.closing_line > 0 AND ABS(bs.market_line - bs.closing_line) >= 30) " +
  "        OR (bs.market_line < 0 AND bs.closing_line < 0 AND ABS(bs.market_line - bs.closing_line) >= 30) " +
  "        OR (bs.market_line > 100 AND bs.closing_line < 0) " +
  "        OR (bs.market_line < -100 AND bs.closing_line > 0))"
).all().filter(function (s) { return V7_EXCL.indexOf(s.game_date) === -1; });

console.log('=== COHORT UNIVERSES ===');
console.log('v6: ' + v6Sigs.length + ' signals, ' + (v6Sigs[0] ? v6Sigs[0].game_date : '?') + ' → ' + (v6Sigs[v6Sigs.length-1] ? v6Sigs[v6Sigs.length-1].game_date : '?'));
console.log('v7 (excl birth/transition days): ' + v7Sigs.length + ' signals, ' + (v7Sigs[0] ? v7Sigs[0].game_date : '?') + ' → ' + (v7Sigs[v7Sigs.length-1] ? v7Sigs[v7Sigs.length-1].game_date : '?'));
console.log('');

// === Model plumbing (identical to earlier sweeps) ===
var base = jobs.getSettings();
var wobaIdx = jobs.getWobaIndex();
var PIN_HARD_CAP = 0.08;

function impliedP(ml) { return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

var builtCache = {};
function buildGame(gameRow) {
  var k = gameRow.game_date + '|' + gameRow.game_id;
  if (builtCache[k]) return builtCache[k];
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '', homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '', homeSp = gameRow.home_sp || '';
  var wProj = base.W_PROJ != null ? base.W_PROJ : 0.65;
  var wAct  = base.W_ACT  != null ? base.W_ACT  : 0.35;
  var bpSR  = base.BP_STRONG_WEIGHT_R != null ? base.BP_STRONG_WEIGHT_R : 0.55;
  var bpWR  = base.BP_WEAK_WEIGHT_R   != null ? base.BP_WEAK_WEIGHT_R   : 0.45;
  var bpSL  = base.BP_STRONG_WEIGHT_L != null ? base.BP_STRONG_WEIGHT_L : 0.35;
  var bpWL  = base.BP_WEAK_WEIGHT_L   != null ? base.BP_WEAK_WEIGHT_L   : 0.65;
  var LEAGUE_BP = 0.318;
  var awayVsR = LEAGUE_BP, awayVsL = LEAGUE_BP, homeVsR = LEAGUE_BP, homeVsL = LEAGUE_BP;
  var awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      var hLU = tryParse(gameRow.home_lineup_json) || [];
      var aLU = tryParse(gameRow.away_lineup_json) || [];
      var aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, hLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      var hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, aLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) { /* ignore */ }
  var built = Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
  });
  builtCache[k] = built;
  return built;
}

var gameLogCache = {};
function loadGameLog(gd, gid) {
  var k = gd + '|' + gid;
  if (gameLogCache[k]) return gameLogCache[k];
  var row = db.prepare("SELECT * FROM game_log WHERE game_date=? AND game_id=?").get(gd, gid);
  gameLogCache[k] = row || null;
  return row;
}

function pnlFromOutcome(outcome, closingLine) {
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -100;
  return closingLine > 0 ? closingLine : 100;
}

var modelCache = {};
function runForCandidate(sig, spW) {
  var k = sig.game_date + '|' + sig.game_id + '|' + spW;
  if (modelCache[k]) return modelCache[k];
  var gRow = loadGameLog(sig.game_date, sig.game_id);
  if (!gRow || gRow.away_score == null) { modelCache[k] = null; return null; }
  var s = Object.assign({}, base, { SP_WEIGHT: spW, RELIEF_WEIGHT: +(1 - spW).toFixed(4) });
  try {
    var built = buildGame(gRow);
    var mr = model.runModel(built, wobaIdx, s, 'standard', true);
    modelCache[k] = mr;
    return mr;
  } catch (e) { modelCache[k] = null; return null; }
}

function scorePool(pool, spW) {
  var kept = [];
  var SOFT = base.SIGNAL_EMIT_FLOOR_PP != null ? Number(base.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  var HARD = PIN_HARD_CAP;
  for (var i = 0; i < pool.length; i++) {
    var sig = pool[i];
    var mr = runForCandidate(sig, spW);
    if (!mr || mr.aML == null || mr.hML == null) continue;
    var newML = sig.signal_side === 'away' ? mr.aML : mr.hML;
    var newP = impliedP(newML);
    var closeP = impliedP(sig.closing_line);
    var newEdge = newP - closeP;
    if (newEdge < SOFT) continue;
    if (newEdge >= HARD) continue;
    var gRow = loadGameLog(sig.game_date, sig.game_id);
    // Opposing SP: batter faces the OTHER team's SP
    var oppSp = sig.signal_side === 'away' ? gRow.home_sp : gRow.away_sp;
    kept.push({
      pnl: pnlFromOutcome(sig.bs_outcome, sig.closing_line),
      edge_pp: newEdge * 100,
      opp_sp_hand: handByName[oppSp] || resolveHand(oppSp),
    });
  }
  return kept;
}

function roi(kept) {
  if (kept.length === 0) return 0;
  var pnl = 0;
  for (var i = 0; i < kept.length; i++) pnl += kept[i].pnl;
  return (pnl / (kept.length * 100)) * 100;
}

function bootstrapCI(kept, N) {
  if (kept.length < 2) return { lo: NaN, hi: NaN };
  var samples = [];
  for (var b = 0; b < N; b++) {
    var pnl = 0;
    for (var i = 0; i < kept.length; i++) {
      var idx = Math.floor(Math.random() * kept.length);
      pnl += kept[idx].pnl;
    }
    samples.push((pnl / (kept.length * 100)) * 100);
  }
  samples.sort(function (a, b) { return a - b; });
  return { lo: samples[Math.floor(N * 0.025)], hi: samples[Math.floor(N * 0.975)] };
}

var SP_WEIGHT_GRID = [0.60, 0.65, 0.70, 0.72, 0.75, 0.77, 0.80, 0.83, 0.85, 0.90];
var BASELINE_SP = 0.80;
var BOOT_N = 1000;

var COHORTS = [
  { name: 'v7',    pool: v7Sigs },
  { name: 'v6',    pool: v6Sigs },
  { name: 'v6+v7', pool: v6Sigs.concat(v7Sigs) },
];

var results = [];  // one row per (cohort × candidate × hand)

console.log('=== SCORING ===');
for (var wi = 0; wi < SP_WEIGHT_GRID.length; wi++) {
  var spW = SP_WEIGHT_GRID[wi];
  process.stdout.write('SP_WEIGHT=' + spW.toFixed(2) + ' scoring...');
  for (var ci = 0; ci < COHORTS.length; ci++) {
    var c = COHORTS[ci];
    var kept = scorePool(c.pool, spW);
    ['R', 'L', 'U'].forEach(function (h) {
      var subset = kept.filter(function (x) { return x.opp_sp_hand === h; });
      var subRoi = roi(subset);
      var subCI  = bootstrapCI(subset, BOOT_N);
      results.push({
        cohort: c.name, spW: spW, hand: h,
        n: subset.length, roi: subRoi,
        ci_lo: subCI.lo, ci_hi: subCI.hi,
      });
    });
    process.stdout.write(' ' + c.name);
  }
  process.stdout.write(' done\n');
}
console.log('');

// === Report ===
for (var ci2 = 0; ci2 < COHORTS.length; ci2++) {
  var c = COHORTS[ci2];
  console.log('');
  console.log('=== COHORT ' + c.name + ' (' + c.pool.length + ' signals) ===');
  ['R', 'L', 'U'].forEach(function (h) {
    var label = h === 'R' ? 'R-facing (batters face RHP starter)'
              : h === 'L' ? 'L-facing (batters face LHP starter)'
                          : 'Unknown SP hand';
    console.log('');
    console.log('  ' + label + ':');
    console.log('    SP_WT | n | ROI              [bootstrap 95% CI]');
    for (var wi2 = 0; wi2 < SP_WEIGHT_GRID.length; wi2++) {
      var spW = SP_WEIGHT_GRID[wi2];
      var r = results.find(function (x) { return x.cohort === c.name && x.spW === spW && x.hand === h; });
      if (!r) continue;
      var isBase = spW === BASELINE_SP ? ' *' : '  ';
      var ciStr = isNaN(r.ci_lo) ? 'CI: n/a (n<2)'
        : '[' + ((r.ci_lo >= 0 ? '+' : '') + r.ci_lo.toFixed(2)).padStart(7) + '%,'
        + ((r.ci_hi >= 0 ? '+' : '') + r.ci_hi.toFixed(2)).padStart(7) + '%]';
      var flag = (r.n > 0 && r.n < 30) ? ' [thin]' : '';
      console.log('    ' + spW.toFixed(2) + isBase + '  ' + String(r.n).padStart(3) + '  '
        + ((r.roi >= 0 ? '+' : '') + r.roi.toFixed(2)).padStart(7) + '%  ' + ciStr + flag);
    }
  });
}
console.log('');

// Direction summary — but honest about CI overlap
console.log('=== DIRECTION SUMMARY (v7 primary — current model stack) ===');
['R', 'L'].forEach(function (h) {
  var below = [], above = [];
  var baseRow = results.find(function (r) { return r.cohort === 'v7' && r.spW === BASELINE_SP && r.hand === h; });
  SP_WEIGHT_GRID.forEach(function (spW) {
    var r = results.find(function (x) { return x.cohort === 'v7' && x.spW === spW && x.hand === h; });
    if (spW < BASELINE_SP) below.push(r);
    else if (spW > BASELINE_SP) above.push(r);
  });
  // Weighted mean by n
  function wmean(arr) {
    var totN = arr.reduce(function (a, r) { return a + r.n; }, 0);
    if (totN === 0) return NaN;
    return arr.reduce(function (a, r) { return a + r.roi * r.n; }, 0) / totN;
  }
  var bMean = wmean(below);
  var aMean = wmean(above);
  // Is baseline CI overlapping with the "best" non-baseline candidate?
  var candidates = below.concat(above);
  var best = null;
  candidates.forEach(function (r) { if (r.n >= 20 && (!best || r.roi > best.roi)) best = r; });
  var label = h === 'R' ? 'R-facing' : 'L-facing';
  console.log('  ' + label + ' (v7): mean below-baseline ' + (isNaN(bMean) ? 'n/a' : (bMean >= 0 ? '+' : '') + bMean.toFixed(2) + '%')
    + ', mean above-baseline ' + (isNaN(aMean) ? 'n/a' : (aMean >= 0 ? '+' : '') + aMean.toFixed(2) + '%'));
  if (best && baseRow && !isNaN(best.ci_lo) && !isNaN(baseRow.ci_hi)) {
    var overlap = (best.ci_lo <= baseRow.roi && baseRow.roi <= best.ci_hi) || (baseRow.ci_lo <= best.roi && best.roi <= baseRow.ci_hi);
    console.log('    Best-candidate SP_WEIGHT=' + best.spW.toFixed(2) + ' (n=' + best.n + ', ROI ' + (best.roi >= 0 ? '+' : '') + best.roi.toFixed(2) + '%)');
    console.log('    Baseline SP_WEIGHT=0.80 (n=' + baseRow.n + ', ROI ' + (baseRow.roi >= 0 ? '+' : '') + baseRow.roi.toFixed(2) + '%)');
    console.log('    CI overlap: ' + (overlap ? 'YES — best NOT distinguishable from baseline at 95%' : 'NO — best distinguishable from baseline'));
  }
});
console.log('');

// Sample-size honesty box
console.log('=== SAMPLE-SIZE HONESTY (v7) ===');
var v7Sample = results.filter(function (r) { return r.cohort === 'v7'; });
var v7R = v7Sample.find(function (r) { return r.spW === BASELINE_SP && r.hand === 'R'; });
var v7L = v7Sample.find(function (r) { return r.spW === BASELINE_SP && r.hand === 'L'; });
var v7U = v7Sample.find(function (r) { return r.spW === BASELINE_SP && r.hand === 'U'; });
console.log('  At baseline SP_WEIGHT=0.80: R-facing n=' + (v7R?v7R.n:'n/a') + ', L-facing n=' + (v7L?v7L.n:'n/a') + ', Unknown n=' + (v7U?v7U.n:'n/a'));
console.log('  All hand-subsets in v7 have n<200 → the user\'s n<200 rule applies.');
console.log('  Bootstrap CIs are reported above alongside every point estimate.');
console.log('  DO NOT read direction from point estimates alone; check CI overlap first.');
console.log('  Rolling-CV is NOT reported because v7 window (13 days incl-excl) is too thin');
console.log('  for a meaningful fit/test split. Single-window ROI with CI is the honest report.');
console.log('');

// TSV
var lines = ['# SP_WEIGHT sweep, v6/v7 cohorts, hand-split, single-window per cohort'];
lines.push(['cohort','sp_weight','opp_sp_hand','n','roi','ci_lo','ci_hi'].join('\t'));
for (var ri = 0; ri < results.length; ri++) {
  var r = results[ri];
  lines.push([r.cohort, r.spW.toFixed(2), r.hand, r.n, r.roi.toFixed(2), isNaN(r.ci_lo)?'':r.ci_lo.toFixed(2), isNaN(r.ci_hi)?'':r.ci_hi.toFixed(2)].join('\t'));
}
fs.writeFileSync(path.join(OUT_DIR, 'sweep-sp-weight-v6v7-by-hand.tsv'), lines.join('\n'));
console.log('Wrote docs/data/sweep-sp-weight-v6v7-by-hand.tsv');
console.log('=== DONE ===');
