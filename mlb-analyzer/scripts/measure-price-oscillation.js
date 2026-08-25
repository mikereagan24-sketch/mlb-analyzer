#!/usr/bin/env node
/**
 * Reversal rate and directional bias between the two signal-price writers.
 * (2026-08-25)
 *
 * THIS EXISTS TO BE RUN BEFORE AND AFTER A FIX. `services/jobs.js` already
 * carries a comment asserting this ping-pong was fixed by a lazy-fetch
 * fallback; the reversal rate was 51% in July and 48% in August, i.e.
 * unchanged. That is the third comment in this repo asserting a resolution
 * the data contradicts, so the rule for the next attempt is: **attach a
 * number, not a comment.**
 *
 *   node scripts/measure-price-oscillation.js                  # whole audit
 *   node scripts/measure-price-oscillation.js --from 2026-08-26
 *
 * Report BOTH figures. The reversal rate alone is the wrong success
 * criterion, because it only counts writes that get undone — a
 * systematic bias on the writes that DON'T oscillate is invisible to it,
 * and that is the larger population.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

function argOf(n) { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; }
const FROM = argOf('--from');
const TO = argOf('--to');

// Implied probability. HIGHER = worse price for the bettor.
const ip = m => (m > 0 ? 100 / (m + 100) : (-m) / ((-m) + 100));
const pp = x => (x * 100).toFixed(4);

(function main() {
  const where = ["action IN ('refresh','refresh_odds_tail')", "detail LIKE '%market_line%'"];
  const binds = [];
  if (FROM) { where.push('created_at >= ?'); binds.push(FROM); }
  if (TO) { where.push('created_at <= ?'); binds.push(TO); }
  const rows = db.prepare(
    'SELECT signal_id, action, detail, created_at FROM bet_signal_audit WHERE '
    + where.join(' AND ') + ' ORDER BY signal_id, created_at').all(...binds);

  console.log('=== signal-price writers: reversal rate and directional bias ===');
  console.log('  window: ' + (FROM || 'all') + ' .. ' + (TO || 'now') + '   audit rows: ' + rows.length);
  console.log('');

  const prev = {};
  let changes = 0, reversals = 0, cross = 0;
  const perWriter = { refresh: [], refresh_odds_tail: [] };
  const crossDiff = [];

  for (const r of rows) {
    let d; try { d = JSON.parse(r.detail); } catch (e) { continue; }
    if (!d.market_line) continue;
    const f = d.market_line.from, t = d.market_line.to;
    if (f == null || t == null) continue;
    changes++;
    perWriter[r.action].push(ip(t) - ip(f));

    const p = prev[r.signal_id];
    if (p && p.to === f && p.from === t) {
      reversals++;
      if (p.action !== r.action) {
        cross++;
        const tail = r.action === 'refresh_odds_tail' ? t : f;
        const ups = r.action === 'refresh_odds_tail' ? f : t;
        crossDiff.push(ip(tail) - ip(ups));
      }
    }
    prev[r.signal_id] = { from: f, to: t, action: r.action };
  }

  // ---- (1) the symptom
  console.log('--- (1) REVERSAL RATE (the symptom) ---');
  console.log('  market_line changes : ' + changes);
  console.log('  immediate reversals : ' + reversals
    + (changes ? '  (' + (100 * reversals / changes).toFixed(1) + '%)' : ''));
  console.log('  of which cross-writer: ' + cross);
  console.log('');

  // ---- (2) the cause, and the number that actually matters
  console.log('--- (2) DIRECTIONAL BIAS (the cause) ---');
  console.log('  Measured over ALL changes, not just reversals. A writer with a');
  console.log('  symmetric role sits near 0.0000pp with a ~50% down-split.');
  console.log('');
  console.log('  writer               n       mean d(implied)   median        moved DOWN (better price)');
  for (const k of Object.keys(perWriter)) {
    const a = perWriter[k].slice().sort((x, y) => x - y);
    if (!a.length) { console.log('  ' + k.padEnd(20) + '     0'); continue; }
    const mean = a.reduce((s, x) => s + x, 0) / a.length;
    const down = a.filter(x => x < 0).length;
    console.log('  ' + k.padEnd(20) + String(a.length).padStart(6) + '   ' + pp(mean).padStart(9) + 'pp   '
      + pp(a[Math.floor(a.length / 2)]).padStart(9) + 'pp   '
      + down + ' (' + (100 * down / a.length).toFixed(1) + '%)');
  }

  if (crossDiff.length) {
    const a = crossDiff.slice().sort((x, y) => x - y);
    const n = a.length;
    const mean = a.reduce((s, x) => s + x, 0) / n;
    const pos = a.filter(x => x > 0).length, neg = a.filter(x => x < 0).length;
    const se = Math.sqrt(0.25 / (pos + neg));
    const z = ((pos / (pos + neg)) - 0.5) / se;
    console.log('');
    console.log('  head-to-head on the same signal, implied(odds_tail) - implied(upsert):');
    console.log('    n=' + n + '   mean ' + pp(mean) + 'pp   median ' + pp(a[Math.floor(n / 2)]) + 'pp');
    console.log('    odds_tail cheaper: ' + neg + ' (' + (100 * neg / n).toFixed(1) + '%)   '
      + 'dearer: ' + pos + ' (' + (100 * pos / n).toFixed(1) + '%)');
    console.log('    sign-split z vs 50/50: ' + z.toFixed(2) + '   '
      + (Math.abs(z) > 2
        ? '*** DIRECTIONAL -- one writer is on a different side of the spread ***'
        : 'symmetric -- consistent with rounding'));
  }

  console.log('');
  console.log('  SUCCESS CRITERION FOR A FIX: both writers near 0.0000pp with a ~50%');
  console.log('  down-split, AND the reversal rate down. The first matters more --');
  console.log('  a bias on non-oscillating writes never shows up in the second.');
})();
