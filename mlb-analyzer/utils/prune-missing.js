'use strict';
/**
 * Delete-missing for upsert-per-entity ingest tables. (2026-08-24)
 *
 * THE PROBLEM IT SOLVES. A job that upserts whatever its source returns
 * and deletes nothing leaves dropped entities frozen forever. On
 * 2026-08-24 seven of sixty-six `catcher_framing` rows dated 2026-06-03 or
 * 2026-05-21, and because they still cleared the 750-pitch floor on those
 * FROZEN counts, `computeFramingRvPerGame` preferred them to the
 * three-year historical baseline. T. d'Arnaud started for LAA that day
 * priced on a 2026-05-21 rate. A stale current-season value outranking a
 * real historical one is the worst ordering available.
 *
 * THE PROBLEM IT CREATES, WHICH IS WORSE. Delete-missing is trivially
 * catastrophic: a truncated response, a parser that returns [] on an
 * unexpected header, an upstream outage serving a stub — any of those and
 * a naive implementation empties the table. Every consumer then falls
 * through to its fallback (for framing, the 2023-25 baseline at x0.80) or
 * to no adjustment at all, and NOTHING REPORTS IT, because an empty table
 * and a table of legitimately-absent entities look identical downstream.
 *
 * So the guard is the point of this module, not the delete:
 *
 *   1. at least MIN_ROWS entities in the fetch, and
 *   2. the fetch is at least HALF_OF the existing row count.
 *
 * Refusing to prune is ALWAYS safe — the worst case is the stale rows
 * that were already there. Pruning on a bad fetch is not recoverable
 * within the run. When the two disagree, refuse.
 *
 * WHY THIS IS A MODULE AND NOT INLINE. It was inline first. Inline meant
 * the guard could only be exercised by triggering a real bad fetch from
 * Savant, which is to say never. Lifting it out makes the refusal path
 * testable against synthetic inputs (scripts/test-prune-missing.js) and
 * keeps ONE implementation — the job calls exactly what the test calls.
 *
 * NOT USED FOR fielding_frv, deliberately. Same never-deletes shape, but
 * FRV is a trailing THREE-SEASON aggregate: a fielder who drops off the
 * leaderboard still has a valid value, unlike a stale partial-season
 * framing rate. Decided 2026-08-24; the per-row freshness check reports
 * it at 21/60 thresholds instead.
 */

const DEFAULTS = {
  minRows: 40,        // an absolute floor: fewer than this is not a leaderboard
  minFraction: 0.5,   // and it must be at least half of what we already hold
};

/**
 * Decide whether a fetch is trustworthy enough to prune against.
 * Pure — no DB, no I/O — so every branch is reachable from a test.
 *
 * @param fetchedCount   distinct ids in the fetch
 * @param existingCount  rows currently in the table
 * @returns {{ok: boolean, reason: string}}
 */
function shouldPrune(fetchedCount, existingCount, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const f = Number(fetchedCount), e = Number(existingCount);

  if (!isFinite(f) || f < 0) {
    return { ok: false, reason: 'fetched count is not a number (' + fetchedCount + ')' };
  }
  if (f < o.minRows) {
    return { ok: false, reason: 'fetch returned ' + f + ' ids, below the absolute floor of '
      + o.minRows + ' — that is a bad fetch, not a roster change' };
  }
  // A first-ever run has nothing to prune, and dividing by zero would let
  // any fetch through. Explicit rather than incidental.
  if (!isFinite(e) || e <= 0) {
    return { ok: true, reason: 'table is empty; nothing to prune' };
  }
  if (f < e * o.minFraction) {
    return { ok: false, reason: 'fetch returned ' + f + ' ids against ' + e
      + ' existing rows (< ' + Math.round(o.minFraction * 100) + '%) — that is a truncated fetch,'
      + ' not a roster change' };
  }
  return { ok: true, reason: 'fetch looks like a full leaderboard (' + f + ' vs ' + e + ')' };
}

/**
 * Apply the guard and, if it passes, delete rows whose id is absent from
 * the fetch. Takes a db handle rather than using the shared one so a test
 * can point it at a scratch copy.
 *
 * Deleting does not destroy the record where a snapshot table exists —
 * catcher_framing_snapshot archives every fetched row by snapshot_date, so
 * a pruned entity's last observed value stays queryable at the date it was
 * last seen. It simply stops being read as current.
 *
 * @param db          better-sqlite3 handle (writable)
 * @param table       table name (trusted, from calling code — never user input)
 * @param idColumn    primary id column
 * @param fetchedIds  iterable of ids present in the fetch
 * @param opts        {minRows, minFraction, nameColumn}
 * @returns {{pruned, prunedRows, skipped, reason, before, fetchedCount}}
 */
function pruneMissing(db, table, idColumn, fetchedIds, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const nameCol = o.nameColumn || 'name';
  const ids = new Set();
  for (const id of (fetchedIds || [])) if (id != null) ids.add(id);

  const before = db.prepare('SELECT COUNT(*) c FROM ' + table).get().c;
  const verdict = shouldPrune(ids.size, before, o);
  if (!verdict.ok) {
    return { pruned: 0, prunedRows: [], skipped: true, reason: verdict.reason,
             before, fetchedCount: ids.size };
  }

  const existing = db.prepare('SELECT ' + idColumn + ' AS id, ' + nameCol + ' AS name FROM ' + table).all();
  const doomed = existing.filter(r => !ids.has(r.id));
  if (doomed.length) {
    const del = db.prepare('DELETE FROM ' + table + ' WHERE ' + idColumn + ' = ?');
    db.transaction((rs) => { for (const r of rs) del.run(r.id); })(doomed);
  }
  return { pruned: doomed.length, prunedRows: doomed, skipped: false,
           reason: verdict.reason, before, fetchedCount: ids.size };
}

module.exports = { shouldPrune, pruneMissing, DEFAULTS };
