'use strict';

// Per-park forward roof priors + sealed-dome classification.
//
// Used by runWeatherJob ONLY when no announced/actual status is in-DB
// yet (the pre-game window). Precedence is actual > announced > prior,
// enforced by the caller's order-of-application.
//
// Empirically verified against statsapi for the Apr-Jun 2026 season
// (130 games across all 7 retractable parks). These are observed
// frequencies, not assumptions.
//
// One file owns BOTH the sealed-dome gate (used by the weather-
// neutralization branch in runWeatherJob) and the prior rule (used
// by the fallback branch). Keeping them co-located prevents drift —
// SEA's prior says "default open" and its sealed-dome status says
// "don't neutralize even when closed"; both facts come from the same
// place.

// Sealed-dome venue_ids — when roof_status='closed' at one of these,
// runWeatherJob should zero effTemp and effWind. SEA (680) is
// deliberately ABSENT: its roof covers but doesn't seal, so closed
// SEA games still report real wind and outside-matching temps.
//   15   ARI Chase Field
//   2392 HOU Daikin Park
//   5325 TEX Globe Life Field
//   4169 MIA loanDepot park
//   14   TOR Rogers Centre
//   32   MIL American Family Field
const SEALED_DOME_VENUE_IDS = new Set([15, 2392, 5325, 4169, 14, 32]);

// Toronto's seasonal flip. Verified empirically: closed through
// roughly May 24, opens after as the cold breaks. This is a rough
// heuristic, not a precise source — a real cutoff would need
// game-by-game lookups, which the post-game corrector handles for
// completed games anyway. The forward prior just needs to be the
// right side of the line for pre-game scoring.
const TOR_OPEN_FROM_MONTH_DAY = '05-25';  // first date prior flips to open

// rollForwardPrior(venueId, gameDate) → { status, confidence } | null
//   status: 'open' | 'closed'
//   confidence: 'estimated' (priors are below announced; if a later
//               ingest produces announced/actual, that wins)
//   Returns null for venues without a prior rule (caller falls
//   through to its existing default-open behavior).
function rollForwardPrior(venueId, gameDate) {
  const vid = Number(venueId);
  switch (vid) {
    // ARI: keep existing scraper-driven path. No prior here — the
    // ARI ingest writes announced rows; if it failed for a game,
    // falling through to default-open is the same behavior as
    // pre-stage-2, preserved.
    case 15:   return null;

    // HOU: 100% closed across the Apr-Jun sample.
    case 2392: return { status: 'closed', confidence: 'estimated' };
    // TEX: ~89% closed.
    case 5325: return { status: 'closed', confidence: 'estimated' };
    // MIA: ~100% closed.
    case 4169: return { status: 'closed', confidence: 'estimated' };

    // TOR: seasonal — closed through ~May 24, open after.
    case 14: {
      const mmdd = String(gameDate || '').slice(5, 10);  // "MM-DD"
      if (mmdd && mmdd < TOR_OPEN_FROM_MONTH_DAY) {
        return { status: 'closed', confidence: 'estimated' };
      }
      return { status: 'open', confidence: 'estimated' };
    }

    // MIL: ~50% toss-up. Pick closed as the prior because the
    // sealed-dome neutralization protects us from over-attributing
    // weather to a closed game we mis-prior'd as open — under-
    // attributing weather (prior says closed, actually open) is the
    // softer error. The post-game corrector self-heals either way.
    case 32:   return { status: 'closed', confidence: 'estimated' };

    // SEA: default open. The corrector will overwrite with actual
    // when the game finishes. When SEA IS closed, runWeatherJob does
    // NOT neutralize (SEA is not in SEALED_DOME_VENUE_IDS).
    case 680:  return { status: 'open', confidence: 'estimated' };

    default:   return null;
  }
}

function isSealedDome(venueId) {
  return SEALED_DOME_VENUE_IDS.has(Number(venueId));
}

module.exports = {
  SEALED_DOME_VENUE_IDS,
  rollForwardPrior,
  isSealedDome,
  TOR_OPEN_FROM_MONTH_DAY,
};
