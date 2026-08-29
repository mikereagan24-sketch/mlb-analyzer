#!/usr/bin/env node
/**
 * A logged bet stays visible once struck. (2026-08-30)
 *
 * THE BUG. getSignalsByDate filters is_active = 1 -- correct for "what
 * should I bet now", wrong for "what did I bet". When a line moved and the
 * signal stopped clearing the emit floor, the rerun set is_active = 0 and
 * the logged bet silently left the card. 146 of 394 logged bets were
 * invisible when this was found, four of them PENDING on the next slate.
 *
 * The row was never at risk -- deactivateSignal touches is_active, notes
 * and updated_at only -- so this was a display gap, not data loss. The
 * tests below assert both halves: the bet reappears, AND the columns that
 * make it a record survive a deactivation.
 *
 * Runs against a scratch DB. Never touches data/mlb.db.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const scratch = path.join(os.tmpdir(), 'logged-bet-test-' + process.pid + '.db');
try { fs.unlinkSync(scratch); } catch (e) {}
const db = new Database(scratch);
db.exec(`CREATE TABLE bet_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date TEXT, game_id TEXT, signal_type TEXT, signal_side TEXT,
  market_line REAL, edge_pct REAL, outcome TEXT, pnl REAL,
  bet_line REAL, bet_price REAL, bet_locked_at TEXT, closing_line REAL, clv REAL,
  is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, updated_at TEXT)`);

// The two production queries, verbatim in shape.
const live = db.prepare("SELECT * FROM bet_signals WHERE game_date = ? AND is_active = 1 ORDER BY game_id");
const logged = db.prepare(
  "SELECT * FROM bet_signals WHERE game_date = ? AND bet_line IS NOT NULL AND is_active = 0 ORDER BY game_id");
// deactivateSignal's real surgical shape: is_active + notes + updated_at ONLY.
const deactivate = db.prepare(
  "UPDATE bet_signals SET is_active = 0, notes = ?, updated_at = datetime('now') "
  + "WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=?");

const D = '2026-08-30';
const ins = db.prepare(
  "INSERT INTO bet_signals (game_date,game_id,signal_type,signal_side,market_line,edge_pct,"
  + "outcome,bet_line,bet_price,bet_locked_at,clv,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)");

ins.run(D, 'col-atl', 'ML', 'away', 189, 0.04, 'pending', 196, 196, '2026-08-30 09:00:00', 1.4);
ins.run(D, 'kc-cle', 'ML', 'home', -183, 0.03, 'pending', -162, -162, '2026-08-30 09:05:00', 2.1);
ins.run(D, 'was-mia', 'ML', 'away', 120, 0.05, 'pending', null, null, null, null);   // unlogged

eq(live.all(D).length, 3, 'before: all three signals are live');
eq(logged.all(D).length, 0, 'before: nothing in the logged-inactive bucket');

// The line moves; two signals stop qualifying. One carries a logged bet.
deactivate.run('Model ml at rerun: 124, mkt=189 — edge no longer meets threshold.', D, 'col-atl', 'ML', 'away');
deactivate.run('Model ml at rerun: 130, mkt=120 — edge no longer meets threshold.', D, 'was-mia', 'ML', 'away');

eq(live.all(D).length, 1, 'after: the live query drops both deactivated signals');
const lb = logged.all(D);
eq(lb.length, 1, 'after: the logged bet is recoverable, the unlogged one is not');
eq(lb[0].game_id, 'col-atl', 'after: it is the right row');

// THE RECORD SURVIVES. This is what makes it a log rather than a view.
eq(lb[0].bet_line, 196, 'bet_line survives deactivation');
eq(lb[0].bet_price, 196, 'bet_price survives');
eq(lb[0].bet_locked_at, '2026-08-30 09:00:00', 'bet_locked_at survives -- the price struck, not the current one');
eq(lb[0].clv, 1.4, 'clv survives');
eq(lb[0].outcome, 'pending', 'outcome untouched');
ok(/edge no longer meets threshold/.test(lb[0].notes || ''),
   'the note explains WHY the signal went away -- annotation, not erasure');

// The two buckets must never overlap: a row is live or logged-inactive,
// never both, or the card would render it twice.
deactivate.run('n/a', D, 'kc-cle', 'ML', 'home');
const liveIds = new Set(live.all(D).map(r => r.id));
ok(!logged.all(D).some(r => liveIds.has(r.id)), 'the live and logged buckets are disjoint');
eq(logged.all(D).length, 2, 'both logged bets are now recoverable');

// A logged bet that is STILL live must not appear in the inactive bucket --
// it already renders through the normal signal path.
ins.run(D, 'sea-tor', 'ML', 'away', -126, 0.04, 'pending', -117, -117, '2026-08-30 10:00:00', 0.5);
ok(!logged.all(D).some(r => r.game_id === 'sea-tor'), 'a live logged bet stays out of the inactive bucket');
ok(live.all(D).some(r => r.game_id === 'sea-tor'), 'and stays in the live one');

// Graded bets stay visible too -- the log outlives the game.
db.prepare("UPDATE bet_signals SET outcome='win', pnl=100 WHERE game_id='col-atl'").run();
const g = logged.all(D).find(r => r.game_id === 'col-atl');
eq(g && g.outcome, 'win', 'a graded logged bet is still recoverable');
eq(g && g.bet_line, 196, 'and still carries the struck price');

// ---- the suppression-note fix -----------------------------------------
// Every suppression used to report "Lineup incomplete", including reasons
// that have nothing to do with lineups. The note is what a logged bet
// displays to explain itself, so a wrong cause misdirects the reader.
const jobsSrc = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
ok(/REASON_TEXT/.test(jobsSrc), 'the deactivation note maps the suppression reason');
for (const r of ['incomplete_lineup', 'bullpen_unavailable', 'no_park_factor']) {
  ok(new RegExp(r).test(jobsSrc), 'note mapping covers ' + r);
}
ok(!/\?\s*'Lineup incomplete \('/.test(jobsSrc),
   'no unconditional "Lineup incomplete" for every suppression reason');

db.close();
try { fs.unlinkSync(scratch); } catch (e) {}
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
