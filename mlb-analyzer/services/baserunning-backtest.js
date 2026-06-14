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
const { resolveCatcherMlbId } = jobs;

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

function newClvAgg() {
  return { n_bets: 0, n_with_close: 0, sumClv: 0, sumAbsClv: 0, nPositive: 0, n_no_close: 0 };
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

  // Load team baserunning. Per-game rate uses team.g (season game
  // count) — accurate mid-season. Falls back to 162 if g is missing
  // (unlikely; FG always returns G on the team aggregate).
  const season = Number(fromDate.slice(0, 4));
  const bsrRows = q.getTeamBaserunning.all(season);
  const bsrByTeam = new Map();
  let teamsWithBsr = 0, sumAbsBsrPerGame = 0;
  for (const r of bsrRows) {
    if (r.bsr == null) continue;
    const g = (r.g != null && r.g > 0) ? r.g : 162;
    const perGame = r.bsr / g;
    bsrByTeam.set(String(r.team).toUpperCase(), perGame);
    teamsWithBsr++;
    sumAbsBsrPerGame += Math.abs(perGame);
  }
  if (teamsWithBsr === 0) {
    return {
      bias_warning: 'team_baserunning is empty for season ' + season
        + ' — run runBaserunningJob first to seed it. Backtest skipped.',
      window: { from: fromDate, to: toDate },
      teams_with_bsr: 0,
    };
  }
  const avgAbsBsrPerGame = sumAbsBsrPerGame / teamsWithBsr;

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

  for (const gameRow of games) {
    gamesConsidered++;
    const parts = (gameRow.game_id || '').split('-');
    const awayTeam = (parts[0] || '').toUpperCase();
    const homeTeam = (parts[1] || '').toUpperCase();
    const awayBsRPerGame = bsrByTeam.get(awayTeam);
    const homeBsRPerGame = bsrByTeam.get(homeTeam);
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
      const close = lookupClosePrice(gameRow.game_date, gameRow.game_id, sideRes.side);
      if (!close) { agg.n_no_close++; return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: null, clv: null }; }
      const myImpl    = impliedP(sideRes.market_ml);
      const closeImpl = impliedP(close.price_ml);
      if (!Number.isFinite(myImpl) || !Number.isFinite(closeImpl)) {
        agg.n_no_close++;
        return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: close.price_ml, clv: null };
      }
      const clv = (closeImpl - myImpl) * 100;
      agg.n_with_close++;
      agg.sumClv += clv;
      agg.sumAbsClv += Math.abs(clv);
      if (clv > 0) agg.nPositive++;
      return { side: sideRes.side, edge: sideRes.edge, price_ml: sideRes.market_ml, close: close.price_ml, clv: Number(clv.toFixed(4)), close_source: close.source };
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

  const out = {
    bias_warning: 'HINDSIGHT BIASED — DIRECTION-ONLY. team_baserunning carries season-cumulative BsR; applying it to early-season games is look-ahead. Forward-honest version awaits ~30d of team_baserunning_snapshot accumulation.',
    scope_note: 'ML-side only. BsR added to each team\'s projected runs (a team\'s baserunning helps its own offense). estTot and totals signals untouched in this readout.',
    window: { from: fromDate, to: toDate },
    games_considered: gamesConsidered,
    games_scored: gamesScored,
    games_suppressed: suppressed,
    games_skipped_missing_bsr: gamesMissingBsr,
    missing_teams: Array.from(missingTeams).sort(),
    baserunning_coverage: {
      season,
      teams_with_bsr: teamsWithBsr,
      avg_abs_team_bsr_per_game: Number(avgAbsBsrPerGame.toFixed(4)),
      note: 'Per-team BsR/game = season BsR / games played; max ±0.15 typical. Margin shift (away_BsR_per_game − home_BsR_per_game) is the bettable Pythag input change.',
    },
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
    disposition_note: 'JUDGE ON: (a) accuracy delta vs its SE band; (b) CLV delta vs its noise band. If both are inside noise, BsR stays OFF (same disposition as FRV). Small clean positive on either metric earns a forward-snapshot follow-up — NOT a wire-to-prod.',
  };
  if (includeDetail) out.plays = plays;
  return out;
}

module.exports = { runBaserunningBacktest };
