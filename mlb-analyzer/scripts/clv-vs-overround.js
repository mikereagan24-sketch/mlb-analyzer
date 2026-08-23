#!/usr/bin/env node
/**
 * CLV against the vig it has to clear, on OBSERVED closes only. (2026-08-23)
 *
 * THE ORIGINAL QUESTION. Positive CLV is necessary for profitability, not
 * sufficient -- it has to exceed the per-side overround. The earlier pass
 * put CLV at +0.78pp against ~2.25pp per side and concluded net -1.47pp.
 * That +0.78pp is now known to be diluted: 187 of those 273 rows had an
 * ASSUMED closing line (closing_line = market_line), which degenerates CLV
 * into "bet price vs emit price" and centres it near zero.
 *
 * This recomputes on the 86 rows whose closing line was actually observed
 * -- captured, re-derived from a capture, or moved (so not a backfill copy).
 *
 * THE OVERROUND IS COMPUTED, NOT ASSUMED. The 4.50pp figure is taken from
 * the same closing captures the CLV is measured against, so both sides of
 * the comparison come from one source at one moment. Quoting a remembered
 * constant against a freshly-measured CLV would be comparing two different
 * markets.
 *
 * TIMEZONES (per the CLAUDE.md rule -- this schema mixes them):
 *   bet_signals.bet_locked_at              -- UTC (SQL datetime('now')).
 *       Verified a priori: a logged bet must precede first pitch. Read as
 *       UTC, 184 of 189 do; read as PT, 61 are impossible.
 *   bet_signal_audit.created_at            -- PT. DIFFERENT COLUMN,
 *       DIFFERENT ZONE, same table family.
 *   empirical_market_captures.generated_at -- PT.
 *   game_log.first_pitch_utc               -- UTC.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const WINDOW_MIN = 60;
const BOOT = 4000;

const ptToUtcMs = s => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 7, +m[5], +m[6]) : null;
};
const utcMs = s => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};
const impl = ml => { const n = Number(ml); if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100); };

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Date-clustered bootstrap on the mean of `vals`, grouped by date.
function clusteredCI(items, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it.v); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) { for (const v of byDate.get(dates[Math.floor(rnd() * n)])) { s += v; c++; } }
    if (c) out.push(s / c);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const f = v => v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2);

// Last ML capture within the window before first pitch -- both sides.
function closingPair(gameDate, gameId, fpUtc) {
  const fp = Date.parse(fpUtc);
  if (!Number.isFinite(fp)) return null;
  const caps = db.prepare(
    "SELECT generated_at, away_price_ml a, home_price_ml h FROM empirical_market_captures "
    + "WHERE market_type='ml' AND game_date=? AND game_id=? AND away_price_ml IS NOT NULL "
    + "AND home_price_ml IS NOT NULL").all(gameDate, gameId);
  let best = null;
  for (const c of caps) {
    const t = ptToUtcMs(c.generated_at);
    if (t == null || t >= fp || (fp - t) > WINDOW_MIN * 60000) continue;
    if (!best || t > best.t) best = { t, a: c.a, h: c.h };
  }
  return best;
}

(function main() {
  console.log('=== CLV vs the overround it must clear -- OBSERVED closes only ===');
  console.log('');

  const OBS = "EXISTS (SELECT 1 FROM bet_signal_audit a WHERE a.signal_id=b.id "
    + "AND a.action IN ('set_closing_line','rederived_closing_line','observed_no_audit'))";
  const rows = db.prepare(
    "SELECT b.id, b.game_date, b.game_id, b.signal_side, b.bet_line, b.closing_line, b.clv, "
    + "       b.bet_locked_at, b.pnl, b.outcome, g.first_pitch_utc "
    + "FROM bet_signals b JOIN game_log g ON g.game_date=b.game_date AND g.game_id=b.game_id "
    + "WHERE b.signal_type='ML' AND b.clv IS NOT NULL AND " + OBS).all();

  console.log('  observed-only ML bets with CLV: ' + rows.length);

  // ---- overround, measured from the same closing captures
  // Measured over EVERY game with a closing pair in the window, not just the
  // games that were bet. Overround is a property of the market, not of the
  // bet selection, and restricting it to the 86 bet games gave n=11 -- too
  // thin to anchor the comparison, and needlessly selected.
  const orItems = [];
  const orGames = db.prepare(
    "SELECT DISTINCT e.game_date, e.game_id, g.first_pitch_utc FROM empirical_market_captures e "
    + "JOIN game_log g ON g.game_date=e.game_date AND g.game_id=e.game_id "
    + "WHERE e.market_type='ml' AND e.away_price_ml IS NOT NULL AND g.first_pitch_utc IS NOT NULL"
  ).all();
  for (const g of orGames) {
    const pair = closingPair(g.game_date, g.game_id, g.first_pitch_utc);
    if (!pair) continue;
    const pa = impl(pair.a), ph = impl(pair.h);
    if (pa == null || ph == null) continue;
    orItems.push({ d: g.game_date, v: (pa + ph - 1) * 100 });
  }
  const orMean = mean(orItems.map(x => x.v));
  const orCI = clusteredCI(orItems, 991);
  console.log('');
  console.log('=== closing overround, measured from the same captures ===');
  console.log('  games with a closing pair inside ' + WINDOW_MIN + 'm : ' + orItems.length
    + '   (all games, not just the bet ones)');
  console.log('  total overround : ' + f(orMean) + 'pp   95% CI [' + f(orCI[0]) + ', ' + f(orCI[1]) + ']');
  console.log('  PER SIDE        : ' + f(orMean / 2) + 'pp   (a one-sided bet pays half the two-way vig)');

  // ---- CLV and net
  function report(label, subset) {
    if (!subset.length) { console.log('  ' + label.padEnd(22) + ' n=0'); return; }
    const items = subset.map(r => ({ d: r.game_date, v: r.clv }));
    const m = mean(items.map(x => x.v));
    const ci = clusteredCI(items, 7717);
    const perSide = orMean / 2;
    const netItems = subset.map(r => ({ d: r.game_date, v: r.clv - perSide }));
    const nm = mean(netItems.map(x => x.v));
    const nci = clusteredCI(netItems, 8823);
    const posPct = 100 * subset.filter(r => r.clv > 0).length / subset.length;
    console.log('  ' + label.padEnd(22) + ' n=' + String(subset.length).padStart(3)
      + '   CLV ' + f(m) + 'pp [' + f(ci[0]) + ', ' + f(ci[1]) + ']'
      + '   NET ' + f(nm) + 'pp [' + f(nci[0]) + ', ' + f(nci[1]) + ']'
      + '   CLV>0 on ' + posPct.toFixed(0) + '%');
    return { n: subset.length, m, ci, nm, nci };
  }

  console.log('');
  console.log('=== CLV, and net of the per-side overround ===');
  console.log('  (net > 0 means the picks clear the vig)');
  report('ALL observed', rows);

  // ---- day-before vs same-day
  // bet_locked_at is UTC; the operator's day is PT. Convert to PT and compare
  // the calendar date to game_date -- "the day before" is a calendar notion,
  // not a lead-time threshold.
  const withFp = rows.filter(r => r.bet_locked_at);
  const dayBefore = [], sameDay = [], unknown = [];
  for (const r of rows) {
    if (!r.bet_locked_at) { unknown.push(r); continue; }
    const t = utcMs(r.bet_locked_at);
    if (t == null) { unknown.push(r); continue; }
    const ptDate = new Date(t - 7 * 3600000).toISOString().slice(0, 10);
    if (ptDate < r.game_date) dayBefore.push(r);
    else if (ptDate === r.game_date) sameDay.push(r);
    else unknown.push(r);   // locked after the game date
  }
  console.log('');
  console.log('=== split by when the bet was placed (PT calendar day vs game date) ===');
  report('day-before (or earlier)', dayBefore);
  report('same-day', sameDay);
  if (unknown.length) console.log('  unclassified            n=' + unknown.length);

  // lead-time detail, since "day before" hides a wide range
  const leads = rows.filter(r => r.bet_locked_at && r.first_pitch_utc)
    .map(r => (Date.parse(r.first_pitch_utc) - utcMs(r.bet_locked_at)) / 3600000)
    .filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (leads.length) {
    console.log('');
    console.log('  lead time before first pitch (h): min ' + leads[0].toFixed(1)
      + '  p25 ' + leads[Math.floor(0.25 * leads.length)].toFixed(1)
      + '  median ' + leads[Math.floor(0.5 * leads.length)].toFixed(1)
      + '  p75 ' + leads[Math.floor(0.75 * leads.length)].toFixed(1)
      + '  max ' + leads[leads.length - 1].toFixed(1) + '   (n=' + leads.length + ')');
  }

  console.log('');
  console.log('=== for contrast: the diluted figure this replaces ===');
  const all = db.prepare("SELECT game_date d, clv v FROM bet_signals WHERE signal_type='ML' AND clv IS NOT NULL").all();
  const am = mean(all.map(x => x.v));
  const aci = clusteredCI(all, 5150);
  console.log('  ALL ML rows incl. assumed closes: n=' + all.length + '   CLV ' + f(am)
    + 'pp [' + f(aci[0]) + ', ' + f(aci[1]) + ']');
  console.log('  187 of those have an ASSUMED close, where CLV degenerates to');
  console.log('  "bet price vs emit price" and centres near zero.');
})();
