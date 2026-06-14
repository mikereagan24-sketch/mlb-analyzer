'use strict';

// RUN_MULT × totals backtest — admin-endpoint version.
//
// Reruns the model over a graded window under five RUN_MULT values,
// varying ONLY the RUN_MULT setting that scales the
// (team_woba - WOBA_BASELINE) * RUN_MULT * park_factor term at
// services/model.js:679-680. Everything else identical: same framing
// substrate (whatever production runs), FRV explicitly OFF (matches
// brief's "current framing, FRV off = production"). Same wind/temp
// inputs read from game_log as-is.
//
// SWEEP
//   45.5 (PROD), 44.0, 43.0, 42.0, 41.0
//   (~-3% to -10% off the 45.5 baseline — the range the 5/23 totals
//   study suggested. Smaller step at the top, wider toward 41 to
//   span the band where mean(model - actual) is expected to cross
//   zero.)
//
// MOTIVATION
//   Two independent analyses (5/23 totals study, 6/13 temp backtest)
//   converged on a systematic totals over-projection: overs lose
//   ~-5%, unders win ~+1.5%, consistent across temp buckets and temp
//   configs. The 5/23 study attributed it to RUN_MULT being too high
//   and noted RUN_MULT was in the big parameter sweep that closed
//   negative — likely because aggregate ROI washed out the totals-
//   side-specific correction. This endpoint isolates the over and
//   under sides instead of aggregating.
//
//   RUN_MULT *also* affects ML (via aRuns/hRuns → Pythagorean win
//   prob). This backtest is about TOTALS only; ML signals are
//   filtered out and not aggregated. The brief notes this caveat
//   explicitly.
//
// HEADLINE CELLS TO READ
//   - over_under_gap_pp per RUN_MULT — over_roi - under_roi. PROD's
//     gap is the "bias"; the RUN_MULT that drives it toward 0 is
//     the ROI-optimal sample-driven value.
//   - model_accuracy.mean_diff_model_minus_actual per RUN_MULT — the
//     value that crosses ~0 is the accuracy-optimal mechanistically-
//     honest target, INDEPENDENT of ROI. If accuracy- and ROI-
//     optimal diverge, that's a hint the totals-emission threshold
//     (TOT_SLOPE / TOT_EMIT_FLOOR) is doing some of the work.
//   - tot_under_roi_trajectory — does under-side ROI collapse as
//     RUN_MULT drops? Under wins might ride on the bias; removing
//     the bias may remove the win. Critical hazard to surface.
//   - signal_mix_trajectory — lower RUN_MULT generates fewer overs /
//     more unders. Visible composition shift.
//
// ⚠ HINDSIGHT BIAS ⚠
//   Counterfactual rerun. Game outcomes observed after the fact.
//   DIRECTIONAL ONLY.
//
// Report-only. No DB writes. No settings mutation. Safe against
// the live prod DB.

const { db, q } = require('../db/schema');
const model = require('./model');
const jobs  = require('./jobs');
const { resolveCatcherMlbId } = jobs;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ============================================================
// Per-game framing/FRV input computation.
// Mirrors services/frv-backtest.js + services/temp-backtest.js.
// Duplicated rather than extracted — three backtest services now;
// the next addition should probably hoist these to
// services/_backtest-helpers.js. For now keep them inline so each
// service is self-contained.
// ============================================================

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

// ============================================================
// UI-highlight + aggregation helpers.
// ============================================================

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

function accumulateFlat(b, sig, graded) {
  b.signals++;
  if (graded.outcome === 'win')  b.wins++;
  if (graded.outcome === 'loss') b.losses++;
  if (graded.outcome === 'push') b.pushes++;
  b.pnl += Number(graded.pnl) || 0;
  if (graded.outcome !== 'push') b.wagered += wageredFor(sig);
}

function accumulateTots(buckets, sig, graded) {
  const k = sig.side === 'over' ? 'tot_over' : 'tot_under';
  accumulateFlat(buckets.all, sig, graded);
  accumulateFlat(buckets[k], sig, graded);
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

// ============================================================
// Sweep configuration.
// ============================================================

// Brief specifies these five values verbatim. PROD is labeled 45.5;
// production may have shifted — output includes live_settings_RUN_MULT
// so the operator can spot the mismatch.
const RUN_MULT_VALUES = [45.5, 44.0, 43.0, 42.0, 41.0];

function newTotsBuckets() {
  return {
    all:       emptyBucket(),
    tot_over:  emptyBucket(),
    tot_under: emptyBucket(),
  };
}

function newCfgAgg() {
  return {
    emit_floor:   newTotsBuckets(),
    ui_highlight: newTotsBuckets(),
    // Accuracy accumulators: per-game (model_total - actual_total)
    // averaged across the scored game set. Same game set across all
    // configs (apples-to-apples), so the difference between cfg means
    // is purely the RUN_MULT effect on estTot.
    accuracy: { sum_diff: 0, sum_estTot: 0, sum_actual: 0, n: 0 },
  };
}

function projectCfgAgg(a) {
  const mean = (s, n) => (n > 0 ? Number((s / n).toFixed(4)) : null);
  return {
    emit_floor:   {
      all:       projectBucket(a.emit_floor.all),
      tot_over:  projectBucket(a.emit_floor.tot_over),
      tot_under: projectBucket(a.emit_floor.tot_under),
    },
    ui_highlight: {
      all:       projectBucket(a.ui_highlight.all),
      tot_over:  projectBucket(a.ui_highlight.tot_over),
      tot_under: projectBucket(a.ui_highlight.tot_under),
    },
    model_accuracy: {
      n_games: a.accuracy.n,
      mean_model_total:                mean(a.accuracy.sum_estTot, a.accuracy.n),
      mean_actual_total:               mean(a.accuracy.sum_actual, a.accuracy.n),
      mean_diff_model_minus_actual:    mean(a.accuracy.sum_diff, a.accuracy.n),
    },
  };
}

function gapPp(over, under) {
  const o = over.roi_pct, u = under.roi_pct;
  if (o == null || u == null) return null;
  return Number((o - u).toFixed(4));
}

function runRunMultTotalsBacktest(opts) {
  const fromDate = opts.fromDate;
  const toDate   = opts.toDate;
  const includeDetail = !!opts.includeDetail;

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();

  // Build the 5 configs. Each clones baseSettings with FRV forced
  // OFF (production state per the brief) and RUN_MULT set to the
  // swept value. baseSettings is never mutated.
  const cfgs = RUN_MULT_VALUES.map(v => ({
    run_mult: v,
    label: v === 45.5 ? 'PROD (45.5)' : ('RUN_MULT=' + v.toFixed(1)),
    settings: Object.assign({}, baseSettings, {
      RUN_MULT: v,
      DEFENSE_FRV_ENABLED: false,
    }),
  }));

  const liveRunMult = Number(baseSettings.RUN_MULT != null ? baseSettings.RUN_MULT : 48);

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);

  const uiThresholds = loadUiHighlightThresholds();

  const aggs = {};
  for (const c of cfgs) aggs[c.run_mult] = newCfgAgg();

  let gamesConsidered = 0, gamesScored = 0, suppressed = 0;
  const plays = [];

  for (const gameRow of games) {
    gamesConsidered++;
    const baseGame = buildBacktestGame(gameRow, baseSettings);

    // Apples-to-apples cut: skip if ANY config suppresses. RUN_MULT
    // doesn't gate suppression in practice, but follow the FRV/temp
    // backtest pattern.
    const perCfg = [];
    let anySuppressed = false;
    for (const c of cfgs) {
      const mr = model.runModel(baseGame, wobaIdx, c.settings, 'standard');
      if (mr && mr._suppressed) anySuppressed = true;
      perCfg.push({ c, mr });
    }
    if (anySuppressed) { suppressed++; continue; }
    gamesScored++;

    const actualTotal = Number(gameRow.away_score) + Number(gameRow.home_score);

    for (const pc of perCfg) {
      const { c, mr } = pc;
      const agg = aggs[c.run_mult];

      // Accuracy bookkeeping — mean(model_total - actual_total) per
      // RUN_MULT. Same game set across configs by the suppression
      // cut above, so cross-config differences are pure RUN_MULT
      // effect.
      const estTot = Number(mr.estTot) || 0;
      const diff = estTot - actualTotal;
      agg.accuracy.sum_diff   += diff;
      agg.accuracy.sum_estTot += estTot;
      agg.accuracy.sum_actual += actualTotal;
      agg.accuracy.n          += 1;

      const sigs = model.getSignals(baseGame, mr, c.settings);
      for (const s of sigs) {
        if (s.type === 'ML') continue; // brief: totals only
        const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
        if (graded.outcome === 'pending') continue;

        accumulateTots(agg.emit_floor, s, graded);
        const hi = isHighlightedSignal(s, uiThresholds);
        if (hi) accumulateTots(agg.ui_highlight, s, graded);

        if (includeDetail) {
          plays.push({
            game_date: gameRow.game_date, game_id: gameRow.game_id,
            run_mult: c.run_mult,
            side: s.side, edge: Number(s.edge),
            market_total: gameRow.market_total,
            model_total: Number(estTot.toFixed(4)),
            actual_total: actualTotal,
            outcome: graded.outcome, pnl: Number(graded.pnl) || 0,
            highlighted: hi,
          });
        }
      }
    }
  }

  // Project + derive headline cells.
  const results = {};
  for (const c of cfgs) results[c.run_mult] = projectCfgAgg(aggs[c.run_mult]);

  // Per-cfg gap (over_roi - under_roi) for both tracks, plus all-
  // totals net pnl and net roi.
  for (const c of cfgs) {
    const r = results[c.run_mult];
    r.over_minus_under_gap_pp = {
      emit_floor:   gapPp(r.emit_floor.tot_over,   r.emit_floor.tot_under),
      ui_highlight: gapPp(r.ui_highlight.tot_over, r.ui_highlight.tot_under),
    };
    r.net_totals = {
      emit_floor:   { pnl_units: r.emit_floor.all.pnl,   roi_pct: r.emit_floor.all.roi_pct },
      ui_highlight: { pnl_units: r.ui_highlight.all.pnl, roi_pct: r.ui_highlight.all.roi_pct },
    };
  }

  // Critical reads.
  // 1. RUN_MULT closest to mean(model - actual) == 0. We pick the
  //    value with the smallest |mean_diff|, AND note whether that
  //    value sits inside the tested range or at an extreme (a clamp
  //    at 45.5 or 41 means the operator should expand the sweep).
  let bestAccVal = null, bestAccAbs = Infinity, bestAccDiff = null;
  for (const c of cfgs) {
    const d = results[c.run_mult].model_accuracy.mean_diff_model_minus_actual;
    if (d == null) continue;
    if (Math.abs(d) < bestAccAbs) { bestAccAbs = Math.abs(d); bestAccVal = c.run_mult; bestAccDiff = d; }
  }
  const accExtremes = bestAccVal != null && (bestAccVal === RUN_MULT_VALUES[0] || bestAccVal === RUN_MULT_VALUES[RUN_MULT_VALUES.length - 1]);

  // 2. tot_under ROI trajectory across configs — does the under
  //    win-rate collapse as RUN_MULT drops?
  const under_roi_trajectory = cfgs.map(c => ({
    run_mult: c.run_mult,
    tot_under_roi_pct: {
      emit_floor:   results[c.run_mult].emit_floor.tot_under.roi_pct,
      ui_highlight: results[c.run_mult].ui_highlight.tot_under.roi_pct,
    },
    tot_under_signals: {
      emit_floor:   results[c.run_mult].emit_floor.tot_under.signals,
      ui_highlight: results[c.run_mult].ui_highlight.tot_under.signals,
    },
  }));
  const over_roi_trajectory = cfgs.map(c => ({
    run_mult: c.run_mult,
    tot_over_roi_pct: {
      emit_floor:   results[c.run_mult].emit_floor.tot_over.roi_pct,
      ui_highlight: results[c.run_mult].ui_highlight.tot_over.roi_pct,
    },
    tot_over_signals: {
      emit_floor:   results[c.run_mult].emit_floor.tot_over.signals,
      ui_highlight: results[c.run_mult].ui_highlight.tot_over.signals,
    },
  }));

  // 3. Signal-mix shift across configs (emit-floor and ui_highlight).
  const signal_mix_trajectory = cfgs.map(c => {
    const ef = results[c.run_mult].emit_floor;
    const ui = results[c.run_mult].ui_highlight;
    return {
      run_mult: c.run_mult,
      emit_floor:   { over_n: ef.tot_over.signals, under_n: ef.tot_under.signals,
                      over_minus_under: ef.tot_over.signals - ef.tot_under.signals },
      ui_highlight: { over_n: ui.tot_over.signals, under_n: ui.tot_under.signals,
                      over_minus_under: ui.tot_over.signals - ui.tot_under.signals },
    };
  });

  // 4. Small-sample flags. Brief threshold: any side n < 50.
  const small_sample_flags = [];
  for (const c of cfgs) {
    const ef = results[c.run_mult].emit_floor;
    const ui = results[c.run_mult].ui_highlight;
    if (ef.tot_over.signals  < 50) small_sample_flags.push({ run_mult: c.run_mult, track: 'emit_floor',   side: 'over',  n: ef.tot_over.signals  });
    if (ef.tot_under.signals < 50) small_sample_flags.push({ run_mult: c.run_mult, track: 'emit_floor',   side: 'under', n: ef.tot_under.signals });
    if (ui.tot_over.signals  < 50) small_sample_flags.push({ run_mult: c.run_mult, track: 'ui_highlight', side: 'over',  n: ui.tot_over.signals  });
    if (ui.tot_under.signals < 50) small_sample_flags.push({ run_mult: c.run_mult, track: 'ui_highlight', side: 'under', n: ui.tot_under.signals });
  }

  const out = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. Counterfactual rerun: "what would the model have signaled if RUN_MULT were different." Outcomes observed after the fact.',
    scope_note: 'TOTALS-ONLY. RUN_MULT also affects ML (via aRuns/hRuns → Pythagorean win prob) but ML signals are excluded from these aggregates per the brief.',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    games_suppressed: suppressed,
    substrate: {
      DEFENSE_FRV_ENABLED: false,
      CATCHER_FRAMING_ENABLED: !!baseSettings.CATCHER_FRAMING_ENABLED,
      note: 'FRV explicitly off; framing matches production live state. Same settings cfg across configs except RUN_MULT.',
    },
    live_settings_RUN_MULT: liveRunMult,
    live_vs_PROD_label_match: Math.abs(liveRunMult - 45.5) < 1e-6,
    ui_thresholds: uiThresholds,
    sweep_values: RUN_MULT_VALUES,
    results,
    headline_reads: {
      // The RUN_MULT minimizing |mean(model - actual)|. If this sits
      // at a sweep extreme (45.5 or 41), the true zero-crossing is
      // outside the tested band — operator should widen the sweep.
      accuracy_optimal_run_mult: bestAccVal,
      accuracy_optimal_mean_diff_model_minus_actual: bestAccDiff != null ? Number(bestAccDiff.toFixed(4)) : null,
      accuracy_optimal_at_sweep_extreme: accExtremes,
      // Under-side trajectory and over-side trajectory side-by-side
      // for direct visual comparison ("did closing the over gap kill
      // the under win?").
      tot_under_roi_trajectory: under_roi_trajectory,
      tot_over_roi_trajectory:  over_roi_trajectory,
      // Composition shift — overs should shrink and unders grow as
      // RUN_MULT drops.
      signal_mix_trajectory,
      small_sample_flags,
    },
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runRunMultTotalsBacktest };
