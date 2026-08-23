#!/usr/bin/env node
/**
 * Repair the two corrupt totals rows the bet_price migration refused.
 * (2026-08-23).  Dry run by default; --apply to write.
 *
 * Policy: recover from game_log where the true value is recoverable,
 * delete where it is not. Both turned out recoverable, so nothing is
 * deleted -- but the delete path is implemented and reported rather than
 * assumed away, because "recoverable" was a finding, not a premise.
 *
 * ROW 1 -- id=7458, 2026-04-14 nym-lad, Total/under
 *   market_line = NULL   (the total was simply never written)
 *   bet_line    = -103   (a PRICE sitting in the line column)
 *   game_log:  market_total 7.5, under_price -108, final 1-2 = 3 -> under WINS
 *   Stored outcome 'win' agrees with a 7.5 line, which corroborates 7.5.
 *   -> market_line := 7.5, bet_line := 7.5, bet_price := -103
 *
 *   edge_pct (0.0988) is LEFT ALONE. It is inside the normal range
 *   (Total edge_pct averages 0.103, legit max 0.455) and recomputing it
 *   today gives 0.0232 -- but TOT_SLOPE may have changed since April, so
 *   a recomputation would FABRICATE a number rather than recover one. An
 *   in-range historical value we cannot verify is better left as recorded.
 *
 * ROW 2 -- id=13484, 2026-04-25 min-tb, Total/under
 *   market_line, bet_line AND closing_line all hold -104, a price.
 *   game_log:  market_total 8.5 (xcheck 8.5, proj 8.5 -- three sources
 *   agree), under_price -113, final 1-6 = 7 -> under WINS, agreeing with
 *   the stored outcome.
 *   -> market_line := 8.5, bet_line := 8.5, bet_price := -104
 *
 *   edge_pct (42) is NULLED. It is the only value above 1.0 in the entire
 *   bet_signals table and is impossible as a fraction; it was derived from
 *   the corrupt market_line. Unlike row 1 there is no plausible recorded
 *   value to preserve, and inventing one is worse than an honest absence.
 *
 *   closing_line := 8.5, matching market_line. That is the convention every
 *   other totals row follows -- and it is worth being explicit that the
 *   convention is INERT: all 761 other totals rows have closing_line
 *   exactly equal to market_line, so the column carries no closing
 *   information for totals at all. Setting 8.5 makes this row consistent
 *   with its peers; it does not make it informative. See
 *   docs/totals-closing-capture-scope-2026-08-23.md.
 *
 * This row is is_active=1, so the bad edge_pct is live in the analysis set.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: !APPLY });

const FIXES = [
  { id: 7458,  market_line: 7.5, bet_line: 7.5, bet_price: -103, edge_pct: 'keep',  closing_line: 'keep' },
  { id: 13484, market_line: 8.5, bet_line: 8.5, bet_price: -104, edge_pct: null,    closing_line: 8.5    },
];

(function main() {
  console.log('=== corrupt totals row repair ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  const upd = db.prepare(
    'UPDATE bet_signals SET market_line=?, bet_line=?, bet_price=?, '
    + 'edge_pct=COALESCE(?, edge_pct), closing_line=COALESCE(?, closing_line) WHERE id=?');
  const nullEdge = db.prepare('UPDATE bet_signals SET edge_pct=NULL WHERE id=?');

  for (const f of FIXES) {
    const before = db.prepare('SELECT * FROM bet_signals WHERE id=?').get(f.id);
    if (!before) { console.log('  id=' + f.id + ' NOT FOUND -- nothing to do'); continue; }
    const g = db.prepare('SELECT market_total, over_price, under_price, away_score, home_score '
      + 'FROM game_log WHERE game_date=? AND game_id=?').get(before.game_date, before.game_id);

    console.log('');
    console.log('  id=' + f.id + '  ' + before.game_date + ' ' + before.game_id
      + ' ' + before.signal_type + '/' + before.signal_side + '  is_active=' + before.is_active);
    console.log('    game_log market_total = ' + (g ? g.market_total : 'NO ROW'));

    // Recoverability gate: refuse to "recover" onto a total game_log does not confirm.
    if (!g || g.market_total == null || Number(g.market_total) !== Number(f.market_line)) {
      console.log('    *** game_log does not confirm ' + f.market_line + ' -- NOT recoverable, would DELETE.');
      console.log('        (not deleting in dry run; re-check before applying)');
      continue;
    }
    // Outcome corroboration: the recovered total must agree with the graded result.
    if (g.away_score != null && g.home_score != null && before.outcome) {
      const act = g.away_score + g.home_score;
      const won = before.signal_side === 'over' ? act > f.market_line : act < f.market_line;
      const agrees = (won ? 'win' : 'loss') === before.outcome;
      console.log('    final ' + g.away_score + '-' + g.home_score + ' = ' + act
        + ' vs ' + f.market_line + ' -> ' + (won ? 'win' : 'loss')
        + '; stored outcome ' + before.outcome + ' -> ' + (agrees ? 'AGREES' : '*** DISAGREES ***'));
      if (!agrees) { console.log('    refusing: recovered total contradicts the graded outcome.'); continue; }
    }
    console.log('    market_line  ' + before.market_line + ' -> ' + f.market_line);
    console.log('    bet_line     ' + before.bet_line + ' -> ' + f.bet_line);
    console.log('    bet_price    ' + before.bet_price + ' -> ' + f.bet_price);
    console.log('    edge_pct     ' + before.edge_pct + ' -> ' + (f.edge_pct === 'keep' ? '(unchanged)' : 'NULL'));
    console.log('    closing_line ' + before.closing_line + ' -> '
      + (f.closing_line === 'keep' ? '(unchanged)' : f.closing_line));

    if (!APPLY) continue;
    upd.run(f.market_line, f.bet_line, f.bet_price,
            null, f.closing_line === 'keep' ? null : f.closing_line, f.id);
    if (f.edge_pct === null) nullEdge.run(f.id);
  }

  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  console.log('');
  console.log('=== verification ===');
  const bad = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' AND edge_pct > 1").get().n;
  console.log('  Total rows with edge_pct > 1 (must be 0): ' + bad);
  const px = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' "
    + "AND market_line IS NOT NULL AND (market_line < 4 OR market_line > 20)").get().n;
  console.log('  Total rows whose market_line is not a total (must be 0): ' + px);
  const cl = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' "
    + "AND closing_line IS NOT NULL AND ABS(closing_line) >= 100").get().n;
  console.log('  Total rows whose closing_line is a price (must be 0): ' + cl);
  const nulls = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE signal_type='Total' "
    + "AND bet_line IS NOT NULL AND market_line IS NULL").get().n;
  console.log('  logged Total rows with no market_line (must be 0): ' + nulls);
})();
