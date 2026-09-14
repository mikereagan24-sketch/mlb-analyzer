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

const { normName, stripSfx, fuzzyLookup } = require('./names');

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
// KEYED THE WAY utils/names.js EXPECTS. (2026-09-14) The index used to be
// two Maps keyed "norm" and "norm|TEAM", which only exact lookups could
// read. fuzzyLookup -- the repo's one name matcher, with the abbreviated-
// first-name stages this resolver needs -- reads a plain object keyed
// "norm" and "norm team" (space, lowercase team). Building it in that
// shape is what lets this module use the shared matcher instead of
// growing its own.
//
// Values stay ARRAYS OF IDS rather than a single id, because ambiguity
// has to survive the lookup: fuzzyLookup returns one value, and if that
// value is a two-element array the caller can still refuse to guess.
//
// Object.create(null): keys are arbitrary player names, and a pitcher
// named in a way that collides with Object.prototype ("constructor")
// would otherwise return a function from a property read.
function buildPitcherIdIndex(db) {
  const keyMap = Object.create(null);
  const add = (key, id) => {
    if (!key || !id) return;
    const n = Number(id);
    if (!keyMap[key]) keyMap[key] = [];
    if (keyMap[key].indexOf(n) === -1) keyMap[key].push(n);
  };

  // Appearance-derived first.
  try {
    const rows = db.prepare(
      'SELECT DISTINCT pitcher_name AS name, pitcher_mlb_id AS id, team '
      + 'FROM pitcher_game_log WHERE pitcher_mlb_id IS NOT NULL AND pitcher_name IS NOT NULL'
    ).all();
    for (const r of rows) {
      const norm = stripSfx(normName(r.name));
      add(norm, r.id);
      const t = String(r.team || '').toLowerCase();
      if (t) add(norm + ' ' + t, r.id);
    }
  } catch (e) { /* table absent -> roster-only index */ }

  // Roster-derived second, so it cannot outvote an appearance.
  try {
    const rows = db.prepare(
      "SELECT name, mlb_id AS id, team FROM team_rosters WHERE position = 'P' AND mlb_id IS NOT NULL"
    ).all();
    for (const r of rows) {
      const norm = stripSfx(normName(r.name));
      add(norm, r.id);
      const t = String(r.team || '').toLowerCase();
      if (t) add(norm + ' ' + t, r.id);
    }
  } catch (e) { /* ignore */ }

  return { keyMap: keyMap };
}

// Returns { id, how, ambiguous, candidates } where how is 'name_team' |
// 'name' | 'fuzzy' | null.
//
// The team-qualified match is tried first so two pitchers sharing a
// normalised name are not silently collapsed. A name that is ambiguous
// even after the team qualifier resolves to NULL rather than to a guess --
// picking one of two Ortizes at random is worse than admitting we do not
// know which.
//
// THE FUZZY STAGE IS ADDITIVE AND RUNS LAST. (2026-09-14) game_log stores
// away_sp / home_sp as "F. Last" while the index holds full names, so
// "E. Rodriguez" missed an exact lookup that "Eduardo Rodriguez" hits.
// Measured over 2026-08-16..09-15: 32 of 830 SP appearances, 3.9%,
// every one of them an abbreviated form.
//
// The two exact stages run FIRST and unchanged, so every name that
// resolved before resolves to the same id -- the fuzzy stage can only
// turn a null into an id, never move an existing answer. That is the same
// additive argument stage 6.5 of fuzzyLookup makes for itself, and the
// measurement asserts it: 0 names resolve differently.
//
// AMBIGUITY SURVIVES THE FUZZY STAGE TOO. fuzzyLookup returns one value,
// but the values here are arrays, so a hit carrying two ids is still
// refused -- and it is REPORTED rather than silently dropped, because an
// ambiguous name is a different problem from an absent one and the caller
// counts them separately.
function resolvePitcherId(index, fgName, fgTeam) {
  const MISS = { id: null, how: null, ambiguous: false, candidates: 0 };
  if (!index || !index.keyMap || !fgName) return MISS;
  const norm = stripSfx(normName(fgName));
  if (!norm) return MISS;
  const team = normaliseFgTeam(fgTeam);
  const km = index.keyMap;

  const decide = (ids, how) => {
    if (!ids || !ids.length) return null;
    if (ids.length === 1) return { id: ids[0], how: how, ambiguous: false, candidates: 1 };
    return { id: null, how: null, ambiguous: true, candidates: ids.length };
  };

  if (team) {
    const d = decide(km[norm + ' ' + team.toLowerCase()], 'name_team');
    if (d) return d;
  }
  const d2 = decide(km[norm], 'name');
  if (d2) return d2;

  const d3 = decide(fuzzyLookup(km, fgName, team || null), 'fuzzy');
  if (d3) return d3;

  // CLASSIFY THE MISS: ambiguous, or absent? fuzzyLookup's abbreviated
  // stages refuse on more than one candidate and return null, so a name
  // with four possible pitchers and a name with none are indistinguishable
  // by return value alone. They are different problems -- one needs a
  // better qualifier, the other needs the pitcher to exist -- and the
  // caller is asked to count them separately, so the scan below tells them
  // apart. Measured example, 2026-09-14: "E. Rodriguez" has four
  // candidates (elmer, eduardo, erick, erian) and no rodriguez-BAL key to
  // resolve against, so it is ambiguous, not missing.
  //
  // REPORTING ONLY. It never returns an id, so it cannot promote a guess:
  // the exactly-one guard in fuzzyLookup remains the only thing that can
  // resolve an abbreviated name.
  const n = countAbbrevCandidates(km, norm);
  if (n > 1) return { id: null, how: null, ambiguous: true, candidates: n };
  return MISS;
}

// Candidates for an abbreviated "f last" form: untagged index keys whose
// last token matches and whose first token starts with the same letter.
// Team-tagged keys are skipped because fuzzyLookup has already tried the
// team-scoped path; counting them here would double-count one pitcher who
// appears both tagged and untagged.
function countAbbrevCandidates(keyMap, norm) {
  const parts = norm.split(' ');
  if (parts.length < 2 || parts[0].length !== 1) return 0;
  const initial = parts[0], last = parts[parts.length - 1];
  let n = 0;
  for (const k in keyMap) {
    if (/\s[a-z]{2,3}$/.test(k)) continue;
    const p = stripSfx(k).split(' ');
    if (p.length >= 2 && p[p.length - 1] === last && p[0] && p[0][0] === initial) n++;
  }
  return n;
}

module.exports = {
  FG_TEAM_MAP, normaliseFgTeam, buildPitcherIdIndex, resolvePitcherId,
};
