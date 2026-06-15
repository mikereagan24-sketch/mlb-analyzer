'use strict';

// Temperature → totals backtest — admin-endpoint version.
//
// Re-grades a date window of graded games under five different
// temperature-adjustment formulas, varying ONLY the per-game
// temp_run_adj that the model reads at services/model.js:722.
// Everything else identical: same framing substrate (whatever
// production runs), FRV explicitly OFF (production state per the
// brief), same roof gating (closed=0, partial ×0.5, open ×1) that
// services/jobs.js:2280 applies when writing temp_run_adj live.
//
// CONFIGS
//   PROD : -0.5 / 0 / 0.3 / 0.6
//          (current production step at services/jobs.js:2266)
//   HOT1 : -0.5 / 0 / 0.3 / 0.6 / 0.9
//          (production + a 5th bucket: temp>=90 → 0.9)
//   HOT2 : -0.5 / 0 / 0.4 / 0.8 / 1.2
//          (steeper top + 90+ bucket at 1.2)
//   LIN  : clamp((tempF-65) * 0.052, ±1.3)
//          (the dead-code continuous formula at services/weather.js:125)
//   LIN2 : clamp((tempF-65) * 0.10, ±1.5)
//          (steeper continuous variant)
//
// HYPOTHESIS
//   Production caps temp at +0.6 above 80°F. If real-world hot games
//   score above projection more than the +0.6 cap suggests, HOT1/
//   HOT2/LIN/LIN2 should improve over-side ROI in the 85+ temp
//   bucket. Configs are identical below ~80°F, so any ROI movement
//   in the lt70 or mid_70_84 buckets is noise (same signals, same
//   outcomes — sanity check that the harness isn't broken).
//
// HOT-BUCKET SAMPLE WARNING
//   Early-summer windows have small 85+ samples. The output flags
//   when hot_85plus_open n < 40 so the operator doesn't read tea
//   leaves out of 12-game samples.
//
// ⚠ HINDSIGHT BIAS ⚠
//   This is a counterfactual: "what would the model have signaled if
//   the temp coefficient were different." Game outcomes and game-day
//   temps are after-the-fact. DIRECTIONAL ONLY.
//
// Report-only. No DB writes. No settings changes. Safe to call
// against the live prod DB.

const { db, q } = require('../db/schema');
const model = require('./model');
const jobs  = require('./jobs');

// Same production resolver the FRV backtest uses — needed by
// buildBacktestGame for framing/FRV input computation.
// Backtest-only resolver (UNIONs active + season). See services/jobs.js.
const { resolveBacktestMlbId: resolveCatcherMlbId } = jobs;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ============================================================
// Per-game framing/FRV input computation.
// Mirrored from services/frv-backtest.js (which mirrors the original
// scripts/framing-frv-hindsight-backtest.js). Duplicated rather than
// extracted because the two services have different per-game pre-
// processing needs; if a third backtest endpoint appears, hoist
// these helpers to a shared module.
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
// UI-highlight + aggregation helpers (mirrors services/frv-backtest.js
// + services/empirical-spread-roi.js).
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

// Totals-only sub-bucketed accumulation. Caller MUST filter ML
// signals out before calling — ML doesn't depend on temp so it would
// be wasted work and pollute the buckets.
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
// Temp formulas — five configs.
// ============================================================

function tempProd(t) { return t < 55 ? -0.5 : t < 70 ? 0 : t < 80 ? 0.3 : 0.6; }
function tempHot1(t) { return t < 55 ? -0.5 : t < 70 ? 0 : t < 80 ? 0.3 : t < 90 ? 0.6 : 0.9; }
function tempHot2(t) { return t < 55 ? -0.5 : t < 70 ? 0 : t < 80 ? 0.4 : t < 90 ? 0.8 : 1.2; }
function tempLin(t)  { return Math.max(-1.3, Math.min(1.3, (t - 65) * 0.052)); }
function tempLin2(t) { return Math.max(-1.5, Math.min(1.5, (t - 65) * 0.10)); }

const TEMP_CONFIGS = [
  { key: 'PROD', label: 'production step (-0.5 / 0 / 0.3 / 0.6, breaks at 55/70/80)', fn: tempProd },
  { key: 'HOT1', label: '+0.9 above 90F (-0.5 / 0 / 0.3 / 0.6 / 0.9, breaks at 55/70/80/90)', fn: tempHot1 },
  { key: 'HOT2', label: 'steeper top (-0.5 / 0 / 0.4 / 0.8 / 1.2, breaks at 55/70/80/90)', fn: tempHot2 },
  { key: 'LIN',  label: 'continuous (tempF-65)*0.052 clamped +/-1.3', fn: tempLin },
  { key: 'LIN2', label: 'steeper continuous (tempF-65)*0.10 clamped +/-1.5', fn: tempLin2 },
];

// Roof gating — exactly mirrors services/jobs.js:2280.
//   closed → 0; partial → ×0.5; open / null / undefined → ×1.
// (The cron defaults roofStatus to 'open' for non-retractable parks
//  at line 2267, so null in the DB is only for legacy rows pre the
//  weather cron. Treating null as open matches the cron default.)
function gateByRoof(rawTempAdj, roofStatus) {
  if (roofStatus === 'closed') return 0;
  if (roofStatus === 'partial') return rawTempAdj * 0.5;
  return rawTempAdj;
}

function tempBucketKey(tempF) {
  if (tempF == null) return null;
  if (tempF < 70) return 'lt70';
  if (tempF < 85) return 'mid_70_84';
  return 'hot_85plus';
}

// Keys in stable iteration order for the by_temp sub-object. The
// hot_85plus_open bucket is a sub-filter of hot_85plus restricted to
// roof_status != 'closed' && != 'partial' — the brief's "hot-game
// test is open-air only effectively" cut.
const TEMP_BUCKET_KEYS = ['lt70', 'mid_70_84', 'hot_85plus', 'hot_85plus_open'];

function newTotsBuckets() {
  const by_temp = {};
  for (const k of TEMP_BUCKET_KEYS) by_temp[k] = emptyBucket();
  return {
    all:       emptyBucket(),
    tot_over:  emptyBucket(),
    tot_under: emptyBucket(),
    by_temp,
  };
}

function newConfigAgg() {
  return {
    emit_floor:   newTotsBuckets(),
    ui_highlight: newTotsBuckets(),
  };
}

function projectTotsBuckets(b) {
  const by_temp = {};
  for (const k of TEMP_BUCKET_KEYS) by_temp[k] = projectBucket(b.by_temp[k]);
  return {
    all:       projectBucket(b.all),
    tot_over:  projectBucket(b.tot_over),
    tot_under: projectBucket(b.tot_under),
    by_temp,
  };
}

function projectConfigAgg(a) {
  return {
    emit_floor:   projectTotsBuckets(a.emit_floor),
    ui_highlight: projectTotsBuckets(a.ui_highlight),
  };
}

function deltaPp(curr, base) {
  if (curr == null || base == null) return null;
  return Number((curr - base).toFixed(4));
}

function buildDeltasVsProd(cfgRes, prodRes) {
  function delForTrack(trackKey) {
    const out = {
      all:       deltaPp(cfgRes[trackKey].all.roi_pct,       prodRes[trackKey].all.roi_pct),
      tot_over:  deltaPp(cfgRes[trackKey].tot_over.roi_pct,  prodRes[trackKey].tot_over.roi_pct),
      tot_under: deltaPp(cfgRes[trackKey].tot_under.roi_pct, prodRes[trackKey].tot_under.roi_pct),
      by_temp: {},
    };
    for (const k of TEMP_BUCKET_KEYS) {
      out.by_temp[k] = deltaPp(cfgRes[trackKey].by_temp[k].roi_pct, prodRes[trackKey].by_temp[k].roi_pct);
    }
    return out;
  }
  return {
    emit_floor:   delForTrack('emit_floor'),
    ui_highlight: delForTrack('ui_highlight'),
  };
}

function runTempBacktest(opts) {
  const fromDate = opts.fromDate;
  const toDate   = opts.toDate;
  const includeDetail = !!opts.includeDetail;

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();

  // Production state per the brief: current framing (whatever
  // baseSettings carries, typically on post fc16748) + FRV explicitly
  // OFF. The temp variation is independent of framing/FRV — same cfg
  // is reused across every config to isolate the temp signal.
  const cfg = Object.assign({}, baseSettings, {
    DEFENSE_FRV_ENABLED: false,
  });

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);

  const uiThresholds = loadUiHighlightThresholds();

  const aggs = {};
  for (const c of TEMP_CONFIGS) aggs[c.key] = newConfigAgg();

  // Game-level counters (used for sample-size warnings + null-temp
  // visibility). Distinct from signal-level bucket counts inside aggs.
  const gameCounts = { lt70: 0, mid_70_84: 0, hot_85plus: 0, hot_85plus_open: 0 };

  let gamesConsidered = 0, gamesScored = 0, suppressed = 0, nullTempSkipped = 0;
  const plays = [];

  for (const gameRow of games) {
    gamesConsidered++;
    const tempF = gameRow.temp_f;
    const roofStatus = gameRow.roof_status;
    // No temp data ⇒ no per-config differential possible. The
    // production model's temp_run_adj would also be null (treated as
    // 0). Drop from the comparison to keep the configs apples-to-
    // apples on the same game set.
    if (tempF == null) { nullTempSkipped++; continue; }

    const baseGame = buildBacktestGame(gameRow, baseSettings);

    // Run all 5 configs; skip the game entirely if ANY config gets a
    // _suppressed model (apples-to-apples on the same game set per
    // the FRV-backtest pattern). Suppression doesn't depend on temp
    // in practice, but the principled check costs little.
    const perCfg = [];
    let anySuppressed = false;
    for (const c of TEMP_CONFIGS) {
      const rawTemp = c.fn(tempF);
      const effTemp = gateByRoof(rawTemp, roofStatus);
      const cfgGame = Object.assign({}, baseGame, { temp_run_adj: effTemp });
      const mr = model.runModel(cfgGame, wobaIdx, cfg, 'standard');
      if (mr && mr._suppressed) anySuppressed = true;
      perCfg.push({ c, cfgGame, mr, effTemp });
    }
    if (anySuppressed) { suppressed++; continue; }
    gamesScored++;

    const tBucket = tempBucketKey(tempF);
    gameCounts[tBucket]++;
    const isHotOpen = tBucket === 'hot_85plus'
      && roofStatus !== 'closed' && roofStatus !== 'partial';
    if (isHotOpen) gameCounts.hot_85plus_open++;

    for (const pc of perCfg) {
      const { c, cfgGame, mr, effTemp } = pc;
      const sigs = model.getSignals(cfgGame, mr, cfg);
      const agg = aggs[c.key];
      for (const s of sigs) {
        // Temp doesn't affect ML — different cfg, same ML signals.
        // Skip ML so the totals comparison isn't drowned out by the
        // identical-across-configs ML buckets.
        if (s.type === 'ML') continue;
        const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
        if (graded.outcome === 'pending') continue;

        // Emit-floor track
        accumulateTots(agg.emit_floor, s, graded);
        accumulateFlat(agg.emit_floor.by_temp[tBucket], s, graded);
        if (isHotOpen) accumulateFlat(agg.emit_floor.by_temp.hot_85plus_open, s, graded);

        // UI-highlight track
        const hi = isHighlightedSignal(s, uiThresholds);
        if (hi) {
          accumulateTots(agg.ui_highlight, s, graded);
          accumulateFlat(agg.ui_highlight.by_temp[tBucket], s, graded);
          if (isHotOpen) accumulateFlat(agg.ui_highlight.by_temp.hot_85plus_open, s, graded);
        }

        if (includeDetail) {
          plays.push({
            game_date: gameRow.game_date, game_id: gameRow.game_id,
            cfg: c.key,
            temp_f: tempF, roof_status: roofStatus,
            temp_run_adj_applied: Number(effTemp.toFixed(4)),
            side: s.side, edge: Number(s.edge),
            market_total: gameRow.market_total,
            outcome: graded.outcome, pnl: Number(graded.pnl) || 0,
            highlighted: hi,
            temp_bucket: tBucket,
          });
        }
      }
    }
  }

  // Build projected results + deltas vs PROD.
  const results = {};
  for (const c of TEMP_CONFIGS) results[c.key] = projectConfigAgg(aggs[c.key]);
  const deltas_vs_PROD = {};
  for (const c of TEMP_CONFIGS) {
    if (c.key === 'PROD') continue;
    deltas_vs_PROD[c.key] = buildDeltasVsProd(results[c.key], results.PROD);
  }

  const out = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. Counterfactual rerun: "what the model would have signaled if the temp coefficient were different." Game outcomes and temps are observed after the fact.',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    games_suppressed: suppressed,
    games_skipped_null_temp: nullTempSkipped,
    substrate: {
      CATCHER_FRAMING_ENABLED: !!cfg.CATCHER_FRAMING_ENABLED,
      DEFENSE_FRV_ENABLED: false,
      note: 'Framing matches production live state; FRV explicitly off per the brief. Same cfg across all temp configs.',
    },
    game_counts_by_temp_bucket: gameCounts,
    hot_85plus_open_sample_warning: gameCounts.hot_85plus_open < 40
      ? ('only ' + gameCounts.hot_85plus_open + ' open-air 85F+ games in window — hot-bucket conclusions are weak below ~40')
      : null,
    ui_thresholds: uiThresholds,
    roof_gating_note: 'temp_run_adj recomputed per config, then gated identically to services/jobs.js:2280 (closed=0, partial x0.5, open x1).',
    ml_signals_note: 'ML signals are identical across configs (temp affects estTot only). Aggregates and plays cover totals only.',
    configs: TEMP_CONFIGS.map(c => ({ key: c.key, label: c.label })),
    results,
    deltas_vs_PROD,
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runTempBacktest };
