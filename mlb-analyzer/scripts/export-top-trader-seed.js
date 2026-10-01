#!/usr/bin/env node
'use strict';
// Export the production seed for the Polymarket top-traders card
// (docs/polymarket-top-traders-card-decisions-2026-10-01.md, decision 4).
// LOCAL ONLY: reads data/polymarket.db READ-ONLY and writes one CSV, which is
// uploaded to POST /upload/top-trader-seed. The CSV holds wallet addresses: it
// stays local (data/ is gitignored) and is never served by any route.
//
//   <node> --max-old-space-size=1536 scripts/export-top-trader-seed.js [--pm-db PATH] [--out PATH]
//
// Contents, both as of AS_OF = the first postseason date (2026-09-28):
//   wallet rows     every wallet's §3 totals over all done regular-season games
//                   dated strictly before AS_OF, with the pre-registration's
//                   exclusions (§2: 2026-04-04 / 04-05 never count)
//   qualified rows  the wallets that pass §3 on that history
// Built with the backtest's own history inputs (loadHistoryInputs) and the
// shared rules (utils/top-traders/rules.js) -- nothing re-implemented.
//
// CSV (one header line, then one record per line; no field contains a comma):
//   type,wallet_id,addr,games,profit,volume,both_teams,as_of
//   wallet,<id>,<0x address>,<int>,<float>,<float>,<int>,<YYYY-MM-DD>
//   qualified,<id>,,,,,,<YYYY-MM-DD>

const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const bt = require(path.join(R, 'services/polymarket-top-traders-backtest'));
const RULES = require(path.join(R, 'utils/top-traders/rules'));

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? null : argv[i + 1]; };
const PM = path.resolve(arg('--pm-db') || path.join(R, 'data/polymarket.db'));
const AS_OF = '2026-09-28';                       // first postseason date: history = the whole regular season
const OUT = path.resolve(arg('--out') || path.join(R, 'data', 'top-trader-seed-' + AS_OF + '.csv'));
const { SEED_HEADER: HEADER } = require(path.join(R, 'db/top-traders-ddl'));

function buildSeed(pm) {
  const { markets, wgByMarket, boughtBoth } = bt.loadHistoryInputs(pm);
  const cum = new Map();
  let qualifiedOn0927 = null;                     // check: the backtest's figure as of D = 2026-09-27
  let i = 0;
  while (i < markets.length) {
    const date = markets[i].game_date;
    const day = [];
    while (i < markets.length && markets[i].game_date === date) day.push(markets[i++]);
    if (date === RULES.SEASON_TO) qualifiedOn0927 = RULES.qualified(cum).length;   // history strictly before 09-27
    if (RULES.EXCLUDED_DATES.has(date) || date > RULES.SEASON_TO) continue;
    for (const m of day) {
      for (const [w, profit, volume] of (wgByMarket.get(m.id) || [])) {
        let s = cum.get(w);
        if (!s) cum.set(w, (s = RULES.newWalletTotals()));
        RULES.addWalletGame(s, profit, volume, boughtBoth.has(m.id + '|' + w));
      }
    }
  }
  const qualified = RULES.qualified(cum);
  return { cum, qualified, qualifiedOn0927 };
}

if (require.main === module) {
  const t0 = Date.now();
  const pm = new Database(PM, { readonly: true, fileMustExist: true });
  const { cum, qualified, qualifiedOn0927 } = buildSeed(pm);
  const addrOf = pm.prepare('SELECT addr FROM wallets WHERE id = ?');
  const out = fs.openSync(OUT, 'w');
  fs.writeSync(out, HEADER + '\n');
  let wallets = 0, buf = [];
  const flush = () => { if (buf.length) { fs.writeSync(out, buf.join('')); buf = []; } };
  for (const [w, s] of [...cum.entries()].sort((a, b) => a[0] - b[0])) {
    const addr = addrOf.get(w).addr;
    if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('unexpected address for wallet ' + w);
    buf.push(['wallet', w, addr, s.games, s.profit, s.volume, s.both, AS_OF].join(',') + '\n');
    wallets++;
    if (buf.length >= 5000) flush();
  }
  for (const q of [...qualified].sort((a, b) => a.w - b.w)) buf.push(['qualified', q.w, '', '', '', '', '', AS_OF].join(',') + '\n');
  flush();
  fs.closeSync(out);
  pm.close();
  const size = fs.statSync(OUT).size;
  console.log('seed as of ' + AS_OF + ': ' + wallets + ' wallet rows, ' + qualified.length + ' qualified rows -> ' + OUT
    + ' (' + (size / 1e6).toFixed(2) + ' MB, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  console.log('check: qualified as of 2026-09-27 (history strictly before it) = ' + qualifiedOn0927
    + ' -- the backtest reported 1050 for that date (results artifact, feasibility.qualified_by_month)');
}

module.exports = { buildSeed, HEADER, AS_OF };
