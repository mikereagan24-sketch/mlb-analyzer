'use strict';

// Under-selection diagnostic — admin-endpoint version.
//
// Re-grades emit-floor TOTAL under signals over a graded window and
// slices them across six dimensions to explain WHERE the ~-1 run
// projection miss on under-emitted games concentrates. The RUN_MULT
// fine-grid sweep (commit c3941c1) proved the miss is invariant to
// the multiplier (~-1.0 to -1.1 flat across 45..48); the bias lives
// in selection or in run-gen inputs, not the scalar.
//
// PRIOR FINDING TO RETEST (5/23 totals slice study, smaller sample):
//   - Under edge NOT uniform.
//   - Strongest in low-total / neutral-pitcher-park games.
//   - COLLAPSED at high totals (unders 1/6 at model_total >=9.5).
//   - Park was the strongest single split.
// This endpoint re-tests those fault lines on the current corrected
// substrate (framing on/119-table, FRV off) over the wider window.
//
// SLICES (each is an independent decomposition over the same under
// signal set — a single signal lands in one cell per dimension):
//   1. model_total       — ≤7.0 / 7.0-7.5 / 7.5-8.5 / 8.5-9.5 / ≥9.5
//   2. park_factor       — <0.95 / 0.95-1.00 / 1.00-1.05 / >1.05
//   3. roof              — open / closed / partial / unknown
//   4. edge_runs         — |model_total - market_total|:
//                          0-0.5 / 0.5-1.0 / 1.0-1.5 / 1.5+
//   5. bullpen_heavy     — opener mode OR SP forecast_ip < 5.0 on
//                          either side, else 'standard'
//   6. month             — may / june / m_NN for any other month
//
// PER CELL:
//   n, wins, losses, pushes, record, roi_pct
//   mean_diff_model_minus_actual (the projection miss in runs)
//   noise_band_pp (= 100/sqrt(n) — crude per-bet SE at -110 odds)
//
// ⚠ HINDSIGHT BIAS ⚠
//   This is a counterfactual rerun of selection — game outcomes are
//   observed after the fact. DIRECTIONAL ONLY.
//
// Report-only. No DB writes. No settings mutation. Safe against the
// live prod DB.

const { db, q } = require('../db/schema');
const model = require('./model');
const jobs  = require('./jobs');
// Backtest-only resolver (UNIONs active + season). See services/jobs.js.
const { resolveBacktestMlbId: resolveCatcherMlbId } = jobs;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ============================================================
// Per-game framing/FRV input computation — byte-for-byte the same
// as the FRV/temp/RUN_MULT backtests. Three+ services duplicate
// this now; the next addition should hoist to a shared helper.
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
// Slice key functions.
// ============================================================

function bucketModelTotal(estTot) {
  if (estTot == null || isNaN(estTot)) return 'unknown';
  if (estTot < 7.0)  return 'lt_7.0';
  if (estTot < 7.5)  return '7.0_to_7.5';
  if (estTot < 8.5)  return '7.5_to_8.5';
  if (estTot < 9.5)  return '8.5_to_9.5';
  return 'gte_9.5';
}

function bucketParkFactor(pf) {
  if (pf == null || isNaN(pf)) return 'unknown';
  if (pf < 0.95)   return 'lt_0.95';
  if (pf < 1.00)   return '0.95_to_1.00';
  if (pf < 1.05)   return '1.00_to_1.05';
  return 'gte_1.05';
}

function bucketRoof(rs) {
  if (rs === 'open' || rs === 'closed' || rs === 'partial') return rs;
  return 'unknown';
}

function bucketEdgeRuns(edgeRuns) {
  if (edgeRuns == null || isNaN(edgeRuns)) return 'unknown';
  const e = Math.abs(edgeRuns);
  if (e < 0.5) return 'lt_0.5';
  if (e < 1.0) return '0.5_to_1.0';
  if (e < 1.5) return '1.0_to_1.5';
  return 'gte_1.5';
}

// "bullpen-heavy" via two cheap signals: opener mode on either side
// (from runModel output), or short SP forecast (<5.0 IP) on either
// side (from game_log columns). Either trigger ⇒ 'bullpen_heavy';
// neither ⇒ 'standard'. Hypothesis the brief is testing: model under-
// projects relief-heavy games, concentrating the under-emit bias.
function bucketBullpenHeavy(gameRow, mr) {
  const isOpener = (mr.awayOpenerWeightUsed != null && mr.awayOpenerWeightUsed > 0)
                || (mr.homeOpenerWeightUsed != null && mr.homeOpenerWeightUsed > 0);
  const aFc = gameRow.away_sp_forecast_ip != null ? parseFloat(gameRow.away_sp_forecast_ip) : null;
  const hFc = gameRow.home_sp_forecast_ip != null ? parseFloat(gameRow.home_sp_forecast_ip) : null;
  const shortSp = (aFc != null && !isNaN(aFc) && aFc < 5.0)
               || (hFc != null && !isNaN(hFc) && hFc < 5.0);
  return (isOpener || shortSp) ? 'bullpen_heavy' : 'standard';
}

function bucketMonth(gameDate) {
  if (!gameDate || typeof gameDate !== 'string' || gameDate.length < 7) return 'unknown';
  const m = parseInt(gameDate.substr(5, 2), 10);
  if (isNaN(m)) return 'unknown';
  if (m === 5) return 'may';
  if (m === 6) return 'june';
  return 'm_' + (m < 10 ? '0' + m : String(m));
}

// ============================================================
// Aggregation.
// ============================================================

function newCell() {
  return {
    n: 0, wins: 0, losses: 0, pushes: 0,
    pnl: 0, wagered: 0,
    sum_diff: 0, // sum of (model_total - actual_total)
  };
}

function accumulate(cell, graded, estTot, actualTotal) {
  cell.n++;
  if (graded.outcome === 'win')  cell.wins++;
  if (graded.outcome === 'loss') cell.losses++;
  if (graded.outcome === 'push') cell.pushes++;
  cell.pnl += Number(graded.pnl) || 0;
  // totals at -110: stake 110 to win 100. Push returns stake (no
  // wagered contribution). Same convention as other backtest
  // services.
  if (graded.outcome !== 'push') cell.wagered += 110;
  cell.sum_diff += (estTot - actualTotal);
}

function projectCell(c) {
  const roi = c.wagered > 0 ? Number((100 * c.pnl / c.wagered).toFixed(4)) : null;
  const meanDiff = c.n > 0 ? Number((c.sum_diff / c.n).toFixed(4)) : null;
  const noise = c.n > 0 ? Number((100 / Math.sqrt(c.n)).toFixed(4)) : null;
  const record = c.pushes
    ? (c.wins + '-' + c.losses + '-' + c.pushes)
    : (c.wins + '-' + c.losses);
  return {
    n: c.n,
    wins: c.wins, losses: c.losses, pushes: c.pushes,
    record,
    roi_pct: roi,
    pnl: Number(c.pnl.toFixed(4)),
    mean_diff_model_minus_actual: meanDiff,
    noise_band_pp: noise,
  };
}

function projectSliceMap(map, orderedKeys) {
  const out = {};
  // Deterministic key order — orderedKeys defines bucket sequence;
  // anything in map but not in orderedKeys (shouldn't happen given
  // the bucket functions, but defensive) gets appended at the end
  // in insertion order.
  const seen = new Set();
  for (const k of orderedKeys) {
    if (map[k]) { out[k] = projectCell(map[k]); seen.add(k); }
  }
  for (const k of Object.keys(map)) {
    if (!seen.has(k)) out[k] = projectCell(map[k]);
  }
  return out;
}

const ORDER = {
  model_total:   ['lt_7.0', '7.0_to_7.5', '7.5_to_8.5', '8.5_to_9.5', 'gte_9.5', 'unknown'],
  park_factor:   ['lt_0.95', '0.95_to_1.00', '1.00_to_1.05', 'gte_1.05', 'unknown'],
  roof:          ['open', 'partial', 'closed', 'unknown'],
  edge_runs:     ['lt_0.5', '0.5_to_1.0', '1.0_to_1.5', 'gte_1.5', 'unknown'],
  bullpen_heavy: ['standard', 'bullpen_heavy'],
  month:         ['may', 'june'], // any other month falls through as m_NN, appended
};

function runUnderSelectionDiagnostic(opts) {
  const fromDate = opts.fromDate;
  const toDate   = opts.toDate;
  const includeDetail = !!opts.includeDetail;

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();

  // Production state per the brief: framing per current production
  // (whatever baseSettings carries, typically on post fc16748),
  // FRV explicitly off.
  const cfg = Object.assign({}, baseSettings, { DEFENSE_FRV_ENABLED: false });

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);

  const slices = {
    model_total:   {},
    park_factor:   {},
    roof:          {},
    edge_runs:     {},
    bullpen_heavy: {},
    month:         {},
  };

  function bumpSlice(group, key, graded, estTot, actualTotal) {
    if (!slices[group][key]) slices[group][key] = newCell();
    accumulate(slices[group][key], graded, estTot, actualTotal);
  }

  let gamesConsidered = 0, gamesScored = 0, suppressed = 0;
  let totalUnderSignals = 0;
  const plays = [];

  for (const gameRow of games) {
    gamesConsidered++;
    const baseGame = buildBacktestGame(gameRow, baseSettings);
    const mr = model.runModel(baseGame, wobaIdx, cfg, 'standard');
    if (mr && mr._suppressed) { suppressed++; continue; }
    gamesScored++;

    const estTot = Number(mr.estTot);
    if (!Number.isFinite(estTot)) continue;
    const actualTotal = Number(gameRow.away_score) + Number(gameRow.home_score);
    const marketTotal = gameRow.market_total != null ? Number(gameRow.market_total) : null;
    const edgeRuns = (marketTotal != null && Number.isFinite(marketTotal))
      ? (estTot - marketTotal)
      : null;

    // Slice keys for THIS game — same across every under signal it
    // emits (the model emits at most one totals signal per game per
    // current rules; the loop below is robust to multiple).
    const k_mt   = bucketModelTotal(estTot);
    const k_pf   = bucketParkFactor(Number(gameRow.park_factor));
    const k_rf   = bucketRoof(gameRow.roof_status);
    const k_ed   = bucketEdgeRuns(edgeRuns);
    const k_bp   = bucketBullpenHeavy(gameRow, mr);
    const k_mo   = bucketMonth(gameRow.game_date);

    const sigs = model.getSignals(baseGame, mr, cfg);
    for (const s of sigs) {
      if (s.type === 'ML') continue;
      if (s.side !== 'under') continue;
      const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
      if (graded.outcome === 'pending') continue;
      totalUnderSignals++;

      bumpSlice('model_total',   k_mt, graded, estTot, actualTotal);
      bumpSlice('park_factor',   k_pf, graded, estTot, actualTotal);
      bumpSlice('roof',          k_rf, graded, estTot, actualTotal);
      bumpSlice('edge_runs',     k_ed, graded, estTot, actualTotal);
      bumpSlice('bullpen_heavy', k_bp, graded, estTot, actualTotal);
      bumpSlice('month',         k_mo, graded, estTot, actualTotal);

      if (includeDetail) {
        plays.push({
          game_date: gameRow.game_date, game_id: gameRow.game_id,
          model_total: Number(estTot.toFixed(4)),
          market_total: marketTotal,
          actual_total: actualTotal,
          edge_runs: edgeRuns != null ? Number(edgeRuns.toFixed(4)) : null,
          park_factor: gameRow.park_factor,
          roof_status: gameRow.roof_status,
          slice_keys: { model_total: k_mt, park_factor: k_pf, roof: k_rf,
                        edge_runs: k_ed, bullpen_heavy: k_bp, month: k_mo },
          outcome: graded.outcome,
          pnl: Number(graded.pnl) || 0,
        });
      }
    }
  }

  // Project slice maps with deterministic ordering.
  const projected = {
    model_total:   projectSliceMap(slices.model_total,   ORDER.model_total),
    park_factor:   projectSliceMap(slices.park_factor,   ORDER.park_factor),
    roof:          projectSliceMap(slices.roof,          ORDER.roof),
    edge_runs:     projectSliceMap(slices.edge_runs,     ORDER.edge_runs),
    bullpen_heavy: projectSliceMap(slices.bullpen_heavy, ORDER.bullpen_heavy),
    month:         projectSliceMap(slices.month,         ORDER.month),
  };

  // ===========
  // Headline reads.
  // ===========

  // 1. Largest |mean_diff| cell across all slices, restricted to
  //    cells with n >= MIN_N_FOR_HEADLINE so we're not chasing a
  //    single-game outlier as the "most concentrated" miss.
  const MIN_N_FOR_HEADLINE = 20;
  let worstAcc = null;
  for (const group of Object.keys(projected)) {
    for (const key of Object.keys(projected[group])) {
      const c = projected[group][key];
      if (c.n < MIN_N_FOR_HEADLINE) continue;
      const d = c.mean_diff_model_minus_actual;
      if (d == null) continue;
      if (worstAcc == null || Math.abs(d) > Math.abs(worstAcc.mean_diff)) {
        worstAcc = { slice: group, bucket: key, mean_diff: d,
                     n: c.n, roi_pct: c.roi_pct, noise_band_pp: c.noise_band_pp };
      }
    }
  }
  if (worstAcc) {
    worstAcc.mean_diff = Number(worstAcc.mean_diff.toFixed(4));
  }

  // 2. The 5/23 high-totals gate: model_total >= 9.5 bucket — report
  //    n, ROI, mean_diff, noise band. If both ROI and mean_diff are
  //    bad here, the "don't fire unders at high totals" rule
  //    confirms on the wider sample.
  const highTotalsBucket = projected.model_total['gte_9.5'] || null;

  // 3. May vs June stability — the seasonal/cohort question. Reports
  //    both buckets side by side with deltas; large delta = bias
  //    shifted with season.
  const mayCell  = projected.month['may']  || null;
  const juneCell = projected.month['june'] || null;
  let may_vs_june = null;
  if (mayCell && juneCell && mayCell.n > 0 && juneCell.n > 0) {
    may_vs_june = {
      may:  { n: mayCell.n,  roi_pct: mayCell.roi_pct,  mean_diff_model_minus_actual: mayCell.mean_diff_model_minus_actual },
      june: { n: juneCell.n, roi_pct: juneCell.roi_pct, mean_diff_model_minus_actual: juneCell.mean_diff_model_minus_actual },
      delta_roi_pp_june_minus_may: (mayCell.roi_pct != null && juneCell.roi_pct != null)
        ? Number((juneCell.roi_pct - mayCell.roi_pct).toFixed(4)) : null,
      delta_mean_diff_june_minus_may: (mayCell.mean_diff_model_minus_actual != null && juneCell.mean_diff_model_minus_actual != null)
        ? Number((juneCell.mean_diff_model_minus_actual - mayCell.mean_diff_model_minus_actual).toFixed(4)) : null,
      interpretation: 'delta close to 0 = stable across months; large = bias shifted with season/weather',
    };
  }

  // 4. Composite small-sample flags — any cell with n < 20 across
  //    every slice, so the operator can quickly see which cells are
  //    unreadable.
  const small_n_flags = [];
  for (const group of Object.keys(projected)) {
    for (const key of Object.keys(projected[group])) {
      const c = projected[group][key];
      if (c.n < 20) small_n_flags.push({ slice: group, bucket: key, n: c.n });
    }
  }

  const out = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. Counterfactual re-grading of selection over already-played games; outcomes observed after the fact.',
    scope_note: 'UNDERS ONLY. emit-floor totals under signals. RUN_MULT-invariance of the ~-1 run miss (commit c3941c1 fine-grid sweep) motivates slicing instead of scaling.',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    games_suppressed: suppressed,
    total_under_signals: totalUnderSignals,
    substrate: {
      CATCHER_FRAMING_ENABLED: !!baseSettings.CATCHER_FRAMING_ENABLED,
      DEFENSE_FRV_ENABLED: false,
      note: 'framing matches production live state; FRV explicitly off.',
    },
    noise_band_note: 'noise_band_pp = 100/sqrt(n) — crude per-bet SE at -110 odds (p~0.524). Cross-cell ROI differences within ~sqrt(2)*max(noise) are inside noise.',
    slices: projected,
    headline_reads: {
      // The single most concentrated -1-run miss across all slice
      // dimensions, subject to n >= 20 so it isn't a 3-game outlier.
      worst_accuracy_cell: worstAcc,
      // The 5/23 'don't fire unders at high totals' gate — model_total
      // >= 9.5 bucket. The original finding was unders 1/6 at this
      // bucket; this re-tests on the wider sample.
      high_model_total_bucket: highTotalsBucket,
      // Seasonal/cohort stability — May vs June.
      may_vs_june,
      // Cells too small to read.
      small_n_flags,
      // Quick comparator vectors (so the operator can spot the
      // monotonicity from a single scroll without diving into
      // slices[]).
      model_total_quick: Object.keys(projected.model_total).map(k => ({
        bucket: k,
        n: projected.model_total[k].n,
        roi_pct: projected.model_total[k].roi_pct,
        mean_diff: projected.model_total[k].mean_diff_model_minus_actual,
      })),
      park_factor_quick: Object.keys(projected.park_factor).map(k => ({
        bucket: k,
        n: projected.park_factor[k].n,
        roi_pct: projected.park_factor[k].roi_pct,
        mean_diff: projected.park_factor[k].mean_diff_model_minus_actual,
      })),
      edge_runs_quick: Object.keys(projected.edge_runs).map(k => ({
        bucket: k,
        n: projected.edge_runs[k].n,
        roi_pct: projected.edge_runs[k].roi_pct,
        mean_diff: projected.edge_runs[k].mean_diff_model_minus_actual,
      })),
    },
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runUnderSelectionDiagnostic };
