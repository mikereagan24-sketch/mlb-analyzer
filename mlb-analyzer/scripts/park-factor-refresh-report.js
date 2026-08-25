#!/usr/bin/env node
/**
 * PARK_FACTORS: what a fresh FanGraphs pull would change. (2026-08-25)
 *
 * Reports BEFORE anything is applied, per the ticket
 * (docs/park-factors-stale-open-question-2026-08-24.md).
 *
 * SOURCE, recorded here because the code it replaces recorded none:
 *   https://www.fangraphs.com/guts.aspx?type=pf&season=2026
 *   columns: Season | Team | Basic (5yr) | 3yr | 1yr | 1B | 2B | 3B | HR |
 *            SO | BB | GB | FB | LD | IFFB | FIP
 *   The Basic/3yr/1yr columns ARE the runs factors (the component columns
 *   are event-specific), so "FanGraphs 3-year R factor" = the `3yr` column.
 *   Pulled 2026-08-25. Values read twice, independently, and agreed.
 *
 * WHAT THIS IS NOT. The number at the bottom is NOT "the error we were
 * making". Nothing here has been checked against 2026 outcomes. It is the
 * distance between production's values and the source production claims to
 * use — a sensitivity, on the same footing as the 0.359-run figure in the
 * ticket, which was also a sensitivity and not an error estimate.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const Database = require(path.join(R, 'node_modules/better-sqlite3'));
const db = new Database(path.join(R, 'data/mlb.db'), { readonly: true });

// Production today — services/scraper.js PARK_FACTORS, last touched 4a2cff2 (2026-04-19).
const PROD = {
  COL:1.25, ARI:1.10, CIN:1.10, CHC:1.08, NYY:1.07, BOS:1.06,
  PHI:1.05, ATL:1.04, CWS:1.03, TEX:1.03, WAS:1.02, TOR:1.02,
  KC:1.02,  MIA:1.01, LAD:1.00, HOU:1.00, STL:0.99, DET:0.98,
  TB:0.95,  MIN:0.97, PIT:0.97, LAA:0.97, MIL:0.96, BAL:0.96,
  CLE:0.95, SEA:0.95, NYM:0.94, SD:0.94,  SF:0.92,  ATH:1.19,
};

// FanGraphs 2026, `3yr` column, as printed (100 = neutral).
const FG_3YR = {
  LAA:98, BAL:99, BOS:101, CWS:98, CLE:103, DET:101, KC:102, MIN:101,
  NYY:100, ATH:112, SEA:91, TB:101, TEX:93, TOR:101, ARI:102, ATL:100,
  CHC:94, CIN:102, COL:111, MIA:100, HOU:100, LAD:99, MIL:98, WAS:102,
  NYM:99, PHI:105, PIT:104, STL:96, SD:97, SF:98,
};

// The four documented manual adjustments, each re-examined 2026-08-25
// rather than carried forward silently. `keep` false means the straight
// FanGraphs value is used.
const ADJUSTMENTS = {
  ATH: { keep: true, value: 1.19,
    why: 'KEEP. FG 3yr is 112 and still averages in Oakland Coliseum years; '
       + 'FG 1yr is 121, which is Sutter Health Park on its own. 1.19 sits '
       + 'between the two and the original reasoning is confirmed by FG\'s own '
       + 'split. 49 of 64 ATH home games are at venue 2529 (Sutter Health).' },
  TB: { keep: true, value: 0.95,
    why: 'KEEP, premise now realised but with a NEW uncertainty. The club HAS '
       + 'returned to Tropicana (56 home games at venue 12 this season), so the '
       + 'forward-looking part of the note came true. FG 3yr (101) now averages '
       + 'in the 2025 Steinbrenner season, so it is contaminated for two more '
       + 'years and the adjustment is MORE needed, not less. UNRESOLVED: the '
       + 'park was rebuilt after Hurricane Milton (new roof, new turf), so the '
       + '"pre-2025 Tropicana trend" may not describe the park that reopened.' },
  KC: { keep: false, value: null,
    why: 'DROP THE ADJUSTMENT. It existed because FG had not yet absorbed the '
       + '2024 fence move-in. FG 2026 3yr is now 102 = 1.02, exactly the '
       + 'adjusted value. The bump has become a no-op; the number does not '
       + 'change, but it stops being a manual override.' },
};

const f2 = v => (v >= 0 ? '+' : '') + v.toFixed(2);
const f3 = v => (v >= 0 ? '+' : '') + v.toFixed(3);

(function main() {
  console.log('=== PARK_FACTORS: production vs a fresh FanGraphs 3yr pull ===');
  console.log('  source : https://www.fangraphs.com/guts.aspx?type=pf&season=2026  (column `3yr`)');
  console.log('  pulled : 2026-08-25');
  console.log('  prod   : services/scraper.js PARK_FACTORS, last touched 2026-04-19 (4a2cff2)');
  console.log('');

  console.log('=== the four manual adjustments, re-examined ===');
  for (const k of Object.keys(ADJUSTMENTS)) {
    const a = ADJUSTMENTS[k];
    console.log('  ' + k + '  ' + (a.keep ? 'KEEP ' + a.value : 'DROP (use FG ' + (FG_3YR[k] / 100).toFixed(2) + ')'));
    console.log('      ' + a.why.replace(/(.{92})/g, '$1\n      '));
  }
  const mex = db.prepare('SELECT COUNT(*) n, MIN(game_date) f, MAX(game_date) l FROM game_log WHERE venue_id=5340').get();
  console.log('  MEXICO CITY override (model.js:48, venue 5340, parkFactor 1.20)');
  console.log('      KEEP, but it is nearly inert: ' + mex.n + ' game(s) this season ('
    + mex.f + '..' + mex.l + '). It bypasses this table entirely, so a refresh');
  console.log('      does not touch it. Left alone.');
  console.log('');

  // ---- the new table
  const NEW = {};
  for (const k of Object.keys(PROD)) {
    const a = ADJUSTMENTS[k];
    NEW[k] = (a && a.keep) ? a.value : Math.round(FG_3YR[k]) / 100;
  }

  console.log('=== per-team delta, and what it does to that park\'s totals ===');
  console.log('  team   prod    new    ratio    home games   mean total   d(total) runs   source');
  const rows = [];
  for (const k of Object.keys(PROD).sort()) {
    const g = db.prepare(
      'SELECT COUNT(*) n, AVG(model_total) avg FROM game_log '
      + 'WHERE UPPER(home_team)=? AND model_total IS NOT NULL').get(k);
    const ratio = NEW[k] / PROD[k];
    const d = (g && g.avg != null) ? g.avg * (ratio - 1) : 0;
    const src = (ADJUSTMENTS[k] && ADJUSTMENTS[k].keep) ? 'manual (kept)' : 'FG 3yr';
    rows.push({ k, n: g.n || 0, d, ratio });
    console.log('  ' + k.padEnd(6) + PROD[k].toFixed(2) + '   ' + NEW[k].toFixed(2)
      + '   ' + ratio.toFixed(4) + '   ' + String(g.n || 0).padStart(6)
      + '       ' + (g.avg != null ? g.avg.toFixed(2) : ' n/a ')
      + '        ' + f3(d).padStart(7) + '     ' + src);
  }

  const changed = rows.filter(r => Math.abs(r.ratio - 1) > 1e-9);
  const affected = changed.reduce((s, r) => s + r.n, 0);
  const totalGames = db.prepare('SELECT COUNT(*) c FROM game_log WHERE model_total IS NOT NULL').get().c;
  const wmean = affected ? changed.reduce((s, r) => s + Math.abs(r.d) * r.n, 0) / affected : 0;
  changed.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

  console.log('');
  console.log('=== summary ===');
  console.log('  teams whose factor changes            : ' + changed.length + ' of 30');
  console.log('  home games affected                   : ' + affected + ' of ' + totalGames
    + '  (' + (100 * affected / totalGames).toFixed(1) + '%)');
  console.log('  game-weighted mean |d(total)| on those: ' + wmean.toFixed(3) + ' runs');
  console.log('  largest movers                        : '
    + changed.slice(0, 5).map(r => r.k + ' ' + f3(r.d)).join('   '));
  console.log('');
  console.log('  For comparison, the ticket measured 0.359 runs against the stranded');
  console.log('  April branch. BOTH numbers are SENSITIVITIES, not error estimates:');
  console.log('  neither set has been checked against 2026 outcomes.');
})();
