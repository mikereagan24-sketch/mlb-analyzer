#!/usr/bin/env node
/**
 * Next-slate confirmation after #341/#342. (2026-09-03)
 *
 * THREE CHECKS, and the third is the one that matters most because it is
 * the only one that can tell you the serialisation actually took:
 *
 *   1. first_pitch_utc populating on started games.
 *   2. no OOM events -- inferred here from uptime continuity, since the
 *      instance-failure record lives in Render, not the app.
 *   3. the [boot-chain] lines appearing IN SEQUENCE rather than
 *      interleaved. Only the Render log shows this; the strings to grep
 *      are printed below so the check is mechanical.
 *
 * Checks 1 and 2 are observable from here. Check 3 is not, so this script
 * prints the exact grep rather than pretending to verify it.
 *
 * Usage:
 *   node scripts/verify-next-slate.js
 *   node scripts/verify-next-slate.js --date 2026-09-04 --since <deploy ISO>
 */
const path = require('path');
const R = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const BASE = (argOf('--url') || 'https://mlb-analyzer.onrender.com').replace(/\/$/, '');
const SINCE = argOf('--since');
const DATE = argOf('--date')
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const { LIVE_OR_DONE } = require(path.join(R, 'services/first-pitch'));
const ptOf = u => new Date(Date.parse(u) - 7 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

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
  let r = null, attempts = 0, fiveOhTwos = 0;
  for (let i = 1; i <= 8; i++) {
    attempts++;
    r = await get(BASE + '/api/games/' + DATE);
    if (r.s === 502 || r.s === 503) fiveOhTwos++;
    if (r.s === 200 && /json/i.test(r.ct)) break;
    await sleep(10000);
  }
  if (!(r.s === 200 && /json/i.test(r.ct))) { console.log('API unavailable (' + r.s + ')'); process.exit(1); }
  const games = JSON.parse(r.b);
  const now = Date.now();
  const started = games.filter(g =>
    g.first_pitch_utc
    || (g.game_status && LIVE_OR_DONE.has(String(g.game_status)))
    || (g.scheduled_start_utc && now >= Date.parse(g.scheduled_start_utc)));

  console.log('=== NEXT-SLATE CONFIRMATION (#341 boot, #342 first-pitch) ===');
  console.log('  ' + BASE + '   date ' + DATE);
  console.log('  games ' + games.length + '   started ' + started.length);
  console.log('');

  // ---- 1. first_pitch_utc on started games ------------------------------
  const fp = started.filter(g => g.first_pitch_utc);
  console.log('1. first_pitch_utc ON STARTED GAMES');
  console.log('   ' + fp.length + '/' + started.length + ' anchored');
  console.log('');
  console.log('   game        sched(PT)   status            first_pitch(PT)   wait');
  for (const g of started.slice().sort((a, b) =>
      String(a.scheduled_start_utc).localeCompare(String(b.scheduled_start_utc)))) {
    const wait = (g.first_pitch_utc && g.scheduled_start_utc)
      ? Math.round((Date.parse(g.first_pitch_utc) - Date.parse(g.scheduled_start_utc)) / 60000) + 'm'
      : '-';
    console.log('   ' + String(g.game_id).padEnd(12)
      + String(g.scheduled_start_utc ? ptOf(g.scheduled_start_utc).slice(11, 16) : '-').padEnd(12)
      + String(g.game_status || '-').slice(0, 17).padEnd(18)
      + String(g.first_pitch_utc ? ptOf(g.first_pitch_utc).slice(11, 16) : '—').padEnd(18)
      + wait);
  }
  console.log('');
  if (!started.length) {
    console.log('   VERDICT: inconclusive -- nothing has started yet.');
  } else if (fp.length > 0) {
    console.log('   VERDICT: PASS. The authoritative branch is firing inside the live');
    console.log('   window. A wait of a few minutes is the real first-pitch delay; a');
    console.log('   wait of 0m on every row would instead mean scheduled was copied.');
  } else {
    console.log('   VERDICT: NOT YET -- no lineup pass has run since the first start,');
    console.log('   or the deploy has not landed. Passes: 8,10,12,13,14,15,16,17,18,23 PT.');
  }
  console.log('');

  // ---- 2. OOM / uptime continuity ---------------------------------------
  console.log('2. NO OOM EVENTS (inferred -- the record lives in Render)');
  console.log('   API attempts this run: ' + attempts + '   502/503 seen: ' + fiveOhTwos);
  const upd = games.map(g => g.updated_at).filter(Boolean).sort();
  console.log('   game_log updated_at: ' + (upd[0] || '-') + ' .. ' + (upd[upd.length - 1] || '-'));
  if (SINCE) {
    const last = upd.length ? Date.parse(String(upd[upd.length - 1]).replace(' ', 'T') + 'Z') : NaN;
    const since = Date.parse(SINCE);
    console.log('   deploy ' + SINCE + ' -- last pass '
      + (Number.isFinite(last) && last >= since ? 'IS after it' : 'is BEFORE it'));
  }
  console.log('   ' + (fiveOhTwos === 0
    ? 'No 502s this run. Consistent with a stable instance, but ABSENCE OF'
    : fiveOhTwos + ' 502(s) this run -- could be a cold start or a crash;'));
  console.log('   ' + (fiveOhTwos === 0
    ? '   502s here is weak evidence: a crash loop between checks is invisible.'
    : '   Render is the only place that distinguishes them.'));
  console.log('');

  // ---- 3. the serialisation check ---------------------------------------
  console.log('3. [boot-chain] IN SEQUENCE -- THE CHECK THAT SERIALISATION TOOK');
  console.log('   Not observable from here. Grep the Render log for:');
  console.log('');
  console.log('     [boot-chain] starting deferred boot work, one job at a time');
  console.log('     [boot][park-factors]');
  console.log('     [first-pitch-backfill]');
  console.log('     [pitcher-usage-backfill] starting');
  console.log('     [startup-prefetch] tomorrow-slate');
  console.log('     [boot-chain] deferred boot work complete');
  console.log('');
  console.log('   PASS  = those appear in that order, each block finishing before the');
  console.log('           next begins, bracketed by the two [boot-chain] lines.');
  console.log('   FAIL  = their output is INTERLEAVED, which means they are still');
  console.log('           running concurrently and the serialisation did not take.');
  console.log('   Also expect [startup-roster] to complete BEFORE the first');
  console.log('   [boot-chain] line -- rosters are the only job left on the');
  console.log('   critical path, and the chain starts 30s after it resolves.');
  console.log('');
  console.log('   A missing "deferred boot work complete" with no error line means');
  console.log('   the chain died mid-way -- that is the OOM signature to look for,');
  console.log('   and it now names which job it reached.');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
