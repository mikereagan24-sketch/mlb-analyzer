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

// Poly's own team abbreviations (from event.teams[].abbreviation) →
// game_log 3-letter abbr. Verified against live Gamma events on
// 2026-07-01: Poly uses 'oak' for Athletics (game_log 'ath'), 'wsh'
// for Nationals (game_log 'was'). All others match game_log directly.
// Pass through unchanged when Poly's abbr already matches game_log
// (default — no map entry needed).
const POLY_ABBR_TO_GAMELOG = {
  oak: 'ath',
  wsh: 'was',
  // Defensive entries in case Poly changes:
  ath: 'ath',
  tbr: 'tb',
  kcr: 'kc',
  sdp: 'sd',
  sfg: 'sf',
  chw: 'cws',
  aoa: 'ath',
  laz: 'laa',
};

function normalizePolyAbbr(polyAbbr) {
  if (!polyAbbr) return null;
  const k = String(polyAbbr).toLowerCase();
  return POLY_ABBR_TO_GAMELOG[k] || k;
}

// Legacy full-team-slug → abbr map, kept only as a fallback for events
// that lack the `teams` array. Any missing slug surfaces as
// unresolved so the operator sees the gap.
const POLY_SLUG_TO_ABBR = {
  'arizona-diamondbacks':   'ari',
  'atlanta-braves':         'atl',
  'baltimore-orioles':      'bal',
  'boston-red-sox':         'bos',
  'chicago-cubs':           'chc',
  'chicago-white-sox':      'cws',
  'cincinnati-reds':        'cin',
  'cleveland-guardians':    'cle',
  'colorado-rockies':       'col',
  'detroit-tigers':         'det',
  'houston-astros':         'hou',
  'kansas-city-royals':     'kc',
  'los-angeles-angels':     'laa',
  'los-angeles-dodgers':    'lad',
  'miami-marlins':          'mia',
  'milwaukee-brewers':      'mil',
  'minnesota-twins':        'min',
  'new-york-mets':          'nym',
  'new-york-yankees':       'nyy',
  'athletics':              'ath',
  'oakland-athletics':      'ath',
  'philadelphia-phillies':  'phi',
  'pittsburgh-pirates':     'pit',
  'san-diego-padres':       'sd',
  'san-francisco-giants':   'sf',
  'seattle-mariners':       'sea',
  'st-louis-cardinals':     'stl',
  'saint-louis-cardinals':  'stl',
  'tampa-bay-rays':         'tb',
  'texas-rangers':          'tex',
  'toronto-blue-jays':      'tor',
  'washington-nationals':   'was',
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

// Gamma: list MLB events whose UNDERLYING GAME plays on the target
// ET date. The critical distinction — Poly's Gamma has TWO date
// concepts on events:
//   startDate      — when the MARKET was created (weeks earlier for
//                    scheduled series). USELESS for finding today's
//                    game.
//   markets[*].gameStartTime — when the underlying GAME plays. This
//                    is what we filter on.
// Slug convention also carries the game date: `mlb-{away}-{home}-{YYYY-MM-DD}`
// verified against 14 live events on 2026-07-01. Slug matching is
// belt-and-suspenders alongside the gameStartTime filter.
//
// PREVIOUS BUG (Stage 1 v1): filter used event.startDate. On a game
// scheduled July 8 whose Poly market was created July 1, the event
// showed startDate=2026-07-01 with startTime=2026-07-08. The v1 code
// picked THAT event for July 1, landed on its placeholder $55 book,
// and returned 0.02/0.98 nonsense. Fixed by filtering on
// markets[0].gameStartTime.
//
// Also: Poly per-game events for TODAY come with liquidity in the
// $500K–$900K range. Placeholder future events are ~$55. If the
// discovered candidates all show <$200, we've almost certainly hit
// a placeholder and should surface that in the CLI as a red flag.
async function gammaListMlbEvents(dateYYYYMMDD) {
  const url = POLY_BASE.gamma
    + '/events?tag_slug=' + encodeURIComponent(TAG_SLUG_MLB)
    + '&closed=false&limit=500';
  const data = await fetchJson(url);
  const events = Array.isArray(data) ? data : (data && data.events) || [];
  if (!dateYYYYMMDD) return events;
  return events.filter(e => matchesGameDate(e, dateYYYYMMDD));
}

// True if the event's underlying game plays on dateYYYYMMDD (ET).
// Precedence:
//   1. markets[0].gameStartTime — authoritative (UTC timestamp).
//   2. event.startTime          — usually same as m[0].gameStartTime.
//   3. slug regex `mlb-*-*-YYYY-MM-DD` — fallback for events with no
//      gameStartTime populated yet.
function matchesGameDate(evt, targetDate) {
  if (!evt) return false;
  const m0 = (evt.markets && evt.markets[0]) || null;
  const t = (m0 && m0.gameStartTime) || evt.startTime || null;
  if (t) return isoToDateEt(t) === targetDate;
  // Fallback: slug carries the date as the last dashed segment.
  const slug = String(evt.slug || '');
  const m = slug.match(/-(\d{4}-\d{2}-\d{2})$/);
  return !!(m && m[1] === targetDate);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Is this event a Poly per-game event (not a future series / award)?
// A per-game event's slug has the `mlb-{away}-{home}-{YYYY-MM-DD}`
// shape (verified against all 14 live per-game slugs on 2026-07-01).
// Award/futures events use different slug shapes.
function isPerGameEvent(evt) {
  if (!evt || !evt.slug) return false;
  return /^mlb-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/.test(String(evt.slug));
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
  // Pick the moneyline market by Poly's own `sportsMarketType='moneyline'`
  // tag. Verified against 2026-07-01 LAD@OAK — the ML market has
  //   sportsMarketType='moneyline', outcomes=['Los Angeles Dodgers',
  //   'Athletics'], prices=['0.615','0.385'], liquidityClob=172729
  // sitting alongside spreads (`baseball_team_first_five_spread`),
  // NRFI (`nrfi`), and totals — each with their own type tag. This is
  // the definitive market picker; the old outcome-name heuristic
  // (reject Yes/No/Over/Under) misfired on placeholder events and
  // occasionally landed on a spread with team-name outcomes.
  //
  // Fallback (for events lacking sportsMarketType) reuses the old
  // team-name-outcomes heuristic. Never fires on today's live events;
  // kept only for defensive parity with earlier code.
  let mkt = evt.markets.find(m => (m && m.sportsMarketType) === 'moneyline');
  if (!mkt) {
    const nonTeamOutcomes = new Set(['yes', 'no', 'over', 'under']);
    mkt = evt.markets.find(m => {
      const o = safeParseJsonMaybe(m && m.outcomes);
      if (!Array.isArray(o) || o.length !== 2) return false;
      return !o.some(x => nonTeamOutcomes.has(String(x).toLowerCase()));
    });
  }
  if (!mkt) return null;
  const outcomes = safeParseJsonMaybe(mkt.outcomes);
  const prices   = safeParseJsonMaybe(mkt.outcomePrices);
  const tokens   = safeParseJsonMaybe(mkt.clobTokenIds);
  if (!Array.isArray(outcomes) || outcomes.length !== 2) return null;

  // AUTHORITATIVE side assignment: use event.teams which carries
  //   [{abbreviation:'lad', ordering:'away'}, {abbreviation:'oak',
  //    ordering:'home'}]
  // This is Poly's own source of truth for which team is home/away
  // and avoids fragile outcome-name → abbr string matching.
  // Fallback (event.teams absent): resolveTeamSlug on outcome names,
  // and assume outcomes[0]=away, outcomes[1]=home per Poly convention.
  let awayAbbr = null, homeAbbr = null, awayName = null, homeName = null;
  let awayIdx = 0, homeIdx = 1;
  const teams = Array.isArray(evt.teams) ? evt.teams : null;
  if (teams && teams.length === 2) {
    const t0 = teams[0], t1 = teams[1];
    const away = t0.ordering === 'away' ? t0 : t1;
    const home = t0.ordering === 'home' ? t0 : t1;
    awayAbbr = normalizePolyAbbr(away && away.abbreviation);
    homeAbbr = normalizePolyAbbr(home && home.abbreviation);
    awayName = (away && away.name) || null;
    homeName = (home && home.name) || null;
    // Match outcome index by team name so token assignment is
    // correct even if Poly ever reorders the outcomes array.
    const findIdx = (name) => {
      if (!name) return -1;
      const lc = String(name).toLowerCase();
      return outcomes.findIndex(o => String(o).toLowerCase() === lc);
    };
    const iA = findIdx(awayName);
    const iH = findIdx(homeName);
    if (iA >= 0 && iH >= 0 && iA !== iH) { awayIdx = iA; homeIdx = iH; }
  } else {
    // Fallback: parse outcome names.
    awayName = outcomes[0]; homeName = outcomes[1];
    awayAbbr = resolveTeamSlug(awayName);
    homeAbbr = resolveTeamSlug(homeName);
  }

  return {
    event_id: evt.id || evt.slug || null,
    title: evt.title || null,
    start_date_iso: evt.startDate || null,
    game_start_time_iso: (mkt && mkt.gameStartTime) || evt.startTime || null,
    away_name: awayName, away_abbr: awayAbbr,
    home_name: homeName, home_abbr: homeAbbr,
    away_token_id: tokens && tokens[awayIdx] || null,
    home_token_id: tokens && tokens[homeIdx] || null,
    away_price_str: prices && prices[awayIdx] || null,
    home_price_str: prices && prices[homeIdx] || null,
    market_condition_id: mkt.conditionId || null,
    market_question: mkt.question || null,
    market_liquidity_clob: mkt.liquidityClob != null ? Number(mkt.liquidityClob) : null,
    event_liquidity_clob: evt.liquidityClob != null ? Number(evt.liquidityClob) : null,
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
// STAGE 2 — depth walk + fees
// ────────────────────────────────────────────────────────────────────
//
// walkAsksForFill(book, stakeUsd) — walks the (already-normalized,
// best-first) ask side of the book, consuming size level by level,
// until stakeUsd of USD notional has been committed. Returns:
//   {
//     filled_usd:      total USD committed across levels (== stakeUsd
//                      when fully filled; less than stakeUsd on partial
//                      due to book depletion)
//     shares_bought:   sum of shares acquired across levels
//     avg_price:       filled_usd / shares_bought  (the REAL taker
//                      average — the "true at-size price")
//     top_ask_price:   book[0].price (headline)
//     slippage_pp:     (avg_price - top_ask_price) * 100  (positive =
//                      worse than headline)
//     levels_consumed: [{price, size_shares, usd}, ...]
//     partial:         true when book couldn't cover stakeUsd
//   }
// Returns null if the ask side is empty.
//
// CRITICAL: This function assumes book.asks is sorted BEST-FIRST
// (ascending price). Stage 1's clobBook() normalization guarantees
// this — walking a Poly raw-ordered array (which is descending) would
// price against the WORST asks first and produce plausible-looking
// nonsense. clobBook() was audited on 2026-07-01 in the Stage 1 fix.
function walkAsksForFill(book, stakeUsd) {
  if (!book || !Array.isArray(book.asks) || !book.asks.length) return null;
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) return null;
  const levels = [];
  let remainingUsd = stakeUsd;
  let sharesTotal = 0;
  for (const lvl of book.asks) {
    if (remainingUsd <= 0) break;
    const price = Number(lvl.price);
    const sizeShares = Number(lvl.size);
    if (!(price > 0) || !(price < 1) || !(sizeShares > 0)) continue;
    const levelUsd = price * sizeShares;
    if (levelUsd >= remainingUsd) {
      // Partial consumption of this level: buy exactly enough shares
      // to hit remainingUsd.
      const sharesTaken = remainingUsd / price;
      levels.push({ price, size_shares: sharesTaken, usd: remainingUsd, full_level: false });
      sharesTotal += sharesTaken;
      remainingUsd = 0;
      break;
    }
    // Consume the whole level and continue.
    levels.push({ price, size_shares: sharesShares(sizeShares), usd: levelUsd, full_level: true });
    sharesTotal += sizeShares;
    remainingUsd -= levelUsd;
  }
  const filledUsd = stakeUsd - Math.max(0, remainingUsd);
  const avg = sharesTotal > 0 ? filledUsd / sharesTotal : null;
  const top = Number(book.asks[0].price);
  // NB: DO NOT round shares_bought / avg_price into the output —
  // rounded values ripple into polyTakerFee's ceil-to-cent boundary
  // and can push a $2.56 fee to $2.57 (verified on BAL slip). Callers
  // should format for display; math must consume raw values.
  return {
    filled_usd:      filledUsd,
    shares_bought:   sharesTotal,
    avg_price:       avg,
    top_ask_price:   top,
    slippage_pp:     avg != null ? (avg - top) * 100 : null,
    levels_consumed: levels,
    partial:         remainingUsd > 1e-6,
  };
}
// Cheap identity — kept to make the intent of the "share size" arg
// explicit in walkAsksForFill and defend against a future off-by-one.
function sharesShares(x) { return x; }

// Polymarket taker fee — BACK-SOLVED from a verified BAL slip.
//
// Live /fee-rate endpoint (clob.polymarket.com/fee-rate?token_id=X)
// returns `base_fee: 1000` uniformly across every MLB token probed on
// 2026-07-01. Poly's public docs don't publish a formula converting
// that constant to the actual charged fee. Rather than guess, we use
// the empirically-solved coefficient:
//
//   verified BAL slip: $100 stake at C=$0.56  →  178.5714... shares,
//                      $2.56 taker fee
//   Because stake / price = shares, price × shares == stake == $100.
//   Therefore  coef × C × (1-C) × N == coef × 100 × (1-C) == 2.56
//   ⇒  coef = 2.56 / 44 = 0.05818181818...  (exact recurring)
//   This ONLY holds when using the exact share count 100/0.56, not
//   the brief's rounded 178.57 (which was where an earlier version of
//   this constant drifted by 4e-6 and pushed the ceil-to-cent from
//   $2.56 to $2.57).
//
// The C×(1-C) shape matches Kalshi's fee shape (peaks at $0.50 tickets,
// tapers to 0 at price extremes). Same rounding convention: ceil-to-cent
// on the TOTAL order (not per-share).
//
// If Poly changes fees, this coefficient WILL drift. The `polyFetchBaseFee`
// helper below persists the API value alongside the computed fee so a
// future slip mismatch is visible in the log — we can re-solve then.
const POLY_TAKER_FEE_COEF = 2.56 / 44;   // = 0.05818181818...

function polyTakerFeeRate(price) {
  const C = Number(price);
  if (!Number.isFinite(C) || C <= 0 || C >= 1) return 0;
  return POLY_TAKER_FEE_COEF * C * (1 - C);
}
function polyTakerFee(price, shares) {
  const C = Number(price);
  const N = Number(shares);
  if (!Number.isFinite(C) || C <= 0 || C >= 1) return 0;
  if (!Number.isFinite(N) || N <= 0) return 0;
  const raw = POLY_TAKER_FEE_COEF * C * (1 - C) * N;
  // Cent-ceil via integer arithmetic — same rounding convention as
  // Kalshi (kalshi.js:302). Guards against float drift near .999999.
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

// Fetch Poly's /fee-rate. Persist raw response for observability. Not
// used to compute the fee (see coefficient note above) — returned so
// callers can log it and flag divergence if the API ever exposes a
// working formula.
async function polyFetchBaseFee(tokenId, side) {
  if (!tokenId) return null;
  const s = side === 'SELL' ? 'SELL' : 'BUY';
  const url = POLY_BASE.clob + '/fee-rate?token_id=' + encodeURIComponent(tokenId) + '&side=' + s;
  try {
    const data = await fetchJson(url);
    return data && Number.isFinite(Number(data.base_fee)) ? Number(data.base_fee) : null;
  } catch (e) {
    return null;
  }
}

// Convert an at-size average price (with fee added) to American odds.
// Includes an intermediate "effective probability" the taker locked
// in, since owner reads American.
function fillToAmerican(avgFillPrice, feeUsd, filledUsd) {
  if (!(avgFillPrice > 0.001 && avgFillPrice < 0.999)) return null;
  if (!(filledUsd > 0)) return null;
  // Effective per-share cost with fee amortized across the fill.
  const shares = filledUsd / avgFillPrice;
  const feePerShare = shares > 0 ? feeUsd / shares : 0;
  const effP = Math.min(0.9999, Math.max(0.0001, avgFillPrice + feePerShare));
  return { eff_price: effP, ml: priceToAmerican(effP) };
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
  // Dedupe by game_id, prefer higher-liquidity event. Poly may keep a
  // placeholder future event live alongside today's real event — the
  // placeholder has liquidity in the low $ (e.g. $55), the real event
  // has $500K+. Picking the higher-liquidity event keeps us on the
  // one traders are actually using.
  const bestPerGid = new Map();
  const candidates = [];
  for (const evt of events) {
    if (!isPerGameEvent(evt)) continue;
    const sides = extractSidesFromEvent(evt);
    if (!sides) continue;
    if (!includeUnmatched && (!sides.away_abbr || !sides.home_abbr)) continue;
    const gid = (sides.away_abbr && sides.home_abbr)
      ? buildGameId(sides.away_abbr, sides.home_abbr) : null;
    const liq = sides.event_liquidity_clob != null ? sides.event_liquidity_clob : 0;
    const prev = gid ? bestPerGid.get(gid) : null;
    if (!prev || liq > prev.liq) {
      bestPerGid.set(gid, { sides, liq, evt });
    }
  }
  for (const { sides } of bestPerGid.values()) candidates.push(sides);

  const out = [];
  for (const sides of candidates) {

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
      game_start_time_iso: sides.game_start_time_iso,
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
      market_liquidity_clob: sides.market_liquidity_clob,
      event_liquidity_clob: sides.event_liquidity_clob,
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
  // Stage 2 depth walk + fees + book fetch
  clobBook,
  walkAsksForFill,
  polyTakerFee,
  polyTakerFeeRate,
  polyFetchBaseFee,
  fillToAmerican,
  POLY_TAKER_FEE_COEF,
  // Exported for testing / Stage 2 wiring
  _internal: {
    POLY_BASE,
    POLY_SLUG_TO_ABBR,
    resolveTeamSlug,
    priceToAmerican,
    buildGameId,
    topOfBookAsk,
    topOfBookBid,
    gammaListMlbEvents,
    extractSidesFromEvent,
    isPerGameEvent,
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

    console.log('Polymarket MLB moneylines for ' + date + ' (top-of-book, ML market)');
    try {
      const rows = await getPolymarketMlbLines(date, { includeUnmatched: true });
      if (!rows.length) { console.log('(no markets matched)'); return; }
      console.log(['game_id       ', 'away_ml', 'home_ml',
        'away bid/ask (mid)', 'home bid/ask (mid)', 'evt_liq  ', 'ml_liq   ', 'game_start_ET', 'event_title'].join('  '));
      for (const r of rows) {
        const aAsk = r.away && r.away.top_ask;
        const aBid = r.away && r.away.top_bid;
        const hAsk = r.home && r.home.top_ask;
        const hBid = r.home && r.home.top_bid;
        const midA = (aAsk && aBid) ? ((aAsk.price + aBid.price) / 2).toFixed(3) : '-';
        const midH = (hAsk && hBid) ? ((hAsk.price + hBid.price) / 2).toFixed(3) : '-';
        const startEt = r.game_start_time_iso ? new Date(r.game_start_time_iso)
          .toLocaleString('en-US', { timeZone: 'America/New_York',
            hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }) : '-';
        console.log([
          (r.game_id || '(unresolved)').padEnd(14),
          String(r.away && r.away.ask_ml != null ? r.away.ask_ml : '-').padStart(7),
          String(r.home && r.home.ask_ml != null ? r.home.ask_ml : '-').padStart(7),
          ((aBid ? aBid.price.toFixed(2) : '-') + '/' + (aAsk ? aAsk.price.toFixed(2) : '-') + '(' + midA + ')').padStart(18),
          ((hBid ? hBid.price.toFixed(2) : '-') + '/' + (hAsk ? hAsk.price.toFixed(2) : '-') + '(' + midH + ')').padStart(18),
          String(r.event_liquidity_clob != null ? Math.round(r.event_liquidity_clob) : '-').padStart(9),
          String(r.market_liquidity_clob != null ? Math.round(r.market_liquidity_clob) : '-').padStart(9),
          startEt.padStart(13),
          r.event_title || '',
        ].join('  '));
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
