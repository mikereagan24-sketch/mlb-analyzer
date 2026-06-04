'use strict';

// Empirical-spread edge engine. Shared between scripts/empirical-
// spread-edge.js (the ad-hoc CLI report) and services/jobs.js (the
// runOddsJob signal-generation block that writes into
// empirical_spread_signals / empirical_spread_outcomes).
//
// All math here is pure and READ-ONLY against the DB — no INSERTs,
// no UPDATEs. The caller owns durability.
//
// ⚠ DIRECTIONAL ⚠
//   Empirical sample is the in-season game_log corpus split across
//   6 cells. Individual cells will be sparse early in the season.
//   Threshold filters live at the consumer (jobs.js, the CLI's
//   --min-sample, the slate API's display gate).

// ------------------------------------------------------------ tunables
// Win-prob bucket boundaries (no-vig home win prob). Cells:
//   < WP_BALANCED_LOW           = Underdog home
//   [WP_BALANCED_LOW, WP_HIGH)  = Balanced / slight favorite home
//   >= WP_HIGH                  = Strong favorite home
const WP_BALANCED_LOW = 0.500;
const WP_HIGH         = 0.575;

// Total bucket boundary (model_total). Below = Low, at/above = High.
const TOTAL_THRESHOLD = 8.5;

// Spread lines surfaced per side. Kalshi publishes 1.5..9.5 in 1-run
// steps; the near-the-money rungs are the only ones with sensible
// liquidity AND non-trivial empirical sample.
const SHOW_LINES = [1.5, 2.5, 3.5];

// Stable cell ordering, used by callers that need a predictable
// summary printout.
const ALL_CELLS = [
  'Underdog home / Low total',
  'Underdog home / High total',
  'Balanced / Low total',
  'Balanced / High total',
  'Strong fav / Low total',
  'Strong fav / High total',
];

// ------------------------------------------------------------ math
// American odds → implied probability. Same formula used in
// services/kalshi.js (probToAmerican is the inverse). Returns null
// for non-finite input so callers can short-circuit cleanly.
function americanToProb(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}

// No-vig home win probability from a model moneyline pair. Strip
// overround by normalizing the pair's implied probs.
function noVigHomeProb(homeMl, awayMl) {
  const pH = americanToProb(homeMl);
  const pA = americanToProb(awayMl);
  if (pH == null || pA == null) return null;
  const sum = pH + pA;
  if (!(sum > 0)) return null;
  return pH / sum;
}

// $100 stake profit on an American moneyline win. (-100) loss is the
// caller's job — this function only returns the winning-side profit.
// +ml: $100 stake wins ml dollars. -ml: $100 stake wins (100/|ml|*100)
// dollars. Mirrors the toWin100 math inside services/model.js's
// calcPnl; kept inline because that helper isn't exported.
function americanProfit(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return 0;
  return ml > 0 ? ml : (100 * 100) / Math.abs(ml);
}

// Cell key. Human-readable so logs and the slate UI can show it as-is.
function cellKey(homeWinProb, modelTotal) {
  let wp;
  if (homeWinProb < WP_BALANCED_LOW) wp = 'Underdog home';
  else if (homeWinProb < WP_HIGH)    wp = 'Balanced';
  else                                wp = 'Strong fav';
  const tot = modelTotal < TOTAL_THRESHOLD ? 'Low total' : 'High total';
  return wp + ' / ' + tot;
}

// ------------------------------------------------------------ cell index
// Build the historical margin distribution per cell. One pass over
// every graded game with a complete model line.
//
// Returns {cells: Map<cellLabel, number[]>, totalGraded, skipped}.
// Caller is expected to memoize this for the lifetime of a single
// report / job pass — it's a few-hundred-row table scan and small
// arithmetic, but it's silly to repeat per-game.
function buildCellIndex(db) {
  const rows = db.prepare(
      "SELECT model_home_ml, model_away_ml, model_total, home_score, away_score "
    + "FROM game_log "
    + "WHERE home_score IS NOT NULL AND away_score IS NOT NULL "
    + "  AND model_home_ml IS NOT NULL AND model_away_ml IS NOT NULL "
    + "  AND model_total IS NOT NULL"
  ).all();
  const cells = new Map();
  for (const c of ALL_CELLS) cells.set(c, []);
  let skipped = 0;
  for (const r of rows) {
    const wp = noVigHomeProb(r.model_home_ml, r.model_away_ml);
    if (wp == null) { skipped++; continue; }
    if (!Number.isFinite(r.model_total)) { skipped++; continue; }
    const margin = r.home_score - r.away_score;
    cells.get(cellKey(wp, r.model_total)).push(margin);
  }
  return { cells, totalGraded: rows.length, skipped };
}

// Tail probabilities. Strict > L because Kalshi spread lines are
// half-runs and integer margins clear or miss cleanly.
function pMarginGreater(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] > L) hit++;
  return hit / margins.length;
}
function pMarginLess(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] < -L) hit++;
  return hit / margins.length;
}

// ------------------------------------------------------------ per-game analysis
// computeGameEdges — runs the full pipeline for ONE game:
//   1. Compute no-vig home win prob from the game's model line.
//   2. Bucket into one of 6 cells.
//   3. For each spread row in `spreadRows` (already filtered to the
//      SHOW_LINES rungs upstream), compute implied + empirical +
//      edge.
//   4. Return a sorted-by-edge-desc prediction list plus context.
//
// Inputs:
//   game        — {away_team, home_team, model_home_ml, model_away_ml,
//                  model_total}
//   spreadRows  — array of {spread_team, spread_line, yes_ask_dollars,
//                  yes_ask_ml} for the SHOW_LINES rungs (caller filters
//                  the SQL with `spread_line IN (1.5, 2.5, 3.5)`).
//   cellIndex   — output of buildCellIndex; provides the cell margin
//                  distribution.
//
// Returns null when the model line is incomplete (so callers can
// skip cleanly); otherwise:
//   {
//     home_win_prob, model_total, cell_label, cell_sample_size,
//     predictions: [
//       { spread_team, spread_line, kalshi_yes_ask_ml, implied_pct,
//         empirical_pct, edge_pp }
//     ]
//   }
//
// implied_pct, empirical_pct, edge_pp are all expressed as percentage-
// point values (e.g. 41.8 means 41.8%, NOT 0.418). edge_pp = empirical
// - implied. This keeps the persisted JSON and downstream UI display
// in the same units the brief specifies.
function computeGameEdges(game, spreadRows, cellIndex) {
  if (!game) return null;
  const wp = noVigHomeProb(game.model_home_ml, game.model_away_ml);
  if (wp == null) return null;
  if (!Number.isFinite(game.model_total)) return null;
  const label = cellKey(wp, game.model_total);
  const margins = (cellIndex.cells.get(label)) || [];
  const n = margins.length;

  const predictions = [];
  for (const s of (spreadRows || [])) {
    // Implied prob: prefer yes_ask_dollars (Kalshi's raw 0..1 price)
    // when available; fall back to converting yes_ask_ml. Both come
    // from the same source post fee+shift but the dollars form is the
    // canonical one Kalshi prices in.
    let implied;
    if (typeof s.yes_ask_dollars === 'number' && Number.isFinite(s.yes_ask_dollars)) {
      implied = s.yes_ask_dollars;
    } else {
      implied = americanToProb(s.yes_ask_ml);
    }
    if (implied == null) continue;

    let empirical = null;
    if (s.spread_team === game.home_team) {
      empirical = pMarginGreater(margins, s.spread_line);
    } else if (s.spread_team === game.away_team) {
      empirical = pMarginLess(margins, s.spread_line);
    } else {
      // Defensive — getKalshiMlbSpreads already drops rows whose
      // team doesn't match either side, but belt-and-suspenders.
      continue;
    }
    if (empirical == null) continue;

    predictions.push({
      spread_team: s.spread_team,
      spread_line: Number(s.spread_line),
      kalshi_yes_ask_ml: s.yes_ask_ml == null ? null : Number(s.yes_ask_ml),
      implied_pct: implied * 100,
      empirical_pct: empirical * 100,
      edge_pp: (empirical - implied) * 100,
    });
  }
  predictions.sort((a, b) => b.edge_pp - a.edge_pp);
  return {
    home_win_prob: wp,
    model_total: game.model_total,
    cell_label: label,
    cell_sample_size: n,
    predictions,
  };
}

// ------------------------------------------------------------ batch entry
// generateEmpiricalSpreadSignals — the public ingest-side entrypoint
// jobs.js calls. Pulls every game on `date` that has Kalshi spread
// coverage plus a complete model line; runs computeGameEdges for
// each. Returns an array; callers persist into
// empirical_spread_signals + empirical_spread_outcomes.
//
// Filtering and predictions[] sorting live inside computeGameEdges;
// this layer just orchestrates the SQL pulls and the cell-index
// reuse.
function generateEmpiricalSpreadSignals(db, date) {
  if (!date) throw new Error('generateEmpiricalSpreadSignals: date required');
  const cellIndex = buildCellIndex(db);

  // Games tonight with spread coverage AND a model line.
  const games = db.prepare(
      "SELECT g.game_date, g.game_id, g.away_team, g.home_team, "
    + "       g.model_home_ml, g.model_away_ml, g.model_total "
    + "FROM game_log g "
    + "WHERE g.game_date = ? "
    + "  AND g.model_home_ml IS NOT NULL AND g.model_away_ml IS NOT NULL "
    + "  AND g.model_total IS NOT NULL "
    + "  AND EXISTS (SELECT 1 FROM kalshi_spread_markets k "
    + "              WHERE k.game_date = g.game_date AND k.game_id = g.game_id) "
    + "ORDER BY g.game_id"
  ).all(date);

  const getSpreads = db.prepare(
      "SELECT spread_team, spread_line, yes_ask_dollars, yes_ask_ml "
    + "FROM kalshi_spread_markets "
    + "WHERE game_date = ? AND game_id = ? "
    + "  AND spread_line IN (1.5, 2.5, 3.5) "
    + "ORDER BY spread_team, spread_line"
  );

  const out = [];
  for (const g of games) {
    const spreads = getSpreads.all(g.game_date, g.game_id);
    if (!spreads.length) continue;
    const edges = computeGameEdges(g, spreads, cellIndex);
    if (!edges || !edges.predictions.length) continue;
    out.push({
      game_date: g.game_date,
      game_id: g.game_id,
      away_team: g.away_team,
      home_team: g.home_team,
      ...edges,
    });
  }
  return { signals: out, cellIndex };
}

module.exports = {
  // Constants — exposed so callers (CLI, jobs) read the same source
  // of truth without duplicating the bucket boundaries.
  WP_BALANCED_LOW,
  WP_HIGH,
  TOTAL_THRESHOLD,
  SHOW_LINES,
  ALL_CELLS,
  // Math
  americanToProb,
  americanProfit,
  noVigHomeProb,
  cellKey,
  // Pipeline
  buildCellIndex,
  computeGameEdges,
  generateEmpiricalSpreadSignals,
};
