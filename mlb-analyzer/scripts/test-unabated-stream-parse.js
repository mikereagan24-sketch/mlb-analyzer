#!/usr/bin/env node
/**
 * The streamed extraction must produce exactly what the full parse did.
 * (2026-09-06)
 *
 * services/unabated.js no longer calls resp.json(). It streams the body
 * through stream-json and keeps only data.teams and
 * data.gameOddsEvents[MLB_KEY], discarding the other 116 leagues as they
 * pass. That removed ~236MB of peak on a 512MB instance -- and it is a
 * rewrite of the ingest path for every price the model sees, so
 * "equivalent" is asserted game-for-game rather than argued.
 *
 * Run against a REAL captured feed, not a fixture: prod-shaped or it does
 * not ship, per the ingest-not-hot-path rule. Prefers a full 117-league
 * snapshot when one is on disk, because that is the case the streaming
 * filter actually has to discard from.
 *
 * Also covers the failure mode the change INTRODUCES: a structurally
 * successful stream that yields nothing.
 *
 * Run: node scripts/test-unabated-stream-parse.js
 * Skips (exit 0) if no odds snapshot is on disk -- Render's free tier
 * drops data/snapshots on restart, and that is an environment fact.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const R = path.join(__dirname, '..');
const { streamMlbSlice, parseUnabatedOdds, sliceForSnapshot, MLB_KEY } =
  require(path.join(R, 'services/unabated'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};
const quiet = fn => {
  const L = console.log; console.log = () => {};
  try { return fn(); } finally { console.log = L; }
};

console.log('=== unabated streaming parse ===');

// Prefer the largest snapshot: the full-feed ones are what the filter has
// to discard from, and a post-slice snapshot would test almost nothing.
const root = path.join(R, 'data', 'snapshots');
let best = null, bestSize = -1;
if (fs.existsSync(root)) {
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('odds')) continue;
      const fp = path.join(dir, f);
      const sz = fs.statSync(fp).size;
      if (sz > bestSize) { bestSize = sz; best = { fp, date: d }; }
    }
  }
}
if (!best) {
  console.log('  SKIP  no odds snapshot on disk to test against');
  process.exit(0);
}
console.log('  fixture: ' + path.relative(R, best.fp)
  + '  (' + (bestSize / 1048576).toFixed(2) + 'MB gz)');

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(best.fp)).toString());
const leagues = Object.keys(raw.gameOddsEvents || {}).length;
console.log('  leagues in fixture: ' + leagues
  + (leagues > 1 ? '  (full feed -- the filter has real work to do)'
                 : '  (already sliced -- weaker test; keep a full-feed capture)'));

(async () => {
  // ---- 1. equivalence, game for game ---------------------------------
  const streamed = await streamMlbSlice(fs.createReadStream(best.fp));
  const fullParsed = quiet(() => parseUnabatedOdds(sliceForSnapshot(raw), best.date));
  const streamParsed = quiet(() => parseUnabatedOdds(streamed.data, best.date));

  ok('gzip auto-detected on a .gz source', streamed.gzipped === true);
  ok('same number of games', fullParsed.length === streamParsed.length,
     fullParsed.length + ' vs ' + streamParsed.length);
  ok('streamed parse is byte-identical to the full parse',
     JSON.stringify(fullParsed) === JSON.stringify(streamParsed));

  // Game-for-game, so a failure names the game rather than just differing.
  const byId = a => new Map(a.map(g => [g.game_id, g]));
  const A = byId(fullParsed), B = byId(streamParsed);
  const missing = [...A.keys()].filter(k => !B.has(k));
  const extra = [...B.keys()].filter(k => !A.has(k));
  const differing = [...A.keys()].filter(k =>
    B.has(k) && JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k)));
  ok('no game missing from the streamed parse', missing.length === 0,
     missing.length ? missing.join(', ') : fullParsed.length + ' game(s) matched');
  ok('no extra game in the streamed parse', extra.length === 0,
     extra.length ? extra.join(', ') : 'none');
  ok('every game identical field-for-field', differing.length === 0,
     differing.length ? differing.join(', ') : 'none differ');

  // ---- 2. the slice really is only the two paths ----------------------
  ok('streamed slice carries teams', Object.keys(streamed.data.teams || {}).length > 0,
     Object.keys(streamed.data.teams || {}).length + ' teams');
  ok('streamed slice carries the MLB events',
     Array.isArray(streamed.data.gameOddsEvents[MLB_KEY]),
     streamed.events + ' events');
  ok('streamed slice carries NOTHING else',
     Object.keys(streamed.data).length === 2
     && Object.keys(streamed.data.gameOddsEvents).length === 1);
  if (leagues > 1) {
    ok('the other leagues were discarded, not kept',
       Object.keys(raw.gameOddsEvents).length > 1
       && Object.keys(streamed.data.gameOddsEvents).length === 1,
       leagues + ' -> 1');
  }

  // ---- 3. the NEW failure mode: a clean stream that yields nothing ----
  const emptyFeed = Buffer.from(JSON.stringify({ teams: {}, gameOddsEvents: {} }));
  const empty = await streamMlbSlice(Readable.from([emptyFeed]));
  ok('a well-formed feed with no MLB key yields events=0, not a throw',
     empty.events === 0 && Array.isArray(empty.data.gameOddsEvents[MLB_KEY]));
  ok('byte count is reported so the guard can log it',
     empty.bytes === emptyFeed.length, empty.bytes + ' bytes');
  ok('plain (non-gzip) input is detected as such', empty.gzipped === false);

  const wrongKey = Buffer.from(JSON.stringify({
    teams: { 1: { abbreviation: 'NYY' } },
    gameOddsEvents: { 'lg99:pt1:pregame': [{ eventId: 1 }] },
  }));
  const wk = await streamMlbSlice(Readable.from([wrongKey]));
  ok('an upstream league-key rename yields events=0 rather than wrong data',
     wk.events === 0 && Object.keys(wk.data.teams).length === 1);

  // ---- 4. the guard exists at the call site --------------------------
  const jobs = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
  ok('runOddsJob guards zero-events-with-scheduled-games',
     jobs.indexOf('ub.events === 0 && scheduleRows.length > 0') !== -1);
  ok('the guard logs the byte count', jobs.indexOf("+ ub.bytes + ' bytes") !== -1);
  ok('the guard does NOT snapshot an empty feed',
     jobs.indexOf('NOT snapshotting and NOT pricing') !== -1);
  ok('the guard falls back to the previous snapshot',
     jobs.indexOf("findMostRecentSnapshot('odds', dateStr)") !== -1);

  console.log('');
  console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('  THREW: ' + (e && e.stack || e)); process.exit(1); });
