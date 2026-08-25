#!/usr/bin/env node
/**
 * Tag every game_log row with the park-factor regime it was scored under.
 * (2026-08-25).  Dry run by default; --apply to write.
 *
 * WHY. `park_factor` is persisted at scrape time and post-lock immutable,
 * so the 2026-08-25 switch to Savant `index_runs` does NOT reach existing
 * rows. Every corpus-wide analysis therefore crosses a **park-factor
 * regime boundary** — the same class of thing as the v6/v7 cohort split,
 * and a bigger discontinuity than either contamination class: 24 of 30
 * teams changed, by up to 0.17.
 *
 * Without a marker the only way to know which side a row sits on is to
 * remember the date. This repo has a bad record with remembered filters,
 * which is why the contamination reasons are columns and not a convention.
 *
 * CLASSIFIED BY COMPARISON, NOT BY DATE. The stored value is checked
 * against both the legacy table and the current one. That is directly
 * observable; a date would be a proxy for *when the row was scraped*,
 * which is not recorded anywhere. Rows for future games scraped before the
 * cutover carry legacy values despite a later game_date, so the date proxy
 * would mislabel exactly the rows most likely to matter.
 *
 * Values written:
 *   legacy_unsourced          matches the pre-2026-08-25 table only. Those
 *                             values matched no source that could be pulled
 *                             (FanGraphs 3yr 4/30, Savant R 6/30).
 *   savant_index_runs         matches the current table only.
 *   unchanged_either_regime   the two tables agree for this team, so the
 *                             row is identical under both and the boundary
 *                             does not apply to it.
 *   venue_override            a date-scoped or venue-id override supplied
 *                             the factor; neither table was consulted.
 *   NULL                      no park_factor at all.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: !APPLY });

// The table as it stood from 2026-04-19 to 2026-08-25. Frozen here on
// purpose: it is the only remaining record of what those rows were scored
// under, and it is no longer in the source tree.
const LEGACY = {
  COL: 1.25, ARI: 1.10, CIN: 1.10, CHC: 1.08, NYY: 1.07, BOS: 1.06,
  PHI: 1.05, ATL: 1.04, CWS: 1.03, TEX: 1.03, WAS: 1.02, TOR: 1.02,
  KC: 1.02,  MIA: 1.01, LAD: 1.00, HOU: 1.00, STL: 0.99, DET: 0.98,
  TB: 0.95,  MIN: 0.97, PIT: 0.97, LAA: 0.97, MIL: 0.96, BAL: 0.96,
  CLE: 0.95, SEA: 0.95, NYM: 0.94, SD: 0.94,  SF: 0.92,  ATH: 1.19,
};
const EPS = 0.0005;

(function main() {
  const current = {};
  for (const r of db.prepare('SELECT team, factor FROM park_factors').all()) current[r.team] = r.factor;
  if (!Object.keys(current).length) {
    console.error('park_factors is EMPTY — run runParkFactorsJob first, or this '
      + 'would tag every row as legacy.');
    process.exit(1);
  }

  const rows = db.prepare(
    'SELECT game_date, game_id, home_team, venue_id, park_factor FROM game_log').all();

  const counts = {};
  const updates = [];
  for (const r of rows) {
    const team = String(r.home_team || '').toUpperCase();
    let label;
    if (r.park_factor == null) {
      label = null;
    } else {
      const cur = current[team], leg = LEGACY[team];
      const mCur = cur != null && Math.abs(r.park_factor - cur) < EPS;
      const mLeg = leg != null && Math.abs(r.park_factor - leg) < EPS;
      if (mCur && mLeg)      label = 'unchanged_either_regime';
      else if (mCur)         label = 'savant_index_runs';
      else if (mLeg)         label = 'legacy_unsourced';
      else                   label = 'venue_override';
    }
    counts[String(label)] = (counts[String(label)] || 0) + 1;
    updates.push({ d: r.game_date, g: r.game_id, label });
  }

  console.log('=== park-factor regime tagging ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  game_log rows: ' + rows.length);
  console.log('');
  for (const k of Object.keys(counts).sort()) {
    console.log('  ' + String(k).padEnd(26) + String(counts[k]).padStart(5));
  }
  console.log('');
  // The boundary only bites where the two regimes disagree. Saying so
  // keeps the number honest: 429 rows are unaffected because their team's
  // factor did not move.
  const affected = counts['legacy_unsourced'] || 0;
  console.log('  Rows where the boundary MATTERS (legacy value differs from current): '
    + affected + ' of ' + rows.length);

  if (!APPLY) { console.log(''); console.log('  DRY RUN — pass --apply to write.'); return; }

  const upd = db.prepare(
    'UPDATE game_log SET park_factor_source=? WHERE game_date=? AND game_id=?');
  db.transaction((us) => { for (const u of us) upd.run(u.label, u.d, u.g); })(updates);

  console.log('');
  console.log('=== verification ===');
  for (const r of db.prepare(
    'SELECT park_factor_source s, COUNT(*) n FROM game_log GROUP BY s ORDER BY s').all()) {
    console.log('  ' + String(r.s).padEnd(26) + String(r.n).padStart(5));
  }
  const untagged = db.prepare(
    'SELECT COUNT(*) c FROM game_log WHERE park_factor IS NOT NULL AND park_factor_source IS NULL'
  ).get().c;
  console.log('  rows with a factor but no source (must be 0): ' + untagged);
})();
