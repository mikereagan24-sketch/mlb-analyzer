'use strict';

// Which of one date's games fit each trend scenario -- the Trends tab's
// "Fits the slate" column. (2026-09-30) DISPLAY ONLY, for interest only: no
// trend passed the pre-registered test (docs/trends-results-2026-09-29.json),
// and nothing here feeds the model, a signal or a bet.
//
// Same definitions as the test: the scenario predicates are
// utils/trends/scenarios.js and the team-game context is
// utils/trends/context.js -- the very functions the backtest's buildRows
// calls. What differs is only what a live slate forces (caveats below).
//
// Reads game_log (and the morning ML capture) through a READ-ONLY handle the
// caller passes, with bounded queries: the slate's own rows, then per slate
// team a LIMITed window of its recent and next games. Never the season.
// Imports nothing from the pricing path.
//
// LIVE RULES (decision record: docs/trends-results-tab-decision-2026-09-29.md)
//   * "Previous game priced" = P has a stored LOCKED price: both moneylines,
//     odds_locked_at set, no market_contamination_reason -- the backtest's
//     population rule (prereg §1) WITHOUT its date window
//     (services/trends-backtest.js inPopulation), whatever P's date.
//   * Price-dependent scenarios (PRICE_DEPENDENT): the game's current stored
//     price; before the odds lock a fit is "provisional"; a game whose
//     MONEYLINE is unreliable (a moneyline flag, an unattributable flag, or
//     contamination -- see FLAG_RULES; totals-only flags do not count) is "no
//     reliable price", a game with no stored price "no price" -- neither is
//     classified.
//   * S25/S26 (line move): "pending lock" until the lock price exists.
//   * S23 (series finale): when the team's next game is not in game_log, the
//     finale is unknowable -- "unknown" if the answer depends on it, never
//     assumed.
//   * Postseason (after the trends window's last date, the regular season's
//     end): fits carry "tested on regular season only".

const { SCENARIOS } = require('../utils/trends/scenarios');
const { TEAM_TZ, DIVISION, leagueOf, isTeam, localParts } = require('../utils/trends/teams');
const CX = require('../utils/trends/context');
const { WINDOW_TO, OPEN_FROM } = require('./trends-backtest');

const PRICE_DEPENDENT = new Set(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S12', 'S19',
  'S21', 'S22', 'S23', 'S24', 'S25', 'S26', 'S27', 'S28', 'S29']);
const LINE_MOVE = new Set(['S25', 'S26']);
const HISTORY_DAYS = 45;           // days of history read (idx_game_log_date range); doubled if a streak reaches its start
const NEXT_DAYS = 7;               // days after the slate read, for the series finale (S23)

const COLS = 'game_date, game_id, away_team, home_team, away_score, home_score, market_away_ml, market_home_ml, '
  + 'ml_source, odds_locked_at, market_contamination_reason, odds_flagged, odds_flag_reason, '
  + 'first_pitch_utc, scheduled_start_utc, is_opener_game_away, is_opener_game_home';

// P's price counts (see LIVE RULES): the population rule minus the date window.
const livePriced = (g) => g.market_away_ml != null && g.market_home_ml != null
  && g.odds_locked_at != null && g.market_contamination_reason == null;
const LIVE_PRICED_RULE = 'previous game counts as priced when it has both stored moneylines, odds_locked_at set and no '
  + 'market_contamination_reason, whatever its date (the backtest population rule without its 2026-04-09..2026-09-27 window)';

// "No reliable price" blocks the price-dependent scenarios only for a
// MONEYLINE problem (2026-09-30). game_log.odds_flag_reason is the odds job's
// reasons joined with ' | ' (services/jobs.js:5208); each fragment is
// attributed by where its text is produced. A fragment matching none of these
// -- or a flag with no reason text -- cannot be attributed and still blocks.
const FLAG_RULES = [
  // moneyline
  { re: /^single-source, no cross-check available$/, market: 'moneyline', src: 'services/jobs.js:5090' },
  { re: /^no sane odds$/, market: 'moneyline', src: 'services/jobs.js:5088' },
  { re: /^impossible line pair:/, market: 'moneyline', src: 'utils/market-sanity.js:101,116 via checkOddsSanity services/jobs.js:5092' },
  { re: /^implausible line magnitude:/, market: 'moneyline', src: 'utils/market-sanity.js:108 via checkOddsSanity services/jobs.js:5092' },
  { re: /^extreme line: (away|home) at /, market: 'moneyline', src: 'services/jobs.js:475-476 (checkOddsSanity)' },
  { re: /^Kalshi vs \S+ (disagree on favorite|divergence):/, market: 'moneyline', src: 'services/jobs.js:508,516 (checkBookDivergence)' },
  // totals only
  { re: /^no sane totals:/, market: 'totals', src: 'services/jobs.js:5146' },
  { re: /^single-source total, no cross-check available$/, market: 'totals', src: 'services/jobs.js:5148' },
  { re: /^totals (juice |line )?divergence:/, market: 'totals', src: 'services/jobs.js:4977,4980 at 83bb54a^ (removed 2026-09-17; "line" form 46113cc)' },
  { re: /^no primary totals;/, market: 'totals', src: 'services/jobs.js:4924 at 83bb54a^ (removed 2026-09-17; "edge calc" form d6e7777)' },
];
// Not attributable to one market, so blocking: the double-header guard
// rejects a source's whole write for the game (utils/dh-assignment-guard.js:97,
// services/jobs.js:5566-5567 / 5731-5732: `continue` skips that source's
// moneyline AND totals), plus anything unrecognised.
function classifyFlagFragment(text) {
  const t = String(text || '').trim();
  for (const r of FLAG_RULES) if (r.re.test(t)) return r.market;
  return 'unattributed';
}
function moneylineUnreliable(g) {
  if (g.market_contamination_reason != null) return true;
  if (g.odds_flagged !== 1) return false;
  const frags = String(g.odds_flag_reason || '').split(' | ').filter(s => s.trim());
  if (!frags.length) return true;                       // flagged with no reason text: unattributable
  return frags.some(f => classifyFlagFragment(f) !== 'totals');
}

function priceState(g) {
  if (g.market_away_ml == null || g.market_home_ml == null) return 'no_price';
  if (moneylineUnreliable(g)) return 'unreliable';
  return g.odds_locked_at != null ? 'locked' : 'unlocked';
}

// db: a READ-ONLY better-sqlite3 handle. date: 'YYYY-MM-DD' (the PT slate date).
function slateFits(db, date) {
  const slate = db.prepare('SELECT ' + COLS + ' FROM game_log WHERE game_date = ? AND COALESCE(is_removed, 0) = 0 ORDER BY game_id')
    .all(date).filter(g => isTeam(g.away_team) && isTeam(g.home_team));
  // One bounded range read on idx_game_log_date for the whole slate, not a
  // scan per team: [date - days, date + NEXT_DAYS].
  const windowStmt = db.prepare('SELECT ' + COLS + ' FROM game_log WHERE game_date BETWEEN ? AND ? AND COALESCE(is_removed, 0) = 0');
  const shift = (d, k) => new Date(Date.parse(d + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  let opens = new Map();
  try {
    opens = new Map(db.prepare("SELECT game_id, away_price_ml, home_price_ml FROM empirical_market_captures "
      + "WHERE game_date = ? AND market_type = 'ml' AND capture_track = 'morning'").all(date).map(r => [r.game_id, r]));
  } catch (e) { /* table absent: no opens, S25/S26 simply never fire */ }

  // Per slate team: its games inside the window -> the shared teamContexts().
  // If any slate team's streak runs back to its first scored game in the
  // window, the streak may run further: double the window and redo (bounded).
  const ctx = new Map();                     // team|key -> context entry
  const local = new Map();
  const teams = [...new Set(slate.flatMap(g => [g.away_team, g.home_team]))];
  let days = HISTORY_DAYS, windowRows = 0;
  const firstDate = (db.prepare('SELECT MIN(game_date) d FROM game_log').get() || {}).d;   // idx_game_log_date: O(1)
  for (;;) {
    ctx.clear();
    const from = shift(date, -days);
    const coversAll = firstDate != null && from <= firstDate;      // nothing earlier exists: a streak cannot be cut off
    const rows = windowStmt.all(from, shift(date, NEXT_DAYS)).filter(g => isTeam(g.away_team) && isTeam(g.home_team));
    windowRows = rows.length;
    for (const g of rows) if (!local.has(CX.key(g))) local.set(CX.key(g), localParts(CX.startUtc(g), TEAM_TZ[g.home_team]));
    let truncated = false;
    for (const t of teams) {
      const list = rows.filter(g => g.away_team === t || g.home_team === t);
      const entries = CX.teamContexts(t, list, livePriced, local);
      for (const [k, v] of entries) ctx.set(t + '|' + k, v);
      const scoredPast = list.filter(g => g.game_date < date && CX.scored(g)).length;
      for (const g of slate) {
        if (g.away_team !== t && g.home_team !== t) continue;
        const e = entries.get(CX.key(g));
        if (scoredPast > 0 && Math.max(e.lossStreak, e.winStreak) >= scoredPast) truncated = true;
      }
    }
    if (!truncated || coversAll || days >= 400) break;
    days *= 2;
  }

  const lbl = (g) => g.away_team + '@' + g.home_team + (/-g2$/.test(g.game_id) ? ' (G2)' : '');
  const result = SCENARIOS.map(s => ({ id: s.id, name: s.name, fits: [], noReliablePrice: [], noPrice: [], pendingLock: [] }));
  const byId = Object.fromEntries(result.map(r => [r.id, r]));
  for (const g of slate) {
    const k = CX.key(g), ps = priceState(g);
    const post = g.game_date > WINDOW_TO;
    const notes = post ? ['tested on regular season only'] : [];
    const sides = [];
    for (const side of ['away', 'home']) {
      const T = side === 'home' ? g.home_team : g.away_team;
      const x = ctx.get(T + '|' + k);
      const sc = CX.teamGameContext(g, side, x, opens.get(g.game_id), local.get(k), OPEN_FROM, DIVISION, leagueOf);
      sides.push(sc);
      for (const s of SCENARIOS) {
        if (s.kind !== 'ml') continue;
        const r = byId[s.id];
        if (PRICE_DEPENDENT.has(s.id)) {
          if (ps === 'no_price') { if (!r.noPrice.includes(lbl(g))) r.noPrice.push(lbl(g)); continue; }
          if (ps === 'unreliable') { if (!r.noReliablePrice.includes(lbl(g))) r.noReliablePrice.push(lbl(g)); continue; }
          if (LINE_MOVE.has(s.id) && ps !== 'locked') { if (!r.pendingLock.includes(lbl(g))) r.pendingLock.push(lbl(g)); continue; }
        }
        let fit = s.test(sc.c), status = 'fit';
        if (s.id === 'S23' && !x.hasNext) {
          // The team's next game is not in game_log: whether G ends the series is unknown.
          const ifLast = s.test(Object.assign({}, sc.c, { seriesLast: true }));
          const ifNot = s.test(Object.assign({}, sc.c, { seriesLast: false }));
          if (ifLast !== ifNot) { fit = true; status = 'unknown'; }
        }
        if (!fit) continue;
        if (status === 'fit' && PRICE_DEPENDENT.has(s.id) && ps === 'unlocked') status = 'provisional';
        r.fits.push({ game: lbl(g), game_id: g.game_id, team: sc.T, status, notes });
      }
    }
    const tx = CX.gameTotalsContext(sides);
    for (const s of SCENARIOS) {
      if (s.kind !== 'total' || !s.test(tx)) continue;
      byId[s.id].fits.push({ game: lbl(g), game_id: g.game_id, team: null, bet: s.bet, status: 'fit', notes });
    }
  }
  return {
    date, games: slate.length, postseason: slate.some(g => g.game_date > WINDOW_TO),
    history: { days, rows_read: windowRows },
    rules: { previous_game_priced: LIVE_PRICED_RULE,
      price_dependent: [...PRICE_DEPENDENT], line_move: [...LINE_MOVE],
      provisional: 'price-dependent fit on a game whose price is not locked yet (current stored price)',
      no_reliable_price: 'the MONEYLINE is unreliable -- a moneyline flag (single-source moneyline, no sane odds, impossible or '
        + 'implausible pair, extreme line, Kalshi-vs-cross-check divergence), an unattributable flag, or market_contamination_reason: '
        + 'not classified. Totals-only flags do not block.',
      no_price: 'no stored moneyline yet: not classified',
      pending_lock: 'S25/S26 need the lock price',
      unknown: 'S23 when the team\'s next game is not in game_log and the answer depends on it',
      postseason: 'games after ' + WINDOW_TO + ' carry "tested on regular season only"' },
    scenarios: result,
  };
}

module.exports = { slateFits, PRICE_DEPENDENT, LINE_MOVE, livePriced, LIVE_PRICED_RULE, FLAG_RULES,
  classifyFlagFragment, moneylineUnreliable, _internals: { priceState } };
