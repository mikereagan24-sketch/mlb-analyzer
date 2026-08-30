'use strict';

// wOBA-scale park factors for input neutralization (feat/park-neutral-inputs).
//
// Distinct from the RUN-scale factors in park_factors.factor, which
// multiply the aTeamWoba × RUN_MULT product at game time in
// services/model.js runModel. Run-scale factors run 0.85 (SEA) to 1.25
// (COL); wOBA-scale factors are compressed because wOBA has less variance
// than raw runs.
//
// THE COMPRESSION RATIO IS 0.50, NOT 0.60-0.80. (corrected 2026-08-30)
// This header claimed 0.60-0.80 "park-dependent" on the basis of
// approximation. Measured against Savant's own two indices across all 29
// listed parks:
//
//   index_woba = 1 + (index_runs - 1) * 0.497     mean |err| 0.0005
//
// Near-deterministic, not park-dependent. services/park-factors.js exports
// it as WOBA_FROM_RUN_K and uses it to derive the ATH manual override,
// which has no Savant venue row.
//
// SOURCE, since 2026-08-30: park_factors.woba_factor, read from Savant's
// index_woba in the same pull as the run factor. See getWobaParkFactor.
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
// HISTORICAL, and the reason this was replaced. The literal below was
// described as "FanGraphs 5-year rolling wOBA park factors", but the
// values were approximations calibrated so a set of expected spot-checks
// held — COL down ~4-5%, SEA/SD up ~2%, league-average parks unchanged.
// A table fitted to expectations rather than measured, carrying a comment
// that named a source it did not come from, with no timestamp and no way
// for the freshness check to see it. That is the same shape as the
// PARK_FACTORS literal replaced on 2026-08-25, and it survived that work
// because nobody grepped for a second copy.
//
// Measured against Savant index_woba on 2026-08-30, the fitted values were
// off by a mean of 0.0207, with TEX and CHC on the WRONG SIDE of neutral.
//
// Keys must match the team abbreviations services/scraper.js produces.

// FROZEN FALLBACK -- DO NOT EDIT. Superseded 2026-08-30 by
// park_factors.woba_factor. Retained only so a cold table degrades to the
// previous behaviour instead of to 1.00, which would silently switch
// neutralization off. Its worst errors against the sourced values were
// TEX +0.09 and CHC +0.06 -- both the WRONG SIGN -- which is what a table
// fitted to expected spot-checks rather than measured produces.
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
// TABLE FIRST, LITERAL AS FALLBACK. (2026-08-30)
//
// park_factors.woba_factor comes from Savant's index_woba, in the same
// pull, row and pulled_at as the run factor -- so it inherits the monthly
// cron, the boot assertion and the freshness entry that the literal below
// could never have, being a literal.
//
// The literal stays as a last resort for a cold table (fresh clone, boot
// before the first pull) rather than being deleted, because returning 1.00
// there would silently disable neutralization instead of degrading it. It
// is NOT a maintained source and should not be edited; see the header.
//
// Cached per process. The table changes monthly and every batter and
// pitcher lookup calls this, so a query per call would be thousands of
// reads per rescore for a value that moves four times a year.
let _wobaCache = null;
function _loadWobaFactors() {
  if (_wobaCache) return _wobaCache;
  try {
    const { q } = require('../db/schema');
    const rows = q.listParkFactors.all();
    const m = {};
    for (const r of rows) if (r.woba_factor != null) m[r.team] = r.woba_factor;
    // Only trust the table if it actually covers the league. A partial
    // table mixed with literal fallbacks is harder to reason about than
    // either source alone.
    _wobaCache = Object.keys(m).length >= 30 ? m : null;
  } catch (e) {
    _wobaCache = null;   // table not built yet
  }
  return _wobaCache;
}

function getWobaParkFactor(teamAbbr) {
  if (!teamAbbr) return 1.00;
  const key = String(teamAbbr).toUpperCase();
  const tbl = _loadWobaFactors();
  if (tbl && tbl[key] != null) return tbl[key];
  return WOBA_PARK_FACTORS[key] != null ? WOBA_PARK_FACTORS[key] : 1.00;
}

// TEST SEAM, for A/B measurement only. Not used in production.
//
// services/model.js DESTRUCTURES getWobaParkFactor at require time
// (`const { getWobaParkFactor } = require(...)`), so reassigning the
// module export does NOT change what the model calls. An A/B that swaps
// the export therefore compares two identical runs and reports that
// nothing moved -- which reads exactly like "the change is safe" and is
// the same failure as an instrument that is not wired to what it claims
// to measure.
//
// Overriding the CACHE works because getWobaParkFactor reads it on every
// call, so the substitution reaches the model through the live path
// rather than around it. Pass null to restore normal loading.
function __setWobaFactorsForTest(map) {
  _wobaCache = map;
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

// PA/TBF-weighted park factor for multi-team players
// (fix/park-neutral-stint-weighted). teamMap is a Map<team_abbr,
// weight> — for batters, weight is games in that team's lineup; for
// pitchers, TBF summed across appearances for that team. Returns
// null when the player is single-team (Map.size <= 1) or when there
// is no stint data, letting the caller fall back to the current-team
// factor (v1 behavior — documented in resolveNeutralizationFactor).
//
// Formula: sum(weight_i * parkFactor(team_i)) / sum(weight_i).
// Standard PA-weighted average — matches the audit fix's math.
// Example: 200 PA at COL (1.10) + 100 PA at LAD (1.00) →
//   (200*1.10 + 100*1.00) / 300 = 1.0667
// That's between the two extremes, correctly reflecting that ~2/3
// of the actuals sample came from the extreme park.
function computeStintWeightedFactor(teamMap) {
  if (!teamMap || typeof teamMap.entries !== 'function') return null;
  if (teamMap.size <= 1) return null;   // single-team: caller falls back
  let sumWeighted = 0;
  let sumWeights = 0;
  for (const [team, weight] of teamMap.entries()) {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) continue;
    const f = getWobaParkFactor(team);
    sumWeighted += w * f;
    sumWeights  += w;
  }
  if (sumWeights <= 0) return null;
  return sumWeighted / sumWeights;
}

module.exports = {
  WOBA_PARK_FACTORS,
  getWobaParkFactor,
  neutralizeWoba,
  computeStintWeightedFactor,
  __setWobaFactorsForTest,
};
