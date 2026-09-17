#!/usr/bin/env node
/**
 * utils/highlight-gate.js is the ONLY highlight rule. (2026-09-17)
 *
 * WHAT WAS WRONG. Eight call sites carried the rule. Four backtest
 * harnesses (frv, temp, runmult, parameter-sweep) each had a verbatim
 * isHighlightedSignal + its own app_settings loader; public/index.html
 * had four -- signalMeetsHighlightThreshold with HARDCODED 2.0/4.5/7.0,
 * _shouldHighlight reading settings x100, _bktThresholds reading the
 * same settings for bucket indices, and the manual-bet preview
 * recomputing the floors inline. They agreed only because production
 * app_settings happened to equal the client's literals. An operator
 * editing ui_highlight_ml_fav_min_pp would have moved seven of the
 * eight and left the game card on 2.0.
 *
 * (The count matters: earlier notes in this repo said five, and the
 * measurement that preceded this PR said five as well. Both undercounted
 * -- it was eight. The no-duplicates assertion below is what makes the
 * number checkable instead of remembered.)
 *
 * THIS TEST:
 *   1. EQUIVALENCE on real rows. The retired harness rule and the
 *      retired client rule are re-declared here -- deliberately, as
 *      frozen historical references -- and compared against the module
 *      over every bet_signals row. Any disagreement must be explained,
 *      not tolerated.
 *   2. NO SECOND COPY. Greps the tree for a re-declared threshold rule.
 *   3. CLIENT WIRING. The page loads the module and delegates.
 *   4. THRESHOLDS ARE SETTINGS, not literals: a changed setting must
 *      move the decision.
 *
 * Run: node scripts/test-highlight-gate.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const { db } = require(path.join(R, 'db/schema'));
const gate = require(path.join(R, 'utils/highlight-gate'));

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== highlight gate: one implementation ===');

const T = gate.loadThresholds(db);
console.log('  thresholds from app_settings: fav ' + T.fav_min_pp
  + '  dog ' + T.dog_min_pp + '  under ' + T.under_min_pp
  + '  overs_enabled ' + T.overs_enabled);

// ---- 1. the retired rules, frozen as references ---------------------
// HARNESS copy (byte-identical in frv/temp/runmult; parameter-sweep's
// differed only in routing ML through categoryFor, same outcome).
const retiredHarness = (sig, t) => {
  const rounded = Math.round(Number(sig.edge) * 200) / 200;
  if (sig.type === 'ML') {
    return Number(sig.marketLine) < 0 ? rounded >= t.fav_min_pp : rounded >= t.dog_min_pp;
  }
  if (sig.side === 'over')  return !!t.overs_enabled;
  if (sig.side === 'under') return rounded >= t.under_min_pp;
  return false;
};
// CLIENT copy, with its literals.
const retiredClient = (s, rawLivePp) => {
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

const rows = db.prepare(
  'SELECT game_date, game_id, signal_type, signal_side, market_line, edge_pct, '
  + 'signal_label, bet_line FROM bet_signals'
).all();
console.log('  corpus: ' + rows.length + ' bet_signals rows');

// The harness shape, built from the stored row the way a replay does.
const asHarnessSig = (r) => ({
  type: r.signal_type === 'ML' ? 'ML' : 'Total',
  side: r.signal_side,
  edge: r.edge_pct,
  marketLine: r.market_line,
});

let hDiff = 0, cDiff = 0;
const hWhy = {}, cWhy = {};
for (const r of rows) {
  const mine = gate.highlightsOnFrozenEdge(asHarnessSig(r), T);
  if (mine !== retiredHarness(asHarnessSig(r), T)) {
    hDiff++;
    const k = (r.market_line == null || Number(r.market_line) === 0)
      ? 'ML line 0/null (retired rule took the dog branch; module returns false)'
      : 'UNEXPLAINED';
    hWhy[k] = (hWhy[k] || 0) + 1;
  }
  // Display layer vs the retired client rule, frozen-edge branch.
  if (gate.highlightsForDisplay(r, T, {}) !== retiredClient(r, undefined)) {
    cDiff++;
    cWhy['UNEXPLAINED'] = (cWhy['UNEXPLAINED'] || 0) + 1;
  }
}
ok('module == retired HARNESS rule on every row', hDiff === 0,
   hDiff ? JSON.stringify(hWhy) : rows.length + ' rows, no disagreement');
ok('module == retired CLIENT rule on every row (frozen-edge branch)', cDiff === 0,
   cDiff ? JSON.stringify(cWhy) : rows.length + ' rows, no disagreement');

// The one INTENTIONAL divergence, stated as a test rather than left to
// a comment: an ML signal with no usable line cannot clear a
// direction-specific floor. The retired harness rule sent line 0 and
// NULL down the dog branch, so a big enough edge highlighted with no
// direction at all; the client already returned false. The module
// follows the client. This changes no measured population -- the corpus
// has zero such rows (verified below) -- so it is safe to unify now
// rather than leave a divergence waiting for the first row to hit it.
const zeroLine = rows.filter(r => r.signal_type === 'ML'
  && (r.market_line == null || Number(r.market_line) === 0));
ok('no ML row in the corpus has a 0/NULL market_line', zeroLine.length === 0,
   'so unifying on "no line -> no highlight" moves nothing; '
   + 'game_log has 20 rows with a NULL market_away_ml but they emit no such signal');
ok('a 0-line ML signal does NOT highlight, however large the edge',
   gate.highlightsOnFrozenEdge({ type: 'ML', side: 'away', edge: 0.5, marketLine: 0 }, T) === false
   && gate.highlightsOnFrozenEdge({ type: 'ML', side: 'away', edge: 0.5, marketLine: null }, T) === false,
   'the retired harness rule returned TRUE here');

// ---- the display layer's two extras ---------------------------------
const starRow = { signal_type: 'ML', signal_side: 'away', market_line: -150, edge_pct: 0.0001, signal_label: '2★' };
ok('2★ highlights on the display path despite a 0.01pp edge',
   gate.highlightsForDisplay(starRow, T, {}) === true);
ok('...and does NOT on the core path (labels are a display concept)',
   gate.highlightsOnFrozenEdge({ type: 'ML', side: 'away', edge: 0.0001, marketLine: -150 }, T) === false);
ok('1★ never highlights',
   gate.highlightsForDisplay(Object.assign({}, starRow, { signal_label: '1★' }), T, {}) === false);
ok('a mojibake label falls through to NOT highlighted, as before',
   gate.highlightsForDisplay(Object.assign({}, starRow, { signal_label: '2â' }), T, {}) === false,
   '6 such rows exist -- see docs/mojibake-star-labels-open-question-2026-09-17.md');
const favRow = { signal_type: 'ML', signal_side: 'away', market_line: -150, edge_pct: 0.0199, signal_label: null };
ok('live raw pp is compared UNROUNDED (1.99 does not clear a 2.0 floor)',
   gate.highlightsForDisplay(favRow, T, { rawLivePp: 1.99 }) === false
   && gate.highlightsForDisplay(favRow, T, { rawLivePp: 2.0 }) === true);
ok('without a live figure the SAME row uses the 0.5-rounded emit edge',
   gate.highlightsForDisplay(favRow, T, {}) === true,
   '0.0199 rounds to 0.02 and clears -- the documented two-basis behaviour');
ok('direction comes from the FROZEN line even with a live figure',
   gate.highlightsForDisplay(favRow, T, { rawLivePp: 3.0 }) === true
   && gate.highlightsForDisplay(Object.assign({}, favRow, { market_line: 150 }), T, { rawLivePp: 3.0 }) === false,
   'same 3.0pp: clears the fav floor, misses the dog floor');

// ---- 4. thresholds are settings, not literals -----------------------
const strict = gate.thresholdsFrom({
  ui_highlight_ml_fav_min_pp: '0.05',
  ui_highlight_ml_dog_min_pp: '0.06',
  ui_highlight_tot_under_min_pp: '0.09',
  ui_highlight_tot_overs_enabled: 'true',
});
ok('a changed setting MOVES the decision',
   gate.highlightsOnFrozenEdge({ type: 'ML', side: 'away', edge: 0.03, marketLine: -150 }, T) === true
   && gate.highlightsOnFrozenEdge({ type: 'ML', side: 'away', edge: 0.03, marketLine: -150 }, strict) === false,
   '3pp clears prod fav 2.0 and misses a 5.0 floor');
ok('overs_enabled=true lets an over highlight',
   gate.highlightsOnFrozenEdge({ type: 'Total', side: 'over', edge: 0.08 }, T) === false
   && gate.highlightsOnFrozenEdge({ type: 'Total', side: 'over', edge: 0.08 }, strict) === true,
   'production has it OFF, so all 13 logged overs are unreachable by this gate');
ok('a missing or unparseable setting falls back to the schema default, never 0',
   gate.thresholdsFrom({ ui_highlight_ml_fav_min_pp: '' }).fav_min_pp === 0.02
   && gate.thresholdsFrom({ ui_highlight_ml_fav_min_pp: 'banana' }).fav_min_pp === 0.02
   && gate.thresholdsFrom({}).fav_min_pp === 0.02,
   'a 0 threshold would highlight everything -- a guard that fails open is not a guard');
ok('both naming shapes read identically',
   gate.highlightsOnFrozenEdge({ type: 'Total', side: 'under', edge: 0.08 }, T)
   === gate.highlightsOnFrozenEdge({ signal_type: 'Total', signal_side: 'under', edge_pct: 0.08 }, T));

// ---- 2. no second copy ----------------------------------------------
// A re-declared rule is what this whole PR removes; the check is a grep
// for the two shapes that carried it. Scoped to prod code + the
// harnesses: this test file itself holds the retired copies on purpose,
// and so does scripts/test-live-edge-highlight.js's history.
const PROD = ['services', 'routes', 'utils', 'public'];
const offenders = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(path.join(R, dir))) {
    const rel = dir + '/' + name;
    const abs = path.join(R, rel);
    if (fs.statSync(abs).isDirectory()) { walk(rel); continue; }
    if (!/\.(js|html)$/.test(name)) continue;
    if (rel === 'utils/highlight-gate.js') continue;
    const src = fs.readFileSync(abs, 'utf8');
    // Strip comments cheaply: only line comments matter here, and the
    // patterns below are code-shaped.
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/function isHighlightedSignal\s*\(/.test(code)) offenders.push(rel + ' (re-declares isHighlightedSignal)');
    if (/return\s+score\s*>=\s*(2\.0|4\.5|7\.0)\b/.test(code)) offenders.push(rel + ' (hardcoded floor literal)');
    if (/ui_highlight_ml_fav_min_pp'\]\s*!=\s*null/.test(code)) offenders.push(rel + ' (re-declares the settings loader)');
  }
};
for (const d of PROD) walk(d);
ok('no prod file re-declares the rule or its loader', offenders.length === 0,
   offenders.length ? offenders.join('; ') : PROD.join(', ') + ' clean');

// Every consumer must reach it through the module.
const consumers = [
  'services/frv-backtest.js', 'services/temp-backtest.js',
  'services/runmult-totals-backtest.js', 'services/parameter-sweep.js',
];
for (const f of consumers) {
  const src = fs.readFileSync(path.join(R, f), 'utf8');
  ok(f + ' requires the gate', src.indexOf("require('../utils/highlight-gate')") !== -1);
}

// ---- 3. client wiring ------------------------------------------------
// index.html is CRLF; normalise so the multi-line assertions below can
// be written the way the source reads.
const page = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');
ok('page loads /highlight-gate.js BEFORE the main script block',
   page.indexOf('<script src="/highlight-gate.js"></script>') !== -1
   && page.indexOf('<script src="/highlight-gate.js"></script>') < page.indexOf('window.PA_WEIGHTS'));
ok('all four client sites delegate',
   page.indexOf('HighlightGate.highlightsForDisplay(s, _uiFloors()') !== -1
   && page.indexOf('function _shouldHighlight(sig, settings) {\n    return HighlightGate.highlightsForDisplay') !== -1
   && page.indexOf('HighlightGate.thresholdsFrom(window._appSettings || {});\n  return { favPp:') !== -1
   && page.indexOf("HighlightGate.highlightsOnFrozenEdge(\n      { signal_type: 'ML'") !== -1);
ok('the page reads thresholds from settings, not literals',
   page.indexOf('function _uiFloors()') !== -1
   && page.indexOf('HighlightGate.thresholdsFrom(window._appSettings || {})') !== -1);
const server = fs.readFileSync(path.join(R, 'server.js'), 'utf8');
ok('server serves the module from utils/, not a copy in public/',
   server.indexOf("app.get('/highlight-gate.js'") !== -1
   && server.indexOf("path.join(__dirname, 'utils', 'highlight-gate.js')") !== -1
   && !fs.existsSync(path.join(R, 'public/highlight-gate.js')));
ok('it is served no-store, so page and gate cannot come from different deploys',
   /highlight-gate\.js'[\s\S]{0,400}no-store/.test(server));

// ---- harness bucket rename ------------------------------------------
for (const f of ['services/frv-backtest.js', 'services/temp-backtest.js',
                 'services/runmult-totals-backtest.js']) {
  const src = fs.readFileSync(path.join(R, f), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(f + ' reports above_ui_floor + by_category_bet, not ui_highlight',
     code.indexOf('above_ui_floor') !== -1
     && code.indexOf('by_category_bet') !== -1
     && !/ui_highlight(?!_)/.test(code));
}
const sweep = fs.readFileSync(path.join(R, 'services/parameter-sweep.js'), 'utf8');
ok('parameter-sweep renames its aggregate and accepts the legacy value',
   sweep.indexOf('by_category_above_ui_floor') !== -1
   && sweep.indexOf("v === 'ui_highlight' ? 'above_ui_floor'") !== -1);
const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
ok('the sweep summary still resolves runs stored under the OLD key',
   api.indexOf('block.by_category_above_ui_floor || block.by_category_highlight') !== -1,
   'both June runs are in that set');

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
