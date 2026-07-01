'use strict';

// Standalone Polymarket MLB moneyline / totals client (Stage 1).
//
// PURPOSE: pull Polymarket MLB markets directly for eyeball comparison
// against Kalshi. Stage 1 = discover + match + display top-of-book
// ONLY. No signals path. No live wiring. Prove matching first, then
// Stage 2 adds depth walk + fees.
//
// ────────────────────────────────────────────────────────────────────
// KNOWN OPEN ITEMS (verify before Stage 2 depth/fee work):
//
//   1. VENUE-URL VERIFICATION. The owner bets on Polymarket US
//      (regulated USD, QCX). This module currently reads from the
//      shared public endpoints:
//        - Gamma:  https://gamma-api.polymarket.com/events   (discovery)
//        - CLOB:   https://clob.polymarket.com/book          (order book)
//      Discovery via Gamma is documented as venue-agnostic (returns
//      metadata for both international and US-regulated markets). The
//      CLOB read endpoint (/book, /price, /midpoint) is the endpoint
//      most sources reference for both venues — but US-specific
//      market data may live behind a different URL / require a chain
//      parameter. Before Stage 2 (depth-aware fill), verify:
//        - Do the token_ids returned by Gamma for the desired MLB
//          markets resolve on clob.polymarket.com/book?
//        - Are US-regulated market prices identical to international
//          on shared endpoints? (If Poly International and Poly US
//          share the same token_id and orderbook, no venue split;
//          if not, we need the US-specific base URL.)
//      This module isolates the base URLs in `POLY_BASE.gamma` and
//      `POLY_BASE.clob` — swapping to a US-specific host is a single
//      change if needed.
//
//   2. FEE-RATE ENDPOINT. Brief says "use API's own /get-fee-rate;
//      Poly has changed fees repeatedly in 2026." I have NOT verified
//      the exact URL / auth for that endpoint. Stage 1 does NOT need
//      fees. When Stage 2 lands, resolve the endpoint by inspecting a
//      real trade slip (owner has one on hand — the BAL $100 @ 56c
//      ticket, fee $2.56) and back-solving.
//
//   3. TEAM SLUG MATCHING. Gamma events include an `outcomes` array
//      whose entries carry `team` slugs. Matching to game_log's
//      3-letter abbrs (game_id) requires a slug→abbr mapping. The map
//      here (POLY_SLUG_TO_ABBR) is BEST-EFFORT from public knowledge —
//      exact slugs Poly uses need verification against a live response.
//      Mismatches at Stage 1 are the exact class of bug the brief said
//      to catch: "a mismatched game shows wrong odds for the wrong
//      matchup." The CLI at the bottom includes cross-checks so
//      operators can eyeball this.
// ────────────────────────────────────────────────────────────────────

const POLY_BASE = {
  gamma: 'https://gamma-api.polymarket.com',
  clob:  'https://clob.polymarket.com',
};

// Discovery endpoints (Gamma).
//   /events?tag_slug=mlb&closed=false — list MLB events (each event
//     contains N markets; for game outcomes, a single market with two
//     outcomes: away wins / home wins).
//   /markets/{condition_id}            — market metadata.
//
// Order-book endpoints (CLOB).
//   /book?token_id=X                   — full depth: bids + asks each
//                                        an array of {price, size}.
//   /price?token_id=X&side=BUY|SELL    — best price.
//   /midpoint?token_id=X
//   /spread?token_id=X
const TAG_SLUG_MLB = 'mlb';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Polymarket slug → game_log 3-letter abbr. VERIFY against a live
// Gamma response — the entries below are anchored to common slug
// conventions but need eyeball confirmation. Missing slugs show up
// as "unresolved" in the CLI, which is the intended catch.
const POLY_SLUG_TO_ABBR = {
  'arizona-diamondbacks':   'ARI',
  'atlanta-braves':         'ATL',
  'baltimore-orioles':      'BAL',
  'boston-red-sox':         'BOS',
  'chicago-cubs':           'CHC',
  'chicago-white-sox':      'CWS',
  'cincinnati-reds':        'CIN',
  'cleveland-guardians':    'CLE',
  'colorado-rockies':       'COL',
  'detroit-tigers':         'DET',
  'houston-astros':         'HOU',
  'kansas-city-royals':     'KC',
  'los-angeles-angels':     'LAA',
  'los-angeles-dodgers':    'LAD',
  'miami-marlins':          'MIA',
  'milwaukee-brewers':      'MIL',
  'minnesota-twins':        'MIN',
  'new-york-mets':          'NYM',
  'new-york-yankees':       'NYY',
  'athletics':              'ATH',
  'oakland-athletics':      'ATH',
  'philadelphia-phillies':  'PHI',
  'pittsburgh-pirates':     'PIT',
  'san-diego-padres':       'SD',
  'san-francisco-giants':   'SF',
  'seattle-mariners':       'SEA',
  'st-louis-cardinals':     'STL',
  'saint-louis-cardinals':  'STL',
  'tampa-bay-rays':         'TB',
  'texas-rangers':          'TEX',
  'toronto-blue-jays':      'TOR',
  'washington-nationals':   'WAS',
};

// game_id shape matches services/kalshi.buildGameId — {away}-{home}
// lowercase alpha-only. Doubleheader suffix ("-g2"...) preserved when
// the event carries a game-number cue (rare on Poly; kept for parity).
function buildGameId(awayAbbr, homeAbbr, gameNumber) {
  const a = String(awayAbbr || '').toLowerCase().replace(/[^a-z]/g, '');
  const h = String(homeAbbr || '').toLowerCase().replace(/[^a-z]/g, '');
  const base = a + '-' + h;
  return (gameNumber && gameNumber > 1) ? base + '-g' + gameNumber : base;
}

// Cheap ISO → YYYY-MM-DD (ET). Poly's `startDate` is UTC; we display
// per-game in whatever the caller's date param is.
function isoToDateEt(iso) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(iso));
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    return p.year + '-' + p.month + '-' + p.day;
  } catch (e) { return null; }
}

// Convert cents-per-share (0..1) to American odds. Mirrors the
// probability→American conversion in services/kalshi.probToAmerican.
function priceToAmerican(p) {
  if (!(p > 0) || !(p < 1)) return null;
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

// Fetch with a timeout + a short retry ladder. Poly is public and
// usually fast, but the odds-job path must never hang.
async function fetchJson(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 15000;
  const retries = (opts && opts.retries != null) ? opts.retries : 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) {
        // Retryable transient errors: 429, 5xx.
        if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
          lastErr = new Error('HTTP ' + resp.status);
          await new Promise(r => setTimeout(r, (attempt + 1) * 500));
          continue;
        }
        throw new Error('HTTP ' + resp.status + ' for ' + url);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 500));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('unknown fetch failure');
}

// Gamma: list MLB events for the given date (ET).
//
// Filters:
//   - tag_slug=mlb                MLB only
//   - closed=false                drops resolved markets
//   - start_date_min / _max       narrow to games starting on the
//                                 target date (ET). The endpoint's
//                                 default sort surfaces high-volume
//                                 historical futures first, which
//                                 drowns today's per-game events;
//                                 the date-range filter is what
//                                 makes today's slate discoverable.
//                                 CRITICAL — verified empirically:
//                                 without this filter Poly returns
//                                 futures/awards and stale per-game
//                                 events, no today matches.
// Poly game-event titles come in three flavors for the SAME matchup:
//     "Team A vs. Team B"                            ← game-winner ML
//     "Team A vs. Team B - First 5 Innings Winner"   ← derivative
//     "Team A vs. Team B - Player Props"             ← derivative
// The moneyline (Stage 1's target) is the SHORT-title event; consumer
// filters out the "- <suffix>" events downstream in extractSidesFromEvent
// / gameEventOnly.
async function gammaListMlbEvents(dateYYYYMMDD) {
  // Widen the window ± 1 day around dateYYYYMMDD to cover ET/UTC skew:
  // a late-ET game rolls into next-UTC-day, and a game "starting"
  // 2026-06-30 in ET may be timestamped 2026-07-01 UTC. Post-filter
  // to ET-anchored date below.
  const startMin = dateYYYYMMDD || null;
  const startMax = dateYYYYMMDD
    ? addDays(dateYYYYMMDD, 2)   // 2 = today + tomorrow, covers ET-late games
    : null;
  const url = POLY_BASE.gamma
    + '/events?tag_slug=' + encodeURIComponent(TAG_SLUG_MLB)
    + '&closed=false&limit=200'
    + (startMin ? '&start_date_min=' + startMin : '')
    + (startMax ? '&start_date_max=' + startMax : '');
  const data = await fetchJson(url);
  const events = Array.isArray(data) ? data : (data && data.events) || [];
  if (!dateYYYYMMDD) return events;
  return events.filter(e => {
    if (!e || !e.startDate) return false;
    return isoToDateEt(e.startDate) === dateYYYYMMDD;
  });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Is this event the game-winner ("Team A vs. Team B" — no suffix)?
// Poly posts three markets for the same matchup with distinct titles;
// only the un-suffixed one is the moneyline we want at Stage 1.
function isGameWinnerEvent(evt) {
  if (!evt || !evt.title) return false;
  const t = String(evt.title);
  if (!/ vs\.? /.test(t)) return false;
  // Reject titles ending in " - Something" (derivative markets).
  if (/ - /.test(t)) return false;
  return true;
}

// Given a Gamma event, extract the away/home slug pair. Poly's events
// have varying shapes; try the most common ones in order.
//   Event shape observed on typical MLB game markets:
//     e.markets = [ { outcomes: '["Team A","Team B"]',
//                     outcomePrices: '["0.42","0.58"]',
//                     clobTokenIds: '["token_a","token_b"]', ... } ]
//   Sometimes the event title itself contains "Team A vs Team B" —
//   used as a fallback.
function extractSidesFromEvent(evt) {
  if (!evt || !evt.markets || !evt.markets.length) return null;
  // Pick the head-to-head moneyline market. A single event carries
  // multiple markets — moneyline, first-inning-run, spreads, etc.
  // The moneyline is the one whose outcomes are BOTH team names (NOT
  // Yes/No, NOT Over/Under). Empirically observed on Poly's MLB
  // events (e.g. MIL vs STL 2026-06-30):
  //   markets[0] = 'Will there be a run scored in the first inning?'
  //                outcomes = ['Yes', 'No']
  //   markets[1] = 'Milwaukee Brewers vs. St. Louis Cardinals'
  //                outcomes = ['Milwaukee Brewers', 'St. Louis Cardinals']
  // Original `find(o.length===2)` picked markets[0] and produced
  // the "Yes"/"No" slug-resolution failure. Explicit filter:
  const nonTeamOutcomes = new Set(['yes', 'no', 'over', 'under']);
  const mkt = evt.markets.find(m => {
    const o = safeParseJsonMaybe(m && m.outcomes);
    if (!Array.isArray(o) || o.length !== 2) return false;
    // Both outcomes must NOT be Yes/No/Over/Under
    return !o.some(x => nonTeamOutcomes.has(String(x).toLowerCase()));
  });
  if (!mkt) return null;
  const outcomes = safeParseJsonMaybe(mkt.outcomes);
  const prices   = safeParseJsonMaybe(mkt.outcomePrices);
  const tokens   = safeParseJsonMaybe(mkt.clobTokenIds);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;

  // Poly convention (empirically): outcomes[0] is the away team,
  // outcomes[1] is the home team on same-day event pages. Confirm on
  // eyeball — the CLI prints both sides in event-order + asserts
  // away vs home via slug lookup below.
  const awayName = outcomes[0], homeName = outcomes[1];
  const away = resolveTeamSlug(awayName);
  const home = resolveTeamSlug(homeName);
  return {
    event_id: evt.id || evt.slug || null,
    title: evt.title || null,
    start_date_iso: evt.startDate || null,
    away_name: awayName, away_abbr: away,
    home_name: homeName, home_abbr: home,
    away_token_id: tokens && tokens[0] || null,
    home_token_id: tokens && tokens[1] || null,
    away_price_str: prices && prices[0] || null,   // Gamma-cached, may be stale
    home_price_str: prices && prices[1] || null,
    market_condition_id: mkt.conditionId || null,
    market_question: mkt.question || null,
  };
}

// Gamma frequently returns JSON strings for these fields ('["A","B"]');
// occasionally native arrays. Handle both without throwing.
function safeParseJsonMaybe(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// Resolve a Poly outcome name (usually a full team name, e.g. "New York
// Yankees") to a game_log abbr. Case-insensitive. Also tries the
// slug-lowercased form.
function resolveTeamSlug(name) {
  if (!name) return null;
  const key = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (POLY_SLUG_TO_ABBR[key]) return POLY_SLUG_TO_ABBR[key];
  // Loose last-word match (e.g. "Athletics" → "athletics" → ATH).
  const last = key.split('-').slice(-1)[0];
  if (last && POLY_SLUG_TO_ABBR[last]) return POLY_SLUG_TO_ABBR[last];
  return null;
}

// Fetch full order book for a token_id.
//
// CRITICAL — Poly's /book returns arrays in REVERSE order from most
// exchange conventions:
//   raw response bids: ASCENDING  (worst → best), best bid at [-1]
//   raw response asks: DESCENDING (worst → best), best ask at [-1]
// Verified empirically against clob.polymarket.com/book on a live
// TOR-SF market: bids = [0.01, 0.02, 0.04, 0.05], best is 0.05.
// This is DOCUMENTED IMPORTANT because Stage 2's depth walk depends
// on it — walking asks in raw index order would walk the WORST prices
// first, catastrophically.
//
// We NORMALIZE here: return `bids` sorted DESCENDING (best first) and
// `asks` sorted ASCENDING (best first) so downstream code uses the
// same intuition as any other order-book system.
//
// Returns:
//   { bids: [{price, size}, ...],  // sorted DESC (best first)
//     asks: [{price, size}, ...],  // sorted ASC  (best first)
//     min_order_size, tick_size, last_trade_price }
// Null on failure (caller falls back to Gamma-cached price).
async function clobBook(tokenId) {
  if (!tokenId) return null;
  const url = POLY_BASE.clob + '/book?token_id=' + encodeURIComponent(tokenId);
  try {
    const data = await fetchJson(url);
    if (!data) return null;
    // Normalize to industry-standard sort so downstream code doesn't
    // have to remember Poly's quirk.
    const rawBids = (data.bids || []).map(x => ({ price: Number(x.price), size: Number(x.size) }))
      .filter(x => Number.isFinite(x.price) && Number.isFinite(x.size) && x.size > 0);
    const rawAsks = (data.asks || []).map(x => ({ price: Number(x.price), size: Number(x.size) }))
      .filter(x => Number.isFinite(x.price) && Number.isFinite(x.size) && x.size > 0);
    rawBids.sort((a, b) => b.price - a.price);   // descending: best bid first
    rawAsks.sort((a, b) => a.price - b.price);   // ascending: best ask first
    return {
      bids: rawBids,
      asks: rawAsks,
      min_order_size:   data.min_order_size   != null ? Number(data.min_order_size)   : null,
      tick_size:        data.tick_size        != null ? Number(data.tick_size)        : null,
      last_trade_price: data.last_trade_price != null ? Number(data.last_trade_price) : null,
    };
  } catch (e) {
    return null;
  }
}

// Top-of-book ask (best price a taker pays to BUY the yes outcome).
// After clobBook normalization, best ask = asks[0]. Returns
// { price, size } or null if book empty.
function topOfBookAsk(book) {
  if (!book || !book.asks || !book.asks.length) return null;
  const best = book.asks[0];
  if (!Number.isFinite(best.price) || !(best.price > 0) || !(best.price < 1)) return null;
  return { price: best.price, size: best.size };
}
// Top-of-book bid (best price a maker offers to BUY). Kept alongside
// topOfBookAsk for the CLI spread display.
function topOfBookBid(book) {
  if (!book || !book.bids || !book.bids.length) return null;
  const best = book.bids[0];
  if (!Number.isFinite(best.price) || !(best.price > 0) || !(best.price < 1)) return null;
  return { price: best.price, size: best.size };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

// Discover + price MLB moneyline markets for a given date.
//
// Returns [{
//   game_date,
//   game_id,              // 'nyy-bos' style, matches game_log
//   away_team, home_team, // 3-letter abbrs
//   event_id, event_title,
//   away: { token_id, top_ask: {price, size}, ask_ml, book },
//   home: { token_id, top_ask: {price, size}, ask_ml, book },
//   gamma_cached: {away_price, home_price},  // for cross-check with live book
//   errors: [],
// }]
//
// STAGE 1 SCOPE: top-of-book ask only. Books returned for Stage 2 use.
// Fees NOT applied. `ask_ml` is the naive top-of-book American
// conversion — the "displayed price," which the brief said explicitly
// misleads at size. The Stage 2 caller walks the book to compute the
// true at-size average.
async function getPolymarketMlbLines(date, opts) {
  if (!date) throw new Error('getPolymarketMlbLines: date (YYYY-MM-DD) required');
  const includeUnmatched = !!(opts && opts.includeUnmatched);

  const events = await gammaListMlbEvents(date);
  const out = [];
  for (const evt of events) {
    // Filter to game-winner events. Derivative markets ("First 5",
    // "Player Props") come back with the same team pair in their
    // title but a suffix that isGameWinnerEvent rejects.
    if (!isGameWinnerEvent(evt)) continue;
    const sides = extractSidesFromEvent(evt);
    if (!sides) continue;
    if (!includeUnmatched && (!sides.away_abbr || !sides.home_abbr)) continue;

    // Fetch both books in parallel — Poly's /book is fast enough that
    // two sequential calls per game would add ~200-400ms per slate.
    const [awayBook, homeBook] = await Promise.all([
      clobBook(sides.away_token_id),
      clobBook(sides.home_token_id),
    ]);

    const awayTop = topOfBookAsk(awayBook);
    const homeTop = topOfBookAsk(homeBook);

    out.push({
      game_date: date,
      game_id: (sides.away_abbr && sides.home_abbr)
        ? buildGameId(sides.away_abbr, sides.home_abbr)
        : null,
      away_team: sides.away_abbr,
      home_team: sides.home_abbr,
      event_id: sides.event_id,
      event_title: sides.title,
      event_start_iso: sides.start_date_iso,
      away: {
        token_id: sides.away_token_id,
        top_ask: awayTop,
        top_bid: topOfBookBid(awayBook),
        ask_ml: awayTop ? priceToAmerican(awayTop.price) : null,
        book: awayBook,
      },
      home: {
        token_id: sides.home_token_id,
        top_ask: homeTop,
        top_bid: topOfBookBid(homeBook),
        ask_ml: homeTop ? priceToAmerican(homeTop.price) : null,
        book: homeBook,
      },
      // Gamma-cached prices — the API's own last-known values. Not the
      // live book. Kept as a cross-check: they should be close to
      // top_ask.price; if wildly different, the book fetch may have
      // hit a stale token.
      gamma_cached: {
        away_price: parseFloat(sides.away_price_str),
        home_price: parseFloat(sides.home_price_str),
      },
      market_condition_id: sides.market_condition_id,
      market_question: sides.market_question,
      // Diagnostic — surfaces slug-resolution failures for eyeball fix.
      _unresolved: {
        away_name: !sides.away_abbr ? sides.away_name : null,
        home_name: !sides.home_abbr ? sides.home_name : null,
      },
    });
  }
  return out;
}

module.exports = {
  getPolymarketMlbLines,
  // Exported for testing / Stage 2 wiring
  _internal: {
    POLY_BASE,
    POLY_SLUG_TO_ABBR,
    resolveTeamSlug,
    priceToAmerican,
    buildGameId,
    clobBook,
    topOfBookAsk,
    gammaListMlbEvents,
    extractSidesFromEvent,
  },
};

// CLI: `node services/polymarket.js [YYYY-MM-DD]`. Prints today's
// Poly moneylines in the same shape services/kalshi.js does so the
// operator can compare side-by-side.
//
// Also: `node services/polymarket.js verify [YYYY-MM-DD]` runs Poly
// AND Kalshi for the same date, joins on game_id, prints both prices
// side-by-side — the Stage 1 acceptance check.
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    const date = (arg === 'verify' ? process.argv[3] : arg)
      || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (arg === 'verify') {
      const { getKalshiMlbLines } = require('./kalshi');
      console.log('Polymarket + Kalshi side-by-side for ' + date);
      console.log('game_id            poly_away  poly_home  kals_away  kals_home  poly_evt_title');
      const [poly, kals] = await Promise.all([
        getPolymarketMlbLines(date, { includeUnmatched: true }),
        getKalshiMlbLines(date, { includeLive: true }),
      ]);
      const kalsByGid = {};
      for (const k of kals) kalsByGid[k.game_id] = k;
      const seen = new Set();
      for (const p of poly) {
        const gid = p.game_id || '(unresolved)';
        seen.add(gid);
        const k = kalsByGid[gid];
        console.log([
          gid.padEnd(18),
          String(p.away && p.away.ask_ml || '-').padStart(9),
          String(p.home && p.home.ask_ml || '-').padStart(9),
          String((k && k.away && k.away.ask_ml) || '-').padStart(9),
          String((k && k.home && k.home.ask_ml) || '-').padStart(9),
          ' ' + (p.event_title || ''),
        ].join('  '));
        if (p._unresolved && (p._unresolved.away_name || p._unresolved.home_name)) {
          console.log('    ↳ UNRESOLVED SLUGS: away=' + (p._unresolved.away_name || '')
            + ' home=' + (p._unresolved.home_name || '') + ' — add to POLY_SLUG_TO_ABBR');
        }
      }
      // Games in Kalshi but not in Poly (or vice versa) — surface the diff
      const onlyKals = kals.filter(k => !seen.has(k.game_id));
      if (onlyKals.length) {
        console.log('--\nGames in Kalshi but NOT matched from Poly (' + onlyKals.length + '):');
        for (const k of onlyKals) {
          console.log('  ' + k.game_id + '  ' + (k.away_team + '@' + k.home_team));
        }
      }
      return;
    }

    console.log('Polymarket MLB moneylines for ' + date + ' (top-of-book)');
    try {
      const rows = await getPolymarketMlbLines(date, { includeUnmatched: true });
      if (!rows.length) { console.log('(no markets matched)'); return; }
      console.log(['game_id', 'away_ml', 'home_ml', 'away bid/ask', 'home bid/ask', 'spread%', 'event_title'].join('\t'));
      for (const r of rows) {
        const aAsk = r.away && r.away.top_ask;
        const aBid = r.away && r.away.top_bid;
        const hAsk = r.home && r.home.top_ask;
        const hBid = r.home && r.home.top_bid;
        const spreadPct = (aAsk && aBid)
          ? ((aAsk.price - aBid.price) * 100).toFixed(0) + '%' : '-';
        console.log([
          r.game_id || '(unresolved)',
          r.away && r.away.ask_ml != null ? r.away.ask_ml : '-',
          r.home && r.home.ask_ml != null ? r.home.ask_ml : '-',
          (aBid ? aBid.price.toFixed(2) : '-') + '/' + (aAsk ? aAsk.price.toFixed(2) : '-'),
          (hBid ? hBid.price.toFixed(2) : '-') + '/' + (hAsk ? hAsk.price.toFixed(2) : '-'),
          spreadPct,
          r.event_title || '',
        ].join('\t'));
        if (r._unresolved && (r._unresolved.away_name || r._unresolved.home_name)) {
          console.log('  ↳ UNRESOLVED SLUGS: away=' + (r._unresolved.away_name || '')
            + ' home=' + (r._unresolved.home_name || ''));
        }
      }
    } catch (e) {
      console.error('error: ' + (e && e.stack || e));
      process.exit(1);
    }
  })();
}
