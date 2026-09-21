// odds-poly-by-first-pitch: the PER-GAME totals split that replaces the
// dead slate-level cut.
//
// WHY IT EXISTS. odds-anchor-split classifies a slate "day" when ANY game
// starts before the cutoff, and over 70 passes (2026-09-18..09-22) that
// made 70 of 70 rows "day" -- one 1PM game speaking for fourteen 7PM
// ones. No evening bucket, no comparison. See
// docs/totals-anchor-fallbacks-closed-2026-09-21.md. This cuts per game,
// which is the granularity the original 44%/9.7% finding used.
//
// WHAT THIS PINS:
//   1. before / after / unknown bucket on the PT hour, with `hour`
//      moving the boundary;
//   2. the PDT conversion -- an 18:00 UTC start is 11:00 PT and must
//      land in "after" at the default hour, not "before";
//   3. scheduled_start_utc is preferred, first_pitch_utc is the
//      fallback, and a game with neither is "unknown" rather than
//      silently bucketed;
//   4. is_removed games are excluded;
//   5. with_kalshi_anchor separates "Kalshi never listed" from "Kalshi
//      listed later", which is the distinction the fallback mechanism
//      turns on;
//   6. from/to bound the window.
//
// The two caveats in the description are structural and cannot be
// tested away -- total_source is end-state, and no per-game record of
// which pass priced a game exists. Section 6 asserts the UNDERCOUNT
// direction, which is the part that matters when reading the output.
//
// Runs the REAL registry SQL against an in-memory DB. No network.
//
// Run: node --max-old-space-size=1536 scripts/test-odds-poly-by-first-pitch-query.js

const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { getQuery } = require(path.join(R, 'services/admin-queries'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const Q = getQuery('odds-poly-by-first-pitch');

function seed() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE game_log (game_date TEXT, game_id TEXT, total_source TEXT, '
    + 'kalshi_anchor_total REAL, scheduled_start_utc TEXT, first_pitch_utc TEXT, '
    + 'is_removed INTEGER, PRIMARY KEY (game_date, game_id));');
  const G = db.prepare('INSERT INTO game_log (game_date, game_id, total_source, '
    + 'kalshi_anchor_total, scheduled_start_utc, first_pitch_utc, is_removed) '
    + 'VALUES (?,?,?,?,?,?,?)');

  // --- 2026-09-20: the real early slate. 17:05 UTC = 10:05 PT -> before.
  G.run('2026-09-20', 'kc-pit',   'polymarket', 8.5,  '2026-09-20 17:05:00', null, 0);
  G.run('2026-09-20', 'ath-cle',  'polymarket', 9.0,  '2026-09-20 17:10:00', null, 0);
  G.run('2026-09-20', 'bos-tb',   'polymarket', null, '2026-09-20 17:10:00', null, 0);
  G.run('2026-09-20', 'chc-cin',  'polymarket', 8.0,  '2026-09-20 17:20:00', null, 0);
  G.run('2026-09-20', 'early-k',  'kalshi',     7.5,  '2026-09-20 17:35:00', null, 0);
  // 18:00 UTC = 11:00 PT exactly: NOT before 11, so "after".
  G.run('2026-09-20', 'edge-11',  'kalshi',     8.5,  '2026-09-20 18:00:00', null, 0);
  // evening
  G.run('2026-09-20', 'late-1',   'kalshi',     9.5,  '2026-09-21 02:10:00', null, 0);
  G.run('2026-09-20', 'late-2',   'polymarket', 8.5,  '2026-09-21 02:05:00', null, 0);
  // removed: must not count at all
  G.run('2026-09-20', 'gone',     'polymarket', null, '2026-09-20 17:00:00', null, 1);
  // no scheduled_start_utc, but first_pitch_utc present -> fallback works
  G.run('2026-09-20', 'fp-only',  'kalshi',     8.5,  null, '2026-09-20 17:15:00', 0);
  // neither -> unknown
  G.run('2026-09-20', 'no-time',  'kalshi',     8.5,  null, null, 0);

  // --- outside the window, must be excluded by from/to
  G.run('2026-09-25', 'outside',  'polymarket', null, '2026-09-25 17:00:00', null, 0);
  return db;
}

function run(db, params) {
  const vals = Q.bindOrder.map(b => {
    const p = Q.params.find(x => x.name === b);
    return Object.prototype.hasOwnProperty.call(params, b) ? params[b] : p.default;
  });
  return db.prepare(Q.sql).all(...vals);
}
const cell = (rows, bucket, src) =>
  rows.find(r => r.first_pitch_bucket === bucket && r.total_source === src) || null;

function main() {
  const db = seed();
  const WIN = { from: '2026-09-20', to: '2026-09-20' };
  const rows = run(db, WIN);

  console.log('\n1. the per-game split, at the default hour=11');
  const bp = cell(rows, 'before', 'polymarket');
  expect('4 Poly-priced games start before 11 PT', bp && bp.games === 4,
    bp ? bp.games + ' game(s)' : 'missing');
  const bk = cell(rows, 'before', 'kalshi');
  // TWO: early-k (17:35 UTC via scheduled_start_utc) and fp-only
  // (17:15 UTC via the first_pitch_utc fallback). Counting one here was
  // this test's own first failure -- the fallback game is easy to forget
  // precisely because it arrives by a different column.
  expect('2 Kalshi-priced games start before 11 PT', bk && bk.games === 2,
    bk ? bk.games + ' game(s)' : 'missing');
  const ap = cell(rows, 'after', 'polymarket');
  expect('1 Poly-priced game starts at/after 11 PT', ap && ap.games === 1,
    ap ? ap.games + ' game(s)' : 'missing');
  const ak = cell(rows, 'after', 'kalshi');
  expect('2 Kalshi-priced games at/after 11 PT (the 11:00 edge and a 19:10)',
    ak && ak.games === 2, ak ? ak.games + ' game(s)' : 'missing');

  console.log('\n2. the PDT conversion, and the boundary is exclusive');
  expect('17:05 UTC buckets as before (10:05 PT)', bp && bp.earliest_pt_hour === 10,
    bp ? String(bp.earliest_pt_hour) : 'n/a');
  expect('an 18:00 UTC start is 11:00 PT and lands in AFTER, not before',
    ak && ak.earliest_pt_hour === 11, ak ? String(ak.earliest_pt_hour) : 'n/a');

  console.log('\n3. scheduled_start_utc preferred, first_pitch_utc the fallback');
  // fp-only has no scheduled_start_utc; it reaches the "before" bucket
  // only through COALESCE(scheduled_start_utc, first_pitch_utc). Drop the
  // fallback from the SQL and this count falls to 1.
  expect('a game with only first_pitch_utc is still bucketed (10:15 PT -> before)',
    bk && bk.games === 2 && bk.earliest_pt_hour === 10,
    bk ? bk.games + ' game(s), earliest ' + bk.earliest_pt_hour : 'missing');
  const fpOnly = db.prepare("SELECT COUNT(*) n FROM game_log WHERE game_id='fp-only' "
    + 'AND scheduled_start_utc IS NULL AND first_pitch_utc IS NOT NULL').get().n;
  expect('...and that game genuinely has no scheduled_start_utc', fpOnly === 1);

  console.log('\n4. unknown is its own bucket, and removed games are gone');
  const unk = cell(rows, 'unknown', 'kalshi');
  expect('a game with neither timestamp is "unknown"', unk && unk.games === 1,
    unk ? unk.games + ' game(s)' : 'missing');
  const total = rows.reduce((a, r) => a + r.games, 0);
  expect('is_removed game excluded: 10 counted, not 11', total === 10,
    total + ' game(s)');

  console.log('\n5. with_kalshi_anchor separates "never listed" from "listed later"');
  expect('3 of the 4 early Poly games carry an anchor (Kalshi got there later)',
    bp && bp.with_kalshi_anchor === 3, bp ? String(bp.with_kalshi_anchor) : 'n/a');
  expect('...so 1 had NO Kalshi anchor at all -- the liquidity_fallback shape',
    bp && bp.games - bp.with_kalshi_anchor === 1,
    bp ? String(bp.games - bp.with_kalshi_anchor) : 'n/a');

  console.log('\n6. the UNDERCOUNT direction of caveat (1)');
  // total_source is end-state. 'edge-11' reads kalshi; if an earlier pass
  // had priced it off Poly, this query cannot know. What it must never do
  // is the reverse -- report a game as Poly that ended Kalshi.
  const polyTotal = rows.filter(r => r.total_source === 'polymarket')
    .reduce((a, r) => a + r.games, 0);
  const dbPoly = db.prepare("SELECT COUNT(*) n FROM game_log WHERE game_date='2026-09-20' "
    + "AND total_source='polymarket' AND COALESCE(is_removed,0)=0").get().n;
  expect('reported Poly count equals the stored end-state, never more',
    polyTotal === dbPoly, polyTotal + ' vs ' + dbPoly);

  console.log('\n7. hour moves the boundary');
  const h13 = run(db, { ...WIN, hour: 13 });
  const bp13 = cell(h13, 'before', 'polymarket');
  expect('at hour=13 the 11:00 PT edge game joins "before"',
    cell(h13, 'before', 'kalshi').games === 3,
    String(cell(h13, 'before', 'kalshi').games));
  expect('...and the early Poly four are unchanged', bp13.games === 4,
    String(bp13.games));

  console.log('\n8. from/to bound the window');
  const wide = run(db, { from: '2026-09-20', to: '2026-09-25' });
  expect('widening the window picks up the out-of-range game',
    wide.reduce((a, r) => a + r.games, 0) === 11,
    String(wide.reduce((a, r) => a + r.games, 0)));
  expect('and dates is reported so the sample size is visible',
    cell(wide, 'before', 'polymarket').dates === 2,
    String(cell(wide, 'before', 'polymarket').dates));

  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
