#!/usr/bin/env node
/**
 * The spread cell follows the live market until lock. (2026-09-11)
 *
 * WHAT WENT WRONG. #371 froze market_total_at_emit at the moment the
 * cell was FIRST COMPUTED -- the ~04:01 build. Measured over the 30 days
 * to 2026-09-10, a game's cell changes between that build and first
 * pitch on 104 of 367 games (28.3%): 15.3% the market total crossing a
 * band edge, 10.6% the model win-prob tier moving as lineups confirm,
 * 2.5% both. Every one of those was a card showing a cell the market had
 * already left, with runline plays priced off it.
 *
 * THE RULE THIS DEFENDS. Before lock: market_total_at_emit IS NULL, the
 * cell re-derives from the current market total on every odds pass.
 * At lock: stamped in the SAME UPDATE as odds_locked_at, and never moves
 * again. That is the ML box's live-vs-frozen split from #357.
 *
 * Run: node scripts/test-spread-cell-live-axis.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const E = require(path.join(R, 'services/empirical-spread-edge'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== spread cell: live until lock ===');

const eng = fs.readFileSync(path.join(R, 'services/empirical-spread-edge.js'), 'utf8');
const jobs = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
const schema = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');

// ---- 1. the engine no longer writes ---------------------------------
ok('the engine does NOT stamp the axis any more',
   eng.indexOf('UPDATE game_log SET market_total_at_emit') === -1,
   'that write moved to the lock sites');
ok('the engine is declared read-only again',
   eng.indexOf('this module is read-only again') !== -1);
ok('generateEmpiricalSpreadSignals reports live vs frozen counts',
   eng.indexOf('on a LIVE axis (unlocked, cell follows the market)') !== -1);

// ---- 2. the freeze is ATOMIC with the lock --------------------------
// Two statements could interleave with an odds pass and leave a row
// locked-but-unstamped. Both lock sites must do it in one UPDATE.
const lockStmts = jobs.match(/UPDATE game_log SET odds_locked_at=datetime\('now'\)[^"]*/g) || [];
ok('both lock sites exist', lockStmts.length === 2, lockStmts.length + ' found');
ok('EVERY lock site stamps the axis in the SAME statement',
   lockStmts.length > 0 && lockStmts.every(s => /market_total_at_emit=market_total/.test(s)),
   lockStmts.filter(s => /market_total_at_emit=market_total/.test(s)).length
     + ' of ' + lockStmts.length + ' — a separate UPDATE could interleave');
ok('every lock site is still guarded by odds_locked_at IS NULL',
   lockStmts.length > 0 && lockStmts.every(s => /odds_locked_at IS NULL/.test(s)),
   'post-lock immutability: the stamp must never be rewritten');

// ---- 3. pre-lock stamps are cleared ---------------------------------
ok('boot clears any pre-lock stamp',
   schema.indexOf('WHERE market_total_at_emit IS NOT NULL AND odds_locked_at IS NULL') !== -1);
ok('and says so rather than repairing silently',
   schema.indexOf('cleared market_total_at_emit on') !== -1);

const bad = db.prepare(
  "SELECT COUNT(*) n FROM game_log "
  + "WHERE market_total_at_emit IS NOT NULL AND odds_locked_at IS NULL").get().n;
ok('NO row is stamped while still unlocked', bad === 0,
   bad + ' row(s) — an unlocked game must have a live axis');

// ---- 4. the axis resolution itself ----------------------------------
// computeGameEdges must prefer the stamp when it exists and fall through
// to the live total when it does not. Exercised through the real
// function, not by re-reading the source.
const idx = E.buildCellIndex(db);
const spreads = [
  { spread_team: 'HOME', spread_line: 1.5, yes_ask_dollars: 0.5, yes_ask_ml: -100,
    no_ask_dollars: 0.5, no_ask_ml: -100 },
];
const base = { game_date: '2026-09-11', game_id: 'aaa-bbb',
  model_home_ml: -130, model_away_ml: 110, model_total: 8.5 };

const liveLow  = E.computeGameEdges(
  Object.assign({}, base, { market_total: 7.5, market_total_at_emit: null }), spreads, idx);
const liveHigh = E.computeGameEdges(
  Object.assign({}, base, { market_total: 9.5, market_total_at_emit: null }), spreads, idx);
ok('UNLOCKED: the cell follows the live market total',
   liveLow && liveHigh && liveLow.cell_label !== liveHigh.cell_label,
   '7.5 -> "' + (liveLow && liveLow.cell_label) + '", 9.5 -> "' + (liveHigh && liveHigh.cell_label) + '"');
ok('UNLOCKED: the axis reports itself as not frozen',
   liveLow && liveLow.axis_total_frozen === false && liveLow.axis_total === 7.5);

const locked = E.computeGameEdges(
  Object.assign({}, base, { market_total: 9.5, market_total_at_emit: 7.5 }), spreads, idx);
ok('LOCKED: a moved market does NOT move the cell',
   locked && locked.cell_label === liveLow.cell_label,
   'market says 9.5, stamp says 7.5, cell stays "' + (locked && locked.cell_label) + '"');
ok('LOCKED: the axis reports itself frozen, at the stamped value',
   locked && locked.axis_total_frozen === true && locked.axis_total === 7.5
   && locked.axis_total_source === 'stamped_at_lock');

// The third state, and the one that is easy to get wrong: every game
// locked BEFORE this change is locked-but-unstamped. Its market_total
// stopped updating at the lock (runOddsJob's locked branch refreshes
// source labels only, prices frozen), so its cell cannot move -- but it
// has no stamp. Reporting those as "live" would put a moving-cell badge
// on a game that finished last week.
const lockedUnstamped = E.computeGameEdges(
  Object.assign({}, base, { market_total: 7.5, market_total_at_emit: null,
                            odds_locked_at: '2026-09-01 02:11:00' }), spreads, idx);
ok('LOCKED BUT UNSTAMPED is frozen, not live',
   lockedUnstamped && lockedUnstamped.axis_total_frozen === true
   && lockedUnstamped.axis_total_source === 'locked_unstamped',
   'every game locked before 2026-09-11 is in this state');
ok('and an UNLOCKED game is the only one reported live',
   liveLow.axis_total_source === 'live' && liveLow.axis_total_frozen === false);
ok('the card does not render a locked-unstamped game as live',
   fs.readFileSync(path.join(R, 'public/index.html'), 'utf8')
     .indexOf("else if (es.axis_frozen) { _axis = ' · tot locked'; }") !== -1);

// ---- 5. partition version -------------------------------------------
ok('a partition version is compiled in',
   typeof E.PARTITION_VERSION === 'string' && E.PARTITION_VERSION.length > 0,
   E.PARTITION_VERSION);
ok('the version changed for this partition change',
   E.PARTITION_VERSION.indexOf('v3') === 0,
   'v2 rows froze at first computation; v3 rows are live until lock');

const before = db.prepare("SELECT value FROM app_settings WHERE key = ?")
  .get(E.PARTITION_VERSION_KEY);
const first = E.checkPartitionVersion(db, { today: '2026-09-11' });
const second = E.checkPartitionVersion(db, { today: '2026-09-11' });
ok('checkPartitionVersion records the version it saw',
   second.changed === false && second.from === E.PARTITION_VERSION,
   'first call changed=' + first.changed + ', second changed=' + second.changed);

// SELFTEST: prove it can actually detect a change, rather than only ever
// reporting "unchanged" because it wrote the value a moment ago.
db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) "
  + "ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(E.PARTITION_VERSION_KEY, 'v0-selftest-sentinel');
const detected = E.checkPartitionVersion(db, { today: '2026-09-11' });
ok('SELFTEST: a changed partition IS detected',
   detected.changed === true && detected.from === 'v0-selftest-sentinel',
   'from "' + detected.from + '" -> "' + detected.to + '"');
// Restore whatever was there before this test ran.
if (before) {
  db.prepare("UPDATE app_settings SET value = ? WHERE key = ?")
    .run(before.value, E.PARTITION_VERSION_KEY);
} else {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(E.PARTITION_VERSION_KEY);
}

// ---- 6. provenance reaches the card ---------------------------------
const cols = db.prepare('PRAGMA table_info(empirical_spread_signals)').all().map(c => c.name);
ok('signal rows carry axis_total / axis_frozen / partition_version',
   ['axis_total', 'axis_frozen', 'partition_version'].every(c => cols.indexOf(c) !== -1));
const upsertArity = (schema.match(/upsertEmpiricalSpreadSignal[\s\S]{0,400}?VALUES \(([^)]*)\)/) || [])[1];
ok('the upsert binds all 16 columns',
   upsertArity && upsertArity.split(',').length === 16,
   upsertArity ? upsertArity.split(',').length + ' placeholders' : 'not found');

const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
ok('the API sends the axis and its live/frozen state',
   api.indexOf('axis_total: r.axis_total') !== -1
   && api.indexOf('axis_frozen: r.axis_frozen === 1') !== -1);
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
ok('the card shows which total placed the cell, and whether it is live',
   html.indexOf("es.axis_frozen ? ' locked' : ' live'") !== -1
   && html.indexOf('+_axis+') !== -1);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
