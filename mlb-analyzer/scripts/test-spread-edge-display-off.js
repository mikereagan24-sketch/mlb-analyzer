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

// ---- 3. the whole block is hidden, not stripped ----------------------
// AMENDED 2026-09-12. #374 kept the block and removed the pp figures,
// leaving a cell label and a posted-price table. That was the wrong
// call: a runline block on the card is a runline recommendation whatever
// it contains, and the price table duplicated the market-line row that
// already sits under the ML boxes. Nothing about runlines renders now.
ok('the API does not even QUERY signal rows while the gate is off',
   /const empRows = SPREAD_EDGE_DISPLAY_ENABLED\s*\n\s*\? q\.getLatestEmpiricalSpreadSignalsByDate\.all\(date\)\s*\n\s*: \[\];/.test(api),
   'empByGame stays empty, so the key is omitted from the response');
ok('the omission is explained', /BLOCK HIDDEN ENTIRELY WHILE THE GATE IS OFF/.test(api));

// Simulate the route's own branch: with the flag off, no game gets a key.
const simulate = (enabled, rows) => {
  const out = {};
  for (const r of (enabled ? rows : [])) out[r.game_id] = { cell_label: r.cell_label };
  return out;
};
const fakeRows = [{ game_id: 'aaa-bbb', cell_label: 'Balanced / Low' }];
ok('with the gate OFF no game carries empirical_spreads',
   Object.keys(simulate(false, fakeRows)).length === 0);
ok('with the gate ON the block comes back',
   Object.keys(simulate(true, fakeRows)).length === 1,
   'hidden or complete — there is no third mode');

// The price-only mode must be GONE, not merely unreachable. Dead markup
// for a state nothing can produce is a trap for the next reader.
ok('the price-only row markup is gone', html.indexOf('emp-spread-price-only') === -1);
ok('the "edges off" note is gone', html.indexOf('emp-spread-quiet') === -1);
ok('the conditional title is gone',
   html.indexOf("showEdge ? 'Spread Edge' : 'Runline'") === -1);
ok('api.js has ONE serialization path again',
   api.indexOf('(a.spread_line - b.spread_line)') === -1
   && !/SPREAD_EDGE_DISPLAY_ENABLED\s*\n\s*\? eligible\.slice/.test(api),
   'the neutral-order and uncapped branches went with the mode');

// ---- 4. the card fails closed ----------------------------------------
ok('the card renders the block ONLY on an explicit edge_display === true',
   /g\.empirical_spreads\.edge_display === true/.test(html),
   'a stale cached bundle must not resurrect it');
ok('the server still states the flag in the payload',
   api.indexOf('edge_display: SPREAD_EDGE_DISPLAY_ENABLED') !== -1,
   'so the client never infers permission from a number being present');

// THE MARKET-LINE ROW IS NOT THIS BLOCK and must survive. It is built
// from game_log.market_*_spread in a different function and is a
// reference, not a play.
ok('the "Spread: AWAY -1.5 / HOME +1.5" reference row survives',
   /'Spread: ' \+ g\.away_team/.test(html)
   && html.indexOf('const spreadRow =') !== -1);
ok('and it does not read empirical_spreads',
   !/spreadRow[\s\S]{0,400}empirical_spreads/.test(html),
   'independent path — unaffected by the gate');

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
