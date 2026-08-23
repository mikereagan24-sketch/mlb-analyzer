'use strict';
/**
 * Real first-pitch timestamps from statsapi. (2026-08-22)
 *
 * WHY THIS EXISTS. game_log.game_time is a display string ("2:10 PM ET").
 * It has no date, no timezone offset that survives arithmetic, and it is
 * the SCHEDULED time -- it does not move when a game is delayed. Any
 * before/after comparison against it is a string comparison that silently
 * succeeds and means nothing.
 *
 * That is not hypothetical: on 2026-08-22 a post-start exposure analysis
 * compared `created_at.slice(11,16)` against `game_time.slice(11,16)`.
 * The latter is "" for a 10-character display string, so every same-date
 * event compared as "after". It produced a confident 100%-after result
 * and a 15-20% exposure table, both meaningless.
 *
 * WHAT statsapi PROVIDES, verified against pk=824804 (2026-08-06 laa-bal):
 *   gameData.datetime.dateTime      = 2026-08-06T16:35:00Z   (scheduled)
 *   gameData.gameInfo.firstPitch    = 2026-08-06T16:36:00.000Z  (ACTUAL)
 *   gameData.status.detailedState   = Final
 * Corroborated by liveData.plays.allPlays[0].about.startTime =
 * 2026-08-06T16:36:33Z, one minute after scheduled.
 *
 * firstPitch is on the v1.1 feed/live endpoint under gameData.gameInfo.
 * It is NOT on the v1 boxscore endpoint (checked: undefined there), and
 * it is absent until the game actually begins -- which is precisely the
 * property that makes it correct. A game that has not started has no
 * first pitch, and callers must fall back to scheduled + buffer.
 */

const https = require('https');

const FEED_URL = pk => 'https://statsapi.mlb.com/api/v1.1/game/' + pk + '/feed/live';

// Statuses meaning "the ball is in play or the game is over". Anything
// here means a market quote is NOT a pre-game price.
const LIVE_OR_DONE = new Set([
  'In Progress', 'Final', 'Game Over', 'Completed Early',
  'Suspended', 'Delayed Start', 'Delayed', 'Manager Challenge',
]);

function _get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad JSON (' + b.length + ' bytes)')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * Fetch {scheduled_start_utc, first_pitch_utc, game_status} for one gamePk.
 * Returns nulls rather than throwing on a missing field -- a game that has
 * not started legitimately has no firstPitch.
 */
async function fetchFirstPitch(gamePk, opts) {
  const j = await _get(FEED_URL(gamePk), (opts && opts.timeoutMs));
  const gd = (j && j.gameData) || {};
  const dt = gd.datetime || {};
  const gi = gd.gameInfo || {};
  const st = gd.status || {};
  return {
    scheduled_start_utc: dt.dateTime || null,
    first_pitch_utc: gi.firstPitch || null,
    game_status: st.detailedState || null,
  };
}

/**
 * Has this game started, as of `nowIso`?
 *
 * Precedence, and the order matters:
 *   1. first_pitch_utc  -- authoritative, and reflects delays.
 *   2. game_status      -- covers the window after the ball is in play but
 *                          before firstPitch has been written to our row.
 *   3. scheduled + buffer -- last resort, and the reason the buffer exists.
 *
 * NEVER falls back to game_time. Returns null when nothing usable is
 * known, so callers can distinguish "not started" from "cannot tell" --
 * a guard should treat null as unsafe, not as permission.
 */
function hasStarted(row, nowIso, bufferMinutes) {
  if (!row) return null;
  const now = Date.parse(nowIso || new Date().toISOString());
  if (!Number.isFinite(now)) return null;

  if (row.first_pitch_utc) {
    const fp = Date.parse(row.first_pitch_utc);
    if (Number.isFinite(fp)) return now >= fp;
  }
  if (row.game_status && LIVE_OR_DONE.has(String(row.game_status))) return true;
  if (row.scheduled_start_utc) {
    const sc = Date.parse(row.scheduled_start_utc);
    if (Number.isFinite(sc)) return now >= (sc - (Number(bufferMinutes) || 0) * 60000);
  }
  return null;
}

module.exports = { fetchFirstPitch, hasStarted, LIVE_OR_DONE, FEED_URL };
