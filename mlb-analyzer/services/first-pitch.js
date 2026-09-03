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

// MEASURED 2026-09-03 against gamePk 824636:
//
//   feed/live FULL            780.1 KB
//   feed/live ?fields=          0.1 KB   (149 bytes)
//
// We JSON.parsed 780 KB -- every play of the game -- to read three
// fields. statsapi HONOURS ?fields= on v1.1/feed/live, verified before
// relying on it, returning exactly the three subtrees.
//
// There is no lighter endpoint that carries firstPitch at all. Also
// measured: v1 boxscore 167 KB (no firstPitch, matching the note above),
// v1 linescore 3.1 KB (no), feed/live/timestamps 8.6 KB (no), and
// v1 schedule+hydrate 1.6 KB (status yes, firstPitch NO). feed/live is
// the only door -- it was just the wrong-sized door.
const FEED_FIELDS = 'gameData,datetime,dateTime,gameInfo,firstPitch,status,detailedState';
const FEED_URL = pk => 'https://statsapi.mlb.com/api/v1.1/game/' + pk
  + '/feed/live?fields=' + FEED_FIELDS;
const FEED_URL_FULL = pk => 'https://statsapi.mlb.com/api/v1.1/game/' + pk + '/feed/live';

// If statsapi ever stops honouring ?fields=, the response silently
// becomes the full document again and we are back to a 780 KB parse per
// call on a 512MB instance. So the parse is SIZE-GATED: anything over
// this is not parsed as an object graph at all.
const FEED_MAX_PARSE_BYTES = 64 * 1024;

// Statuses meaning "the ball is in play or the game is over". Anything
// here means a market quote is NOT a pre-game price.
const LIVE_OR_DONE = new Set([
  'In Progress', 'Final', 'Game Over', 'Completed Early',
  'Suspended', 'Delayed Start', 'Delayed', 'Manager Challenge',
]);

// Pull the three fields out of raw text WITHOUT building an object graph.
// Used only when the body is too large to trust -- i.e. when ?fields= was
// ignored. Scans the string; allocates three small matches, not a parsed
// document. Deliberately narrow: these keys appear once each in the
// gameData subtree, and a miss returns null, which callers already treat
// as 'unknown' rather than as 'not started'.
function _extractFromRaw(text) {
  // indexOf finds the quoted KEY; the value begins immediately after the
  // key's closing quote, so the match starts at `:` -- NOT at another
  // quote. The first version sliced past the closing quote and then asked
  // for a leading `"` anyway, so it matched the following key/value pair
  // and returned truncated garbage ("2026-08-30", "F", null). Caught by
  // diffing against a real 780 KB parse, which is the only way this kind
  // of off-by-one shows itself.
  const pick = key => {
    const needle = '"' + key + '"';
    const i = text.indexOf(needle);
    if (i < 0) return null;
    const m = /^s*:s*"([^"]*)"/.exec(text.slice(i + needle.length, i + needle.length + 96));
    return m ? m[1] : null;
  };
  return {
    dateTime: pick('dateTime'),
    firstPitch: pick('firstPitch'),
    detailedState: pick('detailedState'),
  };
}
function _get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => {
        // SIZE GATE. A fields-filtered response is ~149 bytes. Anything
        // over FEED_MAX_PARSE_BYTES means the filter was not applied, and
        // parsing it would reintroduce the allocation this exists to
        // remove. Extract from raw text instead and flag it.
        if (b.length > FEED_MAX_PARSE_BYTES) {
          const raw = _extractFromRaw(b);
          console.warn('[first-pitch] response was ' + (b.length / 1024).toFixed(0)
            + ' KB (expected <1 KB) -- ?fields= appears to be ignored;'
            + ' extracted from raw text without parsing.');
          return resolve({ _fromRaw: true, gameData: {
            datetime: { dateTime: raw.dateTime },
            gameInfo: { firstPitch: raw.firstPitch },
            status: { detailedState: raw.detailedState },
          } });
        }
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

module.exports = { fetchFirstPitch, hasStarted, LIVE_OR_DONE, FEED_URL,
  // Test seams. The raw extractor is the fallback that runs only when
  // ?fields= stops being honoured, so it is the path least likely to be
  // exercised in production and most likely to rot -- it needs a test.
  FEED_URL_FULL, FEED_MAX_PARSE_BYTES, _extractFromRaw };
