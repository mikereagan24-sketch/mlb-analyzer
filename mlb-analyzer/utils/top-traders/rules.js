'use strict';

// Top-traders rules -- docs/polymarket-top-traders-prereg-2026-09-30.md §2-§5,
// shared by the backtest (services/polymarket-top-traders-backtest.js) and the
// live card (docs/polymarket-top-traders-card-decisions-2026-10-01.md,
// decision 10). Moved here unchanged from the backtest on 2026-10-01; the
// backtest still reproduces docs/polymarket-top-traders-results-2026-09-30.json
// exactly (scripts/test-top-traders-card-a.js).
//
// PURE: no database, no network, no settings, and nothing from the pricing
// path. DISPLAY ONLY -- never a model input.

const EXCLUDED_DATES = new Set(['2026-04-04', '2026-04-05']);   // §2 (#486): not tested, not history
const SEASON_TO = '2026-09-27';                                  // §2 regular season (last date)
const MIN_GAMES = 40, MAX_VOL_PER_PROFIT = 50, BOTH_MAX = 0.20;  // §3
const MIN_QUALIFIED = 25, TOP_N = 25;                            // §3
const TIE_DOLLARS = 0.005;                                       // §4.5

// UTC seconds from game_log's odds_locked_at ('YYYY-MM-DD HH:MM:SS', SQLite
// datetime('now')) or an ISO string; null when absent or unparseable.
const parseUtc = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

// ---------------------------------------------------------------- §3 qualification
// Per-wallet running totals over history (games strictly before D, §2 dates excluded).
const newWalletTotals = () => ({ games: 0, profit: 0, volume: 0, both: 0 });
// One settled wallet-game joins the history. boughtBoth: the wallet bought both teams in it.
function addWalletGame(s, profit, volume, boughtBoth) {
  s.games++; s.profit += profit; s.volume += volume;
  if (boughtBoth) s.both++;
  return s;
}
const isQualified = (s) => s.games >= MIN_GAMES && s.profit > 0 && s.volume / s.profit <= MAX_VOL_PER_PROFIT && s.both / s.games < BOTH_MAX;
// cum: Map wallet -> totals. -> [{ w, profit }], in the map's order.
function qualified(cum) {
  const q = [];
  for (const [w, s] of cum) {
    if (isQualified(s)) q.push({ w, profit: s.profit });
  }
  return q;
}
// §3 top 25: profit descending, ties by wallet id ascending.
const topN = (q) => [...q].sort((a, b) => b.profit - a.profit || a.w - b.w).slice(0, TOP_N);

// ---------------------------------------------------------------- §5 price step
// The trends price rule. -> { skip } | { lock }
function priceStep(g) {
  if (!g || g.odds_locked_at == null) return { skip: 'no_odds_locked_at' };
  if (g.market_contamination_reason != null) return { skip: 'contaminated' };
  if (g.market_away_ml == null || g.market_home_ml == null) return { skip: 'moneyline_missing' };
  return { lock: parseUtc(g.odds_locked_at) };
}

// ---------------------------------------------------------------- §4 lean
// Net dollars per outcome for one wallet set: spent buying minus received selling.
const newLeanAcc = () => ({ any: false, net: [0, 0] });
// side +1 buy / -1 sell; usd = price * size.
function addFill(acc, outcome, side, usd) {
  acc.any = true;
  acc.net[outcome] += side * usd;
  return acc;
}
// §4 steps 4-5. -> { skip } | { leanOutcome, negLean }
function leanFrom(acc) {
  if (!acc.any) return { skip: 'no_qualified_money' };
  if (Math.abs(acc.net[0] - acc.net[1]) < TIE_DOLLARS) return { skip: 'tie' };
  return { leanOutcome: acc.net[0] > acc.net[1] ? 0 : 1, negLean: acc.net[0] <= 0 && acc.net[1] <= 0 };
}

// ---------------------------------------------------------------- card decision 2: concentration
// (2026-10-01, the live card -- not part of the pre-registered test.) The
// largest single wallet's net dollars on the lean outcome over the lean
// outcome's net total: the measure behind the card decisions' distribution
// table (docs/polymarket-top-traders-card-decisions-2026-10-01.md). Shown,
// never filtered; flagged at CONCENTRATION_FLAG or more.
// perWallet: Map wallet -> [net0, net1]. -> share | null (lean side net <= 0)
const CONCENTRATION_FLAG = 0.75;
// Decisions 9 and 11: the card's label, and the postseason note.
const CARD_LABEL = 'Top Polymarket traders — display only. Tested on 2026 regular season (#490): no edge found. Not used by the model.';
const POSTSEASON_NOTE = 'tested on 2026 regular season only — no edge found';
function largestWalletShare(perWallet, leanOutcome, leanNet) {
  if (!(leanNet > 0)) return null;
  let top = -Infinity;
  for (const w of perWallet.values()) if (w[leanOutcome] > top) top = w[leanOutcome];
  return top === -Infinity ? null : top / leanNet;
}

module.exports = {
  EXCLUDED_DATES, SEASON_TO, MIN_GAMES, MAX_VOL_PER_PROFIT, BOTH_MAX, MIN_QUALIFIED, TOP_N, TIE_DOLLARS, CONCENTRATION_FLAG,
  parseUtc, newWalletTotals, addWalletGame, isQualified, qualified, topN, priceStep, newLeanAcc, addFill, leanFrom,
  largestWalletShare, CARD_LABEL, POSTSEASON_NOTE,
};
