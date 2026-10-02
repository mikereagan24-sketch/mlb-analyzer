'use strict';

// DAILY SCORE CATCH-UP (2026-10-02, #505).
//
// Two score pulls were lost this season and nothing noticed for weeks:
//   2026-07-23  the pull errored once (connect ETIMEDOUT) and was not retried
//   2026-09-02  no score run was logged at all (cause unknown)
// leaving 20 finished games unscored and two locked bets pending. The retry in
// runScoreJob covers the first; this covers both, and anything else that ends
// with a finished game and no score.
//
// Once a day, after the 4AM PT score pull and through the same serial job
// queue, for each of the last WINDOW_DAYS dates (yesterday back to 7 days ago):
//   1. ask statsapi which games on that date are finished but have no score in
//      game_log. This is the #486 repair's compareDate ('missing_score'), not a
//      second implementation: it already skips postponed / cancelled duplicates,
//      removed rows, placeholders and the All-Star game, and reads suspended
//      games by gamePk. It only reads.
//   2. a date needs a catch-up when it has such games, OR when it has live
//      game_log rows but no successful 'scores' run logged for it.
//   3. run runScoreJob(date) -- the same function the cron and POST
//      /api/jobs/scores call. It fetches scores, grades bets and captures, and
//      records pitcher usage. It never runs the model, odds, weather, lineups
//      or signals, and neither does anything here.
//   4. ask statsapi again. Games still unscored -> a cron_log 'score-catchup'
//      row with status 'warn' and their ids; GET /api/health/:date reads it as
//      the 'scores_catchup' warning.
//
// A date that is fully scored (no finished game unscored, and a successful
// 'scores' run logged) is never re-run.
//
// REPORTED ONCE, NOT EVERY DAY. A game the score job cannot score -- today the
// "Completed Early" case, whose fix is #504 -- would otherwise re-run its date
// and re-warn every morning for a week. If the last catch-up for a date already
// warned about exactly the same set of games, the date is skipped silently. A
// failed score run ('error') is not a report: the next day tries again.
//
// Dependencies are injected (services/jobs.js wires the real ones; tests pass
// spies), so this module requires nothing but the read-only compareDate.

const { compareDate } = require('./game-log-repair');

const WINDOW_DAYS = 7;

const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const idSet = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean).sort().join(',');

// Finished-but-unscored games on D, per statsapi. -> [{ game_id, status }]
async function unscoredFinished(db, D, fetchJson) {
  const f = await compareDate(db, D, { fetchJson }, { requests: 0 });
  return f.items.filter(i => i.cat === 'missing_score')
    .map(i => ({ game_id: i.row_game_id || i.game_id, status: (i.ref && i.ref.status) || null }));
}

// deps: { db, q, today: 'YYYY-MM-DD' (PT), runScoreJob(date), fetchJson(url), log?, windowDays? }
async function run(deps) {
  const { db, q, today, runScoreJob, fetchJson } = deps;
  const log = deps.log || ((m) => console.log(m));
  const windowDays = deps.windowDays || WINDOW_DAYS;
  const logRow = (D, status, message, ids) => {
    try {
      q.logCronStructured.run({ job_type: 'score-catchup', run_date: D, status, message, games_updated: 0,
        games_skipped: ids ? ids.length : 0, games_skipped_ids: ids ? ids.join(',') : null, skip_reasons: null, duration_ms: null });
    } catch (e) { console.warn('[score-catchup] cron_log write failed (non-fatal): ' + (e && e.message)); }
  };
  const out = { dates: [], ran: [], caught_up: [], still_unscored: [], already_reported: [], errors: [] };

  for (let k = windowDays; k >= 1; k--) {
    const D = addDays(today, -k);
    out.dates.push(D);
    const live = db.prepare('SELECT COUNT(*) n FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0').get(D).n;
    if (!live) continue;                                                  // nothing scheduled: nothing to score

    let missing;
    try { missing = await unscoredFinished(db, D, fetchJson); }
    catch (e) {
      out.errors.push({ date: D, error: 'statsapi check failed: ' + (e && e.message) });
      log('[score-catchup] ' + D + ' statsapi check failed: ' + (e && e.message));
      continue;
    }
    const ranOk = !!db.prepare("SELECT 1 FROM cron_log WHERE job_type = 'scores' AND run_date = ? AND status = 'success' LIMIT 1").get(D);
    if (!missing.length && ranOk) continue;                               // fully scored: never re-run

    const ids = missing.map(m => m.game_id);
    const prior = db.prepare("SELECT status, games_skipped_ids FROM cron_log WHERE job_type = 'score-catchup' AND run_date = ? ORDER BY id DESC LIMIT 1").get(D);
    if (ranOk && prior && prior.status === 'warn' && idSet(prior.games_skipped_ids) === idSet(ids.join(','))) {
      out.already_reported.push(D);                                       // reported once already
      continue;
    }

    const reason = [missing.length ? missing.length + ' finished game(s) without a score' : null,
      ranOk ? null : 'no successful score run logged'].filter(Boolean).join('; ');
    log('[score-catchup] ' + D + ': ' + reason + ' -- running the score job');
    out.ran.push(D);
    let r;
    try { r = await runScoreJob(D); } catch (e) { r = { success: false, error: e && e.message }; }
    if (!r || r.success === false) {
      const msg = reason + '; score job failed: ' + ((r && r.error) || 'unknown');
      out.errors.push({ date: D, error: msg });
      logRow(D, 'error', msg, ids);
      log('[score-catchup] ' + D + ' ' + msg);
      continue;
    }

    let after;
    try { after = await unscoredFinished(db, D, fetchJson); }
    catch (e) {
      const msg = reason + '; score job ran, re-check failed: ' + (e && e.message);
      out.errors.push({ date: D, error: msg });
      logRow(D, 'error', msg, ids);
      continue;
    }
    if (after.length) {
      const afterIds = after.map(a => a.game_id);
      const msg = after.length + ' finished game(s) still unscored after the catch-up score run: '
        + after.map(a => a.game_id + (a.status && a.status !== 'Final' ? ' (' + a.status + ')' : '')).join(', ');
      out.still_unscored.push({ date: D, game_ids: afterIds });
      logRow(D, 'warn', msg, afterIds);
      log('[score-catchup] WARN ' + D + ': ' + msg);
    } else {
      out.caught_up.push(D);
      logRow(D, 'success', 'caught up: ' + reason, null);
      log('[score-catchup] ' + D + ' caught up');
    }
  }
  return out;
}

module.exports = { run, unscoredFinished, WINDOW_DAYS };
