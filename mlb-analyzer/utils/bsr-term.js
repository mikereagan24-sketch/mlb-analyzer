'use strict';

// THE lineup baserunning (BsR) term. ONE implementation (2026-09-28).
//
// Production (services/jobs.js processGameSignals), the offline harness
// (services/harness-inputs.js), /debug/model-trace and the matchup card all
// call this. The card was the only consumer before, and it read the LIVE
// player_baserunning_trailing table with a denominator of games completed
// ON OR BEFORE the date -- a different number from what the backtest
// measured, which read the dated snapshot. A term that enters the price has
// to be one number everywhere, or the card explains a price nobody computed
// and the harness measures a model that is not running.
//
// WHAT THE TERM IS -- construction `current`, the one the gate evaluated:
//
//     side BsR/game = sum(starters' trailing-1yr BsR) / team games played
//
//   numerator    player_baserunning_trailing_snapshot, the latest snapshot on
//                or before game_date (written each morning, so it knows
//                through the previous day). NOT the live table: a replay of a
//                past game must see the BsR that existed then, and the live
//                table is overwritten daily.
//   denominator  games the team COMPLETED STRICTLY BEFORE game_date. The
//                backtest counted through the end of its window, which is
//                hindsight even in its forward mode; the price must not be.
//   resolution   the caller's name -> mlbam_id resolver. Production passes
//                resolveCatcherMlbId, the resolver framing and FRV use.
//
// The arithmetic is services/baserunning-util.computeLineupBsRPerGame,
// unchanged -- this module decides WHICH inputs it gets, so every caller
// gets the same ones.
//
// WHEN THERE IS NO NUMBER. `value` is null and `status` says why:
//   no_snapshot     no trailing snapshot on or before game_date
//   stale_snapshot  the newest one is more than SNAPSHOT_MAX_AGE_DAYS old
//   no_lineup       the lineup JSON is empty or unparseable
//   no_games        the team has no completed games before game_date
//   unresolved      no starter resolved to a player with a BsR row
// runModel prices a null side at 0 and the caller counts and logs it. A
// null is never silently a zero: see bsrFallbackStats() below.

const bsrUtil = require('../services/baserunning-util');

// Snapshots are written daily; the only gap on record is 2026-09-02 ->
// 09-04 (a whole-chain miss). Two days tolerates one missed morning job and
// still refuses a snapshot that has stopped updating.
const SNAPSHOT_MAX_AGE_DAYS = 2;

// Per-process caches. Both inputs are fixed for a past date and change at
// most once a day for today's, so a short TTL keeps a long-running server
// current without re-reading ~1,400 snapshot rows for every game.
const CACHE_TTL_MS = 10 * 60 * 1000;
const _snapCache = new Map();    // game_date -> { at, snapshot_date, maps }
const _gamesCache = new Map();   // game_date -> { at, gamesByTeam }

function _fresh(entry) { return entry && (Date.now() - entry.at) < CACHE_TTL_MS; }

function _daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

function snapshotFor(q, gameDate) {
  const hit = _snapCache.get(gameDate);
  if (_fresh(hit)) return hit;
  const rows = q.getPlayerBaserunningTrailingAsOf ? q.getPlayerBaserunningTrailingAsOf.all(gameDate) : [];
  const entry = { at: Date.now(), snapshot_date: null, maps: null, window: null };
  if (rows && rows.length) {
    entry.snapshot_date = rows[0].snapshot_date;
    entry.maps = bsrUtil.buildBsrMaps(rows);
    entry.window = { startdate: rows[0].window_startdate || null, enddate: rows[0].window_enddate || null };
  }
  _snapCache.set(gameDate, entry);
  return entry;
}

function gamesByTeamBefore(q, gameDate) {
  const hit = _gamesCache.get(gameDate);
  if (_fresh(hit)) return hit.gamesByTeam;
  const rows = q.getCompletedGameIdsBefore ? q.getCompletedGameIdsBefore.all(gameDate) : [];
  const gamesByTeam = bsrUtil.gamesByTeamFromRows(rows);
  _gamesCache.set(gameDate, { at: Date.now(), gamesByTeam });
  return gamesByTeam;
}

/**
 * One side's lineup BsR per game.
 *
 * @param q          db/schema `q` (prepared statements)
 * @param team       team abbreviation as game_log spells it
 * @param lineupJson lineup JSON string or parsed array of {name, ...}
 * @param gameDate   YYYY-MM-DD
 * @param resolveId  (team, lineupName) -> mlbam_id | null
 * @param stintCountById OPTIONAL Map(mlbam_id -> stint_count), for the card's
 *                   "traded mid-window" marker only. It never affects value.
 * @returns {{ value: number|null, status: string, snapshot_date: string|null,
 *             snapshot_age_days: number|null, detail: object|null }}
 *   detail is computeLineupBsRPerGame's full accounting (breakdown etc.)
 *   when a snapshot was usable, else null.
 */
function lineupBsrTerm(q, team, lineupJson, gameDate, resolveId, stintCountById) {
  const out = { value: null, status: null, snapshot_date: null, snapshot_age_days: null,
    window: null, detail: null };
  const snap = snapshotFor(q, gameDate);
  if (!snap.snapshot_date) { out.status = 'no_snapshot'; return out; }
  out.snapshot_date = snap.snapshot_date;
  out.window = snap.window;
  out.snapshot_age_days = _daysBetween(snap.snapshot_date, gameDate);
  if (out.snapshot_age_days > SNAPSHOT_MAX_AGE_DAYS) { out.status = 'stale_snapshot'; return out; }
  const lineup = Array.isArray(lineupJson) ? lineupJson : (bsrUtil.tryParse(lineupJson) || []);
  if (!lineup.length) { out.status = 'no_lineup'; return out; }
  const gamesByTeam = gamesByTeamBefore(q, gameDate);
  // UPPERCASE, always. processGameSignals derives the team from game_id
  // ('tor'), the harness reads game_log.away_team ('TOR'), and the games-
  // played map is keyed upper -- a lowercase key finds no games and every
  // side would read no_games. Normalising here makes both callers identical.
  const T = String(team || '').toUpperCase();
  const res = bsrUtil.computeLineupBsRPerGame({
    team: T, lineupJson: lineup,
    bsrMap: snap.maps.bsrMap, gamesByTeam,
    resolveId: (t, p) => (p && p.name) ? resolveId(t, p.name) : null,
    stintCountById: stintCountById || snap.maps.stintCountById,
  });
  out.detail = res;
  if (!res.games_played) { out.status = 'no_games'; return out; }
  if (res.per_game == null) { out.status = 'unresolved'; return out; }
  out.value = res.per_game;
  out.status = 'ok';
  return out;
}

// Fallback accounting. runModel prices a null side at 0; every caller that
// builds the inputs records WHY here, and production logs it per game, so a
// slate that silently lost its BsR snapshot shows up as a count and a log
// line rather than as prices that quietly stopped moving.
let _fb = null;
function resetBsrFallbackStats() { _fb = { sides: 0, ok: 0, fallback: 0, byStatus: {} }; }
resetBsrFallbackStats();
function recordBsrSide(status) {
  _fb.sides++;
  if (status === 'ok') _fb.ok++;
  else { _fb.fallback++; _fb.byStatus[status] = (_fb.byStatus[status] || 0) + 1; }
}
function bsrFallbackStats() { return _fb; }

function _clearCaches() { _snapCache.clear(); _gamesCache.clear(); }

module.exports = {
  lineupBsrTerm,
  recordBsrSide,
  bsrFallbackStats,
  resetBsrFallbackStats,
  SNAPSHOT_MAX_AGE_DAYS,
  _clearCaches,
};
