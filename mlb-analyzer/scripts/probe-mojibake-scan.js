// Scan every TEXT column in the DB for double-decode damage.
//
// docs/mojibake-star-labels-open-question-2026-09-17.md item (3):
//
//   "The interesting question is not the 6 rows, it is whether the path
//    that mangled them still exists and touches anything else. [...]
//    Worth doing (3) before (1), because repairing the symptom removes
//    the evidence."
//
// So this runs BEFORE any repair migration.
//
// WHAT DAMAGE LOOKS LIKE. UTF-8 read as Latin-1 turns one multi-byte
// character into two or three: 'star' (E2 98 85) becomes 'â..', and the
// common accented letters become 'Ã' + one more. The tells, in rough
// order of confidence:
//
//   U+FFFD             a replacement char -- bytes already lost
//   'Ã' + Latin-1      Ã© Ã¡ Ã³ Ã± ... the accented-name signature
//   'â' + non-letter   the E2-prefixed punctuation/symbol signature
//   lone 'â' at end    the star case: E2 kept, 98 85 dropped
//
// A bare 'â' inside a word is NOT damage -- it is a legitimate letter in
// Portuguese and Vietnamese names, so the patterns below require it to
// be followed by something that cannot start a word, or to be terminal.
//
// Read-only. Run:
//   node --max-old-space-size=1536 scripts/probe-mojibake-scan.js

const Database = require('better-sqlite3');
const db = new Database('data/mlb.db', { readonly: true });

// Ordered most- to least- confident. Each returns a reason string.
const TESTS = [
  { name: 'U+FFFD replacement char', re: /�/ },
  { name: 'Ã + Latin-1 (accent double-decode)', re: /Ã[-¿]/ },
  { name: 'â + symbol/punct (E2 double-decode)', re: /â[- -/†-⃿]/ },
  { name: 'terminal lone â (the star case)', re: /â$/ },
  { name: 'Â followed by anything (C2 double-decode)', re: /Â[-¿ -~]/ },
];

function textColumns() {
  const out = [];
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);
  for (const t of tables) {
    let cols;
    try { cols = db.prepare('PRAGMA table_info(' + t + ')').all(); } catch (e) { continue; }
    for (const c of cols) {
      const ty = String(c.type || '').toUpperCase();
      if (ty.includes('CHAR') || ty.includes('TEXT') || ty.includes('CLOB') || ty === '') {
        out.push({ table: t, col: c.name });
      }
    }
  }
  return out;
}

function main() {
  const cols = textColumns();
  console.log('scanning ' + cols.length + ' TEXT-ish columns across '
    + new Set(cols.map(c => c.table)).size + ' tables\n');

  const hits = [];
  let scanned = 0;
  for (const { table, col } of cols) {
    let rows;
    try {
      // Bounded: only rows containing one of the two lead bytes, so this
      // stays a scan and not a full table materialisation (CLAUDE.md's
      // 2GB rule -- accumulate scalars, not row arrays).
      rows = db.prepare(
        'SELECT "' + col + '" AS v, COUNT(*) AS n FROM "' + table + '" '
        + 'WHERE "' + col + '" LIKE ? OR "' + col + '" LIKE ? OR "' + col + '" LIKE ? '
        + 'GROUP BY 1'
      ).all('%â%', '%Ã%', '%�%');
    } catch (e) { continue; }
    scanned++;
    for (const r of rows) {
      if (r.v == null) continue;
      const t = TESTS.find(x => x.re.test(r.v));
      if (t) hits.push({ table, col, value: r.v, n: r.n, reason: t.name });
    }
  }

  console.log('columns successfully scanned: ' + scanned);
  console.log('DAMAGED DISTINCT VALUES FOUND: ' + hits.length + '\n');

  if (!hits.length) {
    console.log('  none. The 6 signal_label rows are the whole of it, which');
    console.log('  means the mangling path did not touch anything else here.');
  } else {
    const byTable = {};
    for (const h of hits) {
      const k = h.table + '.' + h.col;
      (byTable[k] = byTable[k] || []).push(h);
    }
    for (const k of Object.keys(byTable).sort()) {
      const rowsAffected = byTable[k].reduce((a, h) => a + h.n, 0);
      console.log('  ' + k + '   ' + byTable[k].length + ' distinct value(s), '
        + rowsAffected + ' row(s)');
      for (const h of byTable[k].slice(0, 8)) {
        console.log('      ' + JSON.stringify(h.value).slice(0, 60)
          + '  x' + h.n + '   [' + h.reason + ']');
      }
    }
  }

  // The specific population the ticket is about, for the repair's filter.
  console.log('\n--- bet_signals.signal_label distribution ---');
  for (const r of db.prepare(
    'SELECT signal_label, COUNT(*) n FROM bet_signals GROUP BY 1 ORDER BY n DESC').all()) {
    console.log('  ' + JSON.stringify(r.signal_label).padEnd(14) + ' ' + r.n);
  }

  console.log('\n--- the 2 `unrated` rows, which are a separate decision ---');
  for (const r of db.prepare(
    "SELECT game_date, game_id, signal_type, signal_side, edge_pct, is_active, bet_line "
    + "FROM bet_signals WHERE signal_label='unrated' ORDER BY game_date").all()) {
    console.log('  ' + r.game_date + ' ' + String(r.game_id).padEnd(10)
      + ' ' + String(r.signal_type).padEnd(7) + ' ' + String(r.signal_side).padEnd(6)
      + ' edge=' + r.edge_pct + ' active=' + r.is_active
      + ' bet_line=' + (r.bet_line == null ? 'null' : r.bet_line));
  }

  console.log('\n--- date range of the mojibake rows vs the clean star era ---');
  for (const r of db.prepare(
    "SELECT CASE WHEN signal_label LIKE '%â' THEN 'mojibake' "
    + "WHEN signal_label IN ('1★','2★','3★') THEN 'clean star' "
    + "WHEN signal_label='unrated' THEN 'unrated' ELSE 'null' END AS grp, "
    + 'COUNT(*) n, MIN(game_date) first, MAX(game_date) last '
    + 'FROM bet_signals GROUP BY 1 ORDER BY 2 DESC').all()) {
    console.log('  ' + r.grp.padEnd(11) + ' n=' + String(r.n).padStart(4)
      + '  ' + r.first + ' .. ' + r.last);
  }
}

main();
