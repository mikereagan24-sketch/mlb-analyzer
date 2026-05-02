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
  w_proj: { type: 'number', min: 0.5, max: 1.0, default: 0.70,
    help: 'Steamer projection weight in batter wOBA blend.' },
  w_act: { type: 'number', min: 0.0, max: 0.5, default: 0.30,
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

  // --- Signal thresholds: ML (in cents / American-odds points) -------------
  ml_lean_edge: { type: 'number', min: 5, max: 50, default: 18,
    help: 'Edge (cents) for 1-star ML signal.' },
  ml_value_edge: { type: 'number', min: 10, max: 75, default: 30,
    invariant: (v, all) => Number(all.ml_lean_edge) < v,
    invariantMsg: 'ml_lean_edge must be less than ml_value_edge',
    help: 'Edge (cents) for 2-star ML signal.' },
  ml_3star_edge: { type: 'number', min: 15, max: 100, default: 45,
    invariant: (v, all) => Number(all.ml_value_edge) < v,
    invariantMsg: 'ml_value_edge must be less than ml_3star_edge',
    help: 'Edge (cents) for 3-star ML signal.' },

  // --- Signal thresholds: Total (implied-prob points) ----------------------
  tot_lean_edge: { type: 'number', min: 0.02, max: 0.20, default: 0.05,
    help: 'Implied-prob edge for 1-star Total signal.' },
  tot_value_edge: { type: 'number', min: 0.04, max: 0.25, default: 0.08,
    invariant: (v, all) => Number(all.tot_lean_edge) < v,
    invariantMsg: 'tot_lean_edge must be less than tot_value_edge',
    help: 'Implied-prob edge for 2-star Total signal.' },
  tot_3star_edge: { type: 'number', min: 0.06, max: 0.30, default: 0.11,
    invariant: (v, all) => Number(all.tot_value_edge) < v,
    invariantMsg: 'tot_value_edge must be less than tot_3star_edge',
    help: 'Implied-prob edge for 3-star Total signal.' },

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
