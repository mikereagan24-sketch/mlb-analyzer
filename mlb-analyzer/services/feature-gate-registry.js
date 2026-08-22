'use strict';

// FEATURE GATE REGISTRY + SELF-REPORTING HEALTH CHECK (2026-08-23)
//
// WHY THIS EXISTS. The ARI roof scraper sat broken for most of a season
// because nothing reported its own silence — the failure mode was not a
// bug, it was the absence of anything that would notice. Gated features
// have the same shape: a flag ships OFF "pending a backtest", the
// backtest never gets run or gets run and never recorded, and the
// feature is indistinguishable from one that was deliberately rejected.
//
// This registry makes each gate state its own criterion, its own window,
// and whether a decision was ever recorded. evaluateGates() then reports
// any gate whose window has elapsed with no decision, or whose stated
// precondition has since been met while the gate stayed shut.
//
// THE REGISTRY IS THE SOURCE OF TRUTH FOR "WHY IS THIS OFF". If you flip
// a flag, record the decision here in the same commit. A gate with
// decision:null and an elapsed window is a bug in our process, and the
// health check is designed to say so out loud.
//
// criterion_type semantics — this matters after the 2026-08-21 finding
// that ROI sweeps measure SELECTION rather than pricing (see
// docs/sweep-selection-effect-2026-08-21.md and the CLAUDE.md rule):
//   'roi'          graded on ROI over emitted signals — SELECTION-
//                  CONTAMINATED. The metric cannot move for a bet that
//                  is kept, so only composition can move it. Any such
//                  criterion needs re-specifying before it can decide
//                  anything.
//   'calibration'  graded on a target computed over ALL games (log
//                  loss / Brier / ECE / margin MAE). Immune.
//   'precondition' gated on data existing, not on a measurement.
//   'mechanism'    argued from construction, not measured.
//   'none'         no criterion was ever written down. These are the
//                  ones that go silently stale.

const STATUS = {
  DECIDED: 'decided',                       // a human recorded an outcome
  IN_WINDOW: 'in_window',                   // evaluation window still open
  ELAPSED_NO_DECISION: 'elapsed_no_decision', // ⚠ window passed, nothing recorded
  AWAITING_DECISION: 'awaiting_decision',   // ⚠ precondition met, gate still shut
  BLOCKED: 'blocked',                       // precondition genuinely unmet
  NO_CRITERION: 'no_criterion',             // ⚠ nobody wrote down what would decide it
};

// Preconditions are functions of the db so the check reflects reality
// rather than a stale note. Return true when the stated blocker has
// cleared.
const PRECONDITIONS = {
  fielding_frv_populated: (db) => tableCount(db, 'fielding_frv') > 0,
  catcher_framing_populated: (db) => tableCount(db, 'catcher_framing') > 0,
  bsr_snapshots_60d: (db) =>
    distinctCount(db, 'team_baserunning_snapshot', 'snapshot_date') >= 60,
  bsr_forward_games_500: (db) => {
    const first = scalar(db, 'SELECT MIN(snapshot_date) v FROM team_baserunning_snapshot');
    if (!first) return false;
    return scalar(db, 'SELECT COUNT(*) v FROM game_log WHERE game_date >= ? AND home_score IS NOT NULL', [first]) >= 500;
  },
  hand_conditional_shadow_accumulating: (db) =>
    scalar(db, 'SELECT COUNT(*) v FROM game_log WHERE home_sp_weight_used IS NOT NULL') > 0,
  at_emit_columns_populated: (db) =>
    scalar(db, 'SELECT COUNT(*) v FROM bet_signals WHERE model_home_ml_at_emit IS NOT NULL') > 0,
};

function tableCount(db, t) {
  try { return db.prepare('SELECT COUNT(*) n FROM ' + t).get().n; } catch (e) { return 0; }
}
function distinctCount(db, t, c) {
  try { return db.prepare('SELECT COUNT(DISTINCT ' + c + ') n FROM ' + t).get().n; } catch (e) { return 0; }
}
function scalar(db, sql, params) {
  try { const r = db.prepare(sql).get(...(params || [])); return r ? r.v : null; } catch (e) { return null; }
}

// ---------------------------------------------------------------------
// THE REGISTRY
//
// decision: null means NOBODY EVER RECORDED ONE. Do not fill it in to
// silence the check — fill it in when a decision is actually made, with
// the doc that records it.
// ---------------------------------------------------------------------
const GATES = [
  // ---- settings-gated, currently ON ----
  { id: 'use_opener_logic', key: 'use_opener_logic', on_expected: true,
    criterion: 'Phase 2 opener-aware pitching split; opener_model_* shadowed when off.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-05', outcome: 'enabled', ref: 'docs/opener-tandem-blend-audit-2026-07-05.md' } },

  { id: 'catcher_framing_enabled', key: 'catcher_framing_enabled', on_expected: true,
    criterion: 'Requires catcher_framing populated by the Savant ingest.',
    criterion_type: 'precondition', precondition: 'catcher_framing_populated', window_end: null,
    decision: { date: '2026-07-05', outcome: 'enabled', ref: 'docs/framing-mute-semantics-2026-07-05.md' } },

  { id: 'park_neutral_inputs_enabled', key: 'park_neutral_inputs_enabled', on_expected: true,
    criterion: 'Calibration A/B: log loss / Brier / ECE over all games, with vs without.',
    criterion_type: 'calibration', window_end: null,
    decision: { date: '2026-08-23', outcome: 'validated_directionally_not_significant',
                ref: 'docs/gate-evaluations-2026-08-23.md' },
    note: 'CORRECTION to the 2026-08-23 inventory, which filed this as forgotten. An A/B DOES exist — PR #142, '
        + 'scripts/backtest-park-neutral.js, +3.32pp totals ROI. Two problems with it: it is ROI-based (therefore '
        + 'selection-contaminated) and it PREDATES a correction to the feature itself (the 2026-07-02 audit found '
        + 'over-neutralization of ~2.2pp on extreme-park hitters; the actuals-only fix landed at model.js:381 and '
        + 'was never re-validated). Re-run on calibration 2026-08-23: the flag moves p(home) on 84.4% of games and '
        + 'is better on ALL FIVE metrics (log loss 0.68975 vs 0.69029, Brier, ECE, AUC, edge slope), but '
        + 'delta log loss -0.00055 CI [-0.00117, +0.00012] does not clear zero. Directionally validated, not '
        + 'statistically established. No case to turn it off.' },

  { id: 'signal_venue_aware_enabled', key: 'signal_venue_aware_enabled', on_expected: true,
    criterion: 'Best net at-size price across Poly + Kalshi with fillable-at-stake guard.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-07', outcome: 'enabled', ref: 'docs/venue-aware-signals-2026-07-07.md' } },

  { id: 'kalshi_direct_primary_enabled', key: 'kalshi_direct_primary_enabled', on_expected: true,
    criterion: 'Kalshi-direct ML as primary over Unabated/OddsAPI.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-10', outcome: 'enabled', ref: 'docs/demote-unabated-from-betting-path-2026-07-10.md' } },

  { id: 'kalshi_direct_totals_enabled', key: 'kalshi_direct_totals_enabled', on_expected: true,
    criterion: 'Replacement writer for market_total after Unabated demotion.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-10', outcome: 'enabled', ref: 'CLAUDE.md demotion-pre-flight rule' } },

  { id: 'signal_edge_cap_enabled', key: 'signal_edge_cap_enabled', on_expected: true,
    criterion: 'Suppress signals at edge >= hard cap; flag [soft,hard).',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-13', outcome: 'enabled', ref: 'docs/ship-hard-cap-0.08-2026-07-13.md' },
    note: 'Decision was ROI-based. The 2026-08-22 edge-honesty scope found NO independent support for the 8pp level '
        + '(above-cap honesty is not worse than below-cap). The cap may still be right; its stated basis is contaminated.' },

  { id: 'bullpen_downweight_starters', key: 'bullpen_downweight_starters', on_expected: true,
    criterion: 'Exclude/downweight starter innings from bullpen wOBA.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-07', outcome: 'enabled', ref: 'docs/bullpen-fix-steps-1-2-plus-blend-2026-07-07.md' } },

  { id: 'sp_prefer_rotowire', key: 'sp_prefer_rotowire', on_expected: true,
    criterion: 'Prefer Rotowire probable-SP over statsapi.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-04', outcome: 'enabled', ref: 'docs/sp-forecast-abbrev-name-2026-07-04.md' } },

  // ---- settings-gated, currently OFF ----
  { id: 'defense_frv_enabled', key: 'defense_frv_enabled', on_expected: false,
    criterion: 'Default OFF — "requires the fielding_frv table to be populated".',
    criterion_type: 'calibration', precondition: 'fielding_frv_populated',
    window_end: '2026-09-30', decision: null,
    note: 'PRECONDITION CLEARED (fielding_frv populated; the key is not even in app_settings, so it runs on the '
        + 'schema default). EVALUATION WRITTEN AND RUN 2026-08-23 rather than flipping: scripts/calibration-ab.js '
        + 'DEFENSE_FRV_ENABLED false true. Result — the flag moves p(home) on 100% of games (mean |dp| 0.0083) and '
        + 'is better on ALL FIVE metrics, with the largest edge-slope improvement measured anywhere (-0.313 -> '
        + '-0.218), but delta log loss -0.00087 CI [-0.00211, +0.00065] does not clear zero. '
        + 'FLIP CRITERION: delta_log_loss CI excludes zero on the negative side, on >= 1200 games. '
        + 'WINDOW: re-evaluate 2026-09-30. Do not flip before then. '
        + 'NOTE the first run reported the flag as INERT — a harness artifact, because runModel reads '
        + 'game.{away,home}FieldingRunsPerGame which the caller populates and the harness did not. '
        + 'scripts/calibration-ab.js now hard-fails on that class rather than reporting a false negative.' },

  { id: 'use_hand_conditional_sp_weight', key: 'use_hand_conditional_sp_weight', on_expected: false,
    criterion: 'BLOCKED — the flag is not wired. No criterion can apply until it can be flipped.',
    criterion_type: 'none', precondition: 'hand_conditional_shadow_accumulating',
    window_end: null, decision: null,
    blocked_reason: 'getSettings() never maps use_hand_conditional_sp_weight (nor sp_weight_r / sp_weight_l), '
                  + 'so model.js reads undefined and the flag is permanently false regardless of app_settings.',
    note: 'NOT "awaiting a decision" — UNFLIPPABLE. services/jobs.js:getSettings() returns an explicit hand-mapped '
        + 'whitelist, and USE_HAND_CONDITIONAL_SP_WEIGHT is not in it, so model.js reads undefined and '
        + '!!undefined === false ALWAYS. No app_settings value can turn this on. SP_WEIGHT_R and SP_WEIGHT_L are '
        + 'also unmapped, so model.js falls back to its hardcoded 0.865 / 0.649 — which means the operator-tuned '
        + 'sp_weight_l=0.7 in app_settings is silently ignored. Shadow logging still fires because the alt path '
        + 'uses those hardcoded constants. This is the UI-parity rule inverted: schema key + UI control + '
        + 'app_settings value, with no getSettings mapping to read them. FIX FIRST (map all three keys in '
        + 'getSettings, verify sp_weight_l takes effect), THEN write a flip criterion. Writing one now would be '
        + 'premature — there is nothing to flip.' },

  { id: 'ui_highlight_tot_overs_enabled', key: 'ui_highlight_tot_overs_enabled', on_expected: false,
    criterion: 'Backtest showed no edge in overs.',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-05', outcome: 'deliberately_dark', ref: 'settings-schema help text' },
    note: 'Genuinely decided, and the decision is recorded — but the evidence was ROI-based and is therefore '
        + 'selection-contaminated. Worth re-deriving on a calibration target before treating "no edge in overs" as settled.' },

  // ---- numeric gates ----
  { id: 'signal_edge_hard_cap_pp', key: 'signal_edge_hard_cap_pp', numeric: true,
    criterion: 'Hard suppression threshold. Shipped at 0.08 (schema default 0.25).',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-13', outcome: 'shipped_at_0.08', ref: 'docs/ship-hard-cap-0.08-2026-07-13.md' },
    note: 'See docs/edge-honesty-scope-2026-08-22.md — this analysis found no independent support for the level.' },

  { id: 'signal_edge_soft_cap_pp', key: 'signal_edge_soft_cap_pp', numeric: true,
    criterion: 'Flag-but-emit threshold. Shipped at 0.06 (schema default 0.1).',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-13', outcome: 'shipped_at_0.06', ref: 'docs/ship-hard-cap-0.08-2026-07-13.md' } },

  { id: 'catcher_framing_mute', key: 'catcher_framing_mute', numeric: true,
    criterion: 'Muting factor on framing runs. Schema default 0.65.',
    criterion_type: 'none', window_end: null, decision: null,
    note: 'Prod runs 1.0 — i.e. NO muting — against a schema default of 0.65. That is a live divergence from the '
        + 'documented default with no recorded rationale.' },

  { id: 'defense_frv_mute', key: 'defense_frv_mute', numeric: true,
    criterion: 'Muting factor on team FRV. Schema default 0.5.',
    criterion_type: 'none', window_end: null, decision: null,
    note: 'Unset — moot while defense_frv_enabled is off, but becomes live the moment that flips.' },

  { id: 'catcher_framing_takes_per_game', key: 'catcher_framing_takes_per_game', numeric: true,
    criterion: 'Framing takes/game conversion constant. Schema default 58.',
    criterion_type: 'none', window_end: null, decision: null,
    note: 'Unset — running on the schema default, which is fine, but the constant has no recorded derivation.' },

  { id: 'sp_weight_l', key: 'sp_weight_l', numeric: true,
    criterion: 'Hand-conditional SP_WEIGHT vs LHP. Empirical benchmark 0.649.',
    criterion_type: 'calibration', window_end: null, decision: null,
    note: 'Prod app_settings says 0.7; the empirical benchmark is 0.649. NEITHER IS READ — getSettings() does not '
        + 'map sp_weight_l, so model.js uses its hardcoded 0.649 fallback. The stored 0.7 has never had any '
        + 'effect. Same root cause as use_hand_conditional_sp_weight.' },

  // ---- non-settings gates ----
  { id: 'bsr_baserunning', key: null,
    criterion: 'RE-SPEC 2026-08-23: calibration (log loss over all games) PRIMARY, accuracy (margin MAE) second, '
             + 'CLV demoted to context and split by same-side vs churn. Was: accuracy + CLV with CLV weighted heaviest.',
    criterion_type: 'calibration', window_end: '2026-09-14', decision: null,
    precondition: 'bsr_snapshots_60d',
    note: 'Gate window 2026-08-13..2026-09-14. CLV prong is selection-contaminated — 330 of 348 bets are the same '
        + 'side in both configs and contribute exactly zero, so the delta is 41 marginal bets. And the gate weights '
        + 'CLV HEAVIEST. See docs/bsr-gate-status-2026-08-23.md.' },

  { id: 'bullpen_w_proj_w_act', key: 'bullpen_w_proj', numeric: true,
    criterion: 'Phase-3-blocked pending per-date wOBA snapshots.',
    criterion_type: 'roi', window_end: null, decision: null,
    note: 'The global W_PROJ/W_ACT pair was unblocked and measured 2026-08-21 (no distinguishable effect). The '
        + 'BULLPEN pair was NOT — it routes through a different blend (db/schema.js) with a different actuals gate, '
        + 'so nothing transfers. Still genuinely unmeasured.' },

  { id: 'at_emit_snapshot_columns', key: null,
    criterion: 'Freeze emit-time model lines so post-hoc analysis can distinguish emit state from current state.',
    criterion_type: 'precondition', precondition: 'at_emit_columns_populated', window_end: null,
    decision: { date: '2026-08-23', outcome: 'verified_working_on_emit_path',
                ref: 'docs/feature-gate-inventory-2026-08-23.md' },
    note: 'VERIFIED: q.upsertSignal does populate all four columns — confirmed by observing freshly emitted rows '
        + 'carry them. The all-NULL state in older snapshots is simply that the columns post-date those rows. '
        + 'REMAINING GAP, not a gate: POST /signals/manual omits them entirely and its ON CONFLICT overwrites '
        + 'market_line/model_line/edge_pct from current values, so a manual log on an existing signal still '
        + 'destroys the emit baseline. Tracked in docs/one-click-bet-logging-design-2026-08-23.md; the one-click '
        + 'path deliberately avoids that endpoint.' },

  { id: 'retractable_roof_config_branch', key: null,
    criterion: 'Per-park roofType/defaultClosed/tempClose heuristic in runWeatherJob.',
    criterion_type: 'none', window_end: null,
    decision: { date: '2026-08-20', outcome: 'documented_dead', ref: 'docs/sea-canopy-roof-scope-2026-08-20.md' },
    note: 'Dead by construction — no park carries roofType, so the branch and the "partial" roof state never fire. '
        + 'Documented rather than removed, deliberately, as the fallback path.' },
];

// ---------------------------------------------------------------------
function readSetting(db, key) {
  try {
    const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    return r ? r.value : null;
  } catch (e) { return null; }
}

// evaluateGates(db, opts) -> { today, total, counts, gates: [...] }
// opts.today lets callers/tests pin the date; defaults to server local date.
function evaluateGates(db, opts) {
  const o = opts || {};
  const today = o.today || new Date().toISOString().slice(0, 10);
  const out = [];
  for (const g of GATES) {
    const raw = g.key ? readSetting(db, g.key) : null;
    const prodValue = g.key ? (raw == null ? '(unset — schema default)' : raw) : '(not a setting)';
    let precondMet = null;
    if (g.precondition && PRECONDITIONS[g.precondition]) {
      try { precondMet = !!PRECONDITIONS[g.precondition](db); } catch (e) { precondMet = null; }
    }
    const elapsed = !!(g.window_end && today > g.window_end);

    let status;
    // An explicit `blocked_reason` wins over everything: a gate that
    // CANNOT be flipped is not awaiting a decision, and reporting it as
    // such would send someone to make a decision they cannot act on.
    if (g.blocked_reason) status = STATUS.BLOCKED;
    else if (g.decision) status = STATUS.DECIDED;
    else if (elapsed) status = STATUS.ELAPSED_NO_DECISION;
    else if (g.window_end) status = STATUS.IN_WINDOW;
    else if (precondMet === true) status = STATUS.AWAITING_DECISION;
    else if (precondMet === false) status = STATUS.BLOCKED;
    else status = STATUS.NO_CRITERION;

    out.push({
      id: g.id,
      settings_key: g.key || null,
      prod_value: prodValue,
      criterion: g.criterion,
      criterion_type: g.criterion_type,
      // The 2026-08-21 rule: an ROI-graded criterion measures selection,
      // not pricing, so it cannot settle a pricing question.
      selection_contaminated: g.criterion_type === 'roi',
      window_end: g.window_end || null,
      window_elapsed: elapsed,
      precondition: g.precondition || null,
      precondition_met: precondMet,
      decision: g.decision || null,
      blocked_reason: g.blocked_reason || null,
      status,
      needs_attention: status === STATUS.ELAPSED_NO_DECISION
        || status === STATUS.AWAITING_DECISION
        || status === STATUS.NO_CRITERION
        // A gate blocked by a WIRING defect is a bug, not a decision to
        // wait on — surface it rather than letting it look correctly shut.
        || !!g.blocked_reason,
      note: g.note || null,
    });
  }
  const counts = {};
  for (const r of out) counts[r.status] = (counts[r.status] || 0) + 1;
  return {
    today,
    total: out.length,
    counts,
    needs_attention: out.filter(r => r.needs_attention).length,
    selection_contaminated: out.filter(r => r.selection_contaminated).length,
    gates: out,
  };
}

// Console surface. Called from the daily cron so a stale gate announces
// itself instead of waiting to be asked — the thing the ARI scraper
// never did.
function logGateHealth(db, opts) {
  let r;
  try { r = evaluateGates(db, opts); } catch (e) {
    console.warn('[gate-health] evaluation failed (non-fatal): ' + e.message);
    return null;
  }
  const flagged = r.gates.filter(g => g.needs_attention);
  if (!flagged.length) {
    console.log('[gate-health] ' + r.total + ' gates, none needing attention');
    return r;
  }
  console.warn('[gate-health] ' + flagged.length + ' of ' + r.total + ' gates need attention:');
  for (const g of flagged) {
    console.warn('  [' + g.status + '] ' + g.id
      + (g.settings_key ? ' (' + g.settings_key + '=' + g.prod_value + ')' : '')
      + (g.window_elapsed ? ' — window ended ' + g.window_end : '')
      + (g.precondition_met === true ? ' — precondition "' + g.precondition + '" HAS CLEARED' : ''));
  }
  if (r.selection_contaminated) {
    console.warn('  ' + r.selection_contaminated + ' gate(s) carry an ROI-based criterion, which measures '
      + 'selection not pricing — see the CLAUDE.md rule.');
  }
  return r;
}

module.exports = { GATES, STATUS, evaluateGates, logGateHealth, PRECONDITIONS };
