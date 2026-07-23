// Verify the COALESCE-preservation fixes in services/jobs.js's
// refreshLockedLabels and processOddsArray main UPDATE.
//
// Exercises both SQL statements against an in-memory sqlite table to
// prove:
//   1. refreshLockedLabels no longer wipes ml_source/total_source when
//      the current pass's oddsRaw has NULL sources (Bug A —
//      bal-bos-g2/min-cle case 2026-07-22).
//   2. Main UPDATE no longer wipes market_*_ml/market_total/over_price/
//      under_price when the current pass's oddsRaw has NULL market
//      values (Bug B — pit-nyy-g2 case 2026-07-22).
//   3. Fresh non-null writes STILL overwrite the previous value.
//
// Run: node tmp/verify-source-and-market-preservation.js

const path = require('path');
const Database = require('better-sqlite3');

let failed = 0;
function assert(ok, label) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label);
  if (!ok) failed++;
}

// Minimal game_log schema — only the columns the two UPDATEs touch.
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE game_log (
    game_date TEXT, game_id TEXT,
    market_away_ml INTEGER, market_home_ml INTEGER,
    market_total REAL, over_price INTEGER, under_price INTEGER,
    ml_source TEXT, xcheck_ml_source TEXT,
    total_source TEXT, xcheck_total_source TEXT,
    kalshi_implied_total REAL,
    xcheck_away_ml INTEGER, xcheck_home_ml INTEGER,
    xcheck_total REAL, xcheck_over_price INTEGER, xcheck_under_price INTEGER,
    unabated_away_ml INTEGER, unabated_home_ml INTEGER, unabated_ml_source TEXT,
    unabated_total REAL, unabated_over_price INTEGER, unabated_under_price INTEGER,
    unabated_total_source TEXT,
    market_away_spread REAL, market_home_spread REAL,
    market_away_spread_price INTEGER, market_home_spread_price INTEGER,
    market_away_spread_quality TEXT, market_home_spread_quality TEXT,
    market_spread_src TEXT,
    odds_flagged INTEGER, odds_flag_reason TEXT,
    odds_quality TEXT, odds_quality_at TEXT,
    odds_locked_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (game_date, game_id)
  );
`);

// SQL identical to the fixed statements in jobs.js.
const refreshLockedLabels = db.prepare(`UPDATE game_log SET
  ml_source=COALESCE(?, ml_source),
  xcheck_ml_source=COALESCE(?, xcheck_ml_source),
  total_source=COALESCE(?, total_source),
  xcheck_total_source=COALESCE(?, xcheck_total_source),
  odds_flagged=?, odds_flag_reason=?,
  updated_at=datetime('now')
  WHERE game_date=? AND game_id=?`);

const mainUpdate = db.prepare(`UPDATE game_log SET
  market_away_ml=COALESCE(?, market_away_ml),
  market_home_ml=COALESCE(?, market_home_ml),
  market_total=COALESCE(?, market_total),
  over_price=COALESCE(?, over_price),
  under_price=COALESCE(?, under_price),
  total_source=COALESCE(?, total_source),
  kalshi_implied_total=COALESCE(?, kalshi_implied_total),
  ml_source=COALESCE(?, ml_source),
  xcheck_ml_source=COALESCE(?, xcheck_ml_source),
  xcheck_away_ml=?, xcheck_home_ml=?,
  xcheck_total=?,
  xcheck_over_price=?,
  xcheck_under_price=?,
  xcheck_total_source=COALESCE(?, xcheck_total_source),
  unabated_away_ml=?, unabated_home_ml=?, unabated_ml_source=?,
  unabated_total=?, unabated_over_price=?, unabated_under_price=?,
  unabated_total_source=?,
  market_away_spread=?, market_home_spread=?,
  market_away_spread_price=?, market_home_spread_price=?,
  market_away_spread_quality=?, market_home_spread_quality=?,
  market_spread_src=COALESCE(?, market_spread_src),
  odds_flagged=?, odds_flag_reason=?,
  odds_quality='fresh', odds_quality_at=datetime('now'),
  updated_at=datetime('now')
  WHERE game_date=? AND game_id=?`);

function seed(row) {
  const cols = Object.keys(row).join(',');
  const qs = Object.keys(row).map(() => '?').join(',');
  db.prepare(`INSERT OR REPLACE INTO game_log (${cols}) VALUES (${qs})`).run(...Object.values(row));
}
function fetch(id) {
  return db.prepare("SELECT * FROM game_log WHERE game_date='2026-07-22' AND game_id=?").get(id);
}

// ==================================================================
// Bug A — refreshLockedLabels: preserve ml_source/total_source when
// current pass has NULL sources on a locked row.
// ==================================================================
console.log('\n== Bug A — refreshLockedLabels COALESCE for source labels ==');

// Seed a locked row like bal-bos-g2 had at some prior cron:
// market_*_ml populated, ml_source='kalshi', total populated.
seed({
  game_date: '2026-07-22', game_id: 'bal-bos-g2',
  market_away_ml: 110, market_home_ml: -131,
  market_total: 8.5, over_price: -133, under_price: 117,
  ml_source: 'kalshi', total_source: 'polymarket',
  odds_locked_at: '2026-07-22 23:00:16',
});

// Post-lock cron: Kalshi/Poly skipped due to lock, so o.ml_source and
// o.total_source are NULL. Pre-fix this wiped both to NULL. Post-fix
// they should be preserved.
refreshLockedLabels.run(
  null,  // o.ml_source
  null,  // o.xcheck_ml_source
  null,  // o.total_source
  null,  // o.xcheck_total_source
  1,     // oddsFlagged
  'no sane odds',  // oddsReason
  '2026-07-22', 'bal-bos-g2',
);
{
  const r = fetch('bal-bos-g2');
  assert(r.ml_source === 'kalshi',    'ml_source preserved as kalshi (was NULL in oddsRaw)');
  assert(r.total_source === 'polymarket', 'total_source preserved as polymarket (was NULL in oddsRaw)');
  assert(r.market_away_ml === 110,    'market_away_ml still 110 (refreshLockedLabels doesn\'t touch it)');
  assert(r.market_total === 8.5,      'market_total still 8.5');
  assert(r.odds_flagged === 1,        'odds_flagged updated to 1 (direct write, current-pass state)');
  assert(r.odds_flag_reason === 'no sane odds', 'odds_flag_reason updated (direct write)');
}

// Next cron: Kalshi has coverage again → o.ml_source='kalshi'. New
// value wins over preserved (COALESCE picks non-null new).
refreshLockedLabels.run(
  'kalshi',  // o.ml_source non-null
  null,
  null,
  null,
  0,
  null,
  '2026-07-22', 'bal-bos-g2',
);
{
  const r = fetch('bal-bos-g2');
  assert(r.ml_source === 'kalshi', 'ml_source stays kalshi (new non-null value wins)');
}

// Source LEGITIMATELY changes: polymarket takes over from kalshi.
refreshLockedLabels.run(
  'polymarket',
  null,
  null,
  null,
  0, null,
  '2026-07-22', 'bal-bos-g2',
);
{
  const r = fetch('bal-bos-g2');
  assert(r.ml_source === 'polymarket', 'ml_source updates to polymarket (new non-null wins)');
}

// ==================================================================
// Bug B — main UPDATE: preserve market_*_ml when current pass has NULL
// market values on an unlocked row (intermittent-coverage case).
// ==================================================================
console.log('\n== Bug B — main UPDATE COALESCE for betting-path market fields ==');

// Seed an unlocked row with valid market_*_ml from a prior cron
// (like pit-nyy-g2 had at 4 PM before Kalshi lost coverage).
seed({
  game_date: '2026-07-22', game_id: 'pit-nyy-g2',
  market_away_ml: 153, market_home_ml: -182,
  market_total: 9.0, over_price: -105, under_price: -115,
  ml_source: 'kalshi', total_source: 'kalshi',
  odds_locked_at: null,
});

// Simulate a coverage-lapse cron: Kalshi + Poly both no-coverage, so
// oddsRaw's market_* fields are all NULL. Pre-fix this wiped 153/-182
// to NULL. Post-fix they should be preserved.
function runMain(id, overrides) {
  const args = Object.assign({
    market_away_ml: null, market_home_ml: null,
    market_total: null, over_price: null, under_price: null,
    total_source: null,
    kalshi_implied_total: null,
    ml_source: null, xcheck_ml_source: null,
    xcheck_away_ml: null, xcheck_home_ml: null,
    xcheck_total: null, xcheck_over_price: null, xcheck_under_price: null,
    xcheck_total_source: null,
    unabated_away_ml: null, unabated_home_ml: null, unabated_ml_source: null,
    unabated_total: null, unabated_over_price: null, unabated_under_price: null,
    unabated_total_source: null,
    market_away_spread: null, market_home_spread: null,
    market_away_spread_price: null, market_home_spread_price: null,
    market_away_spread_quality: null, market_home_spread_quality: null,
    market_spread_src: null,
    oddsFlagged: 0, oddsReason: null,
  }, overrides || {});
  mainUpdate.run(
    args.market_away_ml, args.market_home_ml,
    args.market_total, args.over_price, args.under_price, args.total_source,
    args.kalshi_implied_total,
    args.ml_source,
    args.xcheck_ml_source,
    args.xcheck_away_ml, args.xcheck_home_ml,
    args.xcheck_total, args.xcheck_over_price, args.xcheck_under_price,
    args.xcheck_total_source,
    args.unabated_away_ml, args.unabated_home_ml, args.unabated_ml_source,
    args.unabated_total, args.unabated_over_price, args.unabated_under_price,
    args.unabated_total_source,
    args.market_away_spread, args.market_home_spread,
    args.market_away_spread_price, args.market_home_spread_price,
    args.market_away_spread_quality, args.market_home_spread_quality,
    args.market_spread_src,
    args.oddsFlagged, args.oddsReason,
    '2026-07-22', id,
  );
}

runMain('pit-nyy-g2', { oddsFlagged: 1, oddsReason: 'no sane odds' });
{
  const r = fetch('pit-nyy-g2');
  assert(r.market_away_ml === 153,   'market_away_ml preserved as 153 (was NULL in oddsRaw)');
  assert(r.market_home_ml === -182,  'market_home_ml preserved as -182');
  assert(r.market_total === 9.0,     'market_total preserved as 9.0');
  assert(r.over_price === -105,      'over_price preserved as -105');
  assert(r.under_price === -115,     'under_price preserved as -115');
  assert(r.ml_source === 'kalshi',   'ml_source preserved as kalshi');
  assert(r.total_source === 'kalshi','total_source preserved as kalshi');
  assert(r.odds_flagged === 1,       'odds_flagged updated (direct write)');
  assert(r.odds_flag_reason === 'no sane odds', 'odds_flag_reason updated');
}

// Next cron: Kalshi covers with a MOVED line. New non-null value wins.
runMain('pit-nyy-g2', {
  market_away_ml: 145, market_home_ml: -175,
  ml_source: 'kalshi',
});
{
  const r = fetch('pit-nyy-g2');
  assert(r.market_away_ml === 145, 'market_away_ml updates to fresh 145 (line moved)');
  assert(r.market_home_ml === -175, 'market_home_ml updates to fresh -175');
  assert(r.market_total === 9.0,   'market_total unchanged when totals not covered this pass');
}

// Poly totals-only pass (Kalshi still doesn't cover totals):
runMain('pit-nyy-g2', {
  market_total: 9.5, over_price: -110, under_price: -110,
  total_source: 'polymarket',
});
{
  const r = fetch('pit-nyy-g2');
  assert(r.market_total === 9.5,   'market_total updates to fresh 9.5');
  assert(r.total_source === 'polymarket', 'total_source updates to polymarket');
  assert(r.market_away_ml === 145, 'market_away_ml preserved (this pass NULLed ML)');
}

// ==================================================================
// Regression gate — direct writes still work.
// ==================================================================
console.log('\n== Regression gate — non-null new values still overwrite ==');

seed({
  game_date: '2026-07-22', game_id: 'nyy-bos',
  market_away_ml: 100, market_home_ml: -120,
  ml_source: 'kalshi',
});
runMain('nyy-bos', {
  market_away_ml: 105, market_home_ml: -125,
  ml_source: 'kalshi',
});
{
  const r = fetch('nyy-bos');
  assert(r.market_away_ml === 105, 'non-null new value 105 overwrites 100');
  assert(r.market_home_ml === -125, 'non-null new value -125 overwrites -120');
}

console.log();
if (failed === 0) {
  console.log('✓ all invariants hold — source and market preservation working');
  process.exit(0);
}
console.log(`✗ ${failed} assertion(s) failed`);
process.exit(1);
