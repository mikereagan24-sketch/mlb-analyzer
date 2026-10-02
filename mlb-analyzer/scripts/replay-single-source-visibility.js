#!/usr/bin/env node
'use strict';
/**
 * Replay the odds pass + signal generation for sample dates, for the #484
 * no-behaviour-change proof. Run it once against a main checkout and once
 * against the branch, on fresh scratch copies of the same database, and
 * compare the two outputs (--compare).
 *
 *   node scripts/replay-single-source-visibility.js --root <repo dir> --db <source db> --dates 2026-09-08,2026-09-29 --out a.json
 *   node scripts/replay-single-source-visibility.js --compare main.json branch.json
 *
 * --root is the mlb-analyzer directory whose code runs (it may be a different
 * checkout from this script's). The source database is only READ (a backup is
 * taken into a temp directory, deleted afterwards); MLB_DB_PATH points at the
 * copy before any module loads db/schema.
 *
 * Per game: reset to a pre-lock state (no lock, no score, its bet_signals
 * cleared), pin the clock just after its stored venue snapshot (or 3h before
 * first pitch when there is none), and run the real processOddsArray with one
 * odds row built from what game_log stored, plus the Polymarket quote from the
 * snapshot. A row stored as Polymarket cross-checked against Polymarket is
 * replayed the way it was written: a pass with no primary price of its own.
 * No network: node-fetch and global fetch fail.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

if (args[0] === '--compare') { compare(args[1], args[2]); process.exit(process.exitCode || 0); }

const ROOT = path.resolve(arg('--root') || path.join(__dirname, '..'));
const SRC_DB = path.resolve(arg('--db') || path.join(ROOT, 'data/mlb.db'));
const DATES = String(arg('--dates') || '').split(',').filter(Boolean);
const OUT = arg('--out') ? path.resolve(arg('--out')) : null;   // resolved before the chdir below
if (!DATES.length || !OUT) { console.error('usage: --root <dir> --db <file> --dates d1,d2 --out <file>'); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), '__replay484_'));
const TMP_DB = path.join(TMP, 'mlb.db');

(async () => {
  const Sqlite = require(path.join(ROOT, 'node_modules/better-sqlite3'));
  const src = new Sqlite(SRC_DB, { readonly: true, fileMustExist: true });
  await src.backup(TMP_DB); src.close();
  process.env.MLB_DB_PATH = TMP_DB;                            // before anything loads db/schema
  process.chdir(TMP);                                          // score/odds snapshots land in the temp dir

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

  const { db } = require(path.join(ROOT, 'db/schema'));
  const jobs = require(path.join(ROOT, 'services/jobs'));
  const settings = jobs.getSettings();
  db.pragma('foreign_keys = OFF');
  const glCols = new Set(db.prepare('PRAGMA table_info(game_log)').all().map(c => c.name));
  const SIG_COLS = ['signal_type', 'signal_side', 'market_line', 'model_line', 'edge_pct', 'category', 'signal_label', 'is_active',
    'price_venue', 'venue_stale', 'edge_suspect', 'outcome', 'pnl', 'notes'];
  const NEW_SIG = ['ml_price_source', 'ml_xcheck_status', 'ml_xcheck_source', 'ml_depth_usd', 'ml_depth_reason'];
  const sigHas = new Set(db.prepare('PRAGMA table_info(bet_signals)').all().map(c => c.name));

  const out = { root: ROOT, dates: DATES, venue_aware: !!settings.SIGNAL_VENUE_AWARE_ENABLED, games: [], skipped: [], network: net };
  for (const D of DATES) {
    const rows = db.prepare('SELECT * FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0 ORDER BY game_id').all(D);
    for (const G of rows) {
      if (!G.scheduled_start_utc) { out.skipped.push(D + ' ' + G.game_id + ': no scheduled start'); continue; }
      const snap = db.prepare('SELECT snapshot_at, snapshot_json FROM venue_comparison_snapshot WHERE game_date = ? AND game_id = ?').get(D, G.game_id);
      const startMs = RealDate.parse(G.scheduled_start_utc);
      const snapMs = snap ? RealDate.parse(snap.snapshot_at) : null;
      fakeNow = (snapMs != null && snapMs + 60000 < startMs - 15 * 60000) ? snapMs + 60000 : startMs - 3 * 3600000;
      let cmp = null; try { cmp = snap ? JSON.parse(snap.snapshot_json) : null; } catch (e) { cmp = null; }
      const pA = cmp && cmp.poly && cmp.poly.away && cmp.poly.away.net_american;
      const pH = cmp && cmp.poly && cmp.poly.home && cmp.poly.home.net_american;
      const selfX = G.ml_source != null && G.ml_source === G.xcheck_ml_source;
      db.prepare("UPDATE game_log SET odds_locked_at = NULL, away_score = NULL, home_score = NULL, game_status = 'Scheduled' WHERE id = ?").run(G.id);
      db.prepare('DELETE FROM bet_signals WHERE game_date = ? AND game_id = ?').run(D, G.game_id);
      const o = { game_id: G.game_id, market_total: G.market_total, over_price: G.over_price, under_price: G.under_price, total_source: G.total_source,
        ml_source: selfX ? null : G.ml_source,
        market_away_ml: selfX ? null : G.market_away_ml, market_home_ml: selfX ? null : G.market_home_ml,
        poly_away_ml: pA != null && pH != null ? pA : null, poly_home_ml: pA != null && pH != null ? pH : null };
      let err = null;
      try { jobs.processOddsArray(D, [o], settings); } catch (e) { err = e && e.message; }
      const A = db.prepare('SELECT * FROM game_log WHERE id = ?').get(G.id);
      const sigs = db.prepare('SELECT * FROM bet_signals WHERE game_date = ? AND game_id = ? ORDER BY signal_type, signal_side').all(D, G.game_id);
      out.games.push({
        date: D, game_id: G.game_id, variant: selfX ? 'no-primary pass (stored polymarket vs polymarket)' : 'stored primary',
        clock: new RealDate(fakeNow).toISOString(), stored_ml_source: G.ml_source, stored_xcheck_ml_source: G.xcheck_ml_source, error: err,
        market: [A.market_away_ml, A.market_home_ml, A.market_total], model: [A.model_away_ml, A.model_home_ml, A.model_total],
        odds_flagged: A.odds_flagged, odds_flag_reason: A.odds_flag_reason,
        ml_xcheck_status: glCols.has('ml_xcheck_status') ? A.ml_xcheck_status : undefined,
        signals: sigs.map(s => Object.fromEntries(SIG_COLS.concat(NEW_SIG.filter(c => sigHas.has(c))).map(c => [c, s[c]]))),
      });
    }
  }
  fakeNow = null; globalThis.Date = RealDate;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  try { db.close(); } catch (e) {}
  process.chdir(os.tmpdir());
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('replayed ' + out.games.length + ' games on ' + DATES.join(',') + ' (' + out.skipped.length + ' skipped, '
    + out.games.reduce((s, g) => s + g.signals.length, 0) + ' signal rows, network attempts ' + net.length + ') -> ' + OUT);
})().catch((e) => { console.error(e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });

// ---------------------------------------------------------------- compare
// Identical: every signal (type, side, price, model line, edge, category,
// label, active, venue, stale, suspect, outcome, pnl, notes), every market and
// model value, every error. May differ: the new columns, and the flag text --
// but only by the single-source fragment.
function compare(aFile, bFile) {
  const A = JSON.parse(fs.readFileSync(aFile, 'utf8')), B = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  const key = (g) => g.date + ' ' + g.game_id;
  const bBy = new Map(B.games.map(g => [key(g), g]));
  const NEW = new Set(['ml_price_source', 'ml_xcheck_status', 'ml_xcheck_source', 'ml_depth_usd', 'ml_depth_reason']);
  const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !NEW.has(k)));
  const frags = (r) => String(r || '').split(' | ').filter(Boolean);
  const bad = [], flagChanges = [];
  let sigN = 0;
  for (const a of A.games) {
    const b = bBy.get(key(a));
    if (!b) { bad.push(key(a) + ': missing on one side'); continue; }
    sigN += a.signals.length;
    if (JSON.stringify(a.signals.map(strip)) !== JSON.stringify(b.signals.map(strip))) bad.push(key(a) + ': signals differ');
    if (JSON.stringify([a.market, a.model, a.error]) !== JSON.stringify([b.market, b.model, b.error])) bad.push(key(a) + ': market/model/error differ');
    const fa = frags(a.odds_flag_reason), fb = frags(b.odds_flag_reason);
    const lost = fa.filter(f => !fb.includes(f)), added = fb.filter(f => !fa.includes(f));
    if (lost.length || added.some(f => f !== 'single-source, no cross-check available')) bad.push(key(a) + ': flag changed beyond the single-source text');
    if (added.length) flagChanges.push(key(a) + ' [' + a.variant + ']: + "' + added.join('", "') + '"');
  }
  if (A.games.length !== B.games.length) bad.push('game count ' + A.games.length + ' vs ' + B.games.length);
  console.log('games ' + A.games.length + ', signal rows ' + sigN + ', network attempts ' + A.network.length + '/' + B.network.length);
  console.log('decision differences: ' + bad.length + (bad.length ? '\n  ' + bad.join('\n  ') : ''));
  console.log('flag changes (single-source text added): ' + flagChanges.length + (flagChanges.length ? '\n  ' + flagChanges.join('\n  ') : ''));
  const withNew = B.games.flatMap(g => g.signals.filter(s => s.signal_type === 'ML'));
  const tally = {};
  for (const s of withNew) { const k = (s.ml_price_source || 'null') + ' / ' + (s.ml_xcheck_status || 'null') + ' / depth ' + (s.ml_depth_usd != null ? 'recorded' : 'null: ' + s.ml_depth_reason); tally[k] = (tally[k] || 0) + 1; }
  console.log('branch ML signals by source / cross-check / depth:'); for (const [k, v] of Object.entries(tally)) console.log('  ' + v + '  ' + k);
  if (bad.length || A.network.length || B.network.length) process.exitCode = 1;
}
