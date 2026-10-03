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

// WAS THE GAME ACTUALLY PLAYED TO A RESULT? One rule, for every reader of
// statsapi game status. (2026-10-03, #504)
//
// statsapi marks finished games several ways, and abstractGameState 'Final'
// alone does NOT mean "completed": postponed and cancelled games carry it too,
// with no score. Measured over the 2026 regular season and postseason so far
// (abstract | detailed | coded):
//   Final | Final           | F  2,437 games (+ the All-Star game), all scored
//   Final | Completed Early | F  2, scored            (rain-shortened, official)
//   Final | Postponed       | D  28, no score
//   Final | Cancelled       | C  1, no score
//   Live / Preview ...           not finished (a pre-game postseason game
//                                already shows a 0-0 score)
// "Game Over" (coded O) and "Suspended" did not occur this season; they are
// statsapi's documented states and handled the same way.
//
// COMPLETED = abstract Final, coded F (Final, Completed Early) or O (Game Over)
// when the code is present, a detailed state that starts with Final, Game
// Over or Completed Early, and never Postponed / Cancelled / Suspended.
// Scored = completed with both scores present.
//
// Lives here, beside the statsapi id rules, so the game_log repair keeps a
// single pure dependency. Used by the score fetch (services/scraper.js
// parseScoresJson), the game_log repair and its daily catch-up
// (services/game-log-repair.js refOf), and the roof correction
// (services/roof-correct.js). Before this each had
// its own rule: exactly 'Final' (which never scored a Completed Early game),
// abstract 'Final' minus Postponed/Cancelled, and an exact-string set.

const NOT_PLAYED = /^(Postponed|Cancelled|Suspended)/i;
const COMPLETED_DETAILED = /^(Final|Game Over|Completed Early)/i;
const COMPLETED_CODES = new Set(['F', 'O']);

// status: statsapi's game.status (or gameData.status from the live feed).
function isCompletedStatus(status) {
  if (!status) return false;
  const det = String(status.detailedState || '');
  if (!det || NOT_PLAYED.test(det)) return false;
  if (status.abstractGameState != null && status.abstractGameState !== 'Final') return false;
  const coded = status.codedGameState;
  if (coded != null && coded !== '' && !COMPLETED_CODES.has(String(coded))) return false;
  return COMPLETED_DETAILED.test(det);
}

const _score = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// A completed game with both scores: what may be written as a result.
function isScoredFinal(status, awayScore, homeScore) {
  return isCompletedStatus(status) && _score(awayScore) && _score(homeScore);
}

module.exports = { ABBR_NORM, normAbbr, gameIdFor, isCompletedStatus, isScoredFinal };
