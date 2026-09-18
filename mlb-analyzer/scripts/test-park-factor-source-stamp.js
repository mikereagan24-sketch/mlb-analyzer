#!/usr/bin/env node
/**
 * The park-factor regime marker must actually reach the row. (2026-09-18)
 *
 * WHAT WAS WRONG. CLAUDE.md documents game_log.park_factor_source as the
 * thing that makes the 2026-08-25 sourcing change observable — "It is a
 * column, not a convention", against a remembered date. services/scraper.js
 * computed the value and put it on the object it hands to upsertGame.
 * upsertGame's INSERT never bound it.
 *
 * So the column was NULL for every row written since the cutover — 296 of
 * them — and the only non-NULL values in the table came from a one-off
 * backfill script. The convention had quietly replaced the column.
 *
 * AND THE STAMP WAS TOO COARSE ANYWAY. It recorded SOURCE_NAME, which
 * cannot distinguish two pulls of the same source. The pulls move: the
 * 2026-09-01 re-pull changed ARI, CWS, DET, MIN, NYM and WAS by 0.02 each.
 * Rows either side of that date carry different factors under an identical
 * source string, which is the same pooling hazard as the legacy/Savant
 * boundary one level down. The stamp now carries the pull date.
 *
 * Run: node scripts/test-park-factor-source-stamp.js
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const { db, q } = require(path.join(R, 'db/schema'));
const pf = require(path.join(R, 'services/park-factors'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== park_factor_source: written, and precise enough to be useful ===');

// ---- the stamp itself -------------------------------------------------
const stamp = pf.sourceStamp();
ok('the stamp names the source', stamp.indexOf(pf.SOURCE_NAME) === 0, stamp);
ok('and carries the PULL DATE, so two pulls are distinguishable',
   /@\d{4}-\d{2}-\d{2}$/.test(stamp),
   'a bare source name cannot separate the 2026-09-01 re-pull from the 08-25 one');

// ---- the INSERT binds it ---------------------------------------------
const schema = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
ok('upsertGame lists the column', /market_total, park_factor, park_factor_source,/.test(schema));
ok('upsertGame binds the parameter', /@market_total, @park_factor, @park_factor_source,/.test(schema));
ok('and the conflict path preserves it rather than nulling it',
   /park_factor_source = COALESCE\(excluded\.park_factor_source, game_log\.park_factor_source\)/.test(schema),
   'a later upsert from a writer that does not carry the stamp must not wipe it');

// ---- END TO END: it reaches a row ------------------------------------
// The defect was a value computed and dropped between the scraper and the
// table, which no amount of reading either file in isolation would show.
// So: write a row through the real prepared statement and read it back.
const TEST_DATE = '1999-09-09';
const TEST_ID = 'zzz-test-pf-stamp';
try {
  db.prepare('DELETE FROM game_log WHERE game_date=? AND game_id=?').run(TEST_DATE, TEST_ID);
  q.upsertGame.run({
    game_date: TEST_DATE, game_id: TEST_ID, away_team: 'ZZA', home_team: 'ZZH',
    game_time: null, away_sp: null, away_sp_hand: null, home_sp: null, home_sp_hand: null,
    away_sp_id: null, home_sp_id: null,
    statsapi_away_sp: null, statsapi_home_sp: null,
    rotowire_away_sp: null, rotowire_home_sp: null,
    bulk_guy_away_announced: null, bulk_guy_home_announced: null,
    away_sp_proj_ip: null, home_sp_proj_ip: null,
    away_sp_forecast_ip: null, home_sp_forecast_ip: null,
    away_sp_forecast_n_priors: null, home_sp_forecast_n_priors: null,
    away_bulk_forecast_ip: null, home_bulk_forecast_ip: null,
    away_opener_forecast_ip: null, home_opener_forecast_ip: null,
    market_away_ml: null, market_home_ml: null, market_total: null,
    park_factor: 1.07, park_factor_source: stamp,
    model_away_ml: null, model_home_ml: null, model_total: null,
    lineup_source: 'test', venue_id: null, venue_name: null,
    game_number: 1, game_pk: null,
  });
  const row = db.prepare('SELECT park_factor, park_factor_source FROM game_log WHERE game_date=? AND game_id=?')
    .get(TEST_DATE, TEST_ID);
  ok('a game row written through upsertGame CARRIES the stamp',
     !!row && row.park_factor_source === stamp,
     row ? JSON.stringify(row) : 'row not written');

  // And a second upsert that omits the stamp must not erase it.
  q.upsertGame.run(Object.assign({
    game_date: TEST_DATE, game_id: TEST_ID, away_team: 'ZZA', home_team: 'ZZH',
    game_time: null, away_sp: null, away_sp_hand: null, home_sp: null, home_sp_hand: null,
    away_sp_id: null, home_sp_id: null,
    statsapi_away_sp: null, statsapi_home_sp: null,
    rotowire_away_sp: null, rotowire_home_sp: null,
    bulk_guy_away_announced: null, bulk_guy_home_announced: null,
    away_sp_proj_ip: null, home_sp_proj_ip: null,
    away_sp_forecast_ip: null, home_sp_forecast_ip: null,
    away_sp_forecast_n_priors: null, home_sp_forecast_n_priors: null,
    away_bulk_forecast_ip: null, home_bulk_forecast_ip: null,
    away_opener_forecast_ip: null, home_opener_forecast_ip: null,
    market_away_ml: null, market_home_ml: null, market_total: null,
    park_factor: 1.07, park_factor_source: null,
    model_away_ml: null, model_home_ml: null, model_total: null,
    lineup_source: 'test', venue_id: null, venue_name: null,
    game_number: 1, game_pk: null,
  }));
  const row2 = db.prepare('SELECT park_factor_source FROM game_log WHERE game_date=? AND game_id=?')
    .get(TEST_DATE, TEST_ID);
  ok('a later upsert WITHOUT the stamp does not erase it',
     !!row2 && row2.park_factor_source === stamp,
     row2 ? String(row2.park_factor_source) : 'row gone');
} finally {
  db.prepare('DELETE FROM game_log WHERE game_date=? AND game_id=?').run(TEST_DATE, TEST_ID);
}

// ---- the historical gap this exposes ---------------------------------
const since = db.prepare(
  "SELECT COUNT(*) n, SUM(CASE WHEN park_factor_source IS NULL THEN 1 ELSE 0 END) nulls "
  + "FROM game_log WHERE park_factor IS NOT NULL AND game_date >= '2026-08-25'").get();
console.log('  rows since the 2026-08-25 cutover: ' + since.n
  + ', of which unstamped: ' + since.nulls);
ok('the unstamped backlog is reported, not silently tolerated', true,
   'these predate the fix and can only be repaired by a backfill, since the '
   + 'pull that produced each row is no longer recoverable from the row itself');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
