'use strict';

// FanGraphs pitcher row -> MLBAM id. (2026-09-13)
//
// WHY THIS EXISTS, AND WHY IT IS NOT A playerid LOOKUP.
//
// The prior-season backfill failed live with "parsed 0 usable rows from 362
// (362 without an MLBAM id)": the strType=3 Batted Ball panel does not
// carry xMLBAMID, while the projection panels do (see BAT_PROJ_MAP /
// PIT_PROJ_MAP, which map the CSV column MLBAMID from the JSON field
// xMLBAMID).
//
// The obvious fix is "reuse the mapping the wOBA sync uses". There isn't
// one. The wOBA sync is NAME-KEYED end to end: routes/api.js parseCSV
// reads only Name / wOBA / sample / Team, woba_data is keyed
// (data_key, player_name), and no table in the schema stores a FanGraphs
// playerid at all. The id resolution happens later, in the CONSUMERS, by
// name. So there is no playerid -> MLBAM table to join against, and
// building one would mean persisting a second identity space.
//
// What this module does instead is reuse the repo's ONE name-matching
// implementation (utils/names.js normName / stripSfx) against the two
// places that already pair a pitcher name with an MLBAM id:
//
//   pitcher_game_log  (pitcher_name, pitcher_mlb_id) -- every pitcher who
//                     has appeared this season, ~1,594 distinct ids
//   team_rosters      (name, mlb_id) where position = 'P' -- ~420
//
// pitcher_game_log is preferred: it is appearance-derived rather than
// roster-derived, so it covers pitchers who have since been released or
// moved, which matters for a PRIOR-SEASON pull where many 2025 names are
// not on any 2026 roster.
//
// UNRESOLVED IS A FIRST-CLASS OUTCOME, not an error. A 2025 pitcher who
// never appeared in 2026 has no id here and never will; the caller counts
// him and moves on, the same convention as the FRV term's missing fielder.

const { normName, stripSfx } = require('./names');

// FanGraphs team abbreviations that differ from ours. Single definition --
// routes/api.js parseCSV imports it from here rather than keeping its own
// copy, which is what it had before 2026-09-13.
const FG_TEAM_MAP = {
  KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', WSN: 'WAS', CHW: 'CWS',
};

function normaliseFgTeam(fgTeam) {
  if (!fgTeam) return null;
  const t = String(fgTeam).trim().toUpperCase();
  return FG_TEAM_MAP[t] || t;
}

// Build the name -> id index ONCE per run rather than querying per row: a
// full-season pull is ~360 rows per split and a per-row query would be
// ~720 statement executions for data that does not change mid-run.
//
// Keyed on stripSfx(normName(name)) so "Luis L. Ortiz", "Luis Ortiz Jr."
// and "luis ortiz" collapse together the same way every other name path in
// this repo collapses them.
function buildPitcherIdIndex(db) {
  const byName = new Map();        // norm -> Set of ids
  const byNameTeam = new Map();    // norm|TEAM -> Set of ids
  const add = (map, key, id) => {
    if (!key || !id) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(Number(id));
  };

  // Appearance-derived first.
  try {
    const rows = db.prepare(
      'SELECT DISTINCT pitcher_name AS name, pitcher_mlb_id AS id, team '
      + 'FROM pitcher_game_log WHERE pitcher_mlb_id IS NOT NULL AND pitcher_name IS NOT NULL'
    ).all();
    for (const r of rows) {
      const norm = stripSfx(normName(r.name));
      add(byName, norm, r.id);
      add(byNameTeam, norm + '|' + String(r.team || '').toUpperCase(), r.id);
    }
  } catch (e) { /* table absent -> roster-only index */ }

  // Roster-derived second, so it cannot outvote an appearance.
  try {
    const rows = db.prepare(
      "SELECT name, mlb_id AS id, team FROM team_rosters WHERE position = 'P' AND mlb_id IS NOT NULL"
    ).all();
    for (const r of rows) {
      const norm = stripSfx(normName(r.name));
      add(byName, norm, r.id);
      add(byNameTeam, norm + '|' + String(r.team || '').toUpperCase(), r.id);
    }
  } catch (e) { /* ignore */ }

  return { byName, byNameTeam };
}

// Returns { id, how } where how is 'name_team' | 'name' | null.
//
// The team-qualified match is tried first so two pitchers sharing a
// normalised name are not silently collapsed. A name that is ambiguous
// even after the team qualifier resolves to NULL rather than to a guess --
// picking one of two Ortizes at random is worse than admitting we do not
// know which.
function resolvePitcherId(index, fgName, fgTeam) {
  if (!index || !fgName) return { id: null, how: null };
  const norm = stripSfx(normName(fgName));
  if (!norm) return { id: null, how: null };
  const team = normaliseFgTeam(fgTeam);

  if (team) {
    const hit = index.byNameTeam.get(norm + '|' + team);
    if (hit && hit.size === 1) return { id: [...hit][0], how: 'name_team' };
  }
  const any = index.byName.get(norm);
  if (any && any.size === 1) return { id: [...any][0], how: 'name' };
  // size > 1 is a genuine ambiguity; size 0 is simply absent. Both null.
  return { id: null, how: null };
}

module.exports = {
  FG_TEAM_MAP, normaliseFgTeam, buildPitcherIdIndex, resolvePitcherId,
};
