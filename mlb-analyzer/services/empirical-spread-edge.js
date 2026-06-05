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

// Tail-hit floor below which a prediction is flagged low_sample.
// Deep-favorite take rows (e.g. opp +3.5 at no_ask -966) can produce
// empirical probabilities like 90%+ off a tail of only 5-10 games
// out of 60 — looks like edge, actually noise at terrible prices.
// The flag is observational: API gates exclude flagged picks, UI
// can de-emphasize, but rows are still stored for hindsight.
const SUPPRESS_TAIL_HIT_FLOOR = 15;

// Tail probability + count. Strict > L because Kalshi spread lines
// are half-runs and integer margins clear or miss cleanly. Returns
// {p, hit, n} so callers can compute both the empirical fraction and
// the absolute support behind it. n null/empty → returns null.
function tailGreater(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] > L) hit++;
  return { p: hit / margins.length, hit, n: margins.length };
}
function tailLess(margins, L) {
  if (!margins || !margins.length) return null;
  let hit = 0;
  for (let i = 0; i < margins.length; i++) if (margins[i] < -L) hit++;
  return { p: hit / margins.length, hit, n: margins.length };
}

// ------------------------------------------------------------ per-game analysis
// computeGameEdges — runs the full pipeline for ONE game and emits
// BOTH legs (lay and take) of every spread row as separate
// predictions.
//
// Background (verified against the live Kalshi API for 7,647
// KXMLBSPREAD markets, including the user's 6/3 COLLAA event):
// Kalshi does NOT publish a separate +runline market. Each
// kalshi_spread_markets row is the favorite-lays direction for
// `spread_team`, and the +runline price for the OPPOSING team at
// the same line is the same row's no_ask_dollars / no_ask_ml.
// So this function turns each input row into two predictions:
//
//   - lay  ('spread_team' -L) at yes_ask_ml, empirical = P(margin
//     clears +L for spread_team) computed from the cell tail.
//   - take ('opposite_team' +L) at THIS ROW'S no_ask_ml — the real
//     Kalshi-posted +runline price, NOT a synthesized (1 - yes_ask).
//     take_empirical = 1 - lay_empirical (exact complement —
//     no separate tail scan).
//
// The two are linked by pair_id ('game_id|line|sortedTeams') so
// downstream can treat them as one market with two legs (UI
// grouping, hindsight pairing).
//
// SUPPRESS-EXTREMES GUARD: each side's hit count (absolute number
// of cell games supporting the empirical) is computed. If either
// the side's own hit count OR the complementary side's hit count
// drops below SUPPRESS_TAIL_HIT_FLOOR, that prediction's
// low_sample flag is set. The flag is observational — rows are
// still emitted (and persisted) so we can audit later, but the
// API and UI gates use it to exclude noisy deep-tail picks.
//
// Inputs:
//   game        — {away_team, home_team, model_home_ml, model_away_ml,
//                  model_total}
//   spreadRows  — array of {spread_team, spread_line, yes_ask_dollars,
//                  yes_ask_ml, no_ask_dollars, no_ask_ml} for the
//                  SHOW_LINES rungs (caller's SQL filters
//                  `spread_line IN (1.5, 2.5, 3.5)`).
//   cellIndex   — output of buildCellIndex.
//
// Returns null when the model line is incomplete; otherwise:
//   {
//     home_win_prob, model_total, cell_label, cell_sample_size,
//     predictions: [
//       { spread_team, spread_line, side,            // 'lay' | 'take'
//         pair_id,
//         price_ml,                                  // the side's actual
//                                                    // stored price
//         implied_pct, empirical_pct, edge_pp,
//         tail_hit,                                  // absolute hit count
//         low_sample,                                // bool
//         // back-compat / display:
//         kalshi_yes_ask_ml                          // ROW's yes_ask_ml
//                                                    // (same for both legs
//                                                    // of a pair) — kept
//                                                    // so existing
//                                                    // top_edge_yes_ask_ml
//                                                    // queries don't break
//       }
//     ]
//   }
//
// implied_pct, empirical_pct, edge_pp are percentage points (e.g.
// 41.8 means 41.8%, NOT 0.418).
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
    // ---- side, opposite-team attribution
    let oppositeTeam;
    if (s.spread_team === game.home_team) oppositeTeam = game.away_team;
    else if (s.spread_team === game.away_team) oppositeTeam = game.home_team;
    else continue; // defensive — should never happen post-ingest

    // ---- lay implied prob (favorite -L)
    let layImplied;
    if (typeof s.yes_ask_dollars === 'number' && Number.isFinite(s.yes_ask_dollars)) {
      layImplied = s.yes_ask_dollars;
    } else {
      layImplied = americanToProb(s.yes_ask_ml);
    }
    if (layImplied == null) continue;

    // ---- take implied prob (opposite team +L). MUST come from the
    // row's actual no_ask — Kalshi's posted +runline price. NOT
    // (1 - yes_ask): that would erase the bid/ask spread + fees.
    let takeImplied;
    if (typeof s.no_ask_dollars === 'number' && Number.isFinite(s.no_ask_dollars)) {
      takeImplied = s.no_ask_dollars;
    } else {
      takeImplied = americanToProb(s.no_ask_ml);
    }
    // If Kalshi didn't ship a usable no_ask for this rung, the take
    // leg is unpriced — emit only the lay leg.

    // ---- lay empirical via the cell tail
    let layTail;
    if (s.spread_team === game.home_team) {
      layTail = tailGreater(margins, s.spread_line);
    } else {
      layTail = tailLess(margins, s.spread_line);
    }
    if (layTail == null) continue;
    const layEmpirical = layTail.p;
    const layHit       = layTail.hit;
    // Complementary tail count: cell games NOT in the lay's tail are
    // the take's tail (exact complement, no double-counting because
    // half-run lines have no push case).
    const takeHit      = layTail.n - layTail.hit;
    const takeEmpirical = 1 - layEmpirical;

    // ---- low_sample: if EITHER tail's hit count is below the floor,
    // BOTH legs are flagged. Reason: the two are mirror images; a
    // weak underlying tail makes both empiricals shaky, just in
    // opposite directions. Treating them symmetrically also keeps
    // the paired-outcome inversion intact downstream.
    const lowSample = (layHit < SUPPRESS_TAIL_HIT_FLOOR)
                   || (takeHit < SUPPRESS_TAIL_HIT_FLOOR);

    // ---- pair_id — identifies the Kalshi market this row IS,
    // not the unordered team pair. Each Kalshi row IS a market
    // (YES = spread_team -L, NO = opposite_team +L); the two
    // legs share this row, so pair_id keys on the row's YES-side
    // team. The OTHER row at the same line (where the opposite
    // team is the YES side) is a DIFFERENT Kalshi market and
    // gets its own pair_id. Without this, both rows at a line
    // would collide and the lay/take grouping would be 4 legs
    // per key instead of 2.
    const pairId = game.game_id + '|' + Number(s.spread_line).toFixed(1) + '|' + s.spread_team;

    // ---- LAY prediction
    predictions.push({
      spread_team:        s.spread_team,
      spread_line:        Number(s.spread_line),
      side:               'lay',
      pair_id:            pairId,
      price_ml:           s.yes_ask_ml == null ? null : Number(s.yes_ask_ml),
      implied_pct:        layImplied * 100,
      empirical_pct:      layEmpirical * 100,
      edge_pp:            (layEmpirical - layImplied) * 100,
      tail_hit:           layHit,
      low_sample:         lowSample,
      // Kept for back-compat: existing schema column
      // top_edge_yes_ask_ml + slate render still want the row's
      // yes_ask. For the lay leg this IS the side's price.
      kalshi_yes_ask_ml:  s.yes_ask_ml == null ? null : Number(s.yes_ask_ml),
    });

    // ---- TAKE prediction (skip if no_ask unpriced)
    if (takeImplied != null) {
      predictions.push({
        spread_team:        oppositeTeam,
        spread_line:        Number(s.spread_line),
        side:               'take',
        pair_id:            pairId,
        price_ml:           s.no_ask_ml == null ? null : Number(s.no_ask_ml),
        implied_pct:        takeImplied * 100,
        empirical_pct:      takeEmpirical * 100,
        edge_pp:            (takeEmpirical - takeImplied) * 100,
        tail_hit:           takeHit,
        low_sample:         lowSample,
        // For the take leg, kalshi_yes_ask_ml is the ROW's yes_ask
        // (NOT this leg's price) — preserves back-compat with the
        // pre-take schema column. Side's actual price is price_ml.
        kalshi_yes_ask_ml:  s.yes_ask_ml == null ? null : Number(s.yes_ask_ml),
      });
    }
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
      "SELECT spread_team, spread_line, yes_ask_dollars, yes_ask_ml, "
    + "       no_ask_dollars, no_ask_ml "
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
  SUPPRESS_TAIL_HIT_FLOOR,
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
