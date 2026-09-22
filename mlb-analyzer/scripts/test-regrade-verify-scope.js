#!/usr/bin/env node
// A correct refusal is not a failure, and the check must not count it as
// one.
//   node --max-old-space-size=1536 scripts/test-regrade-verify-scope.js
// Exit 1 on any failure.
//
// WHAT WENT WRONG. regrade-stale-totals-pnl refuses any row whose OUTCOME
// would move -- rightly, because it only ever corrects the stake, and an
// outcome that moves means the stored result and the stored bet_line
// disagree about which line was struck. But its closing verification loop
// re-scanned EVERY graded totals row, refusals included, so a correct
// refusal made it print `rows still disagreeing with calcPnl (must be 0): 1`
// for ever, on a row it had just deliberately declined to touch.
//
// It surfaced on 2026-09-22 the moment the first such row existed:
// id=178727, TOR@TEX 2026-09-19, logged under 7.5 against a market that
// was 8.5 all day. Earlier runs ended at 0 only because the row was not
// in the corpus yet.
//
// This is §"Scope a check to what it can act on": a check that can never
// pass on part of its input trains the reader to skip the line, and the
// skipping generalises to the runs where something IS wrong. The fix is
// not to lower the bar -- the refusal still happens, the row is still
// untouched, and it is now REPORTED with its id instead of being
// laundered into a failure count.
//
// Runs the real script against a temp DB holding one of each row.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const R = path.join(__dirname, '..');
const SCRIPT = path.join(R, 'scripts/regrade-stale-totals-pnl.js');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const TMP = path.join(os.tmpdir(), 'regrade-scope-' + process.pid + '.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args || []), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MLB_DB_PATH: TMP }),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

try {
  // Build the fixture through the app's own schema, on its own connection.
  process.env.MLB_DB_PATH = TMP;
  const { db } = require(path.join(R, 'db/schema'));

  const game = (gid, away, home, op, up) => db.prepare(
    'INSERT INTO game_log (game_date, game_id, away_team, home_team, away_score, home_score, '
    + 'over_price, under_price, market_total) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run('2026-09-19', gid, 'AAA', 'BBB', away, home, op, up, 8.5).lastInsertRowid;
  // bet_signals NOT NULL, no default: game_log_id, game_date, game_id,
  // signal_type, signal_side, category. category is the direction on a
  // Total, which is just the side.
  const sig = (glid, gid, side, betLine, betPrice, outcome, pnl) => db.prepare(
    'INSERT INTO bet_signals (game_log_id, game_date, game_id, signal_type, signal_side, '
    + 'category, market_line, bet_line, bet_price, outcome, pnl) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(glid, '2026-09-19', gid, 'Total', side, side, 8.5, betLine, betPrice, outcome, pnl);

  // (a) THE REFUSAL: under 7.5, the game totalled 8 -> a loss, stored as a win.
  sig(game('ref-usal', 2, 6, 123, -149), 'ref-usal', 'under', 7.5, -103, 'win', 100);
  // (b) A GENUINELY STALE ROW: under 9.5, total 10 -> loss either way, but the
  //     stake was stored at the market price instead of the struck one.
  sig(game('sta-le', 5, 5, 110, -110), 'sta-le', 'under', 9.5, -120, 'loss', -110);
  // (c) A CLEAN ROW: already agrees.
  sig(game('cle-an', 5, 5, 110, -110), 'cle-an', 'over', 9.5, -105, 'win', 100);

  const ids = db.prepare("SELECT id, game_id FROM bet_signals ORDER BY id").all();
  const idOf = (g) => (ids.find(x => x.game_id === g) || {}).id;
  expect('fixture built: 3 signals', ids.length === 3, JSON.stringify(ids.map(i => i.game_id)));

  console.log('\n1. the dry run names the refusal');
  let r = run([]);
  expect('exits 0', r.code === 0, 'exit ' + r.code);
  expect('refuses the outcome-changing row', /REFUSING id=' + idOf('ref-usal') + '|REFUSING id=/.test(r.out)
    && r.out.indexOf('REFUSING id=' + idOf('ref-usal')) > -1,
    (r.out.match(/REFUSING[^\n]*/) || [''])[0]);
  expect('...and reports it in a REFUSED line, not only mid-scan',
    r.out.indexOf('REFUSED (outcome would move') > -1,
    (r.out.match(/REFUSED[^\n]*/) || ['absent'])[0]);
  expect('the stale row is listed for correction', /sta-le/.test(r.out));

  console.log('\n2. --apply corrects the stale row and LEAVES the refused one');
  r = run(['--apply']);
  expect('exits 0', r.code === 0, 'exit ' + r.code);
  expect('exactly one row re-graded', /rows re-graded: 1/.test(r.out),
    (r.out.match(/rows re-graded: \d+/) || ['absent'])[0]);
  expect('THE POINT: the refusal is not counted as a failure',
    /rows still disagreeing with calcPnl \(must be 0\): 0/.test(r.out),
    (r.out.match(/rows still disagreeing[^\n]*/) || ['absent'])[0]);
  expect('...it is reported on its own line, with the id',
    /rows REFUSED and left alone[^\n]*1[^\n]*id=/.test(r.out),
    (r.out.match(/rows REFUSED[^\n]*/) || ['absent'])[0]);
  expect('...and says what settles it',
    /Settle it against what the book actually shows/.test(r.out));

  console.log('\n3. the refused row was not written');
  const after = db.prepare('SELECT outcome, pnl FROM bet_signals WHERE id=?').get(idOf('ref-usal'));
  expect('outcome untouched', after.outcome === 'win', after.outcome);
  expect('pnl untouched', Math.abs(Number(after.pnl) - 100) < 0.01, String(after.pnl));
  const fixed = db.prepare('SELECT pnl FROM bet_signals WHERE id=?').get(idOf('sta-le'));
  expect('the stale row was corrected to the struck price',
    Math.abs(Number(fixed.pnl) - (-120)) < 0.01, String(fixed.pnl));

  console.log('\n4. a second --apply is idempotent and still reports 0');
  r = run(['--apply']);
  expect('nothing left to re-grade', /rows re-graded: 0/.test(r.out),
    (r.out.match(/rows re-graded: \d+/) || ['absent'])[0]);
  expect('still 0 disagreements, still 1 refusal',
    /\(must be 0\): 0/.test(r.out) && /rows REFUSED and left alone[^\n]*1/.test(r.out),
    (r.out.match(/rows still disagreeing[^\n]*/) || ['absent'])[0]);

  console.log('\n5. the exclusion is by id, not by lowering the bar');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  expect('refusals are collected', /refused\.push\(\{ r, was: r\.outcome, would: res\.outcome \}\)/.test(src));
  expect('the verification loop skips them by id',
    /const refusedIds = new Set\(refused\.map\(x => x\.r\.id\)\);/.test(src)
    && /if \(refusedIds\.has\(r\.id\)\) continue;/.test(src));
  expect('the 0.01 tolerance is unchanged -- nothing was loosened',
    (src.match(/>= 0\.01/g) || []).length >= 1);
} finally {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* best effort */ } }
}

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
