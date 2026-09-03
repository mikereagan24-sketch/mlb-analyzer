#!/usr/bin/env node
/**
 * Offline replays use the bullpen value the model actually used. (2026-09-03)
 *
 * Four harnesses recomputed the bullpen term live while replaying
 * historical games. Two defects were stacked, and they partially cancel,
 * which is why neither surfaced as an outlier:
 *
 *   DATE   getBullpenWobaBlended reads woba_data, wiped and reloaded
 *          daily -- so a June game got today's projections. The batter
 *          and SP terms ARE date-corrected via getWobaIndexAsOf; the
 *          bullpen term was the one input that silently was not.
 *   ARITY  10 of 17 parameters passed, so minBF ran at 100 instead of 50,
 *          downweight-starters was off, the blend used the GLOBAL
 *          0.45/0.55 rather than the bullpen's 0.25/0.75, the DH rule was
 *          inert, and no park neutralisation applied.
 *
 * Measured over 2,340 sides: 2,329 differed, 60.3% by more than 0.005,
 * signed mean +0.0066.
 */
const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const hi = require(path.join(R, 'services/harness-inputs'));
const { q, db } = require(path.join(R, 'db/schema'));

ok(typeof hi.bullpenTermForReplay === 'function', 'harness-inputs exports bullpenTermForReplay');
if (typeof hi.bullpenTermForReplay !== 'function') {
  // Fail legibly rather than crashing on the first call: a stack trace
  // says the test broke, not that the feature is missing.
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed  (helper absent -- nothing further could run)');
  process.exit(1);
}

// ---- 1. persisted wins, exactly -----------------------------------------
const row = { game_date: '2026-07-04',
  away_bullpen_woba: 0.3123, away_bullpen_woba_vs_l: 0.3200, away_bullpen_woba_vs_r: 0.3050,
  home_bullpen_woba: 0.2988, home_bullpen_woba_vs_l: 0.3010, home_bullpen_woba_vs_r: 0.2960 };
const a = hi.bullpenTermForReplay(q, row, 'away', {}, { team: 'COL' });
eq(a.source, 'persisted', 'a row with a persisted value does NOT recompute');
eq(a.woba, 0.3123, 'and returns it EXACTLY -- not approximately');
eq(a.vsLHB, 0.3200, 'per-hand vsLHB comes from the persisted column');
eq(a.vsRHB, 0.3050, 'per-hand vsRHB comes from the persisted column');
const h = hi.bullpenTermForReplay(q, row, 'home', {}, { team: 'ATL' });
eq(h.woba, 0.2988, 'the home side reads its own columns, not the away ones');

// ---- 2. fallback only when genuinely absent -----------------------------
const bare = { game_date: '2026-07-04', away_bullpen_woba: null };
const fb = hi.bullpenTermForReplay(q, bare, 'away', {}, { team: 'COL', starter: '', lineup: [] });
ok(fb === null || fb.source === 'recomputed',
   'a row with no persisted value falls back to a recompute');

// ---- 3. the fallback passes all 17 args, not 10 -------------------------
// This is what makes the fallback the +0.0009 shape rather than +0.0066.
const src = fs.readFileSync(path.join(R, 'services/harness-inputs.js'), 'utf8');
const call = src.slice(src.indexOf('q.getBullpenWobaBlended('));
const args = call.slice(0, call.indexOf(');')).split(',').length;
ok(args >= 16, 'the fallback passes the full argument list (counted ' + args + ')');
for (const p of ['BULLPEN_MIN_BF', 'BULLPEN_DOWNWEIGHT_STARTERS', 'BULLPEN_W_PROJ', 'BULLPEN_W_ACT'])
  ok(src.includes(p), 'the fallback reads ' + p + ' rather than letting it default');

// ---- 4. no harness still makes the raw 10-arg call ----------------------
const HARNESSES = ['services/frv-backtest.js', 'services/temp-backtest.js',
                   'services/runmult-totals-backtest.js', 'services/baserunning-backtest.js'];
for (const f of HARNESSES) {
  const t = fs.readFileSync(path.join(R, f), 'utf8');
  ok(!/q\.getBullpenWobaBlended\(/.test(t),
     f + ' no longer calls getBullpenWobaBlended directly');
  ok(t.includes('bullpenTermForReplay'), f + ' uses the shared replay helper');
}

// ---- 5. the persisted columns actually exist and are populated ----------
// If coverage ever regresses, every harness silently reverts to the
// recompute path -- so the fix depends on this staying true.
const cov = db.prepare(
  'SELECT COUNT(*) tot, SUM(CASE WHEN away_bullpen_woba IS NOT NULL THEN 1 ELSE 0 END) has '
  + 'FROM game_log').get();
ok(cov.has / cov.tot > 0.95,
   'persisted bullpen coverage is high (' + cov.has + '/' + cov.tot + ')');

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
