'use strict';

// THE post-first-pitch pricing criterion. ONE implementation (2026-09-14).
//
// It existed three times, verbatim: scripts/post-start-exposure.js built
// the exposed set, scripts/post-start-price-change.js narrowed it to real
// movement, and scripts/tag-post-start-pricing.js copied that narrowing in
// order to write the tag. tag-post-start-pricing.js says in its own header
// that it was "derived from post-start-price-change.js so the tagging
// criterion and the measured criterion cannot drift apart" -- which is the
// right intent expressed as a copy, and a copy is what drift is made of.
// Registering the tagger as a production backfill would have made it four.
//
// WHAT THE CRITERION IS, in two steps that must not be collapsed:
//
//   1. EXPOSURE (upper bound). An ML signal with a price-affecting audit
//      event stamped after real first pitch. That counts opportunities to
//      be mispriced, not mispricings: COALESCE and the odds lock make many
//      refreshes no-ops.
//   2. MOVEMENT (the finding). Of those, the ones whose STORED line
//      differs from the last capture taken before first pitch. A 2-point
//      drift and a 40-point drift are both movement and are reported with
//      their magnitude, never collapsed into one count.
//
// AND A THIRD OUTCOME THAT IS NOT "CLEAN": a game with no pre-first-pitch
// capture to compare against. It cannot be measured either way. Left as
// NULL it reads as clean to every consumer, because every consumer filters
// `market_contamination_reason IS NULL`. That is why it gets its own
// reason rather than nothing -- see REASON_NO_PRESTART_CAPTURE.
//
// TIMEZONES (stated per the CLAUDE.md rule; this schema mixes them):
//   empirical_market_captures.generated_at -- PT. Settled a priori: the
//     'morning' capture track stamps 07:30:39, which is a morning cron in
//     PT. Read as UTC that is 00:30 PT, and nothing called "morning" runs
//     at half past midnight.
//   game_log.first_pitch_utc  -- ISO UTC from statsapi.
//   game_log.odds_locked_at   -- UTC, space-separated, hence the T/Z fixup.
//
// This module READS ONLY. The single writer is the backfill task
// services/backfill-tasks/market-contamination-post-first-pitch.js.

const PT_OFFSET_HOURS = 7;

// The two reasons this criterion can produce. Distinct on purpose: one says
// "we measured it and it moved", the other says "we could not measure it".
// Collapsing them would put an unmeasured game and a proven-bad game in the
// same bucket, and the whole point of the second value is that the reader
// can tell them apart.
const REASON_PRICED_POST_FIRST_PITCH = 'priced_post_first_pitch';
const REASON_NO_PRESTART_CAPTURE = 'no_prestart_capture';

// Audit actions that can move a stored price. 'grade' and the soft-delete
// actions cannot, so an event of that kind after first pitch is not
// exposure.
const PRICE_AFFECTING = new Set(['insert', 'refresh', 'refresh_odds_tail']);

function ptToUtcMs(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + PT_OFFSET_HOURS, +m[5], +m[6]);
}

// A stored ML that could not have been a real price is not evidence of
// movement. |ml| <= 1000 is the same bound checkOddsSanity blocks at.
function mlUsable(ml) {
  const n = Number(ml);
  return Number.isFinite(n) && n !== 0 && Math.abs(n) <= 1000;
}

// WHAT THE INSTRUMENT ACTUALLY COVERS, measured rather than remembered.
// Both scripts carried "spans 2026-06-11..2026-08-07 and 755 games" in a
// header comment; by 2026-09-14 the captures reached 09-13 and the comment
// was two months stale while still being read as current. A coverage limit
// belongs in a query, not in prose.
function captureCoverage(db) {
  const r = db.prepare(
    "SELECT COUNT(*) rows, MIN(substr(generated_at,1,10)) lo, "
    + "MAX(substr(generated_at,1,10)) hi, COUNT(DISTINCT game_date || '|' || game_id) games "
    + "FROM empirical_market_captures WHERE market_type='ml' AND away_price_ml IS NOT NULL"
  ).get();
  return { rows: r.rows || 0, from: r.lo || null, to: r.hi || null, games: r.games || 0 };
}

// Step 1: the exposed set. Keyed (game_date|game_id|signal_side) so a game
// with two exposed sides counts once per side here and once as a GAME when
// the caller reduces to games.
function exposedMlSignals(db) {
  const rows = db.prepare(
    'SELECT b.action, b.created_at, b.game_date, b.game_id, b.signal_type, b.signal_side, '
    + 'g.first_pitch_utc, g.odds_locked_at, g.market_away_ml, g.market_home_ml '
    + 'FROM bet_signal_audit b JOIN game_log g '
    + '  ON g.game_date = b.game_date AND g.game_id = b.game_id '
    + "WHERE g.first_pitch_utc IS NOT NULL AND b.signal_type = 'ML'"
  ).all();
  const exposed = new Map();
  for (const r of rows) {
    if (!PRICE_AFFECTING.has(r.action)) continue;
    const ev = ptToUtcMs(r.created_at);
    const fp = Date.parse(r.first_pitch_utc);
    if (ev == null || !Number.isFinite(fp) || ev < fp) continue;
    const ml = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
    if (ml == null || !mlUsable(ml)) continue;
    // FROZEN PRE-START IS SAFE. If the odds lock fired before first pitch
    // the stored price cannot have moved after it, whatever the audit row
    // says -- the event is a no-op refresh against a locked price.
    if (r.odds_locked_at) {
      const lk = Date.parse(String(r.odds_locked_at).replace(' ', 'T') + 'Z');
      if (Number.isFinite(lk) && lk < fp) continue;
    }
    exposed.set([r.game_date, r.game_id, r.signal_side].join('|'), r);
  }
  return exposed;
}

// Step 2: classify each exposed signal against its last pre-first-pitch
// capture. Returns three disjoint lists; their union is the exposed set.
function classifyExposed(db, exposed) {
  const lastPre = db.prepare(
    "SELECT away_price_ml a, home_price_ml h, generated_at ga FROM empirical_market_captures "
    + "WHERE market_type='ml' AND game_date=? AND game_id=? AND away_price_ml IS NOT NULL "
    + 'ORDER BY generated_at'
  );
  const sigRow = db.prepare(
    'SELECT market_line, bet_line, is_active FROM bet_signals '
    + "WHERE game_date=? AND game_id=? AND signal_type='ML' AND signal_side=? LIMIT 1"
  );
  const changed = [], noChange = [], unmeasurable = [];
  for (const [k, r] of exposed) {
    const parts = k.split('|');
    const gd = parts[0], gi = parts[1], side = parts[2];
    const fp = Date.parse(r.first_pitch_utc);
    const caps = lastPre.all(gd, gi).filter((c) => {
      const t = ptToUtcMs(c.ga);
      return t != null && t < fp;
    });
    if (!caps.length) { unmeasurable.push({ gd, gi, side, why: 'no_capture_before_first_pitch' }); continue; }
    const pre = side === 'away' ? caps[caps.length - 1].a : caps[caps.length - 1].h;
    const sr = sigRow.get(gd, gi, side);
    const stored = sr ? Number(sr.market_line) : (side === 'away' ? r.market_away_ml : r.market_home_ml);
    if (pre == null || stored == null || !Number.isFinite(Number(pre))) {
      unmeasurable.push({ gd, gi, side, why: 'capture_price_unusable' });
      continue;
    }
    const d = Number(stored) - Number(pre);
    if (d === 0) noChange.push({ gd, gi, side, pre: Number(pre), stored: Number(stored) });
    else {
      changed.push({ gd, gi, side, pre: Number(pre), stored: Number(stored), d: d,
                     active: sr ? sr.is_active : null });
    }
  }
  return { changed, noChange, unmeasurable };
}

// Reduce the classification to the GAMES each reason applies to.
//
// SCOPE OF THE no_prestart_capture REASON. Only games whose date falls
// INSIDE the measured capture coverage window. Outside it no instrument
// existed, which is a different statement from "the instrument was running
// and found nothing for this game" -- and tagging every pre-2026-06-11 game
// would silently empty the corpus of a third of the season on the strength
// of a filter that was never meant to carry that. Those games stay NULL and
// the limitation is reported, not encoded.
//
// A game with BOTH a measured move and an unmeasurable side takes the
// stronger reason: priced_post_first_pitch wins, because it is a positive
// finding about that game.
function gamesToTag(db, classified, coverage) {
  const cov = coverage || captureCoverage(db);
  const contaminated = new Set(classified.changed.map((c) => c.gd + '|' + c.gi));
  const noCapture = new Set();
  const outsideCoverage = new Set();
  for (const u of classified.unmeasurable) {
    const key = u.gd + '|' + u.gi;
    if (contaminated.has(key)) continue;
    const inside = cov.from && cov.to && u.gd >= cov.from && u.gd <= cov.to;
    (inside ? noCapture : outsideCoverage).add(key);
  }
  return { contaminated, noCapture, outsideCoverage, coverage: cov };
}

function monthCounts(keys) {
  const out = {};
  for (const k of keys) {
    const m = String(k).slice(0, 7);
    out[m] = (out[m] || 0) + 1;
  }
  return out;
}

module.exports = {
  PT_OFFSET_HOURS,
  PRICE_AFFECTING,
  REASON_PRICED_POST_FIRST_PITCH,
  REASON_NO_PRESTART_CAPTURE,
  ptToUtcMs,
  mlUsable,
  captureCoverage,
  exposedMlSignals,
  classifyExposed,
  gamesToTag,
  monthCounts,
};
