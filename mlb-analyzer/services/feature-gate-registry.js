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

// RE-BASELINE EVENTS (2026-09-16)
//
// A change to what an offline harness feeds runModel changes every number
// that harness produces, so a recorded figure has to say which side of the
// change it was measured on. A row carrying `evidence_predates: { event }`
// quotes evidence measured BEFORE the named event. That is informational,
// not a verdict: the evidence is not wrong, it is about a different input
// set, and it has not been re-run. evaluateGates passes the field through
// and logGateHealth lists the rows every morning until they are re-run and
// the field is removed WITH the new figures.
//
// `reproduce` is how to get the old figure back exactly, so a before/after
// is always possible.
const REBASELINE_EVENTS = {
  harness_inputs_persisted: {
    date: '2026-09-16',
    summary: 'services/harness-inputs.js populateCallerInputs went from 4 of the 21 caller-populated '
      + 'fields (FRV as-of, framing RECOMPUTED from current state) to every field with a persisted '
      + 'emit-time source: bullpen x6 and framing x2 read from game_log, opener x6 and tandem x2 '
      + 'copied (value-identical; preScreenGame already carried them). Roster x2 and availability '
      + 'have no source and stay absent. Before this, every harness priced both bullpens at the '
      + 'league constant on both arms.',
    reproduce: 'HARNESS_INPUTS=legacy',
  },
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
  //
  // EXPECT THIS TO UN-ARM WHEN THE PROD TAG BACKFILL RUNS. (2026-09-14)
  // Measured on the 2026-09-13 prod snapshot: 984 before, 772 after
  // market_contamination_post_first_pitch tags its 266 games, against a
  // bar of 979. So this trigger is armed TODAY on prod and will not be
  // armed afterwards.
  //
  // THAT IS THE CORRECT OUTCOME, NOT A REGRESSION. The comment above says
  // the corpus definition matches the floor measurement exactly and that a
  // LOOSER count would trip the trigger before the design could resolve
  // anything. Prod has been running the looser count: the column it
  // filters on was empty there, so `market_contamination_reason IS NULL`
  // admitted every post-first-pitch-priced game. 984 was the loose number
  // and 772 is the strict one. The analysis copy has read ~772 all along,
  // which is why the local and prod answers to "has the evidence caught
  // up" disagreed.
  //
  // Resolving 0.00055 needs 979 games of THIS corpus; at 772 that is ~207
  // further games, not the ~0 prod currently implies.
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
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-30', harness: 'scripts/park-neutral-paired-floor.js',
      figures: 'paired half-width +/-0.000608 at n=801, point estimate -0.00055, and the 979-game '
        + 'trigger derived from them',
      detail: 'Re-running under persisted inputs changes the arms, not just the level: the bullpen '
        + 'column was written with neutralization ON since 2026-08-31, so both arms now carry a '
        + 'neutralized bullpen and only the batter/SP half of this flag varies. '
        + 'PARK_NEUTRAL_INPUTS_ENABLED is flagged PARTIAL by the harness guard for that reason.' },
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
    decision: { date: '2026-07-10', outcome: 'enabled', ref: 'docs/demote-unabated-from-betting-path-2026-07-10.md' },
    note: 'AMENDED 2026-09-17: THE UNABATED FETCH IS REMOVED, not just demoted '
        + '(docs/unabated-fetch-removed-2026-09-17.md). The criterion above describes the '
        + '2026-07-10 state. Kalshi is now the first of two ML writers; Polymarket fills games '
        + 'Kalshi does not cover, and there is no third. Turning this flag OFF now leaves ML '
        + 'to Poly alone, not to a backup feed. The ML cross-check book is the direct Poly '
        + 'quote (#366), and a Poly-primary row is single-source by construction.' },

  { id: 'kalshi_direct_totals_enabled', key: 'kalshi_direct_totals_enabled', on_expected: true,
    criterion: 'Replacement writer for market_total after Unabated demotion.',
    criterion_type: 'mechanism', window_end: null,
    decision: { date: '2026-07-10', outcome: 'enabled', ref: 'CLAUDE.md demotion-pre-flight rule' },
    note: 'AMENDED 2026-09-17: THE UNABATED FETCH IS REMOVED (docs/unabated-fetch-removed-2026-09-17.md). '
        + 'Two things this writer read from it changed. (1) Its RUNG ANCHOR was unabated_total; '
        + 'it is now the line an earlier Kalshi pass persisted for the game today (exact, else '
        + 'nearest within 0.5), else the auto rung -- owner ruling, chosen after measuring that '
        + 'the auto rung differs by one run on an estimated 82 of 416 games (0 of 148 where the '
        + 'fair total sits on a rung, 44 of 80 within 0.1 of a whole run) against 7 of 7 agreeing '
        + 'live on 2026-09-17. (2) The Poly totals anchor it feeds no longer has an '
        + 'unabated_total alternative, so a Poly total with no Kalshi line prices off liquidity '
        + 'and is counted per pass in the odds cron_log message. The removal gate was the '
        + '2026-09-16 slate: phi-nym and det-cws priced=yes agree=yes via liquidity_fallback; '
        + 'ath-tb and sd-col kalshi_exact.\n'
        + 'ANCHOR STORAGE FIXED 2026-09-17: both rung anchors (this writer\'s sticky rung and '
        + 'the Poly one) read game_log.kalshi_anchor_total, written on every Kalshi-priced pass '
        + 'and never cleared by another source. They previously inferred it from '
        + 'total_source=\'kalshi\', which a Poly-priced pass erased -- so the next Kalshi-silent '
        + 'pass moved the line with no market reason. Backfill migration '
        + 'kalshi-anchor-total-backfill-001.' },

  { id: 'signal_edge_cap_enabled', key: 'signal_edge_cap_enabled', on_expected: true,
    criterion: 'Suppress signals at edge >= hard cap; flag [soft,hard).',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-13', outcome: 'enabled', ref: 'docs/ship-hard-cap-0.08-2026-07-13.md' },
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-22', harness: 'scripts/edge-honesty-scope.js',
      figures: 'the edge-honesty finding quoted in the note (above-cap honesty not worse than below-cap)',
      detail: 'The DECISION is ROI-based and unaffected; the note\'s calibration finding re-scored '
        + 'runModel through populateCallerInputs and predates the persisted inputs.' },
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
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-23', harness: 'scripts/calibration-ab.js',
      figures: 'delta log loss -0.00087 CI [-0.00211, +0.00065], ALL FIVE metrics, edge slope -0.313 -> -0.218',
      detail: 'Already closed on its evidence by the 2026-09-12 term split; listed because the figures '
        + 'are still quoted here.' },
    note: 'PRECONDITION CLEARED (fielding_frv populated; the key is not even in app_settings, so it runs on the '
        + 'schema default). EVALUATION WRITTEN AND RUN 2026-08-23 rather than flipping: scripts/calibration-ab.js '
        + 'DEFENSE_FRV_ENABLED false true. Result — the flag moves p(home) on 100% of games (mean |dp| 0.0083) and '
        + 'is better on ALL FIVE metrics, with the largest edge-slope improvement measured anywhere (-0.313 -> '
        + '-0.218), but delta log loss -0.00087 CI [-0.00211, +0.00065] does not clear zero. '
        + 'FLIP CRITERION: delta_log_loss CI excludes zero on the negative side, on >= 1200 games. '
        + 'WINDOW: re-evaluate 2026-09-30. Do not flip before then. '
        + 'NOTE the first run reported the flag as INERT — a harness artifact, because runModel reads '
        + 'game.{away,home}FieldingRunsPerGame which the caller populates and the harness did not. '
        + 'scripts/calibration-ab.js now hard-fails on that class rather than reporting a false negative.\n'
        + 'TERM REDEFINED 2026-09-12 — THE EVIDENCE ABOVE PRE-DATES THE SPLIT AND DOES NOT CARRY OVER. '
        + 'fielding_frv was keyed by mlb_id and summed a player\'s runs across every position he plays, '
        + 'labelling the row with whichever position had the most outs; the term then looked players up by '
        + 'id alone and ignored position entirely. Measured over 2026-08-13..09-10: 26.6% of resolved '
        + 'lineup slots were scored with a row for a position the player was not playing that night, 228 of '
        + 'them crossing infield<->outfield. Two further changes land with it: a fielder with no usable row '
        + 'contributes NULL rather than 0 (6.9% of slots, 372 in 30 days, were being treated as exactly '
        + 'league-average defenders), and the three copies of the term were collapsed into one — the two '
        + 'harness copies had drifted to `outs_total > 0` while production applied FRV_MIN_OUTS, and '
        + 'harness-inputs.js wires calibration-ab.js to a harness copy, so the numbers above were produced '
        + 'by a term production does not compute. '
        + 'THIS ROW IS CLOSING ON ITS RECORDED EVIDENCE. The split term is a new question and opens as '
        + 'defense_frv_split below. Do not carry the -0.00087 delta or the ALL FIVE METRICS claim across.' },

  // The split term. Same criterion as the row above, deliberately: what
  // changed is the term, not the standard it has to clear.
  { id: 'defense_frv_split', key: 'defense_frv_enabled', on_expected: false,
    criterion: 'Calibration A/B (scripts/calibration-ab.js DEFENSE_FRV_ENABLED false true), log loss over '
             + 'all scored games, identical game set both arms. SAME BAR AS THE PRE-SPLIT ROW: '
             + 'delta_log_loss CI excludes zero on the negative side, on >= 1200 games. '
             + 'SCOPE FIXED 2026-09-13: the AS-OF window only -- games inside the '
             + 'fielding_frv_snapshot era with the FRV rows read as-of the game date, not '
             + 'current-state. The bar is unchanged; what is now pinned is the corpus it '
             + 'applies to, because a current-state read prices a game with FRV that already '
             + 'knows how those fielders turned out.',
    criterion_type: 'calibration', precondition: 'fielding_frv_populated',
    window_end: '2026-10-31', decision: null,
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-09-13..09-14', harness: 'scripts/calibration-ab.js',
      figures: 'gate window -0.00154 [-0.00334, +0.00003] n=797; season -0.00066 [-0.00216, +0.00078] '
        + 'n=1158; hindsight -0.00010 [-0.00061, +0.00039]; n-matched resamples -0.00058/-0.00075/-0.00091; '
        + 'the 950-game and 1200-game reachability arithmetic built on those half-widths',
      detail: 'Every figure in the note, including the superseded-scope ones kept with their n.' },
    // corpus_size CORRECTED 2026-09-13 (1078 -> 797, see the chain below), then set
    // NULL the same day when the criterion scope was pinned to the as-of window:
    // under that scope there is no qualifying measurement yet, and 797 describes a
    // corpus the criterion no longer uses. An explicit null is the honest state and
    // test-registry-corpus-size.js accepts it as such; the superseded-scope figures
    // are kept in the note WITH their n rather than deleted.
    // Re-run the chain: node scripts/measure-calibration-corpus.js
    corpus_size: null,
    note: 'OPENED 2026-09-12 when the FRV term was redefined — see defense_frv_enabled above for what '
        + 'changed and why its evidence does not transfer. The term is now: per-fielder FRV AT THE '
        + 'POSITION HE IS PLAYING TONIGHT ((mlb_id, position) key), summed over the non-catcher lineup '
        + 'slots, with unresolved slots scaled over rather than treated as average, one implementation '
        + 'shared by production and both harnesses (utils/fielding-frv-term.js), one floor (FRV_MIN_OUTS).\n'
        + 'CORPUS CORRECTED 2026-09-13. corpus_size was 1078 and the row claimed that was "what a '
        + 'calibration run actually scores". It is not: a run on 2026-06-16..09-10 scores 797. The 1078 '
        + 'counted graded games with both lineups and a weather predicate and stopped there, omitting the '
        + 'market-contamination filter loadGames applies unconditionally plus three later requirements. '
        + 'THE FULL CHAIN, in the order calibration-ab.js walks it: (1) graded with both lineups posted '
        + '1100; (2) weather_inputs_valid (temp_f NOT NULL AND weather_quality_at >= 2026-08-05 23:00 UTC) '
        + '1078; (3) market_contamination_reason IS NULL -258 -> 852; (4) a woba_data_snapshot row for the '
        + 'game date -28 (two dates, 2026-06-26 and 2026-07-19, UNBACKFILLABLE); (5) both scores present '
        + '-24; (6) both market ML present -3; (7) preScreenGame non-null and implied prob usable -0. '
        + 'USABLE = 797. Quoting step 2 overstates the measurement n by 281 games.\n'
        + 'THE >= 1200 BAR IS NOT REACHABLE ON THE SEASON TO DATE. Season-wide 2026-04-01..09-12 under the '
        + 'SAME chain: 2062 graded with lineups, 2006 weather-valid, 1781 after the market filter, and '
        + '1158 USABLE -- SHORT BY 42. The old row said "season-wide the same filter gives 1976, so the '
        + 'bar is reachable without waiting"; 1976 was the step-2 partial count, and the real number is '
        + '1158. The dominant loss is step 4: 589 games over 46 dates (2026-04-04..07-19) have no wOBA '
        + 'snapshot, which cannot be backfilled -- a snapshot records what that morning looked like. So '
        + 'the shortfall is closed only by FORWARD dates. A missed snapshot day costs its whole slate '
        + 'permanently, which makes the 6AM chain gap check (utils/pipeline-freshness.js) a precondition '
        + 'for this bar rather than a side concern.\n'
        + 'AND THE WINDOW CANNOT BE WIDENED BACKWARDS AT ALL. woba_data_snapshot begins 2026-05-20, so '
        + 'the 582 graded-with-lineups games from 2026-04-01..05-19 are structurally unscoreable and a '
        + 'window opening at 04-01 is in practice a 05-20..09-12 corpus. Inside that era the series is '
        + 'essentially complete -- 112 of 114 dates have a snapshot, the two misses being 2026-06-26 and '
        + '2026-07-19 (7 games) -- so the 589-game step-4 loss is 582 pre-era plus 7 in-era, not a '
        + 'recoverable backlog. In-era survival from graded-with-lineups to USABLE is 1158/1480 = 78.2%, '
        + 'so the 42-game shortfall needs about 54 more graded games: at the 13.5 graded games per date '
        + 'observed over 2026-08-21..09-12, roughly FIVE more slates. The bar is days of play away, not '
        + 'weeks, and it arrives on its own provided the snapshot chain does not miss.\n'
        + 'FALLBACK SHARE MEASURED 2026-09-13 (the row called this the first step of any evaluation, and '
        + 'it is now done). Post-ingest, through the real term and resolver over 2026-08-16..09-14: 87.9% '
        + 'exact position matches, 5.8% position fallbacks, 6.3% unresolved on 5614 fielding slots -- '
        + 'against 68.3 / 24.8 / 6.9 on the legacy table. The fallback share fell 4.3x, as predicted. All '
        + '356 unresolved are no_frv_row (genuinely absent from Savant), zero name-resolution failures.\n'
        + 'FIRST A/B, gate window, n=797: delta_log_loss -0.00154, 95% CI [-0.00334, +0.00003]. Better on '
        + 'log loss, Brier, AUC and edge slope (-0.110 -> +0.066); ECE marginally worse (0.0331 -> 0.0339). '
        + 'DOES NOT CLEAR THE BAR, on both clauses: the CI includes zero, and 797 < 1200. The window count '
        + 'is deliberately NOT quoted here -- per the CLAUDE.md sign-test rule it carries no information '
        + 'at this n without an n-matched resample spread beside it.\n'
        + 'SCOPE AND DISPOSITION 2026-09-13.\n'
        + 'WHY CURRENT-STATE IS EXCLUDED. utils/fielding-frv-term.js reads the current-state '
        + 'fielding_frv table -- there is no as-of FRV query in the schema -- so every replayed '
        + 'game is priced with FRV as of the run date. The hindsight horizon grows with lookback: '
        + 'measured across the five windows of the season run it is 96-116 days in W1 and 1-23 in '
        + 'W5. The full-season result (delta_log_loss -0.00066, 95% CI [-0.00216, +0.00078], '
        + 'n=1158) was produced on that read, and 05-20..06-03 can never be scored as-of at all '
        + 'because woba_data_snapshot starts 2026-05-20 while fielding_frv_snapshot starts '
        + '2026-06-04.\n'
        + 'HINDSIGHT IS NOW MEASURED, AND IT IS SMALL. (2026-09-14) Isolated on the gate window '
        + 'by holding the term and the row set fixed and varying only the vintage -- legacy rows '
        + 'as of each game date against legacy rows as of 2026-09-12, both arms with the term ON, '
        + 'identical 797-game set: delta_log_loss -0.00010, 95% CI [-0.00061, +0.00039], 3 of 5 '
        + 'windows. The sign is the expected one (hindsight flatters the term) and the magnitude '
        + 'is 6.5% of the term-vs-OFF effect. The inputs really do move -- mean |delta FRV| 0.0291 '
        + 'runs/game per side, p90 0.0706, max 0.2191, across 79 distinct vintages, every game '
        + 'repriced -- so the as-of read works; vintage simply does not reach the target.\n'
        + 'SO HINDSIGHT DOES NOT EXPLAIN THE -0.00088 GAP between the gate window and the season '
        + 'run: it is nine times too small. That gap is a WINDOW effect, established separately by '
        + 'the n-matched resamples, which reproduce the season delta at the gate window n. The '
        + 'as-of scope is kept ON PRINCIPLE -- a replay should read what existed at the time, '
        + 'whether or not it changes the answer -- and NOT on the strength of this number, which '
        + 'would not carry it.\n'
        + 'WHAT THAT MAKES THE FULL-SEASON RESULT: ADMISSIBLE AS LEGACY-TERM EVIDENCE, not as '
        + 'split-term evidence. Its exclusion from this row rests on the TERM it was computed on, '
        + 'not on hindsight -- before 2026-09-13 the only rows that exist, current-state or '
        + 'snapshot, are the legacy one-row-per-player shape. Caveat on the hindsight figure '
        + 'itself, for the same reason: it was measured on the legacy term, and the split term '
        + 'carries more rows per player, so its vintage sensitivity is not established by it.\n'
        + 'AND THE WEAKNESS WAS NOT A SAMPLE-SIZE EFFECT, which is why the exclusion had to be '
        + 'argued on hindsight rather than on the delta. Three n-matched resamples of the '
        + 'season corpus at the gate window n (SAMPLE_N=1226 -> 812/779/801 usable, seeds 1-3) '
        + 'returned -0.00058, -0.00075, -0.00091, i.e. they reproduce the SEASON delta at the '
        + "GATE WINDOW'S n. The gap between -0.00154 and -0.00066 is a WINDOW effect. Window "
        + 'count was 4/5 in all four runs (spread 4,4,4), so it is reproducible at this n and '
        + 'also does not separate the two results.\n'
        + 'EFFECT-TO-RESOLVE ARITHMETIC, the tighter constraint. Gate window: |delta| 0.00154 '
        + 'against a CI half-width of 0.00169 = 0.91x the resolvable threshold, so resolving it '
        + 'needs about 797 * (1/0.91)^2 = 950 games. Full season: 0.00066 against 0.00147 = '
        + '0.45x, needing about 5700 -- roughly four more seasons. Widening the window buys '
        + 'games and loses effect, and the effect loss dominates.\n'
        + 'THE AS-OF CORPUS IS 0 GAMES TODAY, measured, and this is the binding fact. '
        + 'fielding_frv_snapshot spans 2026-06-04..09-13, but only the 2026-09-13 capture holds '
        + 'PER-POSITION rows (845 rows / 522 players); every earlier date is 521 rows / 521 '
        + 'players -- one summed cross-position row per player carrying a primary-position '
        + 'label, i.e. the LEGACY term whose evidence this row exists not to reuse. So an as-of '
        + 'read before 09-13 returns the pre-split term, and the as-of SPLIT corpus begins '
        + '2026-09-13: 11 games, none graded yet, 0 USABLE. It grows at the ~10-13 usable games '
        + 'per date the chain has been yielding, so ~950 games is ~80 slates away and the '
        + '1200-game bar ~115. Neither is this season, and no backfill can help -- Savant '
        + 'serves current-state, so what its per-position leaderboard said in June is gone.\n'
        + 'AS-OF AND CURRENT-STATE RUNS SCORE DIFFERENT FIELDER SETS. COMPARE LIKE WITH LIKE. '
        + '(2026-09-14, measured on the gate window after #400 made an as-of miss resolve as '
        + 'MISSING rather than falling back to current state.) 1042 of roughly 11000 fielding '
        + 'slots across 1596 team-sides -- about 9% -- have no snapshot row at or before their '
        + 'game date and now contribute nothing, so the team term is scaled over noticeably '
        + 'fewer resolved slots than a current-state run scales over. The cause is not missing '
        + 'capture DATES: it is roster growth in the snapshot itself, 480 qualifying players on '
        + '2026-06-16 rising to 521 on 09-12 as fielders cross FRV_MIN_OUTS, with 42 players in '
        + 'the current table absent from the June capture. A player with no as-of row had not '
        + 'qualified yet, which is the missing-fielder case, not a data gap.\n'
        + 'CONSEQUENCE FOR THIS ROW: a delta measured current-state and a delta measured as-of '
        + 'are not two readings of one quantity. The 9% is larger than the 535 slots that merely '
        + 'FELL BACK before #400, because those still contributed a number. Any comparison '
        + 'across the two reads must say which it used -- harnesses echo it as FRV read: '
        + 'asof|current via harness-inputs.frvAsOfLine() -- and FRV_READ=current reproduces the '
        + 'pre-2026-09-14 figures exactly.\n'
        + 'A MISSED fielding_frv_snapshot DAY IS AN UNRECOVERABLE HOLE IN THE ONLY EVIDENCE '
        + 'CORPUS THIS CRITERION IS ALLOWED TO USE. The as-of scope can only score dates that '
        + 'have a snapshot; Savant serves current state, so a missed capture cannot be '
        + 'reconstructed afterwards; and the corpus is small enough that one lost slate is about '
        + '1% of the first 1200 games. The wOBA holes cost a corpus that had alternatives -- a '
        + 'hole here has none. The 6AM chain gap check owns this (utils/pipeline-freshness.js, '
        + 'fielding_frv_snapshot), which is why it is named as a precondition above and not as '
        + 'a side concern.\n'
        + 'EXPECTED DISPOSITION AT WINDOW CLOSE 2026-10-31: UNRESOLVED. Re-evaluate on a pooled '
        + 'corpus rather than extending this window, and record it as unresolved rather than as '
        + 'a negative -- a null from a 0-game corpus carries no information about the term.\n'
        + 'SUPERSEDED-SCOPE EVIDENCE, kept with its n: gate window 2026-06-16..09-10, '
        + 'current-state FRV, n=797, delta_log_loss -0.00154, 95% CI [-0.00334, +0.00003], four '
        + 'of five metrics favourable (ECE 0.0331 -> 0.0339 the exception). Season 1158 as '
        + 'above, all five favourable (ECE 0.0252 -> 0.0214). Both are hindsight-contaminated '
        + 'and neither is a verdict.\n'
        + 'DO NOT FLIP on the pre-split evidence, and do not flip on the 797-game figure either.' },

  { id: 'use_hand_conditional_sp_weight', key: 'use_hand_conditional_sp_weight', on_expected: false,
    criterion: 'Calibration A/B (scripts/calibration-ab.js). Tier-2 sign-test standard: favourable windows at '
             + 'sign-test p <= 0.05, >=4 of 5 metrics favourable, pooled CI upper bound < +0.001 log loss.',
    criterion_type: 'none', precondition: 'hand_conditional_shadow_accumulating',
    window_end: null, decision: null,
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-22..08-23', harness: 'scripts/calibration-ab.js',
      figures: 'delta log loss +0.00009 [-0.00032, +0.00054] and +0.00008 [-0.00040, +0.00059], '
        + 'sign test 2/5, directionally worse on all five metrics, TIER 4',
      detail: 'This flag is the BATTER-side handedness weight (SP_WEIGHT, not SP_PIT_WEIGHT; see '
        + 'CLAUDE.md) and does not touch the bullpen term. What predates the change is the model both '
        + 'arms were scored on: league-constant bullpens and recomputed framing on each side.' },
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
        + 'selection-contaminated. Worth re-deriving on a calibration target before treating "no edge in overs" as settled.\n'
        + 'AMENDED 2026-09-17 — THE GATE DOES NOT DESCRIBE BETTING. 13 over bets are logged in '
        + 'bet_signals with bet_line IS NOT NULL (continuous-edge era, median emit edge 5.23pp). '
        + 'With overs_enabled=false this gate can never admit an over at any edge, so those 13 '
        + 'bets are direct evidence that what the gate surfaces and what gets bet are different '
        + 'populations. That does not make the "no edge in overs" decision wrong — it makes the '
        + 'gate the wrong instrument for reading betting behaviour, which is why the replay '
        + 'harnesses now report a by_category_bet bucket keyed on bet_line IS NOT NULL instead of '
        + 'approximating bets with a display floor. See utils/logged-bets.js and '
        + 'docs/highlight-gate-consolidation-2026-09-17.md.' },

  { id: 'ui_highlight_symmetric_floor', key: 'ui_highlight_ml_fav_min_pp', on_expected: false,
    criterion: 'Replace fav 2.0 / dog 4.5 with FAV FLOOR 3.5pp and DOG BAND 2.0-4.5pp. '
             + 'FLIP CRITERION: on a FORWARD window, |mean P(model) - realized| within the 95% '
             + 'resolution half-width in BOTH admitted cells, n >= 250 per cell. '
             + 'Re-run: the cell table in the note.',
    criterion_type: 'calibration', precondition: null,
    window_end: '2026-10-31', decision: null,
    corpus_size: 452,
    // Two settings keys move together here (ui_highlight_ml_fav_min_pp and
    // ui_highlight_ml_dog_min_pp) plus a dog UPPER bound that has no key at
    // all today. `key` names the fav one because the registry carries a
    // single settings key per row; the dog half is specified in the
    // criterion and must not be read off `key`.
    note: 'PROPOSAL ONLY — no behaviour change. Nothing in this row alters the shipped gate, '
        + 'which remains fav 2.0 / dog 4.5 / under 7.0 / overs never. (AMENDED 2026-09-17: those '
        + 'values are no longer hardcoded in public/index.html — every site reads app_settings '
        + 'through utils/highlight-gate.js. The numbers are unchanged; only their source is.)\n'
        + 'AMENDED 2026-09-17 — WHAT THE PROPOSED FLOORS WOULD EXCLUDE FROM ACTUAL BETS. Of the '
        + 'continuous-edge bets the operator logged (bet_line IS NOT NULL), 5 of 107 favs and 33 '
        + 'of 100 dogs sit BELOW the proposed admitted regions. A third of logged dogs falling '
        + 'outside a dog band means this proposal, if adopted as a betting rule, would disagree '
        + 'with a third of the dog bets already placed. It is a DISPLAY proposal and the criterion '
        + 'is calibration, so that is not an objection to it — but it must be stated before anyone '
        + 'reads the row as a description of betting. The by_category_bet bucket in the replay '
        + 'harnesses (2026-09-17) exists so this population can be measured directly.\n'
        + 'FOUNDING MEASUREMENT 2026-09-05. Whole season, contamination-filtered, continuous-edge '
        + 'rows only (signal_label IS NULL), P(model) from the frozen emit-time model_line, '
        + 'outcome from final scores. NO ROI USED — ROI over emitted signals measures selection, '
        + 'not pricing.\n'
        + '  FAV 2.0-3.5   n=113  err -0.135  +/-0.092  OVERCONF x1.47  <- excluded by the 3.5 floor\n'
        + '  FAV 3.5pp+    n= 78  err +0.021  +/-0.108  within noise    <- ADMITTED\n'
        + '  DOG 2.0-4.5   n=124  err -0.021  +/-0.088  within noise    <- ADMITTED\n'
        + '  DOG 4.5-6.0   n= 45  err -0.174  +/-0.135  OVERCONF x1.29  <- excluded by the band\n'
        + '  DOG 6.0pp+    n= 92  err -0.118  +/-0.099  OVERCONF x1.19  <- excluded by the band\n'
        + 'FAV IS A FLOOR: all the favourite overconfidence sits in 2.0-3.5; above 3.5 the error '
        + 'flips sign and stays inside the noise band, and fav 3.5pp+ has the smallest absolute '
        + 'calibration error of any fav floor tested (3.0/3.5/4.0/4.5).\n'
        + 'DOG IS A BAND, NOT A FLOOR: dog 2.0pp+ as a floor is OVERCONF x1.37 (n=261) because it '
        + 'readmits the 4.5+ tail, and that tail is overconfident across its whole range '
        + '(4.5-6.0 x1.29, 6.0+ x1.19) rather than in a trimmable corner. Favourites and dogs have '
        + 'OPPOSITE shapes: favs bad low and fine high, dogs fine low and bad high.\n'
        + 'CAVEAT MULTIPLICITY: many cuts were inspected (four fav floors, three dog floors, three '
        + 'upper bounds). This is not a pre-registered single test, which is exactly why the '
        + 'criterion demands a FORWARD window rather than accepting the retrospective fit.\n'
        + 'CAVEAT SELECTION: measured on EMITTED signals only. That is the right population for '
        + '"should this be highlighted", but it is silent about edges below the 1.0pp emit floor.\n'
        + 'UNDERS ARE NOT IN THIS PROPOSAL and are queued behind the totals run-environment work: '
        + 'a band proposal for unders will be measured against the corrected model, not this one. '
        + 'SUPERSEDED for unders by ui_highlight_under_band below, registered 2026-09-06.' },

  { id: 'ui_highlight_under_band', key: 'ui_highlight_tot_under_min_pp', on_expected: false,
    criterion: 'Replace the 7.0pp UNDER floor with a BAND, candidate [2.0, 5.0)pp. '
             + 'FLIP CRITERION: on a FORWARD window, |mean P(model) - realized| within the 95% '
             + 'resolution half-width in the admitted band, n >= 250 in that band. '
             + 'Re-run: the cell table in the note.',
    criterion_type: 'calibration', precondition: null,
    window_end: '2026-10-31', decision: null,
    corpus_size: 355,
    note: 'PROPOSAL ONLY — no behaviour change. The shipped gate remains under >= 7.0pp, '
        + 'overs never. (AMENDED 2026-09-17: no longer hardcoded in public/index.html — the page '
        + 'and all four harnesses read ui_highlight_tot_under_min_pp through '
        + 'utils/highlight-gate.js. Same value, one source.)\n'
        + 'AMENDED 2026-09-17 — CORROBORATION FROM THE BET LOG. 25 of the 29 logged continuous-edge '
        + 'under bets (bet_line IS NOT NULL) sit BELOW the current 7.0pp floor, median emit edge '
        + '2.49pp — i.e. the operator has been betting almost exclusively inside the band this row '
        + 'proposes to admit, and the current floor excludes 86% of what was actually bet. This is '
        + 'independent of the calibration table above and does not substitute for it (betting '
        + 'behaviour is not a calibration measurement), but it is consistent with the same '
        + 'conclusion: the 7.0 floor describes neither the calibrated band nor the bets.\n'
        + 'MEASURED 2026-09-06 on a copy refreshed from production, scored through 2026-09-04 '
        + '(1159 clean completed games). Contamination-filtered on both reasons, continuous-edge '
        + 'rows only, pushes dropped. corpus_size 355 = all under signals in the measurement; the '
        + 'admitted band holds 157 of them. NO ROI USED.\n'
        + 'P(model under) = Phi((market_line - model_line)/sigma), sigma = 4.396 runs from the '
        + 'same corpus. Realized = actual total below the line.\n'
        + '  under 1.0-2.0    n=112  err -0.015  +/-0.092  within noise\n'
        + '  under 2.0-5.0    n=157  err -0.015  +/-0.078  within noise    <- ADMITTED\n'
        + '  under 5.0-7.0    n= 50  err -0.157  +/-0.138  OVERCONF x1.14  <- excluded by the band\n'
        + '  under 7.0pp+     n= 35  err -0.080  +/-0.165  within noise    <- the CURRENT floor\n'
        + 'THE CURRENT FLOOR ADMITS 35 SIGNALS IN A SEASON at a +/-0.165 half-width. It is not '
        + 'mis-calibrated; it is unresolvable. It cannot be shown right or wrong by any amount of '
        + 'data it will collect, which is the actual case against it.\n'
        + 'THE 2.0 LOWER BOUND IS NOT CALIBRATION-DERIVED. under 1.0-2.0 is equally within noise '
        + '(-0.015). The lower bound mirrors the ML proposal shape and the 1.0pp emit floor; if it '
        + 'is ever justified it will be on a different argument than this table.\n'
        + 'THIS IS A CALIBRATION CLAIM ABOUT THE ADMITTED BAND, NOT AN EDGE CLAIM. It says the '
        + 'model’s stated probabilities in [2.0,5.0) match outcomes. It does NOT say those '
        + 'signals are profitable or that the model beats the line. On the same fresh copy the '
        + 'totals model has NO demonstrable discrimination over the market: '
        + 'corr(model-market, actual-market) = +0.0064, 95% CI [-0.089, +0.102], n=424 on '
        + '2026-08-03..now. A well-calibrated forecast with no edge is exactly what that pair of '
        + 'facts describes, and highlighting is a display decision, not a betting one.\n'
        + 'CAVEAT MULTIPLICITY: several cuts were inspected (1-2, 2-5, 5-7, 7+, plus a finer '
        + '1-3/3-5/5-7/7-9/9+ grid). Not a pre-registered single test — hence the forward window.\n'
        + 'CAVEAT REACHABILITY: the admitted band accumulated 157 signals across a full season, so '
        + 'a forward window to 2026-10-31 will NOT reach n=250. The honest outcome is UNRESOLVED '
        + 'at window end, to be re-registered against a pooled multi-season corpus. Lowering the '
        + 'bar to make it resolve would defeat the purpose of setting one.' },

  { id: 'spread_edge_display_enabled', key: null, on_expected: false,
    criterion: 'OFF 2026-09-11. The empirical-spread pp figures are not shown on the '
             + 'card and are not presented as a recommendation anywhere. The engine\'s '
             + 'cell cover probability is worse calibrated than the Kalshi ask it is '
             + 'quoted against, so an "edge" computed as (empirical - implied) is not '
             + 'measuring an edge. Flag lives at routes/api.js '
             + 'SPREAD_EDGE_DISPLAY_ENABLED (a code constant, not a settings key -- '
             + 'this is not a knob to flip from the settings card).\n'
             + 'RE-ENABLE CRITERION (AMENDED 2026-09-12 -- the original was a single '
             + 'measure and a monotone recalibration passed it the same day while being '
             + 'worse on everything else; see AMENDMENT in the note). A recalibrated or '
             + 'rebuilt engine must beat the MARKET out of sample on a FORWARD window '
             + '-- n >= 2,000 distinct plays (one row per date/game/team/line/side, '
             + 'NOT per odds pass), fitted strictly before that window -- on ALL FOUR '
             + 'of the following, not any one:\n'
             + '  (1) n-weighted mean |bin error| BELOW the market\'s on the window;\n'
             + '  (2) Brier NO WORSE than the market\'s;\n'
             + '  (3) log loss NO WORSE than the market\'s;\n'
             + '  (4) AUC EXCEEDING the market\'s BY AT LEAST 0.005 -- not merely '
             + 'matching it (TIGHTENED 2026-09-12; see AMENDMENT 2 in the note);\n'
             + '  (5) PRICE-BAND CHECK: within fixed implied-price bands, plays the '
             + 'candidate calls edge >= 3pp must win MORE OFTEN than plays it calls '
             + 'edge < 0, in AT LEAST THREE of four bands carrying n >= 50 on both '
             + 'sides. Bands: [0.15,0.30) [0.30,0.45) [0.45,0.60) [0.60,0.75).\n'
             + 'Clause (4) is the load-bearing one against RECALIBRATION: it is the '
             + 'only clause a monotone map cannot game, because AUC depends solely on '
             + 'ranking and a monotone map cannot reorder. The 0.005 margin exists '
             + 'because "at least the market\'s" was cleared by 0.0002, which is not a '
             + 'win. Clause (5) is the load-bearing one against a WELL-LABELLED BUT '
             + 'UNINFORMATIVE forecast: a candidate can be better calibrated than the '
             + 'price while ranking outcomes no better, in which case its edges are '
             + 'noise and clauses (1)-(4) will not notice. Clauses (2) and (3) stop a '
             + 'forecast that buys calibration with sharpness -- a constant base-rate '
             + 'predictor is perfectly calibrated and worthless. Beating the RAW engine '
             + 'is not the bar; the raw engine is the thing that failed. Re-run: the '
             + 'walk-forward harness described in the founding measurement below.',
    criterion_type: 'calibration', precondition: null,
    window_end: null, decision: {
      date: '2026-09-11', outcome: 'disabled_on_calibration',
      ref: 'routes/api.js SPREAD_EDGE_DISPLAY_ENABLED' },
    corpus_size: 7404,
    note: 'FOUNDING MEASUREMENT (this is what decided it). Walk-forward over 88 dates '
        + '2026-06-04..09-04, 14,004 distinct plays, one row per (date, game, '
        + 'spread_team, spread_line, side) built from final margins -- NOT from '
        + 'empirical_spread_outcomes, which re-writes every play on every odds pass '
        + '(~28x pseudo-replication that narrows every CI by roughly 5x). Each date '
        + 'priced against a cell index built ONLY from games strictly before it. '
        + 'corpus_size 7404 = the display-eligible subset (cell n >= 150, tail ok); '
        + 'the out-of-sample test half is 4,776.\n'
        + 'CALIBRATION. n-weighted mean |bin error| in 5pp bins: ENGINE 5.84pp vs '
        + 'MARKET 4.03pp. The error is S-shaped, not a simple inflation: overstated at '
        + 'the top (85-90 stated -> 74.0 realized, +13.4 +-4.6) and understated in the '
        + 'middle (50-55 stated 53.2 -> 72.6 realized, -19.5 +-5.7; 60-65 stated 62.3 '
        + '-> 82.0, -19.7 +-4.4). Both halves survive the test window alone (>=80: '
        + '+14.3 +-3.5 on n=652; 50-65: -15.4 +-3.7 across 398 distinct games and 7 '
        + 'cells), so neither is one bad cell. The single clearest statement: a play '
        + 'the card labelled 85% won 74% of the time.\n'
        + 'DISCRIMINATION. AUC on the test window: engine 0.7477, market 0.7560. '
        + 'Stated edge does not predict outcomes within a fixed price band -- win-rate '
        + 'differences between edge>=3pp and edge<0 run +8.4, +12.0, -0.3, -5.0, -7.0 '
        + 'across implied bands, mixed signs, no pattern.\n'
        + 'SHRINKAGE. For p = w*empirical + (1-w)*implied, fitted on games before '
        + '2026-08-01 and tested after: w = 0.00 minimizes fit Brier, and w = 0.04 is '
        + 'the best achievable fitted DIRECTLY on the test half. Brier is monotone '
        + 'increasing in w on both halves (test 0.1987 at w=0, 0.2022 at w=1). At the '
        + 'optimal w the edge is identically zero and every one of the 1,331 plays that '
        + 'would have been shown on the test window disappears.\n'
        + 'AMENDMENT 2026-09-12 -- WHY THE BAR CHANGED. The original criterion was a '
        + 'single measure: mean |bin error| below the market\'s. An ISOTONIC '
        + 'recalibration of empirical_pct, fitted on games before 2026-08-01 and '
        + 'evaluated on the 4,776 plays after, MET IT -- 3.16pp against the market\'s '
        + '4.72pp in 5pp bins (3.04 vs 3.98 in 10pp bins), out of sample, on n well '
        + 'past 2,000. It should not have re-enabled anything: the same model was worse '
        + 'on Brier (0.1990 vs 0.1987), clearly worse on log loss (0.6288 vs 0.5876), '
        + 'and worse on AUC (0.7477 vs 0.7560). Platt was worse still (Brier 0.2016, '
        + 'mean |bin error| 5.53). A bar a forecast can clear while losing on every '
        + 'other measure is a badly specified bar, so it now requires all four.\n'
        + 'AND WHY RECALIBRATION IS NOT THE PATH. Isotonic and Platt are both MONOTONE '
        + 'transforms, and AUC depends only on ranking, so neither can change it: both '
        + 'recalibrated models score EXACTLY 0.7477, identical to the raw engine, '
        + 'against the market\'s 0.7560. No post-hoc map -- not these two, not any yet '
        + 'to be tried -- can close that gap. The engine\'s problem is not that its '
        + 'probabilities are mislabelled; it is that its RANKING of which side covers '
        + 'is worse than the price\'s. THE TARGET IS THE AUC GAP: 0.7477 vs 0.7560. '
        + 'Any re-enable path therefore runs through the CELL DEFINITION -- what the '
        + 'cell conditions on -- or through a new signal, not through post-processing.\n'
        + 'AMENDMENT 2, 2026-09-12 -- WHY THE BAR TIGHTENED AGAIN. A fitted MARGIN '
        + 'model was measured against the posted runline price: proportional-odds '
        + 'ordinal logistic on the home margin (8 ordered categories, 7 cutpoints, '
        + 'P(M<=c) = sigmoid(theta_c - beta.x)), fitted on 1,482 games before '
        + '2026-08-01 and evaluated on 5,472 distinct plays after. Three arms: A = '
        + 'model wp + model total, B = market (Kalshi) wp + market total, C = both.\n'
        + '  arm                        mean|bin err|   Brier   logloss     AUC\n'
        + '  MARKET (posted implied)         2.59      0.1896   0.5641    0.7797\n'
        + '  A  model inputs                 2.08      0.1911   0.5685    0.7762\n'
        + '  B  market inputs                1.07      0.1892   0.5632    0.7799\n'
        + '  C  both                         2.25      0.1909   0.5679    0.7769\n'
        + 'ARM B CLEARED ALL FOUR ORIGINAL CLAUSES. It does NOT re-enable the display, '
        + 'for two reasons recorded here so the decision is not relitigated from the '
        + 'headline alone. FIRST, three of its four clauses are ties by rounding: '
        + 'Brier 0.1892 vs 0.1896, logloss 0.5632 vs 0.5641, and AUC 0.7799 vs 0.7797 '
        + '-- a gap of 0.0002. Only clause (1) is a real separation. Hence the 0.005 '
        + 'margin now on clause (4). SECOND, B FAILED THE PRICE-BAND CHECK: its '
        + 'edge>=3pp plays beat its edge<0 plays in only ONE of four usable bands '
        + '(-2.8, -1.9, +19.5, -0.6 pp), and the single positive rested on n=57. So B '
        + 'is better LABELLED than the market, not better INFORMED -- it ranks '
        + 'outcomes indistinguishably and puts more accurate numbers on the same '
        + 'ordering. Hence clause (5). ROI at the posted ask on B\'s edge>=3pp plays '
        + 'was +2.34 per 100 [-13.0, +17.7] on 572 plays: an interval fifteen points '
        + 'wide either way, which decides nothing.\n'
        + 'EFFECTIVE-n CAVEAT, WHICH APPLIES TO EVERY FIGURE ABOVE: 5,472 plays sit on '
        + '456 games x 3 lines = 1,368 INDEPENDENT market outcomes. lay and take are '
        + 'exact complements and the two teams at a line are near-mirrors, so the '
        + 'effective sample is roughly a quarter of the row count and every interval '
        + 'quoted is correspondingly wider than it looks. The n >= 2,000 in the '
        + 'criterion is a ROW count; an evaluator should satisfy itself that the '
        + 'independent-outcome count behind it is not a quarter of that.\n'
        + 'WHAT ARM B ACTUALLY SHOWS, stated plainly because it is the only durable '
        + 'finding in this line of work: a smooth function of KALSHI\'S OWN moneyline '
        + 'and total is better calibrated than KALSHI\'S OWN runline price. That is a '
        + 'claim about the exchange\'s internal consistency across its markets. The '
        + 'MODEL contributes nothing to it -- arm A lost on three clauses and arm C, '
        + 'which adds model inputs to the market ones, was WORSE than the market '
        + 'alone on three. Any re-enable path still runs through the cell definition '
        + 'or a new signal, as AMENDMENT 1 says.\n'
        + 'ARM B IS REGISTERED AS A CANDIDATE, NOT ADOPTED. Its predictions are '
        + 'persisted forward on every odds pass into spread_candidate_predictions '
        + '(candidate = margin_model_B) by services/spread-candidate-margin-model.js, '
        + 'with coefficients FROZEN at the pre-2026-08-01 fit. Nothing is displayed. '
        + 'The point is a forward-honest evaluation at season end and next season '
        + 'against rows that were written before the games happened; refitting on '
        + 'accumulated data would convert that into an in-sample test and nothing '
        + 'downstream could tell. A refit belongs in a NEW candidate id.\n'
        + 'SUPPORTING, NOT DECIDING: displayed plays (edge >= 3pp) returned -3.91 per '
        + '100 [-8.6, +0.8] against -2.50 [-7.9, +2.9] for the 0-3pp band the floor was '
        + 'hiding, on 13,788 distinct graded plays. ROI measures selection, not pricing '
        + '(see the CLAUDE.md rule), so it is recorded as corroboration of the '
        + 'calibration finding and is NOT the criterion.\n'
        + 'CAVEAT, STATED SO IT IS NOT DISCOVERED LATER: implied_pct comes from Kalshi '
        + 'ASKS on both legs (lay uses yes_ask, take uses no_ask), so the pair carries '
        + 'about 1pp of overround while the engine\'s two legs sum to exactly 100. A '
        + 'comparison against mid would flatter the model. It would not change a '
        + 'betting decision, because you transact at the ask.\n'
        + 'WHAT STAYS ON. Signals still compute and persist -- empirical_spread_signals '
        + 'and empirical_spread_outcomes keep writing every pass, cells and the '
        + 'live/locked axis included -- so the forward record continues and the '
        + 're-enable criterion has data to be judged on. Only the RENDER is gated. The '
        + 'CLI (scripts/empirical-spread-edge.js) still prints the pp figures behind a '
        + 'banner, because measuring a broken number requires being able to see it.\n'
        + 'WHAT THE CARD SHOWS: NOTHING ABOUT RUNLINES. (Revised 2026-09-12. The '
        + '2026-09-11 version of this row said the card kept the cell label, cell n, '
        + 'the axis badge and the posted prices. It did for one day, and that was the '
        + 'wrong call -- a runline block on the card is a runline recommendation '
        + 'whatever it contains, the price table said nothing the market-line row under '
        + 'the ML boxes does not already say, and it doubled the block height on 225 '
        + 'cards to carry no claim.) The API omits empirical_spreads entirely while the '
        + 'gate is off; the client also requires an explicit edge_display === true, so '
        + 'it fails closed against a stale bundle. There is no third "prices only" '
        + 'mode -- the block is hidden or complete, and when the gate flips it returns '
        + 'with edges. EXCEPT: the one-line "Spread: AWAY -1.5 (-140) / HOME +1.5 '
        + '(+120) - src" row under the ML boxes is NOT this block. It is built from '
        + 'game_log.market_*_spread in a separate path and is a market-line reference, '
        + 'not a play. It stays.\n'
        + 'THE CELL WORK IS NOT WHAT FAILED. #371-#373 (market-total axis, weather-row '
        + 'admission, live-until-lock) are unaffected: the cell label, its n and its '
        + 'axis are honest descriptions of which reference population a game sits in. '
        + 'What the data refuses is the step from "this cell covered 82% historically" '
        + 'to "therefore this price has 14pp of edge".' },

  { id: 'spread_cells_market_total_axis', key: null, on_expected: true,
    criterion: 'ADOPTED 2026-09-10, not trialled. The empirical-spread cell total axis is '
             + 'the MARKET total (Low <8.25 / Average 8.25-8.75 / High >=8.75), frozen in '
             + 'game_log.market_total_at_emit; win-prob tiers stay on the model. '
             + 'FORWARD CRITERION: on games bucketed with a FROZEN axis value (not the '
             + 'market_total fallback), the Average-vs-pooled-Low+High cover-rate split must '
             + 'still exclude zero in the Balanced tier, at n >= 250 in Balanced/Average. '
             + 'Re-run: node scripts/test-spread-cell-axis.js for the partition, and the '
             + 'deciding-test block in the 2026-09-10 analysis for the split.',
    criterion_type: 'calibration', precondition: null,
    window_end: '2026-11-15', decision: {
      date: '2026-09-10', outcome: 'adopted_on_stability',
      ref: 'services/empirical-spread-edge.js TOTAL_LOW_MAX comment' },
    corpus_size: 1158,
    note: 'THE SPLITS DID NOT CARRY THIS DECISION; THE STABILITY ARGUMENT DID. The deciding '
        + 'test returned 2 significant results of 12 tested -- Balanced/home +11.1pp '
        + '[+1.6, +20.5] and Underdog-home/away -12.4pp [-22.1, -2.7] -- and at 12 tests '
        + 'roughly 0.6 false positives are expected at 95%. That is SUGGESTIVE, not '
        + 'established, and the forward criterion exists because of it.\n'
        + 'AMENDED 2026-09-10 (same day, after the weather filter came off buildCellIndex): '
        + 'the Balanced/home split above does NOT survive the larger corpus. At n=1,938 it '
        + 'reads +3.6pp [-4.0, +11.2] -- same axis, same cells, four times the sample, '
        + 'effect shrinking toward zero, which is what noise does as n grows. Under candidate '
        + "B's partition at the same n it reads +6.4 [-0.3, +13.0], also not significant. So "
        + 'the split that this row cited as its strongest evidence is gone, and THE AXIS '
        + 'DECISION RESTS ENTIRELY ON THE STABILITY ARGUMENT BELOW. That was already the '
        + 'stated basis, which is the only reason the row survives its own evidence '
        + 'collapsing. The one split that replicated across corpora is Underdog-home/away, '
        + 'and only on the MODEL win-prob axis (-12.4pp at n=1,158, -9.9 [-17.0, -2.7] at '
        + 'n=1,938; -4.6, not significant, under B). NOTE the forward criterion is not yet '
        + 'literally answered: it asks for n>=250 in Balanced/Average on FROZEN-axis games, '
        + 'and none exist yet. This is the same measurement on fallback-axis rows. Do not '
        + 'record the criterion as met or failed on this basis.\n'
        + 'WHAT DID CARRY IT: the old axis keyed on model_total, a model output, and the same '
        + 'quantity whose discrimination collapsed on 2026-08-03 (corr(model-market, '
        + 'actual-market) +0.21 -> +0.02 [-0.089, +0.102]). A cell definition that moves when '
        + 'the model moves cannot be a stable frame for measuring the model. The market cuts '
        + 'fall BETWEEN posted rungs: 0.0% of 1,158 graded games sit on 8.25 or 8.75, against '
        + '41.4% within a rung of the old continuous 8.5 cut.\n'
        + 'CANDIDATE B REJECTED (market win-prob as well as market total): agrees with the '
        + 'model tier on only 58.0% of games, moves 68.7% of them against A 48.5%, and its '
        + '0.500 cut is far less stable -- 18.0% of games within +/-2pp against the model 7.1%.\n'
        + 'COST, PAID KNOWINGLY: 6 cells -> 9, median cell n 207 -> 134, and 6 of 9 cells '
        + 'under 150. The display floor moved 50 -> 150 in the same change, so 3 of 9 cells '
        + 'surfaced a play where 6 of 6 did before. Sub-floor cells still compute and '
        + 'persist; they are hidden, not deleted. MOST OF THAT COST WAS REFUNDED HOURS LATER: '
        + 'dropping the weather-contamination filter from buildCellIndex took the index from '
        + '1,158 rows to 1,938, median cell n 134 -> 205, and 7 of 9 cells over 150 with 3 '
        + 'over 250. Only Balanced/High (148) and Strong fav/High (106) stay hidden. That '
        + 'filter was excluding rows for a reason that died with this axis change -- it '
        + 'existed because a contaminated model_total mis-bucketed the row, and the bucket no '
        + 'longer keys on model_total. Weather reaches neither axis: 0 of 780 tagged rows '
        + 'changed win-prob tier when re-priced with weather zeroed out entirely.\n'
        + 'CORPUS 1158 = graded, clean-weather, with both a market total and a market ML pair, '
        + 'to 2026-09-04. Every historical row currently buckets on the market_total FALLBACK, '
        + 'not on a frozen value -- market_total_at_emit only starts filling from this deploy, '
        + 'and the backfill is impossible. buildCellIndex returns usedFallback so the share is '
        + 'reportable rather than assumed.\n'
        + 'RE-BASELINE: empirical_spread_signals.cell_label rows written before 2026-09-10 '
        + 'carry the old six-label taxonomy ("Low total"/"High total"). Labels were renamed '
        + 'deliberately so the two cannot be pooled by accident. Nothing groups or filters on '
        + 'that column today (checked across services/, routes/, scripts/); anything that '
        + 'starts to must split on the cutover date.' },

  // ---- numeric gates ----
  { id: 'signal_edge_hard_cap_pp', key: 'signal_edge_hard_cap_pp', numeric: true,
    criterion: 'Hard suppression threshold. Shipped at 0.08 (schema default 0.25).',
    criterion_type: 'roi', window_end: null,
    decision: { date: '2026-07-13', outcome: 'shipped_at_0.08', ref: 'docs/ship-hard-cap-0.08-2026-07-13.md' },
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-22', harness: 'scripts/edge-honesty-scope.js',
      figures: 'the edge-honesty finding cited in the note',
      detail: 'Same as signal_edge_cap_enabled: the ROI decision is unaffected, the cited calibration '
        + 'scope predates the persisted inputs.' },
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
             + 'CLV demoted to context and split by same-side vs churn. Was: accuracy + CLV with CLV weighted heaviest.\n'
             + 'CLV PRONG RE-SPECIFIED 2026-09-12: MARGINAL ROWS ONLY. The prong reads forward-honest CLV on the '
             + 'signals the harness derives per config against their captured closing lines, restricted to the rows '
             + 'where the two configs DISAGREE -- without_only + with_only + side_flipped from clv.bet_set_diff. '
             + 'Same-side rows are excluded because their CLV is byte-identical under both configs (verified: 0 of '
             + '378 differ) and they contribute exactly zero to the delta.\n'
             + 'PRECONDITIONS ARE MET as of 2026-09-12: 88 snapshot days (bar 60) and 1,110 graded games since the '
             + 'first snapshot (bar 500). Sample is no longer what blocks this gate and has not been for weeks.',
    criterion_type: 'calibration', window_end: '2026-09-28', decision: null,
    precondition: 'bsr_snapshots_60d',
    corpus_size: 1100,
    note: 'Gate window opened 2026-08-13. WINDOW_END MOVED 2026-09-14 -> 2026-09-28 so the call lands after the '
        + 'regular season ends (~2026-09-27) rather than two weeks before it, on a re-specified CLV prong that had '
        + 'not yet been measured when the old date was set.\n'
        + 'WHY THE CLV PRONG CHANGED. Measured 2026-08-23: 330 of 348 HARNESS-SIGNALED bets were the SAME SIDE in '
        + 'both configs and contribute exactly zero to a with-vs-without delta, leaving ~18 marginal bets to carry '
        + 'a prong the original gate weighted HEAVIEST. TERMINOLOGY, corrected 2026-09-12 before this row merged: '
        + 'those 348 are bets the BACKTEST HARNESS derives per config over every scored game '
        + '(services/baserunning-backtest.js re-picks the signaled side under each arm), NOT rows with '
        + 'bet_signals.bet_line set. The harness never read logged bets, so "switch from logged bets to emitted '
        + 'signals" was never the fix and an earlier draft of this row said so wrongly. The population was always '
        + 'right; what was wrong was POOLING it.\n'
        + 'MARGINAL ROWS ONLY is the actual re-spec, and is the same selection trap in a new place: pooling '
        + 'same-side rows into the delta does not average the effect down, it divides it by the share of rows that '
        + 'cannot move. A with-vs-without number computed over all rows is mostly measuring how often the two '
        + 'configs agree, which is not the question. On the 2026-09-12 run the pooled figures read 1.353pp (n=425, '
        + 'without) against 1.501pp (n=418, with) -- a +0.148pp gap that is 87 disagreeing rows diluted through 378 '
        + 'identical ones.\n'
        + 'FORWARD WINDOW as of 2026-09-12: 2026-06-16 .. 2026-09-10, 87 days, 1,100 graded games with lineups, '
        + '1,884 emitted signals. Snapshot cadence 87 of 88 days on all three BsR tables; the single gap is '
        + '2026-09-03, a whole-chain miss (all five daily-snapshot tables and the 5:30 PT fg-woba job, on a day '
        + 'with 726 cron rows and no restart signature). It was found a week late by diffing snapshot dates '
        + 'against a calendar, because none of those jobs wrote a cron_log row. They do now -- see '
        + 'scripts/test-snapshot-chain-cron-log.js. The 2026-09-08..09-11 boot-loop and failed-deploy days cost '
        + 'ZERO snapshots; all five tables are present on every one of them.\n'
        + 'corpus_size 1100 = graded games with both lineups inside the forward window, which is the accuracy '
        + 'prong s population. The harness scores a subset of those -- 807 on the 2026-09-12 run, since it also '
        + 'needs a resolvable lineup BsR and a morning ML capture. The CLV prong s RESOLVABLE population is the '
        + 'marginal rows inside the harness bet sets: 87 of 425 on that run (47 without-only, 40 with-only, 0 '
        + 'flips). Separately, 1,812 of 1,884 emitted bet_signals in the window carry a closing line -- that is a '
        + 'fact about coverage, not the prong s population, and an earlier draft of this row confused the two.\n'
        + 'AMENDED 2026-09-18 -- THAT 1,812 COUNTED FABRICATED ROWS. Re-measured on the remediated copy the '
        + 'window reads 1,243 of 1,956 (63.5%), and the drop is not decay: scripts/null-fabricated-totals-closing.js '
        + 'NULLs the totals closing lines the old GET /backtest manufactured (it assigned closing_line = market_line '
        + 'on every request). Split by type the picture is clean -- ML 1,041/1,049 (99.2%), Total 202/907 (22.3%), '
        + 'and 99.6% pooled if the fabricated totals rows are counted back in, which is where 1,812/1,884 came from. '
        + 'The CLV prong is unaffected either way: it is ML-only and reads empirical_market_captures, not this '
        + 'column, and 1,143 of 1,145 scored games in the window carry both a morning and a gametime ML capture. '
        + 'A pooled >90% assertion in scripts/test-bsr-gate-respec.js was failing on this and has been replaced by '
        + 'the ML-only and capture-coverage forms; see that file for why re-pinning the pooled number would have '
        + 'meant asking for the fabricated rows back.\n'
        + 'See docs/bsr-gate-status-2026-08-23.md for the original measurement.' },

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
    evidence_predates: { event: 'harness_inputs_persisted',
      measured: '2026-08-31', harness: 'scripts/bullpen-neutral-ab.js',
      figures: 'paired d log loss +0.000019 against +/-0.000217, and the ~105,000-game resolvability figure',
      detail: 'Narrower than the others: that script supplies both bullpen arms itself and overrides '
        + 'the populated values, so the term under test is unchanged. What moves is everything else '
        + 'the arms share, framing above all (recomputed then, persisted now).' },
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
      // Informational, never needs_attention on its own: the evidence is not
      // wrong, it was measured on an input set that has since changed.
      evidence_predates: g.evidence_predates
        ? Object.assign({ event_date: (REBASELINE_EVENTS[g.evidence_predates.event] || {}).date || null },
            g.evidence_predates)
        : null,
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
  // corpus_size standard, reported in the same 6AM pass that reports gate
  // windows. Loud on violation, one quiet line otherwise -- a check nobody
  // ever sees pass is a check nobody trusts when it fails.
  const cs = checkCorpusSize(r.gates.length ? GATES : GATES);
  if (!cs.ok) {
    if (cs.missing.length) {
      console.warn('[gate-health] corpus_size MISSING on ' + cs.missing.length
        + ' non-grandfathered row(s): ' + cs.missing.join(', ')
        + ' — a recorded criterion without an n is not re-runnable.');
    }
    if (cs.unexpected.length) {
      console.warn('[gate-health] corpus_size now present on grandfathered row(s): '
        + cs.unexpected.join(', ')
        + ' — prune them from CORPUS_SIZE_GRANDFATHERED so the list keeps its teeth.');
    }
    if (cs.bad.length) {
      console.warn('[gate-health] corpus_size malformed (want a positive number or explicit null): '
        + cs.bad.join(', '));
    }
  } else {
    console.log('[gate-health] corpus_size OK — ' + (cs.total - cs.grandfathered)
      + ' row(s) under the standard, ' + cs.grandfathered + ' grandfathered');
  }

  // One quiet line per re-baseline event, until each row is re-run and the
  // field removed. Not an attention item: nobody should flip or un-flip a
  // gate because of it, only avoid quoting the old figure as current.
  const predates = {};
  for (const g of r.gates) {
    if (!g.evidence_predates) continue;
    (predates[g.evidence_predates.event] = predates[g.evidence_predates.event] || []).push(g.id);
  }
  for (const ev of Object.keys(predates)) {
    const E = REBASELINE_EVENTS[ev] || {};
    console.log('[gate-health] ' + predates[ev].length + ' gate(s) quote evidence measured before the '
      + (E.date || '?') + ' ' + ev + ' re-baseline, not yet re-run (reproduce old figures with '
      + (E.reproduce || '?') + '): ' + predates[ev].join(', '));
  }

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

// corpus_size IS REQUIRED ON NEW REGISTRY ROWS. (2026-09-05)
//
// A recorded criterion without an n is not re-runnable and not falsifiable.
// The FRV row is the case that forced this: its numbers were recorded on
// 790 games, the weather-contamination backfill later cut the same window
// to 439, and nothing on the row said which corpus the figures came from --
// so "not significant" could not be distinguished from "not significant on
// a corpus that no longer exists".
//
// GRANDFATHERED, not retrofitted. All 26 rows that predate this standard
// are listed below and exempt. Backfilling an n onto them would mean
// inventing one, which is worse than an honest gap. The rule binds the
// NEXT row.
//
// BASELINE ARM: the check fails in BOTH directions. A new row without
// corpus_size fails, and a grandfathered row that GAINS one also fails --
// so the exemption list gets pruned rather than carried forever. A
// permanently-accepted failure list is how a real regression hides inside
// a carried failure count.
const CORPUS_SIZE_GRANDFATHERED = [
  'use_opener_logic', 'catcher_framing_enabled', 'park_neutral_inputs_enabled',
  'signal_venue_aware_enabled', 'kalshi_direct_primary_enabled',
  'kalshi_direct_totals_enabled', 'signal_edge_cap_enabled',
  'bullpen_downweight_starters', 'sp_prefer_rotowire', 'totals_selection_edge',
  'defense_frv_enabled', 'use_hand_conditional_sp_weight',
  'ui_highlight_tot_overs_enabled', 'signal_edge_hard_cap_pp',
  'signal_edge_soft_cap_pp', 'catcher_framing_mute', 'defense_frv_mute',
  // bsr_baserunning PRUNED 2026-09-12: it now carries corpus_size 1100.
  // The gate-health baseline arm flagged it the moment the field landed,
  // which is the arm working -- an accepted-failure list that never
  // shrinks stops being a list of exceptions and becomes the norm.
  'catcher_framing_takes_per_game', 'sp_weight_l',
  'bullpen_w_proj_w_act', 'at_emit_snapshot_columns',
  'retractable_roof_config_branch', 'bullpen_woba_neutralization',
  'debug_bullpen_endpoint_divergence', 'bullpen_pool_lastname_fallback',
];

// corpus_size may be a positive number, or an explicit null WITH the reason
// carried in the note (a criterion that genuinely has no corpus yet -- a
// shadow gate still accumulating, say). `undefined` is the failure: it means
// nobody decided.
function checkCorpusSize(gates) {
  const g = gates || GATES;
  const missing = [], unexpected = [], bad = [];
  for (const row of g) {
    const grandfathered = CORPUS_SIZE_GRANDFATHERED.indexOf(row.id) !== -1;
    const has = Object.prototype.hasOwnProperty.call(row, 'corpus_size');
    if (!grandfathered && !has) { missing.push(row.id); continue; }
    if (grandfathered && has) { unexpected.push(row.id); continue; }
    if (has && row.corpus_size !== null
        && !(typeof row.corpus_size === 'number' && isFinite(row.corpus_size) && row.corpus_size > 0)) {
      bad.push(row.id + ' (' + JSON.stringify(row.corpus_size) + ')');
    }
  }
  return {
    ok: !missing.length && !unexpected.length && !bad.length,
    missing,      // new row with no corpus_size -- the standard was ignored
    unexpected,   // grandfathered row that gained one -- prune the list
    bad,          // present but not a positive number or explicit null
    grandfathered: CORPUS_SIZE_GRANDFATHERED.length,
    total: g.length,
  };
}

module.exports = { GATES, STATUS, evaluateGates, logGateHealth, PRECONDITIONS,
  checkCorpusSize, CORPUS_SIZE_GRANDFATHERED, REBASELINE_EVENTS };
