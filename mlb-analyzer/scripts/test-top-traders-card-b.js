#!/usr/bin/env node
'use strict';
/**
 * Top-traders card, PR B (2026-10-01): the live lean job, the lean log, the
 * card's data route. Display only. Everything runs against a FAKE Polymarket
 * API and throwaway in-memory databases; nothing touches the network.
 *
 *   a. incremental passes: consecutive half-open ranges never overlap, a trade
 *      exactly at a pass boundary is stored once, identical repeat rows are all
 *      kept, a pass killed mid-range resumes without double counting, and a
 *      range over the offset cap is split.
 *   b. the final lean deletes and re-fetches wholesale (no leftovers from the
 *      provisional passes) and equals the BACKTEST's lean
 *      (services/polymarket-top-traders-backtest.js buildOutcomeBlind) on the
 *      same synthetic fills -- lock after the cutoff and lock before it.
 *   c. the kill switch: off means zero fetches and zero writes.
 *   d. the snapshot rule (latest as_of <= D; postseason frozen at the first
 *      postseason date; a regular-season date with no same-season snapshot
 *      does nothing), and the pass schedule.
 *   e. final rows are idempotent; a price-step skip is recorded with its reason.
 *   f. GET /api/top-traders/:date: no wallet address, the >= 75% flag, the
 *      final row preferred, an empty list when nothing is stored.
 *   g. isolation: nothing in the pricing path's require graph (services/jobs.js
 *      and routes/api.js included) references the live module, its router or
 *      its tables; planted-violation self-tests.
 *
 *   node scripts/test-top-traders-card-b.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const R = path.join(__dirname, '..');
// NEVER data/mlb.db: check g loads services/harness-inputs, which loads db/schema.
const TMP_DB = path.join(os.tmpdir(), '__tt_card_b_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { applyTopTradersDdl } = require(path.join(R, 'db/top-traders-ddl'));
const PT = require(path.join(R, 'utils/polymarket-trades'));
const RULES = require(path.join(R, 'utils/top-traders/rules'));
const live = require(path.join(R, 'services/top-traders-live'));
const bt = require(path.join(R, 'services/polymarket-top-traders-backtest'));
const bf = require(path.join(R, 'services/polymarket-backfill'));
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}
const ON = { TOP_TRADERS_LIVE: 'on' }, OFF = {};
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi || 0) / 1000;
const sqlUtc = (s) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19);
const addr = (i) => '0x' + require('crypto').createHash('sha1').update('wallet' + i).digest('hex');

// ---------------------------------------------------------------- the app database (throwaway, in memory)
function appDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, first_pitch_utc TEXT, game_time TEXT,
    odds_locked_at TEXT, market_away_ml INTEGER, market_home_ml INTEGER, ml_source TEXT, market_contamination_reason TEXT, is_removed INTEGER DEFAULT 0);
    CREATE TABLE empirical_market_captures (game_date TEXT, game_id TEXT, market_type TEXT, away_price_ml INTEGER, home_price_ml INTEGER, generated_at TEXT);`);
  applyTopTradersDdl(db);
  return db;
}
// Seed: wallets 1..40 (addresses), qualified = 1..30 as of asOf.
function seed(db, asOf, qualifiedIds) {
  const w = db.prepare('INSERT OR IGNORE INTO top_trader_wallets (wallet_id, addr, games, profit, volume, both_teams, as_of) VALUES (?, ?, 50, 100, 1000, 0, ?)');
  const q = db.prepare('INSERT OR IGNORE INTO top_trader_qualified (as_of, wallet_id) VALUES (?, ?)');
  for (let i = 1; i <= 40; i++) w.run(i, addr(i), asOf);
  for (const i of qualifiedIds) q.run(asOf, i);
}

// ---------------------------------------------------------------- a fake Polymarket (Gamma /events + data-api /trades)
// games: [{ date, cid, slug, outcomes: [name0, name1], start }], trades: cid -> [{ w, ts, side, outcome, price, size }]
function fakeApi(games, trades) {
  const st = { requests: 0, trades: 0, events: 0, failAfter: null, ranges: [] };
  const fetchImpl = async (url) => {
    st.requests++;
    if (st.failAfter != null && st.requests > st.failAfter) throw new Error('planted network failure');
    const u = new URL(url);
    const reply = (code, body) => ({ status: code, text: async () => JSON.stringify(body) });
    if (u.pathname === '/events') {
      st.events++;
      if (u.searchParams.get('closed') !== 'false' || Number(u.searchParams.get('offset')) > 0) return reply(200, []);
      const lo = u.searchParams.get('end_date_min').slice(0, 10), hi = u.searchParams.get('end_date_max').slice(0, 10);
      return reply(200, games.filter(g => g.date >= lo && g.date < hi).map(g => ({ id: g.cid, slug: g.slug, endDate: g.date + 'T23:59:00Z',
        markets: [{ sportsMarketType: 'moneyline', conditionId: g.cid, outcomes: JSON.stringify(g.outcomes), outcomePrices: '["0.5","0.5"]',
          closed: false, gameStartTime: new Date(g.start * 1000).toISOString() }] })));
    }
    if (u.pathname === '/trades') {
      st.trades++;
      const p = u.searchParams, a = +p.get('start'), b = +p.get('end'), off = +p.get('offset'), lim = +p.get('limit');
      if (off > PT.MAX_OFFSET) return reply(400, { error: 'max historical trades offset of 10000 exceeded' });
      if (lim > 1) st.ranges.push([a, b]);
      const rows = (trades[p.get('market')] || []).map((t, i) => Object.assign({ i }, t)).filter(t => t.ts >= a && t.ts <= b)
        .sort((x, y) => y.ts - x.ts || x.i - y.i);
      return reply(200, rows.slice(off, off + lim).map(t => ({ proxyWallet: addr(t.w), side: t.side === 1 ? 'BUY' : 'SELL', asset: 'x',
        conditionId: p.get('market'), size: t.size, price: t.price, timestamp: t.ts, outcome: t.outcome === 0 ? 'A' : 'B', outcomeIndex: t.outcome })));
    }
    return reply(404, {});
  };
  const client = PT.makeClient({ fetchImpl, minGapMs: 0, sleep: async () => {}, log: () => {} });
  return { client, st };
}
const fills = (db, g) => db.prepare('SELECT wallet_id, outcome, side, price, size, ts FROM top_trader_live_fills WHERE game_date = ? AND game_id = ? ORDER BY ts, wallet_id, outcome, side, price, size').all(g.date, g.id);
const key = (f) => [f.wallet_id, f.outcome, f.side, f.price, f.size, f.ts].join('|');
const multiset = (rows) => { const m = new Map(); for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1); return m; };
const sameMultiset = (a, b) => { const A = multiset(a), B = multiset(b); if (A.size !== B.size) return false; for (const [k, n] of A) if (B.get(k) !== n) return false; return true; };
const asStored = (t) => ({ wallet_id: t.w, outcome: t.outcome, side: t.side, price: t.price, size: t.size, ts: t.ts });

(async () => {
  // ---------------------------------------------------------------- shared fixture
  const D = '2026-07-15';
  const SA = utc(2026, 7, 15, 23, 5), SB = utc(2026, 7, 16, 2, 10);
  const QUAL = Array.from({ length: 30 }, (_, i) => i + 1);
  const qset = new Set(QUAL);
  const GA = { date: D, id: 'nyy-bos', cid: '0xA', slug: 'mlb-nyy-bos-' + D, outcomes: ['New York Yankees', 'Boston Red Sox'], start: SA };   // outcome 0 = away
  const GB = { date: D, id: 'lad-sd', cid: '0xB', slug: 'mlb-lad-sd-' + D, outcomes: ['San Diego Padres', 'Los Angeles Dodgers'], start: SB };  // outcome 0 = HOME
  // Game A: 10,600 trades over the 8 hours before the start (over the offset cap: the full range must split),
  // 40 identical repeats, a trade on a pass boundary, and trades after the start (never stored).
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const TA = [];
  for (let k = 0; k < 10600; k++) {
    TA.push({ w: 1 + Math.floor(rnd() * 40), ts: SA - 8 * 3600 + Math.floor(rnd() * 8 * 3600), side: rnd() < 0.8 ? 1 : -1,
      outcome: rnd() < 0.55 ? 0 : 1, price: Math.round(rnd() * 90 + 5) / 100, size: Math.round(rnd() * 5000) / 10 + 1 });
  }
  for (let k = 0; k < 40; k++) TA.push(Object.assign({}, TA[k * 7]));                   // identical repeats: real, distinct fills
  const NOW1 = SA - 3 * 3600, NOW2 = SA - 3600, NOW3 = SA - 15 * 60;
  const BOUNDARY = NOW1 - live._internals.LAG_S;                                           // pass 1 ends here, pass 2 starts here
  TA.push({ w: 3, ts: BOUNDARY, side: 1, outcome: 1, price: 0.5, size: 77.7 });
  for (let k = 0; k < 25; k++) TA.push({ w: 5, ts: SA + 60 + k, side: 1, outcome: 1, price: 0.5, size: 1e6 });   // after the start
  // Game B: before the lock, qualified money on outcome 0; between the lock and the cutoff, a flood on outcome 1.
  const LOCK_B = SB - 1800;
  const TB = [];
  for (let k = 0; k < 300; k++) TB.push({ w: 1 + (k % 30), ts: SB - 6 * 3600 + k * 60, side: 1, outcome: 0, price: 0.5, size: 100 });
  for (let k = 0; k < 120; k++) TB.push({ w: 1 + (k % 30), ts: LOCK_B + 10 + k * 10, side: 1, outcome: 1, price: 0.5, size: 2000 });
  for (let k = 0; k < 50; k++) TB.push({ w: 31 + (k % 10), ts: SB - 3600 + k, side: 1, outcome: 1, price: 0.5, size: 5000 });   // unqualified
  const TRADES = { '0xA': TA, '0xB': TB };
  const glRow = (g, extra) => Object.assign({ game_date: g.date, game_id: g.id, scheduled_start_utc: new Date(g.start * 1000).toISOString().replace('.000Z', 'Z'),
    first_pitch_utc: null, game_time: null, odds_locked_at: null, market_away_ml: -120, market_home_ml: 110, ml_source: 'kalshi',
    market_contamination_reason: null, is_removed: 0 }, extra || {});
  const insGame = (db, r) => db.prepare(`INSERT INTO game_log VALUES (@game_date, @game_id, @scheduled_start_utc, @first_pitch_utc, @game_time,
    @odds_locked_at, @market_away_ml, @market_home_ml, @ml_source, @market_contamination_reason, @is_removed)`).run(r);
  const setGame = (db, g, cols) => { for (const [k, v] of Object.entries(cols)) db.prepare('UPDATE game_log SET ' + k + ' = ? WHERE game_date = ? AND game_id = ?').run(v, g.date, g.id); };
  const fresh = () => { const db = appDb(); seed(db, '2026-07-01', QUAL); insGame(db, glRow(GA)); insGame(db, glRow(GB)); return db; };

  // ---------------------------------------------------------------- a
  console.log('a. incremental passes');
  {
    const db = fresh(), api = fakeApi([GA, GB], TRADES);
    const r1 = await live.runGame({ db, client: api.client, nowS: NOW1, env: ON }, D, GA.id, 'provisional', 't180');
    const r2 = await live.runGame({ db, client: api.client, nowS: NOW2, env: ON }, D, GA.id, 'provisional', 't60');
    const r3 = await live.runGame({ db, client: api.client, nowS: NOW3, env: ON }, D, GA.id, 'provisional', 't15');
    ok('three passes: ranges [0, B1), [B1, B2), [B2, B3), each ending 2 minutes before its "now"',
      JSON.stringify([r1.range, r2.range, r3.range]) === JSON.stringify([[0, NOW1 - 120], [NOW1 - 120, NOW2 - 120], [NOW2 - 120, NOW3 - 120]]), JSON.stringify([r1.range, r2.range, r3.range]));
    ok('consecutive ranges never overlap and leave no gap (each starts where the last ended)', r2.range[0] === r1.range[1] && r3.range[0] === r2.range[1]);
    const reqRanges = api.st.ranges.map(([a, b]) => [a, b + 1]);                          // requested inclusive [a, b] -> half-open [a, b+1)
    const overl = reqRanges.some(([a, b], i) => reqRanges.some(([c, d], j) => j > i && a < d && c < b && !(a === c && b === d)));
    ok('every request is half-open (end = t_end - 1) and no two distinct requested windows overlap', !overl, reqRanges.length + ' paged windows');
    const want = TA.filter(t => qset.has(t.w) && t.ts < NOW3 - 120).map(asStored);
    ok('stored = exactly the qualified wallets\' trades before the last pass end (a multiset match)', sameMultiset(fills(db, GA), want), fills(db, GA).length + ' rows vs ' + want.length);
    ok('the trade exactly at the pass boundary is stored once', fills(db, GA).filter(f => f.ts === BOUNDARY && f.size === 77.7).length === 1);
    const reps = TA.slice(10600).filter(t => qset.has(t.w) && t.ts < NOW3 - 120);
    const kept = reps.every(t => fills(db, GA).filter(f => key(f) === key(asStored(t))).length === TA.filter(x => key(asStored(x)) === key(asStored(t))).length);
    ok('identical repeat rows are all kept (each stored as many times as it occurs)', reps.length > 10 && kept, reps.length + ' repeated rows checked');
    ok('only qualified wallets are stored, and no row at or after the cutoff', fills(db, GA).every(f => qset.has(f.wallet_id) && f.ts < SA));
    ok('the provisional rows log the lean, dollars, wallets, share, qualified count, prices and phase',
      db.prepare("SELECT COUNT(*) c FROM top_trader_lean_log WHERE kind = 'provisional' AND game_id = ? AND lean_team IS NOT NULL AND wallets_with_money > 0 AND qualified_count = 30 AND price_source = 'kalshi' AND phase = 'regular' AND snapshot_as_of = '2026-07-01'").get(GA.id).c === 3);
    // The same pass again: nothing new, nothing doubled.
    const before = fills(db, GA).length;
    const r4 = await live.runGame({ db, client: api.client, nowS: NOW3, env: ON }, D, GA.id, 'provisional', 't15');
    ok('re-running a pass at the same "now" fetches an empty range and doubles nothing', r4.fetched === 0 && fills(db, GA).length === before, JSON.stringify(r4.range));
    // A pass killed mid-range resumes without double counting.
    const db2 = fresh(), api2 = fakeApi([GA, GB], TRADES);
    await live.runGame({ db: db2, client: api2.client, nowS: NOW1, env: ON }, D, GA.id, 'provisional', 't180');
    api2.st.failAfter = api2.st.requests + 6;
    let threw = false;
    try { await live.runGame({ db: db2, client: api2.client, nowS: NOW3, env: ON }, D, GA.id, 'provisional', 't15'); } catch (e) { threw = true; }
    const partial = fills(db2, GA).length;
    api2.st.failAfter = null;
    await live.runGame({ db: db2, client: api2.client, nowS: NOW3, env: ON }, D, GA.id, 'provisional', 't15');
    ok('a pass killed mid-range left partial rows; the next pass deletes them and ends identical (no double counting)',
      threw && partial > fills(db2, GA).filter(f => f.ts < NOW1 - 120).length && sameMultiset(fills(db2, GA), want), partial + ' rows after the kill');
    // Over the offset cap: the full-range fetch splits.
    const st = PT.memoryWindowStore(0, SA);
    const apiS = fakeApi([GA], TRADES);
    let n = 0;
    await PT.fetchWindows(apiS.client, GA.cid, st, (w, page) => { n += page.filter(t => t.timestamp >= w.t_start && t.timestamp < w.t_end).length; return 0; }, 'x');
    ok('a range over the offset cap is split into half-open windows and every row comes back exactly once',
      st.splits > 0 && n === TA.filter(t => t.ts < SA).length, st.splits + ' splits, ' + n + ' rows');
  }

  // ---------------------------------------------------------------- b
  console.log('\nb. the final lean: wholesale re-fetch, and the backtest\'s lean');
  const finalDb = fresh();
  {
    const db = finalDb, api = fakeApi([GA, GB], TRADES);
    await live.runGame({ db, client: api.client, nowS: NOW1, env: ON }, D, GA.id, 'provisional', 't180');
    await live.runGame({ db, client: api.client, nowS: SB - 3 * 3600, env: ON }, D, GB.id, 'provisional', 't180');
    // a leftover the final must not keep
    db.prepare('INSERT INTO top_trader_live_fills VALUES (?, ?, 1, 0, 1, 0.5, 999999, ?)').run(D, GA.id, SA - 10);
    // game A: lock AFTER the cutoff (cut = cutoff); game B: lock BEFORE it (cut = lock)
    setGame(db, GA, { odds_locked_at: sqlUtc(SA + 600), first_pitch_utc: new Date((SA + 120) * 1000).toISOString() });
    setGame(db, GB, { odds_locked_at: sqlUtc(LOCK_B), first_pitch_utc: new Date((SB + 60) * 1000).toISOString() });
    const fA = await live.runGame({ db, client: api.client, nowS: SA + 3 * 3600, env: ON }, D, GA.id, 'final', 'final');
    const fB = await live.runGame({ db, client: api.client, nowS: SB + 3 * 3600, env: ON }, D, GB.id, 'final', 'final');
    ok('final A re-fetched the whole range [0, cutoff): it kept exactly the qualified trades before the cutoff',
      fA.kept === TA.filter(t => qset.has(t.w) && t.ts < SA).length && JSON.stringify(fA.range) === JSON.stringify([0, SA]), fA.kept + ' rows');
    ok('retention: once each final row is written, that game\'s stored live fills are deleted (the planted leftover with them)',
      fills(db, GA).length === 0 && fills(db, GB).length === 0);
    ok('final A: cut = the cutoff (lock after it); final B: cut = the lock (lock before the cutoff)', fA.cut === SA && fB.cut === LOCK_B, fA.cut + ' / ' + fB.cut);
    // Independent: the rules over the raw trade list.
    const expect = (T, cut) => { const acc = RULES.newLeanAcc(); for (const t of T) if (qset.has(t.w) && t.ts < cut) RULES.addFill(acc, t.outcome, t.side, t.price * t.size); return { ln: RULES.leanFrom(acc), net: acc.net }; };
    const eA = expect(TA, SA), eB = expect(TB, LOCK_B), eBwrong = expect(TB, SB);
    const rowA = db.prepare("SELECT * FROM top_trader_lean_log WHERE kind = 'final' AND game_id = ?").get(GA.id);
    const rowB = db.prepare("SELECT * FROM top_trader_lean_log WHERE kind = 'final' AND game_id = ?").get(GB.id);
    const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    const teamOf = (g, o0h, L) => { const [a, h] = g.id.split('-'); return ((L === 0) === (o0h === 1) ? h : a).toUpperCase(); };
    ok('final A: lean team and both dollar sides equal the rules applied to the raw trades (so no provisional leftover, incl. the planted $500k row, was counted)',
      rowA.lean_team === teamOf(GA, 0, eA.ln.leanOutcome) && close(rowA.lean_dollars, eA.net[eA.ln.leanOutcome]) && close(rowA.other_dollars, eA.net[1 - eA.ln.leanOutcome]),
      rowA.lean_team + ' ' + Math.round(rowA.lean_dollars) + ' / ' + Math.round(rowA.other_dollars));
    ok('final B: the flood between the lock and the cutoff is excluded -- the lean is the pre-lock side, not what the cutoff alone would give',
      eB.ln.leanOutcome !== eBwrong.ln.leanOutcome && rowB.lean_team === teamOf(GB, 1, eB.ln.leanOutcome) && close(rowB.lean_dollars, eB.net[eB.ln.leanOutcome]), rowB.lean_team);
    ok('final rows carry the locked price, the source and the cut', rowA.locked_away_ml === -120 && rowA.locked_home_ml === 110 && rowA.price_source === 'kalshi' && rowA.cut_utc === SA);
    // The backtest: a synthetic polymarket.db (the backfill's own schema) with 40 days of history for the 30 wallets.
    const pm = new Database(':memory:');
    pm.exec(bf.SCHEMA);
    const insM = pm.prepare("INSERT INTO markets (id, condition_id, slug, game_date, game_id, cutoff_utc, outcome0_is_home, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'done')");
    const insWG = pm.prepare('INSERT INTO wallet_game VALUES (?, ?, 1, 2, 9, 10, 100, 1)');
    for (let k = 0; k < 40; k++) {
      const day = new Date(Date.parse(D + 'T00:00:00Z') - (45 - k) * 864e5).toISOString().slice(0, 10);
      insM.run(100 + k, '0xH' + k, 'mlb-hist-' + k, day, 'h' + k + '-x', utc(2026, 1, 1, 0) , 0);
      for (const w of QUAL) insWG.run(100 + k, w);
    }
    insM.run(1, GA.cid, GA.slug, D, GA.id, SA, 0);
    insM.run(2, GB.cid, GB.slug, D, GB.id, SB, 1);
    const insF = pm.prepare('INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const t of TA) if (t.ts < SA) insF.run(1, t.w, t.ts, t.side, t.outcome, t.price, t.size);
    for (const t of TB) if (t.ts < SB) insF.run(2, t.w, t.ts, t.side, t.outcome, t.price, t.size);
    const blind = bt.buildOutcomeBlind(pm, db);
    const btRow = (mid) => blind.rows.find(r => r.variant === 'primary' && r.market_id === mid);
    ok('the backtest (buildOutcomeBlind, as-of qualification) tests both games with 30 qualified wallets', !!btRow(1) && !!btRow(2) && blind.feasibility.first_eligible && blind.feasibility.first_eligible.qualified === 30);
    const btTeam = (g, o0h, r) => teamOf(g, o0h, r.lean_outcome);
    ok('final A\'s lean equals the backtest\'s (lock after the cutoff)', btTeam(GA, 0, btRow(1)) === rowA.lean_team, btTeam(GA, 0, btRow(1)) + ' = ' + rowA.lean_team);
    ok('final B\'s lean equals the backtest\'s (lock before the cutoff)', btTeam(GB, 1, btRow(2)) === rowB.lean_team, btTeam(GB, 1, btRow(2)) + ' = ' + rowB.lean_team);
  }

  // ---------------------------------------------------------------- c
  console.log('\nc. the kill switch');
  {
    const db = fresh(), api = fakeApi([GA, GB], TRADES);
    const c0 = db.prepare('SELECT total_changes() c').get().c;
    const rs = [];
    for (const env of [OFF, { TOP_TRADERS_LIVE: 'off' }, { TOP_TRADERS_LIVE: '1' }, { TOP_TRADERS_LIVE: 'true' }]) {
      rs.push(await live.runGame({ db, client: api.client, nowS: NOW1, env }, D, GA.id, 'provisional', 't180'));
      rs.push(await live.runGame({ db, client: api.client, nowS: SA + 9 * 3600, env }, D, GA.id, 'final', 'final'));
    }
    ok('unset / "off" / "1" / "true": every pass returns disabled', rs.every(r => r.disabled === true));
    ok('zero fetches and zero writes while off', api.st.requests === 0 && db.prepare('SELECT total_changes() c').get().c === c0, api.st.requests + ' requests');
    const logs = []; let queuedCalls = 0;
    const s = live.startTopTradersLive({ env: OFF, log: (m) => logs.push(m), queued: () => { queuedCalls++; }, db });
    ok('startTopTradersLive off: schedules nothing, logs the state, never touches the queue',
      s === null && queuedCalls === 0 && logs.length === 1 && /TOP_TRADERS_LIVE is off/.test(logs[0]), logs[0]);
    const logsOn = [];
    const s2 = live.startTopTradersLive({ env: ON, log: (m) => logsOn.push(m), queued: (l, fn) => { queuedCalls++; return Promise.resolve(); }, db, tickMs: 3600000, nowMs: () => (SA - 3 * 3600 + 60) * 1000 });
    ok('startTopTradersLive on: logs the state and returns a scheduler', !!s2 && /TOP_TRADERS_LIVE=on/.test(logsOn[0]));
    if (s2) s2.stop();
  }

  // ---------------------------------------------------------------- d
  console.log('\nd. the snapshot rule and the schedule');
  {
    const db = appDb();
    seed(db, '2026-09-28', QUAL);
    const s1 = live.snapshotFor(db, '2026-10-02');
    ok('a postseason date uses the 2026-09-28 snapshot', s1.as_of === '2026-09-28' && s1.postseason === true && s1.count === 30, JSON.stringify(s1));
    seed(db, '2026-09-30', [1, 2, 3]);
    ok('a later snapshot does not move it: postseason qualification stays frozen at the first postseason date',
      live.snapshotFor(db, '2026-10-02').as_of === '2026-09-28');
    ok('a regular-season date before the only snapshot has no same-season snapshot', live.snapshotFor(db, '2026-07-01').reason === 'no_same_season_snapshot');
    seed(db, '2025-09-30', QUAL);
    ok('a 2026 regular-season date with only a 2025 snapshot: no same-season snapshot', live.snapshotFor(db, '2026-04-10').reason === 'no_same_season_snapshot');
    seed(db, '2026-05-01', QUAL);
    ok('a regular-season date uses the latest snapshot at or before it', live.snapshotFor(db, '2026-05-20').as_of === '2026-05-01' && live.snapshotFor(db, '2026-05-20').postseason === false);
    ok('a season with no known dates (2027) does nothing', live.snapshotFor(db, '2027-05-01').reason === 'season_dates_unknown');
    const g = { date: '2026-04-10', id: 'nyy-bos', start: utc(2026, 4, 10, 23, 5) };
    insGame(db, glRow(g));
    const api = fakeApi([], {});
    const c0 = db.prepare('SELECT total_changes() c').get().c, logs = [];
    const r = await live.runGame({ db, client: api.client, nowS: g.start - 3600, env: ON, log: (m) => logs.push(m) }, g.date, g.id, 'provisional', 't60');
    ok('runGame on that date does nothing (no fetch, no write) and logs why',
      r.skipped === 'no_same_season_snapshot' && api.st.requests === 0 && db.prepare('SELECT total_changes() c').get().c === c0 && /no_same_season_snapshot/.test(logs[0] || ''), logs[0]);
    // Schedule
    const sdb = fresh();
    const due = (t) => live.duePasses(sdb, t, [D]).filter(x => x.game_id === GA.id).map(x => x.pass).join(',');
    // (2026-10-02) Five offsets: T-24h, T-12h, T-3h, T-1h, T-15m (T-36h dropped -- game_log loads ~32 h ahead).
    ok('the pass list is exactly T-24h, T-12h, T-3h, T-1h, T-15m, earliest first',
      JSON.stringify(live._internals.PASSES.map(([, o]) => o / 60)) === JSON.stringify([1440, 720, 180, 60, 15]));
    ok('nothing is due more than 24 hours before the start', due(SA - 24 * 3600 - 60) === '');
    ok('the five offsets fire in order at their times (T-24h, T-12h, T-3h, T-1h, T-15m)',
      [24 * 3600, 12 * 3600, 3 * 3600, 3600, 900].map(o => due(SA - o)).join(',') === 't1440,t720,t180,t60,t15');
    ok('a late load runs only the latest due pass (loaded 2 h before the start: T-3h only, not T-24h / T-12h)', due(SA - 2 * 3600) === 't180');
    live._internals.setState(sdb, { game_date: D, game_id: GA.id }, '2026-07-01', 0, 't180', SA - 3 * 3600);
    ok('a pass already run is not due again; a late start runs only the latest due pass', due(SA - 3 * 3600 + 600) === '' && due(SA - 10 * 60) === 't15');
    ok('no provisional pass at or after the cutoff; no final before the lock', due(SA + 60) === '');
    setGame(sdb, GA, { odds_locked_at: sqlUtc(SA - 600) });
    ok('the final is due once both the lock and the cutoff have passed (+2 min)', due(SA + 60) === '' && due(SA + 120) === 'final');
    setGame(sdb, GA, { odds_locked_at: null });
    ok('with no lock, the final (recording the price-step skip) is due 6 hours after the cutoff', due(SA + 5 * 3600) === '' && due(SA + 6 * 3600) === 'final');
    // The scheduler: one queued job per tick with work; nothing while that job is pending.
    let calls = 0, release;
    const s = live.startTopTradersLive({ env: ON, log: () => {}, db: sdb, tickMs: 3600000, nowMs: () => (SA - 3600) * 1000,
      queued: (label, fn) => { calls++; return new Promise(r => { release = r; }); } });
    s.tick(); s.tick();
    ok('a tick with work due enqueues exactly one job through the queue; a second tick while it is pending enqueues nothing', calls === 1);
    release(); await new Promise(r => setTimeout(r, 10)); s.tick();
    ok('after that job finishes, the next tick may enqueue again', calls === 2);
    s.stop();
  }

  // ---------------------------------------------------------------- d2 (2026-10-02)
  console.log('\nd2. earlier passes: look-ahead, moved starts, missing markets, the placeholder guard');
  {
    // b. Look-ahead: previous PT date through ONE PT date ahead.
    const nowMs = Date.UTC(2026, 6, 15, 18, 0) ;                                // 11:00 PT on 2026-07-15
    ok('look-ahead dates are the previous PT date, today and one PT date ahead', JSON.stringify(live.lookAheadDates(nowMs)) === '["2026-07-14","2026-07-15","2026-07-16"]',
      JSON.stringify(live.lookAheadDates(nowMs)));
    const ldb = appDb(); seed(ldb, '2026-07-01', QUAL);
    const G1 = { date: '2026-07-16', id: 'sea-tex', start: utc(2026, 7, 16, 17, 0) };   // 23 h ahead: T-24h due
    const G2 = { date: '2026-07-17', id: 'hou-oak', start: utc(2026, 7, 17, 17, 0) };   // two PT dates out
    insGame(ldb, glRow(G1)); insGame(ldb, glRow(G2));
    const dueL = live.duePasses(ldb, nowMs / 1000, live.lookAheadDates(nowMs)).map(x => x.game_id + ':' + x.pass);
    ok('a game one PT date ahead is included (its T-24h pass is due)', dueL.includes('sea-tex:t1440'), dueL.join(','));
    ok('a game two PT dates ahead is not considered', !dueL.some(x => x.startsWith('hou-oak')));
    // c. A moved start re-times the remaining passes (CURRENT scheduled_start_utc on every tick).
    const mdb = fresh();
    const dueM = (t) => live.duePasses(mdb, t, [D]).filter(x => x.game_id === GA.id).map(x => x.pass).join(',');
    live._internals.setState(mdb, { game_date: D, game_id: GA.id }, '2026-07-01', 0, 't1440', SA - 24 * 3600);
    ok('before the move: T-12h falls due at the original start - 12 h', dueM(SA - 12 * 3600) === 't720');
    setGame(mdb, GA, { scheduled_start_utc: new Date((SA + 6 * 3600) * 1000).toISOString().replace('.000Z', 'Z') });
    ok('after the start moves 6 h later: nothing at the old time, T-12h at the NEW start - 12 h, T-15m at the new start - 15 min',
      dueM(SA - 12 * 3600) === '' && dueM(SA - 6 * 3600) === 't720' && dueM(SA + 6 * 3600 - 900) === 't15');
    // d. A missing market logs and retries without writing.
    const gdb = fresh(), games = [];                                              // no market listed for the date yet
    const api = fakeApi(games, TRADES), logs = [];
    const c0 = gdb.prepare('SELECT total_changes() c').get().c;
    const r1 = await live.runGame({ db: gdb, client: api.client, nowS: SA - 24 * 3600, env: ON, log: (m) => logs.push(m) }, D, GA.id, 'provisional', 't1440');
    ok('no market listed yet: the pass logs it, fetches no trades and writes nothing (not even a market row)',
      r1.skipped === 'no_polymarket_market' && api.st.trades === 0 && gdb.prepare('SELECT total_changes() c').get().c === c0
      && logs.some(m => /no Polymarket market listed yet -- nothing written; the next pass tries again/.test(m)), logs.join(' | '));
    let nowT = SA - 24 * 3600, queued = 0;
    const sch = live.startTopTradersLive({ env: ON, log: () => {}, db: gdb, tickMs: 3600000, nowMs: () => nowT * 1000, makeClient: () => api.client,
      queued: async (label, fn) => { queued++; await fn(); } });
    await sch.tick(); await new Promise(r => setTimeout(r, 5));
    const ev1 = api.st.events;
    await sch.tick(); await new Promise(r => setTimeout(r, 5));
    ok('the scheduler tries that pass once, then not again on the next tick (no hammering)', queued === 1 && api.st.events === ev1, queued + ' jobs');
    nowT = SA - 12 * 3600;
    await sch.tick(); await new Promise(r => setTimeout(r, 5));
    ok('the next pass (T-12h) tries the market again', queued === 2 && api.st.events > ev1 && gdb.prepare('SELECT total_changes() c').get().c === c0);
    games.push(GA);                                                               // the market is listed now
    nowT = SA - 3 * 3600;
    await sch.tick(); await new Promise(r => setTimeout(r, 5));
    ok('once the market is listed, the next pass finds it and writes its provisional row',
      gdb.prepare("SELECT COUNT(*) c FROM top_trader_lean_log WHERE game_id = ? AND kind = 'provisional'").get(GA.id).c === 1);
    sch.stop();
    // e. The placeholder guard.
    ok('validGameId: two valid team codes (and the doubleheader suffix) only',
      live.validGameId('atl-lad') && live.validGameId('nyy-bos-g2') && live.validGameId('chc-cle-2') && !live.validGameId('atl/phi-lad')
      && !live.validGameId('al-nl') && !live.validGameId('nyy-nyy') && !live.validGameId('xyz-bos') && !live.validGameId('atl-lad-3'));
    const pdb = appDb(); seed(pdb, '2026-09-28', QUAL);
    const PD = '2026-10-03', PS = utc(2026, 10, 3, 20, 0);
    const PH = { date: PD, id: 'atl/phi-lad', start: PS }, REAL = { date: PD, id: 'atl-lad', start: PS }, GONE = { date: PD, id: 'nyy-tb', start: PS + 9000 };
    insGame(pdb, glRow(PH)); insGame(pdb, glRow(REAL)); insGame(pdb, Object.assign(glRow(GONE), { is_removed: 1 }));
    const papi = fakeApi([Object.assign({ cid: '0xR', slug: 'mlb-atl-lad-' + PD, outcomes: ['Atlanta Braves', 'Los Angeles Dodgers'] }, REAL)], { '0xR': TA.slice(0, 50).map(t => Object.assign({}, t, { ts: PS - 7200 + (t.ts % 3000) })) });
    const skips = [];
    const dueP = live.duePasses(pdb, PS - 3600, [PD], { onSkip: (d, id, why) => skips.push(id + ': ' + why) }).map(x => x.game_id);
    ok('the scheduler only schedules "atl-lad": the placeholder and the removed row are skipped, with their reasons',
      JSON.stringify(dueP) === '["atl-lad"]' && skips.includes('atl/phi-lad: not two valid team codes') && skips.includes('nyy-tb: removed in game_log'), skips.join(' | '));
    const plogs = [], cP = pdb.prepare('SELECT total_changes() c').get().c;
    const rPh = [], rGone = [];
    for (const kind of ['provisional', 'final']) {
      rPh.push(await live.runGame({ db: pdb, client: papi.client, nowS: kind === 'final' ? PS + 9 * 3600 : PS - 3600, env: ON, log: (m) => plogs.push(m) }, PD, PH.id, kind, kind === 'final' ? 'final' : 't60'));
      rGone.push(await live.runGame({ db: pdb, client: papi.client, nowS: kind === 'final' ? PS + 9 * 3600 : PS - 3600, env: ON, log: (m) => plogs.push(m) }, PD, GONE.id, kind, kind === 'final' ? 'final' : 't60'));
    }
    ok('"atl/phi-lad" and the removed row: no fetch, no provisional row, no final row (provisional and final passes both)',
      rPh.every(r => r.skipped === 'invalid_game_id') && rGone.every(r => r.skipped === 'removed') && papi.st.requests === 0
      && pdb.prepare('SELECT total_changes() c').get().c === cP);
    ok('each skipped game id is logged once (not once per pass)',
      plogs.filter(m => /atl\/phi-lad: skipped/.test(m)).length === 1 && plogs.filter(m => /nyy-tb: skipped/.test(m)).length === 1, plogs.join(' | '));
    const rReal = await live.runGame({ db: pdb, client: papi.client, nowS: PS - 3600, env: ON }, PD, REAL.id, 'provisional', 't60');
    ok('"atl-lad" is processed: market found, trades fetched, a provisional row written',
      rReal.market === 'mlb-atl-lad-' + PD && rReal.fetched === 50 && pdb.prepare("SELECT COUNT(*) c FROM top_trader_lean_log WHERE game_id = 'atl-lad'").get().c === 1,
      JSON.stringify({ market: rReal.market, fetched: rReal.fetched, kept: rReal.kept }));
  }

  // ---------------------------------------------------------------- e
  console.log('\ne. final rows: idempotent, and price-step skips');
  {
    const db = finalDb, api = fakeApi([GA, GB], TRADES);
    const n0 = db.prepare("SELECT COUNT(*) c FROM top_trader_lean_log WHERE kind = 'final'").get().c;
    const again = await live.runGame({ db, client: api.client, nowS: SA + 9 * 3600, env: ON }, D, GA.id, 'final', 'final');
    ok('a second final run is a no-op: no fetch, no new row', again.skipped === 'final_exists' && api.st.requests === 0
      && db.prepare("SELECT COUNT(*) c FROM top_trader_lean_log WHERE kind = 'final'").get().c === n0);
    let dup = null;
    try { db.prepare("INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, lean_team, qualified_count, kind, phase) VALUES (?, ?, 'x', 1, 'NYY', 30, 'final', 'regular')").run(D, GA.id); } catch (e) { dup = e.message; }
    ok('the database itself refuses a second final row for a game (unique partial index)', /UNIQUE/.test(dup || ''), dup);
    const cases = [['no_odds_locked_at', { odds_locked_at: null }], ['contaminated', { odds_locked_at: sqlUtc(SA - 600), market_contamination_reason: 'flagged' }],
      ['moneyline_missing', { odds_locked_at: sqlUtc(SA - 600), market_home_ml: null }]];
    for (const [reason, cols] of cases) {
      const d2 = fresh(), a2 = fakeApi([GA, GB], TRADES);
      await live.runGame({ db: d2, client: a2.client, nowS: NOW1, env: ON }, D, GA.id, 'provisional', 't180');   // fills stored while in progress
      const before = fills(d2, GA).length, t0 = a2.st.trades;
      setGame(d2, GA, cols);
      const r = await live.runGame({ db: d2, client: a2.client, nowS: SA + 7 * 3600, env: ON }, D, GA.id, 'final', 'final');
      const row = d2.prepare("SELECT * FROM top_trader_lean_log WHERE kind = 'final' AND game_id = ?").get(GA.id);
      ok('price-step skip "' + reason + '": one final row with that reason, no lean, no trades fetched; the game\'s stored fills deleted',
        r.skipped === reason && row && row.skip_reason === reason && row.lean_team == null && a2.st.trades === t0 && before > 0 && fills(d2, GA).length === 0,
        JSON.stringify(r.skipped) + ', ' + before + ' -> ' + fills(d2, GA).length + ' rows');
    }
    // After the final, no pass of either kind fetches or writes anything for that game.
    const a3 = fakeApi([GA, GB], TRADES), c0 = db.prepare('SELECT total_changes() c').get().c;
    const late = await live.runGame({ db, client: a3.client, nowS: SA - 600, env: ON }, D, GA.id, 'provisional', 't15');
    ok('a provisional pass after the final row: skipped, no fetch, no write, no fills re-stored',
      late.skipped === 'final_exists' && a3.st.requests === 0 && db.prepare('SELECT total_changes() c').get().c === c0 && fills(db, GA).length === 0);
  }

  // The upgrade from PR A's lean log (lean_team NOT NULL, no skip_reason), as production has it.
  {
    const PR_A_LEAN_LOG = `CREATE TABLE top_trader_lean_log (id INTEGER PRIMARY KEY AUTOINCREMENT, game_date TEXT NOT NULL, game_id TEXT NOT NULL,
      shown_at TEXT NOT NULL, cut_utc INTEGER NOT NULL, lean_team TEXT NOT NULL, lean_dollars REAL NOT NULL, other_dollars REAL NOT NULL,
      wallets_with_money INTEGER NOT NULL, top_wallet_share REAL, qualified_count INTEGER NOT NULL, away_ml_shown INTEGER, home_ml_shown INTEGER,
      price_source TEXT, kind TEXT NOT NULL CHECK (kind IN ('provisional', 'final')), phase TEXT NOT NULL CHECK (phase IN ('regular', 'postseason')),
      locked_away_ml INTEGER, locked_home_ml INTEGER, CHECK (kind = 'final' OR (locked_away_ml IS NULL AND locked_home_ml IS NULL)));`;
    // PR A's other two tables, as production has them (seeded), must come through any migration untouched.
    const PR_A_SEED_TABLES = `CREATE TABLE top_trader_wallets (wallet_id INTEGER PRIMARY KEY, addr TEXT NOT NULL UNIQUE, games INTEGER NOT NULL CHECK (games >= 0),
      profit REAL NOT NULL, volume REAL NOT NULL CHECK (volume >= 0), both_teams INTEGER NOT NULL CHECK (both_teams >= 0 AND both_teams <= games), as_of TEXT NOT NULL);
      CREATE TABLE top_trader_qualified (as_of TEXT NOT NULL, wallet_id INTEGER NOT NULL, PRIMARY KEY (as_of, wallet_id)) WITHOUT ROWID;`;
    // A normalised definition: the table's and its indexes' CREATE text (quotes, IF NOT EXISTS and spacing ignored) and column flags.
    const norm = (sql) => String(sql || '').replace(/IF NOT EXISTS /g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim();
    const def = (db) => JSON.stringify({
      table: norm(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'top_trader_lean_log'").get().sql),
      indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'top_trader_lean_log' AND sql IS NOT NULL ORDER BY name").all().map(r => [r.name, norm(r.sql)]),
      cols: db.prepare('PRAGMA table_info(top_trader_lean_log)').all().map(c => [c.name, c.type, c.notnull, c.pk]) });
    const seedHash = (db) => JSON.stringify([db.prepare('SELECT * FROM top_trader_wallets ORDER BY wallet_id').all(), db.prepare('SELECT * FROM top_trader_qualified ORDER BY as_of, wallet_id').all()]);
    const prA = (rows) => {
      const db = new Database(':memory:'); db.exec(PR_A_LEAN_LOG); db.exec(PR_A_SEED_TABLES);
      for (let i = 1; i <= 40; i++) db.prepare('INSERT INTO top_trader_wallets VALUES (?, ?, ?, ?, ?, 0, ?)').run(i, addr(i), 40 + i, 10.5 * i, 100 * i, '2026-09-28');
      for (const i of QUAL) db.prepare('INSERT INTO top_trader_qualified VALUES (?, ?)').run('2026-09-28', i);
      const ins = db.prepare(`INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, lean_team, lean_dollars, other_dollars, wallets_with_money,
        top_wallet_share, qualified_count, away_ml_shown, home_ml_shown, price_source, kind, phase, locked_away_ml, locked_home_ml) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 30, -120, 110, 'kalshi', ?, 'postseason', ?, ?)`);
      for (const r of rows) ins.run(...r);
      return db;
    };
    const fresh0 = new Database(':memory:'); applyTopTradersDdl(fresh0);
    const REF = def(fresh0);
    const ROWS = [['2026-09-29', 'chc-sd', 't1', 100, 'SD', 900.5, 100.25, 30, 0.8, 'provisional', null, null],
      ['2026-09-29', 'chc-sd', 't2', 200, 'SD', 1000.5, 200.25, 31, 0.7, 'final', -120, 110],
      ['2026-09-30', 'bos-nyy', 't3', 300, 'NYY', 50, 40, 12, 0.95, 'provisional', null, null]];
    for (const [label, rows] of [['an EMPTY', []], ['a NON-EMPTY (3 rows, one final)', ROWS]]) {
      const db = prA(rows);
      const seedBefore = seedHash(db), rowsBefore = db.prepare('SELECT * FROM top_trader_lean_log ORDER BY id').all();
      applyTopTradersDdl(db); applyTopTradersDdl(db);
      const after = db.prepare('SELECT * FROM top_trader_lean_log ORDER BY id').all();
      const kept = rowsBefore.every((r, i) => Object.keys(r).every(k => Object.is(r[k], after[i][k])) && after[i].skip_reason === null && after[i].snapshot_as_of === null);
      let skipOk = true, skipId = null, dupFinal = null;
      try { skipId = db.prepare("INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, qualified_count, kind, phase, skip_reason) VALUES ('2026-09-30', 'chc-sd', 'x', 1, 30, 'final', 'postseason', 'no_odds_locked_at')").run().lastInsertRowid; } catch (e) { skipOk = false; }
      try { db.prepare("INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, qualified_count, kind, phase, skip_reason) VALUES ('2026-09-30', 'chc-sd', 'y', 1, 30, 'final', 'postseason', 'no_odds_locked_at')").run(); } catch (e) { dupFinal = e.message; }
      ok(label + ' PR A lean log is rebuilt to EXACTLY the fresh definition (table, indexes, columns), twice cleanly', def(db) === REF);
      ok(label + ' rebuild: every row is copied with its id and values (' + rowsBefore.length + '), the new columns NULL', after.length === rowsBefore.length && kept);
      ok(label + ' rebuild: a skip row (no lean team) now inserts, after the existing ids; a second final for that game is refused',
        skipOk && (rowsBefore.length === 0 || skipId > rowsBefore[rowsBefore.length - 1].id) && /UNIQUE/.test(dupFinal || ''), 'skip id ' + skipId);
      ok(label + ' rebuild: top_trader_wallets and top_trader_qualified are untouched (40 wallets, 30 qualified, identical contents)',
        seedHash(db) === seedBefore && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 40);
      ok(label + ' rebuild leaves no temporary table behind', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'top_trader_lean_log_rebuild'").get());
    }
    const src = read('db/top-traders-ddl.js').replace(/\/\/.*$/gm, '');
    ok('the migration code names no statement on top_trader_wallets / top_trader_qualified other than their CREATE TABLE IF NOT EXISTS',
      !/(DROP|ALTER|DELETE|INSERT|UPDATE)[^;`]*top_trader_(wallets|qualified)\b/i.test(src));
  }

  // ---------------------------------------------------------------- f
  console.log('\nf. GET /api/top-traders/:date');
  {
    const db = appDb();
    seed(db, '2026-09-28', QUAL);                                    // addresses present in the database
    const ins = db.prepare(`INSERT INTO top_trader_lean_log (game_date, game_id, shown_at, cut_utc, lean_team, lean_dollars, other_dollars,
      wallets_with_money, top_wallet_share, qualified_count, away_ml_shown, home_ml_shown, price_source, kind, phase, locked_away_ml, locked_home_ml, skip_reason, snapshot_as_of)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1047, -130, 110, 'kalshi', ?, 'postseason', ?, ?, ?, '2026-09-28')`);
    ins.run('2026-10-02', 'nyy-bos', 'p1', 'NYY', 900, 100, 30, 0.80, 'provisional', null, null, null);
    ins.run('2026-10-02', 'nyy-bos', 'f', 'BOS', 500, 400, 31, 0.40, 'final', -130, 110, null);
    ins.run('2026-10-02', 'nyy-bos', 'p2', 'NYY', 950, 100, 32, 0.81, 'provisional', null, null, null);   // written after the final
    ins.run('2026-10-02', 'lad-sd', 'p1', 'LAD', 900, 100, 20, 0.70, 'provisional', null, null, null);
    ins.run('2026-10-02', 'lad-sd', 'p2', 'SD', 800, 300, 22, 0.75, 'provisional', null, null, null);
    ins.run('2026-10-02', 'chc-mil', 'p1', null, null, null, 0, null, 'provisional', null, null, 'no_qualified_money');
    const router = require(path.join(R, 'routes/top-traders'));
    router._setDb(db);
    const express = require(path.join(R, 'node_modules/express'));
    const app = express(); app.use('/api', router);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => {
      let s = ''; r.setEncoding('utf8'); r.on('data', d => { s += d; }); r.on('end', () => res({ code: r.statusCode, raw: s, body: JSON.parse(s) })); }).on('error', rej));
    const a = await get('/api/top-traders/2026-10-02'), e = await get('/api/top-traders/2026-10-03'), bad = await get('/api/top-traders/x');
    const by = Object.fromEntries(a.body.games.map(g => [g.game_id, g]));
    ok('the final row is preferred; otherwise the latest provisional row', by['nyy-bos'].kind === 'final' && by['nyy-bos'].lean_team === 'BOS' && by['lad-sd'].lean_team === 'SD');
    ok('largest-wallet share >= 75% is flagged (0.75 included), under it is not', by['lad-sd'].concentration_flag === true && by['nyy-bos'].concentration_flag === false);
    ok('each game carries dollars, wallets, share, qualified count, snapshot, postseason flag + note, prices and the decision-11 label',
      by['lad-sd'].lean_dollars === 800 && by['lad-sd'].other_dollars === 300 && by['lad-sd'].wallets_with_money === 22 && by['lad-sd'].qualified_count === 1047
      && by['lad-sd'].snapshot_as_of === '2026-09-28' && by['lad-sd'].postseason === true && by['lad-sd'].note === RULES.POSTSEASON_NOTE
      && by['lad-sd'].prices.source === 'kalshi' && by['lad-sd'].label === RULES.CARD_LABEL && a.body.label === RULES.CARD_LABEL);
    ok('a game with no lean shows its reason', by['chc-mil'].lean_team === null && by['chc-mil'].skip_reason === 'no_qualified_money');
    ok('no wallet address anywhere in the response (the database holds 40)', !/0x[0-9a-fA-F]{40}/.test(a.raw) && db.prepare('SELECT COUNT(*) c FROM top_trader_wallets').get().c === 40);
    ok('an empty list when nothing is stored for the date', e.code === 200 && Array.isArray(e.body.games) && e.body.games.length === 0);
    ok('a malformed date -> 400', bad.code === 400);
    await new Promise(r => server.close(r));
    router._resetDb();
    const src = read('routes/top-traders.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok('the route reads only the lean log: no wallets table, no fills, no network', !/top_trader_wallets|top_trader_live_fills|\baddr\b|fetch\(|https?:/.test(src)
      && /FROM top_trader_lean_log/.test(src));
  }

  // ---------------------------------------------------------------- g
  console.log('\ng. isolation');
  {
    const { stripJsComments } = require(path.join(R, 'services/harness-inputs'));
    const FORBIDDEN_TARGET = /^(services\/top-traders-live\.js|routes\/top-traders\.js)$/;
    const FORBIDDEN_TEXT = /top-traders-live|routes\/top-traders['"]|top_trader_live_|top_trader_lean_log/;
    const EXEMPT = new Set(['db/top-traders-ddl.js']);              // the DDL module creates the tables (reached via db/schema.js)
    function violations(roots, fsLike) {
      const rel = (f) => path.relative(R, f).replace(/\\/g, '/');
      const seen = new Set(), stack = roots.map(r => path.join(R, r)), bad = [];
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        const code = stripJsComments(fsLike.read(f));
        const t = !EXEMPT.has(rel(f)) && code.match(FORBIDDEN_TEXT);
        if (t) bad.push(rel(f) + ' names ' + t[0]);
        for (const x of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          const p = path.resolve(path.dirname(f), x[1]);
          const hit = [p, p + '.js', path.join(p, 'index.js')].find(c => fsLike.exists(c));
          if (!hit) continue;
          if (FORBIDDEN_TARGET.test(rel(hit))) bad.push(rel(f) + ' requires ' + rel(hit)); else stack.push(hit);
        }
      }
      return { files: new Set([...seen].map(rel)), bad };
    }
    const realFs = { exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(), read: (p) => fs.readFileSync(p, 'utf8') };
    const pricing = violations(['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js', 'routes/api.js'], realFs);
    ok('the pricing graph is walked (sanity) and includes services/jobs.js and routes/api.js',
      pricing.files.size > 50 && pricing.files.has('services/jobs.js') && pricing.files.has('routes/api.js'), pricing.files.size + ' files');
    ok('nothing in the pricing graph requires or names the live module, its router or its tables', pricing.bad.length === 0, pricing.bad.join(' | ') || 'none');
    ok('services/jobs.js and routes/api.js never mention the live job', !/top-traders-live|top_trader_live|TOP_TRADERS_LIVE/.test(stripJsComments(read('services/jobs.js')) + stripJsComments(read('routes/api.js'))));
    const PRICING = ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js', 'routes/api.js'];
    const liveReach = (() => { const s = new Set(); const st = ['services/top-traders-live.js', 'routes/top-traders.js'].map(r => path.join(R, r));
      while (st.length) { const f = st.pop(); const rf = path.relative(R, f).replace(/\\/g, '/'); if (s.has(rf)) continue; s.add(rf);
        for (const x of stripJsComments(realFs.read(f)).matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          const p = path.resolve(path.dirname(f), x[1]); const hit = [p, p + '.js', path.join(p, 'index.js')].find(c => realFs.exists(c)); if (hit) st.push(hit); } }
      return s; })();
    ok('the live module and its router reach nothing in the pricing path, and not the local-only backfill or backtest',
      PRICING.every(f => !liveReach.has(f)) && !liveReach.has('services/polymarket-backfill.js') && !liveReach.has('services/polymarket-top-traders-backtest.js'),
      [...liveReach].join(','));
    const srv = stripJsComments(read('server.js'));
    const iR = srv.indexOf("app.use('/api', require('./routes/top-traders'));"), iApi = srv.indexOf("app.use('/api', require('./routes/api'));");
    ok('server.js mounts the card router before routes/api.js and starts the job with the job queue (withMemLog)',
      iR > 0 && iApi > iR && /require\('\.\/services\/top-traders-live'\)\.startTopTradersLive\(\{ queued: withMemLog \}\)/.test(srv));
    ok('the backfill and the live job share one fetch implementation (utils/polymarket-trades.js); neither defines its own',
      /require\('\.\.\/utils\/polymarket-trades'\)/.test(read('services/polymarket-backfill.js')) && /require\('\.\.\/utils\/polymarket-trades'\)/.test(read('services/top-traders-live.js'))
      && !/function makeClient|const tradesUrl|MAX_OFFSET\s*=/.test(stripJsComments(read('services/polymarket-backfill.js')) + stripJsComments(read('services/top-traders-live.js'))));
    // Self-tests on planted graphs.
    const planted = {
      [path.join(R, 'services/model.js')]: "require('./helper');",
      [path.join(R, 'services/helper.js')]: "require('./top-traders-live');",
      [path.join(R, 'services/top-traders-live.js')]: '',
    };
    const pfs = { exists: (p) => Object.prototype.hasOwnProperty.call(planted, p), read: (p) => planted[p] };
    ok('SELF-TEST: a pricing file requiring the live module two hops deep is caught', violations(['services/model.js'], pfs).bad.some(b => /requires services\/top-traders-live\.js/.test(b)));
    planted[path.join(R, 'services/helper.js')] = "const t = 'SELECT * FROM top_trader_lean_log';";
    ok('SELF-TEST: a pricing file naming the lean log in code is caught', violations(['services/model.js'], pfs).bad.some(b => /names top_trader_lean_log/.test(b)));
    planted[path.join(R, 'services/helper.js')] = "// require('./top-traders-live') and top_trader_lean_log -- a comment only";
    ok('SELF-TEST: the same words in a comment are not a violation', violations(['services/model.js'], pfs).bad.length === 0);
  }

  try { require(path.join(R, 'db/schema')).db.close(); } catch (e) { /* never opened */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
