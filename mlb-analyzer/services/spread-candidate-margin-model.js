'use strict';

// CANDIDATE runline model — "margin_model_B". (2026-09-12)
//
// NOT A DISPLAY PATH. Nothing here reaches the card, the slate API, or
// any signal table. It writes one side table, spread_candidate_predictions,
// so a forward-honest evaluation can run at season end and next season
// against predictions that were recorded BEFORE the games happened.
// The display gate is services/feature-gate-registry.js ->
// spread_edge_display_enabled, which this does not touch.
//
// WHY THIS EXISTS. Three arms of a fitted margin model were measured
// against the posted Kalshi runline price on 5,472 out-of-sample plays
// (fit < 2026-08-01, test >= 2026-08-01):
//
//   arm                        mean|bin err|   Brier   logloss     AUC
//   MARKET (posted implied)         2.59      0.1896   0.5641    0.7797
//   A  model wp + model total       2.08      0.1911   0.5685    0.7762
//   B  market wp + market total     1.07      0.1892   0.5632    0.7799
//   C  both                         2.25      0.1909   0.5679    0.7769
//
// Only B cleared all four clauses of the gate, and A did not. Read
// plainly: a smooth function of KALSHI'S OWN moneyline and total is
// better calibrated than KALSHI'S OWN runline price. That is a statement
// about the exchange's internal consistency across its markets. The
// model contributes nothing to it -- adding model inputs (arm C) made it
// worse than the market alone on three of four clauses.
//
// B IS A CANDIDATE, NOT A WINNER. Three of its four clauses are ties by
// rounding (Brier 0.1892 vs 0.1896, logloss 0.5632 vs 0.5641, AUC 0.7799
// vs 0.7797 -- a gap of 0.0002), and it FAILED the price-band check:
// within fixed implied bands, its edge>=3pp plays beat its edge<0 plays
// in only one of four bands with usable n, and that one rested on n=57.
// So B is better LABELLED than the market, not better INFORMED: it ranks
// outcomes indistinguishably and just puts more accurate numbers on the
// same ordering. The gate was tightened in the same commit that added
// this file, precisely so that "clears" means more than B managed.
//
// COEFFICIENTS ARE FROZEN. They are the pre-2026-08-01 fit, hardcoded,
// and MUST NOT be refitted here. The whole value of this table is that
// every row was produced by a model that never saw the game it is
// predicting. Refitting on accumulated data -- however tempting once the
// sample grows -- silently converts a forward test into an in-sample
// one, and nothing downstream would be able to tell. If a refit is
// wanted, it belongs in a NEW candidate id with its own frozen
// coefficients and its own fit window, so the two can be compared.

// ---------------------------------------------------------------- form
// Proportional-odds ordinal logistic on the home margin. Margins are
// integers and never 0, so the outcome has 8 ordered categories
// (M<=-4, -3, -2, -1, +1, +2, +3, M>=+4) over 7 cutpoints:
//
//   P(M <= c) = sigmoid(theta_c - eta),  eta = beta . x
//
// Every runline probability falls out of the SAME fit, which is why an
// ordinal model rather than six separate logistic regressions:
//   home lay -L  wins iff M >= L+0.5  ->  1 - P(M <= L-0.5)
//   away lay -L  wins iff M <= -(L+0.5)
//   take         = 1 - lay   (half-run lines never push)
// Monotonicity in the line, and the two directions summing to <= 1, hold
// by CONSTRUCTION. Independent per-threshold fits can violate both, and
// a runline model that says P(win by 2+) < P(win by 3+) is not a model.
const CANDIDATE_ID = 'margin_model_B';

// Fit window, recorded so an evaluator can exclude it without guessing.
const FIT_THROUGH = '2026-07-31';   // fitted on games STRICTLY BEFORE 2026-08-01
const FIT_N_GAMES = 1482;

// theta_c for c in this order. Monotone increasing, as a cumulative
// link requires.
const CUTPOINTS = [-4, -3, -2, -1, 1, 2, 3];
const THETAS = [
  -1.300824,  // P(M <= -4)
  -0.905952,  // P(M <= -3)
  -0.454869,  // P(M <= -2)
   0.004755,  // P(M <= -1)
   0.684741,  // P(M <=  1)
   1.114551,  // P(M <=  2)
   1.524960,  // P(M <=  3)
];
// x = [ logit(market no-vig home wp), (market_total - 8.5), product ]
// The interaction was chosen a priori and applied identically to all
// three arms, so no arm was advantaged by a form picked after the fact.
const BETA = [0.729130, -0.098210, 0.044276];
const TOTAL_CENTER = 8.5;

const clamp = p => Math.max(1e-9, Math.min(1 - 1e-9, p));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const logit = p => Math.log(clamp(p) / (1 - clamp(p)));

// American odds -> implied probability. Same formula as
// services/empirical-spread-edge.js americanToProb; duplicated rather
// than imported so this module has no dependency on the display engine
// and cannot be broken by a change there.
function americanToProb(ml) {
  if (typeof ml !== 'number' || !Number.isFinite(ml) || ml === 0) return null;
  return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
}
function noVigHomeProb(homeMl, awayMl) {
  const pH = americanToProb(homeMl), pA = americanToProb(awayMl);
  if (pH == null || pA == null) return null;
  const sum = pH + pA;
  if (!(sum > 0)) return null;
  return pH / sum;
}

// eta for a game. Returns null when an input is missing -- this model
// REFUSES rather than substituting a neutral value, because a neutral
// win prob is a plausible number nothing downstream could tell from a
// real one.
function etaOf(marketHomeMl, marketAwayMl, marketTotal) {
  const wp = noVigHomeProb(marketHomeMl, marketAwayMl);
  if (wp == null || !Number.isFinite(marketTotal)) return null;
  const w = logit(wp), t = marketTotal - TOTAL_CENTER;
  const x = [w, t, w * t];
  let eta = 0;
  for (let i = 0; i < BETA.length; i++) eta += BETA[i] * x[i];
  return eta;
}

// P(home margin <= c) for a cutpoint c in CUTPOINTS.
function cdfAt(eta, c) {
  const i = CUTPOINTS.indexOf(c);
  if (i === -1) return null;
  return sigmoid(THETAS[i] - eta);
}

// Probability that a LAY on `spread_team` at `line` covers.
//   spread_team is home: needs margin >= line+0.5
//   spread_team is away: needs margin <= -(line+0.5)
// Returns null for a line this model has no cutpoint for, rather than
// extrapolating off the end of the fitted ladder.
function layProb(eta, line, isHome) {
  const k = line + 0.5;                       // 2, 3 or 4 for 1.5/2.5/3.5
  if (eta == null) return null;
  if (isHome) {
    const c = cdfAt(eta, k - 1);              // P(M <= k-1)
    return c == null ? null : 1 - c;
  }
  return cdfAt(eta, -k);                      // P(M <= -k)
}

// ------------------------------------------------------------ generate
// One row per (game, spread_team, spread_line, side) for `date`, with
// the candidate's probability, the posted ask it is quoted against, and
// the resulting edge. Read-only; the caller persists.
//
// NO OUTCOME COLUMN, deliberately. The realized result is a property of
// the final margin and is derivable by joining game_log at evaluation
// time. Storing a graded copy here would be a second source of truth for
// something already recorded, and this codebase has spent weeks removing
// exactly that shape.
function generateCandidatePredictions(db, date) {
  if (!date) throw new Error('generateCandidatePredictions: date required');
  const games = db.prepare(
      'SELECT game_date, game_id, home_team, away_team, '
    + '       market_home_ml, market_away_ml, market_total '
    + 'FROM game_log WHERE game_date = ? '
    + '  AND market_home_ml IS NOT NULL AND market_away_ml IS NOT NULL '
    + '  AND market_total IS NOT NULL'
  ).all(date);
  const getSpreads = db.prepare(
      'SELECT spread_team, spread_line, yes_ask_dollars, yes_ask_ml, '
    + '       no_ask_dollars, no_ask_ml FROM kalshi_spread_markets '
    + 'WHERE game_date = ? AND game_id = ? AND spread_line IN (1.5, 2.5, 3.5)'
  );
  const impliedOf = (dollars, ml) =>
    (typeof dollars === 'number' && Number.isFinite(dollars)) ? dollars : americanToProb(ml);

  const out = [];
  let skippedNoEta = 0;
  for (const g of games) {
    const eta = etaOf(g.market_home_ml, g.market_away_ml, g.market_total);
    if (eta == null) { skippedNoEta++; continue; }
    const wp = noVigHomeProb(g.market_home_ml, g.market_away_ml);
    for (const s of getSpreads.all(g.game_date, g.game_id)) {
      const line = Number(s.spread_line);
      const isHome = s.spread_team === g.home_team;
      const lay = layProb(eta, line, isHome);
      if (lay == null) continue;
      const legs = [
        { side: 'lay',  prob: lay,     imp: impliedOf(s.yes_ask_dollars, s.yes_ask_ml), ml: s.yes_ask_ml },
        { side: 'take', prob: 1 - lay, imp: impliedOf(s.no_ask_dollars,  s.no_ask_ml),  ml: s.no_ask_ml },
      ];
      for (const leg of legs) {
        if (leg.imp == null) continue;        // unpriced leg: no edge to state
        out.push({
          game_date: g.game_date, game_id: g.game_id,
          spread_team: s.spread_team, spread_line: line, side: leg.side,
          candidate: CANDIDATE_ID,
          prob_pct: leg.prob * 100,
          implied_pct: leg.imp * 100,
          edge_pp: (leg.prob - leg.imp) * 100,
          price_ml: leg.ml == null ? null : Number(leg.ml),
          // The inputs, stored alongside the output. Without them a row
          // cannot be re-derived years later, and "why did it say that"
          // becomes unanswerable once market_* has moved on.
          input_market_home_wp: wp,
          input_market_total: g.market_total,
        });
      }
    }
  }
  return { rows: out, skippedNoEta, candidate: CANDIDATE_ID };
}

function persistCandidatePredictions(db, rows, generatedAt) {
  if (!rows || !rows.length) return { written: 0 };
  const ins = db.prepare(
      'INSERT OR REPLACE INTO spread_candidate_predictions '
    + '(game_date, game_id, spread_team, spread_line, side, candidate, generated_at, '
    + ' prob_pct, implied_pct, edge_pp, price_ml, input_market_home_wp, input_market_total) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const tx = db.transaction(rs => {
    for (const r of rs) {
      ins.run(r.game_date, r.game_id, r.spread_team, r.spread_line, r.side,
        r.candidate, generatedAt, r.prob_pct, r.implied_pct, r.edge_pp,
        r.price_ml, r.input_market_home_wp, r.input_market_total);
    }
  });
  tx(rows);
  return { written: rows.length };
}

module.exports = {
  CANDIDATE_ID, FIT_THROUGH, FIT_N_GAMES, CUTPOINTS, THETAS, BETA, TOTAL_CENTER,
  americanToProb, noVigHomeProb, etaOf, cdfAt, layProb,
  generateCandidatePredictions, persistCandidatePredictions,
};
