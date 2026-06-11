// Empirical-market capture for moneyline + totals (feat/morning-
// capture-ml-totals). Two-track (morning/gametime) freeze of ML and
// totals prices so the realized CLV between morning lock and
// gametime close can be measured per market.
//
// Parallel to services/empirical-spread-edge.js's spread engine but
// writes a separate table (empirical_market_captures) because ML and
// totals have no lay/take pair concept — both sides are sides of one
// Kalshi market, not separate events. See the table-header comment in
// db/schema.js for the schema rationale.
//
// PRICE CONVENTION:
//   Prices are sourced from game_log.market_*_ml and game_log.over_price /
//   under_price, which carry the SAME cent-shifted fee-adjusted values
//   set by runOddsJob's Kalshi-direct override blocks
//   (jobs.js feeAdjustAmerican + the totals feeAdjustAmericanFromC).
//   We store them as-is — no re-derive, no re-shift — so the readout
//   stays consistent with the production CLV convention.
//
// SIGNALED SIDE:
//   Derived at capture time by comparing model_*_ml / model_total to
//   the market via impliedP (the same impliedP used in services/
//   model.js). For ML: side with the higher positive edge wins; if
//   neither side has positive edge, signaled_side stays NULL (row is
//   written for price history but contributes 0 plays to the readout).
//   For totals: over_edge / under_edge computed from a model
//   over-probability that mirrors model.js's getSignals math
//   (0.5 + (estTot - mktTot) * TOT_SLOPE, clamped); higher positive
//   edge wins.
//
// GRADING:
//   gradeMarketCapturesForGame is the extension point — called from
//   the same sites as gradeEmpiricalSpreadOutcomesForGame
//   (runScoreJob, processGameSignals's game-final branch, the regrade
//   backfill endpoint). Pulls every ungraded row for the game across
//   both tracks and both market types. ML: signaled side wins iff
//   the corresponding team wins. Totals: actual_total vs market_line;
//   half-run lines preclude push but the grader still checks
//   actual_total === market_line so integer lines (e.g. 9.0) push
//   correctly. pnl_per_100 = americanProfit(signaled_price_ml) on
//   win, -100 on loss, 0 on push.

'use strict';

const { impliedP } = require('./model');
const { americanProfit } = require('./empirical-spread-edge');

const SIGNAL_EMIT_FLOOR_DEFAULT = 0.01;

// Capture market state for a single date.
//
// captureTrack: 'morning' | 'gametime'.
//   - 'morning' uses INSERT OR IGNORE so re-invocations on the same
//     (game, market, track) leave the first-eligible lock intact.
//   - 'gametime' uses INSERT OR REPLACE so each odds-job pass writes
//     a fresh snapshot under its own generated_at — the latest is
//     the close at first pitch.
//
// generatedAt: PT-anchored timestamp shared across this pass so all
// rows in a batch group cleanly in the PK.
//
// Returns { written, skipped, byType } where skipped lists games
// dropped for missing model lines or missing market prices.
function generateMarketCapture(db, q, date, captureTrack, generatedAt) {
  if (!date) throw new Error('generateMarketCapture: date required');
  if (!['morning', 'gametime'].includes(captureTrack)) {
    throw new Error('generateMarketCapture: captureTrack must be "morning" or "gametime"');
  }
  if (!generatedAt) throw new Error('generateMarketCapture: generatedAt required');

  const settings = getSweepableSettings(db);
  const TOT_SLOPE   = settings.TOT_SLOPE;
  const TOT_PROB_LO = settings.TOT_PROB_LO;
  const TOT_PROB_HI = settings.TOT_PROB_HI;
  const EMIT_FLOOR  = settings.SIGNAL_EMIT_FLOOR_PP;

  // Eligibility: game_log row + model lines populated. ML needs
  // market_*_ml; totals needs market_total + over_price + under_price.
  // We pull EVERY row with at least one of those populated and decide
  // per-market_type inside the loop so a game missing totals but with
  // ML still locks ML — the partial-posting reality the brief calls
  // out as the original design motivation.
  const games = db.prepare(
      "SELECT game_date, game_id, away_team, home_team, "
    + "       model_home_ml, model_away_ml, model_total, "
    + "       market_home_ml, market_away_ml, market_total, "
    + "       over_price, under_price "
    + "FROM game_log "
    + "WHERE game_date = ? "
    + "  AND model_home_ml IS NOT NULL "
    + "  AND model_away_ml IS NOT NULL "
    + "  AND model_total   IS NOT NULL"
  ).all(date);

  const writer = captureTrack === 'morning'
    ? q.insertOrIgnoreMarketCapture
    : q.insertOrReplaceMarketCapture;

  let written = 0;
  const skipped = [];
  const byType = { ml: 0, total: 0 };
  const writeTx = db.transaction((rows) => {
    for (const g of rows) {
      // ---- ML market
      if (g.market_home_ml != null && g.market_away_ml != null) {
        // For the 'morning' track, skip if a lock already exists.
        // existsMorningMarketCapture short-circuits the writer's
        // INSERT OR IGNORE — the IGNORE itself is also safe, but
        // checking up front lets us count "skipped" as already-locked
        // for the summary.
        if (captureTrack === 'morning'
            && q.existsMorningMarketCapture.get(g.game_date, g.game_id, 'ml')) {
          // ML already locked for the morning — leave it.
        } else {
          const sig = chooseMlSignaledSide(g, EMIT_FLOOR);
          writer.run(
            g.game_date, g.game_id, 'ml', captureTrack, generatedAt,
            null,                          // market_line
            g.market_away_ml, g.market_home_ml,
            null, null,                    // over/under prices
            sig.side, sig.edge_pp, sig.price_ml
          );
          written++;
          byType.ml++;
        }
      } else {
        skipped.push({ game_id: g.game_id, market_type: 'ml',
          reason: 'market_home_ml or market_away_ml null' });
      }

      // ---- Totals market
      if (g.market_total != null && g.over_price != null && g.under_price != null) {
        if (captureTrack === 'morning'
            && q.existsMorningMarketCapture.get(g.game_date, g.game_id, 'total')) {
          // Totals already locked for the morning — leave it.
        } else {
          const sig = chooseTotalSignaledSide(g, TOT_SLOPE, TOT_PROB_LO, TOT_PROB_HI, EMIT_FLOOR);
          writer.run(
            g.game_date, g.game_id, 'total', captureTrack, generatedAt,
            g.market_total,
            null, null,                    // ML prices
            g.over_price, g.under_price,
            sig.side, sig.edge_pp, sig.price_ml
          );
          written++;
          byType.total++;
        }
      } else {
        skipped.push({ game_id: g.game_id, market_type: 'total',
          reason: 'market_total / over_price / under_price null' });
      }
    }
  });
  writeTx(games);
  return { written, skipped, byType };
}

// Choose the signaled ML side. Edge = model_implied - market_implied.
// Side with HIGHER positive edge wins. If neither clears the emit
// floor, signaled_side stays NULL — row is written for price history
// but contributes 0 plays.
function chooseMlSignaledSide(g, emitFloor) {
  const awayMktImpl = impliedP(g.market_away_ml);
  const homeMktImpl = impliedP(g.market_home_ml);
  const awayModelImpl = impliedP(g.model_away_ml);
  const homeModelImpl = impliedP(g.model_home_ml);
  const awayEdge = awayModelImpl - awayMktImpl;
  const homeEdge = homeModelImpl - homeMktImpl;
  const best = awayEdge >= homeEdge
    ? { side: 'away', edge_pp: awayEdge, price_ml: g.market_away_ml }
    : { side: 'home', edge_pp: homeEdge, price_ml: g.market_home_ml };
  if (best.edge_pp < emitFloor) return { side: null, edge_pp: null, price_ml: null };
  return best;
}

// Choose the signaled totals side. Model over-prob uses the same
// formula as services/model.js getSignals: 0.5 + (estTot - mktTot) *
// TOT_SLOPE, clamped to [TOT_PROB_LO, TOT_PROB_HI]. Market implied
// probs come from over_price / under_price (the prices on game_log
// after the Kalshi-direct totals override path's fee + shift).
function chooseTotalSignaledSide(g, totSlope, totProbLo, totProbHi, emitFloor) {
  const runDiff = Number(g.model_total) - Number(g.market_total);
  const modelOverP = Math.min(Math.max(0.5 + runDiff * totSlope, totProbLo), totProbHi);
  const modelUnderP = 1 - modelOverP;
  const overMktImpl  = impliedP(g.over_price);
  const underMktImpl = impliedP(g.under_price);
  const overEdge  = modelOverP  - overMktImpl;
  const underEdge = modelUnderP - underMktImpl;
  const best = overEdge >= underEdge
    ? { side: 'over',  edge_pp: overEdge,  price_ml: g.over_price }
    : { side: 'under', edge_pp: underEdge, price_ml: g.under_price };
  if (best.edge_pp < emitFloor) return { side: null, edge_pp: null, price_ml: null };
  return best;
}

// Read the small subset of app_settings the capture math depends on.
// Mirrors the defaults in services/model.js getSignals so the capture
// uses the same constants as production signal generation.
function getSweepableSettings(db) {
  const rows = db.prepare(
    "SELECT key, value FROM app_settings WHERE key IN ("
    + "'tot_slope','tot_prob_lo','tot_prob_hi','signal_emit_floor_pp')"
  ).all();
  const m = {};
  for (const r of rows) m[r.key] = Number(r.value);
  return {
    TOT_SLOPE:           Number.isFinite(m.tot_slope)            ? m.tot_slope            : 0.08,
    TOT_PROB_LO:         Number.isFinite(m.tot_prob_lo)          ? m.tot_prob_lo          : 0.20,
    TOT_PROB_HI:         Number.isFinite(m.tot_prob_hi)          ? m.tot_prob_hi          : 0.80,
    SIGNAL_EMIT_FLOOR_PP: Number.isFinite(m.signal_emit_floor_pp) ? m.signal_emit_floor_pp : SIGNAL_EMIT_FLOOR_DEFAULT,
  };
}

// Grade every ungraded market capture row for a completed game.
// Pulled across BOTH tracks AND BOTH market types in one query — no
// capture_track filter, no market_type filter (matches the spread
// grader's dual-track guarantee). Each row grades independently
// against its own frozen price.
//
// ML:
//   home_won = home_score > away_score. signaled_side is graded:
//     side === 'home' && home_won → win
//     side === 'away' && !home_won → win
//     else → loss
//
// Totals:
//   actual_total = away_score + home_score. signaled_side graded:
//     side === 'over'  && actual > line → win
//     side === 'under' && actual < line → win
//     actual === line                  → push  (only possible on integer lines)
//     else                              → loss
//
//   The brief says "do not assume all lines are half-runs — handle a
//   push outcome": the equality check catches integer-line pushes
//   (e.g. line=9.0 with a 5-4 final scoring 9 total). Half-run lines
//   (e.g. 8.5) can never equal an integer total, so push is
//   unreachable on those — the check is a free safety net.
//
// pnl_per_100:
//   win  → americanProfit(signaled_price_ml)
//   loss → -100
//   push → 0
//
// Rows whose signaled_side is NULL (no model signal at capture time)
// grade as outcome='no_signal', pnl=0. They still get graded so the
// row is no longer "ungraded" and the regrade endpoint can stop
// touching them, but they contribute 0 plays to the readout.
function gradeMarketCapturesForGame(db, q, gameRow, gradedAt) {
  if (!gameRow || gameRow.away_score == null || gameRow.home_score == null) {
    return { graded: 0, byType: {}, byOutcome: {} };
  }
  const ungraded = q.getUngradedMarketCapturesByGame.all(
    gameRow.game_date, gameRow.game_id);
  if (!ungraded.length) return { graded: 0, byType: {}, byOutcome: {} };

  const away = Number(gameRow.away_score);
  const home = Number(gameRow.home_score);
  const homeWon  = home > away;
  const actualTotal = away + home;

  let graded = 0;
  const byType = { ml: 0, total: 0 };
  const byOutcome = { win: 0, loss: 0, push: 0, no_signal: 0 };

  for (const r of ungraded) {
    let outcome = null;
    let pnl = 0;
    if (!r.signaled_side) {
      outcome = 'no_signal';
      pnl = 0;
    } else if (r.market_type === 'ml') {
      const win = (r.signaled_side === 'home' && homeWon)
               || (r.signaled_side === 'away' && !homeWon);
      outcome = win ? 'win' : 'loss';
      pnl = win ? americanProfit(r.signaled_price_ml) : -100;
    } else if (r.market_type === 'total') {
      const line = Number(r.market_line);
      if (actualTotal === line) {
        outcome = 'push';
        pnl = 0;
      } else {
        const win = (r.signaled_side === 'over'  && actualTotal > line)
                 || (r.signaled_side === 'under' && actualTotal < line);
        outcome = win ? 'win' : 'loss';
        pnl = win ? americanProfit(r.signaled_price_ml) : -100;
      }
    } else {
      // Unknown market_type — skip rather than corrupt the row.
      continue;
    }
    q.updateMarketCaptureOutcome.run(
      away, home, actualTotal,
      outcome, pnl, gradedAt,
      r.game_date, r.game_id, r.market_type, r.capture_track, r.generated_at
    );
    graded++;
    byType[r.market_type] = (byType[r.market_type] || 0) + 1;
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
  }
  return { graded, byType, byOutcome };
}

module.exports = {
  generateMarketCapture,
  gradeMarketCapturesForGame,
  // Exposed for tests / hand-verification.
  chooseMlSignaledSide,
  chooseTotalSignaledSide,
  getSweepableSettings,
};
