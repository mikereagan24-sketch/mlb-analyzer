#!/usr/bin/env node
// (mlb_id, split) collision handling for the batted-ball ingest.
// (2026-09-14)
//   node scripts/test-batted-ball-dedupe.js
// Exit 1 on any failure. No network.
//
// WHAT WENT WRONG. The FG Batted Ball panel returns more than one row per
// pitcher -- a traded pitcher appears once per team stint -- and both rows
// resolve to the same mlb_id. On the first successful live run, 2026-09-14:
// 1451 resolved rows, 963 distinct (mlb_id, split) pairs, 488 collisions.
//
//   - the snapshot write is a plain INSERT into a table keyed
//     (snapshot_date, mlb_id, split), so the first collision threw and
//     rolled the whole transaction back to ZERO rows
//   - the cron row still said 'success', with the failure encoded as
//     "snapshot 0" mid-message
//   - the live upsert survived only by being last-write-wins, so a traded
//     pitcher stored whichever stint happened to land last
//
// THE RULING (owner, 2026-09-14): on a collision keep the row with the
// largest sample_tbf. Never last-write-wins.
const path = require('path');
const R = path.join(__dirname, '..');
const { dedupeBattedBallRows } = require(path.join(R, 'services/fangraphs'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}
const row = (id, split, tbf, gb) => ({ mlb_id: id, split: split, name: 'p' + id,
  gb_pct: gb, fb_pct: 0.3, ld_pct: 0.2, sample_tbf: tbf });

console.log('1. largest sample_tbf wins, not last-write');
{
  // The traded-pitcher shape: a 420-TBF stint and a 180-TBF stint, with the
  // BIG one first so a last-write-wins implementation would pick the small
  // one and this assertion would catch it.
  const r = dedupeBattedBallRows([
    row(1, 'vs_lhb', 420, 0.51), row(1, 'vs_lhb', 180, 0.39)]);
  check('one row survives', r.rows.length, 1);
  check('and it is the 420-TBF stint', [r.rows[0].sample_tbf, r.rows[0].gb_pct], [420, 0.51]);
  check('the collision is counted', r.collisions, 1);
}
{
  // Same pair, reversed, so the result cannot depend on panel order.
  const r = dedupeBattedBallRows([
    row(1, 'vs_lhb', 180, 0.39), row(1, 'vs_lhb', 420, 0.51)]);
  check('order does not matter', [r.rows.length, r.rows[0].sample_tbf], [1, 420]);
}
{
  // A tie keeps the first, so the output is deterministic rather than
  // "whichever the panel happened to serve second".
  const r = dedupeBattedBallRows([
    row(2, 'vs_rhb', 300, 0.44), row(2, 'vs_rhb', 300, 0.48)]);
  check('an exact tie keeps the FIRST row (deterministic)',
    [r.rows.length, r.rows[0].gb_pct], [1, 0.44]);
}

console.log('');
console.log('2. the split is part of the key');
{
  const r = dedupeBattedBallRows([
    row(3, 'vs_lhb', 100, 0.40), row(3, 'vs_rhb', 200, 0.50)]);
  check('two splits for one pitcher both survive', r.rows.length, 2);
  check('and nothing is counted as a collision', r.collisions, 0);
  check('each split keeps its own numbers',
    r.rows.map((x) => [x.split, x.sample_tbf]).sort(),
    [['vs_lhb', 100], ['vs_rhb', 200]]);
}

console.log('');
console.log('3. unusable rows');
{
  const r = dedupeBattedBallRows([
    row(4, 'vs_lhb', 100, 0.4), { mlb_id: null, split: 'vs_lhb', sample_tbf: 999 }, null]);
  check('a row with no mlb_id is dropped, not kept under a null key',
    r.rows.map((x) => x.mlb_id), [4]);
  // A missing TBF must not beat a real one via NaN comparison.
  const r2 = dedupeBattedBallRows([
    row(5, 'vs_lhb', 250, 0.4), { mlb_id: 5, split: 'vs_lhb', sample_tbf: null }]);
  check('a null sample_tbf does not displace a real one', r2.rows[0].sample_tbf, 250);
  const r3 = dedupeBattedBallRows([
    { mlb_id: 6, split: 'vs_lhb', sample_tbf: null }, row(6, 'vs_lhb', 250, 0.4)]);
  check('...in either order', r3.rows[0].sample_tbf, 250);
}

console.log('');
console.log('4. THE PRODUCTION SHAPE: the deduped set no longer breaks the snapshot');
{
  // Same table definition and same plain INSERT the real snapshot uses.
  const mem = new Database(':memory:');
  mem.exec('CREATE TABLE pitcher_batted_ball_snapshot (snapshot_date TEXT NOT NULL, '
    + 'mlb_id INTEGER NOT NULL, split TEXT NOT NULL, name TEXT, gb_pct REAL, fb_pct REAL, '
    + 'ld_pct REAL, sample_tbf INTEGER, source TEXT, '
    + 'PRIMARY KEY (snapshot_date, mlb_id, split));');
  const ins = mem.prepare('INSERT INTO pitcher_batted_ball_snapshot '
    + '(snapshot_date,mlb_id,split,name,gb_pct,fb_pct,ld_pct,sample_tbf,source) '
    + 'VALUES (?,?,?,?,?,?,?,?,?)');
  const write = (rs) => {
    const tx = mem.transaction((arr) => {
      for (const r of arr) {
        ins.run('2026-09-14', r.mlb_id, r.split, r.name || null,
          r.gb_pct, r.fb_pct, r.ld_pct, r.sample_tbf, 'live');
      }
    });
    tx(rs);
  };

  // 300 pitchers x 2 splits, with every third pitcher traded (a second
  // stint row), i.e. the 2026-09-14 shape in miniature.
  const raw = [];
  for (let i = 1; i <= 300; i++) {
    for (const sp of ['vs_lhb', 'vs_rhb']) {
      raw.push(row(i, sp, 200 + i, 0.40));
      if (i % 3 === 0) raw.push(row(i, sp, 120, 0.55));   // the smaller stint
    }
  }
  check('raw set has collisions', raw.length, 600 + 200);

  // BEFORE: the raw set throws on the first duplicate and writes nothing.
  let threwRaw = false;
  try { write(raw); } catch (e) { threwRaw = /UNIQUE/i.test(e.message); }
  check('the RAW set throws UNIQUE and the transaction rolls back', threwRaw, true);
  check('...leaving zero rows, which is exactly what prod saw',
    mem.prepare('SELECT COUNT(*) n FROM pitcher_batted_ball_snapshot').get().n, 0);

  // AFTER: the deduped set writes cleanly.
  const dd = dedupeBattedBallRows(raw);
  check('dedupe collapses to one row per (mlb_id, split)', dd.rows.length, 600);
  check('and reports how many it collapsed', dd.collisions, 200);
  write(dd.rows);
  check('the deduped set writes every row',
    mem.prepare('SELECT COUNT(*) n FROM pitcher_batted_ball_snapshot').get().n, 600);
  // And the survivor is the larger stint, not the 120-TBF one.
  const traded = mem.prepare('SELECT sample_tbf, gb_pct FROM pitcher_batted_ball_snapshot '
    + "WHERE mlb_id=3 AND split='vs_lhb'").get();
  check('a traded pitcher kept his LARGER stint',
    [traded.sample_tbf, traded.gb_pct], [203, 0.40]);
}

console.log('');
console.log('5. a failed snapshot can no longer report success');
{
  // The job needs an authenticated fetch, so this is a source-level check
  // rather than a call: what must hold is that the cron status for this job
  // is not a hardcoded 'success'. A run that upserts rows and snapshots
  // none has not done what it exists to do -- the as-of lookup reads the
  // snapshot -- and prod ran a full day that way behind a green cron row.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
  const i = src.indexOf("q.logCron.run('fg-batted-ball'");
  check('the fg-batted-ball cron call exists', i > -1, true);
  const line = src.slice(i, i + 200);
  check('its status is conditional, not a literal success', /partial/.test(line), true);
  check('and the job carries the snapshot error', /snapshot_error/.test(src), true);
  check('and marks a zero-row snapshot as failed even without a throw',
    /applied > 0 && snapped === 0/.test(src), true);
}

console.log('');
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
process.exit(failures ? 1 : 0);
