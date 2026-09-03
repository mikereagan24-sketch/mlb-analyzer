#!/usr/bin/env node
/**
 * Re-run the four harnesses both ways after the bullpen-term fix.
 * (2026-09-03)
 *
 * BEFORE = the old path: recompute the bullpen term live with 10 of 17
 *          arguments, against today's woba_data.
 * AFTER  = the merged path: read the persisted emit-time value.
 *
 * Measured input shift was signed +0.0066 wOBA, mean |d| 0.0074, on
 * 2,329 of 2,340 sides. Scaled by RELIEF_PIT_WEIGHT (~0.29) that is a
 * small nudge against the confidence intervals these analyses carry, so
 * most verdicts should be UNCHANGED -- which is worth confirming rather
 * than assuming.
 *
 * HOW THE A/B WORKS WITHOUT TOUCHING PRODUCTION CODE. Each harness does
 * `require('./harness-inputs')` INSIDE its per-game function, so the
 * module object is resolved from Node's cache at call time. Monkey-
 * patching that one export here swaps the term for the whole run and
 * restores it after. No flag, no env var, and nothing left behind in the
 * shipping path.
 *
 * Order is the brief's: FRV first (the live gate candidate at 4/5 windows
 * with a registered trigger -- if the term moves it, the gate decision
 * moves), then RUN_MULT totals (totals carry the most bullpen weight and
 * informed the paused-totals decision), then temp and baserunning (both
 * concluded "not distinguishable"; a small input shift is unlikely to
 * flip a null, but confirm).
 */
const path = require('path');
const R = path.join(__dirname, '..');
const hi = require(path.join(R, 'services/harness-inputs'));
const { q } = require(path.join(R, 'db/schema'));

const FROM = process.argv[2] || '2026-06-01';
const TO = process.argv[3] || '2026-08-29';

const REAL = hi.bullpenTermForReplay;

// Reproduce the pre-fix behaviour exactly: 10 args, today's woba_data.
function legacy(qq, gameRow, side, settings, opts) {
  const s = settings || {};
  const N = (v, d) => (v != null ? Number(v) : d);
  try {
    const r = qq.getBullpenWobaBlended(
      opts.team, opts.starter || '', opts.lineup || [],
      N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
      N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
      N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), gameRow.game_date);
    return r ? { woba: r.woba, vsLHB: r.vsLHB, vsRHB: r.vsRHB, source: 'legacy' } : null;
  } catch (e) { return null; }
}

// The harnesses log per game -- thousands of lines across eight passes,
// which dominates the runtime and buries the result. Silence them for the
// duration and restore after; errors still surface because we rethrow.
function quiet(fn) {
  const L = console.log, W = console.warn, E = console.error;
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { console.log = L; console.warn = W; console.error = E; }
}

const withMode = (mode, fn) => {
  hi.bullpenTermForReplay = mode === 'before' ? legacy : REAL;
  try { return quiet(fn); } finally { hi.bullpenTermForReplay = REAL; }
};

// Pull every leaf number out of a result tree, keyed by path, so the diff
// does not depend on knowing each harness's shape.
function leaves(o, prefix, out) {
  out = out || {}; prefix = prefix || '';
  if (o == null) return out;
  if (typeof o === 'number') { out[prefix] = o; return out; }
  if (typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    if (k === 'detail' || k === 'rows' || k === 'games') continue;   // bulky, not verdicts
    leaves(o[k], prefix ? prefix + '.' + k : k, out);
  }
  return out;
}

const HARNESSES = [
  { name: 'FRV', why: 'live gate candidate, 4/5 windows, registered trigger',
    run: () => require(path.join(R, 'services/frv-backtest'))
      .runFrvBacktest({ fromDate: FROM, toDate: TO }) },
  { name: 'RUN_MULT totals', why: 'totals carry the most bullpen weight; informed the paused-totals decision',
    run: () => require(path.join(R, 'services/runmult-totals-backtest'))
      .runRunMultTotalsBacktest({ fromDate: FROM, toDate: TO }) },
  { name: 'temp', why: 'concluded not distinguishable',
    run: () => require(path.join(R, 'services/temp-backtest'))
      .runTempBacktest({ fromDate: FROM, toDate: TO }) },
  { name: 'baserunning', why: 'concluded not distinguishable',
    run: () => require(path.join(R, 'services/baserunning-backtest'))
      .runBaserunningBacktest({ fromDate: FROM, toDate: TO }) },
];

console.log('=== BULLPEN-TERM A/B ACROSS THE HARNESS CLUSTER ===');
console.log('  window ' + FROM + ' .. ' + TO);
console.log('  BEFORE = 10-arg recompute on today\'s woba_data');
console.log('  AFTER  = persisted emit-time value');
console.log('');

// Optional 3rd arg: run only harnesses whose name matches, so the slow
// ones do not eat the budget before the later ones report.
const ONLY = process.argv[4] ? String(process.argv[4]).toLowerCase() : null;
for (const h of HARNESSES) {
  if (ONLY && !h.name.toLowerCase().includes(ONLY)) continue;
  console.log('--- ' + h.name + '  (' + h.why + ') ---');
  const _t0 = Date.now();
  let before = null, after = null, err = null;
  try { before = withMode('before', h.run); } catch (e) { err = 'BEFORE: ' + e.message; }
  try { after = withMode('after', h.run); } catch (e) { err = (err ? err + ' | ' : '') + 'AFTER: ' + e.message; }
  if (err) { console.log('  could not run: ' + err); console.log(''); continue; }

  const lb = leaves(before), la = leaves(after);
  const keys = [...new Set([...Object.keys(lb), ...Object.keys(la)])].sort();
  const moved = keys.filter(k => {
    const x = lb[k], y = la[k];
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    return Math.abs(x - y) > 1e-9;
  });
  console.log('  ran both passes in ' + ((Date.now() - _t0) / 1000).toFixed(0) + 's');
  console.log('  numeric fields compared : ' + keys.length);
  console.log('  fields that MOVED       : ' + moved.length);
  if (!moved.length) {
    console.log('  VERDICT: byte-identical. The bullpen-term change does not reach');
    console.log('  this harness\'s conclusions at all.');
  } else {
    const rows = moved.map(k => ({ k, b: lb[k], a: la[k], d: la[k] - lb[k] }))
      .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    console.log('');
    // ROI and play COUNTS are the decision numbers. A moved 'wagered' means
    // the POPULATION changed -- different games qualified -- which is a
    // different and larger claim than a moved pnl on a fixed population.
    const roi = rows.filter(r => /.roi$|roi_pct$/.test(r.k));
    const cnt = rows.filter(r => /.(plays|n|wagered)$/.test(r.k));
    console.log('    ROI fields moved   : ' + roi.length);
    console.log('    play-count/wagered : ' + cnt.length + '  <- population change if >0');
    console.log('');
    if (roi.length) {
      console.log('    ROI field                                   before      after      delta');
      for (const r of roi.slice(0, 12))
        console.log('    ' + r.k.padEnd(42) + String(r.b.toFixed(2)).padStart(10)
          + String(r.a.toFixed(2)).padStart(11) + String((r.d>=0?'+':'') + r.d.toFixed(2)).padStart(11));
      if (roi.length > 12) console.log('    ... +' + (roi.length-12) + ' more ROI fields');
      console.log('');
      // A sign flip is only a VERDICT change if the sample can support it.
      // This repo's own rule: ROI over emitted signals resolves at n~200 and
      // plateaus near a 12pp floor, so a 30pp swing on n=40 is noise wearing
      // a verdict's clothes. Pull the play count for each flipped field.
      const playsFor = k => {
        const base = k.replace(/.roi_pct$/, '');
        for (const suf of ['.plays', '.n', '.wagered']) {
          if (typeof la[base + suf] === 'number') {
            return { key: suf.slice(1), before: lb[base + suf], after: la[base + suf] };
          }
        }
        return null;
      };
      const flips = roi.filter(r => (r.b>=0) !== (r.a>=0));
      console.log('    ROI fields that CHANGED SIGN: ' + flips.length);
      for (const r of flips.slice(0, 10)) {
        const p = playsFor(r.k);
        const est = p && p.key === 'wagered' ? Math.round(p.after / 105) : (p ? p.after : null);
        console.log('      ' + r.k.padEnd(52) + String(r.b.toFixed(2)).padStart(8) + ' -> '
          + String(r.a.toFixed(2)).padStart(8)
          + '   n~' + (est == null ? '?' : est)
          + (est != null && est < 200 ? '  (under the n~200 resolution point)' : ''));
      }
    }
    console.log('');
    console.log('    largest raw moves:');
    console.log('    field                                       before      after      delta');
    for (const r of rows.slice(0, 14))
      console.log('    ' + r.k.padEnd(42)
        + String(r.b.toFixed(4)).padStart(10)
        + String(r.a.toFixed(4)).padStart(11)
        + String((r.d >= 0 ? '+' : '') + r.d.toFixed(4)).padStart(11));
    if (rows.length > 14) console.log('    ... +' + (rows.length - 14) + ' more');
    // Anything that looks like a decision number gets called out.
    const verdictish = rows.filter(r => /roi|edge|win|delta|pp|verdict|tier/i.test(r.k));
    console.log('');
    console.log('  decision-shaped fields that moved: ' + verdictish.length
      + (verdictish.length ? ' -- ' + verdictish.slice(0, 5).map(r => r.k).join(', ') : ''));
  }
  console.log('');
}
console.log('NOTE: a moved number is not a changed verdict. Whether any of these');
console.log('crosses a decision bar has to be read against that analysis\'s own');
console.log('interval -- an 0.0066 wOBA input shift scaled by RELIEF_PIT_WEIGHT is');
console.log('small against the CIs these carry.');
