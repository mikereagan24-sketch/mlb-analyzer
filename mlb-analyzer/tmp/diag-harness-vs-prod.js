// Diagnostic: harness (sweep-pyth-exp.js re-scoring) vs prod (stored
// bet_signals) game-by-game comparison to explain the 17pp Val Jul book
// ROI gap (harness +11.90% vs prod actual ~-5%).
//
// For 10 specific resolved Jul games, print side-by-side:
//   - Prod bet_signals: signal_side, market_line (post-#172 clean),
//     closing_line, edge_pct (stored), price_venue, outcome, pnl
//   - Harness re-run: signal_side, edge_pp_recomputed, marketLineOnSide
//     (from game_log.market_*_ml at 1.83 baseline exponent), outcome
//   - Delta: where did the two produce different signals? Same games with
//     same outcomes → what's the market_line vs venue-net divergence?
//
// Then categorize the gap causes:
//   (A) Different market prices: prod bet_signals.market_line vs harness
//       game_log.market_*_ml. Post-#172 these SHOULD match (both frozen at
//       odds_locked_at from same source). Confirmed diff is the venue-
//       aware ML override that runs INSIDE processGameSignals but NOT
//       inside runModel+getSignals directly.
//   (B) Look-ahead wOBA: harness uses today's woba_data (season cumulative);
//       prod at emit time used as-of-date rollup.
//   (C) Signal-emission differences: harness signals population != prod
//       signals population. Some games prod emitted, harness doesn't; some
//       vice versa.
//   (D) Settings drift: check every relevant setting matches app_settings.

const path = require('path');
process.env.DB_PATH = path.join(__dirname, '..', 'data', 'mlb.db');
const db = require('better-sqlite3')(process.env.DB_PATH, { readonly: true });
const model = require('../services/model');
const jobs = require('../services/jobs');

console.log('DB snapshot:', db.prepare("SELECT datetime('now') n").get().n, 'UTC');

// Sanity: prod settings snapshot
const promptSettings = jobs.getSettings();
console.log('\nprompt settings (subset relevant to sweep vs prod):');
const relevantKeys = ['PYTH_EXP','W_PROJ','W_ACT','W_PIT','W_BAT','HFA_BOOST','RUN_MULT','SIGNAL_VENUE_AWARE_ENABLED','SIGNAL_EMIT_FLOOR_PP','SIGNAL_EDGE_CAP_ENABLED','SIGNAL_EDGE_HARD_CAP_PP','SIGNAL_EDGE_SOFT_CAP_PP','KALSHI_DIRECT_PRIMARY_ENABLED','KALSHI_DIRECT_TOTALS_ENABLED','PARK_NEUTRAL_INPUTS_ENABLED','CATCHER_FRAMING_ENABLED'];
for (const k of relevantKeys) console.log('  ' + k.padEnd(32) + ' = ' + JSON.stringify(promptSettings[k]));

// Pick 10 resolved Jul games with prod ML signals (any cohort, clean of corrupted)
const targetGames = db.prepare(
  "SELECT DISTINCT gl.game_date, gl.game_id, gl.market_away_ml, gl.market_home_ml, "
+ "  gl.away_score, gl.home_score, gl.odds_locked_at "
+ "FROM game_log gl "
+ "JOIN bet_signals bs ON bs.game_date=gl.game_date AND bs.game_id=gl.game_id "
+ "WHERE gl.away_score IS NOT NULL "
+ "  AND gl.game_date >= '2026-07-01' "
+ "  AND bs.signal_type='ML' "
+ "  AND bs.closing_line IS NOT NULL "
+ "  AND gl.market_away_ml IS NOT NULL "
+ "  AND gl.away_lineup_json IS NOT NULL "
+ "  AND gl.game_date NOT IN ('2026-07-06','2026-07-07','2026-07-10','2026-07-11') "
+ "ORDER BY RANDOM() LIMIT 10"
).all();
console.log('\nSample games (n=' + targetGames.length + ')');

const impliedP = ml => ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100);
const wobaIdx = jobs.getWobaIndex();

// Reuse the sweep-pyth-exp buildGame pattern
function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function buildGame(gameRow, settings) {
  var parts = (gameRow.game_id || '').split('-');
  var awayAbbr = parts[0] || '';
  var homeAbbr = parts[1] || '';
  var awaySp = gameRow.away_sp || '';
  var homeSp = gameRow.home_sp || '';
  var wProj = settings.W_PROJ != null ? settings.W_PROJ : 0.65;
  var wAct  = settings.W_ACT  != null ? settings.W_ACT  : 0.35;
  var bpSR  = 0.55, bpWR  = 0.45, bpSL  = 0.35, bpWL  = 0.65;
  var LEAGUE_BP = 0.318;
  var awayVsR = LEAGUE_BP, awayVsL = LEAGUE_BP, homeVsR = LEAGUE_BP, homeVsL = LEAGUE_BP;
  var awayBpWoba = LEAGUE_BP, homeBpWoba = LEAGUE_BP;
  const q = require('../db/schema').q;
  try {
    if (q.getBullpenWobaBlended) {
      var hLU = tryParse(gameRow.home_lineup_json) || [];
      var aLU = tryParse(gameRow.away_lineup_json) || [];
      var aBp = q.getBullpenWobaBlended(awayAbbr, awaySp, hLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      var hBp = q.getBullpenWobaBlended(homeAbbr, homeSp, aLU, bpSR, bpWR, bpSL, bpWL, wProj, wAct, gameRow.game_date);
      if (aBp && aBp.vsRHB) awayVsR = aBp.vsRHB;
      if (aBp && aBp.vsLHB) awayVsL = aBp.vsLHB;
      if (hBp && hBp.vsRHB) homeVsR = hBp.vsRHB;
      if (hBp && hBp.vsLHB) homeVsL = hBp.vsLHB;
      awayBpWoba = (aBp && aBp.woba) || LEAGUE_BP;
      homeBpWoba = (hBp && hBp.woba) || LEAGUE_BP;
    }
  } catch (e) {}
  return Object.assign({}, gameRow, {
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
    awayBullpenWoba: awayBpWoba, homeBullpenWoba: homeBpWoba,
    awayBullpenVsR: awayVsR, awayBullpenVsL: awayVsL,
    homeBullpenVsR: homeVsR, homeBullpenVsL: homeVsL,
  });
}

let ambiguous = 0, matched = 0, prodOnly = 0, harnessOnly = 0;
console.log('\n' + '='.repeat(120));
console.log('PER-GAME COMPARISON');
console.log('='.repeat(120));

// For each target game — pull the FULL game_log row
for (const target of targetGames) {
  const gRow = db.prepare("SELECT * FROM game_log WHERE game_date=? AND game_id=?").get(target.game_date, target.game_id);
  console.log('\n' + target.game_date + ' ' + target.game_id +
    '  final ' + target.away_score + '-' + target.home_score +
    '  market_away_ml=' + target.market_away_ml + '  market_home_ml=' + target.market_home_ml);

  // PROD side: bet_signals rows (ML only) for this game
  const prodSigs = db.prepare(
    "SELECT signal_side, market_line, closing_line, model_line, edge_pct, price_venue, venue_stale, outcome, pnl "
  + "FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type='ML' AND is_active=1"
  ).all(target.game_date, target.game_id);
  console.log('  PROD bet_signals:');
  if (prodSigs.length === 0) console.log('    (none)');
  for (const s of prodSigs) {
    console.log('    side=' + s.signal_side.padEnd(5) +
      ' market_line=' + String(s.market_line).padStart(5) +
      ' closing_line=' + String(s.closing_line).padStart(5) +
      ' model_line=' + String(s.model_line).padStart(5) +
      ' edge_pct=' + s.edge_pct +
      ' venue=' + (s.price_venue||'·') +
      ' stale=' + s.venue_stale +
      ' outcome=' + s.outcome +
      ' pnl=' + s.pnl);
  }

  // HARNESS side: run model at pyth_exp=1.83 (matches prod live)
  try {
    const built = buildGame(gRow, promptSettings);
    const mr = model.runModel(built, wobaIdx, promptSettings, 'standard', true);
    if (!mr || mr.aML == null || mr.hML == null) {
      console.log('  HARNESS: runModel returned null (suppressed) — no signal emitted');
      continue;
    }
    const sigs = model.getSignals(built, mr, promptSettings);
    const mlSigs = sigs.filter(s => s.type === 'ML');
    console.log('  HARNESS model output: aML=' + mr.aML + '  hML=' + mr.hML + '  → emitted ML sigs:', mlSigs.length);
    for (const s of mlSigs) {
      // Recompute edge vs game_log market to match harness scorer
      const marketMlForSide = s.side === 'away' ? gRow.market_away_ml : gRow.market_home_ml;
      const modelMlForSide = s.side === 'away' ? mr.aML : mr.hML;
      const edgePP = Math.max(0, impliedP(modelMlForSide) - impliedP(marketMlForSide)) * 100;
      console.log('    side=' + s.side.padEnd(5) +
        ' marketLine(sig)=' + s.marketLine +
        ' modelLine(sig)=' + s.modelLine +
        ' edge(sig)=' + s.edge.toFixed(4) +
        ' edge_pp(recomp)=' + edgePP.toFixed(1) +
        ' suspect=' + (s.edge_suspect||false));
    }

    // Categorize
    const prodSides = new Set(prodSigs.map(s => s.signal_side));
    const harnessSides = new Set(mlSigs.map(s => s.side));
    const bothSides = new Set([...prodSides].filter(x => harnessSides.has(x)));
    const onlyProd = new Set([...prodSides].filter(x => !harnessSides.has(x)));
    const onlyHarness = new Set([...harnessSides].filter(x => !prodSides.has(x)));
    if (bothSides.size > 0 && onlyProd.size === 0 && onlyHarness.size === 0) matched++;
    if (onlyProd.size > 0) prodOnly++;
    if (onlyHarness.size > 0) harnessOnly++;
    if (bothSides.size > 0 && (onlyProd.size > 0 || onlyHarness.size > 0)) ambiguous++;
  } catch (e) {
    console.log('  HARNESS ERROR: ' + e.message.slice(0, 100));
  }
}

console.log('\n' + '='.repeat(120));
console.log('SUMMARY: matched=' + matched + '  prod-only=' + prodOnly + '  harness-only=' + harnessOnly + '  both-with-diff=' + ambiguous);
console.log('='.repeat(120));

// Also check: what's the game_log.market_away_ml vs bet_signals.market_line agreement rate for JUL?
const compareRows = db.prepare(
  "SELECT bs.game_date, bs.game_id, bs.signal_side, bs.market_line AS bs_ml, bs.closing_line AS bs_cl, bs.price_venue, "
+ "       gl.market_away_ml AS gl_a, gl.market_home_ml AS gl_h "
+ "FROM bet_signals bs JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id "
+ "WHERE bs.signal_type='ML' AND bs.closing_line IS NOT NULL "
+ "  AND bs.game_date >= '2026-07-01' "
+ "  AND bs.game_date NOT IN ('2026-07-06','2026-07-07','2026-07-10','2026-07-11')"
).all();
console.log('\nJUL market_line vs closing_line agreement — prod bet_signals vs game_log:');
let sameML = 0, diffML = 0;
let clVsGL_same = 0, clVsGL_diff = 0;
for (const r of compareRows) {
  const gl_on_side = r.signal_side === 'away' ? r.gl_a : r.gl_h;
  if (r.bs_ml === gl_on_side) sameML++; else diffML++;
  if (r.bs_cl === gl_on_side) clVsGL_same++; else clVsGL_diff++;
}
console.log('  bet_signals.market_line == game_log.market_*_ml (post-side): ' + sameML + ' / ' + compareRows.length);
console.log('  bet_signals.closing_line == game_log.market_*_ml (post-side): ' + clVsGL_same + ' / ' + compareRows.length);

// Any bet_signals with price_venue set to 'poly' or 'kalshi' (venue-aware)?
const venueSplit = db.prepare(
  "SELECT price_venue, venue_stale, COUNT(*) c FROM bet_signals "
+ "WHERE signal_type='ML' AND game_date >= '2026-07-01' "
+ "AND game_date NOT IN ('2026-07-06','2026-07-07','2026-07-10','2026-07-11') "
+ "GROUP BY price_venue, venue_stale"
).all();
console.log('\nJUL prod bet_signals price_venue distribution:');
for (const r of venueSplit) console.log('  price_venue=' + (r.price_venue||'null').padEnd(8) + ' stale=' + r.venue_stale + '  n=' + r.c);
