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

// Sealed-dome venue_ids — the six RETRACTABLES that seal when closed.
// Consumed by services/backfill-tasks/weather-backfill-season.js to
// decide whether a temp-bucket crossing is "material" (a crossing at a
// sealed-closed game can't matter; the temp is gated away anyway).
//
// IMPORTANT: this is an enumeration of retractable parks, NOT a
// registry of every sealed venue. Tropicana Field (12) is a fixed dome
// and is not in here. Do not invert this set to mean "unsealed" — see
// UNSEALED_ROOF_VENUE_IDS below, which is the allowlist that actually
// gates temperature.
//   15   ARI Chase Field
//   2392 HOU Daikin Park
//   5325 TEX Globe Life Field
//   4169 MIA loanDepot park
//   14   TOR Rogers Centre
//   32   MIL American Family Field  (membership VERIFIED 2026-08-20
//        against 67 closed games — statsapi game-time temp runs +10.0F
//        median over ERA5 outdoor, vs +0.2F at canopy-roofed SEA. Its
//        wide 57-86F reported range is loose climate control, not an
//        open park. docs/mil-sealed-dome-classification-2026-08-20.md)
const SEALED_DOME_VENUE_IDS = new Set([15, 2392, 5325, 4169, 14, 32]);

// Venues whose roof is a CANOPY over an open-sided park rather than a
// seal. Closed at one of these → temp_run_adj survives the roof gate
// at full strength (weather.js:roofChannelMults reads this set, and it
// is the only thing that lifts the temp gate).
//
// SEA (680) T-Mobile Park: the roof covers the field but the park stays
// open at the sides, so ambient temperature reaches the field.
// Measured over 50 closed SEA games spanning 2023-2026, statsapi
// game-time temp minus ERA5 outdoor reanalysis at the same park-local
// hour is +0.2F median on closed games against +0.3F on the 255 open
// games — a closed SEA game is thermally outdoors.
//
// This is an explicit ALLOWLIST and must stay one. The earlier draft of
// the per-channel gate derived "unsealed" as "absent from
// SEALED_DOME_VENUE_IDS", which silently swept in 19 closed Tropicana
// Field rows (a fixed dome, never in that set) plus 7 rows carrying a
// NULL venue_id, and would have handed climate-controlled buildings
// full outdoor temp adjustment. Anything not listed here is treated as
// sealed (temp x0) — identical to pre-2026-08-20 behavior, so an
// unrecognized or NULL venue_id fails safe.
//
// NOTE this set does NOT gate wind. Wind is zeroed for every closed
// game, canopy or not, because the unsealed-closed wind multiplier is
// not measurable from available data: statsapi reports 0 mph on 70% of
// closed SEA games while ERA5 shows 8.1 mph median outdoors at the same
// hour, so those zeros are nulls rather than readings. Read
// docs/unsealed-roof-wind-multiplier-open-question-2026-08-20.md before
// putting a number there.
const UNSEALED_ROOF_VENUE_IDS = new Set([680]);

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

// True only for venues explicitly listed as canopy-over-open-park.
// Number(null) === 0 and Number(undefined) === NaN, neither of which is
// in the set, so a missing venue_id fails safe to "sealed".
function isUnsealedRoof(venueId) {
  return UNSEALED_ROOF_VENUE_IDS.has(Number(venueId));
}

module.exports = {
  SEALED_DOME_VENUE_IDS,
  UNSEALED_ROOF_VENUE_IDS,
  rollForwardPrior,
  isSealedDome,
  isUnsealedRoof,
  TOR_OPEN_FROM_MONTH_DAY,
};
