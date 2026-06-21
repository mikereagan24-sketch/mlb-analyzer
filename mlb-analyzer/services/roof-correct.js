'use strict';

// Universal post-game roof corrector (Node, runs on Render).
//
// Port of scripts/correct_roof_actual.py. For COMPLETED games at any
// retractable-roof park, reads actual roof state from statsapi's
// gameData.weather.condition and writes roof_status +
// roof_confidence='actual'. Ground truth for the historical record;
// also self-corrects any wrong forward prior or 'announced' value
// (a manager surprise-closes the roof, etc.).
//
// Mirrors the Python's behavior exactly:
//   - Only acts on games whose status.detailedState ∈
//     {Final, Game Over, Completed Early} AND whose weather.condition
//     is populated. Pre-game / empty condition → skipped, NEVER
//     overwrites a known-good value with blank.
//   - Closed iff condition string contains "roof closed" / "dome" /
//     "closed" (case-insensitive). Else open.
//   - 'actual' is the highest confidence level — wins over any
//     existing 'announced' or 'estimated'. Never downgraded.
//
// SAFE on every failure mode:
//   - statsapi HTTP / JSON failure on a single game → that game is
//     skipped, others continue. Never throws.
//   - DB tx failure → returned in summary.errors, throws nothing.
//   - Returns a summary, throws nothing. Caller wraps in try/catch
//     out of paranoia; the wrapping is belt-and-suspenders.

const { db } = require('../db/schema');
const fetch = require('node-fetch');

// All 7 retractable-roof venue_ids — verified empirically against
// statsapi for Apr-Jun 2026. SEA (680) IS included here: the
// corrector records its TRUE roof state. How runWeatherJob TREATS a
// closed SEA game (neutralize or not) is a separate decision —
// SEA's roof covers but doesn't seal, so closed SEA still has real
// wind / outside-matching temp. That gate lives in jobs.js's
// SEALED_DOME_VENUE_IDS, not here.
const ROOF_VENUES = {
  15:   'ARI Chase Field',
  2392: 'HOU Daikin Park',
  5325: 'TEX Globe Life Field',
  680:  'SEA T-Mobile Park',
  14:   'TOR Rogers Centre',
  4169: 'MIA loanDepot park',
  32:   'MIL American Family Field',
};

const COMPLETED_STATES = new Set(['Final', 'Game Over', 'Completed Early']);
const UA = 'mlb-analyzer/1.0 (roof-corrector)';

// One statsapi feed/live fetch. Returns:
//   { roof: 'closed'|'open'|null, condition: <raw string or ''> }
// roof === null when the game isn't completed yet, condition is blank,
// or the fetch failed. Caller treats null as "no data, skip" — NEVER
// writes anything for these.
async function fetchActualRoof(gamePk) {
  const url = 'https://statsapi.mlb.com/api/v1.1/game/' + gamePk + '/feed/live';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!resp.ok) return { roof: null, condition: '' };
    const data = await resp.json();
    const gd = data && data.gameData ? data.gameData : {};
    const wx = gd.weather || {};
    const status = (gd.status && gd.status.detailedState) || '';
    const cond = wx.condition || '';
    if (!COMPLETED_STATES.has(status)) return { roof: null, condition: cond };
    if (!cond) return { roof: null, condition: '' };
    const c = String(cond).toLowerCase();
    if (c.includes('roof closed') || c.includes('dome') || c.includes('closed')) {
      return { roof: 'closed', condition: cond };
    }
    return { roof: 'open', condition: cond };
  } catch (e) {
    return { roof: null, condition: '' };
  } finally {
    clearTimeout(timer);
  }
}

// Build the candidate set: every roofed-park game with game_pk set,
// going back N days from the run date. Default 14 days keeps the
// per-call statsapi work bounded (~50-100 games typical) while still
// catching anything the scoring path might revisit. Past games beyond
// the window are out of scope — they've already been corrected by an
// earlier call.
function selectCandidates(opts) {
  const lookbackDays = Math.max(1, Number(opts.lookbackDays || 14));
  const vids = Object.keys(ROOF_VENUES);
  const placeholders = vids.map(() => '?').join(',');
  // game_date >= cutoff (YYYY-MM-DD). Use local-date arithmetic so
  // 'today' aligns with what runWeatherJob is processing.
  const cutoff = new Date(Date.now() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);
  return db.prepare(
    'SELECT game_date, game_id, game_pk, venue_id, roof_status, roof_confidence '
    + 'FROM game_log WHERE venue_id IN (' + placeholders + ') '
    + 'AND game_pk IS NOT NULL AND game_date >= ? '
    + 'ORDER BY game_date'
  ).all(...vids.map(Number), cutoff);
}

// Main entrypoint. Called from runWeatherJob before the games-read.
// Args: { lookbackDays?: number, runDate?: 'YYYY-MM-DD' }
//   runDate is informational only (logged + returned in summary).
async function runRoofStatusCorrect(opts) {
  opts = opts || {};
  const summary = {
    job: 'roof-status-correct',
    run_date: opts.runDate || null,
    lookback_days: opts.lookbackDays || 14,
    success: false,
    candidates: 0,
    fetched: 0,
    updated: 0,
    nochange: 0,
    nodata: 0,        // completed-but-blank-condition OR not-yet-final
    fetch_errors: 0,  // network / JSON failures (each counted; row stays)
    rows: [],
    errors: [],
  };

  let candidates;
  try {
    candidates = selectCandidates(opts);
  } catch (e) {
    summary.errors.push('db_select_failed: ' + e.message);
    console.warn('[roof-correct] db select failed (non-fatal): ' + e.message);
    return summary;
  }
  summary.candidates = candidates.length;
  if (!candidates.length) {
    summary.success = true;
    return summary;
  }

  // Per-row fetch, sequential w/ short throttle so we don't hammer
  // statsapi. 50ms between calls matches the Python's pacing. At ~60
  // candidates per call this adds ~3 seconds to the weather job —
  // tolerable, and only the weather job invokes us.
  const updates = [];
  for (const r of candidates) {
    let res;
    try {
      res = await fetchActualRoof(r.game_pk);
      summary.fetched++;
    } catch (e) {
      // fetchActualRoof catches internally; this is defense in depth.
      summary.fetch_errors++;
      continue;
    }
    if (res.roof === null) { summary.nodata++; continue; }
    const cur = (r.roof_status || '').toLowerCase();
    const curConf = r.roof_confidence || '';
    if (cur === res.roof && curConf === 'actual') {
      summary.nochange++;
      continue;
    }
    updates.push({
      game_date: r.game_date,
      game_id:   r.game_id,
      venue_id:  r.venue_id,
      before:    (r.roof_status || 'null') + '/' + (curConf || 'null'),
      after:     res.roof + '/actual',
      condition: res.condition,
      roof:      res.roof,
    });
    await new Promise(rs => setTimeout(rs, 50));
  }

  if (!updates.length) {
    summary.success = true;
    return summary;
  }

  // One tx for the whole batch. 'actual' wins over any prior value —
  // it's the canonical answer per the confidence precedence (actual >
  // announced > estimated/prior).
  const updateStmt = db.prepare(
    "UPDATE game_log SET roof_status = ?, roof_confidence = 'actual' "
    + 'WHERE game_date = ? AND game_id = ?'
  );
  const tx = db.transaction((rows) => {
    for (const u of rows) {
      const info = updateStmt.run(u.roof, u.game_date, u.game_id);
      if (info.changes) {
        summary.updated++;
        summary.rows.push({
          game_date: u.game_date, game_id: u.game_id,
          park: ROOF_VENUES[u.venue_id] || ('venue_' + u.venue_id),
          before: u.before, after: u.after, condition: u.condition,
        });
      }
    }
  });
  try {
    tx(updates);
    summary.success = true;
  } catch (e) {
    summary.errors.push('db_tx_failed: ' + e.message);
    console.warn('[roof-correct] DB transaction failed (non-fatal): ' + e.message);
    return summary;
  }
  console.log('[roof-correct] candidates=' + summary.candidates
    + ' fetched=' + summary.fetched
    + ' updated=' + summary.updated
    + ' nochange=' + summary.nochange
    + ' nodata=' + summary.nodata
    + ' fetch_errors=' + summary.fetch_errors);
  return summary;
}

module.exports = {
  runRoofStatusCorrect,
  fetchActualRoof,
  ROOF_VENUES,
  COMPLETED_STATES,
};
