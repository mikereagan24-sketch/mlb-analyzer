#!/usr/bin/env node
'use strict';
/**
 * Bullpen pools and prices, main vs branch, for the #473 identity proof.
 *
 *   node scripts/replay-player-identity.js --root <repo dir> --db <source db> --dates d1,d2 --out x.json [--with-ids]
 *   node scripts/replay-player-identity.js --compare main.json branch.json
 *
 * --root is the mlb-analyzer checkout whose code runs. The source database is
 * only READ: a backup goes to a temp directory (deleted afterwards) and
 * MLB_DB_PATH points at it before any module loads db/schema.
 *
 * Per game: every team's bullpen pool for both batter hands (members, pool
 * size, wOBA), then the real processGameSignals with the clock pinned 3h
 * before first pitch, its odds lock and score cleared, so the model prices
 * the game: model moneylines and total. No network.
 *
 * --with-ids writes the ids the #473 measurement resolved onto the copy's
 * woba_data, as the next upload would carry them (columns added if absent,
 * so main runs on the same data and simply ignores them):
 *   807398 "Julio  Marte" / "Julio Marte" HOU    835395 "Luis  Avila" CIN
 *   829500 "Luis  Fonseca" CWS                   655889 "Manuel Rodríguez" TB
 *   the plain "Manuel Rodriguez" TB row: a DIFFERENT player (other stat line)
 *   whose true id FanGraphs did not let us read; it gets the stand-in
 *   900000001 -- any id other than 655889 behaves identically here.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (args[0] === '--compare') { compare(args[1], args[2]); process.exit(process.exitCode || 0); }

const ROOT = path.resolve(arg('--root') || path.join(__dirname, '..'));
const SRC_DB = path.resolve(arg('--db') || '');
const DATES = String(arg('--dates') || '').split(',').filter(Boolean);
const OUT = arg('--out') ? path.resolve(arg('--out')) : null;
const WITH_IDS = args.includes('--with-ids');
if (!DATES.length || !OUT || !arg('--db')) { console.error('usage: --root <dir> --db <file> --dates d1,d2 --out <file> [--with-ids]'); process.exit(2); }

const IDS = [
  ['Julio  Marte HOU', 807398], ['Julio Marte HOU', 807398],
  ['Luis  Avila CIN', 835395], ['Luis Avila CIN', 835395],
  ['Luis  Fonseca CWS', 829500], ['Luis Fonseca CWS', 829500],
  ['Manuel Rodríguez TB', 655889], ['Manuel Rodriguez TB', 900000001],
];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '__replay473_'));
const TMP_DB = path.join(TMP, 'mlb.db');
(async () => {
  const Sqlite = require(path.join(ROOT, 'node_modules/better-sqlite3'));
  const src = new Sqlite(SRC_DB, { readonly: true, fileMustExist: true });
  await src.backup(TMP_DB); src.close();
  if (WITH_IDS) {
    const w = new Sqlite(TMP_DB);
    for (const c of ['fg_player_id TEXT', 'mlbam_id INTEGER']) { try { w.exec('ALTER TABLE woba_data ADD COLUMN ' + c); } catch (e) {} }
    const up = w.prepare("UPDATE woba_data SET mlbam_id = ? WHERE player_name = ? AND data_key LIKE 'pit-proj-%'");
    for (const [n, id] of IDS) up.run(id, n);
    w.close();
  }
  process.env.MLB_DB_PATH = TMP_DB;
  process.chdir(TMP);

  const net = [];
  const deny = async (u) => { net.push(String(u)); throw new Error('replay: network is forbidden'); };
  const nfPath = require.resolve('node-fetch', { paths: [ROOT] });
  const fm = new Module(nfPath); fm.filename = nfPath; fm.loaded = true; fm.exports = deny; deny.default = deny;
  require.cache[nfPath] = fm;
  globalThis.fetch = deny;
  const RealDate = Date; let fakeNow = null;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0 && fakeNow != null) super(fakeNow); else super(...a); }
    static now() { return fakeNow != null ? fakeNow : RealDate.now(); }
  }
  globalThis.Date = FakeDate;

  const { db, q } = require(path.join(ROOT, 'db/schema'));
  const jobs = require(path.join(ROOT, 'services/jobs'));
  const settings = jobs.getSettings();
  db.pragma('foreign_keys = OFF');
  // Pool MEMBERSHIP per team and hand (weights left at their defaults: they
  // move the wOBA, not who is in the pool). Prices below come from the real
  // processGameSignals with production settings.
  const pool = (team, hand, date) => {
    const r = q.getBullpenWoba(team, '', hand, null, null, date, null, null, false, null, null, 1, null);
    if (!r) return null;
    return { woba: r.woba, n: r.pitchers, members: (r.members || []).filter(m => m.in_pool).map(m => m.name + ':' + (m.woba != null ? Number(m.woba).toFixed(4) : 'null')).sort() };
  };
  const out = { root: ROOT, with_ids: WITH_IDS, dates: DATES, games: [], pools: {}, network: net };
  for (const D of DATES) {
    const teams = new Set();
    const rows = db.prepare('SELECT * FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0 ORDER BY game_id').all(D);
    for (const g of rows) { teams.add(String(g.away_team).toUpperCase()); teams.add(String(g.home_team).toUpperCase()); }
    for (const t of teams) for (const h of ['lhb', 'rhb']) out.pools[D + ' ' + t + ' ' + h] = pool(t, h, D);
    for (const G of rows) {
      if (!G.scheduled_start_utc) continue;
      fakeNow = RealDate.parse(G.scheduled_start_utc) - 3 * 3600000;
      db.prepare("UPDATE game_log SET odds_locked_at = NULL, away_score = NULL, home_score = NULL, game_status = 'Scheduled' WHERE id = ?").run(G.id);
      db.prepare('DELETE FROM bet_signals WHERE game_date = ? AND game_id = ?').run(D, G.game_id);
      let err = null;
      try { jobs.processGameSignals(db.prepare('SELECT * FROM game_log WHERE id = ?').get(G.id), jobs.getWobaIndex(), settings); } catch (e) { err = e && e.message; }
      const A = db.prepare('SELECT * FROM game_log WHERE id = ?').get(G.id);
      out.games.push({ date: D, game_id: G.game_id, error: err,
        model: [A.model_away_ml, A.model_home_ml, A.model_total], opener_model: [A.opener_model_away_ml, A.opener_model_home_ml, A.opener_model_total],
        bullpen: [A.away_bullpen_woba, A.home_bullpen_woba, A.away_bullpen_pool, A.home_bullpen_pool],
        signals: db.prepare('SELECT signal_type, signal_side, market_line, model_line, edge_pct, is_active FROM bet_signals WHERE game_date = ? AND game_id = ? ORDER BY 1, 2').all(D, G.game_id) });
    }
  }
  fakeNow = null; globalThis.Date = RealDate;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  try { db.close(); } catch (e) {}
  process.chdir(os.tmpdir());
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('replayed ' + out.games.length + ' games, ' + Object.keys(out.pools).length + ' team pools on ' + DATES.join(',')
    + (WITH_IDS ? ' [with ids]' : '') + ', network attempts ' + net.length + ' -> ' + OUT);
})().catch((e) => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });

// Every pool and every price, side by side. A difference is listed with the
// team, the pool members that changed and each moneyline's change in points.
function compare(aFile, bFile) {
  const A = JSON.parse(fs.readFileSync(aFile, 'utf8')), B = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  let poolDiff = 0, gameDiff = 0;
  for (const k of Object.keys(A.pools)) {
    const a = A.pools[k], b = B.pools[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    poolDiff++;
    const am = new Set((a && a.members) || []), bm = new Set((b && b.members) || []);
    console.log('POOL ' + k + ': woba ' + (a && a.woba) + ' -> ' + (b && b.woba) + ', n ' + (a && a.n) + ' -> ' + (b && b.n)
      + '; only main: ' + [...am].filter(x => !bm.has(x)).join(', ') + '; only branch: ' + [...bm].filter(x => !am.has(x)).join(', '));
  }
  const bBy = new Map(B.games.map(g => [g.date + ' ' + g.game_id, g]));
  for (const a of A.games) {
    const b = bBy.get(a.date + ' ' + a.game_id);
    if (!b) { gameDiff++; console.log('GAME ' + a.date + ' ' + a.game_id + ': missing on one side'); continue; }
    if (JSON.stringify([a.model, a.opener_model, a.bullpen, a.signals, a.error]) === JSON.stringify([b.model, b.opener_model, b.bullpen, b.signals, b.error])) continue;
    gameDiff++;
    const d = (x, y) => (x == null || y == null) ? x + '->' + y : (y - x >= 0 ? '+' : '') + (y - x);
    console.log('GAME ' + a.date + ' ' + a.game_id + ': away ML ' + a.model[0] + ' -> ' + b.model[0] + ' (' + d(a.model[0], b.model[0]) + ')'
      + ', home ML ' + a.model[1] + ' -> ' + b.model[1] + ' (' + d(a.model[1], b.model[1]) + ')'
      + ', total ' + a.model[2] + ' -> ' + b.model[2] + '; bullpen ' + JSON.stringify(a.bullpen) + ' -> ' + JSON.stringify(b.bullpen)
      + (JSON.stringify(a.signals) !== JSON.stringify(b.signals) ? '; SIGNALS DIFFER' : ''));
  }
  console.log('pools ' + Object.keys(A.pools).length + ' (' + poolDiff + ' differ), games ' + A.games.length + ' (' + gameDiff + ' differ), network ' + A.network.length + '/' + B.network.length);
}
