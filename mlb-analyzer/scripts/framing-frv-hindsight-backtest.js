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

  // Two scenarios. The brief: live production today has both knobs
  // off. The hindsight variant turns both on simultaneously (and uses
  // the default *_MUTE values that production would honor).
  const cfgA = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: false,
    DEFENSE_FRV_ENABLED: false,
  });
  const cfgB = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: true,
    DEFENSE_FRV_ENABLED: true,
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

  // Overlap + divergence tracking.
  const sigsByGameA = new Map(); // gameKey -> Map<sigKey, { sig, graded }>
  const sigsByGameB = new Map();
  const edgeDeltas = []; // for overlapping signals
  const divergent = { aOnly: [], bOnly: [] };

  let gamesConsidered = 0, gamesScored = 0, suppressedA = 0, suppressedB = 0;
  for (const gameRow of games) {
    gamesConsidered++;
    // Build the game ONCE — both configs see identical framing/FRV
    // inputs, only the toggle differs.
    const game = buildBacktestGame(gameRow, baseSettings);

    const mrA = model.runModel(game, wobaIdx, cfgA, 'standard');
    const mrB = model.runModel(game, wobaIdx, cfgB, 'standard');
    if (mrA && mrA._suppressed) { suppressedA++; continue; }
    if (mrB && mrB._suppressed) { suppressedB++; continue; }

    const sigsA = model.getSignals(game, mrA, cfgA);
    const sigsB = model.getSignals(game, mrB, cfgB);
    gamesScored++;

    const localA = new Map();
    const localB = new Map();

    for (const s of sigsA) {
      const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
      if (graded.outcome === 'pending') continue;
      accumulate(aggA, s, graded);
      localA.set(sigKey(gameRow, s), { sig: s, graded });
    }
    for (const s of sigsB) {
      const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
      if (graded.outcome === 'pending') continue;
      accumulate(aggB, s, graded);
      localB.set(sigKey(gameRow, s), { sig: s, graded });
    }

    // Overlap + divergence (this game).
    for (const [k, v] of localA) {
      if (localB.has(k)) {
        const a = v.sig.edge;
        const b = localB.get(k).sig.edge;
        edgeDeltas.push({ key: k, edgeA: a, edgeB: b, delta: b - a });
      } else {
        divergent.aOnly.push({
          key: k, type: v.sig.type, side: v.sig.side,
          edge: v.sig.edge, outcome: v.graded.outcome, pnl: v.graded.pnl,
        });
      }
    }
    for (const [k, v] of localB) {
      if (!localA.has(k)) {
        divergent.bOnly.push({
          key: k, type: v.sig.type, side: v.sig.side,
          edge: v.sig.edge, outcome: v.graded.outcome, pnl: v.graded.pnl,
        });
      }
    }

    sigsByGameA.set(gameRow.game_date + '|' + gameRow.game_id, localA);
    sigsByGameB.set(gameRow.game_date + '|' + gameRow.game_id, localB);
  }

  const meanEdgeA = edgeDeltas.length
    ? edgeDeltas.reduce((s, d) => s + d.edgeA, 0) / edgeDeltas.length : null;
  const meanEdgeB = edgeDeltas.length
    ? edgeDeltas.reduce((s, d) => s + d.edgeB, 0) / edgeDeltas.length : null;
  const meanEdgeDeltaPp = edgeDeltas.length
    ? edgeDeltas.reduce((s, d) => s + (d.delta * 100), 0) / edgeDeltas.length : null;

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
  const col = { label: 24, off: 14, on: 14, delta: 12 };
  console.log(pad('', col.label) + pad('Off (A)', col.off) + pad('On (B)', col.on) + pad('Delta', col.delta));
  console.log('-'.repeat(col.label + col.off + col.on + col.delta));
  console.log(pad('Signals fired:', col.label)
    + pad(aggA.all.signals, col.off)
    + pad(aggB.all.signals, col.on)
    + pad(deltaCount(aggA.all.signals, aggB.all.signals), col.delta));
  console.log(pad('W-L-P:', col.label)
    + pad(fmtWLP(aggA.all), col.off)
    + pad(fmtWLP(aggB.all), col.on)
    + pad('', col.delta));
  console.log(pad('ROI:', col.label)
    + pad(fmtRoi(aggA.all), col.off)
    + pad(fmtRoi(aggB.all), col.on)
    + pad(deltaRoi(aggA.all, aggB.all), col.delta));
  if (meanEdgeA != null) {
    console.log(pad('Mean edge (overlap):', col.label)
      + pad((meanEdgeA * 100).toFixed(2) + 'pp', col.off)
      + pad((meanEdgeB * 100).toFixed(2) + 'pp', col.on)
      + pad((meanEdgeDeltaPp >= 0 ? '+' : '') + meanEdgeDeltaPp.toFixed(2) + 'pp', col.delta));
  } else {
    console.log(pad('Mean edge (overlap):', col.label) + pad('— (no overlap)', col.off + col.on + col.delta));
  }
  console.log('');
  console.log('Divergent signals (count): ' + (divergent.aOnly.length + divergent.bOnly.length));
  console.log('  fired in A only: ' + divergent.aOnly.length);
  console.log('  fired in B only: ' + divergent.bOnly.length);
  console.log('');
  console.log('Per-cohort breakdown:');
  function cohortLine(label, key) {
    const a = aggA[key], b = aggB[key];
    return '  ' + pad(label, 14)
      + pad('A ' + a.signals + ' bets, ' + fmtWLP(a) + ', ROI ' + fmtRoi(a), 38)
      + pad('B ' + b.signals + ' bets, ' + fmtWLP(b) + ', ROI ' + fmtRoi(b), 38)
      + 'Δ ' + deltaRoi(a, b);
  }
  console.log(cohortLine('ML Favs:',   'ml_fav'));
  console.log(cohortLine('ML Dogs:',   'ml_dog'));
  console.log(cohortLine('Tot Overs:', 'tot_over'));
  console.log(cohortLine('Tot Unders:','tot_under'));
  console.log('');
  console.log('Games considered: ' + gamesConsidered
    + ' | scored: ' + gamesScored
    + (suppressedA || suppressedB ? ' | suppressed A=' + suppressedA + ' B=' + suppressedB : ''));
  console.log('');
  console.log(printedBanner);

  // -------------------------------------------------------------- JSON
  const report = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. catcher_framing and fielding_frv tables hold current-state values applied retroactively. Forward-honest version awaits ~30d of snapshot accumulation.',
    date_window: { from: ARGS.from, to: ARGS.to },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    suppressed: { A: suppressedA, B: suppressedB },
    configs: {
      A: { CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: false, label: 'production (current)' },
      B: { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: true,  label: 'dormant features active' },
    },
    aggregates: {
      A: { all: aggA.all, ml_fav: aggA.ml_fav, ml_dog: aggA.ml_dog, tot_over: aggA.tot_over, tot_under: aggA.tot_under,
           roi_pct: { all: roiPct(aggA.all), ml_fav: roiPct(aggA.ml_fav), ml_dog: roiPct(aggA.ml_dog),
                     tot_over: roiPct(aggA.tot_over), tot_under: roiPct(aggA.tot_under) } },
      B: { all: aggB.all, ml_fav: aggB.ml_fav, ml_dog: aggB.ml_dog, tot_over: aggB.tot_over, tot_under: aggB.tot_under,
           roi_pct: { all: roiPct(aggB.all), ml_fav: roiPct(aggB.ml_fav), ml_dog: roiPct(aggB.ml_dog),
                     tot_over: roiPct(aggB.tot_over), tot_under: roiPct(aggB.tot_under) } },
    },
    overlap: {
      count: edgeDeltas.length,
      mean_edge_A_pp: meanEdgeA != null ? Number((meanEdgeA * 100).toFixed(4)) : null,
      mean_edge_B_pp: meanEdgeB != null ? Number((meanEdgeB * 100).toFixed(4)) : null,
      mean_edge_delta_pp: meanEdgeDeltaPp != null ? Number(meanEdgeDeltaPp.toFixed(4)) : null,
    },
    divergent_counts: {
      a_only: divergent.aOnly.length,
      b_only: divergent.bOnly.length,
    },
    // Cap the detailed divergent list at 100 entries each side to keep
    // the JSON manageable; the counts above are authoritative totals.
    divergent_sample: {
      a_only: divergent.aOnly.slice(0, 100),
      b_only: divergent.bOnly.slice(0, 100),
    },
  };

  if (ARGS.json) {
    fs.writeFileSync(ARGS.json, JSON.stringify(report, null, 2));
    console.log('JSON report written to ' + ARGS.json);
  }

  try { db.close(); } catch (_) {}
})();
