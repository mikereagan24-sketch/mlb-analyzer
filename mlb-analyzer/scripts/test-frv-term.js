#!/usr/bin/env node
// The FRV team term after the (mlb_id, position) split (2026-09-12).
//   node scripts/test-frv-term.js
// Exit 1 on any failure.
//
// The load-bearing assertions:
//   (1) ONE implementation — all three call sites reach the same function,
//       with the same floor. The drift this replaces was a harness that
//       admitted rows production rejected, feeding the gate's own evidence.
//   (2) the slot lookup uses tonight's position, and falls back only when
//       there is no row for it — and SAYS so
//   (3) a missing fielder contributes NULL, not zero: the team value is the
//       resolved slots' mean scaled to the full complement
//   (4) warnings print with the feature gate OFF
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const term = require('../utils/fielding-frv-term');

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label
    + (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('1. one implementation, three call sites');
for (const f of ['services/jobs.js', 'services/frv-backtest.js', 'services/baserunning-backtest.js']) {
  check(f + ' delegates to the shared term',
    /require\('\.\.\/utils\/fielding-frv-term'\)/.test(read(f)), true);
}
// The old inline arithmetic must be gone from all three, or a copy survives.
for (const f of ['services/jobs.js', 'services/frv-backtest.js', 'services/baserunning-backtest.js']) {
  check(f + ' no longer computes the rate itself',
    /total_runs \/ row\.outs_total/.test(read(f)), false);
}
check('the floor is imported, never restated',
  /require\('\.\.\/services\/scraper'\)/.test(read('utils/fielding-frv-term.js'))
  && !/\b600\b/.test(read('utils/fielding-frv-term.js').replace(/^\s*\/\/.*$/gm, '')), true);

console.log('\n2. slot matching, fallback, and null-not-zero — on a synthetic table');
const mem = new Database(':memory:');
mem.exec(`CREATE TABLE fielding_frv (
  mlb_id INTEGER NOT NULL, name TEXT, total_runs REAL NOT NULL DEFAULT 0,
  outs_total INTEGER NOT NULL DEFAULT 0, position TEXT NOT NULL,
  season_start INTEGER, season_end INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (mlb_id, position))`);
const ins = mem.prepare('INSERT INTO fielding_frv (mlb_id,name,total_runs,outs_total,position) VALUES (?,?,?,?,?)');
// id 1: good at CF (+10 runs / 1000 outs), bad at LF (-10 / 1000)
ins.run(1, 'Two Positions', 10, 1000, '8');
ins.run(1, 'Two Positions', -10, 1000, '7');
// id 2: only a 1B row, big sample
ins.run(2, 'One Position', 6, 2000, '3');
// id 3: a row below the floor
ins.run(3, 'Thin Sample', 5, 100, '6');
// id 4: no row at all (the rookie case)
const q = {
  getFieldingFrvByIdPos: mem.prepare('SELECT * FROM fielding_frv WHERE mlb_id=? AND position=?'),
  getFieldingFrvPrimary: mem.prepare('SELECT * FROM fielding_frv WHERE mlb_id=? ORDER BY outs_total DESC LIMIT 1'),
};
const resolveId = (t, n) => ({ 'Two Positions': 1, 'One Position': 2, 'Thin Sample': 3, 'Rookie': 4 }[n] || null);
const warnings = [];
const run = (lineup) => term.fieldingRunsPerGame({
  q, team: 'TST', lineupJson: lineup, settings: { DEFENSE_FRV_OPPS_PER_GAME: 25 },
  resolveId, onWarn: (m) => warnings.push(m),
});

// Same player, two positions, opposite values: the slot must decide.
const atCf = run([{ name: 'Two Positions', pos: 'CF' }]);
const atLf = run([{ name: 'Two Positions', pos: 'LF' }]);
check('CF slot uses the CF row  (+10/1000*25)', Number(atCf.value.toFixed(6)), 0.25);
check('LF slot uses the LF row  (-10/1000*25)', Number(atLf.value.toFixed(6)), -0.25);
check('both were exact matches, no fallback', [atCf.fallback, atLf.fallback], [0, 0]);

// No row at tonight's position -> biggest-sample row, reported.
const fb = run([{ name: 'One Position', pos: 'SS' }]);
check('fallback used when the slot has no row', fb.fallback, 1);
check('fallback value is the 1B row (6/2000*25)', Number(fb.value.toFixed(6)), 0.075);
check('fallback names the substituted position',
  /no FRV row at SS .* falling back .* position 3/.test(warnings.join('\n')), true);

// Below-floor and missing both contribute nothing.
const thin = run([{ name: 'Thin Sample', pos: 'SS' }]);
check('below-floor row contributes nothing', [thin.value, thin.missing], [null, 1]);
const rookie = run([{ name: 'Rookie', pos: '2B' }]);
check('no-row player contributes nothing', [rookie.value, rookie.missing], [null, 1]);

console.log('\n3. null, not zero: the sum scales by resolved slots');
// Two good slots (+0.25 CF, +0.075 1B) and one rookie. Old behaviour summed
// the two and implicitly called the rookie average. New behaviour scales
// the two-slot mean over all three fielding slots.
const mixed = run([
  { name: 'Two Positions', pos: 'CF' },
  { name: 'One Position', pos: '1B' },
  { name: 'Rookie', pos: '2B' },
]);
check('counts 3 fielding slots, resolves 2', [mixed.fielders, mixed.resolved, mixed.missing], [3, 2, 1]);
const oldWay = 0.25 + 0.075;                 // sum over resolved = rookie treated as 0
const newWay = ((0.25 + 0.075) / 2) * 3;     // resolved mean scaled to the complement
check('value is the scaled mean, not the bare sum', Number(mixed.value.toFixed(6)), Number(newWay.toFixed(6)));
check('and that really differs from the old behaviour', mixed.value !== oldWay, true);
// With every slot resolved the two agree exactly — the change is confined
// to lineups with missing fielders.
const full = run([{ name: 'Two Positions', pos: 'CF' }, { name: 'One Position', pos: '1B' }]);
check('no scaling when every slot resolves', Number(full.value.toFixed(6)), Number(oldWay.toFixed(6)));

console.log('\n4. warnings do not depend on the feature gate');
// The term never reads DEFENSE_FRV_ENABLED at all — that is the point.
// Comments stripped: the header explains WHY the warnings used to be
// gated, and matching on that would fail for the wrong reason.
const termCode = read('utils/fielding-frv-term.js')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('the shared term does not reference the gate in CODE',
  /DEFENSE_FRV_ENABLED/.test(termCode), false);
check('a missing fielder produced a warning with no settings gate at all',
  warnings.some((w) => /Rookie.*no usable FRV row/.test(w)), true);
check('C / DH / P are not fielding slots',
  run([{ name: 'Two Positions', pos: 'C' }, { name: 'One Position', pos: 'DH' }]).fielders, 0);

console.log('\n5. the live table after the migration');
const live = new Database(process.env.MLB_DB || 'data/mlb.db', { readonly: true });
const pk = live.prepare('PRAGMA table_info(fielding_frv)').all().filter((c) => c.pk > 0).map((c) => c.name);
check('live PK is (mlb_id, position)', pk, ['mlb_id', 'position']);
const floorViolations = live.prepare('SELECT COUNT(*) n FROM fielding_frv WHERE outs_total < 600').get().n;
check('no row below the ingest floor', floorViolations, 0);
const nullPos = live.prepare('SELECT COUNT(*) n FROM fielding_frv WHERE position IS NULL').get().n;
check('no NULL position (the new key forbids it)', nullPos, 0);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
