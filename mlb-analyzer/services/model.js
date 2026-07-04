/** Model service â all settings from DB, no hardcoded constants */
// Fallback used when settings doesn't carry a valid PA_WEIGHTS array
// (should never happen in the Render deploy — getSettings seeds it).
const PA_WEIGHTS_DEFAULT = [4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7];

// Per-lineup-position batters-faced distributions for opener_aware mode.
// Index [0] = leadoff, [8] = 9-hole. Sum of OPENER_FACED ≈ 4.5 BF
// (~1 IP + a couple extra batters); sum of BULK_FACED ≈ 13.5 BF
// (~4.5 IP). At runtime we convert to per-PA fractions by dividing by
// PA_WEIGHTS[i]: openerFrac[i] = OPENER_FACED[i]/PA_WEIGHTS[i], same
// for bulk, with bullpen taking the residual (1 - opener - bulk).
// In bullpen_game mode (no bulk identified) bulkFrac collapses to 0
// and bullpen absorbs the bulk slot.
//
// Replaces the uniform 0.15/0.60/0.25 split from PR #68. Top-of-order
// PAs concentrate on the opener; middle innings on the bulk; bottom
// of order on the bullpen pool. Settable via settings (see
// OPENER_FACED_DISTRIBUTION / BULK_FACED_DISTRIBUTION reads in
// runModel) — same shape contract as PA_WEIGHTS.
const OPENER_FACED_DEFAULT = [1.00, 1.00, 1.00, 0.95, 0.45, 0.20, 0.13, 0.06, 0.00];
const BULK_FACED_DEFAULT   = [1.30, 1.25, 1.10, 1.55, 1.85, 1.85, 1.65, 1.55, 1.40];
const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };

// Special-event venues outside the regular 30-stadium set. Keyed by
// statsapi venue.id (captured in services/scraper.js fetchSchedule and
// persisted to game_log.venue_id). When a game is at one of these
// venues, the override's parkFactor wins over the home-team default
// in services/scraper.js PARK_FACTORS — necessary because the home team
// for a Mexico City series is still ARI but Chase Field's 1.10 factor
// understates run scoring at altitude.
//
// Renamed from VENUE_OVERRIDES to VENUE_ID_OVERRIDES in
// feat/venue-overrides so it doesn't clash with the team-and-date-
// range VENUE_OVERRIDES in services/scraper.js. Both layers are
// applied at the runModel read site below; venue_id wins when both
// match because it's the most specific signal (statsapi-tagged
// non-default venue).
const VENUE_ID_OVERRIDES = {
  // Estadio Alfredo Harp Helú — Mexico City series. ~7800 ft elevation.
  // Coors (~5200 ft) plays to ~1.10 park factor; scaling by elevation
  // (each ~1000 ft ≈ +2% factor) puts Mexico City around 1.20.
  5340: { parkFactor: 1.20, name: 'Estadio Alfredo Harp Helú (Mexico City)' },
};

const { normName, fuzzyLookup } = require('../utils/names');
const { pickVenueOverride } = require('./scraper');
const { getWobaParkFactor, neutralizeWoba, computeStintWeightedFactor } = require('./park-factors-woba');
const stintCache = require('./stint-cache');

// Park-neutralization (feat/park-neutral-inputs, revised 2026-07-03).
// Applied inside blendWoba ONLY to the actuals term of the proj/act
// blend. Rationale (audit 2026-07-02, finding 1): the Steamer RoS
// projections we ingest via /api/projections are already park-neutral
// (verified with a 340-hitter sample across 12 teams — no correlation
// between team park factor and mean projected wOBA). The 2-year splits
// actuals ARE inflated by home PAs, so those DO need to be deflated
// by the wOBA-scale park factor.
//
// League-average defaults (BAT_DFLT / PIT_DFLT and settings-driven
// start/opp defaults) stay raw because no park was baked into them.
// Traded players are approximated with the current-team's home park
// factor (v1 tradeoff, documented in services/park-factors-woba.js).

function buildWobaIndex(rows) {
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
  }
  return idx;
}

// blendWoba mixes the (already-park-neutral) Steamer projection with
// the (home-park-inflated) 2yr actuals. When wobaParkFactor is provided
// and != 1.0, ONLY the actuals term is deflated before blending — the
// projection term is preserved raw. When null / 1.0 / neutralization
// toggle is off, both terms flow through unchanged (byte-identical to
// pre-PR #142 behavior).
function blendWoba(proj, act, minSample, wProj, wAct, wobaParkFactor) {
  const hp = proj && !isNaN(proj.woba);
  const ha = act && !isNaN(act.woba) && act.sample >= minSample;
  const wp = wProj || 0.65;
  const wa = wAct  || 0.35;
  // Neutralize ONLY the actuals term. A null / 1.0 factor is a no-op.
  const actWoba = (ha && wobaParkFactor != null && wobaParkFactor !== 1.0)
    ? neutralizeWoba(act.woba, wobaParkFactor)
    : (ha ? act.woba : null);
  if (hp && ha) return { woba: proj.woba*wp + actWoba*wa, source:'blend' };
  if (hp)      return { woba: proj.woba, source:'steamer' };
  if (ha)      return { woba: actWoba,   source:'actual' };
  return null;
}

// Resolve the wOBA-scale park factor for a player's team when the
// neutralization toggle is on; returns null otherwise (blend then
// treats null as "no adjustment", byte-identical to pre-PR path).
//
// opts (optional, fix/park-neutral-stint-weighted):
//   { playerName: string, isPitcher: boolean }
// When provided, the stint cache is consulted first. Multi-team
// players (games/TBF split across ≥2 teams this season) get a
// PA-weighted (batter) or TBF-weighted (pitcher) blend of each
// stint's park factor — matches the audit tradeoff v1 called out.
// Single-team players + missing/unavailable stint data fall back to
// the current-team factor, so behavior for the vast majority of
// players is byte-identical to pre-fix.
function resolveNeutralizationFactor(teamHint, settings, opts) {
  if (!settings || !settings.PARK_NEUTRAL_INPUTS_ENABLED) return null;
  if (opts && opts.playerName) {
    const teamMap = opts.isPitcher
      ? stintCache.getPitcherStintMap(opts.playerName)
      : stintCache.getBatterStintMap(opts.playerName);
    const weighted = computeStintWeightedFactor(teamMap);
    if (weighted != null) return weighted;
  }
  return getWobaParkFactor(teamHint);
}

function getBatterWoba(idx, name, hand, teamHint, wProj, wAct, minPA, settings) {
  if (minPA == null) minPA = 60;
  const pf = resolveNeutralizationFactor(teamHint, settings, { playerName: name, isPitcher: false });
  const bL = blendWoba(
    fuzzyLookup(idx['bat-proj-lhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-lhp'], name, teamHint),
    minPA, wProj, wAct, pf
  );
  const bR = blendWoba(
    fuzzyLookup(idx['bat-proj-rhp'], name, teamHint),
    fuzzyLookup(idx['bat-act-rhp'], name, teamHint),
    minPA, wProj, wAct, pf
  );
  const eff = hand==='S' ? 'R' : (hand||'R');
  // Default selection has three priority layers:
  //  1. settings.BAT_DFLT_START / BAT_DFLT_OPP — flat per-exposure defaults
  //     configured on the model tab. Same-hand (batter-hand == pitcher-hand)
  //     uses START; opposite-hand uses OPP. This is the authoritative source
  //     and matches the values perBatterEW already uses as its backstop, so
  //     getBatterWoba and perBatterEW stay consistent for defaulted batters.
  //  2. settings.BAT_DFLT_<HAND>_VS_<PHAND> — per-batter-hand per-pitcher-hand
  //     fine-tunable defaults if you want platoon-specific values different
  //     from the flat START/OPP. Rarely populated; legacy.
  //  3. Module const BAT_DFLT — platoon-realistic defaults (LHB hits RHP at
  //     0.330, etc.). Used only when neither (1) nor (2) provides a value.
  //     Callers without a settings object (e.g. some debug routes) land here.
  let d;
  if (settings && settings.BAT_DFLT_START != null) {
    const start = parseFloat(settings.BAT_DFLT_START);
    const opp   = parseFloat(settings.BAT_DFLT_OPP);
    // 'eff' represents the batter's effective hand (S → R). vsLHP is
    // "same-hand" if eff==='L', "opposite-hand" if eff==='R'.
    if (eff === 'L') {
      d = { vsLHP: start, vsRHP: opp };
    } else {
      d = { vsLHP: opp, vsRHP: start };
    }
  } else if (settings && settings.BAT_DFLT_R_VS_RHP != null) {
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
    // Neutralization (when enabled) already happened inside blendWoba
    // on the actuals term only — projections stayed raw. Defaults
    // (d.vsLHP / d.vsRHP) never had park baked in, so they're used
    // as-is when a hand's blend is missing.
    return { vsLHP: bL?.woba ?? d.vsLHP, vsRHP: bR?.woba ?? d.vsRHP, source: src };
  }
  return { vsLHP: d.vsLHP, vsRHP: d.vsRHP, source:'fallback' };
}

function getPitcherWoba(idx, name, hand, teamHint, wProj, wAct, minBF, settings) {
  if (minBF == null) minBF = 100;
  const pf = resolveNeutralizationFactor(teamHint, settings, { playerName: name, isPitcher: true });
  const bL = blendWoba(
    fuzzyLookup(idx['pit-proj-lhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-lhb'], name, teamHint),
    minBF, wProj, wAct, pf
  );
  const bR = blendWoba(
    fuzzyLookup(idx['pit-proj-rhb'], name, teamHint),
    fuzzyLookup(idx['pit-act-rhb'], name, teamHint),
    minBF, wProj, wAct, pf
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
  // Same as getBatterWoba: blend already neutralized the actuals term
  // if enabled; defaults stay raw.
  return {
    vsLHB: bL?.woba ?? d.vsLHB,
    vsRHB: bR?.woba ?? d.vsRHB,
    source: src,
  };
}

function effHand(bh, ph) { return bh==='S' ? (ph==='R'?'L':'R') : bh; }

// `openerOpts` (Phase 2 / per-batter weighting) is null for the standard
// non-opener path; perBatterEW then runs the existing 2-way SP/RP split
// against pitWvsL / pitWvsR — bit-identical to pre-opener behavior.
//
// When openerOpts is non-null (post-this-PR shape):
//   { mode: 'opener' | 'bullpen_game',
//     openerVsL, openerVsR,                  // opener wOBA splits
//     bulkVsL, bulkVsR,                      // bulk wOBA splits (null in bullpen_game)
//     bullpenWobaVsL, bullpenWobaVsR,        // pitching team's bullpen splits
//     perPositionWeights: [{opener,bulk,bullpen}, ...]  // 9 entries
//   }
// `lineupPosition` (0-indexed) selects the batter's row in the matrix.
// The opener / bulk weight at the top of the order reaches ~0.21 / 0.28;
// at the bottom of the order opener collapses to 0 and bullpen absorbs
// the rest. Replaces the uniform 0.15/0.60/0.25 split from PR #68.
//
// The pitWvsL/pitWvsR positional args are NO LONGER USED on the
// opener path — opener wOBA reads come from openerOpts.openerVsL/R
// instead. They still feed the standard non-opener path; non-opener
// games are untouched by this PR.
function perBatterEW(batter, pitcherHand, pitWvsL, pitWvsR, W_PIT, W_BAT, SP_WEIGHT, RELIEF_WEIGHT, SP_PIT_WEIGHT, RELIEF_PIT_WEIGHT, bullpenWoba, BAT_DFLT_START, BAT_DFLT_OPP, openerOpts, lineupPosition) {
  const eff = effHand(batter.hand, pitcherHand);
  const pitWvsBatter = eff === 'L' ? pitWvsL : pitWvsR;
  let pitW;
  if (openerOpts) {
    const w = openerOpts.perPositionWeights[lineupPosition] || { opener: 0, bulk: 0, bullpen: 1 };
    const openerVsBatter  = eff === 'L' ? openerOpts.openerVsL : openerOpts.openerVsR;
    const bullpenVsBatter = eff === 'L' ? openerOpts.bullpenWobaVsL : openerOpts.bullpenWobaVsR;
    if (openerOpts.mode === 'bullpen_game') {
      pitW = openerVsBatter * w.opener + bullpenVsBatter * w.bullpen;
    } else {
      const bulkVsBatter = eff === 'L' ? openerOpts.bulkVsL : openerOpts.bulkVsR;
      pitW = openerVsBatter * w.opener + bulkVsBatter * w.bulk + bullpenVsBatter * w.bullpen;
    }
  } else {
    // Standard non-opener path — bit-identical to pre-PR. Do not modify.
    const spPitW  = (SP_PIT_WEIGHT     != null) ? SP_PIT_WEIGHT     : 0.80;
    const relPitW = (RELIEF_PIT_WEIGHT != null) ? RELIEF_PIT_WEIGHT : 0.20;
    pitW = pitWvsBatter * spPitW + bullpenWoba * relPitW;
  }
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

/**
 * runModel — compute model probabilities and run estimates for a single game.
 *
 * @param {Object} game — game_log row
 * @param {Object} wobaIdx — { byKey: { 'data_key:player_name': row } } from getWobaIndex()
 * @param {Object} settings — app_settings keyed values (validated by services/settings-schema.js)
 * @returns {ModelResult} See type below. Has _suppressed when output is invalid (empty lineups).
 *
 * Pipeline:
 *   1. Build per-batter wOBA blends (Steamer × actual via w_proj/w_act)
 *   2. Apply park factor (or venue override per PR #24)
 *   3. Apply weather adjustments (temp_run_adj, wind_factor)
 *   4. Compute pitching component (sp_pit_weight × SP + relief_pit_weight × bullpen)
 *   5. Compute batting component
 *   6. Blend pitching + batting (w_pit × pit + w_bat × bat) → run-rate
 *   7. Convert to runs/game via run_mult
 *   8. Pythagorean win prob (pyth_exp) clamped via wp_clamp_lo/hi
 *   9. Total over/under prob via tot_slope clamped via tot_prob_lo/hi
 *
 * @typedef {Object} ModelResult
 * @property {number|null} aTeamWoba — away team aggregate wOBA
 * @property {number|null} hTeamWoba — home team aggregate wOBA
 * @property {number|null} aRuns — away runs estimate
 * @property {number|null} hRuns — home runs estimate
 * @property {number|null} estTot — total runs estimate
 * @property {number|null} aML — model away American ML
 * @property {number|null} hML — model home American ML
 * @property {string} [_suppressed] — present iff model invalid; values: 'incomplete_lineup'
 */
function runModel(game, wobaIdx, settings, mode, quiet) {
  // mode === 'opener_aware' enables the 3-way pitching split for any side
  // with is_opener_game_<side>=1 AND bulk_guy_<side> set. Sides without
  // opener data keep the standard 2-way split inside the same call. Any
  // other value (incl. undefined) runs the standard model end-to-end.
  // Caller (processGameSignals) computes BOTH and persists each pair so
  // the use_opener_logic flag can swap which one feeds getSignals
  // without re-running the model.
  //
  // quiet (default false) suppresses per-game opener-model diagnostic
  // logs. Production callers (cron jobs.js, on-demand /api/* scoring)
  // leave it false so the logs surface in the Render console. The
  // parameter sweep passes true so a 58×225 (univariate) or 625×225
  // (joint) run doesn't emit ~30-40 lines per combo of opener-model
  // diagnostic output — the lines are invariant under the swept
  // params (none of them touch computeOpenerPitWeightFromForecast),
  // so the volume is pure noise and was the root of the
  // fix/sweep-runaway-loop false alarm.
  if (mode == null) mode = 'standard';
  if (quiet == null) quiet = false;
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
  // Catcher framing (default disabled; no-op until enabled AND a framing
  // row exists for the catcher). MUTE discounts measured framing to the
  // differential not already in pitcher wOBA-against.
  const CATCHER_FRAMING_ENABLED = !!settings.CATCHER_FRAMING_ENABLED;
  const CATCHER_FRAMING_MUTE = num(settings.CATCHER_FRAMING_MUTE, 0.5);
  // Defensive impact (Build B). Team fielding run value reduces the
  // opposing offense's runs, muted, gated, no-op when disabled/null.
  const DEFENSE_FRV_ENABLED = !!settings.DEFENSE_FRV_ENABLED;
  const DEFENSE_FRV_MUTE = num(settings.DEFENSE_FRV_MUTE, 0.5);
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

  // Phase 2: per-side opener opts. is_opener_game_<side>=1 means that
  // team is using an opener — the listed SP is the opener and bulk_guy_*
  // names the bulk-guy. The opts object is only built when mode is
  // 'opener_aware' AND both flags are present; perBatterEW falls back to
  // the standard 2-way split when opts is null. Side-asymmetry: in the
  // awayLU loop, away batters face HOME pitching, so awayLU consumes
  // opts built from the home side's opener data (and vice versa).
  // OPENER_PIT_WEIGHT / BULK_PIT_WEIGHT / OPENER_RELIEF_PIT_WEIGHT are
  // ORPHANED post-PR (per-batter weighting). They were the uniform
  // 0.15/0.60/0.25 split from PR #68 — replaced by the per-position
  // matrix derived from OPENER_FACED / BULK_FACED below. Kept around
  // for back-compat in case a future revisit wants to fall back to
  // uniform weighting; nothing else in the model reads them now.
  const OPENER_PIT_W   = num(settings.OPENER_PIT_WEIGHT,         0.15);
  const BULK_PIT_W     = num(settings.BULK_PIT_WEIGHT,           0.60);
  const OPENER_REL_W   = num(settings.OPENER_RELIEF_PIT_WEIGHT,  0.25);
  const UNK_PIT_WOBA   = num(settings.UNKNOWN_PITCHER_WOBA,      0.335);

  // Per-position batters-faced distributions. Falls back to
  // module-level defaults when settings are missing or malformed —
  // same guard pattern PA_WEIGHTS uses below. Read here so the
  // matrix is in scope for buildOpenerOpts.
  const OPENER_FACED = (Array.isArray(settings.OPENER_FACED_DISTRIBUTION) && settings.OPENER_FACED_DISTRIBUTION.length === 9)
    ? settings.OPENER_FACED_DISTRIBUTION
    : OPENER_FACED_DEFAULT;
  const BULK_FACED = (Array.isArray(settings.BULK_FACED_DISTRIBUTION) && settings.BULK_FACED_DISTRIBUTION.length === 9)
    ? settings.BULK_FACED_DISTRIBUTION
    : BULK_FACED_DEFAULT;
  // PA_WEIGHTS read moved up from the per-batter loop section so
  // buildOpenerOpts can divide the FACED distributions by it. The
  // forEach loops below reuse the same constant.
  const PA_WEIGHTS = (Array.isArray(settings.PA_WEIGHTS) && settings.PA_WEIGHTS.length === 9)
    ? settings.PA_WEIGHTS
    : PA_WEIGHTS_DEFAULT;

  // Build opener opts for a given side. Returns null when the side isn't
  // opener-led, or when mode != 'opener_aware'. Logs a warn when the
  // bulk-guy isn't in the wOBA index (newly-promoted swingman, etc.) so
  // we can detect data-coverage gaps in production.
  // Per-position weight matrix builder. For each lineup slot:
  //   openerFrac[i] = OPENER_FACED[i] / PA_WEIGHTS[i]   (clamped [0,1])
  //   bulkFrac[i]   = BULK_FACED[i]   / PA_WEIGHTS[i]   (0 in bullpen_game)
  //   bullpenFrac[i] = 1 - openerFrac[i] - bulkFrac[i]
  // Sanity guard: if a custom distribution overshoots (opener+bulk > 1),
  // scale opener and bulk down proportionally so they sum to 1 and
  // bullpenFrac is exactly 0 — never negative. With the default
  // distributions this overshoot branch never fires.
  // PR B (opener/bulk redesign): replace PR 4's bulk-scale logic with
  // target-renormalization. Instead of multiplying BULK_FACED by a scale
  // factor (which produced inconsistent PA-weighted overall weights based
  // on the BULK_FACED constants), this approach:
  //   1. Computes per-position fractions from the existing matrix (shape
  //      preserved — opener faces top of order, bulk faces middle).
  //   2. Computes the current PA-weighted overall weights from that matrix.
  //   3. Scales each slot to hit target PA-weighted weights, then
  //      renormalizes each position so opener+bulk+bullpen=1.
  // Targets come from F4 forecasts via computeOpenerPitWeightFromForecast
  // and computeBulkPitWeightFromForecast. Bullpen is the residual.
  // Bullpen_game mode (no bulk): bulk slot zeroed, bullpen absorbs.
  const buildPerPositionWeights = (mode_, targetOpener, targetBulk) => {
    const out = new Array(9);
    // Step 1: compute raw fractions and current PA-weighted overall.
    let curOpenerSum = 0, curBulkSum = 0, curPaSum = 0;
    const raw = new Array(9);
    for (let i = 0; i < 9; i++) {
      const pa = PA_WEIGHTS[i] || 1;
      let openerFrac = Math.max(0, Math.min(1, (OPENER_FACED[i] || 0) / pa));
      let bulkFrac   = mode_ === 'bullpen_game'
        ? 0
        : Math.max(0, Math.min(1, (BULK_FACED[i] || 0) / pa));
      const sum = openerFrac + bulkFrac;
      if (sum > 1) {
        openerFrac = openerFrac / sum;
        bulkFrac   = bulkFrac   / sum;
      }
      raw[i] = { opener: openerFrac, bulk: bulkFrac, pa };
      curOpenerSum += openerFrac * pa;
      curBulkSum   += bulkFrac   * pa;
      curPaSum     += pa;
    }
    const curOpener = curOpenerSum / curPaSum;
    const curBulk   = curBulkSum   / curPaSum;
    // Step 2: scale factors to hit targets. Guard against zero current
    // weight (bullpen_game has curBulk=0 — bulk target ignored).
    const tOpener = (targetOpener != null && targetOpener >= 0) ? targetOpener : curOpener;
    const tBulk   = (mode_ === 'bullpen_game') ? 0
                    : (targetBulk != null && targetBulk >= 0) ? targetBulk : curBulk;
    const openerScale = curOpener > 0 ? tOpener / curOpener : 0;
    const bulkScale   = curBulk   > 0 ? tBulk   / curBulk   : 0;
    // Step 3: apply scales per position, renormalize to sum=1.
    for (let i = 0; i < 9; i++) {
      let o = raw[i].opener * openerScale;
      let b = raw[i].bulk   * bulkScale;
      // Clamp to non-negative and re-cap so o+b<=1 (preserves bullpen>=0).
      o = Math.max(0, o);
      b = Math.max(0, b);
      if (o + b > 1) {
        const renorm = 1 / (o + b);
        o *= renorm;
        b *= renorm;
      }
      out[i] = { opener: o, bulk: b, bullpen: 1 - o - b };
    }
    return out;
  };

  const buildOpenerOpts = (side) => {
    if (mode !== 'opener_aware') return null;
    const flag    = side === 'away' ? game.is_opener_game_away : game.is_opener_game_home;
    if (flag !== 1) return null;
    const bulkSp  = side === 'away' ? game.bulk_guy_away       : game.bulk_guy_home;
    const team    = side === 'away' ? game.away_team : game.home_team;

    // Opener wOBA splits: the listed SP IS the opener, so we already
    // have the splits in pwA/pwH from earlier. Re-key onto the opts so
    // perBatterEW reads opener splits via openerOpts directly (the
    // existing pitWvsL/pitWvsR positional args still flow through but
    // are unused on the opener_aware path post-PR; standard path
    // continues to consume them as before).
    //
    // SP-null fallback: when statsapi hasn't named a probable yet but
    // RotoWire's PRIM tag has flagged this as a bullpen game (set in
    // jobs.js opener-detect), source the opener slot from the bullpen
    // pool. Without this, getPitcherWoba(null,...) returns the global
    // PIT_DFLT (~league-avg RHP), which is a worse prior than the
    // pitching team's actual bullpen aggregate. Once statsapi populates
    // the SP, this re-keys to the announced pitcher's splits.
    const sideSp = side === 'away' ? game.away_sp : game.home_sp;
    let openerVsL = side === 'away' ? pwA.vsLHB : pwH.vsLHB;
    let openerVsR = side === 'away' ? pwA.vsRHB : pwH.vsRHB;

    // Per-hand bullpen wOBA splits for the pitching team. processGame-
    // Signals populates game.{home,away}BullpenVs{L,R} from
    // q.getBullpenWobaBlended; falls back to the combined bullpen
    // wOBA, then BULLPEN_AVG. 'home' opts feed the awayLU loop where
    // away batters face home pitching, so use home's bullpen splits;
    // mirror for 'away'.
    const bullpenVsL = side === 'away'
      ? (game.awayBullpenVsL ?? game.awayBullpenWoba ?? BULLPEN_AVG)
      : (game.homeBullpenVsL ?? game.homeBullpenWoba ?? BULLPEN_AVG);
    const bullpenVsR = side === 'away'
      ? (game.awayBullpenVsR ?? game.awayBullpenWoba ?? BULLPEN_AVG)
      : (game.homeBullpenVsR ?? game.homeBullpenWoba ?? BULLPEN_AVG);

    // SP-null + opener flag: jobs.js opener-detect set the opener flag
    // because RotoWire's PRIM tag declared a bullpen game before
    // statsapi named a probable. There is no SP to source opener splits
    // from, so use the bullpen pool aggregate as the opener slot prior.
    // Logged once per side so it's clear in cron-log when this kicks in.
    if (!sideSp) {
      openerVsL = bullpenVsL;
      openerVsR = bullpenVsR;
      if (!quiet) console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': SP-null → opener slot sourced from bullpen pool'
        + ' (vsL=' + bullpenVsL.toFixed(3) + ', vsR=' + bullpenVsR.toFixed(3) + ')');
    }

    // Bullpen-game branch: opener flagged, no bulk man identified
    // (game_type_{side} = 'bullpen_game'). bulk slot is forced to 0 by
    // buildPerPositionWeights in bullpen_game mode; bullpen absorbs.
    // Opener target weight still uses F4 forecast — the opener slot is
    // present even without a named bulk pitcher.
    if (!bulkSp) {
      const openerFcRaw = side === 'away' ? game.away_opener_forecast_ip : game.home_opener_forecast_ip;
      const openerFc = (openerFcRaw != null) ? parseFloat(openerFcRaw) : null;
      const targetOpenerWeight = computeOpenerPitWeightFromForecast(openerFc, settings)
        ?? (parseFloat(settings?.OPENER_WEIGHT_ANCHOR_VALUE) || 0.15);
      const perPositionWeights = buildPerPositionWeights('bullpen_game', targetOpenerWeight, 0);
      const sample = perPositionWeights[0];
      // PA-weighted realized
      let realizedOpener = 0, realizedBullpen = 0, paSum = 0;
      for (let i = 0; i < 9; i++) {
        const pa = PA_WEIGHTS[i] || 1;
        realizedOpener  += perPositionWeights[i].opener  * pa;
        realizedBullpen += perPositionWeights[i].bullpen * pa;
        paSum += pa;
      }
      realizedOpener /= paSum;
      realizedBullpen /= paSum;
      if (!quiet) console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': bullpen_game mode (no bulk, target_op=' + targetOpenerWeight.toFixed(3)
        + ' realized op=' + realizedOpener.toFixed(3) + '/bp=' + realizedBullpen.toFixed(3) + ')');
      return {
        mode: 'bullpen_game',
        openerVsL, openerVsR,
        bulkVsL: null, bulkVsR: null,
        bullpenWobaVsL: bullpenVsL,
        bullpenWobaVsR: bullpenVsR,
        perPositionWeights,
        openerWeightUsed:  realizedOpener,
        bulkWeightUsed:    0,
        bullpenWeightUsed: realizedBullpen,
        openerFcUsed:      openerFc,
        bulkFcUsed:        null,
      };
    }

    // Standard opener-with-bulk path.
    // Bulk-guy hand isn't carried on game_log; fallback default 'R' is
    // only used when the wOBA index misses entirely (in which case we
    // overwrite both vsLHB/vsRHB with UNKNOWN_PITCHER_WOBA below).
    const bulkW = getPitcherWoba(wobaIdx, bulkSp, 'R', team, W_PROJ, W_ACT, MIN_BF, settings);
    let bulkVsL = bulkW.vsLHB;
    let bulkVsR = bulkW.vsRHB;
    if (bulkW.source === 'fallback') {
      if (!quiet) console.warn('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': bulk-guy ' + bulkSp + ' not in wOBA index — using UNKNOWN_PITCHER_WOBA=' + UNK_PIT_WOBA);
      bulkVsL = UNK_PIT_WOBA;
      bulkVsR = UNK_PIT_WOBA;
    }
    // PR B (opener/bulk redesign): compute target weights from F4 forecasts.
    // Opener uses *_opener_forecast_ip (role='opener' baseline 1.35), bulk
    // uses *_bulk_forecast_ip (role='bulk' baseline 5.4). Each F4 forecast
    // maps to a slot weight via its anchored helper, then the per-position
    // matrix is renormalized to hit those PA-weighted overall targets.
    //
    // Null forecasts fall back to anchor weight defaults (0.15 opener / 0.60 bulk),
    // matching v4 cohort's "what we use when we don't know" stance.
    const openerFcRaw = side === 'away' ? game.away_opener_forecast_ip : game.home_opener_forecast_ip;
    const openerFc = (openerFcRaw != null) ? parseFloat(openerFcRaw) : null;
    const bulkFcRaw   = side === 'away' ? game.away_bulk_forecast_ip   : game.home_bulk_forecast_ip;
    const bulkFc   = (bulkFcRaw != null) ? parseFloat(bulkFcRaw) : null;

    // SP-SP tandem sub-mode (feat/sp-sp-tandem-forecast-split, 2026-07-04).
    // When jobs.js detectOpeners tagged both pitchers as fresh RR
    // rotation SPs (tandem_subtype='sp_sp'), derive the split from
    // their own forecasts instead of the opener-class anchors:
    //   opener_share = opener_forecast_ip × QUICK_HOOK_FACTOR / 9
    //   bulk_share   = min(bulk_forecast_ip, 9 − opener_forecast_ip × QH) / 9
    //   bullpen      = 1 − opener_share − bulk_share (natural residual)
    // Self-updating property: bump either forecast and the share moves
    // proportionally. Confidence haircut still applies per-pitcher via
    // computeSpPitWeightFromForecast up the pipeline, so a ramping
    // opener with thin n_priors gets his uncertainty absorbed into the
    // forecast IP itself — no special-case for it here.
    //
    // Guarded so a partial payload (null openerFc or null bulkFc)
    // silently falls through to the anchor path — never fails
    // scoring on missing forecast data.
    const tandemSubtype = side === 'away'
      ? game.tandem_subtype_away
      : game.tandem_subtype_home;
    let targetOpenerWeight;
    let targetBulkWeight;
    if (tandemSubtype === 'sp_sp' && openerFc != null && bulkFc != null) {
      const QH = (settings && settings.QUICK_HOOK_FACTOR != null)
        ? parseFloat(settings.QUICK_HOOK_FACTOR)
        : 0.90;
      const openerIP = openerFc * QH;
      const bulkCap  = Math.max(0, 9 - openerIP);
      const bulkIP   = Math.min(bulkFc, bulkCap);
      targetOpenerWeight = openerIP / 9;
      targetBulkWeight   = bulkIP / 9;
      if (!quiet) console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': SP-SP tandem — opener_fc=' + openerFc.toFixed(2)
        + ' × QH=' + QH.toFixed(2) + ' → op_ip=' + openerIP.toFixed(2)
        + ' (' + targetOpenerWeight.toFixed(3) + '); bulk_fc=' + bulkFc.toFixed(2)
        + ' capped at ' + bulkCap.toFixed(2)
        + ' → bk_ip=' + bulkIP.toFixed(2) + ' (' + targetBulkWeight.toFixed(3) + ')');
    } else {
      targetOpenerWeight = computeOpenerPitWeightFromForecast(openerFc, settings)
        ?? (parseFloat(settings?.OPENER_WEIGHT_ANCHOR_VALUE) || 0.15);
      targetBulkWeight   = computeBulkPitWeightFromForecast(bulkFc, settings)
        ?? (parseFloat(settings?.BULK_WEIGHT_ANCHOR_VALUE) || 0.60);
    }
    const perPositionWeights = buildPerPositionWeights('opener', targetOpenerWeight, targetBulkWeight);
    const s0 = perPositionWeights[0], s4 = perPositionWeights[4], s8 = perPositionWeights[8];
    // Compute realized PA-weighted weights for logging + persistence.
    let realizedOpener = 0, realizedBulk = 0, realizedBullpen = 0, paSum = 0;
    for (let i = 0; i < 9; i++) {
      const pa = PA_WEIGHTS[i] || 1;
      realizedOpener  += perPositionWeights[i].opener  * pa;
      realizedBulk    += perPositionWeights[i].bulk    * pa;
      realizedBullpen += perPositionWeights[i].bullpen * pa;
      paSum += pa;
    }
    realizedOpener  /= paSum;
    realizedBulk    /= paSum;
    realizedBullpen /= paSum;
    if (!quiet) console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
      + ': targets op=' + targetOpenerWeight.toFixed(3) + '/bk=' + targetBulkWeight.toFixed(3)
      + ' realized op=' + realizedOpener.toFixed(3) + '/bk=' + realizedBulk.toFixed(3) + '/bp=' + realizedBullpen.toFixed(3)
      + ' (pos1 op=' + s0.opener.toFixed(3) + '/bk=' + s0.bulk.toFixed(3) + '/bp=' + s0.bullpen.toFixed(3)
      + '; pos5 op=' + s4.opener.toFixed(3) + '/bk=' + s4.bulk.toFixed(3) + '/bp=' + s4.bullpen.toFixed(3)
      + '; pos9 op=' + s8.opener.toFixed(3) + '/bk=' + s8.bulk.toFixed(3) + '/bp=' + s8.bullpen.toFixed(3) + ')');
    return {
      mode: 'opener',
      openerVsL, openerVsR,
      bulkVsL, bulkVsR,
      bullpenWobaVsL: bullpenVsL,
      bullpenWobaVsR: bullpenVsR,
      perPositionWeights,
      // Realized PA-weighted weights for downstream persistence and tracing.
      openerWeightUsed:  realizedOpener,
      bulkWeightUsed:    realizedBulk,
      bullpenWeightUsed: realizedBullpen,
      openerFcUsed:      openerFc,
      bulkFcUsed:        bulkFc,
    };
  };
  // Away batters face home pitching → away-side perBatterEW uses HOME's
  // opener opts. Mirror for home.
  const homeOpenerOpts = buildOpenerOpts('home');
  const awayOpenerOpts = buildOpenerOpts('away');

  const awayLU = (game.awayLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.away_team,W_PROJ,W_ACT,MIN_PA,settings)}));
  const homeLU = (game.homeLineup||[]).map(b=>({...b,...getBatterWoba(wobaIdx,b.name,b.hand,game.home_team,W_PROJ,W_ACT,MIN_PA,settings)}));

  // Away batters face the home team's bullpen; home batters face the away team's bullpen.
  // Fall back to league-average BULLPEN_AVG if the per-team value is null/missing.
  const awayVsBullpen = game.homeBullpenWoba ?? BULLPEN_AVG;
  const homeVsBullpen = game.awayBullpenWoba ?? BULLPEN_AVG;

  // PA_WEIGHTS read moved up alongside OPENER_FACED / BULK_FACED so
  // buildPerPositionWeights can divide by it (see top of runModel).
  // The same constant feeds the per-batter loops below.

  // PR 4 (v4 cohort cutover): per-game SP pitching weight derived from
  // F4 forecast IP. Each side gets its own spPitW based on that side's
  // SP forecast — the value persisted to game_log.{away,home}_sp_forecast_ip
  // by the lineup-job (see services/jobs.js forecastForPitcher). Null
  // forecast (e.g. lineup-job hasn't run since deploy, or pitcher had no
  // shrinkage source) now returns the low-confidence target (0.62 by
  // default via SP_FORECAST_LOW_CONF_TARGET) — same treatment a pitcher
  // WITH a forecast but ZERO priors receives. Revised 2026-07-03 per
  // audit finding 2: the pre-revision path returned null → the caller's
  // `?? SP_PIT_WEIGHT` fallback pushed it to 0.80 (max confidence),
  // which was the same backwards-fallback pattern the haircut PR itself
  // was designed to fix. Bullpen weight is the complement so the
  // pitching component always sums to 1.0.
  //
  // Note the cross-side mapping below: the AWAY batters are facing the
  // HOME pitcher, so their perBatterEW call uses HOME's forecast to
  // compute SP weight. Symmetric for HOME batters.
  const awayFc = game.away_sp_forecast_ip != null ? parseFloat(game.away_sp_forecast_ip) : null;
  const homeFc = game.home_sp_forecast_ip != null ? parseFloat(game.home_sp_forecast_ip) : null;
  // n_priors columns are written by services/jobs.js forecastForPitcher
  // alongside forecast_ip. Null on legacy rows written before this branch
  // deployed — computeSpPitWeightFromForecast treats null as "no haircut
  // info" and returns the pre-haircut weight, preserving prior behavior
  // for backfill. Forward writes always populate both.
  const awayNP = game.away_sp_forecast_n_priors != null ? parseInt(game.away_sp_forecast_n_priors, 10) : null;
  const homeNP = game.home_sp_forecast_n_priors != null ? parseInt(game.home_sp_forecast_n_priors, 10) : null;
  // computeSpPitWeightFromForecast never returns null post-fix, so the
  // `?? SP_PIT_WEIGHT` fallback that previously assigned 0.80 to no-
  // forecast pitchers is gone. The `?? SP_PIT_WEIGHT` remains as a
  // defensive back-stop against a defect in the function; if it fires
  // in production that's a bug, not a normal path.
  const awaySpPitW = computeSpPitWeightFromForecast(awayFc, settings, awayNP) ?? SP_PIT_WEIGHT;
  const homeSpPitW = computeSpPitWeightFromForecast(homeFc, settings, homeNP) ?? SP_PIT_WEIGHT;
  const awayRelPitW = 1 - awaySpPitW;
  const homeRelPitW = 1 - homeSpPitW;
  // Legacy single-value pair retained for any diagnostic code paths that
  // reference them. Standard non-opener pitching weight is now the
  // per-side awaySpPitW/homeSpPitW computed above; these constants
  // match the v3 fixed defaults.
  const spPitW  = SP_PIT_WEIGHT;
  const relPitW = RELIEF_PIT_WEIGHT;

  // Per-batter loop. The trailing `i` is the lineup position (0-indexed)
  // — perBatterEW uses it to index openerOpts.perPositionWeights when
  // opener_aware mode is active. Standard non-opener mode ignores it.
  let aWs=0,aWp=0;
  awayLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; aWs+=perBatterEW(b,game.home_sp_hand,pwH.vsLHB,pwH.vsRHB,W_PIT,W_BAT,SP_WEIGHT,RELIEF_WEIGHT,homeSpPitW,homeRelPitW,awayVsBullpen,BAT_DFLT_START,BAT_DFLT_OPP,homeOpenerOpts,i)*pa; aWp+=pa; });
  let hWs=0,hWp=0;
  homeLU.forEach((b,i)=>{ const pa=PA_WEIGHTS[i]??3.77; hWs+=perBatterEW(b,game.away_sp_hand,pwA.vsLHB,pwA.vsRHB,W_PIT,W_BAT,SP_WEIGHT,RELIEF_WEIGHT,awaySpPitW,awayRelPitW,homeVsBullpen,BAT_DFLT_START,BAT_DFLT_OPP,awayOpenerOpts,i)*pa; hWp+=pa; });

  const aTeamWoba = aWp>0 ? aWs/aWp : BAT_DFLT_START;
  const hTeamWoba = hWp>0 ? hWs/hWp : BAT_DFLT_START;
  // Park factor resolution chain (most-specific first):
  //   1. VENUE_ID_OVERRIDES[game.venue_id] — statsapi-tagged special
  //      venue (e.g. Mexico City). game.venue_id captured at schedule
  //      bootstrap. Wins over everything because statsapi has
  //      affirmatively identified a non-default venue for the game.
  //   2. VENUE_OVERRIDES (team + date range, services/scraper.js) —
  //      catches alternate-site runs that don't get a distinct
  //      venue_id (e.g. ATH at Las Vegas Ballpark, 2026-06-08..14).
  //      Re-checked here as well as at the scraper write site so
  //      already-persisted game rows that predate the override entry
  //      still resolve correctly without needing a re-write.
  //   3. game.park_factor — the home-team default written by the
  //      scraper (already includes the team's PARK_FACTORS entry,
  //      or the date-scoped override if the writer applied it).
  //   4. 1.0 — defensive fallback if game.park_factor is null.
  // Weather (temp_run_adj + wind_factor) is layered ADDITIVELY on
  // top of (aRuns + hRuns) further down; this override changes only
  // the multiplicative pf input, no double-counting risk.
  const venueIdOverride = game.venue_id != null ? VENUE_ID_OVERRIDES[game.venue_id] : null;
  const teamDateOverride = !venueIdOverride
    ? pickVenueOverride(game.home_team, game.game_date)
    : null;
  let pf;
  if (venueIdOverride)        pf = venueIdOverride.parkFactor;
  else if (teamDateOverride)  pf = teamDateOverride.pf;
  else                        pf = (game.park_factor || 1.0);
  const aRunsRaw = Math.max(0,(aTeamWoba-WOBA_BASELINE)*RUN_MULT*pf);
  const hRunsRaw = Math.max(0,(hTeamWoba-WOBA_BASELINE)*RUN_MULT*pf);
  // Catcher framing adjustment. A good framing catcher steals strikes,
  // suppressing the runs scored by the batters facing that battery. So
  // the HOME catcher's framing reduces the AWAY offense's runs, and the
  // AWAY catcher's framing reduces the HOME offense's runs. Positive
  // rv_per_game = runs saved by that catcher = subtract from the opposing
  // offense. Muted by CATCHER_FRAMING_MUTE (the value already in pitcher
  // wOBA-against isn't re-added; this captures the differential). Gated:
  // disabled by default, and null per-game values (no ingest / no row /
  // no catcher) are a clean no-op.
  //
  // The per-side math is delegated to applyCatcherFramingDelta so the
  // Matchups display can call the SAME function from the route and
  // surface the exact same number the model applied. Settings flips
  // (CATCHER_FRAMING_ENABLED, CATCHER_FRAMING_MUTE) take effect on the
  // next display read without requiring a model rescore.
  const aFramingAdj = applyCatcherFramingDelta(game.homeCatcherFramingRvPerGame, settings);
  const hFramingAdj = applyCatcherFramingDelta(game.awayCatcherFramingRvPerGame, settings);
  // Team defense (Build B): the HOME team's fielding reduces the AWAY
  // offense's runs (good defenders convert more batted balls into outs),
  // and vice versa — same directional logic as framing. Positive team
  // FRV/game = runs prevented = subtract from the opposing offense.
  let aDefenseAdj = 0, hDefenseAdj = 0;
  if (DEFENSE_FRV_ENABLED) {
    const homeDef = game.homeFieldingRunsPerGame;
    const awayDef = game.awayFieldingRunsPerGame;
    if (typeof homeDef === 'number' && !isNaN(homeDef)) aDefenseAdj = homeDef * DEFENSE_FRV_MUTE;
    if (typeof awayDef === 'number' && !isNaN(awayDef)) hDefenseAdj = awayDef * DEFENSE_FRV_MUTE;
  }
  const aRuns = Math.max(0, aRunsRaw - aFramingAdj - aDefenseAdj);
  const hRuns = Math.max(0, hRunsRaw - hFramingAdj - hDefenseAdj);

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
  return { aTeamWoba,hTeamWoba,aRuns,hRuns,rawHW,adjHW,adjAW,aML,hML,estTot,windFactor,windRunAdj,
    // PR 4: per-side SP weights used in this model run. Persisted to
    // game_log.{away,home}_sp_weight_used by processGameSignals so
    // future backtests can replay model with exact weight inputs.
    // Bullpen weight is the complement (1 - sp_weight) on standard path.
    awaySpWeightUsed: awaySpPitW, homeSpWeightUsed: homeSpPitW,
    // PR B (opener/bulk redesign): realized PA-weighted opener/bulk/bullpen
    // weights from the opener-aware model run, when the side is opener-mode.
    // Null when the side isn't opener-mode (standard SP-vs-bullpen split
    // is fully described by *_sp_weight_used + its complement).
    awayOpenerWeightUsed:  awayOpenerOpts ? awayOpenerOpts.openerWeightUsed  : null,
    awayBulkWeightUsed:    awayOpenerOpts ? awayOpenerOpts.bulkWeightUsed    : null,
    awayBullpenWeightUsed: awayOpenerOpts ? awayOpenerOpts.bullpenWeightUsed : null,
    homeOpenerWeightUsed:  homeOpenerOpts ? homeOpenerOpts.openerWeightUsed  : null,
    homeBulkWeightUsed:    homeOpenerOpts ? homeOpenerOpts.bulkWeightUsed    : null,
    homeBullpenWeightUsed: homeOpenerOpts ? homeOpenerOpts.bullpenWeightUsed : null };
}

function catKey(signalType, signalSide, signalLabel, marketLine) {
  const lbl = (signalLabel||'').replace('★','star').replace('*','star').toLowerCase();
  if (signalType==='ML') { const isFav=parseInt(marketLine)<0; return lbl+'-'+(isFav?'fav':'dog'); }
  return lbl+'-'+signalSide;
}

/**
 * getSignals — convert a runModel() result + game state into emittable bet signals.
 *
 * @param {Object} game — game_log row
 * @param {ModelResult} modelResult — output from runModel()
 * @param {Object} settings — app_settings keyed values
 * @param {Array} [outSuppressed] — OPTIONAL. When provided, signals
 *   suppressed by the edge-sanity hard cap (feat/edge-sanity-cap) are
 *   pushed onto this array as `{ type, side, category, edge, marketLine,
 *   modelLine, reason }` so the caller can persist them to
 *   bet_signal_audit. Return value only ever includes EMITTED signals;
 *   callers that don't need audit visibility can omit the arg
 *   (behavior identical to pre-cap).
 * @returns {Signal[]} Empty array if model._suppressed OR market data is null
 *   (PR #26: null-market suppression for ML and Total independently).
 */
function getSignals(game, modelResult, settings, outSuppressed) {
  // No signals when the upstream model_result was suppressed (e.g. empty
  // or partial lineups — see runModel). modelResult.aML / .estTot are
  // null in that case, so even attempting to push signals would crash.
  if (modelResult && modelResult._suppressed) return [];

  // Null-market suppression. Don't emit ML signals when the market
  // moneylines are missing — there's nothing to calculate edge against.
  // mkt vs model comparison silently misbehaves on null and produces
  // bogus large edges (null > 0 is false; null > -100 is false; etc.).
  const haveAnyML = game.market_away_ml != null && game.market_home_ml != null;

  // Null-market suppression for totals. When both primary AND xcheck
  // totals are missing, MARKET_TOTAL_DFLT used to mask this — producing
  // phantom edges against an arbitrary 8.5 default. Suppress instead.
  // Reproducer pre-fix: SD@ARI 2026-04-25 (Mexico City — Unabated has no
  // totals contract) emitted Total/over 3★ mkt=null mdl=10.35 edge=0.124
  // against the 8.5 default. ML and totals are independent — a game can
  // have valid ML but null totals (suppress only Total) or vice versa.
  const haveAnyTot = (game.market_total != null && game.over_price != null && game.under_price != null) ||
                     (game.xcheck_total != null && game.xcheck_over_price != null && game.xcheck_under_price != null);
  // Continuous-edge architecture (feat/continuous-edge-score). The
  // 1★/2★/3★ tier bucketing is gone. getSignals emits every signal
  // whose raw probability-edge meets a single low floor; the UI
  // does direction-specific highlighting against rounded scores
  // independently. Storing every raw edge above the floor gives us
  // forward data to refine thresholds and bet-sizing-by-edge from
  // the resolved-outcome table.
  const SIGNAL_EMIT_FLOOR = typeof settings.SIGNAL_EMIT_FLOOR_PP !== 'undefined'
    ? Number(settings.SIGNAL_EMIT_FLOOR_PP) : 0.01;
  const TOT_SLOPE = typeof settings.TOT_SLOPE      !== 'undefined' ? Number(settings.TOT_SLOPE)      : 0.08;
  const TOT_PROB_LO = typeof settings.TOT_PROB_LO !== 'undefined' ? Number(settings.TOT_PROB_LO) : 0.20;
  const TOT_PROB_HI = typeof settings.TOT_PROB_HI !== 'undefined' ? Number(settings.TOT_PROB_HI) : 0.80;
  const MARKET_TOTAL_DFLT = typeof settings.MARKET_TOTAL_DFLT !== 'undefined' ? Number(settings.MARKET_TOTAL_DFLT) : 8.5;

  const signals = [];
  const aModel  = modelResult.aML;
  const hModel  = modelResult.hML;
  const aMarket = game.market_away_ml;
  const hMarket = game.market_home_ml;

  // Probability-point edge: model implied prob minus market implied
  // prob. Sign-consistent across the fav/dog boundary (which the
  // old cents-distance mlEdge was working around). Clamped at 0 —
  // a negative edge isn't a "lean against this side" signal, it
  // just means the model doesn't favor this side here.
  const awayEdge = Math.max(0, impliedP(aModel) - impliedP(aMarket));
  const homeEdge = Math.max(0, impliedP(hModel) - impliedP(hMarket));

  // Emit every signal at or above SIGNAL_EMIT_FLOOR. label is NULL
  // for continuous-edge rows; the UI computes a rounded score from
  // edge and decides highlighting against direction-specific
  // thresholds independently.
  if (haveAnyML && awayEdge >= SIGNAL_EMIT_FLOOR) {
    signals.push({type:'ML',side:'away',label:null,marketLine:aMarket,modelLine:aModel,edge:parseFloat(awayEdge.toFixed(4))});
  }
  if (haveAnyML && homeEdge >= SIGNAL_EMIT_FLOOR) {
    signals.push({type:'ML',side:'home',label:null,marketLine:hMarket,modelLine:hModel,edge:parseFloat(homeEdge.toFixed(4))});
  }

  // Use the PRIMARY source for the total-side edge calc. The user bets at
  // the primary venue (typically Kalshi); EV is what's available at the
  // book they actually transact on, not at sharp consensus. Previously
  // this preferred xcheck on the theory that Kalshi's thin book produced
  // outlier juice and a sharp consensus was a more honest model input —
  // but that hides genuine venue-specific +EV (e.g. Kalshi at +104 over
  // a 51% model is +EV at Kalshi regardless of what Sporttrade thinks).
  // xcheck is still STORED and DISPLAYED in the UI and still drives the
  // line/juice divergence flag in services/jobs.js — it just no longer
  // anchors the edge calculation here. Line + over + under travel as a
  // group — never mix xcheck's line with primary's juice or vice versa.
  const havePrimaryTot = game.market_total != null && game.over_price != null && game.under_price != null;
  const mktTotal   = havePrimaryTot ? game.market_total : (game.xcheck_total       ?? MARKET_TOTAL_DFLT);
  const overPrice  = havePrimaryTot ? game.over_price   : (game.xcheck_over_price  ?? -110);
  const underPrice = havePrimaryTot ? game.under_price  : (game.xcheck_under_price ?? -110);
  const estTot     = modelResult.estTot;

  const overImplied  = overPrice  < 0 ? Math.abs(overPrice) /(Math.abs(overPrice) +100) : 100/(overPrice +100);
  const underImplied = underPrice < 0 ? Math.abs(underPrice)/(Math.abs(underPrice)+100) : 100/(underPrice+100);

  const runDiff    = estTot - mktTotal;
  const modelOverP = Math.min(Math.max(0.5 + runDiff * TOT_SLOPE, TOT_PROB_LO), TOT_PROB_HI);
  const modelUnderP = 1 - modelOverP;

  const overEdge  = modelOverP  - overImplied;
  const underEdge = modelUnderP - underImplied;

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
  if (haveAnyTot && overEdge >= SIGNAL_EMIT_FLOOR) {
    signals.push({type:'Total',side:'over', label:null,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(overEdge.toFixed(4)), ...totSigExtras});
  }
  if (haveAnyTot && underEdge >= SIGNAL_EMIT_FLOOR) {
    signals.push({type:'Total',side:'under',label:null,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(underEdge.toFixed(4)), ...totSigExtras});
  }

  // Direction-only categories (feat/continuous-edge-score). Pre-cutover
  // rows used the legacy "<N-star>-<fav|dog|over|under>" shape; new
  // rows use just the direction. catKey is intentionally NOT used for
  // new emissions — it embeds the now-null label as 'star-' which
  // would corrupt category-based grouping.
  const categorized = signals.map(s => {
    let category;
    if (s.type === 'ML') {
      category = parseInt(s.marketLine) < 0 ? 'fav' : 'dog';
    } else {
      category = s.side; // 'over' or 'under'
    }
    return { ...s, category };
  });

  // Edge-sanity cap (feat/edge-sanity-cap). Default OFF — byte-identical
  // to pre-cap behavior when disabled. When enabled:
  //   - edge >= HARD cap → suppressed entirely (removed from returned
  //     array); pushed onto outSuppressed for audit-log persistence.
  //   - edge >= SOFT cap and < HARD → emitted with edge_suspect=true.
  //   - edge < SOFT → emitted unchanged.
  // Thresholds are fractional pp (0.10 = 10pp). Data-driven defaults
  // from scripts/edge-calibration-curve.js — see settings-schema.js.
  const CAP_ENABLED = !!settings.SIGNAL_EDGE_CAP_ENABLED;
  if (!CAP_ENABLED) return categorized;
  const SOFT = typeof settings.SIGNAL_EDGE_SOFT_CAP_PP !== 'undefined'
    ? Number(settings.SIGNAL_EDGE_SOFT_CAP_PP) : 0.10;
  const HARD = typeof settings.SIGNAL_EDGE_HARD_CAP_PP !== 'undefined'
    ? Number(settings.SIGNAL_EDGE_HARD_CAP_PP) : 0.25;
  const emitted = [];
  for (const s of categorized) {
    if (s.edge >= HARD) {
      if (Array.isArray(outSuppressed)) {
        outSuppressed.push({
          type: s.type, side: s.side, category: s.category,
          edge: s.edge, marketLine: s.marketLine, modelLine: s.modelLine,
          reason: 'edge_hard_cap',
        });
      }
      continue;  // do not emit
    }
    if (s.edge >= SOFT) {
      emitted.push({ ...s, edge_suspect: true });
    } else {
      emitted.push(s);
    }
  }
  return emitted;
}

// "To win $100" P&L. Hoisted to module scope (was inner-defined inside
// calcPnl) so calcRunlinePnl below can share it without copy-paste.
// Returns null when ml is malformed/zero — caller decides how to render.
function toWin100(ml, won) {
  ml = parseFloat(ml);
  if (isNaN(ml) || ml === 0) return null;
  const stake = ml > 0 ? parseFloat((10000 / ml).toFixed(2)) : Math.abs(ml);
  return parseFloat((won ? 100 : -stake).toFixed(2));
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

// Runline (-1.5 / +1.5) PnL — graded against the side's score margin.
// Step 2 of the runline workstream. ML-only companion: invoked from the
// signal-grading paths in services/jobs.js whenever an ML bet_signals
// row has captured a spread snapshot. Total signals never call this.
//
// Inputs:
//   side         — 'away' | 'home' (which side the underlying ML signal was on)
//   spreadLine   — REAL, expected ±1.5 from that side's perspective
//   spreadPrice  — INTEGER American odds at fire time (signed)
//   awayScore, homeScore — final scores; null until game finishes
//
// Returns { outcome, pnl }:
//   - 'pending' (pnl 0)   when scores are missing OR spreadLine is null
//                          (latter is expected for pre-Step-2 ML rows
//                           with no captured snapshot)
//   - 'pending' (pnl null) when spreadPrice is missing or spreadLine
//                          is anomalous (warned/errored — spread should
//                          always be ±1.5 in MLB; if it's not, Step 1's
//                          MLB_RUNLINE_POINTS filter has a bug)
//   - 'win'/'loss' (pnl)  graded via toWin100 at the captured price.
// Pushes are not possible on ±1.5 in MLB (margin can't be 1.5 runs),
// so no push branch.
function calcRunlinePnl(side, spreadLine, spreadPrice, awayScore, homeScore) {
  if (awayScore == null || homeScore == null) return { outcome: 'pending', pnl: 0 };
  // Pre-Step-2 ML signals have no captured snapshot — leave pending,
  // no log (this is the expected steady-state for historical rows).
  if (spreadLine == null) return { outcome: 'pending', pnl: 0 };
  if (spreadPrice == null) {
    console.warn('[runline-grade] spread captured but price missing — side=' + side + ', line=' + spreadLine);
    return { outcome: 'pending', pnl: null };
  }
  if (spreadLine !== -1.5 && spreadLine !== 1.5) {
    console.error('[runline-grade] unexpected spread line ' + spreadLine + ' (Step 1 filter should have rejected) — side=' + side);
    return { outcome: 'pending', pnl: null };
  }
  const sideMargin = side === 'away' ? awayScore - homeScore : homeScore - awayScore;
  // -1.5: must win by ≥2;  +1.5: must lose by ≤1 (or win)
  const won = spreadLine === -1.5 ? sideMargin >= 2 : sideMargin >= -1;
  const pnl = toWin100(spreadPrice, won);
  return { outcome: won ? 'win' : 'loss', pnl };
}

// ============================================================
// SP IP-per-start forecast (F4: Bayesian shrinkage of trailing-EWMA toward
// 30-day league baseline). Scaffolding for v4 cohort — no callers in this
// PR. Wiring into runModel ships in a later PR.
//
// Forecast structure (validated against historical data in
// scripts/sp-ip-forecast-analysis.py — F4 RMSE 10.5% below F1 season-average
// baseline on n=1,349 starts):
//
//   forecast = alpha * league_baseline_30d + (1 - alpha) * pitcher_ewma
//   alpha    = SHRINKAGE_K / (SHRINKAGE_K + n_effective)
//   ewma     = sum(lambda^(N-1-i) * ip_i) / sum(lambda^(N-1-i))   for i in trailing N clean starts
//
// "Clean" excludes anomaly starts (likely-injury exits): pitches < ANOMALY_PITCH_THRESHOLD
// AND ip < ANOMALY_IP_THRESHOLD. Anomalies are filtered from forecast INPUTS;
// the pitcher's future starts are still forecast normally.
//
// buildSpStartIndex(db) is the bridge between SQLite and the pure forecast
// function — same shape as buildWobaIndex. Build once per signal-fire pass,
// pass to forecastSpIP as { index, pitcherMlbId, gameDate, settings }.
//
// Returns { forecast: number, components: {...}, source: string }
// where source ∈ {'shrinkage', 'league_only', 'fallback'}.

const FORECAST_TRAILING_N_DEFAULT = 10;
const FORECAST_DECAY_LAMBDA_DEFAULT = 0.92;
const FORECAST_SHRINKAGE_K_DEFAULT = 10;
const FORECAST_LEAGUE_WINDOW_DAYS_DEFAULT = 30;
const FORECAST_ANOMALY_PITCH_THRESHOLD_DEFAULT = 50;
const FORECAST_ANOMALY_IP_THRESHOLD_DEFAULT = 4;
const FORECAST_FALLBACK_IP_DEFAULT = 5.25;

// Role-specific F4 shrinkage baselines. The SP role uses the data-driven
// empirical baseline (avg IP across recent starts, ~5.4); opener and bulk
// roles use design-derived baselines that reflect the IP-equivalent of
// each slot's design weight. Per the v4 opener-mode redesign:
//   opener_weight 0.15 × 9 IP = 1.35 IP baseline
//   bulk_weight   0.60 × 9 IP = 5.40 IP baseline
// These act as the shrinkage target in forecastSpIP — relievers used as
// openers/bulks shrink toward role-appropriate IP rather than toward the
// SP baseline (which inflates relief-only pitcher forecasts by ~3 IP).
const FORECAST_OPENER_BASELINE_IP_DEFAULT = 1.35;
const FORECAST_BULK_BASELINE_IP_DEFAULT   = 5.40;

// Confidence-haircut defaults. Per the product-owner spec: when a starter
// has few clean current-season priors (first start back, returning from
// injury), our confidence in the SP forecast is low and the model should
// CEDE more weight to the bullpen rather than handing the starter the
// full known-starter premium. Below the full-confidence prior count
// (default 3), the SP weight is pulled toward SP_FORECAST_LOW_CONF_TARGET
// (default 0.62 — meaningfully below the 0.75 anchor but still above the
// literal expected share ~0.57). Linear ramp between 0 priors and N
// priors so 1 / 2 starts already partially restore confidence.
const SP_FORECAST_LOW_CONF_TARGET_DEFAULT  = 0.62;
const SP_FORECAST_FULL_CONF_PRIORS_DEFAULT = 3;

// Short-leash pattern defaults (Fix 3). The base anomaly filter excludes
// starts under (ANOM_P pitches AND ANOM_IP innings). For most pitchers
// this correctly removes an isolated injury exit. But a genuine short-
// leash starter whose outings are consistently short (e.g. 2.0 / 2.3 /
// 6.0 / 2.3) loses most of his record to the filter and falls back to
// the league baseline — exactly the wrong answer for "this guy goes 3
// innings every time." When a meaningful fraction of a pitcher's recent
// non-first-of-season starts are short, stop treating them as
// anomalies — the short outings ARE the data.
//
// Tuning notes:
//   * SHORT_IP_THRESHOLD = 4.0 matches the anomaly IP threshold (4)
//     plus a small buffer; short-leash patterns concentrate well below
//     4 IP per the test pitchers.
//   * FRACTION_THRESHOLD = 0.4 means 40% of recent starts must be short
//     to flip — tested against the 3 short-leash test pitchers (≥50%
//     short each) and an ace with one fluky short start (≤10%).
//   * MIN_STARTS = 3 prevents over-trigger on a tiny early-season
//     sample (e.g. a pitcher with 2 starts both short — that's still
//     statistically thin; the graduated low-conf haircut handles it).
const SP_FORECAST_SHORT_IP_THRESHOLD_DEFAULT       = 4.0;
const SP_FORECAST_PATTERN_FRACTION_THRESHOLD_DEFAULT = 0.4;
const SP_FORECAST_PATTERN_MIN_STARTS_DEFAULT       = 3;

// PR 4: anchored mapping from per-game forecast IP to per-game SP pitching
// weight. League-mean SP forecast (5.5 IP) maps to the existing fixed
// 0.80 weight (no change for average pitchers). Slope of 0.07/IP means
// a 1-IP forecast gap produces a 7pp SP weight gap, which translates to
// roughly 1-2 cents of ML per game and a small total impact. Clamps
// prevent extreme forecasts from collapsing bullpen exposure entirely
// (high clamp) or driving SP weight below a sane floor (low clamp).
//
// Settings overrides:
//   FORECAST_WEIGHT_ANCHOR_IP      anchor IP at which spPitW equals base (default 5.5)
//   FORECAST_WEIGHT_ANCHOR_VALUE   spPitW at anchor (default 0.75 — moderate SP lean over literal share)
//   FORECAST_WEIGHT_SLOPE          spPitW change per IP above/below anchor (default 0.10)
//   FORECAST_WEIGHT_MIN            clamp floor (default 0.50)
//   FORECAST_WEIGHT_MAX            clamp ceiling (default 0.95)
//
// `nPriors` (optional) is the count of clean current-season starts
// behind the forecast. When supplied AND below the full-confidence
// threshold, the returned weight is pulled toward
// SP_FORECAST_LOW_CONF_TARGET (default 0.62) so a low-information
// starter cedes to the bullpen instead of inheriting the full
// known-starter premium. Linear ramp:
//   nPriors = 0          → fully pulled to target (0.62)
//   nPriors = FULL/2     → halfway between target and forecast weight
//   nPriors ≥ FULL (3)   → no haircut, forecast weight unchanged
// When nPriors is null/undefined AND forecastIp is present, behavior is
// back-compat-identical to the pre-haircut function (returns forecastWeight).
//
// forecastIp==null path (revised 2026-07-03, audit finding 2): a pitcher
// with NO forecast at all is the LEAST-informed case and used to return
// null — which fell through the caller's `?? SP_PIT_WEIGHT` to the
// MAXIMUM default weight (0.80). That was the same backwards-fallback
// pattern as the pre-haircut bug: missing data → max confidence. Fixed
// to return the low-confidence target (0.62 by default), the same
// weight a pitcher WITH a forecast but ZERO priors receives. This lets
// the null-forecast case use the existing haircut machinery rather
// than a new constant. Callers should drop the `?? SP_PIT_WEIGHT`
// fallback since the function no longer returns null.
function computeSpPitWeightFromForecast(forecastIp, settings, nPriors) {
  const target = parseFloat(settings?.SP_FORECAST_LOW_CONF_TARGET);
  const targetUsed = (target === target) ? target : SP_FORECAST_LOW_CONF_TARGET_DEFAULT;
  if (forecastIp == null) return targetUsed;
  const anchor = parseFloat(settings?.FORECAST_WEIGHT_ANCHOR_IP) || 5.5;
  const baseVal = parseFloat(settings?.FORECAST_WEIGHT_ANCHOR_VALUE) || 0.75;
  const slope = parseFloat(settings?.FORECAST_WEIGHT_SLOPE);
  const slopeUsed = (slope === slope) ? slope : 0.10; // NaN-safe; defaults to 0.10
  const minW = parseFloat(settings?.FORECAST_WEIGHT_MIN) || 0.50;
  const maxW = parseFloat(settings?.FORECAST_WEIGHT_MAX) || 0.95;
  const raw = baseVal + (forecastIp - anchor) * slopeUsed;
  const forecastWeight = Math.max(minW, Math.min(maxW, raw));
  if (nPriors == null) return forecastWeight;
  const fullN = parseInt(settings?.SP_FORECAST_FULL_CONF_PRIORS, 10)
    || SP_FORECAST_FULL_CONF_PRIORS_DEFAULT;
  const n = Math.max(0, Math.min(fullN, Number(nPriors) || 0));
  // Confidence fraction: 0 → all target; 1 → all forecast weight.
  const conf = fullN > 0 ? n / fullN : 1;
  const haircut = targetUsed + (forecastWeight - targetUsed) * conf;
  // Clamp to the same range so a low forecast doesn't punch through min.
  return Math.max(minW, Math.min(maxW, haircut));
}

// Opener-slot weight from F4 forecast IP. Anchored so a typical opener
// forecast (a true 1-IP specialist's forecast under role='opener' baseline,
// which lands around 1.23 IP) maps to the design weight 0.15. Slope 0.15
// gives meaningful differentiation across the realistic opener forecast
// range (~1.0-2.0 IP). Slightly tighter clamps than SP because opener
// is structurally a small slot — even a long-relief opener shouldn't
// absorb more than 30% of pitching wOBA in opener-mode.
//
// Settings overrides:
//   OPENER_WEIGHT_ANCHOR_IP      anchor IP at which weight equals base (default 1.23)
//   OPENER_WEIGHT_ANCHOR_VALUE   weight at anchor (default 0.15)
//   OPENER_WEIGHT_SLOPE          weight change per IP above/below anchor (default 0.15)
//   OPENER_WEIGHT_MIN            clamp floor (default 0.10)
//   OPENER_WEIGHT_MAX            clamp ceiling (default 0.30)
function computeOpenerPitWeightFromForecast(forecastIp, settings) {
  if (forecastIp == null) return null;
  const anchor = parseFloat(settings?.OPENER_WEIGHT_ANCHOR_IP) || 1.23;
  const baseVal = parseFloat(settings?.OPENER_WEIGHT_ANCHOR_VALUE) || 0.15;
  const slope = parseFloat(settings?.OPENER_WEIGHT_SLOPE);
  const slopeUsed = (slope === slope) ? slope : 0.15;
  const minW = parseFloat(settings?.OPENER_WEIGHT_MIN) || 0.10;
  const maxW = parseFloat(settings?.OPENER_WEIGHT_MAX) || 0.30;
  const raw = baseVal + (forecastIp - anchor) * slopeUsed;
  return Math.max(minW, Math.min(maxW, raw));
}

// Bulk-slot weight from F4 forecast IP. Anchor IP 5.4 matches the bulk
// shrinkage baseline (where a typical bulk pitcher's forecast lands).
// Slope 0.125 produces ~10pp weight spread across the realistic bulk
// forecast range (~5.0-5.7 IP).
//
// Settings overrides:
//   BULK_WEIGHT_ANCHOR_IP        anchor IP at which weight equals base (default 5.4)
//   BULK_WEIGHT_ANCHOR_VALUE     weight at anchor (default 0.60)
//   BULK_WEIGHT_SLOPE            weight change per IP above/below anchor (default 0.125)
//   BULK_WEIGHT_MIN              clamp floor (default 0.30)
//   BULK_WEIGHT_MAX              clamp ceiling (default 0.85)
function computeBulkPitWeightFromForecast(forecastIp, settings) {
  if (forecastIp == null) return null;
  const anchor = parseFloat(settings?.BULK_WEIGHT_ANCHOR_IP) || 5.4;
  const baseVal = parseFloat(settings?.BULK_WEIGHT_ANCHOR_VALUE) || 0.60;
  const slope = parseFloat(settings?.BULK_WEIGHT_SLOPE);
  const slopeUsed = (slope === slope) ? slope : 0.125;
  const minW = parseFloat(settings?.BULK_WEIGHT_MIN) || 0.30;
  const maxW = parseFloat(settings?.BULK_WEIGHT_MAX) || 0.85;
  const raw = baseVal + (forecastIp - anchor) * slopeUsed;
  return Math.max(minW, Math.min(maxW, raw));
}

function buildSpStartIndex(db, settings) {
  // Loads every historical SP start, groups by pitcher_mlb_id ordered
  // by date, and precomputes the 30-day league baseline per game_date.
  // O(N) build; O(1) lookup downstream.
  if (!db) return { byPitcher: {}, leagueBaselineByDate: {}, leagueDates: [] };
  settings = settings || {};
  const ANOM_P = parseFloat(settings.FORECAST_ANOMALY_PITCH_THRESHOLD) || FORECAST_ANOMALY_PITCH_THRESHOLD_DEFAULT;
  const ANOM_IP = parseFloat(settings.FORECAST_ANOMALY_IP_THRESHOLD) || FORECAST_ANOMALY_IP_THRESHOLD_DEFAULT;
  const WIN_DAYS = parseInt(settings.FORECAST_LEAGUE_WINDOW_DAYS, 10) || FORECAST_LEAGUE_WINDOW_DAYS_DEFAULT;

  let rows;
  try {
    rows = db.prepare(`
      SELECT game_date, pitcher_mlb_id, pitcher_name, pitches_thrown,
             innings_pitched, outing_type, was_starter
      FROM pitcher_game_log
      WHERE innings_pitched IS NOT NULL
        AND innings_pitched > 0
        AND pitcher_mlb_id IS NOT NULL
      ORDER BY pitcher_mlb_id ASC, game_date ASC
    `).all();
  } catch (e) {
    // pitcher_game_log may not exist or outing_type column may be missing.
    // Return an empty index; downstream calls fall back to league baseline only.
    return { byPitcher: {}, leagueBaselineByDate: {}, leagueDates: [], buildError: e.message };
  }

  // Annotate and group by pitcher. Rows are sorted by
  // (pitcher_mlb_id ASC, game_date ASC) per the SQL ORDER BY, so we can
  // track first-start-of-season per pitcher with a single pass.
  //
  // Outing-type awareness (PR for relief-aware F4):
  //   - Pitch-count anomaly filter (pitches<50 AND ip<4) only applies to
  //     starts. A 30-pitch / 1-IP appearance is normal for a reliever
  //     but anomalous for a starter (he got pulled early). Without this
  //     guard, every relief outing would be flagged anomalous and a
  //     relief-only pitcher would have zero clean priors.
  //   - First-start-of-season filter only applies to starts. The
  //     "starters ramp up pitch counts on opening day" pattern doesn't
  //     apply to relievers, who throw at full intensity from the start.
  //   - The league baseline (cleanByDate) still comes from starts only,
  //     preserving the existing 5.4 IP baseline that starter forecasts
  //     shrink toward. Relief-only pitchers shrink toward this same
  //     baseline (suboptimal but bounded — addressed in a follow-up
  //     that adds role-specific baselines).
  const byPitcher = {};
  const cleanByDate = []; // for league baseline (starts only)
  let lastPitcherId = null;
  let lastSeasonYear = null;
  for (const r of rows) {
    const isStart = (r.outing_type === 'start') || (r.was_starter === 1);
    // First-start-of-season only meaningful for starts.
    const seasonYear = (r.game_date || '').substring(0, 4);
    let isFirstStartOfSeason = false;
    if (isStart) {
      isFirstStartOfSeason = (r.pitcher_mlb_id !== lastPitcherId)
                              || (seasonYear !== lastSeasonYear);
      lastPitcherId = r.pitcher_mlb_id;
      lastSeasonYear = seasonYear;
    }

    // Pitch-count anomaly filter only applies to starts. A 30-pitch
    // relief outing is normal, not anomalous.
    const isAnomalyBase = isStart
      && (r.pitches_thrown != null && r.pitches_thrown < ANOM_P)
      && (r.innings_pitched < ANOM_IP);
    const isAnomaly = isAnomalyBase || isFirstStartOfSeason;
    const start = {
      game_date: r.game_date,
      ip: r.innings_pitched,
      pitches: r.pitches_thrown,
      outing_type: r.outing_type || (isStart ? 'start' : 'relief'),
      is_start: isStart,
      // Pre-pattern-detection flags. is_anomaly may be flipped to false
      // in the second pass below if the pitcher has a short-leash
      // pattern. is_anomaly_base / is_first_of_season are preserved as
      // provenance so a downstream reader can see why a start WAS
      // initially anomaly-tagged.
      is_anomaly_base: isAnomalyBase,
      is_anomaly: isAnomaly,
      is_first_of_season: isFirstStartOfSeason,
      short_leash_pattern: false,
    };
    if (!byPitcher[r.pitcher_mlb_id]) byPitcher[r.pitcher_mlb_id] = [];
    byPitcher[r.pitcher_mlb_id].push(start);
  }

  // ---- Fix 3: short-leash pattern detection ----
  // Re-examine each pitcher's recent (trailing N) starts. If a meaningful
  // fraction are "short" (IP < SHORT_IP_THRESHOLD), un-flag the
  // anomaly-base starts in that window so the pitcher's forecast
  // reflects short-leash reality instead of falling back to league
  // baseline. Looks at TRAILING N starts (matches the forecast window
  // size) so a role change mid-season is correctly classified — a guy
  // who used to be an ace but is currently a 3-IP bullpen-game starter
  // gets the short-leash treatment based on his current cluster.
  //
  // First-start-of-season is preserved as anomalous separately — that's
  // a signal-thinness concern handled by the confidence haircut, not a
  // short-outing concern.
  const SHORT_IP = parseFloat(settings.SP_FORECAST_SHORT_IP_THRESHOLD)
    || SP_FORECAST_SHORT_IP_THRESHOLD_DEFAULT;
  const PATTERN_FRAC = parseFloat(settings.SP_FORECAST_PATTERN_FRACTION_THRESHOLD)
    || SP_FORECAST_PATTERN_FRACTION_THRESHOLD_DEFAULT;
  const PATTERN_MIN = parseInt(settings.SP_FORECAST_PATTERN_MIN_STARTS, 10)
    || SP_FORECAST_PATTERN_MIN_STARTS_DEFAULT;
  // Pattern detection looks at the same trailing window as the forecast
  // (FORECAST_TRAILING_N) — keeps the two in step.
  const PATTERN_N = parseInt(settings.FORECAST_TRAILING_N, 10) || FORECAST_TRAILING_N_DEFAULT;
  for (const pid of Object.keys(byPitcher)) {
    const starts = byPitcher[pid];
    // Collect this pitcher's start-rows in date order (rows are already
    // date-sorted by SQL). Skip relief and first-of-season — neither
    // counts toward the pattern signal.
    const startsOnly = [];
    for (const s of starts) {
      if (!s.is_start) continue;
      if (s.is_first_of_season) continue;
      startsOnly.push(s);
    }
    if (startsOnly.length < PATTERN_MIN) continue;
    // Trailing N starts. If trailing N < MIN, that's a tiny sample and
    // pattern detection shouldn't fire.
    const recent = startsOnly.slice(-PATTERN_N);
    if (recent.length < PATTERN_MIN) continue;
    const shortRecent = recent.filter(s => s.ip < SHORT_IP);
    const frac = shortRecent.length / recent.length;
    if (frac < PATTERN_FRAC) continue;
    // Pattern matched — flip anomaly-base starts back to clean, only
    // within the trailing window (older starts keep their original
    // tagging so seasons-prior history doesn't get retro-classified).
    for (const s of recent) {
      if (s.is_anomaly_base && !s.is_first_of_season) {
        s.is_anomaly = false;
        s.short_leash_pattern = true;
      }
    }
  }

  // League baseline build (uses the FINAL is_anomaly value post-pattern
  // detection). Short-leash short outings now contribute to the league
  // baseline correctly — a small downward pull, dominated by the ~700
  // normal starts per month.
  for (const pid of Object.keys(byPitcher)) {
    for (const s of byPitcher[pid]) {
      if (!s.is_anomaly && s.is_start) {
        cleanByDate.push({ date: s.game_date, ip: s.ip });
      }
    }
  }

  // Build league baseline cache: for each unique date that has a clean
  // start, compute avg IP of clean starts in [date - WIN_DAYS, date).
  // Sorted-array sliding-window approach.
  cleanByDate.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const uniqueDates = [];
  let prev = null;
  for (const c of cleanByDate) {
    if (c.date !== prev) { uniqueDates.push(c.date); prev = c.date; }
  }

  const leagueBaselineByDate = {};
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  let leftIdx = 0;
  for (const d of uniqueDates) {
    const dt = new Date(d + 'T00:00:00Z').getTime();
    const cutoff = dt - WIN_DAYS * MS_PER_DAY;
    while (leftIdx < cleanByDate.length && new Date(cleanByDate[leftIdx].date + 'T00:00:00Z').getTime() < cutoff) leftIdx++;
    let sum = 0, n = 0;
    for (let i = leftIdx; i < cleanByDate.length; i++) {
      const dti = new Date(cleanByDate[i].date + 'T00:00:00Z').getTime();
      if (dti >= dt) break; // strictly before target date
      sum += cleanByDate[i].ip;
      n++;
    }
    leagueBaselineByDate[d] = n > 0 ? sum / n : null;
  }

  return {
    byPitcher,
    leagueBaselineByDate,
    leagueDates: Object.keys(leagueBaselineByDate).sort(),
  };
}

function _lookupLeagueBaseline(index, gameDate, fallbackIP) {
  // Walk back from gameDate to the most recent prior date with a cached baseline.
  // Used when gameDate isn't exactly in the cache (e.g. a date with no clean starts).
  if (!index || !index.leagueBaselineByDate) return fallbackIP;
  const direct = index.leagueBaselineByDate[gameDate];
  if (direct != null) return direct;
  const dates = index.leagueDates || [];
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] < gameDate) {
      const v = index.leagueBaselineByDate[dates[i]];
      if (v != null) return v;
    }
  }
  return fallbackIP;
}

function forecastSpIP({ index, pitcherMlbId, gameDate, settings, role }) {
  settings = settings || {};
  const N = parseInt(settings.FORECAST_TRAILING_N, 10) || FORECAST_TRAILING_N_DEFAULT;
  const LAMBDA = parseFloat(settings.FORECAST_DECAY_LAMBDA) || FORECAST_DECAY_LAMBDA_DEFAULT;
  const K = parseFloat(settings.FORECAST_SHRINKAGE_K) || FORECAST_SHRINKAGE_K_DEFAULT;
  const FALLBACK = parseFloat(settings.FORECAST_FALLBACK_IP) || FORECAST_FALLBACK_IP_DEFAULT;

  // Role-aware F4 shrinkage baseline. Default 'start' uses the data-driven
  // empirical league baseline (~5.4 IP avg across recent starts). Opener
  // and bulk roles use design-derived baselines so relief-style pitchers
  // shrink toward role-appropriate IP instead of being inflated by the
  // starter baseline. Settings overrides allow tuning per role.
  const roleUsed = (role === 'opener' || role === 'bulk') ? role : 'start';
  let f0;
  if (roleUsed === 'opener') {
    f0 = parseFloat(settings.FORECAST_OPENER_BASELINE_IP) || FORECAST_OPENER_BASELINE_IP_DEFAULT;
  } else if (roleUsed === 'bulk') {
    f0 = parseFloat(settings.FORECAST_BULK_BASELINE_IP) || FORECAST_BULK_BASELINE_IP_DEFAULT;
  } else {
    // 'start' — keep empirical data-driven baseline unchanged
    f0 = _lookupLeagueBaseline(index, gameDate, FALLBACK);
  }

  // No pitcher id, no index, or no historical priors → role baseline only.
  if (!pitcherMlbId || !index || !index.byPitcher || !index.byPitcher[pitcherMlbId]) {
    return {
      forecast: f0,
      components: { f0_league: f0, f3_ewma: null, n_eff: 0, alpha: 1, role_used: roleUsed },
      source: (roleUsed === 'start' && f0 === FALLBACK) ? 'fallback' : 'league_only',
    };
  }

  // Filter to strictly-prior clean starts; take last N.
  const allPriors = index.byPitcher[pitcherMlbId];
  const cleanPriors = [];
  for (const p of allPriors) {
    if (p.game_date >= gameDate) break; // priors are date-sorted ascending
    if (!p.is_anomaly) cleanPriors.push(p);
  }
  if (cleanPriors.length === 0) {
    return {
      forecast: f0,
      components: { f0_league: f0, f3_ewma: null, n_eff: 0, alpha: 1, role_used: roleUsed },
      source: (roleUsed === 'start' && f0 === FALLBACK) ? 'fallback' : 'league_only',
    };
  }
  const window = cleanPriors.slice(-N);

  // EWMA: most recent start weight 1.0, prior 0.85, etc.
  let wsum = 0, wn = 0;
  const L = window.length;
  for (let i = 0; i < L; i++) {
    const w = Math.pow(LAMBDA, L - 1 - i);
    wsum += w * window[i].ip;
    wn += w;
  }
  const ewma = wsum / wn;
  const nEff = wn;

  // Bayesian shrinkage toward F0 (role-specific baseline).
  const alpha = K / (K + nEff);
  const forecast = alpha * f0 + (1 - alpha) * ewma;

  return {
    forecast,
    components: {
      f0_league: f0,
      f3_ewma: ewma,
      n_eff: nEff,
      alpha,
      window_size: L,
      total_clean_priors: cleanPriors.length,
      role_used: roleUsed,
    },
    source: 'shrinkage',
  };
}

// Single-source helper for the catcher-framing run delta. Mirrors the
// inline gating inside runModel (line ~691) so anything that wants to
// REPORT what the model would apply can call this with the same
// (rvPerGame, settings) inputs and get the same number.
//
// Input rvPerGame is the raw per-game run-value (positive = catcher
// SAVES runs from the opposing offense). Output is the SIGNED runs
// subtracted from the offense facing this catcher. Returns 0 when the
// toggle is off, when the value is null/NaN, or for any input the
// model would treat as a clean no-op — the exact gating the model
// uses so empty states display as 0 IFF the model would apply 0.
function applyCatcherFramingDelta(rvPerGame, settings) {
  if (!settings || !settings.CATCHER_FRAMING_ENABLED) return 0;
  if (typeof rvPerGame !== 'number' || isNaN(rvPerGame)) return 0;
  // Mirror the internal num() helper used at runModel's top
  // (null/empty → default; Number() NaN → default).
  const raw = settings.CATCHER_FRAMING_MUTE;
  let mute = 0.5;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!isNaN(n)) mute = n;
  }
  return rvPerGame * mute;
}

module.exports = { normName,buildWobaIndex,getBatterWoba,getPitcherWoba,runModel,getSignals,calcPnl,calcRunlinePnl,impliedP,buildSpStartIndex,forecastSpIP,computeSpPitWeightFromForecast,computeOpenerPitWeightFromForecast,computeBulkPitWeightFromForecast,applyCatcherFramingDelta };