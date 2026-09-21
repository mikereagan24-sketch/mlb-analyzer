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
  {
    name: 'v5-ml-edge-pct-recompute-001',
    description:
      'Recompute v5 ML edge_pct from market_line + model_line using '
      + 'the v6 probability-point formula '
      + '(MAX(0, impliedP(model) - impliedP(market))). Migration 001 '
      + 'divided v5 ML edge_pct by 100 under the false assumption that '
      + 'the original integers were percentage-points; they were '
      + 'actually the legacy mlEdge() American-cents distance, so the '
      + 'divided values bucket every v5 ML row into the 9.5-10.0+pp '
      + 'top bucket (a 30-cent distance becomes 0.30, which trips the '
      + 'last bucket\'s 10pp clamp). market_line + model_line are '
      + 'authoritative and intact; recomputing from them lands every '
      + 'row on the correct decimal-pp axis. This migration is '
      + 'naturally idempotent — the recompute is deterministic from '
      + 'the same inputs — but the migrations_applied gate is still '
      + 'used for consistency + audit. cohort=v5 filter scopes the '
      + 'change away from continuous-edge v6 rows that already carry '
      + 'correct decimal pp values.',
    sql:
      "UPDATE bet_signals "
      + "SET edge_pct = MAX(0, "
      + "  CASE "
      + "    WHEN model_line IS NULL OR model_line = 0 THEN 0.5 "
      + "    WHEN model_line < 0 THEN ABS(model_line) * 1.0 / (ABS(model_line) + 100) "
      + "    ELSE 100.0 / (model_line + 100) "
      + "  END "
      + "  - "
      + "  CASE "
      + "    WHEN market_line IS NULL OR market_line = 0 THEN 0.5 "
      + "    WHEN market_line < 0 THEN ABS(market_line) * 1.0 / (ABS(market_line) + 100) "
      + "    ELSE 100.0 / (market_line + 100) "
      + "  END "
      + ") "
      + "WHERE cohort = 'v5' AND signal_type = 'ML';\n",
  },
  {
    name: 'kalshi-anchor-total-backfill-001',
    description:
      'Seed game_log.kalshi_anchor_total (added 2026-09-17) from the rows '
      + 'where Kalshi is still the recorded totals source. The column is the '
      + 'Kalshi rung both rung anchors now read, replacing the inference from '
      + 'total_source that a Poly-priced pass erased. Without this backfill '
      + 'every row written before the column existed has a NULL anchor, so '
      + 'the first Kalshi-silent pass on an in-flight slate would fall to '
      + 'liquidity exactly as before. Rows whose totals came from Poly get '
      + 'nothing -- their Kalshi rung is genuinely unknown, and inventing one '
      + 'from market_total would record a Poly strike as a Kalshi anchor. '
      + 'Idempotent twice over: the IS NULL filter cannot match a row it '
      + 'already filled, and the migrations_applied gate stops a rerun.',
    sql:
      "UPDATE game_log "
      + "SET kalshi_anchor_total = market_total "
      + "WHERE kalshi_anchor_total IS NULL "
      + "  AND total_source = 'kalshi' "
      + "  AND market_total IS NOT NULL;\n",
  },
  {
    name: 'v6-mojibake-repair-001',
    description:
      'Repair April-2026 double-decode damage in three columns. UTF-8 read '
      + 'as Latin-1 turned U+2605 (star, E2 98 85) into three characters '
      + 'and U+2014 (em dash, E2 80 94) into six. Found by '
      + 'scripts/probe-mojibake-scan.js, which sweeps every TEXT column in '
      + 'the DB: 30 distinct damaged values over 57 rows, ALL of them in '
      + '2026-04. Zero damaged rows in 2026-05..09 against ~51,000 clean '
      + 'ones, so the path that produced them is dead and this is a '
      + 'one-off repair, not a symptom of a live writer. '
      + 'Idempotent by construction: every filter matches only the damaged '
      + 'sequence, which cannot survive its own replacement, and the '
      + 'migrations_applied gate stops a rerun regardless. '
      + 'NOT repaired, deliberately: pitcher_woba_override.reason (2 rows) '
      + 'carries U+FFFD, so the bytes are already gone and no '
      + 'deterministic inverse exists; and the 2 rows with '
      + 'signal_label = unrated are left alone, because NULLing them would '
      + 'move them out of the star era into the continuous-edge era where '
      + 'the emit thresholds would then apply. Both are recorded in '
      + 'docs/mojibake-star-labels-open-question-2026-09-17.md. '
      + 'LOCKED ROWS ARE SKIPPED, not carved out. signal_label is not on '
      + 'the whitelist of fields that may flow once a lock is set, and 5 '
      + 'of the 6 label rows carry bet_locked_at. An earlier draft of '
      + 'this migration repaired them anyway under an owner-authorised '
      + 'carve-out; that was the wrong trade. The whitelist exists so '
      + 'that authorisation does NOT bypass it -- a carve-out granted '
      + 'once is a precedent for the next writer that wants one, and '
      + 'five garbled historical labels cost less than that. So ops 0 '
      + 'and 1 filter on BOTH locks named by the rule: bet_locked_at on '
      + 'the signal, and odds_locked_at on its game_log row. The latter '
      + 'is NULL for all six on the analysis copy and is included '
      + 'anyway, because that copy is not production. '
      + 'Ops 2 and 3 need no such filter: bet_signals.notes IS on the '
      + 'post-lock whitelist, and bet_signal_audit is an append-only '
      + 'trail the rule does not govern. '
      + 'Consequence, stated rather than hidden: 5 labels stay damaged '
      + 'and render as legacy rows that never highlight, which is '
      + 'exactly what they did before this migration.',
    sql:
      // Op 0: audit FIRST, while the damaged rows are still identifiable.
      // After op 1 the filter cannot match them, which is also what makes
      // a rerun insert nothing.
      "INSERT INTO bet_signal_audit "
      + "(signal_id, game_date, game_id, action, source, detail, created_at) "
      + "SELECT id, game_date, game_id, 'label_repaired', "
      + "       'v6-mojibake-repair-001', "
      + "       'signal_label double-decode repaired: ' || signal_label "
      + "       || ' -> ' || substr(signal_label, 1, 1) || '★', "
      + "       datetime('now') "
      + "FROM bet_signals "
      + "WHERE signal_label LIKE '_â' "
      + "  AND substr(signal_label, 1, 1) IN ('1','2','3') "
      + "  AND bet_locked_at IS NULL "
      + "  AND NOT EXISTS (SELECT 1 FROM game_log g "
      + "                  WHERE g.game_date = bet_signals.game_date "
      + "                    AND g.game_id = bet_signals.game_id "
      + "                    AND g.odds_locked_at IS NOT NULL);\n"

      // Op 1: the star labels on UNLOCKED rows only. The leading digit
      // survived the mangling, so the target is unambiguous: '2' + E2 98
      // 85 was '2*'. The two lock predicates must match op 0 exactly, or
      // the audit trail would claim a repair that did not happen.
      + "UPDATE bet_signals "
      + "SET signal_label = substr(signal_label, 1, 1) || '★' "
      + "WHERE signal_label LIKE '_â' "
      + "  AND substr(signal_label, 1, 1) IN ('1','2','3') "
      + "  AND bet_locked_at IS NULL "
      + "  AND NOT EXISTS (SELECT 1 FROM game_log g "
      + "                  WHERE g.game_date = bet_signals.game_date "
      + "                    AND g.game_id = bet_signals.game_id "
      + "                    AND g.odds_locked_at IS NOT NULL);\n"

      // Op 2: the em dash in the deactivation note. bet_signals.notes IS
      // on the post-lock whitelist, so these need no carve-out.
      + "UPDATE bet_signals "
      + "SET notes = replace(notes, 'Ã¢ÂÂ', '—') "
      + "WHERE notes LIKE '%Ã¢ÂÂ%';\n"

      // Op 3: the same sequence in the audit trail.
      + "UPDATE bet_signal_audit "
      + "SET detail = replace(detail, 'Ã¢ÂÂ', '—') "
      + "WHERE detail LIKE '%Ã¢ÂÂ%';\n",
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
