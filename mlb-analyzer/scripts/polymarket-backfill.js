#!/usr/bin/env node
'use strict';
// Polymarket MLB pre-game trades backfill. LOCAL ONLY, display-only feature;
// never a model input. See services/polymarket-backfill.js for the decisions.
//
//   <node> --max-old-space-size=1536 scripts/polymarket-backfill.js [flags]
//     --from YYYY-MM-DD --to YYYY-MM-DD   discover by date range (the full run)
//     --slugs a,b,c                        discover explicit event slugs (the pilot)
//     --limit N                            fetch at most N matched markets this run
//     --db PATH        default data/polymarket.db   (gitignored; created if absent)
//     --mlb-db PATH    default data/mlb.db          (opened READ-ONLY, game_log only)
//     --skip-discover                      reuse the markets already in --db
//     --audit-game-time                    only check the game_time -> UTC rule against every
//                                          game_log row with both fields, print it, and exit
//     --recut [--apply] [--only a,b]       re-apply the CURRENT matching / cutoff rule to markets
//                                          already fetched: list every change (no network); with
//                                          --apply, make them (truncate / refetch / exclude)
//
// Resumable: each market is checkpointed (status 'done'), and each of its time
// windows too; rerunning the same command continues where a kill stopped it.
// Heavy-job rules (CLAUDE.md): run alone, heap capped, one request at a time.

const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const bf = require(path.join(R, 'services/polymarket-backfill'));

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
const has = (k) => argv.includes(k);
const DB = path.resolve(arg('--db') || path.join(R, 'data/polymarket.db'));
const MLB = path.resolve(arg('--mlb-db') || path.join(R, 'data/mlb.db'));
if (DB === MLB) { console.error('refusing: --db must not be the mlb database'); process.exit(2); }
const LIMIT = arg('--limit') ? Number(arg('--limit')) : Infinity;

let peakRss = 0;
const sampleRss = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; };

if (has('--audit-game-time')) {
  const mlb = new Database(MLB, { readonly: true, fileMustExist: true });
  const a = bf.auditGameTimeRule(mlb);
  mlb.close();
  console.log('game_time rule: ' + a.exact + '/' + a.total + ' exact (' + (100 * a.rate).toFixed(2) + '%) | mismatches '
    + JSON.stringify(a.byKind));
  for (const m of a.mismatches) console.log('  ' + [m.kind, m.game_date, m.game_id, JSON.stringify(m.game_time), m.scheduled_start_utc,
    m.diff_min == null ? 'unconvertible' : 'off ' + m.diff_min + ' min', m.removed ? 'removed' : ''].join(' | '));
  process.exit(0);
}

if (has('--recut')) {
  const db = bf.openStore(Database, DB);
  const mlb = new Database(MLB, { readonly: true, fileMustExist: true });
  const only = arg('--only') ? new Set(arg('--only').split(',').map(s => s.trim()).filter(Boolean)) : null;
  const iso = (s) => s == null ? '-' : new Date(s * 1000).toISOString().replace('.000Z', 'Z');
  const ch = bf.recutDoneMarkets(db, bf.loadGameIndex(mlb), { apply: has('--apply'), only });
  console.log((has('--apply') ? 'APPLIED ' : 'DRY RUN (nothing changed) ') + ch.length + ' change(s)');
  for (const c of ch) console.log('  ' + [c.action, c.slug, 'old ' + iso(c.old_cutoff) + ' (' + c.old_source + ')',
    c.reason ? 'reason ' + c.reason : 'new ' + iso(c.new_cutoff) + ' (' + c.new_source + ')', 'fills removed ' + c.fills_removed].join(' | '));
  process.exit(0);
}

(async () => {
  const t0 = Date.now();
  const db = bf.openStore(Database, DB);
  const mlb = new Database(MLB, { readonly: true, fileMustExist: true });
  const client = bf.makeClient({});
  const run = db.prepare('INSERT INTO runs (started_at, args) VALUES (datetime(\'now\'), ?)').run(argv.join(' '));
  const finish = (done) => db.prepare('UPDATE runs SET finished_at = datetime(\'now\'), requests = ?, retries = ?, http429 = ?, peak_rss_mb = ?, markets_done = ? WHERE id = ?')
    .run(client.stats.requests, client.stats.retries, client.stats.http429, Math.round(peakRss / 1e5) / 10, done, run.lastInsertRowid);

  if (!has('--skip-discover')) {
    let n = 0;
    if (arg('--slugs')) n = await bf.discoverSlugs(db, client, arg('--slugs').split(',').map(s => s.trim()).filter(Boolean));
    else if (arg('--from') && arg('--to')) n = await bf.discoverRange(db, client, arg('--from'), arg('--to'));
    else { console.error('need --slugs or --from/--to (or --skip-discover)'); process.exit(2); }
    console.log('discovered ' + n + ' moneyline markets');
  }
  const gi = bf.loadGameIndex(mlb);
  bf.matchAll(db, gi);
  const manual = bf.applyManualExclusions(db);
  if (manual.length) console.log('manual exclusions applied (fetched data removed): ' + manual.join(', '));
  const byStatus = db.prepare('SELECT status, exclusion_reason r, COUNT(*) n FROM markets GROUP BY 1, 2').all();
  console.log('markets by status: ' + byStatus.map(x => x.status + (x.r ? '(' + x.r + ')' : '') + '=' + x.n).join(' '));

  let done = 0;
  const queue = db.prepare("SELECT * FROM markets WHERE status IN ('matched', 'fetched') ORDER BY cutoff_utc").all();
  for (const m of queue) {
    if (done >= LIMIT) break;
    if (m.status === 'matched') await bf.fetchMarket(db, client, m, { onPage: sampleRss });
    const agg = bf.aggregateMarket(db, m.id);
    sampleRss();
    done++;
    const row = db.prepare('SELECT fills_stored, window_count, split_needed, duplicates_dropped FROM markets WHERE id = ?').get(m.id);
    console.log('[done ' + done + '] ' + m.slug + ' -> ' + m.game_id + ' | fills ' + row.fills_stored
      + ' | windows ' + row.window_count + (row.split_needed ? ' (SPLIT)' : '') + ' | dups dropped ' + row.duplicates_dropped
      + ' | net-short positions ' + agg.nsPositions + ' | wallet-games ' + agg.wallets
      + ' | requests ' + client.stats.requests + ' | rss ' + Math.round(process.memoryUsage().rss / 1e6) + ' MB');
    finish(done);
  }
  finish(done);
  console.log('run: ' + done + ' markets, ' + client.stats.requests + ' requests, ' + client.stats.retries + ' retries ('
    + client.stats.http429 + ' x 429), peak RSS ' + Math.round(peakRss / 1e6) + ' MB, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
