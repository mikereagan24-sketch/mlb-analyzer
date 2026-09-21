// The odds-anchor-split admin queries answer the #413/#414 question in
// one call, and do not turn a missing instrument into a measured zero.
//
// THE QUESTION. Does a DAY slate reach the Poly totals path through a
// different anchor than an EVENING slate? If day games fall to
// liquidity_fallback because the 8AM PT pass runs before Kalshi has
// posted, a ~9:30AM PT pass is worth adding. If the persisted anchor
// already carries them, it is not. The counts runOddsJob logs are:
//
//   [poly totals by anchor: kalshi pass=A persisted=B liquidity_fallback=C;
//    kalshi totals rung: persisted=D auto=E]
//
// WHAT THIS PINS:
//   1. the five numbers parse out of the message, multi-digit included;
//   2. pre-#414 rows are EXCLUDED, not read as zeros -- an
//      uninstrumented pass must never look like a measured null;
//   3. day / evening / mixed / unknown classify the way the
//      description claims, with day_games carried through so a mixed
//      slate is visible rather than hidden behind its label;
//   4. `unknown` is its own bucket, not silently folded into evening;
//   5. cutoff_hour actually moves the boundary;
//   6. the PT conversion puts each pass on the right side of it -- the
//      8AM PT odds cron logs ran_at 15:00 UTC, and reading that as
//      local would file it as an afternoon pass;
//   7. from/to filter run_date (the slate), not ran_at (UTC).
//
// Runs the REAL registry SQL against an in-memory DB. No network.
//
// Run: node --max-old-space-size=1536 scripts/test-odds-anchor-split-query.js

const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { getQuery } = require(path.join(R, 'services/admin-queries'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const msg = (a, b, c, d, e) =>
  'Updated 9 game(s) from odds [poly totals by anchor: kalshi pass=' + a
  + ' persisted=' + b + ' liquidity_fallback=' + c
  + '; kalshi totals rung: persisted=' + d + ' auto=' + e + ']';

function seed() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE cron_log (id INTEGER PRIMARY KEY, job_type TEXT, run_date TEXT, '
    + 'status TEXT, message TEXT, ran_at TEXT);'
    + 'CREATE TABLE game_log (game_date TEXT, game_id TEXT, scheduled_start_utc TEXT, '
    + 'is_removed INTEGER, PRIMARY KEY (game_date, game_id));'
  );
  const C = db.prepare('INSERT INTO cron_log (job_type, run_date, status, message, ran_at) '
    + 'VALUES (?,?,?,?,?)');
  const G = db.prepare('INSERT INTO game_log (game_date, game_id, scheduled_start_utc, is_removed) '
    + 'VALUES (?,?,?,?)');

  // --- 09-18: a DAY slate. 17:05 UTC = 10:05 PT, before the cutoff.
  G.run('2026-09-18', 'aaa-bbb', '2026-09-18 17:05:00', 0);
  G.run('2026-09-18', 'ccc-ddd', '2026-09-19 02:10:00', 0);   // 19:10 PT, evening
  // 8AM PT pass (15:00 UTC) and 11AM PT pass (18:00 UTC).
  C.run('odds', '2026-09-18', 'success', msg(0, 0, 2, 0, 0), '2026-09-18 15:00:10');
  C.run('odds', '2026-09-18', 'success', msg(1, 0, 1, 2, 0), '2026-09-18 18:00:10');

  // --- 09-19: an EVENING slate. Earliest 23:10 UTC = 16:10 PT.
  G.run('2026-09-19', 'eee-fff', '2026-09-19 23:10:00', 0);
  G.run('2026-09-19', 'ggg-hhh', '2026-09-20 02:05:00', 0);
  C.run('odds', '2026-09-19', 'success', msg(3, 1, 0, 4, 1), '2026-09-19 15:00:20');
  C.run('odds', '2026-09-19', 'success', msg(2, 2, 0, 5, 0), '2026-09-19 18:00:20');

  // --- 09-20: multi-digit values, and a removed game that must not count.
  G.run('2026-09-20', 'iii-jjj', '2026-09-20 18:00:00', 0);   // 11:00 PT, day
  G.run('2026-09-20', 'kkk-lll', '2026-09-20 17:00:00', 1);   // is_removed
  C.run('odds', '2026-09-20', 'success', msg(11, 12, 13, 14, 15), '2026-09-20 15:00:30');

  // --- 09-21: the slate has NO scheduled_start_utc at all -> unknown.
  G.run('2026-09-21', 'mmm-nnn', null, 0);
  C.run('odds', '2026-09-21', 'success', msg(7, 0, 0, 1, 0), '2026-09-21 15:00:40');

  // --- pre-#414: no anchor block. MUST be excluded, not zeroed.
  C.run('odds', '2026-09-18', 'success', 'Updated 10 game(s) from odds', '2026-09-18 22:00:00');
  C.run('odds', '2026-09-19', 'success', 'Updated 10 game(s) from odds', '2026-09-19 22:00:00');
  // --- a non-odds job that happens to mention the phrase
  C.run('weather', '2026-09-18', 'success', msg(99, 99, 99, 99, 99), '2026-09-18 16:00:00');
  // --- a half-written message: anchor block but no rung block
  C.run('odds', '2026-09-18', 'success',
    'Updated 9 game(s) from odds [poly totals by anchor: kalshi pass=5 persisted=5 liquidity_fallback=5]',
    '2026-09-18 19:00:00');
  return db;
}

function run(db, name, params) {
  const q = getQuery(name);
  const vals = q.bindOrder.map(b => {
    const p = q.params.find(x => x.name === b);
    return Object.prototype.hasOwnProperty.call(params, b) ? params[b] : p.default;
  });
  return db.prepare(q.sql).all(...vals);
}

function main() {
  const db = seed();
  const WIN = { from: '2026-09-18', to: '2026-09-21' };

  console.log('\n1. the five numbers parse, multi-digit included');
  const rows = run(db, 'odds-anchor-passes', WIN);
  const d20 = rows.find(r => r.run_date === '2026-09-20');
  expect('multi-digit anchor + rung values survive the parse',
    d20.anchor_kalshi_pass === 11 && d20.anchor_persisted === 12
    && d20.anchor_liquidity_fallback === 13 && d20.rung_persisted === 14
    && d20.rung_auto === 15,
    [d20.anchor_kalshi_pass, d20.anchor_persisted, d20.anchor_liquidity_fallback,
      d20.rung_persisted, d20.rung_auto].join('/'));

  console.log('\n2. uninstrumented rows are EXCLUDED, not counted as zeros');
  // 6 seeded anchor-bearing odds passes: 2 on 09-18, 2 on 09-19, 1 on
  // 09-20, 1 on 09-21. Four more rows are seeded that must NOT appear --
  // two pre-#414 messages, one weather row quoting the phrase, and one
  // half-written message with an anchor block but no rung block.
  expect('only the 6 anchor-bearing odds passes appear', rows.length === 6,
    rows.length + ' row(s)');
  expect('no row has all-zero counts from a missing block',
    !rows.some(r => r.anchor_kalshi_pass === 0 && r.anchor_persisted === 0
      && r.anchor_liquidity_fallback === 0 && r.rung_persisted === 0 && r.rung_auto === 0
      && r.run_date === '2026-09-18' && String(r.ran_at_utc).indexOf('22:00') !== -1));
  expect('a non-odds job mentioning the phrase is not included',
    !rows.some(r => r.anchor_kalshi_pass === 99));
  expect('an anchor block with no rung block is skipped, not half-parsed',
    !rows.some(r => r.anchor_kalshi_pass === 5 && r.anchor_persisted === 5));

  console.log('\n3. the PT conversion files each pass on the right side of the cutoff');
  const p8 = rows.find(r => r.ran_at_utc === '2026-09-18 15:00:10');
  expect('15:00 UTC reads as the 08:00 PT pass', p8.ran_at_pt === '2026-09-18 08:00:10',
    p8.ran_at_pt);
  expect('...and 18:00 UTC as 11:00 PT',
    rows.find(r => r.ran_at_utc === '2026-09-18 18:00:10').ran_at_pt === '2026-09-18 11:00:10');

  console.log('\n4. slate classification, with mixed slates still visible');
  expect('a slate whose earliest game is 10:05 PT is "day"', p8.slate_type === 'day',
    p8.slate_type);
  expect('...and its day/total split is carried through, so MIXED is visible',
    p8.day_games === 1 && p8.total_games === 2, p8.day_games + '/' + p8.total_games);
  const ev = rows.find(r => r.run_date === '2026-09-19');
  expect('a slate whose earliest game is 16:10 PT is "evening"', ev.slate_type === 'evening',
    ev.slate_type);
  expect('a removed game does not count toward the slate',
    d20.total_games === 1, String(d20.total_games));

  console.log('\n5. `unknown` is its own bucket, not folded into evening');
  const unk = rows.find(r => r.run_date === '2026-09-21');
  expect('a slate with no scheduled_start_utc is "unknown"', unk.slate_type === 'unknown',
    unk.slate_type);
  expect('...and says how many games lacked an anchor', unk.unanchored_games === 1,
    String(unk.unanchored_games));

  console.log('\n6. the grouped view sums per (slate_type, pass hour PT)');
  const g = run(db, 'odds-anchor-split', WIN);
  const key = (t, h) => g.find(r => r.slate_type === t && r.pass_hour_pt === h);
  expect('day slates at the 08 PT pass are grouped',
    !!key('day', '08'), g.map(r => r.slate_type + '@' + r.pass_hour_pt).join(' '));
  const day08 = key('day', '08');
  expect('two day-slate 08 PT passes summed (09-18 and 09-20)',
    day08.passes === 2 && day08.dates === 2,
    day08.passes + ' pass(es), ' + day08.dates + ' date(s)');
  expect('their liquidity_fallback sums (2 + 13)',
    day08.anchor_liquidity_fallback === 15, String(day08.anchor_liquidity_fallback));
  expect('their rung counts sum too (0+14 persisted, 0+15 auto)',
    day08.rung_persisted === 14 && day08.rung_auto === 15,
    day08.rung_persisted + '/' + day08.rung_auto);
  const ev08 = key('evening', '08');
  expect('evening slates are a separate group',
    ev08 && ev08.anchor_kalshi_pass === 3 && ev08.anchor_liquidity_fallback === 0,
    ev08 ? ev08.anchor_kalshi_pass + '/' + ev08.anchor_liquidity_fallback : 'missing');
  expect('unknown appears as its own group', !!key('unknown', '08'));

  console.log('\n7. cutoff_hour moves the boundary');
  // 09-19's earliest is 16:10 PT. At cutoff 17 it becomes a day slate.
  const g17 = run(db, 'odds-anchor-split', { ...WIN, cutoff_hour: 17 });
  const ev17 = g17.find(r => r.slate_type === 'evening' && r.pass_hour_pt === '08');
  expect('at cutoff_hour=17 the 16:10 PT slate reclassifies as day', !ev17,
    ev17 ? 'still evening' : 'reclassified');
  const day17 = g17.find(r => r.slate_type === 'day' && r.pass_hour_pt === '08');
  expect('...and joins the day group', day17.passes === 3, day17.passes + ' pass(es)');

  console.log('\n8. from/to filter run_date, not ran_at');
  const narrow = run(db, 'odds-anchor-passes', { from: '2026-09-20', to: '2026-09-20' });
  expect('a one-day window returns only that slate',
    narrow.length === 1 && narrow[0].run_date === '2026-09-20',
    narrow.length + ' row(s)');

  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
