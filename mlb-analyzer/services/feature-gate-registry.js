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
  REEVAL_DUE: 'reeval_due',               // the evidence a past decision lacked has arrived
  OPEN_DECISION: 'open_decision',        // criterion written, decision deliberately deferred
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
  // COUNT-BASED, and the count is derived rather than picked. (2026-08-30)
  //
  // The park-neutral A/B is a PAIRED design -- the same games scored twice
  // with one flag flipped -- and its measured 95% half-width is +/-0.000608
  // at n=801. The standing point estimate is -0.00055, i.e. 0.90x the
  // resolvable threshold: underpowered, but only just.
  //
  // Interval width scales as 1/sqrt(n), so resolving 0.00055 needs
  // 801 * (0.000608/0.00055)^2 = 979 games. That is +178, weeks of season.
  //
  // REGISTERED AS A TRIGGER so the morning check surfaces it, rather than
  // depending on anyone remembering. The gate sits at 'on for the
  // mechanism'; this is what tells us the evidence has caught up.
  //
  // The corpus definition MATCHES the floor measurement exactly -- clean on
  // both contamination reasons, decided result, a market ML, and a wOBA
  // snapshot for the date. A looser count would trip the trigger before the
  // design could actually resolve anything.
  park_neutral_resolvable_979: (db) => scalar(db,
    'SELECT COUNT(*) v FROM game_log g WHERE g.weather_contamination_reason IS NULL '
    + 'AND g.market_contamination_reason IS NULL AND g.model_total IS NOT NULL '
    + 'AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL '
    + 'AND g.home_score != g.away_score AND g.market_home_ml IS NOT NULL '
    + 'AND EXISTS (SELECT 1 FROM woba_data_snapshot s WHERE s.snapshot_date = g.game_date)'
  ) >= 979,

  at_emit_columns_populated: (db) =>
    scalar(db, 'SELECT COUNT(*) v FROM bet_signals WHERE model_home_ml_at_emit IS NOT NULL') > 0,

  // COUNT-BASED, not calendar-based. The totals-edge question cannot be
  // answered by waiting -- it is answered by accumulating logged bets, and
  // 37 is nowhere near enough. A date-based window would come due while the
  // sample was still uninformative and force a decision on noise.
  //
  // 100 is not arbitrary: at n=37 the gap CI was [-1.91, +23.58], a width
  // of ~25pp. Interval width scales as 1/sqrt(n), so n=100 narrows it to
  // roughly 15pp -- still wide, but enough to separate the observed
  // +10.66pp from zero if the effect is real at that magnitude. It is the
  // point at which the test starts being able to answer.
  totals_logged_bets_100: (db) =>
    scalar(db, "SELECT COUNT(*) v FROM bet_signals WHERE signal_type='Total' AND bet_line IS NOT NULL") >= 100,
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
    criterion: 'ON for the mechanism. Calibration cannot adjudicate at this n; '
             + 'paired A/B becomes resolvable at 979 clean scorable games (currently 801).',
    criterion_type: 'mechanism',
    reeval_precondition: 'park_neutral_resolvable_979',
    window_end: null,
    decision: { date: '2026-08-30', outcome: 'on_for_mechanism_trigger_registered',
                ref: 'docs/park-neutral-resolvability-2026-08-30.md' },
    note: 'RESTING STATE, set 2026-08-30, replacing "directionally validated, awaiting '
        + 'significance" -- which implied a pending verdict and had sat implying one for a week. '
        + 'TWO HALVES, both stated because either alone misleads. '
        + 'MECHANISM: neutralizing park out of the actuals before re-applying a park factor at '
        + 'game time is more correct than not, independent of measurement -- otherwise the same '
        + 'park effect is counted twice, once in the input and once in the multiplier. That is '
        + 'why the flag is ON, and it does not depend on the A/B. '
        + 'EVIDENCE: calibration cannot adjudicate at this n. The paired 95% half-width is '
        + '+/-0.000608 at n=801 against a standing point estimate of -0.00055, i.e. 0.90x the '
        + 'resolvable threshold. Underpowered, but only just. '
        + 'THE ~0.020 FIGURE FROM resolution-floor.js --calibration DOES NOT APPLY: that is a '
        + 'BETWEEN-COHORT design and is 28x noisier than this paired one on the same corpus. '
        + 'Quoting it would have made an answerable question look permanently unanswerable. '
        + 'TRIGGER: precondition park_neutral_resolvable_979 -- +178 games, weeks not years. '
        + 'The prior ROI-based A/B (PR #142, +3.32pp totals) is selection-contaminated per the '
        + '2026-08-21 finding and predates the actuals-only fix; it is not calibration evidence. '
        + 'See docs/park-neutral-resolvability-2026-08-30.md.' },

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
  // ---- open question, no settings key: an OBSERVATION to re-test, not a flag ----
  { id: 'totals_selection_edge', key: null, on_expected: null,
    criterion: 'Re-run the decisive test at n >= 100 logged totals bets. NOT a calendar date.',
    criterion_type: 'calibration', precondition: 'totals_logged_bets_100',
    window_end: null, decision: null,
    note: 'FINDING 2026-08-23 (docs/totals-edge-four-steps-2026-08-23.md). Logged totals showed '
        + '23W-14L, +21.12% ROI after re-grading at struck prices, with a win-rate gap of +10.66pp '
        + 'over the price-implied rate. THE GAP CI SPANS ZERO: [-1.91, +23.58], 1.30 SD on n=37. '
        + 'Split by side, the under subset is +18.10pp with a CI excluding zero -- but the SAME '
        + 'measurement on 550 unconditioned under signals gives +1.10pp, spanning zero. Same sign, '
        + '~16x the magnitude: selection, not a model property. '
        + 'The selection effect IS real in direction and survives every control available -- period '
        + '(all 38 bets fall in one pre-v7 month; same-window logged +10.66pp vs not-logged +1.01pp), '
        + 'edge band (matched at >=4pp: +9.60pp vs +1.01pp), total level (the band the operator '
        + 'favoured is NEGATIVE in the population) and side (the operator was LESS under-heavy than '
        + 'the population, 55% vs 73%, yet the outperformance came from unders). '
        + 'IT DECOMPOSES INTO NO IDENTIFIABLE MECHANISM. '
        + 'AT n=37 WITH THE AGGREGATE CI SPANNING ZERO, NOISE REMAINS THE LEADING EXPLANATION. '
        + 'Do not act on the +18.10pp under number. '
        + 'REVISIT TRIGGER: n >= 100 logged totals bets, then re-run scripts/totals-edge-regrade.js '
        + 'AND the unconditioned comparison. The trigger is a COUNT because waiting a further month '
        + 'adds no information -- only logged bets do.' },

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
    criterion: 'Calibration A/B (scripts/calibration-ab.js). Tier-2 sign-test standard: favourable windows at '
             + 'sign-test p <= 0.05, >=4 of 5 metrics favourable, pooled CI upper bound < +0.001 log loss.',
    criterion_type: 'none', precondition: 'hand_conditional_shadow_accumulating',
    window_end: null, decision: null,
    // blocked_reason CLEARED 2026-08-23 — the three keys are now mapped in
    // getSettings() and the flag activates (789/790 games change, was
    // 0/790). Wiring verified byte-identical on the live path.
    // docs/getsettings-whitelist-audit-2026-08-23.md
    note: 'WIRING FIXED 2026-08-23; first evidence is UNFAVOURABLE. Was UNFLIPPABLE: getSettings() returns an explicit hand-mapped '
        + 'whitelist, and USE_HAND_CONDITIONAL_SP_WEIGHT is not in it, so model.js reads undefined and '
        + '!!undefined === false ALWAYS. No app_settings value can turn this on. SP_WEIGHT_R and SP_WEIGHT_L are '
        + 'also unmapped, so model.js falls back to its hardcoded 0.865 / 0.649 — which means the operator-tuned '
        + 'sp_weight_l=0.7 in app_settings is silently ignored. Shadow logging still fires because the alt path '
        + 'uses those hardcoded constants. This is the UI-parity rule inverted: schema key + UI control + '
        + 'app_settings value, with no getSettings mapping to read them. FIX FIRST (map all three keys in '
        + 'getSettings, verify sp_weight_l takes effect), THEN write a flip criterion. Writing one now would be '
        + 'premature — there is nothing to flip. '
        + 'UPDATE: all three keys are now mapped and the flag activates (789/790 games change vs 0/790 before). '
        + 'First A/B is directionally WORSE on all five metrics (delta log loss +0.00009, CI [-0.00032, +0.00054]; '
        + 'ECE 0.0155 vs 0.0114) and the sign test is 2/5 windows favourable — Tier 4 on the proposed standard. '
        + 'RE-RUN 2026-08-22 against the benchmark sp_weight_l=0.649 (now prod): VERDICT UNCHANGED. '
        + 'delta log loss +0.00008 CI [-0.00040, +0.00059], sign test 2/5 windows favourable, directionally WORSE '
        + 'on all five metrics (ECE 0.0142 vs 0.0114 off; AUC 0.5485 vs 0.5494; edge slope -0.320 vs -0.313). '
        + 'The benchmark does NOT rescue it — 0.649 beats 0.7 on ECE (0.0142 vs 0.0155), consistent with being the '
        + 'empirically derived value, but both lose to the flag being off. TIER 4. Leave off. '
        + 'SHADOW DISCONTINUITY, quantified: the hand-conditional deltas are CONSOLE-LOG ONLY — nothing persists '
        + 'them (game_log.sp_weight_used holds SP_PIT_WEIGHT from the IP forecast, a different quantity per the '
        + 'CLAUDE.md SP_WEIGHT vs SP_PIT_WEIGHT rule), so there is no series to pool or restart. The window in '
        + 'which 0.7 was ever READ is bounded by PR #257 merging (2026-08-22T21:53Z) and prod being set to 0.649 '
        + '(~22:12Z): <= 19 minutes, shortened further by Render deploy lag, with at most one hourly cron boundary '
        + '(22:00Z) inside. No restart needed.' },

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
    criterion_type: 'calibration', window_end: null,
    decision: { date: '2026-08-23', outcome: 'set_to_benchmark_0.649_behavior_preserving',
                ref: 'docs/getsettings-whitelist-audit-2026-08-23.md' },
    note: 'RESOLVED 2026-08-23. History: app_settings held 0.7 while getSettings() did not map the key, so '
        + 'model.js used its hardcoded 0.649 and the stored 0.7 never took effect. Wiring the key would have made '
        + '0.7 live on the SHADOW path (live pricing is unaffected while use_hand_conditional_sp_weight is false — '
        + 'verified 0/790 games change). Prod app_settings set to 0.649 so the wiring fix is behavior-preserving on '
        + 'BOTH paths and the shadow record stays on one constant. 0.649 is also the empirical benchmark from '
        + 'pitcher_game_log BF data. Moving to 0.7 is now a SEPARATE proposed change to be evaluated on its own '
        + 'merits, not a side effect of a wiring fix.' },

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
  // ---- registered open items, not settings flags ----
  //
  // Neither is a toggle. They are registered because the alternative was
  // living in prose in a doc, findable only by someone remembering it --
  // which is the failure the ARI roof scraper is the monument to.
  //
  // Both are DELIBERATELY QUIET. They report as open_decision / decided
  // rather than needs_attention, because a check that is red every morning
  // for something nobody intends to act on today trains the reader to skip
  // it -- the fielding_frv permanent-CRITICAL lesson. Findable is the goal,
  // not loud.

  { id: 'bullpen_woba_neutralization', key: null, on_expected: null,
    criterion: 'Mechanism, same footing as park_neutral_inputs_enabled: the batter '
             + 'and SP wOBA inputs are park-neutralized and the BULLPEN pool was not, '
             + 'which was internally inconsistent regardless of what calibration can see.',
    criterion_type: 'mechanism',
    window_end: null,
    decision: { date: '2026-08-31', outcome: 'extended_on_mechanism',
                ref: 'docs/bullpen-park-neutral-2026-08-31.md' },
    note: 'CLOSED 2026-08-31 by extending neutralization to the bullpen actuals term. '
        + 'Same transform, same park_factors.woba_factor table, actuals-only, and the '
        + 'same PA/TBF stint weighting for traded relievers. '
        + 'IMPACT: level shift -0.0007 runs -- essentially nil, which was the ship '
        + 'criterion, since the model already carries a -0.5752 total bias that a '
        + 'one-way push would compound. 821 of 821 games moved; mean |d total| 0.0095 '
        + 'runs, p90 0.0246, max 0.0572. Per-team the direction is right: COL improves '
        + '0.0078 once its inflation is divided out, SEA worsens 0.0065. '
        + 'PERMANENTLY UNRESOLVABLE BY CALIBRATION, and shipped knowing that: paired '
        + 'd log loss +0.000019 against a +/-0.000217 interval, which would need '
        + '~105,000 games to resolve against the 979 that makes the parent feature '
        + 'resolvable. A full 30-club season is ~2,400. So this is NOT "underpowered, '
        + 'resolvable at N" -- it is mechanism-only, and the resting state says so '
        + 'rather than implying a pending verdict. '
        + 'IMPLEMENTATION: db/schema.js cannot require services/park-factors-woba '
        + '(that module requires db/schema for the park_factors table, so the '
        + 'dependency would be circular). The factor arrives as a RESOLVER passed in '
        + 'by services/jobs.js, which keeps the direction one-way and reuses '
        + 'model.js resolveNeutralizationFactor verbatim instead of a fourth copy. '
        + 'That boundary is what the pre-close note predicted: the reason this was '
        + 'never extended was where the code stopped, not a judgement.' },

  { id: 'debug_bullpen_endpoint_divergence', key: null, on_expected: null,
    criterion: 'Known divergence, deliberately left. GET /api/debug/bullpen is a THIRD '
             + 'implementation of the bullpen pool and applies no availability filter at all.',
    criterion_type: 'mechanism',
    window_end: null,
    decision: { date: '2026-08-30', outcome: 'left_diverged_deliberately',
                ref: 'docs/register-bullpen-open-items-2026-08-30.md' },
    note: 'WHAT DIVERGES. routes/api.js GET /debug/bullpen has zero references to '
        + 'getFatiguedPitchers and ignores the `date` param the UI sends it, so it '
        + 'applies NO fatigue exclusions -- not the doubleheader rule, and not the '
        + 'pre-existing 2-consecutive / 3in4 / pitch-count rules either. The model '
        + 'pool (q.getBullpenWoba) and the bullpen REPORT (/debug/bullpen-report) both '
        + 'apply them; this one does not. '
        + 'WHY LEFT: it backs a pool-size quality warning in the UI '
        + '("bullpen: no wOBA data (pool=N) -- pull rosters"), not a pricing path. '
        + 'Adding exclusions would shrink every pool it reports and change when that '
        + 'warning fires. '
        + 'THE THING NOT TO LOSE: if this is ever fixed, RE-MEASURE THE WARNING '
        + 'THRESHOLD FIRST. The current trigger is pool < 2, chosen against un-excluded '
        + 'pools. Post-fix, measured pools run a median of 7 with fatigue removing a '
        + 'median of 3 and up to 10, so the same threshold against excluded pools would '
        + 'fire on healthy bullpens and read as a data outage. Fixing the divergence '
        + 'without re-measuring the threshold converts a silent inconsistency into a '
        + 'noisy false alarm, which is worse.' },

  { id: 'bullpen_pool_lastname_fallback', key: null, on_expected: null,
    criterion: 'FIXED 2026-08-30. The bullpen pool admitted pitchers who were not on '
             + 'the roster, by surname. Now matches on exact normalised name.',
    criterion_type: 'mechanism',
    window_end: null,
    decision: { date: '2026-08-30', outcome: 'fixed_exact_name_match',
                ref: 'docs/roster-match-exact-2026-08-30.md' },
    note: 'THE BUG. db/schema.js q.getBullpenWoba admitted a projection row when '
        + 'any rostered RP name ended in a space plus the candidate surname; the '
        + 'first name was never checked. 22 non-roster players were admitted across '
        + '14 teams and CWS/Shane Smith reached a PRICED pool via Hagen Smith. '
        + 'WHY EXACT, NOT FIRST-INITIAL OR MLB ID. Measured over all 30 teams: EXACT '
        + 'admits 249, which is ALL 249 rostered RPs, 1:1 -- nothing relied on the '
        + 'fallback. First-initial admits 250, the extra being SF/Darien Smith off '
        + 'the roster Dylan Smith, so it is still a phantom. Surname admits 271. '
        + 'mlb_id is not available on this path: projection rows carry only a '
        + 'Name-TEAM string with no id, and at 249/249 it would buy nothing. '
        + 'THREE COPIES, all fixed. db/schema.js had two -- the pool filter and a '
        + 'second surname assumption in the fallback-injection step '
        + '(representedLast), which could silently drop a genuinely rostered arm '
        + 'because an unrelated namesake was present, with no note() recording it. '
        + 'routes/api.js /debug/bullpen had a third in its role tagging. '
        + 'MEASURED IMPACT: 14 teams shed phantom candidates; only ONE priced number '
        + 'moved, CWS +0.0006. Zero fallbacks were introduced, confirming no '
        + 'legitimate arm depended on the loose match. Smallest pool after the fix '
        + 'is 5, well clear of the pool<2 warning threshold, so the '
        + 'debug_bullpen_endpoint_divergence re-measurement caveat does not bite. '
        + 'SAFE AGAINST NAME-FORMAT DRIFT: a rostered arm that loses its exact match '
        + 'is not silently dropped -- it falls through to roster-fallback injection '
        + 'and surfaces in the fallbacks count. Asserted in the test. '
        + 'STILL OPEN, SEPARATELY: Shane Smith carried an actuals sample 7.33x his '
        + 'logged BF (338/278 vs 84), where every current pitcher checked runs '
        + '0.6-1.2x. The exact-match fix removes him from the pool, so the pricing '
        + 'exposure is closed, but the underlying question -- why a pitcher carries '
        + 'actuals that are not from this season -- is NOT answered by this fix and '
        + 'may affect other players who ARE correctly rostered. '
        + 'Guard: scripts/test-roster-match-exact.js. '
        + 'Audit: scripts/measure-roster-match-rules.js, scripts/audit-lastname-fallback-roster.js.' },
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
    let reevalMet = null;
    if (g.reeval_precondition && PRECONDITIONS[g.reeval_precondition]) {
      try { reevalMet = !!PRECONDITIONS[g.reeval_precondition](db); } catch (e) { reevalMet = null; }
    }
    if (g.precondition && PRECONDITIONS[g.precondition]) {
      try { precondMet = !!PRECONDITIONS[g.precondition](db); } catch (e) { precondMet = null; }
    }
    const elapsed = !!(g.window_end && today > g.window_end);

    let status;
    // An explicit `blocked_reason` wins over everything: a gate that
    // CANNOT be flipped is not awaiting a decision, and reporting it as
    // such would send someone to make a decision they cannot act on.
    if (g.blocked_reason) status = STATUS.BLOCKED;
    // RE-EVALUATION TRIGGER, checked BEFORE `decided`. (2026-08-30)
    //
    // A `precondition` answers "may this gate be flipped yet". A
    // `reeval_precondition` answers a different question: "has the evidence
    // that was unavailable when we decided finally arrived". The two need
    // separating, because the decided-branch below short-circuits every
    // precondition check -- so a trigger attached to a DECIDED gate could
    // never fire, which is exactly the remember-it-yourself failure the
    // registry exists to remove.
    //
    // Found by registering park_neutral_resolvable_979 against a gate that
    // already carried a decision and checking whether it would ever
    // surface. It would not have.
    else if (g.reeval_precondition && reevalMet === true) status = STATUS.REEVAL_DUE;
    else if (g.decision) status = STATUS.DECIDED;
    else if (elapsed) status = STATUS.ELAPSED_NO_DECISION;
    else if (g.window_end) status = STATUS.IN_WINDOW;
    else if (precondMet === true) status = STATUS.AWAITING_DECISION;
    else if (precondMet === false) status = STATUS.BLOCKED;
    // A decision deliberately DEFERRED is not the same as one nobody ever
    // wrote down. NO_CRITERION means the criterion is missing; this means
    // the criterion is written and the call has not been made yet.
    else if (g.deferred) status = STATUS.OPEN_DECISION;
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
      reeval_precondition: g.reeval_precondition || null,
      reeval_met: reevalMet,
      decision: g.decision || null,
      blocked_reason: g.blocked_reason || null,
      status,
      needs_attention: status === STATUS.ELAPSED_NO_DECISION || status === STATUS.REEVAL_DUE
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
  // Open decisions print ALWAYS, and separately from the attention list.
  //
  // Registered-but-silent is not findable -- it is a source file someone has
  // to think to grep. Registered-and-alarming is worse: a line that is red
  // every morning for something nobody intends to act on today trains the
  // reader to skip the whole check, which is the fielding_frv
  // permanent-CRITICAL lesson. One informational line is the balance.
  const open = r.gates.filter(g => g.status === STATUS.OPEN_DECISION);
  if (open.length) {
    console.log('[gate-health] ' + open.length + ' open decision(s) on record (not blocking): '
      + open.map(g => g.id).join(', '));
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
      + (g.precondition_met === true ? ' — precondition "' + g.precondition + '" HAS CLEARED' : '')
      + (g.reeval_met === true
          ? ' — RE-EVALUATE: "' + g.reeval_precondition + '" has cleared. The evidence the '
            + 'recorded decision lacked has now arrived; re-run the A/B as a real test.'
          : ''));
  }
  if (r.selection_contaminated) {
    console.warn('  ' + r.selection_contaminated + ' gate(s) carry an ROI-based criterion, which measures '
      + 'selection not pricing — see the CLAUDE.md rule.');
  }
  return r;
}

module.exports = { GATES, STATUS, evaluateGates, logGateHealth, PRECONDITIONS };
