// GET /api/cron-log: the default stays open and unchanged, filters are
// admin-gated and capped.
//
// WHY THIS ENDPOINT MATTERS. It is the whole of what production exposes
// about its own jobs without a DB download, and it was LIMIT 20 with no
// parameters -- roughly half a morning. The 5:30AM PT FG sync, the one
// that writes pitcher_batted_ball_snapshot, falls off the end before
// mid-morning. Three questions this week each needed a full
// refresh-analysis-db.sh to answer something the server already knew.
//
// WHAT THIS PINS, in the order it could regress:
//   1. the no-parameter call is byte-identical to before AND needs no
//      token -- the cron panel in public/index.html calls it, and
//      gating it would break for anyone whose token is not stored;
//   2. any filter requires the token, so the PUBLIC surface is exactly
//      what it was;
//   3. limit is capped, not trusted;
//   4. job_type/status are BOUND, so an unknown value returns nothing
//      rather than falling open to everything;
//   5. malformed input is a 400, not a silent full scan.
//
// Runs the real router on an ephemeral port against a temp DB file.
//
// Run: node --max-old-space-size=1536 scripts/test-cron-log-endpoint.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2, 10);
process.env.DB_DOWNLOAD_TOKEN = TOKEN;
// MLB_DB_PATH (db/schema.js:18) points the schema at a scratch file so
// this never touches data/mlb.db.
const TMP_DB = path.join(os.tmpdir(), 'cronlog-test-' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const { db } = require(path.join(R, 'db/schema'));

function seed() {
  db.prepare('DELETE FROM cron_log').run();
  const ins = db.prepare('INSERT INTO cron_log (job_type, run_date, status, message, ran_at) '
    + 'VALUES (?,?,?,?,?)');
  // 40 rows so the default 20 is a genuine truncation, across two job
  // types, two statuses and two run_dates.
  for (let i = 0; i < 40; i++) {
    ins.run(i % 2 === 0 ? 'odds' : 'lineups',
      i < 20 ? '2026-09-20' : '2026-09-21',
      i % 5 === 0 ? 'error' : 'success',
      'row ' + i,
      '2026-09-21 ' + String(10 + Math.floor(i / 3)).padStart(2, '0') + ':00:' + String(i % 60).padStart(2, '0'));
  }
}

async function main() {
  seed();
  const express = require(path.join(R, 'node_modules/express'));
  const app = express();
  app.use(express.json());
  app.use('/api', require(path.join(R, 'routes/api')));

  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  const get = async (qs, token) => {
    const h = token ? { 'X-Admin-Token': token } : {};
    const r = await fetch('http://127.0.0.1:' + port + '/api/cron-log' + qs, { headers: h });
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body, limitHdr: r.headers.get('x-cron-log-limit') };
  };

  try {
    console.log('\n1. the default call is unchanged and needs no token');
    const base = await get('', null);
    expect('200 without a token', base.status === 200, 'got ' + base.status);
    expect('returns exactly 20 rows', Array.isArray(base.body) && base.body.length === 20,
      base.body ? base.body.length + ' row(s)' : 'no body');
    expect('newest first by ran_at',
      base.body[0].ran_at >= base.body[base.body.length - 1].ran_at);
    expect('no filter header on the ungated path', base.limitHdr === null,
      String(base.limitHdr));

    console.log('\n2. any filter is admin-gated, so the public surface is unchanged');
    for (const qs of ['?limit=50', '?job_type=odds', '?status=error',
                      '?from=2026-09-21', '?to=2026-09-21']) {
      const r = await get(qs, null);
      expect('401 without a token: ' + qs, r.status === 401, 'got ' + r.status);
    }
    const wrong = await get('?limit=50', 'not-the-token');
    expect('401 with a WRONG token', wrong.status === 401, 'got ' + wrong.status);

    console.log('\n3. with the token, filters actually filter');
    const odds = await get('?job_type=odds&limit=100', TOKEN);
    expect('job_type=odds returns only odds rows',
      odds.status === 200 && odds.body.length === 20
      && odds.body.every(r => r.job_type === 'odds'),
      odds.body ? odds.body.length + ' row(s)' : 'status ' + odds.status);
    const err = await get('?status=error&limit=100', TOKEN);
    expect('status=error returns only errors',
      err.body.length === 8 && err.body.every(r => r.status === 'error'),
      err.body.length + ' row(s)');
    const day = await get('?from=2026-09-21&to=2026-09-21&limit=100', TOKEN);
    expect('from/to filter run_date, not ran_at',
      day.body.length === 20 && day.body.every(r => r.run_date === '2026-09-21'),
      day.body.length + ' row(s)');
    const both = await get('?job_type=odds&status=error&limit=100', TOKEN);
    expect('filters compose (AND, not OR)',
      both.body.every(r => r.job_type === 'odds' && r.status === 'error'),
      both.body.length + ' row(s)');
    const more = await get('?limit=40', TOKEN);
    expect('a bigger limit reaches past the old 20-row wall',
      more.body.length === 40, more.body.length + ' row(s)');

    console.log('\n4. limit is capped, not trusted');
    const huge = await get('?limit=99999', TOKEN);
    expect('an over-large limit is CAPPED, not rejected', huge.status === 200);
    expect('capped at 500 and the response says so', huge.limitHdr === '500', huge.limitHdr);
    expect('...and still returns what exists', huge.body.length === 40,
      huge.body.length + ' row(s)');

    console.log('\n5. malformed input is a 400, never a silent full scan');
    for (const qs of ['?limit=abc', '?limit=-5', '?limit=0', '?limit=1.5',
                      '?from=not-a-date', '?to=2026-13-99x']) {
      const r = await get(qs, TOKEN);
      expect('400 for ' + qs, r.status === 400, 'got ' + r.status);
    }

    console.log('\n6. job_type is BOUND, so it cannot fall open');
    const unknown = await get('?job_type=no-such-job&limit=100', TOKEN);
    expect('an unknown job_type returns ZERO rows, not everything',
      unknown.status === 200 && unknown.body.length === 0,
      unknown.body ? unknown.body.length + ' row(s)' : 'status ' + unknown.status);
    const inj = await get('?job_type=' + encodeURIComponent("odds' OR '1'='1") + '&limit=100', TOKEN);
    expect('a quoted injection payload matches nothing (bound, not spliced)',
      inj.status === 200 && inj.body.length === 0,
      inj.body ? inj.body.length + ' row(s)' : 'status ' + inj.status);
    const stillThere = db.prepare('SELECT COUNT(*) n FROM cron_log').get().n;
    expect('the table is intact after all of that', stillThere === 40, stillThere + ' row(s)');
  } finally {
    srv.close();
    try { db.close(); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
  }
  return failed;
}

main().then(f => {
  console.log('\n' + (f === 0 ? 'ALL PASS' : f + ' FAILED'));
  process.exit(f === 0 ? 0 : 1);
}).catch(e => { console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
