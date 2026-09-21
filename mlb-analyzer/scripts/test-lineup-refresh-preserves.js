// A lineup refresh must not discard the rest of the row.
//
// THE INCIDENT (2026-09-16): a manual Pull Weather at 10:09 was wiped by
// the lineup pull at 10:14, leaving temp_f NULL on 15 games. Lineup
// pulls fire ten times a day (8AM, 10AM, Noon, 1-6PM, 11PM PT) and only
// some of them are followed by a weather job, so the slate could sit
// un-weathered through the pricing window.
//
// THE MECHANISM, which is worse than "weather is not in the payload":
//
//   services/jobs.js  DELETE FROM game_log WHERE game_date=? AND away_score IS NULL
//   services/jobs.js  const existingRow = q.getGameById.get(dateStr, g.game_id)
//
// The read happened AFTER the delete, so `existingRow` was undefined for
// every unplayed game. That defeated two protections at once:
//
//   A. 124 of game_log's 165 columns are not named by q.upsertGame's
//      INSERT at all, so a fresh insert leaves them NULL. Weather is
//      here: temp_f, wind_speed, wind_dir, wind_factor, temp_run_adj,
//      roof_status, roof_confidence, weather_quality, weather_quality_at,
//      weather_inputs_valid -- 99-100% populated before a refresh.
//
//   B. 11 more ARE in the payload, supplied as
//      `existingRow ? existingRow.x : <default>`, so they look preserved
//      in the source while always taking the default. park_factor is the
//      dangerous one: it reset to 1.0, a plausible value rather than an
//      obviously-missing one.
//
//   Every COALESCE and CASE guard in upsertGame's ON CONFLICT clause
//   protects the UPDATE path only. A fresh INSERT never reaches them.
//
// THE FIX preserves the row, and the existing code then does what it
// already claimed to: the ON CONFLICT path runs, `existingRow` is
// defined, and the 36 columns that clause touches are the only ones that
// move. It touches ZERO weather columns -- asserted in section 5.
//
// Synthetic date 2999-02-01; every write is undone in the finally block.
// Takes `db` from db/schema -- never a second write connection.
//
// Run: node --max-old-space-size=1536 scripts/test-lineup-refresh-preserves.js

const fs = require('fs');
const path = require('path');
const { db, q } = require('../db/schema');
// The REAL builder runLineupJob calls, not a copy scraped out of the
// source: a future edit that widens the delete fails here, not on a slate.
const { buildOrphanDeleteSql } = require('../services/jobs');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const D = '2999-02-01';
const GID = 'zza-zzb';
const ORPHAN = 'zzx-zzy';          // wrong-date row: no game_pk, not in the fetch

// Columns the refresh must NOT touch. Weather first, because that is the
// reported incident; the rest are the same class of loss.
const MUST_SURVIVE = {
  temp_f: 71.4,
  wind_speed: 9.5,
  wind_dir: 246,
  wind_factor: 0.029,
  temp_run_adj: 0.184,
  roof_status: 'open',
  roof_confidence: 'measured',
  weather_quality: 'ok',
  weather_quality_at: '2026-09-16 17:09:00',
  weather_inputs_valid: 1,
  // opener detection -- only re-derived when detectOpeners runs again
  is_opener_game_away: 1,
  bulk_guy_away: 'Some Bulk',
  game_type_away: 'opener',
  opener_detected_at: '2026-09-16 17:00:00',
  // bullpen wOBA, persisted at signal time
  away_bullpen_woba: 0.3123,
  home_bullpen_woba: 0.3210,
  // market columns the odds job owns (class B -- look preserved, were not)
  market_away_ml: -142,
  market_home_ml: 120,
  market_total: 8.5,
  over_price: -110,
  under_price: -110,
  // park factor: class B, and it reset to a PLAUSIBLE 1.0, not to null
  park_factor: 1.07,
  venue_id: 3313,
  venue_name: 'Test Park',
  // lineups
  away_lineup_json: '[{"name":"A","hand":"R"}]',
  home_lineup_json: '[{"name":"B","hand":"L"}]',
};

// Columns the refresh IS allowed to change -- part of the 36 in the ON
// CONFLICT clause that this pass genuinely re-derives. Preserving these
// would be the opposite bug, which is why section 4 exists.
const MUST_UPDATE = {
  away_sp: 'New Starter',
  home_sp: 'Other Starter',
  game_time: '7:05 PM ET',
};

function seed() {
  const cols = Object.keys(MUST_SURVIVE);
  db.prepare(
    'INSERT INTO game_log (game_date, game_id, away_team, home_team, away_sp, home_sp, '
    + 'away_sp_hand, home_sp_hand, away_sp_id, game_pk, game_number, ' + cols.join(', ') + ') '
    + "VALUES (?, ?, 'SEA', 'TOR', 'Old Starter', 'Old Other', 'R', 'R', 555111, 778899, 1, "
    + cols.map(() => '?').join(', ') + ')'
  ).run(D, GID, ...cols.map(c => MUST_SURVIVE[c]));

  // A wrong-date orphan: the class the DELETE was originally added for
  // (commit 3e71b5c, 2026-04-20, alongside the fail-closed date guard).
  // No game_pk, so fetchSchedule's soft-delete prune cannot see it.
  db.prepare(
    'INSERT INTO game_log (game_date, game_id, away_team, home_team, temp_f) '
    + "VALUES (?, ?, 'ZZZ', 'YYY', 55.0)"
  ).run(D, ORPHAN);
}

function row(gid) {
  return db.prepare('SELECT * FROM game_log WHERE game_date=? AND game_id=?').get(D, gid || GID);
}

function cleanup() {
  try { db.prepare('DELETE FROM game_log WHERE game_date=?').run(D); } catch (e) {}
}

// No unscoped sweep anywhere else in runLineupJob.
function unscopedSweepsInLineupJob() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');
  const start = src.indexOf('async function runLineupJob');
  const nextFn = src.indexOf('\nasync function ', start + 40);
  const seg = src.slice(start, nextFn > start ? nextFn : undefined);
  return (seg.match(/DELETE FROM game_log[^'"`]*/g) || [])
    .filter(sql => !/game_pk IS NULL/.test(sql));
}

// The bootstrap upsert payload, same shape jobs.js builds. The point of
// the fix is that `existingRow` is now DEFINED here, so the
// existingRow-dependent keys carry instead of resetting.
function bootstrapUpsert(existingRow) {
  q.upsertGame.run({
    game_date: D, game_id: GID, away_team: 'SEA', home_team: 'TOR',
    game_time: MUST_UPDATE.game_time,
    away_sp: MUST_UPDATE.away_sp, away_sp_hand: 'L',
    home_sp: MUST_UPDATE.home_sp, home_sp_hand: 'R',
    away_sp_id: null, home_sp_id: null,
    statsapi_away_sp: MUST_UPDATE.away_sp, statsapi_home_sp: MUST_UPDATE.home_sp,
    rotowire_away_sp: null, rotowire_home_sp: null,
    bulk_guy_away_announced: null, bulk_guy_home_announced: null,
    away_sp_proj_ip: null, home_sp_proj_ip: null,
    away_sp_forecast_ip: null, home_sp_forecast_ip: null,
    away_sp_forecast_n_priors: null, home_sp_forecast_n_priors: null,
    away_bulk_forecast_ip: null, home_bulk_forecast_ip: null,
    away_opener_forecast_ip: null, home_opener_forecast_ip: null,
    market_away_ml: existingRow ? (existingRow.market_away_ml || null) : null,
    market_home_ml: existingRow ? (existingRow.market_home_ml || null) : null,
    market_total:   existingRow ? existingRow.market_total : null,
    park_factor:    existingRow ? existingRow.park_factor : 1.0,
    park_factor_source: existingRow ? existingRow.park_factor_source : null,
    model_away_ml:  existingRow ? existingRow.model_away_ml : null,
    model_home_ml:  existingRow ? existingRow.model_home_ml : null,
    model_total:    existingRow ? existingRow.model_total : null,
    lineup_source:  existingRow ? existingRow.lineup_source : 'auto',
    venue_id:       existingRow ? existingRow.venue_id : null,
    venue_name:     existingRow ? existingRow.venue_name : null,
    game_number: 1, game_pk: 778899,
  });
}

function main() {
  cleanup();
  try {
    // ---------------------------------------------------------------
    console.log('\n1. the delete is SCOPED, not "everything unplayed"');
    const sql = buildOrphanDeleteSql(1);
    expect('scoped to rows with no game_pk', /game_pk IS NULL/.test(sql),
      sql.slice(0, 72) + '...');
    expect('scoped to ids NOT being written this pass', /game_id NOT IN \(/.test(sql));
    expect('still limited to unplayed rows', /away_score IS NULL/.test(sql));
    let threw = false;
    try { buildOrphanDeleteSql(0); } catch (e) { threw = true; }
    expect('refuses to build a delete with no id list', threw);
    const unscoped = unscopedSweepsInLineupJob();
    expect('no unscoped game_log sweep remains in runLineupJob',
      unscoped.length === 0, unscoped.join(' | ') || 'none');

    // ---------------------------------------------------------------
    console.log('\n2. a real refresh preserves the row, and still drops the orphan');
    seed();
    expect('seed populated weather', row().temp_f === MUST_SURVIVE.temp_f);
    expect('seed created the orphan', !!row(ORPHAN));

    // Bound exactly as runLineupJob binds it: the date, then the ids the
    // bootstrap is about to write.
    const info = db.prepare(buildOrphanDeleteSql(1)).run(D, GID);

    expect('the real game ROW SURVIVED the delete', !!row());
    expect('the wrong-date ORPHAN was removed', !row(ORPHAN),
      info.changes + ' row(s) deleted');

    const existingRow = q.getGameById.get(D, GID);
    expect('existingRow is DEFINED after the delete (it was not, before)', !!existingRow);
    bootstrapUpsert(existingRow);

    // ---------------------------------------------------------------
    console.log('\n3. every identified column survived the refresh');
    const after = row();
    let lost = 0;
    for (const [col, want] of Object.entries(MUST_SURVIVE)) {
      const got = after[col];
      const ok = (typeof want === 'number') ? Math.abs(got - want) < 1e-9 : got === want;
      if (!ok) { lost++; expect(col + ' survived', false, 'want ' + want + ', got ' + got); }
    }
    expect('all ' + Object.keys(MUST_SURVIVE).length + ' must-survive columns intact',
      lost === 0, lost ? lost + ' lost' : 'none lost');
    expect('park_factor did not reset to the plausible 1.0',
      Math.abs(after.park_factor - MUST_SURVIVE.park_factor) < 1e-9, String(after.park_factor));

    // ---------------------------------------------------------------
    console.log('\n4. what SHOULD change still changes');
    for (const [col, want] of Object.entries(MUST_UPDATE)) {
      expect(col + ' was refreshed by the pass', after[col] === want, 'got ' + after[col]);
    }
    expect('updated_at moved', after.updated_at != null);
    expect('away_sp_id CLEARED when a new name arrives with no id',
      after.away_sp_id == null, 'was 555111, now ' + after.away_sp_id);
    expect('statsapi_away_sp took the new value', after.statsapi_away_sp === MUST_UPDATE.away_sp);

    // ---------------------------------------------------------------
    console.log('\n5. the ON CONFLICT clause touches no weather column');
    const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.js'), 'utf8');
    const i = schemaSrc.indexOf('upsertGame');
    const c = schemaSrc.indexOf('ON CONFLICT(game_date, game_id) DO UPDATE SET', i);
    const clause = schemaSrc.slice(c, schemaSrc.indexOf('updated_at = datetime', c))
      .replace(/--[^\n]*/g, '');
    const weatherCols = ['temp_f', 'wind_speed', 'wind_dir', 'wind_factor', 'temp_run_adj',
      'roof_status', 'roof_confidence', 'weather_quality', 'weather_quality_at',
      'weather_inputs_valid'];
    const touched = weatherCols.filter(w => new RegExp('(^|[\\s,])' + w + '\\s*=').test(clause));
    expect('no weather column in ON CONFLICT DO UPDATE SET', touched.length === 0,
      touched.length ? touched.join(', ') : 'none of ' + weatherCols.length);
  } finally {
    cleanup();
  }
  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
