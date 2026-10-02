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
//      KEEP EVERY ROW (2026-10-01). /trades has no fill id, and identical
//      rows are real, distinct fills: one taker matched against several
//      orders of the same maker at the same price and size (measured: tx
//      0x669ae54a... in mlb-tb-phi-2026-09-27 -- its 48 maker rows sum to the
//      taker's 71,787.21 shares only with the repeats kept). Paging by offset
//      is stable (5 page sizes, identical multisets), so nothing is
//      de-duplicated. Windows are HALF-OPEN [t_start, t_end) on the trade
//      timestamp and never overlap: a trade at ts belongs to the one window
//      with t_start <= ts < t_end, so a trade exactly on a split boundary is
//      fetched once, by the later window.
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

// Client, discovery, game matching and the half-open window fetch live in
// utils/polymarket-trades.js (moved 2026-10-01, unchanged), shared with the
// live top-traders job: one implementation, nothing copied.
const PT = require('../utils/polymarket-trades');
const { PAGE, MAX_OFFSET, GAMMA, makeClient, parseStart, marketFromEvent, slugDate, isGame2, SLUG_RE,
  END_DATE_SLACK_DAYS, iterMoneylineMarkets, etGameTimeToUtc, FALLBACK_TOLERANCE_S, REGULAR_SEASON,
  gameIndexFromRows, resolveCutoff, pickGame, parseTrade, fetchWindows } = PT;

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
  fills INTEGER, dups INTEGER,
  half_open INTEGER NOT NULL DEFAULT 0,         -- 1: [t_start, t_end) (since 2026-10-01); 0: legacy closed [t_start, t_end]
  PRIMARY KEY (market_id, t_start, t_end)) WITHOUT ROWID;
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
  // 2026-10-01: half-open windows, and the per-market marker for the re-fetch
  // of markets whose repeats the old de-duplication dropped.
  if (!db.prepare('PRAGMA table_info(windows)').all().some(c => c.name === 'half_open')) {
    db.exec('ALTER TABLE windows ADD COLUMN half_open INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(markets)').all().some(c => c.name === 'repeats_refetch')) {
    db.exec('ALTER TABLE markets ADD COLUMN repeats_refetch TEXT');          // NULL | pending | done
    db.exec('ALTER TABLE markets ADD COLUMN repeats_dropped_v1 INTEGER');   // the old run's duplicates_dropped, kept
    db.exec('ALTER TABLE markets ADD COLUMN repeats_refetched_at TEXT');
  }
  return db;
}

// ---------------------------------------------------------------- discovery
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
// ... or by date range (the full run): utils/polymarket-trades.js iterMoneylineMarkets
// (3-day end_date windows, END_DATE_SLACK_DAYS past `to`, filtered by slug date).
async function discoverRange(db, client, from, to) {
  let n = 0;
  for await (const m of iterMoneylineMarkets(client, from, to)) { upsertMarket(db, m); n++; }
  return n;
}

// ---------------------------------------------------------------- matching
// game_time -> UTC (etGameTimeToUtc) and the 15-minute fallback tolerance:
// utils/polymarket-trades.js.

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

// MLB's regular season (REGULAR_SEASON) and the cutoff rule (resolveCutoff):
// utils/polymarket-trades.js.

// game_log lookup, built once from a READ-ONLY handle.
function loadGameIndex(mlbDb) {
  return gameIndexFromRows(mlbDb.prepare('SELECT game_date, game_id, scheduled_start_utc, first_pitch_utc, game_time, COALESCE(is_removed,0) removed FROM game_log').iterate());
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
  const date = p[3];
  const season = REGULAR_SEASON[date.slice(0, 4)];
  if (!season) return { status: 'excluded', reason: 'season_dates_unknown' };
  if (date < season.start) return { status: 'excluded', reason: 'spring_training' };
  if (date > season.end) return { status: 'excluded', reason: 'postseason_out_of_scope' };
  if (!gi.dates.has(date)) return { status: 'excluded', reason: 'missing_game_log_date' };
  const t0 = POLY.resolveTeamSlug(m.outcome0), t1 = POLY.resolveTeamSlug(m.outcome1);
  if (!t0 || !t1) return { status: 'excluded', reason: 'unresolved_team_name' };
  let cands = gi.byKey.get(date + '|' + t0 + '|' + t1), outcome0IsHome = 0;
  if (!cands) { cands = gi.byKey.get(date + '|' + t1 + '|' + t0); outcome0IsHome = 1; }
  const pg = pickGame(m.slug, cands, allSlugs);
  if (pg.reason) return { status: 'excluded', reason: pg.reason };
  const g = pg.g;
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
        // Legacy windows are closed [t_start, t_end]; windows written since
        // 2026-10-01 are half-open [t_start, t_end) (half_open = 1).
        db.prepare("DELETE FROM windows WHERE market_id = ? AND t_start >= ? AND status = 'done'").run(m.id, cut);
        const w = db.prepare(`SELECT t_start, t_end, half_open FROM windows WHERE market_id = ? AND status = 'done'
          AND ((half_open = 0 AND t_end >= ?) OR (half_open = 1 AND t_end > ?))`).get(m.id, cut, cut);
        if (w) {
          const n = db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ? AND ts >= ? AND ts < ?').get(m.id, w.t_start, cut).c;
          db.prepare('UPDATE windows SET t_end = ?, fills = ? WHERE market_id = ? AND t_start = ? AND t_end = ?')
            .run(w.half_open ? cut : cut - 1, n, m.id, w.t_start, w.t_end);
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
// Fetch every pre-game fill of one matched market, KEEPING EVERY ROW (decision
// 1). Windows are half-open [t_start, t_end): the first is [0, cutoff), so a
// fill at or after the cutoff is never in any window. A trade at ts belongs to
// the one window with t_start <= ts < t_end. The API's start/end are INCLUSIVE
// seconds, so a window is requested as start = t_start, end = t_end - 1.
// Resumable at window level: a window left 'pending' by a crash has its rows
// deleted and is fetched again.
async function fetchMarket(db, client, m, opts) {
  const o = Object.assign({ onPage: () => {} }, opts || {});
  if (db.prepare('SELECT 1 FROM windows WHERE market_id = ? AND half_open = 0').get(m.id)) {
    throw new Error(m.slug + ' still has legacy closed windows; reset it first (resetMarketForRefetch)');
  }
  const walletId = walletIdFn(db);
  const req0 = client.stats.requests;
  if (!db.prepare('SELECT 1 FROM windows WHERE market_id = ?').get(m.id)) {
    db.prepare("INSERT INTO windows (market_id, t_start, t_end, status, half_open) VALUES (?, 0, ?, 'pending', 1)").run(m.id, m.cutoff_utc);
  }
  const insFill = db.prepare('INSERT INTO fills (market_id, wallet_id, ts, side, outcome, price, size) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const delWin = db.prepare('DELETE FROM fills WHERE market_id = ? AND ts >= ? AND ts < ?');
  const setWin = db.prepare('UPDATE windows SET status = ?, fills = ?, dups = 0 WHERE market_id = ? AND t_start = ? AND t_end = ?');
  const addWin = db.prepare("INSERT OR IGNORE INTO windows (market_id, t_start, t_end, status, half_open) VALUES (?, ?, ?, 'pending', 1)");
  // The window store is this database's windows table, so a kill resumes at window level.
  const store = {
    next: () => db.prepare("SELECT t_start, t_end FROM windows WHERE market_id = ? AND status = 'pending' ORDER BY t_end DESC LIMIT 1").get(m.id) || null,
    begin: (w) => delWin.run(m.id, w.t_start, w.t_end),           // resume safety: drop a partial window
    split: (w, mid) => db.transaction(() => {
      setWin.run('split', null, m.id, w.t_start, w.t_end);
      addWin.run(m.id, w.t_start, mid);
      addWin.run(m.id, mid, w.t_end);
      db.prepare('UPDATE markets SET split_needed = 1 WHERE id = ?').run(m.id);
    })(),
    done: (w, n) => setWin.run('done', n, m.id, w.t_start, w.t_end),
  };
  await fetchWindows(client, m.condition_id, store, (w, page) => {
    let n = 0;
    db.transaction(() => {
      for (const raw of page) {
        const t = parseTrade(raw);
        if (!(t.ts >= w.t_start && t.ts < w.t_end && t.ts < m.cutoff_utc)) continue;   // defensive: the API filters too
        insFill.run(m.id, walletId(t.wallet), t.ts, t.side, t.outcome, t.price, t.size);
        n++;
      }
    })();
    o.onPage();
    return n;
  }, m.slug);
  const wc = db.prepare("SELECT COUNT(*) c, SUM(fills) f FROM windows WHERE market_id = ? AND status = 'done'").get(m.id);
  db.prepare("UPDATE markets SET status = 'fetched', window_count = ?, fills_stored = ?, duplicates_dropped = 0, requests = requests + ? WHERE id = ?")
    .run(wc.c, wc.f || 0, client.stats.requests - req0, m.id);
}

// ---------------------------------------------------------------- re-fetch (2026-10-01)
// Markets the old run fetched with within-window de-duplication, which dropped
// real repeated fills. initRepeatsRefetch marks them once (the old count kept in
// repeats_dropped_v1); refetchMarket then replaces each one's fills and windows
// wholesale and recomputes only its wallet_game / net_short rows. Resumable per
// market: a market killed mid-way is in 'matched'/'fetched' with half-open
// windows and continues where it stopped; one already finished is not redone.
function initRepeatsRefetch(db) {
  return db.prepare(`UPDATE markets SET repeats_refetch = 'pending', repeats_dropped_v1 = duplicates_dropped
    WHERE status = 'done' AND duplicates_dropped > 0 AND repeats_refetch IS NULL`).run().changes;
}
function resetMarketForRefetch(db, id) {
  db.transaction(() => {
    for (const t of ['fills', 'windows', 'wallet_game', 'net_short']) db.prepare('DELETE FROM ' + t + ' WHERE market_id = ?').run(id);
    db.prepare(`UPDATE markets SET status = 'matched', split_needed = 0, window_count = NULL, fills_stored = NULL, duplicates_dropped = 0,
      net_short_positions = NULL, net_short_wallet_games = NULL, wallet_games = NULL, done_at = NULL WHERE id = ?`).run(id);
  })();
}
async function refetchMarket(db, client, marketId, opts) {
  let m = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
  if (m.repeats_refetch !== 'pending') return { skipped: true };
  const legacy = db.prepare('SELECT 1 FROM windows WHERE market_id = ? AND half_open = 0').get(m.id);
  if (m.status === 'done' && legacy) { resetMarketForRefetch(db, m.id); m = db.prepare('SELECT * FROM markets WHERE id = ?').get(m.id); }
  if (m.status === 'matched') { await fetchMarket(db, client, m, opts); m = db.prepare('SELECT * FROM markets WHERE id = ?').get(m.id); }
  const agg = m.status === 'fetched' ? aggregateMarket(db, m.id) : null;      // 'done' with half-open windows: already aggregated
  db.prepare("UPDATE markets SET repeats_refetch = 'done', repeats_refetched_at = datetime('now') WHERE id = ?").run(m.id);
  return { skipped: false, agg };
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
  initRepeatsRefetch, resetMarketForRefetch, refetchMarket,
  etGameTimeToUtc, resolveCutoff, auditGameTimeRule, FALLBACK_TOLERANCE_S,
  MANUAL_EXCLUSIONS, REGULAR_SEASON, scrubMarket, applyManualExclusions, recutDoneMarkets, END_DATE_SLACK_DAYS,
  PAGE, MAX_OFFSET, SCHEMA };
