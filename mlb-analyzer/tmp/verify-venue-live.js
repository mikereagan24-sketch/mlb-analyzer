// Cross-check live venue-aware code path for 2026-07-08:
//   - Query bet_signals.market_line + price_venue for target games.
//   - Run services/odds-comparison.js runComparison for the same date.
//   - Print a four-column table: stored market_line | Kalshi net | Poly net | Poly top_ask (gross)
// This confirms whether market_line matches the venue winner's net_american
// (indicating venue-aware ON) or matches Kalshi's ML (indicating OFF).
// It also surfaces the "gross vs net-at-size" gap that shows on the display
// so the owner-visible +183 vs +173 puzzle is directly reconciled.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const { runComparison } = require('../services/odds-comparison');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });

const TARGETS = ['ath-det', 'col-lad', 'cle-min'];
const DATE = '2026-07-08';

function fmtML(v) { return v == null ? '  —' : (v >= 0 ? '+' : '') + v; }

(async () => {
  console.log('=== setting ===');
  const setting = db.prepare("SELECT value FROM app_settings WHERE key='signal_venue_aware_enabled'").get();
  console.log('signal_venue_aware_enabled :', setting?.value);
  console.log('(when "false", price_venue on new signals stays NULL and market_line stays Kalshi-direct)');
  console.log();

  console.log('=== fetching live venue comparison for ' + DATE + '... ===');
  const cmp = await runComparison(DATE, {});
  const byGid = {};
  for (const r of (cmp.rows || [])) if (r.game_id) byGid[r.game_id] = r;
  console.log('priced ' + Object.keys(byGid).length + ' games\n');

  for (const gid of TARGETS) {
    console.log('┌─────────────────────────────────────────────────────────────────────┐');
    console.log('│ ' + gid.toUpperCase().padEnd(70) + '│');
    console.log('└─────────────────────────────────────────────────────────────────────┘');

    // Kalshi-direct baseline captured in game_log at last odds fetch
    const gl = db.prepare("SELECT market_away_ml, market_home_ml FROM game_log WHERE game_date=? AND game_id=?").get(DATE, gid);
    if (!gl) { console.log('  (no game_log row)\n'); continue; }

    // Stored signals for this game
    const sigs = db.prepare("SELECT signal_side, signal_type, market_line, model_line, price_venue, venue_stale, cohort, edge_pct FROM bet_signals WHERE game_date=? AND game_id=? AND is_active=1").all(DATE, gid);

    // Live comparison rows
    const cmpRow = byGid[gid];
    if (!cmpRow) { console.log('  (no venue comparison row)\n'); continue; }

    for (const side of ['away', 'home']) {
      const P = cmpRow.poly && cmpRow.poly[side];
      const K = cmpRow.kalshi && cmpRow.kalshi[side];
      const glML = side === 'away' ? gl.market_away_ml : gl.market_home_ml;
      const sig = sigs.find(s => s.signal_type === 'ML' && s.signal_side === side);

      console.log('  ' + side + ':');
      console.log('    game_log.market_' + side + '_ml  (Kalshi-direct capture, stale) : ' + fmtML(glML));
      console.log('    LIVE Kalshi   net_american (at-size, fee-adjusted)    : ' + fmtML(K?.net_american) + '   top_ask (gross): ' + fmtML(K?.top_ask_ml) + '   partial: ' + (K?.partial ?? '—'));
      console.log('    LIVE Poly     net_american (at-size, fee-adjusted)    : ' + fmtML(P?.net_american) + '   top_ask (gross): ' + fmtML(P?.top_ask_ml) + '   partial: ' + (P?.partial ?? '—'));
      console.log('    winner (higher net_american wins)                     : ' + (cmpRow.winner?.[side] ?? '—'));
      if (sig) {
        console.log('    bet_signals.market_line (STORED at emit time)         : ' + fmtML(sig.market_line));
        console.log('    bet_signals.price_venue                               : ' + (sig.price_venue ?? 'NULL'));
        console.log('    bet_signals.venue_stale                               : ' + sig.venue_stale);
        console.log('    bet_signals.cohort                                    : ' + sig.cohort);
        console.log('    bet_signals.edge_pct                                  : ' + (sig.edge_pct * 100).toFixed(2) + 'pp');

        // Verification lines
        const winnerNet = cmpRow.winner?.[side] === 'poly' ? P?.net_american
                       : cmpRow.winner?.[side] === 'kalshi' ? K?.net_american
                       : null;
        const match = winnerNet != null && sig.market_line === winnerNet;
        console.log('    ⇒ market_line == venue winner net_american ?         : ' + (match ? 'YES (venue-aware live)' : 'NO — stored=' + sig.market_line + ' vs winner-net=' + winnerNet));
        console.log('    ⇒ market_line == game_log Kalshi-direct ?            : ' + (sig.market_line === glML ? 'YES (Kalshi-direct baseline — venue-aware OFF)' : 'NO'));
      } else {
        console.log('    (no ML signal on this side)');
      }
      console.log();
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
