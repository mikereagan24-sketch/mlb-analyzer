'use strict';

// Polymarket MLB pre-game trades backfill -- stage 1 of backfill -> backtest
// -> card. (2026-09-30) LOCAL ONLY and DISPLAY ONLY.
//
// Nothing here is wired into server.js, routes, jobs or index.html, and it
// never runs on Render. It writes to its own database (data/polymarket.db,
// gitignored) and reads data/mlb.db READ-ONLY, for game_log matching only.
// scripts/test-polymarket-backfill.js asserts that no file in the pricing
// path references this module or its database.
//
// Wallet addresses are stored locally because profit is computed per wallet.
// Nothing in this feature will ever display them.
//
// LOCKED DECISIONS (Mike, 2026-09-30):
//   1. Complete trade history. /trades pages by offset and refuses offsets
//      past 10,000 (HTTP 400 "max historical trades offset of 10000
//      exceeded", measured 2026-09-30). A time window whose fills exceed that
//      is split in half by time, repeatedly, until every window fits. Per
//      market: whether splitting was needed, and the window count. No
//      market is ever silently truncated.
//   2. Net-short positions (a wallet net SHORT one team pre-game -- shares it
//      never bought, i.e. share splitting) are excluded from profit and
//      counted, per market and in total.
//   3. A doubleheader date with a single Polymarket market (which game is
//      unknown) is excluded. Explicitly separate markets (-dh2) are kept
//      when they match cleanly.
//   4. Pre-game cutoff = the EARLIER of game_log.scheduled_start_utc and
//      game_log.first_pitch_utc, whichever exist (Mike, 2026-09-30). A fill at
//      or after it is excluded. first_pitch_utc matters for a SUSPENDED game:
//      it started on the original date, and scheduled_start_utc was moved to
//      the resumption date, so scheduled_start_utc alone would count in-game
//      fills as pre-game (sf-atl 2026-06-16: 6,067 fills).
//      FALLBACK (Mike, 2026-09-30), only when NEITHER exists -- the early-April
//      games whose start columns were never written: game_time ("7:15 PM ET")
//      converted with etGameTimeToUtc, accepted ONLY if it agrees with
//      Polymarket's own gameStartTime within 15 minutes; otherwise the game
//      is excluded as start_time_unconfirmed. markets.cutoff_source records
//      which one each game used. The rule was proven against every game_log
//      row carrying both fields (auditGameTimeRule): 2,020/2,049 exact, every
//      miss explained -- docs/polymarket-backfill-start-time-fallback-2026-09-30.md.
//   5. Local only (above).
//   6. Every exclusion carries its reason.
//   7. Regular season only (Mike, 2026-09-30): MLB's own regular-season dates
//      (REGULAR_SEASON); spring training and postseason markets are excluded
//      with those reasons. Postseason handling is deferred to the card stage.

const { _internal: POLY } = require('./polymarket');   // POLY_SLUG_TO_ABBR / resolveTeamSlug only

const PAGE = 500;
const MAX_OFFSET = 10000;          // largest offset /trades accepts
const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

// ---------------------------------------------------------------- store
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY, addr TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS markets (
  id INTEGER PRIMARY KEY, condition_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL, event_id TEXT,
  outcome0 TEXT, outcome1 TEXT, poly_start_utc INTEGER, slug_date TEXT,
  game_date TEXT, game_id TEXT, cutoff_utc INTEGER, outcome0_is_home INTEGER,
  cutoff_source TEXT,                           -- scheduled_start_utc | first_pitch_utc | fallback_confirmed
  status TEXT NOT NULL DEFAULT 'new',           -- new | excluded | matched | fetched | done
  exclusion_reason TEXT, resolved INTEGER, winner_idx INTEGER,
  split_needed INTEGER NOT NULL DEFAULT 0, window_count INTEGER, fills_stored INTEGER,
  duplicates_dropped INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
  net_short_positions INTEGER, net_short_wallet_games INTEGER, wallet_games INTEGER, done_at TEXT);
CREATE TABLE IF NOT EXISTS windows (
  market_id INTEGER NOT NULL, t_start INTEGER NOT NULL, t_end INTEGER NOT NULL,
  status TEXT NOT NULL,                         -- pending | done | split
  fills INTEGER, dups INTEGER, PRIMARY KEY (market_id, t_start, t_end)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fills (
  market_id INTEGER NOT NULL, wallet_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  side INTEGER NOT NULL,                        -- +1 buy, -1 sell
  outcome INTEGER NOT NULL, price REAL NOT NULL, size REAL NOT NULL);
CREATE INDEX IF NOT EXISTS fills_market_ts ON fills (market_id, ts);
CREATE TABLE IF NOT EXISTS wallet_game (
  market_id INTEGER NOT NULL, wallet_id INTEGER NOT NULL,
  spent REAL NOT NULL, received REAL NOT NULL, payout REAL NOT NULL, profit REAL NOT NULL,
  volume REAL NOT NULL, fills INTEGER NOT NULL,
  PRIMARY KEY (market_id, wallet_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS net_short (
  market_id INTEGER NOT NULL, wallet_id INTEGER NOT NULL, outcome INTEGER NOT NULL, net_shares REAL NOT NULL,
  PRIMARY KEY (market_id, wallet_id, outcome)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, args TEXT,
  requests INTEGER, retries INTEGER, http429 INTEGER, peak_rss_mb REAL, markets_done INTEGER);
`;
function openStore(Database, file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  // Stores created before cutoff_source existed (the pilot databases).
  if (!db.prepare('PRAGMA table_info(markets)').all().some(c => c.name === 'cutoff_source')) {
    db.exec('ALTER TABLE markets ADD COLUMN cutoff_source TEXT');
  }
  return db;
}

// ---------------------------------------------------------------- http
// A tiny client: sequential, a minimum gap between requests, exponential
// backoff on 429 / 5xx / network errors, every retry logged and counted.
function makeClient(opts) {
  const o = Object.assign({ minGapMs: 150, maxAttempts: 8, log: console.log, fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)), now: () => Date.now() }, opts || {});
  const stats = { requests: 0, retries: 0, http429: 0 };
  let last = 0;
  async function getJson(url) {
    for (let attempt = 1; ; attempt++) {
      const wait = last + o.minGapMs - o.now();
      if (wait > 0) await o.sleep(wait);
      last = o.now();
      stats.requests++;
      let status = 0, body = null, err = null;
      try {
        const r = await o.fetchImpl(url, { headers: { 'User-Agent': 'mlb-analyzer-backfill (read-only)' } });
        status = r.status;
        const txt = await r.text();
        try { body = JSON.parse(txt); } catch (e) { body = txt; }
      } catch (e) { err = e; }
      const retryable = err || status === 429 || status >= 500;
      if (!retryable) {
        if (status >= 400) { const e = new Error('HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 200) + ' ' + url); e.status = status; throw e; }
        return body;
      }
      if (status === 429) stats.http429++;
      if (attempt >= o.maxAttempts) throw new Error('giving up after ' + attempt + ' attempts: ' + (err ? err.message : 'HTTP ' + status) + ' ' + url);
      const backoff = Math.min(60000, 1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
      stats.retries++;
      o.log('[retry] attempt ' + attempt + ' ' + (err ? err.message : 'HTTP ' + status) + ' -> waiting ' + backoff + ' ms ' + url.slice(0, 140));
      await o.sleep(backoff);
    }
  }
  return { getJson, stats };
}

// ---------------------------------------------------------------- discovery
function parseStart(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (/[+-]\d\d$/.test(t)) t += ':00';
  const ms = Date.parse(t);
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}
function marketFromEvent(e) {
  const m = (e.markets || []).find(x => x.sportsMarketType === 'moneyline');
  if (!m) return null;
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch (x) { return []; } };
  const outcomes = parse(m.outcomes), prices = parse(m.outcomePrices);
  const ones = prices.map((p, i) => (String(p) === '1' ? i : -1)).filter(i => i >= 0);
  const resolved = !!m.closed && ones.length === 1 && prices.length === 2;
  return { condition_id: m.conditionId, slug: e.slug, event_id: String(e.id),
    outcome0: outcomes[0] || null, outcome1: outcomes[1] || null,
    poly_start_utc: parseStart(m.gameStartTime), resolved: resolved ? 1 : 0, winner_idx: resolved ? ones[0] : null };
}
function upsertMarket(db, m) {
  db.prepare(`INSERT INTO markets (condition_id, slug, event_id, outcome0, outcome1, poly_start_utc, resolved, winner_idx)
    VALUES (@condition_id, @slug, @event_id, @outcome0, @outcome1, @poly_start_utc, @resolved, @winner_idx)
    ON CONFLICT(condition_id) DO UPDATE SET resolved = excluded.resolved, winner_idx = excluded.winner_idx,
      poly_start_utc = excluded.poly_start_utc`).run(m);
}
// By explicit slugs (the pilot) ...
async function discoverSlugs(db, client, slugs) {
  let n = 0;
  for (const slug of slugs) {
    const evs = await client.getJson(GAMMA + '/events?slug=' + encodeURIComponent(slug));
    for (const e of (Array.isArray(evs) ? evs : [])) { const m = marketFromEvent(e); if (m) { upsertMarket(db, m); n++; } }
  }
  return n;
}
// ... or by date range (the full run). Gamma refuses offsets past ~2,100 and
// 2025 fills that, so walk 3-day end_date windows; the game date filter is
// the slug's own date.
//
// An event's end_date is NOT its game date. Measured 2026-09-30: the final
// weekend's moneyline events (e.g. mlb-nym-wsh-2026-09-27) carry endDate
// 2026-10-04, a week after the game. The walk used to stop 3 days past `to`,
// so all 18 of those markets were silently missed. It now runs
// END_DATE_SLACK_DAYS past `to`; events outside [from, to] by slug date are
// still skipped.
const END_DATE_SLACK_DAYS = 21;
async function discoverRange(db, client, from, to) {
  const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  let n = 0;
  for (const closed of ['true', 'false']) {
    for (let day = addDays(from, -3); day <= addDays(to, END_DATE_SLACK_DAYS); day = addDays(day, 3)) {
      for (let off = 0; ; off += 100) {
        const evs = await client.getJson(GAMMA + '/events?series_id=3&closed=' + closed + '&limit=100&offset=' + off
          + '&end_date_min=' + day + 'T00:00:00Z&end_date_max=' + addDays(day, 3) + 'T00:00:00Z');
        if (!Array.isArray(evs) || !evs.length) break;
        for (const e of evs) {
          const sd = slugDate(e.slug);
          if (!sd || sd < from || sd > to) continue;
          const m = marketFromEvent(e);
          if (m) { upsertMarket(db, m); n++; }
        }
        if (evs.length < 100) break;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- matching
const SLUG_RE = /^mlb-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})(-dh2)?$/;
function slugDate(slug) { const m = SLUG_RE.exec(slug || ''); return m ? m[3] : null; }
const isGame2 = (gid) => /-(g)?2$/.test(gid);

// game_log.game_time is a display string, "h:mm AM|PM ET": the scheduled
// start on game_date as read on a New York clock (services/first-pitch.js
// explains why it is never used for arithmetic elsewhere). This converts it
// to a UTC instant, with DST taken from the platform's America/New_York
// rules rather than a hand-coded offset. Anything not in exactly that shape
// -- no "ET", a null, a 24h clock -- returns null: we do not guess a zone.
// -> epoch seconds | null
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function nyOffsetMinutes(ms) {                 // New York wall clock minus UTC, at instant ms
  const p = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
}
function etGameTimeToUtc(gameDate, gameTime) {
  const t = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+ET\s*$/i.exec(gameTime || '');
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameDate || '');
  if (!t || !d || +t[1] < 1 || +t[1] > 12 || +t[2] > 59) return null;
  const hour = (+t[1] % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
  const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], hour, +t[2]);
  // Two passes: the offset is looked up at the instant being solved for, so a
  // time on a DST-change day settles on the offset actually in force then.
  let ms = wall - nyOffsetMinutes(wall) * 60000;
  ms = wall - nyOffsetMinutes(ms) * 60000;
  return Math.floor(ms / 1000);
}
const FALLBACK_TOLERANCE_S = 15 * 60;          // game_time vs Polymarket gameStartTime

// Proves (or disproves) the game_time rule on every game_log row that has
// BOTH fields. Read-only. A mismatch is 'no_et_zone' (the string is not in
// the ET shape) or 'moved' (off by 6h or more: scheduled_start_utc holds a
// make-up / resumption date while game_time kept the original slot) or
// 'other' (anything else -- a genuine failure of the rule).
// `node scripts/polymarket-backfill.js --audit-game-time` prints it.
function auditGameTimeRule(mlbDb) {
  const rows = mlbDb.prepare(`SELECT game_date, game_id, game_time, scheduled_start_utc, COALESCE(is_removed,0) removed
    FROM game_log WHERE game_time IS NOT NULL AND game_time <> ''
      AND scheduled_start_utc IS NOT NULL AND scheduled_start_utc <> ''`).all();
  let exact = 0;
  const mismatches = [], byKind = { no_et_zone: 0, moved: 0, other: 0 };
  for (const r of rows) {
    const t = etGameTimeToUtc(r.game_date, r.game_time), s = parseStart(r.scheduled_start_utc);
    const diffMin = t == null || s == null ? null : (s - t) / 60;
    if (diffMin === 0) { exact++; continue; }
    const kind = t == null ? 'no_et_zone' : Math.abs(diffMin) >= 360 ? 'moved' : 'other';
    byKind[kind]++;
    mismatches.push(Object.assign({ kind, diff_min: diffMin }, r));
  }
  return { total: rows.length, exact, rate: rows.length ? exact / rows.length : null, byKind, mismatches };
}

// MLB's regular season, per statsapi.mlb.com /api/v1/seasons/{year}
// (regularSeasonStartDate / regularSeasonEndDate, read 2026-09-30). Regular
// season only (Mike, 2026-09-30): a slug date before the start is spring
// training, after the end is postseason, both excluded. NOT game_log's first
// date: game_log starts 2026-04-04, nine days after opening day (#486), and
// using it mislabeled ~110 regular-season markets as spring training.
const REGULAR_SEASON = {
  2026: { start: '2026-03-25', end: '2026-09-27' },     // opener NYY @ SF; postseason from 09-28
};

// game_log lookup, built once from a READ-ONLY handle.
function loadGameIndex(mlbDb) {
  const byKey = new Map(), dates = new Set();
  for (const g of mlbDb.prepare('SELECT game_date, game_id, scheduled_start_utc, first_pitch_utc, game_time, COALESCE(is_removed,0) removed FROM game_log').iterate()) {
    dates.add(g.game_date);
    if (g.removed) continue;
    const [a, h] = g.game_id.split('-');
    const k = g.game_date + '|' + a + '|' + h;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ game_id: g.game_id, game_date: g.game_date, scheduled_start_utc: g.scheduled_start_utc,
      first_pitch_utc: g.first_pitch_utc, game_time: g.game_time });
  }
  return { byKey, dates };
}

// The pre-game cutoff for a matched game (decision 4 and its fallback).
// -> { cutoff_utc, cutoff_source } | { reason }
function resolveCutoff(g, polyStartUtc) {
  const s = parseStart(g.scheduled_start_utc), f = parseStart(g.first_pitch_utc);
  if (f != null && (s == null || f < s)) return { cutoff_utc: f, cutoff_source: 'first_pitch_utc' };
  if (s != null) return { cutoff_utc: s, cutoff_source: 'scheduled_start_utc' };
  if (!g.game_time) return { reason: 'no_start_time' };                     // no start field at all
  const t = etGameTimeToUtc(g.game_date, g.game_time);
  if (t == null) return { reason: 'game_time_unparseable' };                 // e.g. no "ET" zone
  // A postponed game keeps its original game_time slot while Polymarket's
  // start moves to the make-up date, so this check is what catches it.
  if (polyStartUtc == null || Math.abs(t - polyStartUtc) > FALLBACK_TOLERANCE_S) return { reason: 'start_time_unconfirmed' };
  return { cutoff_utc: t, cutoff_source: 'fallback_confirmed' };
}

// Markets excluded by hand, each with its evidence. Checked before any
// matching, so a re-run can never re-admit them.
const MANUAL_EXCLUSIONS = {
  // Polymarket gameStartTime 2026-09-25 17:05Z and resolution Boston fit the
  // 9/25 doubleheader game 1 (BOS 4-3), not game_log's 9/27 game (CHC 6-2);
  // 1,709 of its fills were placed after its own start. (Mike, 2026-09-30)
  'mlb-chc-bos-2026-09-27': 'market_does_not_match_game',
};

// -> { status: 'matched', game_date, game_id, cutoff_utc, cutoff_source, outcome0_is_home } | { status: 'excluded', reason }
function matchMarket(m, gi, allSlugs) {
  if (MANUAL_EXCLUSIONS[m.slug]) return { status: 'excluded', reason: MANUAL_EXCLUSIONS[m.slug] };
  const p = SLUG_RE.exec(m.slug || '');
  if (!p) return { status: 'excluded', reason: 'nonstandard_slug' };
  const date = p[3], dh2 = !!p[4];
  const season = REGULAR_SEASON[date.slice(0, 4)];
  if (!season) return { status: 'excluded', reason: 'season_dates_unknown' };
  if (date < season.start) return { status: 'excluded', reason: 'spring_training' };
  if (date > season.end) return { status: 'excluded', reason: 'postseason_out_of_scope' };
  if (!gi.dates.has(date)) return { status: 'excluded', reason: 'missing_game_log_date' };
  const t0 = POLY.resolveTeamSlug(m.outcome0), t1 = POLY.resolveTeamSlug(m.outcome1);
  if (!t0 || !t1) return { status: 'excluded', reason: 'unresolved_team_name' };
  let cands = gi.byKey.get(date + '|' + t0 + '|' + t1), outcome0IsHome = 0;
  if (!cands) { cands = gi.byKey.get(date + '|' + t1 + '|' + t0); outcome0IsHome = 1; }
  if (!cands || !cands.length) return { status: 'excluded', reason: 'unmatched' };
  let g;
  if (cands.length === 1) {
    if (dh2 && !isGame2(cands[0].game_id)) return { status: 'excluded', reason: 'unmatched' };
    g = cands[0];
  } else {
    const g1 = cands.find(c => !isGame2(c.game_id)), g2 = cands.find(c => isGame2(c.game_id));
    if (dh2) g = g2;
    else if (allSlugs.has(m.slug + '-dh2')) g = g1;           // an explicit game-2 market exists: this is game 1
    else return { status: 'excluded', reason: 'dh_single_market' };
    if (!g) return { status: 'excluded', reason: 'unmatched' };
  }
  const c = resolveCutoff(g, m.poly_start_utc);
  if (c.reason) return { status: 'excluded', reason: c.reason };
  if (!m.resolved) return { status: 'excluded', reason: 'unresolved' };
  return { status: 'matched', game_date: date, game_id: g.game_id, cutoff_utc: c.cutoff_utc, cutoff_source: c.cutoff_source,
    outcome0_is_home: outcome0IsHome };
}
function matchAll(db, gi) {
  const allSlugs = new Set(db.prepare('SELECT slug FROM markets').all().map(r => r.slug));
  const upd = db.prepare(`UPDATE markets SET status = @status, exclusion_reason = @reason, slug_date = @slug_date,
    game_date = @game_date, game_id = @game_id, cutoff_utc = @cutoff_utc, cutoff_source = @cutoff_source,
    outcome0_is_home = @outcome0_is_home WHERE id = @id`);
  const rows = db.prepare("SELECT * FROM markets WHERE status IN ('new', 'excluded')").all();
  const tx = db.transaction(() => {
    for (const m of rows) {
      const r = matchMarket(m, gi, allSlugs);
      upd.run({ id: m.id, status: r.status, reason: r.reason || null, slug_date: slugDate(m.slug),
        game_date: r.game_date || null, game_id: r.game_id || null, cutoff_utc: r.cutoff_utc || null,
        cutoff_source: r.cutoff_source || null,
        outcome0_is_home: r.outcome0_is_home == null ? null : r.outcome0_is_home });
    }
  });
  tx();
  return rows.length;
}

// Remove everything fetched or derived for one market (fills, windows,
// wallet_game, net_short) and zero its counters. The market row stays.
function scrubMarket(db, id) {
  db.transaction(() => {
    for (const t of ['fills', 'windows', 'wallet_game', 'net_short']) db.prepare('DELETE FROM ' + t + ' WHERE market_id = ?').run(id);
    db.prepare(`UPDATE markets SET split_needed = 0, window_count = NULL, fills_stored = NULL, duplicates_dropped = 0,
      net_short_positions = NULL, net_short_wallet_games = NULL, wallet_games = NULL, done_at = NULL WHERE id = ?`).run(id);
  })();
}

// A market already fetched but now on MANUAL_EXCLUSIONS: scrub and exclude.
function applyManualExclusions(db) {
  const out = [];
  for (const [slug, reason] of Object.entries(MANUAL_EXCLUSIONS)) {
    const m = db.prepare('SELECT id, status, exclusion_reason FROM markets WHERE slug = ?').get(slug);
    if (!m || (m.status === 'excluded' && m.exclusion_reason === reason && !db.prepare('SELECT 1 FROM fills WHERE market_id = ?').get(m.id))) continue;
    scrubMarket(db, m.id);
    db.prepare(`UPDATE markets SET status = 'excluded', exclusion_reason = ?, cutoff_utc = NULL, cutoff_source = NULL WHERE id = ?`).run(reason, m.id);
    out.push(slug);
  }
  return out;
}

// Re-apply the CURRENT matching / cutoff rule to markets already fetched.
// Lists every change; changes nothing unless opts.apply.
//   cutoff moved EARLIER  -> drop fills at/after it, trim the windows, re-aggregate
//   cutoff moved LATER or the game changed -> scrub, back to 'matched' for a refetch
//   now excluded          -> scrub, exclude with the new reason
function recutDoneMarkets(db, gi, opts) {
  const o = Object.assign({ apply: false, only: null }, opts || {});   // only: a Set of slugs, or null for all
  const allSlugs = new Set(db.prepare('SELECT slug FROM markets').all().map(r => r.slug));
  const changes = [];
  for (const m of db.prepare("SELECT * FROM markets WHERE status IN ('fetched', 'done')").all()) {
    if (o.only && !o.only.has(m.slug)) continue;
    const r = matchMarket(m, gi, allSlugs);
    const base = { id: m.id, slug: m.slug, old_cutoff: m.cutoff_utc, old_source: m.cutoff_source };
    let ch = null;
    if (r.status !== 'matched') ch = Object.assign(base, { action: 'exclude', reason: r.reason });
    else if (r.game_id !== m.game_id || r.cutoff_utc > m.cutoff_utc) ch = Object.assign(base, { action: 'refetch', new_cutoff: r.cutoff_utc, new_source: r.cutoff_source, r });
    else if (r.cutoff_utc < m.cutoff_utc) ch = Object.assign(base, { action: 'truncate', new_cutoff: r.cutoff_utc, new_source: r.cutoff_source });
    else if (r.cutoff_source !== m.cutoff_source) ch = Object.assign(base, { action: 'relabel', new_cutoff: r.cutoff_utc, new_source: r.cutoff_source });
    if (!ch) continue;
    ch.fills_removed = ch.action === 'truncate'
      ? db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ? AND ts >= ?').get(m.id, ch.new_cutoff).c
      : ch.action === 'relabel' ? 0 : db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(m.id).c;
    changes.push(ch);
    if (!o.apply) continue;
    if (ch.action === 'exclude') {
      scrubMarket(db, m.id);
      db.prepare("UPDATE markets SET status = 'excluded', exclusion_reason = ?, cutoff_utc = NULL, cutoff_source = NULL WHERE id = ?").run(ch.reason, m.id);
    } else if (ch.action === 'refetch') {
      scrubMarket(db, m.id);
      db.prepare(`UPDATE markets SET status = 'matched', game_date = ?, game_id = ?, cutoff_utc = ?, cutoff_source = ?, outcome0_is_home = ? WHERE id = ?`)
        .run(ch.r.game_date, ch.r.game_id, ch.r.cutoff_utc, ch.r.cutoff_source, ch.r.outcome0_is_home, m.id);
    } else if (ch.action === 'relabel') {
      db.prepare('UPDATE markets SET cutoff_source = ? WHERE id = ?').run(ch.new_source, m.id);
    } else {
      const cut = ch.new_cutoff;
      db.transaction(() => {
        db.prepare('DELETE FROM fills WHERE market_id = ? AND ts >= ?').run(m.id, cut);
        // Windows tile [0, old cutoff - 1]: drop those wholly past the new
        // cutoff, shorten the one it falls in, and recount it. Its dropped-
        // duplicate count is kept (it cannot be split by time).
        // Split (parent) windows are history only and are left as they were.
        db.prepare("DELETE FROM windows WHERE market_id = ? AND t_start >= ? AND status = 'done'").run(m.id, cut);
        const w = db.prepare("SELECT t_start, t_end FROM windows WHERE market_id = ? AND t_end >= ? AND status = 'done'").get(m.id, cut);
        if (w) {
          const n = db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ? AND ts BETWEEN ? AND ?').get(m.id, w.t_start, cut - 1).c;
          db.prepare('UPDATE windows SET t_end = ?, fills = ? WHERE market_id = ? AND t_start = ? AND t_end = ?').run(cut - 1, n, m.id, w.t_start, w.t_end);
        }
        const wc = db.prepare("SELECT COUNT(*) c, SUM(fills) f, SUM(dups) d FROM windows WHERE market_id = ? AND status = 'done'").get(m.id);
        db.prepare('UPDATE markets SET cutoff_utc = ?, cutoff_source = ?, window_count = ?, fills_stored = ?, duplicates_dropped = ? WHERE id = ?')
          .run(cut, ch.new_source, wc.c, wc.f || 0, wc.d || 0, m.id);
      })();
      if (m.status === 'done') aggregateMarket(db, m.id);
    }
  }
  return changes;
}

// ---------------------------------------------------------------- fetch
function walletIdFn(db) {
  const cache = new Map();
  const ins = db.prepare('INSERT OR IGNORE INTO wallets (addr) VALUES (?)');
  const sel = db.prepare('SELECT id FROM wallets WHERE addr = ?');
  return (addr) => {
    const k = String(addr).toLowerCase();
    let id = cache.get(k);
    if (id == null) { ins.run(k); id = sel.get(k).id; cache.set(k, id); }
    return id;
  };
}
const tradesUrl = (cid, a, b, offset, limit) => DATA + '/trades?' + new URLSearchParams({
  market: cid, takerOnly: 'false', start: String(a), end: String(b), offset: String(offset), limit: String(limit) });

// Fetch every pre-game fill of one matched market. Resumable at window level:
// a window left 'pending' by a crash has its rows deleted and is fetched again.
async function fetchMarket(db, client, m, opts) {
  const o = Object.assign({ onPage: () => {} }, opts || {});
  const walletId = walletIdFn(db);
  const req0 = client.stats.requests;
  const cutoffEnd = m.cutoff_utc - 1;                          // strictly before scheduled start
  if (!db.prepare('SELECT 1 FROM windows WHERE market_id = ?').get(m.id)) {
    db.prepare("INSERT INTO windows (market_id, t_start, t_end, status) VALUES (?, 0, ?, 'pending')").run(m.id, cutoffEnd);
  }
  const insFill = db.prepare('INSERT INTO fills (market_id, wallet_id, ts, side, outcome, price, size) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const delWin = db.prepare('DELETE FROM fills WHERE market_id = ? AND ts BETWEEN ? AND ?');
  // Duplicates are counted PER WINDOW and summed at the end, so a count from a
  // run killed mid-market is not lost when the market is resumed.
  const setWin = db.prepare('UPDATE windows SET status = ?, fills = ?, dups = ? WHERE market_id = ? AND t_start = ? AND t_end = ?');
  const addWin = db.prepare("INSERT OR IGNORE INTO windows (market_id, t_start, t_end, status) VALUES (?, ?, ?, 'pending')");
  for (;;) {
    const w = db.prepare("SELECT t_start, t_end FROM windows WHERE market_id = ? AND status = 'pending' ORDER BY t_end DESC LIMIT 1").get(m.id);
    if (!w) break;
    delWin.run(m.id, w.t_start, w.t_end);                      // resume safety: drop a partial window
    // Over the cap? One row at offset MAX_OFFSET means > MAX_OFFSET fills.
    const probe = await client.getJson(tradesUrl(m.condition_id, w.t_start, w.t_end, MAX_OFFSET, 1));
    if (Array.isArray(probe) && probe.length) {
      if (w.t_start >= w.t_end) throw new Error('window ' + w.t_start + ' is a single second over the offset cap: cannot split -- ' + m.slug);
      const mid = Math.floor((w.t_start + w.t_end) / 2);
      db.transaction(() => {
        setWin.run('split', null, null, m.id, w.t_start, w.t_end);
        addWin.run(m.id, w.t_start, mid);
        addWin.run(m.id, mid + 1, w.t_end);
        db.prepare('UPDATE markets SET split_needed = 1 WHERE id = ?').run(m.id);
      })();
      continue;
    }
    // Page it. Newest first; the window is under the cap, so offsets never pass it.
    const seen = new Set();
    let n = 0, dups = 0;
    for (let off = 0; off <= MAX_OFFSET; off += PAGE) {
      const page = await client.getJson(tradesUrl(m.condition_id, w.t_start, w.t_end, off, PAGE));
      if (!Array.isArray(page)) throw new Error('non-array page for ' + m.slug);
      db.transaction(() => {
        for (const t of page) {
          const ts = Number(t.timestamp);
          if (!(ts >= w.t_start && ts <= w.t_end && ts < m.cutoff_utc)) continue;   // defensive: the API filters too
          const key = [t.transactionHash, t.proxyWallet, t.side, t.outcomeIndex, t.price, t.size, ts].join('|');
          if (seen.has(key)) { dups++; continue; }
          seen.add(key);
          insFill.run(m.id, walletId(t.proxyWallet), ts, t.side === 'BUY' ? 1 : -1, Number(t.outcomeIndex), Number(t.price), Number(t.size));
          n++;
        }
      })();
      o.onPage();
      if (page.length < PAGE) break;
    }
    setWin.run('done', n, dups, m.id, w.t_start, w.t_end);
  }
  const wc = db.prepare("SELECT COUNT(*) c, SUM(fills) f, SUM(dups) d FROM windows WHERE market_id = ? AND status = 'done'").get(m.id);
  db.prepare("UPDATE markets SET status = 'fetched', window_count = ?, fills_stored = ?, duplicates_dropped = ?, requests = requests + ? WHERE id = ?")
    .run(wc.c, wc.f || 0, wc.d || 0, client.stats.requests - req0, m.id);
}

// ---------------------------------------------------------------- profit
// Per wallet per market, from pre-game fills and the resolution:
//   spent    = sum(price x size) over buys
//   received = sum(price x size) over sells (before first pitch)
//   payout   = net shares held on the winning team (x $1)
//   profit   = received - spent + payout
//   volume   = spent + received
// A wallet net SHORT either team (sold shares it never bought: share
// splitting) is excluded from wallet_game and recorded in net_short.
function aggregateMarket(db, marketId) {
  const m = db.prepare('SELECT id, winner_idx FROM markets WHERE id = ?').get(marketId);
  db.prepare('DELETE FROM wallet_game WHERE market_id = ?').run(marketId);
  db.prepare('DELETE FROM net_short WHERE market_id = ?').run(marketId);
  const insWG = db.prepare('INSERT INTO wallet_game VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insNS = db.prepare('INSERT INTO net_short VALUES (?, ?, ?, ?)');
  let wallets = 0, nsPositions = 0, nsWallets = 0;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const shorts = cur.pos.filter(p => p.net < -1e-9);
    if (shorts.length) {
      nsWallets++; nsPositions += shorts.length;
      for (const p of shorts) insNS.run(marketId, cur.wallet, p.outcome, p.net);
    } else {
      const spent = cur.pos.reduce((s, p) => s + p.spent, 0), received = cur.pos.reduce((s, p) => s + p.received, 0);
      const win = cur.pos.find(p => p.outcome === m.winner_idx);
      const payout = win ? Math.max(0, win.net) : 0;
      insWG.run(marketId, cur.wallet, spent, received, payout, received - spent + payout, spent + received,
        cur.pos.reduce((s, p) => s + p.fills, 0));
      wallets++;
    }
    cur = null;
  };
  // .all(), not .iterate(): better-sqlite3 refuses writes on a connection
  // while an iterator is open, and this is one market's wallet x team totals
  // (a few thousand rows at most), never its fills.
  const rows = db.prepare(`SELECT wallet_id, outcome,
      SUM(side * size) net, SUM(CASE WHEN side = 1 THEN price * size ELSE 0 END) spent,
      SUM(CASE WHEN side = -1 THEN price * size ELSE 0 END) received, COUNT(*) fills
    FROM fills WHERE market_id = ? GROUP BY wallet_id, outcome ORDER BY wallet_id, outcome`).all(marketId);
  db.transaction(() => {
    for (const r of rows) {
      if (!cur || cur.wallet !== r.wallet_id) { flush(); cur = { wallet: r.wallet_id, pos: [] }; }
      cur.pos.push(r);
    }
    flush();
    db.prepare("UPDATE markets SET status = 'done', net_short_positions = ?, net_short_wallet_games = ?, wallet_games = ?, done_at = datetime('now') WHERE id = ?")
      .run(nsPositions, nsWallets, wallets, marketId);
  })();
  return { wallets, nsPositions, nsWallets };
}

module.exports = { openStore, makeClient, discoverSlugs, discoverRange, marketFromEvent, upsertMarket,
  loadGameIndex, matchMarket, matchAll, fetchMarket, aggregateMarket, parseStart, slugDate,
  etGameTimeToUtc, resolveCutoff, auditGameTimeRule, FALLBACK_TOLERANCE_S,
  MANUAL_EXCLUSIONS, REGULAR_SEASON, scrubMarket, applyManualExclusions, recutDoneMarkets, END_DATE_SLACK_DAYS,
  PAGE, MAX_OFFSET, SCHEMA };
