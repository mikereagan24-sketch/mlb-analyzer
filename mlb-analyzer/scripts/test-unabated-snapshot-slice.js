#!/usr/bin/env node
/**
 * Narrowing the odds snapshot must not change what replay produces.
 * (2026-09-04)
 *
 * writeSnapshot('odds', ...) now persists only
 * {teams, gameOddsEvents:{[MLB_KEY]:...}} instead of the full 88.3MB
 * Unabated feed. The only consumer is POST /api/replay/odds, which calls
 * parseUnabatedOdds(raw, date). This asserts the two halves that makes
 * safe:
 *
 *   1. parseUnabatedOdds(slice) deep-equals parseUnabatedOdds(full) on a
 *      REAL captured feed, not a synthetic fixture.
 *   2. Pre-existing full-feed snapshots on disk still parse. The write
 *      narrowed; the reader did not, and every snapshot captured before
 *      this change is still a full feed.
 *
 * Run: node scripts/test-unabated-snapshot-slice.js
 * Exit 1 on any failure. Skips (exit 0) if no odds snapshot is on disk,
 * because that is an environment fact, not a regression -- Render's free
 * tier drops data/snapshots on restart.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const R = path.join(__dirname, '..');
const { parseUnabatedOdds, sliceForSnapshot, MLB_KEY } = require(path.join(R, 'services/unabated'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== unabated snapshot slice ===');

const root = path.join(R, 'data', 'snapshots');
let file = null, newest = 0;
if (fs.existsSync(root)) {
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('odds')) continue;
      const fp = path.join(dir, f);
      const t = fs.statSync(fp).mtimeMs;
      if (t > newest) { newest = t; file = fp; }
    }
  }
}

if (!file) {
  console.log('  SKIP  no odds snapshot on disk to test against');
  console.log('        (expected on a fresh clone and after a Render restart)');
  process.exit(0);
}

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
const dateFromPath = path.basename(path.dirname(file));
console.log('  fixture: ' + path.relative(R, file));

const events = raw.gameOddsEvents || {};
const keys = Object.keys(events);
const isFullFeed = keys.length > 1;
ok('fixture is a pre-existing FULL feed (the back-compat case)', isFullFeed,
   keys.length + ' league keys');

// 1. identical parse output
const fullParsed = parseUnabatedOdds(raw, dateFromPath);
const slice = sliceForSnapshot(raw);
const sliceParsed = parseUnabatedOdds(slice, dateFromPath);
ok('slice parses to the same result as the full feed',
   JSON.stringify(fullParsed) === JSON.stringify(sliceParsed),
   fullParsed.length + ' games both ways');

// 2. the reader still opens a full feed -- i.e. we narrowed the WRITE only
ok('full-feed snapshot still parses after the change',
   Array.isArray(fullParsed),
   'games=' + fullParsed.length);

// 3. the slice keeps exactly the two paths parseUnabatedOdds reads
ok('slice carries teams', slice.teams === raw.teams);
ok('slice carries the MLB events', Array.isArray(slice.gameOddsEvents[MLB_KEY]),
   (slice.gameOddsEvents[MLB_KEY] || []).length + ' events');
ok('slice carries nothing else', Object.keys(slice.gameOddsEvents).length === 1
   && Object.keys(slice).length === 2);

// 4. slicing SHARES rather than copies -- the release in runOddsJob depends
//    on this. A deep copy would keep the full feed alive AND double memory.
ok('slice shares sub-objects (does not deep-copy)',
   slice.gameOddsEvents[MLB_KEY] === (raw.gameOddsEvents || {})[MLB_KEY]);

// 5. size, so the win is recorded rather than asserted in prose
if (isFullFeed) {
  const fullBytes = JSON.stringify(raw).length;
  const sliceBytes = JSON.stringify(slice).length;
  console.log('  size: full ' + (fullBytes / 1048576).toFixed(1) + 'MB'
    + ' -> slice ' + (sliceBytes / 1048576).toFixed(1) + 'MB'
    + '  (' + (100 * sliceBytes / fullBytes).toFixed(1) + '%)');
  ok('slice is materially smaller than the full feed', sliceBytes < fullBytes / 2);
}

// 6. degenerate inputs must not throw -- writeSnapshot swallows its own
//    errors, so a throw here would silently lose the snapshot entirely.
let threw = false;
try {
  sliceForSnapshot(null);
  sliceForSnapshot({});
  sliceForSnapshot({ gameOddsEvents: {} });
} catch (e) { threw = true; }
ok('handles null / empty / missing-key input without throwing', !threw);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
