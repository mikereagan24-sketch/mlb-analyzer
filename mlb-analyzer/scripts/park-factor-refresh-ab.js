#!/usr/bin/env node
/**
 * What a fresh Savant pull would change, before applying it. (2026-09-18)
 *
 * Successor to scripts/park-factor-refresh-report.js, which answered the
 * same question for the FanGraphs table that the 2026-08-25 sourcing
 * decision rejected. The source is settled now -- Savant `index_runs`,
 * per services/park-factors.js -- so the open question is no longer
 * WHICH source but HOW OFTEN to re-pull it.
 *
 * TOTALS ONLY. A park factor multiplies both teams' run estimates by the
 * same number, so it moves the total and leaves the win-probability ratio
 * nearly untouched. The ML A/B is structurally blind here and will report
 * "not significant" however wrong the factors are. See CLAUDE.md,
 * "Park factors are evaluated on TOTALS, never on the ML target".
 *
 * WHAT IT DOES NOT DO: it does not write. The table refresh is a separate,
 * deliberate act (services/jobs.js runParkFactorsJob), and the point of
 * this script is to see the consequence first.
 *
 * Run: node scripts/park-factor-refresh-ab.js
 *      node scripts/park-factor-refresh-ab.js --from 2026-04-01 --to 2026-12-31
 */
const path = require('path');
const R = path.join(__dirname, '..');
const pf = require(path.join(R, 'services/park-factors'));
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const { runModel } = require(path.join(R, 'services/model'));
const { q } = require(path.join(R, 'db/schema'));
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FROM = argOf('--from', '2026-04-01');
const TO = argOf('--to', '2026-12-31');

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const rmse = a => (a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : null);
const f = (v, d) => v == null ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d == null ? 4 : d);

(async function main() {
  console.log('=== park factors: stored vs a fresh pull ===');
  console.log('  source: ' + pf.sourceUrl());
  console.log('');

  // ---- 1. the input delta ---------------------------------------------
  const stored = {};
  for (const r of q.listParkFactors.all()) stored[r.team] = r;
  const storedPulled = Object.values(stored).map(r => r.pulled_at).sort().pop();

  let fresh;
  try {
    fresh = (await pf.fetchSavantParkFactors()).rows;
  } catch (e) {
    console.log('  FETCH FAILED: ' + e.message);
    console.log('  (the stored table is unchanged; nothing was written)');
    process.exit(1);
  }
  const freshBy = {};
  for (const r of fresh) freshBy[r.team] = r;

  const ageDays = storedPulled
    ? ((Date.now() - Date.parse(String(storedPulled).replace(' ', 'T') + 'Z')) / 86400000) : null;
  console.log('  stored pull : ' + storedPulled + (ageDays != null ? '   (' + ageDays.toFixed(1) + ' days old)' : ''));
  console.log('  fresh rows  : ' + fresh.length + '   year_range ' + (fresh[0] && fresh[0].year_range));
  console.log('');

  const moved = [];
  for (const t of Object.keys(freshBy).sort()) {
    const s = stored[t];
    if (!s) { moved.push({ t, old: null, neu: freshBy[t].factor, d: null }); continue; }
    const d = Number((freshBy[t].factor - s.factor).toFixed(4));
    if (Math.abs(d) > 1e-9) moved.push({ t, old: s.factor, neu: freshBy[t].factor, d });
  }
  const manual = Object.keys(stored).filter(t => stored[t].source === 'manual');
  console.log('  teams whose factor MOVED: ' + moved.length + ' of ' + fresh.length);
  for (const m of moved) {
    console.log('    ' + m.t.padEnd(5) + String(m.old).padEnd(7) + '-> ' + String(m.neu).padEnd(7)
      + f(m.d, 4) + '   n_pa ' + (stored[m.t] ? stored[m.t].n_pa : '?') + ' -> ' + freshBy[m.t].n_pa);
  }
  const deltas = moved.filter(m => m.d != null).map(m => Math.abs(m.d));
  console.log('  max |delta| ' + (deltas.length ? Math.max(...deltas).toFixed(4) : '0')
    + '   mean |delta| over all ' + fresh.length + ' teams '
    + (fresh.length ? (deltas.reduce((s, x) => s + x, 0) / fresh.length).toFixed(4) : '0'));
  if (manual.length) {
    console.log('  manual rows, not in the feed and NOT refreshed: '
      + manual.map(t => t + ' ' + stored[t].factor).join(', '));
  }

  // Savant publishes whole index points, so the smallest representable
  // move is 0.01. Anything at exactly 0.02 is two ticks of resolution,
  // which is worth saying out loud before anyone reads it as a trend.
  const ticks = deltas.length ? Math.min(...deltas) : null;
  if (ticks != null) {
    console.log('  NOTE the feed publishes integer index points, so 0.01 is the '
      + 'resolution floor; the smallest move here is ' + ticks.toFixed(2) + '.');
  }

  if (!moved.length) {
    console.log('');
    console.log('Nothing moved. A refresh would be a no-op on the model.');
    process.exit(0);
  }

  // ---- 2. what it does to a price -------------------------------------
  // Re-score every game twice, changing ONLY the park factor the model
  // resolves for the home team. game.park_factor is persisted at scrape
  // time and takes precedence in the resolver, so the A/B overrides that
  // field directly -- which is also why a refresh reaches only FUTURE
  // games in production.
  console.log('');
  console.log('=== GAME-WEIGHTED: re-scored both ways, totals target ===');
  const settings = jobs.getSettings();
  const games = ps.loadGames(db, FROM, TO);
  const snap = new Map();
  const movedTeams = new Set(moved.map(m => m.t));

  const dAll = [], dMovedParks = [];
  const errOld = [], errNew = [];
  let scored = 0, atMoved = 0;
  const real = console.log; console.log = () => {};
  for (const g of games) {
    if (!snap.has(g.game_date)) snap.set(g.game_date, ps.loadWobaSnapshot(db, g.game_date));
    const idx = snap.get(g.game_date);
    if (!idx) continue;
    const pre = ps.preScreenGame(g, idx, settings);
    if (!pre) continue;
    const w = (hi.populateCallerInputs ? hi.populateCallerInputs(pre, g, settings) : pre) || pre;
    const home = String(g.home_team || '').toUpperCase();
    const oldPf = stored[home] ? stored[home].factor : null;
    const newPf = freshBy[home] ? freshBy[home].factor : null;
    if (oldPf == null || newPf == null) continue;

    let a, b;
    try {
      a = runModel(Object.assign({}, w, { park_factor: oldPf }), idx, settings, 'opener_aware', true);
      b = runModel(Object.assign({}, w, { park_factor: newPf }), idx, settings, 'opener_aware', true);
    } catch (e) { continue; }
    if (!a || !b || a._suppressed || b._suppressed) continue;
    if (a.estTot == null || b.estTot == null) continue;
    scored++;
    const d = b.estTot - a.estTot;
    dAll.push(d);
    if (movedTeams.has(home)) { atMoved++; dMovedParks.push(d); }

    // Accuracy against the actual total, for the games that have one.
    if (g.away_score != null && g.home_score != null) {
      const actual = Number(g.away_score) + Number(g.home_score);
      errOld.push(a.estTot - actual);
      errNew.push(b.estTot - actual);
    }
  }
  console.log = real;

  console.log('  games scored both ways     : ' + scored);
  console.log('  of those at a MOVED park   : ' + atMoved
    + (scored ? '  (' + (100 * atMoved / scored).toFixed(1) + '%)' : ''));
  console.log('');
  console.log('  d model_total, all games   : mean ' + f(mean(dAll)) + '  median ' + f(med(dAll))
    + '  max |d| ' + (dAll.length ? Math.max(...dAll.map(Math.abs)).toFixed(4) : 'n/a'));
  console.log('  d model_total, moved parks : mean ' + f(mean(dMovedParks)) + '  median ' + f(med(dMovedParks))
    + '  max |d| ' + (dMovedParks.length ? Math.max(...dMovedParks.map(Math.abs)).toFixed(4) : 'n/a'));
  console.log('');
  console.log('  Accuracy on graded games (n=' + errOld.length + '), the target that can see this:');
  const mae = a => mean(a.map(Math.abs));
  console.log('    arm        MAE      RMSE     level');
  console.log('    stored   ' + (mae(errOld) || 0).toFixed(4) + '   ' + (rmse(errOld) || 0).toFixed(4)
    + '   ' + f(mean(errOld)));
  console.log('    fresh    ' + (mae(errNew) || 0).toFixed(4) + '   ' + (rmse(errNew) || 0).toFixed(4)
    + '   ' + f(mean(errNew)));
  console.log('    delta    ' + f((mae(errNew) - mae(errOld))) + '  ' + f((rmse(errNew) - rmse(errOld)))
    + '  ' + f(mean(errNew) - mean(errOld)));
  console.log('');
  console.log('  A delta smaller than the corpus noise floor is not evidence the');
  console.log('  refresh helps or hurts -- it is evidence the question is below');
  console.log('  what this corpus can resolve. Read the input delta first.');
})();
