// The duplicate guard tells a PERIOD SPLIT apart from a NAME COLLISION
// using the source's own period label -- never the sample values.
//
// WHY THE DISCRIMINATOR HAD TO BE STRUCTURAL. #435 made every duplicate
// name a hard throw, because at that point the two cases were
// indistinguishable and a wrong merge is how the actuals shortfall hid
// for six months: FanGraphs was returning a row per season, our side
// wrote whichever landed last, and the stored sample was a subset of the
// real total with nothing to show for it. The tempting shortcut -- "two
// rows whose samples look like halves of a whole are a split" -- is a
// heuristic on the numbers, and a heuristic that guesses wrong either
// merges two real players or splits one. So the guard reads a LABEL:
//
//   labels differ             -> period split -> throw
//   labels equal, or no label -> collision    -> keep larger, report
//   label column present but a value missing  -> throw (fails safe)
//
// The label is FanGraphs' own Season field, captured by parseCSV
// (PERIOD_COLS) and carried through the name expansion. Under
// strGroup:'career' -- what services/fangraphs.js requests since #437 --
// every actuals row is labelled Total. Projection CSVs have no Season
// column at all, so they land on the no-label branch, which is where the
// genuine source duplicates live (16 rows on each pit-proj-*, 4 on each
// bat-proj-*).
//
// This runs the REAL ingest against a temp DB file, not a lifted copy of
// the rule.
//
// Run: node --max-old-space-size=1536 scripts/test-woba-period-split-guard.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const R = path.join(__dirname, '..');

// db/schema.js:18 -- point the schema at a scratch file so this never
// touches data/mlb.db.
const TMP_DB = path.join(os.tmpdir(), 'woba-guard-test-' + process.pid + '.db');
process.env.MLB_DB_PATH = TMP_DB;

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const { db } = require(path.join(R, 'db/schema'));
const { ingestWobaCSV } = require(path.join(R, 'routes/api'));

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
};
// Returns { ok, out, err } -- never throws, so a throw is assertable.
const ingest = (key, csv) => {
  try { return { ok: true, out: quiet(() => ingestWobaCSV(key, Buffer.from(csv), key + '.csv')) }; }
  catch (e) { return { ok: false, err: e.message }; }
};
const stored = (key, name) =>
  db.prepare('SELECT woba, sample_size FROM woba_data WHERE data_key=? AND LOWER(player_name)=?')
    .get(key, name);
const countFor = (key) =>
  db.prepare('SELECT COUNT(*) c FROM woba_data WHERE data_key=?').get(key).c;

// Actuals shape: the splits API spells the team TeamNameAbb and labels
// every row with Season.
const act = (rows) => 'Name,TeamNameAbb,PA,wOBA,Season\n'
  + rows.map(r => r.join(',')).join('\n') + '\n';
// Projection shape: Team, and no period column whatsoever.
const proj = (rows) => 'Name,Team,PA,wOBA\n' + rows.map(r => r.join(',')).join('\n') + '\n';

console.log('\n1. same label = name collision: keep the larger sample, do not throw');
let r = ingest('bat-act-lhp', act([
  ['Max Muncy', 'LAD', 149, 0.340, 'Total'],
  ['Max Muncy', 'LAD', 212, 0.301, 'Total'],
]));
expect('the upload succeeds', r.ok, r.err);
expect('the larger sample won', r.ok && stored('bat-act-lhp', 'max muncy lad').sample_size === 212,
  r.ok ? String(stored('bat-act-lhp', 'max muncy lad').sample_size) : '');
expect('...and its wOBA came with it, not the loser row',
  r.ok && Math.abs(stored('bat-act-lhp', 'max muncy lad').woba - 0.301) < 1e-9);
expect('the collision is NAMED in the result, not just counted',
  r.ok && r.out.collisions.length === 1 && /max muncy/i.test(r.out.collisions[0]),
  r.ok ? JSON.stringify(r.out.collisions) : '');
expect('the return is { rows, collisions }, not a boxed number',
  r.ok && typeof r.out === 'object' && typeof r.out.rows === 'number',
  r.ok ? typeof r.out : '');

console.log('\n2. order does not decide the winner');
const order = [];
for (const pair of [[149, 212], [212, 149]]) {
  ingest('bat-act-rhp', act([
    ['Max Muncy', 'LAD', pair[0], 0.340, 'Total'],
    ['Max Muncy', 'LAD', pair[1], 0.301, 'Total'],
  ]));
  order.push(stored('bat-act-rhp', 'max muncy lad').sample_size);
}
expect('both row orders store the same sample', order[0] === order[1] && order[0] === 212,
  order.join(' vs '));

console.log('\n3. differing labels = period split: throw, write nothing');
const before = countFor('bat-act-lhb');
r = ingest('bat-act-lhb', act([
  ['Blade Tidwell', 'NYM', 86, 0.212, '2024'],
  ['Blade Tidwell', 'NYM', 60, 0.348, '2025'],
]));
expect('the upload is REJECTED', !r.ok);
expect('...and says PERIOD SPLIT, naming both labels',
  !r.ok && /PERIOD SPLIT/.test(r.err) && /2024/.test(r.err) && /2025/.test(r.err), r.err);
expect('...and points at strGroup, the thing an operator can act on',
  !r.ok && /strGroup/.test(r.err));
expect('nothing was written -- the throw is inside the transaction',
  countFor('bat-act-lhb') === before, countFor('bat-act-lhb') + ' vs ' + before);

console.log('\n4. the discriminator does NOT read the numbers');
// 86 + 60 = 146, the exact shape of the real Tidwell split. Labelled
// Total twice, it is a collision and must merge, not throw -- and must
// NOT sum. A value heuristic would have called this a split.
r = ingest('pit-act-rhb', 'Name,TeamNameAbb,TBF,wOBA,Season\n'
  + 'Blade Tidwell,NYM,86,0.212,Total\nBlade Tidwell,NYM,60,0.348,Total\n');
expect('two rows that LOOK like halves of 146 still merge on their label', r.ok, r.err);
expect('...to the larger row, not to a sum',
  r.ok && stored('pit-act-rhb', 'blade tidwell nym').sample_size === 86,
  r.ok ? String(stored('pit-act-rhb', 'blade tidwell nym').sample_size) : '');
// The mirror: identical samples, different labels. Nothing in the values
// suggests a split; the label alone does, and it must win.
r = ingest('pit-act-lhb', 'Name,TeamNameAbb,TBF,wOBA,Season\n'
  + 'Blade Tidwell,NYM,100,0.212,2024\nBlade Tidwell,NYM,100,0.348,2025\n');
expect('two IDENTICAL samples under different labels still throw', !r.ok,
  r.ok ? 'accepted' : '');

console.log('\n5. no label at all = collision (the projection keys)');
r = ingest('bat-proj-lhp', proj([
  ['Aaron Judge', 'NYY', 500, 0.430],
  ['Aaron Judge', 'NYY', 620, 0.421],
]));
expect('a projection duplicate merges rather than throwing', r.ok, r.err);
expect('...keeping the larger sample',
  r.ok && stored('bat-proj-lhp', 'aaron judge nyy').sample_size === 620,
  r.ok ? String(stored('bat-proj-lhp', 'aaron judge nyy').sample_size) : '');
expect('...and is reported by name', r.ok && r.out.collisions.length === 1,
  r.ok ? JSON.stringify(r.out.collisions) : '');

console.log('\n6. an unlabelled row beside a labelled one fails SAFE');
// A half-populated Season column is the one case where we cannot tell,
// and "cannot tell" resolves toward throwing, never toward merging.
r = ingest('bat-proj-rhp', act([
  ['Aaron Judge', 'NYY', 500, 0.430, '2025'],
  ['Aaron Judge', 'NYY', 620, 0.421, ''],
]));
expect('a missing label is treated as differing, so it throws', !r.ok,
  r.ok ? 'accepted' : '');
expect('...and the message shows which side was empty',
  !r.ok && /empty/.test(r.err), r.err);

console.log('\n7. distinct players are never touched');
r = ingest('bat-act-rhb', act([
  ['Max Muncy', 'LAD', 212, 0.301, 'Total'],
  ['Max Muncy', 'ATH', 149, 0.290, 'Total'],
  ['Aaron Judge', 'NYY', 600, 0.430, 'Total'],
]));
expect('two same-named players on different teams both survive',
  r.ok && !!stored('bat-act-rhb', 'max muncy lad') && !!stored('bat-act-rhb', 'max muncy ath'),
  r.err || '');
expect('...with no collision reported', r.ok && r.out.collisions.length === 0,
  r.ok ? JSON.stringify(r.out.collisions) : '');

console.log('\n8. the period label is CAPTURED, never derived');
const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const schema = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
expect('parseCSV looks for a period column by header name',
  /PERIOD_COLS = \['season', 'year', 'period'\]/.test(api));
expect('period is null when the source has no such column -- not inferred',
  /const period = periodCol \? String\(/.test(api));
expect('the guard compares r.period, not r.sample or r.woba',
  /prev\.period == null \? null : String\(prev\.period\)/.test(schema));
const guard = schema.slice(schema.indexOf('const first = new Map();'),
  schema.indexOf('for (const r of first.values())'));
expect('...and the classification reads NO numeric field at all',
  !/\.sample\b|\.woba\b/.test(guard.slice(0, guard.indexOf('collisions.push'))),
  'guard head');

console.log('\n9. every call site reads .rows -- no caller is left on a bare count');
const jobs = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
const all = api + '\n' + jobs;
const sites = all.split('\n').filter(l => /=\s*ingestWobaCSV\(/.test(l));
expect('all five call sites found', sites.length === 5, String(sites.length));
expect('none assigns the result straight into a JSON count field',
  !/rows: inserted(?![.\w])/.test(all) && !/rowCount: inserted(?![.\w])/.test(all));

console.log('\n10. the daily snapshot stores the row the live table stored');
// Before this change a duplicate threw, so the snapshot never saw one.
// Now that collisions merge, the snapshot writer -- INSERT OR REPLACE,
// last write wins -- would keep the SMALLER row while woba_data keeps
// the larger, and a date-accurate backtest would silently disagree with
// live. It is handed the deduped rows for that reason.
r = ingest('pit-proj-lhb', 'Name,Team,TBF,wOBA\n'
  + 'Sandy Alcantara,MIA,300,0.310\nSandy Alcantara,MIA,420,0.295\n');
const liveRow = r.ok ? stored('pit-proj-lhb', 'sandy alcantara mia') : null;
const snapRow = r.ok ? db.prepare(
  'SELECT woba, sample_size FROM woba_data_snapshot WHERE data_key=? AND LOWER(player_name)=?'
).get('pit-proj-lhb', 'sandy alcantara mia') : null;
expect('the snapshot has the row at all', !!snapRow, r.err || '');
expect('...with the same sample as woba_data',
  !!snapRow && snapRow.sample_size === liveRow.sample_size && snapRow.sample_size === 420,
  snapRow ? snapRow.sample_size + ' vs ' + liveRow.sample_size : '');
expect('...and the same wOBA',
  !!snapRow && Math.abs(snapRow.woba - liveRow.woba) < 1e-9);
expect('exactly one snapshot row for that player -- not both duplicates',
  db.prepare('SELECT COUNT(*) c FROM woba_data_snapshot WHERE data_key=? AND LOWER(player_name)=?')
    .get('pit-proj-lhb', 'sandy alcantara mia').c === 1);

try { fs.unlinkSync(TMP_DB); } catch (e) { /* best effort */ }
console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
