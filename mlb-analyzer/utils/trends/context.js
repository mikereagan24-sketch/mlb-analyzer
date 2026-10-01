'use strict';

// Team-game context for the trend scenarios (utils/trends/scenarios.js),
// shared by the season backtest (services/trends-backtest.js buildRows) and
// the one-date slate check (services/trends-slate.js). Moved here unchanged
// from buildRows (2026-09-30) so the slate column cannot drift from the
// tested definitions: the backtest still reproduces
// docs/trends-results-2026-09-29.json exactly (scripts/test-trends-results-tab.js).
//
// Pure: no database, no settings, nothing from the pricing path. Callers
// pass the rows and the "priced" rule; the population rule (the backtest's
// date window) stays with the caller.

const { noVig, cents } = require('./scenarios');

const scored = (g) => g.away_score != null && g.home_score != null;
const startUtc = (g) => g.first_pitch_utc || g.scheduled_start_utc || null;
const orderKey = (g) => g.game_date + '|' + (startUtc(g) || '') + '|' + g.game_id;
const key = (g) => g.game_date + '|' + g.game_id;

function prevDay(d) {
  const t = Date.parse(d + 'T12:00:00Z') - 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

// One team's context for each game in `list` (that team's games, scored and
// scheduled; sorted here in place). isPriced(g): whether a game's price
// counts for P.fav / P.dog (prereg §1). local: key -> localParts at the home
// ballpark. Returns key -> { P, lossStreak, winStreak, seriesId, seriesFirst,
// seriesLast, hasNext }.
function teamContexts(t, list, isPriced, local) {
  const out = new Map();
  list.sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0));
  // §5 series: maximal run vs the same opponent at the same home ballpark.
  let sid = 0;
  const series = list.map((g, i) => {
    const opp = g.home_team === t ? g.away_team : g.home_team;
    const prev = list[i - 1];
    const same = prev && (prev.home_team === t ? prev.away_team : prev.home_team) === opp
      && prev.home_team === g.home_team;
    if (!same) sid++;
    return sid;
  });
  const hist = [];                         // scored games so far, in order
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    let P = null, lossStreak = 0, winStreak = 0;
    if (hist.length) {
      const h = hist[hist.length - 1];
      P = h;
      for (let j = hist.length - 1; j >= 0 && !hist[j].won; j--) lossStreak++;
      for (let j = hist.length - 1; j >= 0 && hist[j].won; j--) winStreak++;
    }
    out.set(key(g), {
      P, lossStreak, winStreak, seriesId: series[i],
      seriesFirst: i === 0 || series[i - 1] !== series[i],
      seriesLast: i === list.length - 1 || series[i + 1] !== series[i],
      hasNext: i < list.length - 1,
    });
    if (scored(g)) {
      const home = g.home_team === t;
      const rf = home ? g.home_score : g.away_score, ra = home ? g.away_score : g.home_score;
      const lp = local.get(key(g));
      const priced = isPriced(g);
      const nv = priced ? noVig(home ? g.market_home_ml : g.market_away_ml,
        home ? g.market_away_ml : g.market_home_ml) : null;
      hist.push({ won: rf > ra, margin: rf - ra, runsFor: rf, runsAgainst: ra, home, priced,
        fav: nv != null && nv > 0.5, dog: nv != null && nv < 0.5,
        opp: home ? g.away_team : g.home_team, seriesId: series[i],
        night: lp ? lp.hour >= 17 : null, localDate: lp ? lp.date : null,
        total: g.home_score + g.away_score });
    }
  }
  return out;
}

// S20: G starts before 17:00 local and P started at or after 17:00 local on
// the previous local day (§5). lp = G's local parts.
function dayAfterNight(lp, P) {
  if (!lp || !P || P.night == null || !P.localDate) return false;
  return lp.hour < 17 && P.night === true && P.localDate === prevDay(lp.date);
}

// The scenario context `c` for team side ('away' | 'home') in game g.
// x = that team's teamContexts() entry for g; open = the morning ML capture
// row or undefined; lp = g's local parts; divisions / leagueOf from
// utils/trends/teams.js. Prices are g's stored market_{away,home}_ml.
function teamGameContext(g, side, x, open, lp, openFrom, DIVISION, leagueOf) {
  const T = side === 'home' ? g.home_team : g.away_team;
  const O = side === 'home' ? g.away_team : g.home_team;
  const P = x.P ? Object.assign({}, x.P, { sameSeries: x.P.seriesId === x.seriesId }) : null;
  const mT = side === 'home' ? g.market_home_ml : g.market_away_ml;
  const mO = side === 'home' ? g.market_away_ml : g.market_home_ml;
  const nv = noVig(mT, mO);
  let moveCents = null;
  if (g.game_date >= openFrom && open) {
    const oT = side === 'home' ? open.home_price_ml : open.away_price_ml;
    if (oT != null) moveCents = cents(oT) - cents(mT);
  }
  const dAN = dayAfterNight(lp, P);
  const c = {
    home: side === 'home', fav: nv > 0.5, dog: nv < 0.5, ml: mT, P,
    lossStreak: x.lossStreak, winStreak: x.winStreak,
    seriesFirst: x.seriesFirst, seriesLast: x.seriesLast,
    g2: /-g2$/.test(g.game_id),
    sameDivision: DIVISION[T] === DIVISION[O],
    interleague: leagueOf(T) !== leagueOf(O),
    ownOpener: (side === 'home' ? g.is_opener_game_home : g.is_opener_game_away) === 1,
    moveCents, dayAfterNight: dAN,
  };
  return { T, O, P, mT, mO, nv, dAN, c };
}

// The totals-scenario context `x` for a game, from its two sides'
// teamGameContext() results (S30, S31).
function gameTotalsContext(sides) {
  return { prevTotalGe15: sides.some(s => s.P && s.P.total >= 15), dayAfterNight: sides.some(s => s.dAN) };
}

module.exports = { scored, startUtc, orderKey, key, prevDay, teamContexts, dayAfterNight, teamGameContext, gameTotalsContext };
