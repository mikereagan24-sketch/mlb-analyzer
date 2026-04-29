// jobs.js v2026-04-12T19:57:39.540Z
// File encoding: UTF-8 (do not save as Windows-1252)
const cron = require('node-cron');
const { q, db } = require('../db/schema');
const { fetchLineups, fetchLineupsRaw, parseLineupsHtml, fetchScores, fetchScoresRaw, parseScoresJson, fetchOddsAPI, fetchKalshiDirect, makeGameId, fetchActiveRosters, fetchSchedule } = require('./scraper');
const { fetchUnabatedOdds, fetchUnabatedRaw, parseUnabatedOdds } = require('./unabated');
const { runModel, getSignals, calcPnl } = require('./model');
const { fetchParkWind } = require('./weather');
const { normName } = require('../utils/names');
const { calcCLV } = require('./clv');
const { writeSnapshot } = require('./snapshot');

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
    ML_VALUE_EDGE:  num('ml_value_edge',     _d('ml_value_edge', 40)),
    ML_LEAN_EDGE:   num('ml_lean_edge',      _d('ml_lean_edge', 20)),
    TOT_VALUE_EDGE: num('tot_value_edge',    _d('tot_value_edge', 0.08)),
    ML_3STAR_EDGE:  num('ml_3star_edge',     _d('ml_3star_edge', 60)),
    TOT_3STAR_EDGE: num('tot_3star_edge',    _d('tot_3star_edge', 0.12)),
    TOT_LEAN_EDGE:  num('tot_lean_edge',     _d('tot_lean_edge', 0.05)),
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
    odds_api_key: s['odds_api_key'] || null,
  };
}

function getWobaIndex() {
  const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
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
function processGameSignals(gameRow, wobaIdx, settings) {
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
  const LEAGUE_BP = 0.318;
  let awayBpVsR = LEAGUE_BP, awayBpVsL = LEAGUE_BP;
  let homeBpVsR = LEAGUE_BP, homeBpVsL = LEAGUE_BP;
  let awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  try {
    if (q.getBullpenWobaBlended) {
      const homeLineupArr = tryParse(gameRow.home_lineup_json) || [];
      const awayLineupArr = tryParse(gameRow.away_lineup_json) || [];
      const awayBp = q.getBullpenWobaBlended(awayAbbr, awaySpName, homeLineupArr, _bpStrongR, _bpWeakR, _bpStrongL, _bpWeakL, _wProj, _wAct, gameRow.game_date, _unknownWoba);
      const homeBp = q.getBullpenWobaBlended(homeAbbr, homeSpName, awayLineupArr, _bpStrongR, _bpWeakR, _bpStrongL, _bpWeakL, _wProj, _wAct, gameRow.game_date, _unknownWoba);
      if (awayBp?.vsRHB) awayBpVsR = awayBp.vsRHB;
      if (awayBp?.vsLHB) awayBpVsL = awayBp.vsLHB;
      if (homeBp?.vsRHB) homeBpVsR = homeBp.vsRHB;
      if (homeBp?.vsLHB) homeBpVsL = homeBp.vsLHB;
      awayBpWoba = awayBp?.woba || LEAGUE_BP;
      homeBpWoba = homeBp?.woba || LEAGUE_BP;
    }
  } catch(e) { /* fallback to league avg */ }
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
  };
  const model = runModel(game, wobaIdx, settings);
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
  // When suppressed, emit empty signals — the bet_signals lifecycle below
  // still runs (DELETE unlocked, deactivate locked-but-no-longer-qualifying)
  // so stale signals from a prior run get cleaned up. Locked bet_lines are
  // preserved by the existing locked-line restore loop.
  const signals = suppressed ? [] : getSignals(game, model, settings);
  // If lineup is projected (not yet confirmed), save as proj_model snapshot.
  // Skip the model_* UPDATE entirely when suppressed (model values are null
  // and .toFixed would throw; we'd rather leave prior values than null them
  // out — the lineups_complete health check + the empty signals array
  // already communicate the suppression state to the UI).
  const isProjected = !gameRow.away_lineup_status || gameRow.away_lineup_status === 'projected';
  const hasProjSnapshot = gameRow.proj_model_away_ml != null;
  if (!suppressed && isProjected) {
    // Lineup still projected — keep proj snapshot current
    db.prepare(`UPDATE game_log SET proj_model_away_ml=?, proj_model_home_ml=?, proj_model_total=?, model_away_ml=?, model_home_ml=?, model_total=?, proj_market_away_ml=COALESCE(proj_market_away_ml, ?), proj_market_home_ml=COALESCE(proj_market_home_ml, ?), proj_market_total=COALESCE(proj_market_total, ?), updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), gameRow.market_away_ml||null, gameRow.market_home_ml||null, gameRow.market_total||null, gameRow.game_date, gameRow.game_id);
  } else if (!suppressed) {
    // Confirmed lineup — proj snapshot is frozen, update current model only
    db.prepare(`UPDATE game_log SET model_away_ml=?, model_home_ml=?, model_total=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);
  }
  const gl = q.getGameById.get(gameRow.game_date, gameRow.game_id);
  if (!gl) return;
  // If game is already final (scored), freeze all signals — don't rewrite
  if (gl.away_score != null) {
    // Just grade any ungraded signals and return — never wipe a completed game's signals
    const existing = db.prepare('SELECT * FROM bet_signals WHERE game_date=? AND game_id=?').all(gameRow.game_date, gameRow.game_id);
    const updateSig = db.prepare('UPDATE bet_signals SET outcome=?, pnl=? WHERE id=?');
    for (const ex of existing) {
      if (ex.outcome !== 'pending') continue;
      const { outcome, pnl } = calcPnl(
        {type:ex.signal_type, side:ex.signal_side, marketLine:ex.market_line},
        gl.away_score, gl.home_score, gl.market_total, gl.over_price, gl.under_price
      );
      if (outcome !== 'pending') updateSig.run(outcome, pnl, ex.id);
    }
    return;
  }

  // Preserve any locked bet_lines before wiping signals
  const lockedLines = db.prepare(
    'SELECT signal_type, signal_side, bet_line, bet_locked_at, closing_line, clv FROM bet_signals WHERE game_date=? AND game_id=? AND bet_line IS NOT NULL'
  ).all(gameRow.game_date, gameRow.game_id);
  db.prepare('DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND (bet_line IS NULL OR bet_line=0)').run(gameRow.game_date, gameRow.game_id);
  for (const sig of signals) {
    const { outcome, pnl } = (gl.away_score != null)
      ? calcPnl({type:sig.type, side:sig.side, marketLine:sig.type==='ML'?(sig.side==='away'?gl.market_away_ml:gl.market_home_ml):gl.market_total, over_price:gl.over_price, under_price:gl.under_price}, gl.away_score, gl.home_score, gl.market_total)
      : { outcome: 'pending', pnl: 0 };
    q.insertSignal.run({
      game_log_id: gl.id,
      game_date: gameRow.game_date,
      game_id: gameRow.game_id,
      signal_type: sig.type,
      signal_side: sig.side,
      signal_label: sig.label,
      category: sig.category,
      market_line: sig.type === 'ML'
        ? (sig.side === 'away' ? gl.market_away_ml : gl.market_home_ml)
        : gl.market_total,
      model_line: sig.type === 'ML'
        ? (sig.side === 'away' ? model.aML : model.hML)
        : parseFloat(model.estTot.toFixed(2)),
      edge_pct: sig.edge,
      outcome,
      pnl,
      cohort: gameRow.game_date < '2026-04-24' ? 'v3-pretuning' : 'v3',
    });
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
  db.prepare(`DELETE FROM bet_signals WHERE game_date=? AND game_id=? AND id NOT IN (
    SELECT MAX(id) FROM bet_signals WHERE game_date=? AND game_id=? GROUP BY signal_type, signal_side
  )`).run(gameRow.game_date, gameRow.game_id, gameRow.game_date, gameRow.game_id);
  // Restore bet_lines for locked signals.
  // If a locked signal no longer qualifies, mark is_active=0 with a note instead of deleting.
  // This keeps it in backtesting but hides it from the Games tab.
  const newSigKeys = new Set(signals.map(s=>s.type+'|'+s.side));
  if (lockedLines.length) {
    for (const locked of lockedLines) {
      if (!newSigKeys.has(locked.signal_type+'|'+locked.signal_side)) {
        // Signal no longer qualifies — deactivate with a note
        // When suppressed (incomplete lineup), model_* values are null;
        // skip .toFixed and write a suppression note instead.
        const finalMdl = suppressed
          ? null
          : (locked.signal_type === 'Total'
              ? parseFloat(model.estTot.toFixed(2))
              : (locked.signal_side === 'away' ? model.aML : model.hML));
        const mktRef = locked.signal_type === 'Total'
          ? (gameRow.market_total != null ? ', mkt=' + gameRow.market_total : '')
          : (locked.signal_side === 'away'
              ? (gameRow.market_away_ml != null ? ', mkt=' + gameRow.market_away_ml : '')
              : (gameRow.market_home_ml != null ? ', mkt=' + gameRow.market_home_ml : ''));
        const note = suppressed
          ? 'Lineup incomplete (' + (model._suppressed_detail || 'no batters') + ') — model output suppressed, signal deactivated.'
          : 'Model ' + locked.signal_type.toLowerCase() + ' at rerun: ' + finalMdl + mktRef + ' — edge no longer meets threshold.';
        db.prepare("UPDATE bet_signals SET is_active=0, notes=? WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?")
          .run(note, gameRow.game_date, gameRow.game_id, locked.signal_type, locked.signal_side);
        try {
          const deact = db.prepare(
            "SELECT id FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?"
          ).get(gameRow.game_date, gameRow.game_id, locked.signal_type, locked.signal_side);
          q.insertBetSignalAudit({
            signal_id: deact ? deact.id : null,
            game_date: gameRow.game_date,
            game_id: gameRow.game_id,
            signal_type: locked.signal_type,
            signal_side: locked.signal_side,
            action: 'auto_deactivate',
            bet_line: locked.bet_line,
            closing_line: locked.closing_line,
            clv: locked.clv,
            source: 'process_game_signals_deactivate',
            detail: note,
          });
        } catch(e) { /* audit failure must not block lifecycle */ }
        console.log('[model] Deactivated stale signal: '+locked.signal_type+'/'+locked.signal_side+' | '+note);
        continue;
      }
      db.prepare(
        'UPDATE bet_signals SET bet_line=?, bet_locked_at=?, closing_line=?, clv=? WHERE game_date=? AND game_id=? AND UPPER(signal_type)=UPPER(?) AND UPPER(signal_side)=UPPER(?)'
      ).run(locked.bet_line, locked.bet_locked_at, locked.closing_line, locked.clv,
            gameRow.game_date, gameRow.game_id, locked.signal_type, locked.signal_side);
    }
  }
  return { model, signals };
}

async function runLineupJob(dateStr) {
  dateStr = dateStr || todayStr();
  console.log('[lineup-job] Starting for ' + dateStr);
  let gamesUpdated = 0;
  try {
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
    // Recompute game_id after normalization
    g.game_id = (g.away_team + '-' + g.home_team).toLowerCase();
  }
  // Deduplicate by game_id (keep last)
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

    for (const g of games) {
      const gameId = g.game_id || makeGameId(g.away_team, g.home_team);
      const awayLU = (g.away_lineup || []).map(b => ({ name: b.name, hand: b.hand }));
      const homeLU = (g.home_lineup || []).map(b => ({ name: b.name, hand: b.hand }));
      const existingRow = q.getGameById.get(dateStr, gameId);
        // Lock odds 10min before game start — only for TODAY's games, never future dates
        const todayForLock = new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
        if (existingRow && !existingRow.odds_locked_at && existingRow.game_time && dateStr === todayForLock) {
          const tm = existingRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (tm) {
            let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
            if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
            const nowPT=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
            const minsToGame=(h*60+mn)-(nowPT.getHours()*60+nowPT.getMinutes());
            if(minsToGame<=10&&minsToGame>=-240){
              db.prepare("UPDATE game_log SET odds_locked_at=datetime('now') WHERE game_date=? AND game_id=? AND odds_locked_at IS NULL").run(dateStr,gameId);
              console.log('[odds] Locked '+gameId+' ('+minsToGame+'min)');
              // Auto-set closing lines on any ML signals for this game
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
        q.upsertGame.run({
        game_date: dateStr,
        game_id: gameId,
        away_team: g.away_team,
        home_team: g.home_team,
        game_time: g.time || null,
        away_sp: g.away_sp && g.away_sp.name,
        away_sp_hand: g.away_sp && g.away_sp.hand,
        home_sp: g.home_sp && g.home_sp.name,
        home_sp_hand: g.home_sp && g.home_sp.hand,
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
        }, wobaIdx, settings);
        gamesUpdated++;
      }
    }

    q.logCron.run('lineups', dateStr, 'success', 'Pulled ' + games.length + ' games (date verified)', gamesUpdated);
    console.log('[lineup-job] Done — ' + gamesUpdated + ' games processed');
    return { success: true, gamesUpdated, date: dateStr };

  } catch (err) {
    console.error('[lineup-job] Error:', err.message);
    q.logCron.run('lineups', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

// Fetch pitcher usage (pitch counts) from MLB Stats API for a given date.
// Returns array of { team, pitcher_name, pitcher_mlb_id, pitches_thrown }.
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
          out.push({ team: teamAbbr, pitcher_name: name, pitcher_mlb_id: pid, pitches_thrown: Number(pitches)||0 });
        }
      }
    } catch(e) {
      console.log('[pitcher-usage] boxscore fail for gamePk=' + g.gamePk + ': ' + e.message);
    }
  }
  return out;
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
        for (const sig of signals) {
          const { outcome } = calcPnl(
            { type: sig.signal_type, side: sig.signal_side, marketLine: sig.market_line, bet_line: sig.bet_line },
            s.awayScore ?? s.away_score, s.homeScore ?? s.home_score, gameRow.market_total
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
              const _price = sig.signal_side === 'over' ? (gameRow.over_price || -110) : (gameRow.under_price || -110);
              const _stake = _price < 0 ? Math.abs(_price) : parseFloat((10000/_price).toFixed(2));
              _pnl = outcome === 'win' ? 100 : parseFloat((-_stake).toFixed(2));
            }
          }
          updateSignal.run(outcome, parseFloat(_pnl.toFixed(2)), sig.id);
        }
        gamesUpdated++;
      }
    }
    // Pull pitcher usage from MLB Stats API and record for fatigue tracking.
    let pitcherRecords = 0;
    try {
      const usage = await fetchPitcherUsage(dateStr);
      for (const u of usage) {
        q.upsertPitcherGameLog.run(dateStr, u.team, u.pitcher_name, u.pitcher_mlb_id, u.pitches_thrown, 1);
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
  console.log('[weather] running for '+date);
  let updated = 0;
  try {
    const games = q.getGamesByDate.all(date);
    if (!games.length) { console.log('[weather] no games for '+date); return { success: true, updated: 0, date: date, note: 'no games' }; }
    const { calcWindFactor, PARKS } = require('./weather');
    const settings = getSettings();
    const wobaIdx = getWobaIndex();
    const month = new Date(date).getMonth() + 1;
    for (const game of games) {
      const parts = game.game_id.split('-');
      const homeKey = parts[1];
      const park = PARKS[homeKey];
      if (!park || park.dome) continue;
      // Parse game hour from game_time (stored as "7:05 PM ET" etc)
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
      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude='+park.lat+'&longitude='+park.lng
          +'&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability'
          +'&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto'
          +'&start_date='+date+'&end_date='+date;
        const wd = await fetch(url, {
          headers: { 'User-Agent': 'mlb-analyzer/1.0 (https://github.com/mikereagan24-sketch/mlb-analyzer)' },
        }).then(r => r.json());
        // Validate before touching game_log. The previous "|| 0" / "|| 65"
        // pattern silently wrote 65°F + 0mph when Open-Meteo returned an
        // empty response, overwriting good data the UI's client-side fetch
        // had already PATCHed in. On bad data: log + skip the UPDATE so
        // last-good values survive and the freshness clock keeps ticking
        // toward the existing expired/stale gates.
        if (!wd || !wd.hourly || !Array.isArray(wd.hourly.time) || !wd.hourly.time.length) {
          console.warn('[weather] '+game.game_id+': empty/invalid response, leaving last-good data: '+JSON.stringify(wd).slice(0,200));
          continue;
        }
        const idx = Math.min(gameHour, wd.hourly.time.length - 1);
        if (idx < 0) {
          console.warn('[weather] '+game.game_id+': bad gameHour='+gameHour+', leaving last-good data');
          continue;
        }
        const _speed  = wd.hourly.wind_speed_10m?.[idx];
        const _dir    = wd.hourly.wind_direction_10m?.[idx];
        const _temp   = wd.hourly.temperature_2m?.[idx];
        const _precip = wd.hourly.precipitation_probability?.[idx];
        if (![_speed, _dir, _temp, _precip].every(v => Number.isFinite(v))) {
          console.warn('[weather] '+game.game_id+': missing fields (speed='+_speed+' dir='+_dir+' temp='+_temp+' precip='+_precip+'), leaving last-good data');
          continue;
        }
        const speed = parseFloat(_speed.toFixed(1));
        const dir   = Math.round(_dir);
        const temp  = parseFloat(_temp.toFixed(1));
        const precip = _precip;
        const windFactor = calcWindFactor(dir, speed, park);
        const tempAdj = temp < 55 ? -0.5 : temp < 70 ? 0 : temp < 80 ? 0.3 : 0.6;
        // Roof logic
        let roofStatus = 'open', roofMult = 1;
        if (park.roofType === 'retractable') {
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
        const effWind = windFactor * roofMult;
        const effTemp = roofStatus === 'closed' ? 0 : tempAdj * roofMult;
        if (q.updateWindData) {
          q.updateWindData.run(speed, dir, effWind, temp, effTemp, roofStatus, 'estimated', date, game.game_id);
        } else {
          db.prepare("UPDATE game_log SET wind_speed=?,wind_dir=?,wind_factor=?,temp_f=?,temp_run_adj=?,roof_status=?,roof_confidence=?,weather_quality='fresh',weather_quality_at=datetime('now') WHERE game_date=? AND game_id=?")
            .run(speed, dir, effWind, temp, effTemp, roofStatus, 'estimated', date, game.game_id);
        }
        const latestRow = q.getGameById.get(date, game.game_id);
        if (latestRow) processGameSignals(latestRow, wobaIdx, settings);
        updated++;
      } catch(e) { console.error('[weather] '+game.game_id+':', e.message); }
    }
    console.log('[weather] updated '+updated+' games for '+date);
    return { success: true, updated: updated, date: date };
  } catch(e) {
    console.error('[weather] job error:', e.message);
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

  console.log('[cron] Scheduled in America/Los_Angeles: lineups 8A + hourly 12-6P + 11P, odds 8A/11A/3P/5P, scores 4A, roster 6A, morning refresh 7A, tomorrow-slate prefetch 8P + refresh 11P');
}

function gameHasStarted(gameRow, gameDate) {
  // Returns true if game start time has passed (game is live or finished).
  // Only games on TODAY's date (Pacific) can have started. NOTE: assumes
  // gameRow.game_time text is PT-local ("7:05 PM" = 7:05 PM PT). If game_time
  // is stored in a different TZ this comparison needs adjusting.
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
  if (!gameRow || !gameRow.game_time) return false;
  if (gameDate && gameDate !== today) return false; // future/past dates never "in progress"
  const tm = gameRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!tm) return false;
  let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
  if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
  const nowPT=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles'}));
  const minsToGame=(h*60+mn)-(nowPT.getHours()*60+nowPT.getMinutes());
  return minsToGame < -5; // started more than 5 min ago
}

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
    const haveTot = o.market_total != null && o.over_price != null && o.under_price != null;
    const haveXcheckTot = o.xcheck_total != null && o.xcheck_over_price != null && o.xcheck_under_price != null;
    if (!haveTot && !haveXcheckTot) {
      reasons.push('no sane totals: no source provided matching-line O/U');
    } else if (!haveTot && haveXcheckTot) {
      reasons.push('no primary totals; edge calc using xcheck only');
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
    db.prepare(`UPDATE game_log SET
      market_away_ml=?, market_home_ml=?,
      market_total=?, over_price=?, under_price=?, total_source=?,
      ml_source=COALESCE(?, ml_source),
      xcheck_ml_source=COALESCE(?, xcheck_ml_source),
      xcheck_away_ml=?, xcheck_home_ml=?,
      xcheck_total=?,
      xcheck_over_price=?,
      xcheck_under_price=?,
      xcheck_total_source=COALESCE(?, xcheck_total_source),
      odds_flagged=?, odds_flag_reason=?,
      odds_quality='fresh', odds_quality_at=datetime('now'),
      updated_at=datetime('now')
      WHERE game_date=? AND game_id=?`)
      .run(o.market_away_ml, o.market_home_ml,
           o.market_total, o.over_price, o.under_price, o.total_source || null,
           o.ml_source || null,
           o.xcheck_ml_source || null,
           o.xcheck_away_ml != null ? o.xcheck_away_ml : null,
           o.xcheck_home_ml != null ? o.xcheck_home_ml : null,
           o.xcheck_total != null ? o.xcheck_total : null,
           o.xcheck_over_price != null ? o.xcheck_over_price : null,
           o.xcheck_under_price != null ? o.xcheck_under_price : null,
           o.xcheck_total_source || null,
           oddsFlagged, oddsReason,
           dateStr, o.game_id);
    const gameRow = q.getGameById.get(dateStr, o.game_id);
    if (gameRow) { processGameSignals(gameRow, wobaIdx, settings); updated++; }
  }
  return { updated, source: odds.length ? (odds[0].source || 'odds') : 'no source' };
}

async function runOddsJob(dateStr) {
  dateStr = dateStr || todayStr();
  try {
    const settings = getSettings();
    let oddsRaw = [];
    try {
      console.log('[odds] Fetching from Unabated...');
      // Split fetch into raw + parse so the snapshot system captures the
      // upstream JSON before any transformation; /api/replay/odds re-runs
      // parseUnabatedOdds against the captured payload without re-fetching.
      const unabatedRawJson = await fetchUnabatedRaw();
      writeSnapshot('odds', dateStr, unabatedRawJson);
      oddsRaw = parseUnabatedOdds(unabatedRawJson, dateStr);
      console.log('[odds] Unabated returned '+oddsRaw.length+' games');
      if (!oddsRaw.length) throw new Error('Unabated returned 0 games');
    } catch(e) {
      console.log('[odds] Unabated failed: '+e.message+' → falling back to Odds API');
      try {
        oddsRaw = await fetchOddsAPI(settings.odds_api_key, dateStr);
      } catch(e2) {
        console.log('[odds] Odds API also failed: '+e2.message);
        oddsRaw = []; // ensure array, don't throw — just log and continue
      }
    }

    // Statsapi-authoritative gate: drop any odds row whose game_id doesn't
    // map to a game in statsapi's schedule for dateStr. statsapi is the
    // single source of truth for *which games exist*; Unabated / Odds API
    // only enrich. processOddsArray today uses UPDATE (so a phantom can't
    // create a row), but if that ever loosens this filter prevents a
    // misidentified Unabated contract from poisoning a slate. Schedule
    // fetch failure is non-fatal — degrade open and let the existing
    // ingest path run.
    if (oddsRaw.length) {
      let validIds = null;
      try {
        const sched = await fetchSchedule(dateStr);
        validIds = new Set(sched.map(g => g.game_id));
      } catch (e) {
        console.warn('[odds] schedule fetch for valid-game gate failed: '+e.message+' (proceeding without gate)');
      }
      if (validIds) {
        const before = oddsRaw.length;
        oddsRaw = oddsRaw.filter(o => {
          if (validIds.has(o.game_id)) return true;
          console.warn('[unabated] rejecting phantom matchup not in statsapi: ' + o.game_id);
          return false;
        });
        if (oddsRaw.length < before) {
          console.log('[odds] gated out '+(before - oddsRaw.length)+' game(s) not in statsapi schedule');
        }
      }
    }

    const result = processOddsArray(dateStr, oddsRaw, settings);
    const updated = result.updated;
    const sourceLabel = result.source;
    q.logCron.run('odds', dateStr, 'success', 'Updated ' + updated + ' game(s) from ' + sourceLabel, updated);
    return { success: true, updated, date: dateStr };
  } catch(err) {
    console.error('[odds-job]', err.message);
    q.logCron.run('odds', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message };
  }
}


async function runRosterJob() {
  console.log('[roster] Starting active roster pull for all 30 teams...');
  try {
    const rosters = await fetchActiveRosters();
    let totalPitchers = 0;
    const upsert = q.upsertRoster;
    for (const [team, pitchers] of Object.entries(rosters)) {
      if (!pitchers.length) continue;
      q.clearRoster.run(team);
      for (const p of pitchers) {
        upsert.run(team, p.name, p.mlb_id, p.role, p.hand);
      }
      totalPitchers += pitchers.length;
    }
    console.log(`[roster] Done — ${totalPitchers} pitchers across ${Object.keys(rosters).length} teams`);
    return { success: true, teams: Object.keys(rosters).length, pitchers: totalPitchers };
  } catch(e) {
    console.error('[roster] Error: '+e.message);
    return { success: false, error: e.message };
  }
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

module.exports = { runRosterJob, runRosterJobIfStale, runLineupJob, runScoreJob, runOddsJob, runWeatherJob, processGameSignals, processOddsArray, getWobaIndex, getSettings, startCronJobs };
