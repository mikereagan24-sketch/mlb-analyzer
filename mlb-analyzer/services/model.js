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
function runModel(game, wobaIdx, settings, mode) {
  // mode === 'opener_aware' enables the 3-way pitching split for any side
  // with is_opener_game_<side>=1 AND bulk_guy_<side> set. Sides without
  // opener data keep the standard 2-way split inside the same call. Any
  // other value (incl. undefined) runs the standard model end-to-end.
  // Caller (processGameSignals) computes BOTH and persists each pair so
  // the use_opener_logic flag can swap which one feeds getSignals
  // without re-running the model.
  if (mode == null) mode = 'standard';
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
  // PR 4 (v4 cohort): bulk slot scaled by F4 forecast IP. Default BULK_FACED
  // sums to ~13.5 batters faced (≈4.5 IP at 3 BF/IP). When the bulk pitcher
  // has a forecast IP > 4.5, we scale BULK_FACED entries up proportionally
  // so the bulk slot absorbs more of the middle innings. The per-slot
  // clamp inside buildPerPositionWeights prevents any one slot from
  // exceeding 100% opener+bulk coverage. Bullpen slot absorbs the residual.
  // BULK_DEFAULT_IP is the implied IP equivalent of the default distribution
  // (~4.5 = 13.5/3). Slight rounding: derived from PA_WEIGHTS for honesty.
  const BULK_DEFAULT_BF_SUM = BULK_FACED.reduce((s, v) => s + (v || 0), 0);
  const BULK_DEFAULT_IP_EQUIV = Math.max(0.1, BULK_DEFAULT_BF_SUM / 3.0);
  const buildPerPositionWeights = (mode_, bulkScale) => {
    const scale = (typeof bulkScale === 'number' && bulkScale > 0) ? bulkScale : 1.0;
    const out = new Array(9);
    for (let i = 0; i < 9; i++) {
      const pa = PA_WEIGHTS[i] || 1; // PA_WEIGHTS[i] should never be 0/null but guard for safety
      let openerFrac = Math.max(0, Math.min(1, (OPENER_FACED[i] || 0) / pa));
      let bulkFrac   = mode_ === 'bullpen_game'
        ? 0
        : Math.max(0, Math.min(1, ((BULK_FACED[i] || 0) * scale) / pa));
      const sum = openerFrac + bulkFrac;
      if (sum > 1) {
        openerFrac = openerFrac / sum;
        bulkFrac   = bulkFrac   / sum;
      }
      const bullpenFrac = 1 - openerFrac - bulkFrac;
      out[i] = { opener: openerFrac, bulk: bulkFrac, bullpen: bullpenFrac };
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
      console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': SP-null → opener slot sourced from bullpen pool'
        + ' (vsL=' + bullpenVsL.toFixed(3) + ', vsR=' + bullpenVsR.toFixed(3) + ')');
    }

    // Bullpen-game branch: opener flagged, no bulk man identified
    // (game_type_{side} = 'bullpen_game'). bulkFrac is 0 at every
    // position; bullpenFrac absorbs the slot. bulk wOBA fields stay
    // null so perBatterEW skips reading them.
    if (!bulkSp) {
      const perPositionWeights = buildPerPositionWeights('bullpen_game');
      const sample = perPositionWeights[0];
      console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': bullpen_game mode (no bulk man identified, per-batter weighting; pos1='
        + 'opener=' + sample.opener.toFixed(3) + '/bullpen=' + sample.bullpen.toFixed(3) + ')');
      return {
        mode: 'bullpen_game',
        openerVsL, openerVsR,
        bulkVsL: null, bulkVsR: null,
        bullpenWobaVsL: bullpenVsL,
        bullpenWobaVsR: bullpenVsR,
        perPositionWeights,
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
      console.warn('[opener-model] ' + (game.game_id || '?') + '/' + side
        + ': bulk-guy ' + bulkSp + ' not in wOBA index — using UNKNOWN_PITCHER_WOBA=' + UNK_PIT_WOBA);
      bulkVsL = UNK_PIT_WOBA;
      bulkVsR = UNK_PIT_WOBA;
    }
    // PR 4: scale BULK_FACED proportionally to the bulk pitcher's F4
    // forecast IP. game_log columns away/home_bulk_forecast_ip are
    // populated by services/jobs.js forecastForPitcher for opener games
    // with PRIM-tagged bulk pitchers. Falls back to scale=1.0 (no change
    // from v3 BULK_FACED default) when forecast is null. Captured for
    // persistence below.
    const bulkFcRaw = side === 'away' ? game.away_bulk_forecast_ip : game.home_bulk_forecast_ip;
    const bulkFc = (bulkFcRaw != null) ? parseFloat(bulkFcRaw) : null;
    const bulkScale = (bulkFc != null && bulkFc > 0) ? (bulkFc / BULK_DEFAULT_IP_EQUIV) : 1.0;
    const perPositionWeights = buildPerPositionWeights('opener', bulkScale);
    const s0 = perPositionWeights[0], s4 = perPositionWeights[4], s8 = perPositionWeights[8];
    console.log('[opener-model] ' + (game.game_id || '?') + '/' + side
      + ': opener+bulk per-batter (pos1 op=' + s0.opener.toFixed(3) + '/bk=' + s0.bulk.toFixed(3) + '/bp=' + s0.bullpen.toFixed(3)
      + '; pos5 op=' + s4.opener.toFixed(3) + '/bk=' + s4.bulk.toFixed(3) + '/bp=' + s4.bullpen.toFixed(3)
      + '; pos9 op=' + s8.opener.toFixed(3) + '/bk=' + s8.bulk.toFixed(3) + '/bp=' + s8.bullpen.toFixed(3) + ')');
    return {
      mode: 'opener',
      openerVsL, openerVsR,
      bulkVsL, bulkVsR,
      bullpenWobaVsL: bullpenVsL,
      bullpenWobaVsR: bullpenVsR,
      perPositionWeights,
      // PR 4: bulk-slot scale used in this run for downstream persistence
      // and tracing. null bulkFcUsed means we used the default distribution.
      bulkScale,
      bulkFcUsed: bulkFc,
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
  // shrinkage source) falls back to the fixed SP_PIT_WEIGHT, preserving
  // v3 behavior. Bullpen weight is the complement so the pitching
  // component always sums to 1.0.
  //
  // Note the cross-side mapping below: the AWAY batters are facing the
  // HOME pitcher, so their perBatterEW call uses HOME's forecast to
  // compute SP weight. Symmetric for HOME batters.
  const awayFc = game.away_sp_forecast_ip != null ? parseFloat(game.away_sp_forecast_ip) : null;
  const homeFc = game.home_sp_forecast_ip != null ? parseFloat(game.home_sp_forecast_ip) : null;
  const awaySpPitW = computeSpPitWeightFromForecast(awayFc, settings) ?? SP_PIT_WEIGHT;
  const homeSpPitW = computeSpPitWeightFromForecast(homeFc, settings) ?? SP_PIT_WEIGHT;
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
  return { aTeamWoba,hTeamWoba,aRuns,hRuns,rawHW,adjHW,adjAW,aML,hML,estTot,windFactor,windRunAdj,
    // PR 4: per-side SP weights used in this model run. Persisted to
    // game_log.{away,home}_sp_weight_used by processGameSignals so
    // future backtests can replay model with exact weight inputs.
    // Bullpen weight is the complement (1 - sp_weight).
    awaySpWeightUsed: awaySpPitW, homeSpWeightUsed: homeSpPitW,
    // Bulk-slot scale factor when this side is in opener mode and has a
    // bulk forecast. Null otherwise. The scale is multiplied into
    // BULK_FACED inside buildPerPositionWeights; downstream persistence
    // can also recover it as (sum(perPositionWeights[i].bulk)/sum(default)).
    awayBulkWeightUsed: awayOpenerOpts && awayOpenerOpts.bulkFcUsed != null ? awayOpenerOpts.bulkScale : null,
    homeBulkWeightUsed: homeOpenerOpts && homeOpenerOpts.bulkFcUsed != null ? homeOpenerOpts.bulkScale : null };
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
 * @returns {Signal[]} Empty array if model._suppressed OR market data is null
 *   (PR #26: null-market suppression for ML and Total independently).
 */
function getSignals(game, modelResult, settings) {
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
  if (haveAnyML && aLabel) signals.push({type:'ML',side:'away',label:aLabel,marketLine:aMarket,modelLine:aModel,edge:Math.round(awayEdge)});
  if (haveAnyML && hLabel) signals.push({type:'ML',side:'home',label:hLabel,marketLine:hMarket,modelLine:hModel,edge:Math.round(homeEdge)});

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
  if (haveAnyTot && oLabel) signals.push({type:'Total',side:'over', label:oLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(overEdge.toFixed(4)), ...totSigExtras});
  if (haveAnyTot && uLabel) signals.push({type:'Total',side:'under',label:uLabel,marketLine:mktTotal,modelLine:parseFloat(estTot.toFixed(1)),overPrice,underPrice,edge:parseFloat(underEdge.toFixed(4)), ...totSigExtras});

  return signals.map(s=>({...s,category:catKey(s.type,s.side,s.label,s.marketLine)}));
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
// Returns null when forecastIp is null/undefined — caller falls back to
// fixed SP_PIT_WEIGHT, preserving v3 behavior for games with no forecast.
function computeSpPitWeightFromForecast(forecastIp, settings) {
  if (forecastIp == null) return null;
  const anchor = parseFloat(settings?.FORECAST_WEIGHT_ANCHOR_IP) || 5.5;
  const baseVal = parseFloat(settings?.FORECAST_WEIGHT_ANCHOR_VALUE) || 0.75;
  const slope = parseFloat(settings?.FORECAST_WEIGHT_SLOPE);
  const slopeUsed = (slope === slope) ? slope : 0.10; // NaN-safe; defaults to 0.10
  const minW = parseFloat(settings?.FORECAST_WEIGHT_MIN) || 0.50;
  const maxW = parseFloat(settings?.FORECAST_WEIGHT_MAX) || 0.95;
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
      is_anomaly: isAnomaly,
      // Provenance for the debug endpoint — lets the reader see WHY a
      // start was filtered (was it a short outing, or just a season opener?).
      is_first_of_season: isFirstStartOfSeason,
    };
    if (!byPitcher[r.pitcher_mlb_id]) byPitcher[r.pitcher_mlb_id] = [];
    byPitcher[r.pitcher_mlb_id].push(start);
    // Only starts contribute to the league baseline. Relief outings would
    // collapse the baseline toward ~1 IP and destroy starter forecasts.
    if (!isAnomaly && isStart) cleanByDate.push({ date: r.game_date, ip: r.innings_pitched });
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

function forecastSpIP({ index, pitcherMlbId, gameDate, settings }) {
  settings = settings || {};
  const N = parseInt(settings.FORECAST_TRAILING_N, 10) || FORECAST_TRAILING_N_DEFAULT;
  const LAMBDA = parseFloat(settings.FORECAST_DECAY_LAMBDA) || FORECAST_DECAY_LAMBDA_DEFAULT;
  const K = parseFloat(settings.FORECAST_SHRINKAGE_K) || FORECAST_SHRINKAGE_K_DEFAULT;
  const FALLBACK = parseFloat(settings.FORECAST_FALLBACK_IP) || FORECAST_FALLBACK_IP_DEFAULT;

  // League baseline always available (or fallback).
  const f0 = _lookupLeagueBaseline(index, gameDate, FALLBACK);

  // No pitcher id, no index, or no historical priors → league baseline only.
  if (!pitcherMlbId || !index || !index.byPitcher || !index.byPitcher[pitcherMlbId]) {
    return {
      forecast: f0,
      components: { f0_league: f0, f3_ewma: null, n_eff: 0, alpha: 1 },
      source: f0 === FALLBACK ? 'fallback' : 'league_only',
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
      components: { f0_league: f0, f3_ewma: null, n_eff: 0, alpha: 1 },
      source: f0 === FALLBACK ? 'fallback' : 'league_only',
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

  // Bayesian shrinkage toward F0.
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
    },
    source: 'shrinkage',
  };
}

module.exports = { normName,buildWobaIndex,getBatterWoba,getPitcherWoba,runModel,getSignals,calcPnl,calcRunlinePnl,impliedP,buildSpStartIndex,forecastSpIP };