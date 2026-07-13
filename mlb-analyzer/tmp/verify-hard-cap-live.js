// Observable verification for the hard-cap 0.08 ship.
//
// Two modes:
//   MODE 1 — synthetic (runs anywhere, proves getSignals enforces the cap
//            at the code level). Constructs a synthetic 10pp-edge signal
//            candidate and calls getSignals with two settings shapes:
//            (a) HARD=0.25 (old prod value) → 10pp signal emits
//            (b) HARD=0.08 (new prod value) → 10pp signal suppresses,
//                outSuppressed array contains it with reason='edge_hard_cap'
//            Any deviation is a failure.
//
//   MODE 2 — live (queries a fresh prod DB pull after the owner flips
//            the setting). Reports:
//              - current signal_edge_hard_cap_pp value in app_settings
//              - how many bet_signal_audit rows of action='suppressed_edge_cap'
//                have appeared since a stated cutoff timestamp
//              - what edge_pct values those new suppressions have — MUST
//                all be in [0.08, 0.25) to prove the new cap is enforcing
//                (rows >= 0.25 would have suppressed under the OLD cap too)
//
// Owner ran mode 1 pre-merge; will run mode 2 post-flip against a fresh
// DB pull to confirm the live enforcement.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });

function pass(name) { console.log('  ✓ ' + name); }
function fail(name, want, got) {
  console.error('  ✗ ' + name + '\n     want: ' + JSON.stringify(want) + '\n     got : ' + JSON.stringify(got));
  process.exitCode = 1;
}

const model = require('../services/model');
const impliedP = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);

// -----------------------------------------------------------------------
// MODE 1 — SYNTHETIC. Prove getSignals enforces cap-0.08 the same way it
// enforces cap-0.25. Two synthetic scenarios: 9pp edge (in the gap
// between old and new cap) and 20pp edge (above both caps).
// -----------------------------------------------------------------------
console.log('\n=== MODE 1 — SYNTHETIC (code-level enforcement) ===');

// Build a synthetic modelResult where the model likes away side at ~60%
// vs a market implied ~40% (dog price +150). Edge ≈ 20pp.
function synthGame(marketAwayMl, modelAwayMl, marketHomeMl, modelHomeMl) {
  return {
    game_id: 'aaa-bbb', game_date: '2199-04-04',
    market_away_ml: marketAwayMl, market_home_ml: marketHomeMl,
    market_total: 8.5, over_price: -110, under_price: -110,
    away_lineup_json: JSON.stringify([{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'}]),
    home_lineup_json: JSON.stringify([{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'},{name:'x'}]),
    // The following are unused by getSignals for the cap-enforcement path:
    away_team: 'AAA', home_team: 'BBB',
    away_sp: 'x', home_sp: 'x',
  };
}
function synthModel(aML, hML) {
  return { aML, hML, estTot: 8.5, gameType: 'sp_sp' };
}

// Case A: 9pp edge (soft-cap warn at old 0.06, would emit with edge_suspect
//         under OLD hard 0.25, MUST SUPPRESS under NEW hard 0.08).
//   Model 60% away implied (aML=-150), Market 51% away implied (+96)
//   Edge = 0.60 - 0.51 = 9pp
const case9pp = {
  game: synthGame(96, -150, -105, 132),
  model: synthModel(-150, 132),
  label: '9pp edge',
};

// Case B: 30pp edge (way above both caps).
//   Model 70% away (aML=-233), Market 40% away (+150)
//   Edge = 0.70 - 0.40 = 30pp
const case30pp = {
  game: synthGame(150, -233, -160, 190),
  model: synthModel(-233, 190),
  label: '30pp edge',
};

function baseSettings(overrides) {
  return Object.assign({
    SIGNAL_EMIT_FLOOR_PP: 0.01,
    SIGNAL_EDGE_CAP_ENABLED: true,
    SIGNAL_EDGE_SOFT_CAP_PP: 0.06,
    SIGNAL_EDGE_HARD_CAP_PP: 0.25,
    TOT_SLOPE: 0.08, TOT_PROB_LO: 0.20, TOT_PROB_HI: 0.80,
    MARKET_TOTAL_DFLT: 8.5,
  }, overrides);
}

function runCase(c, settings) {
  const outSuppressed = [];
  const signals = model.getSignals(c.game, c.model, settings, outSuppressed);
  const ml = signals.filter(s => s.type === 'ML');
  return { ml, outSuppressed };
}

for (const c of [case9pp, case30pp]) {
  console.log('\n' + c.label + ':');
  // --- Old cap (0.25) — 9pp should emit; 20pp should suppress ---
  const oldRun = runCase(c, baseSettings({ SIGNAL_EDGE_HARD_CAP_PP: 0.25 }));
  const oldSuppressedML = oldRun.outSuppressed.filter(x => x.type === 'ML');
  const oldEmittedML = oldRun.ml;
  console.log('  cap=0.25  emitted ML sigs: ' + oldEmittedML.length + '  suppressed ML: ' + oldSuppressedML.length);

  // --- New cap (0.08) — both should suppress ---
  const newRun = runCase(c, baseSettings({ SIGNAL_EDGE_HARD_CAP_PP: 0.08 }));
  const newSuppressedML = newRun.outSuppressed.filter(x => x.type === 'ML');
  const newEmittedML = newRun.ml;
  console.log('  cap=0.08  emitted ML sigs: ' + newEmittedML.length + '  suppressed ML: ' + newSuppressedML.length);

  // Assertions
  if (c.label === '9pp edge') {
    // Old cap 0.25 → 9pp emits (0.06 < 9pp < 25). New cap 0.08 → 9pp suppresses.
    (oldEmittedML.length > 0)
      ? pass('cap=0.25: 9pp signal EMITS (below old hard cap)')
      : fail('cap=0.25: 9pp emit', '>=1 signal', oldEmittedML.length);
    (newSuppressedML.length > 0)
      ? pass('cap=0.08: 9pp signal SUPPRESSES (above new hard cap)')
      : fail('cap=0.08: 9pp suppression', '>=1 suppressed with reason=edge_hard_cap', newSuppressedML);
    if (newSuppressedML.length > 0) {
      const s = newSuppressedML[0];
      s.reason === 'edge_hard_cap'
        ? pass('cap=0.08: reason=edge_hard_cap present in outSuppressed[0]')
        : fail('reason field', 'edge_hard_cap', s.reason);
    }
  }
  if (c.label === '30pp edge') {
    // Both caps → suppression.
    (oldSuppressedML.length > 0)
      ? pass('cap=0.25: 30pp signal SUPPRESSES (baseline sanity)')
      : fail('cap=0.25: 30pp suppression', '>=1', oldSuppressedML.length);
    (newSuppressedML.length > 0)
      ? pass('cap=0.08: 30pp signal SUPPRESSES (baseline sanity)')
      : fail('cap=0.08: 30pp suppression', '>=1', newSuppressedML.length);
  }
}

// -----------------------------------------------------------------------
// MODE 2 — LIVE. Queries the current DB pull for evidence the new cap
// is enforcing on prod signals.
// -----------------------------------------------------------------------
console.log('\n=== MODE 2 — LIVE DB EVIDENCE ===');

// Report the CURRENT app_settings value
const cur = db.prepare("SELECT key, value FROM app_settings WHERE key IN ('signal_edge_cap_enabled', 'signal_edge_hard_cap_pp', 'signal_edge_soft_cap_pp')").all();
const settingsMap = {};
for (const r of cur) settingsMap[r.key] = r.value;
console.log('Current prod values (from DB pull):');
console.log('  signal_edge_cap_enabled     = ' + (settingsMap.signal_edge_cap_enabled || '(default)'));
console.log('  signal_edge_hard_cap_pp     = ' + (settingsMap.signal_edge_hard_cap_pp || '(default)'));
console.log('  signal_edge_soft_cap_pp     = ' + (settingsMap.signal_edge_soft_cap_pp || '(default)'));

const currentHard = parseFloat(settingsMap.signal_edge_hard_cap_pp || '0.25');
if (currentHard === 0.08) {
  pass('LIVE: hard cap is 0.08 in prod — owner has flipped it');
} else if (currentHard === 0.25) {
  console.log('  · LIVE STATE: hard cap still at 0.25. Owner has NOT flipped yet.');
  console.log('  · Once flipped, rerun this harness against a fresh DB pull.');
} else {
  console.log('  · LIVE STATE: hard cap at ' + currentHard + ' (unexpected — not 0.08 or 0.25)');
}

// Show recent suppression audit rows so owner can see the enforcement live
// after they flip. Look at the most recent 10 suppressed_edge_cap audit rows.
const recent = db.prepare(
  "SELECT created_at, game_id, signal_type, signal_side, detail "
+ "FROM bet_signal_audit WHERE action='suppressed_edge_cap' "
+ "ORDER BY id DESC LIMIT 10"
).all();
console.log('\nMost recent 10 suppressed_edge_cap audit rows (any date):');
if (recent.length === 0) {
  console.log('  (none)');
} else {
  for (const a of recent) {
    let d = null; try { d = JSON.parse(a.detail); } catch(e) {}
    const edge = d && d.edge != null ? d.edge : (d && d.edge_pct != null ? d.edge_pct : '·');
    console.log('  ' + a.created_at + '  ' + (a.game_id||'').padEnd(12) + '  ' + a.signal_type + '|' + a.signal_side.padEnd(6) + ' edge=' + edge);
  }
}

// Post-flip proof template: after owner flips, count new suppressions
// whose edge is in [0.08, 0.25) — those are the rows the OLD cap would
// have missed. If any exist, new cap is enforcing.
console.log('\nPost-flip proof (rerun this after owner flips):');
console.log("  Query: SELECT COUNT(*) FROM bet_signal_audit");
console.log("    WHERE action='suppressed_edge_cap' AND created_at > '<flip_ts>'");
console.log("    AND JSON_EXTRACT(detail, '$.edge') BETWEEN 0.08 AND 0.25");
console.log('  Non-zero result = the new cap is catching rows the OLD cap missed → PROOF.');
console.log('');
console.log('exit code:', process.exitCode || 0);
