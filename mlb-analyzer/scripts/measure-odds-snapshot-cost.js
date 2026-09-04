#!/usr/bin/env node
/**
 * Peak rss of runOddsJob's Unabated region, before vs after the slice.
 * (2026-09-04)
 *
 * NO API CALL. Replays the exact sequence against an odds snapshot already
 * on disk, so this is re-runnable without spending the-odds-api quota or
 * hitting Unabated.
 *
 * The region measured is the only part the change touches:
 *
 *   BEFORE   raw = <parse feed>            (what resp.json() does)
 *            stringify + gzip FULL feed    (what writeSnapshot did)
 *            parseUnabatedOdds(raw)
 *
 *   AFTER    raw = <parse feed>
 *            slice = sliceForSnapshot(raw); raw = null
 *            stringify + gzip SLICE
 *            parseUnabatedOdds(slice)
 *
 * Everything else in runOddsJob -- Kalshi, Polymarket, the schedule
 * bootstrap, processOddsArray -- is byte-identical across the change, so
 * the peak delta is determined here.
 *
 * Peak-sampled at 10ms, not measured end-to-end: gzipSync's working set is
 * transient and an entry/exit delta misses it entirely. That is the same
 * trap the shipped [job-mem] line falls into.
 *
 * The gzip output is NOT written to disk -- the allocation is the point,
 * and writing would pollute data/snapshots.
 *
 * Run: node scripts/measure-odds-snapshot-cost.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..');
const NL = String.fromCharCode(10);
const mb = n => (n / 1048576).toFixed(1) + 'MB';

function findSnapshot() {
  const root = path.join(R, 'data', 'snapshots');
  let file = null, newest = 0;
  if (!fs.existsSync(root)) return null;
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
  return file;
}

// ---- child mode: run one arm and print a machine-readable line ----------
const mode = process.argv[2];
if (mode === 'before' || mode === 'after') {
  const { parseUnabatedOdds, sliceForSnapshot } = require(path.join(R, 'services/unabated'));
  const file = findSnapshot();
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString();
  const date = path.basename(path.dirname(file));

  // CHECKPOINTS, NOT AN INTERVAL. Every step here is synchronous, so a
  // setInterval sampler never gets scheduled and reports a peak of zero --
  // which is what the first version of this script did. The same starvation
  // applies to the [mem] heartbeat in services/jobs.js: it cannot sample
  // during blocking work either.
  //
  // Consequence to keep in mind: allocation INSIDE a single gzipSync call
  // is still not sampled, so these peaks are lower bounds.
  let peak = 0, peakExt = 0, peakHeap = 0;
  const mark = () => {
    const m = process.memoryUsage();
    if (m.rss > peak) peak = m.rss;
    if (m.external > peakExt) peakExt = m.external;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  };

  const base = process.memoryUsage().rss;
  mark();
  const t0 = Date.now();
  let parsed;
  if (mode === 'before') {
    const raw = JSON.parse(text);
    mark();
    const s = JSON.stringify(raw);
    mark();
    zlib.gzipSync(s);                             // writeSnapshot, full feed
    mark();
    parsed = parseUnabatedOdds(raw, date);
    mark();
  } else {
    let raw = JSON.parse(text);
    mark();
    const slice = sliceForSnapshot(raw);
    raw = null;                                   // full feed unreachable
    const s = JSON.stringify(slice);
    mark();
    zlib.gzipSync(s);                             // writeSnapshot, slice
    mark();
    parsed = parseUnabatedOdds(slice, date);
    mark();
  }
  const ms = Date.now() - t0;
  const end = process.memoryUsage();
  process.stdout.write('RESULT ' + JSON.stringify({
    mode, base, peak, peakExt, peakHeap, endRss: end.rss, ms, games: parsed.length,
  }) + NL);
  process.exit(0);
}

// ---- driver ------------------------------------------------------------
const file = findSnapshot();
console.log('=== odds snapshot cost: before vs after the slice ===');
if (!file) {
  console.log('  SKIP  no odds snapshot on disk to measure against');
  process.exit(0);
}
console.log('  fixture: ' + path.relative(R, file));
const feedBytes = zlib.gunzipSync(fs.readFileSync(file)).length;
console.log('  feed   : ' + mb(feedBytes) + ' uncompressed');
console.log('');

const run = m => {
  const out = execFileSync(process.execPath, [__filename, m], {
    cwd: R, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = out.split(NL).find(l => l.indexOf('RESULT ') === 0);
  if (!line) throw new Error('no RESULT from ' + m);
  return JSON.parse(line.slice(7));
};

const before = run('before');
const after = run('after');

console.log('  arm       base rss    PEAK rss    peak heap    peak ext     end rss    time   games');
for (const r of [before, after]) {
  console.log('  ' + r.mode.padEnd(9)
    + mb(r.base).padStart(9)
    + mb(r.peak).padStart(12)
    + mb(r.peakHeap).padStart(13)
    + mb(r.peakExt).padStart(12)
    + mb(r.endRss).padStart(12)
    + (r.ms + 'ms').padStart(8)
    + String(r.games).padStart(8));
}

const dPeak = (before.peak - after.peak) / 1048576;
const dAbove = ((before.peak - before.base) - (after.peak - after.base)) / 1048576;
console.log('');
console.log('  peak rss reduced by      ' + dPeak.toFixed(1) + 'MB');
console.log('  peak ABOVE base reduced  ' + dAbove.toFixed(1) + 'MB'
  + '   <- the figure that transfers to a different base');
console.log('  blocking time            ' + before.ms + 'ms -> ' + after.ms + 'ms');
console.log('');
console.log('  games parsed identical   ' + (before.games === after.games ? 'YES' : 'NO -- INVESTIGATE'));
if (before.games !== after.games) process.exit(1);
