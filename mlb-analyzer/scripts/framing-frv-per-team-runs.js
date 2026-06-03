#!/usr/bin/env node
'use strict';

// Per-team projected-runs suppression from framing/FRV.
//
// For each graded game in the window, runs the model twice:
//   A. CATCHER_FRAMING_ENABLED=false, DEFENSE_FRV_ENABLED=false
//   B. CATCHER_FRAMING_ENABLED=true,  DEFENSE_FRV_ENABLED=true
// Captures the aRuns / hRuns deltas (A - B) — positive means the
// defending team's framing+fielding suppressed opposing offense by
// that many projected runs. Aggregates per defending team.
//
// ⚠ HINDSIGHT BIASED — DIRECTIONAL ONLY ⚠
// catcher_framing.rv_tot and fielding_frv.total_runs are CURRENT-STATE
// season-to-date values. Applying them retroactively means the model
// "knows" how each catcher / fielder turned out for the full season
// when scoring early-season games. Use the OUTPUT FOR DIRECTION ONLY.
// A forward-honest version becomes possible ~30 days after the
// catcher_framing_snapshot / fielding_frv_snapshot tables (shipped
// in feat/framing-frv-daily-snapshots, e48a26d) accumulate enough
// rows.
//
// USAGE
//   node scripts/framing-frv-per-team-runs.js
//   node scripts/framing-frv-per-team-runs.js --from 2026-04-01 --to 2026-05-30
//   node scripts/framing-frv-per-team-runs.js --from 2026-04-01 --to 2026-05-30 --json out.json
//
// Defaults: 2026-04-01 to 2026-05-30.
//
// No DB writes — safe against prod.

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- CLI args
function parseArgs(argv) {
  const out = { from: '2026-04-01', to: '2026-05-30', json: null, minGames: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--from' || a === '-f') && argv[i+1]) { out.from = argv[++i]; continue; }
    if ((a === '--to'   || a === '-t') && argv[i+1]) { out.to   = argv[++i]; continue; }
    if (a === '--json' && argv[i+1]) { out.json = argv[++i]; continue; }
    if (a === '--min-games' && argv[i+1]) { out.minGames = parseInt(argv[++i], 10); continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/framing-frv-per-team-runs.js '
        + '[--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json out.json] [--min-games N]');
      process.exit(0);
    }
  }
  for (const k of ['from','to']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out[k])) {
      console.error('error: --' + k + ' must be YYYY-MM-DD, got "' + out[k] + '"');
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.minGames) || out.minGames < 1) out.minGames = 10;
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------- imports
const { db, q } = require('../db/schema');
const model = require('../services/model');
const jobs  = require('../services/jobs');
const { normName, stripSfx } = require('../utils/names');

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ---------------------------------------------------------------- framing/FRV helpers
// Replicated from services/jobs.js processGameSignals (~370-497) per
// the convention established by scripts/framing-frv-hindsight-backtest.js.
// If processGameSignals' framing/FRV logic changes upstream, mirror here.
//
// Case-quirk: team_rosters.team is uppercase; game_id parts are
// lowercase. q.getPositionPlayers is case-sensitive, so callers must
// upper-case the team abbr before resolving.

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
      if (pp[pp.length - 1] === last && pp[0][0] === firstInit) candidates.push(p);
    }
  } catch (e) { return null; }
  return candidates.length === 1 ? candidates[0].mlb_id : null;
}

function computeFramingRvPerGame(team, lineupJson, settings) {
  if (!q.getCatcherFramingById) return null;
  const arr = tryParse(lineupJson) || [];
  if (!arr.length) return null;
  const c = arr.find(p => (p.pos || '').toUpperCase() === 'C');
  if (!c || !c.name) return null;
  const mlbId = resolveCatcherMlbId(team, c.name);
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
  const awayAbbrLower = parts[0] || '';
  const homeAbbrLower = parts[1] || '';
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
      const aBp = q.getBullpenWobaBlended(awayAbbrLower, awaySp, hLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      const hBp = q.getBullpenWobaBlended(homeAbbrLower, homeSp, aLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) { /* fall back */ }

  // Upper-case for the framing/FRV resolver (see note in helpers above).
  const awayTeamUpper = awayAbbrLower.toUpperCase();
  const homeTeamUpper = homeAbbrLower.toUpperCase();
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
    // Pass through the uppercase abbrs so the aggregator can key by
    // them without re-deriving from game_id.
    _awayTeamKey: awayTeamUpper,
    _homeTeamKey: homeTeamUpper,
  });
}

// ---------------------------------------------------------------- stats
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------- main
(function main() {
  const banner = '⚠  HINDSIGHT BIASED — DIRECTIONAL ONLY  ⚠';
  console.log('');
  console.log(banner);
  console.log('');
  console.log('PER-TEAM PROJECTED RUNS SUPPRESSION FROM FRAMING/FRV');
  console.log('(' + ARGS.from + ' to ' + ARGS.to + ')');
  console.log('');

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(ARGS.from, ARGS.to);

  if (!games.length) {
    console.log('No graded games in window. Nothing to backtest.');
    console.log('');
    console.log(banner);
    process.exit(0);
  }

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();
  const cfgA = Object.assign({}, baseSettings, { CATCHER_FRAMING_ENABLED: false, DEFENSE_FRV_ENABLED: false });
  const cfgB = Object.assign({}, baseSettings, { CATCHER_FRAMING_ENABLED: true,  DEFENSE_FRV_ENABLED: true  });

  // team -> [delta, delta, ...] of defensive impact (positive = team
  // suppressed opposing offense by that many projected runs).
  const byTeam = new Map();
  // Per-game raw records for downstream spot-checking.
  const perGameRecords = [];
  let gamesConsidered = 0, gamesScored = 0, suppressed = 0;

  for (const gameRow of games) {
    gamesConsidered++;
    const game = buildBacktestGame(gameRow, baseSettings);
    const mrA = model.runModel(game, wobaIdx, cfgA, 'standard');
    const mrB = model.runModel(game, wobaIdx, cfgB, 'standard');
    if ((mrA && mrA._suppressed) || (mrB && mrB._suppressed)) { suppressed++; continue; }
    if (mrA.aRuns == null || mrA.hRuns == null || mrB.aRuns == null || mrB.hRuns == null) continue;
    gamesScored++;

    // delta_aRuns = aRuns_A - aRuns_B (positive → home team's defense
    // suppressed away offense). delta_hRuns symmetric.
    const deltaARuns = mrA.aRuns - mrB.aRuns;
    const deltaHRuns = mrA.hRuns - mrB.hRuns;

    const homeKey = game._homeTeamKey;
    const awayKey = game._awayTeamKey;
    // Home team owns the away-offense delta (their framing/FRV
    // suppressed the away team's offense). Symmetric.
    if (!byTeam.has(homeKey)) byTeam.set(homeKey, []);
    if (!byTeam.has(awayKey)) byTeam.set(awayKey, []);
    byTeam.get(homeKey).push(deltaARuns);
    byTeam.get(awayKey).push(deltaHRuns);

    perGameRecords.push({
      game_date: gameRow.game_date,
      game_id: gameRow.game_id,
      home_team: homeKey, away_team: awayKey,
      home_def_impact: deltaARuns, // home defense vs away offense
      away_def_impact: deltaHRuns, // away defense vs home offense
      homeCatcherFramingRvPerGame: game.homeCatcherFramingRvPerGame,
      awayCatcherFramingRvPerGame: game.awayCatcherFramingRvPerGame,
      homeFieldingRunsPerGame: game.homeFieldingRunsPerGame,
      awayFieldingRunsPerGame: game.awayFieldingRunsPerGame,
    });
  }

  // -------------------------------------------------------------- aggregate
  const rows = [];
  const insufficient = [];
  for (const [team, deltas] of byTeam) {
    const rec = {
      team,
      games: deltas.length,
      mean: mean(deltas),
      median: median(deltas),
      stddev: stddev(deltas),
      total: sum(deltas),
      per_game_deltas: deltas,
    };
    if (deltas.length < ARGS.minGames) insufficient.push(rec);
    else rows.push(rec);
  }
  rows.sort((a, b) => b.mean - a.mean);

  // -------------------------------------------------------------- output
  function pad(s, n, right) {
    s = String(s);
    if (s.length >= n) return s;
    const fill = ' '.repeat(n - s.length);
    return right ? fill + s : s + fill;
  }
  function fmtSigned(x, digits) {
    if (x == null) return '—';
    const s = x.toFixed(digits == null ? 3 : digits);
    return (x >= 0 ? '+' : '') + s;
  }

  const cols = { team: 6, games: 7, mean: 14, median: 16, stddev: 10, total: 18 };
  console.log(
    pad('Team', cols.team)
    + pad('Games', cols.games, true)
    + pad('Mean Δ runs', cols.mean, true)
    + pad('Median Δ runs', cols.median, true)
    + pad('Stddev', cols.stddev, true)
    + pad('Total runs saved', cols.total, true)
  );
  console.log('-'.repeat(cols.team + cols.games + cols.mean + cols.median + cols.stddev + cols.total));
  for (const r of rows) {
    console.log(
      pad(r.team, cols.team)
      + pad(String(r.games), cols.games, true)
      + pad(fmtSigned(r.mean, 3), cols.mean, true)
      + pad(fmtSigned(r.median, 3), cols.median, true)
      + pad((r.stddev == null ? '—' : r.stddev.toFixed(3)), cols.stddev, true)
      + pad(fmtSigned(r.total, 2), cols.total, true)
    );
  }

  console.log('');
  console.log('Negative values = team\'s framing/FRV INCREASES opposing offense\'s');
  console.log('projected runs (bad framing / bad fielding).');
  console.log('');

  const topN = Math.min(5, rows.length);
  console.log('Top ' + topN + ' most positive (good defense suppression):');
  for (let i = 0; i < topN; i++) {
    const r = rows[i];
    console.log('  ' + r.team + '  mean ' + fmtSigned(r.mean, 3)
      + ' runs/game over ' + r.games + ' games (total ' + fmtSigned(r.total, 2) + ')');
  }
  console.log('');
  console.log('Bottom ' + topN + ' (worst defense, framing/FRV makes opp offense projection worse):');
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - topN); i--) {
    const r = rows[i];
    console.log('  ' + r.team + '  mean ' + fmtSigned(r.mean, 3)
      + ' runs/game over ' + r.games + ' games (total ' + fmtSigned(r.total, 2) + ')');
  }

  if (insufficient.length) {
    console.log('');
    console.log('Insufficient sample (< ' + ARGS.minGames + ' games — not ranked):');
    for (const r of insufficient.sort((a, b) => b.games - a.games)) {
      console.log('  ' + r.team + '  ' + r.games + ' games  mean ' + fmtSigned(r.mean, 3));
    }
  }

  console.log('');
  console.log('Games considered: ' + gamesConsidered
    + ' | scored: ' + gamesScored
    + (suppressed ? ' | suppressed: ' + suppressed : ''));
  console.log('Teams ranked: ' + rows.length
    + (insufficient.length ? ' | insufficient sample: ' + insufficient.length : ''));
  console.log('');
  console.log(banner);

  // -------------------------------------------------------------- JSON
  if (ARGS.json) {
    const report = {
      bias_warning: 'HINDSIGHT BIASED — DIRECTIONAL ONLY. catcher_framing and fielding_frv tables hold current-state values applied retroactively. Forward-honest version awaits ~30d of snapshot accumulation.',
      date_window: { from: ARGS.from, to: ARGS.to },
      games_considered: gamesConsidered,
      games_scored: gamesScored,
      suppressed,
      min_games: ARGS.minGames,
      teams_ranked: rows.length,
      teams_insufficient: insufficient.length,
      // Sorted by mean desc; per_game_deltas array preserves order in
      // which the team encountered each game so a downstream consumer
      // can join back to perGameRecords if needed.
      rows: rows.map(r => ({
        team: r.team,
        games: r.games,
        mean: Number(r.mean.toFixed(4)),
        median: Number(r.median.toFixed(4)),
        stddev: r.stddev == null ? null : Number(r.stddev.toFixed(4)),
        total: Number(r.total.toFixed(4)),
        per_game_deltas: r.per_game_deltas.map(d => Number(d.toFixed(4))),
      })),
      insufficient: insufficient.map(r => ({
        team: r.team, games: r.games,
        mean: Number(r.mean.toFixed(4)),
      })),
      per_game_records: perGameRecords,
    };
    fs.writeFileSync(ARGS.json, JSON.stringify(report, null, 2));
    console.log('JSON report written to ' + ARGS.json);
  }

  try { db.close(); } catch (_) {}
})();
