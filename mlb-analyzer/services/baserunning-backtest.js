'use strict';

// Baserunning hindsight backtest — admin-endpoint version.
//
// ⚠ HINDSIGHT BIASED — DIRECTION-ONLY ⚠
//
// Reads the CURRENT-STATE team_baserunning (season-cumulative BsR)
// and applies it to historical games — the team's season-to-date
// BsR is by definition look-ahead when scoring games played early
// in the season. This output is a PLAUSIBILITY check, not a forward
// ROI claim. A forward-honest version will be possible once enough
// team_baserunning_snapshot history accumulates (~30+ days) to read
// the as-of value via q.getTeamBaserunningAsOf at scoring time.
//
// PLAN
//   For each scored game in the window:
//     1. Build the game (framing/FRV inputs as production runs them).
//     2. Run runModel once — produces aRuns / hRuns (the Pythag input
//        for the WITHOUT-baserunning baseline).
//     3. Derive per-team baserunning runs/game from team_baserunning:
//          team_BsR_per_game = team.bsr / team.g
//        (uses g, the season game count, so the rate is honest mid-
//        season; falls back to 162 only if g is null.)
//     4. WITH-baserunning counterfactual: shift each side's projected
//        runs by their own team's BsR/G (a team's baserunning HELPS
//        its own offense). aRunsAdj = aRuns + awayBsRPerGame;
//        hRunsAdj = hRuns + homeBsRPerGame. Recompute Pythag inline
//        (mirroring model.js:712-714) for the adjusted home win prob.
//     5. Accuracy: |model_margin − actual_margin| under both configs,
//        averaged across games. model_margin = hRuns − aRuns.
//     6. CLV: per ML morning capture in the window, pick the model-
//        signaled side under each config (chooseMlSignaledSide style
//        — implied-prob edge over market, gated by emit_floor). For
//        each signaled bet, find the close price (gametime sibling
//        from empirical_market_captures or kalshi_ml_markets_snapshot
//        fallback) and compute CLV. Aggregate.
//
// PRODUCTION UNTOUCHED — services/model.js NOT modified; runModel is
// called once per game, and the BsR adjustment is applied inline on
// the returned aRuns/hRuns. The Pythag/edge math is duplicated here
// rather than hooked into runModel.
//
// NO DB WRITES. Reads team_baserunning, game_log, empirical_market_
// captures, kalshi_ml_markets_snapshot. Returns compact JSON.

const { db, q } = require('../db/schema');
const model = require('./model');
const jobs  = require('./jobs');
const { impliedP } = require('./model');
// Backtest-only resolver (UNIONs active 26-man + season fullSeason).
// See services/jobs.js resolveBacktestMlbId. Imported under the
// historical name to minimize diff churn against the team-level
// baserunning backtest harness.
const { resolveBacktestMlbId: resolveCatcherMlbId } = jobs;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// ============================================================
// Per-game framing/FRV input computation — same helpers other
// backtest services use. Duplicated rather than extracted (third+
// service to do this; will hoist to a shared helper if a fifth
// backtest needs it).
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
// Pythag + edge helpers — inline so production model.js stays
// untouched. Mirrors services/model.js:712-714 + the
// chooseMlSignaledSide pattern in empirical-market-capture.js.
// ============================================================

function pythagHomeWp(aRuns, hRuns, pythExp, hfaBoost, wpLo, wpHi) {
  let rawHW;
  if (aRuns <= 0 && hRuns <= 0) rawHW = 0.5;
  else if (hRuns <= 0)          rawHW = 0.25;
  else if (aRuns <= 0)          rawHW = 0.75;
  else rawHW = Math.pow(hRuns, pythExp) / (Math.pow(hRuns, pythExp) + Math.pow(aRuns, pythExp));
  return Math.min(Math.max(rawHW + hfaBoost, wpLo), wpHi);
}

// Pick model-signaled side from per-side implied probs + market prices.
// Edge = model_implied - market_implied. Side with higher positive edge
// wins; null when neither clears emitFloor. Returns {side, edge,
// market_ml} so the caller can compute CLV downstream.
function chooseMlSide(awayImpl, homeImpl, marketAwayMl, marketHomeMl, emitFloor) {
  if (marketAwayMl == null || marketHomeMl == null) return { side: null, edge: null, market_ml: null };
  const awayMktImpl = impliedP(marketAwayMl);
  const homeMktImpl = impliedP(marketHomeMl);
  if (!Number.isFinite(awayMktImpl) || !Number.isFinite(homeMktImpl)) return { side: null, edge: null, market_ml: null };
  const awayEdge = awayImpl - awayMktImpl;
  const homeEdge = homeImpl - homeMktImpl;
  const best = awayEdge >= homeEdge
    ? { side: 'away', edge: awayEdge, market_ml: marketAwayMl }
    : { side: 'home', edge: homeEdge, market_ml: marketHomeMl };
  if (best.edge < emitFloor) return { side: null, edge: null, market_ml: null };
  return best;
}

// Close price lookup. Mirrors the two-prong logic in services/
// empirical-spread-roi.js (sibling first, snapshot fallback). Returns
// the side-specific gametime price (market price on the morning's
// signaled side), or null when neither prong has a value.
function lookupClosePrice(gameDate, gameId, signaledSide) {
  // Gametime sibling — latest empirical_market_captures gametime row
  // for this game's ML market. Side-keyed (away_price_ml or home).
  try {
    const sib = db.prepare(
      "SELECT away_price_ml, home_price_ml "
      + "FROM empirical_market_captures "
      + "WHERE game_date=? AND game_id=? AND market_type='ml' "
      + "  AND capture_track='gametime' "
      + "ORDER BY generated_at DESC LIMIT 1"
    ).get(gameDate, gameId);
    if (sib) {
      const p = signaledSide === 'away' ? sib.away_price_ml
              : signaledSide === 'home' ? sib.home_price_ml
              : null;
      if (p != null) return { price_ml: p, source: 'gametime_sibling' };
    }
  } catch (e) { /* table missing — fall through */ }
  // Snapshot fallback — latest kalshi_ml_markets_snapshot at or
  // before game_date. Same side-keyed read.
  try {
    const snap = db.prepare(
      "SELECT away_ask_ml, home_ask_ml, snapshot_date "
      + "FROM kalshi_ml_markets_snapshot "
      + "WHERE game_date=? AND game_id=? "
      + "  AND snapshot_date <= ? "
      + "ORDER BY snapshot_date DESC LIMIT 1"
    ).get(gameDate, gameId, gameDate);
    if (snap) {
      const p = signaledSide === 'away' ? snap.away_ask_ml
              : signaledSide === 'home' ? snap.home_ask_ml
              : null;
      if (p != null) return { price_ml: p, source: 'snapshot' };
    }
  } catch (e) { /* table missing or no row */ }
  return null;
}

// Morning ML price lookup. For each game in the window, find the
// morning capture's frozen market_away_ml / market_home_ml. Returns
// null when no morning capture exists.
function lookupMorningMlPrices(gameDate, gameId) {
  try {
    return db.prepare(
      "SELECT away_price_ml, home_price_ml "
      + "FROM empirical_market_captures "
      + "WHERE game_date=? AND game_id=? AND market_type='ml' "
      + "  AND capture_track='morning' "
      + "ORDER BY generated_at DESC LIMIT 1"
    ).get(gameDate, gameId) || null;
  } catch (e) { return null; }
}

// ============================================================
// Aggregation helpers.
// ============================================================

// ML PnL helpers — same shape as services/frv-backtest.js so the
// pnl/roi block here is directly comparable. wagered varies by line:
// favorites stake |line| to win 100; dogs stake 100 to win line.
function americanProfit(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return 0;
  return ml > 0 ? ml : (100 * 100) / Math.abs(ml);
}
function mlWageredFor(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return 0;
  return ml > 0 ? (10000 / ml) : Math.abs(ml);
}

function newClvAgg() {
  return {
    n_bets: 0, n_with_close: 0, sumClv: 0, sumAbsClv: 0, nPositive: 0, n_no_close: 0,
    // PnL/ROI accumulators — graded from final scores in the game loop.
    // MLB ML is push-free (no tied finals), so wins + losses == n_graded.
    wins: 0, losses: 0, pnl: 0, wagered: 0, n_graded: 0,
  };
}

function projectClv(a) {
  if (!a.n_bets) return { n_bets: 0, n_with_close: 0, avg_clv_pp: null, pct_positive: null, n_no_close: 0 };
  return {
    n_bets:        a.n_bets,
    n_with_close:  a.n_with_close,
    n_no_close:    a.n_no_close,
    avg_clv_pp:    a.n_with_close > 0 ? Number((a.sumClv / a.n_with_close).toFixed(4)) : null,
    pct_positive:  a.n_with_close > 0 ? Number((100 * a.nPositive / a.n_with_close).toFixed(2)) : null,
  };
}

function projectPnl(a) {
  if (!a.n_bets) return { n_bets: 0, n_graded: 0, wins: 0, losses: 0, pnl: 0, wagered: 0, roi_pct: null };
  return {
    n_bets:   a.n_bets,
    n_graded: a.n_graded,
    wins:     a.wins,
    losses:   a.losses,
    pnl:      Number(a.pnl.toFixed(4)),
    wagered:  Number(a.wagered.toFixed(4)),
    roi_pct:  a.wagered > 0 ? Number((100 * a.pnl / a.wagered).toFixed(4)) : null,
  };
}

function runBaserunningBacktest(opts) {
  const fromDate = opts.fromDate;
  const toDate   = opts.toDate;
  const includeDetail = !!opts.includeDetail;

  const baseSettings = jobs.getSettings();
  const wobaIdx = jobs.getWobaIndex();
  const cfg = Object.assign({}, baseSettings, { DEFENSE_FRV_ENABLED: false });

  // Pythag tunables — defaults match model.js's num() defaults.
  const PYTH_EXP  = Number(cfg.PYTH_EXP  != null ? cfg.PYTH_EXP  : 1.83);
  const HFA_BOOST = Number(cfg.HFA_BOOST != null ? cfg.HFA_BOOST : 0.02);
  const WP_CLAMP_LO = Number(cfg.WP_CLAMP_LO != null ? cfg.WP_CLAMP_LO : 0.10);
  const WP_CLAMP_HI = Number(cfg.WP_CLAMP_HI != null ? cfg.WP_CLAMP_HI : 0.90);
  const EMIT_FLOOR  = Number(cfg.SIGNAL_EMIT_FLOOR_PP != null ? cfg.SIGNAL_EMIT_FLOOR_PP : 0.01);

  // LEVEL switch — 'team' (default) or 'player'. Player level reuses
  // the same harness (Pythag, accuracy, CLV) but builds per-team
  // BsR/game from the 9 starters' BsR sum instead of the team-
  // aggregate row.
  //
  // WINDOW switch (player-level only) — 'ytd' (default, season=2026
  // cumulative from player_baserunning) or 'trailing' (~365-day rolling
  // from player_baserunning_trailing). Trailing addresses the ~70-game
  // YTD sample noise that washed out lineup-specificity in the first
  // player-level run.
  //
  // FORWARD-HONEST switch (player + trailing only) — when true, reads
  // each player's BsR AS OF game_date from
  // player_baserunning_trailing_snapshot, never applying future BsR to
  // past games. Games with no snapshot at-or-before their date are
  // skipped. Coverage data (n_snapshot_days, date range) is surfaced
  // in baserunning_coverage so an early/empty result is interpretable.
  // No other variant supports forward mode (team/YTD snapshot tables
  // exist but are not wired here — out of scope for this build).
  const level = opts.level === 'player' ? 'player' : 'team';
  const window = opts.window === 'trailing' ? 'trailing' : 'ytd';
  const forwardHonestRequested = !!opts.forwardHonest;
  const forwardHonest = forwardHonestRequested && level === 'player' && window === 'trailing';
  const { resolveBacktestMlbId } = jobs;

  const season = Number(fromDate.slice(0, 4));

  let bsrRows = null;
  let playerBsrById = null;
  let playerWindowMeta = null;            // for trailing mode response
  let playerStintCountById = null;        // trailing only: mlb_id → stint count
  let multiTeamPlayersInPull = 0;         // trailing only: # players w/ stint_count > 1

  if (level === 'team') {
    bsrRows = q.getTeamBaserunning.all(season);
    if (!bsrRows.length) {
      return {
        bias_warning: 'team_baserunning is empty for season ' + season
          + ' — run runBaserunningJob first to seed it. Backtest skipped.',
        window: { from: fromDate, to: toDate },
        level,
        teams_with_bsr: 0,
      };
    }
  } else if (window === 'ytd') {
    if (!q.getPlayerBaserunning) {
      return {
        bias_warning: 'player_baserunning helpers missing — db migration not yet applied.',
        window: { from: fromDate, to: toDate },
        level, window,
      };
    }
    const playerRows = q.getPlayerBaserunning.all(season);
    if (!playerRows.length) {
      return {
        bias_warning: 'player_baserunning is empty for season ' + season
          + ' — POST /admin/refresh/player-baserunning first to seed.',
        window: { from: fromDate, to: toDate },
        level, window,
        players_with_bsr: 0,
      };
    }
    playerBsrById = new Map();
    for (const r of playerRows) {
      if (r.bsr == null) continue;
      const id = Number(r.mlbam_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      playerBsrById.set(id, Number(r.bsr));
    }
  } else if (!forwardHonest) {
    // window === 'trailing', hindsight mode — current cumulative
    // trailing-1yr row per player applied to all games in [from..to].
    if (!q.getPlayerBaserunningTrailing) {
      return {
        bias_warning: 'player_baserunning_trailing helpers missing — db migration not yet applied.',
        window: { from: fromDate, to: toDate },
        level, window,
      };
    }
    const playerRows = q.getPlayerBaserunningTrailing.all();
    if (!playerRows.length) {
      return {
        bias_warning: 'player_baserunning_trailing is empty — POST /admin/refresh/player-baserunning-trailing first to seed.',
        window: { from: fromDate, to: toDate },
        level, window,
        players_with_bsr: 0,
      };
    }
    playerBsrById = new Map();
    // Multi-team stint tracking. Players with stint_count > 1 had
    // their BsR aggregated across two team-stints by xMLBAMID — a
    // small look-ahead: the lineup gets the full-window value
    // regardless of which team's lineup he appeared in. Tracked so
    // the coverage block can quantify the slot exposure (and we can
    // calibrate the -0.0131 trailing-1yr accuracy delta against it).
    playerStintCountById = new Map();
    for (const r of playerRows) {
      if (r.bsr == null) continue;
      const id = Number(r.mlbam_id);
      if (!Number.isFinite(id) || id <= 0) continue;
      playerBsrById.set(id, Number(r.bsr));
      const sc = (r.stint_count != null) ? Number(r.stint_count) : 1;
      playerStintCountById.set(id, sc);
      if (sc > 1) multiTeamPlayersInPull++;
    }
    // Surface the actual trailing window (from one of the persisted
    // rows) so the response is honest about what data ran.
    const sample = playerRows[0];
    if (sample) {
      playerWindowMeta = {
        startdate: sample.window_startdate,
        enddate:   sample.window_enddate,
        refreshed_at: sample.refreshed_at,
      };
    }
  } else {
    // Forward-honest path. No upfront load — each game's BsR map is
    // built lazily from player_baserunning_trailing_snapshot at the
    // game's date (cache keyed on the resolved snapshot_date). Pre-
    // flight: confirm any snapshot data exists, otherwise the run is
    // structurally empty and we surface that explicitly.
    if (!q.getPlayerBaserunningTrailingAsOf || !q.getPlayerBaserunningTrailingSnapshotCoverage) {
      return {
        bias_warning: 'player_baserunning_trailing_snapshot helpers missing — db migration not yet applied. Forward-honest mode requires the snapshot table + as-of read.',
        window: { from: fromDate, to: toDate },
        level, window, mode: 'forward_honest',
      };
    }
    const cov = q.getPlayerBaserunningTrailingSnapshotCoverage.get();
    if (!cov || !cov.n_snapshot_days) {
      return {
        bias_warning: 'player_baserunning_trailing_snapshot has no rows yet. Forward-honest mode reads point-in-time BsR per game_date; without snapshot history it can\'t score any game. The 6 AM PT job (runPlayerBaserunningTrailingJob) writes a snapshot row each day — wait for accumulation.',
        window: { from: fromDate, to: toDate },
        level, window, mode: 'forward_honest',
        snapshot_coverage: { n_snapshot_days: 0, first_snapshot_date: null, last_snapshot_date: null },
        expectation: 'Forward CLV typically needs 60-90 days of snapshots before it clears its noise band, given ~4 bets/20 cross the emit threshold from BsR. This is a clock, not a verdict.',
      };
    }
  }

  // ---- DIVISOR FIX ----
  // The team_baserunning.g column is the FG team=0,ts aggregate G,
  // which is the SUM of every player's games (~1050+ mid-season),
  // NOT the team's games played (~70 mid-season). Pre-fix this
  // service divided r.bsr by r.g → per-game rate ~15x too small,
  // and the counterfactual margin shift inherited the same scaling
  // error. Use real games-played from game_log instead.
  //
  // Counts every completed game (away_score AND home_score non-null)
  // up to the window's toDate, exploded to team rows via the
  // away-home split in game_id. Same "hindsight current-state" tier
  // as BsR itself — both numerator and denominator are season-to-
  // date at end of window. Forward-honest version (per-date games
  // played at scoring time) waits on snapshot accumulation per the
  // original brief.
  const completedRows = db.prepare(
    "SELECT game_id FROM game_log "
    + "WHERE game_date <= ? AND away_score IS NOT NULL AND home_score IS NOT NULL"
  ).all(toDate);
  const gamesByTeam = new Map();
  for (const r of completedRows) {
    const parts = (r.game_id || '').split('-');
    if (parts.length < 2) continue;
    const away = (parts[0] || '').toUpperCase();
    const home = (parts[1] || '').toUpperCase();
    if (away) gamesByTeam.set(away, (gamesByTeam.get(away) || 0) + 1);
    if (home) gamesByTeam.set(home, (gamesByTeam.get(home) || 0) + 1);
  }

  // Team-level BsR/game map (used only in team mode but the denominator
  // map applies to both — player level reads denominator from gamesByTeam
  // directly inside the lineup sum).
  const bsrByTeam = new Map();
  const denominatorByTeam = {};
  let teamsWithBsr = 0, sumAbsBsrPerGame = 0;
  const teamsMissingGameCount = [];
  if (level === 'team') {
    for (const r of bsrRows) {
      if (r.bsr == null) continue;
      const teamKey = String(r.team).toUpperCase();
      if (teamKey.includes('<') || teamKey.length > 4) continue;
      const realG = gamesByTeam.get(teamKey);
      if (!realG || realG <= 0) { teamsMissingGameCount.push(teamKey); continue; }
      const perGame = r.bsr / realG;
      bsrByTeam.set(teamKey, perGame);
      denominatorByTeam[teamKey] = realG;
      teamsWithBsr++;
      sumAbsBsrPerGame += Math.abs(perGame);
    }
    if (teamsWithBsr === 0) {
      return {
        bias_warning: 'No team_baserunning rows resolved to real games-played from game_log for season ' + season,
        window: { from: fromDate, to: toDate },
        level,
        teams_with_bsr: 0,
        teams_missing_game_count: teamsMissingGameCount,
      };
    }
  } else {
    // Player mode: still surface the denominator per team for the
    // coverage block; we won't precompute per-team BsR rates because
    // they're per-game (lineup-dependent).
    for (const [team, g] of gamesByTeam) {
      if (g > 0) denominatorByTeam[team] = g;
    }
  }
  const avgAbsBsrPerGame = level === 'team' && teamsWithBsr > 0
    ? sumAbsBsrPerGame / teamsWithBsr : null;
  const avgGamesPerTeam = Object.values(denominatorByTeam).length > 0
    ? Object.values(denominatorByTeam).reduce((s, x) => s + x, 0)
      / Object.values(denominatorByTeam).length
    : null;

  const games = db.prepare(
    "SELECT * FROM game_log "
    + "WHERE game_date >= ? AND game_date <= ? "
    + "AND away_score IS NOT NULL AND home_score IS NOT NULL "
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);

  let gamesConsidered = 0, gamesScored = 0, suppressed = 0;
  let gamesMissingBsr = 0;
  const missingTeams = new Set();

  // Accuracy accumulators
  let nAcc = 0, sumAbsErrWithout = 0, sumAbsErrWith = 0;
  let sumErrWithout = 0, sumErrWith = 0;
  // For SE on |err| — sample variance of per-game abs-err deltas.
  let sumSqDeltaAbsErr = 0;

  // CLV accumulators per config
  const clvWithout = newClvAgg();
  const clvWith    = newClvAgg();
  // Bet-set diff counters
  let both = 0, withoutOnly = 0, withOnly = 0, sideFlipped = 0;

  const plays = [];

  // Player-level slot-resolution counters (only meaningful in player
  // mode; harmless extras when team mode runs).
  let lineupSlotsTotal = 0, lineupSlotsResolved = 0, lineupSlotsWithBsr = 0;
  // Multi-team stint exposure (trailing mode only). Tracks how many
  // lineup slots' players had BsR aggregated across >1 team-stint
  // within the trailing window — those slots inherit a small look-
  // ahead since the player's full-window BsR is used regardless of
  // which team's lineup he appeared in on a given day. Critical for
  // calibrating any trailing-1yr accuracy delta against the share
  // of slots that carry the aggregation caveat.
  let lineupSlotsMultiTeam = 0;
  const playersUsed = new Set();
  const multiTeamPlayersUsed = new Set();

  // Forward-mode per-date BsR map cache. Each entry is the as-of
  // snapshot Map at the date the snapshot was actually taken (the
  // resolved snapshot_date, not the game_date — many games map to the
  // same snapshot row). Tracks which snapshot dates the run consumed
  // so coverage diagnostics are exact.
  const playerBsrByDate = new Map();      // key: snapshot_date → Map(mlbam_id → bsr)
  const snapshotDateByGameDate = new Map(); // key: game_date → snapshot_date (or null)
  const snapshotDatesUsed = new Set();
  let gamesSkippedNoSnapshot = 0;
  function getPlayerBsrMapForGame(gameDate) {
    if (snapshotDateByGameDate.has(gameDate)) {
      const sd = snapshotDateByGameDate.get(gameDate);
      return { snapshotDate: sd, map: sd ? playerBsrByDate.get(sd) : null };
    }
    const rows = q.getPlayerBaserunningTrailingAsOf.all(gameDate);
    if (!rows || !rows.length) {
      snapshotDateByGameDate.set(gameDate, null);
      return { snapshotDate: null, map: null };
    }
    const sd = rows[0].snapshot_date;
    snapshotDateByGameDate.set(gameDate, sd);
    if (!playerBsrByDate.has(sd)) {
      const m = new Map();
      for (const r of rows) {
        if (r.bsr == null) continue;
        const id = Number(r.mlbam_id);
        if (!Number.isFinite(id) || id <= 0) continue;
        m.set(id, Number(r.bsr));
      }
      playerBsrByDate.set(sd, m);
      // Snapshot window meta — captured the first time a snapshot
      // is consumed. window_startdate/enddate vary across snapshot
      // dates (rolling), so this records the most-recently-used.
      playerWindowMeta = {
        startdate: rows[0].window_startdate,
        enddate:   rows[0].window_enddate,
        snapshot_date: sd,
      };
    }
    snapshotDatesUsed.add(sd);
    return { snapshotDate: sd, map: playerBsrByDate.get(sd) };
  }

  // Lineup-sum-of-starters BsR-per-game (player mode). Returns null if
  // the lineup is empty / team has no games_played / no slot resolves.
  // Resolved slots without a player_baserunning row contribute 0
  // (neutral baserunner) — common for September call-ups with no
  // season total yet. In forward-honest mode `bsrMap` is the as-of
  // snapshot map for this game's date; otherwise it's the static
  // pre-loaded map (passed in for both paths so the function has no
  // implicit dependency on outer state).
  function computePlayerLineupBsRPerGame(team, lineupJson, bsrMap) {
    if (!bsrMap) return null;
    const realG = gamesByTeam.get(team);
    if (!realG || realG <= 0) return null;
    const lineup = tryParse(lineupJson) || [];
    if (!lineup.length) return null;
    let sum = 0, anyResolved = false;
    for (const p of lineup) {
      if (!p || !p.name) continue;
      lineupSlotsTotal++;
      const mlbId = resolveBacktestMlbId(team, p.name);
      if (!mlbId) continue;
      lineupSlotsResolved++;
      const idNum = Number(mlbId);
      const bsr = bsrMap.get(idNum);
      if (bsr != null) {
        sum += bsr;
        lineupSlotsWithBsr++;
        playersUsed.add(idNum);
        anyResolved = true;
        if (playerStintCountById) {
          const sc = playerStintCountById.get(idNum);
          if (sc != null && sc > 1) {
            lineupSlotsMultiTeam++;
            multiTeamPlayersUsed.add(idNum);
          }
        }
      }
    }
    if (!anyResolved) return null;
    return sum / realG;
  }

  for (const gameRow of games) {
    gamesConsidered++;
    const parts = (gameRow.game_id || '').split('-');
    const awayTeam = (parts[0] || '').toUpperCase();
    const homeTeam = (parts[1] || '').toUpperCase();
    // Pick the BsR map for this game. Hindsight modes use the
    // pre-loaded `playerBsrById`; forward mode resolves the as-of
    // snapshot for game_date. Games with no snapshot at-or-before
    // their date are skipped before model scoring.
    let bsrMapForGame = playerBsrById;
    if (forwardHonest) {
      const got = getPlayerBsrMapForGame(gameRow.game_date);
      if (!got.map) {
        gamesSkippedNoSnapshot++;
        continue;
      }
      bsrMapForGame = got.map;
    }
    const awayBsRPerGame = level === 'team'
      ? bsrByTeam.get(awayTeam)
      : computePlayerLineupBsRPerGame(awayTeam, gameRow.away_lineup_json, bsrMapForGame);
    const homeBsRPerGame = level === 'team'
      ? bsrByTeam.get(homeTeam)
      : computePlayerLineupBsRPerGame(homeTeam, gameRow.home_lineup_json, bsrMapForGame);
    if (awayBsRPerGame == null || homeBsRPerGame == null) {
      gamesMissingBsr++;
      if (awayBsRPerGame == null) missingTeams.add(awayTeam);
      if (homeBsRPerGame == null) missingTeams.add(homeTeam);
      continue;
    }

    const baseGame = buildBacktestGame(gameRow, baseSettings);
    const mr = model.runModel(baseGame, wobaIdx, cfg, 'standard');
    if (mr && mr._suppressed) { suppressed++; continue; }
    gamesScored++;

    const aRuns = Number(mr.aRuns) || 0;
    const hRuns = Number(mr.hRuns) || 0;
    const aRunsAdj = Math.max(0, aRuns + awayBsRPerGame);
    const hRunsAdj = Math.max(0, hRuns + homeBsRPerGame);

    const actualMargin = Number(gameRow.home_score) - Number(gameRow.away_score);
    const marginWithout = hRuns - aRuns;
    const marginWith    = hRunsAdj - aRunsAdj;
    const errWithout = marginWithout - actualMargin;
    const errWith    = marginWith    - actualMargin;
    const absErrWithout = Math.abs(errWithout);
    const absErrWith    = Math.abs(errWith);

    nAcc++;
    sumAbsErrWithout += absErrWithout;
    sumAbsErrWith    += absErrWith;
    sumErrWithout    += errWithout;
    sumErrWith       += errWith;
    const deltaAbsErr = absErrWith - absErrWithout;
    sumSqDeltaAbsErr += deltaAbsErr * deltaAbsErr;

    // ---------- CLV path ----------
    const morning = lookupMorningMlPrices(gameRow.game_date, gameRow.game_id);
    if (!morning) {
      if (includeDetail) {
        plays.push({
          game_date: gameRow.game_date, game_id: gameRow.game_id,
          teams: awayTeam + '@' + homeTeam,
          actual_margin: actualMargin,
          margin_without: Number(marginWithout.toFixed(4)),
          margin_with:    Number(marginWith.toFixed(4)),
          bsr_margin:     Number((homeBsRPerGame - awayBsRPerGame).toFixed(4)),
          clv_status: 'no_morning_capture',
        });
      }
      continue;
    }

    const homeWpWithout = pythagHomeWp(aRuns, hRuns, PYTH_EXP, HFA_BOOST, WP_CLAMP_LO, WP_CLAMP_HI);
    const homeWpWith    = pythagHomeWp(aRunsAdj, hRunsAdj, PYTH_EXP, HFA_BOOST, WP_CLAMP_LO, WP_CLAMP_HI);

    const sideWithout = chooseMlSide(1 - homeWpWithout, homeWpWithout,
      morning.away_price_ml, morning.home_price_ml, EMIT_FLOOR);
    const sideWith    = chooseMlSide(1 - homeWpWith,    homeWpWith,
      morning.away_price_ml, morning.home_price_ml, EMIT_FLOOR);

    function tallyClv(agg, sideRes) {
      if (!sideRes.side) return null;
      agg.n_bets++;
      // ---- PnL grading (independent of close lookup) ----
      // MLB ML is push-free; ties don't happen in finals. Grade off
      // gameRow.home_score/away_score and accumulate at the same
      // wagered convention as services/frv-backtest.js.
      const home = Number(gameRow.home_score);
      const away = Number(gameRow.away_score);
      let outcome = null, profit = 0, wagered = 0;
      if (Number.isFinite(home) && Number.isFinite(away) && home !== away) {
        const homeWon = home > away;
        const win = (sideRes.side === 'home' && homeWon) || (sideRes.side === 'away' && !homeWon);
        profit  = win ? americanProfit(sideRes.market_ml) : -mlWageredFor(sideRes.market_ml);
        wagered = mlWageredFor(sideRes.market_ml);
        if (wagered > 0) {
          agg.n_graded++;
          agg.pnl     += profit;
          agg.wagered += wagered;
          if (win) agg.wins++; else agg.losses++;
          outcome = win ? 'win' : 'loss';
        }
      }
      // ---- CLV path ----
      const close = lookupClosePrice(gameRow.game_date, gameRow.game_id, sideRes.side);
      if (!close) {
        agg.n_no_close++;
        return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: null, clv: null, outcome, pnl: outcome ? Number(profit.toFixed(4)) : null };
      }
      const myImpl    = impliedP(sideRes.market_ml);
      const closeImpl = impliedP(close.price_ml);
      if (!Number.isFinite(myImpl) || !Number.isFinite(closeImpl)) {
        agg.n_no_close++;
        return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: close.price_ml, clv: null, outcome, pnl: outcome ? Number(profit.toFixed(4)) : null };
      }
      const clv = (closeImpl - myImpl) * 100;
      agg.n_with_close++;
      agg.sumClv += clv;
      agg.sumAbsClv += Math.abs(clv);
      if (clv > 0) agg.nPositive++;
      return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: close.price_ml, clv: Number(clv.toFixed(4)), close_source: close.source, outcome, pnl: outcome ? Number(profit.toFixed(4)) : null };
    }
    const playWithout = tallyClv(clvWithout, sideWithout);
    const playWith    = tallyClv(clvWith,    sideWith);

    // Bet-set diff
    if (sideWithout.side && sideWith.side) {
      if (sideWithout.side === sideWith.side) both++;
      else sideFlipped++;
    } else if (sideWithout.side && !sideWith.side) withoutOnly++;
    else if (!sideWithout.side && sideWith.side) withOnly++;

    if (includeDetail) {
      plays.push({
        game_date: gameRow.game_date, game_id: gameRow.game_id,
        teams: awayTeam + '@' + homeTeam,
        actual_margin: actualMargin,
        margin_without: Number(marginWithout.toFixed(4)),
        margin_with:    Number(marginWith.toFixed(4)),
        bsr_margin:     Number((homeBsRPerGame - awayBsRPerGame).toFixed(4)),
        away_bsr_per_game: Number(awayBsRPerGame.toFixed(4)),
        home_bsr_per_game: Number(homeBsRPerGame.toFixed(4)),
        market_away_ml: morning.away_price_ml,
        market_home_ml: morning.home_price_ml,
        without: playWithout,
        with:    playWith,
      });
    }
  }

  // Accuracy reporting
  const meanAbsErrWithout = nAcc > 0 ? sumAbsErrWithout / nAcc : null;
  const meanAbsErrWith    = nAcc > 0 ? sumAbsErrWith    / nAcc : null;
  const meanErrWithout    = nAcc > 0 ? sumErrWithout    / nAcc : null;
  const meanErrWith       = nAcc > 0 ? sumErrWith       / nAcc : null;
  const deltaMeanAbs      = (meanAbsErrWith != null && meanAbsErrWithout != null)
    ? meanAbsErrWith - meanAbsErrWithout : null;
  // SE of the mean delta — paired-sample SD / sqrt(n).
  const sdDelta = nAcc > 1
    ? Math.sqrt(sumSqDeltaAbsErr / nAcc - ((sumAbsErrWith - sumAbsErrWithout) / nAcc) ** 2)
    : null;
  const seDelta = (sdDelta != null && nAcc > 0) ? sdDelta / Math.sqrt(nAcc) : null;

  // CLV noise band — crude per-bet SE at -110 odds.
  const clvNoiseBandWithout = clvWithout.n_with_close > 0
    ? Number((100 / Math.sqrt(clvWithout.n_with_close)).toFixed(4)) : null;
  const clvNoiseBandWith = clvWith.n_with_close > 0
    ? Number((100 / Math.sqrt(clvWith.n_with_close)).toFixed(4)) : null;

  // Forward-mode snapshot coverage diagnostics — explicit so an early
  // / empty result is interpretable. Sourced from the same coverage
  // helper the pre-flight uses, plus the per-run set of snapshot dates
  // actually consumed (intersect of [from..to] with available snapshots).
  let snapshotCoverage = null;
  if (forwardHonest) {
    const cov = q.getPlayerBaserunningTrailingSnapshotCoverage.get() || {};
    const used = Array.from(snapshotDatesUsed).sort();
    snapshotCoverage = {
      n_snapshot_days_total:    cov.n_snapshot_days || 0,
      first_snapshot_date:      cov.first_snapshot_date || null,
      last_snapshot_date:       cov.last_snapshot_date  || null,
      n_snapshot_days_used:     used.length,
      first_snapshot_date_used: used[0] || null,
      last_snapshot_date_used:  used[used.length - 1] || null,
      games_skipped_no_snapshot: gamesSkippedNoSnapshot,
      note: 'n_snapshot_days_total = all daily snapshots ever captured. n_snapshot_days_used = distinct snapshot dates this run actually consumed (one per unique game_date in window with a snapshot at-or-before it). games_skipped_no_snapshot counts games in [from..to] earlier than the first snapshot — pure forward attrition, NOT a model failure.',
    };
  }

  // Coverage block changes shape by level.
  const baserunning_coverage = level === 'team' ? {
    season,
    level,
    teams_with_bsr: teamsWithBsr,
    avg_abs_team_bsr_per_game: avgAbsBsrPerGame != null ? Number(avgAbsBsrPerGame.toFixed(4)) : null,
    avg_games_per_team_denominator: avgGamesPerTeam != null ? Number(avgGamesPerTeam.toFixed(2)) : null,
    denominator_by_team: denominatorByTeam,
    teams_missing_game_count: teamsMissingGameCount,
    denominator_source: 'game_log.completed-games-up-to-toDate (NOT FG team_baserunning.g, which is sum-of-player-games at team=0,ts and is ~15x inflated)',
    note: 'Per-team BsR/game = season BsR / real_games_played. Expect avg_abs_per_game ~0.03-0.10, avg_games_per_team_denominator ~60-80 mid-June.',
  } : {
    season,
    level,
    window,
    mode: forwardHonest ? 'forward_honest' : 'hindsight',
    bsr_source_table: forwardHonest ? 'player_baserunning_trailing_snapshot (as-of game_date)' : (window === 'trailing' ? 'player_baserunning_trailing' : 'player_baserunning'),
    trailing_window: playerWindowMeta,
    snapshot_coverage: snapshotCoverage,
    total_players_with_bsr: forwardHonest
      ? null  // varies by date — see snapshot_coverage
      : (playerBsrById ? playerBsrById.size : 0),
    lineup_slots_total:     lineupSlotsTotal,
    lineup_slots_resolved:  lineupSlotsResolved,
    lineup_slots_with_bsr:  lineupSlotsWithBsr,
    slot_resolve_rate_pct:  lineupSlotsTotal > 0
      ? Number((100 * lineupSlotsResolved / lineupSlotsTotal).toFixed(2)) : null,
    slot_bsr_coverage_pct:  lineupSlotsTotal > 0
      ? Number((100 * lineupSlotsWithBsr / lineupSlotsTotal).toFixed(2)) : null,
    unique_players_used:    playersUsed.size,
    avg_games_per_team_denominator: avgGamesPerTeam != null ? Number(avgGamesPerTeam.toFixed(2)) : null,
    // Multi-team stint exposure (trailing mode only). YTD mode has
    // one contiguous in-progress season — no traded-player splits to
    // aggregate, so this block doesn't apply. For trailing, this is
    // the number to read alongside the headline accuracy/CLV delta
    // to calibrate how much of the move could be traded-player smear.
    multi_team_stints: window === 'trailing' ? {
      players_in_pull:         multiTeamPlayersInPull,
      pct_of_players_in_pull:  playerBsrById && playerBsrById.size > 0
        ? Number((100 * multiTeamPlayersInPull / playerBsrById.size).toFixed(2)) : null,
      lineup_slots:            lineupSlotsMultiTeam,
      pct_of_lineup_slots_with_bsr: lineupSlotsWithBsr > 0
        ? Number((100 * lineupSlotsMultiTeam / lineupSlotsWithBsr).toFixed(2)) : null,
      unique_multi_team_players_used: multiTeamPlayersUsed.size,
      note: 'Traded players (Devers "2 Tms") had >1 raw FG row aggregated by xMLBAMID into one full-window total. Lineup scoring uses the full-window value regardless of which team the slot belonged to that day — second-order look-ahead inside the already-flagged hindsight bias. READ THIS ALONGSIDE accuracy.delta_mean_abs_err: if pct_of_lineup_slots_with_bsr is single-digit, the accuracy delta isn\'t materially driven by this smear; if it\'s 15%+, per-stint correction may need to land before treating the delta as load-bearing. Per-stint correction deferred to forward-honest version IF v1 shows life.',
    } : null,
    denominator_source: 'sum_of_9_starters_BsR / game_log.completed-games (team\'s real games). Units match team-level.',
    note: forwardHonest
      ? 'Per-game lineup BsR = Σ(starters\' trailing-1yr BsR AS OF game_date) / team_games_played. Each game reads the latest player_baserunning_trailing_snapshot row whose snapshot_date <= game_date — never future BsR applied to past games. Slot resolution comes from resolveBacktestMlbId (active 26-man ∪ season fullSeason).'
      : 'Per-game lineup BsR = Σ(starters\' ' + (window === 'trailing' ? 'trailing-1yr' : 'YTD season') + ' BsR) / team_games_played. Resolved slots with no row in ' + (window === 'trailing' ? 'player_baserunning_trailing' : 'player_baserunning') + ' contribute 0 (neutral). Slot resolution comes from resolveBacktestMlbId (active 26-man ∪ season fullSeason).',
  };

  const out = {
    bias_warning: forwardHonest
      ? 'FORWARD-HONEST. Each game scored with player BsR AS OF game_date from player_baserunning_trailing_snapshot — never future BsR applied to past games. Games earlier than the first snapshot are skipped (see baserunning_coverage.snapshot_coverage.games_skipped_no_snapshot). This is the only baserunning variant whose CLV is a clean forward measurement. NOTE: the snapshot table does not yet carry stint_count, so multi_team_stints is not measured in forward mode — small look-ahead from xMLBAMID aggregation of traded players still applies underneath the snapshot. See the hindsight trailing run for the slot-exposure calibration.'
      : window === 'trailing'
        ? 'HINDSIGHT BIASED — DIRECTION-ONLY. Trailing-1yr cumulative BsR (window dates in baserunning_coverage.trailing_window) applied retroactively to games in [from..to]. The trailing window is a better true-talent estimate than YTD (~2x sample) but still hindsight when applied to early-window games. ALSO — multi-team players (traded mid-window) had BsR aggregated across stints by xMLBAMID into one full-window talent estimate; lineups inherit that full-window value regardless of which team the player was on that day. Acceptable for lineup scoring (BsR is context-free individual skill, full sample = better talent estimate) but small look-ahead, second-order inside the hindsight bias. See baserunning_coverage.multi_team_stints for slot exposure — pct_of_lineup_slots_with_bsr calibrates how much of any accuracy delta could be traded-player smear. Per-stint correction deferred to forward-honest path IF v1 shows life. Forward-honest path: pass forwardHonest=true (player+trailing only) once snapshot accumulation begins.'
        : 'HINDSIGHT BIASED — DIRECTION-ONLY. Season-cumulative BsR applied retroactively (look-ahead). Forward-honest version awaits ~30d of *_baserunning_snapshot accumulation.',
    forward_honest_expectation: forwardHonest
      ? 'NOT a 30-day verdict. Baserunning nudges only ~4 bets across the emit threshold per ~20, so the forward BET count grows slowly. CLV likely needs 60-90 days of forward data before it clears its noise band. Set the clock, don\'t watch it. Verdict bar: forward ACCURACY holds AND forward CLV turns positive on adequate bet sample. Weight CLV heaviest, accuracy second, ROI last (near-useless until bet count is large). MEASUREMENT ONLY — this output is NOT wired to live scoring.'
      : null,
    requested_forward_honest_but_unsupported: (forwardHonestRequested && !forwardHonest)
      ? 'forwardHonest=true ignored: forward mode is implemented only for level=player + window=trailing. Other variants run in hindsight mode.'
      : undefined,
    scope_note: 'ML-side only. Per-team BsR/game added to each team\'s projected runs (own baserunning helps own offense). estTot and totals untouched.',
    level,
    bsr_window: level === 'player' ? window : null,
    mode: level === 'player' && window === 'trailing'
      ? (forwardHonest ? 'forward_honest' : 'hindsight')
      : 'hindsight',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    games_suppressed: suppressed,
    games_skipped_missing_bsr: gamesMissingBsr,
    games_skipped_no_snapshot: forwardHonest ? gamesSkippedNoSnapshot : undefined,
    missing_teams: Array.from(missingTeams).sort(),
    baserunning_coverage,
    accuracy: {
      n_games: nAcc,
      without: {
        mean_abs_margin_err: meanAbsErrWithout != null ? Number(meanAbsErrWithout.toFixed(4)) : null,
        mean_signed_margin_err: meanErrWithout != null ? Number(meanErrWithout.toFixed(4)) : null,
      },
      with: {
        mean_abs_margin_err: meanAbsErrWith != null ? Number(meanAbsErrWith.toFixed(4)) : null,
        mean_signed_margin_err: meanErrWith != null ? Number(meanErrWith.toFixed(4)) : null,
      },
      delta_mean_abs_err: deltaMeanAbs != null ? Number(deltaMeanAbs.toFixed(4)) : null,
      delta_se_runs: seDelta != null ? Number(seDelta.toFixed(4)) : null,
      interpretation: 'delta_mean_abs_err = with − without. NEGATIVE = BsR improves accuracy. Compare |delta| against delta_se_runs: |delta| > 2*SE is a meaningful improvement.',
    },
    clv: {
      without: Object.assign({}, projectClv(clvWithout), { noise_band_pp: clvNoiseBandWithout }),
      with:    Object.assign({}, projectClv(clvWith),    { noise_band_pp: clvNoiseBandWith }),
      bet_set_diff: { same_side: both, without_only: withoutOnly, with_only: withOnly, side_flipped: sideFlipped },
      interpretation: 'CLV diff between configs is driven by bet-set composition shifts (BsR flips a few marginal selections). With BsR margin typically ±0.05–0.15 runs/game, most games keep the same signaled side; CLV-with vs CLV-without will be close unless BsR is concentrated on tipping cases.',
    },
    pnl: (function () {
      const pnlWithout = projectPnl(clvWithout);
      const pnlWith    = projectPnl(clvWith);
      const dRoi = (pnlWithout.roi_pct != null && pnlWith.roi_pct != null)
        ? Number((pnlWith.roi_pct - pnlWithout.roi_pct).toFixed(4)) : null;
      return {
        without: pnlWithout,
        with:    pnlWith,
        delta_roi_pp: dRoi,
        grading: 'ML; push-free (MLB finals don\'t tie). Wagered = |line| for favorites, 10000/line for dogs (stake-to-win-100), matching services/frv-backtest.js wageredFor.',
        interpretation: 'CORROBORATING CONTEXT ONLY — not a gate. At n~20 bets the ROI standard error is huge (a single -200 favorite loss = -200 / 100 wagered swings ROI by several pp). Use this to disambiguate when accuracy and CLV point opposite directions; do NOT promote BsR on a ROI swing alone.',
      };
    })(),
    disposition_note: 'JUDGE ON: (a) accuracy delta vs its SE band; (b) CLV delta vs its noise band. If both are inside noise, BsR stays OFF (same disposition as FRV). Small clean positive on either metric earns a forward-snapshot follow-up — NOT a wire-to-prod. The pnl block (with/without ROI + delta) is CORROBORATING CONTEXT ONLY — at n~20 the ROI sampling error swamps the signal, so a flattering ROI swing does NOT override a flat/negative accuracy+CLV verdict. ROI is most useful when accuracy and CLV disagree (e.g. trailing-1yr where accuracy improved but CLV worsened): a clean ROI lift in the same direction as accuracy is mild evidence the accuracy gain is real; a clean ROI drop alongside CLV reinforces the CLV verdict.',
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runBaserunningBacktest };
