#!/usr/bin/env node
/**
 * Ingest-freshness readout. (2026-08-24)
 *
 * RUN THIS BEFORE MEASURING ANYTHING against a local copy of the DB.
 *
 * The whole of 2026-08-23 was spent measuring against an analysis copy
 * whose game data ended on 2026-08-06, and the staleness was then
 * reported as a production outage. Production was healthy throughout.
 * Both mistakes -- trusting the corpus, then blaming the wrong system --
 * were one query away from being avoided.
 *
 *   node scripts/pipeline-freshness.js                    # the default DB
 *   node scripts/pipeline-freshness.js --db path/to.db    # any other copy
 *   node scripts/pipeline-freshness.js --as-of 2026-08-24 # pin the date
 *   node scripts/pipeline-freshness.js --compare other.db # two copies
 *
 * Exit code 1 if anything is CRITICAL, so it can gate a script.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { checkPipelineFreshness, todayPt } = require(path.join(R, 'utils/pipeline-freshness'));

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

function open(p) {
  if (!p) return require(path.join(R, 'db/schema')).db;
  const Database = require(path.join(R, 'node_modules/better-sqlite3'));
  return new Database(path.isAbsolute(p) ? p : path.join(R, p), { readonly: true });
}

function render(label, r) {
  console.log('');
  console.log('=== ' + label + '   (as of ' + r.asOf + ' PT) ===');
  console.log('  ' + 'pipeline'.padEnd(28) + 'last'.padEnd(13) + 'lag'.padStart(4)
    + 'excess'.padStart(8) + '  level');
  for (const row of r.rows) {
    const mark = row.level === 'ok' ? '   ' : (row.level === 'STALE' ? ' ! ' : '***');
    console.log('  ' + row.key.padEnd(28) + String(row.last || 'none').padEnd(13)
      + String(row.lagDays == null ? '-' : row.lagDays).padStart(4)
      + String(row.excess == null ? '-' : (row.excess > 0 ? '+' + row.excess : row.excess)).padStart(8)
      + '  ' + mark + ' ' + row.level);
    // A row can be CRITICAL with excess 0 -- freshly written, stale tail.
    // Without this line the readout looks self-contradictory.
    if (row.perRow && row.perRow.level && row.perRow.level !== 'ok') {
      console.log('      ' + (row.perRow.error
        ? 'per-row check failed: ' + row.perRow.error
        : 'PER-ROW: oldest ' + row.perRow.oldest + ' (+' + row.perRow.excess + 'd), '
          + row.perRow.rowsBehindNewest + ' row(s) behind the newest'));
    }
  }
  console.log('  ' + r.crit + ' critical, ' + r.warn + ' stale, '
    + (r.rows.length - r.crit - r.warn) + ' ok');
  return r;
}

(function main() {
  const asOf = argOf('--as-of') || todayPt();
  const dbPath = argOf('--db');
  const cmp = argOf('--compare');

  const a = render(dbPath || 'default DB (data/mlb.db)',
                   checkPipelineFreshness(open(dbPath), asOf));

  if (cmp) {
    const b = render(cmp, checkPipelineFreshness(open(cmp), asOf));
    console.log('');
    console.log('=== DIFFERENCE ===');
    // The verdict must not require the reference to be spotless. A
    // pipeline that is stale in BOTH copies (catcher_framing, refreshed
    // by hand and 82 days behind on 2026-08-24) is a real finding about
    // the source system and says nothing about which copy is older.
    // What settles "stale copy vs outage" is the DIRECTION of every
    // difference: if the reference is newer everywhere they differ, this
    // copy is simply behind.
    let differ = 0, refNewer = 0, thisNewer = 0;
    for (let i = 0; i < a.rows.length; i++) {
      const av = a.rows[i].last, bv = b.rows[i].last;
      if (av === bv) continue;
      differ++;
      if (av && bv) { if (bv > av) refNewer++; else thisNewer++; }
      else if (bv) refNewer++; else thisNewer++;
      console.log('  ' + a.rows[i].key.padEnd(28)
        + (av || 'none') + '  vs  ' + (bv || 'none'));
    }
    console.log('');
    if (!differ) {
      console.log('  identical -- the two copies are the same vintage');
    } else if (refNewer && !thisNewer) {
      console.log('  THE REFERENCE IS NEWER ON ALL ' + refNewer + ' DIFFERING PIPELINE(S).');
      console.log('  This is a STALE COPY, not an outage. Refresh before measuring.');
    } else if (thisNewer && !refNewer) {
      console.log('  This copy is newer on all ' + thisNewer + ' differing pipeline(s) --');
      console.log('  the reference is the stale one.');
    } else {
      console.log('  MIXED: ' + refNewer + ' newer in the reference, ' + thisNewer + ' newer here.');
      console.log('  The copies have DIVERGED -- neither is a superset. Reconcile before');
      console.log('  overwriting either, or work in one copy will be silently lost.');
    }
    // Anything stale in BOTH is a property of the source system.
    const bothStale = a.rows.filter((r, i) =>
      r.level !== 'ok' && b.rows[i].level !== 'ok' && r.last === b.rows[i].last);
    if (bothStale.length) {
      console.log('');
      console.log('  Stale in BOTH copies -- a real finding about the source, not the copy:');
      bothStale.forEach(r => console.log('    ' + r.key + '  last=' + r.last
        + '  (+' + r.excess + 'd)'));
    }
  }

  process.exit(a.crit > 0 ? 1 : 0);
})();
