#!/usr/bin/env node
/**
 * Post-start price exposure, measured against REAL first pitch. (2026-08-22)
 *
 * THE QUESTION. The magnitude guards catch live in-game prices only when
 * they are extreme enough to be implausible (+94400). A game that is
 * merely 2-0 in the fourth prices the leader at something like -250:
 * plausible, passes pair sanity, passes the magnitude ceiling, passes the
 * edge cap, and prices as a real pre-game market. Those are invisible to
 * every check we have. This counts them.
 *
 * ONLY POSSIBLE NOW. Every previous attempt compared against
 * game_log.game_time, a display string ("2:10 PM ET") with no date and no
 * comparable time -- which silently returns "" from slice(11,16) and makes
 * every same-date comparison read as "after". This uses first_pitch_utc,
 * backfilled from statsapi gameData.gameInfo.firstPitch.
 *
 * TIMEZONES, stated explicitly because this is where the last attempt died:
 *   bet_signal_audit.created_at  -- PT local wall clock, no offset
 *                                   ("2026-04-26 21:00:03").
 *   game_log.odds_locked_at      -- UTC. Written by SQL datetime('now')
 *                                   at jobs.js:3815, which is always UTC.
 *   game_log.first_pitch_utc     -- ISO 8601 UTC from statsapi.
 *
 * created_at and odds_locked_at are in DIFFERENT ZONES despite looking
 * identical. Determined empirically, not assumed: set_closing_line can
 * only occur after a game ends, and reading created_at as PT(+7) puts
 * 727 of 736 such events after first pitch, while reading it as UTC puts
 * 369 after and 367 before -- a coin flip, i.e. wrong. odds_locked_at is
 * UTC by inspection of the SQL that writes it. Applying the PT shift to
 * it produced "0 signals locked before first pitch", which was the tell.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const PT_OFFSET_HOURS = 7;  // PDT. The season never runs in PST.

function ptToUtcMs(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + PT_OFFSET_HOURS, +m[5], +m[6]);
}

// Actions that can set or move the price a signal is judged on.
const PRICE_AFFECTING = new Set(['insert', 'refresh', 'refresh_odds_tail']);

(function main() {
  const rows = db.prepare(
    'SELECT b.action, b.created_at, b.game_date, b.game_id, b.signal_type, b.signal_side, b.detail, '
    + 'g.first_pitch_utc, g.game_status, g.odds_locked_at, '
    + 'g.market_away_ml, g.market_home_ml '
    + 'FROM bet_signal_audit b JOIN game_log g '
    + '  ON g.game_date = b.game_date AND g.game_id = b.game_id '
    + 'WHERE g.first_pitch_utc IS NOT NULL'
  ).all();

  console.log('=== post-start price exposure, vs REAL first pitch ===');
  console.log('  audit events joined to a game with a real first pitch: ' + rows.length);

  let after = 0, before = 0;
  const priceAfter = [];
  for (const r of rows) {
    const ev = ptToUtcMs(r.created_at);
    const fp = Date.parse(r.first_pitch_utc);
    if (ev == null || !Number.isFinite(fp)) continue;
    if (ev >= fp) { after++; if (PRICE_AFFECTING.has(r.action)) priceAfter.push(r); }
    else before++;
  }
  console.log('  events after real first pitch: ' + after + '   before: ' + before
    + '   (' + (100 * after / (after + before)).toFixed(1) + '% after)');
  console.log('');

  console.log('=== price-affecting events after first pitch ===');
  console.log('  (actions: ' + [...PRICE_AFFECTING].join(', ') + ')');
  const byAction = {};
  priceAfter.forEach(r => { byAction[r.action] = (byAction[r.action] || 0) + 1; });
  Object.entries(byAction).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('    ' + k.padEnd(20) + v));
  console.log('    TOTAL                ' + priceAfter.length);
  console.log('');

  // The headline: of those, how many carried a PLAUSIBLE line -- i.e. one
  // that every existing guard would wave through.
  const impl = ml => { const n = Number(ml); return Number.isFinite(n) && n !== 0 && Math.abs(n) <= 1000; };
  let plausible = 0, caught = 0, noline = 0;
  const plausibleGames = new Set();
  for (const r of priceAfter) {
    const ml = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
    if (ml == null) { noline++; continue; }
    if (impl(ml)) { plausible++; plausibleGames.add(r.game_date + '|' + r.game_id); }
    else caught++;
  }
  console.log('=== THE NUMBER: post-start, but PLAUSIBLE (invisible to every guard) ===');
  console.log('  price-affecting events after first pitch : ' + priceAfter.length);
  console.log('    line implausible -> CAUGHT by guards   : ' + caught);
  console.log('    line plausible   -> INVISIBLE          : ' + plausible);
  console.log('    no stored line                         : ' + noline);
  console.log('  distinct games affected                  : ' + plausibleGames.size);
  console.log('');

  // How much of that is neutralised by post-lock immutability?
  let locked = 0, unlocked = 0;
  for (const r of priceAfter) {
    const ml = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
    if (ml == null || !impl(ml)) continue;
    if (r.odds_locked_at) {
      const lk = Date.parse(String(r.odds_locked_at).replace(' ', 'T') + 'Z');  // already UTC
      const fp = Date.parse(r.first_pitch_utc);
      if (lk != null && Number.isFinite(fp) && lk < fp) { locked++; continue; }
    }
    unlocked++;
  }
  console.log('=== how much is neutralised by post-lock immutability? ===');
  console.log('  odds_locked_at set BEFORE first pitch (price frozen pre-start, safe): ' + locked);
  console.log('  NOT locked before first pitch  -> REAL EXPOSURE                     : ' + unlocked);
  console.log('');

  // Season-wide denominator for scale.
  // Denominator must be SIGNALS, not events -- one signal accumulates many
  // refresh events, so an event count over a signal count exceeds 100% and
  // means nothing. Count distinct (game_date, game_id, type, side).
  const exposedSignals = new Set();
  for (const r of priceAfter) {
    const ml = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
    if (ml == null || !impl(ml)) continue;
    let safe = false;
    if (r.odds_locked_at) {
      const lk = Date.parse(String(r.odds_locked_at).replace(' ', 'T') + 'Z');
      const fp = Date.parse(r.first_pitch_utc);
      if (Number.isFinite(lk) && Number.isFinite(fp) && lk < fp) safe = true;
    }
    if (!safe) exposedSignals.add([r.game_date, r.game_id, r.signal_type, r.signal_side].join('|'));
  }
  const tot = db.prepare('SELECT COUNT(*) n FROM bet_signals').get().n;
  const act = db.prepare('SELECT COUNT(*) n FROM bet_signals WHERE is_active=1').get().n;
  let stillActive = 0;
  const q = db.prepare("SELECT COUNT(*) n FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type=? AND signal_side=? AND is_active=1");
  for (const k of exposedSignals) { const p = k.split('|'); if (q.get(p[0], p[1], p[2], p[3]).n > 0) stillActive++; }
  console.log('=== scale (per SIGNAL, not per event) ===');
  console.log('  bet_signals rows total: ' + tot + '   active: ' + act);
  console.log('  DISTINCT SIGNALS with post-start plausible pricing: ' + exposedSignals.size
    + '  (' + (100 * exposedSignals.size / Math.max(tot, 1)).toFixed(1) + '% of all signals)');
  console.log('  ... of which still active today: ' + stillActive);
  console.log('');
  console.log('CAVEAT: an audit event after first pitch does not prove the price');
  console.log('CHANGED -- COALESCE and the lock mean many refreshes are no-ops. This');
  console.log('is an upper bound on exposure, not a count of mispriced bets.');
})();
