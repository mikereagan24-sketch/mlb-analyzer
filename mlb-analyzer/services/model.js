/** Model service â all settings from DB, no hardcoded constants */
// Fallback used when settings doesn't carry a valid PA_WEIGHTS array
// (should never happen in the Render deploy — getSettings seeds it).
const PA_WEIGHTS_DEFAULT = [4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7];
const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };

// Special-event venues outside the regular 30-stadium set. Keyed by
// statsapi venue.id (captured in services/scraper.js fetchSchedule and
// persisted to game_log.venue_id). When a game is at one of these
// venues, the override's parkFactor wins over the home-team default
// in services/scraper.js PARK_FACTORS — necessary because the home team
// for a Mexico City series is still ARI but Chase Field's 1.10 factor
// understates run scoring at altitude.
const VENUE_OVERRIDES = {
  // Estadio Alfredo Harp Helú — Mexico City series. ~7800 ft elevation.
  // Coors (~5200 ft) plays to ~1.10 park factor; scaling by elevation
  // (each ~1000 ft ≈ +2% factor) puts Mexico City around 1.20.
  5340: { parkFactor: 1.20, name: 'Estadio Alfredo Harp Helú (Mexico City)' },
};

const { normName, fuzzyLookup } = require('../utils/names');

function buildWobaIndex(rows) {
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
  }
  return idx;
}

function blendWoba(proj, act, minSample, wProj, wAct) {
  const hp = proj && !isNaN(proj.woba);
  const ha = act && !isNaN(act.woba) && act.sample >= minSample;
  const wp = wProj || 0.65;
  const wa = wAct  || 0.35;
  if (hp && ha) return { woba: proj.woba*wp + act.woba*wa, source:'blend' };
  if (hp) return { woba: proj.woba, source:'steamer' };
  if (ha) return { woba: act.woba, source:'actual' };
  return null;
}

function getBatterWoba(idx, name, hand, teamHint, wProj, wAct, minPA, settings) {
  if (minPA == null) minPA = 60;
  const bL = blendWoba(
    fuzzyLookup(idx['bat-proj-lhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-lhp'], name, teamHint),
    minPA, wProj, wAct
  );
  const bR = blendWoba(
    fuzzyLookup(idx['bat-proj-rhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-rhp'], name, teamHint),
    minPA, wProj, wAct
  );
  const eff = hand==='S' ? 'R' : (hand||'R');
  // Prefer per-hand BAT_DFLT from settings; fall back to module const for
  // external callers (e.g. routes/api.js debug routes) that don't pass settings.
  let d;
  if (settings && settings.BAT_DFLT_R_VS_RHP != null) {
    const byHand = {
      R: { vsRHP: settings.BAT_DFLT_R_VS_RHP, vsLHP: settings.BAT_DFLT_R_VS_LHP },
      L: { vsRHP: settings.BAT_DFLT_L_VS_RHP, vsLHP: settings.BAT_DFLT_L_VS_LHP },
      S: { vsRHP: settings.BAT_DFLT_S_VS_RHP, vsLHP: settings.BAT_DFLT_S_VS_LHP },
    };
    d = byHand[eff] || byHand.R;
  } else {
    d = BAT_DFLT[eff] || BAT_DFLT['R'];
  }
  if (bL || bR) {
    const src = bL&&bR ? (bL.source===bR.source?bL.source:'blend') : (bL?.source||bR?.source);
    return { vsLHP: bL?.woba??d.vsLHP, vsRHP: bR?.woba??d.vsRHP, source: src };
  }
  return { vsLHP: d.vsLHP, vsRHP: d.vsRHP, source:'fallback' };
}

function getPitcherWoba(idx, name, hand, teamHint, wProj, wAct, minBF, settings) {
  if (minBF == null) minBF = 100;
  const bL = blendWoba(
    fuzzyLookup(idx['pit-proj-lhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-lhb'], name, teamHint),
    minBF, wProj, wAct
  );
  const bR = blendWoba(
    fuzzyLookup(idx['pit-proj-rhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-rhb'], name, teamHint),
    minBF, wProj, wAct
  );
  let d;
  if (settings && settings.PIT_DFLT_R_VS_LHB != null) {
    const byHand = {
      R: { vsLHB: settings.PIT_DFLT_R_VS_LHB, vsRHB: settings.PIT_DFLT_R_VS_RHB },
      L: { vsLHB: settings.PIT_DFLT_L_VS_LHB, vsRHB: settings.PIT_DFLT_L_VS_RHB },
    };
    d = byHand[hand] || byHand.R;
  } else {
    d = PIT_DFLT[hand] || PIT_DFLT['R'];
  }
  const src = bL||bR ? (bL?.source===bR?.source?bL?.source||'steamer':'blend') : 'fallback';
  return { vsLHB: bL?.woba??d.vsLHB, vsRHB: bR?.woba??d.vsRHB, source: src };
}

function effHand(bh, ph) { return bh==='S' ? (ph==='R'?'L':'R') : bh; }

function perBatterEW(batter, pitcherHand, pitWvsL, pitWvsR, W_PIT, W_BAT, SP_WEIGHT, RELIEF_WEIGHT, SP_PIT_WEIGHT, RELIEF_PIT_WEIGHT, bullpenWoba, BAT_DFLT_START, BAT_DFLT_OPP) {
  const eff = effHand(batter.hand, pitcherHand);
  const spPitW  = (SP_PIT_WEIGHT     != null) ? SP_PIT_WEIGHT     : 0.80;
  const relPitW = (RELIEF_PIT_WEIGHT != null) ? RELIEF_PIT_WEIGHT : 0.20;
  const pitWvsBatter = eff === 'L' ? pitWvsL : pitWvsR;
  const pitW = pitWvsBatter * spPitW + bullpenWoba * relPitW;
  const spW  = (SP_WEIGHT  != null) ? SP_WEIGHT  : 0.77;
  const relW = (RELIEF_WEIGHT != null) ? RELIEF_WEIGHT : 0.23;
  const vsStart = pitcherHand === 'R' ? (batter.vsRHP ?? BAT_DFLT_START) : (batter.vsLHP ?? BAT_DFLT_START);
  const vsOpp   = pitcherHand === 'R' ? (batter.vsLHP ?? BAT_DFLT_OPP)   : (batter.vsRHP ?? BAT_DFLT_OPP);
  const batW = vsStart * spW + vsOpp * relW;
  return pitW * W_PIT + batW * W_BAT;
}

function rawToML(wp, clampLo, clampHi) {
  if (clampLo == null) clampLo = 0.25;
  if (clampHi == null) clampHi = 0.75;
  const c = Math.min(Math.max(wp, clampLo), clampHi);
  return c>=0.5 ? -Math.round(c/(1-c)*100) : Math.round((1-c)/c*100);
}

function applySpread(aML, hML, FAV_ADJ, DOG_ADJ) {
  const favIsAway = aML <= hML;
  const rawFav = favIsAway ? aML : hML;
  const rawDog = favIsAway ? hML : aML;
  const adjFav = rawFav - FAV_ADJ; // subtract makes fav more negative
  const adjDog = rawDog + DOG_ADJ; // add makes dog more positive
  return {
    adjA: favIsAway ? adjFav : adjDog,
    adjH: favIsAway ? adjDog : adjFav,
  };
}

function impliedP(ml) {
  ml = parseFloat(ml);
  if (!ml || isNaN(ml)) return 0.5;
  return ml<0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
}

function runModel(game, wobaIdx, settings) {
  // Empty/incomplete lineups → suppress. Model run estimates require a
  // full 9-batter lineup to integrate over PA_WEIGHTS; with 0 or partial
  // lineups, the per-batter EW loop produces 0 contributions, aWp/hWp
  // collapse to 0, and the BAT_DFLT_START fallback produces an
  // artificially flat run estimate that drives confidently-wrong signals
  // (e.g. COL@NYM 2026-04-25 was postponed; empty lineups → 4.52 model
  // total vs 7.5 market → false 3★ Total/Under). Threshold of <8 catches
  // both empty and partially-posted lineups; downstream getSignals and
  // processGameSignals key off _suppressed to skip signal generation +
  // DB writes.
  const awayLineupCount = (game.awayLineup || []).length;
  const homeLineupCount = (game.homeLineup || []).length;
  if (awayLineupCount < 8 || homeLineupCount < 8) {
    return {
      aTeamWoba: null, hTeamWoba: null,
      aRuns: null, hRuns: null,
      rawHW: null, adjHW: null, adjAW: null,
      aML: null, hML: null,
      estTot: null,
      windFactor: 0, windRunAdj: 0,
      _suppressed: 'incomplete_lineup',
      _suppressed_detail: 'away=' + awayLineupCount + ' batters, home=' + homeLineupCount + ' batters',
    };
  }
    // Treat null/undefined/'' as missing — see note in services/jobs.js. An
    // empty string in app_settings would otherwise coerce via Number('')===0.
    const num = (v, def) => {
      if (v == null || v === '') return def;
      const n = Number(v);
      return isNaN(n) ? def : n;
    };
  const RUN_MULT  = num(settings.RUN_MULT,  48);
  const HFA_BOOST = num(settings.HFA_BOOST, 0.02);
  const FAV_ADJ   = num(settings.FAV_ADJ,   0);
  const DOG_ADJ   = num(settings.DOG_ADJ,   0);
  const W_PIT     = num(settings.W_PIT,     0.5);
  const W_BAT     = num(settings.W_BAT,     0.5);
  const W_PROJ    = num(settings.W_PROJ,    0.65);
  const W_ACT     = num(settings.W_ACT,     0.35);
  const SP_WEIGHT     = num(settings.SP_WEIGHT,     0.77);
  const RELIEF_WEIGHT = num(settings.RELIEF_WEIGHT, 0.23);
  const SP_PIT_WEIGHT     = num(settings.SP_PIT_WEIGHT,     0.80);
  const RELIEF_PIT_WEIGHT = num(settings.RELIEF_PIT_WEIGHT, 0.20);
  const BULLPEN_AVG    = num(settings.BULLPEN_AVG,     0.318);
  const WOBA_BASELINE  = num(settings.WOBA_BASELINE,   0.230);
  const PYTH_EXP       = num(settings.PYTH_EXP,       1.83);
  const WIND_SCALE     = num(settings.WIND_SCALE,      2.0);
  const TOT_SLOPE      = num(settings.TOT_SLOPE,       0.08);
  const MIN_PA         = num(settings.MIN_PA,          60);
  const MIN_BF         = num(settings.MIN_BF,          100);
  const BAT_DFLT_START = num(settings.BAT_DFLT_START,  0.315);
  const BAT_DFLT_OPP   = num(settings.BAT_DFLT_OPP,   0.320);
  // Probability clamp bounds (win prob for ML, over prob for totals).
  const WP_CLAMP_LO = num(settings.WP_CLAMP_LO, 0.25);
  const WP_CLAMP_HI = num(settings.WP_CLAMP_HI, 0.75);

  const pwA = getPitcherWoba(wobaIdx, game.away_sp, game.away_sp_hand, game.away_team, W_PROJ, W_ACT, MIN_BF, settings);
  const pwH = getPitcherWoba(wobaIdx, game.home_sp, game.home_sp_hand, game.home_team, W_PROJ, W_ACT, MIN_BF, settings);

  const awayLU = (game.awayLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.away_team,W_PROJ,W_ACT,MIN_PA,settings)}));
  const homeLU = (game.homeLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.home_team,W_PROJ,W_ACT,MIN_PA,settings)}));

  // Away batters face the home team's bullpen; home batters face the away team's bullpen.
  // Fall back to league-average BULLPEN_AVG if the per-team value is null/missing.
  const awayVsBullpen = game.homeBullpenWoba ?? BULLPEN_AVG;
  const homeVsBullpen = game.awayBullpenWoba ?? BULLPEN_AVG;

  // Lineup-order PA weights — pulled from settings so they're tunable.
  // Falls back to defaults if the setting is missing/malformed.
  const PA_WEIGHTS = (Array.isArray(settings.PA_WEIGHTS) && settings.PA_WEIGHTS.length === 9)
    ? settings.PA_WEIGHTS
    : PA_WEIGHTS_DEFAULT;

  // Fixed SP/RP pitcher-side split from settings. The UI contract is that
  // spPitW + relPitW = 1.0 (auto-paired in the form), so they're applied
  // uniformly to both teams — no per-game adjustment based on starter
  // projected IP anymore.
  const spPitW  = SP_PIT_WEIGHT;
  const relPitW = RELIEF_PIT_WEIGHT;

  let aWs=0,aWp=0;
  awayLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; aWs+=perBatterEW(b,game.home_sp_hand,pwH.vsLHB,pwH.vsRHB,W_PIT,W_BAT,SP_WEIGHT,RELIEF_WEIGHT,spPitW,relPitW,awayVsBullpen,BAT_DFLT_START,BAT_DFLT_OPP)*pa; aWp+=pa; });
  let hWs=0,hWp=0;
  homeLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; hWs+=perBatterEW(b,game.away_sp_hand,pwA.vsLHB,pwA.vsRHB,W_PIT,W_BAT,SP_WEIGHT,RELIEF_WEIGHT,spPitW,relPitW,homeVsBullpen,BAT_DFLT_START,BAT_DFLT_OPP)*pa; hWp+=pa; });

  const aTeamWoba = aWp>0 ? aWs/aWp : BAT_DFLT_START;
  const hTeamWoba = hWp>0 ? hWs/hWp : BAT_DFLT_START;
  // Venue override (Mexico City, future special-event venues) wins over
  // the home-team default park factor. game.park_factor was set from the
  // home team's PARK_FACTORS entry — for a Mexico City series the home
  // team is ARI (1.10) but the actual venue plays much hotter.
  const venueOverride = game.venue_id != null ? VENUE_OVERRIDES[game.venue_id] : null;
  const pf = venueOverride ? venueOverride.parkFactor : (game.park_factor || 1.0);
  const aRuns = Math.max(0,(aTeamWoba-WOBA_BASELINE)*RUN_MULT*pf);
  const hRuns = Math.max(0,(hTeamWoba-WOBA_BASELINE)*RUN_MULT*pf);

  const rawHW = (aRuns<=0&&hRuns<=0)?0.5 : hRuns<=0?0.25 : aRuns<=0?0.75 :
    hRuns**PYTH_EXP/(hRuns**PYTH_EXP+aRuns**PYTH_EXP);
  const adjHW = Math.min(Math.max(rawHW+HFA_BOOST, WP_CLAMP_LO), WP_CLAMP_HI);
  const adjAW = 1-adjHW;

  const rawAML = rawToML(adjAW, WP_CLAMP_LO, WP_CLAMP_HI);
  const rawHML = rawToML(adjHW, WP_CLAMP_LO, WP_CLAMP_HI);
  const { adjA:aML, adjH:hML } = applySpread(rawAML, rawHML, FAV_ADJ, DOG_ADJ);

  const windFactor = game.wind_factor || 0;
  const tempRunAdj = game.temp_run_adj || 0;
  const windRunAdj = windFactor * WIND_SCALE; // factor=1.0 â +2 runs, -1.0 â -2 runs
  const estTot = Math.max(0, aRuns + hRuns + windRunAdj + tempRunAdj);
  return { aTeamWoba,hTeamWoba,aRuns,hRuns,rawHW,adjHW,adjAW,aML,hML,estTot,windFactor,windRunAdj };
}

function catKey(signalType, signalSide, signalLabel, marketLine) {
  const lbl = (signalLabel||'').replace('★','star').replace('*','star').toLowerCase();
  if (signalType==='ML') { const isFav=parseInt(marketLine)<0; return lbl+'-'+(isFav?'fav':'dog'); }
  return lbl+'-'+signalSide;
}

function getSignals(game, modelResult, settings) {
  // No signals when the upstream model_result was suppressed (e.g. empty
  // or partial lineups — see runModel). modelResult.aML / .estTot are
  // null in that case, so even attempting to push signals would crash.
  if (modelResult && modelResult._suppressed) return [];
  const ML_1STAR = typeof settings.ML_LEAN_EDGE    !== 'undefined' ? Number(settings.ML_LEAN_EDGE)    : 15;
  const ML_2STAR = typeof settings.ML_VALUE_EDGE   !== 'undefined' ? Number(settings.ML_VALUE_EDGE)   : 30;
  const ML_3STAR = typeof settings.ML_3STAR_EDGE   !== 'undefined' ? Number(settings.ML_3STAR_EDGE)   : 60;
  const TOT_1STAR = typeof settings.TOT_LEAN_EDGE  !== 'undefined' ? Number(settings.TOT_LEAN_EDGE)  : 0.04;
  const TOT_2STAR = typeof settings.TOT_VALUE_EDGE !== 'undefined' ? Number(settings.TOT_VALUE_EDGE) : 0.08;
  const TOT_3STAR = typeof settings.TOT_3STAR_EDGE !== 'undefined' ? Number(settings.TOT_3STAR_EDGE) : 0.12;
  const TOT_SLOPE = typeof settings.TOT_SLOPE      !== 'undefined' ? Number(settings.TOT_SLOPE)      : 0.08;
  const TOT_PROB_LO = typeof settings.TOT_PROB_LO !== 'undefined' ? Number(settings.TOT_PROB_LO) : 0.20;
  const TOT_PROB_HI = typeof settings.TOT_PROB_HI !== 'undefined' ? Number(settings.TOT_PROB_HI) : 0.80;
  const MARKET_TOTAL_DFLT = typeof settings.MARKET_TOTAL_DFLT !== 'undefined' ? Number(settings.MARKET_TOTAL_DFLT) : 8.5;

  const signals = [];
  const aModel  = modelResult.aML;
  const hModel  = modelResult.hML;
  const aMarket = game.market_away_ml;
  const hMarket = game.market_home_ml;

  function mlEdge(market, model) {
    const mktDist = market > 0 ? market - 100 : -market - 100;
    const mdlDist = model  > 0 ? model  - 100 : -model  - 100;
    return (market > 0) !== (model > 0) ? mktDist + mdlDist : Math.abs(market - model);
  }

  const awayEdge = (aMarket > 0 && aModel < 0) || (aMarket > aModel) ? mlEdge(aMarket, aModel) : 0;
  const homeEdge = (hMarket > 0 && hModel < 0) || (hMarket > hModel) ? mlEdge(hMarket, hModel) : 0;

  function mlLabel(edge) {
    if (edge >= ML_3STAR) return '3★';
    if (edge >= ML_2STAR) return '2★';
    if (edge >= ML_1STAR) return '1★';
    return null;
  }

  const aLabel = mlLabel(awayEdge);
  const hLabel = mlLabel(homeEdge);
  if (aLabel) signals.push({type:'ML',side:'away',label:aLabel,marketLine:aMarket,modelLine:aModel,edge:Math.round(awayEdge)});
  if (hLabel) signals.push({type:'ML',side:'home',label:hLabel,marketLine:hMarket,modelLine:hModel,edge:Math.round(homeEdge)});

  // Prefer the xcheck source for the total-side edge calc. Kalshi (the
  // primary source) has a thin MLB O/U book and routinely posts outlier
  // juice; using it as the model's only input produces false Over/Under
  // edges. The xcheck source is an independent sharp/liquid book with
  // consensus-shaped juice. Line + over + under travel as a group — never
  // mix xcheck's line with the primary's juice or vice versa.
  const haveXcheckTot = game.xcheck_total != null && game.xcheck_over_price != null && game.xcheck_under_price != null;
  const mktTotal   = haveXcheckTot ? game.xcheck_total       : (game.market_total || MARKET_TOTAL_DFLT);
  const overPrice  = haveXcheckTot ? game.xcheck_over_price  : (game.over_price   || -110);
  const underPrice = haveXcheckTot ? game.xcheck_under_price : (game.under_price  || -110);
  const estTot     = modelResult.estTot;

  const overImplied  = overPrice  < 0 ? Math.abs(overPrice) /(Math.abs(overPrice) +100) : 100/(overPrice +100);
  const underImplied = underPrice < 0 ? Math.abs(underPrice)/(Math.abs(underPrice)+100) : 100/(underPrice+100);

  const runDiff    = estTot - mktTotal;
  const modelOverP = Math.min(Math.max(0.5 + runDiff * TOT_SLOPE, TOT_PROB_LO), TOT_PROB_HI);
  const modelUnderP = 1 - modelOverP;

  const overEdge  = modelOverP  - overImplied;
  const underEdge = modelUnderP - underImplied;

  function totLabel(edge) {
    if (edge >= TOT_3STAR) return '3★';
    if (edge >= TOT_2STAR) return '2★';
    if (edge >= TOT_1STAR) return '1★';
    return null;
  }

  // Carry both the primary (venue) and xcheck (edge-calc) totals on every
  // Total signal so the UI / logs can show "model used xcheck line=X.X
  // from <source>" without losing the user's actual betting venue price.
  const totSigExtras = {
    xcheck_total: game.xcheck_total ?? null,
    xcheck_over_price: game.xcheck_over_price ?? null,
    xcheck_under_price: game.xcheck_under_price ?? null,
    xcheck_total_source: game.xcheck_total_source ?? null,
    // Primary (venue) fields — always include so downstream can compare.
    primary_total: game.market_total ?? null,
    primary_over_price: game.over_price ?? null,
    primary_under_price: game.under_price ?? null,
  };
  const oLabel = totLabel(overEdge);
  const uLabel = totLabel(underEdge);
  if (oLabel) signals.push({type:'Total',side:'over', label:oLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(overEdge.toFixed(4)), ...totSigExtras});
  if (uLabel) signals.push({type:'Total',side:'under',label:uLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(underEdge.toFixed(4)), ...totSigExtras});

  return signals.map(s=>({...s,category:catKey(s.type,s.side,s.label,s.marketLine)}));
}

function calcPnl(signal, awayScore, homeScore, marketTotal) {
  if (awayScore == null || homeScore == null) return { outcome: 'pending', pnl: 0 };
  const actualTotal = awayScore + homeScore;

  // Use locked bet line if available, otherwise market line
  function effectiveLine(sigLine, sigBetLine) {
    const bl = parseFloat(sigBetLine);
    const ml = parseFloat(sigLine);
    return (!isNaN(bl) && bl !== 0) ? bl : ml;
  }

  // "To win $100" P&L:
  //   +odds (dog):  stake = 10000/odds  â win +100, loss -stake
  //   -odds (fav):  stake = abs(odds)   â win +100, loss -stake
  function toWin100(ml, won) {
    ml = parseFloat(ml);
    if (isNaN(ml) || ml === 0) return null;
    const stake = ml > 0 ? parseFloat((10000 / ml).toFixed(2)) : Math.abs(ml);
    return parseFloat((won ? 100 : -stake).toFixed(2));
  }

  if (signal.type === 'ML') {
    if (awayScore === homeScore) return { outcome: 'push', pnl: 0 };
    const betTeamWon = signal.side === 'away' ? awayScore > homeScore : homeScore > awayScore;
    const line = effectiveLine(signal.marketLine, signal.bet_line);
    if (isNaN(parseFloat(line)) || parseFloat(line) === 0)
      return { outcome: betTeamWon ? 'win' : 'loss', pnl: null };
    const pnl = toWin100(line, betTeamWon);
    return { outcome: betTeamWon ? 'win' : 'loss', pnl };
  } else {
    // Total â use -110 vig basis (standard): stake $110 to win $100
    // But if over_price/under_price available via signal.overPrice/underPrice, use that
    const tot = parseFloat(marketTotal) || parseFloat(signal.marketLine);
    if (isNaN(tot)) return { outcome: 'pending', pnl: 0 };
    const isOver  = signal.side === 'over';
    const covered = isOver ? actualTotal > tot : actualTotal < tot;
    if (actualTotal === tot) return { outcome: 'push', pnl: 0 };
    // Use locked bet_line as the total line bet (e.g. 6.5), price is typically -110
    // Use signal.overPrice/underPrice if available, else -110
    const price = isOver
      ? (signal.overPrice || signal.over_price || -110)
      : (signal.underPrice || signal.under_price || -110);
    const line = effectiveLine(price, null); // bet_line on totals is the line number, not the price
    const pnl = toWin100(line, covered);
    return { outcome: covered ? 'win' : 'loss', pnl };
  }
}

module.exports = { normName,buildWobaIndex,getBatterWoba,getPitcherWoba,runModel,getSignals,calcPnl,impliedP };