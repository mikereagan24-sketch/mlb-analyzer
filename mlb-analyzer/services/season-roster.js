'use strict';
// ONE definition of "who played for this team this season", shared by the
// production path and every harness, so the two cannot answer it differently.
//
// WHY IT EXISTS. Stage 9 of fuzzyLookup breaks an abbreviation tie by asking
// whether a candidate is on the lineup's team (utils/names.js). That question
// needs a roster, and a roster is a database read, which the resolver must not
// do -- so the predicate is injected. The moment it is injected, WHERE it comes
// from becomes the thing that can diverge: production building it one way and
// the harness another would mean 548 lineup slots resolve in prod and not in
// any measurement of prod. That is the harness_inputs_persisted failure class,
// which cost a full rebaseline on 2026-09-16. One function, both callers.
//
// WHY THE SEASON TABLE AND NOT THE DAILY ONE. `team_rosters` is an ~840-row
// snapshot of who is active TODAY; it drops anyone optioned, traded or shut
// down. #450 established that replaying April against it is wrong -- that is
// exactly how 21.71% of fielder slots went unresolved. `team_rosters_season`
// (1667 rows) keeps them.
//
// WHAT "AS-OF" CANNOT MEAN HERE, stated because the obvious implementation is
// a trap. team_rosters_season is UNIQUE(team, player_name) with a single
// `updated_at` for the whole table -- every row on this copy reads
// 2026-09-23 13:00:12 -- so it is a season-to-date ACCUMULATION, not a time
// series. There is no as-of dimension to query. `WHERE updated_at <= game_date`
// would return the whole table for any recent date and NOTHING for every date
// before the last write, silently emptying the roster for the entire season.
// So this returns the flat season set and the look-ahead is stated rather than
// faked: a player traded in August appears on his new team for an April game.
//
// THAT LOOK-AHEAD IS SAFE FOR THIS USE, and only for this use. Stage 9's
// roster rule fires only when EXACTLY ONE candidate is on the team. A roster
// that is too generous can turn "exactly one" into "two", which resolves
// nothing -- it cannot produce a WRONG match. The failure direction is a
// missed fix, never a bad one. Do not reuse this set for anything that
// filters or rejects on membership; that is the 2026-07-23 roster gate, and
// it was disabled after two live incidents.

const { normName, stripSfx } = require('../utils/names');

// Lazy, so requiring this module never opens a database. db/schema opens a
// connection at require time and several callers here are pure.
let _q;
function _queries() {
  if (_q === undefined) {
    try { _q = require('../db/schema').q; } catch (e) { _q = null; }
  }
  return _q;
}

// The position players who appear for `team` anywhere in the season roster.
// Returns a Set of normalised names (both the normName form and its
// suffix-stripped form, so "Fernando Tatis Jr." matches either way), or null
// when the table is missing or the team has no rows -- null means "no roster
// available", which callers must treat as "cannot answer", never as "empty".
function seasonRosterSet(team) {
  const q = _queries();
  if (!q || !q.getSeasonPositionPlayers || !team) return null;
  let rows = [];
  try { rows = q.getSeasonPositionPlayers.all(String(team).toUpperCase()) || []; }
  catch (e) { return null; }
  if (!rows.length) return null;
  const set = new Set();
  for (const r of rows) {
    const n = r && r.player_name != null ? normName(r.player_name) : null;
    if (!n) continue;
    set.add(n);
    set.add(stripSfx(n));
  }
  return set.size ? set : null;
}

// Pure: Set -> predicate. No database, so services/model.js can use it without
// acquiring one. Null in, null out -- a missing roster disables the rule
// rather than answering false, which would silently mean "nobody is on this
// team" and turn a tie-break into a permanent no.
function onTeamPredicate(set) {
  if (!set || typeof set.has !== 'function' || !set.size) return null;
  return (key) => set.has(key) || set.has(stripSfx(key));
}

module.exports = { seasonRosterSet, onTeamPredicate };
