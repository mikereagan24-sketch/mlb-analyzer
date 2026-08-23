#!/usr/bin/env node
/**
 * Backfill game_log.{scheduled_start_utc, first_pitch_utc, game_status}
 * from statsapi. (2026-08-22)
 *
 * Usage:  node scripts/backfill-first-pitch.js [from] [to] [--dry]
 *
 * Only touches rows with a game_pk. Rate-limited, resumable (skips rows
 * already carrying a first_pitch_utc unless --force), and reports its
 * misses ENUMERATED rather than summarised -- a systematic miss (e.g.
 * every postponed game) would bias any exposure analysis built on top of
 * this, and a count alone would hide that.
 */
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { fetchFirstPitch } = require(path.join(R, 'services/first-pitch'));

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const FROM = args[0] || '2026-01-01';
const TO = args[1] || '2026-12-31';
const SLEEP_MS = 120;

const db = new Database(path.join(R, 'data/mlb.db'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const rows = db.prepare(
    'SELECT game_date, game_id, game_pk, first_pitch_utc FROM game_log '
    + 'WHERE game_pk IS NOT NULL AND game_date >= ? AND game_date <= ? '
    + 'ORDER BY game_date, game_id'
  ).all(FROM, TO);

  const todo = FORCE ? rows : rows.filter(r => !r.first_pitch_utc);
  console.log('=== first-pitch backfill ===');
  console.log('  window ' + FROM + ' .. ' + TO);
  console.log('  rows with game_pk: ' + rows.length + '   to fetch: ' + todo.length
    + (DRY ? '   [DRY RUN]' : ''));

  const upd = db.prepare(
    'UPDATE game_log SET scheduled_start_utc = ?, first_pitch_utc = ?, game_status = ? '
    + 'WHERE game_date = ? AND game_id = ?'
  );

  let ok = 0, noFp = 0, err = 0;
  const missing = [];
  const errors = [];

  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    try {
      const f = await fetchFirstPitch(r.game_pk);
      if (!DRY) upd.run(f.scheduled_start_utc, f.first_pitch_utc, f.game_status, r.game_date, r.game_id);
      if (f.first_pitch_utc) ok++;
      else { noFp++; missing.push(r.game_date + ' ' + r.game_id + '  status=' + (f.game_status || '?')); }
    } catch (e) {
      err++; errors.push(r.game_date + ' ' + r.game_id + ' pk=' + r.game_pk + '  ' + e.message);
    }
    if ((i + 1) % 100 === 0) process.stdout.write('  ' + (i + 1) + '/' + todo.length + '\n');
    await sleep(SLEEP_MS);
  }

  console.log('');
  console.log('  first_pitch_utc written : ' + ok);
  console.log('  no firstPitch in feed   : ' + noFp);
  console.log('  fetch errors            : ' + err);

  // Enumerate, do not summarise. A systematic miss must be visible.
  if (missing.length) {
    console.log('');
    console.log('  rows with NO firstPitch (enumerated so a systematic gap is visible):');
    const byStatus = {};
    missing.forEach(m => { const s = m.split('status=')[1] || '?'; byStatus[s] = (byStatus[s] || 0) + 1; });
    console.log('    by status: ' + Object.entries(byStatus).map(([k, v]) => k + ' x' + v).join(', '));
    missing.slice(0, 25).forEach(m => console.log('    ' + m));
    if (missing.length > 25) console.log('    ... and ' + (missing.length - 25) + ' more');
  }
  if (errors.length) {
    console.log('');
    console.log('  fetch errors:');
    errors.slice(0, 15).forEach(e => console.log('    ' + e));
  }

  const cov = db.prepare(
    'SELECT COUNT(*) n, SUM(CASE WHEN first_pitch_utc IS NOT NULL THEN 1 ELSE 0 END) f, '
    + 'SUM(CASE WHEN scheduled_start_utc IS NOT NULL THEN 1 ELSE 0 END) s '
    + 'FROM game_log WHERE game_date >= ? AND game_date <= ?'
  ).get(FROM, TO);
  console.log('');
  console.log('  coverage over ALL game_log rows in window (incl. those with no game_pk):');
  console.log('    rows ' + cov.n + '   scheduled_start_utc ' + cov.s + '   first_pitch_utc ' + cov.f
    + '  (' + (100 * cov.f / cov.n).toFixed(1) + '%)');
})();
