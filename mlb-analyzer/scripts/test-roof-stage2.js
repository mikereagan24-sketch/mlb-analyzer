'use strict';
// Local test harness for stage-2 roof work. Three things:
//
//   A. rollForwardPrior — exercise per-park rules with TOR cutoff
//      both sides, MIL/HOU/TEX/MIA default-closed, SEA default-open,
//      ARI null (preserves existing scraper-driven path).
//   B. isSealedDome — confirm SEA is excluded; six others included.
//   C. runRoofStatusCorrect — DRY-RUN against local DB (BEGIN /
//      ROLLBACK), hits real statsapi for ~7-14 days of roofed games.
//      Reports updated/nochange/nodata. Local DB already has 'actual'
//      on every Apr-Jun sample, so updated SHOULD be 0 — proves the
//      precedence guard ('nochange when already actual').
//
//   D. Two specific test games threaded through fetchActualRoof so
//      the classification is visible directly:
//        MIA 2026-05-01 (sealed-dome closed expected)
//        SEA 2026-05-01 (open expected)
//
// Usage:  node scripts/test-roof-stage2.js
// No --commit flag; everything in section C is rolled back.

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { db } = require('../db/schema');
const { rollForwardPrior, isSealedDome, SEALED_DOME_VENUE_IDS } = require('../services/roof-prior');
const { runRoofStatusCorrect, fetchActualRoof } = require('../services/roof-correct');

function expect(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)}  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
  return ok;
}

(async () => {
  console.log('=== A. rollForwardPrior ===');
  expect('ARI venue=15 (any date) → null (scraper path)',
    rollForwardPrior(15, '2026-06-19'), null);
  expect('HOU venue=2392 → closed/estimated',
    rollForwardPrior(2392, '2026-06-19'), { status: 'closed', confidence: 'estimated' });
  expect('TEX venue=5325 → closed/estimated',
    rollForwardPrior(5325, '2026-06-19'), { status: 'closed', confidence: 'estimated' });
  expect('MIA venue=4169 → closed/estimated',
    rollForwardPrior(4169, '2026-06-19'), { status: 'closed', confidence: 'estimated' });
  expect('MIL venue=32 → closed/estimated (low-conf, corrector heals)',
    rollForwardPrior(32, '2026-06-19'), { status: 'closed', confidence: 'estimated' });
  expect('SEA venue=680 → open/estimated (no neutralize even when closed)',
    rollForwardPrior(680, '2026-06-19'), { status: 'open', confidence: 'estimated' });
  expect('TOR venue=14 late-April → closed (seasonal)',
    rollForwardPrior(14, '2026-04-28'), { status: 'closed', confidence: 'estimated' });
  expect('TOR venue=14 May 24 → closed (cutoff inclusive on closed side)',
    rollForwardPrior(14, '2026-05-24'), { status: 'closed', confidence: 'estimated' });
  expect('TOR venue=14 May 25 → open (cutoff flip)',
    rollForwardPrior(14, '2026-05-25'), { status: 'open', confidence: 'estimated' });
  expect('TOR venue=14 late-June → open',
    rollForwardPrior(14, '2026-06-19'), { status: 'open', confidence: 'estimated' });
  expect('unknown venue → null',
    rollForwardPrior(99999, '2026-06-19'), null);
  console.log();

  console.log('=== B. isSealedDome (SEA exception) ===');
  expect('15 ARI sealed',      isSealedDome(15),   true);
  expect('2392 HOU sealed',    isSealedDome(2392), true);
  expect('5325 TEX sealed',    isSealedDome(5325), true);
  expect('4169 MIA sealed',    isSealedDome(4169), true);
  expect('14 TOR sealed',      isSealedDome(14),   true);
  expect('32 MIL sealed',      isSealedDome(32),   true);
  expect('680 SEA NOT sealed', isSealedDome(680),  false);
  expect('99999 (non-roof) NOT sealed', isSealedDome(99999), false);
  console.log('  SEALED_DOME_VENUE_IDS:', Array.from(SEALED_DOME_VENUE_IDS).sort((a,b)=>a-b));
  console.log();

  console.log('=== C. runRoofStatusCorrect (DRY-RUN, rollback) ===');
  db.exec('BEGIN');
  let summary;
  try {
    summary = await runRoofStatusCorrect({ runDate: '2026-06-20', lookbackDays: 14 });
  } finally {
    db.exec('ROLLBACK');
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log();

  console.log('=== D. fetchActualRoof on two key games ===');
  const mia = await fetchActualRoof(823877);  // MIA 2026-05-01 — expect closed
  console.log('  MIA 2026-05-01 phi-mia (sealed dome):', mia);
  expect('MIA 2026-05-01 → closed', mia.roof, 'closed');
  const sea = await fetchActualRoof(823146);  // SEA 2026-05-01 — expect open
  console.log('  SEA 2026-05-01 kc-sea (open-air):', sea);
  expect('SEA 2026-05-01 → open',   sea.roof, 'open');
  const houClosed = await fetchActualRoof(824201); // HOU 2026-05-04 — expect closed
  console.log('  HOU 2026-05-04 lad-hou (sealed dome):', houClosed);
  expect('HOU 2026-05-04 → closed', houClosed.roof, 'closed');
  const ariOpen = await fetchActualRoof(825088); // ARI 2026-05-08 — expect open
  console.log('  ARI 2026-05-08 nym-ari:', ariOpen);
  expect('ARI 2026-05-08 → open',   ariOpen.roof, 'open');
})().catch(e => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
