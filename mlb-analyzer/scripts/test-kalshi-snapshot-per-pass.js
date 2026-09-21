// Kalshi market snapshots keep one row per PASS, and an evening pass for
// tomorrow does not delete today's rows.
//
// THE TICKET: docs/kalshi-totals-snapshot-per-pass-open-question-2026-09-17.md
//
// Two defects, one shape, three tables. The helpers cleared with
//
//   DELETE FROM kalshi_*_markets_snapshot WHERE snapshot_date=?
//
// unscoped by game_date, and the key was (snapshot_date, game_date,
// game_id). The 8PM and 11PM PT passes price TOMORROW under TODAY's PT
// snapshot_date, so they deleted the game-day rows earlier passes had
// written. Measured on the analysis copy before this change:
//
//   table    rows   same-day   day-before
//   totals   1125         14         1111
//   ml       1203         13         1190
//   spread   7602         84         7518
//
// Same-day presence of 14 of 1125 is not Kalshi's behaviour, it is the
// clear. services/empirical-spread-roi.js wants exactly those rows.
//
// THE FIX, in two parts:
//   1. the clear is scoped to (snapshot_date, game_date), so one PT day
//      can hold both slates -- the PK already carries game_date, so
//      nothing collides;
//   2. three new *_markets_log tables keyed (game_date, game_id,
//      captured_at), never cleared, written in the same transaction.
//
// The *_snapshot tables keep their shape and their writes:
// services/clv-stats.js, services/baserunning-backtest.js and
// services/empirical-spread-roi.js read them by that key. Re-keying in
// place would have meant migrating three consumers, or inventing a
// captured_at for rows whose pass time is not recoverable.
//
// Synthetic dates 2999-04-0x; every write is undone in the finally
// block. Takes `db` from db/schema -- never a second write connection.
//
// Run: node --max-old-space-size=1536 scripts/test-kalshi-snapshot-per-pass.js

const { db, q } = require('../db/schema');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const SNAP = '2999-04-01';        // the PT day every pass below runs on
const D0 = '2999-04-01';          // today's slate
const D1 = '2999-04-02';          // tomorrow's slate, priced by the evening pass
const G0 = 'zzk-zzl';
const G1 = 'zzm-zzn';

const PASS_A = '2999-04-01 08:00:00';   // morning, today's slate
const PASS_B = '2999-04-01 15:00:00';   // afternoon, today's slate, line moved
const PASS_C = '2999-04-01 20:00:00';   // evening, TOMORROW's slate

function cleanup() {
  for (const t of ['kalshi_totals_markets_snapshot', 'kalshi_ml_markets_snapshot',
                   'kalshi_spread_markets_snapshot', 'kalshi_totals_markets_log',
                   'kalshi_ml_markets_log', 'kalshi_spread_markets_log']) {
    try { db.prepare('DELETE FROM ' + t + ' WHERE snapshot_date=?').run(SNAP); } catch (e) {}
  }
}

const totalsRow = (gd, gid, line) => ({
  game_date: gd, game_id: gid, market_line: line,
  over_ask_dollars: 0.52, under_ask_dollars: 0.50,
  over_price_ml: -108, under_price_ml: -100,
});
const mlRow = (gd, gid, away) => ({
  game_date: gd, game_id: gid, away_ask_dollars: away, home_ask_dollars: 1 - away,
  away_ask_ml: -120, home_ask_ml: 105, volume_24h_away: 10, volume_24h_home: 11,
});
const spreadRow = (gd, gid, line) => ({
  game_date: gd, game_id: gid, spread_team: 'SEA', spread_line: line,
  yes_ask_dollars: 0.55, yes_bid_dollars: 0.53, no_ask_dollars: 0.47,
  no_bid_dollars: 0.45, yes_ask_ml: -122, no_ask_ml: 112, volume_24h: 9,
});

function logRows(tbl, gd, gid) {
  return db.prepare('SELECT * FROM ' + tbl + ' WHERE game_date=? AND game_id=? '
    + 'ORDER BY captured_at').all(gd, gid);
}
function snapRows(tbl, gd) {
  return db.prepare('SELECT * FROM ' + tbl + ' WHERE snapshot_date=? AND game_date=?')
    .all(SNAP, gd);
}

function main() {
  cleanup();
  try {
    // ---------------------------------------------------------------
    console.log('\n1. captured_at is required and validated, never defaulted');
    const bad = [undefined, null, '', '2999-04-01', new Date(),
      '2999-04-01T08:00:00', '2999-04-01 08:00'];
    let threwAll = true;
    for (const v of bad) {
      try { q.snapshotKalshiTotalsMarkets(SNAP, v, []); threwAll = false; }
      catch (e) { /* expected */ }
    }
    expect('every malformed capturedAt throws', threwAll,
      'tested ' + bad.length + ' shapes incl. date-only, ISO-T and a Date');
    let msg = '';
    try { q.snapshotKalshiTotalsMarkets(SNAP, 'nope', []); } catch (e) { msg = e.message; }
    expect('the error names the helper and the expected form',
      /snapshotKalshiTotalsMarkets/.test(msg) && /YYYY-MM-DD HH:MM:SS/.test(msg));
    expect('...and says why defaulting would be wrong',
      /re-collapse every pass/.test(msg));

    // ---------------------------------------------------------------
    console.log('\n2. two passes on the same slate keep TWO observations');
    q.snapshotKalshiTotalsMarkets(SNAP, PASS_A, [totalsRow(D0, G0, 8.5)]);
    q.snapshotKalshiTotalsMarkets(SNAP, PASS_B, [totalsRow(D0, G0, 9.0)]);
    const tl = logRows('kalshi_totals_markets_log', D0, G0);
    expect('totals log holds 2 rows for the game', tl.length === 2, tl.length + ' row(s)');
    expect('both pass times are recorded',
      tl[0].captured_at === PASS_A && tl[1].captured_at === PASS_B,
      tl.map(r => r.captured_at).join(' | '));
    expect('the LINE MOVE is visible (8.5 -> 9.0)',
      tl[0].market_line === 8.5 && tl[1].market_line === 9.0,
      tl.map(r => r.market_line).join(' -> '));
    const ts = snapRows('kalshi_totals_markets_snapshot', D0);
    expect('the day snapshot still holds exactly one row (last pass wins)',
      ts.length === 1 && ts[0].market_line === 9.0,
      ts.length + ' row(s), line ' + (ts[0] && ts[0].market_line));

    // ---------------------------------------------------------------
    console.log("\n3. the ticket's acceptance check: an evening D+1 pass leaves D intact");
    q.snapshotKalshiTotalsMarkets(SNAP, PASS_C, [totalsRow(D1, G1, 7.5)]);
    expect("today's snapshot row SURVIVED the evening pass for tomorrow",
      snapRows('kalshi_totals_markets_snapshot', D0).length === 1);
    expect("tomorrow's snapshot row was written under the same snapshot_date",
      snapRows('kalshi_totals_markets_snapshot', D1).length === 1);
    expect("today's log rows are untouched",
      logRows('kalshi_totals_markets_log', D0, G0).length === 2);
    expect('the log distinguishes the two slates',
      logRows('kalshi_totals_markets_log', D1, G1).length === 1);

    // A re-run of the SAME pass must not duplicate: captured_at is in
    // the PK, so it replaces.
    q.snapshotKalshiTotalsMarkets(SNAP, PASS_B, [totalsRow(D0, G0, 9.0)]);
    expect('re-running an identical pass does not duplicate a log row',
      logRows('kalshi_totals_markets_log', D0, G0).length === 2);

    // ---------------------------------------------------------------
    console.log('\n4. ML and SPREAD share the shape, so they get the same treatment');
    q.snapshotKalshiMlMarkets(SNAP, PASS_A, [mlRow(D0, G0, 0.55)]);
    q.snapshotKalshiMlMarkets(SNAP, PASS_B, [mlRow(D0, G0, 0.60)]);
    q.snapshotKalshiMlMarkets(SNAP, PASS_C, [mlRow(D1, G1, 0.48)]);
    const ml = logRows('kalshi_ml_markets_log', D0, G0);
    expect('ml log holds 2 observations', ml.length === 2, ml.length + ' row(s)');
    expect('ml move is visible', ml[0].away_ask_dollars === 0.55 && ml[1].away_ask_dollars === 0.60);
    expect("ml: today's snapshot survived the evening pass",
      snapRows('kalshi_ml_markets_snapshot', D0).length === 1);

    q.snapshotKalshiSpreads(SNAP, PASS_A, [spreadRow(D0, G0, -1.5)]);
    q.snapshotKalshiSpreads(SNAP, PASS_B, [spreadRow(D0, G0, -1.5)]);
    q.snapshotKalshiSpreads(SNAP, PASS_C, [spreadRow(D1, G1, -1.5)]);
    const sp = logRows('kalshi_spread_markets_log', D0, G0);
    expect('spread log holds 2 observations for the same line', sp.length === 2,
      sp.length + ' row(s)');
    expect("spread: today's snapshot survived the evening pass",
      snapRows('kalshi_spread_markets_snapshot', D0).length === 1);
    // The spread PK also carries team+line, so two lines in one pass are
    // two rows rather than one overwriting the other.
    q.snapshotKalshiSpreads(SNAP, PASS_B,
      [spreadRow(D0, G0, -1.5), spreadRow(D0, G0, 1.5)]);
    expect('two spread lines in one pass are two log rows',
      logRows('kalshi_spread_markets_log', D0, G0).length === 3,
      logRows('kalshi_spread_markets_log', D0, G0).length + ' row(s)');

    // ---------------------------------------------------------------
    console.log('\n5. the clears are scoped in the SQL, not just in the helper');
    for (const stmt of ['_snapKalshiTotalsClearDate', '_snapKalshiMlClearDate',
                        '_snapKalshiSpreadsClearDate']) {
      const src = q[stmt] && q[stmt].source;
      expect(stmt + ' is scoped by game_date',
        !!src && /snapshot_date=\?\s+AND\s+game_date=\?/.test(src),
        src ? src.replace(/\s+/g, ' ').slice(0, 76) : 'missing');
    }
    // The log tables must have no clear at all -- they are the history.
    const clears = Object.keys(q).filter(k => {
      const src = q[k] && q[k].source;
      return typeof src === 'string' && /DELETE FROM kalshi_\w+_markets_log/.test(src);
    });
    expect('no helper deletes from a *_markets_log table', clears.length === 0,
      clears.join(', ') || 'none');
  } finally {
    cleanup();
  }
  return failed;
}

const f = main();
console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
process.exit(f === 0 ? 0 : 1);
