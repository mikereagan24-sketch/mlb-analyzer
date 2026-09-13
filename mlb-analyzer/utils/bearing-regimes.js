'use strict';

// Parks whose PARKS.cfDir has changed, and when. (2026-09-12)
//
// WHY THIS IS A MODULE AND NOT A LIST IN A TEST. game_log.wind_factor is
// persisted at scrape time, so a row written before its park's bearing
// moved holds a factor the current code cannot reproduce. That makes every
// bearing change a REGIME BOUNDARY in the wind channel, the same shape as
// the park_factor_source boundary CLAUDE.md documents — and unlike park
// factors there is no wind_factor_source column, so the only way to spot
// such a row is to re-derive it and see that it differs.
//
// Any check that re-derives stored wind needs this list to know which
// mismatches are regime artifacts rather than code defects. It was
// hardcoded in two test files before batch 4a; adding a third copy is how
// these drift apart, so it lives here once.
//
// Batch dates are the day the bearing LANDED, and the boundary is
// INTRA-DAY — a row written at 17:00 PT on the cutover day can still carry
// the old bearing. Filter on the row, not on the date.

const BEARING_REGIMES = [
  // batch 2, 2026-08-11 — 9 parks off the placeholder, plus chc refined
  { batch: '2', date: '2026-08-11',
    parks: ['phi', 'kan', 'kc', 'det', 'cle', 'nyy', 'bal', 'was', 'cin', 'ath', 'oak', 'chc'] },
  // batch 3, 2026-08-18 — the remaining open-air parks
  { batch: '3', date: '2026-08-18',
    parks: ['nym', 'min', 'atl', 'col', 'lad', 'laa', 'sd'] },
  // batch 4a, 2026-09-12 — the two retractables that play open most often.
  // sea 45 -> 48 (3 degrees, flips nothing); mil 45 -> 128 (83 degrees,
  // flips the sign on 5 of its 19 roof-open windy games).
  { batch: '4a', date: '2026-09-12', parks: ['sea', 'mil'] },
];

// Flat set, for "is a mismatch at this park explainable as a regime
// artifact?" Note batch 2 is included for completeness even though its
// rows predate the corpus most checks look at.
const BEARING_REGIME_PARKS = new Set(
  BEARING_REGIMES.reduce((acc, r) => acc.concat(r.parks), []));

function regimeFor(parkKey) {
  const k = String(parkKey || '').toLowerCase();
  for (const r of BEARING_REGIMES) if (r.parks.indexOf(k) > -1) return r;
  return null;
}

module.exports = { BEARING_REGIMES, BEARING_REGIME_PARKS, regimeFor };
