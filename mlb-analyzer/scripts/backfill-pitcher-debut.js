#!/usr/bin/env node
/**
 * Backfill pitcher_debut from statsapi. (2026-08-23)
 *
 * THE PREREQUISITE. Nothing in the rookie/low-sample analysis can run
 * without this: pitcher_game_log is single-season, so the DB has no debut
 * date and no career innings, and cohort definition (1b) -- career-IP
 * based -- does not exist without them.
 *
 * SOURCE. One call per pitcher:
 *   /api/v1/people/{id}?hydrate=stats(group=[pitching],type=[career])
 * gives mlbDebutDate AND career inningsPitched / battersFaced /
 * gamesStarted together. Verified against id 693821 (Bryce Elder):
 * debut 2022-04-12, career 572.1 IP, 2443 BF, 102 GS.
 *
 * LOOK-AHEAD WARNING, carried into the schema comment too. The career
 * figures are AS-OF-FETCH and therefore INCLUDE 2026. They must not be
 * used raw for an as-of-game-date cohort: a pitcher with 60 career IP
 * today may have had 5 at the time of the start being scored. The
 * subtraction happens in scripts/build-rookie-cohorts.js.
 *
 * Scope: starters only (was_starter=1), 438 of them. Relievers are not
 * needed for a starting-pitcher hypothesis and would triple the call count.
 *
 * Idempotent: skips ids already present unless --force.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const https = require('https');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const SLEEP_MS = 110;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) => {
  const req = https.get(url, r => {
    let b = '';
    r.on('data', d => { b += d; });
    r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad JSON')); } });
  });
  req.on('error', rej);
  req.setTimeout(15000, () => req.destroy(new Error('timeout')));
});

(async () => {
  const starters = db.prepare(
    "SELECT pitcher_mlb_id id, MIN(pitcher_name) nm, COUNT(*) apps "
    + "FROM pitcher_game_log WHERE was_starter=1 AND pitcher_mlb_id IS NOT NULL "
    + "GROUP BY pitcher_mlb_id ORDER BY apps DESC").all();
  const have = new Set(db.prepare('SELECT pitcher_mlb_id id FROM pitcher_debut').all().map(r => r.id));
  const todo = FORCE ? starters : starters.filter(s => !have.has(s.id));

  console.log('=== pitcher_debut backfill ' + (APPLY ? '' : '[DRY RUN]') + ' ===');
  console.log('  distinct starters: ' + starters.length + '   already have: ' + have.size
    + '   to fetch: ' + todo.length);
  if (!APPLY) { console.log(''); console.log('  DRY RUN -- pass --apply to write.'); return; }

  const up = db.prepare(
    'INSERT OR REPLACE INTO pitcher_debut '
    + '(pitcher_mlb_id, pitcher_name, mlb_debut_date, career_ip, career_bf, career_gs, fetched_at) '
    + "VALUES (?,?,?,?,?,?,datetime('now'))");

  let ok = 0, noDebut = 0, noStats = 0, err = 0;
  const misses = [], errors = [];
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    try {
      const j = await get('https://statsapi.mlb.com/api/v1/people/' + s.id
        + '?hydrate=stats(group=[pitching],type=[career])');
      const p = (j.people || [])[0];
      if (!p) { err++; errors.push(s.id + ' ' + s.nm + ': no people[0]'); continue; }
      const st = (p.stats || [])[0];
      const t = st && (st.splits || [])[0] ? (st.splits[0].stat || {}) : {};
      const ip = t.inningsPitched != null ? Number(t.inningsPitched) : null;
      if (!p.mlbDebutDate) { noDebut++; misses.push(s.id + ' ' + (p.fullName || s.nm) + ': no mlbDebutDate'); }
      if (ip == null) { noStats++; }
      up.run(s.id, p.fullName || s.nm, p.mlbDebutDate || null,
             ip, t.battersFaced != null ? Number(t.battersFaced) : null,
             t.gamesStarted != null ? Number(t.gamesStarted) : null);
      if (p.mlbDebutDate && ip != null) ok++;
    } catch (e) { err++; errors.push(s.id + ' ' + s.nm + ': ' + e.message); }
    if ((i + 1) % 100 === 0) process.stdout.write('  ' + (i + 1) + '/' + todo.length + '\n');
    await sleep(SLEEP_MS);
  }

  console.log('');
  console.log('  complete (debut + career stats): ' + ok);
  console.log('  missing mlbDebutDate           : ' + noDebut);
  console.log('  missing career stats           : ' + noStats);
  console.log('  fetch errors                   : ' + err);

  // Enumerate misses rather than summarising -- a systematic gap (e.g. every
  // 2026 debutant) would bias the cohort in exactly the predicted direction,
  // which is the one failure mode that could manufacture a false positive.
  if (misses.length) {
    console.log('');
    console.log('  rows missing a debut date (enumerated):');
    misses.slice(0, 20).forEach(m => console.log('    ' + m));
    if (misses.length > 20) console.log('    ... and ' + (misses.length - 20) + ' more');
  }
  if (errors.length) {
    console.log('');
    console.log('  errors:');
    errors.slice(0, 10).forEach(e => console.log('    ' + e));
  }

  const cov = db.prepare(
    'SELECT COUNT(*) n, SUM(CASE WHEN mlb_debut_date IS NOT NULL THEN 1 ELSE 0 END) d, '
    + 'SUM(CASE WHEN career_ip IS NOT NULL THEN 1 ELSE 0 END) ip FROM pitcher_debut').get();
  console.log('');
  console.log('  pitcher_debut rows: ' + cov.n + '   with debut date: ' + cov.d + '   with career IP: ' + cov.ip);
  const dbt = db.prepare("SELECT MIN(mlb_debut_date) a, MAX(mlb_debut_date) b FROM pitcher_debut WHERE mlb_debut_date IS NOT NULL").get();
  console.log('  debut date span: ' + dbt.a + ' .. ' + dbt.b);
  const rook = db.prepare("SELECT COUNT(*) n FROM pitcher_debut WHERE mlb_debut_date >= '2026-01-01'").get().n;
  console.log('  starters who debuted in 2026: ' + rook);
})();
