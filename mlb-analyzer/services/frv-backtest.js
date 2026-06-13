'use strict';

// FRV hindsight backtest — admin-endpoint version.
//
// Re-runs the FRV impact measurement (B = framing + FRV vs
// C = framing only) on the CORRECTED framing substrate (post-fc16748
// resolver case fix + post-f4c2645 Savant qualifier camelCase fix), so
// the prior -6.58pp B-vs-A number can be re-evaluated against a
// working framing layer instead of the silently-dead one.
//
// Lifted from scripts/framing-frv-hindsight-backtest.js (4-config
// diagnostic mode); narrowed to B-vs-C because that is the only
// comparison the rerun brief asked for, and dropped the A/D configs
// to halve the runModel call count per game. Helpers
// (resolveCatcherMlbId import, computeFramingRvPerGame,
// computeTeamFieldingRunsPerGame, buildBacktestGame, accumulate,
// isHighlightedSignal, loadUiHighlightThresholds) are byte-for-byte
// copies of the script's versions — if the script's reference logic
// ever drifts, mirror here.
//
// ⚠ HINDSIGHT BIAS ⚠
//   catcher_framing.rv_tot and fielding_frv.total_runs are
//   CURRENT-STATE values (cumulative season-to-date), applied
//   retroactively to early-season games. Output is DIRECTIONAL ONLY
//   until ~30d of snapshot accumulation makes a forward-honest
//   version possible (see feat/framing-frv-daily-snapshots).
//
// Report-only. No DB writes. No settings changes. Safe to call
// against the live prod DB.

const { db, q } = require('../db/schema');
const model = require('./model');
const jobs  = require('./jobs');

// Single source of truth — the same resolver production uses for
// catcher framing and FRV. fc16748 made resolveCatcherMlbId
// uppercase its team input internally, so we no longer need the old
// awayAbbr.toUpperCase() workaround that the original script carried.
const { resolveCatcherMlbId } = jobs;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

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

// UI-highlight thresholds — mirrors services/empirical-spread-roi.js
// and the original script. Defaults match services/settings-schema.js.
function loadUiHighlightThresholds() {
  let rows = [];
  try {
    rows = db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ("
      + "'ui_highlight_ml_fav_min_pp','ui_highlight_ml_dog_min_pp',"
      + "'ui_highlight_tot_under_min_pp','ui_highlight_tot_overs_enabled')"
    ).all();
  } catch (e) { /* table missing → defaults */ }
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    fav_min_pp:    m['ui_highlight_ml_fav_min_pp']    != null ? Number(m['ui_highlight_ml_fav_min_pp'])    : 0.02,
    dog_min_pp:    m['ui_highlight_ml_dog_min_pp']    != null ? Number(m['ui_highlight_ml_dog_min_pp'])    : 0.045,
    under_min_pp:  m['ui_highlight_tot_under_min_pp'] != null ? Number(m['ui_highlight_tot_under_min_pp']) : 0.07,
    overs_enabled: m['ui_highlight_tot_overs_enabled'] === 'true',
  };
}

// edge*200 → round → /200 rounds to nearest 0.005pp; e.g. raw 0.0445 → 0.045.
function isHighlightedSignal(sig, t) {
  const rounded = Math.round(Number(sig.edge) * 200) / 200;
  if (sig.type === 'ML') {
    return Number(sig.marketLine) < 0
      ? rounded >= t.fav_min_pp
      : rounded >= t.dog_min_pp;
  }
  if (sig.side === 'over')  return !!t.overs_enabled;
  if (sig.side === 'under') return rounded >= t.under_min_pp;
  return false;
}

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

function newAgg() {
  return {
    all:        emptyBucket(),
    ml_fav:     emptyBucket(),
    ml_dog:     emptyBucket(),
    tot_over:   emptyBucket(),
    tot_under:  emptyBucket(),
  };
}

function roiPct(b) {
  return b.wagered > 0 ? Number((100 * b.pnl / b.wagered).toFixed(4)) : null;
}

function projectBucket(b) {
  return {
    signals: b.signals, wins: b.wins, losses: b.losses, pushes: b.pushes,
    pnl: Number(b.pnl.toFixed(4)),
    wagered: Number(b.wagered.toFixed(4)),
    roi_pct: roiPct(b),
  };
}

function projectAgg(agg) {
  return {
    all:       projectBucket(agg.all),
    ml_fav:    projectBucket(agg.ml_fav),
    ml_dog:    projectBucket(agg.ml_dog),
    tot_over:  projectBucket(agg.tot_over),
    tot_under: projectBucket(agg.tot_under),
  };
}

function sigKey(gameRow, sig) {
  return gameRow.game_date + '|' + gameRow.game_id + '|' + sig.type + '|' + sig.side;
}

// Per-game |FRV delta| bucket boundary. 0.10 runs is the "perceptible"
// threshold below which FRV barely moved the projection — Δ ROI on the
// small-delta bucket should be ~0 if FRV is informative; non-zero Δ
// there is noise.
const FRV_LARGE_THRESHOLD = 0.10;

function runFrvBacktest(opts) {
  const fromDate = opts.fromDate;
  const toDate   = opts.toDate;
  const includeDetail = !!opts.includeDetail;

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();

  // Same B vs C config the script's CORRECTED-SUBSTRATE block uses.
  // A and D are dropped — the brief only asks for B-vs-C.
  const cfgB = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: true, DEFENSE_FRV_ENABLED: true,
  });
  const cfgC = Object.assign({}, baseSettings, {
    CATCHER_FRAMING_ENABLED: true, DEFENSE_FRV_ENABLED: false,
  });

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);

  const uiThresholds = loadUiHighlightThresholds();

  // Emit-floor aggregators
  const aggB = newAgg();
  const aggC = newAgg();
  // UI-highlight aggregators
  const aggBhi = newAgg();
  const aggChi = newAgg();
  // FRV-delta split (emit-floor)
  const aggB_largeFrv = newAgg();
  const aggB_smallFrv = newAgg();
  const aggC_largeFrv = newAgg();
  const aggC_smallFrv = newAgg();
  // FRV-delta split (UI-highlight)
  const aggBhi_largeFrv = newAgg();
  const aggBhi_smallFrv = newAgg();
  const aggChi_largeFrv = newAgg();
  const aggChi_smallFrv = newAgg();

  // B∩C overlap. Outcomes are identical (same bet, same market price)
  // so the intersection ROI is the same whether you pull pnl from B
  // or C; we report it once. Counts of B-only / C-only are
  // (aggB - intersection) / (aggC - intersection).
  const overlapBvsC = [];

  let gamesConsidered = 0, gamesScored = 0;
  const suppressedCounts = { B: 0, C: 0 };
  const plays = []; // populated only when includeDetail === true

  for (const gameRow of games) {
    gamesConsidered++;
    const game = buildBacktestGame(gameRow, baseSettings);

    const mrB = model.runModel(game, wobaIdx, cfgB, 'standard');
    const mrC = model.runModel(game, wobaIdx, cfgC, 'standard');

    if (mrB && mrB._suppressed) suppressedCounts.B++;
    if (mrC && mrC._suppressed) suppressedCounts.C++;
    if ((mrB && mrB._suppressed) || (mrC && mrC._suppressed)) continue;
    gamesScored++;

    const frvDelta = Math.max(
      Math.abs((mrB.aRuns || 0) - (mrC.aRuns || 0)),
      Math.abs((mrB.hRuns || 0) - (mrC.hRuns || 0))
    );
    const frvLarge = frvDelta >= FRV_LARGE_THRESHOLD;

    const localsB = new Map();
    const localsC = new Map();

    const sigsB = model.getSignals(game, mrB, cfgB);
    for (const s of sigsB) {
      const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
      if (graded.outcome === 'pending') continue;
      accumulate(aggB, s, graded);
      localsB.set(sigKey(gameRow, s), { sig: s, graded });
      const splitEmit = frvLarge ? aggB_largeFrv : aggB_smallFrv;
      accumulate(splitEmit, s, graded);
      if (isHighlightedSignal(s, uiThresholds)) {
        accumulate(aggBhi, s, graded);
        const splitHi = frvLarge ? aggBhi_largeFrv : aggBhi_smallFrv;
        accumulate(splitHi, s, graded);
      }
    }

    const sigsC = model.getSignals(game, mrC, cfgC);
    for (const s of sigsC) {
      const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
      if (graded.outcome === 'pending') continue;
      accumulate(aggC, s, graded);
      localsC.set(sigKey(gameRow, s), { sig: s, graded });
      const splitEmit = frvLarge ? aggC_largeFrv : aggC_smallFrv;
      accumulate(splitEmit, s, graded);
      if (isHighlightedSignal(s, uiThresholds)) {
        accumulate(aggChi, s, graded);
        const splitHi = frvLarge ? aggChi_largeFrv : aggChi_smallFrv;
        accumulate(splitHi, s, graded);
      }
    }

    for (const [k, v] of localsB) {
      if (localsC.has(k)) {
        const c = localsC.get(k);
        overlapBvsC.push({
          key: k,
          sig: v.sig,
          graded: v.graded,
          frvLarge,
          edgeB: v.sig.edge,
          edgeC: c.sig.edge,
        });
      }
    }

    if (includeDetail) {
      // Compact per-signal record — one row per (config, signal) pair.
      // Detail mode is for spot-checking, not production analytics, so
      // we trim the signal object to the fields the operator cares
      // about (type/side/edge/marketLine/pnl/outcome).
      function pushPlay(cfg, s, graded) {
        plays.push({
          game_date: gameRow.game_date,
          game_id: gameRow.game_id,
          cfg, // 'B' or 'C'
          type: s.type, side: s.side,
          edge: Number(s.edge),
          market_line: s.marketLine != null ? Number(s.marketLine) : null,
          outcome: graded.outcome,
          pnl: Number(graded.pnl) || 0,
          frv_delta: Number(frvDelta.toFixed(4)),
          frv_large: frvLarge,
          highlighted: isHighlightedSignal(s, uiThresholds),
        });
      }
      for (const [, v] of localsB) pushPlay('B', v.sig, v.graded);
      for (const [, v] of localsC) pushPlay('C', v.sig, v.graded);
    }
  }

  // Intersection record/ROI. B and C share outcomes on common signals
  // — pulling from B is sufficient.
  let intPnl = 0, intWag = 0, intWins = 0, intLoss = 0, intPush = 0;
  for (const o of overlapBvsC) {
    const w = wageredFor(o.sig);
    intPnl += Number(o.graded.pnl) || 0;
    if (o.graded.outcome !== 'push') intWag += w;
    if (o.graded.outcome === 'win')  intWins++;
    if (o.graded.outcome === 'loss') intLoss++;
    if (o.graded.outcome === 'push') intPush++;
  }
  const intRoi = intWag > 0 ? Number((100 * intPnl / intWag).toFixed(4)) : null;

  function deltaPp(curr, base) {
    if (curr == null || base == null) return null;
    return Number((curr - base).toFixed(4));
  }

  const out = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. catcher_framing and fielding_frv hold current-state values applied retroactively. Forward-honest version awaits ~30d of snapshot accumulation.',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    suppressed: suppressedCounts,
    configs: {
      B: { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: true,  label: 'framing + FRV' },
      C: { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: false, label: 'framing only' },
    },
    ui_thresholds: uiThresholds,
    frv_large_threshold_runs: FRV_LARGE_THRESHOLD,
    emit_floor: {
      B: projectAgg(aggB),
      C: projectAgg(aggC),
      delta_pp_B_minus_C: {
        all:      deltaPp(roiPct(aggB.all),      roiPct(aggC.all)),
        ml_fav:   deltaPp(roiPct(aggB.ml_fav),   roiPct(aggC.ml_fav)),
        ml_dog:   deltaPp(roiPct(aggB.ml_dog),   roiPct(aggC.ml_dog)),
        tot_over: deltaPp(roiPct(aggB.tot_over), roiPct(aggC.tot_over)),
        tot_under:deltaPp(roiPct(aggB.tot_under),roiPct(aggC.tot_under)),
      },
    },
    ui_highlight: {
      B: projectAgg(aggBhi),
      C: projectAgg(aggChi),
      delta_pp_B_minus_C: {
        all:      deltaPp(roiPct(aggBhi.all),      roiPct(aggChi.all)),
        ml_fav:   deltaPp(roiPct(aggBhi.ml_fav),   roiPct(aggChi.ml_fav)),
        ml_dog:   deltaPp(roiPct(aggBhi.ml_dog),   roiPct(aggChi.ml_dog)),
        tot_over: deltaPp(roiPct(aggBhi.tot_over), roiPct(aggChi.tot_over)),
        tot_under:deltaPp(roiPct(aggBhi.tot_under),roiPct(aggChi.tot_under)),
      },
    },
    frv_delta_split: {
      // Emit-floor, B vs C, split by per-game |FRV delta|.
      // small (< FRV_LARGE_THRESHOLD): FRV barely moved the projection;
      //   Δ ROI here ≈ 0 if FRV is informative (non-zero = noise).
      // large (>= FRV_LARGE_THRESHOLD): FRV actually moved the
      //   projection; Δ ROI here is the real signal.
      emit_floor: {
        small: {
          B: projectAgg(aggB_smallFrv),
          C: projectAgg(aggC_smallFrv),
          delta_pp_B_minus_C_all: deltaPp(roiPct(aggB_smallFrv.all), roiPct(aggC_smallFrv.all)),
        },
        large: {
          B: projectAgg(aggB_largeFrv),
          C: projectAgg(aggC_largeFrv),
          delta_pp_B_minus_C_all: deltaPp(roiPct(aggB_largeFrv.all), roiPct(aggC_largeFrv.all)),
        },
      },
      ui_highlight: {
        small: {
          B: projectAgg(aggBhi_smallFrv),
          C: projectAgg(aggChi_smallFrv),
          delta_pp_B_minus_C_all: deltaPp(roiPct(aggBhi_smallFrv.all), roiPct(aggChi_smallFrv.all)),
        },
        large: {
          B: projectAgg(aggBhi_largeFrv),
          C: projectAgg(aggChi_largeFrv),
          delta_pp_B_minus_C_all: deltaPp(roiPct(aggBhi_largeFrv.all), roiPct(aggChi_largeFrv.all)),
        },
      },
    },
    intersection_b_c: {
      // Signals firing in BOTH B and C. Outcomes match (same bet, same
      // market price); ROI on the intersection is the apples-to-apples
      // "what happened on the shared signal set" number. If the B-vs-C
      // aggregate Δ is large but the intersection is most of both
      // configs' signals, the Δ comes from a few re-bucketed signals,
      // not from FRV per-signal improvement.
      count: overlapBvsC.length,
      b_only_count: aggB.all.signals - overlapBvsC.length,
      c_only_count: aggC.all.signals - overlapBvsC.length,
      wins: intWins, losses: intLoss, pushes: intPush,
      pnl: Number(intPnl.toFixed(4)),
      wagered: Number(intWag.toFixed(4)),
      roi_pct: intRoi,
    },
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runFrvBacktest };
