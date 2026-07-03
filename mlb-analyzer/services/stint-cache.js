'use strict';

// In-memory stint cache for multi-team park-neutralization
// (fix/park-neutral-stint-weighted).
//
// Consumed by resolveNeutralizationFactor in services/model.js. When a
// player has appeared for more than one team this season we need to
// PA-weight (batters) or TBF-weight (pitchers) each stint's park
// factor instead of using the current team's factor for the whole
// actuals sample.
//
// Data source: game_log lineups + pitcher_game_log. Both are
// already-trusted, already-ingested, in-DB. Cheapest path, no new
// ingest job. Two side effects: (a) the cache lags trades by up to
// one lineup post + one game logged, and (b) a batter who has NOT
// appeared in a lineup yet at a new team is treated as single-team
// (correct — no actuals accumulated at the new team yet).
//
// Cache TTL 1 hour — scoring cadence is generally hourly during the
// day, so a stale-by-<1h cache picks up new stints on the next
// scheduled run without stampeding the DB. First lookup after boot
// or expiry pays the query cost (~1 rows/game × 30 games/day × 120
// days ≈ 3600 rows), still sub-100ms on the local DB.

const { db } = require('../db/schema');
const { normName } = require('../utils/names');

// Season boundary — lineups pre-2026-03-01 are spring-training noise
// and don't reflect any player's actual regular-season stint. The
// team-changes we care about happen in-season.
const SEASON_START = '2026-03-01';
const TTL_MS = 60 * 60 * 1000;

let _batterCache = null;   // normName → Map<team, gameCount>
let _pitcherCache = null;  // normName → Map<team, tbfSum>
let _cacheBuiltAt = 0;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// Iterate every game's confirmed / projected lineup and count games
// per (player, team). A lineup appearance is a proxy for PA — real
// PA-per-appearance is ~3.8-4.5 depending on the batting slot, but
// for weight-only purposes count-per-team is scale-equivalent to
// PA-per-team so the ratio comes out the same.
function buildBatterCache() {
  const cache = new Map();
  const rows = db.prepare(
    "SELECT away_team, home_team, away_lineup_json, home_lineup_json "
    + "FROM game_log "
    + "WHERE game_date >= ? "
    + "AND (away_lineup_json IS NOT NULL OR home_lineup_json IS NOT NULL)"
  ).all(SEASON_START);
  for (const g of rows) {
    const pairs = [[g.away_team, g.away_lineup_json], [g.home_team, g.home_lineup_json]];
    for (const [team, luJson] of pairs) {
      if (!team) continue;
      const lineup = tryParse(luJson);
      if (!Array.isArray(lineup)) continue;
      for (const p of lineup) {
        if (!p || !p.name) continue;
        const k = normName(p.name);
        if (!k) continue;
        if (!cache.has(k)) cache.set(k, new Map());
        const teamMap = cache.get(k);
        teamMap.set(team, (teamMap.get(team) || 0) + 1);
      }
    }
  }
  return cache;
}

// Pitcher stint tally: sum batters_faced per (pitcher_name, team). TBF
// is the natural denominator for pitcher wOBA-against so the weighting
// is proportional to how much of a pitcher's sample was collected at
// each team's park.
function buildPitcherCache() {
  const cache = new Map();
  const rows = db.prepare(
    "SELECT pitcher_name, team, batters_faced "
    + "FROM pitcher_game_log "
    + "WHERE game_date >= ? AND batters_faced IS NOT NULL AND batters_faced > 0"
  ).all(SEASON_START);
  for (const r of rows) {
    if (!r.pitcher_name || !r.team) continue;
    const k = normName(r.pitcher_name);
    if (!k) continue;
    if (!cache.has(k)) cache.set(k, new Map());
    const teamMap = cache.get(k);
    teamMap.set(r.team, (teamMap.get(r.team) || 0) + r.batters_faced);
  }
  return cache;
}

function ensureCache() {
  const now = Date.now();
  if (_batterCache && _pitcherCache && (now - _cacheBuiltAt) < TTL_MS) return;
  _batterCache  = buildBatterCache();
  _pitcherCache = buildPitcherCache();
  _cacheBuiltAt = now;
}

// Public lookup — returns Map<team, weight> for the player, or null if
// no stint data is available. Never throws; a DB failure returns null
// so the caller falls back to current-team neutralization (v1 behavior).
function getBatterStintMap(playerName) {
  if (!playerName) return null;
  try { ensureCache(); }
  catch (e) { console.warn('[stint-cache] batter build failed: ' + e.message); return null; }
  return _batterCache.get(normName(playerName)) || null;
}

function getPitcherStintMap(pitcherName) {
  if (!pitcherName) return null;
  try { ensureCache(); }
  catch (e) { console.warn('[stint-cache] pitcher build failed: ' + e.message); return null; }
  return _pitcherCache.get(normName(pitcherName)) || null;
}

// Test-only helper: force a cache rebuild on the next read. Callers in
// production should never touch this — the TTL is authoritative.
function _resetCache() {
  _batterCache = null;
  _pitcherCache = null;
  _cacheBuiltAt = 0;
}

// Test-only helper: inject a synthetic cache to bypass DB reads (for
// unit tests that need to control the stint distribution without
// having to set up a whole game_log fixture).
function _injectCache(batter, pitcher) {
  _batterCache  = batter  || new Map();
  _pitcherCache = pitcher || new Map();
  _cacheBuiltAt = Date.now();
}

module.exports = {
  getBatterStintMap,
  getPitcherStintMap,
  _resetCache,
  _injectCache,
};
