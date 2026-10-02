'use strict';

// Top-traders card, PR B (2026-10-01): the LIVE LEAN JOB.
// docs/polymarket-top-traders-card-decisions-2026-10-01.md. DISPLAY ONLY --
// nothing in the pricing path reads this module or its tables, and
// services/jobs.js / routes/api.js never reference it
// (scripts/test-top-traders-card-b.js check g).
//
// KILL SWITCH: runs only when the environment variable TOP_TRADERS_LIVE=on.
// Anything else (unset included) means OFF: no fetches and no writes at all.
// The state is logged once at startup.
//
// SCHEDULING: startTopTradersLive() (called from server.js) ticks every 5
// minutes. A tick that finds work due enqueues ONE job through the app's
// serial job queue (services/jobs.js _queued, passed in by server.js as
// withMemLog), so a pass never runs alongside another job. A tick while that
// job is still queued or running enqueues nothing. Per game:
//   - provisional passes at about T-3h, T-1h and T-15m before the scheduled
//     start (game_log.scheduled_start_utc); a late start runs only the latest
//     due pass. None at or after the cutoff.
//   - the final pass once BOTH odds_locked_at and the cutoff have passed (+2
//     minutes). With no lock 6 hours after the cutoff, the final row records
//     the price-step skip instead (decision 6, #488).
//
// TRADES: there is no trade id, so NOTHING is de-duplicated; every row
// Polymarket returns is kept, identical repeats included. All fetching goes
// through utils/polymarket-trades.js (the backfill's client: half-open windows
// requested with end = t_end - 1, splitting over the offset cap, sequential
// requests, backoff) -- nothing copied.
//   - A provisional pass fetches only [last_end, now - 2 minutes), where
//     last_end is where the previous pass ended. It first deletes any stored
//     row at or after last_end (what a killed pass may have left), and moves
//     last_end only once the whole range is stored, so a range is never
//     counted twice. Provisional leans are display only.
//   - The final pass deletes the game's stored fills and re-fetches the full
//     pre-game range [0, cutoff), then computes the lean from fills with
//     ts < min(lock, cutoff), exactly as the backtest does. Exact by
//     construction.
// Only the QUALIFIED wallets' fills are stored (wallet id, outcome, side,
// price, size, ts); addresses are matched in memory and never stored here.
// RETENTION (decision 3, amended): only for games in progress -- a game's
// fills are deleted in the same transaction that writes its final row.
//
// SNAPSHOT: a game on date D uses the latest top_trader_qualified as_of <= D.
// Postseason dates use the snapshot at the first postseason date (2026-09-28:
// qualification frozen at 2026-09-27, decision 9). A regular-season date with
// no snapshot from its own season does nothing and logs why (settlement is
// deferred to the 2027 build). Rules: utils/top-traders/rules.js.
//
// No network call is ever made inside a web request: routes/top-traders.js
// reads stored rows only. Every page is processed and dropped as it arrives.

const PT = require('../utils/polymarket-trades');
const RULES = require('../utils/top-traders/rules');
const { _internal: POLY } = require('./polymarket');   // resolveTeamSlug only (team name -> abbr)

const PASSES = [['t180', 180 * 60], ['t60', 60 * 60], ['t15', 15 * 60]];   // [name, seconds before the scheduled start]
const LAG_S = 120;                       // passes stop 2 minutes before now (trades API indexing lag)
const NO_LOCK_GIVE_UP_S = 6 * 3600;      // final without a lock: record the price-step skip this long after the cutoff
const TICK_MS = 5 * 60 * 1000;

const isOn = (env) => String((env || process.env).TOP_TRADERS_LIVE || '').trim().toLowerCase() === 'on';
let _db = null;
const appDb = () => (_db || (_db = require('../db/schema').db));   // the app's handle; opened lazily
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const isoNow = (s) => new Date(s * 1000).toISOString();

// ---------------------------------------------------------------- snapshot rule
// -> { as_of, postseason, count } | { reason, postseason? }
function snapshotFor(db, date) {
  const season = PT.REGULAR_SEASON[date.slice(0, 4)];
  if (!season) return { reason: 'season_dates_unknown' };
  if (date < season.start) return { reason: 'before_regular_season' };
  const postseason = date > season.end;
  const cap = postseason ? addDays(season.end, 1) : date;          // postseason: frozen at the first postseason date
  const row = db.prepare('SELECT MAX(as_of) a FROM top_trader_qualified WHERE as_of <= ?').get(cap);
  if (!row || !row.a || row.a < season.start) return { reason: 'no_same_season_snapshot', postseason };
  const count = db.prepare('SELECT COUNT(*) c FROM top_trader_qualified WHERE as_of = ?').get(row.a).c;
  return { as_of: row.a, postseason, count };
}
// The snapshot's qualified wallets: lower-case address -> wallet id, in memory only.
function qualifiedByAddr(db, asOf) {
  const m = new Map();
  for (const r of db.prepare(`SELECT w.wallet_id id, w.addr a FROM top_trader_qualified q
      JOIN top_trader_wallets w ON w.wallet_id = q.wallet_id WHERE q.as_of = ?`).iterate(asOf)) m.set(String(r.a).toLowerCase(), r.id);
  return m;
}

// ---------------------------------------------------------------- games and markets
function gamesOn(db, date) {
  return db.prepare(`SELECT game_date, game_id, scheduled_start_utc, first_pitch_utc, game_time, odds_locked_at,
      market_away_ml, market_home_ml, ml_source, market_contamination_reason, COALESCE(is_removed, 0) removed
    FROM game_log WHERE game_date = ?`).all(date);
}
const marketRow = (db, g) => db.prepare('SELECT * FROM top_trader_live_markets WHERE game_date = ? AND game_id = ?').get(g.game_date, g.game_id);

// Find the date's Polymarket moneyline markets and match them to game_log
// (team names -> abbrs, doubleheaders, cutoff): the backfill's own rules, from
// utils/polymarket-trades.js. Runs only when a game of the date has no market yet.
async function discoverMarkets(db, client, date, games, nowS) {
  const live = games.filter(g => !g.removed);
  if (live.every(g => { const r = marketRow(db, g); return r && r.condition_id; })) return 0;
  const markets = [];
  for await (const m of PT.iterMoneylineMarkets(client, date, date)) markets.push(m);
  const allSlugs = new Set(markets.map(m => m.slug));
  const gi = PT.gameIndexFromRows(games);
  const up = db.prepare(`INSERT INTO top_trader_live_markets (game_date, game_id, condition_id, slug, outcome0_is_home, cutoff_utc, cutoff_source, reason, discovered_at)
    VALUES (@game_date, @game_id, @condition_id, @slug, @outcome0_is_home, @cutoff_utc, @cutoff_source, @reason, @at)
    ON CONFLICT(game_date, game_id) DO UPDATE SET condition_id = excluded.condition_id, slug = excluded.slug,
      outcome0_is_home = excluded.outcome0_is_home, cutoff_utc = excluded.cutoff_utc, cutoff_source = excluded.cutoff_source,
      reason = excluded.reason, discovered_at = excluded.discovered_at`);
  const matched = new Set();
  db.transaction(() => {
    for (const m of markets) {
      const t0 = POLY.resolveTeamSlug(m.outcome0), t1 = POLY.resolveTeamSlug(m.outcome1);
      if (!t0 || !t1) continue;
      let cands = gi.byKey.get(date + '|' + t0 + '|' + t1), o0h = 0;
      if (!cands) { cands = gi.byKey.get(date + '|' + t1 + '|' + t0); o0h = 1; }
      const pg = PT.pickGame(m.slug, cands, allSlugs);
      if (pg.reason) continue;
      const c = PT.resolveCutoff(pg.g, m.poly_start_utc);
      up.run({ game_date: date, game_id: pg.g.game_id, condition_id: c.reason ? null : m.condition_id, slug: m.slug,
        outcome0_is_home: o0h, cutoff_utc: c.cutoff_utc || null, cutoff_source: c.cutoff_source || null, reason: c.reason || null, at: isoNow(nowS) });
      matched.add(pg.g.game_id);
    }
    for (const g of live) {
      if (matched.has(g.game_id)) continue;
      const r = marketRow(db, g);
      if (!r || !r.condition_id) up.run({ game_date: date, game_id: g.game_id, condition_id: null, slug: null, outcome0_is_home: null,
        cutoff_utc: null, cutoff_source: null, reason: 'no_polymarket_market', at: isoNow(nowS) });
    }
  })();
  return markets.length;
}

// ---------------------------------------------------------------- fetch and store
// Fetch [start, end) of one market and store the qualified wallets' rows, every
// one of them. -> { fetched, kept }
async function fetchAndStore(db, client, g, mkt, start, end, qmap) {
  const ins = db.prepare(`INSERT INTO top_trader_live_fills (game_date, game_id, wallet_id, outcome, side, price, size, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const out = { fetched: 0, kept: 0 };
  if (!(end > start)) return out;
  await PT.fetchWindows(client, mkt.condition_id, PT.memoryWindowStore(start, end), (w, page) => {
    let n = 0;
    db.transaction(() => {
      for (const raw of page) {
        const t = PT.parseTrade(raw);
        if (!(t.ts >= w.t_start && t.ts < w.t_end && t.ts < mkt.cutoff_utc)) continue;   // defensive: the API filters too
        out.fetched++;
        const id = qmap.get(t.wallet);
        if (id == null) continue;
        ins.run(g.game_date, g.game_id, id, t.outcome, t.side, t.price, t.size, t.ts);
        n++;
      }
    })();
    out.kept += n;
    return n;
  }, mkt.slug);
  return out;
}

// The lean from stored fills with ts < cut: the rules module's own accumulator
// and lean step (§4), the same `price * size` as the backtest.
// -> { leanOutcome, net, wallets, share } | { skip, wallets }
function leanFromStored(db, g, cut) {
  const acc = RULES.newLeanAcc(), per = new Map();
  for (const f of db.prepare(`SELECT wallet_id, outcome, side, price * size usd FROM top_trader_live_fills
      WHERE game_date = ? AND game_id = ? AND ts < ?`).iterate(g.game_date, g.game_id, cut)) {
    RULES.addFill(acc, f.outcome, f.side, f.usd);
    let w = per.get(f.wallet_id);
    if (!w) per.set(f.wallet_id, (w = [0, 0]));
    w[f.outcome] += f.side * f.usd;
  }
  const ln = RULES.leanFrom(acc);
  if (ln.skip) return { skip: ln.skip, wallets: per.size };
  return { leanOutcome: ln.leanOutcome, net: acc.net, wallets: per.size, share: RULES.largestWalletShare(per, ln.leanOutcome, acc.net[ln.leanOutcome]) };
}
const leanTeam = (g, mkt, leanOutcome) => {
  const [away, home] = g.game_id.split('-');
  const leanIsHome = (leanOutcome === 0) === (mkt.outcome0_is_home === 1);
  return String(leanIsHome ? home : away).toUpperCase();
};

const insLog = (db, row) => db.prepare(`INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, lean_team, lean_dollars,
    other_dollars, wallets_with_money, top_wallet_share, qualified_count, away_ml_shown, home_ml_shown, price_source, kind, phase,
    locked_away_ml, locked_home_ml, skip_reason, snapshot_as_of)
  VALUES (@game_date, @game_id, @shown_at, @cut_utc, @lean_team, @lean_dollars, @other_dollars, @wallets_with_money, @top_wallet_share,
    @qualified_count, @away_ml_shown, @home_ml_shown, @price_source, @kind, @phase, @locked_away_ml, @locked_home_ml, @skip_reason, @snapshot_as_of)
  ON CONFLICT(game_date, game_id) WHERE kind = 'final' DO NOTHING`).run(row).changes;
function logRow(g, mkt, snap, kind, cut, nowS, lean, extra) {
  const L = lean && lean.leanOutcome != null ? lean.leanOutcome : null;
  return Object.assign({
    game_date: g.game_date, game_id: g.game_id, shown_at: isoNow(nowS), cut_utc: cut,
    lean_team: L == null ? null : leanTeam(g, mkt, L),
    lean_dollars: L == null ? null : lean.net[L], other_dollars: L == null ? null : lean.net[1 - L],
    wallets_with_money: lean ? lean.wallets : null, top_wallet_share: L == null ? null : lean.share,
    qualified_count: snap.count, away_ml_shown: g.market_away_ml == null ? null : g.market_away_ml,
    home_ml_shown: g.market_home_ml == null ? null : g.market_home_ml, price_source: g.ml_source || null,
    kind, phase: snap.postseason ? 'postseason' : 'regular', locked_away_ml: null, locked_home_ml: null,
    skip_reason: lean && lean.skip ? lean.skip : null, snapshot_as_of: snap.as_of,
  }, extra || {});
}
function setState(db, g, snapAsOf, lastEnd, passName, nowS) {
  db.prepare(`INSERT INTO top_trader_live_state (game_date, game_id, snapshot_as_of, last_end, passes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_date, game_id) DO UPDATE SET snapshot_as_of = excluded.snapshot_as_of, last_end = excluded.last_end,
      passes = CASE WHEN excluded.passes = '' THEN top_trader_live_state.passes
                    WHEN top_trader_live_state.passes = '' THEN excluded.passes
                    ELSE top_trader_live_state.passes || ',' || excluded.passes END,
      updated_at = excluded.updated_at`).run(g.game_date, g.game_id, snapAsOf, lastEnd, passName || '', isoNow(nowS));
}
// RETENTION (decision 3, amended 2026-10-01): a game's stored live fills exist only while it is in
// progress. The final row (a lean or a skip) and the deletion of the game's fills happen in ONE
// transaction; the lean log keeps the summary. -> 1 when the final row was written, 0 when one existed.
function writeFinal(db, g, row) {
  return db.transaction(() => {
    const wrote = insLog(db, row);
    db.prepare('DELETE FROM top_trader_live_fills WHERE game_date = ? AND game_id = ?').run(g.game_date, g.game_id);
    return wrote;
  })();
}
const stateOf = (db, g) => db.prepare('SELECT * FROM top_trader_live_state WHERE game_date = ? AND game_id = ?').get(g.game_date, g.game_id);
const hasFinal = (db, g) => !!db.prepare("SELECT 1 FROM top_trader_lean_log WHERE game_date = ? AND game_id = ? AND kind = 'final'").get(g.game_date, g.game_id);

// ---------------------------------------------------------------- one game
// opts: { db, client, nowS, env, log }. kind: 'provisional' | 'final'.
// -> a summary object (what happened, and why when nothing did).
async function runGame(opts, gameDate, gameId, kind, passName) {
  if (!isOn(opts.env)) return { disabled: true };                       // KILL SWITCH: no fetch, no write
  const { db, client, nowS } = opts;
  const log = opts.log || (() => {});
  const snap = snapshotFor(db, gameDate);
  if (snap.reason) { log('[top-traders-live] ' + gameDate + ' ' + gameId + ': nothing done -- ' + snap.reason); return { skipped: snap.reason }; }
  const games = gamesOn(db, gameDate);
  const g = games.find(x => x.game_id === gameId && !x.removed);
  if (!g) return { skipped: 'no_game_log_row' };
  // Idempotent: once a game has its final row, no pass of either kind fetches or writes anything for it.
  if (hasFinal(db, g)) return { skipped: 'final_exists' };
  const req0 = client.stats.requests;
  await discoverMarkets(db, client, gameDate, games, nowS);
  let mkt = marketRow(db, g);
  // The cutoff is re-read from game_log on every pass (first_pitch_utc appears at the game).
  if (mkt && mkt.condition_id) {
    const c = PT.resolveCutoff(g, null);
    if (!c.reason && c.cutoff_utc !== mkt.cutoff_utc) {
      db.prepare('UPDATE top_trader_live_markets SET cutoff_utc = ?, cutoff_source = ? WHERE game_date = ? AND game_id = ?')
        .run(c.cutoff_utc, c.cutoff_source, g.game_date, g.game_id);
      mkt = marketRow(db, g);
    }
  }
  const base = { game: gameDate + ' ' + gameId, kind, snapshot_as_of: snap.as_of, qualified: snap.count, postseason: snap.postseason,
    market: mkt && mkt.condition_id ? mkt.slug : null };
  if (snap.count < RULES.MIN_QUALIFIED) {                                // §3 eligibility
    if (kind === 'final') writeFinal(db, g, logRow(g, mkt || {}, snap, 'final', mkt && mkt.cutoff_utc || 0, nowS, { skip: 'not_eligible', wallets: null }));
    return Object.assign(base, { skipped: 'not_eligible' });
  }
  if (!mkt || !mkt.condition_id) {
    if (kind === 'final') writeFinal(db, g, logRow(g, {}, snap, 'final', 0, nowS, { skip: (mkt && mkt.reason) || 'no_polymarket_market', wallets: null }));
    return Object.assign(base, { skipped: (mkt && mkt.reason) || 'no_polymarket_market', requests: client.stats.requests - req0 });
  }
  const qmap = qualifiedByAddr(db, snap.as_of);
  const cutoff = mkt.cutoff_utc;
  if (kind === 'provisional') {
    if (nowS >= cutoff) return Object.assign(base, { skipped: 'at_or_after_cutoff' });
    let st = stateOf(db, g);
    if (st && st.snapshot_as_of !== snap.as_of) {                          // a new snapshot: start over with its wallets
      db.prepare('DELETE FROM top_trader_live_fills WHERE game_date = ? AND game_id = ?').run(g.game_date, g.game_id);
      db.prepare('DELETE FROM top_trader_live_state WHERE game_date = ? AND game_id = ?').run(g.game_date, g.game_id);
      st = null;
    }
    const start = st ? st.last_end : 0, end = Math.min(nowS - LAG_S, cutoff);
    // Resume safety: a pass killed mid-range left rows at or after last_end; they are fetched again now.
    db.prepare('DELETE FROM top_trader_live_fills WHERE game_date = ? AND game_id = ? AND ts >= ?').run(g.game_date, g.game_id, start);
    const r = await fetchAndStore(db, client, g, mkt, start, end, qmap);
    const lastEnd = Math.max(start, end);
    setState(db, g, snap.as_of, lastEnd, passName || 'manual', nowS);
    const lock = RULES.parseUtc(g.odds_locked_at);
    const cut = Math.min(lastEnd, cutoff, lock == null ? Infinity : lock);
    const lean = leanFromStored(db, g, cut);
    insLog(db, logRow(g, mkt, snap, 'provisional', cut, nowS, lean));
    return Object.assign(base, { range: [start, lastEnd], fetched: r.fetched, kept: r.kept, cut, lean: summarize(g, mkt, lean),
      requests: client.stats.requests - req0 });
  }
  // FINAL: the price step first (§5); a skip is recorded with its reason, no fetch.
  const ps = RULES.priceStep(g);
  if (ps.skip) {
    writeFinal(db, g, logRow(g, mkt, snap, 'final', cutoff, nowS, { skip: ps.skip, wallets: null }));
    return Object.assign(base, { skipped: ps.skip, requests: client.stats.requests - req0 });
  }
  const cut = Math.min(ps.lock, cutoff);
  // Delete and re-fetch the whole pre-game range: no leftovers from the provisional passes.
  db.prepare('DELETE FROM top_trader_live_fills WHERE game_date = ? AND game_id = ?').run(g.game_date, g.game_id);
  setState(db, g, snap.as_of, 0, '', nowS);
  const r = await fetchAndStore(db, client, g, mkt, 0, cutoff, qmap);
  setState(db, g, snap.as_of, cutoff, 'final', nowS);
  const lean = leanFromStored(db, g, cut);
  const wrote = writeFinal(db, g, logRow(g, mkt, snap, 'final', cut, nowS, lean,
    { locked_away_ml: g.market_away_ml, locked_home_ml: g.market_home_ml }));
  return Object.assign(base, { range: [0, cutoff], fetched: r.fetched, kept: r.kept, cut, lean: summarize(g, mkt, lean), wrote,
    requests: client.stats.requests - req0 });
}
function summarize(g, mkt, lean) {
  if (lean.skip) return { skip: lean.skip, wallets: lean.wallets };
  const L = lean.leanOutcome;
  return { team: leanTeam(g, mkt, L), lean_dollars: lean.net[L], other_dollars: lean.net[1 - L], wallets: lean.wallets,
    share: lean.share, flagged: lean.share != null && lean.share >= RULES.CONCENTRATION_FLAG };
}

// ---------------------------------------------------------------- what is due
// -> [{ game_date, game_id, kind, pass }]  (pure: reads game_log and the job's own tables)
function duePasses(db, nowS, dates) {
  const due = [];
  for (const date of dates) {
    for (const g of gamesOn(db, date)) {
      if (g.removed) continue;
      const start = PT.parseStart(g.scheduled_start_utc);
      const c = PT.resolveCutoff(g, null);
      if (start == null || c.reason) continue;
      const cutoff = c.cutoff_utc;
      if (hasFinal(db, g)) continue;
      const lock = RULES.parseUtc(g.odds_locked_at);
      if (nowS >= cutoff + LAG_S && (lock != null ? nowS >= lock + LAG_S : nowS >= cutoff + NO_LOCK_GIVE_UP_S)) {
        due.push({ game_date: date, game_id: g.game_id, kind: 'final', pass: 'final' });
        continue;
      }
      if (nowS >= cutoff) continue;
      const done = new Set(String((stateOf(db, g) || {}).passes || '').split(',').filter(Boolean));
      const latest = PASSES.filter(([, off]) => nowS >= start - off).pop();     // the latest pass whose time has come
      if (latest && !done.has(latest[0])) due.push({ game_date: date, game_id: g.game_id, kind: 'provisional', pass: latest[0] });
    }
  }
  return due;
}
const ptDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

// ---------------------------------------------------------------- scheduler
// queued: services/jobs.js _queued (exported as withMemLog). -> { stop, tick } | null when off.
function startTopTradersLive(o) {
  const env = o.env || process.env, log = o.log || console.log;
  if (!isOn(env)) {
    log('[top-traders-live] TOP_TRADERS_LIVE is off: the live lean job is disabled (no fetches, no writes). Set TOP_TRADERS_LIVE=on to enable.');
    return null;
  }
  log('[top-traders-live] TOP_TRADERS_LIVE=on: the live lean job is enabled (passes at T-3h / T-1h / T-15m, final after lock and cutoff; every 5 min through the job queue).');
  let pending = false;
  const tick = () => {
    if (pending) return null;                         // the previous tick's job is still queued or running
    const nowMs = (o.nowMs || Date.now)();
    let due;
    try {
      const db = o.db || appDb();
      const today = ptDate(nowMs);
      due = duePasses(db, Math.floor(nowMs / 1000), [addDays(today, -1), today]);
    } catch (e) { log('[top-traders-live] tick failed: ' + (e && e.message ? e.message : e)); return null; }
    if (!due.length) return null;
    pending = true;
    const p = o.queued('top-traders live (' + due.length + ')', async () => {
      const db = o.db || appDb();
      const client = (o.makeClient || PT.makeClient)({ log });
      for (const d of due) {
        try {
          const r = await runGame({ db, client, nowS: Math.floor((o.nowMs || Date.now)() / 1000), env, log }, d.game_date, d.game_id, d.kind, d.pass);
          log('[top-traders-live] ' + d.pass + ' ' + d.game_date + ' ' + d.game_id + ' ' + JSON.stringify(r));
        } catch (e) {
          log('[top-traders-live] ' + d.pass + ' ' + d.game_date + ' ' + d.game_id + ' FAILED: ' + (e && e.message ? e.message : e));
        }
      }
    });
    Promise.resolve(p).catch(e => log('[top-traders-live] job failed: ' + (e && e.message ? e.message : e))).finally(() => { pending = false; });
    return p;
  };
  const timer = setInterval(tick, o.tickMs || TICK_MS);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = {
  startTopTradersLive, runGame, duePasses, snapshotFor, isOn,
  _internals: { PASSES, LAG_S, NO_LOCK_GIVE_UP_S, leanFromStored, fetchAndStore, qualifiedByAddr, discoverMarkets, setState, stateOf },
};
