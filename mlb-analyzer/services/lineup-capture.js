/**
 * Same-day / next-day lineup capture. (2026-08-26)
 *
 * THE PROBLEM THIS SOLVES IS STORAGE, NOT FETCHING. Same-day lineups have
 * been fetched all season -- runLineupJob(todayStr()) fires nine times a
 * day (8AM, noon-6PM hourly, 11PM PT). They were never stored, because
 * game_log's projected snapshot is written through COALESCE and the 8PM PT
 * tomorrow-slate prefetch always claims the slot first. Measured on the
 * corpus: 1586 of 1588 rows carrying proj_lineup_captured_at are next-day,
 * exactly 2 are same-day, median lead 32.2h.
 *
 * So the same-day-vs-next-day question is NOT recoverable historically,
 * and it becomes answerable the day this starts writing.
 *
 * HORIZON IS DERIVED HERE, AT FETCH TIME, AND STORED.
 *
 * It is computed from the requested date against the America/New_York
 * calendar date -- the same classifyDate the scraper uses to choose the
 * URL, so the stored horizon and the page actually fetched cannot drift
 * apart. Reconstructing it downstream from capture_time vs game_date would
 * be a guess: an 11PM PT same-day pull and a 1AM ET next-day pull sit hours
 * apart on opposite sides of the boundary, and DST moves the boundary twice
 * a year. This repo has already paid for one remembered-filter-instead-of-a-
 * column (the park-factor regime); this is the same shape.
 *
 * lead_minutes is stored alongside, not instead. horizon is which page was
 * fetched; lead_minutes is how close to start it was. They are different
 * questions and the analysis needs both -- a 6PM PT same-day pull for a
 * 4PM ET game has a negative lead, and that capture is a record, not a
 * forecast.
 *
 * THE ANCHOR FOR THAT LEAD IS scheduled_start_utc, NOT first_pitch_utc.
 * first pitch does not exist until the game begins; statsapi returns null
 * for a scheduled game. Since every capture is pre-game by construction, a
 * lead measured only against first pitch would be NULL on exactly the rows
 * the analysis is built from -- and unbackfillable, because the value did
 * not exist at the moment the row describes. See pickAnchor.
 */
const SOURCE_ROTOWIRE = 'rotowire';

// The database is INJECTABLE, defaulting to the app's. Same pattern as
// utils/prune-missing.js and for the same reason: a test that writes rows
// must be able to write them somewhere other than data/mlb.db. Requiring
// db/schema lazily also keeps this module importable by scripts that only
// want horizonFor/leadMinutes without opening the database.
let _schema = null;
const appDb = () => (_schema || (_schema = require('../db/schema'))).db;

const _stmts = new WeakMap();
function stmtsFor(db) {
  let s = _stmts.get(db);
  if (!s) {
    s = {
      insert: db.prepare(
        'INSERT OR IGNORE INTO lineup_captures (game_date,game_id,source,horizon,capture_time,side,'
        + ' lineup_json,lineup_status,sp_name,sp_hand,hand_source,n_slots,page_has_started,'
        + ' lead_minutes,lead_anchor,scheduled_start_utc,first_pitch_utc)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      anchors: db.prepare('SELECT scheduled_start_utc, first_pitch_utc FROM game_log WHERE game_date=? AND game_id=?'),
    };
    _stmts.set(db, s);
  }
  return s;
}

// Same classification the scraper uses to pick the URL. Kept as its own
// function rather than imported because scraper.js does not export it and
// widening that module's surface for one caller is worse than eight lines
// that are verified against it by scripts/test-lineup-capture.js.
function horizonFor(dateStr, nowMs) {
  const now = nowMs != null ? new Date(nowMs) : new Date();
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const t = new Date(now.getTime() + 86400000);
  const tomorrowET = t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (dateStr === todayET) return 'same_day';
  if (dateStr === tomorrowET) return 'next_day';
  return null;                    // past or 2+ days out -- not a capture horizon
}

function leadMinutes(anchorUtc, captureIso) {
  if (!anchorUtc) return null;
  const a = Date.parse(anchorUtc), cap = Date.parse(captureIso);
  if (!isFinite(a) || !isFinite(cap)) return null;
  return Math.round((a - cap) / 60000);
}

// Pick the lead anchor from what EXISTS AT CAPTURE TIME.
//
// first_pitch_utc is null for any game that has not begun -- statsapi
// returns it that way, verified 2026-08-26 on a scheduled game. Every
// capture is pre-game by construction, so preferring first pitch and
// stopping there would put NULL on precisely the rows the analysis needs,
// and no later backfill could repair it: the value did not exist at the
// moment the row describes.
//
// first_pitch still wins WHEN PRESENT, because a capture taken during a
// rain delay should measure against when play actually started, and that
// is also what makes a post-start capture show a negative lead.
function pickAnchor(scheduledUtc, firstPitchUtc) {
  if (firstPitchUtc) return { at: firstPitchUtc, anchor: 'first_pitch' };
  if (scheduledUtc) return { at: scheduledUtc, anchor: 'scheduled' };
  return { at: null, anchor: null };
}

/**
 * Persist one parsed slate. Append-only and idempotent: the primary key
 * includes capture_time, and the insert is OR IGNORE, so re-running a job
 * for the same date cannot double-count and cannot overwrite.
 *
 * @param games      parseLineupsHtml output
 * @param dateStr    the slate date requested
 * @param capturedAt ISO string from fetchLineupsRaw -- the time the FETCH
 *                   returned, not the time the write happens. Those differ
 *                   by however long parsing and upserts took, and the fetch
 *                   time is the one that describes the data.
 */
function captureSlate(games, dateStr, capturedAt, opts) {
  opts = opts || {};
  const source = opts.source || SOURCE_ROTOWIRE;
  const horizon = opts.horizon || horizonFor(dateStr, opts.nowMs);
  const out = { horizon, written: 0, skipped: 0, started: 0, noAnchor: 0, reason: null };

  if (!horizon) { out.reason = 'not_a_capture_horizon'; return out; }
  if (!Array.isArray(games) || !games.length) { out.reason = 'no_games'; return out; }

  const capture_time = capturedAt || new Date().toISOString();

  // Both anchors are copied in at capture time so the row stays
  // reproducible even if game_log is later corrected -- and so the
  // scheduled time recorded here is the one that was actually knowable,
  // not a value revised after a postponement.
  const db = opts.db || appDb();
  const st = stmtsFor(db);

  const write = db.transaction(rows => {
    for (const r of rows) st.insert.run(...r);
  });

  const rows = [];
  for (const g of games) {
    if (!g || !g.game_id) { out.skipped++; continue; }
    let sched = null, fp = null;
    try {
      const row = st.anchors.get(dateStr, g.game_id);
      if (row) { sched = row.scheduled_start_utc || null; fp = row.first_pitch_utc || null; }
    } catch (e) { sched = null; fp = null; }
    const a = pickAnchor(sched, fp);
    const lead = leadMinutes(a.at, capture_time);
    if (a.anchor == null) out.noAnchor++;
    const started = g.page_has_started ? 1 : 0;
    if (started) out.started++;

    for (const [side, lineup, sp] of [
      ['away', g.away_lineup, g.away_sp],
      ['home', g.home_lineup, g.home_sp],
    ]) {
      const arr = Array.isArray(lineup) ? lineup : [];
      // A block with zero players is a real state on both pages (the slate
      // is published before the card fills in). It is written, with
      // n_slots=0, because "we looked and there was nothing" is data --
      // coverage is one of the five metrics and it cannot be computed from
      // rows that were never inserted.
      rows.push([
        dateStr, g.game_id, source, horizon, capture_time, side,
        JSON.stringify(arr),
        g.lineup_status || null,
        sp && sp.name ? sp.name : null,
        sp && sp.hand ? sp.hand : null,
        // RotoWire prints the batter's hand in the lineup cell, so
        // handedness here is source-supplied. The flag exists for the
        // second source that may not, and for the roster-fallback path if
        // one is ever added -- specced in
        // docs/lineup-source-recon-2026-08-23.md, populated honestly today.
        arr.length ? 'source' : null,
        arr.length,
        started,
        lead,
        a.anchor,
        sched,
        fp,
      ]);
    }
  }

  write(rows);
  out.written = rows.length;
  return out;
}

module.exports = { captureSlate, horizonFor, leadMinutes, pickAnchor, SOURCE_ROTOWIRE };
