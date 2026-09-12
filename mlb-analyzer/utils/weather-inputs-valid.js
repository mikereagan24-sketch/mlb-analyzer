// Single definition of the weather_inputs_valid predicate (2026-09-12).
//
// THREE consumers need this rule and none of them may re-spell it:
//   db/schema.js                        boot-time backfill of NULL rows
//   scripts/set-weather-inputs-valid.js explicit backfill + assertions
//   docs/weather-inputs-valid-2026-09-12.md   the written record
// A second literal is how this kind of thing drifts; the repo has already
// paid for that twice (FRV_MIN_OUTS, and the three hand-maintained key
// lists that failed open).
//
// WHAT THE FLAG MEANS: 1 = the persisted wind_*/temp_f/wind_factor/
// temp_run_adj in this row were produced by a park-local-hour-correct,
// correct-coordinates path, so a harness that RE-SCORES from these columns
// can trust them. It is NOT "the emit-time price was clean" — that is
// weather_contamination_reason. db/schema.js documents both senses.
//
// THE BOUNDARY IS OBSERVABLE, not a remembered date. weather_quality_at
// records when a row's weather columns were last written, and every write
// at or after the season backfill's first came from the park-local-hour
// path, because that path landed 2026-07-29/30 — before the backfill ran.
//
// ZONES, because this schema mixes them and the comparison fails silently
// (CLAUDE.md timestamp rule):
//   game_log.weather_quality_at   UTC  (SQL datetime('now'))
//   backfill_jobs.started_at      PT   (nowPtIso)
// The backfill's PT start 2026-08-05 16:21:36 is 23:21:36Z; its first
// weather write is 2026-08-05 23:22:25Z, one minute later — the a-priori
// ordering that confirms the reading. The 7-hour window where the two
// readings disagree contains 0 rows, so nothing here depended on getting
// it right, but the next such comparison might.
//
// BOUNDARY_UTC is sited in MEASURED EMPTY SPACE: last pre-backfill write
// 2026-08-03 00:00:37Z, first backfill write 2026-08-05 23:22:25Z, and the
// 2.97-day gap between them holds zero rows. assertGapEmpty() re-checks
// that, so a future row landing in the gap fails loudly instead of being
// classified by a stale constant.

const BOUNDARY_UTC = '2026-08-05 23:00:00';   // mid-gap
const GAP_LO_UTC   = '2026-08-03 00:00:37';   // last pre-backfill write
const GAP_HI_UTC   = '2026-08-05 23:22:25';   // first backfill write

// SQL predicate over game_log. No bound parameters so it can be inlined
// into the boot migration and into aggregate reporting alike.
const VALID_SQL =
  "(temp_f IS NOT NULL AND weather_quality_at IS NOT NULL AND weather_quality_at >= '"
  + BOUNDARY_UTC + "')";

// Throws if the boundary constant is no longer sited in empty space.
function assertGapEmpty(db) {
  const n = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE weather_quality_at > ? AND weather_quality_at < ?'
  ).get(GAP_LO_UTC, GAP_HI_UTC).n;
  if (n !== 0) {
    throw new Error('weather_inputs_valid boundary no longer in empty space: ' + n
      + ' row(s) have weather_quality_at between ' + GAP_LO_UTC + 'Z and ' + GAP_HI_UTC
      + 'Z, which the constant cannot classify. Re-measure the gap.');
  }
  return n;
}

// Classify only rows that have no verdict yet. Idempotent by construction,
// so it is a no-op on every boot after the first, and it never overwrites a
// value written at ingest time by q.updateWindData.
function backfillNullFlags(db) {
  const before = db.prepare(
    'SELECT COUNT(*) n FROM game_log WHERE weather_inputs_valid IS NULL').get().n;
  if (!before) return { scanned: 0, valid: 0, invalid: 0 };
  const v = db.prepare('UPDATE game_log SET weather_inputs_valid = 1 WHERE weather_inputs_valid IS NULL AND '
    + VALID_SQL).run();
  const i = db.prepare('UPDATE game_log SET weather_inputs_valid = 0 WHERE weather_inputs_valid IS NULL').run();
  return { scanned: before, valid: v.changes, invalid: i.changes };
}

// The class mapping, asserted rather than assumed. Each entry was verified
// per row by scripts/verify-weather-inputs-valid.js: 17/18 sampled
// naive_hour rows reproduce the archive value at the park-local hour to
// 0.00F and 0/18 match the naive ET hour, while sampled ath_* rows match
// neither their current park nor a clean derivation.
const CLASS_ASSERTIONS = [
  ['every naive_hour row is VALID (corrected 2026-08-05/06)',
    "weather_contamination_reason LIKE '%naive_hour%' AND NOT " + VALID_SQL],
  ['every ath_* row is INVALID (restored from pre-fix snapshot)',
    "weather_contamination_reason LIKE 'ath_%' AND " + VALID_SQL],
  ['every ari_roof_* row is VALID (recomputed under actual roof)',
    "weather_contamination_reason LIKE 'ari_roof_%' AND NOT " + VALID_SQL],
  ['no row with NULL temp_f is VALID', 'temp_f IS NULL AND ' + VALID_SQL],
];

module.exports = {
  BOUNDARY_UTC, GAP_LO_UTC, GAP_HI_UTC, VALID_SQL,
  assertGapEmpty, backfillNullFlags, CLASS_ASSERTIONS,
};
