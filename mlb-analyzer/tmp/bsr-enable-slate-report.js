#!/usr/bin/env node
'use strict';
// BsR enable (feat/bsr-enable), one-shot verification. (2026-09-28) Read-only.
//
// Prices every game twice through the harness path the parity dump uses
// (preScreenGame -> populateCallerInputs -> runModel -> getSignals), with
// bsr_enabled OFF and ON, and reports:
//
//   CURRENT SLATE, per game: home win prob without / with, the ML decision
//     without / with (away | home | none), bet/no-bet CROSSINGS, SIDE FLIPS
//     (away <-> home; expected 0), and the per-side BsR status.
//   FORWARD CORPUS: that the total is untouched -- estTot and every Total
//     signal identical with the term on and off -- plus the same crossing /
//     flip / fallback counts, so the slate is not the only evidence.
//
// Window definitions are the parity dump's (tmp/node-parity-price-dump.js).
//   <node> --max-old-space-size=1536 tmp/bsr-enable-slate-report.js
const path = require('path');
const R = path.join(__dirname, '..');
const ps = require(path.join(R, 'services/parameter-sweep'));
const hi = require(path.join(R, 'services/harness-inputs'));
const jobs = require(path.join(R, 'services/jobs'));
const model = require(path.join(R, 'services/model'));
const { db } = require(path.join(R, 'db/schema'));

const quiet = (fn) => {
  const l = console.log, w = console.warn, e = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; console.error = e; }
};
const base = quiet(() => jobs.getSettings());
const OFF = Object.assign({}, base, { BSR_ENABLED: false });
const ON = Object.assign({}, base, { BSR_ENABLED: true });

const cand = db.prepare("SELECT DISTINCT game_date FROM game_log WHERE model_total IS NOT NULL ORDER BY game_date DESC LIMIT 6").all().map(r => r.game_date);
let slateDate = null;
for (const d of cand) { if (quiet(() => ps.loadWobaSnapshot(db, d))) { slateDate = d; break; } }
const FROM = db.prepare('SELECT MIN(snapshot_date) v FROM team_baserunning_snapshot').get().v;
const TO = db.prepare('SELECT MAX(game_date) v FROM game_log WHERE home_score IS NOT NULL').get().v;

const mlSide = (sigs) => { const m = (sigs || []).find(s => s.type === 'ML'); return m ? m.side : 'none'; };
const totals = (sigs) => JSON.stringify((sigs || []).filter(s => s.type === 'Total'));

function sweep(label, from, to, perGame) {
  const agg = { games: 0, priced: 0, crossings: 0, toBet: 0, toNone: 0, sideFlipped: 0,
    fallbackSides: 0, sides: 0, totDiff: 0, totSigDiff: 0, maxAbsDp: 0, sumAbsDp: 0, byStatus: {} };
  const dates = db.prepare('SELECT DISTINCT game_date FROM game_log WHERE game_date BETWEEN ? AND ? ORDER BY game_date').all(from, to).map(r => r.game_date);
  for (const d of dates) {
    const idx = quiet(() => ps.loadWobaSnapshot(db, d));
    if (!idx) continue;
    for (const g of quiet(() => ps.loadGames(db, d, d, {}))) {
      agg.games++;
      const build = (s) => quiet(() => hi.populateCallerInputs(ps.preScreenGame(g, idx, s), g, s));
      const wOff = build(OFF), wOn = build(ON);
      if (!wOff || !wOn) continue;
      const mOff = quiet(() => model.runModel(wOff, idx, OFF, 'standard', true));
      const mOn = quiet(() => model.runModel(wOn, idx, ON, 'standard', true));
      if (!mOff || !mOn || mOff._suppressed || mOn._suppressed) continue;
      agg.priced++;
      const sOff = quiet(() => model.getSignals(g, mOff, OFF, []));
      const sOn = quiet(() => model.getSignals(g, mOn, ON, []));
      const dOff = mlSide(sOff), dOn = mlSide(sOn);
      if (dOff !== dOn) {
        if (dOff === 'none') { agg.crossings++; agg.toBet++; }
        else if (dOn === 'none') { agg.crossings++; agg.toNone++; }
        else agg.sideFlipped++;
      }
      if (mOff.estTot !== mOn.estTot) agg.totDiff++;
      if (totals(sOff) !== totals(sOn)) agg.totSigDiff++;
      // the shadow the model returns must BE the off price
      if (mOn.bsrOff.adjHW !== mOff.adjHW || mOn.bsrOff.hML !== mOff.hML) agg.shadowMismatch = (agg.shadowMismatch || 0) + 1;
      agg.fallbackSides += mOn.bsrFallbackSides;
      agg.sides += 2;
      for (const side of ['away', 'home']) {
        const st = g[side + '_bsr_state'] || (wOn[side + 'BsRPerGame'] == null ? 'null' : 'ok');
        agg.byStatus[st] = (agg.byStatus[st] || 0) + 1;
      }
      const dp = mOn.adjHW - mOff.adjHW;
      agg.maxAbsDp = Math.max(agg.maxAbsDp, Math.abs(dp)); agg.sumAbsDp += Math.abs(dp);
      if (perGame) {
        const f = (v) => v == null ? '  null' : (v >= 0 ? '+' : '') + v.toFixed(3);
        console.log('  ' + g.game_id.padEnd(12) + ' home wp ' + mOff.adjHW.toFixed(4) + ' -> ' + mOn.adjHW.toFixed(4)
          + ' (' + (dp >= 0 ? '+' : '') + dp.toFixed(4) + ')  hML ' + mOff.hML + ' -> ' + mOn.hML
          + '  ML ' + dOff.padEnd(4) + ' -> ' + dOn.padEnd(4) + (dOff !== dOn ? (dOff !== 'none' && dOn !== 'none' ? '  SIDE FLIP' : '  CROSSING') : '')
          + '  bsr away ' + f(wOn.awayBsRPerGame) + ' home ' + f(wOn.homeBsRPerGame)
          + '  estTot ' + (mOff.estTot === mOn.estTot ? 'same' : 'DIFF'));
      }
    }
  }
  console.log('  ' + label + ' ' + from + '..' + to + ': ' + agg.priced + ' priced of ' + agg.games
    + ' | ML crossings ' + agg.crossings + ' (none->bet ' + agg.toBet + ', bet->none ' + agg.toNone + ')'
    + ' | side_flipped ' + agg.sideFlipped
    + ' | fallback sides ' + agg.fallbackSides + ' of ' + agg.sides + ' ' + JSON.stringify(agg.byStatus)
    + ' | mean |dp| ' + (agg.priced ? (agg.sumAbsDp / agg.priced).toFixed(4) : '-') + ', max ' + agg.maxAbsDp.toFixed(4)
    + ' | estTot differs ' + agg.totDiff + ', Total signals differ ' + agg.totSigDiff
    + ' | shadow != off price ' + (agg.shadowMismatch || 0));
  return agg;
}

console.log('node ' + process.version + '  harness inputs: ' + hi.harnessInputsMode());
console.log('\nCURRENT SLATE ' + slateDate);
sweep('slate', slateDate, slateDate, true);
console.log('\nFORWARD CORPUS');
sweep('forward', FROM, TO, false);
console.log('\n' + hi.harnessInputsLine());
