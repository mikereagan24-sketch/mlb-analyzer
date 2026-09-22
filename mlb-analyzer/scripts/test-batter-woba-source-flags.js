#!/usr/bin/env node
// The lineup says where each batter's wOBA came from, and changes
// nothing about pricing.
//   node --max-old-space-size=1536 scripts/test-batter-woba-source-flags.js
// Exit 1 on any failure.
//
// WHY. #434 put the two inputs behind each PITCHER rate on the matchup
// header. The batter side had nothing, and that is what let #443's defect
// run a whole season unseen: Fernando Tatis Jr., Michael Harris II,
// Vladimir Guerrero Jr. and Jazz Chisholm Jr. resolved their PROJECTION
// but not their ACTUALS -- their actuals rows are bare, and the bare
// suffixed key was excluded from the resolver's scans by a shape test.
// Every lineup row showed a plausible number with nothing saying the
// actuals term was absent from it.
//
// THE STATE THAT MATTERS IS THE THIRD ONE. A rookie below min_pa and a
// debut with no row are both ordinary. An established hitter whose
// surname IS in the actuals index on this team, or is one abbreviation
// away, is a resolver bug -- so that state is separated out and styled
// to stand out, and the other two are not.
//
// WHAT THIS PINS:
//   1. act_gated fires only below MIN_PA, and carries the sample AND the
//      threshold, the way the pitcher card does;
//   2. proj_only_no_row and proj_only_near_miss are DISTINGUISHABLE, and
//      the near-miss carries what nearly matched;
//   3. a different team is NOT a near miss -- it is a different player
//      until something says otherwise;
//   4. the reported actUsed matches what getBatterWoba actually did,
//      which is the assertion that stops the badge drifting from the
//      model;
//   5. the RAMP is reported, not just the gate: blendWoba smoothsteps the
//      actuals weight between MIN_PA and BATTER_ACT_FULL_WEIGHT_PA, and
//      at exactly MIN_PA that weight is ZERO -- so "used" alone would
//      claim a contribution the model did not make;
//   6. no pricing file changed. Asserted as a PROPERTY -- the flags are
//      absent from every pricing module -- not as a git diff, because
//      coupling a test to working-tree state makes it red on any
//      uncommitted edit (that flaw has already been fixed twice here).

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { normName, stripSfx, hasTeamTag, fuzzyLookup } = require(path.join(R, 'utils/names'));
const { blendWoba, BATTER_ACT_FULL_WEIGHT_PA } = require(path.join(R, 'services/model'));

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' -- ' + extra : ''));
  if (!cond) failed++;
}

const MIN_PA = 60;
const mk = (rows) => {
  const o = {};
  for (const [n, woba, sample] of rows) o[normName(n)] = { woba, sample };
  return o;
};

// The shipped classifier, lifted by BEHAVIOUR from routes/api.js so the
// test drives the same rule. Section 7 asserts the route still carries it.
function nearMissFor(keyMap, name, teamHint) {
  if (!keyMap) return null;
  const k = normName(name);
  const p = stripSfx(k).split(' ');
  if (p.length < 2) return null;
  const last = p[p.length - 1], initial = p[0][0];
  const tl = teamHint ? String(teamHint).toLowerCase() : null;
  let best = null;
  for (const key of Object.keys(keyMap)) {
    const tagged = hasTeamTag(key);
    const cut = tagged ? key.lastIndexOf(' ') : -1;
    const base = tagged ? key.slice(0, cut) : key;
    const tag = tagged ? key.slice(cut + 1) : null;
    const bp = stripSfx(base).split(' ');
    if (bp[bp.length - 1] !== last) continue;
    if (tag && tl && tag !== tl) continue;
    const sameInitial = !!(bp[0] && bp[0][0] === initial);
    const cand = { key, team: tag, sameInitial,
      kind: tag ? 'same_surname_same_team' : 'same_surname_untagged' };
    if (!best) best = cand;
    else if (cand.sameInitial && !best.sameInitial) best = cand;
    else if (cand.sameInitial === best.sameInitial && cand.team && !best.team) best = cand;
  }
  return best;
}
function classify(projIdx, actIdx, name, team) {
  const proj = fuzzyLookup(projIdx, name, team) || null;
  const act = fuzzyLookup(actIdx, name, team) || null;
  const sample = act && Number.isFinite(Number(act.sample)) ? Number(act.sample) : null;
  const actUsed = !!(act && !isNaN(act.woba) && sample != null && sample >= MIN_PA);
  const floor = Number(BATTER_ACT_FULL_WEIGHT_PA);
  let ramp = 0;
  if (actUsed) {
    if (!(floor > MIN_PA)) ramp = 1;
    else {
      const t = (sample - MIN_PA) / (floor - MIN_PA);
      ramp = !(t > 0) ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t));
    }
  }
  const nm = act ? null : nearMissFor(actIdx, name, team);
  const actContributes = actUsed && ramp > 0;
  let flag;
  if (actUsed) flag = actContributes ? 'ok' : 'act_ramp_zero';
  else if (act) flag = 'act_gated';
  else if (nm) flag = 'proj_only_near_miss';
  else flag = 'proj_only_no_row';
  return { flag, actUsed, actContributes, act, proj, sample,
    ramp: +ramp.toFixed(3), rampRaw: ramp, nearMiss: nm };
}

console.log('\n1. act_gated: a row resolved but sat below MIN_PA');
let r = classify(mk([['Rookie Guy SF', 0.300]]), mk([['Rookie Guy', 0.480, 12]]), 'Rookie Guy', 'SF');
expect('flag is act_gated', r.flag === 'act_gated', r.flag);
expect('the sample rides along', r.sample === 12, String(r.sample));
expect('actUsed is false', r.actUsed === false);
r = classify(mk([['Rookie Guy SF', 0.300]]), mk([['Rookie Guy', 0.480, 60]]), 'Rookie Guy', 'SF');
expect('exactly MIN_PA is NOT gated', r.flag !== 'act_gated', r.flag);

console.log('\n2. proj only, with and without a near miss');
r = classify(mk([['Debut Kid SF', 0.300]]), mk([['Someone Else', 0.300, 400]]), 'Debut Kid', 'SF');
expect('no row anywhere -> proj_only_no_row', r.flag === 'proj_only_no_row', r.flag);
expect('...and no nearMiss payload', r.nearMiss === null);
// the real shape: same surname, same team, different first name
r = classify(mk([['Bo Davidson SF', 0.300]]), mk([['Chanteyon Davidson SF', 0.273, 400]]),
  'Bo Davidson', 'SF');
expect('same surname + team -> proj_only_near_miss', r.flag === 'proj_only_near_miss', r.flag);
expect('...and it names what nearly matched',
  !!r.nearMiss && r.nearMiss.key === 'chanteyon davidson sf', JSON.stringify(r.nearMiss));
expect('...classified as same_surname_same_team',
  r.nearMiss.kind === 'same_surname_same_team', r.nearMiss.kind);
// an untagged same-surname row is also a near miss
r = classify(mk([['Bo Davidson SF', 0.300]]), mk([['Chanteyon Davidson', 0.273, 400]]),
  'Bo Davidson', 'SF');
expect('an untagged same-surname row is a near miss too',
  r.flag === 'proj_only_near_miss' && r.nearMiss.kind === 'same_surname_untagged', r.flag);
// same initial is the stronger signal and wins the pick
r = classify(mk([['Bob Smith SF', 0.300]]),
  mk([['Alan Smith SF', 0.300, 400], ['Brian Smith SF', 0.300, 400]]), 'Bob Smith', 'SF');
expect('a same-initial candidate is preferred', r.nearMiss.key === 'brian smith sf'
  && r.nearMiss.sameInitial === true, JSON.stringify(r.nearMiss));

console.log('\n3. a DIFFERENT team is not a near miss');
r = classify(mk([['Buddy Kennedy SF', 0.300]]), mk([['Buddy Kennedy WAS', 0.300, 400]]),
  'B. Kennedy', 'SF');
expect('same surname on another team -> proj_only_no_row', r.flag === 'proj_only_no_row', r.flag);
expect('...and nearMiss stays null', r.nearMiss === null, JSON.stringify(r.nearMiss));

console.log('\n4. the reported source matches what getBatterWoba actually used');
// blendWoba is what getBatterWoba calls. Its gate is act.sample >= minSample,
// and it is handed BATTER_ACT_FULL_WEIGHT_PA as the shrink floor.
for (const sample of [0, 12, 59, 60, 61, 90, 149, 150, 400]) {
  const proj = { woba: 0.300 }, act = { woba: 0.500, sample };
  const blended = blendWoba(proj, act, MIN_PA, 0.45, 0.55, null, BATTER_ACT_FULL_WEIGHT_PA);
  const cls = classify(mk([['X Y SF', 0.300]]), mk([['X Y', 0.500, sample]]), 'X Y', 'SF');
  const modelUsedAct = Math.abs(Number(blended.woba) - 0.300) > 1e-9;
  // actUsed mirrors the GATE; the ramp explains why a gated-in sample can
  // still contribute nothing at exactly the threshold.
  const claimContribution = cls.actContributes;
  expect('sample ' + String(sample).padStart(3) + ': model used actuals=' + modelUsedAct
    + ', badge claims=' + claimContribution, claimContribution === modelUsedAct,
    'blend=' + Number(blended.woba).toFixed(4) + ' ramp=' + cls.ramp + ' flag=' + cls.flag);
}

console.log('\n5. the ramp is reported, and is zero at exactly MIN_PA');
let c60 = classify(mk([['X Y SF', 0.300]]), mk([['X Y', 0.500, 60]]), 'X Y', 'SF');
expect('at MIN_PA the ramp weight is 0', c60.ramp === 0, String(c60.ramp));
expect('...and the flag says so rather than claiming a blend',
  c60.flag === 'act_ramp_zero', c60.flag);
let c150 = classify(mk([['X Y SF', 0.300]]), mk([['X Y', 0.500, 150]]), 'X Y', 'SF');
expect('at the full-weight floor the ramp is 1', c150.ramp === 1, String(c150.ramp));
expect('...and the flag is ok', c150.flag === 'ok', c150.flag);
let c90 = classify(mk([['X Y SF', 0.300]]), mk([['X Y', 0.500, 90]]), 'X Y', 'SF');
expect('between them it is strictly partial', c90.ramp > 0 && c90.ramp < 1, String(c90.ramp));

console.log('\n6. the regression case: a bare suffixed actuals row resolves and is NOT flagged');
// This is the #443 shape. Before that fix the actuals lookup missed and
// this row would have read "proj only"; it must now read as blended.
r = classify(mk([['Fernando Tatis Jr. SD', 0.350]]), mk([['Fernando Tatis Jr.', 0.360, 500]]),
  'F. Tatis', 'SD');
expect('"F. Tatis" + SD resolves its bare suffixed actuals row', r.actUsed === true, r.flag);
expect('...so it is not flagged at all', r.flag === 'ok', r.flag);

console.log('\n7. display only -- the flags appear in no pricing module');
const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
expect('routes/api.js builds the report', /wobaSrc = \{/.test(api) && /nearMissFor\(/.test(api));
expect('the route reports every flag',
  ['proj_only_near_miss', 'proj_only_no_row', 'act_gated', 'act_ramp_zero']
    .every(f => api.indexOf("'" + f + "'") > -1));
expect('index.html renders them', /function batSrc\(/.test(html)
  && /function batSrcSummary\(/.test(html));
expect('the per-slot counts are on the lineup header', /batSrcSummary\(lu\)/.test(html));
const PRICING = ['services/model.js', 'services/jobs.js', 'services/parameter-sweep.js',
  'db/schema.js', 'utils/names.js'];
for (const f of PRICING) {
  const src = fs.readFileSync(path.join(R, f), 'utf8');
  const hits = ['wobaSrc', 'nearMissFor', 'proj_only_near_miss', 'act_ramp_zero', 'batSrc']
    .filter(sym => src.indexOf(sym) > -1);
  expect(f + ' carries none of the display symbols', hits.length === 0, hits.join(', '));
}
// and the model-side invariants the badge depends on
const model = fs.readFileSync(path.join(R, 'services/model.js'), 'utf8');
expect('getBatterWoba still passes the shrink floor to blendWoba',
  /minPA, wProj, wAct, pf, BATTER_ACT_FULL_WEIGHT_PA/.test(model));
expect('the floor is still 150', Number(BATTER_ACT_FULL_WEIGHT_PA) === 150,
  String(BATTER_ACT_FULL_WEIGHT_PA));
expect('blendWoba still gates on sample >= minSample',
  /act\.sample >= minSample/.test(model));

console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
