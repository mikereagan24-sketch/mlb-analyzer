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

function token() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  for (const p of ['.admin-token', path.join(__dirname, '..', '.admin-token')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { /* next */ }
  }
  return null;
}

async function q(name, params) {
  const tok = token();
  if (!tok) throw new Error('no admin token: set ADMIN_TOKEN or create .admin-token');
  const url = new URL(BASE + '/api/admin/query/' + name);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { 'X-Admin-Token': tok } });
  const body = await r.text();
  if (!r.ok) throw new Error(name + ' -> HTTP ' + r.status + ': ' + body.slice(0, 300));
  try { return JSON.parse(body); } catch (e) { throw new Error(name + ' -> unparseable: ' + body.slice(0, 200)); }
}
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
  const totalRows = cap.reduce((s, r) => s + r.rows, 0);
  const withLead = cap.reduce((s, r) => s + r.with_lead, 0);
  const pct = totalRows ? 100 * withLead / totalRows : 0;
  check('lead_minutes populated on >=90% of captures', totalRows > 0 && pct >= 90,
    totalRows ? withLead + '/' + totalRows + ' = ' + pct.toFixed(1) + '%'
              : 'no rows to judge');
  if (totalRows && pct < 90) {
    console.log('        A capture with a NULL lead cannot be bucketed by lead, which is');
    console.log('        the analysis axis. Check that refreshFirstPitch ran with');
    console.log('        onlyMissing before the capture, and that the rows have a game_pk.');
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
