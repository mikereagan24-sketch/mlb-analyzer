#!/usr/bin/env node
/**
 * Before/after for extending park-neutralization to the bullpen pool.
 * (2026-08-31)
 *
 * Same shape as scripts/woba-park-source-ab.js: per-team input delta, then
 * the game-weighted impact, then the LEVEL SHIFT, which is the number that
 * decides whether this is safe to ship.
 *
 * THE A/B MUST SUPPLY THE BULLPEN VALUES ITSELF. harness-inputs.js does not
 * compute them -- the model reads game.awayBullpenWoba, which services/
 * jobs.js sets on the live path. A harness game has no such property (the
 * game_log column is snake_case) so runModel would fall back to
 * BULLPEN_AVG for BOTH arms and the A/B would report no change, which
 * reads as "safe to ship". That is the same instrument-not-wired-to-the-
 * thing failure as the model-trace leg and the destructured export in the
 * wOBA source A/B; the moved-game count below is what proves it is wired.
 *
 * Totals-focused for the reason the park-factor work established: a park
 * term scales both sides, so it moves the run estimate far more than the
 * win-probability ratio. Both are reported.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const mdl = require(path.join(R, 'services/model'));
const pfw = require(path.join(R, 'services/park-factors-woba'));
const { q } = require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const f = (v, d) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 4 : d);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
function sd(a) { if (a.length < 2) return null; const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

(function main() {
  const settings = jobs.getSettings();
  if (!settings.PARK_NEUTRAL_INPUTS_ENABLED) {
    console.log('PARK_NEUTRAL_INPUTS_ENABLED is off — extending it to the bullpen is a no-op.');
    return;
  }
  const mk = team => (name, raw) => {
    try {
      const fac = mdl.resolveNeutralizationFactor(team, settings, { playerName: name, isPitcher: true });
      return fac == null ? null : pfw.neutralizeWoba(raw, fac);
    } catch (e) { return null; }
  };
  const BP = (team, sp, lu, leg, neut) => q.getBullpenWobaBlended(
    team, sp || '', lu || [],
    settings.BP_STRONG_WEIGHT_R ?? 0.55, settings.BP_WEAK_WEIGHT_R ?? 0.45,
    settings.BP_STRONG_WEIGHT_L ?? 0.35, settings.BP_WEAK_WEIGHT_L ?? 0.65,
    settings.W_PROJ ?? 0.65, settings.W_ACT ?? 0.35,
    null, settings.UNKNOWN_PITCHER_WOBA ?? 0.335, settings.MIN_BF ?? 100,
    true, settings.BULLPEN_W_PROJ ?? 0.25, settings.BULLPEN_W_ACT ?? 0.75,
    leg, neut);

  // ---- per-team input delta -------------------------------------------
  console.log('=== PER-TEAM: bullpen pool wOBA, raw vs neutralized ===');
  console.log('  higher wOBA-against = worse bullpen. A hitter park (pf>1) should');
  console.log('  IMPROVE once its inflation is divided out; a pitcher park worsens.');
  console.log('');
  console.log('  team   parkF     raw    neutral    d(wOBA)');
  const teams = db.prepare("SELECT DISTINCT team t FROM team_rosters WHERE role='RP' ORDER BY t").all().map(r => r.t);
  const rows = [];
  for (const t of teams) {
    const off = BP(t, '', [], 1, null), on = BP(t, '', [], 1, mk(t));
    if (!off || !on || off.woba == null || on.woba == null) continue;
    rows.push({ t, pf: pfw.getWobaParkFactor(t), raw: off.woba, neu: on.woba, d: on.woba - off.woba });
  }
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  for (const r of rows) {
    console.log('  ' + r.t.padEnd(6) + String(r.pf).padEnd(8) + r.raw.toFixed(4).padStart(8)
      + r.neu.toFixed(4).padStart(10) + f(r.d).padStart(11));
  }
  console.log('');
  console.log('  mean |d| = ' + f(mean(rows.map(r => Math.abs(r.d))))
    + '   max |d| = ' + f(Math.max.apply(null, rows.map(r => Math.abs(r.d)))));
  // DIRECTION CHECK, against the POOL-EFFECTIVE factor, not the home park.
  //
  // The first version compared against the home park and flagged LAA and
  // WAS as moving the wrong way. They were not: resolveNeutralizationFactor
  // applies PA/TBF stint weighting, so a reliever traded in from a hitter
  // park carries HIS factor, not his current club's. LAA (home 0.99) has 2
  // such arms above 1.0; WAS (home 1.03) has 3 below. The pool moves with
  // its members' weighted factors, which is the feature working.
  //
  // A check that flags correct behaviour as a defect is worse than no
  // check -- it invites someone to 'fix' the stint weighting away.
  const effFactor = t => {
    const rps = db.prepare("SELECT player_name FROM team_rosters WHERE team=? AND role='RP'").all(t);
    const fs2 = rps.map(r => { try { return mdl.resolveNeutralizationFactor(
      t, settings, { playerName: r.player_name, isPitcher: true }); } catch (e) { return null; } })
      .filter(x => x != null && isFinite(x));
    return fs2.length ? mean(fs2) : pfw.getWobaParkFactor(t);
  };
  const wrongWay = rows.filter(r => {
    const ef = effFactor(r.t);
    if (Math.abs(ef - 1) < 0.002) return false;   // neutral pool, sign is noise
    return (ef > 1 && r.d > 0) || (ef < 1 && r.d < 0);
  });

  // ---- game-weighted ---------------------------------------------------
  console.log('');
  console.log('=== GAME-WEIGHTED: re-scored both ways ===');
  const games = ps.loadGames(db, '2026-04-01', '2026-12-31');
  const snap = new Map();
  const dTot = [], dHome = [], dLL = [];
  let scored = 0, moved = 0;
  const EPS = 1e-9, clamp = p => Math.min(1 - EPS, Math.max(EPS, p));
  const real = console.log; console.log = () => {};
  for (const g of games) {
    if (!snap.has(g.game_date)) snap.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = snap.get(g.game_date); if (!idx) continue;
    const pre = ps.preScreenGame(g, idx, settings); if (!pre) continue;
    const base = hi.populateCallerInputs ? hi.populateCallerInputs(pre, g, settings) : pre;
    if (!base) continue;
    const aLU = base.awayLineup || [], hLU = base.homeLineup || [];
    const leg = require(path.join(R, 'utils/dh-leg')).legOf(g.game_id);
    // The bullpen a team's OPPONENT faces: away pen faces home batters.
    const aOff = BP(g.away_team, g.away_sp, hLU, leg, null);
    const hOff = BP(g.home_team, g.home_sp, aLU, leg, null);
    const aOn  = BP(g.away_team, g.away_sp, hLU, leg, mk(g.away_team));
    const hOn  = BP(g.home_team, g.home_sp, aLU, leg, mk(g.home_team));
    if (!aOff || !hOff || !aOn || !hOn) continue;
    const withBp = (bpA, bpH) => Object.assign({}, base, {
      awayBullpenWoba: bpA.woba, homeBullpenWoba: bpH.woba,
      awayBullpenVsL: bpA.vsLHB, awayBullpenVsR: bpA.vsRHB,
      homeBullpenVsL: bpH.vsLHB, homeBullpenVsR: bpH.vsRHB,
    });
    let a, b;
    try {
      a = mdl.runModel(withBp(aOff, hOff), idx, settings, 'opener_aware', true);
      b = mdl.runModel(withBp(aOn,  hOn ), idx, settings, 'opener_aware', true);
    } catch (e) { continue; }
    if (!a || !b || a._suppressed || b._suppressed) continue;
    if (a.estTot == null || b.estTot == null) continue;
    scored++;
    const dt = b.estTot - a.estTot;
    if (Math.abs(dt) > 1e-9) moved++;
    dTot.push(dt);
    if (a.adjHW != null && b.adjHW != null) {
      dHome.push(b.adjHW - a.adjHW);
      if (g.home_score != null && g.away_score != null && g.home_score !== g.away_score) {
        const y = g.home_score > g.away_score ? 1 : 0;
        const ll = p => -(y * Math.log(clamp(p)) + (1 - y) * Math.log(1 - clamp(p)));
        dLL.push(ll(b.adjHW) - ll(a.adjHW));
      }
    }
  }
  console.log = real;

  const abs = dTot.map(Math.abs).sort((x, y) => x - y);
  console.log('  games scored both ways : ' + scored);
  console.log('  games whose total MOVED: ' + moved
    + (scored ? '  (' + (100 * moved / scored).toFixed(1) + '%)' : '')
    + (moved === 0 ? '   *** ZERO — the A/B is not wired to the model ***' : ''));
  console.log('');
  console.log('  d(model total), neutralized - raw, in RUNS:');
  console.log('    LEVEL (signed mean) ' + f(mean(dTot), 4) + '   median ' + f(med(dTot), 4));
  console.log('    mean |d| ' + f(mean(abs), 4) + '   p90 ' + f(abs[Math.floor(0.9 * abs.length)], 4)
    + '   max ' + f(abs[abs.length - 1], 4));
  console.log('');
  console.log('  d(p home win): mean |d| ' + f(mean(dHome.map(Math.abs)), 5)
    + '   max ' + f(Math.max.apply(null, dHome.map(Math.abs)), 5));

  if (dLL.length > 2) {
    const s = sd(dLL), n = dLL.length;
    const half = 1.959964 * s / Math.sqrt(n);
    console.log('');
    console.log('  PAIRED d log loss over ' + n + ' decided games:');
    console.log('    mean ' + f(mean(dLL), 6) + '   95% CI +/-' + half.toFixed(6));
    console.log('    ' + (Math.abs(mean(dLL)) > half
      ? 'interval EXCLUDES zero'
      : 'interval spans zero — descriptive only, as pre-registered for park-neutral'));
  }
  console.log('');
  console.log('  THE LEVEL SHIFT IS THE SHIP/NO-SHIP NUMBER. The model already carries');
  console.log('  a negative total bias (-0.5752 in the run-factor work), so a change');
  console.log('  that pushes every total one way compounds it. Moving individual games');
  console.log('  without moving the level is the safe shape.');
})();
