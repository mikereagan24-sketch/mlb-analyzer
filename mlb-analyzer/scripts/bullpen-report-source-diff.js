#!/usr/bin/env node
/**
 * What changes when the bullpen report stops mirroring and consumes the
 * shared function. (2026-08-31)
 *
 * TWO DIFFS, because they are different kinds of change:
 *
 *   MEMBERSHIP  which relievers the table marks in_pool. This is a change
 *               to WHAT IS BEING LOOKED AT, not to a number underneath it,
 *               so it is reported per team and large moves are flagged.
 *   TEAM wOBA   the displayed team number, which moves to match the model's.
 *
 * The report has never known the pool-selection rule (qualified>=3 else
 * slice(0,8)), the downweight-starters weighting, the no-lineup fallback
 * branch, or park neutralization. Its in_pool flag was
 * `role==='RP' && !isSP && !fatigued` -- which is CANDIDACY, not pool
 * membership. Everything that passed those three tests read as in-pool
 * regardless of whether the model actually averaged it.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { q, db } = require(path.join(R, 'db/schema'));
const mdl = require(path.join(R, 'services/model'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const jobs = require(path.join(R, 'services/jobs'));

const settings = jobs.getSettings();
const DATE = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// PRODUCTION KNOBS, not literals. The first version of this script hardcoded
// minBF=100 (the SP-facing gate) and globals 0.65/0.35. Production runs
// BULLPEN_MIN_BF=50 and W_PROJ/W_ACT 0.45/0.55, so the absolute wOBAs it
// printed were not the ones the report shows. A diff script that does not
// use the real settings is measuring a configuration nobody runs.
const N = (v, d) => (v != null ? Number(v) : d);
const S = {
  bpSR: N(settings.BP_STRONG_WEIGHT_R, 0.55), bpWR: N(settings.BP_WEAK_WEIGHT_R, 0.45),
  bpSL: N(settings.BP_STRONG_WEIGHT_L, 0.35), bpWL: N(settings.BP_WEAK_WEIGHT_L, 0.65),
  wProj: N(settings.W_PROJ, 0.65), wAct: N(settings.W_ACT, 0.35),
  unk: N(settings.UNKNOWN_PITCHER_WOBA, 0.335),
  minBF: N(settings.BULLPEN_MIN_BF, N(settings.MIN_BF, 100)),
  bpWP: N(settings.BULLPEN_W_PROJ, N(settings.W_PROJ, 0.65)),
  bpWA: N(settings.BULLPEN_W_ACT, N(settings.W_ACT, 0.35)),
  dws: !!(settings.BULLPEN_DOWNWEIGHT_STARTERS === true || settings.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
};
console.log('settings: minBF=' + S.minBF + '  global=' + S.wProj + '/' + S.wAct
  + '  bullpen=' + S.bpWP + '/' + S.bpWA + '  downweightStarters=' + S.dws);
const norm = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

const mk = t => (n, raw) => {
  try {
    const f = mdl.resolveNeutralizationFactor(t, settings, { playerName: n, isPitcher: true });
    return f == null ? null : pfw.neutralizeWoba(raw, f);
  } catch (e) { return null; }
};

// What the OLD report counted as in_pool: role RP, not the starter, not
// fatigued. No pool-selection rule, because it did not know there was one.
function oldInPool(team) {
  const roster = db.prepare("SELECT player_name, role FROM team_rosters WHERE team=? AND role='RP'").all(team);
  const fatigued = new Set(q.getFatiguedPitchers(team, DATE).map(f => norm(f.pitcher_name)));
  return new Set(roster.map(r => norm(r.player_name)).filter(n => !fatigued.has(n)));
}

(function main() {
  const teams = db.prepare("SELECT DISTINCT team t FROM team_rosters WHERE role='RP' ORDER BY t").all().map(r => r.t);
  console.log('=== DIFF 1: in_pool MEMBERSHIP, per team ===');
  console.log('  date ' + DATE);
  console.log('  "old" = role RP, not starter, not fatigued (candidacy).');
  console.log('  "new" = the pool the model actually averages.');
  console.log('');
  console.log('  team   old   new   delta   dropped (were shown in-pool, are not)');
  const rowsM = [];
  for (const t of teams) {
    const res = q.getBullpenWobaBlended(t, '', [], S.bpSR, S.bpWR, S.bpSL, S.bpWL, S.wProj, S.wAct,
      DATE, S.unk, S.minBF, S.dws, S.bpWP, S.bpWA, 1, mk(t));
    if (!res || !res.members) continue;
    const oldSet = oldInPool(t);
    const newSet = new Set(res.members.filter(m => m.in_pool).map(m => m.name));
    const dropped = [...oldSet].filter(n => !newSet.has(n));
    const added = [...newSet].filter(n => !oldSet.has(n));
    rowsM.push({ t, old: oldSet.size, neu: newSet.size, dropped, added });
  }
  rowsM.sort((a, b) => (b.dropped.length + b.added.length) - (a.dropped.length + a.added.length));
  for (const r of rowsM) {
    const d = r.neu - r.old;
    const big = (r.dropped.length + r.added.length) >= 3;
    console.log('  ' + r.t.padEnd(6) + String(r.old).padStart(4) + String(r.neu).padStart(6)
      + String((d >= 0 ? '+' : '') + d).padStart(8) + '   '
      + (r.dropped.length ? r.dropped.slice(0, 3).join(', ') + (r.dropped.length > 3 ? ' +' + (r.dropped.length - 3) : '') : '-')
      + (r.added.length ? '   ADDED: ' + r.added.join(', ') : '')
      + (big ? '   <-- LARGE' : ''));
  }
  const totalDrop = rowsM.reduce((s, r) => s + r.dropped.length, 0);
  const totalAdd = rowsM.reduce((s, r) => s + r.added.length, 0);
  const bigTeams = rowsM.filter(r => (r.dropped.length + r.added.length) >= 3);
  console.log('');
  console.log('  totals: ' + totalDrop + ' dropped, ' + totalAdd + ' added across ' + rowsM.length + ' teams');
  console.log('  teams with a LARGE change (>=3 rows): ' + bigTeams.length
    + (bigTeams.length ? ' — ' + bigTeams.map(r => r.t).join(', ') : ''));
  console.log('');
  console.log('  NOTE: a dropped row does NOT disappear from the table. It is still');
  console.log('  listed, with in_pool=false, which is the honest state it always had.');

  // ---- DIFF 2: team wOBA ------------------------------------------------
  console.log('');
  console.log('=== DIFF 2: displayed TEAM wOBA, report -> model ===');
  console.log('  the report recomputed this without neutralization, without the');
  console.log('  downweight-starters weighting, and without the pool-selection rule.');
  console.log('');
  console.log('  team    report(old)   model(new)    delta');
  const rowsW = [];
  for (const t of teams) {
    // OLD: unneutralized, no downweight, simple mean of candidates.
    const oldRes = q.getBullpenWobaBlended(t, '', [], S.bpSR, S.bpWR, S.bpSL, S.bpWL, S.wProj, S.wAct,
      DATE, S.unk, S.minBF, false, S.bpWP, S.bpWA, 1, null);
    const newRes = q.getBullpenWobaBlended(t, '', [], S.bpSR, S.bpWR, S.bpSL, S.bpWL, S.wProj, S.wAct,
      DATE, S.unk, S.minBF, S.dws, S.bpWP, S.bpWA, 1, mk(t));
    if (!oldRes || !newRes || oldRes.woba == null || newRes.woba == null) continue;
    rowsW.push({ t, o: oldRes.woba, n: newRes.woba, d: newRes.woba - oldRes.woba });
  }
  rowsW.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const r of rowsW) {
    console.log('  ' + r.t.padEnd(7) + r.o.toFixed(4).padStart(10) + r.n.toFixed(4).padStart(13)
      + ((r.d >= 0 ? '+' : '') + r.d.toFixed(4)).padStart(10));
  }
  const md = rowsW.reduce((s, r) => s + Math.abs(r.d), 0) / rowsW.length;
  console.log('');
  console.log('  mean |delta| ' + md.toFixed(4)
    + '   max ' + Math.max.apply(null, rowsW.map(r => Math.abs(r.d))).toFixed(4));
})();
