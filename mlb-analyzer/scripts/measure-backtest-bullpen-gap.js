#!/usr/bin/env node
/**
 * How wrong is the bullpen term in a backtest? (2026-09-03)
 *
 * MEASURE BEFORE CHANGING. The four backtest harnesses replay historical
 * games by recomputing the bullpen wOBA live, while game_log carries the
 * value that actually fed runModel at emit time. If the difference is
 * negligible, that is worth knowing too.
 *
 * There are TWO defects stacked here, and this separates them:
 *
 *   DATE   getBullpenWobaBlended reads woba_data, which is wiped and
 *          reloaded daily. Replaying a June game today prices its bullpen
 *          off today's projections. The batter and SP terms ARE date-
 *          corrected via getWobaIndexAsOf against woba_data_snapshot; the
 *          bullpen term is the one input that silently is not.
 *
 *   ARITY  the harnesses pass 10 of the function's 17 parameters:
 *            minBF            -> defaults 100, production uses 50
 *            downweightStarters -> undefined, production true
 *            bullpenWProj/WAct  -> fall back to the GLOBAL 0.45/0.55,
 *                                  production uses 0.25/0.75
 *            gameNumber       -> undefined, so the DH nightcap rule is inert
 *            neutralizeFn     -> undefined, so NO park neutralisation
 *
 * The persisted column is the ground truth for both: it is what the model
 * used. Everything reported here is delta against it.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { q, db } = require(path.join(R, 'db/schema'));
const { getSettings } = require(path.join(R, 'services/jobs'));

const s = getSettings();
const N = (v, d) => (v != null ? Number(v) : d);
const num = a => a.filter(x => x != null && isFinite(x));
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-29';

const games = db.prepare(
  'SELECT game_date, game_id, away_team, home_team, away_sp, home_sp, '
  + 'away_lineup_json, home_lineup_json, '
  + 'away_bullpen_woba, home_bullpen_woba '
  + 'FROM game_log WHERE game_date BETWEEN ? AND ? '
  + 'AND away_bullpen_woba IS NOT NULL ORDER BY game_date').all(FROM, TO);

// exactly the harnesses' call: 10 of 17 args
const bt = (team, sp, lu, date) => q.getBullpenWobaBlended(
  team, sp || '', lu || [],
  N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
  N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
  N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), date);

// production's call minus the neutralizer (which needs model.js wiring);
// isolates the ARITY half from the DATE half.
const prodish = (team, sp, lu, date) => q.getBullpenWobaBlended(
  team, sp || '', lu || [],
  N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
  N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
  N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), date,
  N(s.UNKNOWN_PITCHER_WOBA, 0.335),
  N(s.BULLPEN_MIN_BF, N(s.MIN_BF, 100)),
  !!(s.BULLPEN_DOWNWEIGHT_STARTERS === true || s.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
  N(s.BULLPEN_W_PROJ, N(s.W_PROJ, 0.65)), N(s.BULLPEN_W_ACT, N(s.W_ACT, 0.35)), 1);

const parse = j => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };

const dBt = [], dArity = [], dOptB = [], rows = [];
for (const g of games) {
  for (const side of ['away', 'home']) {
    const team = side === 'away' ? g.away_team : g.home_team;
    const sp = side === 'away' ? g.away_sp : g.home_sp;
    const lu = parse(side === 'away' ? g.home_lineup_json : g.away_lineup_json);
    const truth = side === 'away' ? g.away_bullpen_woba : g.home_bullpen_woba;
    if (truth == null) continue;
    let a = null, b = null;
    try { a = bt(team, sp, lu, g.game_date); } catch (e) {}
    try { b = prodish(team, sp, lu, g.game_date); } catch (e) {}
    if (a && a.woba != null) { dBt.push(a.woba - truth); rows.push({ g, side, truth, bt: a.woba }); }
    if (a && b && a.woba != null && b.woba != null) dArity.push(b.woba - a.woba);
    // What each candidate fix leaves on the table:
    //   OPTION A read the persisted column  -> exact by construction
    //   OPTION B pass all 17 args, still recompute -> date error remains
    if (b && b.woba != null) dOptB.push(b.woba - truth);
  }
}

console.log('=== BACKTEST BULLPEN TERM vs THE VALUE THE MODEL ACTUALLY USED ===');
console.log('  window ' + FROM + ' .. ' + TO + '   games ' + games.length
  + '   sides compared ' + dBt.length);
console.log('');
if (!dBt.length) { console.log('  nothing comparable'); process.exit(0); }

const abs = dBt.map(Math.abs);
console.log('  delta = backtest recomputation MINUS persisted truth, in wOBA');
console.log('    signed mean : ' + (mean(dBt) >= 0 ? '+' : '') + mean(dBt).toFixed(4)
  + '     <- level shift');
console.log('    mean |d|    : ' + mean(abs).toFixed(4));
console.log('    median |d|  : ' + pct(abs, 0.5).toFixed(4));
console.log('    p90 |d|     : ' + pct(abs, 0.9).toFixed(4));
console.log('    max |d|     : ' + Math.max(...abs).toFixed(4));
console.log('    sides differing by >0.005 : '
  + abs.filter(x => x > 0.005).length + ' / ' + abs.length
  + '  (' + (100 * abs.filter(x => x > 0.005).length / abs.length).toFixed(1) + '%)');
console.log('    sides differing at all    : '
  + abs.filter(x => x > 1e-9).length + ' / ' + abs.length);
console.log('');
if (dArity.length) {
  const aa = dArity.map(Math.abs);
  console.log('  OF WHICH, the ARITY half alone (same date, 17 args vs 10):');
  console.log('    signed mean ' + (mean(dArity) >= 0 ? '+' : '') + mean(dArity).toFixed(4)
    + '   mean |d| ' + mean(aa).toFixed(4) + '   max ' + Math.max(...aa).toFixed(4));
  console.log('    -> the remainder of the total is the DATE half (today\'s woba_data');
  console.log('       standing in for the game\'s own).');
  console.log('');
}
if (dOptB.length) {
  const ob = dOptB.map(Math.abs);
  console.log('  WHAT EACH CANDIDATE FIX BUYS:');
  console.log('    do nothing (today)      signed ' + (mean(dBt) >= 0 ? '+' : '') + mean(dBt).toFixed(4)
    + '   mean |d| ' + mean(abs).toFixed(4) + '   max ' + Math.max(...abs).toFixed(4));
  console.log('    OPTION B: all 17 args   signed ' + (mean(dOptB) >= 0 ? '+' : '') + mean(dOptB).toFixed(4)
    + '   mean |d| ' + mean(ob).toFixed(4) + '   max ' + Math.max(...ob).toFixed(4));
  console.log('    OPTION A: read column   signed +0.0000   mean |d| 0.0000   max 0.0000  (exact)');
  console.log('');
  console.log('    NOTE the two defects partially CANCEL: arity is signed '
    + mean(dArity).toFixed(4) + ' and the total is ' + mean(dBt).toFixed(4) + ', so fixing');
  console.log('    ARITY ALONE moves the level from +' + mean(dBt).toFixed(4) + ' to ' + mean(dOptB).toFixed(4)
    + ' but leaves a mean |d| of ' + mean(ob).toFixed(4) + '.');
  console.log('');
}
console.log('  RELIEF_PIT_WEIGHT scales this into the run total. At ~0.29, a');
console.log('  bullpen wOBA error of ' + mean(abs).toFixed(4) + ' is roughly '
  + (mean(abs) * 0.29).toFixed(5) + ' of a wOBA point on the');
console.log('  pitching side of the blend -- small per game, systematic across all.');
console.log('');
const worst = rows.map(r => ({ ...r, d: Math.abs(r.bt - r.truth) })).sort((a, b) => b.d - a.d).slice(0, 8);
console.log('  worst 8 sides:');
console.log('    date        game        side   truth    backtest   delta');
for (const w of worst)
  console.log('    ' + w.g.game_date + '  ' + String(w.g.game_id).padEnd(11)
    + w.side.padEnd(7) + w.truth.toFixed(4) + '   ' + w.bt.toFixed(4)
    + '   ' + ((w.bt - w.truth) >= 0 ? '+' : '') + (w.bt - w.truth).toFixed(4));
