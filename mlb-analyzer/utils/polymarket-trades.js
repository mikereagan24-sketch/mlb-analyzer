'use strict';

// Polymarket trades and market discovery, shared by the local backfill
// (services/polymarket-backfill.js) and the live top-traders job
// (services/top-traders-live.js). Moved here unchanged from the backfill on
// 2026-10-01 so both use ONE implementation -- nothing is copied. The
// backfill's behaviour is unchanged (scripts/test-polymarket-backfill.js).
//
// NO DATABASE and nothing from the pricing path: callers pass in a client and,
// for fetchWindows, a window store. DISPLAY ONLY -- never a model input.
//
// TRADES (the backfill's locked decision 1, 2026-10-01):
//   - /trades has no fill id, and identical rows are real, distinct fills, so
//     NOTHING is de-duplicated: every row the API returns is passed on.
//   - Windows are HALF-OPEN [t_start, t_end) on the trade timestamp. The API's
//     start/end are INCLUSIVE seconds, so a window is requested as
//     start = t_start, end = t_end - 1.
//   - /trades refuses offsets past MAX_OFFSET. A window with more fills than
//     that is split in half by time, [a, mid) + [mid, b), until each fits; a
//     trade at exactly mid belongs to the second window only.
//   - Requests are sequential, with a minimum gap and exponential backoff.

const PAGE = 500;
const MAX_OFFSET = 10000;          // largest offset /trades accepts
const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

// ---------------------------------------------------------------- http
// A tiny client: sequential, a minimum gap between requests, exponential
// backoff on 429 / 5xx / network errors, every retry logged and counted.
function makeClient(opts) {
  const o = Object.assign({ minGapMs: 150, maxAttempts: 8, log: console.log, fetchImpl: globalThis.fetch,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)), now: () => Date.now() }, opts || {});
  const stats = { requests: 0, retries: 0, http429: 0 };
  let last = 0;
  async function getJson(url) {
    for (let attempt = 1; ; attempt++) {
      const wait = last + o.minGapMs - o.now();
      if (wait > 0) await o.sleep(wait);
      last = o.now();
      stats.requests++;
      let status = 0, body = null, err = null;
      try {
        const r = await o.fetchImpl(url, { headers: { 'User-Agent': 'mlb-analyzer-backfill (read-only)' } });
        status = r.status;
        const txt = await r.text();
        try { body = JSON.parse(txt); } catch (e) { body = txt; }
      } catch (e) { err = e; }
      const retryable = err || status === 429 || status >= 500;
      if (!retryable) {
        if (status >= 400) { const e = new Error('HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 200) + ' ' + url); e.status = status; throw e; }
        return body;
      }
      if (status === 429) stats.http429++;
      if (attempt >= o.maxAttempts) throw new Error('giving up after ' + attempt + ' attempts: ' + (err ? err.message : 'HTTP ' + status) + ' ' + url);
      const backoff = Math.min(60000, 1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
      stats.retries++;
      o.log('[retry] attempt ' + attempt + ' ' + (err ? err.message : 'HTTP ' + status) + ' -> waiting ' + backoff + ' ms ' + url.slice(0, 140));
      await o.sleep(backoff);
    }
  }
  return { getJson, stats };
}

// ---------------------------------------------------------------- discovery
function parseStart(s) {
  if (!s) return null;
  let t = String(s).replace(' ', 'T');
  if (/[+-]\d\d$/.test(t)) t += ':00';
  const ms = Date.parse(t);
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}
function marketFromEvent(e) {
  const m = (e.markets || []).find(x => x.sportsMarketType === 'moneyline');
  if (!m) return null;
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch (x) { return []; } };
  const outcomes = parse(m.outcomes), prices = parse(m.outcomePrices);
  const ones = prices.map((p, i) => (String(p) === '1' ? i : -1)).filter(i => i >= 0);
  const resolved = !!m.closed && ones.length === 1 && prices.length === 2;
  return { condition_id: m.conditionId, slug: e.slug, event_id: String(e.id),
    outcome0: outcomes[0] || null, outcome1: outcomes[1] || null,
    poly_start_utc: parseStart(m.gameStartTime), resolved: resolved ? 1 : 0, winner_idx: resolved ? ones[0] : null };
}
const SLUG_RE = /^mlb-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})(-dh2)?$/;
function slugDate(slug) { const m = SLUG_RE.exec(slug || ''); return m ? m[3] : null; }
const isGame2 = (gid) => /-(g)?2$/.test(gid);

// Every moneyline market whose slug date is in [from, to]. Gamma refuses
// offsets past ~2,100 and a season fills that, so walk 3-day end_date windows;
// the game date filter is the slug's own date.
//
// An event's end_date is NOT its game date. Measured 2026-09-30: the final
// weekend's moneyline events (e.g. mlb-nym-wsh-2026-09-27) carry endDate
// 2026-10-04, a week after the game. The walk used to stop 3 days past `to`,
// so all 18 of those markets were silently missed. It now runs
// END_DATE_SLACK_DAYS past `to`; events outside [from, to] by slug date are
// still skipped. Yields one market at a time (one page held at once).
const END_DATE_SLACK_DAYS = 21;
async function* iterMoneylineMarkets(client, from, to) {
  const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10);
  for (const closed of ['true', 'false']) {
    for (let day = addDays(from, -3); day <= addDays(to, END_DATE_SLACK_DAYS); day = addDays(day, 3)) {
      for (let off = 0; ; off += 100) {
        const evs = await client.getJson(GAMMA + '/events?series_id=3&closed=' + closed + '&limit=100&offset=' + off
          + '&end_date_min=' + day + 'T00:00:00Z&end_date_max=' + addDays(day, 3) + 'T00:00:00Z');
        if (!Array.isArray(evs) || !evs.length) break;
        for (const e of evs) {
          const sd = slugDate(e.slug);
          if (!sd || sd < from || sd > to) continue;
          const m = marketFromEvent(e);
          if (m) yield m;
        }
        if (evs.length < 100) break;
      }
    }
  }
}

// ---------------------------------------------------------------- game matching
// game_time is a display string, "h:mm AM|PM ET": the scheduled start on
// game_date as read on a New York clock (services/first-pitch.js explains why
// it is never used for arithmetic elsewhere). This converts it to a UTC
// instant, with DST taken from the platform's America/New_York rules rather
// than a hand-coded offset. Anything not in exactly that shape -- no "ET", a
// null, a 24h clock -- returns null: we do not guess a zone.
// -> epoch seconds | null
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function nyOffsetMinutes(ms) {                 // New York wall clock minus UTC, at instant ms
  const p = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000;
}
function etGameTimeToUtc(gameDate, gameTime) {
  const t = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+ET\s*$/i.exec(gameTime || '');
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameDate || '');
  if (!t || !d || +t[1] < 1 || +t[1] > 12 || +t[2] > 59) return null;
  const hour = (+t[1] % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
  const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], hour, +t[2]);
  // Two passes: the offset is looked up at the instant being solved for, so a
  // time on a DST-change day settles on the offset actually in force then.
  let ms = wall - nyOffsetMinutes(wall) * 60000;
  ms = wall - nyOffsetMinutes(ms) * 60000;
  return Math.floor(ms / 1000);
}
const FALLBACK_TOLERANCE_S = 15 * 60;          // game_time vs Polymarket gameStartTime

// MLB's regular season, per statsapi.mlb.com /api/v1/seasons/{year}
// (regularSeasonStartDate / regularSeasonEndDate, read 2026-09-30). NOT
// game_log's first date: game_log starts 2026-04-04, nine days after opening
// day (#486). A date after the end is postseason.
const REGULAR_SEASON = {
  2026: { start: '2026-03-25', end: '2026-09-27' },     // opener NYY @ SF; postseason from 09-28
};

// game_log rows -> { byKey: date|away|home -> [game], dates }. rows: an
// iterable of { game_date, game_id, scheduled_start_utc, first_pitch_utc,
// game_time, removed }.
function gameIndexFromRows(rows) {
  const byKey = new Map(), dates = new Set();
  for (const g of rows) {
    dates.add(g.game_date);
    if (g.removed) continue;
    const [a, h] = g.game_id.split('-');
    const k = g.game_date + '|' + a + '|' + h;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push({ game_id: g.game_id, game_date: g.game_date, scheduled_start_utc: g.scheduled_start_utc,
      first_pitch_utc: g.first_pitch_utc, game_time: g.game_time });
  }
  return { byKey, dates };
}

// The pre-game cutoff for a matched game: the EARLIER of scheduled_start_utc
// and first_pitch_utc (a suspended game started on its original date); only
// when neither exists, game_time confirmed by Polymarket within 15 minutes.
// -> { cutoff_utc, cutoff_source } | { reason }
function resolveCutoff(g, polyStartUtc) {
  const s = parseStart(g.scheduled_start_utc), f = parseStart(g.first_pitch_utc);
  if (f != null && (s == null || f < s)) return { cutoff_utc: f, cutoff_source: 'first_pitch_utc' };
  if (s != null) return { cutoff_utc: s, cutoff_source: 'scheduled_start_utc' };
  if (!g.game_time) return { reason: 'no_start_time' };                     // no start field at all
  const t = etGameTimeToUtc(g.game_date, g.game_time);
  if (t == null) return { reason: 'game_time_unparseable' };                 // e.g. no "ET" zone
  // A postponed game keeps its original game_time slot while Polymarket's
  // start moves to the make-up date, so this check is what catches it.
  if (polyStartUtc == null || Math.abs(t - polyStartUtc) > FALLBACK_TOLERANCE_S) return { reason: 'start_time_unconfirmed' };
  return { cutoff_utc: t, cutoff_source: 'fallback_confirmed' };
}

// Which game a market is, given the game_log candidates for its date and team
// pair. A doubleheader date with a single market (which game is unknown) is
// excluded; explicitly separate markets (-dh2) are kept.
// -> { g } | { reason }
function pickGame(slug, cands, allSlugs) {
  const dh2 = /-dh2$/.test(slug || '');
  if (!cands || !cands.length) return { reason: 'unmatched' };
  if (cands.length === 1) {
    if (dh2 && !isGame2(cands[0].game_id)) return { reason: 'unmatched' };
    return { g: cands[0] };
  }
  const g1 = cands.find(c => !isGame2(c.game_id)), g2 = cands.find(c => isGame2(c.game_id));
  let g;
  if (dh2) g = g2;
  else if (allSlugs.has(slug + '-dh2')) g = g1;           // an explicit game-2 market exists: this is game 1
  else return { reason: 'dh_single_market' };
  return g ? { g } : { reason: 'unmatched' };
}

// ---------------------------------------------------------------- trades
const tradesUrl = (cid, a, b, offset, limit) => DATA + '/trades?' + new URLSearchParams({
  market: cid, takerOnly: 'false', start: String(a), end: String(b), offset: String(offset), limit: String(limit) });

// One /trades row -> { wallet, ts, side (+1 buy / -1 sell), outcome, price, size }.
const parseTrade = (t) => ({ wallet: String(t.proxyWallet).toLowerCase(), ts: Number(t.timestamp),
  side: t.side === 'BUY' ? 1 : -1, outcome: Number(t.outcomeIndex), price: Number(t.price), size: Number(t.size) });

// Fetch every trade of one market over the store's half-open windows,
// splitting any window over the offset cap. Nothing is de-duplicated.
//   store.next()        -> the next pending window { t_start, t_end }, or null when none is left
//   store.begin(w)      before a window is fetched (resume safety: drop what a crash left of it)
//   store.split(w, mid) replace w by [w.t_start, mid) and [mid, w.t_end)
//   store.done(w, n)    w finished; n = rows kept by onPage over its pages
//   onPage(w, page)     every page as returned (raw rows); -> rows kept
// Pages are handed over one at a time and never held.
async function fetchWindows(client, conditionId, store, onPage, label) {
  for (;;) {
    const w = store.next();
    if (!w) break;
    store.begin(w);
    // Over the cap? One row at offset MAX_OFFSET means > MAX_OFFSET fills.
    const probe = await client.getJson(tradesUrl(conditionId, w.t_start, w.t_end - 1, MAX_OFFSET, 1));
    if (Array.isArray(probe) && probe.length) {
      if (w.t_end - w.t_start <= 1) throw new Error('window [' + w.t_start + ', ' + w.t_end + ') is a single second over the offset cap: cannot split -- ' + label);
      // [a, b) -> [a, mid) + [mid, b): a trade at exactly mid goes to the second, only.
      store.split(w, Math.floor((w.t_start + w.t_end) / 2));
      continue;
    }
    // Page it. Newest first; the window is under the cap, so offsets never pass it.
    let n = 0;
    for (let off = 0; off <= MAX_OFFSET; off += PAGE) {
      const page = await client.getJson(tradesUrl(conditionId, w.t_start, w.t_end - 1, off, PAGE));
      if (!Array.isArray(page)) throw new Error('non-array page for ' + label);
      n += onPage(w, page);
      if (page.length < PAGE) break;
    }
    store.done(w, n);
  }
}

// An in-memory window store for one half-open range [t_start, t_end) (the
// live job; the backfill keeps its windows in its database). -> store, plus
// .windows (every window ever created) and .splits.
function memoryWindowStore(tStart, tEnd) {
  const all = [{ t_start: tStart, t_end: tEnd, status: 'pending' }];
  const st = {
    windows: all, splits: 0,
    next: () => all.filter(w => w.status === 'pending').sort((a, b) => b.t_end - a.t_end)[0] || null,
    begin: () => {},
    split: (w, mid) => { w.status = 'split'; st.splits++;
      all.push({ t_start: w.t_start, t_end: mid, status: 'pending' }, { t_start: mid, t_end: w.t_end, status: 'pending' }); },
    done: (w, n) => { w.status = 'done'; w.fills = n; },
  };
  return st;
}

module.exports = {
  PAGE, MAX_OFFSET, GAMMA, DATA, END_DATE_SLACK_DAYS, FALLBACK_TOLERANCE_S, REGULAR_SEASON, SLUG_RE,
  makeClient, parseStart, marketFromEvent, slugDate, isGame2, iterMoneylineMarkets,
  nyOffsetMinutes, etGameTimeToUtc, gameIndexFromRows, resolveCutoff, pickGame,
  tradesUrl, parseTrade, fetchWindows, memoryWindowStore,
};
