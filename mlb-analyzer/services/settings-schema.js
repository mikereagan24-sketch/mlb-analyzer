// Typed schema for app_settings. The legacy free-form key/value table let a
// blank submit, a stray non-numeric value, or a violated cross-field invariant
// silently corrupt the model. Every setting the model reads is now declared
// here with type, range, default, optional invariant, and help text. POST
// /api/settings, the settings UI, and the settings_sanity health check all
// read from this single source of truth.
//
// Note on key names: this schema uses the EXISTING app_settings keys
// (bp_strong_weight_r, tot_lean_edge, ml_3star_edge, ...) rather than the
// abbreviated forms (bp_strong_r, tot_lean, ...) so live app_settings rows
// don't need a rename migration.

const SETTINGS_SCHEMA = {
  // --- Pitching weights (SP vs bullpen on the pitcher side) -----------------
  sp_pit_weight: { type: 'number', min: 0.5, max: 0.95, default: 0.75,
    help: 'Starting pitcher weight in pitching component (vs bullpen). Must sum to 1.0 with relief_pit_weight.' },
  relief_pit_weight: { type: 'number', min: 0.05, max: 0.5, default: 0.25,
    invariant: (v, all) => Math.abs(v + Number(all.sp_pit_weight) - 1.0) < 0.02,
    invariantMsg: 'sp_pit_weight + relief_pit_weight must equal 1.0',
    help: 'Bullpen weight in pitching component (vs SP). Must sum to 1.0 with sp_pit_weight.' },

  // --- Bullpen by handedness (manager assumption weights) -------------------
  bp_strong_weight_r: { type: 'number', min: 0.3, max: 0.8, default: 0.55,
    help: 'R-bullpen strong-arm weight vs RHB.' },
  bp_weak_weight_r: { type: 'number', min: 0.2, max: 0.7, default: 0.45,
    invariant: (v, all) => Math.abs(v + Number(all.bp_strong_weight_r) - 1.0) < 0.02,
    invariantMsg: 'bp_strong_weight_r + bp_weak_weight_r must equal 1.0',
    help: 'R-bullpen weak-arm weight vs RHB.' },
  bp_strong_weight_l: { type: 'number', min: 0.2, max: 0.7, default: 0.35,
    help: 'L-bullpen strong-arm weight vs LHB.' },
  bp_weak_weight_l: { type: 'number', min: 0.3, max: 0.8, default: 0.65,
    invariant: (v, all) => Math.abs(v + Number(all.bp_strong_weight_l) - 1.0) < 0.02,
    invariantMsg: 'bp_strong_weight_l + bp_weak_weight_l must equal 1.0',
    help: 'L-bullpen weak-arm weight vs LHB.' },

  // --- Opener-aware pitching split (Phase 2) -------------------------------
  // Activated only when use_opener_logic=true AND a side has
  // is_opener_game_<side>=1 + bulk_guy_<side>. The three weights replace
  // sp_pit_weight / relief_pit_weight on that side; non-opener sides keep
  // the standard split. Defaults: 0.15 / 0.60 / 0.25 = opener / bulk /
  // leftover bullpen, calibrated as ~1 IP / ~5 IP / ~3 IP of a 9-inning
  // team day. Sum-to-1 invariant lives on bulk_pit_weight.
  opener_pit_weight: { type: 'number', min: 0.05, max: 0.30, default: 0.15,
    help: 'Opener weight in pitching component for opener-led games. Default 0.15 ≈ 1 inning of 9 plus high-leverage premium.' },
  bulk_pit_weight: { type: 'number', min: 0.40, max: 0.80, default: 0.60,
    invariant: (v, all) => Math.abs(Number(all.opener_pit_weight) + v + Number(all.opener_relief_pit_weight) - 1.0) < 0.02,
    invariantMsg: 'opener_pit_weight + bulk_pit_weight + opener_relief_pit_weight must equal 1.0',
    help: 'Bulk-guy weight in opener-led games. Default 0.60 ≈ 5 innings of 9 plus workhorse share.' },
  opener_relief_pit_weight: { type: 'number', min: 0.10, max: 0.40, default: 0.25,
    help: 'Leftover bullpen weight in opener-led games. Default 0.25 ≈ 3 innings of 9 (later, lower-leverage).' },
  // Phase 2 feature flag — DEFAULT FALSE. When false, opener-led games
  // run the standard SP path (opener as the SP) and the opener-aware
  // values are computed in shadow only. Flipping to true is the moment
  // v3 cohort taints; do not enable until shadow comparison has run for
  // ≥1 week and the diffs look right.
  use_opener_logic: { type: 'boolean', default: false,
    help: 'Phase 2: enable opener-aware pitching split for opener-led games. Default false; opener_model_* is shadowed when off, swapped with model_* when on.' },

  // --- SP/RP split (model side) --------------------------------------------
  sp_weight: { type: 'number', min: 0.5, max: 0.95, default: 0.80,
    help: 'SP weight in run estimation.' },
  relief_weight: { type: 'number', min: 0.05, max: 0.5, default: 0.20,
    invariant: (v, all) => Math.abs(v + Number(all.sp_weight) - 1.0) < 0.02,
    invariantMsg: 'sp_weight + relief_weight must equal 1.0',
    help: 'Bullpen weight in run estimation.' },

  // --- Pitching vs batting blend -------------------------------------------
  w_pit: { type: 'number', min: 0.4, max: 0.7, default: 0.40,
    help: 'Pitching component weight in run-rate calc.' },
  w_bat: { type: 'number', min: 0.4, max: 0.7, default: 0.60,
    invariant: (v, all) => Math.abs(v + Number(all.w_pit) - 1.0) < 0.02,
    invariantMsg: 'w_pit + w_bat must equal 1.0',
    help: 'Batting component weight.' },

  // --- Projection vs actual blend ------------------------------------------
  w_proj: { type: 'number', min: 0.0, max: 1.0, default: 0.70,
    help: 'Steamer projection weight in batter wOBA blend.' },
  w_act: { type: 'number', min: 0.0, max: 1.0, default: 0.30,
    invariant: (v, all) => Math.abs(v + Number(all.w_proj) - 1.0) < 0.02,
    invariantMsg: 'w_proj + w_act must equal 1.0',
    help: 'FanGraphs actuals weight.' },

  // --- Run scoring environment ---------------------------------------------
  run_mult: { type: 'number', min: 30, max: 60, default: 45.5,
    help: 'Run-scoring multiplier in run-rate to runs/game conversion.' },
  bullpen_avg: { type: 'number', min: 0.25, max: 0.40, default: 0.318,
    help: 'League-avg bullpen wOBA reference.' },
  hfa_boost: { type: 'number', min: 0.0, max: 0.10, default: 0.025,
    help: 'Home-field advantage boost on home WP.' },

  // --- Catcher framing (run-environment adjustment) ------------------------
  catcher_framing_enabled: { type: 'boolean', default: false,
    help: 'Apply projected catcher framing runs to the opposing offense run estimate. Default OFF — requires the catcher_framing table to be populated by the Savant ingest. No-op when off or when no framing row exists for the catcher.' },
  catcher_framing_mute: { type: 'number', min: 0.0, max: 1.0, default: 0.65,
    help: 'Fraction of measured framing run value applied. <1 because pitcher wOBA-against already partially reflects framing from the usual batterymate; this captures the differential without double-counting. 0.65 = applies most of the value, since tonight\'s catcher often differs from the pitcher\'s sampled batterymates.' },
  catcher_framing_abs_factor: { type: 'number', min: 0.0, max: 1.0, default: 0.80,
    help: 'Scaling applied to the 2023-2025 historical framing baseline to express pre-ABS values in 2026-equivalent units (ABS cut framing ~20%). Only affects the historical fallback; current-season 2026 data is used as-is. Net effect on a fallback catcher: ×abs_factor ×mute.' },
  catcher_framing_min_pitches_2026: { type: 'number', min: 0, max: 5000, default: 750,
    help: 'Minimum 2026 called pitches for a catcher\'s current-season framing to be trusted. Below this, fall back to the 2023-2025 baseline (scaled by abs_factor). Matches the historical ingest floor.' },
  catcher_framing_takes_per_game: { type: 'number', min: 30, max: 90, default: 58,
    help: 'Leaguewide shadow-zone called takes per full team-game (~58). The framing pitches column counts these takes, not total pitches; per-game framing = (rv_tot/pitches) x this. Environmental constant, not a per-catcher estimate.' },

  // --- Defensive impact / Fielding Run Value (Build B) ---------------------
  defense_frv_enabled: { type: 'boolean', default: false,
    help: 'Apply team defensive Fielding Run Value (sum of 7 non-catcher fielders) to the opposing offense run estimate. Default OFF — requires the fielding_frv table to be populated. No-op when off or when no fielders resolve. Catcher defense is handled separately by the framing feature.' },
  defense_frv_mute: { type: 'number', min: 0.0, max: 1.0, default: 0.5,
    help: 'Fraction of team fielding run value applied. <1 because pitcher wOBA-against already partially reflects the defense played behind the pitcher in his sample; this captures the differential without double-counting.' },
  defense_frv_opps_per_game: { type: 'number', min: 10, max: 40, default: 25,
    help: 'Fielding opportunities a starting fielder sees per full game (~25, near-constant across non-catcher positions per the FRV outs_total data). Per-game FRV = (total_runs/outs_total) x this. Environmental constant.' },

  // --- Starting-pitcher source precedence ---------------------------------
  // When ON, RotoWire wins on conflict with statsapi for away_sp/home_sp:
  // RotoWire scrapes posted/announced lineups, which lead statsapi on
  // reshuffled games (e.g. det-bal-g2 2026-05-24: statsapi had stale
  // 'Framber Valdez', RotoWire had correct 'Troy Melton'). When a side's
  // RotoWire value is NULL (not yet posted), statsapi is preserved
  // regardless of this flag — a null RotoWire never blanks out a present
  // statsapi value. Default ON because RotoWire-wins is the corrected
  // behavior; flip OFF here (no redeploy) to roll back if it proves worse.
  sp_prefer_rotowire: { type: 'boolean', default: true,
    help: 'When ON (default), RotoWire wins over statsapi when both supply a starting pitcher and they disagree. RotoWire pulls confirmed/announced lineups, which lead statsapi probables on reshuffled / doubleheader games. A null/missing RotoWire SP is NEVER allowed to overwrite a present statsapi value (the null-safety check is independent of this flag). sp_source_conflict still fires on every disagreement regardless of which value wins. Flip OFF to fall back to statsapi-wins precedence.' },

  // --- Kalshi-direct moneyline (override Unabated/OddsAPI ML primary) -------
  kalshi_direct_primary_enabled: { type: 'boolean', default: false,
    help: 'When ON, fetch MLB moneylines directly from Kalshi (services/kalshi.js, pre-game only) and OVERRIDE the ML on any oddsRaw row that Kalshi covers. The Unabated/OddsAPI fetch still runs and supplies (a) ML for games Kalshi does not cover and (b) totals/spreads for every game (Kalshi-direct is ML-only for now). Locked games are skipped. Default OFF — dormant.' },

  // --- Kalshi-direct totals (override Unabated/OddsAPI over/under prices) ---
  // Independent of the ML flag so totals can be toggled separately.
  kalshi_direct_totals_enabled: { type: 'boolean', default: false,
    help: 'When ON, fetch MLB totals from Kalshi (services/kalshi.js, pre-game only) and OVERRIDE over_price/under_price on any oddsRaw row Kalshi covers. The total LINE (market_total) is preserved from the Unabated/OddsAPI backup; Kalshi only supplies fee-adjusted prices for that line. If Kalshi has no rung within 0.5 of market_total, the override is skipped (game stays on backup). Kalshi-implied fair total is recorded in kalshi_implied_total for divergence observation regardless. Locked games are skipped. Default OFF — dormant.' },
  tot_slope: { type: 'number', min: 0.05, max: 0.15, default: 0.08,
    help: 'Total-runs slope in over/under conversion.' },

  // --- Win-prob clamps ------------------------------------------------------
  wp_clamp_lo: { type: 'number', min: 0.20, max: 0.50, default: 0.30,
    help: 'Lower bound on model win probability.' },
  wp_clamp_hi: { type: 'number', min: 0.50, max: 0.80, default: 0.70,
    invariant: (v, all) => Number(all.wp_clamp_lo) < v,
    invariantMsg: 'wp_clamp_lo must be less than wp_clamp_hi',
    help: 'Upper bound on model win probability.' },
  tot_prob_lo: { type: 'number', min: 0.20, max: 0.50, default: 0.30,
    help: 'Lower bound on model over/under probability.' },
  tot_prob_hi: { type: 'number', min: 0.50, max: 0.80, default: 0.70,
    invariant: (v, all) => Number(all.tot_prob_lo) < v,
    invariantMsg: 'tot_prob_lo must be less than tot_prob_hi',
    help: 'Upper bound on model over/under probability.' },

  // --- Continuous-edge thresholds (feat/continuous-edge-score) -------------
  // Replaces the legacy ml_/tot_lean/value/3star tier system. ALL units
  // are probability points as decimals (0.05 = 5pp). getSignals emits
  // every signal with raw edge >= signal_emit_floor_pp; the UI decides
  // highlighting against direction-specific minimums independently. The
  // floor exists primarily to bound the bet_signals write rate — every
  // emitted row is forward-collected data for threshold refinement.
  signal_emit_floor_pp: { type: 'number', min: 0.005, max: 0.10, default: 0.01,
    help: 'Minimum raw probability-edge for any signal (ML or Total) to be persisted. Set low to collect data.' },
  // Direction-specific UI highlight minimums. Comparison is against the
  // ROUNDED 0.5pp score (Math.round(edge*100/0.5)*0.5/100), not the raw
  // edge, so the UI display and highlight condition stay consistent.
  // Defaults are seeded from a 1270+/625-candidate backtest:
  //   * Favorites historically performed at lower edge thresholds.
  //   * Dog edges needed more cushion before becoming +EV.
  //   * Totals UNDERS at >=7pp were the strongest signal in backtest;
  //     overs were flat/negative at every threshold, so highlighting
  //     is gated behind an explicit enabled flag.
  ui_highlight_ml_fav_min_pp: { type: 'number', min: 0.005, max: 0.10, default: 0.02,
    invariant: (v, all) => v >= Number(all.signal_emit_floor_pp),
    invariantMsg: 'ui_highlight_ml_fav_min_pp must be >= signal_emit_floor_pp',
    help: 'Rounded-score (pp) threshold above which an ML favorite signal is highlighted.' },
  ui_highlight_ml_dog_min_pp: { type: 'number', min: 0.005, max: 0.10, default: 0.045,
    invariant: (v, all) => v >= Number(all.signal_emit_floor_pp),
    invariantMsg: 'ui_highlight_ml_dog_min_pp must be >= signal_emit_floor_pp',
    help: 'Rounded-score (pp) threshold above which an ML underdog signal is highlighted.' },
  ui_highlight_tot_under_min_pp: { type: 'number', min: 0.01, max: 0.20, default: 0.07,
    invariant: (v, all) => v >= Number(all.signal_emit_floor_pp),
    invariantMsg: 'ui_highlight_tot_under_min_pp must be >= signal_emit_floor_pp',
    help: 'Rounded-score (pp) threshold above which a Totals under signal is highlighted.' },
  ui_highlight_tot_overs_enabled: { type: 'boolean', default: false,
    help: 'When false, Totals over signals are never highlighted regardless of edge (backtest showed no edge in overs).' },

  // --- Misc -----------------------------------------------------------------
  woba_baseline: { type: 'number', min: 0.20, max: 0.30, default: 0.230,
    help: 'League-avg wOBA baseline used as fallback.' },
  pyth_exp: { type: 'number', min: 1.5, max: 2.5, default: 1.83,
    help: 'Pythagorean exponent for win prob.' },
  market_total_dflt: { type: 'number', min: 6.0, max: 11.0, default: 8.5,
    help: 'Default market total when fetch returns null and xcheck also null.' },
};

// Keys that legitimately bypass the typed schema: free-form text/JSON values
// the API still accepts (text auth secrets, the JSON-encoded PA weights array,
// and a few non-validated knobs the legacy UI exposes that aren't worth the
// schema entry yet). validateSetting passes these through unchanged.
const PASSTHROUGH_KEYS = new Set([
  'odds_api_key',
  'fangraphs_session_cookie',
  'pa_weights',
  // Legacy numeric settings the schema doesn't enumerate yet — kept so a POST
  // including them doesn't 400 out the whole request. Add a schema entry to
  // validate any of these.
  'fav_adj', 'dog_adj',
  'wind_scale',
  'min_pa', 'min_bf',
  'bat_dflt_start', 'bat_dflt_opp',
  'unknown_pitcher_woba',
]);

function validateSetting(key, value, allSettings) {
  const def = SETTINGS_SCHEMA[key];
  if (!def) {
    if (PASSTHROUGH_KEYS.has(key)) return { ok: true, value };
    return { ok: false, error: 'Unknown setting: ' + key };
  }
  if (value === '' || value == null) return { ok: false, error: key + ' cannot be blank' };
  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: key + ' must be a number, got: ' + value };
    if (n < def.min || n > def.max) return { ok: false, error: key + ' must be between ' + def.min + ' and ' + def.max + ', got: ' + n };
    if (def.invariant) {
      const merged = { ...allSettings, [key]: n };
      if (!def.invariant(n, merged)) return { ok: false, error: def.invariantMsg };
    }
    return { ok: true, value: n };
  }
  if (def.type === 'boolean') {
    // app_settings stores TEXT, so accept the common encodings — true/false,
    // 1/0, and the strings 'true'/'false'/'1'/'0'. Coerce to a real boolean
    // for the validator's return value; storage downstream stringifies.
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === '1' || value === 1) return { ok: true, value: true };
    if (value === 'false' || value === '0' || value === 0) return { ok: true, value: false };
    return { ok: false, error: key + ' must be boolean (true/false/1/0), got: ' + value };
  }
  return { ok: true, value };
}

function validateAll(updates, currentSettings) {
  const merged = { ...currentSettings, ...updates };
  const errors = [];
  for (const [k, v] of Object.entries(updates)) {
    const result = validateSetting(k, v, merged);
    if (!result.ok) errors.push(result.error);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function getDefaults() {
  const out = {};
  for (const [k, def] of Object.entries(SETTINGS_SCHEMA)) out[k] = def.default;
  return out;
}

// Schema view safe to send to the browser: drops the invariant function (not
// JSON-serializable) but keeps invariantMsg + a list of dependency keys the
// client can use to know when to re-run the invariant locally for UX feedback.
function getSchemaForClient() {
  const out = {};
  const fnSrc = fn => fn && fn.toString();
  for (const [k, def] of Object.entries(SETTINGS_SCHEMA)) {
    const deps = [];
    if (def.invariant) {
      const src = fnSrc(def.invariant);
      const m = src && src.match(/all\.(\w+)/g);
      if (m) for (const x of m) deps.push(x.slice(4));
    }
    out[k] = {
      type: def.type, min: def.min, max: def.max, default: def.default,
      help: def.help || '',
      invariantMsg: def.invariantMsg || null,
      dependsOn: Array.from(new Set(deps)),
    };
  }
  return out;
}

module.exports = {
  SETTINGS_SCHEMA,
  PASSTHROUGH_KEYS,
  validateSetting,
  validateAll,
  getDefaults,
  getSchemaForClient,
};
