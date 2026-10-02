'use strict';

// statsapi -> app team abbreviations and game ids. ONE implementation, used by
// services/scraper.js fetchSchedule (the schedule bootstrap) and
// services/game-log-repair.js (#486), so a repaired row gets exactly the
// game_id the bootstrap would have written. Moved out of fetchSchedule
// unchanged on 2026-10-02. Pure: no I/O.
//
// statsapi -> app abbr normalization. Mirrors the TEAM_NORM map in
// services/jobs.js so bootstrap rows produce the SAME game_id RotoWire
// and the Unabated odds path would compute for the same matchup.
// Known divergences:
//   WSH (statsapi)  -> WAS (us)
//   OAK (statsapi)  -> ATH (us, post-2025 venue change)
//   AZ  (statsapi)  -> ARI (us -- sportsbook + FanGraphs convention)
// Verified 2026-04-25 by spot-checking a slate where SD@AZ surfaced as
// sd-az under statsapi's raw abbr but the Unabated odds path keyed on
// sd-ari, breaking the join.
const ABBR_NORM = { 'WSH': 'WAS', 'OAK': 'ATH', 'AZ': 'ARI' };
const normAbbr = (a) => (ABBR_NORM[a] || a || '').toUpperCase();

// Doubleheaders: statsapi gives gameNumber 1/2/3 per leg. Single games
// are gameNumber 1 implicitly. game_id appends '-g{N}' when N > 1 so the
// UNIQUE(game_date, game_id) constraint holds across legs.
function gameIdFor(awayAbbr, homeAbbr, gameNumber) {
  const baseGameId = (awayAbbr + '-' + homeAbbr).toLowerCase();
  return (gameNumber || 1) > 1 ? baseGameId + '-g' + (gameNumber || 1) : baseGameId;
}

module.exports = { ABBR_NORM, normAbbr, gameIdFor };
