// Verify the pregame-freeze logic in the /admin/odds-comparison route
// without hitting the live network. Simulates the route's split logic:
//   - Look up game_log.odds_locked_at for a date.
//   - Show which games would fall into the "locked → serve snapshot"
//     branch and which would fall through to runComparison.
// If venue_comparison_snapshot is populated, also print what would be
// served for locked games instead of the live +496 leak.

const path = require('path');
const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'mlb.db'), { readonly: true });

const DATE = process.argv[2] || '2026-07-08';
console.log('=== pregame-freeze plan for ' + DATE + ' ===\n');

const games = db.prepare(
  "SELECT game_id, game_time, odds_locked_at, market_away_ml, market_home_ml "
+ "FROM game_log WHERE game_date=? ORDER BY game_time"
).all(DATE);

const locked = games.filter(g => g.odds_locked_at);
const unlocked = games.filter(g => !g.odds_locked_at);

console.log('LOCKED (' + locked.length + ' games — route would SERVE SNAPSHOT):');
for (const g of locked) console.log('  ' + g.game_id.padEnd(10) + ' locked_at=' + g.odds_locked_at + '   kalshi-frozen mkt: ' + g.market_away_ml + ' / ' + g.market_home_ml);
console.log();
console.log('UNLOCKED (' + unlocked.length + ' games — route would FETCH LIVE + PERSIST SNAPSHOT):');
for (const g of unlocked) console.log('  ' + g.game_id.padEnd(10) + ' game_time=' + (g.game_time || '—') + '   mkt: ' + g.market_away_ml + ' / ' + g.market_home_ml);
console.log();

try {
  const snaps = db.prepare(
    "SELECT game_id, snapshot_at, length(snapshot_json) as bytes "
  + "FROM venue_comparison_snapshot WHERE game_date=?"
  ).all(DATE);
  console.log('EXISTING SNAPSHOTS in venue_comparison_snapshot (' + snaps.length + '):');
  for (const s of snaps) console.log('  ' + s.game_id.padEnd(10) + ' at=' + s.snapshot_at + '  json_bytes=' + s.bytes);
} catch (e) {
  console.log('(table does not exist yet in this DB — will be created by schema.js on next boot)');
}
