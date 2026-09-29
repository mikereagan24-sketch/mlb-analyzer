#!/usr/bin/env node
'use strict';
// Run the trends backtest under docs/trends-preregistration-2026-09-29.md and
// print EVERY scenario -- weak ones included -- in-sample, September holdout
// and all, with the multiple-comparisons note. Display only.
//
//   <node> --max-old-space-size=1536 scripts/run-trends-backtest.js            read-only, prints
//   <node> --max-old-space-size=1536 scripts/run-trends-backtest.js --write    also records the run
//                                                                             (trend_runs / trend_results)
//   --json FILE   also writes the full result object

const path = require('path');
const fs = require('fs');
const R = path.join(__dirname, '..');
const tb = require(path.join(R, 'services/trends-backtest'));

const WRITE = process.argv.includes('--write');
const jsonAt = process.argv.indexOf('--json');
const JSON_OUT = jsonAt !== -1 ? process.argv[jsonAt + 1] : null;
let db;
if (WRITE) db = require(path.join(R, 'db/schema')).db;
else {
  const Database = require(path.join(R, 'node_modules/better-sqlite3'));
  db = new Database(process.env.MLB_DB_PATH || path.join(R, 'data/mlb.db'), { readonly: true });
}

const run = tb.runTrendsBacktest(db, { root: R });
const pct = (v, d = 1) => (v == null ? '   -  ' : (100 * v).toFixed(d).padStart(5) + '%');
const sgn = (v, d = 1) => (v == null ? '   -  ' : ((v >= 0 ? '+' : '') + (100 * v).toFixed(d)).padStart(6));
const p3 = (v) => (v == null ? '   -  ' : v < 0.001 ? '<0.001' : v.toFixed(3));
const get = (id, variant, split) => run.results.find(r => r.scenario === id && r.variant === variant && r.split === split);

console.log('TRENDS BACKTEST   pre-registration ' + run.prereg.path + ' @ ' + run.prereg.commit.slice(0, 7)
  + '   content sha256 ' + run.prereg.sha256.slice(0, 12)
  + (run.prereg.matchesCommitted ? '  (matches the committed pre-registration)'
     : '  *** DOES NOT MATCH the committed pre-registration -- this is not a run under #478 ***'));
console.log('population ' + run.population.games + ' games / ' + run.population.teamRows + ' team-rows / '
  + run.population.totalRows + ' totals games   window ' + run.window.from + '..' + run.window.to
  + '   holdout ' + run.window.holdoutFrom + '..   no start time (no day/night): ' + run.population.gamesWithoutStartTime);
console.log('\nImplementation notes (§9):');
for (const n of run.notes) console.log('  - ' + n);

const ids = [...new Set(run.results.map(r => r.scenario))];
console.log('\n' + 'id   scenario'.padEnd(58) + '| IN-SAMPLE (Apr-Aug)'.padEnd(78) + '| SEPT HOLDOUT'.padEnd(44) + '| ALL');
console.log(''.padEnd(58) + '|    n  W-L       win%  [95% CI]         impl%   edge     p      q     ROI  [95% CI]        '
  + '|    n   win%  impl%   edge    ROI  flag   |    n   win%   edge    ROI      $ won');
for (const id of ids) {
  const a = get(id, 'primary', 'in'), o = get(id, 'primary', 'out'), l = get(id, 'primary', 'all');
  const small = (r) => (r.tooSmall ? '*' : ' ');
  console.log((id + ' ' + a.name).slice(0, 56).padEnd(57) + small(a) + '| '
    + String(a.n).padStart(4) + ' ' + (a.W + '-' + a.L + (a.P ? '-' + a.P : '')).padEnd(9)
    + pct(a.winPct) + ' [' + pct(a.winLo, 0) + ',' + pct(a.winHi, 0) + '] ' + pct(a.implied) + sgn(a.edge) + ' '
    + p3(a.pValue) + ' ' + p3(a.qValue) + sgn(a.roi) + ' [' + sgn(a.roiLo, 0) + ',' + sgn(a.roiHi, 0) + '] | '
    + String(o.n).padStart(4) + small(o) + pct(o.winPct) + pct(o.implied) + sgn(o.edge) + sgn(o.roi) + ' '
    + String(a.holdout || '').padEnd(13) + '| '
    + String(l.n).padStart(4) + pct(l.winPct) + sgn(l.edge) + sgn(l.roi) + ('$' + Math.round(l.dollars)).padStart(10));
}
console.log('  * n < 30: too small to read (§6). Edge = win% - implied%, in points. ROI on a flat $100 at the locked price.');

console.log('\nSENSITIVITY (§2): all rows, primary vs recorded-source-only (vs Kalshi-at-lock-only for S25/S26)');
for (const id of ids) {
  const p = get(id, 'primary', 'all'), rs = get(id, 'recorded_source_only', 'all'), k = get(id, 'kalshi_lock_only', 'all');
  console.log('  ' + id + '  primary n ' + String(p.n).padStart(4) + ' edge' + sgn(p.edge) + ' ROI' + sgn(p.roi)
    + '   recorded-only n ' + String(rs.n).padStart(4) + ' edge' + sgn(rs.edge) + ' ROI' + sgn(rs.roi)
    + (k ? '   kalshi-lock n ' + String(k.n).padStart(4) + ' edge' + sgn(k.edge) + ' ROI' + sgn(k.roi) : '')
    + '   sources ' + JSON.stringify(p.mix) + (p.bothTeamsGames ? '   both-teams games ' + p.bothTeamsGames : ''));
}

const mc = run.multipleComparisons;
console.log('\nMULTIPLE COMPARISONS (§7)');
console.log('  ' + mc.tested + ' scenarios tested; ' + mc.significantInSample + ' clear p < 0.05 in-sample.');
console.log('  By chance alone ~' + mc.expectedByChance.toFixed(2) + ' would; P(>= ' + mc.significantInSample
  + ' | no real edge) = ' + mc.pAtLeastThisManyByChance.toFixed(3)
  + ' under binomial(31, 0.05) -- an approximation, since the scenarios overlap and are not independent.');
console.log('  Survive Benjamini-Hochberg at q < 0.10: ' + (mc.survivingBH10.length ? mc.survivingBH10.join(', ') : 'none'));
const flagged = run.results.filter(r => r.variant === 'primary' && r.split === 'in' && r.holdout);
console.log('\nHOLDOUT (§8): in-sample p < 0.05 -> ' + (flagged.length
  ? flagged.map(r => r.scenario + ' ' + r.holdout).join(', ') : 'none'));
const septOnly = ids.filter(id => { const o = get(id, 'primary', 'out'), a = get(id, 'primary', 'in');
  return o.pValue != null && o.pValue < 0.05 && !(a.pValue != null && a.pValue < 0.05); });
console.log('Significant ONLY in September (reported, not promoted): ' + (septOnly.length ? septOnly.join(', ') : 'none'));

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(run, null, 1));
if (WRITE) console.log('\nrecorded as trend_runs.id = ' + tb.persistRun(db, run));
