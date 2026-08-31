#!/usr/bin/env node
/**
 * The logged-bets block is actually rendered. (2026-08-30)
 *
 * WHAT HAPPENED. #321 built the whole path correctly -- the query
 * (getLoggedInactiveByDate), the API field (logged_bets), and the renderer
 * (renderLoggedBets) -- and then inserted the CALL at line 81 of
 * public/index.html, which is inside the <style> block, between
 * .gcard-play-venue and .pv-line.
 *
 * So it was CSS, not JavaScript. It never executed. The API dutifully
 * shipped logged_bets on every game and the UI threw it away.
 *
 * The tell: #321's own comment records "146 of 394 logged bets were
 * invisible when this was found". That number was still exactly 146 of 394
 * afterwards, because nothing about the rendering changed. A fix whose
 * headline metric does not move is a fix that did not run.
 *
 * WHY A TEST AND NOT JUST A FIX. Every existing check passed: the function
 * was defined, the API returned the data, test-logged-bet-visibility.js
 * (22 assertions) verified the QUERY. Nothing verified that anything called
 * the renderer. A unit test of a function nobody invokes is green forever.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };

const P = path.join(R, 'public/index.html');
const src = fs.readFileSync(P, 'utf8');
const lines = src.split(/\r?\n/);

// ---- map the <style> blocks -------------------------------------------
const styleRanges = [];
let open = false;
lines.forEach((l, i) => {
  if (/<style[ >]/i.test(l)) { open = true; styleRanges.push([i + 1, null]); }
  if (/<\/style>/i.test(l) && open) { open = false; styleRanges[styleRanges.length - 1][1] = i + 1; }
});
const insideStyle = n => styleRanges.some(([a, b]) => n >= a && n <= (b == null ? Infinity : b));

ok(styleRanges.length > 0, 'found at least one <style> block to check against');

// ---- 1. the call exists, and is JavaScript ----------------------------
const callLines = [];
const defLines = [];
lines.forEach((l, i) => {
  if (!l.includes('renderLoggedBets')) return;
  if (/function\s+renderLoggedBets/.test(l)) defLines.push(i + 1);
  else callLines.push(i + 1);
});

ok(defLines.length === 1, 'renderLoggedBets is defined exactly once (got ' + defLines.length + ')');
ok(callLines.length >= 1, 'renderLoggedBets is CALLED at least once (got ' + callLines.length + ')');
for (const n of callLines) {
  ok(!insideStyle(n),
     'the call at line ' + n + ' is outside <style> -- it is JS, not CSS');
}
for (const n of defLines) {
  ok(!insideStyle(n), 'the definition at line ' + n + ' is outside <style>');
}

// ---- 2. it is wired into the card template ----------------------------
// Being outside <style> is necessary but not sufficient -- it could sit in
// a dead function. Assert it is concatenated into the game-card string,
// which is what actually puts it on screen.
const gridIdx = lines.findIndex(l => l.includes("document.getElementById('game-grid').innerHTML=games.map"));
ok(gridIdx >= 0, 'located the game-card template');
if (gridIdx >= 0) {
  // The template runs until the closing of the map callback; bound the
  // search generously and require the call inside it.
  const withinTemplate = callLines.some(n => n > gridIdx + 1 && n < gridIdx + 200);
  ok(withinTemplate,
     'renderLoggedBets is concatenated into the game-card template '
     + '(template starts line ' + (gridIdx + 1) + ', calls at ' + callLines.join(',') + ')');
}

// ---- 3. it is NOT gated on there being a live signal -------------------
// The entire point is a struck bet the model no longer emits for. Gating
// the block on sigs.length would re-hide exactly the rows it exists for.
for (const n of callLines) {
  const line = lines[n - 1];
  ok(!/sigs\.length\s*(\?|&&)/.test(line),
     'the call at line ' + n + ' is not gated on sigs.length');
}

// ---- 4. no other stray JS statement inside <style> ---------------------
// The same slip could land any call in the stylesheet. A CSS declaration
// never contains a bare `foo(bar)+` or `foo(bar);` at statement position.
const strays = [];
for (const [a, b] of styleRanges) {
  for (let n = a + 1; n < (b == null ? lines.length : b); n++) {
    const t = lines[n - 1].trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*\s*\([^)]*\)\s*[+;,]?\s*$/.test(t)) strays.push(n + ': ' + t);
  }
}
ok(strays.length === 0,
   'no bare function-call statements inside <style>'
   + (strays.length ? ' -- found: ' + strays.join(' | ') : ''));

// ---- 5. the data path still works -------------------------------------
const { q } = require(path.join(R, 'db/schema'));
ok(typeof q.getLoggedInactiveByDate === 'object' && q.getLoggedInactiveByDate !== null,
   'getLoggedInactiveByDate query exists');
const apiSrc = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
ok(apiSrc.includes('logged_bets: loggedByGame[g.game_id] || []'),
   'the API still attaches logged_bets to each game');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
