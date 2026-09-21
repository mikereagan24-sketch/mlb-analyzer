// Every chain that sequences these jobs runs lineups -> weather -> odds.
//
// WHY THE ORDER IS LOAD-BEARING, and not just tidy:
//
//   runWeatherJob iterates q.getGamesByDate.all(date), so it can only
//   fetch for rows that already exist. runLineupJob is what CREATES the
//   slate, through its statsapi bootstrap. So weather-before-lineups
//   fetches against whatever slate was already there and silently
//   misses every game the pass is about to add -- on a fresh date, all
//   of them. That is the load-bearing half of the order.
//
//   Odds-last is consistency rather than a proven data dependency:
//   runOddsJob walks the odds feed ("oddsRaw is authoritative for which
//   games exist") and resolves each game with q.getGameById -- it does
//   not enumerate the slate. Section 2 asserts BOTH facts, so the
//   rationale in the code comments cannot quietly become wrong.
//
//   Before #426 the cost was louder: the lineup job deleted and
//   re-inserted unplayed rows, so a weather fetch that ran first was
//   discarded outright. That is fixed; this ordering defect is the part
//   that survived it, and it is invisible in the logs because the
//   weather job reports success on the rows it did see.
//
// Three chains had it backwards (7AM refresh, 8PM prefetch, 11PM
// refresh) against one that had it right (runMorningCaptureJob). The
// majority being wrong is the tell that this spreads by copy-paste,
// which is what this test exists to stop.
//
// SOURCE-LEVEL by necessity: these are cron callbacks registered at
// module load against a live scheduler. Executing them would fire real
// jobs against real providers. Asserting the ORDER OF THE CALLS in the
// source is the property that matters and the one a paste would break.
//
// Run: node --max-old-space-size=1536 scripts/test-cron-chain-order.js

const fs = require('fs');
const path = require('path');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');

// Rank in the required order. A chain may skip stages (the 11PM block
// runs no lineup pull by design); what it may not do is invert them.
const RANK = { runLineupJob: 1, runWeatherJob: 2, runOddsJob: 3 };

// A "chain" is a lexical block that calls two or more of the three.
// Blocks are located by their opening marker so the report names
// something a reader can find.
const BLOCKS = [
  { name: '7AM PT morning refresh',      marker: "console.log('[cron] 7AM PT morning refresh" },
  { name: '8PM PT tomorrow-slate prefetch', marker: "console.log('[cron] 8PM PT tomorrow-slate prefetch" },
  { name: '11PM PT tomorrow-slate refresh', marker: "console.log('[cron] 11PM PT tomorrow-slate refresh" },
  { name: 'runMorningCaptureJob',        marker: 'async function runMorningCaptureJob' },
];

// Calls inside a block, in source order. Definitions (`async function
// runX`) and the recursive self-call are excluded.
function callsIn(start, end) {
  const seg = SRC.slice(start, end);
  const out = [];
  const re = /(?:await\s+|=\s*)(runLineupJob|runWeatherJob|runOddsJob)\s*\(/g;
  let m;
  while ((m = re.exec(seg))) out.push({ fn: m[1], at: start + m.index });
  return out;
}

function blockEnd(start) {
  // End at the next block marker, or the next top-level async function.
  let best = SRC.length;
  for (const b of BLOCKS) {
    const i = SRC.indexOf(b.marker, start + 10);
    if (i > start && i < best) best = i;
  }
  const fn = SRC.indexOf('\nasync function ', start + 10);
  if (fn > start && fn < best) best = fn;
  return best;
}

console.log('\n1. every chain runs lineups -> weather -> odds');
let chainsChecked = 0;
for (const b of BLOCKS) {
  const start = SRC.indexOf(b.marker);
  if (start === -1) { expect('block located: ' + b.name, false, 'marker not found'); continue; }
  const calls = callsIn(start, blockEnd(start));
  if (calls.length < 2) {
    expect(b.name + ': not a chain any more (fewer than 2 job calls)', true,
      calls.map(c => c.fn).join(' -> ') || 'none');
    continue;
  }
  chainsChecked++;
  const seq = calls.map(c => c.fn);
  const ranks = calls.map(c => RANK[c.fn]);
  const ordered = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
  expect(b.name, ordered, seq.map(f => f.replace('run', '').replace('Job', '')).join(' -> '));
}
expect('at least 3 chains were actually checked', chainsChecked >= 3,
  chainsChecked + ' chain(s)');

console.log('\n2. the dependency that makes the order matter still holds');
// If either consumer stops reading the slate, this test is measuring
// nothing and should say so rather than passing quietly.
const weatherStart = SRC.indexOf('async function runWeatherJob');
const weatherSeg = SRC.slice(weatherStart, SRC.indexOf('\nasync function ', weatherStart + 10));
expect('runWeatherJob still iterates q.getGamesByDate',
  /q\.getGamesByDate\.all\(/.test(weatherSeg));
// Odds is the WEAKER half, and the assertion says so rather than
// overstating it. Claiming getGamesByDate here would have been a false
// statement inside a test, which is worse than no statement -- and it
// is in fact the first thing this test caught, about its own author.
const oddsStart = SRC.indexOf('async function runOddsJob');
const oddsSeg = SRC.slice(oddsStart, SRC.indexOf('\nasync function ', oddsStart + 10));
expect('runOddsJob still resolves rows via q.getGameById',
  /q\.getGameById\.get\(/.test(oddsSeg));
expect('runOddsJob does NOT enumerate the slate (so odds-last is consistency)',
  !/q\.getGamesByDate\.all\(/.test(oddsSeg));
expect('runLineupJob still bootstraps the slate from statsapi',
  /bootstrapRows\s*=\s*await fetchSchedule/.test(SRC));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
