#!/usr/bin/env node
/**
 * Bullpen park-neutralization. (2026-08-31)
 *
 * Three things that must hold:
 *
 *   1. NO RESOLVER => byte-identical to the un-neutralized path. The
 *      extension must be inert until deliberately wired.
 *   2. ACTUALS ONLY. The Steamer projection is already park-neutral;
 *      dividing it too is the double-count the 2026-07-02 audit removed
 *      from the batter path.
 *   3. NO CIRCULAR REQUIRE. db/schema.js must not depend on
 *      services/park-factors-woba, which depends on db/schema for the
 *      park_factors table. The resolver is passed IN for this reason.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const { q } = require(path.join(R, 'db/schema'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const mdl = require(path.join(R, 'services/model'));
const { getSettings } = require(path.join(R, 'services/jobs'));
const settings = getSettings();

const BP = (team, leg, neut) => q.getBullpenWobaBlended(
  team, '', [], 0.55, 0.45, 0.35, 0.65, 0.65, 0.35,
  '2026-08-22', 0.335, 100, true, 0.25, 0.75, leg, neut);

// ---- 1. inert without a resolver ---------------------------------------
for (const t of ['COL', 'SEA', 'NYY', 'MIA']) {
  const omitted = q.getBullpenWobaBlended(t, '', [], 0.55, 0.45, 0.35, 0.65,
    0.65, 0.35, '2026-08-22', 0.335, 100, true, 0.25, 0.75, 1);
  const explicitNull = BP(t, 1, null);
  eq(omitted.woba, explicitNull.woba, t + ': omitting the resolver == passing null');
  eq(omitted.pitchers, explicitNull.pitchers, t + ': pool size unchanged either way');
}

// A resolver that returns null (flag off) must also be inert -- that is
// the production path when PARK_NEUTRAL_INPUTS_ENABLED is false.
for (const t of ['COL', 'SEA']) {
  eq(BP(t, 1, () => null).woba, BP(t, 1, null).woba,
     t + ': a resolver returning null leaves the term untouched');
}

// ---- 2. it actually moves, in the right direction ----------------------
const mk = team => (name, raw) => {
  const fac = mdl.resolveNeutralizationFactor(team, settings, { playerName: name, isPitcher: true });
  return fac == null ? null : pfw.neutralizeWoba(raw, fac);
};
if (settings.PARK_NEUTRAL_INPUTS_ENABLED) {
  const col = { off: BP('COL', 1, null).woba, on: BP('COL', 1, mk('COL')).woba };
  const sea = { off: BP('SEA', 1, null).woba, on: BP('SEA', 1, mk('SEA')).woba };
  ok(col.on !== col.off, 'COL pool wOBA moves when neutralized');
  // Coors inflates actuals, so dividing it out makes the pen look BETTER
  // (lower wOBA-against). This is the direction recorded in the gate
  // registry before the code existed.
  ok(col.on < col.off, 'COL (hitter park) improves — inflation removed');
  ok(sea.on > sea.off, 'SEA (pitcher park) worsens — deflation removed');
  ok(Math.abs(col.on - col.off) > Math.abs(sea.on - sea.off) * 0.5,
     'the more extreme park moves at least comparably');
}

// ---- 3. actuals only ---------------------------------------------------
// A pool whose members are ALL below the actuals gate uses projections
// only, so neutralization must be a no-op there regardless of park.
const projOnly = q.getBullpenWobaBlended('COL', '', [], 0.55, 0.45, 0.35, 0.65,
  0.65, 0.35, '2026-08-22', 0.335, 1e9, true, 0.25, 0.75, 1, mk('COL'));
const projOnlyRaw = q.getBullpenWobaBlended('COL', '', [], 0.55, 0.45, 0.35, 0.65,
  0.65, 0.35, '2026-08-22', 0.335, 1e9, true, 0.25, 0.75, 1, null);
eq(projOnly.woba, projOnlyRaw.woba,
   'with the actuals gate unreachable, neutralization is a no-op (projections stay raw)');

// A resolver that throws must not take the pool down.
ok(BP('COL', 1, () => { throw new Error('boom'); }).woba != null,
   'a throwing resolver degrades to the raw term rather than failing the pool');

// ---- 4. no circular require -------------------------------------------
const schemaSrc = fs.readFileSync(path.join(R, 'db/schema.js'), 'utf8');
ok(!schemaSrc.includes("require('../services/park-factors-woba')")
   && !schemaSrc.includes('require("../services/park-factors-woba")'),
   'db/schema.js does NOT require park-factors-woba — that would be circular');
const pfwSrc = fs.readFileSync(path.join(R, 'services/park-factors-woba.js'), 'utf8');
ok(pfwSrc.includes("require('../db/schema')"),
   'and park-factors-woba DOES require db/schema — which is why the other direction must not exist');

// The caller supplies the resolver, reusing model.js rather than copying.
const jobsSrc = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');
ok(jobsSrc.includes('resolveNeutralizationFactor'),
   'jobs.js builds the resolver from model.js resolveNeutralizationFactor');
// Match a CALL, not the bare name. The first version asserted on the name
// alone and failed against a source COMMENT in schema.js explaining which
// function the resolver reuses -- a test that cannot tell a copy of the
// logic from a note about it. Second time this exact trap has appeared
// (see test-bullpen-availability.js and the -g(d+) regex), so: assert on
// something only real code contains.
ok(!schemaSrc.includes('resolveNeutralizationFactor('),
   'the schema layer never CALLS the resolver — it only receives one');
ok(!schemaSrc.includes('stint-cache') && !schemaSrc.includes('getWobaParkFactor'),
   'and holds no copy of the neutralization lookup either');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
