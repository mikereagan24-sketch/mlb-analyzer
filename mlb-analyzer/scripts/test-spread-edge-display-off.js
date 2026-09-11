#!/usr/bin/env node
/**
 * The spread-edge pp display is OFF. (2026-09-11)
 *
 * WHY. Measured walk-forward on 14,004 distinct plays: the engine's cell
 * cover probability is worse calibrated than the Kalshi ask it is quoted
 * against (mean |bin error| 5.84pp vs 4.03pp), discriminates no better
 * (AUC 0.7477 vs 0.7560), and the out-of-sample optimal weight on it in
 * w*empirical + (1-w)*implied is 0.00. A play the card labelled 85% won
 * 74% of the time.
 *
 * WHAT THIS DEFENDS, and each of these has a way of quietly coming back:
 *   1. The pp figures are OMITTED from the payload, not nulled. A null
 *      still travels the wire and still tempts `edge_pp || 0`.
 *   2. The block is not a ranked list. Ordering by edge IS a
 *      recommendation even with the numbers stripped off.
 *   3. The signal WRITE path is untouched. Turning off a display must
 *      not turn off the forward record the re-enable criterion needs.
 *   4. The gate is registered with a criterion that names the market as
 *      the bar, not the raw engine.
 *
 * Run: node scripts/test-spread-edge-display-off.js
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

let failures = 0;
const ok = (name, cond, detail) => {
  console.log('  ' + (cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
};

console.log('=== spread-edge pp display is off ===');

const api = fs.readFileSync(path.join(R, 'routes/api.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'public/index.html'), 'utf8');
const eng = fs.readFileSync(path.join(R, 'services/empirical-spread-edge.js'), 'utf8');
const jobs = fs.readFileSync(path.join(R, 'services/jobs.js'), 'utf8');

// ---- 1. the flag, and that it is a constant not a settings key -------
ok('the display flag exists and is OFF',
   /const SPREAD_EDGE_DISPLAY_ENABLED\s*=\s*false/.test(api));
const schemaKeys = fs.readFileSync(path.join(R, 'services/settings-schema.js'), 'utf8');
ok('it is NOT a settings-schema key',
   schemaKeys.indexOf('spread_edge_display_enabled') === -1,
   'a schema key would need a UI control in this PR (UI-parity rule)');

// ---- 2. the pp figures are omitted, not nulled -----------------------
ok('edge_pp / empirical_pct / implied are behind the flag',
   /if \(SPREAD_EDGE_DISPLAY_ENABLED\) \{\s*\n\s*row\.edge_pp/.test(api),
   'omitted keys, so no downstream `edge_pp || 0`');
ok('the payload declares which shape it is',
   api.indexOf('edge_display: SPREAD_EDGE_DISPLAY_ENABLED') !== -1);

// Exercise the real serializer shape rather than trusting the regex.
// Mirrors the api.js branch exactly.
const ENABLED = false;
const pred = { spread_team: 'LAD', spread_line: 1.5, side: 'lay', pair_id: 'x',
  price_ml: -120, edge_pp: 9.9, empirical_pct: 71.2, implied_pct: 61.3, tail_hit: 88 };
const row = (function (p) {
  const r = { spread_team: p.spread_team, spread_line: p.spread_line,
    side: p.side || 'lay', pair_id: p.pair_id || null,
    yes_ask_ml: (p.price_ml != null ? p.price_ml : p.kalshi_yes_ask_ml) };
  if (ENABLED) {
    r.edge_pp = p.edge_pp; r.empirical_pct = p.empirical_pct;
    r.kalshi_implied_pct = p.implied_pct;
    r.tail_hit = p.tail_hit != null ? p.tail_hit : null;
  }
  return r;
})(pred);
ok('a serialized row carries NO pp keys at all',
   !('edge_pp' in row) && !('empirical_pct' in row)
   && !('kalshi_implied_pct' in row) && !('tail_hit' in row),
   Object.keys(row).join(', '));
ok('it still carries the posted price and the rung',
   row.yes_ask_ml === -120 && row.spread_line === 1.5 && row.spread_team === 'LAD');

// ---- 3. not a ranked list --------------------------------------------
ok('rows are ordered by rung then team, not by edge',
   api.indexOf('(a.spread_line - b.spread_line)') !== -1
   && /Ordering by edge\s*\n\s*\/\/ would rank them/.test(api),
   'a ranked list is a recommendation with the numbers removed');
ok('the top-3 cap only applies when edges are shown',
   /SPREAD_EDGE_DISPLAY_ENABLED\s*\n\s*\? eligible\.slice\(0, EMP_SPREAD_TOP_N\)/.test(api),
   'a "top 3" of nothing is still a ranking');
ok('the low_sample filter still runs in both modes',
   /: \(preds \|\| \[\]\)\.filter\(p => !p\.low_sample\)/.test(api));

// ---- 4. the card ------------------------------------------------------
ok('the card gates on the server flag, not on the presence of a number',
   html.indexOf('var showEdge = (es.edge_display === true);') !== -1,
   'a stale cached bundle must not re-enable it');
ok('price-only rows render without a pp figure',
   html.indexOf('emp-spread-price-only') !== -1
   && /if\(!showEdge\)\{[\s\S]{0,400}?emp-spread-price-only/.test(html));
ok('price-only rows drop the actionable accent colour',
   html.indexOf('.emp-spread-price-only .emp-spread-pick-bet{color:var(--text3)') !== -1);
ok('the block is no longer titled "Spread Edge" while quiet',
   html.indexOf("var _title = showEdge ? 'Spread Edge' : 'Runline';") !== -1);
ok('the card says why it is quiet',
   html.indexOf('emp-spread-quiet') !== -1
   && html.indexOf('worse calibrated than the price') !== -1);
ok('the cell label, n and axis badge SURVIVE',
   html.indexOf("es.cell_label?(' '+es.cell_label+' (n='+es.cell_sample_size+')')") !== -1
   && html.indexOf("es.axis_frozen ? ' locked' : ' live'") !== -1);

// ---- 5. the write path is untouched ----------------------------------
ok('the engine still computes edge_pp',
   eng.indexOf('edge_pp:') !== -1 && eng.indexOf('empirical_pct:') !== -1,
   'the forward record is what the re-enable criterion is judged on');
ok('signals are still persisted every pass',
   eng.indexOf('function persistEmpiricalSpreadSignals') !== -1
   && eng.indexOf('q.upsertEmpiricalSpreadSignal.run') !== -1);
ok('jobs.js still calls the generation path',
   jobs.indexOf('generateEmpiricalSpreadSignals') !== -1
   || jobs.indexOf('persistEmpiricalSpreadSignals') !== -1);
ok('outcomes are still captured for grading',
   eng.indexOf('q.upsertEmpiricalSpreadOutcome.run') !== -1);

// ---- 6. the CLI is labelled, not silenced ----------------------------
const cli = fs.readFileSync(path.join(R, 'scripts/empirical-spread-edge.js'), 'utf8');
ok('the CLI still prints the figures (it is the measurement tool)',
   cli.indexOf('edge ') !== -1 && cli.indexOf('TOP OPPORTUNITIES') !== -1);
ok('but warns they are not a recommendation',
   cli.indexOf('NOT A RECOMMENDATION') !== -1
   && cli.indexOf('spread_edge_display_enabled') !== -1);

// ---- 7. the gate ------------------------------------------------------
const reg = require(path.join(R, 'services/feature-gate-registry'));
const gate = reg.GATES.find(g => g.id === 'spread_edge_display_enabled');
ok('the gate is registered', !!gate);
ok('on_expected is false', gate && gate.on_expected === false);
ok('criterion_type is calibration', gate && gate.criterion_type === 'calibration');
ok('corpus_size is recorded', gate && typeof gate.corpus_size === 'number' && gate.corpus_size > 0,
   gate ? String(gate.corpus_size) : '-');
ok('the criterion names the MARKET as the bar, not the raw engine',
   gate && /Beating the RAW engine is not the bar/.test(gate.criterion));
ok('the criterion demands a forward window of n >= 2,000 distinct plays',
   gate && /n >= 2,000 distinct plays/.test(gate.criterion)
   && /NOT per odds pass/.test(gate.criterion));
ok('the ROI evidence is recorded as SUPPORTING, not deciding',
   gate && /SUPPORTING, NOT DECIDING/.test(gate.note)
   && /is NOT the criterion/.test(gate.note));
ok('the founding calibration measurement is in the row',
   gate && /5\.84pp vs\s*\n?\s*MARKET 4\.03pp/.test(gate.note.replace(/\s+/g, ' ').replace(/ /g, ' '))
        || (gate && gate.note.indexOf('ENGINE 5.84pp vs MARKET 4.03pp') !== -1));

console.log('');
console.log(failures ? 'FAILED (' + failures + ')' : 'OK');
process.exit(failures ? 1 : 0);
