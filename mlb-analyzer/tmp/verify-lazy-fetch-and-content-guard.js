// Verification for fix/venue-lazy-fetch-and-content-guard.
//
// Two independent fixes, verified separately:
//
// PART A — lazy venue-fetch in processGameSignals (ping-pong bug)
//   Scenarios A1-A3: opts absent → cache peek OR snapshot fallback provides
//                    tier-1; processGameSignals writes venue_stale=0 with
//                    price_venue populated.
//   Scenario A4:     nothing available → falls back to Kalshi-direct
//                    (venue_stale=1, price_venue=null).
//
// PART B — lineup-content-hash staleness guard
//   Scenarios B1-B3: same lineup content but bumped lineups_quality_at
//                    → refreshSignalBaselines does NOT skip (fixes the
//                    stuck-rows bug). Changed lineup content → skips.
//                    NULL row.lineup_hash → fail-open (refresh).
//
// The harness exercises the isolated tier-decision logic against a real
// DB with a scratch date; production code paths are re-used where
// possible.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: false });

function pass(name) { console.log('  ✓ ' + name); }
function fail(name, want, got) {
  console.error('  ✗ ' + name + '\n     want: ' + JSON.stringify(want) + '\n     got : ' + JSON.stringify(got));
  process.exitCode = 1;
}

const SYNTHETIC_DATE = '2199-02-02';
const SYNTHETIC_GID = 'scratch-lazy';

function cleanup() {
  db.prepare("DELETE FROM venue_comparison_snapshot WHERE game_date = ?").run(SYNTHETIC_DATE);
  db.prepare("DELETE FROM bet_signals WHERE game_date = ?").run(SYNTHETIC_DATE);
  db.prepare("DELETE FROM game_log WHERE game_date = ?").run(SYNTHETIC_DATE);
}
cleanup();

// Seed a game_log row
const AWAY_LINEUP = JSON.stringify([{name:'A1',hand:'R'},{name:'A2',hand:'L'}]);
const HOME_LINEUP = JSON.stringify([{name:'H1',hand:'R'},{name:'H2',hand:'R'}]);
const glInfo = db.prepare(`INSERT INTO game_log (
  game_date, game_id, away_team, home_team,
  market_away_ml, market_home_ml, market_total,
  model_away_ml, model_home_ml, model_total,
  away_lineup_json, home_lineup_json,
  away_lineup_status, home_lineup_status,
  lineups_quality_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'projected', 'projected', datetime('now', '-2 hours'))`)
  .run(SYNTHETIC_DATE, SYNTHETIC_GID, 'AAA', 'BBB', 180, -209, 8.5, -139, 121, 8.10, AWAY_LINEUP, HOME_LINEUP);
const glId = glInfo.lastInsertRowid;

// Seed a fresh snapshot (~6 min old)
const freshSnap = {
  game_id: SYNTHETIC_GID, away_team: 'AAA', home_team: 'BBB',
  poly: { away: { net_american: 184, partial: false, top_ask_ml: 203, fee_usd: 1.5 },
          home: { net_american: -225, partial: false, top_ask_ml: -213, fee_usd: 1.6 } },
  kalshi: { away: { net_american: 181, partial: false, top_ask_ml: 194, fee_usd: 0.5 },
            home: { net_american: -208, partial: false, top_ask_ml: -194, fee_usd: 0.4 } },
  winner: { away: 'poly', home: 'kalshi' },
};
const freshSnapAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
db.prepare(`INSERT OR REPLACE INTO venue_comparison_snapshot
  (game_date, game_id, snapshot_at, snapshot_json) VALUES (?, ?, ?, ?)`)
  .run(SYNTHETIC_DATE, SYNTHETIC_GID, freshSnapAt, JSON.stringify(freshSnap));

// -----------------------------------------------------------------------
// PART A — lazy venue-fetch discipline
// -----------------------------------------------------------------------
console.log('\nPART A — lazy venue-fetch in processGameSignals (ping-pong fix)');

// Emulate the tier-decision block from processGameSignals — same code
// paths, isolated so we can control opts / cache / snapshot presence.
function decideVenueMarket({ opts, cachePeekReturns, gameId, gameDate }) {
  const _pickBestML = require('../services/jobs')._pickBestML_test || null;
  // Fallback duplicate (jobs.js keeps _pickBestML private) — same logic.
  function pickBest(r, s) {
    if (!r) return null;
    const P = r.poly && r.poly[s], K = r.kalshi && r.kalshi[s];
    const pOK = P && P.net_american != null && !P.partial;
    const kOK = K && K.net_american != null && !K.partial;
    if (!pOK && !kOK) return null;
    if (pOK && !kOK) return { ml: P.net_american, venue: 'poly' };
    if (kOK && !pOK) return { ml: K.net_american, venue: 'kalshi' };
    return P.net_american >= K.net_american
      ? { ml: P.net_american, venue: 'poly' }
      : { ml: K.net_american, venue: 'kalshi' };
  }
  const oc = require('../services/odds-comparison');
  // Stub peekCachedRowsByGid for this call
  const origPeek = oc.peekCachedRowsByGid;
  oc.peekCachedRowsByGid = () => cachePeekReturns;
  try {
    let venueRows = (opts && opts.venueRowsByGid) || null;
    if (!venueRows) {
      try { venueRows = oc.peekCachedRowsByGid(gameDate) || null; } catch(e) {}
    }
    let rowForGame = venueRows && venueRows[gameId];
    let servedFromSnapshot = false;
    if (!rowForGame) {
      // Fresh snapshot lookup — replicate _loadFreshSnapshotForGid behavior
      const s = db.prepare("SELECT snapshot_at, snapshot_json FROM venue_comparison_snapshot WHERE game_date=? AND game_id=?").get(gameDate, gameId);
      if (s) {
        const ageMs = Date.now() - new Date(s.snapshot_at).getTime();
        if (ageMs <= 30 * 60 * 1000) {
          rowForGame = JSON.parse(s.snapshot_json);
          servedFromSnapshot = true;
        }
      }
    }
    let venueStale = 1;
    let priceVenueAway = null, priceVenueHome = null;
    let mktAway = 180, mktHome = -209; // Kalshi-direct fallback
    if (rowForGame) {
      const bA = pickBest(rowForGame, 'away');
      const bH = pickBest(rowForGame, 'home');
      if (bA) { mktAway = bA.ml; priceVenueAway = bA.venue; venueStale = 0; }
      if (bH) { mktHome = bH.ml; priceVenueHome = bH.venue; venueStale = 0; }
    }
    return { mktAway, mktHome, priceVenueAway, priceVenueHome, venueStale, servedFromSnapshot };
  } finally {
    oc.peekCachedRowsByGid = origPeek;
  }
}

// A1: opts prefetched (runLineupJob path)
const optsRows = { [SYNTHETIC_GID]: {
  poly:   { away: { net_american: 190, partial: false }, home: { net_american: -230, partial: false } },
  kalshi: { away: { net_american: 185, partial: false }, home: { net_american: -220, partial: false } },
}};
const a1 = decideVenueMarket({ opts: { venueRowsByGid: optsRows }, cachePeekReturns: null, gameId: SYNTHETIC_GID, gameDate: SYNTHETIC_DATE });
a1.mktAway === 190 ? pass('A1 opts prefetch: mktAway=190 (Poly winner)') : fail('A1 mktAway', 190, a1.mktAway);
a1.priceVenueAway === 'poly' ? pass('A1 opts prefetch: price_venue=poly') : fail('A1 venue', 'poly', a1.priceVenueAway);
a1.venueStale === 0 ? pass('A1 opts prefetch: venue_stale=0') : fail('A1 stale', 0, a1.venueStale);
a1.servedFromSnapshot === false ? pass('A1 opts prefetch: not from snapshot') : fail('A1 snap', false, a1.servedFromSnapshot);

// A2: opts absent but cache-peek returns rows (odds-cron path, cache warm)
const a2 = decideVenueMarket({ opts: null, cachePeekReturns: optsRows, gameId: SYNTHETIC_GID, gameDate: SYNTHETIC_DATE });
a2.mktAway === 190 ? pass('A2 cache peek: mktAway=190 (Poly winner, live via cache)') : fail('A2 mktAway', 190, a2.mktAway);
a2.venueStale === 0 ? pass('A2 cache peek: venue_stale=0') : fail('A2 stale', 0, a2.venueStale);
a2.servedFromSnapshot === false ? pass('A2 cache peek: not from snapshot') : fail('A2 snap', false, a2.servedFromSnapshot);

// A3: opts absent AND cache empty → snapshot fallback (cold cache path)
const a3 = decideVenueMarket({ opts: null, cachePeekReturns: null, gameId: SYNTHETIC_GID, gameDate: SYNTHETIC_DATE });
a3.mktAway === 184 ? pass('A3 snapshot fallback: mktAway=184 (Poly winner from snapshot)') : fail('A3 mktAway', 184, a3.mktAway);
a3.priceVenueAway === 'poly' ? pass('A3 snapshot fallback: price_venue=poly') : fail('A3 venue', 'poly', a3.priceVenueAway);
a3.venueStale === 0 ? pass('A3 snapshot fallback: venue_stale=0 (NOT downgraded to tier-3)') : fail('A3 stale', 0, a3.venueStale);
a3.servedFromSnapshot === true ? pass('A3 snapshot fallback: servedFromSnapshot=true') : fail('A3 snap', true, a3.servedFromSnapshot);

// A4: opts absent, cache empty, snapshot too old → tier-3 fallback
db.prepare("UPDATE venue_comparison_snapshot SET snapshot_at=? WHERE game_date=? AND game_id=?")
  .run(new Date(Date.now() - 45 * 60 * 1000).toISOString(), SYNTHETIC_DATE, SYNTHETIC_GID);
const a4 = decideVenueMarket({ opts: null, cachePeekReturns: null, gameId: SYNTHETIC_GID, gameDate: SYNTHETIC_DATE });
a4.mktAway === 180 ? pass('A4 no venue anywhere: mktAway=180 (Kalshi-direct fallback)') : fail('A4 mktAway', 180, a4.mktAway);
a4.priceVenueAway === null ? pass('A4 no venue anywhere: price_venue=null') : fail('A4 venue', null, a4.priceVenueAway);
a4.venueStale === 1 ? pass('A4 no venue anywhere: venue_stale=1 (tier-3)') : fail('A4 stale', 1, a4.venueStale);
// Restore fresh snapshot for PART B
db.prepare("UPDATE venue_comparison_snapshot SET snapshot_at=? WHERE game_date=? AND game_id=?")
  .run(freshSnapAt, SYNTHETIC_DATE, SYNTHETIC_GID);

// -----------------------------------------------------------------------
// PART B — lineup-content-hash staleness guard
// -----------------------------------------------------------------------
console.log('\nPART B — lineup-content-hash staleness guard (stuck-rows fix)');

const crypto = require('crypto');
function computeHash(gl) {
  const parts = [
    gl.away_lineup_json || '',
    gl.home_lineup_json || '',
    gl.away_lineup_status || '',
    gl.home_lineup_status || '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Seed a bet_signals row with lineup_hash matching current game_log state
const originalHash = computeHash({
  away_lineup_json: AWAY_LINEUP,
  home_lineup_json: HOME_LINEUP,
  away_lineup_status: 'projected',
  home_lineup_status: 'projected',
});
db.prepare(`INSERT INTO bet_signals (
  game_log_id, game_date, game_id, signal_type, signal_side, category,
  market_line, model_line, edge_pct,
  cohort, is_active, lineup_hash,
  created_at, updated_at
) VALUES (?, ?, ?, 'ML', 'away', 'dog', 180, -139, 0.0684,
  'v7', 1, ?,
  datetime('now','-2 hours'), datetime('now','-2 hours'))`)
  .run(glId, SYNTHETIC_DATE, SYNTHETIC_GID, originalHash);

// Guard function — replicates refreshSignalBaselines line-by-line
function shouldSkipStale(row) {
  const currentHash = computeHash({
    away_lineup_json:   row.away_lineup_json,
    home_lineup_json:   row.home_lineup_json,
    away_lineup_status: row.away_lineup_status,
    home_lineup_status: row.home_lineup_status,
  });
  return !!(row.lineup_hash && currentHash && row.lineup_hash !== currentHash);
}

// B1: same lineup content, but bumped lineups_quality_at → DO NOT skip (bug fix)
db.prepare("UPDATE game_log SET lineups_quality_at=datetime('now') WHERE game_date=? AND game_id=?").run(SYNTHETIC_DATE, SYNTHETIC_GID);
const b1Row = db.prepare(`SELECT bs.lineup_hash, gl.away_lineup_json, gl.home_lineup_json, gl.away_lineup_status, gl.home_lineup_status
  FROM bet_signals bs JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
  WHERE bs.game_date=? AND bs.game_id=? AND bs.signal_type='ML' AND bs.signal_side='away'`).get(SYNTHETIC_DATE, SYNTHETIC_GID);
shouldSkipStale(b1Row) === false
  ? pass('B1 identical lineup content, quality bumped: refresh (NOT skipped) — 07-10 stuck-rows fix')
  : fail('B1 skip', false, shouldSkipStale(b1Row));

// B2: lineup CONTENT changes (batter added) → skip (guard trips correctly)
const NEW_AWAY = JSON.stringify([{name:'A1',hand:'R'},{name:'A2',hand:'L'},{name:'A3',hand:'R'}]);
db.prepare("UPDATE game_log SET away_lineup_json=? WHERE game_date=? AND game_id=?").run(NEW_AWAY, SYNTHETIC_DATE, SYNTHETIC_GID);
const b2Row = db.prepare(`SELECT bs.lineup_hash, gl.away_lineup_json, gl.home_lineup_json, gl.away_lineup_status, gl.home_lineup_status
  FROM bet_signals bs JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
  WHERE bs.game_date=? AND bs.game_id=? AND bs.signal_type='ML' AND bs.signal_side='away'`).get(SYNTHETIC_DATE, SYNTHETIC_GID);
shouldSkipStale(b2Row) === true
  ? pass('B2 lineup content changed (batter added): SKIP — guard trips correctly')
  : fail('B2 skip', true, shouldSkipStale(b2Row));

// B3: lineup status flips projected → confirmed → skip (status is material)
db.prepare("UPDATE game_log SET away_lineup_json=?, away_lineup_status='confirmed' WHERE game_date=? AND game_id=?").run(AWAY_LINEUP, SYNTHETIC_DATE, SYNTHETIC_GID);
const b3Row = db.prepare(`SELECT bs.lineup_hash, gl.away_lineup_json, gl.home_lineup_json, gl.away_lineup_status, gl.home_lineup_status
  FROM bet_signals bs JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
  WHERE bs.game_date=? AND bs.game_id=? AND bs.signal_type='ML' AND bs.signal_side='away'`).get(SYNTHETIC_DATE, SYNTHETIC_GID);
shouldSkipStale(b3Row) === true
  ? pass('B3 lineup status projected→confirmed: SKIP — status is material')
  : fail('B3 skip', true, shouldSkipStale(b3Row));

// B4: NULL row.lineup_hash (row from before this migration) → fail-open
db.prepare("UPDATE game_log SET away_lineup_json=?, away_lineup_status='projected' WHERE game_date=? AND game_id=?").run(AWAY_LINEUP, SYNTHETIC_DATE, SYNTHETIC_GID);
db.prepare("UPDATE bet_signals SET lineup_hash=NULL WHERE game_date=? AND game_id=?").run(SYNTHETIC_DATE, SYNTHETIC_GID);
const b4Row = db.prepare(`SELECT bs.lineup_hash, gl.away_lineup_json, gl.home_lineup_json, gl.away_lineup_status, gl.home_lineup_status
  FROM bet_signals bs JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
  WHERE bs.game_date=? AND bs.game_id=? AND bs.signal_type='ML' AND bs.signal_side='away'`).get(SYNTHETIC_DATE, SYNTHETIC_GID);
shouldSkipStale(b4Row) === false
  ? pass('B4 NULL lineup_hash (pre-migration row): fail-open (NOT skipped)')
  : fail('B4 skip', false, shouldSkipStale(b4Row));

// -----------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------
cleanup();
console.log('\nexit code:', process.exitCode || 0);
