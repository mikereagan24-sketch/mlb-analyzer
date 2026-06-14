'use strict';

// RUN_MULT × totals backtest — admin-endpoint version.
//
// Reruns the model over a graded window under ten RUN_MULT values,
// varying ONLY the RUN_MULT setting that scales the
// (team_woba - WOBA_BASELINE) * RUN_MULT * park_factor term at
// services/model.js:679-680. Everything else identical: same framing
// substrate (whatever production runs), FRV explicitly OFF (matches
// brief's "current framing, FRV off = production"). Same wind/temp
// inputs read from game_log as-is.
//
// SWEEP
//   41, 42, 43, 44, 45.5 (PROD), 46, 47, 48, 49, 50
//
//   The original downward sweep (45.5..41) found mean(model-actual)
//   at -0.73 at 45.5 and getting MORE negative as RUN_MULT dropped —
//   i.e. the model UNDER-projects, and the accuracy-optimal RUN_MULT
//   sits above the tested band, not below it. This widened sweep
//   tests up to 50 to find the zero-crossing on the high side; the
//   downward leg is kept (41..45) so the prior result is reproducible
//   in the same response.
//
// MOTIVATION
//   Original hypothesis from the 5/23 totals study: model OVER-
//   projects, RUN_MULT too high → drop it. Downward sweep falsified
//   that — accuracy gets worse going down. The same response (overs
//   lose, unders win) is then EITHER (a) the under-projection
//   manifesting as the model emitting under signals on games that
//   actually go OVER the market because the under signal is meant
//   to be a "stay-low" cue and lower scoring games naturally hit
//   under more often by base rate, OR (b) something other than
//   RUN_MULT is driving the over/under ROI gap — e.g. wind/temp
//   asymmetry, market-line skew, or TOT_SLOPE.
//
//   This widened sweep is about finding the mechanistically-honest
//   target on accuracy. The ROI story is reported alongside but the
//   accuracy zero-crossing is the load-bearing number; if accuracy-
//   optimal sits at 49 or 50 and over-side ROI is still negative
//   there, the over-bias on ROI is NOT a RUN_MULT problem and a
//   different lever is needed.
//
//   RUN_MULT *also* affects ML (via aRuns/hRuns → Pythagorean win
//   prob). This backtest is about TOTALS only; ML signals are
//   filtered out and not aggregated. The brief notes this caveat
//   explicitly.
//
// HEADLINE CELLS TO READ
//   - model_accuracy.mean_diff_model_minus_actual per RUN_MULT — the
//     value that crosses ~0 is the accuracy-optimal mechanistically-
//     honest target, INDEPENDENT of ROI. Prior downward sweep showed
//     this is negative at every value down to 41; the widened sweep
//     is meant to find the zero-crossing on the high side. If the
//     crossing still sits at the sweep extreme (50), the operator
//     needs to widen again or accept that the bias is large enough
//     to need a different lever.
//   - per-side accuracy: mean(model-actual) over games that fired
//     OVER vs games that fired UNDER, separately. Lets us see
//     whether the under-projection is uniform across games or
//     concentrated on one side — concentration suggests the
//     selection effect (which games the model thinks are unders) is
//     part of the story, not just RUN_MULT magnitude.
//   - over_under_gap_pp per RUN_MULT — over_roi - under_roi. The
//     "bias" on ROI; the RUN_MULT that drives it toward 0 is the
//     ROI-optimal sample-driven value. If this diverges from the
//     accuracy-optimal, ROI is being moved by something other than
//     RUN_MULT (TOT_SLOPE / TOT_EMIT_FLOOR, market skew, etc.).
//   - tot_over_roi_trajectory — over-side sample SHOULD grow going
//     up (more under-projected games tip into over signals). The
//     prior sweep had over n in single digits at 41; flag n<50 so
//     the operator can see where the sample becomes readable.
//   - tot_under_roi_trajectory — under-side sample shrinks going up.
//     If under ROI collapses as RUN_MULT rises, the under wins were
//     riding on the over-bias being corrected.
//   - signal_mix_trajectory — overs grow + unders shrink going up.
//     Visible composition shift.
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

// Widened sweep: 41..50 with 45.5 (PROD) included. Original downward-
// only sweep showed accuracy-optimal RUN_MULT sits above 45.5; this
// includes 46..50 to find the zero-crossing. PROD label is the 45.5
// entry; output includes live_settings_RUN_MULT so the operator can
// spot a mismatch if production has shifted since the brief.
const RUN_MULT_VALUES = [41.0, 42.0, 43.0, 44.0, 45.5, 46.0, 47.0, 48.0, 49.0, 50.0];

function newTotsBuckets() {
  return {
    all:       emptyBucket(),
    tot_over:  emptyBucket(),
    tot_under: emptyBucket(),
  };
}

function newAccBucket() {
  return { sum_diff: 0, sum_estTot: 0, sum_actual: 0, n: 0 };
}

function newCfgAgg() {
  return {
    emit_floor:   newTotsBuckets(),
    ui_highlight: newTotsBuckets(),
    // Accuracy accumulators: per-game (model_total - actual_total)
    // averaged across the scored game set. Same game set across all
    // configs (apples-to-apples), so the difference between cfg means
    // is purely the RUN_MULT effect on estTot.
    accuracy: newAccBucket(),
    // Per-side accuracy: same statistic restricted to games where the
    // config emitted at least one over signal (or under signal) at
    // emit-floor. Lets us see whether the under-projection is uniform
    // across games or concentrated on one side — concentration means
    // the selection effect (which games the model thinks are unders)
    // is part of the story, not just RUN_MULT magnitude.
    accuracy_over_games:  newAccBucket(),
    accuracy_under_games: newAccBucket(),
  };
}

function projectAcc(bucket) {
  const mean = (s, n) => (n > 0 ? Number((s / n).toFixed(4)) : null);
  return {
    n_games:                       bucket.n,
    mean_model_total:              mean(bucket.sum_estTot, bucket.n),
    mean_actual_total:             mean(bucket.sum_actual, bucket.n),
    mean_diff_model_minus_actual:  mean(bucket.sum_diff,   bucket.n),
  };
}

function projectCfgAgg(a) {
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
    model_accuracy:       projectAcc(a.accuracy),
    model_accuracy_by_side: {
      // Subset of the scored game set restricted to games where this
      // config emitted an over (under) signal at emit-floor. Counts
      // games, not signals — a game with two overs counts once.
      over_games:  projectAcc(a.accuracy_over_games),
      under_games: projectAcc(a.accuracy_under_games),
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

      const estTot = Number(mr.estTot) || 0;
      const diff = estTot - actualTotal;

      // Whole-game accuracy bucket (every scored game contributes).
      agg.accuracy.sum_diff   += diff;
      agg.accuracy.sum_estTot += estTot;
      agg.accuracy.sum_actual += actualTotal;
      agg.accuracy.n          += 1;

      // Single pass: accumulate signals and track whether this cfg
      // emitted any over / any under signal at emit-floor for this
      // game. Per-side accuracy is bumped after the pass so each side
      // sees the game exactly once even if multiple signals fired.
      let firedOver = false, firedUnder = false;
      const sigs = model.getSignals(baseGame, mr, c.settings);
      for (const s of sigs) {
        if (s.type === 'ML') continue; // brief: totals only
        const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
        if (graded.outcome === 'pending') continue;

        if (s.side === 'over')  firedOver = true;
        if (s.side === 'under') firedUnder = true;

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

      if (firedOver) {
        agg.accuracy_over_games.sum_diff   += diff;
        agg.accuracy_over_games.sum_estTot += estTot;
        agg.accuracy_over_games.sum_actual += actualTotal;
        agg.accuracy_over_games.n          += 1;
      }
      if (firedUnder) {
        agg.accuracy_under_games.sum_diff   += diff;
        agg.accuracy_under_games.sum_estTot += estTot;
        agg.accuracy_under_games.sum_actual += actualTotal;
        agg.accuracy_under_games.n          += 1;
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
  // 1. RUN_MULT closest to mean(model - actual) == 0 across the
  //    whole-game sample. If at a sweep extreme (41 or 50), the
  //    true zero-crossing is outside the tested band and the operator
  //    should widen again. The prior downward-only sweep hit this:
  //    best was 45.5 (the top of that band) with diff = -0.73; this
  //    widened sweep should expose the actual crossing.
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

  // 3. Per-side accuracy trajectory — the new read this revision
  //    adds. mean(model - actual) restricted to games where the cfg
  //    fired an over (over_games) vs an under (under_games), per
  //    cfg. A large divergence between the two columns at the same
  //    cfg means the under-projection is concentrated on one side
  //    (selection effect), not uniform across all games.
  const per_side_accuracy_trajectory = cfgs.map(c => {
    const a = results[c.run_mult].model_accuracy_by_side;
    return {
      run_mult: c.run_mult,
      over_games:  { n: a.over_games.n,  mean_diff_model_minus_actual: a.over_games.mean_diff_model_minus_actual  },
      under_games: { n: a.under_games.n, mean_diff_model_minus_actual: a.under_games.mean_diff_model_minus_actual },
    };
  });

  // 4. Signal-mix shift across configs (emit-floor and ui_highlight).
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

  // 5. Small-sample flags. Brief threshold: any side n < 50.
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
      // The RUN_MULT minimizing |mean(model - actual)| over the
      // whole game set. If at sweep extreme (41 or 50), the true
      // crossing is outside the tested band — operator should widen
      // the sweep again or accept the bias is bigger than a
      // coefficient nudge can fix.
      accuracy_optimal_run_mult: bestAccVal,
      accuracy_optimal_mean_diff_model_minus_actual: bestAccDiff != null ? Number(bestAccDiff.toFixed(4)) : null,
      accuracy_optimal_at_sweep_extreme: accExtremes,
      // Side-by-side ROI trajectories across all sweep values.
      // Over-side sample SHOULD grow going up; under shrinks going
      // up. Reading the two together answers: does correcting the
      // bias kill the under win?
      tot_over_roi_trajectory:  over_roi_trajectory,
      tot_under_roi_trajectory: under_roi_trajectory,
      // Per-side accuracy across all sweep values — over_games vs
      // under_games mean_diff. Divergence at the same cfg = under-
      // projection is selection-driven, not uniform.
      per_side_accuracy_trajectory,
      // Composition shift across configs.
      signal_mix_trajectory,
      small_sample_flags,
    },
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runRunMultTotalsBacktest };
