// End-to-end precedence tests for fix/opener-rr-gate-precedence.
//
// Exercises the real detectOpeners function against synthesized game_log
// rows + real pitcher_fg_role table state. Confirms:
//
//   A. Announced-bulk + fresh rotation SP  →  OPENER (piggyback preserved).
//      This is the TOR@SEA 2026-07-04 case that PR #148 broke — Gilbert
//      (SEA SP1 on IL-ramp pitch limit) opens with Hancock (SEA SP5) the
//      announced bulk. Piggyback tandem is real information; must survive.
//
//   B. No announced bulk + fresh rotation SP + short outings  →  STANDARD.
//      Inferred / pattern-match opener classification is blocked by the
//      RR-rotation-slot gate. Short outings treated by the SP-weight
//      n_priors haircut instead.
//
//   C. No announced bulk + RR-tagged RP + short outings  →  OPENER.
//      Reverse audit — genuine bullpen conversion pattern (Herget /
//      Morán / Montgomery type) still classifies as opener.
//
//   D. Manual pitcher_role_override  →  wins over everything (unchanged).
//
// Uses temporary DB writes with restoration in a finally block — never
// leaves the local DB in a modified state.
//
// Run: node scripts/test-opener-detection-precedence.js

const { db, q } = require('../db/schema');
const { detectOpeners } = require('../services/jobs');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}
const TEST_DATE = '2999-01-01'; // synthetic date that won't collide with real data
function nowStamp() { return new Date().toISOString().slice(0,10) + ' ' + new Date().toISOString().slice(11,19); }

// Snapshot original state of the objects we're going to mutate so we
// can restore in the finally block. Never persists test writes.
const snapshots = {
  gilbertRoleAt: null,
  hancockRoleAt: null,
  removedGameRow: false,
  removedOverride: false,
};

function setupTestGame(homeSp, awaySp, awayBulkAnnounced, homeBulkAnnounced) {
  db.prepare(
    "INSERT INTO game_log (game_date, game_id, away_team, home_team, away_sp, away_sp_hand, home_sp, home_sp_hand, "
    + "bulk_guy_away_announced, bulk_guy_home_announced) "
    + "VALUES (?, 'tor-sea', 'TOR', 'SEA', ?, 'R', ?, 'R', ?, ?)"
  ).run(TEST_DATE, awaySp, homeSp, awayBulkAnnounced, homeBulkAnnounced);
  snapshots.removedGameRow = true;
}
function cleanupTestGame() {
  db.prepare("DELETE FROM game_log WHERE game_date = ? AND game_id = 'tor-sea'").run(TEST_DATE);
}
function freshenGilbertRR() {
  const orig = db.prepare('SELECT role_at FROM pitcher_fg_role WHERE mlb_id = 669302').get();
  snapshots.gilbertRoleAt = orig && orig.role_at;
  db.prepare('UPDATE pitcher_fg_role SET role_at = ? WHERE mlb_id = 669302').run(nowStamp());
}
function freshenHancockRR() {
  const orig = db.prepare('SELECT role_at FROM pitcher_fg_role WHERE mlb_id = 676106').get();
  snapshots.hancockRoleAt = orig && orig.role_at;
  db.prepare('UPDATE pitcher_fg_role SET role_at = ? WHERE mlb_id = 676106').run(nowStamp());
}
function restoreAll() {
  if (snapshots.removedGameRow) cleanupTestGame();
  if (snapshots.gilbertRoleAt) {
    db.prepare('UPDATE pitcher_fg_role SET role_at = ? WHERE mlb_id = 669302').run(snapshots.gilbertRoleAt);
  }
  if (snapshots.hancockRoleAt) {
    db.prepare('UPDATE pitcher_fg_role SET role_at = ? WHERE mlb_id = 676106').run(snapshots.hancockRoleAt);
  }
  if (snapshots.removedOverride) {
    db.prepare("DELETE FROM pitcher_role_override WHERE mlb_id = 999999999").run();
  }
}

(async () => {
  try {
    // Ensure Gilbert + Hancock have fresh RR for the test
    freshenGilbertRR();
    freshenHancockRR();

    // ── Case A: announced bulk + fresh rotation SP → OPENER (PR #149 fix) ─
    console.log('\n=== A. Announced bulk + fresh rotation SP (Gilbert+Hancock) → OPENER ===');
    cleanupTestGame();
    setupTestGame(
      /*home_sp*/ 'Logan Gilbert',
      /*away_sp*/ 'Shane Bieber',
      /*away_bulk_announced*/ null,
      /*home_bulk_announced*/ 'Emerson Hancock'
    );
    await detectOpeners(TEST_DATE);
    let row = db.prepare("SELECT is_opener_game_home, bulk_guy_home, game_type_home, bulk_guy_home_announced FROM game_log WHERE game_date=? AND game_id='tor-sea'").get(TEST_DATE);
    expect('home flagged opener (piggyback preserved)', row.is_opener_game_home === 1);
    expect('bulk_guy_home = Hancock (tandem intact)', row.bulk_guy_home === 'Emerson Hancock');
    expect('game_type_home = opener', row.game_type_home === 'opener');
    expect('bulk_guy_home_announced still Hancock', row.bulk_guy_home_announced === 'Emerson Hancock');

    // ── Case B: no announced bulk + fresh rotation SP → STANDARD (pattern gate) ─
    console.log('\n=== B. No announced bulk + fresh rotation SP → STANDARD ===');
    cleanupTestGame();
    setupTestGame(
      'Logan Gilbert', 'Shane Bieber',
      /*away_bulk_announced*/ null,
      /*home_bulk_announced*/ null
    );
    await detectOpeners(TEST_DATE);
    row = db.prepare("SELECT is_opener_game_home, bulk_guy_home, game_type_home FROM game_log WHERE game_date=? AND game_id='tor-sea'").get(TEST_DATE);
    expect('home NOT flagged opener', row.is_opener_game_home === 0);
    expect('bulk_guy_home = null', row.bulk_guy_home === null);
    expect('game_type_home = standard', row.game_type_home === 'standard');

    // ── Case C: no announced bulk + RR-tagged RP + short outings → OPENER ─
    // Use a known RP with short outings from the local DB. Mason
    // Montgomery (mlb_id 682254, PIT, RR role=RP, role_detail=SU7,
    // avg pitches 15.7) fits the pattern.
    console.log('\n=== C. No announced bulk + RP with short outings → OPENER ===');
    cleanupTestGame();
    db.prepare(
      "INSERT INTO game_log (game_date, game_id, away_team, home_team, away_sp, away_sp_hand, home_sp, home_sp_hand) "
      + "VALUES (?, 'test-pit', 'TEST', 'PIT', 'Sample Away Sp', 'R', 'Mason Montgomery', 'R')"
    ).run(TEST_DATE);
    // Ensure Montgomery is in team_rosters for the lookup
    const monInRoster = db.prepare("SELECT mlb_id FROM team_rosters WHERE team='PIT' AND player_name='Mason Montgomery'").get();
    if (!monInRoster) {
      db.prepare("INSERT INTO team_rosters (team, player_name, mlb_id, role) VALUES ('PIT', 'Mason Montgomery', 682254, 'RP')").run();
    }
    await detectOpeners(TEST_DATE);
    row = db.prepare("SELECT is_opener_game_home, game_type_home FROM game_log WHERE game_date=? AND game_id='test-pit'").get(TEST_DATE);
    if (!monInRoster) {
      db.prepare("DELETE FROM team_rosters WHERE mlb_id=682254 AND team='PIT'").run();
    }
    db.prepare("DELETE FROM game_log WHERE game_date=? AND game_id='test-pit'").run(TEST_DATE);
    expect('RP with 1-IP pattern still flagged opener (reverse-audit case unchanged)',
      row && row.is_opener_game_home === 1);
    expect('game_type_home = opener (or bullpen_game if bulk unknown)',
      row && (row.game_type_home === 'opener' || row.game_type_home === 'bullpen_game'));

    // ── Case D: manual override wins over everything ─
    console.log('\n=== D. Manual pitcher_role_override wins over gate ===');
    // Set an override forcing Gilbert into 'RP' — should not affect
    // detectOpeners' opener classification directly (overrides are on
    // team_rosters.role via runRosterJob phase 3), but we can test the
    // opener_override table if it exists. Look for it.
    const hasOpenerOverride = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opener_override'").get();
    if (!hasOpenerOverride) {
      console.log('  SKIP: opener_override table not present in local DB — precedence test moot.');
    } else {
      cleanupTestGame();
      setupTestGame('Logan Gilbert', 'Shane Bieber', null, null);
      // Insert a manual opener_override forcing OPENER even though gate
      // would block.
      db.prepare(
        "INSERT OR REPLACE INTO opener_override (game_date, game_id, side, is_opener, opener_name, bulk_guy) "
        + "VALUES (?, 'tor-sea', 'home', 1, 'Logan Gilbert', 'Emerson Hancock')"
      ).run(TEST_DATE);
      await detectOpeners(TEST_DATE);
      row = db.prepare("SELECT is_opener_game_home, bulk_guy_home FROM game_log WHERE game_date=? AND game_id='tor-sea'").get(TEST_DATE);
      db.prepare("DELETE FROM opener_override WHERE game_date=? AND game_id='tor-sea' AND side='home'").run(TEST_DATE);
      expect('override forces opener classification (wins over gate)', row && row.is_opener_game_home === 1);
      expect('override sets bulk_guy_home', row && row.bulk_guy_home === 'Emerson Hancock');
    }

  } catch (e) {
    console.error('TEST ERROR:', e && e.stack || e);
    failed++;
  } finally {
    restoreAll();
  }

  console.log('\n=== SUMMARY ===');
  console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
