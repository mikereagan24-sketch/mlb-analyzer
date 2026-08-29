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
 *   node scripts/measure-price-oscillation.js                  # local copy
 *   node scripts/measure-price-oscillation.js --from 2026-08-26
 *   ADMIN_TOKEN=... node scripts/measure-price-oscillation.js --prod --from 2026-08-26
 *
 * USE --prod FOR ANY POST-DEPLOY CLAIM. The fix this measures shipped to
 * production, so production is the only place that can confirm or refute
 * it. The local file is a separately-evolved analysis copy and answering
 * from it has already produced one false report. Every run prints which
 * database it read, so a figure can never be quoted without its source.
 *
 * --prod reads the whitelisted `price-write-details` query and pages it to
 * completion; it does not need the 671MB download that motivated the query.
 *
 * Report BOTH figures. The reversal rate alone is the wrong success
 * criterion, because it only counts writes that get undone — a
 * systematic bias on the writes that DON'T oscillate is invisible to it,
 * and that is the larger population.
 */
const path = require('path');
const R = path.join(__dirname, '..');

function argOf(n) { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; }
const FROM = argOf('--from');
const TO = argOf('--to');
const PROD = process.argv.includes('--prod');

// --prod reads PRODUCTION through the admin query API. (2026-08-29)
//
// This measurement is about a fix that shipped to production with a stated
// prediction, so the analysis copy cannot answer it -- it is a separately
// evolved database, and treating it as production's stand-in already
// produced one false outage report. The alternative was a 671MB download
// on every run, which is why `price-write-details` was whitelisted in the
// first place; it just had no caller until now.
//
// The local DB is NOT opened in --prod mode. Opening it lazily keeps the
// script runnable on a machine that has no copy at all.
const admin = PROD ? require(path.join(R, 'utils/admin-client')) : null;
let db = null;
if (!PROD) {
  const Database = require(path.join(R, 'node_modules/better-sqlite3'));
  db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });
}

// Rows in the same shape either way: {signal_id, action, detail, created_at}
// ordered by (signal_id, created_at). The admin query orders identically,
// which is what lets the reversal walk below be source-agnostic.
async function loadRows() {
  if (!PROD) {
    const where = ["action IN ('refresh','refresh_odds_tail')", "detail LIKE '%market_line%'"];
    const binds = [];
    if (FROM) { where.push('created_at >= ?'); binds.push(FROM); }
    if (TO) { where.push('created_at <= ?'); binds.push(TO); }
    return { rows: db.prepare(
      'SELECT signal_id, action, detail, created_at FROM bet_signal_audit WHERE '
      + where.join(' AND ') + ' ORDER BY signal_id, created_at').all(...binds), pages: 1 };
  }
  // Paged on signal_id. The endpoint caps at 1000 rows with no OFFSET, so
  // without this a full-history run would measure the first page and report
  // a reversal rate that looks perfectly plausible and is wrong.
  return admin.fetchAll('price-write-details',
    { from: FROM, to: TO, limit: 1000 }, 'after_signal_id', 'signal_id');
}

// Implied probability. HIGHER = worse price for the bettor.
const ip = m => (m > 0 ? 100 / (m + 100) : (-m) / ((-m) + 100));
const pp = x => (x * 100).toFixed(4);

(async function main() {
  const loaded = await loadRows();
  const rows = loaded.rows;

  console.log('=== signal-price writers: reversal rate and directional bias ===');
  console.log('  source: ' + (PROD ? 'PRODUCTION via admin API (' + loaded.pages + ' page' + (loaded.pages===1?'':'s') + ')' : 'local data/mlb.db (analysis copy -- NOT production)'));
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
  // --- (3) COUNTERFACTUAL: what the no-venue-downgrade guard would have done.
  //
  // The 'after' number cannot exist until production has run with the guard,
  // so this replays the guard's predicate over the SAME historical rows: a
  // `refresh` write is dropped when it moved price_venue from a real venue to
  // null, which is exactly the condition the guard blocks. Everything else is
  // replayed unchanged. It is a projection on real data, not a live result --
  // labelled as such, and it does not substitute for the post-deploy run.
  if (process.argv.includes('--replay-guard')) {
    const kept = [];
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail); } catch (e) { continue; }
      if (!d.market_line) continue;
      const blocked = r.action === 'refresh' && d.price_venue
        && d.price_venue.from != null && d.price_venue.to == null;
      if (!blocked) kept.push({ id: r.signal_id, action: r.action, f: d.market_line.from, t: d.market_line.to });
    }
    const prev2 = {};
    let ch = 0, rev = 0;
    const per = { refresh: [], refresh_odds_tail: [] };
    for (const r of kept) {
      ch++; per[r.action].push(ip(r.t) - ip(r.f));
      const p = prev2[r.id];
      if (p && p.to === r.f && p.from === r.t) rev++;
      prev2[r.id] = { from: r.f, to: r.t, action: r.action };
    }
    console.log('');
    console.log('--- (3) COUNTERFACTUAL with the no-venue-downgrade guard ---');
    console.log('  PROJECTION over historical rows, not a live measurement.');
    console.log('  writes dropped (venue -> null on the upsert path): ' + (changes - ch));
    console.log('  market_line changes : ' + changes + '  ->  ' + ch);
    console.log('  reversal rate       : ' + (100 * reversals / changes).toFixed(1) + '%  ->  '
      + (ch ? (100 * rev / ch).toFixed(1) : '0.0') + '%');
    for (const k of Object.keys(per)) {
      const a = per[k];
      if (!a.length) { console.log('  ' + k.padEnd(20) + ' n=0'); continue; }
      const mean = a.reduce((s, x) => s + x, 0) / a.length;
      const down = a.filter(x => x < 0).length;
      console.log('  ' + k.padEnd(20) + ' n=' + String(a.length).padStart(5)
        + '  mean ' + pp(mean).padStart(9) + 'pp  down ' + (100 * down / a.length).toFixed(1) + '%');
    }
    // LIKE-FOR-LIKE. The means above CANNOT reach zero once degradation
    // stops, and that is not a residual bias -- it is composition. With
    // venue->null blocked, the surviving upsert writes are
    // disproportionately null->venue ACQUISITIONS, which legitimately
    // improve the price (null->poly -0.93pp, null->kalshi -0.99pp). So
    // 'both writers near 0.0000pp' is the WRONG success criterion in the
    // presence of a one-way transition.
    //
    // The pricing comparison that IS like-for-like is writes where the
    // venue did not change. That was already near-symmetric before the
    // guard (-0.2391pp, 53.2% down), which is the same evidence that
    // killed the bid-vs-ask hypothesis.
    const same = { refresh: [], refresh_odds_tail: [] };
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail); } catch (e) { continue; }
      if (!d.market_line || d.price_venue) continue;
      same[r.action].push(ip(d.market_line.to) - ip(d.market_line.from));
    }
    console.log('');
    console.log('  LIKE-FOR-LIKE (venue unchanged) -- the real pricing comparison:');
    for (const k of Object.keys(same)) {
      const a = same[k];
      if (!a.length) { console.log('    ' + k.padEnd(20) + ' n=0'); continue; }
      const mean = a.reduce((s, x) => s + x, 0) / a.length;
      const down = a.filter(x => x < 0).length;
      console.log('    ' + k.padEnd(20) + ' n=' + String(a.length).padStart(5)
        + '  mean ' + pp(mean).padStart(9) + 'pp  down ' + (100 * down / a.length).toFixed(1) + '%');
    }
  }

  console.log('  SUCCESS CRITERION FOR A FIX: both writers near 0.0000pp with a ~50%');
  console.log('  down-split, AND the reversal rate down. The first matters more --');
  console.log('  a bias on non-oscillating writes never shows up in the second.');
})().catch(e => {
  // A stack trace is the wrong output for a check someone runs to get a
  // number. The likely failures here are operational -- no token, a rotated
  // token, the endpoint disabled -- and each of those has a specific fix
  // that the message should name.
  console.error('');
  console.error('FAILED: ' + (e && e.message ? e.message : e));
  if (PROD) {
    console.error('');
    console.error('  --prod reads production over the admin API. It needs the same value');
    console.error('  as the DB_DOWNLOAD_TOKEN env var on the server:');
    console.error('    ADMIN_TOKEN=... node scripts/measure-price-oscillation.js --prod');
    console.error('  or put it in a .admin-token file (gitignored).');
    console.error('  Drop --prod to measure the local analysis copy instead -- but do not');
    console.error('  quote that number as a production result.');
  }
  process.exit(1);
});
