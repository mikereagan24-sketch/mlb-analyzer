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
  const out = { from: '2026-05-01', to: '2026-06-01', json: null, muteSweep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--from' || a === '-f') && argv[i+1]) { out.from = argv[++i]; continue; }
    if ((a === '--to'   || a === '-t') && argv[i+1]) { out.to   = argv[++i]; continue; }
    if (a === '--json' && argv[i+1]) { out.json = argv[++i]; continue; }
    if (a === '--mute-sweep') { out.muteSweep = true; continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/framing-frv-hindsight-backtest.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json out.json] [--mute-sweep]');
      console.log('  --mute-sweep  Sweep CATCHER_FRAMING_MUTE 0.0..1.0 step 0.1 (11 configs, FRV always OFF).');
      console.log('                Otherwise runs the default 4-config A/B/C/D comparison.');
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
// Uses the PRODUCTION resolveCatcherMlbId from services/jobs.js so the
// hindsight backtest runs on the exact resolver production runs on.
// This is the principled fix after the diag/roster-per-team-status
// episode (commit fc16748) where a local resolver copy in the
// admin-diagnostic endpoint resolved catchers that production missed
// because the diagnostic uppercased team while production passed
// lowercase. One resolver, two callers — the rule applies here too.
// The local upper-case workaround inside buildBacktestGame
// (lines below) is now redundant because the production resolver
// uppercases internally, but kept as defense-in-depth + a marker that
// this script knew about the case quirk before the production fix
// landed.
const { resolveCatcherMlbId } = jobs;

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

// UI-highlight thresholds. Mirror what services/empirical-spread-roi.js
// pulls from app_settings — the sweep readout's "bet only the picks
// the user actually places" filter. Loaded once at backtest start.
// Default values mirror services/settings-schema.js. tot_over has no
// dedicated threshold (overs_enabled is a master switch).
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

// Same rounded-0.5pp check production uses (services/settings-schema.js
// :157-159 comment + services/empirical-spread-roi.js isHighlightedSignal).
// edge*200 → round → /200 = nearest 0.005pp; e.g. raw 0.0445 → 0.045
// clears the dog threshold.
function isHighlightedSignal(sig, t) {
  const rounded = Math.round(Number(sig.edge) * 200) / 200;
  if (sig.type === 'ML') {
    return Number(sig.marketLine) < 0
      ? rounded >= t.fav_min_pp
      : rounded >= t.dog_min_pp;
  }
  // Totals
  if (sig.side === 'over')  return !!t.overs_enabled;
  if (sig.side === 'under') return rounded >= t.under_min_pp;
  return false;
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
// ---------------------------------------------------------------- mute-sweep mode
// --mute-sweep: 11 configs across CATCHER_FRAMING_MUTE in 0.1 steps
// (0.0..1.0). DEFENSE_FRV_ENABLED is forced off for every config so
// the only thing that varies is the framing mute. MUTE=0.0 sets
// CATCHER_FRAMING_ENABLED=false (clean baseline equivalent to A);
// MUTE>0.0 sets ENABLED=true with the swept MUTE value.
//
// All other code paths (helpers, aggregators, JSON shape conventions,
// hindsight-bias caveat) are reused. The default 4-config mode is
// untouched — when --mute-sweep is NOT passed, control falls through
// to the existing A/B/C/D path.
function runMuteSweep(games, baseSettings, wobaIdx, banner) {
  console.log('FRAMING MUTE SWEEP (FRV disabled across all configs)');
  console.log('(' + ARGS.from + ' to ' + ARGS.to + ')');
  console.log('');

  const muteValues = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

  function newAgg() {
    return {
      all: emptyBucket(), ml_fav: emptyBucket(), ml_dog: emptyBucket(),
      tot_over: emptyBucket(), tot_under: emptyBucket(),
    };
  }
  // Build the 11 settings objects once.
  const configs = muteValues.map(mute => {
    const cfg = Object.assign({}, baseSettings, {
      // MUTE=0.0 is the clean-off baseline — gate the feature entirely
      // so the model never reads framing inputs (matches A in the
      // 4-config mode). MUTE>0.0 keeps the feature on and just scales
      // the contribution.
      CATCHER_FRAMING_ENABLED: mute > 0,
      CATCHER_FRAMING_MUTE: mute,
      DEFENSE_FRV_ENABLED: false,
    });
    return { mute, cfg, agg: newAgg(), suppressed: 0 };
  });

  let gamesConsidered = 0, gamesScored = 0;
  for (const gameRow of games) {
    gamesConsidered++;
    const game = buildBacktestGame(gameRow, baseSettings);

    // Run each config once. If ANY config suppresses the game we skip
    // it entirely (so the per-config aggregates are over the same
    // game set and ROIs are apples-to-apples comparable).
    const mrs = configs.map(c => model.runModel(game, wobaIdx, c.cfg, 'standard'));
    let anySuppressed = false;
    for (let i = 0; i < configs.length; i++) {
      if (mrs[i] && mrs[i]._suppressed) { configs[i].suppressed++; anySuppressed = true; }
    }
    if (anySuppressed) continue;
    gamesScored++;

    for (let i = 0; i < configs.length; i++) {
      const c = configs[i];
      const sigs = model.getSignals(game, mrs[i], c.cfg);
      for (const s of sigs) {
        const graded = model.calcPnl(s, gameRow.away_score, gameRow.home_score, gameRow.market_total);
        if (graded.outcome === 'pending') continue;
        accumulate(c.agg, s, graded);
      }
    }
  }

  // -------------------------------------------------------------- summary table
  function pad(s, n, right) {
    s = String(s);
    if (s.length >= n) return s;
    const fill = ' '.repeat(n - s.length);
    return right ? fill + s : s + fill;
  }
  function fmtWLP(b) { return b.wins + '-' + b.losses + (b.pushes ? '-' + b.pushes : ''); }
  function roiNum(b) { return b.wagered > 0 ? (100 * b.pnl / b.wagered) : null; }
  function fmtRoi(b) {
    const r = roiNum(b);
    if (r == null) return '—';
    return (r >= 0 ? '+' : '') + r.toFixed(2) + '%';
  }
  function fmtDeltaPp(curr, base) {
    if (curr == null || base == null) return '—';
    const d = curr - base;
    return (d >= 0 ? '+' : '') + d.toFixed(2) + 'pp';
  }

  const baselineRoi = roiNum(configs[0].agg.all);
  const col = { mute: 7, sig: 10, wl: 10, roi: 11, delta: 14 };
  console.log(
    pad('MUTE', col.mute)
    + pad('Signals', col.sig, true)
    + pad('W-L', col.wl, true)
    + pad('ROI', col.roi, true)
    + pad('Δ from 0.0', col.delta, true)
  );
  console.log('-'.repeat(col.mute + col.sig + col.wl + col.roi + col.delta));
  for (const c of configs) {
    console.log(
      pad(c.mute.toFixed(1), col.mute)
      + pad(String(c.agg.all.signals), col.sig, true)
      + pad(fmtWLP(c.agg.all), col.wl, true)
      + pad(fmtRoi(c.agg.all), col.roi, true)
      + pad(c.mute === 0 ? '—' : fmtDeltaPp(roiNum(c.agg.all), baselineRoi), col.delta, true)
    );
  }

  // Best MUTE — highest ROI among rows that actually had bets graded.
  let best = null;
  for (const c of configs) {
    const r = roiNum(c.agg.all);
    if (r == null) continue;
    if (best == null || r > best.r) best = { mute: c.mute, r };
  }
  console.log('');
  if (best) {
    console.log('Best MUTE: ' + best.mute.toFixed(1)
      + ' (ROI ' + (best.r >= 0 ? '+' : '') + best.r.toFixed(2) + '%)');
  } else {
    console.log('Best MUTE: — (no graded signals)');
  }

  // -------------------------------------------------------------- per-cohort
  console.log('');
  console.log('Per-cohort ROI by MUTE:');
  const cohorts = [
    { label: 'ML Favs',    key: 'ml_fav' },
    { label: 'ML Dogs',    key: 'ml_dog' },
    { label: 'Tot Overs',  key: 'tot_over' },
    { label: 'Tot Unders', key: 'tot_under' },
  ];
  // Header row: MUTE values across the top.
  const cohortCol = { label: 13, val: 9 };
  let header = pad('', cohortCol.label);
  for (const c of configs) header += pad(c.mute.toFixed(1), cohortCol.val, true);
  console.log(header);
  console.log('-'.repeat(cohortCol.label + cohortCol.val * configs.length));
  for (const co of cohorts) {
    let line = pad(co.label, cohortCol.label);
    for (const c of configs) line += pad(fmtRoi(c.agg[co.key]), cohortCol.val, true);
    console.log(line);
  }
  console.log('');
  console.log('(Counts column omitted from cohort matrix to keep width readable; full');
  console.log(' per-cohort signal counts available in JSON output.)');

  const supTotal = configs.reduce((s, c) => s + c.suppressed, 0);
  console.log('');
  console.log('Games considered: ' + gamesConsidered
    + ' | scored: ' + gamesScored
    + (supTotal ? ' | suppressed (any config): '
        + configs.filter(c => c.suppressed).map(c => c.mute.toFixed(1) + '=' + c.suppressed).join(' ') : ''));
  console.log('');
  console.log(banner);

  // -------------------------------------------------------------- JSON
  if (ARGS.json) {
    const report = {
      bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. catcher_framing values are current-state and applied retroactively. Forward-honest version awaits ~30d of snapshot accumulation.',
      mode: 'mute-sweep',
      date_window: { from: ARGS.from, to: ARGS.to },
      games_considered: gamesConsidered,
      games_scored: gamesScored,
      defense_frv_enabled: false,
      configs: configs.map(c => ({
        mute: c.mute,
        framing_enabled: c.mute > 0,
        suppressed: c.suppressed,
        all: c.agg.all,
        ml_fav: c.agg.ml_fav,
        ml_dog: c.agg.ml_dog,
        tot_over: c.agg.tot_over,
        tot_under: c.agg.tot_under,
        roi_pct: {
          all:       roiNum(c.agg.all),
          ml_fav:    roiNum(c.agg.ml_fav),
          ml_dog:    roiNum(c.agg.ml_dog),
          tot_over:  roiNum(c.agg.tot_over),
          tot_under: roiNum(c.agg.tot_under),
        },
      })),
      best: best ? { mute: best.mute, roi_pct: best.r } : null,
    };
    fs.writeFileSync(ARGS.json, JSON.stringify(report, null, 2));
    console.log('JSON report written to ' + ARGS.json);
  }

  try { db.close(); } catch (_) {}
}

(function main() {
  const printedBanner = '⚠  HINDSIGHT BIASED — DIRECTIONAL ONLY  ⚠';

  console.log('');
  console.log(printedBanner);
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

  // --mute-sweep takes over the whole run; default 4-config mode is
  // unreachable on the same invocation. The two modes share the games
  // load + baseSettings + wobaIdx setup above.
  if (ARGS.muteSweep) {
    runMuteSweep(games, baseSettings, wobaIdx, printedBanner);
    return;
  }

  console.log('FRAMING/FRV HINDSIGHT BACKTEST (' + ARGS.from + ' to ' + ARGS.to + ')');
  console.log('');

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
  // UI-highlight parallel aggregates (B and C only — the configs the
  // user asked to A/B for the FRV re-run). Mirrors the sweep's
  // dual-aggregate reporting so the FRV impact can be reported on the
  // bet set the user actually places, not the every-signal-above-emit
  // set. Aggregator shape identical to the emit-floor newAgg().
  const uiThresholds = loadUiHighlightThresholds();
  const aggBhi = newAgg();
  const aggChi = newAgg();
  // FRV-delta classification per game (B vs C splitting). |frvDelta|
  // = absolute change to home OR away runs projection caused by
  // turning FRV on (B has FRV, C does not). Bucket boundary at 0.10
  // runs picked as a "perceptible" threshold — picks where FRV moved
  // the projection by < 0.1 runs are essentially noise.
  const FRV_LARGE_THRESHOLD = 0.10;
  const aggB_largeFrv = newAgg();
  const aggB_smallFrv = newAgg();
  const aggC_largeFrv = newAgg();
  const aggC_smallFrv = newAgg();
  // Same dual aggregator for the highlight bet set.
  const aggBhi_largeFrv = newAgg();
  const aggBhi_smallFrv = newAgg();
  const aggChi_largeFrv = newAgg();
  const aggChi_smallFrv = newAgg();

  // Overlap + divergence tracking. Each non-A config gets its own
  // edge-delta array (signals that fire in BOTH A and that config —
  // used for the "mean edge vs A" row) and its own divergent-from-A
  // bucket (signals that fire in the config but NOT in A).
  const sigsByGame = { A: new Map(), B: new Map(), C: new Map(), D: new Map() };
  const overlapVsA = { B: [], C: [], D: [] };
  const divergentVsA = { bOnly: [], cOnly: [], dOnly: [] };
  // B-vs-C overlap tracking (FRV-only delta on the intersection set).
  const overlapBvsC = [];

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

    // Per-game |FRV delta|: max absolute change to either side's runs
    // projection caused by turning FRV on (B has FRV; C does not).
    // Drives the large/small bucket split below.
    const frvDelta = Math.max(
      Math.abs((mrs.B.aRuns || 0) - (mrs.C.aRuns || 0)),
      Math.abs((mrs.B.hRuns || 0) - (mrs.C.hRuns || 0))
    );
    const frvLarge = frvDelta >= FRV_LARGE_THRESHOLD;

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
    // B/C dual + split bucketing — second pass over locals.B / locals.C
    // so each signal lands exactly once per aggregator family
    // (emit-floor/hi × all/large-FRV/small-FRV).
    for (const k of ['B', 'C']) {
      for (const [, v] of locals[k]) {
        const s = v.sig, graded = v.graded;
        const isHi = isHighlightedSignal(s, uiThresholds);
        // FRV-delta split (emit-floor)
        const splitEmit = (k === 'B')
          ? (frvLarge ? aggB_largeFrv : aggB_smallFrv)
          : (frvLarge ? aggC_largeFrv : aggC_smallFrv);
        accumulate(splitEmit, s, graded);
        if (isHi) {
          // UI-highlight all-signals aggregate
          accumulate(k === 'B' ? aggBhi : aggChi, s, graded);
          // UI-highlight + FRV-delta split
          const splitHi = (k === 'B')
            ? (frvLarge ? aggBhi_largeFrv : aggBhi_smallFrv)
            : (frvLarge ? aggChi_largeFrv : aggChi_smallFrv);
          accumulate(splitHi, s, graded);
        }
      }
    }
    // B-vs-C signal-key overlap for the intersection comparison.
    // Each entry stores the signal that fired in BOTH configs with
    // its B-side and C-side edges + outcomes — lets us compare ROI
    // on a strict intersection set, not just per-config aggregates.
    for (const [k, v] of locals.B) {
      if (locals.C.has(k)) {
        const c = locals.C.get(k);
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

  // ============================================================
  // CORRECTED-SUBSTRATE B-vs-C REPORT
  // The prior -6.58pp FRV result (B-vs-A) ran on a framing
  // substrate broken in two ways since fixed:
  //   1. resolveCatcherMlbId returned null for every catcher in
  //      production because game_id-derived team was lowercase
  //      and team_rosters.team was uppercase (SQLite '=' is
  //      case-sensitive). Fix: fc16748.
  //   2. catcher_framing_historical was the Savant-qualified
  //      subset only (59 catchers) because the bypass URL
  //      parameter was the wrong case (min_pitches vs
  //      minPitches). Fix: f4c2645.
  // This block isolates the C-vs-B comparison (framing-on only
  // vs framing+FRV) on the CORRECTED substrate — the right
  // number to compare against -6.58.
  // ============================================================
  console.log('=== CORRECTED-SUBSTRATE FRV ISOLATION (C=framing-only vs B=framing+FRV) ===');
  console.log('');
  function deltaPpStr(curr, base) {
    if (curr == null || base == null) return '—';
    const d = curr - base;
    return (d >= 0 ? '+' : '') + d.toFixed(2) + 'pp';
  }
  // Emit-floor aggregates
  console.log('-- All graded signals (emit-floor) --');
  console.log('  C (framing-on, FRV-off):  ' + aggC.all.signals + ' sigs, '
    + fmtWLP(aggC.all) + ', ROI ' + fmtRoi(aggC.all));
  console.log('  B (framing-on, FRV-on):   ' + aggB.all.signals + ' sigs, '
    + fmtWLP(aggB.all) + ', ROI ' + fmtRoi(aggB.all)
    + '   Δ ' + deltaPpStr(roiPct(aggB.all), roiPct(aggC.all)));
  console.log('');
  console.log('-- ML splits --');
  console.log('  C ML favs:   ' + aggC.ml_fav.signals + ' / ROI ' + fmtRoi(aggC.ml_fav));
  console.log('  B ML favs:   ' + aggB.ml_fav.signals + ' / ROI ' + fmtRoi(aggB.ml_fav)
    + '   Δ ' + deltaPpStr(roiPct(aggB.ml_fav), roiPct(aggC.ml_fav)));
  console.log('  C ML dogs:   ' + aggC.ml_dog.signals + ' / ROI ' + fmtRoi(aggC.ml_dog));
  console.log('  B ML dogs:   ' + aggB.ml_dog.signals + ' / ROI ' + fmtRoi(aggB.ml_dog)
    + '   Δ ' + deltaPpStr(roiPct(aggB.ml_dog), roiPct(aggC.ml_dog)));
  console.log('');
  console.log('-- UI-highlight bet selection (fav>=' + uiThresholds.fav_min_pp
    + ', dog>=' + uiThresholds.dog_min_pp
    + ', under>=' + uiThresholds.under_min_pp
    + ', overs ' + (uiThresholds.overs_enabled ? 'on' : 'OFF') + ') --');
  console.log('  C all-hi:    ' + aggChi.all.signals + ' / ROI ' + fmtRoi(aggChi.all));
  console.log('  B all-hi:    ' + aggBhi.all.signals + ' / ROI ' + fmtRoi(aggBhi.all)
    + '   Δ ' + deltaPpStr(roiPct(aggBhi.all), roiPct(aggChi.all)));
  console.log('  C ML-fav hi: ' + aggChi.ml_fav.signals + ' / ROI ' + fmtRoi(aggChi.ml_fav));
  console.log('  B ML-fav hi: ' + aggBhi.ml_fav.signals + ' / ROI ' + fmtRoi(aggBhi.ml_fav)
    + '   Δ ' + deltaPpStr(roiPct(aggBhi.ml_fav), roiPct(aggChi.ml_fav)));
  console.log('  C ML-dog hi: ' + aggChi.ml_dog.signals + ' / ROI ' + fmtRoi(aggChi.ml_dog));
  console.log('  B ML-dog hi: ' + aggBhi.ml_dog.signals + ' / ROI ' + fmtRoi(aggBhi.ml_dog)
    + '   Δ ' + deltaPpStr(roiPct(aggBhi.ml_dog), roiPct(aggChi.ml_dog)));
  console.log('');
  console.log('-- Split by per-game |FRV delta on aRuns/hRuns| (threshold ' + FRV_LARGE_THRESHOLD + ' runs) --');
  console.log('  small-delta games  C: ' + aggC_smallFrv.all.signals + ' / ROI ' + fmtRoi(aggC_smallFrv.all));
  console.log('  small-delta games  B: ' + aggB_smallFrv.all.signals + ' / ROI ' + fmtRoi(aggB_smallFrv.all)
    + '   Δ ' + deltaPpStr(roiPct(aggB_smallFrv.all), roiPct(aggC_smallFrv.all))
    + '   (FRV barely moved the projection — Δ should be ~0 if FRV is informative)');
  console.log('  large-delta games  C: ' + aggC_largeFrv.all.signals + ' / ROI ' + fmtRoi(aggC_largeFrv.all));
  console.log('  large-delta games  B: ' + aggB_largeFrv.all.signals + ' / ROI ' + fmtRoi(aggB_largeFrv.all)
    + '   Δ ' + deltaPpStr(roiPct(aggB_largeFrv.all), roiPct(aggC_largeFrv.all))
    + '   (FRV actually moved the projection — Δ here is the real signal)');
  console.log('');
  // B-vs-C intersection — only signals that fired in BOTH configs.
  // Tests whether FRV's edge change on common signals tracks the
  // result, vs whether B's ROI delta is driven by B-only / C-only
  // signal-set differences.
  let bIntPnl = 0, bIntWag = 0, cIntPnl = 0, cIntWag = 0;
  let bIntWins = 0, bIntLoss = 0, cIntWins = 0, cIntLoss = 0;
  for (const o of overlapBvsC) {
    const w = wageredFor(o.sig);
    bIntPnl += Number(o.graded.pnl) || 0;
    if (o.graded.outcome !== 'push') bIntWag += w;
    if (o.graded.outcome === 'win')  bIntWins++;
    if (o.graded.outcome === 'loss') bIntLoss++;
    // C's graded outcome for the same signal — same actual result;
    // pnl is identical since the bet is the same side at the same
    // market price. The intersection's ROI difference must come from
    // sample composition (which signals fall into the intersection),
    // not from re-grading.
  }
  // For C we need a separate sweep over locals.C ∩ locals.B; the
  // outcomes are identical so the C intersection ROI equals B's.
  // We report the count as a sanity check on cross-config signal-set
  // stability — if intersection is much smaller than min(B, C), the
  // configs are firing meaningfully different signal sets.
  const cAllSigs = aggC.all.signals;
  const bAllSigs = aggB.all.signals;
  const intN = overlapBvsC.length;
  console.log('-- Intersection (signals firing in BOTH C and B) --');
  console.log('  intersection count: ' + intN
    + '   (C-only: ' + (cAllSigs - intN) + ', B-only: ' + (bAllSigs - intN) + ')');
  if (intN > 0) {
    const intRoi = bIntWag > 0 ? (100 * bIntPnl / bIntWag) : null;
    console.log('  intersection record (B=C, same signal/outcome): '
      + bIntWins + '-' + bIntLoss + ', ROI '
      + (intRoi != null ? (intRoi >= 0 ? '+' : '') + intRoi.toFixed(2) + '%' : '—'));
    console.log('  (B-vs-C aggregate ROI difference therefore comes from the symmetric');
    console.log('   differences — signals that fire under one config but not the other.');
    console.log('   If aggregate Δ above is large but the symmetric difference is small,');
    console.log('   the FRV-driven re-bucketing of a few games is doing the work.)');
  }
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
