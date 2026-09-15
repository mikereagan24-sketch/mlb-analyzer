#!/usr/bin/env node
// game_log.away_sp_id / home_sp_id: the feed carries it, the backfill fills
// the past, and neither may pair an id with the wrong name. (2026-09-14)
//   node scripts/test-game-log-sp-id.js
// Exit 1 on any failure. No network.
//
// WHY THE ID EXISTS. away_sp / home_sp are TEXT, and statsapi supplies
// "F. Last" for some sides, so every consumer re-derived an id from an
// abbreviated name. Measured 2026-08-16..09-15: 32 of 830 sides (3.9%)
// unresolvable by name even through the shared fuzzy matcher, 4 of them
// ambiguous beyond rescue. The schedule feed already had the id.
//
// THE FAILURE THIS GUARDS AGAINST is not a missing id -- it is an id that
// belongs to a different pitcher than the name beside it. Two places can
// produce that, and both are covered below: the upsert (RotoWire writes a
// confirmed NAME with no id after a scratch) and the backfill (fill by
// date+team without checking who the row says started).
const path = require('path');
const R = path.join(__dirname, '..');
const fs = require('fs');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const { sameStarter } = require(path.join(R, 'services/backfill-tasks/game-log-sp-id'));
const { getBackfillTask } = require(path.join(R, 'services/backfill-jobs'));

// The object literal passed to the call starting at `at`: from the first '{'
// after it to its matching '}', skipping braces inside string literals.
// Returns null when there is no literal (e.g. a variable is passed).
function objectLiteralAfter(src, at) {
  const open = src.indexOf('{', at);
  const paren = src.indexOf(')', at);
  if (open < 0 || (paren >= 0 && paren < open)) return null;
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got)
                 + '\n        want ' + JSON.stringify(want)));
}

console.log('1. sameStarter goes through the shared matcher, not string equality');
check('exact match', sameStarter('Carmen Mlodzinski', 'Carmen Mlodzinski'), true);
// The 31-of-832 case: the stored name is abbreviated, the appearance is not.
check('abbreviated stored name matches the full appearance name',
  sameStarter('C. Mlodzinski', 'Carmen Mlodzinski'), true);
check('...and the other direction', sameStarter('Matthew Liberatore', 'M. Liberatore'), true);
check('diacritics fold', sameStarter('C. Sanchez', 'Cristopher Sánchez'), true);
check('suffixes fold', sameStarter('Luis Ortiz Jr.', 'Luis Ortiz'), true);
// The 7 that remain after the matcher: genuine late changes. These MUST
// stay rejected -- writing an id here would contradict the visible name.
check('a genuine change is REJECTED (Perkins vs Basso)',
  sameStarter('Jack Perkins', 'Brady Basso'), false);
check('...and Fried vs Rodon', sameStarter('Max Fried', 'Carlos Rodón'), false);
check('same surname, different first initial is rejected',
  sameStarter('A. Rodriguez', 'Carlos Rodriguez'), false);
check('empty inputs are not a match', [sameStarter(null, 'X'), sameStarter('X', '')],
  [false, false]);

console.log('');
console.log('2. the backfill classifies every side it cannot fill');
const mem = new Database(':memory:');
mem.exec(
  'CREATE TABLE game_log (game_date TEXT, game_id TEXT, game_number INTEGER, '
  + 'away_team TEXT, home_team TEXT, away_sp TEXT, home_sp TEXT, '
  + 'away_sp_id INTEGER, home_sp_id INTEGER, home_score INTEGER, '
  + 'PRIMARY KEY (game_date, game_id));'
  + 'CREATE TABLE pitcher_game_log (game_date TEXT, team TEXT, pitcher_name TEXT, '
  + 'pitcher_mlb_id INTEGER, was_starter INTEGER, game_number INTEGER);');
const G = mem.prepare('INSERT INTO game_log VALUES (?,?,?,?,?,?,?,?,?,?)');
const A = mem.prepare('INSERT INTO pitcher_game_log VALUES (?,?,?,?,?,?)');

// (a) fillable both sides, home side abbreviated
G.run('2026-09-01', 'aaa-bbb', 1, 'AAA', 'BBB', 'Full Name', 'C. Mlodzinski', null, null, 5);
A.run('2026-09-01', 'AAA', 'Full Name', 101, 1, 1);
A.run('2026-09-01', 'BBB', 'Carmen Mlodzinski', 102, 1, 1);
// (b) genuine mismatch -> refused
G.run('2026-09-02', 'ccc-ddd', 1, 'CCC', 'DDD', 'Jack Perkins', 'Ok Guy', null, null, 3);
A.run('2026-09-02', 'CCC', 'Brady Basso', 103, 1, 1);
A.run('2026-09-02', 'DDD', 'Ok Guy', 104, 1, 1);
// (c) two starters flagged on one side -> refused, never guessed
G.run('2026-09-03', 'eee-fff', 1, 'EEE', 'FFF', 'Opener Guy', 'Solo Guy', null, null, 4);
A.run('2026-09-03', 'EEE', 'Opener Guy', 105, 1, 1);
A.run('2026-09-03', 'EEE', 'Bulk Guy', 106, 1, 1);
A.run('2026-09-03', 'FFF', 'Solo Guy', 107, 1, 1);
// (d) unplayed game, no appearance rows at all
G.run('2026-09-20', 'ggg-hhh', 1, 'GGG', 'HHH', 'Future Guy', 'Other Guy', null, null, null);
// (e) an id the feed already supplied must not be touched
G.run('2026-09-04', 'iii-jjj', 1, 'III', 'JJJ', 'Feed Guy', 'Feed Two', 900, 901, 6);
A.run('2026-09-04', 'III', 'Someone Else', 999, 1, 1);
A.run('2026-09-04', 'JJJ', 'Feed Two', 902, 1, 1);
// (f) doubleheader leg 2 picks its own starter
G.run('2026-09-05', 'kkk-lll-g2', 2, 'KKK', 'LLL', 'Leg Two', 'Leg Two Home', null, null, 2);
A.run('2026-09-05', 'KKK', 'Leg One', 201, 1, 1);
A.run('2026-09-05', 'KKK', 'Leg Two', 202, 1, 2);
A.run('2026-09-05', 'LLL', 'Leg Two Home', 203, 1, 2);

const task = getBackfillTask('game_log_sp_id');
check('the task is registered', !!task, true);

(async function main() {
  const dry = await task.run({ db: mem, q: {}, params: { from: '2026-01-01', to: '2026-12-31' },
    dryRun: true, onProgress: () => {} });
  check('dry run writes nothing',
    mem.prepare('SELECT COUNT(*) n FROM game_log WHERE away_sp_id IS NOT NULL '
      + 'AND game_id != ?').get('iii-jjj').n, 0);
  check('classification counts', [dry.stats.filled, dry.stats.name_mismatch,
    dry.stats.multiple_starters, dry.stats.no_starter_row],
    // 6 fillable sides: 2 from (a), 1 from (b), 1 from (c), 2 from (f).
    // (e) is not examined at all -- both its ids are already present, so the
    // row does not match the 'IS NULL' selection, which is itself the point.
    [6, 1, 1, 2]);
  check('unplayed sides are called out inside no_starter_row', dry.stats.unplayed_sides, 2);

  const live = await task.run({ db: mem, q: {}, params: { from: '2026-01-01', to: '2026-12-31' },
    dryRun: false, onProgress: () => {} });
  check('live wrote exactly what the dry run planned',
    [live.written, live.verification.writes_matched_plan], [6, true]);

  const row = (gi) => mem.prepare('SELECT * FROM game_log WHERE game_id = ?').get(gi);
  check('(a) both sides filled, abbreviated one included',
    [row('aaa-bbb').away_sp_id, row('aaa-bbb').home_sp_id], [101, 102]);
  check('(b) the genuine mismatch stays NULL, the good side fills',
    [row('ccc-ddd').away_sp_id, row('ccc-ddd').home_sp_id], [null, 104]);
  check('(c) two flagged starters is refused, not guessed',
    [row('eee-fff').away_sp_id, row('eee-fff').home_sp_id], [null, 107]);
  check('(d) an unplayed game stays NULL',
    [row('ggg-hhh').away_sp_id, row('ggg-hhh').home_sp_id], [null, null]);
  // The important one: a feed-supplied id is never overwritten, even though
  // the appearance log names a different pitcher for that side.
  check('(e) a feed-supplied id is NOT overwritten by the appearance log',
    [row('iii-jjj').away_sp_id, row('iii-jjj').home_sp_id], [900, 901]);
  check('(f) doubleheader leg 2 takes leg 2 starters',
    [row('kkk-lll-g2').away_sp_id, row('kkk-lll-g2').home_sp_id], [202, 203]);

  const again = await task.run({ db: mem, q: {}, params: { from: '2026-01-01', to: '2026-12-31' },
    dryRun: false, onProgress: () => {} });
  check('re-running is idempotent (nothing left to write)', again.written, 0);

  console.log('');
  console.log('3. the write path carries the id, and cannot pair it with a stale name');
  const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
  const scr = strip(fs.readFileSync(path.join(R, 'services/scraper.js'), 'utf8'));
  check('the scraper carries probablePitcher.id alongside the name',
    /away_sp:\s*aPP\s*\?\s*\{[^}]*id:\s*aPP\.id/.test(scr), true);
  // EVERY upsertGame.run( PAYLOAD, NOT A COUNT OF TWO. (2026-09-15)
  //
  // This used to assert that exactly two sites in jobs.js set away_sp_id.
  // There were four call sites -- two in jobs.js the count never looked at
  // past the first two, and POST /games/upsert in routes/api.js -- and
  // better-sqlite3 throws on any missing named parameter. The RotoWire
  // site's omission failed every lineup pull from the #407 deploy onward.
  // So: find every call, extract its object literal, check both keys.
  const payloadSites = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) {
        const src = strip(fs.readFileSync(p, 'utf8'));
        let at = src.indexOf('upsertGame.run(');
        while (at >= 0) {
          payloadSites.push({ file: path.relative(R, p).replace(/\\/g, '/'),
            line: src.slice(0, at).split('\n').length, body: objectLiteralAfter(src, at) });
          at = src.indexOf('upsertGame.run(', at + 1);
        }
      }
    }
  };
  for (const d of ['services', 'routes', 'db', 'utils']) walk(path.join(R, d));
  // A scanner that finds nothing passes every per-site check vacuously.
  // 4 is today's call-site count; this is a floor on the scanner, not the
  // property under test.
  check('the scanner finds the known upsertGame.run( sites (>= 4)', payloadSites.length >= 4, true);
  for (const s of payloadSites) {
    check(s.file + ' (stripped line ' + s.line + ') payload carries away_sp_id and home_sp_id',
      !!s.body && /(^|[\s,{])away_sp_id\s*:/.test(s.body) && /(^|[\s,{])home_sp_id\s*:/.test(s.body), true);
  }
  const sch = strip(fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8'));
  check('the columns are migrated', /ADD COLUMN away_sp_id INTEGER/.test(sch)
    && /ADD COLUMN home_sp_id INTEGER/.test(sch), true);
  // A plain COALESCE here would keep an id belonging to the pitcher who was
  // scratched. The CASE clears it when a DIFFERENT name arrives with no id.
  check('the upsert clears the id when a different name arrives without one',
    /away_sp_id = CASE[\s\S]{0,260}excluded\.away_sp <> game_log\.away_sp THEN NULL/.test(sch), true);
  check('...and the same for the home side',
    /home_sp_id = CASE[\s\S]{0,260}excluded\.home_sp <> game_log\.home_sp THEN NULL/.test(sch), true);

  console.log('');
  console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
