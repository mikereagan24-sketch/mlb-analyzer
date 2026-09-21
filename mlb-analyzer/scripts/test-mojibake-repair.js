// The mojibake repair restores what was written, and only that.
//
// Closes docs/mojibake-star-labels-open-question-2026-09-17.md.
//
// THE DAMAGE is UTF-8 read as Latin-1, in two flavours:
//   U+2605 star     E2 98 85  ->  U+00E2 U+0098 U+0085          (3 chars)
//   U+2014 em dash  E2 80 94  ->  U+00C3 U+00A2 U+00C2 U+0080
//                                 U+00C2 U+0094                 (6 chars)
// The second is a DOUBLE double-decode: mangled, re-encoded, mangled
// again. Both are deterministic, so both invert exactly.
//
// THE TICKET SAID to find the path before repairing, "because repairing
// the symptom removes the evidence". scripts/probe-mojibake-scan.js did
// that first and found the damage is wider than the 6 labels the ticket
// counted -- 30 distinct values over 57 rows in FOUR columns -- and that
// all of it is 2026-04, with zero damaged rows in 2026-05..09 against
// ~51,000 clean ones. So the writer is dead and a one-off repair is the
// right shape.
//
// Runs the REAL migration SQL from services/migrations.js against an
// in-memory DB seeded with the real damaged byte sequences. No network,
// no writes to the analysis copy.
//
// Run: node --max-old-space-size=1536 scripts/test-mojibake-repair.js

const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { MIGRATIONS } = require(path.join(R, 'services/migrations'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const STAR = '★';
const DASH = '—';
const MOJI_STAR = 'â';
const MOJI_DASH = 'Ã¢ÂÂ';

const MIG = MIGRATIONS.find(m => m.name === 'v6-mojibake-repair-001');

function seed() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE bet_signals (id INTEGER PRIMARY KEY, game_date TEXT, game_id TEXT, '
    + 'signal_label TEXT, notes TEXT, bet_line REAL, bet_locked_at TEXT, '
    + 'market_line REAL, edge_pct REAL, is_active INTEGER);'
    + 'CREATE TABLE bet_signal_audit (id INTEGER PRIMARY KEY, signal_id INTEGER, '
    + 'game_date TEXT, game_id TEXT, action TEXT, source TEXT, detail TEXT, created_at TEXT);'
  );
  const S = db.prepare('INSERT INTO bet_signals (id, game_date, game_id, signal_label, notes, '
    + 'bet_line, bet_locked_at, market_line, edge_pct, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)');
  // The six real label rows, five of them bet-locked.
  S.run(1, '2026-04-17', 'stl-hou', '2' + MOJI_STAR, null, 122, '2026-04-17 19:42:13', -110, 0.04, 1);
  S.run(2, '2026-04-17', 'lad-col', '3' + MOJI_STAR, null, 270, '2026-04-16 17:54:17', 250, 0.07, 1);
  S.run(3, '2026-04-17', 'cin-min', '1' + MOJI_STAR, null, 150, '2026-04-17 21:01:39', 140, 0.02, 1);
  S.run(4, '2026-04-17', 'cin-min', '3' + MOJI_STAR, null, 8.5, '2026-04-17 22:44:17', 8.5, 0.06, 1);
  S.run(5, '2026-04-17', 'tex-sea', '1' + MOJI_STAR, null, 6.5, '2026-04-17 22:44:23', 6.5, 0.02, 1);
  S.run(6, '2026-04-17', 'sd-laa', '1' + MOJI_STAR, null, null, null, -130, 0.03, 1);
  // Rows that must NOT move.
  S.run(7, '2026-04-20', 'aaa-bbb', '2' + STAR, null, null, null, -110, 0.05, 1);
  S.run(8, '2026-04-18', 'tb-pit', 'unrated', null, -150, null, -150, 2, 0);
  S.run(9, '2026-04-26', 'phi-atl', 'unrated', null, -150, null, -150, 5, 0);
  S.run(10, '2026-07-01', 'ccc-ddd', null, null, null, null, -105, 0.03, 1);
  // A damaged note, and a clean one of the same kind.
  S.run(11, '2026-04-19', 'eee-fff', null,
    'Model ml at rerun: -160, mkt=-150 ' + MOJI_DASH + ' edge no longer meets threshold.',
    null, null, -150, 0.01, 0);
  S.run(12, '2026-07-02', 'ggg-hhh', null,
    'Model ml at rerun: 102, mkt=111 ' + DASH + ' edge no longer meets threshold.',
    null, null, 111, 0.01, 0);
  const A = db.prepare('INSERT INTO bet_signal_audit (signal_id, game_date, game_id, action, '
    + 'source, detail, created_at) VALUES (?,?,?,?,?,?,?)');
  A.run(11, '2026-04-19', 'eee-fff', 'deactivate', 'processGameSignals',
    'Model ml at rerun: -160, mkt=-150 ' + MOJI_DASH + ' edge no longer meets threshold.',
    '2026-04-19 12:00:00');
  A.run(12, '2026-07-02', 'ggg-hhh', 'deactivate', 'processGameSignals',
    'Model ml at rerun: 102, mkt=111 ' + DASH + ' edge no longer meets threshold.',
    '2026-07-02 12:00:00');
  return db;
}

function main() {
  expect('the migration is registered', !!MIG, MIG ? MIG.name : 'MISSING');
  if (!MIG) return failed;

  const db = seed();
  const before = db.prepare('SELECT COUNT(*) n FROM bet_signals WHERE signal_label LIKE ?')
    .get('%' + MOJI_STAR).n;
  expect('seed has the 6 damaged labels', before === 6, before + ' row(s)');

  db.exec(MIG.sql);

  console.log('\n1. the six star labels are restored');
  const labels = db.prepare('SELECT id, signal_label FROM bet_signals WHERE id <= 6 ORDER BY id').all();
  const want = ['2' + STAR, '3' + STAR, '1' + STAR, '3' + STAR, '1' + STAR, '1' + STAR];
  expect('all six now read as clean stars',
    labels.every((r, i) => r.signal_label === want[i]),
    labels.map(r => r.signal_label).join(' '));
  expect('the digit is preserved per row (not defaulted to one tier)',
    labels[1].signal_label === '3' + STAR && labels[2].signal_label === '1' + STAR);
  expect('no mojibake label remains',
    db.prepare('SELECT COUNT(*) n FROM bet_signals WHERE signal_label LIKE ?')
      .get('%' + MOJI_STAR).n === 0);

  console.log('\n2. what must NOT move, did not');
  expect('an already-clean star is untouched',
    db.prepare('SELECT signal_label FROM bet_signals WHERE id=7').get().signal_label === '2' + STAR);
  expect('both `unrated` rows are left alone',
    db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_label='unrated'").get().n === 2);
  expect('NULL labels stay NULL',
    db.prepare('SELECT signal_label FROM bet_signals WHERE id=10').get().signal_label === null);
  const locked = db.prepare('SELECT market_line, edge_pct, bet_line, bet_locked_at '
    + 'FROM bet_signals WHERE id=1').get();
  expect('no BASELINE field moved on a bet-locked row',
    locked.market_line === -110 && locked.edge_pct === 0.04
    && locked.bet_line === 122 && locked.bet_locked_at === '2026-04-17 19:42:13');

  console.log('\n3. the em dash is repaired in both columns');
  expect('the damaged note is readable',
    db.prepare('SELECT notes FROM bet_signals WHERE id=11').get().notes
      === 'Model ml at rerun: -160, mkt=-150 ' + DASH + ' edge no longer meets threshold.');
  expect('the clean note is byte-identical afterwards',
    db.prepare('SELECT notes FROM bet_signals WHERE id=12').get().notes
      === 'Model ml at rerun: 102, mkt=111 ' + DASH + ' edge no longer meets threshold.');
  expect('the audit detail is repaired too',
    db.prepare('SELECT detail FROM bet_signal_audit WHERE signal_id=11 AND action=?')
      .get('deactivate').detail.indexOf(MOJI_DASH) === -1);

  console.log('\n4. the post-lock carve-out is auditable');
  const audits = db.prepare("SELECT * FROM bet_signal_audit WHERE action='label_repaired' "
    + 'ORDER BY signal_id').all();
  expect('one audit row per repaired signal', audits.length === 6, audits.length + ' row(s)');
  expect('the audit names the migration',
    audits.every(a => a.source === 'v6-mojibake-repair-001'));
  expect('the audit records the before and after',
    audits[0].detail.indexOf(MOJI_STAR) !== -1 && audits[0].detail.indexOf('2' + STAR) !== -1,
    audits[0].detail);

  console.log('\n5. idempotent: a second apply changes nothing');
  const snap = () => JSON.stringify([
    db.prepare('SELECT id, signal_label, notes FROM bet_signals ORDER BY id').all(),
    db.prepare('SELECT COUNT(*) n FROM bet_signal_audit').get().n,
  ]);
  const a = snap();
  db.exec(MIG.sql);
  const b = snap();
  expect('re-running the SQL is a no-op on rows AND on audit count', a === b);
  expect('...and still exactly 6 label_repaired audit rows (no duplicates)',
    db.prepare("SELECT COUNT(*) n FROM bet_signal_audit WHERE action='label_repaired'").get().n === 6);

  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
