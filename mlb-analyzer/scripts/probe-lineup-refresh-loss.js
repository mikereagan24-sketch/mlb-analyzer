// What a lineup refresh actually discards.
//
// services/jobs.js ~2230 runs
//   DELETE FROM game_log WHERE game_date=? AND away_score IS NULL
// and then re-inserts from statsapi. Two separate losses follow, and the
// second is the one that is easy to miss:
//
//   A. Columns absent from q.upsertGame's INSERT list can never be
//      restored -- the re-insert simply does not name them, so they
//      default to NULL.
//
//   B. Columns that ARE in the payload but are supplied as
//      `existingRow ? existingRow.x : <default>` are ALSO lost, because
//      `existingRow` is read AFTER the DELETE (jobs.js:2236) and is
//      therefore always undefined. Every COALESCE and CASE guard in
//      upsertGame protects the ON CONFLICT path only; a fresh INSERT
//      never reaches them.
//
// Read-only. Run:
//   node --max-old-space-size=1536 scripts/probe-lineup-refresh-loss.js

const fs = require('fs');
const path = require('path');
const { db } = require('../db/schema');

const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.js'), 'utf8');
const jobsSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobs.js'), 'utf8');

// ---- the INSERT column list of q.upsertGame -------------------------
function upsertColumns() {
  const i = schemaSrc.indexOf('upsertGame');
  const ins = schemaSrc.indexOf('INSERT INTO game_log', i);
  const open = schemaSrc.indexOf('(', ins);
  let depth = 0, end = -1;
  for (let k = open; k < schemaSrc.length; k++) {
    if (schemaSrc[k] === '(') depth++;
    else if (schemaSrc[k] === ')') { depth--; if (depth === 0) { end = k; break; } }
  }
  return schemaSrc.slice(open + 1, end)
    .replace(/--[^\n]*/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^[a-z_][a-z0-9_]*$/i.test(s));
}

// ---- the bootstrap payload's existingRow-dependent keys -------------
function existingRowDependentKeys() {
  const start = jobsSrc.indexOf('bootstrapRows = await fetchSchedule');
  const seg = jobsSrc.slice(start, start + 9000);
  const keys = new Set();
  const re = /([a-z_][a-z0-9_]*)\s*:\s*[^,\n]*existingRow/gi;
  let m;
  while ((m = re.exec(seg))) keys.add(m[1]);
  return keys;
}

const cols = db.prepare('PRAGMA table_info(game_log)').all().map(c => c.name);
const inserted = new Set(upsertColumns());
const exRow = existingRowDependentKeys();

const neverWritten = cols.filter(c => !inserted.has(c));
const defeatedGuard = cols.filter(c => inserted.has(c) && exRow.has(c));

// ---- how often is each actually populated, pre-refresh? -------------
// Scored on UNPLAYED rows only -- the population the DELETE targets.
const unplayed = db.prepare(
  'SELECT COUNT(*) n FROM game_log WHERE away_score IS NULL').get().n;
const fillRate = (col) => {
  try {
    const r = db.prepare('SELECT SUM(' + col + ' IS NOT NULL) f FROM game_log WHERE away_score IS NULL').get();
    return r.f || 0;
  } catch (e) { return null; }
};

console.log('=== game_log columns : ' + cols.length
  + '   named by upsertGame INSERT : ' + inserted.size + ' ===');
console.log('unplayed rows in this copy: ' + unplayed + '\n');

console.log('--- A. NEVER WRITTEN by the re-insert (no way back) ---');
const aRows = neverWritten.map(c => ({ col: c, filled: fillRate(c) }))
  .sort((x, y) => (y.filled || 0) - (x.filled || 0));
for (const r of aRows) {
  const pct = unplayed ? (100 * (r.filled || 0) / unplayed).toFixed(0) + '%' : '-';
  console.log('  ' + r.col.padEnd(34) + String(r.filled).padStart(6) + ' / ' + unplayed + '  ' + pct);
}

console.log('\n--- B. IN the payload but read from existingRow AFTER the delete ---');
console.log('    (these look preserved in the source and are not)');
for (const c of defeatedGuard) {
  const f = fillRate(c);
  const pct = unplayed ? (100 * (f || 0) / unplayed).toFixed(0) + '%' : '-';
  console.log('  ' + c.padEnd(34) + String(f).padStart(6) + ' / ' + unplayed + '  ' + pct);
}

console.log('\n--- C. genuinely re-derived by the same job pass ---');
const reDerived = cols.filter(c => inserted.has(c) && !exRow.has(c));
console.log('  ' + reDerived.join(', '));
