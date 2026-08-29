#!/usr/bin/env node
/**
 * Did the capture actually run in PRODUCTION? (2026-08-26)
 *
 * A green deploy proves nothing about a scheduled job. `park_factors`
 * shipped with a monthly cron and no bootstrap; production came up with
 * zero rows and priced every park neutral until somebody looked. The 10AM
 * PT lineup pull added here has never fired anywhere, and neither has the
 * capture write behind it.
 *
 * So this asks production directly, over the admin API, rather than
 * inferring from the analysis copy -- which is a separately-evolved
 * database and cannot answer a question about prod.
 *
 *   ADMIN_TOKEN=... node scripts/verify-capture-in-prod.js
 *   ADMIN_TOKEN=... node scripts/verify-capture-in-prod.js --from 2026-08-27
 *
 * The token is read from the environment or .admin-token (gitignored).
 * It is never printed.
 *
 * THREE THINGS ARE CHECKED, and each can fail independently:
 *   1. captures exist at all, at BOTH horizons
 *   2. the 10AM PT hour specifically produced rows -- the new cron
 *   3. lead_minutes is populated, i.e. the start anchor reached game_log
 *      before the capture read it
 *
 * (3) is the one most likely to fail quietly: captures would still land,
 * look healthy in every count, and be useless for lead-bucketing.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.PROD_URL || 'https://mlb-analyzer.onrender.com';
function argOf(n, d) { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; }

// Default window: today PT and yesterday, which is where a just-deployed
// cron would show up. A wider window hides a job that ran once and stopped.
function ptDate(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
const FROM = argOf('--from', ptDate(-1));
const NEW_CRON_HOUR = 10;          // the pull added 2026-08-26

// Token loading and the admin fetch live in utils/admin-client.js. They
// used to live here, and when measure-price-oscillation.js needed the same
// thing a second copy was the obvious move -- which is how the duplicate-
// implementation problem starts. One module, two callers.
const admin = require(path.join(__dirname, '..', 'utils/admin-client'));
const q = (name, params) => admin.query(name, params, { base: BASE });

const rowsOf = j => (Array.isArray(j) ? j : (j && (j.rows || j.data || j.result)) || []);

let failures = 0;
const check = (label, pass, detail) => {
  console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + label + (detail ? '  -- ' + detail : ''));
  if (!pass) failures++;
};

(async () => {
  console.log('=== capture verification against PRODUCTION ===');
  console.log('  ' + BASE + '   window from ' + FROM + ' PT');
  console.log('');

  let cap;
  try { cap = rowsOf(await q('lineup-capture-health', { from: FROM })); }
  catch (e) {
    console.log('  [FAIL] lineup-capture-health query: ' + e.message);
    console.log('');
    console.log('  If this is a 400/unknown-query, the deploy predates the query');
    console.log('  whitelist entry. If it is a 401, the token is wrong.');
    process.exit(1);
  }

  console.log('--- (1) captures exist, at both horizons ---');
  if (!cap.length) {
    check('any capture rows since ' + FROM, false,
      'ZERO rows. Either the deploy has not happened, or no lineup cron has '
      + 'fired since it did, or the capture is throwing (grep [lineup-capture] in the log).');
  } else {
    for (const r of cap) {
      console.log('    ' + r.pt_date + '  ' + String(r.pt_hour).padStart(2, '0') + ':00 PT  '
        + String(r.horizon).padEnd(9) + ' rows=' + String(r.rows).padStart(4)
        + ' games=' + String(r.games).padStart(3)
        + ' with_lead=' + String(r.with_lead).padStart(4)
        + ' (sched ' + r.anchor_sched + ' / fp ' + r.anchor_fp + ')'
        + ' started=' + r.started + ' empty=' + r.empty_lineups);
    }
    const horizons = new Set(cap.map(r => r.horizon));
    check('same_day captures present', horizons.has('same_day'));
    check('next_day captures present', horizons.has('next_day'),
      horizons.has('next_day') ? '' : 'the 8PM PT tomorrow-slate prefetch may not have run yet');
  }

  console.log('');
  console.log('--- (2) the NEW 10AM PT pull specifically ---');
  const tenAm = cap.filter(r => r.pt_hour === NEW_CRON_HOUR);
  check('10AM PT hour produced capture rows', tenAm.length > 0,
    tenAm.length ? tenAm.map(r => r.pt_date + ':' + r.rows).join(', ')
                 : 'no rows in the 10:00 PT hour. This cron is new and has never run; '
                   + 'if other hours have rows and this one does not, the schedule entry '
                   + 'did not take.');

  console.log('');
  console.log('--- (3) the start anchor reached game_log before the capture ---');
  //
  // SCOPED TO WHAT THE CHECK CAN ACT ON. The captures written before the
  // anchor fix (PR #314, merge 2b59693 at 2026-08-26T22:36:05Z) came from
  // code that computed lead_minutes from first_pitch_utc alone, which is
  // null for any game that has not started. Those rows are NULL forever
  // and no run of anything will change that.
  //
  // Carried in the denominator they produce a check that can never pass,
  // and a check that fails forever is a check nobody reads -- the exact
  // failure just fixed in verify-commits-landed.js, where two false
  // positives had been sitting in the stranded list for weeks.
  //
  // THE BOUNDARY IS OBSERVED, NOT REMEMBERED. It comes from the earliest
  // capture_time carrying a non-null lead_anchor: a row can only have that
  // column populated if the fixed code wrote it. Same reasoning as the
  // park-factor regime, which classifies by comparing stored values
  // against both tables rather than by trusting a date. The merge time is
  // used only to SANITY-CHECK the observed boundary, never to set it.
  const ANCHOR_FIX_MERGED_UTC = '2026-08-26T22:36:05Z';   // PR #314, merge 2b59693

  let boundary = null, pre = null;
  try {
    const b = rowsOf(await q('lineup-capture-anchor-boundary', {}))[0];
    if (b) {
      boundary = b.first_anchored_at || null;
      pre = { total: b.total_rows, anchored: b.anchored_rows, first: b.first_capture_at };
    }
  } catch (e) {
    console.log('  (anchor-boundary query unavailable: ' + e.message + ')');
  }

  if (!boundary) {
    check('any capture carries a start anchor', false,
      'NO row anywhere has a lead_anchor. Either the anchor fix is not deployed, '
      + 'or refreshFirstPitch is not running before the capture.');
  } else {
    console.log('  anchor-fix boundary, OBSERVED from the data: ' + boundary);
    console.log('    (PR #314 merged ' + ANCHOR_FIX_MERGED_UTC + '; the merge time is a'
      + ' cross-check, not the filter)');
    if (boundary < ANCHOR_FIX_MERGED_UTC) {
      console.log('    WARNING: a row carries an anchor from BEFORE the fix merged.');
      console.log('    That should be impossible; the boundary logic needs re-checking.');
      failures++;
    }
    if (pre && pre.total > pre.anchored) {
      console.log('  EXCLUDED from this check: ' + (pre.total - pre.anchored)
        + ' pre-fix row(s), earliest capture ' + pre.first);
      console.log('    Written before the fix, permanently NULL, unfixable by any rerun.');
      console.log('    Reported, not dropped -- they are still in the table and still real.');
    }

    // Re-fetch scoped to post-boundary rows only.
    let scoped = [];
    try { scoped = rowsOf(await q('lineup-capture-health', { from: FROM, since_ts: boundary })); }
    catch (e) { console.log('  (scoped re-fetch failed: ' + e.message + ')'); }

    const totalRows = scoped.reduce((s, r) => s + r.rows, 0);
    const withLead = scoped.reduce((s, r) => s + r.with_lead, 0);
    const pct = totalRows ? 100 * withLead / totalRows : 0;
    check('lead_minutes populated on >=90% of POST-FIX captures',
      totalRows > 0 && pct >= 90,
      totalRows ? withLead + '/' + totalRows + ' = ' + pct.toFixed(1) + '%'
                : 'no post-fix rows in the window yet -- not a pass, just nothing to judge');
    if (totalRows && pct < 90) {
      console.log('        A post-fix capture with a NULL lead is a REAL defect -- the');
      console.log('        exclusion above does not cover it. Check that refreshFirstPitch');
      console.log('        ran with onlyMissing before the capture, and that the rows have');
      console.log('        a game_pk.');
    }
  }

  try {
    const fp = rowsOf(await q('first-pitch-anchor-coverage', { from: FROM, limit: 10 }));
    console.log('');
    console.log('  game_log anchor coverage (the backfill\'s progress):');
    for (const r of fp) {
      console.log('    ' + r.game_date + '  games=' + String(r.games).padStart(3)
        + '  with_pk=' + String(r.with_pk).padStart(3)
        + '  scheduled=' + String(r.with_scheduled).padStart(3)
        + '  first_pitch=' + String(r.with_first_pitch).padStart(3));
    }
    const recent = fp[0];
    if (recent) {
      check('today\'s slate has a scheduled start on every game with a game_pk',
        recent.with_scheduled >= recent.with_pk,
        recent.with_scheduled + '/' + recent.with_pk);
    }
  } catch (e) {
    console.log('  (first-pitch-anchor-coverage unavailable: ' + e.message + ')');
  }

  console.log('');
  console.log(failures ? failures + ' CHECK(S) FAILED' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('fatal: ' + (e && e.message)); process.exit(2); });
