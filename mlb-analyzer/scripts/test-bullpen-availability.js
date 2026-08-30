#!/usr/bin/env node
/**
 * Bullpen availability: exclusions, the doubleheader rule, and the floor.
 * (2026-08-29)
 *
 * The three things that must stay true:
 *
 *   1. An exclusion is REPORTED, not just applied. The pool has always been
 *      filtered; nothing recorded it, so a game priced off 5 arms and one
 *      priced off 9 were indistinguishable. Fatigue thinned 28 of 30 pools
 *      on 2026-08-22.
 *   2. The same-day rule fires ONLY on a nightcap. It is inert for ~99% of
 *      games and must stay that way -- a rule that quietly excluded arms on
 *      ordinary games would be worse than the bug it fixes.
 *   3. The floor SUPPRESSES rather than substituting. Falling back to
 *      BULLPEN_AVG below three arms produces a confident number from no
 *      information.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- 1. the floor, exercised through the real runModel -----------------
const { runModel } = require(path.join(R, 'services/model'));

// Minimum viable game: nine batters a side so the lineup guard passes and
// the bullpen guard is what we are actually testing.
const lineup = n => Array.from({ length: n }, (_, i) => ({ name: 'B' + i, hand: 'R', pos: 'LF' }));
const baseGame = extra => Object.assign({
  game_date: '2026-08-29', game_id: 'aaa-bbb',
  awayLineup: lineup(9), homeLineup: lineup(9),
  awayBullpenWoba: 0.318, homeBullpenWoba: 0.318,
  park_factor: 1.0,
}, extra);
const settings = { BULLPEN_AVG: 0.318 };

const quiet = fn => { const r = console.log; console.log = () => {}; try { return fn(); } finally { console.log = r; } };

// No availability recorded -> the guard must NOT fire. A null pool means
// the lookup never ran; that is not evidence of a thin bullpen.
let m = quiet(() => runModel(baseGame({}), {}, settings, 'opener_aware', true));
ok(m && m._suppressed !== 'bullpen_unavailable', 'no availability recorded -> not suppressed');

m = quiet(() => runModel(baseGame({ bullpenAvailability: {
  away: { pool: null, excluded: [] }, home: { pool: null, excluded: [] } } }), {}, settings, 'opener_aware', true));
ok(m && m._suppressed !== 'bullpen_unavailable', 'null pool -> not suppressed (lookup never ran)');

// At and above the floor -> priced.
m = quiet(() => runModel(baseGame({ bullpenAvailability: {
  away: { pool: 3, excluded: [] }, home: { pool: 7, excluded: [] } } }), {}, settings, 'opener_aware', true));
ok(m && m._suppressed !== 'bullpen_unavailable', 'pool exactly at the floor (3) -> priced, not suppressed');

// Below the floor -> suppressed, on either side.
for (const [side, other] of [['away', 'home'], ['home', 'away']]) {
  const avail = {};
  avail[side] = { pool: 2, excluded: [{ name: 'x y', reasons: ['dh-game1'] }] };
  avail[other] = { pool: 8, excluded: [] };
  m = quiet(() => runModel(baseGame({ bullpenAvailability: avail }), {}, settings, 'opener_aware', true));
  eq(m && m._suppressed, 'bullpen_unavailable', side + ' pool of 2 -> suppressed');
  ok(m && /1 excluded/.test(m._suppressed_detail || ''), side + ': detail names the exclusion count');
  ok(m && new RegExp(side).test(m._suppressed_detail || ''), side + ': detail names which side is thin');
  ok(m && m.adjHW == null && m.estTot == null, side + ': suppressed result carries no numbers');
}

// A pool of ZERO is suppression, not a pass-through to league average.
m = quiet(() => runModel(baseGame({ bullpenAvailability: {
  away: { pool: 0, excluded: [] }, home: { pool: 8, excluded: [] } } }), {}, settings, 'opener_aware', true));
eq(m && m._suppressed, 'bullpen_unavailable', 'pool of 0 -> suppressed, never averaged');

// The lineup guard still wins when both apply -- it is checked first and
// is the more fundamental failure.
m = quiet(() => runModel(baseGame({ awayLineup: lineup(4), bullpenAvailability: {
  away: { pool: 1, excluded: [] }, home: { pool: 8, excluded: [] } } }), {}, settings, 'opener_aware', true));
eq(m && m._suppressed, 'incomplete_lineup', 'incomplete lineup takes precedence over the bullpen floor');

// ---- 2. the doubleheader rule, on data this test OWNS -----------------
//
// The first version of this asserted against a real corpus doubleheader
// (2026-07-29 ATL/NYM) and passed -- until the local DB stopped carrying
// the re-ingested leg rows, at which point it failed for a reason that had
// nothing to do with the code under test. A test whose result depends on
// whether somebody happened to re-run a score job is not a test.
//
// So it seeds its own rows under a team code that cannot collide with a
// real one, asserts, and removes them in a finally. The assertions are the
// same; only the provenance of the data changed.
const { q, db } = require(path.join(R, 'db/schema'));

const T = 'ZZT';                 // not an MLB abbreviation
const D = '2026-06-02';          // a date with no real ZZT rows
const ins = db.prepare(
  'INSERT OR REPLACE INTO pitcher_game_log (game_date, team, pitcher_name, pitcher_mlb_id, '
  + 'pitches_thrown, innings_pitched, batters_faced, was_starter, outing_type, appeared, '
  + 'game_pk, game_number, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,datetime(\x27now\x27))');

try {
  // Leg 1: a starter and two relievers. Leg 2: a different starter only.
  ins.run(D, T, 'Zed Starter One', 900001, 90, 5.0, 20, 1, 'start', 991, 1);
  ins.run(D, T, 'Zed Reliever A',  900002, 18, 1.0,  4, 0, 'short_relief', 991, 1);
  ins.run(D, T, 'Zed Reliever B',  900003, 22, 1.0,  5, 0, 'short_relief', 991, 1);
  ins.run(D, T, 'Zed Starter Two', 900004, 85, 5.0, 19, 1, 'start', 992, 2);

  const dh = n => q.getFatiguedPitchers(T, D, n).filter(x => x.reasons.includes('dh-game1'));

  eq(dh(1).length, 0, 'leg 1 has no dh-game1 exclusions -- there is no earlier game');
  eq(dh(2).length, 3, 'leg 2 excludes all three leg-1 pitchers');
  eq(q.getFatiguedPitchers(T, D).filter(x => x.reasons.includes('dh-game1')).length, 0,
     'omitting gameNumber entirely -> rule inert (every ordinary caller)');
  ok(dh(2).some(x => x.pitcher_name === 'Zed Starter One'),
     'the leg-1 STARTER is excluded too -- he cannot relieve in the nightcap');
  ok(!dh(2).some(x => x.pitcher_name === 'Zed Starter Two'),
     'the leg-2 starter is NOT excluded by his own appearance');

  // A legacy row (game_number NULL) must never be read as a leg-1
  // appearance -- that would exclude arms on the strength of missing data.
  ins.run(D, T, 'Zed Legacy Row', 900005, 20, 1.0, 4, 0, 'short_relief', null, null);
  ok(!q.getFatiguedPitchers(T, D, 2).some(x => x.pitcher_name === 'Zed Legacy Row'),
     'a NULL game_number row is not treated as a leg-1 appearance');

  // Leg identity survives a both-legs pitcher -- the Phase 1 guarantee,
  // asserted on rows this test controls rather than on corpus state.
  ins.run(D, T, 'Zed Both Legs', 900006, 11, 0.7, 3, 0, 'short_relief', 991, 1);
  ins.run(D, T, 'Zed Both Legs', 900006, 17, 1.0, 4, 0, 'short_relief', 992, 2);
  const both = db.prepare(
    'SELECT game_number, pitches_thrown FROM pitcher_game_log WHERE game_date=? AND team=? '
    + 'AND pitcher_name=? ORDER BY game_number').all(D, T, 'Zed Both Legs');
  eq(both.length, 2, 'a both-legs pitcher keeps TWO rows (Phase 1; leg 1 not overwritten)');
  eq(both[0].pitches_thrown, 11, 'leg 1 pitch count survives');
  eq(both[1].pitches_thrown, 17, 'leg 2 pitch count is its own row');

  // ---- the leg reaches the POOL, not just getFatiguedPitchers ----------
  // The source assertion this replaced could only prove an argument was
  // spelled correctly. This proves it is honoured: same team, same date,
  // two legs, and the nightcap must lose the arms that worked leg 1.
  //
  // Needs a roster and projections, because the pool is built from
  // projection rows filtered against the active RP set.
  db.prepare('INSERT OR REPLACE INTO team_rosters (player_name, team, role) VALUES (?,?,?)')
    .run('Zed Reliever A', T, 'RP');
  db.prepare('INSERT OR REPLACE INTO team_rosters (player_name, team, role) VALUES (?,?,?)')
    .run('Zed Reliever B', T, 'RP');
  db.prepare('INSERT OR REPLACE INTO team_rosters (player_name, team, role) VALUES (?,?,?)')
    .run('Zed Reliever C', T, 'RP');
  const insW = db.prepare('INSERT OR REPLACE INTO woba_data (data_key, player_name, woba, sample_size) VALUES (?,?,?,?)');
  for (const hand of ['lhb', 'rhb']) {
    insW.run('pit-proj-' + hand, 'Zed Reliever A ' + T, 0.310, 40);
    insW.run('pit-proj-' + hand, 'Zed Reliever B ' + T, 0.320, 40);
    insW.run('pit-proj-' + hand, 'Zed Reliever C ' + T, 0.330, 40);
  }
  const BPleg = n => q.getBullpenWobaBlended(T, '', [], 0.55, 0.45, 0.35, 0.65,
    0.45, 0.55, D, 0.335, 50, true, 0.25, 0.75, n, null);
  const p1 = BPleg(1), p2 = BPleg(2);
  ok(p1 && p2, 'the seeded ZZT pool resolves for both legs');
  if (p1 && p2) {
    eq(p1.pitchers, 3, 'leg 1 pools all three seeded relievers');
    eq(p2.pitchers, 1, 'the nightcap pools only the arm that did not work leg 1');
    const ex2 = (p2.excluded || []).map(e => e.name).sort().join(',');
    ok(ex2.includes('zed reliever a') && ex2.includes('zed reliever b'),
       'and both leg-1 relievers appear in the nightcap exclusion list (got: ' + ex2 + ')');
    ok(p2.woba !== p1.woba, 'the nightcap wOBA differs -- the exclusion reached the NUMBER');
  }
} finally {
  db.prepare('DELETE FROM pitcher_game_log WHERE game_date=? AND team=?').run(D, T);
  db.prepare('DELETE FROM team_rosters WHERE team=?').run(T);
  db.prepare("DELETE FROM woba_data WHERE player_name LIKE '%' || ? ").run(T);
}

// ---- 3. the leg parser, which shipped broken once ---------------------
// /-g(d+)$/ matches a literal "d", never fires, and makes the whole rule
// silently inert. One copy in utils/dh-leg.js, asserted here.
const { legOf, isNightcap } = require(path.join(R, 'utils/dh-leg'));
eq(legOf('bos-nyy'), 1, 'an ordinary game is leg 1, not unknown');
eq(legOf('bos-nyy-g2'), 2, 'the -g2 suffix parses to leg 2');
eq(legOf('ari-sf-g2'), 2, 'suffix parses regardless of team codes');
eq(legOf('atl-nym-g3'), 3, 'a third leg parses');
eq(legOf(null), 1, 'null game_id is leg 1, never NaN');
eq(legOf(''), 1, 'empty game_id is leg 1');
eq(legOf('bos-nyy-g'), 1, 'a malformed suffix falls back to leg 1');
eq(legOf('bos-gnyy'), 1, 'a mid-string g does not parse as a leg');
eq(isNightcap('bos-nyy'), false, 'ordinary game is not a nightcap');
eq(isNightcap('bos-nyy-g2'), true, 'leg 2 is a nightcap');
// The exact failure that shipped: a literal-d regex returns 1 for a real
// nightcap, which reads as 'feature working, nothing to exclude'.
ok(legOf('bos-nyy-g2') !== 1, 'a real nightcap never reports leg 1');

// ---- 4. the report and the model must agree ---------------------------
// They are separate implementations. The report called getFatiguedPitchers
// WITHOUT the leg, so it showed arms used in game 1 as available while the
// model pool correctly excluded them -- the 2026-08-29 BOS nightcap.
const apiSrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
// Plain string matching, deliberately. Writing these as regexes is how the
// literal-d bug got here in the first place -- an escaped backslash does
// not survive every editing path, and a regex that silently stops matching
// makes a test pass while asserting nothing.
//
// REWRITTEN 2026-08-30, when the report stopped being a second
// implementation. The old assertion here was:
//
//   apiSrc.includes('getFatiguedPitchers(teamU, date, gameNumber)')
//
// which required the report to make the leg-aware call ITSELF. That was the
// right assertion while the report was a mirror, and it is the wrong one
// now: the report no longer calls getFatiguedPitchers at all, because
// getBullpenWobaBlended does it. Keeping the old form would have forced the
// mirror to be re-created to satisfy a test written to protect it.
//
// So assert the two things that actually matter, and are stable under the
// refactor: the report does NOT re-implement the lookup, and the leg still
// reaches the pool.
ok(!apiSrc.includes('getFatiguedPitchers(teamU'),
   'the bullpen report does NOT call getFatiguedPitchers itself -- no second copy');
ok(apiSrc.includes('gameNumber, neutralizeFor);'),
   'the report passes the leg through to getBullpenWobaBlended instead');

ok(apiSrc.includes('buildTeamReport(g.away_team, g.away_sp, homeLU, legOf(g.game_id))'),
   'the report call site derives the leg from the game_id');
const jobsSrc2 = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
// Match the CODE form, not the bare string. The first version of this
// asserted on '-g(d+)$' and failed against a source COMMENT that describes
// the bug -- a test that cannot tell the defect from the note explaining
// it. `.match(/-g(` only appears when someone hand-writes the regex.
ok(!(apiSrc + jobsSrc2).includes('.match(/-g('),
   'no hand-written leg regex outside utils/dh-leg.js -- one copy only');

// ---- 5. every consumer of the pool must pass the leg -------------------
// There are four call sites of getBullpenWobaBlended/getFatiguedPitchers:
// the model (processGameSignals), the bullpen report, and the model-trace
// endpoint. Each one that omits the leg silently reports leg-1 numbers for
// a nightcap. The report was found that way on 2026-08-29; model-trace was
// found the same way the day after, while checking whether the report fix
// had worked -- the trace showed NYY identical across both legs while the
// persisted game_log row already had five arms excluded.
ok(apiSrc.includes('BP_WA_, legOf(gameRow.game_id))'),
   'model-trace passes the leg to getBullpenWobaBlended');
// split, not a regex. This assertion has now been mangled twice by an
// eaten backslash; a counting check does not need one.
ok(apiSrc.split('legOf(').length - 1 >= 4,
   'every leg-dependent call site in the API derives the leg');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);