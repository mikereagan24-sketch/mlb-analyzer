#!/usr/bin/env node
/**
 * Nothing about a started game reaches the operator. (2026-09-02)
 *
 * sd-cin 2026-09-02: the card showed a market-gate pill quoting
 * -1775/-2580 on a game in the top of the 8th. The #306 post-start refusal
 * DID fire and no signal price was written -- but three artifacts of a live
 * in-game market had already landed by the time it ran, because the refusal
 * sat ~290 lines below them.
 *
 * THE DEFECT WAS ORDERING, so the assertions are about ordering. A source
 * test is the right shape here: the failure mode is "someone moves the
 * start check back down", and that is a positional property, not a value.
 *
 * The four fixes, in the order they run:
 *   1. _startedNow computed ONCE, before anything that can emit
 *   2. venue override skipped on a started game (was pulling live quotes)
 *   3. gate reason reworded (checkMarketMLPairSanity says "corrupt feed
 *      data", which is wrong for a legitimate in-game market)
 *   4. suppression audit -- the pill -- not written on a started game
 * and the refusal still runs and still records refused_post_start_pricing.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };

const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
const lines = src.split(/\r?\n/);
const at = pat => { const i = lines.findIndex(l => l.includes(pat)); return i < 0 ? Infinity : i + 1; };

// ---- 1. ORDERING: the start check precedes everything that can emit -----
const L = {
  started:  at('_startedNow = !!gameHasStarted(gameRow'),
  venue:    at('if (_venueAware && !_startedNow) {'),
  gate:     at('let _pairReason = checkMarketMLPairSanity('),
  audit:    at('if (!_startedNow && outSuppressed.length) {'),
  refusal:  at("action: 'refused_post_start_pricing'"),
};
for (const [k, v] of Object.entries(L)) ok(v !== Infinity, 'located the ' + k + ' anchor');

ok(L.started < L.venue,
   'start state is computed BEFORE the venue override (' + L.started + ' < ' + L.venue + ')');
ok(L.started < L.gate,
   'start state is computed BEFORE the gate reason is built (' + L.started + ' < ' + L.gate + ')');
ok(L.started < L.audit,
   'start state is computed BEFORE the suppression audit (' + L.started + ' < ' + L.audit + ')');
ok(L.audit < L.refusal,
   'the audit still sits above the refusal -- so it MUST be guarded, not merely ordered ('
   + L.audit + ' < ' + L.refusal + ')');

// The old shape: a second, later computation. One source of truth only.
const startedComputations = lines.filter(l => l.includes('_startedNow = !!gameHasStarted(')).length;
ok(startedComputations === 1,
   'gameHasStarted is evaluated exactly once per pass (got ' + startedComputations + ')');

// ---- 2. the three emitters are actually guarded -------------------------
ok(src.includes('if (_venueAware && !_startedNow) {'),
   'venue override is gated on NOT started');
ok(src.includes('if (!_startedNow && outSuppressed.length) {'),
   'suppression audit is gated on NOT started');
ok(src.includes('if (_pairReason && _startedNow) {'),
   'the gate reason is reworded when the game has started');
ok(src.includes('live in-game market on a started game'),
   'and the replacement text names the real cause');

// ---- 3. the refusal is untouched ---------------------------------------
ok(src.includes("action: 'refused_post_start_pricing'"),
   'the post-start refusal still records its audit row');
ok(src.includes('if (_startedNow && signals.length) {'),
   'and still refuses to write signal prices');

// ---- 4. market-sanity stays PURE ---------------------------------------
// The rewording belongs to the caller. If game state leaked into
// market-sanity, every other caller would inherit a judgement it did not
// ask for.
const msSrc = fs.readFileSync(path.join(R, 'utils/market-sanity.js'), 'utf8');
for (const leak of ['gameHasStarted', 'first_pitch', 'game_status', 'started']) {
  ok(!msSrc.includes(leak), 'utils/market-sanity.js does not know about ' + leak);
}
const { checkMarketMLPairSanity } = require(path.join(R, 'utils/market-sanity'));
ok(/corrupt feed data/.test(String(checkMarketMLPairSanity(-1775, -2580))),
   'market-sanity still reports the magnitude case in its own terms');
ok(checkMarketMLPairSanity(-155, 128) == null,
   'and still passes a normal pre-game pair');

// ---- 5. FIX 4: the first-pitch predicate ------------------------------
const { db } = require(path.join(R, 'db/schema'));
const NEW_PRED = " AND (scheduled_start_utc IS NULL"
  + "      OR (first_pitch_utc IS NULL"
  + "          AND scheduled_start_utc <= strftime('%Y-%m-%dT%H:%M:%SZ','now')))";
ok(src.includes("first_pitch_utc IS NULL"),
   'refreshFirstPitch onlyMissing also looks for a missing first pitch');
ok(src.includes("scheduled_start_utc <= strftime('%Y-%m-%dT%H:%M:%SZ','now')"),
   'and bounds it to games whose scheduled start has already passed');

// Behavioural: on a seeded slate the predicate picks exactly the games that
// still need a first pitch, and nothing once they all have one.
const D = '2026-06-05', T = 'ZZP';
const ins = db.prepare('INSERT INTO game_log (game_date, game_id, away_team, home_team, game_pk, scheduled_start_utc, first_pitch_utc) VALUES (?,?,?,?,?,?,?)');
const sel = db.prepare('SELECT game_id FROM game_log WHERE game_date = ? AND game_pk IS NOT NULL' + NEW_PRED);
try {
  ins.run(D, T + '-a', 'ZZP', 'ZZQ', 900001, null, null);                                  // no anchor yet
  ins.run(D, T + '-b', 'ZZP', 'ZZR', 900002, '2020-01-01T00:00:00Z', null);                // started, no fp
  ins.run(D, T + '-c', 'ZZP', 'ZZS', 900003, '2020-01-01T00:00:00Z', '2020-01-01T00:05:00Z'); // fp recorded
  ins.run(D, T + '-d', 'ZZP', 'ZZT', 900004, '2099-01-01T00:00:00Z', null);                // not started yet
  const picked = sel.all(D).map(r => r.game_id).sort();
  ok(picked.length === 2, 'predicate picks exactly 2 of 4 seeded games (got ' + picked.length + ': ' + picked.join(',') + ')');
  ok(picked.includes(T + '-a'), 'picks the game with no start anchor');
  ok(picked.includes(T + '-b'), 'picks the STARTED game with no recorded first pitch');
  ok(!picked.includes(T + '-c'), 'skips the game whose first pitch is already recorded');
  ok(!picked.includes(T + '-d'), 'skips the game that has not started yet -- this is the bound');

  // once the straggler lands its first pitch, the set empties
  db.prepare('UPDATE game_log SET first_pitch_utc=? WHERE game_date=? AND game_id=?')
    .run('2020-01-01T00:06:00Z', D, T + '-b');
  db.prepare('UPDATE game_log SET scheduled_start_utc=? WHERE game_date=? AND game_id=?')
    .run('2099-01-01T00:00:00Z', D, T + '-a');
  ok(sel.all(D).length === 0,
     'the set converges to empty -- it cannot become a per-pass re-fetch of the slate');
} finally {
  db.prepare('DELETE FROM game_log WHERE game_date=? AND away_team=?').run(D, 'ZZP');
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
