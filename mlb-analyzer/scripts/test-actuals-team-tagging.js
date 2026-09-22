// Actuals rows are team-tagged ONLY where a name collides.
//
// THE COLLISION. There are two Max Muncys (LAD 571970, ATH 691777) and
// two Yunior Martes (CIN, SF). Projections keep them apart because they
// carry 'Team'; the splits API that feeds the actuals carries
// 'TeamNameAbb', which parseCSV did not recognise -- so both players
// became one bare "Max Muncy" row and one silently overwrote the other,
// until #435's duplicate guard turned that collapse into a rejected
// upload (bat-act-lhp, 212 vs 149).
//
// WHY NOT TAG EVERYTHING. Measured against the real (name, team) pairs
// the model queries with since 2026-08-01
// (scripts/probe-actuals-team-tagging.js):
//
//   blanket team-tagging   pit: 76 of 245 queries STOP resolving (31%)
//                          bat: 202 of 536 stop resolving (38%)
//   collision-only         pit: 0 lost, 0 gained
//                          bat: 0 lost, 0 gained
//
// FanGraphs reports a multi-team marker -- "6 Tms", "2 Tms" -- for
// anyone who changed teams inside the two-year window. Tagging with that
// yields "kevin gausman 6 tms", which no lookup carrying teamHint 'TOR'
// can hit, and the bare key it used to land on is gone. Collision-only
// touches 1-2 names per key instead of 800-1200.
//
// Run: node --max-old-space-size=1536 scripts/test-actuals-team-tagging.js

const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const { normName, fuzzyLookup } = require(path.join(R, 'utils/names'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');

// The shipped branch, lifted so the test exercises the real rule shape.
function applyTagging(key, rows) {
  if (key.includes('-act-')) {
    const c = new Map();
    for (const r of rows) { const k = normName(r.name); c.set(k, (c.get(k) || 0) + 1); }
    for (const r of rows) if (c.get(normName(r.name)) <= 1) r.team = null;
  }
  return rows;
}
const SUF = /\s+(jr\.?|sr\.?|ii|iii|iv)$/i;
function expand(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.team) { out.push(r.name); continue; }
    out.push(r.name + ' ' + r.team);
    if (SUF.test(r.name)) out.push(r.name.replace(SUF, '') + ' ' + r.team);
  }
  return out;
}
const idxOf = (forms) => {
  const m = {};
  for (const f of forms) m[normName(f)] = { woba: 0.3, sample: 100 };
  return m;
};
const mk = (n, t) => ({ name: n, team: t, woba: 0.3, sample: 100 });

console.log('\n1. parseCSV reads the actuals team column');
expect("'teamnameabb' is an accepted team header",
  /TEAM_COLS = \['team', 'teamnameabb'\]/.test(api));
expect("'team' is preferred when both exist (ordered map, not a set test)",
  /TEAM_COLS\s*\n?\s*\.map\(want =>/.test(api));

console.log('\n2. only colliding names get a team');
const act = applyTagging('bat-act-lhp',
  [mk('Max Muncy', 'LAD'), mk('Max Muncy', 'ATH'), mk('Aaron Judge', 'NYY')]);
expect('both Muncys keep their team', act[0].team === 'LAD' && act[1].team === 'ATH',
  act[0].team + '/' + act[1].team);
expect('a non-colliding name stays bare', act[2].team === null, String(act[2].team));

console.log('\n3. projections are untouched');
const proj = applyTagging('bat-proj-lhp', [mk('Max Muncy', 'LAD'), mk('Aaron Judge', 'NYY')]);
expect('every projection row keeps its team',
  proj.every(r => r.team !== null), proj.map(r => r.team).join('/'));
expect('the branch is scoped by -act-', /if \(key\.includes\('-act-'\)\) \{/.test(api));

console.log('\n4. the key shapes match projections, and both Muncys survive');
const forms = expand(applyTagging('bat-act-lhp',
  [mk('Max Muncy', 'LAD'), mk('Max Muncy', 'ATH'), mk('Aaron Judge', 'NYY')]));
expect('key shape is "max muncy lad", as projections use',
  forms.map(normName).indexOf('max muncy lad') !== -1, forms.map(normName).join(' | '));
expect('both Muncys produce DISTINCT keys -- no overwrite',
  new Set(forms.map(normName)).size === forms.length, forms.length + ' forms');
expect('the ambiguous bare "max muncy" key is gone',
  forms.map(normName).indexOf('max muncy') === -1);

console.log('\n5. the resolver still hits, team-first and bare');
const idx = idxOf(forms);
expect('a collided name resolves WITH its team hint', !!fuzzyLookup(idx, 'Max Muncy', 'LAD'));
expect('...to the other team too', !!fuzzyLookup(idx, 'Max Muncy', 'ATH'));
expect('a collided name with NO team hint does not resolve -- correctly ambiguous',
  !fuzzyLookup(idx, 'Max Muncy', null));
expect('a non-colliding name still resolves bare', !!fuzzyLookup(idx, 'Aaron Judge', null));
expect('...and with a team hint', !!fuzzyLookup(idx, 'Aaron Judge', 'NYY'));
expect('...and with the WRONG team hint, via the bare fallback',
  !!fuzzyLookup(idx, 'Aaron Judge', 'BOS'));

console.log('\n6. the multi-team marker cannot re-key a whole file');
// "6 Tms" is what broke blanket tagging. A non-colliding player carrying
// it must still be bare, or every traded player stops resolving.
const tms = applyTagging('bat-act-lhp', [mk('Kevin Gausman', '6 Tms'), mk('Aaron Judge', 'NYY')]);
expect('a traded, non-colliding player stays bare', tms[0].team === null, String(tms[0].team));
const tIdx = idxOf(expand(tms));
expect('...so he still resolves against his CURRENT team',
  !!fuzzyLookup(tIdx, 'Kevin Gausman', 'TOR'));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
