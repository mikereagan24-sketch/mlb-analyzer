#!/usr/bin/env node
/**
 * Post-deploy observables for #338. (2026-09-02)
 *
 * TWO THINGS, and they are different kinds of claim:
 *
 *   A. first_pitch_utc populates DURING the live slate, not next morning.
 *      This is the branch of gameHasStarted that has never fired inside the
 *      window it was written for -- 0/15 mid-slate on 2026-09-02 while one
 *      game was in the 8th, against 15/15 and 12/12 on the two finished
 *      days. A started game with a non-null first_pitch_utc is the proof.
 *
 *   B. the venue override stops re-fetching on started games. This is the
 *      fix that stops the value EXISTING rather than suppressing it after
 *      the fact, so the observable is an ABSENCE: no market-gate
 *      suppression should be recorded against a started game any more.
 *
 * B's absence is only meaningful alongside evidence that the pass ran at
 * all, so this reports the pass evidence next to it rather than letting an
 * empty result read as success on its own.
 *
 * Usage:
 *   node scripts/verify-post-start-fixes-live.js
 *   node scripts/verify-post-start-fixes-live.js --date 2026-09-02
 */
const path = require('path');
const R = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const BASE = (argOf('--url') || 'https://mlb-analyzer.onrender.com').replace(/\/$/, '');
// --since <ISO>: when the fix deployed. Both observables are claims about
// what the NEW code does, so a pass that ran before the deploy proves
// nothing either way. Without this, an empty result reads as success when
// it may only mean the code has not run -- the same trap as the vacuous
// edge-cap assertion and the empty logged-bets list.
const SINCE = argOf('--since');
const DATE = argOf('--date')
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const { LIVE_OR_DONE } = require(path.join(R, 'services/first-pitch'));

function get(url, depth) {
  depth = depth || 0;
  return new Promise(res => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, { headers: { Accept: 'application/json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 4)
        return res(get(new URL(r.headers.location, url).toString(), depth + 1));
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => res({ s: r.statusCode, ct: r.headers['content-type'] || '', b }));
    }).on('error', e => res({ s: 0, ct: '', b: e.message }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let r = null;
  for (let i = 1; i <= 8; i++) {
    r = await get(BASE + '/api/games/' + DATE);
    if (r.s === 200 && /json/i.test(r.ct)) break;
    console.log('  (attempt ' + i + ': status ' + r.s + ')');
    await sleep(10000);
  }
  if (!(r.s === 200 && /json/i.test(r.ct))) { console.log('API unavailable'); process.exit(1); }
  const games = JSON.parse(r.b);
  const now = Date.now();

  const started = games.filter(g => {
    if (g.first_pitch_utc) return true;
    if (g.game_status && LIVE_OR_DONE.has(String(g.game_status))) return true;
    if (g.scheduled_start_utc) return now >= Date.parse(g.scheduled_start_utc);
    return false;
  });

  console.log('=== #338 POST-DEPLOY OBSERVABLES ===');
  console.log('  ' + BASE + '   date ' + DATE);
  console.log('  games ' + games.length + '   judged started ' + started.length);
  console.log('');

  // ---- A. first_pitch_utc during the live window ------------------------
  const fpAll = games.filter(g => g.first_pitch_utc).length;
  const fpStarted = started.filter(g => g.first_pitch_utc).length;
  console.log('A. first_pitch_utc DURING the slate');
  console.log('   populated, whole slate   : ' + fpAll + '/' + games.length);
  console.log('   populated, started games : ' + fpStarted + '/' + started.length);
  console.log('');
  console.log('   game        status         sched_start_utc        first_pitch_utc');
  for (const g of games) {
    const isS = started.includes(g);
    console.log('   ' + String(g.game_id).padEnd(11)
      + String(g.game_status || '-').padEnd(15)
      + String(g.scheduled_start_utc || '-').padEnd(23)
      + String(g.first_pitch_utc || '-')
      + (isS && !g.first_pitch_utc ? '   <-- STARTED, still null' : ''));
  }
  console.log('');
  if (!started.length) {
    console.log('   VERDICT: inconclusive -- no game has started yet today.');
    console.log('   Re-run once the first game is under way; before that, a null');
    console.log('   column is correct and proves nothing.');
  } else if (fpStarted > 0) {
    console.log('   VERDICT: PASS. ' + fpStarted + ' started game(s) carry a real first pitch');
    console.log('   during the live slate. That branch of gameHasStarted has never');
    console.log('   fired in this window before.');
  } else {
    console.log('   VERDICT: NOT YET. Every started game still reads null.');
    console.log('   NOTE: this is expected until a lineup pass runs AFTER the deploy --');
    console.log('   that job carries refreshFirstPitch. Passes fire at 8/10/12/13/14/');
    console.log('   15/16/17/18 and 23 PT.');
    console.log('   Either the deploy has not landed, or no lineup pass has run since');
    console.log('   the first game started -- that job carries the refresh. Check for');
    console.log('   [first-pitch] in the log with a non-zero "with real first pitch".');
  }
  console.log('');

  // ---- B. no market-gate suppression on a started game ------------------
  const sup = await get(BASE + '/api/signals/suppressed?date=' + DATE);
  console.log('B. venue override no longer re-fetches on started games');
  let gateRows = [];
  if (/json/i.test(sup.ct)) {
    try { const p = JSON.parse(sup.b); gateRows = Array.isArray(p) ? p : []; } catch (e) { gateRows = []; }
  } else {
    console.log('   (suppression endpoint returned ' + sup.s + ' / non-JSON; treating as no rows)');
  }
  const startedIds = new Set(started.map(g => g.game_id));
  const offending = (gateRows || []).filter(x =>
    startedIds.has(x.game_id) && /market gate|impossible|magnitude|in-game/i.test(String(x.reason || '')));
  console.log('   suppression rows returned      : ' + (gateRows || []).length);
  console.log('   ...against a STARTED game      : ' + offending.length);
  for (const o of offending)
    console.log('     ' + o.game_id + '  ' + o.signal_type + '/' + o.signal_side
      + '  mkt=' + o.market_line + '  reason=' + String(o.reason).slice(0, 70));
  console.log('');

  // Pass evidence, so an empty result is not read as success on its own.
  const upd = games.map(g => g.updated_at).filter(Boolean).sort();
  console.log('   pass evidence: game_log updated_at ranges '
    + (upd[0] || '-') + ' .. ' + (upd[upd.length - 1] || '-'));
  console.log('   (an empty offending list means nothing if no pass has run)');
  console.log('');
  const lastPass = upd.length ? Date.parse(String(upd[upd.length - 1]).replace(' ', 'T') + 'Z') : NaN;
  const sinceMs = SINCE ? Date.parse(SINCE) : NaN;
  const passedAfterDeploy = Number.isFinite(lastPass) && Number.isFinite(sinceMs) && lastPass >= sinceMs;
  if (SINCE) {
    console.log('   deploy given as ' + SINCE + ' -- last pass '
      + (passedAfterDeploy ? 'IS after it' : 'is BEFORE it'));
    console.log('');
  }
  if (!started.length) {
    console.log('   VERDICT: inconclusive -- nothing has started to re-fetch for.');
  } else if (SINCE && !passedAfterDeploy) {
    console.log('   VERDICT: INCONCLUSIVE. No pass has run since the deploy, so the');
    console.log('   new code has not executed yet. An empty result here would be the');
    console.log('   same empty result the old code produced on a quiet day -- it');
    console.log('   cannot tell you the override stopped re-fetching.');
  } else if (offending.length === 0) {
    console.log('   VERDICT: PASS' + (SINCE ? '.' : ', conditional -- pass --since <deploy ISO> to')
      + (SINCE ? '' : ' rule out that the new code simply has not run.'));
    console.log('   No market-gate suppression is recorded against any started game,');
    console.log('   which is the shape expected when the override stops pulling live');
    console.log('   quotes rather than pulling and then rejecting them.');
  } else {
    console.log('   VERDICT: FAIL. A started game still produced a market-gate row,');
    console.log('   so live quotes are still reaching the sanity check.');
  }
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
