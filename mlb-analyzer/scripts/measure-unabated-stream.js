#!/usr/bin/env node
/**
 * Peak memory of the FULL odds job: full-buffer parse vs streamed.
 * (2026-09-06)
 *
 * NO UNABATED CALL. Both arms are fed the same on-disk snapshot, so the
 * only difference is how the body is consumed. Kalshi/Polymarket are still
 * fetched live (free, public) because the point is the whole job's peak,
 * not the extractor in isolation -- the extractor alone is measured by
 * scripts/test-unabated-stream-parse.js.
 *
 * ARM A reproduces the pre-2026-09-06 path exactly: gunzip the whole body,
 * build the string, JSON.parse the full 117-league graph, then slice.
 * ARM B is the shipped path: stream through stream-json, keep only
 * teams + gameOddsEvents[MLB_KEY].
 *
 * The chained morning capture is left ON, because that is what the four
 * today-odds crons actually do -- so a [job-peak] here is comparable to a
 * production [job-peak] odds line rather than to half of one.
 *
 * Sampling is a 25ms interval PLUS checkpoints. The interval fires during
 * the streamed arm (async) but is starved during arm A's synchronous
 * JSON.parse, so checkpoints carry A. Peaks are therefore lower bounds on
 * A and tighter on B -- which understates, not overstates, the win.
 *
 * Run: node scripts/measure-unabated-stream.js [snapshotPath]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const R = path.join(__dirname, '..');
const NL = String.fromCharCode(10);
const mb = n => (n / 1048576).toFixed(1) + 'MB';

const unabated = require(path.join(R, 'services/unabated'));
const jobs = require(path.join(R, 'services/jobs'));

// Pick the largest snapshot: full-feed captures are the case that matters.
let file = process.argv[2] || null;
if (!file) {
  const root = path.join(R, 'data', 'snapshots');
  let bestSize = -1;
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('odds')) continue;
        const fp = path.join(dir, f), sz = fs.statSync(fp).size;
        if (sz > bestSize) { bestSize = sz; file = fp; }
      }
    }
  }
}
if (!file) { console.log('no odds snapshot on disk to measure against'); process.exit(0); }

const REAL = unabated.fetchUnabatedRawDetailed;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

function armFullBuffer() {
  // The old path, reproduced: whole body -> string -> full graph -> slice.
  const gz = fs.readFileSync(file);
  const buf = zlib.gunzipSync(gz);
  const text = buf.toString();
  const full = JSON.parse(text);
  const data = unabated.sliceForSnapshot(full);
  const events = (data.gameOddsEvents[unabated.MLB_KEY] || []).length;
  return Promise.resolve({ data, bytes: buf.length, events, gzipped: false });
}
function armStreamed() {
  return unabated.streamMlbSlice(fs.createReadStream(file));
}

async function run(label, impl) {
  unabated.fetchUnabatedRawDetailed = impl;
  if (global.gc) { global.gc(); global.gc(); }
  const base = process.memoryUsage();
  let pr = base.rss, ph = base.heapUsed, pe = base.external, n = 0;
  const mark = () => {
    const m = process.memoryUsage(); n++;
    if (m.rss > pr) pr = m.rss;
    if (m.heapUsed > ph) ph = m.heapUsed;
    if (m.external > pe) pe = m.external;
  };
  const iv = setInterval(mark, 25);
  const L = console.log, W = console.warn;
  console.log = console.warn = () => {};
  const t0 = Date.now();
  let err = null;
  try { await jobs.runOddsJob(today); } catch (e) { err = e && e.message; }
  const ms = Date.now() - t0;
  console.log = L; console.warn = W;
  clearInterval(iv); mark();
  unabated.fetchUnabatedRawDetailed = REAL;
  return { label, base, pr, ph, pe, ms, n, err };
}

(async () => {
  const out = [];
  out.push('=== FULL odds job: full-buffer vs streamed Unabated ===');
  const rawLen = zlib.gunzipSync(fs.readFileSync(file)).length;
  out.push('  fixture: ' + path.relative(R, file)
    + '  (' + mb(fs.statSync(file).size) + ' gz, ' + mb(rawLen) + ' raw)');
  out.push('  date   : ' + today + '   chained morning capture: ON (matches the today-odds crons)');
  out.push('');
  const A = await run('A full-buffer', armFullBuffer);
  const B = await run('B streamed   ', armStreamed);
  out.push('  arm            base rss   PEAK rss   peak heap   peak ext   over base    wall   samples');
  for (const r of [A, B]) {
    out.push('  ' + r.label
      + mb(r.base.rss).padStart(11) + mb(r.pr).padStart(11)
      + mb(r.ph).padStart(12) + mb(r.pe).padStart(11)
      + ('+' + ((r.pr - r.base.rss) / 1048576).toFixed(1) + 'MB').padStart(12)
      + ((r.ms / 1000).toFixed(1) + 's').padStart(8) + String(r.n).padStart(9)
      + (r.err ? '   ERROR: ' + r.err : ''));
  }
  out.push('');
  out.push('  peak rss   ' + mb(A.pr) + ' -> ' + mb(B.pr)
    + '   (' + ((B.pr - A.pr) / 1048576).toFixed(1) + 'MB)');
  out.push('  peak heap  ' + mb(A.ph) + ' -> ' + mb(B.ph)
    + '   (' + ((B.ph - A.ph) / 1048576).toFixed(1) + 'MB)');
  out.push('  peak ext   ' + mb(A.pe) + ' -> ' + mb(B.pe)
    + '   (' + ((B.pe - A.pe) / 1048576).toFixed(1) + 'MB)');
  out.push('  over base  +' + ((A.pr - A.base.rss) / 1048576).toFixed(1)
    + 'MB -> +' + ((B.pr - B.base.rss) / 1048576).toFixed(1) + 'MB');
  out.push('  wall time  ' + (A.ms / 1000).toFixed(1) + 's -> ' + (B.ms / 1000).toFixed(1) + 's');
  process.stdout.write(out.join(NL) + NL);
  process.exit(0);
})();
