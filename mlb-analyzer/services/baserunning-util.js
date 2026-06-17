'use strict';

// Shared lineup-BsR math. One implementation for both the matchup-tab
// display and the trailing backtest so they can't drift.
//
// Per-game lineup BsR = Σ(resolved starters' trailing-1yr BsR) / team's
// games-played. Resolved slots with no BsR row contribute 0 (neutral —
// common for September call-ups without a trailing total yet).
//
// All inputs explicit — no module-level closures. Each call returns a
// per-call accounting object; the backtest accumulates across many
// calls, the matchup view uses one call's result directly.

function tryParse(s) {
  if (!s) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// computeLineupBsRPerGame({
//   team,           // 'NYY' etc — only used as a passthrough to resolveId
//   lineupJson,     // raw JSON string OR already-parsed array of {name, mlb_id, ...}
//   bsrMap,         // Map(mlbam_id:number → bsr:number)  (required)
//   gamesByTeam,    // Map(team:string → games_played:number)  (required)
//   resolveId,      // (team, playerObj) => mlbam_id|null   (required)
//   stintCountById, // OPTIONAL Map(mlbam_id → stint_count)
// }) → {
//   per_game,                  // number | null — sum / games_played, null if no slots resolved or no denom
//   sum_bsr,                   // number — raw sum
//   games_played,              // number | null
//   slots_total,               // # slots iterated
//   slots_resolved,            // # slots where resolveId returned an id
//   slots_with_bsr,            // # slots where bsrMap had a value
//   slots_multi_team,          // # slots whose player had stint_count > 1 (0 if stintCountById not supplied)
//   player_ids: Set<number>,   // ids that contributed BsR
//   multi_team_player_ids: Set<number>,
//   breakdown: [{slot, name, mlbam_id, bsr, resolved, has_bsr, multi_team}],
// }
function computeLineupBsRPerGame(opts) {
  const team       = opts.team;
  const bsrMap     = opts.bsrMap;
  const gamesByTeam = opts.gamesByTeam;
  const resolveId  = opts.resolveId;
  const stintCountById = opts.stintCountById || null;

  const empty = {
    per_game: null, sum_bsr: 0, games_played: null,
    slots_total: 0, slots_resolved: 0, slots_with_bsr: 0, slots_multi_team: 0,
    player_ids: new Set(), multi_team_player_ids: new Set(),
    breakdown: [],
  };
  if (!bsrMap || !gamesByTeam || typeof resolveId !== 'function') return empty;

  const lineup = Array.isArray(opts.lineupJson)
    ? opts.lineupJson
    : (tryParse(opts.lineupJson) || []);
  const games_played = gamesByTeam.get(team) || null;

  const out = {
    per_game: null, sum_bsr: 0, games_played,
    slots_total: 0, slots_resolved: 0, slots_with_bsr: 0, slots_multi_team: 0,
    player_ids: new Set(), multi_team_player_ids: new Set(),
    breakdown: [],
  };

  // Same upfront gating as the original backtest impl — if there's no
  // denominator we can't produce per_game and slot counters shouldn't
  // be polluted with rows we'll discard anyway. Empty lineup short-
  // circuits the same way. Both produce an "empty" result, not an
  // iteration.
  if (!games_played || games_played <= 0) return out;
  if (!lineup.length) return out;

  let sum = 0, anyResolved = false;
  for (let i = 0; i < lineup.length; i++) {
    const p = lineup[i];
    if (!p || !p.name) continue;
    out.slots_total++;
    const mlbId = resolveId(team, p);
    const idNum = mlbId != null ? Number(mlbId) : null;
    const row = { slot: i + 1, name: p.name, mlbam_id: idNum, bsr: null, resolved: false, has_bsr: false, multi_team: false };
    if (!Number.isFinite(idNum) || idNum <= 0) {
      out.breakdown.push(row);
      continue;
    }
    row.resolved = true;
    out.slots_resolved++;
    const bsr = bsrMap.get(idNum);
    if (bsr != null) {
      row.bsr = Number(bsr);
      row.has_bsr = true;
      sum += row.bsr;
      out.slots_with_bsr++;
      out.player_ids.add(idNum);
      anyResolved = true;
      if (stintCountById) {
        const sc = stintCountById.get(idNum);
        if (sc != null && sc > 1) {
          row.multi_team = true;
          out.slots_multi_team++;
          out.multi_team_player_ids.add(idNum);
        }
      }
    }
    out.breakdown.push(row);
  }

  out.sum_bsr = sum;
  if (!anyResolved || !games_played || games_played <= 0) {
    // Match backtest behavior: per_game null when nothing resolved or
    // no denominator (e.g. team has no completed games yet). Slot
    // accounting still surfaces what was tried.
    return out;
  }
  out.per_game = sum / games_played;
  return out;
}

// Helper for callers that need a Map from (mlbam_id → bsr) and an
// optional (mlbam_id → stint_count) Map from the current trailing-1yr
// rows. Skips rows with null bsr or unparseable id.
function buildBsrMaps(trailingRows) {
  const bsrMap = new Map();
  const stintCountById = new Map();
  for (const r of trailingRows || []) {
    if (r == null) continue;
    const id = Number(r.mlbam_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (r.bsr != null) bsrMap.set(id, Number(r.bsr));
    if (r.stint_count != null) stintCountById.set(id, Number(r.stint_count));
  }
  return { bsrMap, stintCountById };
}

// Helper for completed-games-per-team denominator from game_log. Same
// query the backtest uses. Takes a prepared statement OR a callable
// (so the caller controls db access — keeps this module pure).
//   rowsCompletedGames: [{game_id: 'AWAY-HOME-..'}]
function gamesByTeamFromRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const parts = String(r.game_id || '').split('-');
    if (parts.length < 2) continue;
    const away = (parts[0] || '').toUpperCase();
    const home = (parts[1] || '').toUpperCase();
    if (away) out.set(away, (out.get(away) || 0) + 1);
    if (home) out.set(home, (out.get(home) || 0) + 1);
  }
  return out;
}

module.exports = {
  computeLineupBsRPerGame,
  buildBsrMaps,
  gamesByTeamFromRows,
  tryParse,
};
