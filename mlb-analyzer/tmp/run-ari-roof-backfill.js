'use strict';
// Local dry-run + live-run harness for the ARI roof backfill task.
// Invokes the registered task's run() directly (no HTTP; matches how the
// admin route calls it via services/backfill-jobs.runBackfillJob).

const { db } = require('../db/schema');
const { getBackfillTask } = require('../services/backfill-jobs');

const MODE = process.argv[2] === 'live' ? 'live' : 'dry';
const FROM = '2026-03-01';
const TO = new Date().toISOString().slice(0, 10);

(async () => {
  const task = getBackfillTask('weather_contamination_ari_roof');
  if (!task) throw new Error('task not registered');
  const ctx = {
    db,
    params: { from: FROM, to: TO, dry_run: MODE === 'dry' },
    dryRun: MODE === 'dry',
    onProgress: (p) => console.log('[progress]', JSON.stringify(p)),
  };
  console.log('MODE=' + MODE + ' from=' + FROM + ' to=' + TO);
  const result = await task.run(ctx);
  console.log('\n--- RESULT ---');
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error('ERR', e); process.exit(1); });
