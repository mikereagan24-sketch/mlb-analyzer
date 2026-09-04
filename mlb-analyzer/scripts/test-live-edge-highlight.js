#!/usr/bin/env node
/**
 * The bet-box green gate, extracted from public/index.html and checked
 * against real bet_signals rows. (2026-09-04)
 *
 * The card now shows the CURRENT edge in the ML boxes -- live model vs
 * live market -- and greens a box only when that current edge clears the
 * signal's direction floor, compared RAW rather than 0.5-rounded.
 *
 * This asserts the behaviour on production-shaped rows rather than
 * fixtures, per the ingest-not-hot-path rule's "prod-shaped fixtures or
 * it doesn't ship". The functions under test are the ones in the page:
 * they are re-declared here because index.html is not requireable, and
 * the test asserts the page still contains them so the copy cannot
 * silently drift from the original.
 *
 * Run: node scripts/test-live-edge-highlight.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== live-edge highlight gate ===');

// ---- the page still defines what this test models --------------------
const page = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
ok('page defines liveEdgePpML', page.indexOf('function liveEdgePpML(s, g)') !== -1);
ok('page gate accepts a raw live pp',
   page.indexOf('function signalMeetsHighlightThreshold(s, rawLivePp)') !== -1);
ok('vd() inline threshold copy is gone -- folded into the shared gate',
   page.indexOf('isHighlight = score >= 2.0') === -1
   && page.indexOf('isHighlight = score >= 4.5') === -1);
ok('ML boxes print the LIVE market',
   page.indexOf("mkt '+fmtML(g.market_away_ml)") !== -1
   && page.indexOf("mkt '+fmtML(g.market_home_ml)") !== -1);
ok('Total box still uses the frozen resolver',
   page.indexOf('_resolveTotalMkt(g, sigs)') !== -1);
ok('ML box renders the live figure to TWO decimals',
   page.indexOf('? livePp.toFixed(2)') !== -1);
ok('Total box keeps ONE decimal on its rounded emit score',
   page.indexOf("* 0.5).toFixed(1)) + 'PP'") !== -1);
ok('header chip stays at ONE decimal', page.indexOf("'was ' + emitPp.toFixed(1)") !== -1);
ok('header chip carries the frozen price', page.indexOf("' at ' + (Number(ml) > 0") !== -1);

// ---- the logic, mirrored ---------------------------------------------
const _impliedP = ml => {
  const m = Number(ml);
  if (!isFinite(m) || m === 0) return null;
  return m < 0 ? Math.abs(m) / (Math.abs(m) + 100) : 100 / (m + 100);
};
const liveEdgePpML = (s, g) => {
  if (!s || !g || String(s.signal_type).toUpperCase() !== 'ML') return null;
  const side = String(s.signal_side).toLowerCase();
  // effAwayML/effHomeML: opener-aware, matching what the box prints.
  const opener = g.is_opener_game_away || g.is_opener_game_home;
  const mdl = side === 'away'
    ? (opener && g.opener_model_away_ml != null ? g.opener_model_away_ml : g.model_away_ml)
    : (opener && g.opener_model_home_ml != null ? g.opener_model_home_ml : g.model_home_ml);
  const mkt = side === 'away' ? g.market_away_ml : g.market_home_ml;
  const a = _impliedP(mdl), b = _impliedP(mkt);
  if (a == null || b == null) return null;
  return (a - b) * 100;
};
const gate = (s, rawLivePp) => {
  if (!s) return false;
  if (s.signal_label !== null && s.signal_label !== undefined) {
    return s.signal_label === '2★' || s.signal_label === '3★';
  }
  const useRaw = typeof rawLivePp === 'number' && isFinite(rawLivePp);
  const score = useRaw ? rawLivePp : Math.round((s.edge_pct || 0) * 100 / 0.5) * 0.5;
  if (s.signal_type === 'ML') {
    if (s.market_line < 0) return score >= 2.0;
    if (s.market_line > 0) return score >= 4.5;
    return false;
  }
  if (s.signal_type === 'Total') {
    if (s.signal_side === 'under') return score >= 7.0;
    return false;
  }
  return false;
};

// ---- the named case ---------------------------------------------------
const rowFor = gid => db.prepare(
  'SELECT s.*, g.model_away_ml, g.model_home_ml, g.market_away_ml, g.market_home_ml, '
  + 'g.opener_model_away_ml, g.opener_model_home_ml, '
  + 'g.is_opener_game_away, g.is_opener_game_home '
  + 'FROM bet_signals s JOIN game_log g '
  + '  ON g.game_date = s.game_date AND g.game_id = s.game_id '
  + "WHERE s.game_id = ? AND s.signal_type = 'ML' AND s.signal_side = 'away' "
  + 'AND s.is_active = 1 ORDER BY s.game_date DESC LIMIT 1').get(gid);

const mn = rowFor('mil-nym');
if (!mn) {
  console.log('  SKIP  mil-nym away not in the local DB');
} else {
  const live = liveEdgePpML(mn, mn);
  const emitPp = (mn.edge_pct || 0) * 100;
  const frozenPp = (_impliedP(
    mn.is_opener_game_away || mn.is_opener_game_home
      ? (mn.opener_model_away_ml != null ? mn.opener_model_away_ml : mn.model_away_ml)
      : mn.model_away_ml) - _impliedP(mn.market_line)) * 100;
  console.log('  mil-nym away: emit ' + emitPp.toFixed(2) + 'pp'
    + '  live-vs-live ' + live.toFixed(4) + 'pp'
    + '  live-vs-frozen ' + frozenPp.toFixed(2) + 'pp'
    + '  dir ' + (mn.market_line < 0 ? 'FAV floor 2.0' : 'DOG floor 4.5'));
  ok('mil-nym uses the LIVE-vs-LIVE figure, not live-vs-frozen',
     Math.abs(live - frozenPp) > 0.2, 'they differ by '
       + Math.abs(live - frozenPp).toFixed(2) + 'pp, so the basis is distinguishable');
  ok('mil-nym away renders NOT green', gate(mn, live) === false,
     'raw ' + live.toFixed(4) + 'pp < 2.0 floor');
  ok('mil-nym would have been GREEN under the old 0.5-rounded basis',
     gate(mn, undefined) === true,
     'rounded emit ' + (Math.round(emitPp / 0.5) * 0.5).toFixed(1) + 'pp >= 2.0 -- this is the change');
  // Was: asserted it prints "2.0PP" while not green. That was the defect
  // two decimals fixes -- a raw 1.9854 displayed AS its floor and did not
  // green, which reads as a broken highlight rather than a near miss.
  ok('two-decimal display no longer reads as the floor it misses',
     live.toFixed(2) !== '2.00' && Number(live.toFixed(2)) < 2.0
     && gate(mn, live) === false,
     'prints ' + live.toFixed(2) + 'PP, not green (one decimal gave '
       + live.toFixed(1) + ')');
}

// ---- no ML row may green without clearing its own raw floor ----------
const all = db.prepare(
  'SELECT s.*, g.model_away_ml, g.model_home_ml, g.market_away_ml, g.market_home_ml, '
  + 'g.opener_model_away_ml, g.opener_model_home_ml, '
  + 'g.is_opener_game_away, g.is_opener_game_home '
  + 'FROM bet_signals s JOIN game_log g '
  + '  ON g.game_date = s.game_date AND g.game_id = s.game_id '
  + "WHERE s.signal_type = 'ML' AND s.is_active = 1 AND s.signal_label IS NULL "
  + 'ORDER BY s.game_date DESC LIMIT 400').all();
let checked = 0, greens = 0, viol = 0;
for (const s of all) {
  const live = liveEdgePpML(s, s);
  if (live == null) continue;
  checked++;
  const g = gate(s, live);
  if (g) greens++;
  const floor = s.market_line < 0 ? 2.0 : s.market_line > 0 ? 4.5 : Infinity;
  if (g !== (live >= floor)) viol++;
}
ok('every ML row greens iff its raw live pp clears its own floor',
   viol === 0, checked + ' rows checked, ' + greens + ' green, ' + viol + ' violations');

// THE INVARIANT TWO DECIMALS BUYS. A box that is not green must not print
// a number that reads as clearing its floor, and vice versa. At one
// decimal this failed for any raw value in [floor-0.05, floor).
let mis1 = 0, mis2 = 0, worst = null;
for (const s of all) {
  const live = liveEdgePpML(s, s);
  if (live == null) continue;
  const floor = s.market_line < 0 ? 2.0 : s.market_line > 0 ? 4.5 : null;
  if (floor == null) continue;
  const green = live >= floor;
  if ((Number(live.toFixed(1)) >= floor) !== green) {
    mis1++;
    if (!worst) worst = s.game_id + ' ' + s.signal_side + ' raw ' + live.toFixed(4);
  }
  if ((Number(live.toFixed(2)) >= floor) !== green) mis2++;
}
ok('at TWO decimals, no box prints a number contradicting its own colour',
   mis2 === 0, mis2 + ' contradictions');
ok('the change is load-bearing: ONE decimal did contradict on this corpus',
   mis1 > 0, mis1 + ' row(s) would misread, e.g. ' + (worst || 'n/a'));
ok('the corpus actually exercises both outcomes', greens > 0 && greens < checked,
   greens + ' of ' + checked);

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
