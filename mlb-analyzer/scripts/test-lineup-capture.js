#!/usr/bin/env node
/**
 * Tests for services/lineup-capture.js. (2026-08-26)
 *
 * The horizon field is the whole point of the table, so the tests that
 * matter are the boundary ones: DST, the ET-vs-PT midnight gap, and the
 * 11PM-PT same-day pull that lands after midnight ET and would be
 * misclassified by anything that inferred horizon from the timestamp.
 *
 * Runs against a scratch DB, never data/mlb.db.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + label); } };
const eq = (a, b, label) => ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- horizonFor: pure, so test it without touching a DB ----------------
const { horizonFor, leadMinutes } = require(path.join(R, 'services/lineup-capture'));

// 2026-08-26 18:00 UTC = 14:00 ET, 11:00 PT. ET date 2026-08-26.
const midday = Date.parse('2026-08-26T18:00:00Z');
eq(horizonFor('2026-08-26', midday), 'same_day', 'midday: today is same_day');
eq(horizonFor('2026-08-27', midday), 'next_day', 'midday: tomorrow is next_day');
eq(horizonFor('2026-08-25', midday), null, 'midday: yesterday is not a horizon');
eq(horizonFor('2026-08-28', midday), null, 'midday: 2 days out is not a horizon');

// THE CASE THAT BREAKS TIMESTAMP INFERENCE.
// 11PM PT on 2026-08-26 is 2026-08-27T06:00Z -- already the 27th in ET.
// The cron fired runLineupJob(todayStr()) with PT's today = 2026-08-26,
// but ET has rolled over, so ET-relative classification calls it 'past'.
// It must NOT be silently recorded as some other horizon.
const latePt = Date.parse('2026-08-27T06:00:00Z');
eq(horizonFor('2026-08-26', latePt), null, '11PM PT pull: ET has rolled over, not a horizon');
eq(horizonFor('2026-08-27', latePt), 'same_day', '11PM PT pull: ET today is the 27th');
ok(horizonFor('2026-08-26', latePt) !== 'same_day',
   '11PM PT pull is never mislabelled same_day for the PT date');

// DST boundaries. US DST ended 2026-11-01 at 2AM ET.
// 2026-11-01T05:30:00Z is 01:30 EDT -- still Nov 1 in ET.
eq(horizonFor('2026-11-01', Date.parse('2026-11-01T05:30:00Z')), 'same_day', 'DST fall-back: 01:30 EDT is Nov 1');
// 2026-03-08T07:30:00Z is 02:30 EST -> clocks jump to 03:30 EDT; still Mar 8.
eq(horizonFor('2026-03-08', Date.parse('2026-03-08T07:30:00Z')), 'same_day', 'DST spring-forward: still Mar 8');
// UTC midnight is 8PM ET the PREVIOUS day -- the classic off-by-one.
eq(horizonFor('2026-06-15', Date.parse('2026-06-16T00:00:00Z')), 'same_day',
   'UTC midnight is still the previous ET day');

// ---- leadMinutes -------------------------------------------------------
eq(leadMinutes('2026-08-26T23:05:00Z', '2026-08-26T18:00:00Z'), 305, 'lead: 5h05m before first pitch');
eq(leadMinutes('2026-08-26T18:00:00Z', '2026-08-26T20:00:00Z'), -120, 'lead: negative when captured after first pitch');
eq(leadMinutes(null, '2026-08-26T18:00:00Z'), null, 'lead: null first pitch -> null');
eq(leadMinutes('garbage', '2026-08-26T18:00:00Z'), null, 'lead: unparseable -> null, not NaN');

// ---- captureSlate against a scratch DB ---------------------------------
// The db is INJECTED. This test must never be able to write to
// data/mlb.db -- db/schema is not required here at all, so there is no
// path by which it could.
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const scratch = path.join(os.tmpdir(), 'lineup-capture-test-' + process.pid + '.db');
const db = new Database(scratch);
db.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, away_team TEXT, home_team TEXT, first_pitch_utc TEXT, PRIMARY KEY (game_date, game_id))');
for (const ddl of require(path.join(R, 'db/lineup-captures-ddl')).LINEUP_CAPTURES_DDL) db.exec(ddl);
const { captureSlate } = require(path.join(R, 'services/lineup-capture'));
const countRows = () => db.prepare('SELECT COUNT(*) c FROM lineup_captures').pluck().get();

db.prepare('INSERT OR REPLACE INTO game_log (game_date,game_id,away_team,home_team,first_pitch_utc) '
  + "VALUES ('2026-08-26','nyy-bos','NYY','BOS','2026-08-26T23:05:00Z')").run();

const slate = [{
  game_id: 'nyy-bos', away_team: 'NYY', home_team: 'BOS',
  lineup_status: 'projected', page_has_started: 0,
  away_sp: { name: 'Some Pitcher', hand: 'R' }, home_sp: { name: 'Other Pitcher', hand: 'L' },
  away_lineup: Array.from({ length: 9 }, (_, i) => ({ name: 'A' + i, hand: 'R' })),
  home_lineup: Array.from({ length: 9 }, (_, i) => ({ name: 'H' + i, hand: 'L' })),
}];

const r1 = captureSlate(slate, '2026-08-26', '2026-08-26T15:00:00Z', { nowMs: midday, db });
eq(r1.horizon, 'same_day', 'captureSlate: horizon derived');
eq(r1.written, 2, 'captureSlate: one row per side');
eq(countRows(), 2, 'captureSlate: rows landed');

const row = db.prepare("SELECT * FROM lineup_captures WHERE side='away'").get();
eq(row.horizon, 'same_day', 'row: horizon stored, not inferred');
eq(row.lead_minutes, 485, 'row: lead_minutes computed from first pitch');
eq(row.first_pitch_utc, '2026-08-26T23:05:00Z', 'row: first pitch copied in for reproducibility');
eq(row.n_slots, 9, 'row: slot count');
eq(row.hand_source, 'source', 'row: handedness flagged as source-supplied');
eq(row.page_has_started, 0, 'row: not started');
eq(JSON.parse(row.lineup_json).length, 9, 'row: lineup round-trips');

// IDEMPOTENCE. Re-running the same job must not double-count -- the
// primary key includes capture_time and the insert is OR IGNORE.
const r2 = captureSlate(slate, '2026-08-26', '2026-08-26T15:00:00Z', { nowMs: midday, db });
eq(countRows(), 2, 'idempotent: same capture_time does not duplicate');
ok(r2.written === 2, 'idempotent: reports rows attempted, not rows inserted');

// A LATER PULL IS A NEW ROW, NOT AN OVERWRITE. This is the entire
// difference from game_log's COALESCE snapshot.
captureSlate(slate, '2026-08-26', '2026-08-26T21:00:00Z', { nowMs: midday, db });
eq(countRows(), 4, 'a second capture time appends rather than overwrites');

// BOTH HORIZONS COEXIST FOR THE SAME GAME. The point of the exercise.
captureSlate(slate, '2026-08-26', '2026-08-25T23:00:00Z',
             { nowMs: Date.parse('2026-08-25T18:00:00Z'), db });
eq(countRows(), 6, 'next-day capture coexists with same-day for one game');
const horizons = db.prepare('SELECT DISTINCT horizon FROM lineup_captures ORDER BY horizon').all().map(r => r.horizon);
eq(JSON.stringify(horizons), JSON.stringify(['next_day', 'same_day']), 'both horizons present for the same game');

// STARTED GAMES ARE FLAGGED, NOT DROPPED. Dropping them would silently
// change the denominator; the analysis excludes them explicitly instead.
const started = [Object.assign({}, slate[0], { page_has_started: 1, lineup_status: 'confirmed' })];
const r3 = captureSlate(started, '2026-08-26', '2026-08-27T01:00:00Z', { nowMs: midday, db });
eq(r3.started, 1, 'started block counted');
const s = db.prepare('SELECT * FROM lineup_captures WHERE page_has_started=1 LIMIT 1').get();
ok(s != null, 'started capture is stored, not discarded');
ok(s.lead_minutes < 0, 'started capture carries a negative lead');

// EMPTY LINEUPS ARE STORED. "We looked and there was nothing" is the
// coverage metric; it cannot be computed from rows never inserted.
const empty = [Object.assign({}, slate[0], { away_lineup: [], home_lineup: [] })];
captureSlate(empty, '2026-08-26', '2026-08-26T13:00:00Z', { nowMs: midday, db });
const e = db.prepare("SELECT * FROM lineup_captures WHERE capture_time='2026-08-26T13:00:00Z' AND side='away'").get();
eq(e.n_slots, 0, 'empty lineup stored with n_slots=0');
eq(e.hand_source, null, 'empty lineup has no handedness source');

// Degenerate inputs must not throw.
eq(captureSlate([], '2026-08-26', '2026-08-26T13:00:00Z', { nowMs: midday, db }).reason, 'no_games', 'empty slate handled');
eq(captureSlate(null, '2026-08-26', '2026-08-26T13:00:00Z', { nowMs: midday, db }).reason, 'no_games', 'null slate handled');
eq(captureSlate(slate, '2026-08-20', '2026-08-26T13:00:00Z', { nowMs: midday, db }).reason,
   'not_a_capture_horizon', 'past date is not captured');
ok(captureSlate([{ away_lineup: [], home_lineup: [] }], '2026-08-26', '2026-08-26T14:00:00Z',
   { nowMs: midday, db }).skipped === 1, 'game with no id is skipped, not thrown on');

db.close();
try { fs.unlinkSync(scratch); } catch (e) {}
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
