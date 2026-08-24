#!/usr/bin/env node
/**
 * Lineup accuracy and model impact, on data that already exists. (2026-08-23)
 *
 * THE FINDING THAT MADE THIS POSSIBLE. The plan was to build forward
 * capture and wait ~6 weeks for 150-200 games. That is unnecessary:
 * game_log ALREADY persists prior lineup state.
 *
 *   proj_away_lineup_json / proj_home_lineup_json  -- the PROJECTED lineup
 *   proj_lineup_captured_at                        -- when it was captured
 *   away_lineup_json / home_lineup_json            -- the CONFIRMED lineup
 *   proj_model_total / proj_model_*_ml             -- model on the projection
 *   model_total / model_*_ml                       -- model on the confirmed
 *
 * 1375 games carry both lineups; 1539 completed games carry both model
 * scorings, spanning 2026-04-27 to 2026-08-22. So metrics 1-5 run today
 * at roughly 8x the sample forward capture would have produced by October.
 *
 * WHAT THIS IS AND IS NOT. It is a QUALITY BASELINE for the source
 * actually in use (RotoWire), measured against confirmed lineups. It is
 * NOT a source ranking -- that needs the comparison access forecloses.
 *
 * Lineup entries are [{name, hand}, ...] in batting order, so slot
 * accuracy is positional, roster accuracy is set-based, and handedness
 * comes straight from the stored field.
 */
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

const BOOT = 4000;
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ci(items, stat, seed) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.d)) byDate.set(it.d, []); byDate.get(it.d).push(it); }
  const dates = [...byDate.keys()], n = dates.length, rnd = mulberry(seed), out = [];
  for (let b = 0; b < BOOT; b++) {
    const s = [];
    for (let i = 0; i < n; i++) for (const x of byDate.get(dates[Math.floor(rnd() * n)])) s.push(x);
    const v = stat(s); if (v != null && isFinite(v)) out.push(v);
  }
  if (out.length < 50) return [null, null];
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.floor(0.975 * out.length)]];
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const pj = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
const f = (v, d) => v == null ? 'n/a' : Number(v).toFixed(d == null ? 1 : d);

(function main() {
  const rows = db.prepare(
    'SELECT game_date, game_id, proj_away_lineup_json pa, proj_home_lineup_json ph, '
    + 'away_lineup_json ca, home_lineup_json ch, proj_lineup_captured_at pcap, '
    + 'proj_model_total pmt, model_total mt, proj_model_home_ml pmh, model_home_ml mh, '
    + 'home_score, away_score, market_contamination_reason mc '
    + 'FROM game_log ORDER BY game_date').all();

  console.log('=== lineup accuracy + model impact, from existing data ===');
  console.log('  game_log rows: ' + rows.length);

  // ---------- metrics 1-3: per SIDE (a game has two lineups)
  const sides = [];
  for (const r of rows) {
    for (const [projRaw, confRaw, which] of [[r.pa, r.ca, 'away'], [r.ph, r.ch, 'home']]) {
      const p = pj(projRaw), c = pj(confRaw);
      if (!p || !c || p.length < 9 || c.length < 9) continue;
      const P = p.slice(0, 9), C = c.slice(0, 9);
      let slotHits = 0, handHits = 0;
      for (let i = 0; i < 9; i++) {
        if (norm(P[i].name) === norm(C[i].name)) slotHits++;
        if (String(P[i].hand || '').toUpperCase() === String(C[i].hand || '').toUpperCase()) handHits++;
      }
      const cs = new Set(C.map(x => norm(x.name)));
      const rosterHits = P.filter(x => cs.has(norm(x.name))).length;

      // HANDEDNESS, two ways -- they answer different questions and the
      // positional one is NOT what the model consumes.
      //   positional : same hand in the same batting slot. A pure order
      //                shuffle breaks this even though the platoon mix is
      //                identical, so it understates what matters.
      //   composition: the multiset of L/R/S across the nine. This is the
      //                platoon composition the model actually reads, and
      //                it is invariant to reordering.
      const tally = arr => arr.reduce((m, x) => {
        const h = String(x.hand || '?').toUpperCase(); m[h] = (m[h] || 0) + 1; return m; }, {});
      const tp = tally(P), tc = tally(C);
      const keys = new Set([...Object.keys(tp), ...Object.keys(tc)]);
      let overlap = 0;
      for (const k of keys) overlap += Math.min(tp[k] || 0, tc[k] || 0);
      const compExact = overlap === 9;
      sides.push({ d: r.game_date, which, slotHits, rosterHits, handHits,
                   handCompHits: overlap, compExact });
    }
  }
  console.log('  sides with both lineups (9+): ' + sides.length);
  console.log('');

  const meanOf = k => a => a.reduce((s, x) => s + x[k], 0) / a.length / 9 * 100;
  console.log('=== (1)(2)(3) accuracy, per batting slot ===');
  for (const [k, label] of [['slotHits', 'exact-slot'], ['rosterHits', 'roster (order ignored)'],
                            ['handHits', 'handedness (positional)'],
                            ['handCompHits', 'handedness (COMPOSITION)']]) {
    const m = meanOf(k)(sides);
    const c = ci(sides, meanOf(k), k.length + 7);
    console.log('  ' + label.padEnd(24) + f(m, 1) + '%   95% CI [' + f(c[0], 1) + ', ' + f(c[1], 1) + ']');
  }
  console.log('');
  const compRight = sides.filter(x => x.compExact).length;
  console.log('  platoon composition EXACTLY right : ' + compRight + '/' + sides.length
    + '  (' + f(100 * compRight / sides.length) + '%)  <- what the model consumes');
  const perfect = sides.filter(x => x.slotHits === 9).length;
  const perfectRoster = sides.filter(x => x.rosterHits === 9).length;
  console.log('  lineups exactly right, all 9 slots : ' + perfect + '/' + sides.length
    + '  (' + f(100 * perfect / sides.length) + '%)');
  console.log('  right nine, any order              : ' + perfectRoster + '/' + sides.length
    + '  (' + f(100 * perfectRoster / sides.length) + '%)');
  console.log('');
  const dist = {};
  sides.forEach(x => { dist[9 - x.rosterHits] = (dist[9 - x.rosterHits] || 0) + 1; });
  console.log('  wrong players per lineup (roster):');
  Object.keys(dist).sort((a, b) => a - b).forEach(k =>
    console.log('    ' + k + ' wrong: ' + String(dist[k]).padStart(4)
      + '  (' + f(100 * dist[k] / sides.length) + '%)'));

  // ---------- metric 4: model impact
  console.log('');
  console.log('=== (4) MODEL IMPACT -- the headline ===');
  const mi = rows.filter(r => r.pmt != null && r.mt != null && r.home_score != null)
    .map(r => ({ d: r.game_date, v: Math.abs(Number(r.pmt) - Number(r.mt)),
                 signed: Number(r.mt) - Number(r.pmt),
                 mlDelta: (r.pmh != null && r.mh != null) ? Math.abs(Number(r.mh) - Number(r.pmh)) : null,
                 mc: !!r.mc }));
  console.log('  completed games with both scorings: ' + mi.length);
  const abs = mi.map(x => x.v).sort((a, b) => a - b);
  const q = p => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  console.log('');
  console.log('  |proj_model_total - model_total|, in RUNS:');
  console.log('    median ' + f(q(0.5), 3) + '   p75 ' + f(q(0.75), 3) + '   p90 ' + f(q(0.90), 3)
    + '   p99 ' + f(q(0.99), 3) + '   max ' + f(abs[abs.length - 1], 3));
  const meanAbs = a => a.reduce((s, x) => s + x.v, 0) / a.length;
  const cAbs = ci(mi, meanAbs, 4242);
  console.log('    mean   ' + f(meanAbs(mi), 3) + '   95% CI [' + f(cAbs[0], 3) + ', ' + f(cAbs[1], 3) + ']');
  const signedMean = a => a.reduce((s, x) => s + x.signed, 0) / a.length;
  const cSign = ci(mi, signedMean, 5353);
  console.log('    SIGNED mean (confirmed - projected) ' + f(signedMean(mi), 3)
    + '   [' + f(cSign[0], 3) + ', ' + f(cSign[1], 3) + ']'
    + (cSign[0] != null && (cSign[0] > 0 || cSign[1] < 0) ? '   BIASED' : '   no directional bias'));
  console.log('');
  for (const [lo, hi] of [[0, 0.05], [0.05, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 1], [1, 99]]) {
    const n = abs.filter(v => v >= lo && v < hi).length;
    console.log('    ' + (lo + '-' + (hi > 90 ? 'inf' : hi) + ' runs').padEnd(16)
      + String(n).padStart(5) + '  (' + f(100 * n / abs.length) + '%)');
  }
  const mlAbs = mi.filter(x => x.mlDelta != null).map(x => x.mlDelta).sort((a, b) => a - b);
  if (mlAbs.length) {
    console.log('');
    console.log('  |proj_model_home_ml - model_home_ml|, in AMERICAN ODDS POINTS:');
    const qm = p => mlAbs[Math.min(mlAbs.length - 1, Math.floor(p * mlAbs.length))];
    console.log('    median ' + f(qm(0.5), 1) + '   p75 ' + f(qm(0.75), 1)
      + '   p90 ' + f(qm(0.90), 1) + '   max ' + f(mlAbs[mlAbs.length - 1], 1));
  }

  // ---------- metric 5: coverage
  console.log('');
  console.log('=== (5) coverage ===');
  const tot = rows.length;
  const withProj = rows.filter(r => r.pa && r.ph).length;
  const withConf = rows.filter(r => r.ca && r.ch).length;
  console.log('  projected lineups present : ' + withProj + '/' + tot + '  (' + f(100 * withProj / tot) + '%)');
  console.log('  confirmed lineups present : ' + withConf + '/' + tot + '  (' + f(100 * withConf / tot) + '%)');
  const capt = rows.filter(r => r.pcap).map(r => r.pcap).sort();
  if (capt.length) console.log('  capture span: ' + capt[0] + ' .. ' + capt[capt.length - 1]);
})();
