#!/usr/bin/env node
'use strict';

// Framing/FRV hindsight backtest.
//
// Compares two model configurations across a date range of graded
// games, using the production runModel + getSignals + calcPnl
// entrypoints:
//
//   A. CATCHER_FRAMING_ENABLED=false, DEFENSE_FRV_ENABLED=false
//      (current production behavior)
//   B. CATCHER_FRAMING_ENABLED=true,  DEFENSE_FRV_ENABLED=true
//      (dormant features active)
//
// ⚠ HINDSIGHT BIAS ⚠
//   catcher_framing.rv_tot and fielding_frv.total_runs are
//   CURRENT-STATE values (cumulative through season-to-date). Using
//   them to score historical games means the model knows how each
//   catcher / fielder turned out for the full season when scoring
//   early-season games — look-ahead. The output is DIRECTIONAL ONLY.
//   A forward-honest version will be possible once ~30 days of the
//   newly-shipped catcher_framing_snapshot / fielding_frv_snapshot
//   tables have accumulated (see feat/framing-frv-daily-snapshots).
//
// USAGE
//   node scripts/framing-frv-hindsight-backtest.js
//   node scripts/framing-frv-hindsight-backtest.js --from 2026-05-01 --to 2026-06-01
//   node scripts/framing-frv-hindsight-backtest.js --from 2026-05-15 --to 2026-05-29 --json out.json
//
// Defaults: from = 2026-05-01, to = 2026-06-01.
//
// Output: summary table to stdout. Optional --json <path> writes the
// full JSON report. No DB writes — IT IS SAFE TO RUN AGAINST PROD.

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- CLI args
function parseArgs(argv) {
  const out = { from: '2026-05-01', to: '2026-06-01', json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--from' || a === '-f') && argv[i+1]) { out.from = argv[++i]; continue; }
    if ((a === '--to'   || a === '-t') && argv[i+1]) { out.to   = argv[++i]; continue; }
    if (a === '--json' && argv[i+1]) { out.json = argv[++i]; continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/framing-frv-hindsight-backtest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json out.json]');
      process.exit(0);
    }
  }
  for (const k of ['from','to']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out[k])) {
      console.error('error: --' + k + ' must be YYYY-MM-DD, got "' + out[k] + '"');
      process.exit(2);
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- imports
const { db, q } = require('../db/schema');
const model = require('../services/model');
const jobs  = require('../services/jobs');
const { normName, stripSfx } = require('../utils/names');

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ---------------------------------------------------------------- framing/FRV
// Duplicated from services/jobs.js processGameSignals (~lines 370-497)
// because the script can't modify production code and the resolver +
// per-game computation aren't exported. Kept in sync via comment cross-
// reference; if production logic changes, mirror here.

function resolveCatcherMlbId(team, lineupName) {
  if (!team || !lineupName) return null;
  const norm = stripSfx(normName(lineupName));
  const parts = norm.split(' ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const firstInit = parts[0][0];
  let candidates = [];
  try {
    const players = q.getPositionPlayers.all(team);
    for (const p of players) {
      const pn = stripSfx(normName(p.player_name));
      const pp = pn.split(' ');
      if (pp.length < 2) continue;
      const pLast = pp[pp.length - 1];
      const pInit = pp[0][0];
      if (pLast === last && pInit === firstInit) candidates.push(p);
    }
  } catch (e) { return null; }
  return candidates.length === 1 ? candidates[0].mlb_id : null;
}

function computeFramingRvPerGame(team, lineupJson, settings) {
  if (!q.getCatcherFramingById) return null;
  const arr = tryParse(lineupJson) || [];
  if (!arr.length) return null;
  const c = arr.find(p => (p.pos || '').toUpperCase() === 'C');
  const catcherName = c ? c.name : '';
  if (!catcherName) return null;
  const mlbId = resolveCatcherMlbId(team, catcherName);
  if (!mlbId) return null;
  const min2026 = settings.CATCHER_FRAMING_MIN_PITCHES_2026 != null
    ? Number(settings.CATCHER_FRAMING_MIN_PITCHES_2026) : 750;
  const takesPerGame = settings.CATCHER_FRAMING_TAKES_PER_GAME != null
    ? Number(settings.CATCHER_FRAMING_TAKES_PER_GAME) : 58;
  const absFactor = settings.CATCHER_FRAMING_ABS_FACTOR != null
    ? Number(settings.CATCHER_FRAMING_ABS_FACTOR) : 0.80;
  const rate = (rvTot, pitches) => {
    if (!pitches || pitches <= 0) return null;
    return (rvTot / pitches) * takesPerGame;
  };
  const row = q.getCatcherFramingById.get(mlbId);
  if (row && row.pitches >= min2026) return rate(row.rv_tot, row.pitches);
  if (q.getCatcherFramingHistById) {
    const h = q.getCatcherFramingHistById.get(mlbId);
    if (h && h.pitches > 0) {
      const r = rate(h.rv_tot, h.pitches);
      if (r != null) return r * absFactor;
    }
  }
  return null;
}

function computeTeamFieldingRunsPerGame(team, lineupJson, settings) {
  if (!q.getFieldingFrvById) return null;
  const arr = tryParse(lineupJson) || [];
  if (!arr.length) return null;
  const FIELD_POS = new Set(['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']);
  const oppsPerGame = settings.DEFENSE_FRV_OPPS_PER_GAME != null
    ? Number(settings.DEFENSE_FRV_OPPS_PER_GAME) : 25;
  let sum = 0, resolved = 0;
  for (const p of arr) {
    const pos = (p.pos || '').toUpperCase();
    if (!FIELD_POS.has(pos)) continue;
    const mlbId = resolveCatcherMlbId(team, p.name);
    if (!mlbId) continue;
    const row = q.getFieldingFrvById.get(mlbId);
    if (!row || !row.outs_total || row.outs_total <= 0) continue;
    sum += (row.total_runs / row.outs_total) * oppsPerGame;
    resolved++;
  }
  return resolved > 0 ? sum : null;
}

// ---------------------------------------------------------------- buildGame
// Mirrors backtest-sp-relief-split's buildGame + adds the framing/FRV
// per-game fields runModel needs. The CATCHER_FRAMING_ENABLED /
// DEFENSE_FRV_ENABLED toggle is applied inside runModel — populating
// the fields here is unconditional; the toggle just controls whether
// runModel consumes them.
function buildBacktestGame(gameRow, settings) {
  const parts = (gameRow.game_id || '').split('-');
  const awayAbbr = parts[0] || '';
  const homeAbbr = parts[1] || '';
  const awaySp = gameRow.away_sp || gameRow.away_pitcher || '';
  const homeSp = gameRow.home_sp || gameRow.home_pitcher || '';
  const wProj = settings.W_PROJ != null ? settings.W_PROJ : 0.65;
  const wAct  = settings.W_ACT  != null ? settings.W_ACT  : 0.35;
  const bpSR  = settings.BP_STRONG_WEIGHT_R != null ? settings.BP_STRONG_WEIGHT_R : 0.55;
  const bpWR  = settings.BP_WEAK_WEIGHT_R   != null ? settings.BP_WEAK_WEIGHT_R   : 0.45;
  const bpSL  = settings.BP_STRONG_WEIGHT_L != null ? settings.BP_STRONG_WEIGHT_L : 0.35;
  const bpWL  = settings.BP_WEAK_WEIGHT_L   != null ? settings.BP_WEAK_WEIGHT_L   : 0.65;
  const LEAGUE_BP = 0.318;
  let awayVsR = LEAGUE_BP, awayVsL = LEAGUE_BP, homeVsR = LEAGUE_BP, homeVsL = LEAGUE_BP;
  let awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      const hLU = tryParse(gameRow.home_lineup_json) || [];
      const aLU = tryParse(gameRow.away_lineup_json) || [];
      const aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, hLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      const hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, aLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) { /* fall back */ }

  // Always-on framing/FRV per-game value computation. The toggle is
  // applied DOWNSTREAM in runModel — populating the fields here makes
  // the same input visible to both configs A and B.
  //
  // Case-quirk: game_id is lowercase ('hou-chc' -> awayAbbr 'hou') but
  // team_rosters.team is uppercase ('HOU'). q.getPositionPlayers uses
  // case-sensitive equality so we must upper before calling the
  // resolver, otherwise every catcher / fielder resolves to null and
  // the entire hindsight comparison degenerates to A === B. Production
  // doesn't hit this because CATCHER_FRAMING_ENABLED / DEFENSE_FRV_ENABLED
  // default to false — the null inputs are silently ignored.
  const awayTeamUpper = awayAbbr.toUpperCase();
  const homeTeamUpper = homeAbbr.toUpperCase();
  const awayCatcherFramingRvPerGame = computeFramingRvPerGame(awayTeamUpper, gameRow.away_lineup_json, settings);
  const homeCatcherFramingRvPerGame = computeFramingRvPerGame(homeTeamUpper, gameRow.home_lineup_json, settings);
  const awayFieldingRunsPerGame = computeTeamFieldingRunsPerGame(awayTeamUpper, gameRow.away_lineup_json, settings);
  const homeFieldingRunsPerGame = computeTeamFieldingRunsPerGame(homeTeamUpper, gameRow.home_lineup_json, settings);

  return Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
    awayCatcherFramingRvPerGame, homeCatcherFramingRvPerGame,
    awayFieldingRunsPerGame, homeFieldingRunsPerGame,
  });
}

// ---------------------------------------------------------------- aggregation
function wageredFor(sig) {
  if (sig.type === 'ML') {
    const ln = Number(sig.marketLine);
    if (!ln) return 0;
    return ln > 0 ? (10000 / ln) : Math.abs(ln);
  }
  return 110;
}
function emptyBucket() {
  return { signals: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, wagered: 0 };
}
function bucketKeyForSignal(sig) {
  if (sig.type === 'ML') return Number(sig.marketLine) < 0 ? 'ml_fav' : 'ml_dog';
  return sig.side === 'over' ? 'tot_over' : 'tot_under';
}
function accumulate(buckets, sig, graded) {
  const k = bucketKeyForSignal(sig);
  for (const b of [buckets.all, buckets[k]]) {
    b.signals++;
    if (graded.outcome === 'win')  b.wins++;
    if (graded.outcome === 'loss') b.losses++;
    if (graded.outcome === 'push') b.pushes++;
    b.pnl += Number(graded.pnl) || 0;
    if (graded.outcome !== 'push') b.wagered += wageredFor(sig);
  }
}
function roiPct(b) {
  return b.wagered > 0 ? (100 * b.pnl / b.wagered) : null;
}
function fmtRoi(b) {
  const r = roiPct(b);
  if (r == null) return '—';
  return (r >= 0 ? '+' : '') + r.toFixed(2) + '%';
}
function fmtWLP(b) { return b.wins + '-' + b.losses + '-' + b.pushes; }

// Stable signal key for cross-config overlap analysis.
function sigKey(gameRow, sig) {
  return gameRow.game_date + '|' + gameRow.game_id + '|' + sig.type + '|' + sig.side;
}

// ---------------------------------------------------------------- main
(function main() {
  const printedBanner = '⚠  HINDSIGHT BIASED — DIRECTIONAL ONLY  ⚠';

  console.log('');
  console.log(printedBanner);
  console.log('');
  console.log('FRAMING/FRV HINDSIGHT BACKTEST (' + ARGS.from + ' to ' + ARGS.to + ')');
  console.log('');

  // Pull every graded game in the window. processGameSignals is the
  // production entrypoint but it writes — we'd need to roll back. The
  // backtest-sp-relief-split pattern (call runModel + getSignals
  // directly, no writes) is more honest for our purpose.
  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(ARGS.from, ARGS.to);

  if (!games.length) {
    console.log('No graded games in window. Nothing to backtest.');
    console.log('');
    console.log(printedBanner);
    process.exit(0);
  }

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();

  // Four scenarios. A is the production-current baseline; B is the
  // existing combined-on variant; C and D isolate framing-only and
  // FRV-only so the operator can see whether the lift observed under
  // B is driven by one feature, the other, or both.
  const cfgA = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: false,
  });
  const cfgB = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: true,
  });
  const cfgC = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: false, // framing only
  });
  const cfgD = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: true,  // FRV only
  });

  // Aggregators per config.
  function newAgg() {
    return {
      all:        emptyBucket(),
      ml_fav:     emptyBucket(),
      ml_dog:     emptyBucket(),
      tot_over:   emptyBucket(),
      tot_under:  emptyBucket(),
    };
  }
  const aggA = newAgg();
  const aggB = newAgg();
  const aggC = newAgg();
  const aggD = newAgg();

  // Overlap + divergence tracking. Each non-A config gets its own
  // edge-delta array (signals that fire in BOTH A and that config —
  // used for the "mean edge vs A" row) and its own divergent-from-A
  // bucket (signals that fire in the config but NOT in A).
  const sigsByGame = { A: new Map(), B: new Map(), C: new Map(), D: new Map() };
  const overlapVsA = { B: [], C: [], D: [] };
  const divergentVsA = { bOnly: [], cOnly: [], dOnly: [] };

  let gamesConsidered = 0, gamesScored = 0;
  const suppressedCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const gameRow of games) {
    gamesConsidered++;
    // Build the game ONCE — all four configs see identical framing/FRV
    // inputs, only the enabled toggles differ.
    const game = buildBacktestGame(gameRow, baseSettings);

    const mrs = {
      A: model.runModel(game, wobaIdx, cfgA, 'standard'),
      B: model.runModel(game, wobaIdx, cfgB, 'standard'),
      C: model.runModel(game, wobaIdx, cfgC, 'standard'),
      D: model.runModel(game, wobaIdx, cfgD, 'standard'),
    };
    let anySuppressed = false;
    for (const k of ['A','B','C','D']) {
      if (mrs[k] && mrs[k]._suppressed) { suppressedCounts[k]++; anySuppressed = true; }
    }
    if (anySuppressed) continue;
    gamesScored++;

    const cfgMap = { A: cfgA, B: cfgB, C: cfgC, D: cfgD };
    const aggMap = { A: aggA, B: aggB, C: aggC, D: aggD };
    const locals = { A: new Map(), B: new Map(), C: new Map(), D: new Map() };

    for (const k of ['A','B','C','D']) {
      const sigs = model.getSignals(game, mrs[k], cfgMap[k]);
      for (const s of sigs) {
        const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
        if (graded.outcome === 'pending') continue;
        accumulate(aggMap[k], s, graded);
        locals[k].set(sigKey(gameRow, s), { sig: s, graded });
      }
    }

    // Overlap + divergence vs A, computed per non-A config.
    for (const other of ['B','C','D']) {
      const localOther = locals[other];
      for (const [k, v] of localOther) {
        if (locals.A.has(k)) {
          overlapVsA[other].push({
            key: k, edgeA: locals.A.get(k).sig.edge, edgeOther: v.sig.edge,
            delta: v.sig.edge - locals.A.get(k).sig.edge,
          });
        } else {
          divergentVsA[other.toLowerCase() + 'Only'].push({
            key: k, type: v.sig.type, side: v.sig.side,
            edge: v.sig.edge, outcome: v.graded.outcome, pnl: v.graded.pnl,
          });
        }
      }
    }

    for (const k of ['A','B','C','D']) {
      sigsByGame[k].set(gameRow.game_date + '|' + gameRow.game_id, locals[k]);
    }
  }

  // Per-config mean edge over A∩config overlap (used for the "Mean
  // edge (vs A)" row in the summary table). Each value is the mean
  // signed delta in pp; positive = config produced a stronger edge
  // than A on the same signals.
  function meanDeltaPp(arr) {
    if (!arr.length) return null;
    return arr.reduce((s, d) => s + d.delta * 100, 0) / arr.length;
  }
  function meanEdgePp(arr, side /* 'edgeA' | 'edgeOther' */) {
    if (!arr.length) return null;
    return arr.reduce((s, d) => s + d[side] * 100, 0) / arr.length;
  }
  const meanEdgeAvsB = meanEdgePp(overlapVsA.B, 'edgeA');
  const meanEdge = {
    A_in_B_overlap: meanEdgeAvsB,
    B: meanEdgePp(overlapVsA.B, 'edgeOther'),
    C: meanEdgePp(overlapVsA.C, 'edgeOther'),
    D: meanEdgePp(overlapVsA.D, 'edgeOther'),
    deltaVsA: {
      B: meanDeltaPp(overlapVsA.B),
      C: meanDeltaPp(overlapVsA.C),
      D: meanDeltaPp(overlapVsA.D),
    },
  };

  // -------------------------------------------------------------- summary table
  function pad(s, n, right) {
    s = String(s);
    if (s.length >= n) return s;
    const fill = ' '.repeat(n - s.length);
    return right ? fill + s : s + fill;
  }
  function deltaCount(a, b) {
    const d = b - a;
    return (d >= 0 ? '+' : '') + d;
  }
  function deltaRoi(a, b) {
    const ra = roiPct(a), rb = roiPct(b);
    if (ra == null || rb == null) return '—';
    const d = rb - ra;
    return (d >= 0 ? '+' : '') + d.toFixed(2) + 'pp';
  }
  const col = { label: 22, val: 13 };
  console.log(pad('', col.label)
    + pad('Off (A)', col.val, true)
    + pad('Framing (C)', col.val, true)
    + pad('FRV (D)', col.val, true)
    + pad('Both (B)', col.val, true));
  console.log('-'.repeat(col.label + col.val * 4));
  console.log(pad('Signals fired:', col.label)
    + pad(aggA.all.signals, col.val, true)
    + pad(aggC.all.signals, col.val, true)
    + pad(aggD.all.signals, col.val, true)
    + pad(aggB.all.signals, col.val, true));
  console.log(pad('W-L-P:', col.label)
    + pad(fmtWLP(aggA.all), col.val, true)
    + pad(fmtWLP(aggC.all), col.val, true)
    + pad(fmtWLP(aggD.all), col.val, true)
    + pad(fmtWLP(aggB.all), col.val, true));
  console.log(pad('ROI:', col.label)
    + pad(fmtRoi(aggA.all), col.val, true)
    + pad(fmtRoi(aggC.all), col.val, true)
    + pad(fmtRoi(aggD.all), col.val, true)
    + pad(fmtRoi(aggB.all), col.val, true));
  // Mean edge (vs A). A column shows the mean edge of A∩B-overlap A
  // signals for context (other overlap subsets land on slightly
  // different A means depending on intersection — using one A column
  // keeps the table readable). Each non-A column shows that config's
  // mean edge on its OWN overlap with A.
  function fmtEdgePp(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + 'pp'; }
  console.log(pad('Mean edge (overlap):', col.label)
    + pad(fmtEdgePp(meanEdge.A_in_B_overlap), col.val, true)
    + pad(fmtEdgePp(meanEdge.C), col.val, true)
    + pad(fmtEdgePp(meanEdge.D), col.val, true)
    + pad(fmtEdgePp(meanEdge.B), col.val, true));
  console.log('');
  console.log('Divergent from A (fired in alt config but NOT in A):');
  console.log('  fired in C only: ' + divergentVsA.cOnly.length);
  console.log('  fired in D only: ' + divergentVsA.dOnly.length);
  console.log('  fired in B only: ' + divergentVsA.bOnly.length);
  console.log('');
  console.log('Per-cohort breakdown:');
  function cohortLine(label, key) {
    const a = aggA[key], b = aggB[key], c = aggC[key], d = aggD[key];
    return '  ' + pad(label, 12)
      + pad('A ' + fmtRoi(a) + ' (' + a.signals + ')', 20)
      + pad('C ' + fmtRoi(c) + ' (' + c.signals + ')', 20)
      + pad('D ' + fmtRoi(d) + ' (' + d.signals + ')', 20)
      + pad('B ' + fmtRoi(b) + ' (' + b.signals + ')', 20);
  }
  console.log(cohortLine('ML Favs:',   'ml_fav'));
  console.log(cohortLine('ML Dogs:',   'ml_dog'));
  console.log(cohortLine('Tot Overs:', 'tot_over'));
  console.log(cohortLine('Tot Unders:','tot_under'));
  console.log('');
  const supTotal = suppressedCounts.A + suppressedCounts.B + suppressedCounts.C + suppressedCounts.D;
  console.log('Games considered: ' + gamesConsidered
    + ' | scored: ' + gamesScored
    + (supTotal ? ' | suppressed (any): A=' + suppressedCounts.A + ' B=' + suppressedCounts.B
                  + ' C=' + suppressedCounts.C + ' D=' + suppressedCounts.D : ''));
  console.log('');
  console.log(printedBanner);

  // -------------------------------------------------------------- JSON
  const report = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. catcher_framing and fielding_frv tables hold current-state values applied retroactively. Forward-honest version awaits ~30d of snapshot accumulation.',
    date_window: { from: ARGS.from, to: ARGS.to },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    suppressed: { A: suppressedCounts.A, B: suppressedCounts.B, C: suppressedCounts.C, D: suppressedCounts.D },
    configs: {
      A: { CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: false, label: 'production (current)' },
      B: { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: true,  label: 'both on' },
      C: { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: false, label: 'framing only' },
      D: { CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: true,  label: 'FRV only' },
    },
    aggregates: (function aggReport() {
      const out = {};
      for (const [k, agg] of [['A', aggA], ['B', aggB], ['C', aggC], ['D', aggD]]) {
        out[k] = {
          all: agg.all, ml_fav: agg.ml_fav, ml_dog: agg.ml_dog,
          tot_over: agg.tot_over, tot_under: agg.tot_under,
          roi_pct: {
            all:       roiPct(agg.all),
            ml_fav:    roiPct(agg.ml_fav),
            ml_dog:    roiPct(agg.ml_dog),
            tot_over:  roiPct(agg.tot_over),
            tot_under: roiPct(agg.tot_under),
          },
        };
      }
      return out;
    })(),
    overlap_vs_A: {
      B: {
        count: overlapVsA.B.length,
        mean_edge_A_pp: meanEdge.A_in_B_overlap != null ? Number(meanEdge.A_in_B_overlap.toFixed(4)) : null,
        mean_edge_other_pp: meanEdge.B != null ? Number(meanEdge.B.toFixed(4)) : null,
        mean_edge_delta_pp: meanEdge.deltaVsA.B != null ? Number(meanEdge.deltaVsA.B.toFixed(4)) : null,
      },
      C: {
        count: overlapVsA.C.length,
        mean_edge_other_pp: meanEdge.C != null ? Number(meanEdge.C.toFixed(4)) : null,
        mean_edge_delta_pp: meanEdge.deltaVsA.C != null ? Number(meanEdge.deltaVsA.C.toFixed(4)) : null,
      },
      D: {
        count: overlapVsA.D.length,
        mean_edge_other_pp: meanEdge.D != null ? Number(meanEdge.D.toFixed(4)) : null,
        mean_edge_delta_pp: meanEdge.deltaVsA.D != null ? Number(meanEdge.deltaVsA.D.toFixed(4)) : null,
      },
    },
    divergent_counts: {
      // Signals that fired in the alt config but NOT in A — i.e. new
      // bets the dormant features would have surfaced.
      b_only: divergentVsA.bOnly.length,
      c_only: divergentVsA.cOnly.length,
      d_only: divergentVsA.dOnly.length,
    },
    // Cap each list at 100 entries to keep the JSON manageable; counts
    // above are authoritative totals.
    divergent_sample: {
      b_only: divergentVsA.bOnly.slice(0, 100),
      c_only: divergentVsA.cOnly.slice(0, 100),
      d_only: divergentVsA.dOnly.slice(0, 100),
    },
  };

  if (ARGS.json) {
    fs.writeFileSync(ARGS.json, JSON.stringify(report, null, 2));
    console.log('JSON report written to ' + ARGS.json);
  }

  try { db.close(); } catch (_) {}
})();
