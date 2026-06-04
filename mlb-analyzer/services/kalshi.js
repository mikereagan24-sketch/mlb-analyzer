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

// 429 (rate limit) retry schedule. Production hit a single throttle event
// and the whole override silently fell through to backup — we want to try
// genuinely hard before giving up. Array length = number of retries; each
// entry is the delay BEFORE that retry. Total worst-case added latency is
// the sum (1+2+4 = 7s), kept short so the odds-job critical path doesn't
// stall too long.
const KALSHI_RETRY_BACKOFF_MS = [1000, 2000, 4000];
// Ceiling on honoring a Retry-After header. Defends against a misbehaving
// upstream telling us to wait minutes.
const KALSHI_MAX_BACKOFF_MS = 30000;

// Liquidity gate. Kalshi's UI displays a per-event DOLLAR volume (e.g.
// $299,325 for CWS-SF) that does NOT exactly equal the sum of the two
// contracts' volume_24h_fp values (222,906 + 44,915 ≈ 267,821, not
// 299,325). The exact unit/reconciliation of volume_24h_fp vs the UI
// dollar figure is UNCONFIRMED, so we don't hardcode a dollar threshold
// we can't justify. MIN_VOLUME defaults to 0 (no gate); per-side
// volume_24h is exposed raw on the output so a sane threshold can be
// calibrated once the unit is pinned down.
const MIN_VOLUME = 0;

// Pre-game filter. Kalshi keeps a market status='active' DURING the game,
// so without an explicit start-time check the client returns in-progress
// prices (a 4:05 ET game appeared at 9:30 PT today with HOU-CHC -9900 and
// SEA-KC -300 — those are live, not pre-game). Default GAME_START_BUFFER_MIN
// is 0: a game is "live" the instant its scheduled start passes. Set
// positive to exclude games that start within N minutes; e.g. 5 means
// "drop games starting in the next 5 minutes too." Negative would let
// just-started games through.
const GAME_START_BUFFER_MIN = 0;

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
  // Accepts any of these series prefixes:
  //   KXMLBGAME-{YYMONDD}{HHMM}{AWAY}{HOME}[-{TEAM}]    (moneylines)
  //   KXMLBTOTAL-{YYMONDD}{HHMM}{AWAY}{HOME}[-{N}]      (totals strike rungs)
  //   KXMLBSPREAD-{YYMONDD}{HHMM}{AWAY}{HOME}[-{TEAM}{N}] (spread ladder)
  // Inside the prefix the format is identical, so one parser serves all.
  // The market-level ticker has a trailing segment (-{TEAM} for ML,
  // -{N} for totals, -{TEAM}{N} for spreads); the event_ticker
  // returned by /markets typically omits it. We strip the trailing
  // segment regardless of which series it belongs to.
  if (!eventTicker) return null;
  const prefixMatch = eventTicker.match(/^(KXMLBGAME|KXMLBTOTAL|KXMLBSPREAD)-/);
  if (!prefixMatch) return null;
  const body = eventTicker.slice(prefixMatch[0].length);
  // If a trailing -{TEAM} (ML) or -{N} (totals) segment is present, drop it.
  const core = body.includes('-') ? body.split('-')[0] : body;
  // YY=2 + MON=3 + DD=2 + HHMM=4 = 11 chars before the team blob.
  if (core.length < 12) return null;
  const yy = core.slice(0, 2);
  const mon = core.slice(2, 5);
  const dd = core.slice(5, 7);
  const hhmm = core.slice(7, 11);
  let blob = core.slice(11);
  if (!(mon in MONTHS)) return null;

  // Doubleheader suffix. Kalshi appends G<n> to the team-blob with NO
  // separator on doubleheader nightcap markets — verified against
  // KXMLBTOTAL-26MAY231915STLCING2 ("STLCIN" + "G2"). Strip BEFORE the
  // team-blob split so splitTeamBlob sees a clean two-team string.
  //
  // Safety against false-match: confirmed (by enumeration over both the
  // game_log abbr set and Kalshi-side variants) that NO MLB abbr ends in
  // a letter+digit pattern matching /G\d$/. The regex can therefore only
  // fire on a genuine suffix; a normal ticker (no doubleheader) passes
  // through unchanged.
  //
  // game_number convention matches game_log: NULL/1 for single games,
  // 2+ for doubleheader legs.
  let game_number = 1;
  const dhMatch = blob.match(/^(.+)G(\d)$/);
  if (dhMatch) {
    blob = dhMatch[1];
    const n = parseInt(dhMatch[2], 10);
    if (Number.isFinite(n) && n > 0) game_number = n;
  }

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
  return { game_date, away_team: teams.away, home_team: teams.home, hhmm, game_number };
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

// Build a game_id matching the rest of the system's convention. Mirrors
// services/scraper.js makeGameId's normalization (lowercase, strip non-
// alpha, hyphen-join), then appends "-g<N>" for doubleheader nightcaps
// — matches game_log values like "col-nym-g2" written by fetchSchedule.
// gameNumber omitted / 1 / 0 → no suffix. gameNumber 2+ → "-g{N}".
function buildGameId(awayTeam, homeTeam, gameNumber) {
  const a = (awayTeam || '').toLowerCase().replace(/[^a-z]/g, '');
  const h = (homeTeam || '').toLowerCase().replace(/[^a-z]/g, '');
  const base = a + '-' + h;
  return (gameNumber && gameNumber > 1) ? base + '-g' + gameNumber : base;
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

// "ET wall-clock minutes" — a sortable integer representing a moment as
// it reads on a clock in America/New_York. Used to compare game start
// times (embedded ET in the event ticker) to the current ET wall-clock,
// without ever caring whether ET is currently EDT or EST: both sides of
// the comparison are reduced to wall-clock-of-ET, so DST shifts cancel.
//
// Implementation note: Date.UTC of (Y,M-1,D) gives UTC midnight of that
// CALENDAR date, regardless of timezone. Adding the wall-clock hour+minute
// produces a monotonic integer with the property that two such values
// computed for the same timezone differ by exactly the wall-clock minute
// gap between them. We never INTERPRET this number as a UTC instant.
function _etWallClockMinutes(y, mo, d, h, mi) {
  const dayUtc = Math.floor(Date.UTC(+y, +mo - 1, +d) / 60000);
  return dayUtc + +h * 60 + +mi;
}

// Current "now" rendered as ET wall-clock minutes. Uses Intl with
// timeZone:America/New_York so DST is handled by the platform, not by us.
function etMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return _etWallClockMinutes(p.year, p.month, p.day, p.hour, p.minute);
}

// Game start as ET wall-clock minutes, derived from the ticker's embedded
// YYMONDD+HHMM. Returns null on malformed input. Verified against today's
// CWS@SF KXMLBGAME-26MAY231605CWSSF: game_date 2026-05-23, hhmm "1605"
// → 16:05 ET (4:05 PM ET / 1:05 PM PT), which matches SF's Saturday
// home start time.
function etMinutesFromTicker(parsed) {
  if (!parsed || !parsed.game_date || !parsed.hhmm) return null;
  const [y, mo, d] = parsed.game_date.split('-');
  if (!y || !mo || !d) return null;
  const h = parsed.hhmm.slice(0, 2);
  const mi = parsed.hhmm.slice(2, 4);
  return _etWallClockMinutes(y, mo, d, h, mi);
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

// Parse a Retry-After response header. RFC 7231 allows either an integer
// (delta-seconds) or an HTTP-date. Returns milliseconds-to-wait, or null
// when absent / unparseable (caller falls back to the backoff schedule).
function _parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const trimmed = String(headerValue).trim();
  // delta-seconds form: pure integer.
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  // HTTP-date form: parse and diff against now.
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// Paginated /markets fetch. Follows the cursor field until empty or the
// MAX_PAGES safety stop trips. Returns the flat list of market objects.
// On HTTP 429 (rate limit), retries with exponential backoff per
// KALSHI_RETRY_BACKOFF_MS, honoring a Retry-After header when present.
// After retries are exhausted, throws — the override block's try/catch
// in services/jobs.js catches it and falls through to the
// Unabated/OddsAPI backup safely. Other non-OK statuses fail fast.
//
// seriesTicker defaults to SERIES_TICKER (KXMLBGAME, moneylines) so the
// existing ML caller works unchanged. getKalshiMlbTotals passes
// 'KXMLBTOTAL' to pull the totals ladder instead.
async function fetchAllMarkets(seriesTicker) {
  const series = seriesTicker || SERIES_TICKER;
  const all = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(KALSHI_URL);
    url.searchParams.set('series_ticker', series);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    // 429-aware fetch loop. Each iteration either:
    //   - returns a non-429 response (success OR a different error) and breaks
    //   - returns 429 with retries remaining → wait then re-enter loop
    //   - returns 429 with no retries left → break and let the throw fire
    let resp = null;
    for (let attempt = 0; attempt <= KALSHI_RETRY_BACKOFF_MS.length; attempt++) {
      resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
      if (resp.status !== 429) break;
      if (attempt === KALSHI_RETRY_BACKOFF_MS.length) break;
      const headerWait = _parseRetryAfter(resp.headers.get('Retry-After'));
      const wait = headerWait != null
        ? Math.min(headerWait, KALSHI_MAX_BACKOFF_MS)
        : KALSHI_RETRY_BACKOFF_MS[attempt];
      console.warn('[kalshi] /markets 429 page=' + page
        + ' attempt=' + (attempt + 1) + '/' + KALSHI_RETRY_BACKOFF_MS.length
        + ' waiting=' + wait + 'ms'
        + (headerWait != null ? ' (Retry-After honored)' : ' (backoff schedule)'));
      await new Promise(r => setTimeout(r, wait));
    }
    if (!resp.ok) {
      if (resp.status === 429) {
        throw new Error('Kalshi /markets HTTP 429 — rate-limited after '
          + KALSHI_RETRY_BACKOFF_MS.length + ' retries');
      }
      throw new Error('Kalshi /markets HTTP ' + resp.status);
    }
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
//
// opts.includeLive (default false): when false, drop games whose ET start
//   time has passed (Kalshi keeps markets status='active' DURING the game
//   and would otherwise feed in-progress prices into the consumer). When
//   true, all matching games are returned with `is_live` flagged — used
//   by the CLI for visual validation of the filter.
// opts.bufferMin (default GAME_START_BUFFER_MIN): minutes of safety
//   margin before scheduled start. With bufferMin=5, a game starting in
//   3 minutes is treated as live.
async function getKalshiMlbLines(date, opts) {
  if (!date) throw new Error('getKalshiMlbLines: date (YYYY-MM-DD) required');
  const includeLive = !!(opts && opts.includeLive);
  const bufferMin = (opts && opts.bufferMin != null)
    ? Number(opts.bufferMin) : GAME_START_BUFFER_MIN;

  const nowIso = new Date().toISOString();
  const nowEtMin = etMinutesNow();
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
      // Compute start time + live status ONCE per event (both market
      // tickers share the same start). is_live=true means scheduled
      // start (minus optional buffer) has already passed in ET wall-clock.
      const startMin = etMinutesFromTicker(parsed);
      const isLive = startMin != null
        && (startMin - bufferMin) <= nowEtMin;
      byEvent.set(eventTicker, {
        game_date: parsed.game_date,
        away_team: parsed.away_team,
        home_team: parsed.home_team,
        // game_number + game_id let consumers map directly to game_log
        // rows. Doubleheader nightcaps (G2+) get the "-g{N}" suffix that
        // matches game_log; single games / game-1 stay unsuffixed.
        game_number: parsed.game_number,
        game_id: buildGameId(parsed.away_team, parsed.home_team, parsed.game_number),
        event_ticker: eventTicker,
        start_et: parsed.hhmm, // 4-digit ET HHMM, e.g. "1605"
        is_live: isLive,
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
  // event would be a debugging foot-gun downstream. Live games are dropped
  // unless the caller opted in via includeLive — Kalshi keeps markets
  // active during play, and an in-progress price would silently bleed
  // into edge calculations that assume a pre-game line.
  return [...byEvent.values()]
    .filter(e => e.away && e.home)
    .filter(e => includeLive || !e.is_live);
}

// Public entrypoint for totals. Returns one row per matching event with
// the chosen ladder rung (over/under prices + fee-adjusted American odds)
// plus the full strike ladder for downstream consumers that want to pick
// their own line. Pre-game gated like the ML path.
//
// Each Kalshi totals event has ~3–11 strike markets (one per half-run
// rung), each a binary "Over floor_strike runs". yes = OVER, no = UNDER.
//
// opts.line (default null): target strike. When set, return the rung
//   whose floor_strike equals it; if no exact match exists, return the
//   nearest available rung. The returned `line` field is the ACTUAL strike
//   used — never silently substitutes a different number; the caller
//   sees the real value.
// opts.includeLive (default false): include in-progress games. Default
//   excludes them — Kalshi keeps totals markets active during play and
//   their prices reflect live game state, not a pre-game line.
// opts.bufferMin (default GAME_START_BUFFER_MIN): pre-start safety margin
//   for the is_live check.
// Default line when opts.line is not specified: the rung whose yes_ask
//   (over price) is closest to $0.50 — matches Kalshi's UI "fair" pick
//   and keeps the call usable without prior knowledge of typical totals.
//
// Fee adjustment: each side (over, under) is fee-loaded INDEPENDENTLY
// using its own contract price, since C * (1 - C) differs by side.
async function getKalshiMlbTotals(date, opts) {
  if (!date) throw new Error('getKalshiMlbTotals: date (YYYY-MM-DD) required');
  const includeLive = !!(opts && opts.includeLive);
  const bufferMin = (opts && opts.bufferMin != null)
    ? Number(opts.bufferMin) : GAME_START_BUFFER_MIN;
  const targetLine = (opts && opts.line != null) ? Number(opts.line) : null;

  const nowIso = new Date().toISOString();
  const nowEtMin = etMinutesNow();
  const raw = await fetchAllMarkets('KXMLBTOTAL');

  // Group strike rungs by event_ticker. Each event has many rungs (one
  // market per half-run line); the chosen rung is selected after all
  // rungs for an event have been collected.
  const byEvent = new Map();
  for (const m of raw) {
    // Same filters as ML: active + not-yet-settled.
    if (m.status !== 'active') continue;
    if (m.close_time && m.close_time <= nowIso) continue;

    const eventTicker = m.event_ticker;
    if (!eventTicker) continue;
    const parsed = parseEventTicker(eventTicker);
    if (!parsed) continue;
    if (parsed.game_date !== date) continue;

    // floor_strike comes through as a number from Kalshi (unlike the
    // dollar fields, which are strings). Coerce anyway for safety.
    const strike = Number(m.floor_strike);
    if (!Number.isFinite(strike)) continue;

    // Side prices are strings — same pattern as ML.
    const overAsk = parseFloat(m.yes_ask_dollars);
    const underAsk = parseFloat(m.no_ask_dollars);
    if (!Number.isFinite(overAsk) || !Number.isFinite(underAsk)) continue;
    const overBid = parseFloat(m.yes_bid_dollars);
    const underBid = parseFloat(m.no_bid_dollars);

    if (!byEvent.has(eventTicker)) {
      const startMin = etMinutesFromTicker(parsed);
      const isLive = startMin != null
        && (startMin - bufferMin) <= nowEtMin;
      byEvent.set(eventTicker, {
        game_date: parsed.game_date,
        away_team: parsed.away_team,
        home_team: parsed.home_team,
        // Doubleheader-aware game_id (see buildGameId helper). Single
        // games / game-1 pass through unsuffixed; G2+ tickers get the
        // "-g{N}" suffix matching game_log.
        game_number: parsed.game_number,
        game_id: buildGameId(parsed.away_team, parsed.home_team, parsed.game_number),
        event_ticker: eventTicker,
        start_et: parsed.hhmm,
        is_live: isLive,
        rungs: [],
      });
    }
    byEvent.get(eventTicker).rungs.push({
      strike,
      over_ask_dollars: overAsk,
      over_bid_dollars: Number.isFinite(overBid) ? overBid : null,
      under_ask_dollars: underAsk,
      under_bid_dollars: Number.isFinite(underBid) ? underBid : null,
    });
  }

  // Fee-adjust a single side's American odds. C is the side's ask price
  // in dollars; the inversion through probToAmerican is float-fragile at
  // the boundaries so we guard both ends. Returns null on degenerate input.
  const feeAdjustAmericanFromC = (C) => {
    if (!Number.isFinite(C) || !(C > 0.001 && C < 0.999)) return null;
    const adj = C + kalshiTakerFeeRate(C);
    if (!(adj > 0.001 && adj < 0.999)) return null;
    return probToAmerican(adj);
  };

  // Interpolated fair total (observation-only — does NOT change `line`,
  // which remains the snapped bettable rung). De-vig each rung's over
  // price to remove Kalshi's spread, then find the adjacent rung pair
  // where pOver crosses 0.50 and linearly interpolate between the two
  // strikes for a continuous fair-total estimate.
  //
  // Why: without this, kalshi_implied_total downstream snapped to the
  // chosen rung's .5 value (e.g. chc-pit 2026-05-26 with over crossing
  // 0.50 between strike 7.5 (over $0.55) and 8.5 (over $0.47) — true
  // fair ~8.03 — was reported as 8.5, showing a fake ±1.00 divergence
  // vs market 7.5). Interpolation lands the observation field on the
  // honest sub-run value the rungs actually imply.
  //
  // Guards:
  //   - Need at least 2 priced rungs to bracket. Returns null otherwise.
  //   - Degenerate rung (over+under <= 0 or non-finite): skipped,
  //     doesn't participate in pair-walking.
  //   - Non-monotonic pair (pOver_low < pOver_high): a well-priced
  //     ladder always has pOver strictly decreasing as strike rises;
  //     a pair violating that is stale/illiquid on one side, skip.
  //   - No crossover at all (entire ladder >= 0.50 or all < 0.50):
  //     returns null — DO NOT extrapolate beyond the ladder. Caller
  //     (jobs.js) falls back to the snapped `line` in that case.
  const computeImpliedTotal = (rungs) => {
    if (!rungs || rungs.length < 2) return null;
    const priced = [];
    for (const r of rungs) {
      const o = r.over_ask_dollars;
      const u = r.under_ask_dollars;
      const sum = o + u;
      if (!(Number.isFinite(o) && Number.isFinite(u) && o > 0 && u > 0 && sum > 0)) continue;
      priced.push({ strike: r.strike, pOver: o / sum });
    }
    if (priced.length < 2) return null;
    // Caller sorted rungs ascending by strike before invoking us, so
    // priced[] is also strike-ascending.
    for (let i = 0; i < priced.length - 1; i++) {
      const lo = priced[i];
      const hi = priced[i + 1];
      if (lo.pOver < hi.pOver) continue; // non-monotonic, skip
      if (lo.pOver >= 0.50 && hi.pOver < 0.50) {
        const span = lo.pOver - hi.pOver;
        if (!(span > 0)) return null; // defensive — caught by monotonic check
        const frac = (lo.pOver - 0.50) / span;
        const interp = lo.strike + frac * (hi.strike - lo.strike);
        return Math.round(interp * 100) / 100;
      }
    }
    return null;
  };

  const results = [];
  for (const evt of byEvent.values()) {
    if (!includeLive && evt.is_live) continue;
    if (!evt.rungs.length) continue;

    // Sort ascending by strike so the ladder reads naturally and the
    // nearest-strike search has a stable tie-break (first-seen at equal
    // distance, but the lower strike wins by sort order — minor, but
    // documenting so it's predictable if the caller hits a tie).
    evt.rungs.sort((a, b) => a.strike - b.strike);

    // Continuous fair-total estimate from the de-vigged ladder. Observation
    // only — `chosen.strike` below (and the per-side prices) are unchanged.
    const impliedTotal = computeImpliedTotal(evt.rungs);

    let chosen;
    if (targetLine != null) {
      // Target a specific line; if no exact match, take the nearest.
      let best = null;
      let bestDist = Infinity;
      for (const r of evt.rungs) {
        const d = Math.abs(r.strike - targetLine);
        if (d < bestDist) { best = r; bestDist = d; }
      }
      chosen = best;
    } else {
      // No target — pick the rung whose OVER ask is closest to $0.50
      // (Kalshi's implied "fair" line). Matches the UI's default pick.
      let best = null;
      let bestDist = Infinity;
      for (const r of evt.rungs) {
        const d = Math.abs(r.over_ask_dollars - 0.50);
        if (d < bestDist) { best = r; bestDist = d; }
      }
      chosen = best;
    }

    const overC = chosen.over_ask_dollars;
    const underC = chosen.under_ask_dollars;
    results.push({
      game_date: evt.game_date,
      away_team: evt.away_team,
      home_team: evt.home_team,
      game_number: evt.game_number,
      game_id: evt.game_id,
      event_ticker: evt.event_ticker,
      start_et: evt.start_et,
      is_live: evt.is_live,
      // `line` is the snapped bettable rung (what the model bets
      // against). `implied_total` is the continuous interpolated fair
      // value from the de-vigged ladder — null when the ladder doesn't
      // bracket pOver=0.50, in which case callers should fall back to
      // `line`. Storage downstream uses interpolated when present.
      line: chosen.strike,
      implied_total: impliedTotal,
      over: {
        ask_dollars: overC,
        ask_ml: probToAmerican(overC),
        fee_adj_ml: feeAdjustAmericanFromC(overC),
      },
      under: {
        ask_dollars: underC,
        ask_ml: probToAmerican(underC),
        fee_adj_ml: feeAdjustAmericanFromC(underC),
      },
      ladder: evt.rungs.map(r => ({
        strike: r.strike,
        over_ask: r.over_ask_dollars,
        under_ask: r.under_ask_dollars,
      })),
    });
  }

  return results;
}

// Extract spread_team + suffix N from a KXMLBSPREAD market ticker.
// Spread tickers tail with "{TEAM}{N}" (e.g. "LAA2" for "LAA wins
// by more than 1.5 runs"; "COL10" for "COL wins by more than 9.5
// runs"). sideOfMarket above can't handle this because it would
// run "LAA2" through normalizeAbbr and emit literally "LAA2".
//
// Returns { team, suffixN } or null on malformed input. Caller uses
// market.floor_strike for the actual spread line — suffixN is kept
// only for debugging / cross-checks (suffixN should equal
// floor_strike + 0.5 in practice).
function parseSpreadSide(marketTicker) {
  if (!marketTicker) return null;
  const parts = marketTicker.split('-');
  if (parts.length < 3) return null;
  const tail = parts[parts.length - 1];
  const m = tail.match(/^([A-Z]+?)(\d+)$/);
  if (!m) return null;
  return { team: normalizeAbbr(m[1]), suffixN: parseInt(m[2], 10) };
}

// Public entrypoint for the Kalshi MLB spread ladder. Returns one
// row per spread market (NOT one per game) — each Kalshi event has
// ~10-12 spread markets (1.5 through 9.5 in 1-run steps, two sides
// per game). Each row carries spread_team (the side favored at this
// rung), spread_line (the half-run line), and the raw Kalshi prices
// + probToAmerican-converted asks. Caller is responsible for fee +
// shift adjustment on yes_ask_ml / no_ask_ml (jobs.js mirrors the
// ML path here).
//
// opts.includeLive (default false): include in-progress games. Pre-
//   game gating mirrors getKalshiMlbLines / getKalshiMlbTotals.
// opts.bufferMin (default GAME_START_BUFFER_MIN): pre-start safety.
async function getKalshiMlbSpreads(date, opts) {
  if (!date) throw new Error('getKalshiMlbSpreads: date (YYYY-MM-DD) required');
  const includeLive = !!(opts && opts.includeLive);
  const bufferMin = (opts && opts.bufferMin != null)
    ? Number(opts.bufferMin) : GAME_START_BUFFER_MIN;

  const nowIso = new Date().toISOString();
  const nowEtMin = etMinutesNow();
  const raw = await fetchAllMarkets('KXMLBSPREAD');

  // Compute per-event start time / is_live ONCE (cached by
  // event_ticker) so each market for that event reuses it without
  // re-parsing or re-comparing wall-clock.
  const eventMeta = new Map();
  function getEventMeta(parsed, eventTicker) {
    if (eventMeta.has(eventTicker)) return eventMeta.get(eventTicker);
    const startMin = etMinutesFromTicker(parsed);
    const isLive = startMin != null && (startMin - bufferMin) <= nowEtMin;
    const meta = {
      game_date: parsed.game_date,
      away_team: parsed.away_team,
      home_team: parsed.home_team,
      game_number: parsed.game_number,
      game_id: buildGameId(parsed.away_team, parsed.home_team, parsed.game_number),
      start_et: parsed.hhmm,
      is_live: isLive,
    };
    eventMeta.set(eventTicker, meta);
    return meta;
  }

  const results = [];
  for (const m of raw) {
    // Same active + unsettled filters as the ML / totals paths.
    if (m.status !== 'active') continue;
    if (m.close_time && m.close_time <= nowIso) continue;

    const eventTicker = m.event_ticker;
    if (!eventTicker) continue;
    const parsed = parseEventTicker(eventTicker);
    if (!parsed) continue;
    if (parsed.game_date !== date) continue;

    // floor_strike comes through as a number from Kalshi (same as
    // totals). spread_line is just floor_strike — the YES side wins
    // when the team wins by MORE than floor_strike runs, which is
    // equivalent to taking that team at -floor_strike on a runline.
    const strike = Number(m.floor_strike);
    if (!Number.isFinite(strike)) continue;

    const side = parseSpreadSide(m.ticker);
    if (!side || !side.team) continue;

    const yesAsk = parseFloat(m.yes_ask_dollars);
    const yesBid = parseFloat(m.yes_bid_dollars);
    const noAsk  = parseFloat(m.no_ask_dollars);
    const noBid  = parseFloat(m.no_bid_dollars);
    // Skip markets with no usable yes_ask — bid-only or pure-no-side
    // entries can't produce a meaningful spread line for analysis.
    if (!Number.isFinite(yesAsk)) continue;

    const volumeRaw = parseFloat(m.volume_24h_fp);
    const volume = Number.isFinite(volumeRaw) ? volumeRaw : 0;
    if (volume < MIN_VOLUME) continue;

    const meta = getEventMeta(parsed, eventTicker);
    if (!includeLive && meta.is_live) continue;
    // Spread team must match one of the event's two teams. A Kalshi
    // abbr we haven't mapped yet would slip through normalizeAbbr
    // unchanged and produce a spread_team that doesn't join to
    // game_log; drop it instead of writing a foot-gun row.
    if (side.team !== meta.away_team && side.team !== meta.home_team) continue;

    results.push({
      game_date: meta.game_date,
      game_id: meta.game_id,
      spread_team: side.team,
      spread_line: strike,
      yes_ask_dollars: yesAsk,
      yes_bid_dollars: Number.isFinite(yesBid) ? yesBid : null,
      no_ask_dollars:  Number.isFinite(noAsk)  ? noAsk  : null,
      no_bid_dollars:  Number.isFinite(noBid)  ? noBid  : null,
      // Raw American conversions. Caller (jobs.js runOddsJob spread
      // ingest block) applies feeAdjustAmerican — mirrors the ML
      // path's handoff.
      yes_ask_ml: probToAmerican(yesAsk),
      no_ask_ml:  Number.isFinite(noAsk) ? probToAmerican(noAsk) : null,
      volume_24h: volume,
      event_ticker: eventTicker,
      ticker: m.ticker,
      // Carry the suffix for debug parity with the brief's named
      // tickers (e.g. LAA2 → spread_line 1.5, suffixN 2). Consumers
      // should prefer spread_line; suffixN is observational.
      _suffix_n: side.suffixN,
      // is_live + start_et exposed for live-game filtering by the
      // caller if needed.
      is_live: meta.is_live,
      start_et: meta.start_et,
    });
  }

  return results;
}

module.exports = {
  getKalshiMlbLines,
  getKalshiMlbTotals,
  getKalshiMlbSpreads,
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
    buildGameId,
    normalizeAbbr,
    splitTeamBlob,
    fetchAllMarkets,
    etMinutesNow,
    etMinutesFromTicker,
    KALSHI_TO_GAMELOG,
    GAMELOG_ABBRS,
    MIN_VOLUME,
    GAME_START_BUFFER_MIN,
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
    if (arg === 'totals') {
      // `totals [YYYY-MM-DD] [line]` — default date is today (NY), default
      // line is "closest to fair $0.50 over" (handled inside the function).
      const tDate = process.argv[3]
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const tLineArg = process.argv[4];
      const tLine = (tLineArg != null && tLineArg !== '') ? parseFloat(tLineArg) : null;
      const lineLabel = (tLine != null && Number.isFinite(tLine)) ? tLine.toFixed(1) : 'auto (closest to fair)';
      console.log('Kalshi MLB totals for ' + tDate + ' (line target: ' + lineLabel + ')');
      try {
        const rows = await getKalshiMlbTotals(tDate, {
          includeLive: true,
          line: Number.isFinite(tLine) ? tLine : null,
        });
        if (!rows.length) {
          console.log('(no markets matched)');
          return;
        }
        rows.sort((a, b) => (Number(a.is_live) - Number(b.is_live))
          || (a.start_et || '').localeCompare(b.start_et || ''));
        console.log(
          ['status', 'start_et', 'away/home', 'line', 'over_ml', 'under_ml',
            'over_fee', 'under_fee', 'rungs', 'event_ticker'].join('\t')
        );
        let pre = 0, live = 0, lineMismatches = 0;
        for (const r of rows) {
          if (r.is_live) live++; else pre++;
          // If the caller requested a specific line and the chosen one
          // differs, surface that — never silently substitute.
          if (Number.isFinite(tLine) && r.line !== tLine) lineMismatches++;
          console.log([
            r.is_live ? 'LIVE   ' : 'PREGAME',
            r.start_et || '----',
            r.away_team + '@' + r.home_team,
            r.line.toFixed(1) + (Number.isFinite(tLine) && r.line !== tLine ? '*' : ''),
            r.over.ask_ml,
            r.under.ask_ml,
            r.over.fee_adj_ml != null ? r.over.fee_adj_ml : '-',
            r.under.fee_adj_ml != null ? r.under.fee_adj_ml : '-',
            r.ladder.length,
            r.event_ticker,
          ].join('\t'));
        }
        console.log('--');
        console.log(pre + ' pre-game, ' + live + ' live'
          + (Number.isFinite(tLine) && lineMismatches > 0
            ? ' (* = chosen line differs from requested ' + tLine.toFixed(1) + ' — nearest match used; ' + lineMismatches + ' total)'
            : ''));
      } catch (e) {
        console.error('error: ' + e.message);
        process.exit(1);
      }
      return;
    }
    const date = arg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    console.log('Kalshi MLB moneylines for ' + date + ' (ASK-based, status=active)');
    // CLI passes includeLive:true so the user can see BOTH pre-game and
    // live games side by side and visually validate the filter is firing
    // correctly. The default consumer call (no opts) excludes live games.
    try {
      const rows = await getKalshiMlbLines(date, { includeLive: true });
      if (!rows.length) {
        console.log('(no markets matched)');
        return;
      }
      // Sort pre-game first, then live, by ET start time within each group.
      rows.sort((a, b) => (Number(a.is_live) - Number(b.is_live))
        || (a.start_et || '').localeCompare(b.start_et || ''));
      console.log(
        ['status', 'start_et', 'away/home', 'away_ml', 'home_ml',
          'p(home)', 'vol_away', 'vol_home', 'event_ticker'].join('\t')
      );
      let pre = 0, live = 0;
      for (const r of rows) {
        if (r.is_live) live++; else pre++;
        console.log([
          r.is_live ? 'LIVE   ' : 'PREGAME',
          r.start_et || '----',
          r.away_team + '@' + r.home_team,
          r.away.ask_ml,
          r.home.ask_ml,
          r.home.win_prob_ask.toFixed(4),
          r.volume_24h_away,
          r.volume_24h_home,
          r.event_ticker,
        ].join('\t'));
      }
      console.log('--');
      console.log(pre + ' pre-game, ' + live + ' live (live rows would be EXCLUDED by default — opts.includeLive=false)');
    } catch (e) {
      console.error('error: ' + e.message);
      process.exit(1);
    }
  })();
}
