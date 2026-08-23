#!/usr/bin/env node
/**
 * Did the post-first-pitch price actually MOVE? (2026-08-22)
 *
 * scripts/post-start-exposure.js produced an UPPER BOUND: 284 signals had
 * a price-affecting audit event after real first pitch. That counts
 * opportunities to be mispriced, not mispricings -- COALESCE and the odds
 * lock make many refreshes no-ops.
 *
 * This narrows it to signals whose stored line actually DIFFERS from the
 * last capture taken before first pitch, and reports the distribution of
 * |change| -- a 2-point drift and a 40-point drift are not the same
 * finding and must not be collapsed into one count.
 *
 * TIMEZONES (stated per the CLAUDE.md rule; this schema mixes them):
 *   empirical_market_captures.generated_at -- PT. Settled a priori: the
 *     'morning' capture track stamps 07:30:39, which is a morning cron in
 *     PT. Read as UTC that is 00:30 PT, and nothing called "morning" runs
 *     at half past midnight.
 *   game_log.first_pitch_utc -- ISO UTC from statsapi.
 *
 * COVERAGE LIMIT, stated up front: empirical_market_captures spans
 * 2026-06-11..2026-08-07 and 755 games. Signals outside that window have
 * no pre-first-pitch capture to compare against and are reported as
 * unmeasurable rather than silently dropped or assumed clean.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const PT_OFFSET_HOURS = 7;
function ptToUtcMs(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + PT_OFFSET_HOURS, +m[5], +m[6]);
}
const PRICE_AFFECTING = new Set(['insert', 'refresh', 'refresh_odds_tail']);

(function main() {
  // Rebuild the exposed set exactly as post-start-exposure.js defines it.
  const rows = db.prepare(
    'SELECT b.action, b.created_at, b.game_date, b.game_id, b.signal_type, b.signal_side, '
    + 'g.first_pitch_utc, g.odds_locked_at, g.market_away_ml, g.market_home_ml '
    + 'FROM bet_signal_audit b JOIN game_log g '
    + '  ON g.game_date = b.game_date AND g.game_id = b.game_id '
    + "WHERE g.first_pitch_utc IS NOT NULL AND b.signal_type = 'ML'"
  ).all();

  const impl = ml => { const n = Number(ml); return Number.isFinite(n) && n !== 0 && Math.abs(n) <= 1000; };
  const exposed = new Map();
  for (const r of rows) {
    if (!PRICE_AFFECTING.has(r.action)) continue;
    const ev = ptToUtcMs(r.created_at), fp = Date.parse(r.first_pitch_utc);
    if (ev == null || !Number.isFinite(fp) || ev < fp) continue;
    const ml = r.signal_side === 'away' ? r.market_away_ml : r.market_home_ml;
    if (ml == null || !impl(ml)) continue;
    if (r.odds_locked_at) {
      const lk = Date.parse(String(r.odds_locked_at).replace(' ', 'T') + 'Z');
      if (Number.isFinite(lk) && lk < fp) continue;   // frozen pre-start, safe
    }
    exposed.set([r.game_date, r.game_id, r.signal_side].join('|'), r);
  }
  console.log('=== narrowing the exposure to genuine price movement ===');
  console.log('  exposed ML signals (upper bound): ' + exposed.size);

  const lastPre = db.prepare(
    "SELECT away_price_ml a, home_price_ml h, generated_at ga FROM empirical_market_captures "
    + "WHERE market_type='ml' AND game_date=? AND game_id=? AND away_price_ml IS NOT NULL "
    + "ORDER BY generated_at"
  );
  const sigRow = db.prepare(
    "SELECT market_line, bet_line, is_active FROM bet_signals "
    + "WHERE game_date=? AND game_id=? AND signal_type='ML' AND signal_side=? LIMIT 1"
  );

  let unmeasurable = 0, noChange = 0;
  const changed = [];
  for (const [k, r] of exposed) {
    const [gd, gi, side] = k.split('|');
    const fp = Date.parse(r.first_pitch_utc);
    const caps = lastPre.all(gd, gi).filter(c => {
      const t = ptToUtcMs(c.ga); return t != null && t < fp;
    });
    if (!caps.length) { unmeasurable++; continue; }
    const pre = side === 'away' ? caps[caps.length - 1].a : caps[caps.length - 1].h;
    const sr = sigRow.get(gd, gi, side);
    const stored = sr ? Number(sr.market_line) : (side === 'away' ? r.market_away_ml : r.market_home_ml);
    if (pre == null || stored == null || !Number.isFinite(Number(pre))) { unmeasurable++; continue; }
    const d = Number(stored) - Number(pre);
    if (d === 0) noChange++;
    else changed.push({ gd, gi, side, pre: Number(pre), stored: Number(stored), d,
                        active: sr ? sr.is_active : null });
  }

  console.log('  no pre-first-pitch capture (outside 06-11..08-07 window): ' + unmeasurable);
  console.log('  price IDENTICAL to last pre-first-pitch capture (no-op)  : ' + noChange);
  console.log('  price CHANGED after first pitch                          : ' + changed.length);
  console.log('');

  if (!changed.length) { console.log('  nothing moved.'); return; }

  const abs = changed.map(c => Math.abs(c.d)).sort((a, b) => a - b);
  const q = p => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  console.log('=== distribution of |change| in American odds points ===');
  console.log('  n=' + abs.length + '   min ' + abs[0] + '   p25 ' + q(0.25) + '   median ' + q(0.5)
    + '   p75 ' + q(0.75) + '   p90 ' + q(0.90) + '   max ' + abs[abs.length - 1]);
  console.log('');
  const bands = [[1, 5], [5, 10], [10, 20], [20, 40], [40, 100], [100, 1e9]];
  console.log('  |change|      n    share   still_active');
  for (const [lo, hi] of bands) {
    const g = changed.filter(c => Math.abs(c.d) >= lo && Math.abs(c.d) < hi);
    const act = g.filter(c => c.active === 1).length;
    const lbl = hi > 1e8 ? (lo + '+') : (lo + '-' + hi);
    console.log('  ' + lbl.padEnd(11) + String(g.length).padStart(4) + '   '
      + (100 * g.length / changed.length).toFixed(1).padStart(5) + '%   ' + act);
  }
  console.log('');
  console.log('  A 2-point drift is ordinary market noise. A 40-point move on a game');
  console.log('  already in progress is the price reacting to the score.');
  console.log('');
  console.log('=== largest moves ===');
  changed.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12).forEach(c =>
    console.log('    ' + c.gd + ' ' + c.gi.padEnd(9) + c.side.padEnd(5)
      + ' pre ' + String(c.pre).padStart(6) + ' -> stored ' + String(c.stored).padStart(6)
      + '   d=' + (c.d > 0 ? '+' : '') + c.d + (c.active === 1 ? '   [ACTIVE]' : '')));
  console.log('');
  console.log('  still active among CHANGED: ' + changed.filter(c => c.active === 1).length);
})();
