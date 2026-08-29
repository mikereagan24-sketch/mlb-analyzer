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

// ---- 2. the doubleheader rule, against real data -----------------------
const { q } = require(path.join(R, 'db/schema'));

// 2026-07-29 ATL/NYM is a real split doubleheader in the corpus, and
// Didier Fuentes threw in BOTH legs -- the case whose leg-1 row used to be
// destroyed by INSERT OR REPLACE.
const DH_DATE = '2026-07-29', DH_TEAM = 'ATL';
const legOf = n => q.getFatiguedPitchers(DH_TEAM, DH_DATE, n).filter(x => x.reasons.includes('dh-game1'));

eq(legOf(1).length, 0, 'leg 1 has no dh-game1 exclusions -- there is no earlier game');
ok(legOf(2).length > 0, 'leg 2 excludes arms used in leg 1');
eq(q.getFatiguedPitchers(DH_TEAM, DH_DATE).filter(x => x.reasons.includes('dh-game1')).length, 0,
   'omitting gameNumber entirely -> rule inert (every ordinary caller)');
eq(q.getFatiguedPitchers(DH_TEAM, DH_DATE, 1).filter(x => x.reasons.includes('dh-game1')).length, 0,
   'gameNumber=1 -> rule inert');

// The exclusion must reach the POOL, not just the fatigue list.
const bp = n => q.getBullpenWobaBlended(DH_TEAM, '', [], 0.55, 0.45, 0.35, 0.65,
  0.65, 0.35, DH_DATE, 0.335, 100, true, 0.25, 0.75, n);
const leg1 = bp(1), leg2 = bp(2);
ok(leg2.pitchers < leg1.pitchers,
   'the nightcap pool is smaller than leg 1 (' + leg2.pitchers + ' vs ' + leg1.pitchers + ')');
ok(leg2.excluded.some(e => e.reasons.includes('dh-game1')),
   'the pool exclusion list carries the dh-game1 reason');
eq(leg1.excluded.filter(e => e.reasons.includes('dh-game1')).length, 0,
   'leg 1 pool has no dh-game1 exclusions');

// Phase 1 is what makes any of this answerable: both legs must exist.
const fuentes = require(path.join(R, 'db/schema')).db.prepare(
  "SELECT game_number, pitches_thrown FROM pitcher_game_log "
  + "WHERE game_date=? AND pitcher_name LIKE '%Fuentes%' ORDER BY game_number").all(DH_DATE);
eq(fuentes.length, 2, 'the both-legs pitcher has TWO rows, not one (Phase 1)');
ok(fuentes.every(r => r.game_number != null), 'both rows carry a leg number');
ok(fuentes[0].pitches_thrown !== fuentes[1].pitches_thrown,
   'the two legs hold different pitch counts -- leg 1 was not overwritten');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
