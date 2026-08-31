#!/usr/bin/env node
/**
 * Post-deploy check: did the logged-bets fix actually run? (2026-08-30)
 *
 * THE METRIC THAT WAS ASKED FOR DOES NOT MOVE, AND SHOULD NOT.
 *
 * #321 recorded "146 of 394 logged bets were invisible". The natural
 * post-deploy check is "146 should drop". It will not, and building the
 * check that way would produce a permanently-red signal -- the exact
 * failure mode of a check nobody reads any more.
 *
 * 146/394 counts rows where `bet_line IS NOT NULL AND is_active = 0`. That
 * is a statement about what the MODEL currently thinks (the signal stopped
 * being emitted), not about what the PAGE shows. Rendering those rows does
 * not reactivate them. The count is expected to grow, not shrink, as more
 * struck bets stop qualifying -- which is normal and is precisely the
 * population the block exists to display.
 *
 * THE CHECK THAT ACTUALLY PROVES IT RAN is: does the deployed page contain
 * a call to renderLoggedBets, in JavaScript rather than inside <style>, and
 * does the API return rows for it to draw? #321 failed because the call
 * landed at line 81 of public/index.html, inside the stylesheet -- every
 * other part of the path was correct, so only the CALL SITE distinguishes
 * "shipped" from "shipped and running".
 *
 * Usage:
 *   node scripts/verify-logged-bets-render.js                 (local file)
 *   node scripts/verify-logged-bets-render.js --url https://... [--date YYYY-MM-DD]
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const BASE = argOf('--url');
const DATE = argOf('--date')
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

let pass = 0, fail = 0;
const ok = (c, l) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l); if (c) pass++; else fail++; };

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return resolve(get(new URL(r.headers.location, url).toString()));
      }
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
}

// The same call-site assertions the unit test makes, run against whatever
// HTML was actually deployed.
function checkHtml(html, label) {
  const lines = html.split(/\r?\n/);
  const ranges = [];
  let open = false;
  lines.forEach((l, i) => {
    if (/<style[ >]/i.test(l)) { open = true; ranges.push([i + 1, null]); }
    if (/<\/style>/i.test(l) && open) { open = false; ranges[ranges.length - 1][1] = i + 1; }
  });
  const insideStyle = n => ranges.some(([a, b]) => n >= a && n <= (b == null ? Infinity : b));

  const calls = [], defs = [];
  lines.forEach((l, i) => {
    if (!l.includes('renderLoggedBets')) return;
    (/function\s+renderLoggedBets/.test(l) ? defs : calls).push(i + 1);
  });

  console.log('  [' + label + ']  ' + lines.length + ' lines, '
    + ranges.length + ' <style> block(s)');
  ok(defs.length === 1, 'renderLoggedBets is defined once');
  ok(calls.length >= 1, 'renderLoggedBets is CALLED (' + calls.length + ' call site(s): '
    + (calls.join(',') || 'NONE') + ')');
  const stuckInCss = calls.filter(insideStyle);
  ok(stuckInCss.length === 0,
     'no call site sits inside <style>'
     + (stuckInCss.length ? ' -- STILL IN CSS at line(s) ' + stuckInCss.join(',') : ''));
  return calls.length > 0 && stuckInCss.length === 0;
}

(async function main() {
  console.log('=== LOGGED-BETS RENDER VERIFICATION ===');
  console.log('  target : ' + (BASE || 'local file public/index.html'));
  console.log('  date   : ' + DATE);
  console.log('');

  console.log('1. THE DEPLOYED ARTIFACT');
  let renderOk;
  if (BASE) {
    const r = await get(BASE.replace(/\/$/, '') + '/');
    ok(r.status === 200, 'fetched the page (HTTP ' + r.status + ')');
    renderOk = checkHtml(r.body, 'deployed');
  } else {
    renderOk = checkHtml(fs.readFileSync(path.join(R, 'public/index.html'), 'utf8'), 'local');
  }
  console.log('');

  console.log('2. IS THERE ANYTHING TO DRAW');
  let n = null;
  if (BASE) {
    const r = await get(BASE.replace(/\/$/, '') + '/api/games/' + DATE);
    try {
      const games = JSON.parse(r.body);
      n = games.reduce((s, g) => s + ((g.logged_bets || []).length), 0);
      ok(true, 'API returned ' + games.length + ' games carrying ' + n + ' logged bet(s)');
    } catch (e) { ok(false, 'API response was not parseable JSON'); }
  } else {
    const { q } = require(path.join(R, 'db/schema'));
    n = q.getLoggedInactiveByDate.all(DATE).length;
    ok(true, 'local DB has ' + n + ' logged bet(s) with no live signal for ' + DATE);
  }
  console.log('');

  console.log('3. WHAT YOU SHOULD SEE');
  if (renderOk && n > 0) {
    console.log('  ' + n + ' card(s) should show a green "Logged bets (no live signal)" block.');
    console.log('  If the page shows NONE, the deploy did not pick up the change --');
    console.log('  that is the check #321 needed and did not get.');
  } else if (renderOk && n === 0) {
    console.log('  Call site is correct, but no logged bets exist for ' + DATE + ',');
    console.log('  so an empty card is EXPECTED and proves nothing either way.');
    console.log('  Re-run on a date with deactivated logged bets.');
  } else {
    console.log('  Call site is WRONG in the deployed artifact -- fix before reading');
    console.log('  anything into what the page shows.');
  }

  console.log('');
  console.log('NOT A VALID CHECK: "146 of 394 should drop". That count is');
  console.log('bet_line IS NOT NULL AND is_active = 0 -- what the model thinks,');
  console.log('not what the page draws. Rendering does not reactivate a signal,');
  console.log('so the number is expected to GROW. A check built on it would be');
  console.log('red forever.');
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
