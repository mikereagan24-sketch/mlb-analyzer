'use strict';

// DH-assignment guard (2026-07-28 CLE-CIN incident).
//
// The pair-plausibility check in utils/market-sanity.js catches
// STATISTICALLY impossible pairs (both dogs, implied-sum wildly off).
// It cannot catch SEMANTICALLY wrong assignments: right pair, wrong
// game_pk. That was the actual 7/28 CLE-CIN failure — Kalshi published
// only ONE cle-cin market (ticker KXMLBGAME-26JUL281910CLECIN, the
// 19:10 ET evening game) with NO "G" suffix, so kalshi.parseEventTicker
// assigned it game_number=1 (game_id=cle-cin). But statsapi's game 1
// starts at 13:40 ET; the ticker's embedded 1910 belongs to game 2.
// The odds-write path in services/jobs.js:4030 then overwrote the
// 13:40-leg's game_log row with the 19:10-leg's price. Poly (which
// correctly had both legs) was blocked from filling because Kalshi had
// already written. Result: a wrong-team-favored line rode into signal
// emission without any structural flag firing — both sources at that
// snapshot happened to agree on the wrong favorite.
//
// This guard runs at the source-write step (Kalshi/Poly → oddsRaw). It
// compares the source's ticker/event start_time against statsapi's
// game_time for the game_id the source is trying to write to. On
// mismatch beyond a 30-min tolerance, the write is REJECTED — the
// game_log row keeps its prior last-good market (via existing COALESCE
// in the UPDATE), and the odds_flag_reason is stamped with a
// DH-crossed marker for operator visibility. Downstream: signals
// auto-suppress via the null-market gate in getSignals (nothing new
// wrote, prior value may already be stale-but-honest).
//
// Tolerance: 30 min is comfortably below the typical DH-leg gap
// (usually 3-6 hours for a split doubleheader, ~30 min for a straight
// makeup DH) and comfortably above any legitimate schedule drift.
// Tighter would false-positive on statsapi placeholder start times;
// looser would fail to discriminate DH legs.

const START_MISMATCH_TOL_MIN = 30;
const RE_ET_STRING = /^(\d{1,2}):(\d{2})\s+(AM|PM)\s+ET\s*$/i;

// Parse a game_log.game_time string like "1:40 PM ET" or "10:05 AM ET"
// into minutes-of-day in ET wall-clock. Returns null on malformed input
// or when the field is missing — caller treats null as "unknown, pass".
function parseEtWallClockStringMin(s) {
  if (!s) return null;
  const m = String(s).match(RE_ET_STRING);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + mm;
}

// Parse Kalshi's 4-digit HHMM (ET wall-clock, per the embedded ticker
// convention documented in services/kalshi.js) to minutes-of-day.
function parseKalshiHhmmMin(s) {
  if (!s || String(s).length !== 4) return null;
  const h = parseInt(String(s).slice(0, 2), 10);
  const m = parseInt(String(s).slice(2, 4), 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Parse an ISO instant to minutes-of-day in ET wall-clock. Uses Intl so
// DST is handled by the platform.
function parseIsoToEtMin(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour');
  const m = parts.find(p => p.type === 'minute');
  if (!h || !m) return null;
  return parseInt(h.value, 10) * 60 + parseInt(m.value, 10);
}

// Core check. Returns null when the source's start matches the
// schedule (or when either side is missing — insufficient data, no
// mismatch to flag). Returns a short reason string on mismatch.
//
//   sourceEtMin:    minutes-of-day in ET for the SOURCE's ticker/event start
//   scheduleEtMin:  minutes-of-day in ET for statsapi's game_time
//   sourceLabel:    'kalshi' | 'polymarket' — appears in the reason text
//   gameId:         game_log game_id — appears in the reason text
function checkSourceStartMatchesSchedule(sourceEtMin, scheduleEtMin, sourceLabel, gameId) {
  if (sourceEtMin == null || scheduleEtMin == null) return null;
  const delta = sourceEtMin - scheduleEtMin;
  if (Math.abs(delta) <= START_MISMATCH_TOL_MIN) return null;
  const hhmm = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  };
  return (sourceLabel || 'source') + ' start-time mismatch for ' + gameId
    + ': ticker/event=' + hhmm(sourceEtMin) + ' ET vs schedule=' + hhmm(scheduleEtMin) + ' ET'
    + ' (Δ=' + delta + ' min, tolerance ±' + START_MISMATCH_TOL_MIN + ' min)'
    + ' — DH-crossed or wrong-leg market, write REJECTED';
}

module.exports = {
  parseEtWallClockStringMin,
  parseKalshiHhmmMin,
  parseIsoToEtMin,
  checkSourceStartMatchesSchedule,
  START_MISMATCH_TOL_MIN,
};
