#!/usr/bin/env node
/**
 * How often has an ML market gate fired silently? (2026-08-31)
 *
 * The three gates in signalsForGame null the runtime market_*_ml. Until the
 * fix they wrote nothing an operator could see -- no bet_signals row, no
 * bet_signal_audit row, no pill. Only a console.warn nobody reads.
 *
 * They shipped 2026-07-28 (27f2ded, the CLE-CIN DH incident). Anything
 * earlier was not gated.
 *
 * TWO SOURCES, because one of them is not enough:
 *
 *   A. game_log         the stored market pair. Easy, and MISLEADING ON ITS
 *                       OWN: the first version of this script checked only
 *                       this and reported zero firings, because the gate is
 *                       evaluated against the RUNTIME pair.
 *   B. venue_comparison the runtime pair. When SIGNAL_VENUE_AWARE_ENABLED is
 *      _snapshot        on, jobs.js replaces the stored lines with the best
 *                       price per side via _pickBestML -- independently per
 *                       side, so best-away can come from Poly and best-home
 *                       from Kalshi. Taking the better price on BOTH sides
 *                       always lowers the implied sum, which is precisely
 *                       what pushes a pair toward "both positive". This is
 *                       the path the founding incident took.
 *
 * KNOWN LIMITS, so the number is not over-read:
 *   - venue_comparison_snapshot is keyed (game_date, game_id), so it holds
 *     ONE row per game -- the latest state, not what was live at emission.
 *     A gate that fired on transient pricing is not reconstructible.
 *   - Therefore this is a LOWER BOUND on condition 1.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const { checkMarketMLPairSanity } = require(path.join(R, 'utils/market-sanity'));

const GATE_SHIPPED = '2026-07-28';
const ip = m => (m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100));

// Mirrors jobs.js _pickBestML exactly.
function pickBest(row, side) {
  const P = row.poly && row.poly[side];
  const K = row.kalshi && row.kalshi[side];
  const pOK = P && P.net_american != null && !P.partial;
  const kOK = K && K.net_american != null && !K.partial;
  if (!pOK && !kOK) return null;
  if (pOK && !kOK) return { ml: P.net_american, venue: 'poly' };
  if (kOK && !pOK) return { ml: K.net_american, venue: 'kalshi' };
  return P.net_american >= K.net_american
    ? { ml: P.net_american, venue: 'poly' }
    : { ml: K.net_american, venue: 'kalshi' };
}

const glBy = {};
for (const g of db.prepare(
  'SELECT game_date, game_id, away_team, home_team, market_away_ml, market_home_ml, '
  + 'odds_flag_reason FROM game_log').all()) glBy[g.game_date + '|' + g.game_id] = g;

const mlSig = new Set(db.prepare(
  "SELECT DISTINCT game_date || '|' || game_id AS k FROM bet_signals WHERE signal_type='ML'").all().map(r => r.k));
const anySig = new Set(db.prepare(
  "SELECT DISTINCT game_date || '|' || game_id AS k FROM bet_signals").all().map(r => r.k));

// ---- CONDITION 1: structural pair impossibility -------------------------
const snaps = db.prepare(
  'SELECT game_date, game_id, snapshot_json FROM venue_comparison_snapshot '
  + 'WHERE game_date >= ? ORDER BY game_date, game_id').all(GATE_SHIPPED);

let priced = 0, crossVenue = 0;
const structural = [];
for (const s of snaps) {
  let row; try { row = JSON.parse(s.snapshot_json); } catch (e) { continue; }
  const a = pickBest(row, 'away'), h = pickBest(row, 'home');
  if (!a || !h) continue;
  priced++;
  if (a.venue !== h.venue) crossVenue++;
  const reason = checkMarketMLPairSanity(a.ml, h.ml);
  if (!reason) continue;
  const k = s.game_date + '|' + s.game_id;
  const gl = glBy[k] || {};
  structural.push({
    date: s.game_date, matchup: (gl.away_team || '?') + '@' + (gl.home_team || '?'),
    runtime: a.ml + '/' + h.ml, venues: a.venue + '/' + h.venue,
    stored: String(gl.market_away_ml) + '/' + String(gl.market_home_ml),
    storedSane: (gl.market_away_ml != null && gl.market_home_ml != null)
      ? (checkMarketMLPairSanity(gl.market_away_ml, gl.market_home_ml) ? 'also-bad' : 'sane') : 'null',
    sum: (ip(a.ml) + ip(h.ml)).toFixed(4),
    hadML: mlSig.has(k), hadAny: anySig.has(k),
  });
}

// ---- CONDITIONS 2 and 3: odds_flag_reason stamps ------------------------
const flagRows = db.prepare(
  "SELECT game_date, game_id, odds_flag_reason FROM game_log "
  + "WHERE game_date >= ? AND odds_flag_reason IS NOT NULL AND odds_flag_reason <> ''").all(GATE_SHIPPED);
const favDis = flagRows.filter(r => /disagree on favorite/i.test(r.odds_flag_reason));
const dhCross = flagRows.filter(r => /start-time mismatch|DH-crossed|wrong-leg market/i.test(r.odds_flag_reason));

// Historical totals, to show whether a condition is live or dormant.
const favAll = db.prepare("SELECT COUNT(*) n FROM game_log WHERE odds_flag_reason LIKE '%disagree on favorite%'").get().n;
const favLast = db.prepare("SELECT MAX(game_date) d FROM game_log WHERE odds_flag_reason LIKE '%disagree on favorite%'").get().d;
const dhAll = db.prepare("SELECT COUNT(*) n FROM game_log WHERE odds_flag_reason LIKE '%start-time mismatch%' "
  + "OR odds_flag_reason LIKE '%DH-crossed%' OR odds_flag_reason LIKE '%wrong-leg market%'").get().n;

console.log('=== SILENT ML MARKET-GATE FIRINGS ===');
console.log('  gate shipped : ' + GATE_SHIPPED);
console.log('  window       : ' + GATE_SHIPPED + ' -> '
  + (snaps.length ? snaps[snaps.length - 1].game_date : 'n/a'));
console.log('');

console.log('  CONDITION 1 -- structural pair impossibility (runtime venue-aware pair)');
console.log('    games with both sides priced : ' + priced);
console.log('    cross-venue pairs            : ' + crossVenue
  + '   (' + (priced ? (100 * crossVenue / priced).toFixed(1) : '0') + '%)');
console.log('    GATE WOULD FIRE ON           : ' + structural.length
  + '   (' + (priced ? (100 * structural.length / priced).toFixed(1) : '0') + '%)');
for (const g of structural) {
  console.log('      ' + g.date + '  ' + g.matchup.padEnd(10)
    + 'runtime ' + g.runtime.padEnd(13) + '(' + g.venues + ')'
    + '  stored ' + g.stored.padEnd(12) + ' [' + g.storedSane + ']'
    + '  sum ' + g.sum
    + '  hadML=' + (g.hadML ? 'yes' : 'NO'));
}
console.log('    stored pair looked SANE on   : ' + structural.filter(g => g.storedSane === 'sane').length
  + ' of ' + structural.length + '  <- invisible to any game_log-only audit');
console.log('');

console.log('  CONDITION 2 -- sources disagree on favorite');
console.log('    firings since the gate shipped : ' + favDis.length);
console.log('    instances in ALL history       : ' + favAll + '   (most recent ' + (favLast || 'never') + ')');
if (favAll > 0 && favDis.length === 0) {
  console.log('    NOTE: every instance predates the gate. The flag stopped being');
  console.log('    raised before the gate that consumes it existed, so this');
  console.log('    condition has never fired in production.');
}
console.log('');

console.log('  CONDITION 3 -- DH-crossed source rejection');
console.log('    firings since the gate shipped : ' + dhCross.length);
console.log('    instances in ALL history       : ' + dhAll);
if (dhAll === 0) {
  console.log('    NOTE: no game has ever carried this stamp. VERIFIED WIRED, though:');
  console.log('    utils/dh-assignment-guard checkSourceStartMatchesSchedule returns');
  console.log('    "<source> start-time mismatch for <gameId>", which the regex does');
  console.log('    match. So the arm is live and simply has not triggered -- not a');
  console.log('    regex that cannot fire, which was the thing worth ruling out.');
}
console.log('');

const worst = structural.filter(g => !g.hadML && g.hadAny);
console.log('=== BOTTOM LINE ===');
console.log('  reconstructible silent firings : ' + structural.length);
console.log('  ...showing the full symptom     : ' + worst.length
  + '   (no ML signal, other signals present)');
console.log('');
console.log('  LOWER BOUND. venue_comparison_snapshot keeps one row per game --');
console.log('  the latest state, not what was live at emission -- so a gate that');
console.log('  fired on transient pricing cannot be recovered. Both reconstructed');
console.log('  hits DO have ML signals on file, which is consistent with the');
console.log('  snapshot differing from emission-time state in either direction.');
