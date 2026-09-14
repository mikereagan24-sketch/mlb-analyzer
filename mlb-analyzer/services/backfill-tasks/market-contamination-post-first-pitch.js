'use strict';

// Backfill task: tag games whose market price moved after real first pitch.
// (2026-09-14)
//
// WHY THIS EXISTS. The tag was computed by a laptop script
// (scripts/tag-post-start-pricing.js) that only ever ran against
// data/mlb.db. Result: 273 games tagged on the analysis copy, 0 on
// production -- with BYTE-IDENTICAL inputs on both, 42903 priced ml capture
// rows over 1249 games, 2026-06-11..09-13. Prod's zero was an unrun job,
// not a different finding, and it had two consequences:
//
//   - /api reported ZERO market contamination on a production surface,
//     which is a false all-clear rather than a missing convenience
//   - the park_neutral_resolvable_979 precondition reads this column, so
//     gate preconditions evaluated differently on prod than locally
//
// WHY NOT DROP THE FILTER INSTEAD. The guard-removal rule: name the failure
// mode, then check whether the corpus can see it. The failure mode is a
// stored market_*_ml written AFTER first pitch, so the claimed edge is
// measured against a line that already knew something about the game. The
// tag is DERIVED FROM bet_signal_audit and empirical_market_captures --
// production evidence of what happened at emit time -- and is not visible
// in game_log's own columns at all. So a calibration corpus cannot evaluate
// this guard: the tag is the only record of the defect, and a run on the
// filtered corpus is a run on the population its target was removed from.
// The rule's own remedy is to go to production evidence for guards, which
// is exactly what this task reads.
//
// THE CRITERION IS NOT RESPELLED HERE. utils/post-start-pricing.js owns it
// and post-start-price-change.js reads the same module, so the tagging
// criterion and the measured criterion cannot drift. That was previously
// maintained by copying, with a comment asking the copies not to diverge.
//
// WHAT IT WRITES. game_log.market_contamination_reason only. No
// market_*_ml, no bet_signals, nothing on the live path: the stored line
// still records what the model actually saw and logged bets keep the price
// they were logged at. Because no bet_signals field is touched, the
// post-lock immutability rule does not bind.
//
// IDEMPOTENT AND ADDITIVE. The UPDATE carries
// `AND market_contamination_reason IS NULL`, so a re-run cannot double-tag
// and cannot overwrite a weather reason or a hand-set value. UNDO is one
// statement, printed in the result:
//   UPDATE game_log SET market_contamination_reason = NULL
//    WHERE market_contamination_reason IN ('priced_post_first_pitch',
//                                          'no_prestart_capture');
//
// EXPECTED EFFECT AT REGISTRATION, measured on the 2026-09-13 prod snapshot
// so the operator sees it before the write rather than after:
//   266 games tagged priced_post_first_pitch (Jul 102, Aug 131, Sep 33)
//   0 games tagged no_prestart_capture
//   park_neutral_resolvable_979: 984 -> 772, which UN-ARMS that trigger
// The un-arming is the correct outcome, not a regression -- see the note on
// that precondition in services/feature-gate-registry.js.

const { registerBackfillTask } = require('../backfill-jobs');
const psp = require('../../utils/post-start-pricing');

registerBackfillTask({
  name: 'market_contamination_post_first_pitch',
  run: async function ({ db, q, params, dryRun, onProgress }) {
    const coverage = psp.captureCoverage(db);
    onProgress({ phase: 'coverage', capture_rows: coverage.rows,
      capture_games: coverage.games, from: coverage.from, to: coverage.to });

    if (!coverage.rows) {
      throw new Error('empirical_market_captures has no priced ml rows — the criterion '
        + 'has nothing to compare stored prices against, so it would report every '
        + 'exposed signal unmeasurable. Refusing to write.');
    }

    const exposed = psp.exposedMlSignals(db);
    const cls = psp.classifyExposed(db, exposed);
    const games = psp.gamesToTag(db, cls, coverage);

    const contaminated = [...games.contaminated];
    const noCapture = [...games.noCapture];
    const byMonth = {
      priced_post_first_pitch: psp.monthCounts(contaminated),
      no_prestart_capture: psp.monthCounts(noCapture),
      left_null_outside_coverage: psp.monthCounts([...games.outsideCoverage]),
    };

    const already = db.prepare(
      'SELECT COUNT(*) n FROM game_log WHERE market_contamination_reason IS NOT NULL').get().n;
    // How many of the target games ALREADY carry some reason, so the
    // idempotent UPDATE will skip them. Reported so "tagged 0" on a re-run
    // reads as idempotency rather than as a failure.
    const q1 = 'SELECT COUNT(*) n FROM game_log WHERE market_contamination_reason IS NOT NULL '
      + "AND (game_date || '|' || game_id) IN (";
    const targets = contaminated.concat(noCapture);
    const alreadyInTarget = targets.length
      ? db.prepare(q1 + targets.map(() => '?').join(',') + ')').get(...targets).n
      : 0;

    onProgress({ phase: 'classified', exposed: exposed.size, changed: cls.changed.length,
      no_change: cls.noChange.length, unmeasurable: cls.unmeasurable.length,
      to_tag_contaminated: contaminated.length, to_tag_no_capture: noCapture.length });

    const summary = {
      task: 'market_contamination_post_first_pitch',
      capture_coverage: coverage,
      classification: {
        exposed_ml_signals: exposed.size,
        price_changed_after_first_pitch: cls.changed.length,
        price_identical_noop: cls.noChange.length,
        unmeasurable: cls.unmeasurable.length,
      },
      would_tag: {
        priced_post_first_pitch: contaminated.length,
        no_prestart_capture: noCapture.length,
        left_null_outside_coverage: games.outsideCoverage.size,
      },
      by_month: byMonth,
      already_tagged_anywhere: already,
      already_tagged_among_targets: alreadyInTarget,
      undo: "UPDATE game_log SET market_contamination_reason = NULL WHERE "
        + "market_contamination_reason IN ('" + psp.REASON_PRICED_POST_FIRST_PITCH
        + "', '" + psp.REASON_NO_PRESTART_CAPTURE + "')",
    };

    if (dryRun) {
      summary.dry_run = true;
      summary.note =
        'Live run writes game_log.market_contamination_reason for the games above and '
        + 'nothing else. Idempotent (WHERE market_contamination_reason IS NULL), so a '
        + 're-run tags 0 and that is success. EXPECT park_neutral_resolvable_979 TO '
        + 'UN-ARM: measured 984 -> 772 against a bar of 979 on the 2026-09-13 snapshot. '
        + 'That trigger is currently armed on a count that includes games this criterion '
        + 'excludes, which is the looser count its own registry note warns against.';
      return summary;
    }

    const upd = db.prepare(
      'UPDATE game_log SET market_contamination_reason = ? '
      + 'WHERE game_date = ? AND game_id = ? AND market_contamination_reason IS NULL');
    let tagged = 0;
    const counts = { priced_post_first_pitch: 0, no_prestart_capture: 0 };
    const tx = db.transaction(() => {
      for (const pair of [[contaminated, psp.REASON_PRICED_POST_FIRST_PITCH],
                          [noCapture, psp.REASON_NO_PRESTART_CAPTURE]]) {
        for (const k of pair[0]) {
          const p = k.split('|');
          const ch = upd.run(pair[1], p[0], p[1]).changes;
          tagged += ch;
          counts[pair[1]] += ch;
        }
      }
    });
    tx();

    const after = db.prepare(
      'SELECT market_contamination_reason r, COUNT(*) n FROM game_log '
      + 'WHERE market_contamination_reason IS NOT NULL GROUP BY 1').all();

    summary.dry_run = false;
    summary.tagged_this_run = tagged;
    summary.tagged_by_reason = counts;
    summary.game_log_reasons_now = after;
    summary.verification = {
      expected_contaminated: contaminated.length,
      expected_no_capture: noCapture.length,
      skipped_already_tagged: alreadyInTarget,
      all_targets_accounted:
        tagged + alreadyInTarget === contaminated.length + noCapture.length,
    };
    return summary;
  },
});

module.exports = {
  REASONS: [psp.REASON_PRICED_POST_FIRST_PITCH, psp.REASON_NO_PRESTART_CAPTURE],
};
