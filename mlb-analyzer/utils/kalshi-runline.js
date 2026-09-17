'use strict';
// The standard +/-1.5 runline pair, from Kalshi's spread ladder. (2026-09-17)
//
// game_log.market_{away,home}_spread{,_price} and market_spread_src were
// filled by the Unabated merge until that fetch was removed. Kalshi's
// ladder carries the same line: each game has a "TEAM wins by more than 1.5"
// market per team, where YES is TEAM -1.5 and NO is the opponent +1.5. One
// market read both ways is a complete mirrored pair.
//
// WHICH TEAM LAYS -1.5: the one whose 1.5 market has the higher YES ask,
// i.e. the team more likely to win by two. Measured against what Unabated
// wrote, 2026-08-15..09-14, 416 games with a stored runline:
//
//   YES-ask rule, ties to away   405/416 match the stored side
//   YES-ask rule, ties to home   403/416
//   ML favourite lays -1.5       362/416
//
//   by |YES gap| between the two teams' 1.5 markets:
//     < 0.02      37/45     <- coin flips; which team lays -1.5 is arbitrary
//     0.02-0.05   73/74
//     >= 0.05    295/297
//
// COVERAGE, same window: Kalshi had BOTH teams' 1.5 markets for 416 of the
// 416 games with a stored runline, including all 119 whose stored runline
// had come from Polymarket via Unabated. No runline coverage is lost.
//
// Measured by running THIS function over kalshi_spread_markets (0 refused).
// Re-run: node --max-old-space-size=1536 scripts/measure-kalshi-runline-rule.js
//
// Prices must already be fee-adjusted (runOddsJob projects them before
// calling). A pair with a missing or insane price on either side is refused
// rather than half-written -- the same rule Unabated's parse applied.

const { isSaneSpreadPrice } = require('./market-sanity');

const RUNLINE = 1.5;

// rows: Kalshi spread rows for ONE game (any lines; non-1.5 are ignored).
// Returns { away_spread, home_spread, away_price, home_price, src } or
// { refused: '<reason>' }.
function pickKalshiRunline(rows, awayTeam, homeTeam) {
  const away = String(awayTeam || '').toUpperCase();
  const home = String(homeTeam || '').toUpperCase();
  const one = (rows || []).filter(r => Number(r.spread_line) === RUNLINE);
  const A = one.find(r => String(r.spread_team).toUpperCase() === away) || null;
  const H = one.find(r => String(r.spread_team).toUpperCase() === home) || null;
  if (!A && !H) return { refused: 'no 1.5 market' };
  let fav;
  if (A && H) {
    const a = Number(A.yes_ask_dollars), h = Number(H.yes_ask_dollars);
    if (!Number.isFinite(a) && !Number.isFinite(h)) return { refused: 'no yes ask on either 1.5 market' };
    fav = !Number.isFinite(h) ? A : !Number.isFinite(a) ? H : (a >= h ? A : H);
  } else {
    fav = A || H;
  }
  const favIsAway = fav === A;
  const favPrice = fav.yes_ask_ml;
  const dogPrice = fav.no_ask_ml;
  if (!isSaneSpreadPrice(favPrice) || !isSaneSpreadPrice(dogPrice)) {
    return { refused: 'missing or insane price (yes=' + favPrice + ', no=' + dogPrice + ')' };
  }
  return {
    away_spread: favIsAway ? -RUNLINE : RUNLINE,
    home_spread: favIsAway ? RUNLINE : -RUNLINE,
    away_price: favIsAway ? favPrice : dogPrice,
    home_price: favIsAway ? dogPrice : favPrice,
    src: 'kalshi',
  };
}

module.exports = { pickKalshiRunline, RUNLINE };
