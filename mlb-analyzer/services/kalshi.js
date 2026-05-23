// Standalone Kalshi MLB moneyline client.
//
// Purpose: pull KXMLBGAME markets directly from Kalshi's public API to
// SUPPLEMENT the Unabated msId=105 feed, which is intermittently missing
// for liquid Kalshi games. This module is NOT wired into the live model
// — it exists for validation against Unabated before any integration.
//
// API: https://external-api.kalshi.com/trade-api/v2/markets
//       ?series_ticker=KXMLBGAME&limit=200
// No auth (public market data).
//
// NOTE: a sibling fetchKalshiDirect() lives in services/scraper.js but it
// hits api.elections.kalshi.com with the KXMLB series and the older
// KXMLB-26APR14-CHCPHI ticker shape. That code path is unaffected — this
// file targets the newer KXMLBGAME series with its embedded date+time
// ticker layout and dollar-denominated bid/ask fields.

const KALSHI_URL = 'https://external-api.kalshi.com/trade-api/v2/markets';
const SERIES_TICKER = 'KXMLBGAME';
const PAGE_LIMIT = 200;
const MAX_PAGES = 10; // safety stop on the cursor loop

// Liquidity gate. Kalshi's UI displays a per-event DOLLAR volume (e.g.
// $299,325 for CWS-SF) that does NOT exactly equal the sum of the two
// contracts' volume_24h_fp values (222,906 + 44,915 ≈ 267,821, not
// 299,325). The exact unit/reconciliation of volume_24h_fp vs the UI
// dollar figure is UNCONFIRMED, so we don't hardcode a dollar threshold
// we can't justify. MIN_VOLUME defaults to 0 (no gate); per-side
// volume_24h is exposed raw on the output so a sane threshold can be
// calibrated once the unit is pinned down.
const MIN_VOLUME = 0;

// Kalshi abbr → game_log abbr. game_log uses (confirmed via DISTINCT scan):
//   ARI ATH ATL BAL BOS CHC CIN CLE COL CWS DET HOU KC LAA LAD MIA MIL
//   MIN NYM NYY PHI PIT SD SEA SF STL TB TEX TOR WAS
// Verified against a live Kalshi /markets response:
//   AZ  → ARI : OBSERVED (e.g. KXMLBGAME-…COLAZ). Required.
//   WSH → WAS : OBSERVED (e.g. KXMLBGAME-26MAY241610WSHATL). Required.
//   ATH       : Kalshi already emits ATH (e.g. KXMLBGAME-…SEAATH),
//               matching game_log — NO remap (intentionally absent).
// Defensive entries below — Kalshi has NOT been observed emitting these
// long-form abbrs, but if it ever does, the remap lands them in
// game_log's short-form bucket:
//   TBR → TB, KCR → KC, SDP → SD, SFG → SF, CHW → CWS
// Do NOT remove AZ or WSH on the assumption they're hypothetical — both
// are confirmed against live data and the resolver depends on them.
const KALSHI_TO_GAMELOG = {
  AZ:  'ARI',
  WSH: 'WAS',
  TBR: 'TB',
  KCR: 'KC',
  SDP: 'SD',
  SFG: 'SF',
  CHW: 'CWS',
};

// Authoritative game_log abbr set, used to split the {AWAY}{HOME} blob in
// the event ticker. We iterate possible split points and accept the unique
// pair that resolves to two known abbrs (after Kalshi→game_log mapping).
const GAMELOG_ABBRS = new Set([
  'ARI','ATH','ATL','BAL','BOS','CHC','CIN','CLE','COL','CWS','DET','HOU',
  'KC','LAA','LAD','MIA','MIL','MIN','NYM','NYY','PHI','PIT','SD','SEA',
  'SF','STL','TB','TEX','TOR','WAS',
]);

const MONTHS = { JAN:0, FEB:1, MAR:2, APR:3, MAY:4, JUN:5, JUL:6, AUG:7, SEP:8, OCT:9, NOV:10, DEC:11 };

// Normalize a Kalshi abbr to the game_log abbr (passthrough when no mapping).
function normalizeAbbr(kalshiAbbr) {
  return KALSHI_TO_GAMELOG[kalshiAbbr] || kalshiAbbr;
}

// Split a concatenated two-team blob into (away, home) by trying every
// possible split position and accepting the unique split where both halves
// (after normalization) are in GAMELOG_ABBRS. Returns null on ambiguity or
// no match. Handles SF=2 + CWS=3, AZ=2 + LAD=3, etc.
function splitTeamBlob(blob) {
  const matches = [];
  for (let i = 2; i <= blob.length - 2; i++) {
    const a = normalizeAbbr(blob.slice(0, i));
    const h = normalizeAbbr(blob.slice(i));
    if (GAMELOG_ABBRS.has(a) && GAMELOG_ABBRS.has(h)) {
      matches.push({ away: a, home: h });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Parse an event ticker like "KXMLBGAME-26MAY231605CWSSF" into:
//   { game_date: '2026-05-23', away_team: 'CWS', home_team: 'SF',
//     hhmm: '1605', tz_warning: '...' }
//
// IMPORTANT: the embedded time appears to be ET/local. The date->game_date
// mapping derived here is the LOCAL date implied by the ticker; it MUST
// be verified against a known game (e.g. confirm that KXMLBGAME-26MAY231605CWSSF
// maps to the same game_date as game_log's cws-sf row for 2026-05-23)
// before this is trusted. A late ET game could roll a UTC day, and if
// game_log's game_date is stored in UTC for some games we could see drift.
function parseEventTicker(eventTicker) {
  // KXMLBGAME-{YYMONDD}{HHMM}{AWAY}{HOME}[-{TEAM}]
  // The market-level ticker has the trailing -{TEAM}; the event_ticker
  // returned by /markets is the part WITHOUT the trailing team segment,
  // but we accept either by stripping it.
  if (!eventTicker || !eventTicker.startsWith('KXMLBGAME-')) return null;
  const body = eventTicker.slice('KXMLBGAME-'.length);
  // If a trailing -{TEAM} segment is present (market ticker), drop it.
  const core = body.includes('-') ? body.split('-')[0] : body;
  // YY=2 + MON=3 + DD=2 + HHMM=4 = 11 chars before the team blob.
  if (core.length < 12) return null;
  const yy = core.slice(0, 2);
  const mon = core.slice(2, 5);
  const dd = core.slice(5, 7);
  const hhmm = core.slice(7, 11);
  const blob = core.slice(11);
  if (!(mon in MONTHS)) return null;
  const year = 2000 + parseInt(yy, 10);
  const monthIdx = MONTHS[mon];
  const day = parseInt(dd, 10);
  if (isNaN(year) || isNaN(day)) return null;
  // YYYY-MM-DD assembly. This is the LOCAL (ET-assumed) date — see header
  // comment; verify against game_log before trusting.
  const game_date = year + '-'
    + String(monthIdx + 1).padStart(2, '0') + '-'
    + String(day).padStart(2, '0');
  const teams = splitTeamBlob(blob);
  if (!teams) return null;
  return { game_date, away_team: teams.away, home_team: teams.home, hhmm };
}

// Identify which side of an event a market ticker refers to. Market tickers
// look like "KXMLBGAME-26MAY231605CWSSF-CWS"; we return the normalized team
// abbr from the trailing segment.
function sideOfMarket(marketTicker) {
  if (!marketTicker) return null;
  const parts = marketTicker.split('-');
  if (parts.length < 3) return null;
  return normalizeAbbr(parts[parts.length - 1]);
}

// Probability → American moneyline.
//   p >= 0.5 → favorite, negative line: -round(100 * p / (1 - p))
//   p <  0.5 → dog, positive line:        round(100 * (1 - p) / p)
function probToAmerican(p) {
  if (!(p > 0) || !(p < 1)) return null;
  return p >= 0.5
    ? -Math.round(100 * p / (1 - p))
    :  Math.round(100 * (1 - p) / p);
}

// Kalshi taker fee.
//
// Formula (per Kalshi docs):
//   fee_total = ceil_to_cent( COEF * C * (1 - C) * N )
// where C = contract price in dollars, N = contracts. The C*(1-C) shape
// charges the most around 50¢ contracts and tapers toward 0 at the price
// extremes. Round UP to the next whole cent on the TOTAL order, not per
// contract (Kalshi bills the order, not each contract individually).
//
// COEF: Kalshi's published guides say 0.07, but three real fills
// back-solve to ~0.068. Numbers computed and verified, ceil-to-cent:
//   $38.20 stake @ 0.62 → 61.6 contracts, slip says $0.99
//     COEF=0.07  → $1.0159 raw → $1.02 charged  (off by 3¢)
//     COEF=0.068 → $0.9869 raw → $0.99 charged  ✓
//   $100.00 stake @ 0.62 → 161 contracts, slip says $2.60
//     COEF=0.07  → $2.6552 raw → $2.66 charged  (off by 6¢)
//     COEF=0.068 → $2.5793 raw → $2.58 charged  (off by 2¢)
//   $100.00 stake @ 0.50 → 200 contracts, slip says $3.39
//     COEF=0.07  → $3.5000 raw → $3.50 charged  (off by 11¢)
//     COEF=0.068 → $3.4000 raw → $3.40 charged  (off by 1¢)
// The third slip is the important one: C*(1-C) peaks at C=0.50, so the
// fee is at its maximum sensitivity to COEF there. 0.07 misses by 11¢
// at the peak; 0.068 misses by 1¢. That confirms 0.068 is the right
// neighborhood, not just a coincidence at C=0.62. Holding 0.068 as the
// default; treat as configurable and re-verify against fresh slips,
// since the rate may vary by market or change over time.
const KALSHI_FEE_COEF = 0.068;

// Smooth per-contract fee rate (un-rounded). Useful for the model: edge
// calculations need a differentiable per-contract cost, not the bucketed
// per-order total. Returns dollars per contract at price C.
function kalshiTakerFeeRate(price) {
  const C = Number(price);
  if (!Number.isFinite(C) || C <= 0 || C >= 1) return 0;
  return KALSHI_FEE_COEF * C * (1 - C);
}

// Charged taker fee in dollars for an order of `contracts` at `price`.
// This is what Kalshi actually debits: ceil-to-cent on the TOTAL.
function kalshiTakerFee(price, contracts) {
  const C = Number(price);
  const N = Number(contracts);
  if (!Number.isFinite(C) || C <= 0 || C >= 1) return 0;
  if (!Number.isFinite(N) || N <= 0) return 0;
  const raw = KALSHI_FEE_COEF * C * (1 - C) * N;
  // Cent-rounding via integer arithmetic to dodge float drift
  // (e.g. 0.058 → 5.7999999 cents → ceil should give 6, not 7).
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

// Paginated /markets fetch. Follows the cursor field until empty or the
// MAX_PAGES safety stop trips. Returns the flat list of market objects.
async function fetchAllMarkets() {
  const all = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(KALSHI_URL);
    url.searchParams.set('series_ticker', SERIES_TICKER);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);
    const resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('Kalshi /markets HTTP ' + resp.status);
    const data = await resp.json();
    const batch = Array.isArray(data.markets) ? data.markets : [];
    all.push(...batch);
    cursor = data.cursor || null;
    if (!cursor) break;
  }
  return all;
}

// Public entrypoint. Returns the array of MLB moneyline pairs for the
// requested date in the shape documented in the module header.
async function getKalshiMlbLines(date) {
  if (!date) throw new Error('getKalshiMlbLines: date (YYYY-MM-DD) required');

  const nowIso = new Date().toISOString();
  const raw = await fetchAllMarkets();

  // Two markets per event (one per side). Group by event_ticker, accumulate
  // each side, then emit one row per event that matches the requested date.
  const byEvent = new Map();
  for (const m of raw) {
    // Active + unsettled only: status === 'active' AND close_time in future.
    // Settled markets show bid 0.00/ask 1.00 or 0.99/1.00 and would skew
    // any downstream comparison.
    if (m.status !== 'active') continue;
    if (m.close_time && m.close_time <= nowIso) continue;

    const eventTicker = m.event_ticker;
    if (!eventTicker) continue;
    const parsed = parseEventTicker(eventTicker);
    if (!parsed) continue;
    if (parsed.game_date !== date) continue;

    // ASK-based line. Ask is the price you'd pay to enter the position,
    // so the implied probability and resulting American odds reflect the
    // price AFTER the spread — i.e. the bettor's actual fill, not pure
    // mispricing. This is intentional: any edge calc layered on top will
    // already net out Kalshi's spread.
    //
    // Kalshi returns these as JSON STRINGS ("0.4900", "62.64"), not
    // numbers — the original typeof === 'number' guard was always false
    // and dropped every market. parseFloat + Number.isFinite handles both
    // representations (defensive in case Kalshi ever switches to numbers).
    const ask = parseFloat(m.yes_ask_dollars);
    const bid = parseFloat(m.yes_bid_dollars);
    if (!Number.isFinite(ask)) continue;
    const win_prob_ask = ask; // dollars per $1 contract == implied probability
    const ask_ml = probToAmerican(win_prob_ask);

    const sideTeam = sideOfMarket(m.ticker);
    const volumeRaw = parseFloat(m.volume_24h_fp);
    const volume = Number.isFinite(volumeRaw) ? volumeRaw : 0;
    if (volume < MIN_VOLUME) continue;

    if (!byEvent.has(eventTicker)) {
      byEvent.set(eventTicker, {
        game_date: parsed.game_date,
        away_team: parsed.away_team,
        home_team: parsed.home_team,
        event_ticker: eventTicker,
        away: null,
        home: null,
        volume_24h_away: null,
        volume_24h_home: null,
      });
    }
    const evt = byEvent.get(eventTicker);
    const side = {
      ask_ml,
      bid_dollars: Number.isFinite(bid) ? bid : null,
      ask_dollars: ask,
      win_prob_ask,
    };
    if (sideTeam === evt.away_team) {
      evt.away = side;
      evt.volume_24h_away = volume;
    } else if (sideTeam === evt.home_team) {
      evt.home = side;
      evt.volume_24h_home = volume;
    } else {
      // Side abbr didn't match either team — likely a Kalshi abbr we
      // haven't mapped yet, or a malformed ticker. Skip silently rather
      // than producing a half-populated event.
    }
  }

  // Only emit fully-populated events (both sides present). A half-fetched
  // event would be a debugging foot-gun downstream.
  return [...byEvent.values()].filter(e => e.away && e.home);
}

module.exports = {
  getKalshiMlbLines,
  // Taker-fee helpers. kalshiTakerFee returns the dollars Kalshi will
  // actually debit (ceil-to-cent total); kalshiTakerFeeRate returns the
  // smooth per-contract rate for edge math.
  kalshiTakerFee,
  kalshiTakerFeeRate,
  // Exported for unit-testing / inspection. Not part of the stable surface.
  _internal: {
    parseEventTicker,
    sideOfMarket,
    probToAmerican,
    normalizeAbbr,
    splitTeamBlob,
    fetchAllMarkets,
    KALSHI_TO_GAMELOG,
    GAMELOG_ABBRS,
    MIN_VOLUME,
    KALSHI_FEE_COEF,
  },
};

// CLI test: `node services/kalshi.js [YYYY-MM-DD]`. Prints today's lines
// (or the supplied date) in a readable table for eyeball-comparison
// against Unabated.
//
// Also: `node services/kalshi.js feecheck <price> <contracts>` prints
// the computed taker fee so it can be validated against real Kalshi
// slips. e.g. `feecheck 0.62 161` should report $2.58 (real slip $2.60).
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    if (arg === 'feecheck') {
      const price = parseFloat(process.argv[3]);
      const contracts = parseFloat(process.argv[4]);
      if (!Number.isFinite(price) || !Number.isFinite(contracts)) {
        console.error('usage: node services/kalshi.js feecheck <price> <contracts>');
        process.exit(2);
      }
      const ratePerContract = kalshiTakerFeeRate(price);
      const rawTotal = ratePerContract * contracts;
      const chargedTotal = kalshiTakerFee(price, contracts);
      console.log('Kalshi taker fee (COEF = ' + KALSHI_FEE_COEF + ')');
      console.log('  price          = $' + price.toFixed(4));
      console.log('  contracts      = ' + contracts);
      console.log('  rate/contract  = $' + ratePerContract.toFixed(6));
      console.log('  raw total      = $' + rawTotal.toFixed(6));
      console.log('  charged total  = $' + chargedTotal.toFixed(2) + '  (ceil-to-cent)');
      return;
    }
    const date = arg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    console.log('Kalshi MLB moneylines for ' + date + ' (ASK-based, status=active)');
    try {
      const rows = await getKalshiMlbLines(date);
      if (!rows.length) {
        console.log('(no markets matched)');
        return;
      }
      console.log(
        ['away/home', 'away_ml', 'home_ml', 'p(home)', 'vol_away', 'vol_home', 'event_ticker'].join('\t')
      );
      for (const r of rows) {
        console.log([
          r.away_team + '@' + r.home_team,
          r.away.ask_ml,
          r.home.ask_ml,
          r.home.win_prob_ask.toFixed(4),
          r.volume_24h_away,
          r.volume_24h_home,
          r.event_ticker,
        ].join('\t'));
      }
    } catch (e) {
      console.error('error: ' + e.message);
      process.exit(1);
    }
  })();
}
