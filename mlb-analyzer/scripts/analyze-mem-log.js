#!/usr/bin/env node
/**
 * Classify a slate's [mem] / [job-mem] output. (2026-09-03)
 *
 * Two shapes were named up front, and there is a third the instrumentation
 * can now distinguish:
 *
 *   A. UNDERSIZED   peak RSS sits high BETWEEN jobs, i.e. the floor itself
 *                   is near the ceiling. Resize; shaving allocations buys
 *                   a few percent against a structural gap.
 *   B. ONE JOB      floor is low, one named job spikes. Fix that job.
 *   C. NO GC HEADROOM   heap and heapTotal climb steadily and never fall,
 *                   while the floor between jobs also rises. V8 sizes its
 *                   heap from the HOST, not the cgroup -- with no
 *                   --max-old-space-size it can believe it has ~2GB on a
 *                   512MB container, so it never feels pressure and the
 *                   CONTAINER kills it instead of a collection running.
 *                   Cheap to fix and invisible to payload arithmetic.
 *
 * C matters because it makes B's arithmetic misleading: under an unbounded
 * heap limit, allocation RATE kills you even when every individual
 * allocation is small. That is the regime where removing the 780KB parses
 * helps far more than their size suggests.
 *
 * Usage:
 *   node scripts/analyze-mem-log.js render.log
 *   pbpaste | node scripts/analyze-mem-log.js
 */
const fs = require('fs');

const file = process.argv[2];
const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
const lines = text.split(/\r?\n/);

const num = s => (s == null ? null : parseFloat(String(s).replace('MB', '')));

// [mem] rss 210.4MB  heap 44.1MB/62.0MB  ext 9.8MB  peakRss 240.1MB  peakHeap 58.9MB
const beats = [];
// [job-mem] lineup Noon  heap A -> B (+D)  rss A -> B (+D)  ext E  1234ms
const jobs = [];

for (const l of lines) {
  let m = l.match(/\[mem\]\s+rss\s+([\d.]+)MB\s+heap\s+([\d.]+)MB\/([\d.]+)MB\s+ext\s+([\d.]+)MB/);
  if (m) { beats.push({ rss: +m[1], heap: +m[2], heapTotal: +m[3], ext: +m[4], raw: l }); continue; }
  m = l.match(/\[job-mem\]\s+(.+?)\s+heap\s+([\d.]+)MB\s*->\s*([\d.]+)MB\s*\(([+-][\d.]+)MB\).*?rss\s+([\d.]+)MB\s*->\s*([\d.]+)MB\s*\(([+-][\d.]+)MB\).*?(\d+)ms/);
  if (m) {
    jobs.push({ label: m[1].trim(), heapA: +m[2], heapB: +m[3], dHeap: +m[4],
                rssA: +m[5], rssB: +m[6], dRss: +m[7], ms: +m[8] });
  }
}

console.log('=== PARSED ===');
console.log('  [mem] heartbeats : ' + beats.length);
console.log('  [job-mem] entries: ' + jobs.length);
if (!beats.length && !jobs.length) {
  console.log('');
  console.log('  Nothing matched. Grep the log for "[mem]" and "[job-mem]" and');
  console.log('  paste those lines. If they are absent entirely, the build with the');
  console.log('  instrumentation has not deployed yet.');
  process.exit(1);
}
console.log('');

if (jobs.length) {
  console.log('=== PER-JOB COST (sorted by RSS delta) ===');
  console.log('  job                        dRSS      dHeap     duration');
  for (const j of jobs.slice().sort((a, b) => b.dRss - a.dRss)) {
    console.log('  ' + j.label.padEnd(26)
      + String((j.dRss >= 0 ? '+' : '') + j.dRss.toFixed(1) + 'MB').padStart(9)
      + String((j.dHeap >= 0 ? '+' : '') + j.dHeap.toFixed(1) + 'MB').padStart(10)
      + String((j.ms / 1000).toFixed(1) + 's').padStart(11));
  }
  const worst = jobs.slice().sort((a, b) => b.dRss - a.dRss)[0];
  console.log('');
  console.log('  heaviest by RSS: ' + worst.label + '  (+' + worst.dRss.toFixed(1) + 'MB)');
  const retained = jobs.filter(j => j.dRss > 5);
  if (retained.length) {
    console.log('  jobs whose RSS did NOT come back below +5MB: '
      + retained.map(j => j.label).join(', '));
    console.log('  (RSS not returning is retention or fragmentation, not a transient)');
  }
  console.log('');
}

if (beats.length) {
  const rss = beats.map(b => b.rss);
  const heap = beats.map(b => b.heap);
  const floor = Math.min(...rss), peak = Math.max(...rss);
  const firstQ = beats.slice(0, Math.max(1, Math.floor(beats.length / 4)));
  const lastQ = beats.slice(-Math.max(1, Math.floor(beats.length / 4)));
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const drift = avg(lastQ.map(b => b.rss)) - avg(firstQ.map(b => b.rss));
  const heapDrift = avg(lastQ.map(b => b.heap)) - avg(firstQ.map(b => b.heap));

  console.log('=== HEARTBEAT PROFILE ===');
  console.log('  samples        : ' + beats.length + '  (~' + beats.length + ' minutes)');
  console.log('  RSS floor      : ' + floor.toFixed(1) + 'MB');
  console.log('  RSS peak       : ' + peak.toFixed(1) + 'MB   (' + (100 * peak / 512).toFixed(0) + '% of 512MB)');
  console.log('  RSS swing      : ' + (peak - floor).toFixed(1) + 'MB');
  console.log('  RSS drift      : ' + (drift >= 0 ? '+' : '') + drift.toFixed(1)
    + 'MB  (last quarter vs first)');
  console.log('  heap drift     : ' + (heapDrift >= 0 ? '+' : '') + heapDrift.toFixed(1) + 'MB');
  console.log('  heapTotal max  : ' + Math.max(...beats.map(b => b.heapTotal)).toFixed(1) + 'MB');
  console.log('');

  console.log('=== VERDICT ===');
  const UNDERSIZED_FLOOR = 380;   // floor this high leaves no room for any job
  const DRIFT_MB = 40;            // sustained one-way growth across the window

  if (floor >= UNDERSIZED_FLOOR) {
    console.log('  A. UNDERSIZED. The floor between jobs is ' + floor.toFixed(0)
      + 'MB of 512MB, so any');
    console.log('     job at all can finish the process. Resize the instance;');
    console.log('     trimming allocations is shaving against a structural gap.');
  } else if (drift >= DRIFT_MB && heapDrift > 0) {
    console.log('  C. NO GC HEADROOM. RSS drifted +' + drift.toFixed(0)
      + 'MB across the window with');
    console.log('     heap climbing too, and no collection bringing it back. V8 sizes');
    console.log('     its heap from the HOST, not the cgroup -- with no');
    console.log('     --max-old-space-size it can believe it has ~2GB on a 512MB box,');
    console.log('     never feel pressure, and let the CONTAINER kill it.');
    console.log('     Fix: node --max-old-space-size=384 server.js, then re-measure.');
    console.log('     Under this regime allocation RATE matters more than size, which');
    console.log('     is why removing the 780KB parses may help out of proportion.');
  } else if (jobs.length && Math.max(...jobs.map(j => j.dRss)) > 80) {
    const w = jobs.slice().sort((a, b) => b.dRss - a.dRss)[0];
    console.log('  B. ONE JOB. Floor is ' + floor.toFixed(0) + 'MB and ' + w.label
      + ' spikes +' + w.dRss.toFixed(0) + 'MB.');
    console.log('     Fix that job; the instance is adequate.');
  } else {
    console.log('  NO PATHOLOGY VISIBLE. Floor ' + floor.toFixed(0) + 'MB, peak '
      + peak.toFixed(0) + 'MB, drift ' + drift.toFixed(0) + 'MB.');
    console.log('     If no OOM occurred this slate, that is itself the result:');
    console.log('     the removed feed/live parses were the margin. Keep the');
    console.log('     instrumentation for a week before concluding.');
  }
}
