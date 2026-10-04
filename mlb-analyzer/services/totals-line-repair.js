'use strict';
// Totals line/price repair for 37 early-season logged Totals (2026-10-04).
// Used by POST /api/admin/totals-line-repair (routes/totals-line-repair.js).
//
// WHAT IS WRONG. On production, 37 logged Totals from 2026-04-09..05-08 hold
// the PRICE in bet_line (-110, +125, ...) and nothing in bet_price. Today's
// grader reads bet_line as the total (services/model.js calcPnl, "the struck
// line wins", 2026-09-23), so any regrade of those dates would grade them
// against a total of -110: 24 of the 37 would flip outcome. Their CURRENT
// outcomes are all right (graded before that rule, at market_line); 11 P&L
// amounts are wrong (stake from the market's price, not the operator's).
//
// THE CORRECTION IS THE ONE THE LOCAL COPY ALREADY HAS:
//   - 35 rows: scripts/backfill-totals-bet-price.js -- bet_price := the price
//     in bet_line, bet_line := market_line (the emit-time total, post-lock
//     immutable, the number on the card when the bet was logged).
//   - 7458 and 13484: scripts/fix-corrupt-totals-rows.js, the two that script
//     refused. 7458 has no market_line (total 7.5 recovered from game_log);
//     13484 holds -104 in market_line, bet_line and closing_line and an
//     edge_pct of 42 (total 8.5 recovered from game_log, edge_pct nulled).
// Those scripts open data/mlb.db by path, so they only ever ran locally
// (scripts/refresh-analysis-db.sh re-applies them after each refresh). This
// is the same correction, for production.
//
// MODES
//   diff  (default)  per id: current, expected and target values, and whether
//                    apply would write or skip it. Writes NOTHING.
//   apply            compare-and-set, per row: writes only when the row still
//                    holds EXACTLY the expected current values (and is the
//                    expected game and side); otherwise skips it and says why.
//                    A row already at its target is skipped, so a second apply
//                    writes nothing.
//
// WRITES ONLY the listed columns of the listed ids (bet_line, bet_price; for
// 7458 also market_line; for 13484 also market_line, closing_line, edge_pct),
// plus one bet_signal_audit row per changed bet. It NEVER grades and never
// recalculates P&L or CLV: outcome and pnl are left for the grade run
// (POST /api/admin/game-log-repair mode 'grade'), which then reads the
// corrected line and price. It requires nothing; the db is injected.

const SOURCE = 'admin_totals_line_repair';
const ACTION = 'totals_line_repair';

// [id, game_date, game_id, side, price now in bet_line, market_line (the total)]
// Values read from production on 2026-10-04 (/api/games/:date), bet_price NULL on all 37.
const BACKFILL_35 = [
  [5639, '2026-04-09', 'ari-nym', 'over', -110, 6.5],
  [5641, '2026-04-09', 'cws-kc', 'under', -108, 9.5],
  [5777, '2026-04-10', 'pit-chc', 'over', -113, 6.5],
  [6002, '2026-04-11', 'pit-chc', 'over', -113, 6.5],
  [7133, '2026-04-13', 'hou-sea', 'under', -103, 8],
  [7134, '2026-04-13', 'chc-phi', 'over', -110, 8.5],
  [7140, '2026-04-13', 'nym-lad', 'under', -100, 8.5],
  [7262, '2026-04-14', 'kc-det', 'over', -100, 7.5],
  [7739, '2026-04-14', 'chc-phi', 'over', -127, 9.5],
  [8002, '2026-04-15', 'cle-stl', 'over', -108, 9],
  [8047, '2026-04-15', 'chc-phi', 'over', -108, 8.5],
  [9194, '2026-04-17', 'kc-nyy', 'over', -110, 7.5],
  [9203, '2026-04-17', 'cin-min', 'under', -110, 8.5],
  [9204, '2026-04-17', 'tex-sea', 'under', -110, 6.5],
  [9542, '2026-04-18', 'cin-min', 'under', -110, 8.5],
  [9543, '2026-04-18', 'tb-pit', 'over', 125, 7.5],
  [9547, '2026-04-18', 'det-bos', 'under', -105, 6.5],
  [9556, '2026-04-18', 'lad-col', 'under', -113, 10.5],
  [9558, '2026-04-18', 'sd-laa', 'under', -113, 9.5],
  [11196, '2026-04-21', 'min-nym', 'under', -108, 7.5],
  [11508, '2026-04-21', 'nyy-bos', 'under', -104, 8.5],
  [13378, '2026-04-25', 'was-cws', 'under', -117, 8.5],
  [13492, '2026-04-26', 'ath-tex', 'over', -113, 8.5],
  [13552, '2026-04-26', 'min-tb', 'under', -113, 8.5],
  [13585, '2026-04-26', 'laa-kc', 'under', -104, 8.5],
  [13688, '2026-04-27', 'tb-cle', 'under', -113, 8.5],
  [13820, '2026-04-27', 'sea-min', 'under', 104, 8.5],
  [14122, '2026-04-28', 'hou-bal', 'under', -125, 9.5],
  [14126, '2026-04-28', 'sea-min', 'under', -103, 7.5],
  [14128, '2026-04-28', 'nyy-tex', 'over', 110, 7.5],
  [14479, '2026-04-29', 'laa-cws', 'under', -103, 8.5],
  [14706, '2026-04-30', 'sf-phi-g2', 'over', 100, 7.5],
  [15334, '2026-05-01', 'ari-chc', 'over', -110, 7.5],
  [16299, '2026-05-02', 'ari-chc', 'over', 100, 7.5],
  [18965, '2026-05-08', 'col-phi', 'over', 107, 7.5],
];

// expected: every column apply compares before writing (market_line is compared
// for all 37 even where it is not written: it is where the target total comes
// from). target: exactly the columns apply writes.
const FIXES = BACKFILL_35.map(([id, game_date, game_id, side, price, total]) => ({
  id, game_date, game_id, side, script: 'backfill-totals-bet-price',
  expected: { bet_line: price, bet_price: null, market_line: total },
  target: { bet_line: total, bet_price: price },
})).concat([
  { id: 7458, game_date: '2026-04-14', game_id: 'nym-lad', side: 'under', script: 'fix-corrupt-totals-rows',
    expected: { bet_line: -103, bet_price: null, market_line: null, closing_line: null, edge_pct: 0.0988 },
    target: { market_line: 7.5, bet_line: 7.5, bet_price: -103 } },             // edge_pct and closing_line kept, as the script did
  { id: 13484, game_date: '2026-04-25', game_id: 'min-tb', side: 'under', script: 'fix-corrupt-totals-rows',
    expected: { bet_line: -104, bet_price: null, market_line: -104, closing_line: -104, edge_pct: 42 },
    target: { market_line: 8.5, bet_line: 8.5, bet_price: -104, closing_line: 8.5, edge_pct: null } },
]).sort((a, b) => a.id - b.id);

const COLS = ['bet_line', 'bet_price', 'market_line', 'closing_line', 'edge_pct'];
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k] == null ? null : row[k]]));

// -> { action: 'write' | 'skip', reason, current }
function classify(db, f) {
  const row = db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(f.id);
  if (!row) return { action: 'skip', reason: 'no bet_signals row with this id', current: null };
  const keys = [...new Set(Object.keys(f.expected).concat(Object.keys(f.target)))];
  const current = Object.assign({ game_date: row.game_date, game_id: row.game_id, signal_type: row.signal_type, signal_side: row.signal_side }, pick(row, keys));
  if (row.game_date !== f.game_date || row.game_id !== f.game_id || row.signal_type !== 'Total' || row.signal_side !== f.side) {
    return { action: 'skip', reason: 'not the expected bet (' + [row.game_date, row.game_id, row.signal_type, row.signal_side].join(' ') + ')', current };
  }
  if (Object.entries(f.target).every(([k, v]) => same(row[k], v))) return { action: 'skip', reason: 'already repaired (holds the target values)', current };
  const off = Object.entries(f.expected).filter(([k, v]) => !same(row[k], v)).map(([k, v]) => k + '=' + row[k] + ' (expected ' + v + ')');
  if (off.length) return { action: 'skip', reason: 'current values differ from expected: ' + off.join(', '), current };
  return { action: 'write', reason: null, current };
}

function parseRequest(body) {
  const mode = (body && body.mode) || 'diff';
  if (!['diff', 'apply'].includes(mode)) return { error: 'mode must be diff or apply' };
  return { mode };
}

// deps: { db }. Synchronous; the route runs it through the serial job queue.
function run(body, deps) {
  const p = parseRequest(body);
  if (p.error) return { error: p.error };
  const db = deps.db;
  const items = FIXES.map(f => Object.assign({ id: f.id, game_date: f.game_date, game_id: f.game_id, side: f.side, script: f.script,
    expected: f.expected, target: f.target }, classify(db, f)));
  const out = { mode: p.mode, ids: FIXES.length };
  if (p.mode === 'diff') {
    out.would_write = items.filter(i => i.action === 'write').length;
    out.would_skip = items.length - out.would_write;
    out.items = items;
    return out;
  }
  const written = [], skipped = [];
  const tx = db.transaction(() => {
    for (const f of FIXES) {
      const c = classify(db, f);                                      // re-read inside the transaction
      if (c.action !== 'write') { skipped.push({ id: f.id, game_date: f.game_date, game_id: f.game_id, reason: c.reason }); continue; }
      const setCols = Object.keys(f.target);
      const whereCols = Object.keys(f.expected);
      // Compare-and-set in SQL too: the WHERE repeats every expected value.
      const sql = 'UPDATE bet_signals SET ' + setCols.map(k => k + ' = @t_' + k).join(', ')
        + ' WHERE id = @id AND ' + whereCols.map(k => k + ' IS @e_' + k).join(' AND ');
      const params = { id: f.id };
      for (const k of setCols) params['t_' + k] = f.target[k];
      for (const k of whereCols) params['e_' + k] = f.expected[k];
      const r = db.prepare(sql).run(params);
      if (r.changes !== 1) { skipped.push({ id: f.id, game_date: f.game_date, game_id: f.game_id, reason: 'compare-and-set matched ' + r.changes + ' rows' }); continue; }
      const after = db.prepare('SELECT * FROM bet_signals WHERE id = ?').get(f.id);
      db.prepare('INSERT INTO bet_signal_audit (signal_id, game_date, game_id, signal_type, signal_side, action, bet_line, closing_line, clv, source, detail) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        f.id, f.game_date, f.game_id, 'Total', f.side, ACTION, after.bet_line, after.closing_line, after.clv, SOURCE,
        JSON.stringify({ before: pick(c.current, COLS.filter(k => k in c.current)), after: pick(after, Object.keys(f.target)), per: f.script }));
      written.push({ id: f.id, game_date: f.game_date, game_id: f.game_id, before: c.current, after: pick(after, Object.keys(f.target)) });
    }
  });
  tx();
  out.written = written.length;
  out.skipped = skipped.length;
  out.written_items = written;
  out.skipped_items = skipped;
  return out;
}

module.exports = { run, parseRequest, FIXES, SOURCE, ACTION };
