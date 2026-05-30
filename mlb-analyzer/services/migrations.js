// One-shot data migrations. Schema migrations (table creation,
// ALTER TABLE) live in db/schema.js — that file runs CREATE TABLE IF
// NOT EXISTS and friends on every boot, which is naturally
// idempotent. This file is for ROW migrations (UPDATE / DELETE on
// existing data) where re-running could corrupt rows (e.g. dividing
// an already-decimal column by 100 twice would push it to 1e-4).
//
// Idempotency model:
//   * A 'migrations_applied' table records (name, applied_at) for
//     each migration that has run to completion.
//   * Each migration is a { name, description, sql } object. `sql` is
//     a single string passed to db.exec(); it may contain multiple
//     statements separated by ';'. The whole block is wrapped in a
//     transaction so a partial failure rolls back the row writes AND
//     the migrations_applied insert — a retry on the next boot finds
//     no record and re-runs.
//   * Order matters. Migrations run top-to-bottom of MIGRATIONS;
//     append new ones at the bottom, never reorder or rename existing
//     entries (renaming would re-trigger a completed migration).

'use strict';

// IMPORTANT: never edit an existing migration's `name` or `sql` after
// it has shipped. Add NEW entries at the bottom.
const MIGRATIONS = [
  {
    name: 'v5-normalize-001',
    description:
      'Normalize legacy v5 bet_signals rows: re-tag continuous-edge '
      + 'rows mis-stamped as v5 to v6, strip the "Nstar-" prefix from '
      + 'v5 categories so direction-only filters work, and divide v5 '
      + 'ML edge_pct values >= 1 (stored as integer percent in the '
      + 'star-tier era) by 100 so they land on the same decimal-pp '
      + 'scale every other row uses. Op 3 filter "edge_pct >= 1" is '
      + 'the critical safety guard — if this migration is somehow '
      + 'rerun on the same rows, the (>= 1) filter would no longer '
      + 'match anything (the divided rows are all < 1 by definition).',
    sql:
      // Op 1: re-tag mis-tagged continuous-edge rows as v6. These are
      // rows whose category is direction-only ('fav'|'dog'|'over'|
      // 'under') — emitted by the post-cutover signal-write path but
      // accidentally stamped v5 (the cohort ternary in jobs.js was off
      // before c32462c).
      "UPDATE bet_signals "
      + "SET cohort = 'v6' "
      + "WHERE cohort = 'v5' AND category NOT LIKE '%star%';\n"

      // Op 2: normalize v5 prefixed categories to direction-only. The
      // pre-cutover schema stored '<Nstar>-<dir>' (e.g. '2star-fav');
      // the bucket UI in c32462c expects bare direction values.
      + "UPDATE bet_signals "
      + "SET category = CASE "
      + "  WHEN category LIKE '%-fav'   THEN 'fav' "
      + "  WHEN category LIKE '%-dog'   THEN 'dog' "
      + "  WHEN category LIKE '%-over'  THEN 'over' "
      + "  WHEN category LIKE '%-under' THEN 'under' "
      + "  ELSE category "
      + "END "
      + "WHERE cohort = 'v5' AND category LIKE '%star%';\n"

      // Op 3: convert v5 ML edge_pct from integer-percent to decimal.
      // The pre-cutover ML write path stored edge_pct as Math.round
      // (mlEdge(...))  — an American-cents distance reported as a
      // small integer. Post-cutover ML rows store the raw probability-
      // edge as a 4-decimal float. The (edge_pct >= 1) filter is the
      // safety guard: every post-cutover decimal-pp value is < 1, so
      // even an accidental rerun would match zero rows.
      + "UPDATE bet_signals "
      + "SET edge_pct = edge_pct / 100.0 "
      + "WHERE cohort = 'v5' AND signal_type = 'ML' AND edge_pct >= 1;\n",
  },
];

// Ensure the bookkeeping table exists. Schema:
//   name        text primary key  — migration identifier
//   applied_at  text not null    — datetime('now') at successful apply
// We CREATE TABLE IF NOT EXISTS rather than relying on db/schema.js so
// this module is self-contained and can be required from a fresh DB.
function ensureMigrationsTable(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations_applied ("
    + "  name TEXT PRIMARY KEY,"
    + "  applied_at TEXT NOT NULL"
    + ");"
  );
}

function isApplied(db, name) {
  const row = db.prepare(
    "SELECT 1 AS x FROM migrations_applied WHERE name = ?"
  ).get(name);
  return !!row;
}

function applyOne(db, m) {
  // Wrap UPDATEs + the bookkeeping insert in a single transaction.
  // A throw inside the transaction callback rolls back EVERYTHING —
  // including the migrations_applied row — so a retry next boot
  // re-enters this branch cleanly.
  const tx = db.transaction(() => {
    db.exec(m.sql);
    db.prepare(
      "INSERT INTO migrations_applied (name, applied_at) "
      + "VALUES (?, datetime('now'))"
    ).run(m.name);
  });
  tx();
}

// Run every pending migration in declaration order. Synchronous —
// callers can rely on the row state being normalized by the time
// this returns. Throws on any failure (bookkeeping-table creation,
// SQL error inside a migration) so the caller can decide whether to
// continue booting or abort.
function applyPendingMigrations(db) {
  try {
    ensureMigrationsTable(db);
  } catch (e) {
    // The brief: if migrations_applied creation fails, abort entirely.
    console.error('[migration] FATAL: could not create migrations_applied table — ' + e.message);
    throw e;
  }
  for (const m of MIGRATIONS) {
    if (isApplied(db, m.name)) {
      console.log('[migration] ' + m.name + ' already applied, skipping');
      continue;
    }
    console.log('[migration] applying ' + m.name);
    try {
      applyOne(db, m);
      console.log('[migration] applied ' + m.name + ' successfully');
    } catch (e) {
      console.error('[migration] FAILED ' + m.name + ': ' + e.message
        + ' — transaction rolled back; will retry on next boot');
      throw e;
    }
  }
}

module.exports = {
  applyPendingMigrations,
  // Exported for the validation harness; not for runtime use.
  MIGRATIONS,
};
