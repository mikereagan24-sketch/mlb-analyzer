'use strict';

// game_log repair against MLB's statsapi (#486, 2026-10-02).
//
// Compares statsapi's schedule with game_log, date by date, and -- only when
// asked -- writes the differences. Used by POST /api/admin/game-log-repair
// (routes/game-log-repair.js).
//
// MODES
//   diff  (default)  report every difference by category; writes NOTHING.
//   apply            write ONLY the requested categories in the date range.
//   grade            grade the bet_signals of finished games on the given dates
//                    with gradeBetSignalsForGame (services/jobs.js) and nothing
//                    else. Separate and explicit: apply never grades.
//
// CATEGORIES (apply writes only these columns):
//   missing_game         INSERT a FINAL game statsapi lists and game_log lacks:
//                        game_date, game_id, away_team, home_team, game_number,
//                        game_pk, scheduled_start_utc, game_status, scores.
//                        Nothing else -- no prices, locks, lineups, model output.
//   wrong_score          away_score / home_score / actual_total (+ scores_source
//   missing_score        'statsapi-repair', scores_quality, game_status)
//   start_time           scheduled_start_utc (statsapi's scheduled start for the
//                        game's official date; tolerance 5 minutes)
//   game_pk              game_pk
//   first_pitch          first_pitch_utc, only where it is NULL, from the game
//                        feed (services/first-pitch.js fetchFirstPitch)
//   postponed_duplicate  is_removed / removed_at / removed_reason on a row left on
//                        a postponed (or cancelled) game's ORIGINAL date
//   placeholder          the same, for a row whose game_id is not a team-team id
//                        (e.g. "atl/phi-lad", #502)
//   dh_assignment        game_id / game_number of a doubleheader leg stored under
//                        a non-standard id ("chc-cle-2" -> "chc-cle-g2")
// It NEVER writes prices, locks, model outputs, signals, captures or bets, and
// never calls the model, odds, weather, lineup or signal code: this module
// requires nothing but utils/statsapi-ids.js, and every effect goes through the
// injected deps (db, fetchJson, fetchFirstPitch, grade).
// A row that has ANY bet_signals is never retired: it is reported instead
// (stricter than the schedule prune, which also deactivates signals --
// services/scraper.js -- because this repair never writes signals).
//
// EDGE CASES
//   - Final = statsapi abstractGameState 'Final' minus Postponed / Cancelled, so
//     "Completed Early" and "Game Over" games are final.
//   - The All-Star Game (gameType 'A') is OUT OF SCOPE: never inserted, scored
//     or retired; reported. Its row ("al-nl") is not a team-team game, so no
//     team reader would use it either way.
//   - Suspended games: a game is processed on its official date. When statsapi
//     lists it there as "Suspended", its final state is read by gamePk; its
//     scheduled start stays the ORIGINAL date's (first pitch was then).
//   - Postponed / cancelled entries are never games: a row on their date is a
//     postponed_duplicate; the make-up keeps its own row.
//   - missing_game inserts FINAL games only: the live slate is the schedule
//     bootstrap's (services/jobs.js ensureScheduleBootstrap), never this route's.
//
// IDEMPOTENT: a second apply over the same range writes nothing, because apply
// writes exactly what diff reports and diff compares against the written values.
// Per date: one statsapi request (~60-100 KB; a range is processed one date at
// a time, never as one season-sized response), plus one by-gamePk request per
// suspended game and one feed request per first_pitch fix. At most MAX_DAYS
// dates per call.

const { normAbbr, gameIdFor, isScoredFinal } = require('../utils/statsapi-ids');

const CATEGORIES = ['missing_game', 'wrong_score', 'missing_score', 'start_time', 'game_pk', 'first_pitch',
  'postponed_duplicate', 'placeholder', 'dh_assignment'];
const MAX_DAYS = 31;
const GAME_TYPES = new Set(['R', 'F', 'D', 'L', 'W']);         // regular season + postseason; 'A' = All-Star, out of scope
const START_TOLERANCE_MS = 5 * 60 * 1000;
const LIST_CAP = 400;                                           // items listed per category in a response
const SCHEDULE_URL = (d) => 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=' + d + '&gameType=R,F,D,L,W,A&hydrate=team';
const GAME_URL = (pk) => 'https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=' + pk + '&gameType=R,F,D,L,W,A&hydrate=team';

const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isoZ = (s) => (s ? new Date(Date.parse(s)).toISOString().replace('.000Z', 'Z') : null);
const wellFormed = (id) => /^[a-z]{2,3}-[a-z]{2,3}(-g?\d)?$/.test(String(id || ''));
const isPostponed = (st) => /^(Postponed|Cancelled)/.test(st || '');

// -> { error } | { from, to, dates[], categories[] }
function parseRequest(body) {
  const b = body || {};
  const mode = b.mode || 'diff';
  if (!['diff', 'apply', 'grade'].includes(mode)) return { error: 'mode must be diff, apply or grade' };
  if (!isDate(b.from) || !isDate(b.to)) return { error: 'from and to must be YYYY-MM-DD' };
  if (b.to < b.from) return { error: 'to is before from' };
  const dates = [];
  for (let d = b.from; d <= b.to; d = addDays(d, 1)) dates.push(d);
  if (dates.length > MAX_DAYS) return { error: 'at most ' + MAX_DAYS + ' dates per call (got ' + dates.length + ')' };
  const categories = b.categories == null ? CATEGORIES.slice() : [].concat(b.categories);
  const bad = categories.filter(c => !CATEGORIES.includes(c));
  if (bad.length) return { error: 'unknown categories: ' + bad.join(', ') };
  return { mode, from: b.from, to: b.to, dates, categories };
}

// statsapi game -> the reference record (null for an unmapped team)
function refOf(g) {
  const away = normAbbr(g.teams && g.teams.away && g.teams.away.team && g.teams.away.team.abbreviation);
  const home = normAbbr(g.teams && g.teams.home && g.teams.home.team && g.teams.home.team.abbreviation);
  if (!away || !home) return null;
  const gn = g.gameNumber || 1;
  const st = (g.status && g.status.detailedState) || null;
  return { pk: g.gamePk, type: g.gameType, date: g.officialDate, id: gameIdFor(away, home, gn), base: (away + '-' + home).toLowerCase(), gn,
    away, home, start: isoZ(g.gameDate), status: st,
    // The one completed-game rule (utils/statsapi-ids.js), shared with the score fetch.
    final: isScoredFinal(g.status, g.teams.away.score, g.teams.home.score),
    as: g.teams.away.score == null ? null : Number(g.teams.away.score), hs: g.teams.home.score == null ? null : Number(g.teams.home.score) };
}

// One date: statsapi's games for it (official date), compared with game_log. -> findings
async function compareDate(db, D, deps, stats) {
  const sched = await deps.fetchJson(SCHEDULE_URL(D)); stats.requests++;
  // A real game belongs to its OFFICIAL date (a resumed game is also listed on its
  // resumption date, under its original officialDate). A postponed entry is listed
  // on its ORIGINAL date but carries the make-up's officialDate, so postponed /
  // cancelled entries are taken from the listing date instead (measured 2026-10-02).
  const list = (sched && sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  const real = [], postponed = [], outOfScope = [];
  for (const g of list) {
    const r = refOf(g);
    if (!r) { outOfScope.push({ date: D, game_pk: g.gamePk, detail: 'unmapped team abbreviation' }); continue; }
    if (isPostponed(r.status)) { if (GAME_TYPES.has(r.type)) postponed.push(r); continue; }
    if (g.officialDate && g.officialDate !== D) continue;      // listed here, but officially another date's game
    if (!GAME_TYPES.has(r.type)) { outOfScope.push({ date: D, game_id: r.id, game_pk: r.pk, detail: 'gameType ' + r.type + ' (All-Star / exhibition) is out of scope' }); continue; }
    if (/^Suspended/.test(r.status || '')) {                    // the final state lives on the resumption listing
      const byPk = await deps.fetchJson(GAME_URL(r.pk)); stats.requests++;
      const all = [].concat(...((byPk && byPk.dates) || []).map(x => x.games || []));
      const fin = all.map(refOf).find(x => x && x.pk === r.pk && x.final);
      if (fin) Object.assign(r, { final: true, as: fin.as, hs: fin.hs, status: fin.status });
    }
    real.push(r);
  }
  const rows = db.prepare(`SELECT id, game_date, game_id, game_pk, game_number, away_score, home_score, scheduled_start_utc,
      first_pitch_utc, game_status, COALESCE(is_removed, 0) is_removed FROM game_log WHERE game_date = ?`).all(D);
  const live = rows.filter(r => !r.is_removed);
  const f = { real, rows: live, allRows: rows, items: [], outOfScope, other: [] };
  const item = (cat, row, ref, detail, extra) => f.items.push(Object.assign({ cat, date: D, game_id: (ref && ref.id) || (row && row.game_id), row_id: row ? row.id : null,
    row_game_id: row ? row.game_id : null, ref, detail }, extra || {}));
  const used = new Set();
  for (const G of real) {
    let r = live.find(x => x.game_id === G.id), via = 'id';
    if (!r && G.gn > 1) {                                        // a leg stored as "base-N" rather than "base-gN"
      r = live.find(x => !used.has(x.id) && x.game_id === G.base + '-' + G.gn);
      if (r) { via = 'dh'; item('dh_assignment', r, G, r.game_id + ' -> ' + G.id + ' (game ' + G.gn + ')'); }
    }
    if (!r) {
      if (G.final) item('missing_game', null, G, 'statsapi ' + G.status + ' ' + G.as + '-' + G.hs + ', pk ' + G.pk);
      else f.other.push({ date: D, game_id: G.id, detail: 'not in game_log and not final (' + G.status + '): left to the schedule bootstrap' });
      continue;
    }
    used.add(r.id);
    if (r.game_pk == null || Number(r.game_pk) !== G.pk) item('game_pk', r, G, 'game_pk ' + r.game_pk + ' -> ' + G.pk);
    const t = Date.parse(r.scheduled_start_utc || '');
    if (!r.scheduled_start_utc || !Number.isFinite(t) || Math.abs(t - Date.parse(G.start)) > START_TOLERANCE_MS) {
      item('start_time', r, G, 'scheduled_start_utc ' + r.scheduled_start_utc + ' -> ' + G.start);
    }
    if (G.final) {
      if (r.away_score == null || r.home_score == null) item('missing_score', r, G, 'no score -> ' + G.as + '-' + G.hs + ' (' + G.status + ')');
      else if (Number(r.away_score) !== G.as || Number(r.home_score) !== G.hs) {
        const flip = Math.sign(Number(r.away_score) - Number(r.home_score)) !== Math.sign(G.as - G.hs);
        item('wrong_score', r, G, r.away_score + '-' + r.home_score + ' -> ' + G.as + '-' + G.hs + (flip ? ' (WRONG WINNER)' : ''), { wrong_winner: flip });
      }
      if (!r.first_pitch_utc) item('first_pitch', r, G, 'first_pitch_utc is NULL on a final game');
    }
  }
  const realPks = new Set(real.map(G => G.pk));
  for (const r of live) {
    if (used.has(r.id)) continue;
    const pp = postponed.find(p => p.id === r.game_id || (r.game_pk != null && p.pk === Number(r.game_pk)));
    if (/^(al|nl)-(al|nl)$/.test(r.game_id)) f.outOfScope.push({ date: D, game_id: r.game_id, detail: 'All-Star row: out of scope' });
    else if (pp) item('postponed_duplicate', r, null, 'statsapi ' + pp.status + ' on ' + D + ' (pk ' + pp.pk + ')'
      + (/^Cancelled/.test(pp.status) ? '; never played' : '; the make-up has its own row')
      + (r.away_score != null ? '; row carries a score ' + r.away_score + '-' + r.home_score : ''));
    else if (!wellFormed(r.game_id)) item('placeholder', r, null, 'not a team-team game id; pk ' + r.game_pk
      + (realPks.has(Number(r.game_pk)) ? ' belongs to a real game on ' + D : ''));
    else f.other.push({ date: D, game_id: r.game_id, detail: 'in game_log, not in statsapi for ' + D + ' (pk ' + r.game_pk + ')' });
  }
  return f;
}

// Apply one date's findings for the requested categories. -> { written: {cat: n}, skipped: [] }
async function applyDate(db, D, f, categories, deps, stats) {
  const want = new Set(categories), written = {}, skipped = [];
  const bump = (c) => { written[c] = (written[c] || 0) + 1; };
  const inserted = [];                                         // rows created here: their first pitch is fetched below too
  const signals = db.prepare('SELECT COUNT(*) c FROM bet_signals WHERE game_date = ? AND game_id = ?');
  const exists = (id) => db.prepare('SELECT 1 FROM game_log WHERE game_date = ? AND game_id = ?').get(D, id);
  db.transaction(() => {
    for (const it of f.items) {
      if (!want.has(it.cat) || it.cat === 'first_pitch') continue;
      const G = it.ref;
      switch (it.cat) {
        case 'dh_assignment':
          if (exists(G.id)) { skipped.push({ cat: it.cat, date: D, game_id: it.row_game_id, reason: 'target id ' + G.id + ' already exists' }); break; }
          db.prepare("UPDATE game_log SET game_id = ?, game_number = ?, updated_at = datetime('now') WHERE id = ?").run(G.id, G.gn, it.row_id); bump(it.cat); break;
        case 'postponed_duplicate':
        case 'placeholder': {
          const n = signals.get(D, it.row_game_id).c;
          if (n > 0) { skipped.push({ cat: it.cat, date: D, game_id: it.row_game_id, reason: n + ' bet_signals row(s): not retired (signals are never written here)' }); break; }
          db.prepare("UPDATE game_log SET is_removed = 1, removed_at = datetime('now'), removed_reason = ? WHERE id = ? AND COALESCE(is_removed, 0) = 0")
            .run(it.cat === 'placeholder' ? 'repair_placeholder' : 'repair_postponed_original', it.row_id);
          bump(it.cat); break;
        }
        case 'missing_game':
          if (exists(G.id)) { skipped.push({ cat: it.cat, date: D, game_id: G.id, reason: 'a removed row already holds ' + D + ' ' + G.id }); break; }
          db.prepare(`INSERT INTO game_log (game_date, game_id, away_team, home_team, game_number, game_pk, scheduled_start_utc, game_status,
              away_score, home_score, actual_total, scores_source, scores_quality, scores_quality_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'statsapi-repair', 'fresh', datetime('now'))`)
            .run(D, G.id, G.away, G.home, G.gn, G.pk, G.start, G.status, G.as, G.hs, G.as + G.hs);
          inserted.push({ game_id: G.id, ref: G, row_id: db.prepare('SELECT id FROM game_log WHERE game_date = ? AND game_id = ?').get(D, G.id).id });
          bump(it.cat); break;
        case 'wrong_score':
        case 'missing_score':
          db.prepare(`UPDATE game_log SET away_score = ?, home_score = ?, actual_total = ?, scores_source = 'statsapi-repair',
              scores_quality = 'fresh', scores_quality_at = datetime('now'), game_status = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(G.as, G.hs, G.as + G.hs, G.status, it.row_id);
          bump(it.cat); break;
        case 'start_time':
          db.prepare("UPDATE game_log SET scheduled_start_utc = ?, updated_at = datetime('now') WHERE id = ?").run(G.start, it.row_id); bump(it.cat); break;
        case 'game_pk':
          db.prepare("UPDATE game_log SET game_pk = ?, updated_at = datetime('now') WHERE id = ?").run(G.pk, it.row_id); bump(it.cat); break;
        default: break;
      }
    }
  })();
  if (want.has('first_pitch')) {
    for (const it of f.items.filter(x => x.cat === 'first_pitch').concat(inserted)) {
      const fp = await deps.fetchFirstPitch(it.ref.pk); stats.requests++;
      if (!fp || !fp.first_pitch_utc) { skipped.push({ cat: 'first_pitch', date: D, game_id: it.game_id, reason: 'the game feed has no firstPitch' }); continue; }
      db.prepare("UPDATE game_log SET first_pitch_utc = ?, updated_at = datetime('now') WHERE id = ? AND first_pitch_utc IS NULL").run(fp.first_pitch_utc, it.row_id);
      bump('first_pitch');
    }
  }
  return { written, skipped };
}

// The whole request. deps: { db, fetchJson(url), fetchFirstPitch(pk), grade(date, gameId, row, a, h) }
async function run(req, deps) {
  const p = parseRequest(req);
  if (p.error) return { error: p.error };
  const t0 = Date.now(), stats = { requests: 0 };
  const db = deps.db;
  if (p.mode === 'grade') {
    let games = 0, signals = 0;
    for (const D of p.dates) {
      for (const r of db.prepare(`SELECT * FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0
          AND away_score IS NOT NULL AND home_score IS NOT NULL ORDER BY game_id`).all(D)) {
        signals += deps.grade(D, r.game_id, r, r.away_score, r.home_score) || 0;
        games++;
      }
    }
    return { mode: 'grade', from: p.from, to: p.to, dates: p.dates.length, games_graded: games, bet_signals_graded: signals, ms: Date.now() - t0 };
  }
  const counts = {}, items = {}, written = {}, skipped = [], outOfScope = [], other = [];
  for (const c of CATEGORIES) { counts[c] = 0; items[c] = []; }
  for (const D of p.dates) {
    const f = await compareDate(db, D, deps, stats);
    for (const it of f.items) {
      if (!p.categories.includes(it.cat)) continue;
      counts[it.cat]++;
      if (items[it.cat].length < LIST_CAP) items[it.cat].push({ date: it.date, game_id: it.game_id, row_game_id: it.row_game_id, detail: it.detail });
    }
    outOfScope.push(...f.outOfScope); other.push(...f.other);
    if (p.mode === 'apply') {
      const a = await applyDate(db, D, f, p.categories, deps, stats);
      for (const [c, n] of Object.entries(a.written)) written[c] = (written[c] || 0) + n;
      skipped.push(...a.skipped);
    }
  }
  const out = { mode: p.mode, from: p.from, to: p.to, dates: p.dates.length, categories: p.categories, counts, items, out_of_scope: outOfScope, other,
    statsapi_requests: stats.requests, ms: Date.now() - t0 };
  if (p.mode === 'apply') Object.assign(out, { written, skipped });
  return out;
}

module.exports = { run, parseRequest, compareDate, CATEGORIES, MAX_DAYS, SCHEDULE_URL, GAME_URL };
