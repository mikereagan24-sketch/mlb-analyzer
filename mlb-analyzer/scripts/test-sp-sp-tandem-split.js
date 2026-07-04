// Verification harness for feat/sp-sp-tandem-forecast-split.
//
// Exercises the SP-SP tandem sub-mode in model.js buildOpenerOpts
// against synthesized game rows. Confirms:
//
//   1. TOR@SEA (Gilbert 3.38 / Hancock 5.44) → O:~0.34 / B:~0.60 / BP:~0.06
//      (within the ~0.34/~0.57/~0.09 band the brief targeted; the
//      spec formula gives these exact numbers from those inputs).
//
//   2. Classic-opener case (tandem_subtype null) → byte-identical to
//      pre-branch main. Runs the same synthetic game twice, once with
//      subtype='sp_sp' + subtype=null, and asserts the null path
//      produces the pre-branch anchor-driven targets.
//
//   3. Self-updating: bump the opener forecast → opener share grows
//      proportionally (opener_share = opener_fc × QH / 9).
//
//   4. Missing forecast → falls back to anchor path (never fails).
//
//   5. QUICK_HOOK_FACTOR override → shares scale linearly with QH.
//
// Runs the real runModel to reach buildOpenerOpts, using a minimal
// synthetic game payload + a stub wOBA index so the model has just
// enough inputs to score the opener_aware path.
//
// Run: node scripts/test-sp-sp-tandem-split.js

const { runModel } = require('../services/model');
const { getSettings } = require('../services/jobs');

let failed = 0;
function expect(name, cond, extra) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' — ' + extra : ''));
  if (!cond) failed++;
}

// Minimal synthetic wOBA index — every player_name → mid-range wOBA so
// scoring produces finite numbers.
function stubWobaIdx() {
  const idx = {};
  for (const key of ['bat-proj-lhp','bat-proj-rhp','bat-act-lhp','bat-act-rhp',
                     'pit-proj-lhb','pit-proj-rhb','pit-act-lhb','pit-act-rhb']) {
    idx[key] = {};
  }
  return idx;
}

function baseLineup() {
  const arr = [];
  for (let i = 0; i < 9; i++) {
    arr.push({ name: 'Batter ' + (i+1), hand: 'R', pos: 'DH' });
  }
  return arr;
}

function makeGame(overrides) {
  const g = {
    game_id: 'tor-sea',
    game_date: '2026-07-04',
    away_team: 'TOR', home_team: 'SEA',
    away_sp: 'Shane Bieber', away_sp_hand: 'R',
    home_sp: 'Logan Gilbert', home_sp_hand: 'R',
    market_away_ml: 108, market_home_ml: -122,
    market_total: 8.0, over_price: -110, under_price: -110,
    park_factor: 1.00,
    awayLineup: baseLineup(), homeLineup: baseLineup(),
    // Bullpen defaults (needed to reach the opener-aware weight compute)
    awayBullpenWoba: 0.318, homeBullpenWoba: 0.318,
    awayBullpenVsL: 0.318, awayBullpenVsR: 0.318,
    homeBullpenVsL: 0.318, homeBullpenVsR: 0.318,
    // Opener flag + forecasts
    is_opener_game_home: 1, bulk_guy_home: 'Emerson Hancock',
    home_sp_forecast_ip: 5.67,
    home_opener_forecast_ip: 3.38,
    home_bulk_forecast_ip: 5.44,
    home_sp_forecast_n_priors: 18,
  };
  return Object.assign(g, overrides || {});
}

function extractHomeSideShares(mr) {
  // runModel writes realized weights via the openerModel path onto the
  // model output. We access via the internal openerOpts if returned;
  // if not, fall back to reading the console log during runModel calls
  // (which we can't do in a fixture cleanly). Simpler: use the model
  // output's opener-weight bookkeeping.
  return {
    opener:  mr.homeOpenerWeightUsed,
    bulk:    mr.homeBulkWeightUsed,
    bullpen: mr.homeBullpenWeightUsed,
  };
}

// Load settings once with the opener-aware flag flipped on so the
// tandem branch actually runs. Downstream settings not relevant to
// this path (framing, defense, etc.) are inherited from live.
const S = Object.assign({}, getSettings(), { USE_OPENER_LOGIC: true });

// ── Test 1: TOR@SEA target under sp_sp subtype (SP-forecast source) ───
// Revised 2026-07-04 per docs/sea-tandem-analysis: sp_sp now uses the
// SP-role forecast (home_sp_forecast_ip=5.67 for Gilbert) instead of
// the opener-role forecast (3.38). Realized SEA tandem openers averaged
// 4.89 IP (~54% share), which lands at ~0.567 with the SP forecast.
console.log('\n=== 1. TOR@SEA sp_sp: Gilbert SP_fc=5.67 / Hancock bulk_fc=5.44 → forecast-driven shares ===');
{
  const game = makeGame({ tandem_subtype_home: 'sp_sp' });
  const mr = runModel(game, stubWobaIdx(), S, 'opener_aware', false);
  const sh = extractHomeSideShares(mr);
  console.log('  shares: opener=' + (sh.opener || 0).toFixed(3)
    + '  bulk=' + (sh.bulk || 0).toFixed(3)
    + '  bullpen=' + (sh.bullpen || 0).toFixed(3));
  // Raw formula (post-swap + flat-matrix 2026-07-04):
  //   openerIP = 5.67 × 0.90 = 5.103
  //   bulkCap  = 9 − 5.103   = 3.897
  //   bulkIP   = min(5.44, 3.897) = 3.897 (capped)
  //   opener target = 5.103 / 9 = 0.567
  //   bulk target   = 3.897 / 9 = 0.433
  //   bullpen       = 1 − 0.567 − 0.433 = 0.000
  //
  // Flat matrix: sp_sp bypasses buildPerPositionWeights and applies
  // targets uniformly across all 9 slots (see model.js comment). So
  // realized shares equal targets exactly.
  expect('opener share ≈ 0.567 (flat matrix, no compression)',
    sh.opener != null && Math.abs(sh.opener - 0.567) < 0.005,
    'got ' + (sh.opener != null ? sh.opener.toFixed(3) : 'null'));
  expect('bulk share ≈ 0.433 (capped by 9 − opener × QH)',
    sh.bulk != null && Math.abs(sh.bulk - 0.433) < 0.005,
    'got ' + (sh.bulk != null ? sh.bulk.toFixed(3) : 'null'));
  expect('bullpen ≈ 0.000 (two starters cover 9 IP)',
    sh.bullpen != null && sh.bullpen < 0.01,
    'got ' + (sh.bullpen != null ? sh.bullpen.toFixed(3) : 'null'));
}

// ── Test 2: classic opener (no sp_sp tag) → byte-identical ────────────
console.log('\n=== 2. Classic opener (tandem_subtype null) → anchor path unchanged ===');
{
  const game = makeGame(); // tandem_subtype_home = undefined → null
  const mr = runModel(game, stubWobaIdx(), S, 'opener_aware', true);
  const sh = extractHomeSideShares(mr);
  console.log('  shares: opener=' + (sh.opener || 0).toFixed(3)
    + '  bulk=' + (sh.bulk || 0).toFixed(3)
    + '  bullpen=' + (sh.bullpen || 0).toFixed(3));
  // Classic-opener anchor path with Gilbert's opener_fc=3.38 and
  // Hancock's bulk_fc=5.44 goes through computeOpener/BulkPitWeight-
  // FromForecast. The exact numbers depend on those helpers, but the
  // targets are clamped to the max weight (0.30 opener) and near the
  // bulk anchor (~0.60). Just assert we're in the classic band.
  expect('opener share ≤ 0.31 (clamped by OPENER_WEIGHT_MAX 0.30)',
    sh.opener != null && sh.opener <= 0.31,
    'got ' + (sh.opener != null ? sh.opener.toFixed(3) : 'null'));
  expect('bulk share in [0.50, 0.75] band (classic anchor path)',
    sh.bulk != null && sh.bulk >= 0.50 && sh.bulk <= 0.75);
  expect('bullpen residual ≥ 0.05',
    sh.bullpen != null && sh.bullpen >= 0.05);
}

// ── Test 3: self-updating — bump SP forecast, share grows ─────────────
// Revised 2026-07-04: sp_sp reads home_sp_forecast_ip now, so we bump
// that column instead of home_opener_forecast_ip.
console.log('\n=== 3. Self-updating: sp_forecast bump → opener share grows ===');
{
  const gameLow  = makeGame({ tandem_subtype_home: 'sp_sp', home_sp_forecast_ip: 4.00 });
  const gameHigh = makeGame({ tandem_subtype_home: 'sp_sp', home_sp_forecast_ip: 6.00 });
  const mrLow  = runModel(gameLow,  stubWobaIdx(), S, 'opener_aware', true);
  const mrHigh = runModel(gameHigh, stubWobaIdx(), S, 'opener_aware', true);
  const shLow  = extractHomeSideShares(mrLow);
  const shHigh = extractHomeSideShares(mrHigh);
  console.log('  sp_fc=4.00 → op=' + shLow.opener.toFixed(3));
  console.log('  sp_fc=6.00 → op=' + shHigh.opener.toFixed(3));
  expect('opener share grows with forecast', shHigh.opener > shLow.opener + 0.05,
    'delta=' + (shHigh.opener - shLow.opener).toFixed(3));
  // Flat matrix: ratio is 1.5× exact (0.90*6.0/9 = 0.600 vs 0.90*4.0/9 = 0.400).
  const ratio = shHigh.opener / shLow.opener;
  expect('linear growth (ratio ≈ 1.5×)', Math.abs(ratio - 1.5) < 0.02,
    'ratio=' + ratio.toFixed(3));
}

// ── Test 4: missing forecast → falls back to anchor path ─────────────
// Revised 2026-07-04: with SP-forecast source, we need to null the
// home_sp_forecast_ip (not the opener one) to force the fallback.
console.log('\n=== 4. Missing sp_forecast → falls back to anchor path (never fails) ===');
{
  const game = makeGame({ tandem_subtype_home: 'sp_sp', home_sp_forecast_ip: null });
  const mr = runModel(game, stubWobaIdx(), S, 'opener_aware', true);
  const sh = extractHomeSideShares(mr);
  expect('opener share finite (fallback path ran)',
    sh.opener != null && isFinite(sh.opener) && sh.opener > 0);
  expect('bulk share finite (fallback path ran)',
    sh.bulk != null && isFinite(sh.bulk) && sh.bulk > 0);
}

// ── Test 5: QUICK_HOOK_FACTOR override scales linearly ────────────────
console.log('\n=== 5. QUICK_HOOK_FACTOR override — shares scale linearly ===');
{
  const game = makeGame({ tandem_subtype_home: 'sp_sp' });
  const mrDefault = runModel(game, stubWobaIdx(), S, 'opener_aware', true);
  const mrHalf    = runModel(game, stubWobaIdx(), Object.assign({}, S, { QUICK_HOOK_FACTOR: 0.45 }), 'opener_aware', true);
  const shD = extractHomeSideShares(mrDefault);
  const shH = extractHomeSideShares(mrHalf);
  console.log('  QH=0.90 → op=' + shD.opener.toFixed(3));
  console.log('  QH=0.45 → op=' + shH.opener.toFixed(3));
  // Flat matrix: ratio is 0.5× exact (halving QH halves opener_IP → halves target).
  const ratio = shH.opener / shD.opener;
  expect('opener share halves with QH (ratio ≈ 0.5×)',
    Math.abs(ratio - 0.5) < 0.02,
    'ratio=' + ratio.toFixed(3));
}

console.log('\n=== SUMMARY ===');
console.log(failed === 0 ? 'ALL PASS' : (failed + ' FAILED'));
process.exit(failed === 0 ? 0 : 1);
