// jobs.js v2026-04-12T19:57:39.540Z
// File encoding: UTF-8 (do not save as Windows-1252)
const cron = require('node-cron');
const crypto = require('crypto');
const { q, db } = require('../db/schema');
const { fetchLineups, fetchLineupsRaw, parseLineupsHtml, fetchScores, fetchScoresRaw, parseScoresJson, fetchOddsAPI, fetchKalshiDirect, makeGameId, fetchActiveRosters, fetchSeasonRosters, fetchCatcherFraming, fetchCatcherFramingHistorical, fetchFieldingFrv, fetchSchedule } = require('./scraper');
const { fetchTeamBaserunning, fetchPlayerBaserunning, fetchPlayerBaserunningTrailing } = require('./fangraphs');
const { fetchUnabatedOdds, fetchUnabatedRaw, parseUnabatedOdds } = require('./unabated');
const { getKalshiMlbLines, getKalshiMlbTotals, getKalshiMlbSpreads, kalshiTakerFeeRate } = require('./kalshi');
const { getPolymarketMlbLines, polyTakerFeeRate } = require('./polymarket');
const empiricalSpreadEdge = require('./empirical-spread-edge');
const { runModel, getSignals, calcPnl, calcRunlinePnl, buildSpStartIndex, forecastSpIP } = require('./model');
const { fetchParkWind } = require('./weather');
const { normName, stripSfx } = require('../utils/names');
const { calcCLV } = require('./clv');
const { writeSnapshot } = require('./snapshot');

// Cohort assignment by game_date. Shared by processGameSignals (auto-
// emitted signals) AND routes/api.js POST /signals/manual (manual bet
// log). Prior to hoisting, /signals/manual hardcoded 'v3', so every
// manually-logged bet since April was tagged v3 regardless of the true
// epoch — invisible under any default cohort filter. See
// docs/locked-bet-visibility-fix-2026-07-06.md.
//
// Boundaries match db/schema.js one-shot migrations exactly. Update in
// lockstep at each cohort cutover.
function cohortForGameDate(game_date) {
  return game_date >= '2026-07-06' ? 'v7'
    : game_date >= '2026-05-30' ? 'v6'
    : game_date >= '2026-05-20' ? 'v5'
    : game_date >= '2026-05-12' ? 'v4'
    : game_date < '2026-04-24' ? 'v3-pretuning' : 'v3';
}

// Venue-aware signal edges (feat/venue-aware-signals; consolidated
// with feat/venue-comparison-resilience, 2026-07-10). Previously kept a
// per-jobs.js 60s Map cache duplicating what routes/api.js had. Owner's
// Part 1 ruling: route + odds-cron tail + matchup-tab must share one
// upstream fetch pair per (date, opts) window. Both callers now route
// through services/odds-comparison.runComparisonCached which owns the
// shared cache + in-flight-promise dedup. This function stays as a
// thin adapter that reshapes the { rows: [...] } response into the
// rowsByGid map processGameSignals + refreshSignalBaselines want.
async function _fetchVenueSlateCached(game_date) {
  const { runComparisonCached } = require('./odds-comparison');
  try {
    const res = await runComparisonCached(game_date, {});
    const rowsByGid = {};
    for (const r of (res.rows || [])) if (r.game_id) rowsByGid[r.game_id] = r;
    return rowsByGid;
  } catch (e) {
    console.warn('[venue-aware] runComparisonCached failed for ' + game_date + ': ' + e.message);
    return {};
  }
}

// Shared snapshot lookup (fix/venue-lazy-fetch-and-content-guard, 2026-07-10).
// Both processGameSignals and refreshSignalBaselines need to fall back to
// the last-good pregame venue snapshot when the live comparison is
// unavailable — same tier discipline in both call paths kills the
// ping-pong bug where processGameSignals wrote tier-3 (no venue) while
// refreshSignalBaselines wrote tier-1 (from live), flipping the row
// back and forth on every cron cycle.
//
// Age gate matches refreshSignalBaselines' SNAPSHOT_FRESH_MAX_MS default:
// 30 minutes. Beyond that, snapshot is too old to be considered tier-1
// and the caller falls through to lower tiers.
const _SNAPSHOT_FRESH_MAX_MS_DEFAULT = 30 * 60 * 1000;
let _snapPrepared = null;
function _loadFreshSnapshotForGid(game_date, game_id, maxAgeMs) {
  if (!_snapPrepared) {
    try {
      _snapPrepared = db.prepare(
        "SELECT snapshot_at, snapshot_json FROM venue_comparison_snapshot "
      + "WHERE game_date=? AND game_id=?"
      );
    } catch (e) { return null; }
  }
  const s = _snapPrepared.get(game_date, game_id);
  if (!s) return null;
  try {
    const ageMs = Date.now() - new Date(s.snapshot_at).getTime();
    if (ageMs > (maxAgeMs || _SNAPSHOT_FRESH_MAX_MS_DEFAULT)) return null;
    const parsed = JSON.parse(s.snapshot_json);
    parsed._snapshot_at = s.snapshot_at;
    parsed._snapshot_age_ms = ageMs;
    return parsed;
  } catch (e) { return null; }
}

// Lineup content hash (fix/venue-lazy-fetch-and-content-guard, 2026-07-10).
// Digests the game_log fields that materially affect processGameSignals'
// output — lineup JSON per side plus lineup_status per side (projected vs
// confirmed can swing the model even when the batter list is identical).
//
// Used by the refreshSignalBaselines staleness guard: instead of skipping
// on the timestamp `lineups_quality_at > rowStamp` (which trips whenever
// RotoWire re-serves the same lineup, freezing the row on stale data),
// the guard now compares the stored hash on bet_signals against the
// current game_log hash. Skip only when they differ — meaning a real
// content change is inbound and processGameSignals is about to rewrite
// model_line, so refreshing market_line here would produce a mismatched
// edge_pct in the interim.
//
// Nulls collapse to empty strings so a lineup that hasn't populated yet
// still produces a stable hash rather than throwing.
function _computeLineupHash(gl) {
  if (!gl) return null;
  const parts = [
    gl.away_lineup_json || '',
    gl.home_lineup_json || '',
    gl.away_lineup_status || '',
    gl.home_lineup_status || '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Pick the venue-best net American ML for a side, respecting the fillable-
// at-stake guard. Returns {ml, venue} on success, or null if neither venue
// qualifies (caller falls back to Kalshi-direct with venue_stale=1).
function _pickBestML(rowForGame, side) {
  if (!rowForGame) return null;
  const P = rowForGame.poly && rowForGame.poly[side];
  const K = rowForGame.kalshi && rowForGame.kalshi[side];
  const polyOK = P && P.net_american != null && !P.partial;
  const kalOK  = K && K.net_american != null && !K.partial;
  if (!polyOK && !kalOK) return null;
  if (polyOK && !kalOK)  return { ml: P.net_american, venue: 'poly' };
  if (kalOK && !polyOK)  return { ml: K.net_american, venue: 'kalshi' };
  // Both eligible — higher net_american = better for the bettor.
  return P.net_american >= K.net_american
    ? { ml: P.net_american, venue: 'poly' }
    : { ml: K.net_american, venue: 'kalshi' };
}

// Pacific-Time date helpers (app is Pacific-based now). Neutral names on
// purpose — if the app's canonical TZ ever shifts again, only these three
// function bodies need updating, not every call site.
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
// PT-anchored "YYYY-MM-DD HH:MM:SS" timestamp. Used by the empirical-
// spread / morning-capture writers so generated_at / opened_at /
// graded_at columns match the rest of the project's PT convention
// (snapshot tables, todayStr/tomorrowStr above) rather than the UTC
// that SQLite's datetime('now') and JS toISOString() default to.
//
// 'sv-SE' is the trick: that locale formats as YYYY-MM-DD HH:MM:SS
// natively, identical on-disk shape to what we wrote before — only the
// wall-clock anchor changes.
//
// [tz cutover: 2026-06-08] — Rows written before this fix are UTC.
// Rows written after are PT. The two coexist; PK-component
// generated_at values are NOT rewritten. The eventual ROI / window
// readout must apply the offset for rows with game_date <= cutover.
function nowPtIso() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' });
}

const { getDefaults: _settingsDefaults } = require('./settings-schema');

function getSettings() {
  const rows = q.getAllSettings.all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  // Use Number() and ?? so 0 is valid (|| would replace 0 with default)
  // Treat null/undefined/empty-string as missing so an accidentally-blanked
  // form field falls back to the default instead of Number('')===0 silently
  // zeroing out load-bearing params (e.g. RELIEF_WEIGHT → no bullpen at all).
  const num = (key, def) => {
    const raw = s[key];
    if (raw == null || raw === '') return def;
    const v = Number(raw);
    return isNaN(v) ? def : v;
  };
  // Defaults sourced from services/settings-schema.js for keys it covers; the
  // schema is the single source of truth so a server boot against an empty
  // app_settings table runs with the same numbers the validator enforces.
  // Keys the schema doesn't enumerate (FAV_ADJ, DOG_ADJ, MIN_PA, etc.) keep
  // their inline defaults below.
  const _DFL = _settingsDefaults();
  const _d = (key, fallback) => (_DFL[key] !== undefined ? _DFL[key] : fallback);
  return {
    RUN_MULT:       num('run_mult',          _d('run_mult', 48)),
    HFA_BOOST:      num('hfa_boost',         _d('hfa_boost', 0.02)),
    FAV_ADJ:        num('fav_adj', 0),
    DOG_ADJ:        num('dog_adj', 0),
    W_PIT:          num('w_pit',             _d('w_pit', 0.5)),
    W_BAT:          num('w_bat',             _d('w_bat', 0.5)),
    W_PROJ:         num('w_proj',            _d('w_proj', 0.65)),
    W_ACT:          num('w_act',             _d('w_act', 0.35)),
    // Continuous-edge thresholds (feat/continuous-edge-score). The
    // legacy ml_/tot_ lean/value/3star tier keys are gone; getSignals
    // now reads SIGNAL_EMIT_FLOOR_PP only. The UI_HIGHLIGHT_*
    // settings are read separately by the UI via /api/settings — the
    // model does not consume them.
    SIGNAL_EMIT_FLOOR_PP: num('signal_emit_floor_pp', _d('signal_emit_floor_pp', 0.01)),
    SP_WEIGHT:      num('sp_weight',         _d('sp_weight', 0.77)),
    RELIEF_WEIGHT:     num('relief_weight',     _d('relief_weight', 0.23)),
    SP_PIT_WEIGHT:     num('sp_pit_weight',     _d('sp_pit_weight', 0.80)),
    RELIEF_PIT_WEIGHT: num('relief_pit_weight', _d('relief_pit_weight', 0.20)),
    BP_STRONG_WEIGHT_R: num('bp_strong_weight_r', _d('bp_strong_weight_r', 0.55)),
    BP_WEAK_WEIGHT_R:   num('bp_weak_weight_r',   _d('bp_weak_weight_r',   0.45)),
    BP_STRONG_WEIGHT_L: num('bp_strong_weight_l', _d('bp_strong_weight_l', 0.35)),
    BP_WEAK_WEIGHT_L:   num('bp_weak_weight_l',   _d('bp_weak_weight_l',   0.65)),
    BULLPEN_AVG:    num('bullpen_avg',       _d('bullpen_avg', 0.318)),
    WOBA_BASELINE:  num('woba_baseline',     _d('woba_baseline', 0.230)),
    PYTH_EXP:       num('pyth_exp',          _d('pyth_exp', 1.83)),
    WIND_SCALE:     num('wind_scale',        2.0),
    TOT_SLOPE:      num('tot_slope',         _d('tot_slope', 0.08)),
    MIN_PA:         num('min_pa',         60),
    MIN_BF:         num('min_bf',         100),
    // Bullpen-side actuals-blend gate. Separate from SP-facing MIN_BF because
    // RPs rarely reach 100 BF vs one handedness. Default 50 (schema).
    BULLPEN_MIN_BF: num('bullpen_min_bf', _d('bullpen_min_bf', 50)),
    // Downweight rostered RPs by (1 − start_BF_fraction) in the pool mean —
    // strips opener/bulk pollution. TEXT-coerced boolean like the other
    // toggles above. Default true (schema) — set to 'false' for byte-identical.
    BULLPEN_DOWNWEIGHT_STARTERS: (function() {
      const raw = s['bullpen_downweight_starters'];
      if (raw == null) return _d('bullpen_downweight_starters', true);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    // Bullpen-specific proj/act blend (Path B). Defaults 0.25/0.75. Null →
    // fall back to the global W_PROJ/W_ACT so legacy DBs without these rows
    // stay byte-identical.
    BULLPEN_W_PROJ: num('bullpen_w_proj', _d('bullpen_w_proj', 0.25)),
    BULLPEN_W_ACT:  num('bullpen_w_act',  _d('bullpen_w_act',  0.75)),
    // Venue-aware signal edges (feat/venue-aware-signals). Default OFF —
    // when ON, market_line is sourced from services/odds-comparison.js
    // winner (fillable-at-stake guarded) and the emitted row is tagged
    // with price_venue. Cohort stays v7 per the 2026-07-08 amendment.
    SIGNAL_VENUE_AWARE_ENABLED: (function() {
      const raw = s['signal_venue_aware_enabled'];
      if (raw == null) return _d('signal_venue_aware_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    BAT_DFLT_START: num('bat_dflt_start', 0.315),
    BAT_DFLT_OPP:   num('bat_dflt_opp',  0.320),
    UNKNOWN_PITCHER_WOBA: num('unknown_pitcher_woba', 0.335),
    PA_WEIGHTS:        (function(){
      var raw = s['pa_weights'] || '[4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7]';
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 9 && parsed.every(function(x){return typeof x === 'number' && !isNaN(x);})) return parsed;
      } catch(e) {}
      return [4.65,4.55,4.5,4.5,4.25,4.13,4,3.85,3.7];
    })(),
    WP_CLAMP_LO:       num('wp_clamp_lo',       _d('wp_clamp_lo', 0.25)),
    WP_CLAMP_HI:       num('wp_clamp_hi',       _d('wp_clamp_hi', 0.75)),
    TOT_PROB_LO:       num('tot_prob_lo',       _d('tot_prob_lo', 0.20)),
    TOT_PROB_HI:       num('tot_prob_hi',       _d('tot_prob_hi', 0.80)),
    MARKET_TOTAL_DFLT: num('market_total_dflt', _d('market_total_dflt', 8.5)),
    BAT_DFLT_R_VS_RHP: num('bat_dflt_r_vs_rhp', 0.305),
    BAT_DFLT_R_VS_LHP: num('bat_dflt_r_vs_lhp', 0.325),
    BAT_DFLT_L_VS_RHP: num('bat_dflt_l_vs_rhp', 0.330),
    BAT_DFLT_L_VS_LHP: num('bat_dflt_l_vs_lhp', 0.290),
    BAT_DFLT_S_VS_RHP: num('bat_dflt_s_vs_rhp', 0.322),
    BAT_DFLT_S_VS_LHP: num('bat_dflt_s_vs_lhp', 0.308),
    PIT_DFLT_R_VS_LHB: num('pit_dflt_r_vs_lhb', 0.320),
    PIT_DFLT_R_VS_RHB: num('pit_dflt_r_vs_rhb', 0.295),
    PIT_DFLT_L_VS_LHB: num('pit_dflt_l_vs_lhb', 0.285),
    PIT_DFLT_L_VS_RHB: num('pit_dflt_l_vs_rhb', 0.330),
    // Phase 2 opener-aware weights + flag. The flag is stored as TEXT
    // in app_settings (the table is TEXT-only) so we coerce to a real
    // boolean here; processGameSignals then routes signals to whichever
    // model output the flag selects.
    OPENER_PIT_WEIGHT:        num('opener_pit_weight',         _d('opener_pit_weight', 0.15)),
    BULK_PIT_WEIGHT:          num('bulk_pit_weight',           _d('bulk_pit_weight', 0.60)),
    OPENER_RELIEF_PIT_WEIGHT: num('opener_relief_pit_weight',  _d('opener_relief_pit_weight', 0.25)),
    QUICK_HOOK_FACTOR:        num('quick_hook_factor',         _d('quick_hook_factor', 0.90)),
    USE_OPENER_LOGIC: (function() {
      const raw = s['use_opener_logic'];
      if (raw == null) return _d('use_opener_logic', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    // Catcher framing run-environment adjustment. Previously NOT surfaced
    // here, which left settings.CATCHER_FRAMING_ENABLED undefined — the
    // feature could never actually activate. Now wired so flipping the
    // setting takes effect. Boolean coerced from TEXT like USE_OPENER_LOGIC.
    CATCHER_FRAMING_ENABLED: (function() {
      const raw = s['catcher_framing_enabled'];
      if (raw == null) return _d('catcher_framing_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    CATCHER_FRAMING_MUTE:             num('catcher_framing_mute',             _d('catcher_framing_mute', 0.5)),
    CATCHER_FRAMING_ABS_FACTOR:       num('catcher_framing_abs_factor',       _d('catcher_framing_abs_factor', 0.80)),
    CATCHER_FRAMING_MIN_PITCHES_2026: num('catcher_framing_min_pitches_2026', _d('catcher_framing_min_pitches_2026', 750)),
    CATCHER_FRAMING_TAKES_PER_GAME:   num('catcher_framing_takes_per_game',   _d('catcher_framing_takes_per_game', 58)),
    // Defensive impact (Build B). Same dormant-until-enabled pattern as framing.
    DEFENSE_FRV_ENABLED: (function() {
      const raw = s['defense_frv_enabled'];
      if (raw == null) return _d('defense_frv_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    DEFENSE_FRV_MUTE:          num('defense_frv_mute',          _d('defense_frv_mute', 0.5)),
    DEFENSE_FRV_OPPS_PER_GAME: num('defense_frv_opps_per_game', _d('defense_frv_opps_per_game', 25)),
    // Park-neutralize wOBA inputs (feat/park-neutral-inputs). Boolean;
    // TEXT-coerced same as CATCHER_FRAMING_ENABLED / USE_OPENER_LOGIC.
    // Default false → model.js get*Woba lookups return raw wOBA as
    // before (byte-identical regression path).
    PARK_NEUTRAL_INPUTS_ENABLED: (function() {
      const raw = s['park_neutral_inputs_enabled'];
      if (raw == null) return _d('park_neutral_inputs_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    // Edge-sanity cap (feat/edge-sanity-cap). Master toggle + soft/hard
    // thresholds. Default OFF preserves byte-identical emission.
    SIGNAL_EDGE_CAP_ENABLED: (function() {
      const raw = s['signal_edge_cap_enabled'];
      if (raw == null) return _d('signal_edge_cap_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    SIGNAL_EDGE_SOFT_CAP_PP: num('signal_edge_soft_cap_pp', _d('signal_edge_soft_cap_pp', 0.10)),
    SIGNAL_EDGE_HARD_CAP_PP: num('signal_edge_hard_cap_pp', _d('signal_edge_hard_cap_pp', 0.25)),
    // Starting-pitcher source precedence (services/jobs.js runLineupJob).
    // Default TRUE — RotoWire wins on conflict. Reversible via this flag
    // without a redeploy. See settings-schema.js for the full rationale.
    SP_PREFER_ROTOWIRE: (function() {
      const raw = s['sp_prefer_rotowire'];
      if (raw == null) return _d('sp_prefer_rotowire', true);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    // Kalshi-direct ML override (services/jobs.js runOddsJob). Same dormant
    // pattern: default off, no effect until flipped.
    KALSHI_DIRECT_PRIMARY_ENABLED: (function() {
      const raw = s['kalshi_direct_primary_enabled'];
      if (raw == null) return _d('kalshi_direct_primary_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    // Kalshi-direct totals override. Independent flag — totals can be on
    // while ML is off or vice versa.
    KALSHI_DIRECT_TOTALS_ENABLED: (function() {
      const raw = s['kalshi_direct_totals_enabled'];
      if (raw == null) return _d('kalshi_direct_totals_enabled', false);
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    })(),
    odds_api_key: s['odds_api_key'] || null,
  };
}

function getWobaIndex() {
  const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
  return _buildIdxFromRows(rows);
}

// Date-accurate index for backtests: build from the latest daily snapshot
// on or before `date`. Falls back to the live index when no snapshot
// covers the date (e.g. dates before snapshotting was deployed). Same
// override-application as getWobaIndex so backtests and live scoring
// treat pitcher_woba_override entries identically.
function getWobaIndexAsOf(date) {
  if (!date) return getWobaIndex();
  let snapDate = null;
  try {
    const r = q.getSnapshotDateAsOf.get(date);
    snapDate = r && r.d ? r.d : null;
  } catch (e) { /* table may not exist on very old DBs */ }
  if (!snapDate) return getWobaIndex();  // no snapshot coverage → live index
  const rows = q.loadSnapshotRows.all(snapDate);
  if (!rows.length) return getWobaIndex();
  return _buildIdxFromRows(rows);
}

// Shared index builder: rows → { data_key: { normName: {woba, sample} } }
// with pitcher_woba_override entries overlaid on the projection keys.
function _buildIdxFromRows(rows) {
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
  }
  try {
    const overrides = q.listWobaOverrides ? q.listWobaOverrides.all() : [];
    for (const o of overrides) {
      const key = o.vs_hand === 'L' ? 'pit-proj-lhb' : 'pit-proj-rhb';
      if (!idx[key]) idx[key] = {};
      const nameKey = normName(o.player_name);
      idx[key][nameKey] = { woba: o.woba, sample: 600 };
      for (const existing of Object.keys(idx[key])) {
        if (existing.startsWith(nameKey + ' ')) {
          idx[key][existing] = { woba: o.woba, sample: 600 };
        }
      }
    }
  } catch (e) {
    console.warn('[woba-override] apply failed (non-fatal): ' + e.message);
  }
  return idx;
}

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

// Sanity-check a game's two-outcome moneyline pair. Returns a reason string
// when the lines look wrong, or null when they look sane. Two classes of
// failure:
//   - impossible:  same-sign pair (both favorites or both dogs)
//   - suspicious:  either side's implied probability exceeds 0.80
//                  (≈ -400 or worse — real but very rare, often a data bug)
// Missing or zero lines skip the check entirely.
function checkOddsSanity(awayML, homeML) {
  const a = parseFloat(awayML), h = parseFloat(homeML);
  if (isNaN(a) || isNaN(h) || a === 0 || h === 0) return null;
  const impP = x => x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
  const pa = impP(a), ph = impP(h);
  if (pa > 0.80) return 'extreme line: away at ' + (a > 0 ? '+' + a : a) + ' (implied p=' + pa.toFixed(3) + ')';
  if (ph > 0.80) return 'extreme line: home at ' + (h > 0 ? '+' + h : h) + ' (implied p=' + ph.toFixed(3) + ')';
  return null;
}

// Flag when the primary ML source (typically Kalshi) disagrees sharply with
// the secondary cross-check book (typically Polymarket). Two escalating
// checks:
//   1) Hard disagreement: the two books pick different favorites — almost
//      always a bad primary price, regardless of magnitude.
//   2) Soft disagreement: same favorite but implied probability differs by
//      more than 8 cents.
// xcheckSrc is the cross-check book name (e.g. 'polymarket') used only in
// the error message so flags are self-describing. Returns null if either
// side's four prices is missing.
function checkBookDivergence(awayML, homeML, xcheckAwayML, xcheckHomeML, xcheckSrc) {
  const a = parseFloat(awayML), h = parseFloat(homeML);
  const ca = parseFloat(xcheckAwayML), ch = parseFloat(xcheckHomeML);
  if (isNaN(a) || isNaN(h) || isNaN(ca) || isNaN(ch)) return null;
  if (a === 0 || h === 0 || ca === 0 || ch === 0) return null;
  const xcheckLabel = xcheckSrc || 'xcheck';
  const impP = x => x < 0 ? Math.abs(x) / (Math.abs(x) + 100) : 100 / (x + 100);
  const pa = impP(a), ph = impP(h), pca = impP(ca), pch = impP(ch);
  // In American odds, lower number = bigger favorite (e.g. -150 < +130).
  const kalFav = a < h ? 'away' : 'home';
  const xcheckFav = ca < ch ? 'away' : 'home';
  if (kalFav !== xcheckFav) {
    const xcheckFavImpP = xcheckFav === 'away' ? pca : pch;
    // Pick-em games (xcheck fav < ~-115 implied) flip favorites naturally
    // between books — ignore disagreement in that noise zone.
    if (xcheckFavImpP <= 0.535) return null;
    const kalFavML = kalFav === 'away' ? a : h;
    const xcheckFavML = xcheckFav === 'away' ? ca : ch;
    return 'Kalshi vs ' + xcheckLabel + ' disagree on favorite: Kalshi favors ' + kalFav +
           ' (' + (kalFavML > 0 ? '+' + kalFavML : kalFavML) + ') ' + xcheckLabel + ' favors ' +
           xcheckFav + ' (' + (xcheckFavML > 0 ? '+' + xcheckFavML : xcheckFavML) + ')';
  }
  const kalFavImpP = kalFav === 'away' ? pa : ph;
  const xcheckFavImpP = xcheckFav === 'away' ? pca : pch;
  const diff = Math.abs(kalFavImpP - xcheckFavImpP);
  if (diff > 0.08) {
    return 'Kalshi vs ' + xcheckLabel + ' divergence: Kalshi=' + awayML + '/' + homeML +
           ' ' + xcheckLabel + '=' + xcheckAwayML + '/' + xcheckHomeML +
           ' (fav Δp=' + diff.toFixed(3) + ')';
  }
  return null;
}

/**
 * BET_SIGNALS FIELD SEMANTICS
 *
 * signal_type: 'ML' | 'Total'
 * signal_side: 'away' | 'home' for ML, 'over' | 'under' for Total
 * signal_label: '1★' | '2★' | '3★'
 * category: 'Nstar-fav' | 'Nstar-dog' | 'Nstar-over' | 'Nstar-under' | '0star-...'
 *
 * market_line: the price USED IN EDGE CALC.
 *   For ML: that side's American moneyline at primary venue.
 *   For Total: the total runs line at primary venue (not the price).
 *   PR #25: this is always the primary venue value, never xcheck.
 *
 * model_line: the model's "fair" value for that side.
 *   For ML: model_away_ml or model_home_ml (American odds).
 *   For Total: model_total (runs).
 *
 * edge_pct: percentage-point gap between implied probability of market_line
 *   and model_line. Threshold for 1★/2★/3★ comes from settings
 *   (ml_lean_edge, tot_lean_edge, etc.).
 *
 * bet_line: NULL until user locks via /api/signals/:id/bet-line.
 *   The price the user actually got. May differ from market_line if line
 *   moved between signal generation and lock.
 *
 * bet_locked_at: timestamp of lock (NULL if not locked).
 *
 * closing_line: market_line at game start, written by closing-lock cron.
 *
 * clv: implied-probability percentage points. Positive = market moved your
 *   way after lock. PR #31: handles cross-side scenarios (lock dog → close
 *   fav etc.) via implied-prob math. ML signals only — Total signals stay
 *   clv=NULL.
 *
 * outcome: 'pending' | 'win' | 'loss' | 'push' | 'void'
 *   Set by score-grading job after game finals.
 *
 * pnl: $ on $100 stake. Computed at grading using bet_line if set, else
 *   market_line.
 *
 * cohort: 'v1' | 'v2-tainted' | 'v3-pretuning' | 'v3-tainted' | 'v3'
 *   v3 starts 2026-04-24 (PR #33). Prior model versions and tainted periods
 *   preserved for historical reference, excluded from default 'v3 (current)'
 *   Backtest filter.
 *
 * is_active: 1 = currently emitting signal; 0 = deactivated (model no longer
 *   recommends this side, but bet_line was already locked so row is preserved
 *   for grading + audit). PR #34: every is_active transition is recorded in
 *   bet_signal_audit.
 *
 * notes: free-form deactivation reason or manual annotation.
 */
function processGameSignals(gameRow, wobaIdx, settings, opts) {
  // opts.venueRowsByGid: optional map { [game_id]: comparisonRow } from
  // services/odds-comparison.js runComparison, prefetched slate-wide so
  // per-game processing stays synchronous. When SIGNAL_VENUE_AWARE_ENABLED
  // is on and this map is absent (or has no entry for this game_id, or
  // both venues failed the fillable-at-stake guard), the market baseline
  // falls back to gameRow.market_* (Kalshi-direct) and the emitted row is
  // marked venue_stale=1 so the fallback is visible downstream.
  // Lazy-fetch fallback: 5 of 6 callers of processGameSignals don't
  // pre-fetch the slate (only runLineupJob does), so relying on opts alone
  // caused a ping-pong bug where refreshSignalBaselines wrote tier-1 (from
  // its own live fetch) and the next processGameSignals pass wrote tier-3
  // (no venue), flipping the row back and forth on each cron cycle. The
  // block below tries opts.venueRowsByGid first, then peeks the
  // runComparisonCached shared cache synchronously (60s TTL), then falls
  // back to the per-game venue_comparison_snapshot via
  // _loadFreshSnapshotForGid — same tier discipline that
  // refreshSignalBaselines uses. Result: all 5 callers get tier-1 without
  // having to thread venue data through 5 call sites by hand.
  let _venueRows = (opts && opts.venueRowsByGid) || null;
  // Per-team bullpen wOBA from pit-act data
  const awayParts = (gameRow.game_id||'').split('-');
  const awayAbbr = awayParts[0]||'';
  const homeAbbr = awayParts[1]||'';
  const awaySpName = gameRow.away_pitcher||'';
  const homeSpName = gameRow.home_pitcher||'';
  const _wProj = (settings && settings.W_PROJ != null) ? parseFloat(settings.W_PROJ) : 0.65;
  const _wAct = (settings && settings.W_ACT != null) ? parseFloat(settings.W_ACT) : 0.35;
  const _bpStrongR = (settings && settings.BP_STRONG_WEIGHT_R != null) ? parseFloat(settings.BP_STRONG_WEIGHT_R) : 0.55;
  const _bpWeakR   = (settings && settings.BP_WEAK_WEIGHT_R   != null) ? parseFloat(settings.BP_WEAK_WEIGHT_R)   : 0.45;
  const _bpStrongL = (settings && settings.BP_STRONG_WEIGHT_L != null) ? parseFloat(settings.BP_STRONG_WEIGHT_L) : 0.35;
  const _bpWeakL   = (settings && settings.BP_WEAK_WEIGHT_L   != null) ? parseFloat(settings.BP_WEAK_WEIGHT_L)   : 0.65;
  const _unknownWoba = (settings && settings.UNKNOWN_PITCHER_WOBA != null) ? parseFloat(settings.UNKNOWN_PITCHER_WOBA) : 0.335;
  // bullpen path uses its own BF gate — RPs rarely reach the SP-facing MIN_BF=100
  // vs a single handedness in a season, so a shared gate forced the bullpen
  // path onto pure Steamer for the majority of pool RPs. Fresh key
  // BULLPEN_MIN_BF (default 50 in schema) unblocks the actuals blend. Falls
  // back to MIN_BF for legacy DBs where the new row hasn't been seeded.
  const _minBF = (settings && settings.MIN_BF != null) ? parseFloat(settings.MIN_BF) : 100;
  const _bullpenMinBF = (settings && settings.BULLPEN_MIN_BF != null) ? parseFloat(settings.BULLPEN_MIN_BF) : _minBF;
  const _downweightStarters = !!(settings && (settings.BULLPEN_DOWNWEIGHT_STARTERS === true || settings.BULLPEN_DOWNWEIGHT_STARTERS === 'true'));
  // Bullpen-specific blend override. Fall back to the global W_PROJ/W_ACT
  // when the settings row is missing so legacy DBs are byte-identical.
  const _bullpenWProj = (settings && settings.BULLPEN_W_PROJ != null) ? parseFloat(settings.BULLPEN_W_PROJ) : _wProj;
  const _bullpenWAct  = (settings && settings.BULLPEN_W_ACT  != null) ? parseFloat(settings.BULLPEN_W_ACT)  : _wAct;
  const LEAGUE_BP = 0.318;
  let awayBpVsR = LEAGUE_BP, awayBpVsL = LEAGUE_BP;
  let homeBpVsR = LEAGUE_BP, homeBpVsL = LEAGUE_BP;
  let awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      const homeLineupArr = tryParse(gameRow.home_lineup_json) || [];
      const awayLineupArr = tryParse(gameRow.away_lineup_json) || [];
      const awayBp = q.getBullpenWobaBlended(awayAbbr, awaySpName, homeLineupArr, _bpStrongR, _bpWeakR, _bpStrongL, _bpWeakL, _wProj, _wAct, gameRow.game_date, _unknownWoba, _bullpenMinBF, _downweightStarters, _bullpenWProj, _bullpenWAct);
      const homeBp = q.getBullpenWobaBlended(homeAbbr, homeSpName, awayLineupArr, _bpStrongR, _bpWeakR, _bpStrongL, _bpWeakL, _wProj, _wAct, gameRow.game_date, _unknownWoba, _bullpenMinBF, _downweightStarters, _bullpenWProj, _bullpenWAct);
      if (awayBp?.vsRHB) awayBpVsR = awayBp.vsRHB;
      if (awayBp?.vsLHB) awayBpVsL = awayBp.vsLHB;
      if (homeBp?.vsRHB) homeBpVsR = homeBp.vsRHB;
      if (homeBp?.vsLHB) homeBpVsL = homeBp.vsLHB;
      awayBpWoba = awayBp?.woba || LEAGUE_BP;
      homeBpWoba = homeBp?.woba || LEAGUE_BP;
    }
  } catch(e) { /* fallback to league avg */ }
  // Catcher framing (per-game run value). Extract each side's catcher
  // from the lineup (pos==='C'), bridge name→mlb_id→rv_tot through
  // team_rosters + catcher_framing, convert cumulative season runs to a
  // per-game rate (≈145 pitches/game). Null when: no catcher in lineup,
  // no roster/framing row, or the table is empty (ingest not built yet).
  // runModel applies these only when CATCHER_FRAMING_ENABLED and a value
  // is present — null is a clean no-op.
  let awayCatcherFramingRvPerGame = null, homeCatcherFramingRvPerGame = null;
  // Per-side catcher inputs persisted for the Matchups display
  // (feat/matchups-framing-impact). Names from the lineup; state code
  // mirrors the silent-no-op branches below so the UI can render
  // honest empty states ('lineup pending', 'no framing data') instead
  // of a misleading 0.
  let awayCatcherName = null, homeCatcherName = null;
  let awayCatcherFramingState = null, homeCatcherFramingState = null;
  try {
    if (q.getCatcherFramingById && q.getPositionPlayers) {
      const findCatcher = (lu) => {
        const arr = tryParse(lu) || [];
        if (!arr.length) return null;                 // no lineup posted → silent
        const c = arr.find(p => (p.pos || '').toUpperCase() === 'C');
        return c ? c.name : '';                        // '' = lineup present but no C
      };
      const framingEnabled = !!(settings && settings.CATCHER_FRAMING_ENABLED);
      const absFactor = (settings && settings.CATCHER_FRAMING_ABS_FACTOR != null)
        ? Number(settings.CATCHER_FRAMING_ABS_FACTOR) : 0.80;
      const min2026 = (settings && settings.CATCHER_FRAMING_MIN_PITCHES_2026 != null)
        ? Number(settings.CATCHER_FRAMING_MIN_PITCHES_2026) : 750;
      // Leaguewide shadow-zone called takes per full team-game (~58). This
      // is the framing-relevant pitch count a STARTING catcher receives in
      // a complete game — an environmental constant (property of the
      // pitching/umpiring mix), NOT a per-catcher estimate.
      const takesPerGame = (settings && settings.CATCHER_FRAMING_TAKES_PER_GAME != null)
        ? Number(settings.CATCHER_FRAMING_TAKES_PER_GAME) : 58;
      // Per-game framing runs = per-pitch rate × takes/game. Both rv_tot and
      // pitches are real Statcast counts (pitches = framing-relevant shadow
      // takes), so the rate needs no estimate. Per-pitch normalization is
      // immune to the defensive-replacement / partial-game problem: a
      // catcher's rate is computed from his actual takes regardless of how
      // they were distributed across full vs partial games. We then project
      // tonight's STARTING catcher to a full game's worth of takes.
      const rate = (rvTot, pitches) => {
        if (!pitches || pitches <= 0) return null;
        return (rvTot / pitches) * takesPerGame;
      };
      // Returns { rv, state }. state ∈ enum documented in
      // db/schema.js's catcher_framing_state column. rv is the raw
      // per-game value before MUTE/ENABLED gating — model.js's
      // applyCatcherFramingDelta does the gating.
      const perGame = (team, catcherName) => {
        if (catcherName === null) return { rv: null, state: 'no_lineup' };
        if (catcherName === '') {
          if (framingEnabled) console.warn('[framing] ' + gameRow.game_id + ' ' + team
            + ': lineup has no catcher (pos=C) — no framing applied');
          return { rv: null, state: 'no_catcher' };
        }
        // Abbreviated lineup name ("A. Martinez") → mlb_id via roster
        // (accent-folded last+initial) → framing row.
        const mlbId = resolveCatcherMlbId(team, catcherName);
        if (!mlbId) {
          if (framingEnabled) console.warn('[framing] ' + gameRow.game_id + ' ' + team
            + ': catcher "' + catcherName + '" did not resolve to a roster mlb_id — no framing applied (check roster / name format)');
          return { rv: null, state: 'no_roster_match' };
        }
        // Primary: current-season (2026) framing, used as-is (already
        // post-ABS). Only trusted when it clears the min-pitches floor —
        // a 200-pitch 2026 sample is noisier than a 3-year baseline.
        const row = q.getCatcherFramingById.get(mlbId);
        if (row && row.pitches >= min2026) {
          return { rv: rate(row.rv_tot, row.pitches), state: 'applied' };
        }
        // Fallback: 2023-2025 historical baseline, scaled by absFactor to
        // express pre-ABS values in 2026-equivalent units. Applies when the
        // 2026 row is missing entirely OR below the min-pitches floor.
        if (q.getCatcherFramingHistById) {
          const h = q.getCatcherFramingHistById.get(mlbId);
          if (h && h.pitches > 0) {
            const r = rate(h.rv_tot, h.pitches);
            if (r != null) {
              if (framingEnabled) console.warn('[framing] ' + gameRow.game_id + ' ' + team
                + ': catcher "' + catcherName + '" (id ' + mlbId + ') low/no 2026 sample — using 2023-25 baseline ×' + absFactor);
              return { rv: r * absFactor, state: 'applied' };
            }
          }
        }
        if (framingEnabled) console.warn('[framing] ' + gameRow.game_id + ' ' + team
          + ': catcher "' + catcherName + '" (id ' + mlbId + ') has no 2026 or historical framing row — no framing applied');
        return { rv: null, state: 'no_framing_data' };
      };
      const awayC = findCatcher(gameRow.away_lineup_json);
      const homeC = findCatcher(gameRow.home_lineup_json);
      awayCatcherName = awayC || null;   // '' becomes null for display (no_catcher state still set)
      homeCatcherName = homeC || null;
      const awayRes = perGame(awayAbbr, awayC);
      const homeRes = perGame(homeAbbr, homeC);
      awayCatcherFramingRvPerGame = awayRes.rv;
      homeCatcherFramingRvPerGame = homeRes.rv;
      awayCatcherFramingState = awayRes.state;
      homeCatcherFramingState = homeRes.state;
    }
  } catch (e) { /* missing table / ingest not built → null, no-op */ }
  // Defensive impact (Build B): team fielding run value, summed over the 7
  // non-catcher position players in the lineup. Catcher defense is handled
  // by the framing feature; DH and pitcher fielding are excluded. Each
  // fielder's per-game value = total_runs / outs_total × opps_per_game
  // (per-opportunity rate scaled to a full game's ~25 opportunities, immune
  // to partial-game distortion). Null when no fielders resolve (ingest not
  // built / lineup not posted) → clean no-op.
  let awayFieldingRunsPerGame = null, homeFieldingRunsPerGame = null;
  try {
    if (q.getFieldingFrvById && q.getPositionPlayers) {
      const FIELD_POS = new Set(['1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']);
      const defEnabled = !!(settings && settings.DEFENSE_FRV_ENABLED);
      const oppsPerGame = (settings && settings.DEFENSE_FRV_OPPS_PER_GAME != null)
        ? Number(settings.DEFENSE_FRV_OPPS_PER_GAME) : 25;
      const teamFielding = (team, lu) => {
        const arr = tryParse(lu) || [];
        if (!arr.length) return null;                 // no lineup → silent no-op
        let sum = 0, resolved = 0, fielders = 0;
        for (const p of arr) {
          const pos = (p.pos || '').toUpperCase();
          if (!FIELD_POS.has(pos)) continue;          // skip C, DH, P
          fielders++;
          const mlbId = resolveCatcherMlbId(team, p.name); // same name→id resolver
          if (!mlbId) {
            if (defEnabled) console.warn('[defense] ' + gameRow.game_id + ' ' + team
              + ': fielder "' + p.name + '" (' + pos + ') did not resolve to mlb_id');
            continue;
          }
          const row = q.getFieldingFrvById.get(mlbId);
          if (!row || !row.outs_total || row.outs_total <= 0) {
            if (defEnabled) console.warn('[defense] ' + gameRow.game_id + ' ' + team
              + ': fielder "' + p.name + '" (id ' + mlbId + ') no FRV row — no defensive value');
            continue;
          }
          sum += (row.total_runs / row.outs_total) * oppsPerGame;
          resolved++;
        }
        // Only return a value if we resolved at least one fielder. Partial
        // resolution (e.g. 5 of 7) returns the partial sum — better than
        // discarding signal, and warnings above flag the misses.
        return resolved > 0 ? sum : null;
      };
      awayFieldingRunsPerGame = teamFielding(awayAbbr, gameRow.away_lineup_json);
      homeFieldingRunsPerGame = teamFielding(homeAbbr, gameRow.home_lineup_json);
    }
  } catch (e) { /* missing table / ingest not built → null, no-op */ }
  // Projected IP/start for each SP, drives the dynamic SP/RP split in runModel.
  // Null when no projection row exists — runModel falls back to flat SP weight.
  // NOTE: existing bullpen code at line ~86 reads gameRow.away_pitcher which
  // isn't a real column; the canonical column is away_sp. Using away_sp here
  // (with away_pitcher fallback) so projIP lookup actually finds something.
  var awaySpLookupName = gameRow.away_sp || gameRow.away_pitcher || '';
  var homeSpLookupName = gameRow.home_sp || gameRow.home_pitcher || '';
  var awaySpProjIP = q.getPitcherProjIP ? q.getPitcherProjIP(awaySpLookupName) : null;
  var homeSpProjIP = q.getPitcherProjIP ? q.getPitcherProjIP(homeSpLookupName) : null;
  const game = {
    ...gameRow,
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    // Bullpen wOBA: away team's bullpen faces home batters, home team's bullpen faces away batters.
    // awayBullpenWoba/homeBullpenWoba feed the model; the per-side values stay for the debug report.
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayBpVsR, awayBullpenVsL: awayBpVsL,
    homeBullpenVsR: homeBpVsR, homeBullpenVsL: homeBpVsL,
    // Starter projected IP (null when no projection uploaded)
    awaySpProjIP: awaySpProjIP, homeSpProjIP: homeSpProjIP,
    // Catcher framing per-game run value (null when ingest not built,
    // no catcher in lineup, or no framing row). Applied in runModel only
    // when CATCHER_FRAMING_ENABLED.
    awayCatcherFramingRvPerGame: awayCatcherFramingRvPerGame,
    homeCatcherFramingRvPerGame: homeCatcherFramingRvPerGame,
    // Team defensive run value (sum of 7 non-catcher fielders' per-game FRV);
    // null when ingest not built / no fielders resolved. Applied in runModel
    // only when DEFENSE_FRV_ENABLED.
    awayFieldingRunsPerGame: awayFieldingRunsPerGame,
    homeFieldingRunsPerGame: homeFieldingRunsPerGame,
  };
  // Venue-aware market baseline override (feat/venue-aware-signals). When
  // SIGNAL_VENUE_AWARE_ENABLED is on AND the caller pre-fetched the venue
  // comparison slate for this date, override game.market_{away,home}_ml on
  // the object handed to runModel with the winner's net_american per side.
  // Fillable-at-stake guard inside _pickBestML rejects partial fills. On
  // unavailable / non-fillable → falls back to Kalshi-direct market_line
  // (gameRow.market_*) and marks _venueStaleFlag so bet_signals.venue_stale
  // records the fallback.
  const _venueAware = !!(settings && settings.SIGNAL_VENUE_AWARE_ENABLED);
  let _venueByMarket = { ml_away: null, ml_home: null }; // filled in when override applies
  let _venueStaleFlag = _venueAware; // start true; cleared once a valid override lands
  let _venueServedFromSnapshot = false; // audit flag when tier-1 came from snapshot
  if (_venueAware) {
    // Tier discipline (mirrors refreshSignalBaselines):
    //   (a) prefetched opts.venueRowsByGid (only runLineupJob provides this)
    //   (b) sync peek of runComparisonCached (60s TTL, shared with jobs+route)
    //   (c) per-game venue_comparison_snapshot ≤30 min old
    // Any of (a)/(b)/(c) → venue_stale=0. None → fall through to
    // Kalshi-direct with venue_stale=1 (tier-3).
    if (!_venueRows) {
      try {
        const { peekCachedRowsByGid } = require('./odds-comparison');
        if (typeof peekCachedRowsByGid === 'function') {
          _venueRows = peekCachedRowsByGid(gameRow.game_date) || null;
        }
      } catch (e) { /* module missing → stay null, fall to snapshot */ }
    }
    let rowForGame = _venueRows && _venueRows[gameRow.game_id];
    if (!rowForGame) {
      const snap = _loadFreshSnapshotForGid(gameRow.game_date, gameRow.game_id);
      if (snap) { rowForGame = snap; _venueServedFromSnapshot = true; }
    }
    if (rowForGame) {
      const bestA = _pickBestML(rowForGame, 'away');
      const bestH = _pickBestML(rowForGame, 'home');
      if (bestA) { game.market_away_ml = bestA.ml; _venueByMarket.ml_away = bestA.venue; _venueStaleFlag = false; }
      if (bestH) { game.market_home_ml = bestH.ml; _venueByMarket.ml_home = bestH.venue; _venueStaleFlag = false; }
    }
  }
  const stdModel = runModel(game, wobaIdx, settings, 'standard');
  // Phase 2 shadow: compute the opener-aware model whenever a side is
  // opener-led, regardless of the use_opener_logic flag. Persisted into
  // opener_model_* alongside the standard model_* so we can compare
  // outputs side-by-side for ≥1 week before flipping the flag.
  //
  // The bulk_guy_* requirement was dropped here so the bullpen_game
  // branch in model.buildOpenerOpts also runs through opener_aware
  // mode — a side flagged is_opener_game with NO bulk man (true
  // bullpen day) was previously falling through to the standard 75/25
  // SP/RP path because hasOpenerSide gated on bulk_guy. Now any
  // opener-flagged side gets opener_model_* written; the model picks
  // the right branch (3-way 'opener' or collapsed 'bullpen_game') via
  // game_type.
  const hasOpenerSide = (game.is_opener_game_away === 1)
                     || (game.is_opener_game_home === 1);
  const openerModel = hasOpenerSide
    ? runModel(game, wobaIdx, settings, 'opener_aware')
    : null;
  const useOpenerLogic = settings && settings.USE_OPENER_LOGIC === true;
  // Pick which model output feeds getSignals. Standard is the default;
  // when the flag is on AND a non-suppressed opener-aware result exists,
  // signals fire off opener-aware instead.
  const model = (useOpenerLogic && openerModel && !openerModel._suppressed)
    ? openerModel
    : stdModel;
  // Empty/partial lineups → runModel returned a sentinel. Skip ALL DB
  // writes downstream: model_* would be null (and .toFixed would throw),
  // and signals would crash on null marketLine math. Locked bet_lines
  // remain untouched in bet_signals — they survive by no-op. When the
  // lineup re-populates and processGameSignals runs again, the normal
  // path takes over and refreshes signals as usual.
  const suppressed = !!(model && model._suppressed);
  if (suppressed) {
    console.log('[model] Suppressed signals for ' + gameRow.game_id + ': ' + model._suppressed_detail);
  }
  if (hasOpenerSide && openerModel && !openerModel._suppressed && stdModel && !stdModel._suppressed) {
    console.log('[opener-model] ' + gameRow.game_id
      + ' std=' + stdModel.aML + '/' + stdModel.hML + '@' + stdModel.estTot.toFixed(2)
      + ' opener=' + openerModel.aML + '/' + openerModel.hML + '@' + openerModel.estTot.toFixed(2)
      + ' active=' + (useOpenerLogic ? 'opener' : 'std'));
  }
  // When suppressed, emit empty signals — the bet_signals lifecycle below
  // still runs (DELETE unlocked, deactivate locked-but-no-longer-qualifying)
  // so stale signals from a prior run get cleaned up. Locked bet_lines are
  // preserved by the existing locked-line restore loop.
  // outSuppressed collects signals removed by the edge-sanity hard cap
  // (feat/edge-sanity-cap). Always allocated; getSignals ignores it when
  // the cap is disabled. Written to bet_signal_audit after the emitted
  // signals loop so a burst of suppressions is queryable as an
  // input-breakage alarm.
  const outSuppressed = [];
  const signals = suppressed ? [] : getSignals(game, model, settings, outSuppressed);
  if (outSuppressed.length) {
    for (const sup of outSuppressed) {
      try {
        q.insertBetSignalAudit({
          signal_id: null,
          game_date: gameRow.game_date,
          game_id: gameRow.game_id,
          signal_type: sup.type,
          signal_side: sup.side,
          action: 'suppressed_edge_cap',
          bet_line: null,
          closing_line: null,
          clv: null,
          source: 'getSignals',
          detail: JSON.stringify({
            reason: sup.reason,
            edge: sup.edge,
            marketLine: sup.marketLine,
            modelLine: sup.modelLine,
            category: sup.category,
          }),
        });
      } catch (e) {
        // Non-critical — cap already suppressed; audit-log failure just
        // means we lose reviewability of this one suppression. Do not
        // block the signal-write path.
        console.warn('[edge-cap-audit] ' + gameRow.game_id + ': ' + e.message);
      }
    }
  }
  // If lineup is projected (not yet confirmed), save as proj_model snapshot.
  // Skip the model_* UPDATE entirely when suppressed (model values are null
  // and .toFixed would throw; we'd rather leave prior values than null them
  // out — the lineups_complete health check + the empty signals array
  // already communicate the suppression state to the UI).
  const isProjected = !gameRow.away_lineup_status || gameRow.away_lineup_status === 'projected';
  const hasProjSnapshot = gameRow.proj_model_away_ml != null;
  // model_* always stores the STANDARD model output regardless of which
  // model fed signals. Phase 2 stores opener-aware separately into
  // opener_model_* below. The flag only swaps which one drives signals,
  // not which writes to which column.
  if (!suppressed && isProjected) {
    // Lineup still projected — keep proj snapshot current
    db.prepare(`UPDATE game_log SET proj_model_away_ml=?, proj_model_home_ml=?, proj_model_total=?, model_away_ml=?, model_home_ml=?, model_total=?, proj_market_away_ml=COALESCE(proj_market_away_ml, ?), proj_market_home_ml=COALESCE(proj_market_home_ml, ?), proj_market_total=COALESCE(proj_market_total, ?), updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(stdModel.aML, stdModel.hML, parseFloat(stdModel.estTot.toFixed(2)), stdModel.aML, stdModel.hML, parseFloat(stdModel.estTot.toFixed(2)), gameRow.market_away_ml||null, gameRow.market_home_ml||null, gameRow.market_total||null, gameRow.game_date, gameRow.game_id);
  } else if (!suppressed) {
    // Confirmed lineup — proj snapshot is frozen, update current model only
    db.prepare(`UPDATE game_log SET model_away_ml=?, model_home_ml=?, model_total=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(stdModel.aML, stdModel.hML, parseFloat(stdModel.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);
  }
  // Phase 2 shadow persistence. Independent of model_* — fires whenever
  // the opener-aware run produced a non-suppressed output. Doesn't touch
  // any column other than opener_model_* + opener_model_computed_at.
  if (!suppressed && openerModel && !openerModel._suppressed) {
    db.prepare(`UPDATE game_log SET opener_model_away_ml=?, opener_model_home_ml=?, opener_model_total=?, opener_model_computed_at=datetime('now'), updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(openerModel.aML, openerModel.hML, parseFloat(openerModel.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);
  }
  // Bullpen wOBA persistence. Captures the values that fed runModel at this
  // signal-fire time, independent of suppression status (bullpen wOBA is
  // computed above at lines ~282-283 before suppression branches). Without
  // this persistence, the model can't be replayed on historical games at
  // new settings — woba_data is wiped+reloaded daily, so the inputs
  // disappear. May 2026 calibration analysis flagged this as the blocker
  // for any future settings-tuning backtest.
  try {
    db.prepare(`UPDATE game_log SET
      away_bullpen_woba=?, home_bullpen_woba=?,
      away_bullpen_woba_vs_l=?, away_bullpen_woba_vs_r=?,
      home_bullpen_woba_vs_l=?, home_bullpen_woba_vs_r=?
      WHERE game_date=? AND game_id=?`)
      .run(
        awayBpWoba, homeBpWoba,
        awayBpVsL, awayBpVsR,
        homeBpVsL, homeBpVsR,
        gameRow.game_date, gameRow.game_id
      );
  } catch (e) {
    // Non-critical — log and continue. Doesn't block signal firing.
    console.warn('[bullpen-persist] ' + gameRow.game_id + ': ' + e.message);
  }
  // Catcher-framing inputs (feat/matchups-framing-impact). Raw rv +
  // state code per side. Settings gating (MUTE × ENABLED) is applied
  // at READ time by the route via applyCatcherFramingDelta in
  // services/model.js — toggle flips take effect immediately without
  // requiring a rescore. Non-critical write — wrap try/catch so a
  // schema migration mid-deploy can't break signal firing.
  try {
    db.prepare(`UPDATE game_log SET
      away_catcher_name=?, home_catcher_name=?,
      away_catcher_framing_rv_per_game=?, home_catcher_framing_rv_per_game=?,
      away_catcher_framing_state=?, home_catcher_framing_state=?
      WHERE game_date=? AND game_id=?`)
      .run(
        awayCatcherName, homeCatcherName,
        awayCatcherFramingRvPerGame, homeCatcherFramingRvPerGame,
        awayCatcherFramingState, homeCatcherFramingState,
        gameRow.game_date, gameRow.game_id
      );
  } catch (e) {
    console.warn('[framing-persist] ' + gameRow.game_id + ': ' + e.message);
  }
  // PR 4 + PR B: persist the weights runModel actually used. SP weights
  // come from stdModel (standard non-opener path). Opener/bulk/bullpen
  // weights come from openerModel — they're the realized PA-weighted
  // totals from buildPerPositionWeights' renormalization, not raw
  // forecast-derived numbers. Null on standard games (no openerModel).
  // Gated on !suppressed because stdModel returns a partial-data object
  // when suppressed. Non-critical write — wrap in try/catch.
  if (!suppressed && stdModel) {
    try {
      const om = (openerModel && !openerModel._suppressed) ? openerModel : null;
      db.prepare(`UPDATE game_log SET
        away_sp_weight_used=?, home_sp_weight_used=?,
        away_bulk_weight_used=?, home_bulk_weight_used=?,
        away_opener_weight_used=?, home_opener_weight_used=?,
        away_bullpen_weight_used=?, home_bullpen_weight_used=?
        WHERE game_date=? AND game_id=?`)
        .run(
          stdModel.awaySpWeightUsed != null ? stdModel.awaySpWeightUsed : null,
          stdModel.homeSpWeightUsed != null ? stdModel.homeSpWeightUsed : null,
          om && om.awayBulkWeightUsed    != null ? om.awayBulkWeightUsed    : null,
          om && om.homeBulkWeightUsed    != null ? om.homeBulkWeightUsed    : null,
          om && om.awayOpenerWeightUsed  != null ? om.awayOpenerWeightUsed  : null,
          om && om.homeOpenerWeightUsed  != null ? om.homeOpenerWeightUsed  : null,
          om && om.awayBullpenWeightUsed != null ? om.awayBullpenWeightUsed : null,
          om && om.homeBullpenWeightUsed != null ? om.homeBullpenWeightUsed : null,
          gameRow.game_date, gameRow.game_id
        );
    } catch (e) {
      console.warn('[weight-persist] ' + gameRow.game_id + ': ' + e.message);
    }
  }
  const gl = q.getGameById.get(gameRow.game_date, gameRow.game_id);
  if (!gl) return;
  // Compute lineup content hash once; every signal emitted this pass
  // shares the same digest. Consumed by refreshSignalBaselines' guard.
  const _lineupHash = _computeLineupHash(gl);
  // Post-lock, pre-final freeze (fix/post-lock-immutability-guard, 2026-07-12).
  // Once game_log.odds_locked_at is set (T-10 pregame freeze OR game-start
  // catchup), bet_signals writes for that game are frozen per owner's
  // "one number pregame, freeze at T-10" ruling from PR #164/#228.
  //
  // Without this guard, later processGameSignals passes — any of the 6
  // caller sites — read gameRow.market_*_ml (also frozen; processOddsArray
  // skips locked rows correctly) but then run the venue-override block
  // against LIVE runComparisonCached data. In-play Poly/Kalshi books can
  // have very thin ladders where a $100 stake walks past top-of-book to
  // avg_price=0.22, producing net_american=+355 for a game whose true
  // pregame line was +113. The UPSERT then stomps market_line with the
  // in-play value. 34 historical rows corrupted this way since April;
  // closing_line was clean on all of them (captured by cron_closing_lock
  // at odds_locked_at time, from the frozen pre-lock game_log price).
  //
  // closing_line + clv still flow via cron_closing_lock (a separate path
  // that fires at lock time, once). outcome + pnl still flow via the
  // graded-game branch above (which runs when gl.away_score != null).
  // See docs/post-lock-immutability-2026-07-12.md.
  if (gl.odds_locked_at && gl.away_score == null) return;
  // If game is already final (scored), freeze all signals — don't rewrite
  if (gl.away_score != null) {
    // Just grade any ungraded signals and return — never wipe a completed game's signals
    const existing = db.prepare('SELECT * FROM bet_signals WHERE game_date=? AND game_id=?').all(gameRow.game_date, gameRow.game_id);
    const updateSig = db.prepare('UPDATE bet_signals SET outcome=?, pnl=? WHERE id=?');
    // Step 2 runline companion: ML signals get a parallel grading
    // pass on the captured spread snapshot. Total signals leave
    // companion_spread_* null. Only fires when companion_spread_outcome
    // is currently NULL (un-graded) — same "don't rewrite a graded
    // signal" guard as the ML grading above.
    const updateRunline = db.prepare('UPDATE bet_signals SET companion_spread_outcome=?, companion_spread_pnl=? WHERE id=?');
    for (const ex of existing) {
      if (ex.outcome !== 'pending') continue;
      const { outcome, pnl } = calcPnl(
        {type:ex.signal_type, side:ex.signal_side, marketLine:ex.market_line},
        gl.away_score, gl.home_score, gl.market_total, gl.over_price, gl.under_price
      );
      if (outcome !== 'pending') updateSig.run(outcome, pnl, ex.id);
    }
    // Independent loop for runline grading — only ML signals participate,
    // and we re-check companion_spread_outcome separately so a row whose
    // ML grading already landed in a prior pass can still pick up its
    // runline grade now that this PR's columns exist.
    for (const ex of existing) {
      if (ex.signal_type !== 'ML') continue;
      if (ex.companion_spread_outcome != null && ex.companion_spread_outcome !== 'pending') continue;
      const r = calcRunlinePnl(ex.signal_side, ex.companion_spread_line, ex.companion_spread_price, gl.away_score, gl.home_score);
      if (r.outcome !== 'pending') updateRunline.run(r.outcome, r.pnl, ex.id);
    }
    // Empirical-spread grading. Piggy-backs on the same "game is
    // final" entry point as the bet_signals grading above. Extracted
    // to empiricalSpreadEdge.gradeEmpiricalSpreadOutcomesForGame so
    // the same function is shared with runScoreJob (the 4AM PT score
    // cron that lands when games go final — the path that ACTUALLY
    // fires under cron) and the backfill admin endpoint. See the
    // header comment on that function for the truth table, the
    // dual-track guarantee (SELECT does not filter by capture_track),
    // and the price-freeze rationale.
    try {
      const gradedAt = nowPtIso();
      empiricalSpreadEdge.gradeEmpiricalSpreadOutcomesForGame(db, q, gl, gradedAt);
      // Market capture grading (ML + totals) shares the same entry
      // point as the spread grader so no path can grade one market
      // type without the others. Idempotent — only rows with
      // outcome IS NULL are touched.
      try {
        const empMc = require('./empirical-market-capture');
        empMc.gradeMarketCapturesForGame(db, q, gl, gradedAt);
      } catch (mErr) {
        console.warn('[empirical-market] grading failed for ' + gameRow.game_id
          + ' (non-fatal): ' + (mErr && mErr.message));
      }
    } catch (gerr) {
      console.warn('[empirical-spreads] grading failed for ' + gameRow.game_id
        + ' (non-fatal): ' + gerr.message);
    }
    return;
  }

  // UPSERT lifecycle (feat/upsert-signal-refresh, 2026-07-08). Replaces
  // the DELETE-unlocked + INSERT-fresh + restore-locks + dedupe dance
  // with per-tuple UPSERTs. Ownership rule from the owner's design
  // ruling: the ML market baseline is the venue winner's fee-adjusted
  // net-at-size, refreshed every cron pass. bet_locked_at freezes the
  // baseline permanently for locked rows (WHERE guard inside the
  // prepared statement); pregame refresh flows through unlocked rows.
  //
  //   existingByKey: snapshot of the current DB state per (type, side)
  //   BEFORE any UPSERT. Used to (a) compute per-column deltas for the
  //   bet_signal_audit entries so refresh history is reconstructable,
  //   (b) detect orphan rows to deactivate at the tail.
  const existingRows = db.prepare(
    'SELECT id, signal_type, signal_side, market_line, model_line, edge_pct, category, price_venue, venue_stale, is_active, bet_line, bet_locked_at, closing_line, clv FROM bet_signals WHERE game_date=? AND game_id=?'
  ).all(gameRow.game_date, gameRow.game_id);
  const existingByKey = {};
  for (const r of existingRows) existingByKey[r.signal_type + '|' + r.signal_side] = r;
  for (const sig of signals) {
    // Venue-aware market baseline for the STORED market_line + PnL grading.
    // When the venue override landed on the game object, use game.market_*
    // (which already carries the winning venue's net_american). Otherwise
    // fall back to gl.market_* (Kalshi-direct). PnL grading uses the same
    // baseline so ROI reflects the price the model actually saw.
    const _mkAwayML = _venueByMarket.ml_away ? game.market_away_ml : gl.market_away_ml;
    const _mkHomeML = _venueByMarket.ml_home ? game.market_home_ml : gl.market_home_ml;
    const _sigMarketLine = sig.type === 'ML'
      ? (sig.side === 'away' ? _mkAwayML : _mkHomeML)
      : gl.market_total;
    const _sigVenue = sig.type === 'ML'
      ? (sig.side === 'away' ? _venueByMarket.ml_away : _venueByMarket.ml_home)
      : null;
    const { outcome, pnl } = (gl.away_score != null)
      ? calcPnl({type:sig.type, side:sig.side, marketLine:_sigMarketLine, over_price:gl.over_price, under_price:gl.under_price}, gl.away_score, gl.home_score, gl.market_total)
      : { outcome: 'pending', pnl: 0 };
    // Step 2 runline companion: snapshot the spread for ML signals,
    // null for Total. Side-of-signal picks the matching half of the
    // game_log spread pair (the spread is signed REAL, so 'away' gets
    // market_away_spread and 'home' gets market_home_spread). Grade at
    // fire time too if scores are already in (rare late re-run path).
    const _spreadLine  = sig.type === 'ML'
      ? (sig.side === 'away' ? gl.market_away_spread       : gl.market_home_spread)       : null;
    const _spreadPrice = sig.type === 'ML'
      ? (sig.side === 'away' ? gl.market_away_spread_price : gl.market_home_spread_price) : null;
    const _spreadSrc   = sig.type === 'ML' ? (gl.market_spread_src || null) : null;
    let _spreadOutcome = null, _spreadPnl = null;
    if (sig.type === 'ML' && gl.away_score != null) {
      const r = calcRunlinePnl(sig.side, _spreadLine, _spreadPrice, gl.away_score, gl.home_score);
      _spreadOutcome = r.outcome === 'pending' ? null : r.outcome;
      _spreadPnl     = r.outcome === 'pending' ? null : r.pnl;
    }
    // Snapshot the pre-UPSERT row for this key so audit deltas are
    // computable AFTER the row moves. Absent → treat as insert; present
    // and bet_locked_at IS NOT NULL → UPSERT is a no-op (the WHERE guard
    // catches it), audit skipped so it doesn't record a phantom refresh.
    const _sigKey = sig.type + '|' + sig.side;
    const _preRow = existingByKey[_sigKey] || null;
    q.upsertSignal.run({
      game_log_id: gl.id,
      game_date: gameRow.game_date,
      game_id: gameRow.game_id,
      signal_type: sig.type,
      signal_side: sig.side,
      // signal_label is NULL for continuous-edge rows
      // (feat/continuous-edge-score); pre-cutover rows carry their
      // legacy "1★"/"2★"/"3★" string. category is direction-only
      // ('fav'|'dog'|'over'|'under') post-cutover.
      signal_label: sig.label,
      category: sig.category,
      market_line: _sigMarketLine,
      model_line: sig.type === 'ML'
        ? (sig.side === 'away' ? model.aML : model.hML)
        : parseFloat(model.estTot.toFixed(2)),
      edge_pct: sig.edge,
      outcome,
      pnl,
      // Cohort assignment by game_date. The model has gone through several
      // major changes; cohort is used to filter backtest output so each
      // version's ROI is measured cleanly against its own signals.
      //
      //   v3-pretuning : pre-2026-04-24 (early v3, before settings retune)
      //   v3           : 2026-04-24 — 2026-05-11
      //   v4           : 2026-05-12 — 2026-05-19
      //                  (PR 4 forecast-modulated weights + opener/bulk
      //                  redesign + role-aware F4 baselines; wOBA blend
      //                  W_PROJ/W_ACT = 0.70/0.30)
      //   v5           : 2026-05-20 — 2026-05-29
      //                  (wOBA blend retuned to 0.45/0.55 after the blend
      //                  sweep showed actuals were underweighted — ROI
      //                  peaked near 0.45/0.55 across 545 games)
      //   v6           : 2026-05-30 — 2026-07-05
      //                  (continuous edge score replaces star tiers;
      //                  signals report raw pp edges via edge_pct,
      //                  signal_label NULL. Plus forecastForPitcher
      //                  defensive fix — null on league_only instead of
      //                  leaking 5.45 baseline.)
      //   v7           : 2026-07-06 onward — birth certificate in
      //                  docs/cohort-v7-cutover-2026-07-05.md. Signal
      //                  stack materially changed vs v6: park-neutral
      //                  inputs LIVE (#142/#144/#146, actuals-only,
      //                  PA-weighted stints); edge-sanity cap LIVE
      //                  (soft/hard); opener precedence + RR gate
      //                  (#148/#149); SP-SP tandem forecast split with
      //                  flat weights (#150/#151); SP-forecast fuzzy
      //                  resolver (#154). RUN_MULT=46 (temporary 50
      //                  window during 2026-07-04 → 2026-07-05 stayed
      //                  v6 by game_date boundary). Framing
      //                  effectively LIVE (mute=1.0, coverage ramping
      //                  from ingest cutover 2026-06-17).
      //   Note (2026-07-08 amendment): SIGNAL_VENUE_AWARE_ENABLED, when
      //                  flipped ON, keeps the cohort at v7 rather than
      //                  cutting v8 — one day of pre-venue-aware v7
      //                  signals (~30 rows on 2026-07-06/07-07) isn't
      //                  worth a cohort split. See v7 birth cert amendment
      //                  in docs/cohort-v7-cutover-2026-07-05.md for the
      //                  small known heterogeneity note.
      cohort: cohortForGameDate(gameRow.game_date),
      companion_spread_line:    _spreadLine,
      companion_spread_price:   _spreadPrice,
      companion_spread_outcome: _spreadOutcome,
      companion_spread_pnl:     _spreadPnl,
      companion_spread_src:     _spreadSrc,
      // Edge-sanity soft-cap flag (feat/edge-sanity-cap). getSignals
      // sets sig.edge_suspect=true when SIGNAL_EDGE_SOFT_CAP_PP <= edge
      // < SIGNAL_EDGE_HARD_CAP_PP. Downstream UI reads this to render
      // a warning + exclude from "best plays" emphasis.
      edge_suspect: sig.edge_suspect ? 1 : 0,
      // Venue-aware signal edges (feat/venue-aware-signals). price_venue
      // records which venue supplied the baseline ('poly'|'kalshi'|null
      // for totals until Stage 2 lands them). venue_stale=1 marks a v8
      // row that couldn't obtain a fillable venue-best baseline and fell
      // back to Kalshi-direct — visible in backtest so ROI can segment.
      price_venue: _sigVenue,
      venue_stale: (_venueAware && (_sigVenue == null)) ? 1 : 0,
      // Lineup content hash — used by refreshSignalBaselines' staleness
      // guard. Same for all signals emitted this pass since they share
      // the same gl row. Nulls collapse to empty strings inside the
      // helper so hash is stable pre-lineup-population.
      lineup_hash: _lineupHash,
    });
    // Refresh audit trail. Records action='insert' on first sight and
    // action='refresh' on every subsequent pass that changes a tracked
    // column. Locked rows produce no audit because the WHERE guard on
    // upsertSignal makes the UPDATE a no-op — nothing to record.
    try {
      const _mlWasLocked = _preRow && _preRow.bet_locked_at != null;
      if (!_mlWasLocked) {
        const _modelLineNew = sig.type === 'ML'
          ? (sig.side === 'away' ? model.aML : model.hML)
          : parseFloat(model.estTot.toFixed(2));
        const _newSnap = {
          market_line: _sigMarketLine,
          model_line:  _modelLineNew,
          edge_pct:    sig.edge,
          category:    sig.category,
          price_venue: _sigVenue,
          venue_stale: (_venueAware && (_sigVenue == null)) ? 1 : 0,
        };
        const _delta = {};
        let _changed = false;
        if (!_preRow) {
          // first sighting — record baseline for future comparison
          _delta.first_sight = _newSnap;
          _changed = true;
        } else {
          for (const k of Object.keys(_newSnap)) {
            if (_preRow[k] !== _newSnap[k]) {
              _delta[k] = { from: _preRow[k], to: _newSnap[k] };
              _changed = true;
            }
          }
        }
        if (_changed) {
          q.insertBetSignalAudit({
            signal_id: _preRow ? _preRow.id : null,
            game_date: gameRow.game_date,
            game_id: gameRow.game_id,
            signal_type: sig.type,
            signal_side: sig.side,
            action: _preRow ? 'refresh' : 'insert',
            bet_line: null,
            closing_line: null,
            clv: null,
            source: 'process_game_signals_upsert',
            detail: JSON.stringify(_delta),
          });
        }
      }
    } catch (e) {
      // Audit failure never blocks signal write.
      console.warn('[upsert-audit] ' + gameRow.game_id + '/' + sig.type + '/' + sig.side + ': ' + e.message);
    }
    // Audit-log soft-flagged signals too (in addition to insertSignal's
    // edge_suspect column) so operators can grep the audit table for a
    // combined count of flagged + suppressed events by day — a burst is
    // an input-breakage alarm.
    if (sig.edge_suspect) {
      try {
        q.insertBetSignalAudit({
          signal_id: null,  // no lastInsertRowid tracking here; join on game_id+type+side
          game_date: gameRow.game_date,
          game_id: gameRow.game_id,
          signal_type: sig.type,
          signal_side: sig.side,
          action: 'flagged_soft_cap',
          bet_line: null, closing_line: null, clv: null,
          source: 'getSignals',
          detail: JSON.stringify({ edge: sig.edge, category: sig.category }),
        });
      } catch (e) {
        console.warn('[edge-cap-flag-audit] ' + gameRow.game_id + ': ' + e.message);
      }
    }
  }

  // Remove any duplicate signals (same type+side) — keep highest ID
  // Audit which rows are about to be deleted, for forensic "where did my lock go?" queries.
  const dupRows = db.prepare(
    "SELECT id, signal_type, signal_side, bet_line, closing_line, clv, " +
    "(SELECT MAX(id) FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=outer.signal_type AND signal_side=outer.signal_side) AS keep_id " +
    "FROM bet_signals AS outer WHERE game_date=? AND game_id=? AND id NOT IN (" +
    "  SELECT MAX(id) FROM bet_signals WHERE game_date=? AND game_id=? GROUP BY signal_type, signal_side" +
    ")"
  ).all(gameRow.game_date, gameRow.game_id, gameRow.game_date, gameRow.game_id, gameRow.game_date, gameRow.game_id);
  for (const dup of dupRows) {
    try {
      q.insertBetSignalAudit({
        signal_id: dup.id,
        game_date: gameRow.game_date,
        game_id: gameRow.game_id,
        signal_type: dup.signal_type,
        signal_side: dup.signal_side,
        action: 'auto_delete',
        bet_line: dup.bet_line,
        closing_line: dup.closing_line,
        clv: dup.clv,
        source: 'process_game_signals_dedupe',
        detail: 'duplicate type+side, keeping max(id)=' + dup.keep_id,
      });
    } catch(e) { /* audit failure must not block lifecycle */ }
  }
  // Deactivate orphans (feat/upsert-signal-refresh). An orphan is any
  // row from existingByKey whose (type, side) is NOT in the current
  // `signals` array — meaning getSignals no longer emits for that
  // tuple. Deactivation semantics:
  //
  //   - Unlocked (bet_line IS NULL): is_active=0. bet_signals_audit
  //     action='deactivated'. The row stays in the table so a later
  //     cron pass with fresh inputs can UPSERT it back to is_active=1
  //     (the ON CONFLICT DO UPDATE sets is_active=1 unconditionally
  //     inside the WHERE-guarded UPDATE).
  //
  //   - Locked (bet_line IS NOT NULL): is_active=0 same as before,
  //     but bet_line/bet_locked_at/closing_line/clv are preserved by
  //     the surgical UPDATE (deactivateSignal only touches is_active
  //     + notes + updated_at). The row remains queryable for CLV /
  //     backtest / audit purposes.
  //
  // No more DELETE + INSERT + restore-locks dance. The UPSERT's WHERE
  // bet_locked_at IS NULL guard is the lock-preservation mechanism.
  const currentKeys = new Set(signals.map(s => s.type + '|' + s.side));
  for (const [key, preRow] of Object.entries(existingByKey)) {
    if (currentKeys.has(key)) continue;
    if (preRow.is_active === 0) continue; // already deactivated
    const [dType, dSide] = key.split('|');
    // Note text — when suppressed (incomplete lineup), model_* values
    // are null so skip the .toFixed reference to the fresh model
    // output and log the suppression reason instead.
    const finalMdl = suppressed
      ? null
      : (dType === 'Total'
          ? parseFloat(model.estTot.toFixed(2))
          : (dSide === 'away' ? model.aML : model.hML));
    const mktRef = dType === 'Total'
      ? (gameRow.market_total != null ? ', mkt=' + gameRow.market_total : '')
      : (dSide === 'away'
          ? (gameRow.market_away_ml != null ? ', mkt=' + gameRow.market_away_ml : '')
          : (gameRow.market_home_ml != null ? ', mkt=' + gameRow.market_home_ml : ''));
    const note = suppressed
      ? 'Lineup incomplete (' + (model._suppressed_detail || 'no batters') + ') — model output suppressed, signal deactivated.'
      : 'Model ' + dType.toLowerCase() + ' at rerun: ' + finalMdl + mktRef + ' — edge no longer meets threshold.';
    q.deactivateSignal.run(note, gameRow.game_date, gameRow.game_id, dType, dSide);
    try {
      q.insertBetSignalAudit({
        signal_id: preRow.id,
        game_date: gameRow.game_date,
        game_id: gameRow.game_id,
        signal_type: dType,
        signal_side: dSide,
        action: 'deactivated',
        bet_line: preRow.bet_line,
        closing_line: preRow.closing_line,
        clv: preRow.clv,
        source: 'process_game_signals_upsert',
        detail: note,
      });
    } catch (e) { /* audit failure must not block lifecycle */ }
    console.log('[model] Deactivated stale signal: ' + dType + '/' + dSide + ' | ' + note);
  }
  return { model, signals };
}

// Fetch statsapi's schedule for dateStr and upsert every game it returns.
// Idempotent — upsertGame ON CONFLICT(game_date, game_id) preserves all
// downstream-written fields (odds, model, lineup confirmations) and only
// touches the matchup + SP columns the bootstrap is responsible for.
//
// Used by every job that needs "schedule is current" before its real
// work — runOddsJob and runWeatherJob both call it at the top, so an
// overnight schedule change (e.g. a postponement makeup added after
// last night's prefetch) gets a game_log row before odds/weather try
// to enrich it. runLineupJob keeps its own inline bootstrap loop because
// it has additional pre-bootstrap cleanup (dropping stale unplayed rows).
//
// Returns the array of rows from fetchSchedule (empty on fetch failure
// — failure is non-fatal, callers degrade open).

// Odds-cron tail refresh (feat/upsert-signal-refresh, 2026-07-08).
// Lightweight per-side rewrite of bet_signals.market_line + edge_pct
// against fresh venue-comparison rows, WITHOUT rebuilding the model.
// Called from runOddsJob's tail so a market move re-anchors edges even
// between full lineup-cron passes.
//
// Design rulings enforced here:
//
//   Staleness guard — skip games where the LATEST lineup capture is
//   newer than the row's last baseline write. bet_signals.updated_at
//   is bumped by processGameSignals when the model output persists;
//   game_log.lineups_quality_at is bumped when RotoWire pushes a new
//   lineup. If lineups_quality_at > updated_at, the persisted model
//   snapshot is stale relative to the lineup that shipped after it;
//   refreshing edge from a stale model against fresh prices produces
//   a false-precision number. Skip; next full processGameSignals pass
//   picks it up cleanly.
//
//   Freeze — skip games with game_log.odds_locked_at set. The T-10
//   pregame freeze rule from PR #163 applies here too.
//
//   Locked-row protection — never touch bet_signals rows with
//   bet_locked_at IS NOT NULL (WHERE guard on the UPDATE).
//
//   Fallback tiers (owner's tightened ruling):
//     tier 1: venue winner's net_american (fillable, fee-adjusted).
//             venue_stale = 0.
//     tier 2: Kalshi net_american (fillable, fee-adjusted, when tier 1
//             is unavailable OR venue-aware is OFF). venue_stale = 1.
//     tier 3: raw game_log.market_*_ml Kalshi-direct capture. Last
//             resort when Kalshi book is not computable. venue_stale = 1.
//
// Returns { refreshed, staleSkip, lockedGameSkip, lockedRowSkip,
//           lockedByOdds, unchanged }.
async function refreshSignalBaselines(dateStr, settings, opts) {
  const stats = { refreshed: 0, staleSkip: 0, lockedGameSkip: 0, lockedRowSkip: 0, unchanged: 0, noComparison: 0, snapshotServed: 0 };
  const _venueAware = !!(settings && settings.SIGNAL_VENUE_AWARE_ENABLED);
  let venueRowsByGid = (opts && opts.venueRowsByGid) || null;
  if (_venueAware && !venueRowsByGid) {
    try { venueRowsByGid = await _fetchVenueSlateCached(dateStr); }
    catch (e) { console.warn('[refresh-tail] venue fetch failed: ' + e.message); venueRowsByGid = {}; }
  }
  const activeRows = db.prepare(
    "SELECT bs.id, bs.game_id, bs.signal_type, bs.signal_side, bs.market_line, bs.model_line, bs.edge_pct, bs.category, bs.price_venue, bs.venue_stale, bs.bet_locked_at, bs.updated_at, bs.created_at, bs.lineup_hash, "
  + "gl.odds_locked_at, gl.lineups_quality_at, gl.market_away_ml, gl.market_home_ml, "
  + "gl.away_lineup_json, gl.home_lineup_json, gl.away_lineup_status, gl.home_lineup_status "
  + "FROM bet_signals bs JOIN game_log gl ON gl.game_date = bs.game_date AND gl.game_id = bs.game_id "
  + "WHERE bs.game_date = ? AND bs.is_active = 1 AND bs.signal_type = 'ML'"
  ).all(dateStr);
  const updateStmt = db.prepare(
    "UPDATE bet_signals SET market_line=?, edge_pct=?, price_venue=?, venue_stale=?, updated_at=datetime('now') "
  + "WHERE id=? AND bet_locked_at IS NULL"
  );
  // Snapshot-fallback tier (feat/venue-comparison-resilience, 2026-07-10).
  // When a live cmpRow isn't available (Poly/Kalshi transient failure OR
  // 60s-cache-expired-and-refresh-failed OR game_id not matched), load
  // the most recent snapshot from venue_comparison_snapshot and use it
  // as tier-1 IF the snapshot age is within SNAPSHOT_FRESH_MAX_MS
  // (parameterized, default 30 min per owner ruling).
  //
  // Rationale: 07-10 incident — 100% of active ML signals ended up at
  // tier-3 raw game_log captures because the tail-refresh at 18:00 UTC
  // hit an empty live-fetch and the pre-fix code fell through. The
  // snapshot from 17:54:11 UTC (6 min stale) held valid venue-winner
  // nets — under the new logic those become tier-1 with venue_stale=0
  // (the row didn't downgrade even though the live fetch failed).
  const SNAPSHOT_FRESH_MAX_MS = Number((settings && settings.SNAPSHOT_FRESH_MAX_MS) || 30 * 60 * 1000);
  const snapStmt = db.prepare(
    "SELECT snapshot_at, snapshot_json FROM venue_comparison_snapshot "
  + "WHERE game_date=? AND game_id=?"
  );
  const snapshotCache = {};
  function loadFreshSnapshotForGid(gid) {
    if (snapshotCache[gid] !== undefined) return snapshotCache[gid];
    const s = snapStmt.get(dateStr, gid);
    if (!s) { snapshotCache[gid] = null; return null; }
    try {
      const ageMs = Date.now() - new Date(s.snapshot_at).getTime();
      if (ageMs > SNAPSHOT_FRESH_MAX_MS) { snapshotCache[gid] = null; return null; }
      const parsed = JSON.parse(s.snapshot_json);
      parsed._snapshot_at = s.snapshot_at;
      parsed._snapshot_age_ms = ageMs;
      snapshotCache[gid] = parsed;
      return parsed;
    } catch (e) { snapshotCache[gid] = null; return null; }
  }
  const impliedP = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
  for (const row of activeRows) {
    // 1) Per-bet freeze
    if (row.bet_locked_at) { stats.lockedRowSkip++; continue; }
    // 2) T-10 pregame freeze (game-level)
    if (row.odds_locked_at) { stats.lockedGameSkip++; continue; }
    // 3) Staleness guard: skip only when the lineup CONTENT changed since
    //    this row was last written by processGameSignals. The prior guard
    //    used the lineups_quality_at timestamp, which bumps on every
    //    RotoWire pull even when RotoWire re-served an identical lineup
    //    — that froze the tail-refresh on rows RotoWire touched without
    //    materially changing (07-10 incident: 5 games stuck at
    //    updated_at='2026-07-09' with venue_stale=1 tier-3 baselines).
    //
    //    Hash mismatch means processGameSignals is about to rewrite
    //    model_line off a fresh lineup — refreshing market_line here
    //    would compute an interim edge against stale model_line.
    //
    //    Fail-open on NULL row.lineup_hash (row emitted before this
    //    migration): refresh, don't skip. The tail-refresh only touches
    //    market_line/edge_pct/price_venue/venue_stale, never model_line,
    //    so at worst the row edge_pct lands one pass early.
    const currentLineupHash = _computeLineupHash({
      away_lineup_json:   row.away_lineup_json,
      home_lineup_json:   row.home_lineup_json,
      away_lineup_status: row.away_lineup_status,
      home_lineup_status: row.home_lineup_status,
    });
    if (row.lineup_hash && currentLineupHash && row.lineup_hash !== currentLineupHash) {
      stats.staleSkip++;
      continue;
    }
    // 4) Pick baseline per fallback tiers.
    //    tier 1a: live venue winner
    //    tier 1b: snapshot venue winner (age ≤ SNAPSHOT_FRESH_MAX_MS)
    //            — same semantics as tier 1a, marked venue_stale=0
    //    tier 2:  Kalshi net-at-size (from either live cmpRow or fresh
    //            snapshot; fee-adjusted, venue_stale=1)
    //    tier 3:  raw game_log Kalshi-direct capture (venue_stale=1)
    let cmpRow = venueRowsByGid ? venueRowsByGid[row.game_id] : null;
    let servedFromSnapshot = false;
    if (!cmpRow && _venueAware) {
      const snap = loadFreshSnapshotForGid(row.game_id);
      if (snap) { cmpRow = snap; servedFromSnapshot = true; }
    }
    let newMarket = null, newVenue = null, newStale = 1;
    if (_venueAware && cmpRow) {
      const best = _pickBestML(cmpRow, row.signal_side);
      if (best) { newMarket = best.ml; newVenue = best.venue; newStale = 0; }
    }
    if (newMarket == null && cmpRow) {
      // Tier 2: Kalshi net (fillable, fee-adjusted). Same tier whether
      // sourced from live cmpRow or fresh snapshot.
      const K = cmpRow.kalshi && cmpRow.kalshi[row.signal_side];
      if (K && K.net_american != null && !K.partial) {
        newMarket = K.net_american; newVenue = 'kalshi'; newStale = 1;
      }
    }
    // Tier 3 raw-capture fallback removed (feat/demote-unabated,
    // 2026-07-10). Post-#230 the game_log.market_*_ml columns hold
    // Kalshi/Poly baselines only (never Unabated), so the "last resort
    // raw capture" was either (a) already Kalshi/Poly and thus
    // redundant with tier-1/2, or (b) NULL because neither venue
    // covered the game. Snapshot-fallback tier from #166 replaces this
    // path. Downstream: unchanged unlocked rows stay at their prior
    // Kalshi/Poly value until a future cron resolves fresh data.
    if (newMarket == null) { stats.noComparison++; continue; }
    if (servedFromSnapshot) stats.snapshotServed++;
    // 5) Skip write if nothing changed.
    if (newMarket === row.market_line && newVenue === row.price_venue && (newStale ? 1 : 0) === row.venue_stale) {
      stats.unchanged++;
      continue;
    }
    // 6) Recompute edge from the persisted model_line snapshot. Same
    //    formula as services/model.js:getSignals; category tells us
    //    which side of the edge lives on this row.
    const modelP = impliedP(row.model_line);
    const marketP = impliedP(newMarket);
    const newEdge = Math.max(0, modelP - marketP);
    const res = updateStmt.run(newMarket, parseFloat(newEdge.toFixed(4)), newVenue, newStale, row.id);
    if (res.changes > 0) {
      stats.refreshed++;
      try {
        q.insertBetSignalAudit({
          signal_id: row.id,
          game_date: dateStr,
          game_id: row.game_id,
          signal_type: row.signal_type,
          signal_side: row.signal_side,
          action: 'refresh_odds_tail',
          bet_line: null,
          closing_line: null,
          clv: null,
          source: 'refreshSignalBaselines',
          detail: JSON.stringify({
            market_line: { from: row.market_line, to: newMarket },
            edge_pct:    { from: row.edge_pct,    to: parseFloat(newEdge.toFixed(4)) },
            price_venue: { from: row.price_venue, to: newVenue },
            venue_stale: { from: row.venue_stale, to: newStale },
            source:      servedFromSnapshot ? 'snapshot' : (cmpRow ? 'live' : 'game_log_capture'),
            snapshot_at: servedFromSnapshot && cmpRow ? cmpRow._snapshot_at : null,
            snapshot_age_ms: servedFromSnapshot && cmpRow ? cmpRow._snapshot_age_ms : null,
          }),
        });
      } catch (e) { /* audit failure never blocks refresh */ }
    }
  }
  return stats;
}

// statsapi-side SP capture with backfill, shared by both bootstrap paths
// (ensureScheduleBootstrap above and runLineupJob's inline bootstrap loop).
//
// Priority order (highest wins):
//   1. THIS pass's statsapi probable (bootObj.name) — fresh + authoritative.
//   2. existingRow.statsapi_<away|home>_sp — already captured by a prior pass.
//   3. existingRow.<away|home>_sp, IFF rotowire_<away|home>_sp doesn't
//      match it (rules out RotoWire-fill as the source of the value).
//      Catches:
//       - rows written before this branch's schema existed (statsapi_*_sp
//         was added recently; pre-branch writes never populated it).
//       - mid-day bootstrap passes where statsapi cleared its probable
//         (g.away_sp is null this pass, but earlier in the day it had a
//         value that's now sitting in away_sp via the upsert's COALESCE).
//         Without this backfill the column stays null and the conflict
//         flag silently fails to fire for doubleheader g2 legs, which
//         statsapi often shows-then-clears the probable for.
//   4. null — preserve whatever's in the column (likely null).
//
// Live bug this fixes: det-bal-g2 on 2026-05-24 had bootstrap log
// 'away_sp=null' but existingRow.away_sp held 'Framber Valdez' at merge
// time (carried via COALESCE from an earlier pass / day). statsapi_away_sp
// stayed null, so the conflict detector saw "either side null" and
// returned 0 instead of catching the genuine Valdez-vs-Melton mismatch.
function deriveStatsapiSp(bootObj, existing, sourceKey) {
  if (bootObj && bootObj.name) return bootObj.name;
  if (!existing) return null;
  const existingStatsapi = existing['statsapi_' + sourceKey];
  if (existingStatsapi) return existingStatsapi;
  const existingMerged = existing[sourceKey];
  const existingRotowire = existing['rotowire_' + sourceKey];
  if (existingMerged && existingMerged !== existingRotowire) {
    return existingMerged;
  }
  return null;
}

async function ensureScheduleBootstrap(dateStr) {
  let rows = [];
  try {
    rows = await fetchSchedule(dateStr);
  } catch (e) {
    console.warn('[bootstrap] statsapi fetch failed for ' + dateStr + ': ' + e.message);
    return [];
  }
  for (const g of rows) {
    const existingRow = q.getGameById.get(dateStr, g.game_id);
    // statsapi is the authoritative source; values flow through unchanged.
    // Log source attribution so the per-game write trail is greppable —
    // pairs with the [lineups] write log in runLineupJob's RotoWire path.
    console.log('[bootstrap] ' + g.game_id + ' write from statsapi: '
      + 'away_sp=' + (g.away_sp ? g.away_sp.name : 'null') + ', '
      + 'home_sp=' + (g.home_sp ? g.home_sp.name : 'null') + ', '
      + 'game_time=' + (g.time || 'null'));
    q.upsertGame.run({
      game_date: dateStr,
      game_id: g.game_id,
      away_team: g.away_team,
      home_team: g.home_team,
      game_time: g.time || null,
      away_sp: g.away_sp ? g.away_sp.name : null,
      away_sp_hand: g.away_sp ? g.away_sp.hand : null,
      home_sp: g.home_sp ? g.home_sp.name : null,
      home_sp_hand: g.home_sp ? g.home_sp.hand : null,
      // Per-source SP capture: bootstrap is the statsapi source. Persist
      // statsapi's probable SPs distinctly so they survive even if the
      // merged away_sp/home_sp gets a different value from a later pass.
      // rotowire_*_sp null here → COALESCE preserves any value RotoWire
      // already wrote. deriveStatsapiSp handles backfill when this pass's
      // statsapi probable is null but the row already carries a non-
      // RotoWire-sourced value (see helper definition above).
      statsapi_away_sp: deriveStatsapiSp(g.away_sp, existingRow, 'away_sp'),
      statsapi_home_sp: deriveStatsapiSp(g.home_sp, existingRow, 'home_sp'),
      rotowire_away_sp: null,
      rotowire_home_sp: null,
      // statsapi never carries the announced bulk; only RotoWire's PRIM
      // tag does. Null here lets the upsert COALESCE preserve any value
      // a prior RotoWire pass already wrote.
      bulk_guy_away_announced: null,
      bulk_guy_home_announced: null,
      // SP proj_ip is captured by the lineup-job (which has the canonical
      // SP names). Bootstrap passes null and COALESCE preserves any value
      // already written.
      away_sp_proj_ip: null,
      home_sp_proj_ip: null,
      // F4 forecast IP is captured by the lineup-job too. Same null +
      // COALESCE pattern as proj_ip — bootstrap never writes these.
      away_sp_forecast_ip: null,
      home_sp_forecast_ip: null,
      away_sp_forecast_n_priors: null,
      home_sp_forecast_n_priors: null,
      away_bulk_forecast_ip: null,
      home_bulk_forecast_ip: null,
      away_opener_forecast_ip: null,
      home_opener_forecast_ip: null,
      market_away_ml: existingRow ? (existingRow.market_away_ml || null) : null,
      market_home_ml: existingRow ? (existingRow.market_home_ml || null) : null,
      market_total:   existingRow ? existingRow.market_total : null,
      park_factor:    existingRow ? existingRow.park_factor : 1.0,
      model_away_ml:  existingRow ? existingRow.model_away_ml : null,
      model_home_ml:  existingRow ? existingRow.model_home_ml : null,
      model_total:    existingRow ? existingRow.model_total : null,
      lineup_source:  existingRow ? existingRow.lineup_source : 'auto',
      venue_id:       g.venue_id != null ? g.venue_id : (existingRow ? existingRow.venue_id : null),
      venue_name:     g.venue_name != null ? g.venue_name : (existingRow ? existingRow.venue_name : null),
      game_number:    g.game_number != null ? g.game_number : 1,
      game_pk:        g.game_pk != null ? g.game_pk : null,
    });
  }
  if (rows.length > 0) console.log('[bootstrap] statsapi upserted ' + rows.length + ' row(s) for ' + dateStr);
  return rows;
}

async function runLineupJob(dateStr) {
  dateStr = dateStr || todayStr();
  console.log('[lineup-job] Starting for ' + dateStr);
  let gamesUpdated = 0;
  try {
    // Step 0: belt-and-suspenders roster freshness check
    // (fix/roster-staleness-on-lineup-pass). The 6AM PT cron is the
    // only scheduled roster refresh, so any callup/IL-return whose
    // status.code='A' lands AFTER 6AM PT today is invisible to the
    // catcher-framing resolver (and any other team_rosters consumer)
    // for the remainder of the day. runRosterJobIfStale only fires
    // the statsapi pull when the most recent team_rosters row is
    // older than maxAgeHrs — so on a healthy 6AM cron this is a fast
    // no-op skip, but lineup-job passes after midday will catch
    // mid-morning + early-afternoon transactions before they break
    // signal scoring. 4h chosen so the 8AM lineup-job sees the 6AM
    // roster (2h old → skip), the noon lineup-job triggers a refresh
    // (6h old), and post-noon passes piggyback on the noon refresh
    // until the 5-6PM pass triggers another. Caps max-callup-
    // staleness at ~4h instead of 24h with no new cron entries.
    try {
      await runRosterJobIfStale(4);
    } catch (e) {
      console.warn('[lineup-job] runRosterJobIfStale failed (non-fatal): ' + (e && e.message));
    }

    // Step 1: bootstrap game_log from statsapi schedule. statsapi has the
    // canonical schedule (matchups + scheduled time + probable SPs) for
    // dates well before RotoWire publishes. Bootstrap rows are upserted
    // immediately; if the chained RotoWire fetch later fails or skips, the
    // bootstrap rows remain — which is exactly what the caller needs for
    // future-date "Load Games" UI clicks. Bootstrap failure is logged but
    // not fatal: we still proceed to RotoWire so an error in statsapi
    // doesn't block confirmed-lineup ingestion when both sources are alive.
    let bootstrapRows = [];
    try {
      bootstrapRows = await fetchSchedule(dateStr);
    } catch (e) {
      console.warn('[lineup-job] statsapi bootstrap failed for ' + dateStr + ': ' + e.message);
    }
    if (bootstrapRows.length > 0) {
      // Cleanup matches the RotoWire path below: drop stale unplayed rows
      // before upsert so a previous mistaken date can't survive. Wrapped in
      // try/catch because bet_signals FK blocks the delete when a signal
      // has a user-locked bet_line — the upsert below still updates via
      // ON CONFLICT in that case.
      try {
        const info = db.prepare('DELETE FROM game_log WHERE game_date=? AND away_score IS NULL').run(dateStr);
        if (info.changes > 0) console.log('[lineup-job] Removed ' + info.changes + ' stale unplayed row(s) for ' + dateStr + ' (pre-bootstrap)');
      } catch (e) {
        console.warn('[lineup-job] Pre-bootstrap cleanup skipped (likely bet_signals FK):', e && e.message);
      }
      for (const g of bootstrapRows) {
        const existingRow = q.getGameById.get(dateStr, g.game_id);
        console.log('[bootstrap] ' + g.game_id + ' write from statsapi: '
          + 'away_sp=' + (g.away_sp ? g.away_sp.name : 'null') + ', '
          + 'home_sp=' + (g.home_sp ? g.home_sp.name : 'null') + ', '
          + 'game_time=' + (g.time || 'null'));
        q.upsertGame.run({
          game_date: dateStr,
          game_id: g.game_id,
          away_team: g.away_team,
          home_team: g.home_team,
          game_time: g.time || null,
          away_sp: g.away_sp ? g.away_sp.name : null,
          away_sp_hand: g.away_sp ? g.away_sp.hand : null,
          home_sp: g.home_sp ? g.home_sp.name : null,
          home_sp_hand: g.home_sp ? g.home_sp.hand : null,
          // Per-source SP capture: bootstrap is the statsapi source. Same
          // pattern as ensureScheduleBootstrap above. deriveStatsapiSp
          // handles the backfill case (see helper definition near the top
          // of this module) — critical for doubleheader g2 legs where
          // statsapi sometimes shows-then-clears a probable mid-day.
          statsapi_away_sp: deriveStatsapiSp(g.away_sp, existingRow, 'away_sp'),
          statsapi_home_sp: deriveStatsapiSp(g.home_sp, existingRow, 'home_sp'),
          rotowire_away_sp: null,
          rotowire_home_sp: null,
          // statsapi bootstrap doesn't know about PRIM; null preserves any
          // existing RotoWire-written value via COALESCE in upsertGame.
          bulk_guy_away_announced: null,
          bulk_guy_home_announced: null,
          // statsapi bootstrap leaves proj_ip to the lineup-job pass.
          away_sp_proj_ip: null,
          home_sp_proj_ip: null,
          // F4 forecast IP also left to the lineup-job pass.
          away_sp_forecast_ip: null,
          home_sp_forecast_ip: null,
          away_sp_forecast_n_priors: null,
          home_sp_forecast_n_priors: null,
          away_bulk_forecast_ip: null,
          home_bulk_forecast_ip: null,
          away_opener_forecast_ip: null,
          home_opener_forecast_ip: null,
          // Preserve all downstream-written fields when the row already
          // exists. Bootstrap is matchup + SP only; everything else is owned
          // by other jobs (odds, model, lineup confirmations).
          market_away_ml: existingRow ? (existingRow.market_away_ml || null) : null,
          market_home_ml: existingRow ? (existingRow.market_home_ml || null) : null,
          market_total:   existingRow ? existingRow.market_total : null,
          park_factor:    existingRow ? existingRow.park_factor : 1.0,
          model_away_ml:  existingRow ? existingRow.model_away_ml : null,
          model_home_ml:  existingRow ? existingRow.model_home_ml : null,
          model_total:    existingRow ? existingRow.model_total : null,
          lineup_source:  existingRow ? existingRow.lineup_source : 'auto',
          venue_id:       g.venue_id != null ? g.venue_id : (existingRow ? existingRow.venue_id : null),
          venue_name:     g.venue_name != null ? g.venue_name : (existingRow ? existingRow.venue_name : null),
          // statsapi is the source of truth for doubleheader markers.
          game_number:    g.game_number != null ? g.game_number : 1,
          game_pk:        g.game_pk != null ? g.game_pk : null,
        });
      }
      console.log('[lineup-job] statsapi bootstrap upserted ' + bootstrapRows.length + ' rows for ' + dateStr);
    }

    // Step 2: RotoWire enrichment. If RotoWire skips (date mismatch / past
    // / future), we still consider the job a success when bootstrap rows
    // landed — the user gets matchups + probable SPs even without
    // confirmed lineups.
    //
    // Split fetch into raw + parse so the snapshot system can capture the
    // upstream HTML before any Cheerio parsing; /api/replay/lineups re-runs
    // parseLineupsHtml against the captured payload.
    const rawResp = await fetchLineupsRaw(dateStr);
    let result;
    if (rawResp.skipped) {
      result = rawResp;
    } else {
      writeSnapshot('lineups', dateStr, { html: rawResp.html, fetched_at: rawResp.fetched_at });
      result = parseLineupsHtml(rawResp.html, dateStr);
    }

    if (result && result.skipped) {
      console.log('[lineup-job] RotoWire skipped: ' + result.message);
      const successFromBootstrap = bootstrapRows.length > 0;
      const cronStatus = successFromBootstrap ? 'bootstrap-only' : 'skipped';
      q.logCron.run('lineups', dateStr, cronStatus, result.message + (successFromBootstrap ? ' (statsapi bootstrap kept ' + bootstrapRows.length + ' rows)' : ''), bootstrapRows.length);
      return {
        success: successFromBootstrap,
        skipped: !successFromBootstrap,
        reason: result.reason,
        message: result.message,
        bootstrap: bootstrapRows.length,
        date: dateStr,
      };
    }

    const games = Array.isArray(result) ? result : [];
  // Normalize team codes — fix common scraper mistakes
  const TEAM_NORM = {'WSH':'WAS','OAK':'ATH','CWS':'CWS'};
  for (const g of games) {
    if (TEAM_NORM[g.away_team]) g.away_team = TEAM_NORM[g.away_team];
    if (TEAM_NORM[g.home_team]) g.home_team = TEAM_NORM[g.home_team];
    // Recompute game_id after normalization, preserving any '-g{N}'
    // doubleheader suffix that parseLineupsHtml assigned. Stripping it
    // here was the silent collapse that re-collided RotoWire's two DH
    // sections back into one game_id.
    const dhMatch = (g.game_id || '').match(/-g\d+$/);
    g.game_id = (g.away_team + '-' + g.home_team).toLowerCase() + (dhMatch ? dhMatch[0] : '');
  }
  // Deduplicate by game_id (keep last). With the DH suffix preserved
  // above, doubleheader legs now have distinct game_ids and survive dedup.
  const seen = {}; for (const g of games) seen[g.game_id] = g;
  games.length = 0; Object.values(seen).forEach(g => games.push(g));
    if (!games.length) {
      // RotoWire returned an empty list. If statsapi bootstrap landed rows,
      // the call still succeeded for the caller's purpose (game_log has
      // matchups + probable SPs). Otherwise the job genuinely failed.
      const successFromBootstrap = bootstrapRows.length > 0;
      const status = successFromBootstrap ? 'bootstrap-only' : 'error';
      const msg = 'No games returned from RotoWire' + (successFromBootstrap ? ' (statsapi bootstrap kept ' + bootstrapRows.length + ' rows)' : '');
      q.logCron.run('lineups', dateStr, status, msg, bootstrapRows.length);
      return successFromBootstrap
        ? { success: true, skipped: false, bootstrap: bootstrapRows.length, gamesUpdated: 0, date: dateStr }
        : { success: false, error: 'No games returned', date: dateStr };
    }

    // Stale-row cleanup runs only when statsapi bootstrap didn't fire (it
    // already cleaned up there before its own upsert). Skipping the second
    // cleanup is critical: with bootstrap rows in place, this DELETE would
    // wipe them all (they have away_score IS NULL) before the RotoWire
    // upsert loop could enrich. The pre-bootstrap cleanup already covered
    // the wrong-date-write scenario this guard was protecting against.
    if (bootstrapRows.length === 0) {
      try {
        const info = db.prepare('DELETE FROM game_log WHERE game_date=? AND away_score IS NULL').run(dateStr);
        if (info.changes > 0) console.log('[lineup-job] Removed ' + info.changes + ' stale unplayed row(s) for ' + dateStr);
      } catch (e) {
        console.error('[lineup-job] Cleanup skipped (likely bet_signals FK):', e && e.message);
      }
    }

    const settings = getSettings();
    const wobaIdx = getWobaIndex();

    // F4 SP IP-per-start forecast index. Built once per slate; reused for
    // every game. The pure forecast function (services/model.js
    // forecastSpIP) takes this index and a pitcher mlb_id plus the game
    // date, and returns a Bayesian-shrinkage IP forecast. Diagnostic in
    // this PR — the model does not yet consume these values (PR 4 wires
    // them into the SP/bullpen split).
    const spStartIndex = buildSpStartIndex(db, settings);
    if (spStartIndex.buildError) {
      console.warn('[lineup-job] SP forecast index build failed: ' + spStartIndex.buildError + ' — forecasts will use league baseline fallback');
    }
    // Helper: resolve a pitcher name on a given team to their mlb_id via
    // team_rosters, then call forecastSpIP. Returns the forecast IP (a
    // number), or null when:
    //   * name was missing,
    //   * neither the exact nor the diacritic-normalized roster row
    //     matched (pitcher not in team_rosters — produce a VISIBLE null
    //     rather than the silent league baseline that source!=='fallback'
    //     used to let through),
    //   * the forecast itself reported source='fallback' (no index data).
    // PR 4's gate accepts any non-null number; the COALESCE in upsertGame
    // preserves prior values when this is null.
    const rosterLookup = db.prepare(
      "SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?"
    );
    // Normalized-name fallback for accents / casing / punctuation.
    // Rotowire and other ingestion paths sometimes flatten 'Martín Pérez'
    // to 'Martin Perez', which the exact-match SQL above misses — the
    // pitcher was then silently treated as unknown and forecastSpIP
    // returned the ~5.45 IP league baseline tagged 'league_only'. With
    // 'league_only' upstream of the (source!=='fallback') gate, that
    // baseline flowed through as a real forecast. The map below catches
    // those cases at JS level. Built once per slate (small table, ~1200
    // rows). normName already does NFD-strip + lowercase + punctuation
    // collapse so it covers the brief's requested normalization and a
    // bit more.
    const rosterByNorm = new Map();
    for (const row of db.prepare(
      "SELECT team, player_name, mlb_id FROM team_rosters WHERE team IS NOT NULL AND player_name IS NOT NULL"
    ).all()) {
      const key = row.team + ':' + normName(row.player_name);
      // First write wins — if two roster rows normalize to the same key
      // on the same team, prefer the first (rare; would indicate a
      // duplicate roster row anyway).
      if (!rosterByNorm.has(key)) rosterByNorm.set(key, row.mlb_id);
    }
    // Returns an object so the writer can persist both the forecast IP
    // and the count of clean priors behind it (needed by the SP-weight
    // confidence haircut in services/model.js
    // computeSpPitWeightFromForecast). Returns null when truly no info.
    //
    // Semantics:
    //   - pitcher not in roster / source='fallback' → null. Persist
    //     null and let runModel fall through to SP_PIT_WEIGHT (0.80) —
    //     same as pre-haircut behavior; this case is structurally
    //     "we don't even know who's pitching."
    //   - source='league_only' → { forecast: f0_league, n_priors: 0 }.
    //     Pre-fix this returned null and the no-priors case landed at
    //     0.80; now we persist 0 priors so the haircut targets the
    //     low-confidence weight (~0.62) instead.
    //   - source='shrinkage' → { forecast, n_priors: total_clean_priors }.
    //     The graduated haircut ramps weight from low-conf back to the
    //     forecast-driven weight as n_priors grows.
    const forecastForPitcher = (pitcherName, team, role) => {
      if (!pitcherName || !team) return null;
      let mlbId = null;
      const r = rosterLookup.get(team, pitcherName);
      if (r) mlbId = r.mlb_id;
      if (mlbId == null) {
        const key = team + ':' + normName(pitcherName);
        if (rosterByNorm.has(key)) mlbId = rosterByNorm.get(key);
      }
      // Abbreviated-name fallback (docs/sp-forecast-abbrev-name-2026-07-04.md).
      // RotoWire occasionally writes SPs as 'Y. Yamamoto' / 'C. Sanchez' /
      // 'S. Woods Richardson'. Exact + normalized-exact both miss because
      // team_rosters has the full name ('Yoshinobu Yamamoto'). Without this
      // fallback the SP forecast column persisted null and the model priced
      // the pitcher at SP_FORECAST_LOW_CONF_TARGET=0.62 — the same
      // low-confidence weight assigned to a genuine no-priors pitcher. Fired
      // silently for ~20 games since 2026-03-01 (S. Woods Richardson,
      // E. Rodriguez, C. Sanchez, B. Williamson recurring).
      //
      // Pattern mirrors utils/names.js fuzzyLookup's isAbbrev branch: scope
      // the scan to this team, match by first-initial + last-name against
      // rosterByNorm. Only resolves when exactly one roster entry matches
      // (ambiguous cases like two 'E. Rodriguez' on the same team return
      // null and stay in the low-conf bucket — safer than resolving to the
      // wrong pitcher). Cost: O(roster-for-team) per unresolved abbrev,
      // typically ~40 entries — trivial vs. the forecastSpIP call itself.
      if (mlbId == null) {
        const norm = normName(pitcherName);
        const parts = norm.split(' ');
        const isAbbrev = parts.length >= 2 && parts[0].length === 1;
        if (isAbbrev) {
          const initial = parts[0];
          const last = parts[parts.length - 1];
          const prefix = team + ':';
          let matches = 0;
          let matchId = null;
          let matchNormName = null;
          for (const [k, v] of rosterByNorm.entries()) {
            if (!k.startsWith(prefix)) continue;
            const rn = k.slice(prefix.length);
            const p = stripSfx(rn).split(' ');
            if (p[p.length - 1] === last && p[0] && p[0][0] === initial) {
              matches++;
              matchId = v;
              matchNormName = rn;
              if (matches > 1) break;
            }
          }
          if (matches === 1) {
            mlbId = matchId;
            console.log('[forecast-for-pitcher] abbrev-resolved name=' + pitcherName
              + ' team=' + team + ' → ' + matchNormName + ' mlbId=' + mlbId);
          } else if (matches > 1) {
            console.log('[forecast-null-resolve] abbrev-ambiguous name=' + pitcherName
              + ' team=' + team + ' role=' + (role || 'start') + ' matches=' + matches);
          }
        }
      }
      if (mlbId == null) {
        // Distinct log tag for the health counter — greppable and structured.
        console.log('[forecast-null-resolve] name=' + pitcherName
          + ' team=' + team + ' role=' + (role || 'start') + ' reason=unresolved-name');
        return null;
      }
      const out = forecastSpIP({
        index: spStartIndex,
        pitcherMlbId: mlbId,
        gameDate: dateStr,
        settings,
        role: role || 'start',
      });
      console.log('[forecast-for-pitcher] name=' + pitcherName + ' team=' + team + ' role=' + (role || 'start') + ' mlbId=' + mlbId + ' source=' + out.source + ' forecast=' + (out.forecast != null ? out.forecast.toFixed(4) : 'null') + ' n_priors=' + ((out.components && out.components.total_clean_priors) || 0));
      if (out.source === 'fallback') {
        console.log('[forecast-null-resolve] name=' + pitcherName + ' team=' + team
          + ' role=' + (role || 'start') + ' reason=index-fallback mlbId=' + mlbId);
        return null;
      }
      // league_only persists with n_priors=0 (low-conf haircut target);
      // shrinkage persists with its actual prior count.
      const nPriors = (out.components && out.components.total_clean_priors) || 0;
      return { forecast: out.forecast, n_priors: nPriors };
    };
    // Back-compat unwrappers for the bulk/opener writes that don't need
    // n_priors (only the SP slot consumes the haircut today).
    const forecastIp     = (n, t, r) => { const v = forecastForPitcher(n, t, r); return v ? v.forecast : null; };
    const forecastNPriors = (n, t, r) => { const v = forecastForPitcher(n, t, r); return v ? v.n_priors : null; };
    // updateLineup also writes the proj_* snapshot columns wrapped in
    // COALESCE so the FIRST non-empty projected write wins and subsequent
    // updates (still projected, or transitioned to confirmed) preserve the
    // original snapshot. Caller passes the values when capture conditions
    // are met, null otherwise — when it passes null COALESCE is a no-op
    // (preserves existing, including null-staying-null when projection
    // never happened).
    const updateLineup = db.prepare(
    `UPDATE game_log SET
      away_lineup_json=?, home_lineup_json=?,
      away_lineup_status=?, home_lineup_status=?,
      proj_away_lineup_json = COALESCE(proj_away_lineup_json, ?),
      proj_home_lineup_json = COALESCE(proj_home_lineup_json, ?),
      proj_away_sp = COALESCE(proj_away_sp, ?),
      proj_home_sp = COALESCE(proj_home_sp, ?),
      proj_lineup_captured_at = COALESCE(proj_lineup_captured_at, ?),
      lineups_quality='fresh', lineups_quality_at=datetime('now'),
      updated_at=datetime('now')
     WHERE game_date=? AND game_id=?`
  );

    // Venue-aware signal edges (feat/venue-aware-signals). Prefetch the
    // slate-wide venue comparison once so per-game processGameSignals stays
    // synchronous. Off-path when the setting is off — the fetch is
    // skipped and processGameSignals runs without an override.
    let _venueRowsByGid = null;
    if (settings && settings.SIGNAL_VENUE_AWARE_ENABLED) {
      try {
        _venueRowsByGid = await _fetchVenueSlateCached(dateStr);
        console.log('[venue-aware] fetched ' + Object.keys(_venueRowsByGid).length + ' comparison rows for ' + dateStr);
      } catch (e) {
        console.warn('[venue-aware] prefetch failed for ' + dateStr + ' — falling back per-game to Kalshi-direct (venue_stale=1): ' + e.message);
        _venueRowsByGid = {};
      }
    }

    for (const g of games) {
      const gameId = g.game_id || makeGameId(g.away_team, g.home_team);
      let awayLU = (g.away_lineup || []).map(b => ({ name: b.name, hand: b.hand, pos: b.pos || null }));
      let homeLU = (g.home_lineup || []).map(b => ({ name: b.name, hand: b.hand, pos: b.pos || null }));

      // Manual lineup-override integration (feat/lineup-override-backend).
      // Rule: CONFIRMED WINS. The override is applied ONLY while the
      // incoming side's status is 'projected' (or null/bootstrap). When
      // RotoWire posts a 'confirmed' lineup for the side, the override
      // is auto-deleted and RotoWire's confirmed lineup is used (real
      // beats guess).
      //
      // Per-side independence: away override doesn't affect home, and
      // vice versa. Null-safety: no override → existing behavior
      // unchanged.
      const _luIncomingAwayStatus = g.away_lineup_status
        || (g.lineup_status === 'confirmed' ? 'confirmed' : 'projected');
      const _luIncomingHomeStatus = g.home_lineup_status
        || (g.lineup_status === 'confirmed' ? 'confirmed' : 'projected');
      const _luOvAway = q.getLineupOverride
        ? q.getLineupOverride.get(dateStr, gameId, 'away') : null;
      const _luOvHome = q.getLineupOverride
        ? q.getLineupOverride.get(dateStr, gameId, 'home') : null;
      if (_luOvAway) {
        if (_luIncomingAwayStatus === 'confirmed') {
          q.deleteLineupOverride.run(dateStr, gameId, 'away');
          console.log('[lineups] ' + gameId + '/away: confirmed lineup posted, clearing manual override');
        } else {
          try {
            const ovLu = JSON.parse(_luOvAway.lineup_json);
            if (Array.isArray(ovLu) && ovLu.length > 0) {
              awayLU = ovLu;
              console.log('[lineups] ' + gameId + '/away: using manual lineup_override ('
                + ovLu.length + ' batters), RotoWire projected lineup ignored');
            }
          } catch (e) {
            console.warn('[lineups] ' + gameId + '/away: lineup_override JSON parse failed (using RotoWire): ' + e.message);
          }
        }
      }
      if (_luOvHome) {
        if (_luIncomingHomeStatus === 'confirmed') {
          q.deleteLineupOverride.run(dateStr, gameId, 'home');
          console.log('[lineups] ' + gameId + '/home: confirmed lineup posted, clearing manual override');
        } else {
          try {
            const ovLu = JSON.parse(_luOvHome.lineup_json);
            if (Array.isArray(ovLu) && ovLu.length > 0) {
              homeLU = ovLu;
              console.log('[lineups] ' + gameId + '/home: using manual lineup_override ('
                + ovLu.length + ' batters), RotoWire projected lineup ignored');
            }
          } catch (e) {
            console.warn('[lineups] ' + gameId + '/home: lineup_override JSON parse failed (using RotoWire): ' + e.message);
          }
        }
      }

      const existingRow = q.getGameById.get(dateStr, gameId);
        // Lock odds 10min before game start — only for TODAY's games, never future dates
        const todayForLock = new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
        if (existingRow && !existingRow.odds_locked_at && existingRow.game_time && dateStr === todayForLock) {
          const tm = existingRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (tm) {
            let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
            if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
            // game_time is stored in ET (scraper.fmtET, RotoWire's
            // .lineup__time). Subtract 3 hours to compare against PT
            // wall-clock. Cross-midnight wrap-around isn't a real case for
            // MLB so the simple modulo is safe.
            let gameMinsPT = h*60+mn - 3*60;
            if (gameMinsPT < 0) gameMinsPT += 24*60;
            const nowPT=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
            const minsToGame=gameMinsPT-(nowPT.getHours()*60+nowPT.getMinutes());
            if(minsToGame<=10&&minsToGame>=-240){
              db.prepare("UPDATE game_log SET odds_locked_at=datetime('now') WHERE game_date=? AND game_id=? AND odds_locked_at IS NULL").run(dateStr,gameId);
              console.log('[odds] Locked '+gameId+' ('+minsToGame+'min)');
              // Auto-set closing lines on any ML signals for this game.
              //
              // ---- CLV CAVEAT ----
              // When kalshi_direct_primary_enabled is on, market_*_ml below
              // is the FEE-ADJUSTED Kalshi price (set in runOddsJob's
              // Kalshi-direct override block), NOT the raw market. CLV
              // computed here is therefore fee-skewed — systematically
              // inflated by roughly the per-contract fee — and is NOT
              // directly comparable to a true closing line. Known, accepted
              // consequence of storing the all-in price everywhere. See
              // feat/kalshi-fee-adjusted-lines.
              const gameForClose = q.getGameById.get(dateStr, gameId);
              if (gameForClose) {
                const mlSigs = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type='ML' AND closing_line IS NULL").all(dateStr, gameId);
                for (const sig of mlSigs) {
                  const closingLine = sig.signal_side === 'away' ? gameForClose.market_away_ml : gameForClose.market_home_ml;
                  const clv = calcCLV(sig.bet_line, closingLine);
                  db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closingLine, clv, sig.id);
                  try {
                    q.insertBetSignalAudit({
                      signal_id: sig.id,
                      game_date: dateStr,
                      game_id: gameId,
                      signal_type: sig.signal_type,
                      signal_side: sig.signal_side,
                      action: 'set_closing_line',
                      bet_line: sig.bet_line,
                      closing_line: closingLine,
                      clv: clv,
                      source: 'cron_closing_lock',
                      detail: 'odds locked at game start gate',
                    });
                  } catch(e) { /* audit failure must not block lifecycle */ }
                }
              }
            }
          }
        }
        // SP source precedence (gated by sp_prefer_rotowire, default ON):
        //   sp_prefer_rotowire = TRUE  (default, the current policy):
        //     RotoWire wins on conflict. RotoWire scrapes posted /
        //     announced lineups, which lead statsapi probables on
        //     reshuffled or doubleheader games (det-bal-g2 2026-05-24
        //     was the case that motivated this — statsapi had stale
        //     'Framber Valdez', RotoWire had correct 'Troy Melton').
        //   sp_prefer_rotowire = FALSE (legacy "Option B" precedence):
        //     statsapi wins on conflict — RotoWire can fill in when
        //     statsapi is null but cannot override a non-null statsapi.
        //     Kept reachable via the toggle so we can roll back without
        //     a redeploy if RotoWire-wins turns out worse.
        //
        // CRITICAL null-safety, INDEPENDENT OF THE TOGGLE: a NULL RotoWire
        // value never overwrites a present statsapi value. Both conflict
        // branches gate on `rwAwaySp` (resp. rwHomeSp) being truthy. When
        // RotoWire hasn't posted, the default `writeAwaySp = rwAwaySp`
        // is `null` and the upsert's COALESCE(excluded, existing) keeps
        // the statsapi value.
        //
        // game_time precedence is UNCHANGED — statsapi continues to own
        // game_time. Only the SP fields flip; the brief was explicit.
        //
        // sp_source_conflict still fires on every disagreement (in the
        // post-upsert block below) regardless of which value won the
        // merge — the flag is computed from the per-source columns, not
        // from the merged result.
        const SP_PREFER_ROTOWIRE = !!(settings && settings.SP_PREFER_ROTOWIRE);
        const rwAwaySp   = g.away_sp && g.away_sp.name || null;
        const rwHomeSp   = g.home_sp && g.home_sp.name || null;
        const rwAwayHand = g.away_sp && g.away_sp.hand || null;
        const rwHomeHand = g.home_sp && g.home_sp.hand || null;
        const rwTime     = g.time || null;
        let writeAwaySp = rwAwaySp, writeAwayHand = rwAwayHand;
        let writeHomeSp = rwHomeSp, writeHomeHand = rwHomeHand;
        let writeTime   = rwTime;

        // Piece 4 / durability guard (feat/opener-name-override): when
        // an opener_override carries a non-null opener_name for this
        // side, pin the SP to it BEFORE the conflict logic runs. Without
        // this, detectOpeners pins the SP correctly but the next
        // runLineupJob pass overwrites it with RotoWire's value
        // (was-cle 2026-05-25 case: RotoWire keeps reporting the bulk
        // pitcher in the SP slot, so without this guard the pin reverts
        // every lineup-job run).
        //
        // Per-side independent: an away override only pins away_sp;
        // home conflict logic still runs for the home side, and vice
        // versa. Bulk-only overrides (opener_name null) DO NOT touch
        // the SP — they only affect is_opener/bulk_guy via detectOpeners.
        //
        // The hand for the pinned name is set to null because the
        // override doesn't carry hand info — letting the upsert's
        // COALESCE preserve whatever's already in the row is safer
        // than asserting RotoWire's hand for the wrong pitcher (e.g.
        // RotoWire's rwAwayHand would be Littell's hand when the
        // override pins Poulin).
        //
        // Survives the SP_PREFER_ROTOWIRE toggle: a manual override is
        // more authoritative than either auto-source.
        const _ovAway = q.getOpenerOverride.get(dateStr, gameId, 'away');
        const _ovHome = q.getOpenerOverride.get(dateStr, gameId, 'home');
        const _awaySpPinned = !!(_ovAway && _ovAway.opener_name);
        const _homeSpPinned = !!(_ovHome && _ovHome.opener_name);
        if (_awaySpPinned) {
          writeAwaySp = _ovAway.opener_name;
          writeAwayHand = null;
          console.log('[lineups] ' + gameId + '/away: SP pinned by opener_override'
            + " (opener_name='" + _ovAway.opener_name + "')"
            + (rwAwaySp && rwAwaySp !== _ovAway.opener_name
                ? ", RotoWire value '" + rwAwaySp + "' ignored"
                : ''));
        }
        if (_homeSpPinned) {
          writeHomeSp = _ovHome.opener_name;
          writeHomeHand = null;
          console.log('[lineups] ' + gameId + '/home: SP pinned by opener_override'
            + " (opener_name='" + _ovHome.opener_name + "')"
            + (rwHomeSp && rwHomeSp !== _ovHome.opener_name
                ? ", RotoWire value '" + rwHomeSp + "' ignored"
                : ''));
        }

        if (existingRow) {
          // Skip the away conflict logic when an override pinned the SP —
          // the override is more authoritative than either auto-source.
          if (!_awaySpPinned && existingRow.away_sp && rwAwaySp && existingRow.away_sp !== rwAwaySp) {
            if (SP_PREFER_ROTOWIRE) {
              console.warn('[lineups] SP conflict, using RotoWire over statsapi for ' + gameId
                + ': statsapi=\'' + existingRow.away_sp + '\', rotowire=\'' + rwAwaySp + '\'');
              // writeAwaySp already equals rwAwaySp by default — let RotoWire win.
            } else {
              console.warn('[lineups] SP conflict, preserving statsapi for ' + gameId
                + ': statsapi=\'' + existingRow.away_sp + '\', rotowire=\'' + rwAwaySp + '\'');
              writeAwaySp = null; writeAwayHand = null;
            }
          }
          if (!_homeSpPinned && existingRow.home_sp && rwHomeSp && existingRow.home_sp !== rwHomeSp) {
            if (SP_PREFER_ROTOWIRE) {
              console.warn('[lineups] SP conflict, using RotoWire over statsapi for ' + gameId
                + ': statsapi=\'' + existingRow.home_sp + '\', rotowire=\'' + rwHomeSp + '\'');
            } else {
              console.warn('[lineups] SP conflict, preserving statsapi for ' + gameId
                + ': statsapi=\'' + existingRow.home_sp + '\', rotowire=\'' + rwHomeSp + '\'');
              writeHomeSp = null; writeHomeHand = null;
            }
          }
          // game_time unchanged — statsapi still owns it.
          if (existingRow.game_time && rwTime && existingRow.game_time !== rwTime) {
            console.warn('[lineups] not overwriting game_time for ' + gameId
              + ': statsapi=\'' + existingRow.game_time + '\', rotowire=\'' + rwTime + '\'');
            writeTime = null;
          }
        }
        // Source attribution. Greppable per-side labels so production logs
        // make it obvious which source landed which value. Cases:
        //   rotowire-null            — RotoWire didn't supply a value; whatever
        //                              was in the row (likely statsapi-bootstrapped)
        //                              is preserved via the upsert's COALESCE.
        //   preserved-statsapi       — sp_prefer_rotowire is OFF and we declined
        //                              to overwrite a non-null statsapi value
        //                              (legacy Option-B precedence).
        //   rotowire-fill            — existing was null; RotoWire fills.
        //   rotowire-wins-conflict   — sp_prefer_rotowire is ON, existing was
        //                              non-null and disagreed with RotoWire,
        //                              and we overwrote with RotoWire's value
        //                              (the policy that fixed det-bal-g2).
        //   rotowire-overwrite-same  — existing == new value; merge is a no-op
        //                              in terms of stored state.
        //   opener-override-pin      — feat/opener-name-override piece 4:
        //                              the side's SP was pinned by an
        //                              opener_override.opener_name BEFORE
        //                              the merge ran; both RotoWire and
        //                              statsapi are bypassed for this side.
        const fmtSrc = (rw, write, existing, pinned) => {
          if (pinned) return 'opener-override-pin';
          if (rw == null) return 'rotowire-null';
          if (write == null && existing) return 'preserved-statsapi';
          if (existing == null) return 'rotowire-fill';
          if (existing !== write) return 'rotowire-wins-conflict';
          return 'rotowire-overwrite-same'; // existing == new, no harm
        };
        console.log('[lineups] ' + gameId + ' write: '
          + 'away_sp=' + (writeAwaySp ?? existingRow?.away_sp ?? 'null') + '(' + fmtSrc(rwAwaySp, writeAwaySp, existingRow?.away_sp, _awaySpPinned) + '), '
          + 'home_sp=' + (writeHomeSp ?? existingRow?.home_sp ?? 'null') + '(' + fmtSrc(rwHomeSp, writeHomeSp, existingRow?.home_sp, _homeSpPinned) + '), '
          + 'game_time=' + (writeTime ?? existingRow?.game_time ?? 'null') + '(' + fmtSrc(rwTime, writeTime, existingRow?.game_time, false) + ')');

        q.upsertGame.run({
        game_date: dateStr,
        game_id: gameId,
        away_team: g.away_team,
        home_team: g.home_team,
        game_time: writeTime,
        away_sp: writeAwaySp,
        away_sp_hand: writeAwayHand,
        home_sp: writeHomeSp,
        home_sp_hand: writeHomeHand,
        // Per-source SP capture: RotoWire writes its RAW value (rwAwaySp /
        // rwHomeSp), independent of the Option-B precedence merge above
        // that may have rejected it in favor of statsapi for away_sp /
        // home_sp. statsapi_*_sp null here → COALESCE preserves the
        // bootstrap-written statsapi value. Both source columns thus end
        // up holding each source's unfiltered original, which lets the
        // post-upsert conflict detector compare apples to apples.
        statsapi_away_sp: null,
        statsapi_home_sp: null,
        rotowire_away_sp: rwAwaySp,
        rotowire_home_sp: rwHomeSp,
        // RotoWire's PRIM-tagged announced bulk pitcher. Null when no PRIM
        // tag was found on this side; the upsert's COALESCE preserves any
        // previously-captured value across refreshes.
        bulk_guy_away_announced: g.away_bulk_announced ? g.away_bulk_announced.name : null,
        bulk_guy_home_announced: g.home_bulk_announced ? g.home_bulk_announced.name : null,
        // Look up SP projected IP/start from pit_proj_ip via the existing
        // exact + last-name fallback in q.getPitcherProjIP. Resolves to the
        // SP we're about to persist (writeAwaySp/writeHomeSp), preferring
        // RotoWire's name when not preserved by statsapi. Falls back to
        // statsapi's existing SP name if the RotoWire name was rejected by
        // the reconciliation guard. Null means no projection match — the
        // model's existing flat-weight fallback applies (model behavior
        // unchanged by this column).
        away_sp_proj_ip: q.getPitcherProjIP
          ? q.getPitcherProjIP(writeAwaySp || existingRow?.away_sp || (g.away_sp && g.away_sp.name) || '')
          : null,
        home_sp_proj_ip: q.getPitcherProjIP
          ? q.getPitcherProjIP(writeHomeSp || existingRow?.home_sp || (g.home_sp && g.home_sp.name) || '')
          : null,
        // F4 forecast IP for the SP slot. Same name-resolution chain as
        // proj_ip above. Resolves to mlb_id via team_rosters and computes
        // the Bayesian-shrinkage EWMA forecast. Null when SP name is null
        // (e.g., PRIM-detected bullpen game pre-announcement) — the SP
        // forecast column stays null and the model's existing bullpen-
        // sourced fallback for the opener slot continues to apply.
        // Diagnostic only in this PR; PR 4 wires consumption.
        away_sp_forecast_ip: forecastIp(
          writeAwaySp || existingRow?.away_sp || (g.away_sp && g.away_sp.name) || null,
          g.away_team,
          'start'
        ),
        home_sp_forecast_ip: forecastIp(
          writeHomeSp || existingRow?.home_sp || (g.home_sp && g.home_sp.name) || null,
          g.home_team,
          'start'
        ),
        away_sp_forecast_n_priors: forecastNPriors(
          writeAwaySp || existingRow?.away_sp || (g.away_sp && g.away_sp.name) || null,
          g.away_team,
          'start'
        ),
        home_sp_forecast_n_priors: forecastNPriors(
          writeHomeSp || existingRow?.home_sp || (g.home_sp && g.home_sp.name) || null,
          g.home_team,
          'start'
        ),
        // F4 forecast IP for the announced bulk pitcher in opener games.
        // Null when no PRIM-tagged bulk was announced for this side (the
        // common case). When announced, this is the bulk pitcher's
        // historical IP signal — what PR 4 will use to size the bulk slot
        // relative to the bullpen residual. Role='bulk' uses the 5.4 IP
        // baseline (matches design weight 0.60 × 9 IP), keeping bulk
        // forecasts centered on bulk-role expectations.
        // Bulk forecast: pulls from either the RotoWire-announced bulk OR
        // the opener-detection-inferred bulk (legacy bulk_guy_* column on
        // game_log). model.js's buildOpenerOpts reads game.bulk_guy_away
        // (the inferred column) — so the bulk forecast must populate
        // whenever that's set, not only when RotoWire announces.
        away_bulk_forecast_ip: forecastIp(
          (g.away_bulk_announced && g.away_bulk_announced.name)
            || existingRow?.bulk_guy_away
            || null,
          g.away_team,
          'bulk'
        ),
        home_bulk_forecast_ip: forecastIp(
          (g.home_bulk_announced && g.home_bulk_announced.name)
            || existingRow?.bulk_guy_home
            || null,
          g.home_team,
          'bulk'
        ),
        // Opener-role forecast: forecasted unconditionally for every named
        // SP. Used downstream only when is_opener_game_{side}=1 (set by the
        // separate opener-detection pass). Previously gated on
        // g.away_bulk_announced, but that missed bullpen-game patterns —
        // an opener game with no named bulk follower (e.g. TOR-DET 5/16
        // Spencer Miles). Architecturally cleaner to pre-compute for every
        // SP since the per-game cost is one F4 lookup and the column sits
        // unused on non-opener games (where the standard model handles them).
        away_opener_forecast_ip: forecastIp(
          writeAwaySp || existingRow?.away_sp || (g.away_sp && g.away_sp.name) || null,
          g.away_team,
          'opener'
        ),
        home_opener_forecast_ip: forecastIp(
          writeHomeSp || existingRow?.home_sp || (g.home_sp && g.home_sp.name) || null,
          g.home_team,
          'opener'
        ),
        // Lineup job NEVER overwrites odds — only the odds job writes market lines
      market_away_ml: existingRow ? (existingRow.market_away_ml||null) : null, // ML only from Odds API
      market_home_ml: existingRow ? (existingRow.market_home_ml||null) : null, // ML only from Odds API
      market_total:   existingRow ? existingRow.market_total   : g.market_total,
      park_factor: g.park_factor || 1.0,
        model_away_ml: existingRow ? existingRow.model_away_ml : null,
        model_home_ml: existingRow ? existingRow.model_home_ml : null,
        model_total:   existingRow ? existingRow.model_total   : null,
        lineup_source: 'auto',
        // RotoWire payload doesn't carry venue, so fall back to the existing
        // bootstrapped venue. Statsapi-bootstrapped venue_id wins when set.
        venue_id:   g.venue_id != null ? g.venue_id : (existingRow ? existingRow.venue_id : null),
        venue_name: g.venue_name != null ? g.venue_name : (existingRow ? existingRow.venue_name : null),
        // RotoWire payload doesn't carry doubleheader markers — pass null so
        // the upsert's COALESCE preserves the statsapi-bootstrapped values.
        game_number: g.game_number != null ? g.game_number : null,
        game_pk:     g.game_pk     != null ? g.game_pk     : null,
          away_lineup_status: g.away_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected'),
      home_lineup_status: g.home_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected'),
      lineup_status: g.lineup_status || 'projected',
      });
      // SP source-discrepancy flag. Both sources have now written for this
      // game (statsapi via bootstrap above, RotoWire via this upsert), so
      // we can compare their raw values. existingRow.statsapi_*_sp is the
      // statsapi value captured pre-RotoWire; rwAwaySp / rwHomeSp are
      // RotoWire's raw values from this pass.
      //
      // Match logic (matches resolveCatcherMlbId pattern for SP-name
      // robustness against "F. Valdez" vs "Framber Valdez" / accents /
      // Jr-Sr-II suffixes):
      //   1. Both null OR either null → not a conflict (one source
      //      unconfirmed, not disagreement).
      //   2. normName + stripSfx full-string equal → not a conflict.
      //   3. Otherwise compare last-name + first-initial.
      //   4. Else → CONFLICT.
      //
      // Behavior: FLAG ONLY. We persist the flag on the row so the UI /
      // API can surface it, but signals are NOT suppressed — pre-game
      // churn often produces brief disagreements that resolve on their
      // own, and silencing legitimate signals on transient mismatch would
      // cost more than the flag is worth.
      const _statsapiAway = existingRow ? existingRow.statsapi_away_sp : null;
      const _statsapiHome = existingRow ? existingRow.statsapi_home_sp : null;
      const _spNamesMatch = (a, b) => {
        if (!a || !b) return false;
        const na = stripSfx(normName(a));
        const nb = stripSfx(normName(b));
        if (na === nb) return true;
        const pa = na.split(' ');
        const pb = nb.split(' ');
        if (pa.length < 2 || pb.length < 2) return false;
        return pa[pa.length - 1] === pb[pb.length - 1]
            && pa[0][0] === pb[0][0];
      };
      const _conflictParts = [];
      if (_statsapiAway && rwAwaySp && !_spNamesMatch(_statsapiAway, rwAwaySp)) {
        _conflictParts.push('away: statsapi=' + _statsapiAway + ', rotowire=' + rwAwaySp);
      }
      if (_statsapiHome && rwHomeSp && !_spNamesMatch(_statsapiHome, rwHomeSp)) {
        _conflictParts.push('home: statsapi=' + _statsapiHome + ', rotowire=' + rwHomeSp);
      }
      const _conflictFlag = _conflictParts.length > 0 ? 1 : 0;
      const _conflictNote = _conflictParts.length > 0 ? _conflictParts.join(' | ') : null;
      try {
        q.updateSpSourceConflict.run({
          game_date: dateStr,
          game_id: gameId,
          sp_source_conflict: _conflictFlag,
          sp_source_conflict_note: _conflictNote,
        });
        if (_conflictFlag) {
          console.warn('[sp-source-conflict] ' + gameId + ' → ' + _conflictNote);
        }
      } catch (e) {
        // Non-fatal: a flag-write failure must not break the lineup-job.
        console.warn('[sp-source-conflict] write failed for ' + gameId + ': ' + e.message);
      }
      const awayStatus = g.away_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected');
    const homeStatus = g.home_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected');
    // Capture-once snapshot of the first non-empty projected lineup. Skips
    // bootstrap-empty and direct-to-confirmed states; once captured, the
    // COALESCE in updateLineup keeps it frozen across later updates.
    const _captureProj = (awayStatus === 'projected' || homeStatus === 'projected')
      && awayStatus !== 'confirmed' && homeStatus !== 'confirmed'
      && awayLU.length > 0 && homeLU.length > 0;
    const _projAwayJson = _captureProj ? JSON.stringify(awayLU) : null;
    const _projHomeJson = _captureProj ? JSON.stringify(homeLU) : null;
    const _projAwaySP = _captureProj ? (g.away_sp ? g.away_sp.name : null) : null;
    const _projHomeSP = _captureProj ? (g.home_sp ? g.home_sp.name : null) : null;
    const _projAt = _captureProj ? new Date().toISOString() : null;
    updateLineup.run(
      JSON.stringify(awayLU), JSON.stringify(homeLU),
      awayStatus, homeStatus,
      _projAwayJson, _projHomeJson,
      _projAwaySP, _projHomeSP, _projAt,
      dateStr, gameId
    );
      // Clear zeros — treat 0 same as null for market odds
      db.prepare("UPDATE game_log SET market_away_ml=CASE WHEN market_away_ml=0 THEN NULL ELSE market_away_ml END, market_home_ml=CASE WHEN market_home_ml=0 THEN NULL ELSE market_home_ml END, market_total=CASE WHEN market_total=0 THEN NULL ELSE market_total END WHERE game_date=? AND game_id=?").run(dateStr, gameId);
      const gameRow = q.getGameById.get(dateStr, gameId);
      if (gameRow) {
        processGameSignals({
          ...gameRow,
          away_lineup_json: JSON.stringify(awayLU),
          home_lineup_json: JSON.stringify(homeLU),
        }, wobaIdx, settings, { venueRowsByGid: _venueRowsByGid });
        gamesUpdated++;
      }
    }

    q.logCron.run('lineups', dateStr, 'success', 'Pulled ' + games.length + ' games (date verified)', gamesUpdated);
    console.log('[lineup-job] Done — ' + gamesUpdated + ' games processed');

    // Phase 1 of opener support: data layer only. Detection runs after
    // SPs are upserted but doesn't gate signal generation in this PR
    // (processGameSignals already ran inside the per-game loop above).
    // Failure is non-fatal — the lineup job's own success counts as
    // success regardless of whether opener detection ran cleanly.
    try {
      await detectOpeners(dateStr);
    } catch (e) {
      console.warn('[opener-detect] failed (non-fatal): ' + e.message);
    }

    return { success: true, gamesUpdated, date: dateStr };

  } catch (err) {
    console.error('[lineup-job] Error:', err.message);
    q.logCron.run('lineups', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

// Convert MLB Stats API's innings-pitched string ("6.1" = 6⅓ IP, "6.2"
// = 6⅔ IP) to a real number. Handles edge cases:
//   "0.0", "" / null / undefined → 0
//   "6.0" → 6, "6.1" → 6.333…, "6.2" → 6.667
//   anything not matching the X.D pattern falls back to parseFloat
function parseInningsString(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  if (!str) return 0;
  const m = str.match(/^(\d+)(?:\.(\d))?$/);
  if (!m) {
    const f = parseFloat(str);
    return isNaN(f) ? 0 : f;
  }
  const whole = parseInt(m[1], 10);
  const partial = m[2] ? parseInt(m[2], 10) : 0;
  return whole + (partial === 1 ? 1/3 : partial === 2 ? 2/3 : 0);
}

// Returns array of { team, pitcher_name, pitcher_mlb_id, pitches_thrown,
// innings_pitched, batters_faced, was_starter, outing_type }.
async function fetchPitcherUsage(dateStr) {
  const fetch = require('node-fetch');
  const [y,m,d] = dateStr.split('-');
  const mmddyyyy = m + '/' + d + '/' + y;
  const schedUrl = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + mmddyyyy + '&hydrate=linescore,pitchers';
  const sResp = await fetch(schedUrl);
  if (!sResp.ok) throw new Error('MLB schedule HTTP ' + sResp.status);
  const sched = await sResp.json();
  const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  const out = [];
  for (const g of games) {
    const status = g.status && g.status.abstractGameState;
    if (status !== 'Final') continue;
    try {
      const boxUrl = 'https://statsapi.mlb.com/api/v1/game/' + g.gamePk + '/boxscore';
      const bResp = await fetch(boxUrl);
      if (!bResp.ok) continue;
      const box = await bResp.json();
      for (const side of ['home','away']) {
        const teamObj = box.teams && box.teams[side];
        if (!teamObj) continue;
        const teamAbbr = (teamObj.team && teamObj.team.abbreviation || '').toUpperCase();
        const pitcherIds = teamObj.pitchers || [];
        for (const pid of pitcherIds) {
          const player = teamObj.players && teamObj.players['ID' + pid];
          if (!player) continue;
          const name = player.person && player.person.fullName;
          if (!name) continue;
          const pitching = (player.stats && player.stats.pitching) || {};
          const pitches = pitching.numberOfPitches != null ? pitching.numberOfPitches
                        : (pitching.pitchesThrown != null ? pitching.pitchesThrown : 0);
          // PR A additions: capture IP, BF, GS-flag and derive an outing_type
          // tag so PR B can score candidates without re-deriving on read.
          // outing_type: 'start' when statsapi credited the gameStarted flag
          // (covers regular SPs *and* openers — the bulk-guy detection
          // discriminates via separate signals), 'long_relief' when the
          // pitcher came on in relief but worked 3+ IP (the bulk-guy
          // signature), 'short_relief' otherwise.
          const ip = parseInningsString(pitching.inningsPitched);
          const bf = Number(pitching.battersFaced) || 0;
          const wasStarter = pitching.gamesStarted ? 1 : 0;
          const outingType = wasStarter ? 'start'
                           : (ip >= 3 ? 'long_relief' : 'short_relief');
          out.push({
            team: teamAbbr,
            pitcher_name: name,
            pitcher_mlb_id: pid,
            pitches_thrown: Number(pitches) || 0,
            innings_pitched: ip,
            batters_faced: bf,
            was_starter: wasStarter,
            outing_type: outingType,
          });
        }
      }
    } catch(e) {
      console.log('[pitcher-usage] boxscore fail for gamePk=' + g.gamePk + ': ' + e.message);
    }
  }
  return out;
}

// One-shot: backfill innings_pitched / batters_faced / was_starter /
// outing_type on pitcher_game_log rows from the last 60 days. Statsapi
// has had these fields all along; we just weren't reading them. PR B's
// scored bulk-guy heuristic needs ~30+ days of long-relief / start
// patterns to discriminate, so 60 days covers v3 + the pre-tuning era
// that PR B will lean on.
//
// Idempotency:
//   - app_settings flag 'pitcher_usage_backfill_done' (string 'true')
//     short-circuits the entire function — set on successful completion.
//   - row-level: a date is skipped when ANY pitcher_game_log row for
//     that date already has innings_pitched IS NOT NULL. So a deploy
//     interrupted mid-backfill resumes cleanly on the next start, and
//     ongoing runScoreJob captures (which write the new columns
//     directly) keep the backfill from re-fetching boxscores it
//     doesn't need.
//
// Throttle: 200ms between dates so we're not hammering statsapi for
// 60 boxscore fans-out in a single tight loop. Per-game errors are
// already swallowed inside fetchPitcherUsage.
async function runPitcherUsageBackfill() {
  const flagRow = db.prepare(
    "SELECT value FROM app_settings WHERE key='pitcher_usage_backfill_done'"
  ).get();
  if (flagRow && flagRow.value === 'true') {
    console.log('[pitcher-usage-backfill] flag set — skipping');
    return { success: true, skipped: true, reason: 'flag_set' };
  }

  const dates = [];
  const today = new Date();
  for (let i = 1; i <= 60; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  console.log('[pitcher-usage-backfill] starting — 60-day window, ' + dates.length + ' dates');
  let datesProcessed = 0, datesAlreadyDone = 0, datesFailed = 0, rowsWritten = 0;
  for (const date of dates) {
    const exists = db.prepare(
      "SELECT 1 FROM pitcher_game_log WHERE game_date = ? AND innings_pitched IS NOT NULL LIMIT 1"
    ).get(date);
    if (exists) { datesAlreadyDone++; continue; }

    try {
      const usage = await fetchPitcherUsage(date);
      for (const u of usage) {
        q.upsertPitcherGameLog.run(
          date, u.team, u.pitcher_name, u.pitcher_mlb_id,
          u.pitches_thrown, u.innings_pitched, u.batters_faced,
          u.was_starter, u.outing_type, 1
        );
        rowsWritten++;
      }
      datesProcessed++;
      if (usage.length > 0) {
        console.log('[pitcher-usage-backfill] ' + date + ': ' + usage.length + ' pitcher rows');
      }
    } catch (e) {
      datesFailed++;
      console.warn('[pitcher-usage-backfill] ' + date + ' failed: ' + e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // Set the done flag only if we didn't have any date-level failures.
  // Partial backfills shouldn't flip the flag — the next deploy will
  // resume on the still-empty dates via the row-level guard above.
  if (datesFailed === 0) {
    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pitcher_usage_backfill_done', 'true')"
    ).run();
    console.log('[pitcher-usage-backfill] done — flag set');
  } else {
    console.warn('[pitcher-usage-backfill] '+datesFailed+' date(s) failed — flag NOT set, will retry on next start');
  }
  console.log('[pitcher-usage-backfill] processed='+datesProcessed
    +', already_done='+datesAlreadyDone+', failed='+datesFailed
    +', rows_written='+rowsWritten);
  return {
    success: datesFailed === 0,
    dates_processed: datesProcessed,
    dates_already_done: datesAlreadyDone,
    dates_failed: datesFailed,
    rows_written: rowsWritten,
  };
}

async function runScoreJob(dateStr) {
  dateStr = dateStr || yesterdayStr();
  console.log('[score-job] Starting for ' + dateStr);
  let gamesUpdated = 0;
  try {
    // Snapshot raw statsapi JSON before parsing; /api/replay/scores re-runs
    // parseScoresJson against the captured payload.
    const rawScoresJson = await fetchScoresRaw(dateStr);
    writeSnapshot('scores', dateStr, rawScoresJson);
    const scores = parseScoresJson(rawScoresJson);
    for (const s of scores) {
      const gameId = s.gameId || makeGameId(s.away || s.away_team, s.home || s.home_team);
      q.updateScores.run({
        game_date: dateStr,
        game_id: gameId,
        away_score: s.awayScore ?? s.away_score,
        home_score: s.homeScore ?? s.home_score,
        scores_source: 'mlb-api',
      });
      const gameRow = db.prepare(`SELECT * FROM game_log WHERE game_date=? AND game_id=?`).get(dateStr, gameId);
      if (gameRow) {
        // Grade ALL locked signals (active + inactive) so P&L is complete
        const signals = db.prepare('SELECT * FROM bet_signals WHERE game_date=? AND game_id=?').all(dateStr, gameId);
        const updateSignal = db.prepare(`UPDATE bet_signals SET outcome=?, pnl=? WHERE id=?`);
        // Step 2 runline companion: parallel grading on captured
        // spread snapshot. ML-only; Total signals never enter this loop.
        const updateRunline = db.prepare(`UPDATE bet_signals SET companion_spread_outcome=?, companion_spread_pnl=? WHERE id=?`);
        const _ay = s.awayScore ?? s.away_score;
        const _hy = s.homeScore ?? s.home_score;
        for (const sig of signals) {
          const { outcome } = calcPnl(
            { type: sig.signal_type, side: sig.signal_side, marketLine: sig.market_line, bet_line: sig.bet_line },
            _ay, _hy, gameRow.market_total
          );
          // To-win-100 P&L
          let _pnl = 0;
          if (outcome !== 'pending' && outcome !== 'push') {
            if (sig.signal_type === 'ML') {
              // ML: use locked bet_line price, else market ML price
              const _ml = parseFloat(sig.bet_line || sig.market_line);
              if (!isNaN(_ml) && _ml !== 0) {
                const _stake = _ml > 0 ? parseFloat((10000/_ml).toFixed(2)) : Math.abs(_ml);
                _pnl = outcome === 'win' ? 100 : parseFloat((-_stake).toFixed(2));
              }
            } else {
              // Total: bet_line is the O/U number, NOT the price
              // Use over/under price from game_log, NOT closing_line (which stores the total number)
              //
              // ---- CLV / P&L CAVEAT ----
              // When kalshi_direct_totals_enabled is on, gameRow.over_price
              // / under_price are FEE-ADJUSTED Kalshi asks (set in
              // runOddsJob's totals override block) — NOT raw market
              // prices. Any P&L computed against them inherits the same
              // per-contract fee skew documented at the ML CLV site
              // (~line 1206) and at the override site itself. Known,
              // accepted; see feat/kalshi-fee-adjusted-lines and the
              // totals override block for the design rationale.
              const _price = sig.signal_side === 'over' ? (gameRow.over_price || -110) : (gameRow.under_price || -110);
              const _stake = _price < 0 ? Math.abs(_price) : parseFloat((10000/_price).toFixed(2));
              _pnl = outcome === 'win' ? 100 : parseFloat((-_stake).toFixed(2));
            }
          }
          updateSignal.run(outcome, parseFloat(_pnl.toFixed(2)), sig.id);
          // Runline grading runs independently — only for ML signals,
          // only when the companion outcome is currently un-graded
          // (NULL or 'pending'), and only when a spread snapshot was
          // captured at fire time. Pre-Step-2 ML rows have null
          // companion_spread_line, so calcRunlinePnl returns 'pending'
          // and the row stays untouched.
          if (sig.signal_type !== 'ML') continue;
          if (sig.companion_spread_outcome != null && sig.companion_spread_outcome !== 'pending') continue;
          const r = calcRunlinePnl(sig.signal_side, sig.companion_spread_line, sig.companion_spread_price, _ay, _hy);
          if (r.outcome !== 'pending') updateRunline.run(r.outcome, r.pnl, sig.id);
        }
        // Empirical-spread grading. Before fix/empirical-spread-grading
        // -wiring this never fired from cron: the grader lived only
        // inside processGameSignals's game-final branch, which no cron
        // path invokes after scores land. runScoreJob is the cron that
        // owns the moment scores land — so it now grades the empirical
        // rows directly, same idempotent function as processGameSignals
        // and the backfill endpoint use. Wrapped in its own try/catch
        // so an empirical-side failure can't undo the bet_signals
        // grading the score job already completed for this game.
        try {
          const gradedAt = nowPtIso();
          const r = empiricalSpreadEdge.gradeEmpiricalSpreadOutcomesForGame(db, q, gameRow, gradedAt);
          if (r.graded > 0) {
            console.log('[score-job] empirical-spreads graded ' + r.graded
              + ' row(s) for ' + gameId
              + ' (by track: ' + JSON.stringify(r.byTrack) + ')');
          }
          // ML + totals market captures grade through the same entry
          // point — separate try so an ML/totals grading failure can't
          // undo the spread grading the score job already completed.
          try {
            const empMc = require('./empirical-market-capture');
            const mr = empMc.gradeMarketCapturesForGame(db, q, gameRow, gradedAt);
            if (mr.graded > 0) {
              console.log('[score-job] empirical-market graded ' + mr.graded
                + ' row(s) for ' + gameId
                + ' (by_type=' + JSON.stringify(mr.byType)
                + ', by_outcome=' + JSON.stringify(mr.byOutcome) + ')');
            }
          } catch (mErr) {
            console.warn('[score-job] empirical-market grading failed for '
              + gameId + ' (non-fatal): ' + mErr.message);
          }
        } catch (e) {
          console.warn('[score-job] empirical-spreads grading failed for '
            + gameId + ' (non-fatal): ' + e.message);
        }
        gamesUpdated++;
      }
    }
    // Pull pitcher usage from MLB Stats API and record for fatigue tracking.
    let pitcherRecords = 0;
    try {
      const usage = await fetchPitcherUsage(dateStr);
      for (const u of usage) {
        q.upsertPitcherGameLog.run(
          dateStr, u.team, u.pitcher_name, u.pitcher_mlb_id,
          u.pitches_thrown, u.innings_pitched, u.batters_faced,
          u.was_starter, u.outing_type, 1
        );
        pitcherRecords++;
      }
      console.log('[score-job] Recorded ' + pitcherRecords + ' pitcher appearances for ' + dateStr);
    } catch(e) {
      console.log('[score-job] pitcher-usage fetch failed: ' + e.message);
    }
    q.logCron.run('scores', dateStr, 'success', 'Updated ' + scores.length + ' scores, ' + pitcherRecords + ' pitcher apps', gamesUpdated);
    console.log('[score-job] Done — ' + gamesUpdated + ' games updated');
    return { success: true, gamesUpdated, date: dateStr };
  } catch (err) {
    console.error('[score-job] Error:', err.message);
    q.logCron.run('scores', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}


// Run weather for all games on a given date. Returns { success, updated, date }.
async function runWeatherJob(date) {
  const startTs = Date.now();
  console.log('[weather] running for '+date);
  let updated = 0;
  const skippedIds = [];
  // Per-reason tally so the cron_log row can answer "how many games hit
  // which failure mode" at a glance — exactly the question we couldn't
  // answer when 3 games went stale on 2026-05-01 with no log signal.
  // dome / no_park are deterministic and counted but NOT added to
  // skippedIds (they're not "unexpected misses"); the transient reasons
  // are both counted and listed.
  const skipReasonCounts = {
    dome: 0,
    no_park: 0,
    empty_response: 0,
    bad_index: 0,
    non_finite_value: 0,
    exception: 0,
    retry_succeeded: 0,
  };

  // Helper: write the cron_log row in its own try/catch so a logging
  // failure (e.g. SQLite lock) can never break the actual job. Same
  // guarantee runOddsJob / runLineupJob have via their q.logCron calls.
  const writeCronLog = (status, message) => {
    try {
      q.logCronStructured.run({
        job_type: 'weather',
        run_date: date,
        status,
        message,
        games_updated: updated,
        games_skipped: skippedIds.length,
        games_skipped_ids: skippedIds.join(','),
        skip_reasons: JSON.stringify(skipReasonCounts),
        duration_ms: Date.now() - startTs,
      });
    } catch (e) {
      console.warn('[weather] cron_log write failed (non-fatal): ' + e.message);
    }
  };

  try {
    // Bootstrap statsapi schedule first so any newly-discovered games
    // (e.g. an overnight postponement makeup) get a game_log row before
    // we start fetching weather. Otherwise a brand-new leg would be
    // weatherless until runLineupJob's next cycle.
    await ensureScheduleBootstrap(date);

    // Roof-status pipeline (two independent stages — each in its own
    // try/catch so a failure in one never blocks the other or the
    // weather job). Both run BEFORE the games-read below so any new
    // announced/actual status is in-DB by the time this job reads
    // each game's row.
    //
    // 1) D-backs forward scraper — writes roof_confidence='announced'
    //    for the next homestand at Chase.
    // 2) Universal post-game corrector — for completed games at any of
    //    the 7 roofed parks, reads statsapi's gameData.weather.condition
    //    and writes roof_confidence='actual'. Self-heals any wrong
    //    forward prior or announced value once the game is final.
    //
    // Precedence enforced downstream in fetchAndApply: actual > announced
    // > prior (estimated). The corrector never DOWNGRADES — it only
    // writes 'actual' for completed games with populated conditions.
    try {
      const { runRoofStatusIngest } = require('./roof-ari');
      const roofRes = await runRoofStatusIngest(date);
      if (roofRes && (roofRes.errors || []).length) {
        console.warn('[weather] roof-ari ingest reported errors: '
          + roofRes.errors.join(', ') + ' (weather job continues)');
      }
    } catch (e) {
      console.warn('[weather] roof-ari ingest crashed (non-fatal, weather continues): ' + e.message);
    }
    try {
      const { runRoofStatusCorrect } = require('./roof-correct');
      const corrRes = await runRoofStatusCorrect({ runDate: date });
      if (corrRes && (corrRes.errors || []).length) {
        console.warn('[weather] roof-correct reported errors: '
          + corrRes.errors.join(', ') + ' (weather job continues)');
      }
    } catch (e) {
      console.warn('[weather] roof-correct crashed (non-fatal, weather continues): ' + e.message);
    }

    const games = q.getGamesByDate.all(date);
    if (!games.length) {
      console.log('[weather] no games for '+date);
      writeCronLog('no_games', 'no games on slate');
      return { success: true, updated: 0, date: date, note: 'no games' };
    }
    const { calcWindFactor, PARKS } = require('./weather');
    const { rollForwardPrior, isSealedDome } = require('./roof-prior');
    const settings = getSettings();
    const wobaIdx = getWobaIndex();
    const month = new Date(date).getMonth() + 1;

    // One-shot fetch + write for a single game. Returns:
    //   { ok: true }                       — weather written, signals will rerun
    //   { ok: false, reason, transient }   — skip. transient=true means a
    //                                         retry might help (Open-Meteo
    //                                         returned bad/empty data this
    //                                         attempt). reason ∈
    //                                         { empty_response, bad_index,
    //                                           non_finite_value, exception }.
    // dome / no_park are deterministic and handled by the outer loop.
    const fetchAndApply = async (game, park, gameHour) => {
      try {
        // Cache-bust query param so retries hit the upstream rather than
        // any intermediary cache that returned the bad payload first time.
        const url = 'https://api.open-meteo.com/v1/forecast?latitude='+park.lat+'&longitude='+park.lng
          +'&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability'
          +'&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto'
          +'&start_date='+date+'&end_date='+date+'&_t='+Date.now();
        const wd = await fetch(url, {
          headers: { 'User-Agent': 'mlb-analyzer/1.0 (https://github.com/mikereagan24-sketch/mlb-analyzer)' },
        }).then(r => r.json());
        if (!wd || !wd.hourly || !Array.isArray(wd.hourly.time) || !wd.hourly.time.length) {
          return { ok: false, reason: 'empty_response', transient: true,
                   detail: JSON.stringify(wd).slice(0, 200) };
        }
        const idx = Math.min(gameHour, wd.hourly.time.length - 1);
        if (idx < 0) {
          return { ok: false, reason: 'bad_index', transient: true,
                   detail: 'gameHour=' + gameHour };
        }
        const _speed  = wd.hourly.wind_speed_10m?.[idx];
        const _dir    = wd.hourly.wind_direction_10m?.[idx];
        const _temp   = wd.hourly.temperature_2m?.[idx];
        const _precip = wd.hourly.precipitation_probability?.[idx];
        if (![_speed, _dir, _temp, _precip].every(v => Number.isFinite(v))) {
          return { ok: false, reason: 'non_finite_value', transient: true,
                   detail: 'speed='+_speed+' dir='+_dir+' temp='+_temp+' precip='+_precip };
        }
        const speed = parseFloat(_speed.toFixed(1));
        const dir   = Math.round(_dir);
        const temp  = parseFloat(_temp.toFixed(1));
        const precip = _precip;
        const windFactor = calcWindFactor(dir, speed, park);
        const tempAdj = temp < 55 ? -0.5 : temp < 70 ? 0 : temp < 80 ? 0.3 : 0.6;
        let roofStatus = 'open', roofMult = 1, roofConfidence = 'estimated';
        // Resolution precedence (highest wins): actual > announced > prior
        // (estimated) > config heuristic > default-open.
        //
        //   actual    — written by services/roof-correct.js from statsapi
        //               gameData.weather.condition for completed games.
        //               Ground truth; never overwritten.
        //   announced — written by services/roof-ari.js (D-backs forward
        //               scraper) for the next homestand at Chase.
        //   prior     — services/roof-prior.rollForwardPrior(venue_id, date):
        //               per-park empirical defaults (HOU/TEX/MIA/TOR/MIL/SEA)
        //               for pre-game scoring before announced/actual lands.
        //               Stored at roof_confidence='estimated' so a later
        //               announced or actual wins.
        //   config    — the inert retractable config below; no park
        //               carries roofType, so this branch is dead today
        //               but kept as the documented fallback path.
        const announcedRoof = (game.roof_confidence === 'announced' || game.roof_confidence === 'actual')
          ? (game.roof_status || '').toLowerCase()
          : '';
        if (announcedRoof === 'open' || announcedRoof === 'closed' || announcedRoof === 'partial') {
          roofStatus = announcedRoof;
          roofConfidence = game.roof_confidence;
          roofMult = roofStatus === 'closed' ? 0 : roofStatus === 'partial' ? 0.5 : 1;
        } else {
          // Forward-prior fallback. rollForwardPrior returns null for
          // venues without a rule (ARI venue 15 included — it expects
          // the scraper above; default-open is the preserved old
          // behavior if the scrape failed). For the other 6 roofed
          // venues, the prior is the per-park empirical default.
          const prior = rollForwardPrior(game.venue_id, date);
          if (prior && (prior.status === 'open' || prior.status === 'closed')) {
            roofStatus = prior.status;
            roofConfidence = prior.confidence || 'estimated';
            roofMult = roofStatus === 'closed' ? 0 : 1;
          } else if (park.roofType === 'retractable') {
            let closed = false;
            if (park.defaultClosed) closed = !(temp < park.tempClose && precip < park.precipClose);
            else if (park.closedBehavior === 'rain_only') closed = precip >= park.precipClose;
            else if (park.aprilDefault === 'closed' && month <= 4) closed = !(temp >= park.tempClose && precip < park.precipClose);
            else if (park.closedBehavior === 'hot') closed = temp >= park.tempClose || precip >= park.precipClose;
            else closed = temp < park.tempClose || precip >= park.precipClose;
            roofStatus = closed ? 'closed' : 'open';
            if (park.partialEnclosure && closed) roofStatus = 'partial';
            roofMult = roofStatus === 'closed' ? 0 : roofStatus === 'partial' ? 0.5 : 1;
          }
        }
        // Weather neutralization on CLOSED roofs is gated on the park
        // being a true sealed dome (SEALED_DOME_VENUE_IDS in
        // services/roof-prior.js). Six of the seven retractables are
        // sealed — statsapi shows wind=0 / controlled temp when
        // closed, so effWind / effTemp must be zeroed. SEA (680) is
        // the verified exception: its roof covers but doesn't enclose,
        // so closed SEA games still report real wind (e.g. 12 mph In
        // From LF) and outside-matching temps. At SEA, record the
        // closed status but keep the reported weather applied.
        // Partial-enclosure parks keep the 0.5 multiplier from the
        // config branch.
        const sealedClosed = roofStatus === 'closed' && isSealedDome(game.venue_id);
        const effWind = sealedClosed ? 0 : windFactor * roofMult;
        const effTemp = sealedClosed ? 0 : tempAdj * roofMult;
        if (q.updateWindData) {
          q.updateWindData.run(speed, dir, effWind, temp, effTemp, roofStatus, roofConfidence, date, game.game_id);
        } else {
          db.prepare("UPDATE game_log SET wind_speed=?,wind_dir=?,wind_factor=?,temp_f=?,temp_run_adj=?,roof_status=?,roof_confidence=?,weather_quality='fresh',weather_quality_at=datetime('now') WHERE game_date=? AND game_id=?")
            .run(speed, dir, effWind, temp, effTemp, roofStatus, roofConfidence, date, game.game_id);
        }
        const latestRow = q.getGameById.get(date, game.game_id);
        if (latestRow) processGameSignals(latestRow, wobaIdx, settings);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'exception', transient: true, detail: e.message };
      }
    };

    for (const game of games) {
      const parts = game.game_id.split('-');
      const homeKey = parts[1];
      const park = PARKS[homeKey];
      if (!park) {
        skipReasonCounts.no_park++;
        skippedIds.push(game.game_id);
        console.warn('[weather] '+game.game_id+': no_park (homeKey='+homeKey+')');
        continue;
      }
      if (park.dome) {
        // Domes are deterministically weather-irrelevant; tallied but not
        // listed in skippedIds (which is for unexpected misses we'd want
        // to investigate).
        skipReasonCounts.dome++;
        continue;
      }
      let gameHour = 19;
      if (game.game_time) {
        const m = game.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (m) {
          let h = parseInt(m[1]), ap = m[3].toUpperCase();
          if (ap === 'PM' && h !== 12) h += 12;
          if (ap === 'AM' && h === 12) h = 0;
          gameHour = h;
        }
      }

      let res = await fetchAndApply(game, park, gameHour);
      if (!res.ok && res.transient) {
        // Retry once after 1s. The 2026-05-01 incident (3 games stale at
        // the 7AM PT cron) looked like transient Open-Meteo failures —
        // a single retry would have caught all three. Logging the
        // first-attempt reason so we can tell from cron_log how often
        // retries are actually saving us.
        console.warn('[weather] '+game.game_id+': '+res.reason+' on first attempt, retrying in 1s ('+res.detail+')');
        await new Promise(r => setTimeout(r, 1000));
        res = await fetchAndApply(game, park, gameHour);
        if (res.ok) {
          skipReasonCounts.retry_succeeded++;
        }
      }

      if (res.ok) {
        updated++;
      } else {
        skipReasonCounts[res.reason] = (skipReasonCounts[res.reason] || 0) + 1;
        skippedIds.push(game.game_id);
        console.warn('[weather] '+game.game_id+' final skip: '+res.reason+' ('+(res.detail||'')+')');
      }
    }

    const status = skippedIds.length === 0 ? 'success' : (updated > 0 ? 'partial' : 'error');
    const message = 'updated '+updated+', skipped '+skippedIds.length
      + (skipReasonCounts.retry_succeeded ? ', retries succeeded '+skipReasonCounts.retry_succeeded : '');
    console.log('[weather] ' + message + ' for ' + date);
    writeCronLog(status, message);

    return {
      success: status !== 'error',
      updated,
      skipped: skippedIds.length,
      skipped_ids: skippedIds,
      skip_reasons: skipReasonCounts,
      date,
    };
  } catch(e) {
    console.error('[weather] job error:', e.message);
    writeCronLog('error', 'job threw: ' + e.message);
    return { success: false, error: e.message, updated: updated, date: date };
  }
}

function startCronJobs() {
  // All schedules below run in America/Los_Angeles. The cron hour is the
  // Pacific-time hour; node-cron handles DST transitions automatically.

  // --- Lineups: 8AM, Noon-6PM hourly, 11PM PT (free RotoWire scrapes) ---
  [[8,'8AM'],[12,'Noon'],[13,'1PM'],[14,'2PM'],[15,'3PM'],[16,'4PM'],[17,'5PM'],[18,'6PM']].forEach(([h,label]) => {
    cron.schedule('0 '+h+' * * *', () => {
      console.log('[cron] '+label+' PT lineup pull');
      runLineupJob(todayStr());
    }, { timezone: 'America/Los_Angeles' });
  });
  cron.schedule('0 23 * * *', () => {
    console.log('[cron] 11PM PT lineup pull');
    runLineupJob(todayStr());
  }, { timezone: 'America/Los_Angeles' });

  // --- Odds: 4 pulls today (8AM, 11AM, 3PM, 5PM PT) ---
  // Tomorrow's odds pull is handled by the tomorrow-slate prefetch block below.
  [[8,'8AM'],[11,'11AM'],[15,'3PM'],[17,'5PM']].forEach(([h,label]) => {
    cron.schedule('0 '+h+' * * *', () => {
      console.log('[cron] '+label+' PT odds pull');
      runOddsJob(todayStr());
    }, { timezone: 'America/Los_Angeles' });
  });

  // --- Scores: 4AM PT ---
  cron.schedule('0 4 * * *', () => {
    console.log('[cron] 4AM PT score pull');
    runScoreJob(yesterdayStr());
  }, { timezone: 'America/Los_Angeles' });

  // --- 6AM PT roster refresh: pull active 26-man rosters from statsapi ---
  // Catches IL transitions and activations from the previous day. Runs before
  // the 7AM morning refresh so updated rosters are available when bullpen-
  // aware signals compute. Order on this date: roster → odds → weather →
  // lineups → rerun.
  cron.schedule('0 6 * * *', async () => {
    console.log('[cron] 6AM PT roster refresh');
    try { await runRosterJob(); }
    catch(e) { console.error('[cron-roster] failed:', e && e.message); }
    // Season-cumulative roster (statsapi fullSeason) — backtest-only
    // resolver source. Runs after the active roster so a statsapi
    // hiccup on this call doesn't block tonight's live roster.
    try { await runSeasonRosterJob(); }
    catch(e) { console.error('[cron-roster-season] failed:', e && e.message); }
    // Refresh the trailing-3yr Fielding Run Value after rosters (daily is
    // ample — it's a multi-season aggregate that barely moves day to day).
    // Non-fatal: a Savant hiccup must not abort the morning chain.
    try { await runFieldingFrvJob(); }
    catch(e) { console.error('[cron-frv] failed:', e && e.message); }
    // Team baserunning (FG team-aggregated BsR). Daily snapshot for
    // forward-honest backtests; the live table is also used as the
    // current-state hindsight reference. Non-fatal: an FG hiccup must
    // not abort the morning chain.
    try { await runBaserunningJob(); }
    catch(e) { console.error('[cron-baserunning] failed:', e && e.message); }
    try { await runPlayerBaserunningJob(); }
    catch(e) { console.error('[cron-player-baserunning] failed:', e && e.message); }
    try { await runPlayerBaserunningTrailingJob(); }
    catch(e) { console.error('[cron-player-baserunning-trailing] failed:', e && e.message); }
  }, { timezone: 'America/Los_Angeles' });

  // --- 7AM PT morning refresh: odds -> weather -> lineups -> rerun all games ---
  // Sequential so we don't thrash SQLite or hit rate limits. Catches each step
  // individually so a single failure doesn't abort the rest of the chain.
  cron.schedule('0 7 * * *', async () => {
    const d = todayStr();
    console.log('[cron] 7AM PT morning refresh for ' + d);
    try { await runOddsJob(d); }
    catch(e) { console.error('[cron-refresh] odds failed:', e && e.message); }
    try { await runWeatherJob(d); }
    catch(e) { console.error('[cron-refresh] weather failed:', e && e.message); }
    try { await runLineupJob(d); }
    catch(e) { console.error('[cron-refresh] lineups failed:', e && e.message); }
    // Final rerun of every game on the slate (mirrors POST /games/:date/rerun).
    try {
      const games = q.getGamesByDate.all(d);
      const wobaIdx = getWobaIndex();
      const settings = getSettings();
      let n = 0;
      for (const g of games) {
        try { processGameSignals(g, wobaIdx, settings); n++; }
        catch(e) { console.error('[cron-refresh] rerun skip '+g.game_id+':', e && e.message); }
      }
      console.log('[cron-refresh] complete — reran ' + n + ' of ' + games.length + ' games');
    } catch(e) { console.error('[cron-refresh] rerun loop failed:', e && e.message); }
  }, { timezone: 'America/Los_Angeles' });

  // --- 7:30AM PT morning empirical-spread capture for D+1 ---
  // Fresh projected-lineup capture, parallel ROI track to the existing
  // gametime track. User bets D+1 games 7-10am PT, game-by-game as
  // lines firm; this captures the FIRST-eligible empirical signal per
  // game so the realized CLV vs gametime can be measured later.
  //
  // The chain inside runMorningCaptureJob is lineups → weather → odds
  // → morning-capture, all targeting tomorrowStr(). Each step is
  // non-fatal individually; the morning capture proper still runs even
  // if (e.g.) weather hiccups. Idempotent: re-invoking the same day
  // leaves morning_capture_state.opened_at unchanged and the existing
  // locked rows untouched.
  cron.schedule('30 7 * * *', async () => {
    const d = tomorrowStr();
    console.log('[cron] 7:30AM PT morning empirical-spread capture for ' + d);
    try { await runMorningCaptureJob(d); }
    catch (e) { console.error('[cron-morning-capture] failed:', e && e.message); }
  }, { timezone: 'America/Los_Angeles' });

  // --- 8PM PT tomorrow-slate prefetch ---
  // Pulls odds, weather, and lineups (if available) for tomorrow's date so the
  // UI has fresh data the moment the user switches to tomorrow. Tomorrow's
  // confirmed lineups usually aren't published yet at this hour, but the
  // statsapi schedule bootstrap inside runLineupJob captures schedule + SPs.
  // Open-Meteo serves forecasts 7+ days out. Most books post next-day odds
  // around 6-8PM ET (3-5PM PT), so 8PM PT typically sees full coverage.
  cron.schedule('0 20 * * *', async () => {
    const d = tomorrowStr();
    console.log('[cron] 8PM PT tomorrow-slate prefetch for ' + d);
    // Run sequentially, not in parallel — keeps logs readable and avoids
    // rate-limit collisions across odds/weather/lineup providers.
    try {
      const oddsR    = await runOddsJob(d);
      const weatherR = await runWeatherJob(d);
      const lineupR  = await runLineupJob(d);
      console.log('[cron-prefetch] ' + d
        + ': odds updated ' + ((oddsR && oddsR.updated) || 0)
        + ', weather updated ' + ((weatherR && weatherR.updated) || 0)
        + ', lineups ' + ((lineupR && lineupR.gamesUpdated) || 0));
    } catch (e) {
      console.error('[cron-prefetch] failed:', e && e.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  // --- 11PM PT tomorrow-slate refresh ---
  // Second pass to catch books that posted lines after the 8PM run. Skips
  // the lineup pull — RotoWire rarely has new info between 8PM and 11PM PT
  // and the statsapi schedule was already bootstrapped at 8PM.
  cron.schedule('0 23 * * *', async () => {
    const d = tomorrowStr();
    console.log('[cron] 11PM PT tomorrow-slate refresh for ' + d);
    try {
      const oddsR    = await runOddsJob(d);
      const weatherR = await runWeatherJob(d);
      console.log('[cron-prefetch-refresh] ' + d
        + ': odds updated ' + ((oddsR && oddsR.updated) || 0)
        + ', weather updated ' + ((weatherR && weatherR.updated) || 0));
    } catch (e) {
      console.error('[cron-prefetch-refresh] failed:', e && e.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  console.log('[cron] Scheduled in America/Los_Angeles: lineups 8A + hourly 12-6P + 11P, odds 8A/11A/3P/5P, scores 4A, roster 6A, morning refresh 7A, morning empirical-spread capture 7:30A, tomorrow-slate prefetch 8P + refresh 11P');
}

function gameHasStarted(gameRow, gameDate) {
  // Returns true if game start time has passed (game is live or finished).
  // Only games on TODAY's date (Pacific) can have started. game_time is
  // stored in ET (scraper.fmtET, RotoWire's .lineup__time text); subtract
  // 3 hours before comparing against PT wall-clock.
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
  if (!gameRow || !gameRow.game_time) return false;
  if (gameDate && gameDate !== today) return false; // future/past dates never "in progress"
  const tm = gameRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!tm) return false;
  let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
  if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
  let gameMinsPT = h*60+mn - 3*60;
  if (gameMinsPT < 0) gameMinsPT += 24*60;
  const nowPT=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  const minsToGame=gameMinsPT-(nowPT.getHours()*60+nowPT.getMinutes());
  return minsToGame < -5; // started more than 5 min ago
}

// Plausibility band for market_total. Source-agnostic gate applied
// inside processOddsArray before haveTot is computed — a feed-emitted
// total outside this band is treated as missing rather than written
// straight to game_log. Mirrors what checkOddsSanity (line ~232) does
// for the ML side: refuse to display / bet against a value the data
// itself says is wrong.
//
// Real MLB totals run ~6.5–12.5 (Kalshi's strike ladder is 2.5–12.5
// but the traded band is tighter). 6.0/14.5 is intentionally
// conservative — rejects clear garbage (4.5, 2.5, 20) without ever
// rejecting a legitimate line. The 2026-05-26 MIA@TOR incident
// (market_total=4.5 with -563/+457 prices from the Unabated/OddsAPI
// feed) motivated this; the gate would have nulled the bad row and
// the existing "no sane totals" flag string would have surfaced it.
const TOTAL_MIN_PLAUSIBLE = 6.0;
const TOTAL_MAX_PLAUSIBLE = 14.5;

// Pure post-fetch processing: dedup -> per-game flag build + UPDATE +
// processGameSignals. Extracted from runOddsJob so the snapshot-replay
// endpoint (POST /api/replay/odds) can re-run the same logic against a
// captured upstream payload without hitting Unabated.
function processOddsArray(dateStr, oddsRaw, settings) {
  if (!Array.isArray(oddsRaw)) oddsRaw = [];
  // Deduplicate by game_id — keep first occurrence (Kalshi lines take priority)
  const seen = new Set();
  const odds = oddsRaw.filter(o => { if(seen.has(o.game_id)) return false; seen.add(o.game_id); return true; });
  if(oddsRaw.length !== odds.length) console.log('[odds] Deduped '+oddsRaw.length+' -> '+odds.length+' results');
  const wobaIdx = getWobaIndex();
  let updated = 0;
  // Label-only UPDATE for locked games (see comment block in original site).
  const refreshLockedLabels = db.prepare(`UPDATE game_log SET
    ml_source=?, xcheck_ml_source=?,
    total_source=?, xcheck_total_source=?,
    odds_flagged=?, odds_flag_reason=?,
    updated_at=datetime('now')
    WHERE game_date=? AND game_id=?`);

  for (const o of odds) {
    console.log('[odds-xcheck] ' + o.game_id + ': primary=' + o.market_away_ml + '/' + o.market_home_ml + '(' + o.ml_source + ')' + ' xcheck=' + o.xcheck_away_ml + '/' + o.xcheck_home_ml + '(' + o.xcheck_ml_source + ')');
    const existing = q.getGameById.get(dateStr, o.game_id);

    const haveMarket = o.market_away_ml != null && o.market_home_ml != null;
    const singleSource = haveMarket && (!o.xcheck_ml_source || o.xcheck_ml_source === o.ml_source);
    const reasons = [];
    if (!haveMarket) {
      reasons.push('no sane odds');
    } else if (singleSource) {
      reasons.push('single-source, no cross-check available');
    } else {
      const sanityReason = checkOddsSanity(o.market_away_ml, o.market_home_ml);
      const divergenceReason = checkBookDivergence(
        o.market_away_ml, o.market_home_ml,
        o.xcheck_away_ml, o.xcheck_home_ml,
        o.xcheck_ml_source
      );
      if (sanityReason) reasons.push(sanityReason);
      if (divergenceReason) reasons.push(divergenceReason);
    }

    // Totals plausibility gate. Refuse to surface an implausible
    // market_total (and the prices reported alongside it) — null both
    // sides so the existing "no sane totals" flag fires through the
    // unchanged haveTot path below. Applied symmetrically to xcheck.
    // Source-agnostic: this catches a bad value regardless of which
    // book the feed sourced it from.
    if (o.market_total != null
        && (o.market_total < TOTAL_MIN_PLAUSIBLE || o.market_total > TOTAL_MAX_PLAUSIBLE)) {
      console.warn('[odds] rejecting implausible total for ' + o.game_id
        + ': ' + o.market_total + ' (outside ['
        + TOTAL_MIN_PLAUSIBLE + ', ' + TOTAL_MAX_PLAUSIBLE + ']) — treating as missing');
      o.market_total = null;
      o.over_price = null;
      o.under_price = null;
    }
    if (o.xcheck_total != null
        && (o.xcheck_total < TOTAL_MIN_PLAUSIBLE || o.xcheck_total > TOTAL_MAX_PLAUSIBLE)) {
      console.warn('[odds] rejecting implausible xcheck total for ' + o.game_id
        + ': ' + o.xcheck_total + ' (outside ['
        + TOTAL_MIN_PLAUSIBLE + ', ' + TOTAL_MAX_PLAUSIBLE + ']) — treating as missing');
      o.xcheck_total = null;
      o.xcheck_over_price = null;
      o.xcheck_under_price = null;
    }

    const haveTot = o.market_total != null && o.over_price != null && o.under_price != null;
    const haveXcheckTot = o.xcheck_total != null && o.xcheck_over_price != null && o.xcheck_under_price != null;
    if (!haveTot && !haveXcheckTot) {
      reasons.push('no sane totals: no source provided matching-line O/U');
    } else if (!haveTot && haveXcheckTot) {
      // Post-#230: model.js suppresses the Totals signal entirely when
      // primary is null — xcheck is stored/displayed only, never anchors
      // an edge. Flag text updated to reflect suppression, not xcheck-fallback.
      reasons.push('no primary totals; Totals signal SUPPRESSED (xcheck reference-only)');
    } else if (haveTot && !haveXcheckTot) {
      reasons.push('single-source total, no cross-check available');
    } else if (haveTot && haveXcheckTot) {
      // Project xcheck onto primary's line; flag when projected Δp > 0.08.
      const RUNS_TO_PROB = 0.12;
      const impP = x => x < 0 ? Math.abs(x)/(Math.abs(x)+100) : 100/(x+100);
      const lineDelta = o.market_total - o.xcheck_total;
      const dOver  = Math.abs(impP(o.over_price)  - (impP(o.xcheck_over_price)  - lineDelta * RUNS_TO_PROB));
      const dUnder = Math.abs(impP(o.under_price) - (impP(o.xcheck_under_price) + lineDelta * RUNS_TO_PROB));
      const d = Math.max(dOver, dUnder);
      if (d > 0.08) {
        if (o.market_total !== o.xcheck_total) {
          reasons.push('totals divergence: ' + (o.total_source||'primary') + '=' + o.market_total + '@' + o.over_price + '/' + o.under_price + ', ' + (o.xcheck_total_source||'xcheck') + '=' + o.xcheck_total + '@' + o.xcheck_over_price + '/' + o.xcheck_under_price + ' (Δp=' + d.toFixed(3) + ')');
        } else {
          reasons.push('totals juice divergence: ' + (o.total_source||'primary') + '=' + o.over_price + '/' + o.under_price + ', ' + (o.xcheck_total_source||'xcheck') + '=' + o.xcheck_over_price + '/' + o.xcheck_under_price + ' (Δp=' + d.toFixed(3) + ')');
        }
      }
    }
    const oddsReason = reasons.length ? reasons.join(' | ') : null;
    const oddsFlagged = oddsReason ? 1 : 0;
    if (oddsReason) console.warn('[odds-sanity] ' + dateStr + '/' + o.game_id + ': ' + oddsReason);

    if (existing && existing.odds_locked_at) {
      refreshLockedLabels.run(
        o.ml_source || null, o.xcheck_ml_source || null,
        o.total_source || null, o.xcheck_total_source || null,
        oddsFlagged, oddsReason,
        dateStr, o.game_id
      );
      console.log('[odds] Locked '+o.game_id+': refreshed source labels (prices frozen)');
      continue;
    }
    if (existing && gameHasStarted(existing, dateStr)) {
      db.prepare("UPDATE game_log SET odds_locked_at=datetime('now') WHERE game_date=? AND game_id=? AND odds_locked_at IS NULL").run(dateStr, o.game_id);
      console.log('[odds] Skipping started game: '+o.game_id);
      const mlSigsO = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type='ML' AND closing_line IS NULL").all(dateStr, o.game_id);
      for (const sig of mlSigsO) {
        const closingLine = sig.signal_side === 'away' ? o.market_away_ml : o.market_home_ml;
        const clv = calcCLV(sig.bet_line, closingLine);
        db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closingLine, clv, sig.id);
        try {
          q.insertBetSignalAudit({
            signal_id: sig.id,
            game_date: dateStr,
            game_id: o.game_id,
            signal_type: sig.signal_type,
            signal_side: sig.signal_side,
            action: 'set_closing_line',
            bet_line: sig.bet_line,
            closing_line: closingLine,
            clv: clv,
            source: 'cron_closing_lock',
            detail: 'odds-job started-game close',
          });
        } catch(e) { /* audit failure must not block lifecycle */ }
      }
      refreshLockedLabels.run(
        o.ml_source || null, o.xcheck_ml_source || null,
        o.total_source || null, o.xcheck_total_source || null,
        oddsFlagged, oddsReason,
        dateStr, o.game_id
      );
      continue;
    }
    // Null-write rule (PR #10 pattern): values flow through transparently so
    // a transient null isn't masked. Pre-lock provenance labels (ml_source,
    // xcheck_ml_source, xcheck_total_source) keep COALESCE so a single null
    // fetch on a near-locked game doesn't lose the correct source label.
    // Step 1 runline ingest (PR #spread-ingest): write market_*_spread,
    // *_spread_price, *_spread_quality, market_spread_src in the same
    // odds-write transaction. Quality flips to 'fresh' on a non-null
    // write and falls back to null otherwise so a transient miss doesn't
    // mask staleness. The 0→null cleanup mirrors the lineup-job pattern
    // for ML — an American-odds value of 0 doesn't exist; treat as null.
    const _awaySpread       = o.market_away_spread != null ? o.market_away_spread : null;
    const _homeSpread       = o.market_home_spread != null ? o.market_home_spread : null;
    const _awaySpreadPrice  = (o.market_away_spread_price != null && o.market_away_spread_price !== 0) ? o.market_away_spread_price : null;
    const _homeSpreadPrice  = (o.market_home_spread_price != null && o.market_home_spread_price !== 0) ? o.market_home_spread_price : null;
    const _awaySpreadQual   = (_awaySpread != null && _awaySpreadPrice != null) ? 'fresh' : null;
    const _homeSpreadQual   = (_homeSpread != null && _homeSpreadPrice != null) ? 'fresh' : null;
    db.prepare(`UPDATE game_log SET
      market_away_ml=?, market_home_ml=?,
      market_total=?, over_price=?, under_price=?, total_source=?,
      kalshi_implied_total=COALESCE(?, kalshi_implied_total),
      ml_source=COALESCE(?, ml_source),
      xcheck_ml_source=COALESCE(?, xcheck_ml_source),
      xcheck_away_ml=?, xcheck_home_ml=?,
      xcheck_total=?,
      xcheck_over_price=?,
      xcheck_under_price=?,
      xcheck_total_source=COALESCE(?, xcheck_total_source),
      unabated_away_ml=?, unabated_home_ml=?, unabated_ml_source=?,
      unabated_total=?, unabated_over_price=?, unabated_under_price=?,
      unabated_total_source=?,
      market_away_spread=?, market_home_spread=?,
      market_away_spread_price=?, market_home_spread_price=?,
      market_away_spread_quality=?, market_home_spread_quality=?,
      market_spread_src=COALESCE(?, market_spread_src),
      odds_flagged=?, odds_flag_reason=?,
      odds_quality='fresh', odds_quality_at=datetime('now'),
      updated_at=datetime('now')
      WHERE game_date=? AND game_id=?`)
      .run(o.market_away_ml, o.market_home_ml,
           o.market_total, o.over_price, o.under_price, o.total_source || null,
           o.kalshi_implied_total != null ? o.kalshi_implied_total : null,
           o.ml_source || null,
           o.xcheck_ml_source || null,
           o.xcheck_away_ml != null ? o.xcheck_away_ml : null,
           o.xcheck_home_ml != null ? o.xcheck_home_ml : null,
           o.xcheck_total != null ? o.xcheck_total : null,
           o.xcheck_over_price != null ? o.xcheck_over_price : null,
           o.xcheck_under_price != null ? o.xcheck_under_price : null,
           o.xcheck_total_source || null,
           o.unabated_away_ml != null ? o.unabated_away_ml : null,
           o.unabated_home_ml != null ? o.unabated_home_ml : null,
           o.unabated_ml_source || null,
           o.unabated_total != null ? o.unabated_total : null,
           o.unabated_over_price != null ? o.unabated_over_price : null,
           o.unabated_under_price != null ? o.unabated_under_price : null,
           o.unabated_total_source || null,
           _awaySpread, _homeSpread,
           _awaySpreadPrice, _homeSpreadPrice,
           _awaySpreadQual, _homeSpreadQual,
           o.market_spread_src || null,
           oddsFlagged, oddsReason,
           dateStr, o.game_id);
    const gameRow = q.getGameById.get(dateStr, o.game_id);
    if (gameRow) { processGameSignals(gameRow, wobaIdx, settings); updated++; }
  }
  return { updated, source: odds.length ? (odds[0].source || 'odds') : 'no source' };
}

// opts.skipChainedMorningCapture (default false): when set, runOddsJob
// does NOT chain a runMorningCaptureJob call onto its completion. Set
// to true by runMorningCaptureJob's own internal chain so the
// odds-job-finishes → morning-capture path doesn't recurse forever.
// All other callers (the 8/11/3/5 PT cron schedules, the 8PM/11PM
// tomorrow-slate prefetches, the morning refresh, and manual rerun
// endpoints) leave it false so a successful odds-job run triggers a
// morning-capture attempt against the same date. First-eligible lock
// inside generateMorningCapture means already-locked games skip;
// newly-eligible games lock at the first odds-job pass after Kalshi
// posts their D+1 spread markets (typically 14:30-21:30 UTC on D-1
// per the eligibility funnel finding, so the 3PM PT and 5PM PT odds
// passes are the practical lock points).
async function runOddsJob(dateStr, opts) {
  dateStr = dateStr || todayStr();
  opts = opts || {};
  try {
    const settings = getSettings();

    // Bootstrap statsapi schedule first. statsapi is the sole source of
    // truth for which games exist on the slate — the "game universe" is
    // defined here, not by any book.
    const scheduleRows = await ensureScheduleBootstrap(dateStr);

    // ====================================================================
    // Complete the 2026-07-10 demote (fix/complete-demote-seed-oddsraw-
    // from-schedule, 2026-07-22).
    //
    // The original demote moved Unabated out of the BETTING PATH as a
    // PRICE source (market_*_ml / market_total / over_price / under_price
    // now had to come from Kalshi or Poly). But Unabated still defined
    // the SHAPE of oddsRaw — Kalshi-direct override below only writes
    // into a pre-existing oddsRaw entry, so any game Unabated didn't
    // return silently escaped every override. Diagnosis on the
    // 2026-07-22 BAL@BOS and PIT@NYY doubleheaders confirmed the case:
    // Poly priced both nightcaps, Kalshi had partial coverage, but
    // Unabated hadn't returned the -g2 entries, so market_*_ml stayed
    // NULL on both game_log rows. Separately, Poly had NO write path
    // to game_log.market_*_ml at all — it fed processGameSignals'
    // in-memory venue baseline but never round-tripped to the row.
    //
    // New sequencing:
    //   1. SEED oddsRaw from scheduleRows — statsapi defines the universe.
    //   2. Fetch Unabated (or fall back to Odds-API) into unabatedRows.
    //   3. MERGE Unabated into pre-seeded oddsRaw, writing ONLY to the
    //      unabated_*/xcheck_* columns per the demote ruling. Never
    //      touches market_*_ml.
    //   4. Kalshi-direct override (below) writes market_*_ml from Kalshi.
    //   5. Poly-direct override (new, below) writes market_*_ml from
    //      Poly for any row Kalshi didn't cover.
    //   6. Coverage instrumentation logs any scheduled game with NULL
    //      market_*_ml after all overrides (permanent visibility).
    //
    // The old "demote loop" (NULL market_*_ml on Unabated rows) and the
    // "statsapi-authoritative gate" (drop Unabated rows not in schedule)
    // are both replaced by construction — oddsRaw is seeded with NULL
    // market_*_ml and only contains schedule game_ids to begin with.
    // ====================================================================
    let oddsRaw = scheduleRows.map(g => ({
      game_id:               g.game_id,
      awayTeam:              g.away_team,
      homeTeam:              g.home_team,
      // Price fields all start NULL. Kalshi/Poly overrides fill them.
      market_away_ml:        null,
      market_home_ml:        null,
      market_total:          null,
      over_price:            null,
      under_price:           null,
      ml_source:             null,
      total_source:          null,
      // xcheck_* + unabated_* + spread — filled from Unabated below.
      xcheck_away_ml:        null,
      xcheck_home_ml:        null,
      xcheck_total:          null,
      xcheck_over_price:     null,
      xcheck_under_price:    null,
      xcheck_ml_source:      null,
      xcheck_total_source:   null,
      unabated_away_ml:      null,
      unabated_home_ml:      null,
      unabated_ml_source:    null,
      unabated_total:        null,
      unabated_over_price:   null,
      unabated_under_price:  null,
      unabated_total_source: null,
      market_away_spread:    null,
      market_home_spread:    null,
      market_away_spread_price: null,
      market_home_spread_price: null,
      market_spread_src:     null,
    }));
    console.log('[odds] seeded oddsRaw from ' + scheduleRows.length + ' scheduled games');

    // Fetch Unabated (or fall back to Odds-API). unabatedRows carry the
    // pre-demote market_*_ml — routed into unabated_*/xcheck_* on merge.
    let unabatedRows = [];
    try {
      console.log('[odds] Fetching from Unabated...');
      const unabatedRawJson = await fetchUnabatedRaw();
      writeSnapshot('odds', dateStr, unabatedRawJson);
      unabatedRows = parseUnabatedOdds(unabatedRawJson, dateStr);
      console.log('[odds] Unabated returned '+unabatedRows.length+' games');
      if (!unabatedRows.length) throw new Error('Unabated returned 0 games');
    } catch(e) {
      console.log('[odds] Unabated failed: '+e.message+' → falling back to Odds API');
      try {
        unabatedRows = await fetchOddsAPI(settings.odds_api_key, dateStr);
      } catch(e2) {
        console.log('[odds] Odds API also failed: '+e2.message);
        unabatedRows = []; // proceed with pure-Kalshi/Poly slate
      }
    }

    // Merge Unabated data into seeded oddsRaw by game_id. Only writes to
    // unabated_*/xcheck_* + reference spread fields — never touches
    // market_*_ml, per demote. Phantom game_ids (in Unabated but not
    // statsapi) get rejected — replaces the old validIds gate.
    {
      const seededById = new Map();
      for (const o of oddsRaw) seededById.set(o.game_id, o);
      let mergedCount = 0, phantomCount = 0;
      for (const u of unabatedRows) {
        const o = seededById.get(u.game_id);
        if (!o) {
          console.warn('[unabated] rejecting phantom matchup not in statsapi: ' + u.game_id);
          phantomCount++;
          continue;
        }
        o.unabated_away_ml     = u.market_away_ml != null ? u.market_away_ml : null;
        o.unabated_home_ml     = u.market_home_ml != null ? u.market_home_ml : null;
        o.unabated_ml_source   = u.ml_source || null;
        o.unabated_total       = u.market_total != null ? u.market_total : null;
        o.unabated_over_price  = u.over_price != null ? u.over_price : null;
        o.unabated_under_price = u.under_price != null ? u.under_price : null;
        o.unabated_total_source = u.total_source || null;
        // xcheck_* — Unabated's second-priority sportsbook. Preserved so
        // the totals-divergence flag in processOddsArray still fires
        // against Kalshi/Poly-primary.
        o.xcheck_away_ml      = u.xcheck_away_ml != null ? u.xcheck_away_ml : null;
        o.xcheck_home_ml      = u.xcheck_home_ml != null ? u.xcheck_home_ml : null;
        o.xcheck_total        = u.xcheck_total != null ? u.xcheck_total : null;
        o.xcheck_over_price   = u.xcheck_over_price != null ? u.xcheck_over_price : null;
        o.xcheck_under_price  = u.xcheck_under_price != null ? u.xcheck_under_price : null;
        o.xcheck_ml_source    = u.xcheck_ml_source || null;
        o.xcheck_total_source = u.xcheck_total_source || null;
        // Runline / spread reference — Unabated is the current source.
        o.market_away_spread       = u.market_away_spread != null ? u.market_away_spread : null;
        o.market_home_spread       = u.market_home_spread != null ? u.market_home_spread : null;
        o.market_away_spread_price = u.market_away_spread_price != null ? u.market_away_spread_price : null;
        o.market_home_spread_price = u.market_home_spread_price != null ? u.market_home_spread_price : null;
        o.market_spread_src        = u.market_spread_src || null;
        mergedCount++;
      }
      console.log('[odds] Unabated merged into ' + mergedCount + ' scheduled game(s)'
        + (phantomCount ? ', ' + phantomCount + ' phantom(s) rejected' : ''));
    }

    // Kalshi-direct ML override (gated). When kalshi_direct_primary_enabled
    // is on, fetch pre-game MLB moneylines directly from Kalshi and
    // OVERRIDE the ML fields of any oddsRaw row Kalshi covers. The
    // Unabated/OddsAPI rows remain in oddsRaw with their totals/spreads
    // intact — Kalshi-direct is ML-only for now. Games Kalshi doesn't
    // cover flow through unmodified, so the existing fetch IS the backup.
    //
    // Guardrails:
    //   - Locked rows (odds_locked_at set) are skipped — locked line wins.
    //   - Kalshi game_ids not in oddsRaw are LOGGED and SKIPPED, not
    //     injected (statsapi/oddsRaw is authoritative for which games
    //     exist; mirrors the phantom gate above).
    //   - LOUD ON EMPTY: Kalshi returned data but matched zero oddsRaw
    //     rows → WARN (likely a game_id mapping break), then proceed
    //     unmodified.
    //   - Whole block try/catch'd: any failure logs and falls through.
    //     Kalshi-direct must never break the odds job.
    if (settings.KALSHI_DIRECT_PRIMARY_ENABLED) {
      try {
        const kalshiRows = await getKalshiMlbLines(dateStr);
        if (!kalshiRows.length) {
          console.log('[odds] Kalshi-direct: no pre-game markets returned for ' + dateStr);
        } else {
          // Fee-adjust Kalshi's raw ask to the all-in price the bettor
          // actually pays: convert American → implied prob C, add Kalshi's
          // per-contract taker fee rate (0.068 * C * (1 - C), single-sourced
          // from kalshi.js's KALSHI_FEE_COEF), convert back to American.
          // Verified against three live slates (DET@BAL 117/-117 → 109/-125,
          // CWS@SF -104/-100 → -111/-107, PIT@TOR 138/-144 → 129/-154).
          //
          // ---- CLV IMPACT — KNOWN, ACCEPTED ----
          // market_*_ml here is the FEE-ADJUSTED Kalshi price (per
          // kalshi_direct_primary), NOT the raw market. The CLV / closing-
          // line computation in this same file (see the closing-lock branch
          // around line ~1151, calcCLV call) reads market_*_ml as the
          // closing line, so CLV is therefore computed against a fee-loaded
          // number rather than the true market close — systematically
          // inflating CLV by roughly the fee. This change does NOT fix
          // CLV; it just documents that the inflation is a deliberate
          // consequence of storing the all-in line everywhere. See
          // feat/kalshi-fee-adjusted-lines.
          function feeAdjustAmerican(ml) {
            if (typeof ml !== 'number' || !Number.isFinite(ml)) return ml;
            const C = ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
            // Skip on degenerate inputs: C*(1-C) → 0 at the extremes so
            // the adjustment is tiny anyway, and the inversion back through
            // probToAmerican is float-fragile near the boundaries.
            if (!(C > 0.001 && C < 0.999)) return ml;
            const adj = C + kalshiTakerFeeRate(C);
            if (!(adj > 0.001 && adj < 0.999)) return ml;
            // Compute American odds at 2-decimal precision before final
            // rounding, then subtract 0.5 toward the bettor-unfavorable
            // direction so the stored value never overstates the price
            // available on Kalshi. Pre-change this rounded the raw float
            // directly, which could land up to 0.5 cents in the bettor's
            // favor; the half-cent subtraction guarantees the integer
            // sits at or below what Kalshi would actually transact.
            if (adj >= 0.5) {
              const americanFloat = -(100 * adj / (1 - adj));
              const twoDecimal = Math.round(americanFloat * 100) / 100;
              return Math.round(twoDecimal - 1.0);
            } else {
              const americanFloat = 100 * (1 - adj) / adj;
              const twoDecimal = Math.round(americanFloat * 100) / 100;
              return Math.round(twoDecimal - 1.0);
            }
          }
          const oddsById = new Map();
          for (const o of oddsRaw) oddsById.set(o.game_id, o);
          let overridden = 0, skippedLocked = 0, missingFromOdds = 0;
          // Snapshot rows accumulated regardless of override/lock fate
          // — observation of Kalshi's ML market for the CLV close
          // fallback in services/empirical-spread-roi.js. Mirrors the
          // spreads snapshot's "capture everything Kalshi shows"
          // convention. Fee-adjusted values stored, same shift as
          // game_log.
          const mlSnapshotRows = [];
          for (const k of kalshiRows) {
            // Prefer the game_id the Kalshi client emits — it includes the
            // doubleheader nightcap suffix (e.g. "stl-cin-g2") that the
            // rest of the system uses in game_log. makeGameId(team, team)
            // produces only the unsuffixed form, which would map a G2
            // event onto game 1's row. Fall back to makeGameId for the
            // single-game case if k.game_id is ever absent — defensive
            // against an older Kalshi-client build that doesn't emit it.
            const gameId = k.game_id || makeGameId(k.away_team, k.home_team);
            const awayFeeMl = feeAdjustAmerican(k.away.ask_ml);
            const homeFeeMl = feeAdjustAmerican(k.home.ask_ml);
            // Snapshot every Kalshi row, locked or not, in-oddsRaw or
            // not. The snapshot is independent observation; the lock
            // only blocks the game_log override below.
            mlSnapshotRows.push({
              game_date: dateStr, game_id: gameId,
              away_ask_dollars: k.away.ask_dollars,
              home_ask_dollars: k.home.ask_dollars,
              away_ask_ml: awayFeeMl,
              home_ask_ml: homeFeeMl,
              volume_24h_away: k.volume_24h_away,
              volume_24h_home: k.volume_24h_home,
            });
            const o = oddsById.get(gameId);
            if (!o) {
              console.warn('[odds] Kalshi-direct: ' + gameId
                + ' not in oddsRaw — skipping (oddsRaw is authoritative for which games exist)');
              missingFromOdds++;
              continue;
            }
            const existing = q.getGameById.get(dateStr, gameId);
            if (existing && existing.odds_locked_at) {
              skippedLocked++;
              continue;
            }
            // ML override only. Totals, spreads, sources for non-ML markets,
            // and every other field stay as Unabated/OddsAPI set them. ML
            // values are FEE-ADJUSTED (see CLV note above the helper).
            o.market_away_ml = awayFeeMl;
            o.market_home_ml = homeFeeMl;
            o.ml_source = 'kalshi';
            overridden++;
          }
          const backupCount = oddsRaw.length - overridden;
          console.log('[odds] Kalshi-direct: ' + overridden + ' game(s) overridden, '
            + backupCount + ' from backup (unabated/oddsapi)'
            + (skippedLocked ? ', ' + skippedLocked + ' locked (skipped)' : '')
            + (missingFromOdds ? ', ' + missingFromOdds + ' kalshi-only (skipped, not in oddsRaw)' : ''));
          if (overridden === 0 && missingFromOdds > 0) {
            console.warn('[odds] Kalshi-direct: ' + kalshiRows.length
              + ' Kalshi game(s) returned but ZERO matched oddsRaw game_ids — mapping likely broken'
              + ' (check abbr normalization in services/kalshi.js). Proceeding with unmodified oddsRaw.');
          }

          // PT-anchored ML snapshot — matches the spreads snapshot tz
          // convention. Non-fatal: snapshot failure must not block the
          // ML override above. CLV-only consumer.
          try {
            const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            q.snapshotKalshiMlMarkets(snapDate, mlSnapshotRows);
            console.log('[odds-snapshot] Kalshi ML: captured ' + mlSnapshotRows.length
              + ' rows for ' + snapDate);
          } catch (e) {
            console.warn('[odds-snapshot] Kalshi ML snapshot failed (non-fatal): ' + e.message);
          }
        }
      } catch (e) {
        console.warn('[odds] Kalshi-direct override failed (non-fatal, falling through): ' + e.message);
      }
    }

    // ====================================================================
    // Poly-direct ML override (fix/complete-demote-seed-oddsraw-from-
    // schedule, 2026-07-22). Completes the 2026-07-10 demote by giving
    // Poly a WRITE PATH to game_log.market_*_ml. Kalshi ran first above;
    // Poly fills any oddsRaw row Kalshi left NULL. Ranking: Kalshi wins
    // when both have coverage (matches the pre-existing venue-aware
    // baseline preference for Kalshi's on-shore market when available).
    //
    // Poly is DH-aware since fix/dh-odds-poly-and-oddsapi (PR #183) —
    // getPolymarketMlbLines returns distinct rows per DH leg with
    // -g{N}-suffixed game_ids that match statsapi/game_log.
    //
    // Guardrails: match the Kalshi-direct block.
    //   - Locked games (odds_locked_at set) skipped.
    //   - Poly game_ids not in oddsRaw (i.e. not in statsapi schedule)
    //     LOGGED and SKIPPED — statsapi is authoritative.
    //   - Whole block try/catch'd: any failure logs and falls through.
    //
    // ---- CLV IMPACT — MATCHES KALSHI PATH ----
    // Poly top-of-book ask is fee-adjusted through polyTakerFeeRate so
    // the stored market_*_ml is the all-in price the bettor pays.
    // Symmetric with Kalshi's stored fee-adjusted values, so downstream
    // CLV computation stays consistent across sources. Same known-and-
    // accepted CLV inflation noted on the Kalshi-direct helper.
    //
    // Totals are NOT written here — Poly totals require per-strike book
    // walking that's already done by odds-comparison.js's runComparison
    // for the venue-aware signal path. Adding a slate-level Poly totals
    // write is a follow-up (needs a rung-pick + fee handling story).
    // Totals-only games where Kalshi doesn't cover will still surface
    // NULL market_total, same as pre-fix.
    // ====================================================================
    try {
      const polyRows = await getPolymarketMlbLines(dateStr);
      if (!polyRows.length) {
        console.log('[odds] Poly-direct: no markets returned for ' + dateStr);
      } else {
        // Fee-adjust a Poly top-of-book raw price (0-1 dollar) to an
        // integer American ML matching Kalshi's stored convention.
        function polyFeeAdjustAmerican(topAskPrice) {
          const C = Number(topAskPrice);
          if (!Number.isFinite(C) || !(C > 0.001 && C < 0.999)) return null;
          const adj = C + polyTakerFeeRate(C);
          if (!(adj > 0.001 && adj < 0.999)) return null;
          if (adj >= 0.5) {
            const americanFloat = -(100 * adj / (1 - adj));
            const twoDecimal    = Math.round(americanFloat * 100) / 100;
            return Math.round(twoDecimal - 1.0);
          } else {
            const americanFloat = 100 * (1 - adj) / adj;
            const twoDecimal    = Math.round(americanFloat * 100) / 100;
            return Math.round(twoDecimal - 1.0);
          }
        }
        const oddsById = new Map();
        for (const o of oddsRaw) oddsById.set(o.game_id, o);
        let wrote = 0, skippedLocked = 0, skippedHaveKalshi = 0, missingFromSchedule = 0;
        for (const p of polyRows) {
          if (!p.game_id) continue;
          const o = oddsById.get(p.game_id);
          if (!o) {
            console.warn('[odds] Poly-direct: ' + p.game_id
              + ' not in statsapi schedule — skipping');
            missingFromSchedule++;
            continue;
          }
          const existing = q.getGameById.get(dateStr, p.game_id);
          if (existing && existing.odds_locked_at) {
            skippedLocked++;
            continue;
          }
          // Kalshi wrote first — only fill when it left the field NULL.
          if (o.market_away_ml != null || o.market_home_ml != null) {
            skippedHaveKalshi++;
            continue;
          }
          const awayTopPrice = p.away && p.away.top_ask && p.away.top_ask.price;
          const homeTopPrice = p.home && p.home.top_ask && p.home.top_ask.price;
          const awayMl = polyFeeAdjustAmerican(awayTopPrice);
          const homeMl = polyFeeAdjustAmerican(homeTopPrice);
          if (awayMl == null || homeMl == null) {
            console.warn('[odds] Poly-direct: ' + p.game_id
              + ' top-of-book incomplete (away=' + awayTopPrice
              + ' home=' + homeTopPrice + ') — skipping');
            continue;
          }
          o.market_away_ml = awayMl;
          o.market_home_ml = homeMl;
          o.ml_source = 'polymarket';
          wrote++;
        }
        console.log('[odds] Poly-direct ML: ' + wrote + ' game(s) written'
          + (skippedLocked ? ', ' + skippedLocked + ' locked (skipped)' : '')
          + (skippedHaveKalshi ? ', ' + skippedHaveKalshi + ' had Kalshi (skipped)' : '')
          + (missingFromSchedule ? ', ' + missingFromSchedule + ' not in statsapi (skipped)' : ''));
      }
    } catch (e) {
      console.warn('[odds] Poly-direct override failed (non-fatal, falling through): ' + e.message);
    }

    // ====================================================================
    // Coverage instrumentation. Permanent visibility into which scheduled
    // games are still missing market_*_ml after every override has run.
    // Complements the Kalshi/Poly per-block WARN lines with a single
    // slate-level summary that's grep-friendly. Any [odds-coverage] MISS
    // line is a scheduled game the model can't emit an ML signal on.
    // ====================================================================
    {
      const misses = oddsRaw.filter(o => o.market_away_ml == null || o.market_home_ml == null);
      console.log('[odds-coverage] ' + dateStr + ': '
        + (oddsRaw.length - misses.length) + '/' + oddsRaw.length
        + ' scheduled games have market_*_ml populated');
      for (const o of misses) {
        console.warn('[odds-coverage] MISS ' + dateStr + '/' + o.game_id
          + ' — market_away_ml=' + o.market_away_ml
          + ' market_home_ml=' + o.market_home_ml
          + ' unabated_away_ml=' + o.unabated_away_ml
          + ' unabated_home_ml=' + o.unabated_home_ml);
      }
    }

    // Kalshi-direct SPREADS ingest. Independent of the ML / Totals
    // overrides above — runs every odds-job regardless of the
    // KALSHI_DIRECT_PRIMARY_ENABLED / KALSHI_DIRECT_TOTALS_ENABLED
    // flags. INGEST ONLY: rows land in kalshi_spread_markets and a
    // PT-anchored snapshot mirror; nothing in the model consumes
    // them. Pulling the full Kalshi spread ladder per game (~10-12
    // markets per event) is forward prep for value analysis once
    // the model supports margin distributions. Non-fatal: a Kalshi
    // hiccup must not abort the rest of runOddsJob.
    try {
      const kalshiSpreads = await getKalshiMlbSpreads(dateStr);
      if (!kalshiSpreads.length) {
        console.log('[odds] Kalshi spreads: no pre-game markets returned for ' + dateStr);
      } else {
        // Fee + shift adjustment for Kalshi spread asks. Identical
        // math to the ML override's feeAdjustAmerican (~line 2669):
        // convert American → implied prob, add Kalshi's per-contract
        // taker fee, convert back to American at 2-decimal precision,
        // subtract 1.0 (bettor-unfavorable shift to match screen),
        // round to integer. Duplicated rather than shared so the
        // spread block stays self-contained.
        function feeAdjustAmericanSpread(ml) {
          if (typeof ml !== 'number' || !Number.isFinite(ml)) return ml;
          const C = ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
          if (!(C > 0.001 && C < 0.999)) return ml;
          const adj = C + kalshiTakerFeeRate(C);
          if (!(adj > 0.001 && adj < 0.999)) return ml;
          if (adj >= 0.5) {
            const americanFloat = -(100 * adj / (1 - adj));
            const twoDecimal = Math.round(americanFloat * 100) / 100;
            return Math.round(twoDecimal - 1.0);
          } else {
            const americanFloat = 100 * (1 - adj) / adj;
            const twoDecimal = Math.round(americanFloat * 100) / 100;
            return Math.round(twoDecimal - 1.0);
          }
        }
        const upsertSpread = db.prepare(
          "INSERT OR REPLACE INTO kalshi_spread_markets "
          + "(game_date, game_id, spread_team, spread_line, "
          + " yes_ask_dollars, yes_bid_dollars, no_ask_dollars, no_bid_dollars, "
          + " yes_ask_ml, no_ask_ml, volume_24h, event_ticker, ticker, updated_at) "
          + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))"
        );
        // Project each spread market through fee+shift on the
        // American asks. The snapshot mirror uses the same projection
        // (so snapshot rows match live rows column-for-column).
        const projectedRows = kalshiSpreads.map(s => Object.assign({}, s, {
          yes_ask_ml: feeAdjustAmericanSpread(s.yes_ask_ml),
          no_ask_ml:  s.no_ask_ml == null ? null : feeAdjustAmericanSpread(s.no_ask_ml),
        }));
        let spreadsInserted = 0;
        const insertTx = db.transaction((rows) => {
          for (const s of rows) {
            upsertSpread.run(
              s.game_date, s.game_id, s.spread_team, Number(s.spread_line),
              s.yes_ask_dollars, s.yes_bid_dollars, s.no_ask_dollars, s.no_bid_dollars,
              s.yes_ask_ml, s.no_ask_ml, s.volume_24h, s.event_ticker, s.ticker
            );
            spreadsInserted++;
          }
        });
        insertTx(projectedRows);
        console.log('[odds] Kalshi-direct spreads: ' + spreadsInserted
          + ' market(s) upserted across ' + new Set(projectedRows.map(s => s.game_id)).size + ' game(s)');

        // PT-anchored snapshot — matches the wOBA / framing / FRV
        // snapshot timezone convention (America/Los_Angeles since
        // commit 5452e09). Non-fatal: snapshot failure must not
        // block the live spread upsert above.
        try {
          const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
          q.snapshotKalshiSpreads(snapDate, projectedRows);
          console.log('[odds-snapshot] Kalshi spreads: captured ' + projectedRows.length
            + ' rows for ' + snapDate);
        } catch (e) {
          console.warn('[odds-snapshot] Kalshi spreads snapshot failed (non-fatal): ' + e.message);
        }
      }
    } catch (e) {
      console.warn('[odds] Kalshi spreads ingest failed (non-fatal): ' + e.message);
    }

    // Empirical-spread signal generation. Runs immediately after the
    // Kalshi spread ingest so the cell-distribution lookup sees the
    // freshest spread prices. INGEST ONLY — writes to
    // empirical_spread_signals (one row per game per job pass) and
    // empirical_spread_outcomes (one row per prediction per job pass;
    // graded later by processGameSignals when scores arrive). Always
    // writes capture_track='gametime' — the morning track is handled
    // by runMorningCaptureJob() further down. Does NOT touch
    // bet_signals, model output, or any production signal table.
    // Non-fatal: a failure here logs a warning and continues.
    try {
      const empOut = empiricalSpreadEdge.generateEmpiricalSpreadSignals(db, dateStr);
      const empSignals = empOut.signals || [];
      if (!empSignals.length) {
        console.log('[empirical-spreads] no games with spread coverage for ' + dateStr);
      } else {
        // Per-pass timestamp. Stored once so all rows in this pass
        // share the same generated_at and group cleanly in the PK.
        // PT-anchored via nowPtIso() — matches the snapshot tables'
        // PT convention. [tz cutover: 2026-06-08]
        const generatedAt = nowPtIso();
        const persisted = empiricalSpreadEdge.persistEmpiricalSpreadSignals(
          db, q, empSignals, 'gametime', generatedAt
        );
        console.log('[empirical-spreads] gametime: ' + persisted.written
          + ' signal(s) at ' + generatedAt
          + ' (cell sample base: ' + empOut.cellIndex.totalGraded + ' graded games)');
      }
    } catch (e) {
      console.warn('[empirical-spreads] generation failed (non-fatal): ' + e.message);
    }

    // ML + totals gametime market capture (feat/morning-capture-ml-totals).
    // Parallel to the spread gametime generation above. Each odds-job
    // pass writes a fresh per-market snapshot using INSERT OR REPLACE
    // so the LATEST generated_at per (game, market_type, 'gametime')
    // is the close-at-first-pitch the CLV readout's gametime-sibling
    // lookup will use. Non-fatal — a failure here must not break the
    // odds job's success state.
    try {
      const empiricalMarketCapture = require('./empirical-market-capture');
      const generatedAt = nowPtIso();
      const mc = empiricalMarketCapture.generateMarketCapture(
        db, q, dateStr, 'gametime', generatedAt);
      if (mc.written > 0) {
        console.log('[empirical-market] gametime: wrote ' + mc.written
          + ' row(s) (by_type=' + JSON.stringify(mc.byType) + ') at ' + generatedAt);
      }
    } catch (e) {
      console.warn('[empirical-market] gametime generation failed (non-fatal): ' + e.message);
    }

    // Kalshi-direct TOTALS override (gated). Mirrors the ML override above:
    // when kalshi_direct_totals_enabled is on, fetch pre-game MLB totals
    // from Kalshi and OVERRIDE over_price / under_price on any oddsRaw row
    // Kalshi covers. We do NOT change market_total — the LINE stays from
    // the Unabated/OddsAPI backup (which the model's existing edge calc
    // expects); Kalshi supplies fee-adjusted PRICES for that same line.
    //
    // Line matching:
    //   - Look up the existing market_total in Kalshi's strike ladder.
    //   - Exact match → use that rung's over_ask / under_ask.
    //   - No exact match → nearest, but only if within 0.5 of market_total
    //     (a half-run gap). >0.5 apart means Kalshi and the consensus
    //     disagree on the line itself; safer to leave on backup than to
    //     paper over a real disagreement with a different-line price.
    //
    // Observation field: kalshi_implied_total holds Kalshi's auto-pick
    // (the rung whose over_ask is closest to $0.50). Always populated when
    // Kalshi covers the game, even when the price override is skipped.
    // Surfaces a divergence signal without driving anything.
    //
    // ---- CLV CAVEAT — INHERITED FROM ML PATH ----
    // over_price / under_price written here are FEE-ADJUSTED Kalshi asks
    // (per-side, independent fee load — see feeAdjustAmericanFromC below),
    // NOT raw market prices. The totals P&L computation later in this
    // file (the per-side _price lookup ~ search "Total: bet_line is the
    // O/U number") reads gameRow.over_price / under_price, so any CLV-
    // adjacent metric derived from those values will be fee-skewed —
    // systematically inflated by roughly the per-contract fee — just like
    // ML. Known, accepted consequence; see feat/kalshi-fee-adjusted-lines.
    //
    // Guardrails: same as ML override.
    //   - Pre-game gated by getKalshiMlbTotals.
    //   - Locked games (odds_locked_at set) skipped.
    //   - game_id match: prefer k.game_id (doubleheader-aware), fall back
    //     to makeGameId(team, team) for older Kalshi-client builds.
    //   - LOUD ON EMPTY: Kalshi returned data but matched zero oddsRaw
    //     game_ids → WARN.
    //   - Whole block try/catch'd: failure must never break the odds job.
    if (settings.KALSHI_DIRECT_TOTALS_ENABLED) {
      try {
        const kalshiTotals = await getKalshiMlbTotals(dateStr);
        if (!kalshiTotals.length) {
          console.log('[odds] Kalshi-direct totals: no pre-game markets returned for ' + dateStr);
        } else {
          // Per-side, C-input fee adjustment. Same shape as the ML
          // helper (feeAdjustAmerican at ~line 2845) and the spreads
          // helper (feeAdjustAmericanSpread at ~line 2940) — starts
          // from a contract dollar price (the ladder rung's raw
          // over_ask / under_ask) instead of American odds, applies
          // Kalshi's per-contract taker fee, converts to American at
          // 2-decimal precision, then subtracts 1.0 toward the
          // bettor-unfavorable direction so the stored value never
          // overstates the price available on Kalshi.
          //
          // Pre-fix this rounded the raw float directly, landing 1
          // cent in the bettor's favor every time — symmetric ML
          // bug that was fixed for ML/spreads but missed on totals.
          // Single-helper edit; o.over_price / o.under_price write
          // sites below already consume its return.
          function feeAdjustAmericanFromC(C) {
            if (!Number.isFinite(C) || !(C > 0.001 && C < 0.999)) return null;
            const adj = C + kalshiTakerFeeRate(C);
            if (!(adj > 0.001 && adj < 0.999)) return null;
            if (adj >= 0.5) {
              const americanFloat = -(100 * adj / (1 - adj));
              const twoDecimal    = Math.round(americanFloat * 100) / 100;
              return Math.round(twoDecimal - 1.0);
            } else {
              const americanFloat = 100 * (1 - adj) / adj;
              const twoDecimal    = Math.round(americanFloat * 100) / 100;
              return Math.round(twoDecimal - 1.0);
            }
          }
          const oddsById = new Map();
          for (const o of oddsRaw) oddsById.set(o.game_id, o);
          let overridden = 0, skippedLocked = 0, missingFromOdds = 0;
          let skippedNoExistingTotal = 0, skippedLineGap = 0, skippedFeeFail = 0;
          // Snapshot rows accumulated for EVERY kalshi event,
          // regardless of override skip path. CLV close-price fallback
          // in services/empirical-spread-roi.js consumes this. Mirrors
          // the spreads snapshot convention.
          const totalsSnapshotRows = [];
          for (const k of kalshiTotals) {
            const gameId = k.game_id || makeGameId(k.away_team, k.home_team);
            const o = oddsById.get(gameId);

            // === SNAPSHOT rung selection (independent observation) ===
            // Prefer the rung matching unabated_total (exact, then nearest
            // within 0.5) so the snapshot lines up with the reference-only
            // display. Falls back to Kalshi's default chosen rung when
            // no reference exists. ALWAYS produces a rung so snapshot
            // coverage is independent of override fate.
            //
            // Pre-#230: anchored on o.market_total (Unabated). Post-#230:
            // market_total is Kalshi-only, so the anchor moved to
            // o.unabated_total (reference-only column) with the same 0.5-
            // line-gap semantics preserved for observation.
            let candidateRung = null;
            let nearestRung = null, nearestDist = Infinity;
            if (o && o.unabated_total != null) {
              candidateRung = k.ladder.find(r => r.strike === o.unabated_total);
              if (!candidateRung) {
                for (const r of k.ladder) {
                  const d = Math.abs(r.strike - o.unabated_total);
                  if (d < nearestDist) { nearestRung = r; nearestDist = d; }
                }
                if (nearestRung && nearestDist <= 0.5) candidateRung = nearestRung;
              }
            }
            const snapRung = candidateRung
              || { strike: k.line, over_ask: k.over.ask_dollars, under_ask: k.under.ask_dollars };
            totalsSnapshotRows.push({
              game_date: dateStr, game_id: gameId,
              market_line: snapRung.strike,
              over_ask_dollars: snapRung.over_ask,
              under_ask_dollars: snapRung.under_ask,
              over_price_ml: feeAdjustAmericanFromC(snapRung.over_ask),
              under_price_ml: feeAdjustAmericanFromC(snapRung.under_ask),
            });

            // === WRITE (Kalshi is the SOLE source post-#230) ===
            if (!o) {
              console.warn('[odds] Kalshi-direct totals: ' + gameId
                + ' not in oddsRaw — skipping');
              missingFromOdds++;
              continue;
            }
            const existing = q.getGameById.get(dateStr, gameId);
            if (existing && existing.odds_locked_at) {
              skippedLocked++;
              continue;
            }
            // Observation-only: record Kalshi's implied fair total.
            // Prefer the continuous interpolated value (from de-vigged
            // ladder, see kalshi.js computeImpliedTotal) so divergence
            // vs bettable line isn't quantized to .5 steps. Falls back
            // to the snapped bettable rung when the ladder doesn't
            // bracket pOver=0.50 (k.implied_total null in that case).
            o.kalshi_implied_total = (k.implied_total != null) ? k.implied_total : k.line;
            // Pick the rung to write:
            //   - candidateRung set → Unabated reference line matched a
            //     Kalshi rung within 0.5 (best when they agree on the line)
            //   - Otherwise use Kalshi's own auto-picked rung (k.line +
            //     over/under). Post-#230 we DO write in this fallback path
            //     rather than skipping — the ruling says totals baseline
            //     must be Kalshi/Poly, so Kalshi's own preferred line IS
            //     the correct answer when there's no agreement or no
            //     reference at all. Pre-#230 the code left the row on
            //     Unabated here; that path is gone.
            const chosenLine = candidateRung
              ? candidateRung.strike
              : k.line;
            const chosenOverAsk  = candidateRung ? candidateRung.over_ask  : k.over.ask_dollars;
            const chosenUnderAsk = candidateRung ? candidateRung.under_ask : k.under.ask_dollars;
            const chosenRung = { strike: chosenLine, over_ask: chosenOverAsk, under_ask: chosenUnderAsk };
            if (chosenRung.over_ask == null || chosenRung.under_ask == null) {
              skippedLineGap++;
              continue;
            }
            const overFeeMl = feeAdjustAmericanFromC(chosenRung.over_ask);
            const underFeeMl = feeAdjustAmericanFromC(chosenRung.under_ask);
            if (overFeeMl == null || underFeeMl == null) {
              skippedFeeFail++;
              continue;
            }
            // Post-#230: Kalshi is the SOLE totals source, so write
            // market_total from Kalshi's rung too (was: left from Unabated).
            o.market_total = chosenRung.strike;
            o.over_price = overFeeMl;
            o.under_price = underFeeMl;
            o.total_source = 'kalshi';
            overridden++;
          }
          const backupCount = oddsRaw.length - overridden;
          console.log('[odds] Kalshi-direct totals: ' + overridden + ' overridden, '
            + backupCount + ' backup'
            + (skippedLocked ? ', ' + skippedLocked + ' locked (skipped)' : '')
            + (skippedLineGap ? ', ' + skippedLineGap + ' line-gap >0.5 (skipped)' : '')
            + (skippedNoExistingTotal ? ', ' + skippedNoExistingTotal + ' no existing total' : '')
            + (skippedFeeFail ? ', ' + skippedFeeFail + ' fee-adj degenerate' : '')
            + (missingFromOdds ? ', ' + missingFromOdds + ' kalshi-only (skipped)' : ''));
          if (overridden === 0 && missingFromOdds > 0) {
            console.warn('[odds] Kalshi-direct totals: ' + kalshiTotals.length
              + ' Kalshi total event(s) returned but ZERO matched oddsRaw game_ids — mapping likely broken'
              + ' (check abbr normalization / doubleheader suffix). Proceeding with unmodified oddsRaw.');
          }

          // PT-anchored totals snapshot — matches the spreads/ML
          // snapshot tz convention. Non-fatal: snapshot failure must
          // not block the totals override above. CLV-only consumer.
          try {
            const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            q.snapshotKalshiTotalsMarkets(snapDate, totalsSnapshotRows);
            console.log('[odds-snapshot] Kalshi totals: captured ' + totalsSnapshotRows.length
              + ' rows for ' + snapDate);
          } catch (e) {
            console.warn('[odds-snapshot] Kalshi totals snapshot failed (non-fatal): ' + e.message);
          }
        }
      } catch (e) {
        console.warn('[odds] Kalshi-direct totals override failed (non-fatal, falling through): ' + e.message);
      }
    }

    const result = processOddsArray(dateStr, oddsRaw, settings);
    const updated = result.updated;
    const sourceLabel = result.source;
    q.logCron.run('odds', dateStr, 'success', 'Updated ' + updated + ' game(s) from ' + sourceLabel, updated);

    // Tail refresh (feat/upsert-signal-refresh, 2026-07-08). After the
    // odds cron persists fresh market_*_ml into game_log, re-anchor
    // bet_signals.market_line/edge_pct for every active unlocked ML row
    // on this dateStr against the venue winner net. Staleness guard +
    // T-10 freeze + per-bet freeze all enforced inside
    // refreshSignalBaselines. Non-fatal on failure — odds cron already
    // succeeded before this ran.
    try {
      const stats = await refreshSignalBaselines(dateStr, settings);
      console.log('[odds-tail-refresh] ' + dateStr + ' → ' + JSON.stringify(stats));
    } catch (e) {
      console.warn('[odds-tail-refresh] ' + dateStr + ' failed (non-fatal): ' + e.message);
    }

    // Chained morning-capture attempt. Kalshi posts D+1 spread
    // markets mid-afternoon on D-1 (~14:30-21:30 UTC, observed),
    // so the 7:30AM PT D+1 cron is structurally too early — it
    // ALWAYS finds zero spread-eligible games. Hooking morning
    // capture onto every successful odds-job pass makes it
    // first-eligible-lock at the first odds run AFTER Kalshi
    // posts a given game's market. The 7:30AM cron stays as-is
    // (it opens the lock window and is a harmless extra attempt).
    //
    // Idempotent: generateMorningCapture's existsMorningSignalForGame
    // check skips already-locked games. Recursion-safe: this only
    // fires when opts.skipChainedMorningCapture is falsy, and the
    // runMorningCaptureJob's own internal runOddsJob call sets it
    // true (see further down this file). Try/catch'd so a capture
    // failure can never undo a successful odds-job run.
    if (!opts.skipChainedMorningCapture) {
      try {
        const cap = await runMorningCaptureJob(dateStr);
        const locked = (cap && cap.morning && cap.morning.written) || 0;
        console.log('[morning-capture] chained: ' + locked + ' locked'
          + ' for ' + dateStr + ' (' + sourceLabel + ' odds-job)');
      } catch (e) {
        console.warn('[morning-capture] chained call failed for ' + dateStr
          + ' (non-fatal): ' + (e && e.message));
      }
    }

    return { success: true, updated, date: dateStr };
  } catch(err) {
    console.error('[odds-job]', err.message);
    q.logCron.run('odds', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message };
  }
}

// Morning empirical-spread capture for D+1.
//
// Sequence for a target date D+1 (= the slate being captured):
//   1. ensure the morning_capture_state lock-window row exists
//      (records opened_at; INSERT OR IGNORE so re-invocations don't
//      shift the window).
//   2. runLineupJob(D+1) -> runWeatherJob(D+1) -> runOddsJob(D+1).
//      This sequence mirrors the 8PM tomorrow-slate prefetch and
//      is what makes the morning capture FRESH (against current
//      projected lineups + current odds) rather than against the
//      stale 11pm prior-evening snapshot. runOddsJob also writes
//      capture_track='gametime' as a side effect (its existing
//      block); that's harmless — gametime is supposed to update
//      every refresh, and we want the morning lock to capture the
//      EXACT same prices runOddsJob just observed.
//   3. generateMorningCapture — engine returns only games NOT
//      already morning-locked; persists them with
//      capture_track='morning'. First-eligible wins; subsequent
//      calls leave already-locked games untouched.
//
// Non-fatal at each step. Returns a status object so the manual
// endpoint can surface what happened.
async function runMorningCaptureJob(dateStr) {
  if (!dateStr) dateStr = tomorrowStr();
  const summary = {
    success: false,
    date: dateStr,
    opened_at: null,
    refresh: { lineups: null, weather: null, odds: null },
    morning: { written: 0, outcomeRows: 0, skipped: 0 },
  };
  try {
    // (1) Lock-window state. Set opened_at to the current
    // PT-anchored timestamp. INSERT OR IGNORE so a second invocation
    // on the same date leaves the original opened_at intact.
    // [tz cutover: 2026-06-08] — opened_at was UTC before this fix.
    const openedAt = nowPtIso();
    q.upsertMorningCaptureState.run(dateStr, openedAt);
    const state = q.getMorningCaptureState.get(dateStr);
    summary.opened_at = state ? state.opened_at : openedAt;

    // (2) Sequential refresh chain. Each step is independently
    // try/caught — a Kalshi hiccup must not stop the lineup pull
    // from running, etc.
    try {
      const r = await runLineupJob(dateStr);
      summary.refresh.lineups = r && r.gamesUpdated != null ? r.gamesUpdated : (r || null);
    } catch (e) { console.error('[morning-capture] lineups failed:', e && e.message); }
    try {
      const r = await runWeatherJob(dateStr);
      summary.refresh.weather = r && r.updated != null ? r.updated : (r || null);
    } catch (e) { console.error('[morning-capture] weather failed:', e && e.message); }
    try {
      // skipChainedMorningCapture: prevent recursion. runOddsJob
      // chains a runMorningCaptureJob call onto its tail on every
      // other invocation; we're already INSIDE runMorningCaptureJob
      // here, so suppress the chain or runMorningCaptureJob would
      // re-enter via runOddsJob's tail and loop indefinitely.
      const r = await runOddsJob(dateStr, { skipChainedMorningCapture: true });
      summary.refresh.odds = r && r.updated != null ? r.updated : (r || null);
    } catch (e) { console.error('[morning-capture] odds failed:', e && e.message); }

    // (2b) Explicit model-line rescore for every D+1 game.
    //
    // runOddsJob normally invokes processGameSignals per game (which
    // writes model_home_ml / model_away_ml / model_total onto
    // game_log) inside processOddsArray — but only for games whose
    // oddsRaw rows came back from Unabated/OddsAPI. At 7:30AM PT on
    // day D for D+1, those upstreams typically don't have D+1 markets
    // posted yet (Kalshi posts D+1 spreads around 14:48 PT on D), so
    // oddsRaw is empty, processGameSignals never fires per game, and
    // model_* on game_log stay NULL. generateMorningCapture's
    // eligibility query (empirical-spread-edge.js:339-348) then drops
    // every D+1 game because model_home_ml IS NULL — empty capture,
    // not the bug the rest of the chain looked like it should have
    // fixed.
    //
    // Force model lines onto every D+1 game in game_log regardless
    // of upstream odds coverage. processGameSignals is the same
    // function the rest of the codebase uses for this purpose; we
    // simply call it directly here per game so the morning capture
    // never depends on an Unabated/OddsAPI hit. No new ingest path —
    // we reuse the existing one, satisfying the "do not write a
    // parallel ingest" constraint.
    let rescored = 0;
    try {
      const games = q.getGamesByDate.all(dateStr);
      const wobaIdx = getWobaIndex();
      const settings = getSettings();
      for (const g of games) {
        try {
          processGameSignals(g, wobaIdx, settings);
          rescored++;
        } catch (e) {
          console.warn('[morning-capture] model rescore failed for ' + g.game_id
            + ' (non-fatal): ' + (e && e.message));
        }
      }
      console.log('[morning-capture] model rescored ' + rescored + '/' + games.length
        + ' D+1 game(s) for ' + dateStr);
    } catch (e) {
      console.error('[morning-capture] model rescore loop failed:', e && e.message);
    }
    summary.refresh.model_rescored = rescored;

    // (3) Morning capture proper. Engine drops games already
    // locked; what remains lands with capture_track='morning' and
    // the per-pass generatedAt timestamp. PT-anchored.
    // [tz cutover: 2026-06-08]
    const generatedAt = nowPtIso();
    const result = empiricalSpreadEdge.generateMorningCapture(db, q, dateStr, generatedAt);
    summary.morning.written     = result.persisted.written;
    summary.morning.outcomeRows = result.persisted.outcomeRows;
    summary.morning.skipped     = result.skipped.length;
    console.log('[morning-capture] ' + dateStr + ': ' + summary.morning.written
      + ' newly-locked game(s), ' + summary.morning.skipped + ' already-locked, '
      + summary.morning.outcomeRows + ' outcome rows at ' + generatedAt);

    // (3b) Market capture (ML + totals) — feat/morning-capture-ml-totals.
    // Parallel to the spread capture above. Eligibility is per-
    // market_type (ML can lock at 7:35am while totals wait for weather-
    // dependent posting at 3pm — the brief's partial-posting reality).
    // existsMorningMarketCapture inside the engine first-eligible-locks
    // each game/market_type independently; re-invocations are no-ops
    // for already-locked entries. Same shared generatedAt as the
    // spread capture above so grouping by batch is consistent.
    try {
      const empiricalMarketCapture = require('./empirical-market-capture');
      const mc = empiricalMarketCapture.generateMarketCapture(
        db, q, dateStr, 'morning', generatedAt);
      summary.morning.market_written = mc.written;
      summary.morning.market_by_type = mc.byType;
      console.log('[morning-capture] market: wrote ' + mc.written
        + ' row(s) (by_type=' + JSON.stringify(mc.byType) + ') for ' + dateStr);
    } catch (e) {
      console.warn('[morning-capture] market capture failed for ' + dateStr
        + ' (non-fatal): ' + (e && e.message));
    }
    q.logCron.run('morning-capture', dateStr, 'success',
      summary.morning.written + ' locked, ' + summary.morning.skipped + ' skipped',
      summary.morning.written);
    summary.success = true;
    return summary;
  } catch (err) {
    console.error('[morning-capture]', err.message);
    try { q.logCron.run('morning-capture', dateStr, 'error', err.message, 0); } catch (_) {}
    summary.error = err.message;
    return summary;
  }
}


// Identify the most likely bulk-guy on `team` for an opener-led game on
// `date`. Replaced the freshest-last-appearance heuristic (which picked
// Martinez over Scholtens for TB on 2026-05-02 because Martinez happened
// to start more recently — exactly backwards) with the scored ranking
// approved alongside PR A's data capture.
//
// Per-candidate score:
//   +5  ≥1 outing in last 30d with was_starter=0 AND innings_pitched ≥ 3
//       (long-relief pattern — the bulk-guy signature)
//   +3  most recent appearance was was_starter=0 (last role was relief)
//   +2  avg innings_pitched over last 5 outings ∈ [3.5, 5.5] (bulk-guy IP range)
//   +1  days-rested ∈ [4, 6] (rotation-style rest)
//   -2  most recent was was_starter=1 AND avg IP last-5 > 5.5
//       (regular-starter signature — actively penalize so true SPs don't
//       sneak in via a single misclassified relief outing)
//
// Threshold: top score must reach 5 to be picked; below that, return
// null (spec's "do not guess; UI shows BULK GUY UNKNOWN with manual
// override"). Tiebreak on most recent long-relief outing date —
// freshest swingman wins.
//
// Note on date windows: long_relief detection uses last 30d (recent
// pattern matters); last_was_relief / sp_signature / days_rested use
// the absolute most recent appearance regardless of date; avg IP uses
// the last 5 outings regardless of date. This way a candidate with
// only old data still gets meaningful signals where applicable.
function identifyBulkGuy(team, date, openerName) {
  const fgSPs = db.prepare(
    "SELECT mlb_id, player_name FROM pitcher_fg_role WHERE team=? AND role='SP'"
  ).all(team);
  if (!fgSPs.length) return null;

  // Filter: not the opener, not scheduled to start in the next 2 days.
  const nextDate = (d, plus) => {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + plus);
    return t.toISOString().slice(0, 10);
  };
  const tomorrow = nextDate(date, 1);
  const dayAfter = nextDate(date, 2);
  const scheduled = new Set();
  for (const r of db.prepare(
    "SELECT away_sp, home_sp FROM game_log WHERE game_date IN (?, ?) AND COALESCE(is_removed, 0) = 0"
  ).all(tomorrow, dayAfter)) {
    if (r.away_sp) scheduled.add(r.away_sp);
    if (r.home_sp) scheduled.add(r.home_sp);
  }
  const candidates = fgSPs.filter(p =>
    p.player_name !== openerName && !scheduled.has(p.player_name)
  );
  if (!candidates.length) return null;

  const dateMs = Date.parse(date + 'T00:00:00Z');
  const thirtyDaysAgo = new Date(dateMs - 30 * 86400000).toISOString().slice(0, 10);
  const recent30Stmt = db.prepare(
    "SELECT game_date, was_starter, innings_pitched FROM pitcher_game_log " +
    "WHERE pitcher_mlb_id = ? AND game_date >= ? AND game_date < ? " +
    "ORDER BY game_date DESC"
  );
  const mostRecentStmt = db.prepare(
    "SELECT game_date, was_starter, innings_pitched FROM pitcher_game_log " +
    "WHERE pitcher_mlb_id = ? AND game_date < ? " +
    "ORDER BY game_date DESC LIMIT 1"
  );
  const last5Stmt = db.prepare(
    "SELECT game_date, was_starter, innings_pitched FROM pitcher_game_log " +
    "WHERE pitcher_mlb_id = ? AND game_date < ? " +
    "ORDER BY game_date DESC LIMIT 5"
  );

  for (const c of candidates) {
    if (c.mlb_id == null) {
      c.score = 0; c.signals = ['no_mlb_id']; c._tieKey = ''; continue;
    }
    const recent30   = recent30Stmt.all(c.mlb_id, thirtyDaysAgo, date);
    const mostRecent = mostRecentStmt.get(c.mlb_id, date);
    const last5      = last5Stmt.all(c.mlb_id, date);

    let score = 0;
    const signals = [];

    if (recent30.some(o => o.was_starter === 0 && (o.innings_pitched || 0) >= 3)) {
      score += 5; signals.push('+5 long_relief_pattern');
    }
    if (mostRecent && mostRecent.was_starter === 0) {
      score += 3; signals.push('+3 last_was_relief');
    }
    let avgIp = null;
    if (last5.length > 0) {
      avgIp = last5.reduce((s, o) => s + (o.innings_pitched || 0), 0) / last5.length;
      if (avgIp >= 3.5 && avgIp <= 5.5) {
        score += 2; signals.push('+2 avg_ip_' + avgIp.toFixed(2));
      }
      if (mostRecent && mostRecent.was_starter === 1 && avgIp > 5.5) {
        score -= 2; signals.push('-2 sp_signature_avgip_' + avgIp.toFixed(2));
      }
    }
    let daysRested = null;
    if (mostRecent && mostRecent.game_date) {
      daysRested = Math.floor((dateMs - Date.parse(mostRecent.game_date + 'T00:00:00Z')) / 86400000);
      if (daysRested >= 4 && daysRested <= 6) {
        score += 1; signals.push('+1 days_rest_' + daysRested);
      }
    }
    // Tiebreak key: most recent long-relief outing date in the 30d window
    // (empty string sorts last so candidates with no long-relief lose ties).
    const lastLongRelief = recent30.find(o => o.was_starter === 0 && (o.innings_pitched || 0) >= 3);
    c._tieKey = lastLongRelief ? lastLongRelief.game_date : '';
    c.score = score;
    c.signals = signals;
    console.log('[bulk-guy-score] ' + team + ' ' + c.player_name
      + ': score=' + score + ' [' + signals.join(', ') + ']'
      + ' avg_ip_last5=' + (avgIp != null ? avgIp.toFixed(2) : 'n/a')
      + ' last_app=' + (mostRecent ? mostRecent.game_date : 'n/a')
      + ' rest=' + (daysRested != null ? daysRested + 'd' : 'n/a'));
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b._tieKey || '').localeCompare(a._tieKey || '');
  });
  const top = candidates[0];
  if (!top || top.score < 5) {
    console.log('[bulk-guy-score] ' + team + ': top='
      + (top ? top.player_name + ' (' + top.score + ')' : 'none')
      + ' below threshold 5 → leaving bulk_guy NULL');
    return null;
  }
  console.log('[bulk-guy-score] ' + team + ': picked ' + top.player_name + ' (score=' + top.score + ')');
  return top.player_name;
}

// Per-game opener detection. Writes is_opener_game_{side},
// bulk_guy_{side}, opener_planned_batters_{side}, opener_detected_at on
// each game_log row for `date`. Detection per side:
//
//   Primary signal — the probable SP is classified RP or CL by FG.
//   Confirming   — recent pitcher_game_log shows avg pitches < 30
//                  over the last 10 outings (proxy for "<2 IP",
//                  since pitches is what we record).
//
// When both signals fire, mark is_opener_game_{side}=1 and try to
// identify the bulk-guy. If we can't pick one confidently, leave
// bulk_guy_{side} NULL so the UI can show "BULK GUY UNKNOWN" with a
// manual-override button rather than guessing.
//
// opener_override rows always win — when one exists for (date, game_id,
// side), its values are written verbatim and detection skips.
//
// This function is purely additive in Phase 1: no signal-generation
// path reads is_opener_game_* yet, so the v3 cohort is not tainted.
async function detectOpeners(dateStr) {
  const games = q.getGamesByDate.all(dateStr);
  if (!games.length) {
    console.log('[opener-detect] no games for ' + dateStr);
    return { date: dateStr, detected: 0, unknown_bulk: 0 };
  }
  // Build the F4 index once for this date (used for opener+bulk role
  // forecasts after detection settles which pitcher is which).
  const settings = getSettings();
  let spStartIndex = null;
  try {
    spStartIndex = buildSpStartIndex(db, settings);
  } catch (e) {
    console.warn('[opener-detect] F4 index build failed (forecasts skipped): ' + e.message);
  }
  const rosterLookup = db.prepare("SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?");
  // Fallback resolver: pitcher_game_log keeps a (team, pitcher_name,
  // pitcher_mlb_id) row for every pitching appearance. A pitcher called
  // up after the most recent runRosterJob hasn't landed in team_rosters
  // yet, but the moment they appear in a box score they're in this
  // table. Pull the team's distinct (id, name) pairs and let the JS
  // resolver below do the normalized-name match.
  // pitcher_game_log uses statsapi-style team abbrs for two clubs
  // (WSH for the Nationals, AZ for the Diamondbacks), while game_log /
  // team_rosters use the post-normalization app convention (WAS, ARI).
  // Verified by distinct-team scan against the local DB. Without this
  // map the fallback would query `team='WAS'` and miss every Poulin /
  // WAS-bullpen row that exists under 'WSH'. The IN (?, ?) below always
  // gets two values — when no alias applies, both slots receive the
  // same value (harmless dedup at the SQL level).
  //
  // Other potentially-divergent abbrs:
  //  - OAK / ATH: pitcher_game_log uses ATH only (no OAK rows observed
  //    in current data — verified). game_log uses ATH. No alias needed.
  //  - Other 28 teams: identical between the tables.
  const TEAM_ALIAS_PGL = { WAS: 'WSH', ARI: 'AZ' };
  const gameLogLookup = db.prepare(
    "SELECT DISTINCT pitcher_mlb_id, pitcher_name FROM pitcher_game_log "
    + "WHERE team IN (?, ?) AND pitcher_mlb_id IS NOT NULL"
  );

  // Resolve a pitcher's mlb_id by team + name. Two-tier:
  //   1. team_rosters exact match (existing behavior, fastest path).
  //   2. pitcher_game_log normalized-name match within the team —
  //      catches recently-called-up pitchers who aren't in team_rosters
  //      yet (e.g. PJ Poulin called up 5/24, not in team_rosters but
  //      mlb_id 676571 reachable via pitcher_game_log entries).
  //
  // Name normalization mirrors _spNamesMatch (~line 1493 in this file
  // used by the sp_source_conflict detector): stripSfx(normName(...))
  // for full-string equality first, then a last-name + first-initial
  // fallback so "P.J. Poulin" matches "PJ Poulin" and "Acuna Jr." would
  // match "Acuna".
  //
  // Constrained to the requested team so a same-named pitcher on a
  // different team can't poison the resolution. Multiple matches on
  // the same team → return null (prefer no resolution to a wrong one);
  // a warn line surfaces the ambiguity in logs.
  const resolveMlbId = (team, pitcherName) => {
    if (!team || !pitcherName) return null;
    const r = rosterLookup.get(team, pitcherName);
    if (r) return r.mlb_id;
    // Roster missed — try pitcher_game_log by normalized name. Query
    // both team spellings (app convention + statsapi alias, e.g.
    // 'WAS' + 'WSH') so the lookup is robust to which convention the
    // log rows happen to use.
    const targetNorm = stripSfx(normName(pitcherName));
    if (!targetNorm) return null;
    const altTeam = TEAM_ALIAS_PGL[team] || team;
    const candidates = gameLogLookup.all(team, altTeam);
    if (!candidates.length) return null;
    const matchedIds = new Set();
    let matchKind = null;
    let firstMatchName = null;
    // Pass 1: full-string normalized equality.
    for (const c of candidates) {
      if (!c.pitcher_name) continue;
      if (stripSfx(normName(c.pitcher_name)) === targetNorm) {
        matchedIds.add(c.pitcher_mlb_id);
        if (!firstMatchName) firstMatchName = c.pitcher_name;
        matchKind = 'exact-norm';
      }
    }
    // Pass 2: last-name + first-initial (only if pass 1 produced nothing).
    if (matchedIds.size === 0) {
      const ta = targetNorm.split(' ');
      if (ta.length >= 2) {
        const tLast = ta[ta.length - 1];
        const tInit = ta[0][0];
        for (const c of candidates) {
          if (!c.pitcher_name) continue;
          const ca = stripSfx(normName(c.pitcher_name)).split(' ');
          if (ca.length < 2) continue;
          if (ca[ca.length - 1] === tLast && ca[0][0] === tInit) {
            matchedIds.add(c.pitcher_mlb_id);
            if (!firstMatchName) firstMatchName = c.pitcher_name;
            matchKind = 'last+initial';
          }
        }
      }
    }
    if (matchedIds.size === 1) {
      const mlbId = [...matchedIds][0];
      console.log('[forecast-fallback] ' + team + '/' + pitcherName
        + ' not in team_rosters → resolved via pitcher_game_log: '
        + firstMatchName + ' (mlb_id=' + mlbId + ', match=' + matchKind + ')');
      return mlbId;
    }
    if (matchedIds.size > 1) {
      console.warn('[forecast-fallback] ' + team + '/' + pitcherName
        + ' ambiguous in pitcher_game_log (' + matchedIds.size
        + ' candidates) — returning null to avoid wrong-pitcher match');
    }
    return null;
  };

  const forecastForName = (pitcherName, team, role) => {
    if (!pitcherName || !team || !spStartIndex) return null;
    const mlbId = resolveMlbId(team, pitcherName);
    const out = forecastSpIP({
      index: spStartIndex,
      pitcherMlbId: mlbId,
      gameDate: dateStr,
      settings,
      role: role || 'start',
    });
    if (out.source === 'fallback') return null;
    return out.forecast;
  };
  const writeDetection = (date, gameId, side, isOpener, bulkGuy, plannedBatters, tandemSubtype) => {
    // side comes from a closed { 'away', 'home' } enum below — safe to
    // splice into the column name. NEVER widen this to user input.
    //
    // game_type derives from (isOpener, bulkGuy) — single source of
    // truth so the auto-detection path and the manual-override path
    // (which both flow through here) keep the column current with no
    // separate code branch:
    //   isOpener && bulkGuy   → 'opener'        (3-way model split)
    //   isOpener && !bulkGuy  → 'bullpen_game'  (0.15 opener + 0.85 BP)
    //   !isOpener             → 'standard'      (existing path)
    //
    // tandemSubtype (feat/sp-sp-tandem-forecast-split, 2026-07-04) is
    // an OPTIONAL further refinement written alongside game_type:
    //   'sp_sp' → both opener AND bulk are RR-fresh rotation SPs.
    //             model.js buildOpenerOpts uses the forecast-driven
    //             split formula instead of opener-class anchors.
    //   null    → classic opener / bullpen_game / standard.
    //             model.js falls through to the existing anchor path.
    const gameType = isOpener
      ? (bulkGuy ? 'opener' : 'bullpen_game')
      : 'standard';
    const subtypeCol = 'tandem_subtype_' + side;
    const sql = "UPDATE game_log SET "
      + "is_opener_game_" + side + " = ?, "
      + "bulk_guy_" + side + " = ?, "
      + "opener_planned_batters_" + side + " = ?, "
      + "game_type_" + side + " = ?, "
      + subtypeCol + " = ?, "
      + "opener_detected_at = datetime('now') "
      + "WHERE game_date = ? AND game_id = ?";
    db.prepare(sql).run(isOpener ? 1 : 0, bulkGuy, plannedBatters, gameType,
      tandemSubtype != null ? tandemSubtype : null, date, gameId);

    // After writing detection state, refresh the role-specific forecast
    // columns. The lineup-job's earlier upsertGame gated bulk_forecast_ip
    // on RotoWire-announced bulk only, which misses cases where opener
    // detection infers a bulk without RotoWire confirmation (e.g.
    // TOR-DET 5/16: bulk_guy_away='Eric Lauer' inferred but
    // bulk_guy_away_announced=null). Re-compute both forecast columns
    // here once bulk_guy is settled.
    //
    // Look up the row to get the SP name for the opener-role forecast
    // (the named SP IS the opener on opener-mode games).
    const row = q.getGameById ? q.getGameById.get(date, gameId) : null;
    if (!row) return;
    const team = side === 'away' ? row.away_team : row.home_team;
    const sp   = side === 'away' ? row.away_sp   : row.home_sp;
    const openerFc = isOpener ? forecastForName(sp, team, 'opener') : null;
    const bulkFc   = (isOpener && bulkGuy) ? forecastForName(bulkGuy, team, 'bulk') : null;
    try {
      const fcSql = "UPDATE game_log SET "
        + (side === 'away' ? "away_opener_forecast_ip = ?, away_bulk_forecast_ip = ? "
                           : "home_opener_forecast_ip = ?, home_bulk_forecast_ip = ? ")
        + "WHERE game_date = ? AND game_id = ?";
      db.prepare(fcSql).run(openerFc, bulkFc, date, gameId);
    } catch (e) {
      console.warn('[opener-detect] forecast persist failed: ' + e.message);
    }
  };

  let detectedCount = 0, unknownBulkCount = 0;
  for (const g of games) {
    for (const side of ['away', 'home']) {
      const team = side === 'away' ? g.away_team : g.home_team;
      const sp   = side === 'away' ? g.away_sp   : g.home_sp;

      // Manual override always wins. Detection logic skips entirely.
      const ov = q.getOpenerOverride.get(dateStr, g.game_id, side);
      if (ov) {
        // Piece 3 of feat/opener-name-override: when ov.opener_name is
        // set, pin it into away_sp/home_sp for this side BEFORE
        // writeDetection. writeDetection's tail (~line 2890) reads the
        // row back to compute the opener IP forecast, so updating the
        // SP first means the forecast resolves against the pinned name
        // (e.g. PJ Poulin's real ~1.1 IP from the pitcher_game_log
        // fallback) rather than whatever the lineup-job last wrote
        // (e.g. RotoWire's stale bulk-as-SP value).
        //
        // KNOWN LIMITATION (this commit only): a subsequent runLineupJob
        // SP-precedence merge (~line 1255) can overwrite away_sp back
        // to RotoWire's value. Piece 4 of this branch adds the
        // durability guard. Until that lands, the override only sticks
        // until the next lineup-job pass touches this row.
        if (ov.opener_name && typeof ov.opener_name === 'string') {
          db.prepare(
            "UPDATE game_log SET "
              + (side === 'away' ? 'away_sp' : 'home_sp') + " = ? "
            + "WHERE game_date=? AND game_id=?"
          ).run(ov.opener_name, dateStr, g.game_id);
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': override pinned opener_name=\'' + ov.opener_name + '\''
            + ' (replaced ' + (sp || 'null') + ')');
        }
        writeDetection(
          dateStr, g.game_id, side,
          !!ov.is_opener,
          ov.bulk_guy || null,
          ov.planned_batters != null ? ov.planned_batters : null
        );
        if (ov.is_opener) {
          detectedCount++;
          if (!ov.bulk_guy) unknownBulkCount++;
          console.log('[opener-detect] ' + g.game_id + '/' + side + ': override applied — opener='
            + (ov.opener_name || sp || 'unknown') + ' → bulk-guy ' + (ov.bulk_guy || 'UNKNOWN'));
        }
        continue;
      }

      if (!team) {
        writeDetection(dateStr, g.game_id, side, false, null, null);
        continue;
      }

      // SP-null + RotoWire PRIM-tagged bulk: this is RotoWire telling us
      // it's a bullpen game even though statsapi hasn't named a probable
      // yet (TB-style early announcement). Classify as opener mode with
      // the PRIM-tagged name as bulk. Model.js sources the opener slot
      // from the bullpen pool when SP is null, so the day-before estimate
      // uses bullpen wOBA for the opener slot + Scholtens-style bulk
      // wOBA for the bulk slot. When statsapi later populates the SP,
      // this re-runs and the opener slot upgrades to the announced
      // pitcher's actual splits.
      if (!sp) {
        const announcedBulkPrim = side === 'away'
          ? g.bulk_guy_away_announced
          : g.bulk_guy_home_announced;
        if (announcedBulkPrim) {
          writeDetection(dateStr, g.game_id, side, true, announcedBulkPrim, 4);
          detectedCount++;
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': SP-null + PRIM bulk → opener mode, bulk=' + announcedBulkPrim
            + ' (opener slot will use bullpen wOBA until SP announced)');
          continue;
        }
        // Otherwise nothing to detect off; clear flags so a previous
        // run's value doesn't linger if the SP was removed.
        writeDetection(dateStr, g.game_id, side, false, null, null);
        continue;
      }

      // Map SP name → mlb_id via team_rosters (the same lookup the
      // FG-roles overlay uses). If we can't resolve mlb_id we can't
      // check FG role and bail to "not opener".
      const spRow = db.prepare(
        "SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?"
      ).get(team, sp);
      let isOpener = false, bulkGuy = null, plannedBatters = null;

      // SP disambiguator helper (fix/opener-rr-gate-precedence, 2026-07-04).
      // Answers "is this SP a fresh RR-classified rotation starter
      // (role 'SP' + role_detail SP1..SP5, role_at within 7 days)?"
      //
      // Used by the FG-role-reliever pattern-match branch below as the
      // narrow guard: an inferred (unannounced) opener classification
      // is blocked when RR lists the pitcher as a rotation slot.
      //
      // SUPERSEDES PR #148 SCOPE. PR #148 placed this gate above BOTH
      // branches, which erased known-good information: on TOR@SEA
      // 2026-07-04 Gilbert (SEA SP1 on an IL-ramp pitch limit) genuinely
      // opens with Hancock (SEA SP5) the announced bulk — a real
      // piggyback tandem. The over-broad gate flipped the game to
      // 'standard' with bulk_guy=null, discarding Hancock and pricing
      // the game as ~5.7 IP Gilbert + anonymous bullpen (worse than the
      // original bug it tried to fix).
      //
      // Precedence rules (revised):
      //   1. pitcher_role_override — ALWAYS wins (handled above at
      //      ~line 4030; this gate never sees an override case).
      //   2. RotoWire announced-bulk (PRIM) branch — WINS over RR-gate.
      //      An announced tandem is known information (two named
      //      pitchers, curated by RotoWire); RR-rotation status of the
      //      named SP does NOT flip the game back to standard. This is
      //      the crucial change from PR #148.
      //   3. RR SP + SP1..SP5 (this gate) — blocks only the FG-role-
      //      reliever pattern-match branch below (inferred openers
      //      with no announced bulk).
      //   4. FG-role-reliever + short-outings branch — retained,
      //      guarded by (3).
      //
      // Freshness: role_at must be within 7 days. Stale RR falls back
      // to pre-fix behavior (no gate) rather than trusting stale data.
      //
      // FOLLOW-UP (out of scope, noted per brief): when the opener is
      // a fresh RR rotation SP AND the announced-bulk branch fires
      // (Gilbert-type — ramping starter opening a tandem), the current
      // opener-share compute already reads the forecast IP through
      // computeOpenerPitWeightFromForecast (see model.js:1155). For
      // Gilbert on 2026-07-04 that produced O:0.29 (from a 3.38 IP
      // opener forecast, clamped at the max weight), which the owner
      // said was "approximately right." No parameter change needed
      // here; a subtype-aware anchor for ramping-SP-openers is a
      // separate refinement PR if the population turns out non-trivial.
      const isFreshRotationSp = (mlbId) => {
        if (!mlbId) return false;
        const fg = q.getFgRoleByMlbId.get(mlbId);
        if (!fg || fg.role !== 'SP') return false;
        const detail = String(fg.role_detail || '').trim().toUpperCase();
        if (!/^SP[1-5]$/.test(detail)) return false;
        if (!fg.role_at) return false;
        const roleT = Date.parse(String(fg.role_at).replace(' ', 'T') + 'Z');
        if (isNaN(roleT)) return false;
        const ageDays = (Date.now() - roleT) / 86400000;
        return ageDays <= 7;
      };

      // Highest-confidence signal: RotoWire has PRIM-tagged a bulk
      // pitcher behind a named SP. RotoWire's announcement is curated
      // and trumps FG role heuristics — a "regular SP" being used as
      // an opener won't have RP classification in FG, but RotoWire's
      // announcement directly states this is opener mode. Without
      // this branch, BOS-KC 5/19 (Bailey Falter SP, Luinder Avila
      // announced bulk) was classified as standard because Falter's
      // FG role is SP, ignoring the announced bulk entirely.
      //
      // This branch WINS over the RR-rotation-slot gate (fix/opener-
      // rr-gate-precedence — supersedes PR #148). An announced tandem
      // is known information — RR-rotation status of the named SP
      // does not overrule it. Ramping-starter opener cases (Gilbert-
      // type) are handled naturally: the announced-bulk branch keeps
      // both pitchers routed as a piggyback, and the opener share
      // reflects the SP's forecast IP via computeOpenerPitWeightFrom-
      // Forecast — for Gilbert that produced O:0.29 which the owner
      // said was "approximately right."
      const announcedBulk = side === 'away'
        ? g.bulk_guy_away_announced
        : g.bulk_guy_home_announced;
      if (announcedBulk) {
        // Self-bulk case: RotoWire's lineup feed sometimes places the
        // bulk pitcher in the SP slot when the opener hasn't been
        // announced yet (was-cle 2026-05-25: away_sp='Zack Littell'
        // AND bulk_guy_away_announced='Zack Littell'; ground truth
        // per RotoWire news was Poulin opens, Littell bulks — the
        // lineup feed put the bulk in the SP slot and had no opener
        // name).
        //
        // When announcedBulk name-normalizes-equal to sp, this is
        // "known bulk, unknown opener". Mechanism: NULL out the SP on
        // the row so model.js's buildOpenerOpts (services/model.js
        // ~line 470 "if (!sideSp)") sees sideSp=null and sources the
        // opener slot from the bullpen pool — exactly the path the
        // existing SP-null + PRIM-bulk branch above (~line 2941)
        // already uses. The named pitcher becomes the bulk; bulk
        // forecast computes from the announced name; opener forecast
        // naturally becomes null because forecastForName(null, ...)
        // short-circuits in writeDetection's forecast block.
        //
        // The SP-null update happens BEFORE writeDetection so the
        // forecast read inside writeDetection sees the nulled SP and
        // skips the opener forecast computation cleanly.
        //
        // Steady state: on the next detectOpeners run, the row's sp
        // is already null and the existing SP-null + PRIM-bulk branch
        // above handles it identically. If a later RotoWire scrape
        // repopulates sp with the bulk's name again, the next
        // detectOpeners-after-lineup-job pass re-nulls it.
        //
        // statsapi_*_sp / rotowire_*_sp source columns are NOT
        // nulled — they exist for divergence observation and don't
        // affect model behavior. sp_source_conflict will likely fire
        // here too (statsapi probable vs RotoWire's bulk-as-SP), which
        // is informative.
        const _spNorm   = sp ? stripSfx(normName(sp)) : null;
        const _bulkNorm = stripSfx(normName(announcedBulk));
        if (_spNorm && _bulkNorm && _spNorm === _bulkNorm) {
          db.prepare(
            "UPDATE game_log SET "
              + (side === 'away' ? 'away_sp' : 'home_sp') + " = NULL, "
              + (side === 'away' ? 'away_sp_hand' : 'home_sp_hand') + " = NULL "
            + "WHERE game_date=? AND game_id=?"
          ).run(dateStr, g.game_id);
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': announced bulk == named SP (' + announcedBulk + ')'
            + ' → treating ' + announcedBulk + ' as BULK, opener UNKNOWN'
            + ' (bullpen wOBA for opener slot)');
        } else {
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': RotoWire announced bulk ' + announcedBulk
            + ' behind ' + sp + ' → opener mode (FG role disregarded)');
        }
        isOpener = true;
        bulkGuy = announcedBulk;
        plannedBatters = 4;
      } else if (spRow && spRow.mlb_id) {
        // RR-rotation-slot gate — narrow scope (fix/opener-rr-gate-
        // precedence, 2026-07-04). Only fires here, on the inferred /
        // pattern-match path. The announced-bulk branch above already
        // fires unconditionally on PRIM-tagged tandems, so a rotation
        // SP with an announced bulk keeps the piggyback routing.
        //
        // Here, no bulk was announced. If RR lists this SP as a fresh
        // rotation slot, the "avg pitches < 30" pattern below would
        // be picking up injury-ramp / short-leash rather than opener
        // usage — that's what the SP-weight n_priors haircut is for.
        // Block classification and let the SP path score.
        if (isFreshRotationSp(spRow.mlb_id)) {
          const fg = q.getFgRoleByMlbId.get(spRow.mlb_id);
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': SP ' + sp + ' has fresh RR rotation slot '
            + fg.role_detail + ' (role_at=' + fg.role_at + ')'
            + ' AND no announced bulk — pattern-match opener'
            + ' classification BLOCKED; routed as normal SP (short'
            + ' outings, if any, treated by the SP-weight n_priors'
            + ' haircut). If a bulk gets announced later, the announced'
            + '-bulk branch above will pick up the tandem naturally.');
          // isOpener stays false; falls through to writeDetection below.
        } else {
          const fg = q.getFgRoleByMlbId.get(spRow.mlb_id);
          const fgSaysReliever = fg && (fg.role === 'RP' || fg.role === 'CL');
          if (fgSaysReliever) {
            // Confirming signal: pitches per appearance over last ~10 outings.
            // < 30 pitches/app is the proxy for "<2 IP". When we have no
            // data (recent callup), trust the FG signal alone.
            const outings = db.prepare(
              "SELECT pitches_thrown FROM pitcher_game_log WHERE pitcher_mlb_id=? ORDER BY game_date DESC LIMIT 10"
            ).all(spRow.mlb_id);
            const avgPitches = outings.length
              ? outings.reduce((s, o) => s + (o.pitches_thrown || 0), 0) / outings.length
              : null;
            if (avgPitches == null || avgPitches < 30) {
              isOpener = true;
              plannedBatters = 4; // spec default until per-pitcher tuning lands
              // No announced bulk reached this branch (the early
              // if-announcedBulk branch above handles those). Fall back
              // to identifyBulkGuy's historical-pattern scoring.
              bulkGuy = identifyBulkGuy(team, dateStr, sp);
            }
          }
        }
      }

      // Tandem subtype (feat/sp-sp-tandem-forecast-split, 2026-07-04).
      // If both the opener AND the bulk are RR-fresh rotation SPs, tag
      // this as an 'sp_sp' tandem so model.js uses the forecast-driven
      // split formula. Only fires on opener-mode games with a named
      // bulk (game_type='opener' with bulkGuy set). Anything else
      // stays null → classic path is byte-identical.
      let tandemSubtype = null;
      if (isOpener && bulkGuy && spRow && spRow.mlb_id) {
        const bulkMlbId = resolveMlbId(team, bulkGuy);
        if (bulkMlbId && isFreshRotationSp(spRow.mlb_id) && isFreshRotationSp(bulkMlbId)) {
          tandemSubtype = 'sp_sp';
          const spFg   = q.getFgRoleByMlbId.get(spRow.mlb_id);
          const bulkFg = q.getFgRoleByMlbId.get(bulkMlbId);
          console.log('[opener-detect] ' + g.game_id + '/' + side
            + ': tandem_subtype=sp_sp — opener ' + sp
            + ' (' + (spFg && spFg.role_detail) + ') + bulk ' + bulkGuy
            + ' (' + (bulkFg && bulkFg.role_detail) + ')'
            + ' — model.js will derive split from their own forecasts');
        }
      }

      writeDetection(dateStr, g.game_id, side, isOpener, bulkGuy, plannedBatters, tandemSubtype);
      if (isOpener) {
        detectedCount++;
        if (!bulkGuy) unknownBulkCount++;
        console.log('[opener-detect] ' + g.game_id + '/' + side + ': ' + team
          + ' using opener ' + sp + ' → bulk-guy ' + (bulkGuy || 'UNKNOWN')
          + (tandemSubtype ? ' [sp_sp]' : ''));
      }
    }
  }
  console.log('[opener-detect] ' + dateStr + ': ' + detectedCount
    + ' opener-led side(s), ' + unknownBulkCount + ' with unknown bulk-guy');

  // Re-score any opener-flagged games. Signal-processing inside the
  // lineup-job's per-game loop ran BEFORE detectOpeners, so games that
  // flip to opener-mode here never had opener-aware weights applied to
  // their model output. Re-running processGameSignals now picks up the
  // updated is_opener_game_* flags and forecast columns, persists
  // opener/bulk/bullpen weight breakdowns, and re-fires signals against
  // the corrected model_line / model_total.
  let rescored = 0;
  try {
    const openerGames = db.prepare(
      "SELECT * FROM game_log WHERE game_date=? AND (is_opener_game_away=1 OR is_opener_game_home=1)"
    ).all(dateStr);
    if (openerGames.length) {
      const wobaIdx = getWobaIndex();
      for (const row of openerGames) {
        try {
          processGameSignals(row, wobaIdx, settings);
          rescored++;
        } catch (e) {
          console.warn('[opener-detect] re-score failed for ' + row.game_id + ': ' + e.message);
        }
      }
      console.log('[opener-detect] re-scored ' + rescored + '/' + openerGames.length + ' opener game(s)');
    }
  } catch (e) {
    console.warn('[opener-detect] re-score pass failed (non-fatal): ' + e.message);
  }

  return { date: dateStr, detected: detectedCount, unknown_bulk: unknownBulkCount, rescored };
}

// Resolve an abbreviated lineup catcher name (e.g. "A. Martinez") to an
// mlb_id. Returns mlb_id or null. Null on ambiguity (two candidates,
// same last name + initial) — safer to skip than guess wrong.
//
// Two-pass resolution as of fix/catcher-resolution-framing-fallback:
//
//   PASS 1 — team_rosters POS players (original logic).
//     Matches on accent-folded last name + first initial. Misses
//     when the player isn't in team_rosters yet — e.g. recent
//     call-up before the next 6AM roster sync, or a roster-ingest
//     glitch. Two known cases that motivated this fix:
//       - PIT C "E. Rodriguez" (Endy Rodríguez) → missed when
//         called up the day of the slate.
//       - MIA C "Joe Mack" (rookie) → similar.
//
//   PASS 2 — catcher_framing table (new fallback). Format there is
//     "Lastname, Firstname" (Savant leaderboard convention). Parse
//     and apply the same last + first-initial match. catcher_framing
//     is keyed by mlb_id from Savant so an mlb_id resolved here is
//     authoritative for framing purposes — exactly what the caller
//     needs. If still ambiguous (two catchers with same last name +
//     initial), keep the miss. catcher_framing_historical is the
//     last resort for catchers with no current-season sample.
//
// Logs a structured warn line on every miss (after both passes) with
// the lineup name + team so prod misses can be diagnosed without
// re-tracing through the resolution path.
function resolveCatcherMlbId(team, lineupName) {
  if (!team || !lineupName) return null;
  // CASE NORMALIZATION (fix/resolver-team-case-and-single-source).
  // Production callers in processGameSignals derive team from
  // game_id.split('-')[0] / [1], and makeGameId in services/scraper.js
  // lower-cases the abbreviations — so awayAbbr/homeAbbr arrive here
  // as e.g. 'pit', 'stl'. team_rosters.team is stored UPPERCASE by
  // the roster ingest (fetchActiveRosters iterates MLB_TEAM_IDS keys,
  // which are uppercase). SQLite TEXT '=' is case-sensitive, so the
  // PASS 1 q.getPositionPlayers.all('pit') returns ZERO rows — the
  // root cause of the four reported framing misses on PIT/SEA/BOS/
  // STL (none of which had a PASS 2 catcher_framing lifeline because
  // they're absent from that table). Upper-casing once here is the
  // single defensive boundary for every caller.
  team = String(team).toUpperCase();
  const norm = stripSfx(normName(lineupName));
  const parts = norm.split(' ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const firstInit = parts[0][0];

  // PASS 1: team_rosters POS players. Two-tier match.
  //   1a strict: same last name AND same first_init.
  //   1b unique-last-name fallback: if 1a returned ZERO candidates AND
  //      exactly ONE roster row on this team has the matching last
  //      name (any first init), use it. Catches first-name encoding
  //      mismatches where one side has the full first ("Ronald") and
  //      the other has an oddly-normalized form, AND scenarios where
  //      a player's preferred name differs from statsapi's fullName.
  //      Scoped per-team so a "Smith" on one team won't false-match
  //      a "Smith" on another. Skipped when ≥2 last-name matches
  //      exist (genuine ambiguity — same null result as before).
  try {
    const players = q.getPositionPlayers.all(team);
    const candidatesStrict = [];
    const candidatesByLast = [];
    for (const p of players) {
      const pn = stripSfx(normName(p.player_name));
      const pp = pn.split(' ');
      if (pp.length < 2) continue;
      if (pp[pp.length - 1] !== last) continue;
      candidatesByLast.push(p);
      if (pp[0][0] === firstInit) candidatesStrict.push(p);
    }
    if (candidatesStrict.length === 1) return candidatesStrict[0].mlb_id;
    if (candidatesStrict.length === 0 && candidatesByLast.length === 1) {
      // 1b unique-last fallback. Log it so prod can audit any false
      // positives — if a wrong player resolves this way, the warn
      // line in render logs lets us spot it.
      console.warn('[resolver] PASS 1b unique-last fallback: team=' + team
        + ' lineup_name="' + lineupName + '" → resolved to "'
        + candidatesByLast[0].player_name + '" (mlb_id ' + candidatesByLast[0].mlb_id
        + ') — strict last+first_init had zero candidates, only one last-name match on roster');
      return candidatesByLast[0].mlb_id;
    }
    // 2+ strict candidates is ambiguous — fall through to PASS 2; if
    // PASS 2 also resolves uniquely (e.g. only one of them is a
    // catcher per Savant), we'll still get the right answer. Falling
    // through is safe because PASS 2 has its own uniqueness check.
  } catch (e) { /* table missing — keep going */ }

  // PASS 2: catcher_framing direct match. Names are
  // "Lastname, Firstname" — split on comma, normalize each piece,
  // and apply the same matching rule. Loop current-season first,
  // then historical.
  const matchCatcherFraming = (rows) => {
    if (!rows) return null;
    const hits = [];
    for (const r of rows) {
      if (!r.name) continue;
      const commaIdx = r.name.indexOf(',');
      if (commaIdx < 0) continue;                  // unrecognized format → skip
      const rLast  = stripSfx(normName(r.name.slice(0, commaIdx)));
      const rFirst = stripSfx(normName(r.name.slice(commaIdx + 1)));
      if (!rLast || !rFirst) continue;
      // rLast / rFirst are already space-collapsed by normName; use
      // the whole string for last-name match (handles compound
      // surnames like "de la cruz").
      if (rLast === last && rFirst[0] === firstInit) hits.push(r);
    }
    if (hits.length === 1) return hits[0].mlb_id;
    return null;
  };
  try {
    if (q.getAllCatcherFramingNames) {
      const id = matchCatcherFraming(q.getAllCatcherFramingNames.all());
      if (id) return id;
    }
    if (q.getAllCatcherFramingHistNames) {
      const id = matchCatcherFraming(q.getAllCatcherFramingHistNames.all());
      if (id) return id;
    }
  } catch (e) { /* fall through to miss */ }

  // Structured miss log for prod diagnosis. Includes the raw
  // lineupName so the operator can spot encoding artifacts or
  // unexpected formats without re-running the full pipeline.
  console.warn('[framing] catcher resolution miss: team=' + team
    + ' lineup_name="' + lineupName + '" '
    + '(normalized last="' + last + '" first_init="' + firstInit + '")');
  return null;
}

// Fetch the Savant catcher-framing leaderboard and upsert into
// catcher_framing (keyed by mlb_id). Non-fatal per-row; reports counts.
async function runCatcherFramingJob(year) {
  console.log('[framing] fetching Savant catcher-framing leaderboard...');
  try {
    const rows = await fetchCatcherFraming(year);
    let applied = 0;
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        if (!r.mlb_id || !r.pitches || r.pitches <= 0) continue;
        q.upsertCatcherFraming.run(r.mlb_id, r.name || null, r.rv_tot, r.pitches);
        applied++;
      }
    });
    tx(rows);
    console.log('[framing] upserted ' + applied + '/' + rows.length + ' catchers');
    // Daily snapshot. Mirrors the wOBA snapshot pattern at the bottom
    // of routes/api.js ingestWobaCSV — fires right after the upsert so
    // the row set we just landed is the row set archived under today's
    // snapshot_date. Non-fatal: a snapshot failure must never block the
    // live framing load. Date in PT per feat/framing-frv-daily-snapshots
    // brief (note: woba_data_snapshot uses ET — the two are flagged as
    // diverging, awaiting Mike's call on whether to unify).
    try {
      const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      q.snapshotCatcherFraming(snapDate, rows);
      console.log('[framing-snapshot] captured ' + rows.length + ' rows for ' + snapDate);
    } catch (e) {
      console.warn('[framing-snapshot] capture failed (non-fatal): ' + e.message);
    }
    return { success: true, fetched: rows.length, applied };
  } catch (e) {
    console.error('[framing] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Ingest the 2023-2025 historical framing baseline (fallback for catchers
// with little/no current-season sample). Aggregated by mlb_id with a
// min-pitches floor in fetchCatcherFramingHistorical.
async function runCatcherFramingHistJob(opts) {
  const o = opts || {};
  const startY = o.seasonStart || 2023, endY = o.seasonEnd || 2025;
  const minPitches = o.minPitches != null ? o.minPitches : 750;
  console.log('[framing-hist] fetching ' + startY + '-' + endY + ' baseline (min ' + minPitches + ' pitches)...');
  try {
    // Snapshot the existing mlb_id set BEFORE the ingest so the
    // response can report which catchers are newly cleared by the
    // (now lower-qualifier) Savant CSV + our 750-pitch aggregate
    // floor. Used by feat/catcher-framing-hist-lower-qualifier to
    // surface what changed when the Savant URL switched from default
    // (Savant-qualified-only) to min_pitches=1 (everything).
    const beforeRows = db.prepare(
      "SELECT mlb_id, name, pitches FROM catcher_framing_historical"
    ).all();
    const beforeIds = new Set(beforeRows.map((r) => r.mlb_id));

    const rows = await fetchCatcherFramingHistorical({ seasonStart: startY, seasonEnd: endY, minPitches });
    let applied = 0;
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        if (!r.mlb_id || !r.pitches || r.pitches <= 0) continue;
        q.upsertCatcherFramingHist.run(r.mlb_id, r.name || null, r.rv_tot, r.pitches, startY, endY);
        applied++;
      }
    });
    tx(rows);

    // Diff: new catchers cleared the 750-pitch floor that previously
    // weren't in the table. Sorted ascending by pitches so the
    // marginal additions (catchers just above the floor) appear
    // first — those are the ones most likely to have been excluded
    // by Savant's prior default qualifier.
    const newEntries = rows
      .filter((r) => r.mlb_id && r.pitches >= minPitches && !beforeIds.has(r.mlb_id))
      .map((r) => ({ mlb_id: r.mlb_id, name: r.name, pitches: r.pitches, rv_tot: r.rv_tot }))
      .sort((a, b) => a.pitches - b.pitches);

    console.log('[framing-hist] upserted ' + applied + ' catchers'
      + ' (>= ' + minPitches + ' pitches, ' + startY + '-' + endY + ')'
      + ' — was ' + beforeRows.length + ', now ' + applied
      + ', +' + newEntries.length + ' new');

    return {
      success: true,
      applied,
      season_start: startY,
      season_end: endY,
      min_pitches: minPitches,
      before_count: beforeRows.length,
      after_count: applied,
      new_catchers_cleared: newEntries.length,
      new_catcher_details: newEntries,
    };
  } catch (e) {
    console.error('[framing-hist] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Ingest Statcast Fielding Run Value for non-catcher position players
// (Build B). Defaults to the current season; body may override the range.
async function runFieldingFrvJob(opts) {
  const o = opts || {};
  // Default to the trailing 3-season window (currentYear-2 .. currentYear)
  // for stability against year-to-year defensive noise. Daily refresh blends
  // the current season in as it accumulates.
  const curY = new Date().getFullYear();
  const startY = o.seasonStart || (curY - 2);
  const endY = o.seasonEnd || curY;
  console.log('[defense] fetching FRV ' + startY + '-' + endY + ' (positions 3-9, min 200 inn)...');
  try {
    const rows = await fetchFieldingFrv({ seasonStart: startY, seasonEnd: endY });
    let applied = 0;
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        if (!r.mlb_id) continue;
        q.upsertFieldingFrv.run(r.mlb_id, r.name || null, r.total_runs, r.outs_total || 0, r.position || null, startY, endY);
        applied++;
      }
    });
    tx(rows);
    console.log('[defense] upserted ' + applied + ' non-catcher fielders (' + startY + '-' + endY + ')');
    // Daily snapshot — fires after upsert with the same source row
    // set. Each row carries season_start / season_end forward so the
    // archived snapshot retains its trailing-window provenance. PK
    // (snapshot_date, mlb_id, position) handles the multi-position
    // case naturally. Non-fatal: a snapshot failure must never block
    // the live FRV load. PT per the brief; flagged as diverging
    // from wOBA's ET convention pending Mike's call.
    try {
      const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      // Project the upsert row shape onto what snapshotFieldingFrv
      // expects (season_start / season_end overlaid from the job
      // window, since the source rows may not carry them inline).
      const snapRows = rows.map(r => ({
        mlb_id: r.mlb_id,
        name: r.name || null,
        total_runs: r.total_runs,
        outs_total: r.outs_total || 0,
        position: r.position || null,
        season_start: startY,
        season_end: endY,
      }));
      q.snapshotFieldingFrv(snapDate, snapRows);
      console.log('[frv-snapshot] captured ' + snapRows.length + ' rows for ' + snapDate);
    } catch (e) {
      console.warn('[frv-snapshot] capture failed (non-fatal): ' + e.message);
    }
    return { success: true, applied, season_start: startY, season_end: endY };
  } catch (e) {
    console.error('[defense] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Team baserunning daily refresh + snapshot. Fetches FG team-
// aggregated BsR (and components) for the current season, upserts
// into team_baserunning, then mirrors to team_baserunning_snapshot
// at today's PT date. Same shape as runFieldingFrvJob; PT-anchored
// snapshot to match the framing/FRV convention. Non-fatal failure
// on either fetch or snapshot — never blocks the rest of the cron.
//
// AUTH: reuses the same fangraphs_session_cookie the projection
// scraper consumes. Initial implementation tried unauthenticated
// browser-mimic headers and got 403'd by Cloudflare — moved to the
// proven baseHeaders pattern. Cookie pasted by operator via the
// Model tab; if absent, the job logs the missing-cookie state and
// returns success=false (non-fatal — never blocks the cron chain).
async function runBaserunningJob(opts) {
  const o = opts || {};
  const season = o.season || new Date().getFullYear();
  const cookieRow = q.getSetting.get('fangraphs_session_cookie');
  const cookieValue = cookieRow && cookieRow.value ? String(cookieRow.value).trim() : '';
  if (!cookieValue) {
    console.warn('[baserunning] fangraphs_session_cookie not configured — skipping. Paste via Model tab and re-run /admin/refresh/baserunning.');
    return { success: false, error: 'fangraphs_session_cookie not configured. Paste from Model tab.' };
  }
  console.log('[baserunning] fetching FG team BsR for season ' + season + '...');
  try {
    const rows = await fetchTeamBaserunning(season, cookieValue);
    const refreshedAt = new Date().toISOString();
    // Stale-row cleanup. The pre-field-name-fix upsert wrote rows
    // with team = HTML anchor string (e.g. '<A HREF=...>LAD</A>').
    // The clean abbr 'LAD' didn't PK-conflict with the anchor row
    // so both stuck around — verified_count ballooned to 60 with
    // 30 garbage + 30 clean. Drop garbage rows for this season
    // before the upsert so the table converges to 30 clean rows.
    // Also clean the snapshot table cross-season (same root cause).
    let cleanedLive = 0, cleanedSnap = 0;
    try {
      cleanedLive = db.prepare(
        "DELETE FROM team_baserunning WHERE season=? "
        + "AND (team LIKE '%<%' OR length(team) > 4 OR bsr IS NULL)"
      ).run(Number(season)).changes;
      cleanedSnap = db.prepare(
        "DELETE FROM team_baserunning_snapshot "
        + "WHERE team LIKE '%<%' OR length(team) > 4 OR bsr IS NULL"
      ).run().changes;
      if (cleanedLive || cleanedSnap) {
        console.log('[baserunning] cleanup deleted ' + cleanedLive
          + ' stale live row(s), ' + cleanedSnap + ' stale snapshot row(s)');
      }
    } catch (e) {
      console.warn('[baserunning] cleanup failed (non-fatal): ' + e.message);
    }
    q.upsertTeamBaserunning(season, rows, refreshedAt);
    console.log('[baserunning] upserted ' + rows.length + ' team rows for ' + season);
    // Post-write verification — actual SELECT COUNT, not the
    // pre-write rows.length, so the operator can distinguish
    // "mapped 30" from "committed 30 visible to subsequent reads".
    // Also non_null_bsr_count to catch the case where 30 rows
    // commit but every bsr column is null (parser field-name miss).
    let verified_count = null, non_null_bsr_count = null, sample_db = [];
    try {
      const cRow = db.prepare(
        "SELECT COUNT(*) AS n FROM team_baserunning WHERE season=?"
      ).get(Number(season));
      verified_count = cRow ? cRow.n : null;
      const bRow = db.prepare(
        "SELECT COUNT(*) AS n FROM team_baserunning WHERE season=? AND bsr IS NOT NULL"
      ).get(Number(season));
      non_null_bsr_count = bRow ? bRow.n : null;
      sample_db = db.prepare(
        "SELECT season, team, bsr, ubr, wsb, wgdp, sb, cs, g "
        + "FROM team_baserunning WHERE season=? ORDER BY team LIMIT 3"
      ).all(Number(season));
    } catch (e) {
      console.warn('[baserunning] verify-count failed (non-fatal): ' + e.message);
    }
    // Sample parsed rows from the fetched array so the operator can
    // see what got mapped from FG's response — directly comparable
    // to sample_db. If sample_parsed has populated bsr but sample_db
    // doesn't, the write side dropped them.
    const sample_parsed = rows.slice(0, 3);
    try {
      const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      q.snapshotTeamBaserunning(snapDate, season, rows);
      console.log('[baserunning-snapshot] captured ' + rows.length + ' rows for ' + snapDate);
    } catch (e) {
      console.warn('[baserunning-snapshot] capture failed (non-fatal): ' + e.message);
    }
    return {
      success: true,
      applied: rows.length,
      verified_count,
      non_null_bsr_count,
      season,
      cleaned_stale_live_rows: cleanedLive,
      cleaned_stale_snapshot_rows: cleanedSnap,
      sample_parsed,
      sample_db,
    };
  } catch (e) {
    console.error('[baserunning] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Player-level baserunning daily refresh + snapshot. Mirrors
// runBaserunningJob's shape but pulls ind=1 (individuals). Aggregation
// across mid-season trade splits happens inside fetchPlayerBaserunning;
// this job just persists the result. Same fangraphs_session_cookie
// dependency.
async function runPlayerBaserunningJob(opts) {
  const o = opts || {};
  const season = o.season || new Date().getFullYear();
  const cookieRow = q.getSetting.get('fangraphs_session_cookie');
  const cookieValue = cookieRow && cookieRow.value ? String(cookieRow.value).trim() : '';
  if (!cookieValue) {
    console.warn('[player-baserunning] fangraphs_session_cookie not configured — skipping. Paste via Model tab and re-run /admin/refresh/player-baserunning.');
    return { success: false, error: 'fangraphs_session_cookie not configured. Paste from Model tab.' };
  }
  console.log('[player-baserunning] fetching FG player BsR for season ' + season + '...');
  try {
    const rows = await fetchPlayerBaserunning(season, cookieValue);
    const refreshedAt = new Date().toISOString();
    q.upsertPlayerBaserunning(season, rows, refreshedAt);
    console.log('[player-baserunning] upserted ' + rows.length + ' player rows for ' + season);
    // Post-write verification
    let verified_count = null, non_null_bsr_count = null, sample_db = [];
    try {
      verified_count = db.prepare(
        "SELECT COUNT(*) AS n FROM player_baserunning WHERE season=?"
      ).get(Number(season)).n;
      non_null_bsr_count = db.prepare(
        "SELECT COUNT(*) AS n FROM player_baserunning WHERE season=? AND bsr IS NOT NULL"
      ).get(Number(season)).n;
      sample_db = db.prepare(
        "SELECT season, mlbam_id, name, bsr, ubr, wsb, wgdp, sb, cs, g "
        + "FROM player_baserunning WHERE season=? ORDER BY bsr DESC LIMIT 5"
      ).all(Number(season));
    } catch (e) {
      console.warn('[player-baserunning] verify-count failed (non-fatal): ' + e.message);
    }
    const sample_parsed = rows.slice(0, 3);
    try {
      const snapDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      q.snapshotPlayerBaserunning(snapDate, season, rows);
      console.log('[player-baserunning-snapshot] captured ' + rows.length + ' rows for ' + snapDate);
    } catch (e) {
      console.warn('[player-baserunning-snapshot] capture failed (non-fatal): ' + e.message);
    }
    return {
      success: true,
      applied: rows.length,
      verified_count,
      non_null_bsr_count,
      season,
      sample_parsed,
      sample_db,
    };
  } catch (e) {
    console.error('[player-baserunning] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Trailing-window (~365-day rolling) player baserunning. Same shape
// as runPlayerBaserunningJob but with explicit startdate/enddate that
// span across the season boundary. Default window: today minus 365
// days → today (PT). Caller can override via opts.startdate /
// opts.enddate (YYYY-MM-DD) for backfill or special-case runs.
//
// Single rolling window persisted at a time — clear+insert pattern.
// Each successful run also writes a daily snapshot row per player to
// player_baserunning_trailing_snapshot (PT-anchored snapshot_date),
// starting the forward-honest clock so the backtest can read each
// player's trailing-1yr BsR as-of a past game_date.
async function runPlayerBaserunningTrailingJob(opts) {
  const o = opts || {};
  const cookieRow = q.getSetting.get('fangraphs_session_cookie');
  const cookieValue = cookieRow && cookieRow.value ? String(cookieRow.value).trim() : '';
  if (!cookieValue) {
    console.warn('[player-baserunning-trailing] fangraphs_session_cookie not configured — skipping. Paste via Model tab and re-run /admin/refresh/player-baserunning-trailing.');
    return { success: false, error: 'fangraphs_session_cookie not configured. Paste from Model tab.' };
  }
  // Default to PT today − 365 days through PT today. PT for
  // consistency with the framing/FRV/baserunning snapshot tz.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const oneYearAgo = (() => {
    const d = new Date(today + 'T12:00:00Z');
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const startdate = o.startdate || oneYearAgo;
  const enddate   = o.enddate   || today;
  console.log('[player-baserunning-trailing] fetching FG player BsR window=' + startdate + '..' + enddate + '...');
  try {
    const rows = await fetchPlayerBaserunningTrailing(startdate, enddate, cookieValue);
    const refreshedAt = new Date().toISOString();
    q.replacePlayerBaserunningTrailing(rows, startdate, enddate, refreshedAt);
    console.log('[player-baserunning-trailing] persisted ' + rows.length + ' player rows for window ' + startdate + '..' + enddate);
    // Daily snapshot mirror — starts the forward-honest clock. PT date
    // matches the framing/FRV/baserunning snapshot tz. Same delete-then-
    // insert idempotency, so a same-day re-run rewrites cleanly.
    let snapshot_captured = null;
    try {
      const snapDate = today; // PT today, computed above
      q.snapshotPlayerBaserunningTrailing(snapDate, rows, startdate, enddate);
      snapshot_captured = { snapshot_date: snapDate, rows: rows.length, window_startdate: startdate, window_enddate: enddate };
      console.log('[player-baserunning-trailing-snapshot] captured ' + rows.length + ' rows for ' + snapDate);
    } catch (e) {
      console.warn('[player-baserunning-trailing-snapshot] capture failed (non-fatal): ' + e.message);
    }
    // Verification — counts + sanity sample (top BsR rows) + multi-
    // team aggregation visibility so the operator can eyeball how
    // many traded-mid-window players inherit the xMLBAMID aggregation
    // before running the backtest.
    let verified_count = null, non_null_bsr_count = null, sample_db = [];
    let multi_team_count = null, multi_team_sample = [];
    let non_null_pa_count = null;
    try {
      verified_count = db.prepare("SELECT COUNT(*) AS n FROM player_baserunning_trailing").get().n;
      non_null_bsr_count = db.prepare("SELECT COUNT(*) AS n FROM player_baserunning_trailing WHERE bsr IS NOT NULL").get().n;
      non_null_pa_count = db.prepare("SELECT COUNT(*) AS n FROM player_baserunning_trailing WHERE pa IS NOT NULL AND pa > 0").get().n;
      multi_team_count = db.prepare(
        "SELECT COUNT(*) AS n FROM player_baserunning_trailing WHERE stint_count > 1"
      ).get().n;
      // Top 5 by BsR — sanity check the trailing values look right
      // (Carroll/De La Cruz/Buxton range ~8-10 per the probe). pa
      // surfaced too so the pa_weighted construction's denominator is
      // visible alongside the numerator.
      sample_db = db.prepare(
        "SELECT mlbam_id, name, bsr, g, pa, ab, stint_count, window_startdate, window_enddate "
        + "FROM player_baserunning_trailing WHERE bsr IS NOT NULL "
        + "ORDER BY bsr DESC LIMIT 5"
      ).all();
      // Top multi-team players so the operator can eyeball (Devers,
      // any mid-window trade with non-trivial BsR).
      multi_team_sample = db.prepare(
        "SELECT mlbam_id, name, bsr, g, pa, stint_count "
        + "FROM player_baserunning_trailing WHERE stint_count > 1 "
        + "ORDER BY ABS(COALESCE(bsr, 0)) DESC LIMIT 5"
      ).all();
    } catch (e) {
      console.warn('[player-baserunning-trailing] verify-count failed (non-fatal): ' + e.message);
    }
    return {
      success: true,
      applied: rows.length,
      verified_count,
      non_null_bsr_count,
      non_null_pa_count,
      multi_team_count,
      multi_team_pct: (verified_count && verified_count > 0 && multi_team_count != null)
        ? Number((100 * multi_team_count / verified_count).toFixed(2)) : null,
      window: { startdate, enddate },
      snapshot_captured,
      sample_db_top_5_by_bsr: sample_db,
      multi_team_sample,
    };
  } catch (e) {
    console.error('[player-baserunning-trailing] job failed: ' + e.message);
    return { success: false, error: e.message };
  }
}

async function runRosterJob() {
  console.log('[roster] Starting active roster pull for all 30 teams...');
  try {
    const rosters = await fetchActiveRosters();
    let totalPlayers = 0;
    const upsert = q.upsertRoster;
    for (const [team, players] of Object.entries(rosters)) {
      if (!players.length) continue;
      q.clearRoster.run(team);
      for (const p of players) {
        upsert.run(team, p.name, p.mlb_id, p.role, p.hand, p.position || null);
      }
      totalPlayers += players.length;
    }
    console.log(`[roster] statsapi pull done — ${totalPlayers} players across ${Object.keys(rosters).length} teams`);

    // Phase 2: FanGraphs RosterResource overlay. Fetches editorially-curated
    // SP/RP tags and overrides the GS/G heuristic where we have a match.
    // Failure here is non-fatal — we keep the GS/G role.
    let fgResult = { success: false, skipped: true };
    try {
      fgResult = await runFangraphsRolesJob();
    } catch (e) {
      console.error('[fg-roles] runFangraphsRolesJob failed (non-fatal): ' + e.message);
    }

    // Phase 3: manual overrides — always win. Applied last so they sit
    // on top of both fg_role and the GS/G heuristic in team_rosters.role.
    let overridesApplied = 0;
    try {
      const overrides = q.listRoleOverrides.all();
      for (const o of overrides) {
        const info = db.prepare("UPDATE team_rosters SET role=? WHERE mlb_id=?")
          .run(o.role, o.mlb_id);
        if (info.changes > 0) overridesApplied++;
      }
      if (overridesApplied > 0) {
        console.log('[roster] applied ' + overridesApplied + ' manual role override(s)');
      }
    } catch (e) {
      console.warn('[roster] override application failed (non-fatal): ' + e.message);
    }

    return {
      success: true,
      teams: Object.keys(rosters).length,
      pitchers: totalPlayers,
      fg: fgResult,
      overrides_applied: overridesApplied,
    };
  } catch(e) {
    console.error('[roster] Error: '+e.message);
    return { success: false, error: e.message };
  }
}

// Season-cumulative roster pull (statsapi rosterType=fullSeason).
// Writes to team_rosters_season — a SEPARATE table from team_rosters,
// consumed ONLY by resolveBacktestMlbId. Live signal generation
// continues to read team_rosters (active 26-man) so this job can't
// silently change live behavior.
//
// Same delete-then-insert pattern as runRosterJob. No FG roles
// overlay (the role-based filters that matter live aren't applied to
// backtest resolution — backtest only cares about POS slots).
// Non-fatal failure mirrors runRosterJob.
async function runSeasonRosterJob() {
  console.log('[roster-season] Starting season roster pull for all 30 teams...');
  try {
    const rosters = await fetchSeasonRosters();
    let totalPlayers = 0;
    const upsert = q.upsertSeasonRoster;
    for (const [team, players] of Object.entries(rosters)) {
      if (!players.length) continue;
      q.clearSeasonRoster.run(team);
      for (const p of players) {
        upsert.run(team, p.name, p.mlb_id, p.role, p.hand, p.position || null);
      }
      totalPlayers += players.length;
    }
    console.log(`[roster-season] statsapi pull done — ${totalPlayers} players across ${Object.keys(rosters).length} teams`);
    return { success: true, teams: Object.keys(rosters).length, players: totalPlayers };
  } catch(e) {
    console.error('[roster-season] Error: '+e.message);
    return { success: false, error: e.message };
  }
}

// Backtest-only name → mlb_id resolver. Tries the production active-
// roster resolver first (matches today's lineup against today's
// 26-man) and falls back to the season roster (full-season players,
// covers currently-IL stars who were active when the historical
// lineup was set).
//
// LIVE SIGNAL GENERATION DOES NOT CALL THIS. Catcher framing + FRV in
// processGameSignals stay on resolveCatcherMlbId. This function is
// reserved for /admin/lineup-coverage, services/frv-backtest.js, and
// the planned player-BsR backtest — surfaces where lineups are
// historical (5/01-6/14) and the IL'd-now stars need to resolve.
//
// Matching logic mirrors resolveCatcherMlbId's PASS 1 + 1b inline so
// the season-roster path gets the same accent-folding / unique-last-
// name fallback semantics. PASS 2 (catcher_framing) is inherited
// through the resolveCatcherMlbId delegation at the top.
function resolveBacktestMlbId(team, lineupName) {
  // Try the live resolver first — covers active 26-man + framing
  // PASS 2. The live resolver already logs structured warns on miss,
  // which we don't want spamming for routine backtest IL'd-player
  // misses, but accepting a few extra log lines is cheaper than
  // duplicating PASS 2 here.
  const live = resolveCatcherMlbId(team, lineupName);
  if (live) return live;

  // Fall back to season roster. Same matching shape as PASS 1 / 1b.
  if (!team || !lineupName) return null;
  team = String(team).toUpperCase();
  const norm = stripSfx(normName(lineupName));
  const parts = norm.split(' ');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const firstInit = parts[0][0];

  try {
    if (!q.getSeasonPositionPlayers) return null;
    const players = q.getSeasonPositionPlayers.all(team);
    const candidatesStrict = [];
    const candidatesByLast = [];
    for (const p of players) {
      const pn = stripSfx(normName(p.player_name));
      const pp = pn.split(' ');
      if (pp.length < 2) continue;
      if (pp[pp.length - 1] !== last) continue;
      candidatesByLast.push(p);
      if (pp[0][0] === firstInit) candidatesStrict.push(p);
    }
    if (candidatesStrict.length === 1) return candidatesStrict[0].mlb_id;
    if (candidatesStrict.length === 0 && candidatesByLast.length === 1) {
      return candidatesByLast[0].mlb_id;
    }
  } catch (e) { /* season table missing or query failed → null */ }
  return null;
}

// REPLACED 2026-07-02 by the FG Daily Sync bookmarklet + /api/upload/rr-roles.
// FanGraphs blocked server-side RosterResource fetches with HTTP 403 in
// ~2026-06-03; the paid-member workflow now pushes RR JSON same-origin
// from the owner's logged-in browser through the bookmarklet.
//
// Kept as a no-op stub so:
//   - the existing runRosterJob chain (Phase 2 call) stops throwing daily
//   - the /api/jobs/fg-roles manual trigger returns a clear message
//   - services/fangraphs-roles.js is still importable (TEAM_SLUGS is used
//     by the health check)
async function runFangraphsRolesJob() {
  const msg = 'replaced by FG Daily Sync bookmarklet (POST /api/upload/rr-roles)';
  console.log('[fg-roles] SKIP: ' + msg);
  return { success: true, skipped: true, replaced_by: 'fg-daily-sync', message: msg };
}

// Defensive trigger: refresh rosters only when the most recent team_rosters
// row is older than maxAgeHrs (default 24). Belt-and-suspenders for the case
// where the 6AM cron didn't fire (server started up after the cron window,
// process restarted mid-day, etc.). Manual /api/jobs/rosters and the cron
// itself still call runRosterJob() unconditionally.
async function runRosterJobIfStale(maxAgeHrs = 24) {
  try {
    const row = db.prepare("SELECT MAX(updated_at) AS last FROM team_rosters").get();
    const last = row && row.last;
    if (last) {
      // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" UTC; normalize before parse.
      const t = Date.parse(last.replace(' ', 'T') + 'Z');
      if (!isNaN(t)) {
        const ageHrs = (Date.now() - t) / 3600000;
        if (ageHrs < maxAgeHrs) {
          console.log('[roster] skip: last refresh ' + ageHrs.toFixed(1) + 'h ago (< ' + maxAgeHrs + 'h)');
          return { success: true, skipped: true, ageHrs: +ageHrs.toFixed(2) };
        }
      }
    }
    return await runRosterJob();
  } catch(e) {
    console.error('[roster-if-stale] Error: ' + e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { runRosterJob, runRosterJobIfStale, runSeasonRosterJob, runFangraphsRolesJob, runCatcherFramingJob, runCatcherFramingHistJob, runFieldingFrvJob, runBaserunningJob, runPlayerBaserunningJob, runPlayerBaserunningTrailingJob, runLineupJob, runScoreJob, runOddsJob, runWeatherJob, runPitcherUsageBackfill, detectOpeners, processGameSignals, processOddsArray, runMorningCaptureJob, getWobaIndex, getWobaIndexAsOf, getSettings, startCronJobs, nowPtIso, resolveCatcherMlbId, resolveBacktestMlbId, cohortForGameDate };
