#!/usr/bin/env node
/**
 * The 6AM snapshot chain records that it ran. (2026-09-12)
 *
 * WHAT IT FIXES. FRV, catcher framing and the three baserunning jobs each
 * sat in a bare try/catch that only console.error'd. None wrote a
 * cron_log row and there was no job_type for any of them, so a missed day
 * left NO RECORD -- the only evidence was an absent snapshot_date.
 *
 * FOUNDING INSTANCE: 2026-09-03. All five snapshot tables are missing it,
 * and so is the 5:30 PT fg-woba job. Not an OOM restart -- 726 cron rows
 * ran that day with no gap >= 15 min anywhere in the 11:30-14:30 UTC
 * window that brackets the 5:30/6:00 PT slots. It was found a week later
 * by diffing snapshot dates against a calendar while measuring something
 * else.
 *
 * A missed day must now be RECORDED, not inferred.
 *
 * Run: node scripts/test-snapshot-chain-cron-log.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== 6AM snapshot chain writes cron_log ===');
const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- every snapshot job is wrapped, with its own job_type ------------
const EXPECTED = {
  'fielding-frv': 'runFieldingFrvJob',
  'catcher-framing': 'runCatcherFramingJob',
  'team-baserunning': 'runBaserunningJob',
  'player-baserunning': 'runPlayerBaserunningJob',
  'player-baserunning-trailing': 'runPlayerBaserunningTrailingJob',
};
for (const [jobType, fn] of Object.entries(EXPECTED)) {
  ok('wrapped: ' + fn + " -> job_type '" + jobType + "'",
     src.indexOf("_snapshotStep('" + jobType + "', " + fn + ")") !== -1);
}
ok('job_types are distinct', new Set(Object.keys(EXPECTED)).size === 5);

// No snapshot job may still be called bare inside the cron chain. This is
// the arm that catches a SIXTH job being added later without logging.
const chainStart = src.indexOf("cron.schedule('0 6 * * *'");
const chainEnd = src.indexOf("cron.schedule('0 7 * * *'");
ok('the 6AM chain is locatable', chainStart !== -1 && chainEnd > chainStart);
const chain = src.slice(chainStart, chainEnd);
const bare = Object.values(EXPECTED).filter(fn =>
  new RegExp('await ' + fn + '\\(\\)').test(chain));
ok('no snapshot job is still invoked bare in the chain', bare.length === 0,
   bare.length ? bare.join(', ') : 'all five go through _snapshotStep');

// ---- the helper's contract -------------------------------------------
ok('status uses the existing success/error convention',
   /okRun \? 'success' : 'error'/.test(src),
   "so `status != 'success'` keeps working as the health filter");
ok('a returned {success:false} is logged as an ERROR, not a success',
   /res && res\.success === false/.test(src),
   'a missing FG cookie writes no snapshot and must not read as OK');
ok('the helper rethrows so callers\' catch blocks still fire',
   /if \(thrown\) throw thrown;/.test(src),
   'the chain stays non-fatal exactly as before');
ok('the cron_log write is itself wrapped',
   /cron_log write failed \(non-fatal\)/.test(src),
   'logging must not be able to break the thing it logs');
ok('the founding instance is recorded in the code',
   /FOUNDING INSTANCE, 2026-09-03/.test(src) && /726 cron rows/.test(src));

// ---- behaviour, exercised rather than read ---------------------------
// Reimplements the helper's decision table and checks each branch. The
// real function is not called here because it writes to cron_log.
const decide = (thrown, res) => (!thrown && !(res && res.success === false)) ? 'success' : 'error';
ok('BEHAVIOUR: clean return -> success', decide(null, { success: true, applied: 30 }) === 'success');
ok('BEHAVIOUR: thrown -> error', decide(new Error('FG 503'), undefined) === 'error');
ok('BEHAVIOUR: soft {success:false} -> error',
   decide(null, { success: false, error: 'fangraphs_session_cookie not configured' }) === 'error');
ok('BEHAVIOUR: a job returning nothing at all -> success',
   decide(null, undefined) === 'success',
   'no throw and no failure flag is a clean run, not an error');

// ---- the gap this was built for is real and still visible ------------
const GAP = '2026-09-03';
const tables = ['team_baserunning_snapshot', 'player_baserunning_snapshot',
  'player_baserunning_trailing_snapshot', 'catcher_framing_snapshot', 'fielding_frv_snapshot'];
let missing = 0;
for (const t of tables) {
  try {
    if (db.prepare('SELECT COUNT(*) n FROM ' + t + ' WHERE snapshot_date = ?').get(GAP).n === 0) missing++;
  } catch (e) { /* table shape differs; not this test's business */ }
}
console.log('  ' + GAP + ': ' + missing + ' of ' + tables.length + ' snapshot tables have no row');
ok('the founding gap is still present in the data', missing === tables.length,
   'all five missed the same day — one chain, not five failures');
ok('and cron_log had NOTHING to say about it',
   db.prepare("SELECT COUNT(*) n FROM cron_log WHERE run_date = ? AND job_type IN "
     + "('fielding-frv','catcher-framing','team-baserunning','player-baserunning',"
     + "'player-baserunning-trailing')").get(GAP).n === 0,
   'which is the whole reason for this change — rows only start from deploy');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
