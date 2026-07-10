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
const STRIKE_TOL = 1e-6;  // exact strike-match tolerance

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

// Pick the strike on a ladder closest to `target`. Returns
//   { strike, exact: bool, entry }
// where `entry` is the ladder object at that strike. Ladder must be
// sorted ascending by strike. Returns null if empty.
function pickClosestStrike(ladder, target) {
  if (!Array.isArray(ladder) || !ladder.length) return null;
  let best = ladder[0];
  let bestDist = Math.abs(best.strike - target);
  for (const r of ladder) {
    const d = Math.abs(r.strike - target);
    if (d < bestDist) { best = r; bestDist = d; }
  }
  return { strike: best.strike, exact: Math.abs(best.strike - target) < STRIKE_TOL, entry: best };
}

// Price ONE totals line on both venues at stakeUsd, on BOTH sides
// (over + under). Called out from priceGame() only when the caller
// explicitly requests a totals line for this game — the per-strike
// orderbook fetches are the expensive part, so this stays opt-in.
//
// Strike matching: exact match preferred on each venue. If a venue
// only has neighboring strikes, uses the closest and flags
// `matched.exact_{venue}: false` so the caller can render "closest
// strike X.X" honestly.
//
// Returns null if neither venue has a totals ladder for this game.
// Otherwise:
//   {
//     line_requested: number,
//     matched: {
//       poly:   { strike, exact } | null,
//       kalshi: { strike, exact, event_ticker } | null,
//     },
//     over:  { poly: <sideOut>|null, kalshi: <sideOut>|null, winner: 'poly'|'kalshi'|'tie'|null },
//     under: { same shape },
//   }
async function priceTotal(gameRow, line, stakeUsd) {
  const polyLadder = gameRow.totals_ladder || [];
  const kalTotals  = gameRow._kalshi && gameRow._kalshi.totals;   // { event_ticker, ladder }
  const kalLadder  = (kalTotals && kalTotals.ladder) || [];
  if (!polyLadder.length && !kalLadder.length) return null;

  const polyMatch = pickClosestStrike(polyLadder, line);
  const kalMatch  = pickClosestStrike(kalLadder,  line);

  const out = {
    line_requested: line,
    matched: {
      poly:   polyMatch ? { strike: polyMatch.strike, exact: polyMatch.exact } : null,
      kalshi: kalMatch  ? { strike: kalMatch.strike,  exact: kalMatch.exact,
                            event_ticker: kalTotals && kalTotals.event_ticker } : null,
    },
    over:  { poly: null, kalshi: null, winner: null },
    under: { poly: null, kalshi: null, winner: null },
  };

  // ── Poly side ──
  if (polyMatch) {
    const entry = polyMatch.entry;
    try {
      const [overBook, underBook] = await Promise.all([
        poly.clobBook(entry.over_token),
        poly.clobBook(entry.under_token),
      ]);
      if (overBook) {
        out.over.poly = priceAtSize(poly.walkAsksForFill, overBook, stakeUsd, poly.polyTakerFee);
      }
      if (underBook) {
        out.under.poly = priceAtSize(poly.walkAsksForFill, underBook, stakeUsd, poly.polyTakerFee);
      }
    } catch (e) { /* leave nulls; caller handles */ }
  }

  // ── Kalshi side ──
  if (kalMatch && kalTotals && kalTotals.event_ticker) {
    const ticker = kalshi.kalshiTotalsRungTicker(kalTotals.event_ticker, kalMatch.strike);
    if (ticker) {
      try {
        const ob = await kalshi.fetchKalshiOrderbook(ticker);
        if (ob) {
          // On a KXMLBTOTAL rung, YES = over, NO = under. To BUY OVER
          // as a taker, cross the NO bids → yes_asks derived view is
          // exactly what we need. To BUY UNDER, cross YES bids →
          // no_asks derived view. Depth walk is symmetric.
          if (ob.yes_asks && ob.yes_asks.length) {
            out.over.kalshi = priceAtSize(kalshi.kalshiWalkAsksForFill,
              ob.yes_asks, stakeUsd, kalshi.kalshiTakerFee);
            if (out.over.kalshi) out.over.kalshi.market_ticker = ticker;
          }
          if (ob.no_asks && ob.no_asks.length) {
            out.under.kalshi = priceAtSize(kalshi.kalshiWalkAsksForFill,
              ob.no_asks, stakeUsd, kalshi.kalshiTakerFee);
            if (out.under.kalshi) out.under.kalshi.market_ticker = ticker;
          }
        }
      } catch (e) { /* leave nulls */ }
    }
  }

  // Winner per side — higher net American == better for the bettor.
  for (const s of ['over', 'under']) {
    const p = out[s].poly && out[s].poly.net_american;
    const k = out[s].kalshi && out[s].kalshi.net_american;
    if (p == null || k == null) continue;
    if (Math.abs(p - k) < 1e-6) out[s].winner = 'tie';
    else out[s].winner = (p > k) ? 'poly' : 'kalshi';
  }
  return out;
}

// Top-level: pull Poly slate + Kalshi slate, join on game_id, price
// every game at stakeUsd. Returns [comparisonRow].
async function runComparison(dateYYYYMMDD, opts) {
  const stakeUsd = (opts && opts.stakeUsd) || DEFAULT_STAKE_USD;
  const progress = (opts && opts.onProgress) || (() => {});
  // Per-game totals lines to price. Map keyed by game_id, value = line
  // (number). When empty/null, totals pricing is skipped entirely
  // (Stage 2's original ML-only behavior).
  const totalRequests = new Map();
  if (opts && opts.totalRequests) {
    for (const [gid, line] of Object.entries(opts.totalRequests)) {
      const n = Number(line);
      if (Number.isFinite(n)) totalRequests.set(gid, n);
    }
  }

  progress({ step: 'pull_poly', msg: 'fetching Poly MLB events + books' });
  // Poly fetch used to be a bare await — a single Gamma API failure took
  // down the ENTIRE runComparison call (07-10 incident: refresh tail wrote
  // tier-3 raw captures across the slate because Poly's fetch threw and
  // the route fell to its catch → rows=[] → refresh saw cmpRow=null →
  // tier-3). Symmetric with Kalshi's try/catch below: catch, log, keep
  // going with polyRows=[]. Signals fall to tier-2 Kalshi net-at-size or
  // to snapshot fallback (see route + refreshSignalBaselines) instead of
  // to tier-3 raw. runComparison returns a partial (Kalshi-only) result
  // rather than throwing when Poly is down.
  let polyRows = [];
  let _polyErr = null;
  try {
    polyRows = await poly.getPolymarketMlbLines(dateYYYYMMDD);
  } catch (e) {
    _polyErr = e.message || String(e);
    progress({ step: 'pull_poly_err', msg: _polyErr });
  }
  progress({ step: 'pull_poly_done', msg: 'poly rows: ' + polyRows.length
    + '  (with totals ladder: ' + polyRows.filter(r => (r.totals_ladder || []).length).length + ')'
    + (_polyErr ? '  [poly failed: ' + _polyErr + ']' : '') });

  progress({ step: 'pull_kalshi', msg: 'fetching Kalshi MLB lines + totals' });
  let kalsRows = [];
  let kalsTotals = [];
  let _kalErr = null;
  try {
    // includeLive:true so a game that's just started still gets compared
    // — the depth walk is honest either way. Pull totals in parallel;
    // needed only when totalRequests is non-empty but the pull is one
    // slate-level call, cheap.
    [kalsRows, kalsTotals] = await Promise.all([
      kalshi.getKalshiMlbLines(dateYYYYMMDD, { includeLive: true }),
      totalRequests.size
        ? kalshi.getKalshiMlbTotals(dateYYYYMMDD, { includeLive: true })
        : Promise.resolve([]),
    ]);
  } catch (e) {
    _kalErr = e.message || String(e);
    progress({ step: 'pull_kalshi_err', msg: _kalErr });
  }
  progress({ step: 'pull_kalshi_done', msg: 'kalshi ML rows: ' + kalsRows.length
    + '  totals rows: ' + kalsTotals.length });

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
  // Attach Kalshi totals ladder to the same _kalshi bag by game_id.
  const kalsTotByGid = {};
  for (const k of kalsTotals) {
    if (!k.game_id) continue;
    kalsTotByGid[k.game_id] = {
      event_ticker: k.event_ticker,
      ladder: (k.ladder || []).map(r => ({
        strike:            r.strike,
        over_ask_dollars:  r.over_ask,
        under_ask_dollars: r.under_ask,
      })),
    };
  }
  for (const gid of Object.keys(kalsByGid)) {
    if (kalsTotByGid[gid]) kalsByGid[gid].totals = kalsTotByGid[gid];
  }
  // Also carry Kalshi totals for game_ids that have totals but no ML —
  // rare but the ladder itself is still useful for the priceGame stub.
  for (const gid of Object.keys(kalsTotByGid)) {
    if (!kalsByGid[gid]) kalsByGid[gid] = { totals: kalsTotByGid[gid] };
  }

  // Optional filter — Stage 3b calls the endpoint with a small
  // subset of game_ids (the ones with emitted signals). Poly + Kalshi
  // slate pulls above are one-shot anyway (a single Gamma call and a
  // single KXMLBGAME paginate), so the cost saving is in the per-game
  // orderbook fetches (Poly /book × 2 sides + Kalshi /orderbook × 2
  // sides per game). Filtering here skips those.
  const filterSet = opts && Array.isArray(opts.gameIds) && opts.gameIds.length
    ? new Set(opts.gameIds) : null;

  const rows = [];
  let done = 0;
  const candidates = filterSet
    ? polyRows.filter(p => p.game_id && filterSet.has(p.game_id))
    : polyRows;
  for (const p of candidates) {
    if (!p.game_id) continue;
    const kmatch = kalsByGid[p.game_id] || null;
    const candidate = Object.assign({}, p, { _kalshi: kmatch });
    progress({ step: 'price_game', msg: p.game_id + ' (' + (done + 1) + '/' + candidates.length + ')' });
    const row = await priceGame(candidate, stakeUsd);
    // Optional totals pricing — driven by totalRequests. Only fires
    // for games explicitly requested by the caller (Stage 3b passes
    // signal.market_line; Stage 3 matchup block passes g.market_total).
    // Attaches row.totals_priced with the {matched, over, under}
    // shape from priceTotal(); on failure attaches null so callers
    // render an honest empty state.
    const line = totalRequests.get(p.game_id);
    if (line != null) {
      try {
        row.totals_priced = await priceTotal(candidate, line, stakeUsd);
      } catch (e) {
        row.totals_priced = null;
        row._totals_error = e.message;
      }
    }
    // Compact totals ladders on the response for the client to know
    // what strikes are available if it wants to pick a different one.
    row.totals_ladder_summary = {
      poly:   (p.totals_ladder || []).map(x => x.strike),
      kalshi: (kmatch && kmatch.totals && kmatch.totals.ladder || []).map(x => x.strike),
    };
    rows.push(row);
    done++;
  }
  progress({ step: 'done', msg: 'priced ' + rows.length + ' games' });
  return {
    window: { date: dateYYYYMMDD, stake_usd: stakeUsd },
    rows,
    filter_applied: filterSet ? { game_ids: [...filterSet] } : null,
    total_requests_applied: totalRequests.size
      ? Object.fromEntries(totalRequests) : null,
    // Per-source error surface (feat/venue-comparison-resilience). Callers
    // (route + refreshSignalBaselines) use these to decide the snapshot-
    // fallback path: if poly_error is set, rows only reflect Kalshi; if
    // kalshi_error is set, only Poly; if both, rows is empty. Distinct
    // from a bare throw so a Poly outage doesn't nuke the whole response.
    poly_error:   _polyErr,
    kalshi_error: _kalErr,
  };
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

// Shared runComparison cache (feat/venue-comparison-resilience, 2026-07-10).
// Consolidates the previously-independent 60s caches in routes/api.js
// (_oddsComparisonCache) and services/jobs.js (_venueCache). Rationale:
// three callers (route, odds-cron tail refresh, matchup-tab live fetch)
// were each hitting Poly's Gamma API + Kalshi orderbooks independently
// within short windows, and Poly's rate limit is the tightest resource.
// A single shared cache with in-flight-promise dedup guarantees at most
// ONE upstream API pair-fetch per (date, stake, gameIds, totalRequests)
// per TTL window regardless of concurrent callers.
//
// TTL of 60s matches the prior route cache. In-flight dedup (Map value
// is a Promise, not a resolved value) means simultaneous callers with
// the same key await one fetch instead of triggering N.
const _CMP_CACHE_TTL_MS = 60 * 1000;
const _CMP_CACHE_MAX_ENTRIES = 64;
const _cmpCache = new Map(); // key → { at, promise, resolved, data }

function _cmpKey(dateYYYYMMDD, opts) {
  const stake = (opts && opts.stakeUsd) || DEFAULT_STAKE_USD;
  const gids = opts && Array.isArray(opts.gameIds)
    ? opts.gameIds.slice().sort().join(',')
    : 'all';
  const totKeys = opts && opts.totalRequests
    ? Object.entries(opts.totalRequests).sort().map(([k,v]) => k+':'+v).join(',')
    : 'none';
  return dateYYYYMMDD + '|' + stake + '|' + gids + '|t:' + totKeys;
}

async function runComparisonCached(dateYYYYMMDD, opts) {
  const key = _cmpKey(dateYYYYMMDD, opts);
  const now = Date.now();
  const hit = _cmpCache.get(key);
  if (hit && (now - hit.at) < _CMP_CACHE_TTL_MS) {
    // Return cached resolved data OR the still-pending promise (dedup).
    return hit.resolved ? hit.data : hit.promise;
  }
  // Miss (or expired). Fire a single fetch; store the promise so parallel
  // callers land here and await the same in-flight fetch.
  const entry = { at: now, resolved: false, data: null, promise: null };
  entry.promise = (async () => {
    try {
      const data = await runComparison(dateYYYYMMDD, opts);
      entry.data = data;
      entry.resolved = true;
      return data;
    } catch (e) {
      // On throw, mark resolved so subsequent callers within TTL don't
      // re-trigger. Throw the same error to all in-flight awaiters.
      entry.data = { window: { date: dateYYYYMMDD, stake_usd: (opts && opts.stakeUsd) || DEFAULT_STAKE_USD }, rows: [], error: e.message || String(e) };
      entry.resolved = true;
      throw e;
    }
  })();
  _cmpCache.set(key, entry);
  // Trim cache — defensive against long-running processes.
  if (_cmpCache.size > _CMP_CACHE_MAX_ENTRIES) {
    const oldest = [..._cmpCache.entries()].sort((a,b) => a[1].at - b[1].at)[0];
    if (oldest) _cmpCache.delete(oldest[0]);
  }
  return entry.promise;
}

// Synchronous cache peek (fix/venue-lazy-fetch-and-content-guard,
// 2026-07-10). Returns rowsByGid for the default (date, {}) key IF a
// fresh, resolved cache entry exists; otherwise null. Used by
// processGameSignals for its lazy venue lookup — the async
// runComparisonCached path is too expensive to await inside the
// sync per-game processing loop, but a cache HIT is a synchronous
// Map lookup and safe to use.
//
// If the cache is empty or expired, caller falls through to the
// snapshot fallback (also sync — DB read) and finally to
// game_log capture as tier-3.
function peekCachedRowsByGid(dateYYYYMMDD, opts) {
  const key = _cmpKey(dateYYYYMMDD, opts || {});
  const hit = _cmpCache.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) >= _CMP_CACHE_TTL_MS) return null;
  if (!hit.resolved) return null; // in-flight — don't sync-await, let caller fall back
  const data = hit.data;
  if (!data || !Array.isArray(data.rows)) return null;
  const rowsByGid = {};
  for (const r of data.rows) if (r.game_id) rowsByGid[r.game_id] = r;
  return rowsByGid;
}

// Test/admin helper to inspect the cache without exposing the Map.
function _cmpCacheStats() {
  const now = Date.now();
  return {
    size: _cmpCache.size,
    entries: [..._cmpCache.entries()].map(([k, v]) => ({
      key: k, age_ms: now - v.at, resolved: v.resolved, has_error: !!(v.data && v.data.error),
    })),
  };
}

module.exports = { runComparison, runComparisonCached, peekCachedRowsByGid, priceGame, priceAtSize, priceTotal, pickClosestStrike, _cmpCacheStats };

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
