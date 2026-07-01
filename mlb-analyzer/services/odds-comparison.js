'use strict';

// Odds-comparison service (Stage 2).
//
// For a chosen bet size (default $100), pulls Polymarket AND Kalshi
// depth-aware fills for each matched MLB game, applies each site's
// taker fee, converts to American odds, and reports the winner
// per game.
//
// READ-ONLY. No signals wired. Failures on either side are captured
// per-game and never block the other side or the caller.

const poly   = require('./polymarket');
const kalshi = require('./kalshi');

const DEFAULT_STAKE_USD = 100;

// One-side pricing: given a normalized best-first ask book, a stake,
// and a taker-fee function, return the at-size fill + fee-adjusted
// effective probability + American odds. Shared shape across Poly
// and Kalshi so downstream comparison is trivial.
function priceAtSize(walkFn, book, stakeUsd, feeFn) {
  const walk = walkFn(book, stakeUsd);
  if (!walk || !(walk.shares_bought > 0)) return null;
  const feeUsd = feeFn(walk.avg_price, walk.shares_bought);
  const effP   = Math.min(0.9999, Math.max(0.0001,
    walk.avg_price + (feeUsd / walk.shares_bought)));
  // Round only for the output display — internal precision retained.
  return {
    top_ask_price:  round4(walk.top_ask_price),
    top_ask_ml:     priceToAmerican(walk.top_ask_price),
    avg_fill_price: round4(walk.avg_price),
    slippage_pp:    round4(walk.slippage_pp),
    shares_bought:  round4(walk.shares_bought),
    filled_usd:     round2(walk.filled_usd),
    partial:        walk.partial,
    fee_usd:        round2(feeUsd),
    eff_price:      round4(effP),
    net_american:   priceToAmerican(effP),
    levels_used:    walk.levels_consumed.length,
  };
}

// Poly-side: normalize book (Stage 1's clobBook does that), walk asks,
// apply back-solved fee. Kalshi-side: fetch orderbook, derive yes-ask
// view (cross the NO bids), walk, apply Kalshi taker fee.
async function priceGame(gameCandidate, stakeUsd) {
  const out = {
    game_id: gameCandidate.game_id,
    away_team: gameCandidate.away_team,
    home_team: gameCandidate.home_team,
    stake_usd: stakeUsd,
    poly:   { away: null, home: null, errors: [] },
    kalshi: { away: null, home: null, errors: [] },
    winner: { away: null, home: null },  // 'poly' | 'kalshi' | 'tie'
  };

  // Poly — books already normalized by clobBook (Stage 1) and attached
  // to gameCandidate.away.book / .home.book. Walk asks.
  try {
    if (gameCandidate.away && gameCandidate.away.book) {
      out.poly.away = priceAtSize(poly.walkAsksForFill,
        gameCandidate.away.book, stakeUsd, poly.polyTakerFee);
    }
    if (gameCandidate.home && gameCandidate.home.book) {
      out.poly.home = priceAtSize(poly.walkAsksForFill,
        gameCandidate.home.book, stakeUsd, poly.polyTakerFee);
    }
  } catch (e) { out.poly.errors.push('poly_walk_failed: ' + e.message); }

  // Kalshi — fetch orderbook per side. On KXMLBGAME each side has its
  // own market ticker ({event_ticker}-{TEAM}); buying YES on the
  // team's market = betting that team wins. To fill YES via depth
  // walk we cross the NO bids on that same market (fetchKalshiOrderbook
  // returns a `yes_asks` view derived from no_bids).
  const kalMatch = gameCandidate._kalshi;   // attached by getComparisonRows
  if (kalMatch) {
    for (const side of ['away', 'home']) {
      const ticker = kalMatch[side + '_ticker'];
      if (!ticker) continue;
      try {
        const ob = await kalshi.fetchKalshiOrderbook(ticker);
        if (!ob || !ob.yes_asks || !ob.yes_asks.length) continue;
        out.kalshi[side] = priceAtSize(kalshi.kalshiWalkAsksForFill,
          ob.yes_asks, stakeUsd, kalshi.kalshiTakerFee);
        if (out.kalshi[side]) {
          out.kalshi[side].market_ticker = ticker;
        }
      } catch (e) { out.kalshi.errors.push('kalshi_' + side + '_walk_failed: ' + e.message); }
    }
  }

  // Winner per side — higher net American odds means the taker pays
  // less / wins more. Compare only when both are present.
  for (const side of ['away', 'home']) {
    const p = out.poly[side] && out.poly[side].net_american;
    const k = out.kalshi[side] && out.kalshi[side].net_american;
    if (p == null || k == null) { out.winner[side] = null; continue; }
    // American-odds comparator: more positive = better for the bettor.
    // For a $100 stake, better net American == more $ won.
    if (Math.abs(p - k) < 1e-6) out.winner[side] = 'tie';
    else out.winner[side] = (p > k) ? 'poly' : 'kalshi';
  }
  return out;
}

// Top-level: pull Poly slate + Kalshi slate, join on game_id, price
// every game at stakeUsd. Returns [comparisonRow].
async function runComparison(dateYYYYMMDD, opts) {
  const stakeUsd = (opts && opts.stakeUsd) || DEFAULT_STAKE_USD;
  const progress = (opts && opts.onProgress) || (() => {});
  progress({ step: 'pull_poly', msg: 'fetching Poly MLB events + books' });
  const polyRows = await poly.getPolymarketMlbLines(dateYYYYMMDD);
  progress({ step: 'pull_poly_done', msg: 'poly rows: ' + polyRows.length });

  progress({ step: 'pull_kalshi', msg: 'fetching Kalshi MLB lines' });
  let kalsRows = [];
  try {
    // includeLive:true so a game that's just started still gets compared
    // — the depth walk is honest either way.
    kalsRows = await require('./kalshi').getKalshiMlbLines(dateYYYYMMDD,
      { includeLive: true });
  } catch (e) {
    progress({ step: 'pull_kalshi_err', msg: e.message });
  }
  progress({ step: 'pull_kalshi_done', msg: 'kalshi rows: ' + kalsRows.length });

  // Kalshi ticker per side is inferable from the event_ticker:
  // KXMLBGAME-26JUL041335MINNYY has market tickers -MIN (away) and
  // -NYY (home). Reconstruct here so priceGame can hit the orderbook
  // endpoint per side.
  const kalsByGid = {};
  for (const k of kalsRows) {
    const ev = k.event_ticker || '';
    // Away = k.away_team (game_log abbr), Home = k.home_team. Kalshi's
    // market suffix uses Kalshi's abbr, which for our purposes is the
    // same game_log abbr we already resolved during Stage-1 parsing —
    // EXCEPT Kalshi emits AZ→ARI, WSH→WAS remaps in its own module
    // (kalshi.normalizeAbbr). k.away_team / k.home_team are POST-remap
    // (verified in services/kalshi.js:433-478), so the ticker suffix
    // is the pre-remap form. Reverse-map by walking known aliases.
    const invMap = { ARI: 'AZ', WAS: 'WSH' };
    const awaySuffix = invMap[k.away_team] || k.away_team;
    const homeSuffix = invMap[k.home_team] || k.home_team;
    kalsByGid[k.game_id] = {
      away_ticker: ev + '-' + awaySuffix,
      home_ticker: ev + '-' + homeSuffix,
    };
  }

  const rows = [];
  let done = 0;
  for (const p of polyRows) {
    if (!p.game_id) continue;
    const kmatch = kalsByGid[p.game_id] || null;
    const candidate = Object.assign({}, p, { _kalshi: kmatch });
    progress({ step: 'price_game', msg: p.game_id + ' (' + (done + 1) + '/' + polyRows.length + ')' });
    const row = await priceGame(candidate, stakeUsd);
    rows.push(row);
    done++;
  }
  progress({ step: 'done', msg: 'priced ' + rows.length + ' games' });
  return { window: { date: dateYYYYMMDD, stake_usd: stakeUsd }, rows };
}

// ────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────
function round2(v) { return v == null ? null : Number(v.toFixed(2)); }
function round4(v) { return v == null ? null : Number(v.toFixed(4)); }
function priceToAmerican(p) {
  if (!(p > 0) || !(p < 1)) return null;
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

module.exports = { runComparison, priceGame, priceAtSize };

// CLI: `node services/odds-comparison.js [YYYY-MM-DD] [stake_usd]`
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    const stakeArg = process.argv[3];
    const date = arg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const stake = stakeArg ? Number(stakeArg) : DEFAULT_STAKE_USD;
    console.log('Odds comparison for ' + date + ' at stake $' + stake);
    console.log('(showing progress — no silent background work)\n');
    const t0 = Date.now();
    const result = await runComparison(date, {
      stakeUsd: stake,
      onProgress: ({ step, msg }) => {
        const ts = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        console.log('  [' + ts + '] ' + step + ': ' + msg);
      },
    });
    console.log();
    console.log('=== Per-game at-size comparison (stake $' + stake + ', American odds after fees) ===');
    console.log([
      'game_id    ',
      '  poly_A →', '  kals_A →', '  win_A',
      '   poly_H →', '  kals_H →', '  win_H',
    ].join('  '));
    console.log('-'.repeat(110));
    const fmt = (side) => {
      if (!side) return '   -   ';
      const ml = side.net_american != null ? String(side.net_american) : '-';
      const top = side.top_ask_ml != null ? String(side.top_ask_ml) : '-';
      const partial = side.partial ? '*' : ' ';
      return (top + '→' + ml + partial).padStart(10);
    };
    for (const r of result.rows) {
      const winFlag = (w) => w === 'poly' ? '  POLY' : w === 'kalshi' ? 'KALSHI' : w === 'tie' ? '  tie ' : '  -   ';
      console.log([
        (r.game_id || '?').padEnd(11),
        fmt(r.poly.away), fmt(r.kalshi.away), winFlag(r.winner.away),
        fmt(r.poly.home), fmt(r.kalshi.home), winFlag(r.winner.home),
      ].join('  '));
    }
    console.log();
    console.log('* = partial fill (book depth < stake). Legend: top→net (partial). Winner = higher net American.');
    // Wins tally
    const tally = { away: {}, home: {} };
    for (const r of result.rows) {
      tally.away[r.winner.away || 'none'] = (tally.away[r.winner.away || 'none'] || 0) + 1;
      tally.home[r.winner.home || 'none'] = (tally.home[r.winner.home || 'none'] || 0) + 1;
    }
    console.log('Away winners:', tally.away);
    console.log('Home winners:', tally.home);
  })().catch(e => { console.error(e && e.stack || e); process.exit(1); });
}
