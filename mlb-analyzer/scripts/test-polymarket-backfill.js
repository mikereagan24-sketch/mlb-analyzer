#!/usr/bin/env node
'use strict';
/**
 * Polymarket pre-game backfill (services/polymarket-backfill.js), on
 * SYNTHETIC data with hand-computed answers. No network, and data/mlb.db is
 * never opened (a throwaway MLB_DB_PATH is set before anything can load
 * db/schema).
 *
 *   a. profit: buys, a partial sell before first pitch, the resolution payout,
 *      and a losing side
 *   b. net-short positions are excluded and counted
 *   c. window splitting: a market over the 10,000-offset cap is split until
 *      every window fits, with no fill lost or duplicated at window edges --
 *      and a crash mid-market resumes to the same result
 *   d. slug matching to game_log: the team-name map, a swapped outcome order,
 *      a clean -dh2 pair, a single-market doubleheader exclusion, a
 *      spring-training exclusion, a missing game_log date, unresolved
 *   e. the pre-game cutoff excludes a fill exactly at scheduled start
 *   f. isolation: no file in the pricing path references the backfill or its
 *      database, with self-tests that a planted violation is caught
 *   g. the start-time fallback: game_time -> UTC across both 2026 DST
 *      boundaries, the rule audit, an accepted fallback, a rejected
 *      disagreement, a POSTPONED game (game_time kept the original slot,
 *      Polymarket moved to the make-up date) excluded as unconfirmed, no
 *      fallback when scheduled_start_utc exists, and cutoff_source stored
 *   h. cutoff = earlier of scheduled_start_utc and first_pitch_utc (a
 *      SUSPENDED game), the manual exclusion, --recut on stored data, and
 *      discovery of an event whose end_date is a week after its game
 *   i. regular season only: spring training ends at MLB's real opening day
 *      (2026-03-25), not game_log's first date; postseason is excluded
 *
 *   node scripts/test-polymarket-backfill.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), '__pm_backfill_test_' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;                  // before anything can load db/schema
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const bf = require(path.join(R, 'services/polymarket-backfill'));

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + label + (detail != null ? '   ' + detail : ''));
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const store = () => bf.openStore(Database, ':memory:');
function addMarket(db, o) {
  const r = db.prepare(`INSERT INTO markets (condition_id, slug, outcome0, outcome1, status, cutoff_utc, resolved, winner_idx, game_id)
    VALUES (?, ?, ?, ?, 'matched', ?, 1, ?, ?)`).run(o.cid || ('0x' + Math.random()), o.slug || 'mlb-a-b-2026-07-01',
    o.outcome0 || 'Boston Red Sox', o.outcome1 || 'New York Yankees', o.cutoff || 2000000000, o.winner == null ? 0 : o.winner, o.game_id || 'bos-nyy');
  return r.lastInsertRowid;
}

// ---- a mock /trades that behaves like the real one (measured 2026-09-30):
// newest first, start/end inclusive, offset > 10000 -> HTTP 400.
function mockTrades(byCid, opts) {
  const o = Object.assign({ failAfter: Infinity }, opts || {});
  let calls = 0;
  return async (url) => {
    calls++;
    if (calls > o.failAfter) throw new Error('simulated crash');
    const u = new URL(url);
    const cid = u.searchParams.get('market'), start = +u.searchParams.get('start'), end = +u.searchParams.get('end');
    const offset = +u.searchParams.get('offset'), limit = +u.searchParams.get('limit');
    if (offset > bf.MAX_OFFSET) return { status: 400, text: async () => '{"error":"max historical trades offset of 10000 exceeded"}' };
    const rows = (byCid[cid] || []).filter(t => t.timestamp >= start && t.timestamp <= end);
    return { status: 200, text: async () => JSON.stringify(rows.slice(offset, offset + limit)) };
  };
}
const quietClient = (fetchImpl) => bf.makeClient({ fetchImpl, minGapMs: 0, sleep: async () => {}, log: () => {} });

(async () => {
  // ------------------------------------------------------------------ a, b
  console.log('a. profit math');
  {
    const db = store();
    const mid = addMarket(db, { winner: 0 });                 // outcome 0 (away) wins
    const w = (addr) => { db.prepare('INSERT OR IGNORE INTO wallets (addr) VALUES (?)').run(addr); return db.prepare('SELECT id FROM wallets WHERE addr = ?').get(addr).id; };
    const fill = (wid, side, outcome, price, size, ts) => db.prepare('INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?)').run(mid, wid, ts || 1000, side, outcome, price, size);
    const A = w('0xa'), B = w('0xb'), C = w('0xc'), D = w('0xd');
    fill(A, 1, 0, 0.40, 100); fill(A, -1, 0, 0.55, 30);      // buy 100 @.40, sell 30 @.55 -> hold 70 of the winner
    fill(B, 1, 1, 0.62, 50);                                    // 50 of the loser
    fill(C, 1, 0, 0.50, 10); fill(C, 1, 1, 0.50, 10);          // both sides, flat
    fill(D, -1, 1, 0.60, 20); fill(D, 1, 0, 0.45, 5);          // SHORT the loser without buying it: split shares
    const agg = bf.aggregateMarket(db, mid);
    const g = (id) => db.prepare('SELECT * FROM wallet_game WHERE market_id = ? AND wallet_id = ?').get(mid, id);
    const a = g(A), b = g(B), c = g(C);
    ok('A: spent 40, received 16.5, payout 70, profit +46.5, volume 56.5, 2 fills',
      near(a.spent, 40) && near(a.received, 16.5) && near(a.payout, 70) && near(a.profit, 46.5) && near(a.volume, 56.5) && a.fills === 2,
      JSON.stringify(a));
    ok('B: losing side -> payout 0, profit -31', near(b.payout, 0) && near(b.profit, -31), JSON.stringify(b));
    ok('C: both sides at .50 -> spent 10, payout 10, profit 0', near(c.spent, 10) && near(c.payout, 10) && near(c.profit, 0));
    console.log('b. net-short positions');
    ok('D (net short the losing team) is NOT in wallet_game', !g(D));
    ok('D is recorded in net_short with -20 shares', (() => { const r = db.prepare('SELECT * FROM net_short WHERE market_id = ?').all(mid); return r.length === 1 && r[0].wallet_id === D && near(r[0].net_shares, -20); })());
    ok('market counts: 1 net-short position, 1 net-short wallet-game, 3 wallet-games',
      agg.nsPositions === 1 && agg.nsWallets === 1 && agg.wallets === 3
      && db.prepare('SELECT net_short_positions p, net_short_wallet_games w, wallet_games g, status FROM markets WHERE id = ?').get(mid).status === 'done');
  }

  // ------------------------------------------------------------------ c
  console.log('\nc. window splitting past the 10,000-offset cap, and resume');
  {
    const CID = '0xbig', N = 25000, T0 = 1700000000;
    const trades = [];
    for (let i = 0; i < N; i++) {
      // Spread over ~2 days, plus a 600-fill burst on ONE second so window edges cut through dense time.
      const ts = i < 600 ? T0 + 86400 : T0 + Math.floor(i * 7.3);
      trades.push({ transactionHash: '0xtx' + i, proxyWallet: '0xw' + (i % 997), side: i % 3 ? 'BUY' : 'SELL',
        outcomeIndex: i % 2, price: 0.3 + (i % 40) / 100, size: 1 + (i % 17), timestamp: ts });
    }
    trades.sort((x, y) => y.timestamp - x.timestamp || (x.transactionHash < y.transactionHash ? -1 : 1));
    const cutoff = T0 + 400000;
    const db = store();
    const mid = addMarket(db, { cid: CID, cutoff });
    const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(mid);
    await bf.fetchMarket(db, quietClient(mockTrades({ [CID]: trades })), m);
    const r = db.prepare('SELECT fills_stored, window_count, split_needed, duplicates_dropped FROM markets WHERE id = ?').get(mid);
    const stored = db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(mid).c;
    const maxWin = db.prepare("SELECT MAX(fills) m FROM windows WHERE market_id = ? AND status = 'done'").get(mid).m;
    ok('all 25,000 fills stored (none lost)', stored === N && r.fills_stored === N, stored);
    ok('split was needed and recorded; more than one window', r.split_needed === 1 && r.window_count > 1, 'windows ' + r.window_count);
    ok('every finished window is under the cap', maxWin <= bf.MAX_OFFSET, 'largest ' + maxWin);
    const distinct = db.prepare('SELECT COUNT(*) c FROM (SELECT DISTINCT wallet_id, ts, side, outcome, price, size FROM fills WHERE market_id = ?)').get(mid).c;
    const ref = new Set(trades.map(t => ['0x' + '', t.proxyWallet, t.timestamp, t.side, t.outcomeIndex, t.price, t.size].join('|'))).size;
    ok('no fill duplicated at window edges (distinct rows == reference distinct rows)', distinct === ref, distinct + ' vs ' + ref);
    ok('windows tile the range with no gap or overlap', (() => {
      const ws = db.prepare("SELECT t_start, t_end FROM windows WHERE market_id = ? AND status = 'done' ORDER BY t_start").all(mid);
      if (ws[0].t_start !== 0 || ws[ws.length - 1].t_end !== cutoff - 1) return false;
      for (let i = 1; i < ws.length; i++) if (ws[i].t_start !== ws[i - 1].t_end + 1) return false;
      return true;
    })());
    // Resume: crash after 30 requests -- past the probes and splits, part-way
    // through paging, so committed pages of an unfinished window are on disk --
    // then run again on the same store.
    const db2 = store();
    const mid2 = addMarket(db2, { cid: CID, cutoff });
    const m2 = db2.prepare('SELECT * FROM markets WHERE id = ?').get(mid2);
    let crashed = false;
    try { await bf.fetchMarket(db2, quietClient(mockTrades({ [CID]: trades }, { failAfter: 30 })), m2); }
    catch (e) { crashed = /simulated crash|giving up/.test(e.message); }
    const partial = db2.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(mid2).c;
    await bf.fetchMarket(db2, quietClient(mockTrades({ [CID]: trades })), m2);
    const after = db2.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(mid2).c;
    ok('a crash mid-market leaves a partial store (' + partial + ' fills), then resume completes exactly', crashed && partial > 0 && partial < N && after === N, after);
  }

  // ------------------------------------------------------------------ d
  console.log('\nd. slug matching to game_log');
  {
    const mlb = new Database(':memory:');
    mlb.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, game_time TEXT, is_removed INTEGER)');
    const G = (d, id, s) => mlb.prepare('INSERT INTO game_log VALUES (?, ?, ?, NULL, 0)').run(d, id, s);
    G('2026-04-04', 'bos-nyy', '2026-04-04T17:05:00Z');                          // season start
    G('2026-05-01', 'was-atl', '2026-05-01T23:20:00Z');
    G('2026-05-01', 'ath-sea', '2026-05-02T02:10:00Z');
    G('2026-05-02', 'chc-cle', '2026-05-02T17:10:00Z'); G('2026-05-02', 'chc-cle-g2', '2026-05-02T23:10:00Z');   // DH, both markets
    G('2026-05-03', 'col-nym', '2026-05-03T17:10:00Z'); G('2026-05-03', 'col-nym-g2', '2026-05-03T23:10:00Z');   // DH, one market
    mlb.exec('ALTER TABLE game_log ADD COLUMN first_pitch_utc TEXT');          // all NULL here
    const gi = bf.loadGameIndex(mlb);
    const slugs = new Set(['mlb-wsh-atl-2026-05-01', 'mlb-chc-cle-2026-05-02', 'mlb-chc-cle-2026-05-02-dh2', 'mlb-col-nym-2026-05-03']);
    const M = (slug, o0, o1, resolved) => bf.matchMarket({ slug, outcome0: o0, outcome1: o1, resolved: resolved == null ? 1 : resolved }, gi, slugs);
    const r1 = M('mlb-wsh-atl-2026-05-01', 'Washington Nationals', 'Atlanta Braves');
    ok('team-name map: Washington Nationals -> was, matched was-atl', r1.status === 'matched' && r1.game_id === 'was-atl' && r1.outcome0_is_home === 0);
    ok('cutoff is game_log scheduled_start_utc', r1.cutoff_utc === Date.parse('2026-05-01T23:20:00Z') / 1000);
    const r2 = M('mlb-sea-ath-2026-05-01', 'Seattle Mariners', 'Athletics');
    ok('outcomes in the other order still match (outcome0 is home)', r2.status === 'matched' && r2.game_id === 'ath-sea' && r2.outcome0_is_home === 1, JSON.stringify(r2));
    ok('explicit DH pair: plain slug -> game 1', M('mlb-chc-cle-2026-05-02', 'Chicago Cubs', 'Cleveland Guardians').game_id === 'chc-cle');
    ok('explicit DH pair: -dh2 slug -> game 2', M('mlb-chc-cle-2026-05-02-dh2', 'Chicago Cubs', 'Cleveland Guardians').game_id === 'chc-cle-g2');
    ok('single-market doubleheader is excluded with a reason',
      M('mlb-col-nym-2026-05-03', 'Colorado Rockies', 'New York Mets').reason === 'dh_single_market');
    ok('spring training (before game_log begins) is excluded', M('mlb-sea-oak-2026-03-19', 'Seattle Mariners', 'Athletics').reason === 'spring_training');
    ok('a season date missing from game_log is excluded', M('mlb-stl-wsh-2026-04-07', 'St. Louis Cardinals', 'Washington Nationals').reason === 'missing_game_log_date');
    ok('no such game on a known date -> unmatched', M('mlb-tex-min-2026-05-01', 'Texas Rangers', 'Minnesota Twins').reason === 'unmatched');
    ok('an unresolved market is excluded', M('mlb-wsh-atl-2026-05-01', 'Washington Nationals', 'Atlanta Braves', 0).reason === 'unresolved');
    ok('a non-standard slug is excluded', M('mlb-wsh-atl-2026-05-01-player-props', 'x', 'y').reason === 'nonstandard_slug');
  }

  // ------------------------------------------------------------------ e
  console.log('\ne. the pre-game cutoff');
  {
    const CID = '0xcut', S = 1780000000;
    const T = (i, ts) => ({ transactionHash: '0xc' + i, proxyWallet: '0xw', side: 'BUY', outcomeIndex: 0, price: 0.5, size: 1, timestamp: ts });
    const trades = [T(1, S + 1), T(2, S), T(3, S - 1), T(4, S - 3600)];
    const db = store();
    const mid = addMarket(db, { cid: CID, cutoff: S });
    await bf.fetchMarket(db, quietClient(mockTrades({ [CID]: trades })), db.prepare('SELECT * FROM markets WHERE id = ?').get(mid));
    const ts = db.prepare('SELECT ts FROM fills WHERE market_id = ? ORDER BY ts').all(mid).map(r => r.ts);
    ok('a fill exactly at scheduled start is excluded; one second before is kept', JSON.stringify(ts) === JSON.stringify([S - 3600, S - 1]), ts.join(','));
  }

  // ------------------------------------------------------------------ f
  console.log('\nf. isolation from the pricing path');
  {
    const { stripJsComments } = require(path.join(R, 'services/harness-inputs'));
    const ROOTS = ['services/model.js', 'utils/pythag-win-prob.js', 'services/jobs.js'];
    const FORBIDDEN_TARGET = /^(services\/polymarket-backfill\.js|scripts\/polymarket-backfill\.js)$/;
    const FORBIDDEN_TEXT = /polymarket-backfill|polymarket\.db/;
    function violations(roots, fsLike, root) {
      const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
      const seen = new Set(), stack = roots.map(r => path.join(root, r)), bad = [];
      while (stack.length) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        const code = stripJsComments(fsLike.read(f));
        const t = code.match(FORBIDDEN_TEXT);
        if (t) bad.push(rel(f) + ' names ' + t[0]);
        for (const x of code.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          const p = path.resolve(path.dirname(f), x[1]);
          const hit = [p, p + '.js', path.join(p, 'index.js')].find(c => fsLike.exists(c));
          if (!hit) continue;
          if (FORBIDDEN_TARGET.test(rel(hit))) bad.push(rel(f) + ' requires ' + rel(hit));
          else stack.push(hit);
        }
      }
      return { files: seen, bad };
    }
    const realFs = { exists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(), read: (p) => fs.readFileSync(p, 'utf8') };
    const iso = violations(ROOTS, realFs, R);
    ok('the pricing graph was walked (sanity)', iso.files.size > 20, iso.files.size + ' files');
    ok('services/polymarket.js is in that graph (the backfill may use it; not the reverse)', iso.files.has(path.join(R, 'services/polymarket.js')));
    ok('no file in the pricing graph references the backfill or data/polymarket.db', iso.bad.length === 0, iso.bad.join(' | ') || 'none');
    const planted = {
      [path.join(R, 'services/model.js')]: "require('./odds');",
      [path.join(R, 'services/odds.js')]: "const b = require('./polymarket-backfill');",
      [path.join(R, 'services/polymarket-backfill.js')]: '',
    };
    const pfs = { exists: (p) => Object.prototype.hasOwnProperty.call(planted, p), read: (p) => planted[p] };
    const c1 = violations(['services/model.js'], pfs, R);
    ok('SELF-TEST: a require of the backfill one hop deep is caught', c1.bad.length >= 1 && /services\/odds\.js/.test(c1.bad[0]), c1.bad.join(' | '));
    planted[path.join(R, 'services/odds.js')] = "// polymarket.db in a comment is fine\nconst p = 'data/polymarket.db';";
    const c2 = violations(['services/model.js'], pfs, R);
    ok('SELF-TEST: the database path in code is caught; in a comment it is not', c2.bad.length === 1 && /names polymarket\.db/.test(c2.bad[0]), c2.bad.join(' | '));
  }

  // ------------------------------------------------------------------ g
  console.log('\ng. the start-time fallback (game_time, confirmed by Polymarket)');
  {
    const U = (iso) => Date.parse(iso) / 1000;
    const E = bf.etGameTimeToUtc;
    // 2026 US DST: starts Sun 2026-03-08 02:00, ends Sun 2026-11-01 02:00.
    ok('DST spring boundary: 7:05 PM ET the day before is EST (UTC-5)', E('2026-03-07', '7:05 PM ET') === U('2026-03-08T00:05:00Z'));
    ok('DST spring boundary: 1:05 PM ET on the change day is EDT (UTC-4)', E('2026-03-08', '1:05 PM ET') === U('2026-03-08T17:05:00Z'));
    ok('DST spring boundary: 7:05 PM ET the day after is EDT', E('2026-03-09', '7:05 PM ET') === U('2026-03-09T23:05:00Z'));
    ok('DST fall boundary: 8:00 PM ET on Oct 31 is EDT -> next UTC day', E('2026-10-31', '8:00 PM ET') === U('2026-11-01T00:00:00Z'));
    ok('DST fall boundary: 8:00 PM ET on Nov 2 is EST (UTC-5)', E('2026-11-02', '8:00 PM ET') === U('2026-11-03T01:00:00Z'));
    ok('in season: 7:45 PM ET on 2026-08-10 -> 23:45Z (a real game_log row)', E('2026-08-10', '7:45 PM ET') === U('2026-08-10T23:45:00Z'));
    ok('12 PM is noon, 12 AM is midnight', E('2026-07-01', '12:05 PM ET') === U('2026-07-01T16:05:00Z') && E('2026-07-01', '12:30 AM ET') === U('2026-07-01T04:30:00Z'));
    ok('no ET zone, null, or an impossible hour -> null (no guessing)',
      E('2026-04-26', '10:45 AM') === null && E('2026-04-26', null) === null && E('2026-04-26', '13:05 PM ET') === null && E(null, '1:05 PM ET') === null);

    // The rule audit, on a synthetic game_log with one of each case.
    const aud = new Database(':memory:');
    aud.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, game_time TEXT, is_removed INTEGER)');
    const A = (d, id, s, t) => aud.prepare('INSERT INTO game_log VALUES (?, ?, ?, ?, 0)').run(d, id, s, t);
    A('2026-08-10', 'phi-stl', '2026-08-10T23:45:00Z', '7:45 PM ET');            // exact
    A('2026-06-19', 'bos-sea', '2026-06-20T02:10:00Z', '10:10 PM ET');           // exact, crosses UTC midnight
    A('2026-05-09', 'tb-bos', '2026-07-17T17:35:00Z', '4:10 PM ET');             // postponed: moved
    A('2026-04-26', 'col-nym-g2', '2026-04-26T17:45:00Z', '10:45 AM');           // no ET zone
    A('2026-07-01', 'aaa-bbb', '2026-07-01T23:40:00Z', '7:10 PM ET');            // 30 min off: a real failure
    A('2026-07-02', 'ccc-ddd', null, '7:10 PM ET');                               // not both fields: not audited
    const au = bf.auditGameTimeRule(aud);
    ok('audit: 5 rows with both fields, 2 exact; 1 moved, 1 no_et_zone, 1 other',
      au.total === 5 && au.exact === 2 && au.byKind.moved === 1 && au.byKind.no_et_zone === 1 && au.byKind.other === 1, JSON.stringify(au.byKind));

    // Matching with the fallback.
    const mlb = new Database(':memory:');
    mlb.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, game_time TEXT, is_removed INTEGER)');
    const G = (d, id, s, t) => mlb.prepare('INSERT INTO game_log VALUES (?, ?, ?, ?, 0)').run(d, id, s, t);
    G('2026-04-04', 'bos-nyy', '2026-04-04T17:05:00Z', '1:05 PM ET');            // season start
    G('2026-04-23', 'mil-det', null, '1:10 PM ET');                               // fallback candidates ...
    G('2026-04-24', 'was-cws', null, '7:40 PM ET');
    G('2026-04-05', 'chc-cle', null, '7:15 PM ET');                               // ... postponed
    G('2026-04-13', 'mia-atl', null, null);                                       // neither field
    G('2026-04-14', 'sf-phi', null, '6:40 PM');                                   // no zone
    G('2026-05-01', 'was-atl', '2026-05-01T23:20:00Z', '9:00 PM ET');            // both; they disagree
    mlb.exec('ALTER TABLE game_log ADD COLUMN first_pitch_utc TEXT');          // all NULL here
    const gi = bf.loadGameIndex(mlb);
    const M = (slug, o0, o1, poly) => bf.matchMarket({ slug, outcome0: o0, outcome1: o1, resolved: 1, poly_start_utc: poly }, gi, new Set([slug]));
    const t1 = U('2026-04-23T17:10:00Z');
    const acc = M('mlb-mil-det-2026-04-23', 'Milwaukee Brewers', 'Detroit Tigers', t1 + 5 * 60);
    ok('accepted: no scheduled_start_utc, game_time within 15 min of Polymarket -> matched, cutoff from game_time',
      acc.status === 'matched' && acc.cutoff_utc === t1 && acc.cutoff_source === 'fallback_confirmed', JSON.stringify(acc));
    ok('accepted at exactly 15 minutes (the tolerance is inclusive)',
      M('mlb-mil-det-2026-04-23', 'Milwaukee Brewers', 'Detroit Tigers', t1 - 15 * 60).cutoff_source === 'fallback_confirmed');
    ok('rejected: 20 minutes apart -> excluded start_time_unconfirmed',
      M('mlb-was-cws-2026-04-24', 'Washington Nationals', 'Chicago White Sox', U('2026-04-24T23:40:00Z') + 20 * 60).reason === 'start_time_unconfirmed');
    ok('rejected: no Polymarket start to confirm against -> start_time_unconfirmed',
      M('mlb-was-cws-2026-04-24', 'Washington Nationals', 'Chicago White Sox', null).reason === 'start_time_unconfirmed');
    const pp = M('mlb-chc-cle-2026-04-05', 'Chicago Cubs', 'Cleveland Guardians', U('2026-06-01T17:05:00Z'));
    ok('POSTPONED: game_time kept the 4/05 slot, Polymarket moved to the make-up date -> start_time_unconfirmed',
      pp.status === 'excluded' && pp.reason === 'start_time_unconfirmed', JSON.stringify(pp));
    ok('neither field -> excluded no_start_time', M('mlb-mia-atl-2026-04-13', 'Miami Marlins', 'Atlanta Braves', U('2026-04-13T23:15:00Z')).reason === 'no_start_time');
    ok('game_time with no zone -> excluded game_time_unparseable (Polymarket start is not used as a substitute)',
      M('mlb-sf-phi-2026-04-14', 'San Francisco Giants', 'Philadelphia Phillies', U('2026-04-14T22:40:00Z')).reason === 'game_time_unparseable');
    const sch = M('mlb-wsh-atl-2026-05-01', 'Washington Nationals', 'Atlanta Braves', U('2026-05-02T01:00:00Z'));
    ok('no fallback when scheduled_start_utc exists: it wins even though game_time and Polymarket disagree with it',
      sch.status === 'matched' && sch.cutoff_utc === U('2026-05-01T23:20:00Z') && sch.cutoff_source === 'scheduled_start_utc', JSON.stringify(sch));

    // cutoff_source is stored per market by matchAll.
    const db = store();
    const put = (cid, slug, o0, o1, poly) => db.prepare(`INSERT INTO markets (condition_id, slug, outcome0, outcome1, poly_start_utc, resolved, winner_idx)
      VALUES (?, ?, ?, ?, ?, 1, 0)`).run(cid, slug, o0, o1, poly);
    put('0xf1', 'mlb-mil-det-2026-04-23', 'Milwaukee Brewers', 'Detroit Tigers', t1 + 60);
    put('0xf2', 'mlb-wsh-atl-2026-05-01', 'Washington Nationals', 'Atlanta Braves', U('2026-05-01T23:20:00Z'));
    put('0xf3', 'mlb-chc-cle-2026-04-05', 'Chicago Cubs', 'Cleveland Guardians', U('2026-06-01T17:05:00Z'));
    bf.matchAll(db, gi);
    const rows = Object.fromEntries(db.prepare('SELECT condition_id, status, cutoff_source, exclusion_reason FROM markets').all().map(r => [r.condition_id, r]));
    ok('markets.cutoff_source recorded: fallback_confirmed / scheduled_start_utc / NULL for the excluded game',
      rows['0xf1'].cutoff_source === 'fallback_confirmed' && rows['0xf2'].cutoff_source === 'scheduled_start_utc'
      && rows['0xf3'].cutoff_source === null && rows['0xf3'].exclusion_reason === 'start_time_unconfirmed', JSON.stringify(rows));
  }

  // ------------------------------------------------------------------ h
  console.log('\nh. first pitch vs scheduled start, manual exclusion, --recut, discovery end-date slack');
  {
    const U = (iso) => Date.parse(iso) / 1000;
    const rc = bf.resolveCutoff;
    // sf-atl 2026-06-16 as game_log has it: started on time, suspended, resumed 6/17.
    const susp = rc({ game_date: '2026-06-16', scheduled_start_utc: '2026-06-17T18:00:00Z', first_pitch_utc: '2026-06-16T23:16:00.000Z', game_time: '7:15 PM ET' }, U('2026-06-16T23:15:00Z'));
    ok('SUSPENDED game: first pitch on the original date wins over the resumption-date scheduled start',
      susp.cutoff_utc === U('2026-06-16T23:16:00Z') && susp.cutoff_source === 'first_pitch_utc', JSON.stringify(susp));
    const late = rc({ scheduled_start_utc: '2026-08-10T23:45:00Z', first_pitch_utc: '2026-08-10T23:47:00.000Z' }, null);
    ok('ordinary game: first pitch 2 min after scheduled -> scheduled start is the cutoff',
      late.cutoff_utc === U('2026-08-10T23:45:00Z') && late.cutoff_source === 'scheduled_start_utc');
    const early = rc({ scheduled_start_utc: '2026-05-06T00:10:00Z', first_pitch_utc: '2026-05-06T00:09:00.000Z' }, null);
    ok('first pitch a minute BEFORE scheduled (as lad-hou 5/05) -> first pitch is the cutoff',
      early.cutoff_utc === U('2026-05-06T00:09:00Z') && early.cutoff_source === 'first_pitch_utc');
    const fpOnly = rc({ game_date: '2026-04-10', scheduled_start_utc: null, first_pitch_utc: '2026-04-10T23:07:00.000Z', game_time: '9:00 PM ET' }, U('2026-04-11T01:00:00Z'));
    ok('first pitch but no scheduled start -> first pitch; the game_time fallback is not consulted',
      fpOnly.cutoff_utc === U('2026-04-10T23:07:00Z') && fpOnly.cutoff_source === 'first_pitch_utc');

    const mx = bf.matchMarket({ slug: 'mlb-chc-bos-2026-09-27', outcome0: 'Chicago Cubs', outcome1: 'Boston Red Sox', resolved: 1 },
      { byKey: new Map(), dates: new Set(['2026-09-27']), seasonStart: '2026-03-26' }, new Set());
    ok('chc-bos 9/27 is excluded as market_does_not_match_game before any matching', mx.status === 'excluded' && mx.reason === 'market_does_not_match_game');

    // --recut on stored data
    const mlb = new Database(':memory:');
    mlb.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, first_pitch_utc TEXT, game_time TEXT, is_removed INTEGER)');
    const G = (d, id, s, f) => mlb.prepare('INSERT INTO game_log VALUES (?, ?, ?, ?, NULL, 0)').run(d, id, s, f);
    G('2026-04-01', 'bos-nyy', '2026-04-01T17:05:00Z', null);                         // season start; stored cutoff too early
    G('2026-06-16', 'sf-atl', '2026-06-17T18:00:00Z', '2026-06-16T23:16:00.000Z');   // suspended
    G('2026-07-01', 'tex-min', '2026-07-02T00:10:00Z', '2026-07-02T00:11:00.000Z');  // unchanged
    G('2026-09-27', 'chc-bos', '2026-09-27T19:05:00Z', '2026-09-27T19:05:00.000Z');  // manual exclusion
    const gi = bf.loadGameIndex(mlb);
    const db = store();
    const S = U('2026-06-16T23:16:00Z'), OLD = U('2026-06-17T18:00:00Z');
    const mk = (cid, slug, o0, o1, gid, cut) => db.prepare(`INSERT INTO markets (condition_id, slug, outcome0, outcome1, status, game_date, game_id,
      cutoff_utc, cutoff_source, outcome0_is_home, resolved, winner_idx) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, 'scheduled_start_utc', 0, 1, 0)`)
      .run(cid, slug, o0, o1, bf.slugDate(slug), gid, cut).lastInsertRowid;
    const A = mk('0xr1', 'mlb-sf-atl-2026-06-16', 'San Francisco Giants', 'Atlanta Braves', 'sf-atl', OLD);
    const B = mk('0xr2', 'mlb-tex-min-2026-07-01', 'Texas Rangers', 'Minnesota Twins', 'tex-min', U('2026-07-02T00:10:00Z'));
    const C = mk('0xr3', 'mlb-chc-bos-2026-09-27', 'Chicago Cubs', 'Boston Red Sox', 'chc-bos', U('2026-09-27T19:05:00Z'));
    const E = mk('0xr4', 'mlb-bos-nyy-2026-04-01', 'Boston Red Sox', 'New York Yankees', 'bos-nyy', U('2026-04-01T16:00:00Z'));
    const W = (addr) => { db.prepare('INSERT OR IGNORE INTO wallets (addr) VALUES (?)').run(addr); return db.prepare('SELECT id FROM wallets WHERE addr = ?').get(addr).id; };
    const F = (mid, w, ts, side, outcome, price, size) => db.prepare('INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?)').run(mid, W(w), ts, side, outcome, price, size);
    const WIN = (mid, a, b, status, fills) => db.prepare('INSERT INTO windows VALUES (?, ?, ?, ?, ?, 0)').run(mid, a, b, status, fills);
    F(A, '0xa', S - 3600, 1, 0, 0.50, 10);        // pre-game buy
    F(A, '0xb', S - 1, 1, 1, 0.40, 10);           // pre-game buy, one second before first pitch
    F(A, '0xa', S, -1, 0, 0.90, 10);              // IN-GAME sell, at first pitch
    F(A, '0xc', S + 50, 1, 0, 0.95, 5);           // in-game, first window
    F(A, '0xc', S + 500, 1, 0, 0.97, 5);          // in-game, second window
    WIN(A, 0, OLD - 1, 'split', null); WIN(A, 0, S + 99, 'done', 4); WIN(A, S + 100, OLD - 1, 'done', 1);
    db.prepare('UPDATE markets SET fills_stored = 5, window_count = 2, split_needed = 1 WHERE id = ?').run(A);
    for (const mid of [B, C, E]) { F(mid, '0xd', U('2026-01-01T00:00:00Z'), 1, 0, 0.5, 2); WIN(mid, 0, 1999999999, 'done', 1); }
    for (const mid of [A, B, C, E]) bf.aggregateMarket(db, mid);
    const before = db.prepare('SELECT COUNT(*) c FROM fills').get().c;
    const dry = bf.recutDoneMarkets(db, gi, {});
    ok('dry run lists changes and changes nothing', db.prepare('SELECT COUNT(*) c FROM fills').get().c === before && dry.length === 3,
      dry.map(c => c.slug + ':' + c.action).join(', '));
    const byslug = Object.fromEntries(dry.map(c => [c.slug, c]));
    ok('dry run: sf-atl truncate (3 fills), chc-bos exclude, bos-nyy refetch (cutoff moved later), tex-min untouched',
      byslug['mlb-sf-atl-2026-06-16'].action === 'truncate' && byslug['mlb-sf-atl-2026-06-16'].fills_removed === 3
      && byslug['mlb-chc-bos-2026-09-27'].action === 'exclude' && byslug['mlb-bos-nyy-2026-04-01'].action === 'refetch' && !byslug['mlb-tex-min-2026-07-01']);
    bf.recutDoneMarkets(db, gi, { apply: true, only: new Set(['mlb-sf-atl-2026-06-16']) });
    ok('--only limits the change to the named market', db.prepare('SELECT status FROM markets WHERE id = ?').get(C).status === 'done');
    const a = db.prepare('SELECT * FROM markets WHERE id = ?').get(A);
    const ws = db.prepare("SELECT t_start, t_end, status, fills FROM windows WHERE market_id = ? ORDER BY status, t_start").all(A);
    ok('truncate: fills at/after first pitch removed, cutoff and source updated',
      db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(A).c === 2 && a.cutoff_utc === S && a.cutoff_source === 'first_pitch_utc'
      && a.fills_stored === 2 && a.window_count === 1 && a.status === 'done', JSON.stringify(a));
    ok('truncate: the window past the cutoff is dropped, the straddling one ends at cutoff-1 and is recounted, split history kept',
      JSON.stringify(ws) === JSON.stringify([{ t_start: 0, t_end: S - 1, status: 'done', fills: 2 }, { t_start: 0, t_end: OLD - 1, status: 'split', fills: null }]), JSON.stringify(ws));
    const g = (w) => db.prepare('SELECT profit FROM wallet_game WHERE market_id = ? AND wallet_id = ?').get(A, W(w));
    ok('truncate: wallet_game recomputed (A +5 holding 10 winners bought at .50; B -4; C, in-game only, gone)',
      near(g('0xa').profit, 5) && near(g('0xb').profit, -4) && !g('0xc'));
    bf.recutDoneMarkets(db, gi, { apply: true });
    const c = db.prepare('SELECT status, exclusion_reason, fills_stored FROM markets WHERE id = ?').get(C);
    ok('exclude: chc-bos 9/27 excluded with its reason; fills, windows and wallet_game removed',
      c.status === 'excluded' && c.exclusion_reason === 'market_does_not_match_game'
      && ['fills', 'windows', 'wallet_game'].every(t => !db.prepare('SELECT 1 FROM ' + t + ' WHERE market_id = ?').get(C)), JSON.stringify(c));
    const e = db.prepare('SELECT status, cutoff_utc FROM markets WHERE id = ?').get(E);
    ok('refetch: a cutoff that moved LATER sends the market back to matched with its data removed',
      e.status === 'matched' && e.cutoff_utc === U('2026-04-01T17:05:00Z') && !db.prepare('SELECT 1 FROM fills WHERE market_id = ?').get(E));
    ok('a second recut finds nothing to change (idempotent), and tex-min kept its data',
      bf.recutDoneMarkets(db, gi, {}).length === 0 && db.prepare('SELECT COUNT(*) c FROM fills WHERE market_id = ?').get(B).c === 1);
    ok('applyManualExclusions is a no-op on an already-excluded market', bf.applyManualExclusions(db).length === 0);

    // discovery: an event whose end_date is a week after its game. With
    // --from 09-21 --to 09-27 the old walk's last window was [09-30, 10-03].
    const ev = (slug, endDate) => ({ id: slug, slug, endDate, closed: true, markets: [{ sportsMarketType: 'moneyline', conditionId: '0x' + slug,
      outcomes: '["New York Mets","Washington Nationals"]', outcomePrices: '["0","1"]', closed: true, gameStartTime: '2026-09-27 17:05:00+00' }] });
    const events = [ev('mlb-nym-wsh-2026-09-27', '2026-10-04T17:05:00Z'), ev('mlb-tb-phi-2026-09-21', '2026-09-22T17:05:00Z'), ev('mlb-tb-phi-2026-09-28', '2026-09-29T17:05:00Z')];
    const gamma = async (url) => {
      const u = new URL(url);
      const lo = Date.parse(u.searchParams.get('end_date_min')), hi = Date.parse(u.searchParams.get('end_date_max'));
      const off = +u.searchParams.get('offset'), closed = u.searchParams.get('closed') === 'true';
      const rows = events.filter(x => x.closed === closed && Date.parse(x.endDate) >= lo && Date.parse(x.endDate) <= hi);
      return { status: 200, text: async () => JSON.stringify(rows.slice(off, off + 100)) };
    };
    const ddb = store();
    await bf.discoverRange(ddb, quietClient(gamma), '2026-09-21', '2026-09-27');
    const found = ddb.prepare('SELECT slug FROM markets ORDER BY slug').all().map(r => r.slug);
    ok('an event whose end_date is a week after its game (the final weekend) is discovered', found.includes('mlb-nym-wsh-2026-09-27'), found.join(','));
    ok('slug dates outside --from/--to are still skipped', found.includes('mlb-tb-phi-2026-09-21') && !found.includes('mlb-tb-phi-2026-09-28'));
  }

  // ------------------------------------------------------------------ i
  console.log('\ni. regular season only: MLB\'s own season dates');
  {
    // game_log starting nine days after opening day, as the real one does (#486).
    const mlb = new Database(':memory:');
    mlb.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, first_pitch_utc TEXT, game_time TEXT, is_removed INTEGER)');
    mlb.prepare("INSERT INTO game_log VALUES ('2026-04-04', 'bos-nyy', '2026-04-04T17:05:00Z', NULL, NULL, 0)").run();
    mlb.prepare("INSERT INTO game_log VALUES ('2026-09-27', 'bos-nyy', '2026-09-27T17:05:00Z', NULL, NULL, 0)").run();
    const gi = bf.loadGameIndex(mlb);
    const M = (slug) => bf.matchMarket({ slug, outcome0: 'Boston Red Sox', outcome1: 'New York Yankees', resolved: 1 }, gi, new Set([slug]));
    ok('2026 regular season is statsapi\'s 2026-03-25 .. 2026-09-27', bf.REGULAR_SEASON[2026].start === '2026-03-25' && bf.REGULAR_SEASON[2026].end === '2026-09-27');
    ok('the day before opening day is spring training', M('mlb-bos-nyy-2026-03-24').reason === 'spring_training');
    ok('opening day with no game_log rows is missing_game_log_date, NOT spring training', M('mlb-bos-nyy-2026-03-25').reason === 'missing_game_log_date');
    ok('the day before game_log begins (04-03) is missing_game_log_date', M('mlb-bos-nyy-2026-04-03').reason === 'missing_game_log_date');
    ok('the last regular-season day still matches', M('mlb-bos-nyy-2026-09-27').status === 'matched');
    ok('the day after it (Wild Card) is postseason_out_of_scope', M('mlb-bos-nyy-2026-09-29').reason === 'postseason_out_of_scope');
    ok('a year with no recorded season dates is excluded, not guessed', M('mlb-bos-nyy-2027-05-01').reason === 'season_dates_unknown');
  }

  try { require(path.join(R, 'db/schema')).db.close(); } catch (e) { /* not loaded */ }
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* absent */ } }
  ok('the throwaway database was removed (data/mlb.db never opened)', !fs.existsSync(TMP_DB));
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
