// Tests for feat/roster-pitcher-picker.
//
// What this pins, in the order the failures actually happened:
//
//   A. The picker's SOURCE is usable at all. Every row /api/pitchers
//      would return carries an mlb_id AND a hand, because the whole
//      point of a dropdown over a text box is that a selection writes
//      the join key and the handedness instead of the operator retyping
//      one and guessing the other. A row that cannot supply them is
//      dropped, not silently degraded to a name.
//
//   B. A roster pick ROUND-TRIPS name + id + hand into game_log, for
//      BOTH slots -- the opener (away_sp/home_sp/away_sp_id) and the
//      bulk (bulk_guy_{side}/_id/_hand). The bulk slot had no id or hand
//      column at all before this branch and no edit control once
//      detection had filled it.
//
//   C. DURABILITY. runLineupJob deletes every unplayed row for the date
//      and re-inserts from the feeds (services/jobs.js ~2230, ~2414), so
//      a manual edit written straight onto game_log does not survive.
//      This replays that delete-and-reinsert and asserts the pick comes
//      back, which is the only reason the edit goes through
//      opener_override rather than the lineup PATCH.
//
//   D. THE ID NEVER OUTLIVES THE NAME. Three writers set an SP name
//      outside q.upsertGame and therefore outside its away_sp_id CASE:
//      the lineup PATCH, detectOpeners' override pin, and the
//      announced-bulk-equals-SP branch. A new name with no id must CLEAR
//      the stored id at every one of them.
//
//   E. The off-roster escape hatch is representable and FLAGGED: a name
//      with no id is accepted only with off_roster=1, and is visible as
//      such afterwards.
//
//   F. PARTIAL UPDATE. Two controls write one opener_override row, so a
//      bulk-only save must not wipe a pinned opener_name.
//
// Synthetic date 2999-01-02 throughout; every write is undone in the
// finally block. Takes `db` from db/schema and never opens a second
// write connection (CLAUDE.md, "Never open a second write connection").
//
// Run:  node scripts/test-pitcher-picker.js
//       node scripts/test-pitcher-picker.js --coverage   (roster-coverage
//         figures quoted in the schema comments and the PR body)

const fs = require('fs');
const path = require('path');
const { db, q } = require('../db/schema');
const { detectOpeners } = require('../services/jobs');
const { normName, stripSfx } = require('../utils/names');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const D = '2999-01-02';
const GID = 'zzt-zzh';
const AWAY = 'SEA';
const HOME = 'TOR';

const K = (n) => stripSfx(normName(n || ''));

// ---------------------------------------------------------------------
// Fixtures pulled from the REAL roster tables, so the ids and hands are
// the ones production would hand the picker. Two distinct pitchers per
// side are needed: one to seed as the feed's value, one to pick.
function pickTwo(team) {
  const rows = q.getTeamPitchers.all(team).filter(r => r.mlb_id != null && r.hand);
  return rows.length >= 2 ? [rows[0], rows[1]] : null;
}

function seedGame(awaySpName, awaySpId, homeSpName, homeSpId) {
  db.prepare(
    'INSERT INTO game_log (game_date, game_id, away_team, home_team, '
    + 'away_sp, away_sp_id, away_sp_hand, home_sp, home_sp_id, home_sp_hand, park_factor) '
    + "VALUES (?, ?, ?, ?, ?, ?, 'R', ?, ?, 'R', 1.0)"
  ).run(D, GID, AWAY, HOME, awaySpName, awaySpId, homeSpName, homeSpId);
}

function row() {
  return db.prepare('SELECT * FROM game_log WHERE game_date=? AND game_id=?').get(D, GID);
}

function cleanup() {
  try { db.prepare('DELETE FROM game_log WHERE game_date=? AND game_id=?').run(D, GID); } catch (e) {}
  try { db.prepare('DELETE FROM opener_override WHERE game_date=?').run(D); } catch (e) {}
  try { db.prepare('DELETE FROM bet_signals WHERE game_date=?').run(D); } catch (e) {}
  try { db.prepare('DELETE FROM bet_signal_audit WHERE game_date=?').run(D); } catch (e) {}
}

// The route handler's merge rules, exercised through the same prepared
// statement the endpoint uses. Mirrors POST /opener-override's payload
// construction so the statement's named-parameter contract is pinned
// without standing up express.
function setOverride(fields) {
  const prev = q.getOpenerOverride.get(D, GID, fields.side) || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  const pick = (k) => has(k) ? fields[k] : (prev[k] != null ? prev[k] : null);
  const idFor = (nk, ik) => has(nk) ? (has(ik) ? fields[ik] : null)
                                    : (prev[ik] != null ? prev[ik] : null);
  const hdFor = (nk, hk) => has(nk) ? (has(hk) ? fields[hk] : null)
                                    : (prev[hk] != null ? prev[hk] : null);
  q.setOpenerOverride.run({
    game_date: D, game_id: GID, side: fields.side,
    is_opener: fields.is_opener,
    bulk_guy: pick('bulk_guy'),
    bulk_guy_id: idFor('bulk_guy', 'bulk_guy_id'),
    bulk_guy_hand: hdFor('bulk_guy', 'bulk_guy_hand'),
    opener_name: pick('opener_name'),
    opener_name_id: idFor('opener_name', 'opener_name_id'),
    opener_name_hand: hdFor('opener_name', 'opener_name_hand'),
    pick_source: pick('pick_source'),
    off_roster: fields.off_roster ? 1 : (has('off_roster') ? 0 : (prev.off_roster ? 1 : 0)),
    planned_batters: pick('planned_batters'),
    set_by: 'test',
    reason: pick('reason'),
  });
}

async function main() {
  const awayPair = pickTwo(AWAY);
  const homePair = pickTwo(HOME);
  if (!awayPair || !homePair) {
    console.log('SKIP -- team_rosters has fewer than 2 usable pitchers for '
      + AWAY + '/' + HOME + '. Run runRosterJob first.');
    return 0;
  }
  const [awayFeed, awayPick] = awayPair;
  const [homeFeed, homePick] = homePair;

  // === A. the picker's source =========================================
  console.log('\nA. /api/pitchers source rows are complete');
  const active = q.getTeamPitchers.all(AWAY);
  const season = q.getTeamPitchersSeason.all(AWAY);
  expect('active pitcher rows exist for ' + AWAY, active.length > 0, active.length + ' rows');
  const noId = active.filter(r => r.mlb_id == null);
  const noHand = active.filter(r => !r.hand);
  expect('every active row carries an mlb_id', noId.length === 0,
    noId.length ? noId.map(r => r.player_name).join(', ') : active.length + '/' + active.length);
  expect('every active row carries a hand', noHand.length === 0,
    noHand.length ? noHand.map(r => r.player_name).join(', ') : active.length + '/' + active.length);
  expect('roles are confined to SP/RP/CL',
    active.every(r => ['SP', 'RP', 'CL'].includes(r.role)),
    [...new Set(active.map(r => r.role))].join(','));
  expect('season tier is a superset worth offering', season.length >= active.length,
    'active ' + active.length + ' / season ' + season.length);
  // The endpoint de-duplicates season against active on the normalized
  // name; assert the key function actually separates the two tiers.
  const activeKeys = new Set(active.map(r => K(r.player_name)));
  const dupes = season.filter(r => activeKeys.has(K(r.player_name)));
  expect('season-tier rows overlapping active are de-duplicable',
    dupes.length < season.length, dupes.length + ' of ' + season.length + ' overlap');

  // === B/C/D/E/F ======================================================
  cleanup();
  try {
    // --- B. round-trip, opener slot ---------------------------------
    console.log('\nB. a roster pick round-trips name + id + hand');
    seedGame(awayFeed.player_name, awayFeed.mlb_id, homeFeed.player_name, homeFeed.mlb_id);
    setOverride({
      side: 'away', is_opener: 1,
      opener_name: awayPick.player_name,
      opener_name_id: awayPick.mlb_id,
      opener_name_hand: awayPick.hand,
      pick_source: 'active_roster',
      bulk_guy: homePick.player_name === awayPick.player_name ? awayFeed.player_name : awayFeed.player_name,
      bulk_guy_id: awayFeed.mlb_id,
      bulk_guy_hand: awayFeed.hand,
      planned_batters: 4,
    });
    await detectOpeners(D);
    let r = row();
    expect('away_sp pinned to the picked name', r.away_sp === awayPick.player_name,
      String(r.away_sp));
    expect('away_sp_id is the PICKED id, not the feed id',
      r.away_sp_id === awayPick.mlb_id,
      'got ' + r.away_sp_id + ', picked ' + awayPick.mlb_id + ', feed ' + awayFeed.mlb_id);
    expect('away_sp_hand comes from the roster', r.away_sp_hand === awayPick.hand,
      String(r.away_sp_hand));
    expect('bulk_guy_away written', r.bulk_guy_away === awayFeed.player_name,
      String(r.bulk_guy_away));
    expect('bulk_guy_away_id written', r.bulk_guy_away_id === awayFeed.mlb_id,
      String(r.bulk_guy_away_id));
    expect('bulk_guy_away_hand written', r.bulk_guy_away_hand === awayFeed.hand,
      String(r.bulk_guy_away_hand));
    expect('game_type_away is opener', r.game_type_away === 'opener', String(r.game_type_away));

    // --- C. durability across the lineup job's delete + re-insert ----
    console.log('\nC. the pick survives the lineup job deleting and re-inserting the row');
    const del = db.prepare('DELETE FROM game_log WHERE game_date=? AND away_score IS NULL').run(D);
    expect('unplayed row was deleted (the lineup-job shape)', del.changes >= 1,
      del.changes + ' row(s)');
    expect('opener_override survived the delete',
      !!q.getOpenerOverride.get(D, GID, 'away'));
    // Re-insert exactly what the feeds would: the ORIGINAL pitcher, with
    // the original id. If nothing replays the override, this is what the
    // operator would be left looking at.
    seedGame(awayFeed.player_name, awayFeed.mlb_id, homeFeed.player_name, homeFeed.mlb_id);
    r = row();
    expect('post-refresh row holds the FEED value before detection re-runs',
      r.away_sp === awayFeed.player_name, String(r.away_sp));
    await detectOpeners(D);
    r = row();
    expect('away_sp is re-pinned after the refresh', r.away_sp === awayPick.player_name,
      String(r.away_sp));
    expect('away_sp_id is re-pinned after the refresh', r.away_sp_id === awayPick.mlb_id,
      String(r.away_sp_id));
    expect('bulk_guy_away is re-applied after the refresh',
      r.bulk_guy_away === awayFeed.player_name, String(r.bulk_guy_away));
    expect('bulk_guy_away_id is re-applied after the refresh',
      r.bulk_guy_away_id === awayFeed.mlb_id, String(r.bulk_guy_away_id));

    // --- F. partial update -------------------------------------------
    console.log('\nF. a bulk-only save does not wipe the pinned opener');
    setOverride({ side: 'away', is_opener: 1, bulk_guy: homePick.player_name,
      bulk_guy_id: homePick.mlb_id, bulk_guy_hand: homePick.hand,
      pick_source: 'active_roster' });
    let ov = q.getOpenerOverride.get(D, GID, 'away');
    expect('opener_name still pinned after a bulk-only write',
      ov.opener_name === awayPick.player_name, String(ov.opener_name));
    expect('opener_name_id still pinned after a bulk-only write',
      ov.opener_name_id === awayPick.mlb_id, String(ov.opener_name_id));
    expect('bulk_guy moved to the new pick', ov.bulk_guy === homePick.player_name,
      String(ov.bulk_guy));
    expect('bulk_guy_id moved with it', ov.bulk_guy_id === homePick.mlb_id,
      String(ov.bulk_guy_id));

    // Clearing the bulk clears its id and hand too.
    setOverride({ side: 'away', is_opener: 1, bulk_guy: null, bulk_guy_id: null,
      bulk_guy_hand: null });
    await detectOpeners(D);
    r = row();
    expect('clearing the bulk clears bulk_guy_away', r.bulk_guy_away == null,
      String(r.bulk_guy_away));
    expect('clearing the bulk clears bulk_guy_away_id', r.bulk_guy_away_id == null,
      String(r.bulk_guy_away_id));
    expect('clearing the bulk clears bulk_guy_away_hand', r.bulk_guy_away_hand == null,
      String(r.bulk_guy_away_hand));

    // --- H. legacy override rows (no id, not off-roster) -------------
    console.log('\nH. a pre-picker override still gets its bulk id resolved by name');
    cleanup();
    seedGame(awayFeed.player_name, awayFeed.mlb_id, homeFeed.player_name, homeFeed.mlb_id);
    // Exactly the shape the old prompt() wrote: a bulk NAME and nothing
    // else. Inserted raw, bypassing setOverride, because that is how the
    // 3 rows already in the table were created.
    db.prepare(
      'INSERT INTO opener_override (game_date, game_id, side, is_opener, bulk_guy) '
      + 'VALUES (?, ?, ?, 1, ?)'
    ).run(D, GID, 'away', awayPick.player_name);
    await detectOpeners(D);
    r = row();
    expect('legacy override still applies its bulk name',
      r.bulk_guy_away === awayPick.player_name, String(r.bulk_guy_away));
    expect('legacy override gets the bulk id RESOLVED by name, not left null',
      r.bulk_guy_away_id === awayPick.mlb_id,
      'got ' + r.bulk_guy_away_id + ', expected ' + awayPick.mlb_id);
    expect('legacy override is not flagged off-roster',
      !q.getOpenerOverride.get(D, GID, 'away').off_roster);

    // --- D. the id never outlives the name ---------------------------
    console.log('\nD. a name written with no id CLEARS the stored id');
    // D1: the override pin, free-text (no id) over a row that has one.
    cleanup();
    seedGame(awayFeed.player_name, awayFeed.mlb_id, homeFeed.player_name, homeFeed.mlb_id);
    setOverride({ side: 'away', is_opener: 0, opener_name: 'Zzz Nonexistent',
      opener_name_id: null, opener_name_hand: 'L',
      off_roster: 1, pick_source: 'free_text' });
    await detectOpeners(D);
    r = row();
    expect('pinned free-text name landed', r.away_sp === 'Zzz Nonexistent', String(r.away_sp));
    expect('away_sp_id CLEARED, not inherited from the replaced pitcher',
      r.away_sp_id == null, 'got ' + r.away_sp_id + ' (feed id was ' + awayFeed.mlb_id + ')');

    // D2: the lineup PATCH's column set, asserted on the source. The
    // handler is an express route; what matters is that a name branch
    // always writes the id column beside it.
    const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
    const patchIdx = apiSrc.indexOf("router.patch('/games/:date/:gameId/lineup'");
    const patchBody = apiSrc.slice(patchIdx, patchIdx + 2600);
    expect('lineup PATCH writes away_sp_id whenever it writes away_sp',
      /away_sp=\?[\s\S]{0,200}away_sp_id=\?/.test(patchBody));
    expect('lineup PATCH writes home_sp_id whenever it writes home_sp',
      /home_sp=\?[\s\S]{0,200}home_sp_id=\?/.test(patchBody));

    // D3: the announced-bulk-equals-SP branch nulls the id with the name.
    const jobsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');
    expect('the SP-null branch nulls away_sp_id alongside away_sp',
      /'away_sp' : 'home_sp'\) \+ " = NULL, "[\s\S]{0,200}sp_id' : 'home_sp_id'\) \+ " = NULL/
        .test(jobsSrc));
    // D4: the lineup-job pin threads the override's id into upsertGame,
    // where the CASE's "supplied id wins" branch takes it. Both keys must
    // be PRESENT in the payload -- omitting them is what broke every
    // lineup pull on the #407 deploy.
    expect('lineup-job upsert payload still carries both sp_id keys',
      /away_sp_id: writeAwaySpId/.test(jobsSrc) && /home_sp_id: writeHomeSpId/.test(jobsSrc));
    expect('the pin sources its hand from opener_name_hand',
      /writeAwayHand = _pinHandOf\(_ovAway\.opener_name_hand\)/.test(jobsSrc));

    // --- E. the escape hatch is flagged ------------------------------
    console.log('\nE. the off-roster escape hatch is representable and flagged');
    ov = q.getOpenerOverride.get(D, GID, 'away');
    expect('off_roster persisted as 1', ov.off_roster === 1, String(ov.off_roster));
    expect('pick_source records free_text', ov.pick_source === 'free_text',
      String(ov.pick_source));
    expect('a free-text pick stores no id', ov.opener_name_id == null,
      String(ov.opener_name_id));
    expect('the hand the operator chose is kept', ov.opener_name_hand === 'L',
      String(ov.opener_name_hand));
    // The endpoint refuses a name with no id unless off_roster says so.
    // Asserted on the source for the same reason as D2.
    const ovIdx = apiSrc.indexOf("router.post('/opener-override'");
    const ovBody = apiSrc.slice(ovIdx, ovIdx + 6000);
    expect('the endpoint rejects a named pitcher with no id and no off_roster flag',
      /namedNoId && !payload\.off_roster/.test(ovBody));
    expect('the endpoint AWAITS detection and re-prices the edited game',
      /await detectOpeners\(b\.game_date\)/.test(ovBody)
      && /processGameSignals\(gameRow, getWobaIndex\(\), getSettings\(\)\)/.test(ovBody));

    // --- UI: no free-text pitcher box on the roster path ------------
    console.log('\nG. the card no longer offers a free-text SP box or a stray R/L pick');
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect('the old free-text SP input is gone',
      !/inp\.placeholder = 'SP name'/.test(uiSrc));
    expect('the prompt()-based bulk entry is gone',
      !/prompt\('Bulk-guy name for/.test(uiSrc));
    expect('the bulk slot has an always-present edit control',
      /showPitcherEdit\(gid, dt, sd, 'bulk'\)/.test(uiSrc));
    expect('the picker fetches the pitchers endpoint',
      /\/api\/pitchers\//.test(uiSrc));
    expect('a roster option carries name, id and hand together',
      /o\.dataset\.name = pr\.player_name/.test(uiSrc)
      && /o\.value = String\(pr\.mlb_id\)/.test(uiSrc)
      && /o\.dataset\.hand = pr\.hand/.test(uiSrc));
    expect('the R/L/S select survives ONLY inside the off-roster hatch',
      /freeHand\.id = 'spfreehand-'/.test(uiSrc)
      && !/sel\.id = 'sph-'\+rowId/.test(uiSrc));
  } finally {
    cleanup();
  }
  return failed;
}

// ---------------------------------------------------------------------
// --coverage: the figures quoted in db/schema.js and the PR body. Read
// only; no writes. Matched with the SHARED normalizer, because an exact
// match reads accents and "G. Rodriguez" forms as absent players and
// inflates the miss rate more than twofold (14.5% vs 6.1%).
function coverage() {
  const FROM = '2026-08-20', TO = '2026-09-14';
  const mk = (tbl) => {
    const m = {};
    for (const r of db.prepare('SELECT team, player_name, role FROM ' + tbl).all()) {
      if (!['SP', 'RP', 'CL'].includes(r.role)) continue;
      if (!m[r.team]) m[r.team] = new Set();
      m[r.team].add(K(r.player_name));
      const a = K(r.player_name).split(' ');
      if (a.length >= 2) m[r.team].add(a[0][0] + ' ' + a[a.length - 1]);
    }
    return m;
  };
  const act = mk('team_rosters'), sea = mk('team_rosters_season');
  const look = (m, t, p) => {
    const s = m[t]; if (!s) return false;
    const k = K(p); if (s.has(k)) return true;
    const a = k.split(' ');
    return a.length >= 2 && s.has(a[0][0] + ' ' + a[a.length - 1]);
  };
  let n = 0, mA = 0, mB = 0; const ex = [];
  const rows = db.prepare(
    'SELECT game_date, game_id, away_team, home_team, away_sp, home_sp '
    + 'FROM game_log WHERE game_date BETWEEN ? AND ?').all(FROM, TO);
  for (const r of rows) for (const side of ['away', 'home']) {
    const t = r[side + '_team'], p = r[side + '_sp'];
    if (!t || !p) continue;
    n++;
    if (!look(act, t, p)) {
      mA++;
      if (!look(sea, t, p)) { mB++; if (ex.length < 10) ex.push(t + ' / ' + p + '  (' + r.game_date + ')'); }
    }
  }
  const pitchers = db.prepare(
    "SELECT COUNT(*) n, COUNT(DISTINCT team) t, SUM(mlb_id IS NOT NULL) wid, SUM(hand IS NOT NULL) wh "
    + "FROM team_rosters WHERE role IN ('SP','RP','CL')").get();
  console.log('\nROSTER COVERAGE  ' + FROM + ' .. ' + TO + '  (data/mlb.db)');
  console.log('  active pitchers       ' + pitchers.n + ' over ' + pitchers.t + ' teams; '
    + pitchers.wid + ' with mlb_id, ' + pitchers.wh + ' with hand');
  console.log('  SP slots checked      ' + n);
  console.log('  absent from ACTIVE    ' + mA + ' / ' + n + '  = ' + (100 * mA / n).toFixed(1) + '%');
  console.log('  absent from A UNION S ' + mB + ' / ' + n + '  = ' + (100 * mB / n).toFixed(1) + '%');
  if (ex.length) { console.log('  needing the escape hatch:'); ex.forEach(e => console.log('    ' + e)); }
  console.log('\n  The second row is what the escape hatch is for. The first is');
  console.log('  why the dropdown offers the season tier as well as the 26-man.');
}

if (process.argv.includes('--coverage')) {
  coverage();
  process.exit(0);
}

main().then((f) => {
  console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
  process.exit(f === 0 ? 0 : 1);
}).catch((e) => {
  cleanup();
  console.error('ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
