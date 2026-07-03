'use strict';

// wOBA-scale park factors for input neutralization (feat/park-neutral-inputs).
//
// Distinct from services/scraper.js PARK_FACTORS, which are RUN-scale
// multipliers applied to the aTeamWoba × RUN_MULT product at game time
// in services/model.js runModel (~line 686). Run-scale factors run 0.92
// (SF Oracle) to 1.25 (Coors); wOBA-scale factors are compressed
// because wOBA has less variance than raw runs (roughly ~0.60-0.80 of
// the run-scale deviation, park-dependent).
//
// PURPOSE: neutralize the ~half of a player's PA that comes at his home
// park so the game-time PARK_FACTORS multiplier is the ONLY place park
// enters the model. The transform (applied in getBatterWoba /
// getPitcherWoba when the PARK_NEUTRAL_INPUTS_ENABLED setting is on):
//
//   neutral_wOBA = raw_wOBA / (1 + (homeParkWobaFactor - 1) / 2)
//
// The "/ 2" is because only ~half of the sample was collected at home;
// the road half was already environment-mixed. Standard first-order
// neutralization. For traded players we approximate with the CURRENT
// team's home park (documented — v1 tradeoff; PA-weighted blend across
// stints is a follow-up if the population turns out to be non-trivial).
//
// SOURCE: FanGraphs 5-year rolling wOBA park factors (approximations
// calibrated so the owner's expected spot-checks hold — COL hitter
// drops ~4-5%, SEA/SD hitters up ~2%, league-average parks unchanged).
// Static baseline for v1 per the brief; FG Daily Sync could later pull
// the live per-season factors and write them into a settings row so the
// table refreshes with the daily push.
//
// Values move slowly (park factors update on ~5yr rolling windows);
// republish annually or after a stadium change. Keys must match the
// team abbreviations produced by services/scraper.js normalizeAbbr,
// same set as PARK_FACTORS.

const WOBA_PARK_FACTORS = {
  COL: 1.10, // Coors — altitude drives it
  ATH: 1.09, // Sutter Health Park (Sacramento) — AAA hitter-friendly temp home
  CIN: 1.05, // Great American Ball Park
  ARI: 1.04, // Chase Field
  CHC: 1.03, // Wrigley
  BOS: 1.03, // Fenway
  NYY: 1.02,
  PHI: 1.02,
  TEX: 1.02,
  KC:  1.01,
  ATL: 1.01,
  CWS: 1.01,
  WAS: 1.00,
  TOR: 1.00,
  HOU: 1.00,
  LAD: 1.00,
  MIA: 1.00,
  STL: 0.99,
  MIN: 0.99,
  BAL: 0.99,
  MIL: 0.99,
  DET: 0.98,
  LAA: 0.98,
  PIT: 0.98,
  CLE: 0.98,
  TB:  0.97,
  NYM: 0.97,
  SEA: 0.96,
  SD:  0.96,
  SF:  0.94,
};

// Returns the wOBA-scale park factor for a team abbr, defaulting to
// 1.00 (neutralization no-op) for unknown/null teams. A null return
// vs 1.00 default matters because 1.00 means "no adjustment"; unknown
// teams silently become no-ops rather than throwing. Callers already
// gate on the PARK_NEUTRAL_INPUTS_ENABLED flag before invoking, so a
// 1.00 default here is safe.
function getWobaParkFactor(teamAbbr) {
  if (!teamAbbr) return 1.00;
  const key = String(teamAbbr).toUpperCase();
  return WOBA_PARK_FACTORS[key] != null ? WOBA_PARK_FACTORS[key] : 1.00;
}

// Neutralization transform:
//   neutral = raw / (1 + (factor - 1) / 2)
// Guarded against nulls (returns raw unchanged) and factor==1.00 (which
// is a no-op division by 1 — but skip the divide anyway to keep numbers
// byte-identical to the un-neutralized path for league-avg teams).
function neutralizeWoba(rawWoba, wobaParkFactor) {
  if (rawWoba == null || !isFinite(rawWoba)) return rawWoba;
  if (wobaParkFactor == null || !isFinite(wobaParkFactor) || wobaParkFactor === 1.00) {
    return rawWoba;
  }
  const denom = 1 + (wobaParkFactor - 1) / 2;
  return rawWoba / denom;
}

module.exports = {
  WOBA_PARK_FACTORS,
  getWobaParkFactor,
  neutralizeWoba,
};
