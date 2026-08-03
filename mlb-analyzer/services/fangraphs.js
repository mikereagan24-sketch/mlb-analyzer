'use strict';

// One-click refresh for the eight FanGraphs split CSVs the model depends on:
// four Steamer RoS projections (bat vs L/R, pit vs L/R) and four two-year
// trailing actuals (same four splits). Caller supplies a fangraphs.com
// Member session cookie value — user pastes it into the Model tab and the
// route pulls it from app_settings before invoking refreshAllFanGraphs.
// Cookie name is a stable WordPress COOKIEHASH, not a secret.

const PROJ_BASE  = 'https://www.fangraphs.com/api/projections';
// Actuals API URL — resolved lazily at call time so a hot-config change
// via env var (FG_ACTUALS_URL_OVERRIDE) doesn't require redeploy.
//
// URL history:
//   2026-07-31 → 2026-08-02: FG rewrote /leaders/splits-leaderboards.
//     New API returned unhandled ASP.NET exceptions ({"Message":"An
//     error has occurred."}) on our request shape.
//   2026-08-03 (PR #216, briefly): guessed the legacy page routed to
//     /api/leaders/splits/splits-leaders-legacy. Wrong — that path
//     404s. Merged then reverted same day.
//   2026-08-03 (this PR): owner captured the working payload from
//     FG's own frontend. Same URL, same method — the URL never
//     changed. The failure was BODY-shape only: FG's rewritten
//     handler expects null for the arrWx* fields (we sent []) and
//     "2" string for strType on batters (we sent 1 number). Types
//     that were silently coerced by the old handler now crash the
//     new one. See fetchActualSplit below for the corrected body.
//
// FG_ACTUALS_URL_OVERRIDE stays as an escape hatch for the next FG
// rewrite; not needed today.
const ACTUAL_URL_DEFAULT = 'https://www.fangraphs.com/api/leaders/splits/splits-leaders';
function _actualUrl() {
  return (process.env.FG_ACTUALS_URL_OVERRIDE || '').trim() || ACTUAL_URL_DEFAULT;
}
// Exposed as a constant name for any callers that may still read the
// module property. Reads the same env var so behavior is consistent.
const ACTUAL_URL = _actualUrl();
const COOKIE_NAME = 'wordpress_logged_in_0cae6f5cb929d209043cb97f8c2eee44';

function buildCookieHeader(cookieValue) {
  if (!cookieValue) throw new Error('FanGraphs session cookie not configured. Paste from Model tab.');
  return COOKIE_NAME + '=' + cookieValue;
}

function baseHeaders(cookieValue) {
  // Origin + X-Requested-With are required by FanGraphs' API backend for the
  // actuals POST (returns 500 without them) and are harmless on projection
  // GETs, so both go here. Sent on every request.
  return {
    'Cookie': buildCookieHeader(cookieValue),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.fangraphs.com/leaders/splits-leaderboards',
    'Origin': 'https://www.fangraphs.com',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

// Preseason CSV column order — taken verbatim from the user's own prior
// FanGraphs downloads. Downstream ingestion (parseCSV, the name-matching
// paths) is built against these headers, so any refreshed CSV must match
// exactly or lookups silently target the wrong column.
const BAT_PROJ_COLS = ['Name','Team','G','PA','AB','H','1B','2B','3B','HR','R','RBI','BB','IBB','SO','HBP','SF','SH','GDP','SB','CS','AVG','BB%','K%','BB/K','OBP','SLG','wOBA','OPS','ISO','Spd','BABIP','UBR','wSB','wRC','wRAA','wRC+','BsR','Fld','Off','Def','WAR','ADP','InterSD','InterSK','IntraSD','Vol','Skew','Dim','FPTS','FPTS/G','SPTS','SPTS/G','P10','P20','P30','P40','P50','P60','P70','P80','P90','TT10','TT20','TT30','TT40','TT50','TT60','TT70','TT80','TT90','NameASCII','PlayerId','MLBAMID'];

const PIT_PROJ_COLS = ['Name','Team','AB','H','1B','2B','3B','HR','BB','IBB','SO','HBP','SF','SH','AVG','BB%','K%','OBP','SLG','wOBA','OPS','ISO','BABIP','wRC+','TBF','NameASCII','PlayerId','MLBAMID'];

// Mapping from preseason column name → RoS JSON API key (or a function that
// derives the value from the full row). `null` means the column isn't
// present in the RoS response — emit an empty string to preserve schema.
const BAT_PROJ_MAP = {
  'Name': 'PlayerName',
  'Team': 'Team',
  'G': 'G', 'PA': 'PA', 'AB': 'AB', 'H': 'H', '1B': '1B', '2B': '2B', '3B': '3B',
  'HR': 'HR', 'R': 'R', 'RBI': 'RBI', 'BB': 'BB', 'IBB': 'IBB', 'SO': 'SO',
  'HBP': 'HBP', 'SF': 'SF', 'SH': 'SH', 'SB': 'SB', 'CS': 'CS', 'AVG': 'AVG',
  'BB%': 'BB%', 'K%': 'K%', 'BB/K': 'BB/K', 'OBP': 'OBP', 'SLG': 'SLG',
  'wOBA': 'wOBA', 'OPS': 'OPS', 'ISO': 'ISO', 'BABIP': 'BABIP',
  'wRC': 'wRC', 'wRAA': 'wRAA', 'wRC+': 'wRC+', 'WAR': 'WAR',
  'ADP': 'ADP', 'FPTS': 'FPTS', 'SPTS': 'SPTS',
  'FPTS/G': 'FPTS_G',
  'SPTS/G': 'SPTS_G',
  'PlayerId': 'playerid',
  'MLBAMID': 'xMLBAMID',
  'NameASCII': (row) => (row.PlayerName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
  // Preseason-only columns absent from RoS — kept for schema fidelity.
  'GDP': null, 'Spd': null, 'UBR': null, 'wSB': null, 'BsR': null,
  'Fld': null, 'Off': null, 'Def': null,
  'InterSD': null, 'InterSK': null, 'IntraSD': null, 'Vol': null, 'Skew': null, 'Dim': null,
  'P10': null, 'P20': null, 'P30': null, 'P40': null, 'P50': null,
  'P60': null, 'P70': null, 'P80': null, 'P90': null,
  'TT10': null, 'TT20': null, 'TT30': null, 'TT40': null, 'TT50': null,
  'TT60': null, 'TT70': null, 'TT80': null, 'TT90': null,
};

const PIT_PROJ_MAP = {
  'Name': 'PlayerName',
  'Team': 'Team',
  'AB': null, 'H': 'H', '1B': '1B', '2B': '2B', '3B': '3B', 'HR': 'HR',
  'BB': 'BB', 'IBB': 'IBB', 'SO': 'SO', 'HBP': 'HBP', 'SF': 'SF', 'SH': 'SH',
  'AVG': 'AVG', 'BB%': 'BB%', 'K%': 'K%', 'OBP': 'OBP', 'SLG': 'SLG',
  'wOBA': 'wOBA', 'OPS': 'OPS', 'ISO': 'ISO', 'BABIP': 'BABIP',
  'wRC+': 'wRC+', 'TBF': 'TBF',
  'NameASCII': (row) => (row.PlayerName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
  'PlayerId': 'playerid',
  'MLBAMID': 'xMLBAMID',
};

function mapRowToSchema(row, cols, mapping) {
  return cols.map(col => {
    const spec = mapping[col];
    if (spec === null || spec === undefined) return '';
    if (typeof spec === 'function') return spec(row);
    const val = row[spec];
    return val == null ? '' : val;
  });
}

function toCsv(cols, mappedRows) {
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  for (const r of mappedRows) lines.push(r.map(escape).join(','));
  return lines.join('\n');
}

function jsonToProjectionCsv(rows, stats) {
  const cols    = stats === 'bat' ? BAT_PROJ_COLS : PIT_PROJ_COLS;
  const mapping = stats === 'bat' ? BAT_PROJ_MAP  : PIT_PROJ_MAP;
  return toCsv(cols, rows.map(r => mapRowToSchema(r, cols, mapping)));
}

// Generic JSON-array → CSV conversion, used by the actuals path which has
// no preseason schema to match. Column order = keys of first row. Nullish
// → empty; RFC-4180 double-quote escaping for commas/quotes/newlines.
function jsonToCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map(c => escape(row[c])).join(','));
  return lines.join('\n');
}

// --- Projections (GET, response is JSON despite download=1) ---

async function fetchProjection(type, stats, cookieValue) {
  const url = PROJ_BASE + '?type=' + encodeURIComponent(type)
    + '&stats=' + encodeURIComponent(stats)
    + '&pos=all&team=0&players=0&lg=all&download=1';
  const res = await fetch(url, { headers: baseHeaders(cookieValue) });
  if (!res.ok) {
    // Symmetric with fetchActualSplit (2026-08-02): capture body on
    // non-ok so an FG contract change / bot block surfaces its own
    // reason instead of leaving us guessing from a bare status code.
    let body500 = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        body500 = j && j.error ? String(j.error) : t;
      } catch (_) { body500 = t; }
    } catch (_) { body500 = '<body read failed>'; }
    throw new Error('Projection fetch ' + type + '/' + stats
      + ' failed: HTTP ' + res.status + ' — ' + String(body500).slice(0, 400));
  }
  const text = await res.text();
  let rows;
  try { rows = JSON.parse(text); }
  catch(e) { throw new Error('Projection ' + type + '/' + stats + ' returned non-JSON: ' + text.slice(0,200)); }
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Projection ' + type + '/' + stats + ' returned empty/invalid: ' + text.slice(0,200));
  }
  // Schema-aware transform — emit the preseason column order with RoS
  // keys remapped. Generic jsonToCsv would leak raw API keys and break
  // Name-based lookups downstream.
  return jsonToProjectionCsv(rows, stats);
}

// --- Actuals (POST returns JSON — transform to CSV) ---

// 2-year trailing date window for the actuals query. Deliberate
// signal-stability choice from the original 2026-04-21 introduction
// (commit f00d40e, "feat(fangraphs): one-click refresh for 8 FG CSVs"
// — description explicitly names "2-year trailing actuals"; module
// docstring line 5 still says the same).
//
// Why 2 years and not single-season:
//   - Platoon splits stabilize slowly. 2 years ≈ 2× the PA per hand,
//     ~sqrt(2)× less noise on the per-player estimate.
//   - The minPA=60 (batters) and minBF=100 (pitchers) gates in
//     model.blendWoba are calibrated against 2-year cumulative
//     samples. Narrowing to single-season would push many part-time
//     platoon players below the gate → fall back to pure projection
//     → less actuals influence overall. Material shift in blend
//     character on ~15-25% of the lineup pool at mid-season.
//
// History:
//   2026-04-21 (f00d40e): introduced with twoYearDateRange, deliberate.
//   2026-08-03 (PR #217 / 0e6cf3f): narrowed to seasonDateRange
//     (03-01 → 11-01) as part of matching the captured payload
//     byte-for-byte. Row counts dropped ~15-25% below historical
//     322-449 band → owner caught it. The captured range reflected
//     the operator's browser view at capture time, not a required
//     shape — FG's API accepts any date range.
//   2026-08-03 (this PR): reverting to 2-year to preserve the
//     signal-stability contract the minPA/minBF gates were
//     calibrated against. A follow-up diagnostic
//     (tmp/probe-fg-actuals-4combos.js) will confirm whether date
//     range materially affects FG's response vs strAutoPt='true'
//     being the true filter. If the probe shows date is decorative
//     against the rewritten handler, we revisit — but the safe
//     default in the meantime is the shape prod ran on for months.
function twoYearDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 2);
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

async function fetchActualSplit(splitCode, position, cookieValue) {
  const { start, end } = twoYearDateRange();
  // Body shape captured from FG's own frontend 2026-08-03 after the
  // splits-leaderboards rewrite. Prior body caused unhandled ASP.NET
  // exceptions ({"Message":"An error has occurred."}) because the new
  // handler is strict on:
  //   - arrWx* fields must be null, not [] (old handler coerced [])
  //   - strType must be "2" (string) even for batters (old handler
  //     accepted number 1 for batters; the pre-rewrite comment
  //     "1 for batters, '2' for pitchers" no longer applies)
  //   - strSplitTeams must be BOOLEAN false, not string 'false'
  //     (defensive — we always used boolean, but easy to break)
  // Every field below is present in the captured working payload.
  // Owner note: strSplitArr comes in as [] from the captured browser
  // view (their current filter), but our use-case requires the split
  // ID → we pass [splitCode] so FG scopes to the split we want.
  const body = {
    strSplitArr: [splitCode],
    strGroup: 'season',
    strPosition: position,
    strType: '2',               // string "2" for BOTH B and P per captured payload
    strStartDate: start,
    strEndDate: end,
    strSplitTeams: false,       // boolean, NOT the string 'false'
    dctFilters: [],
    strStatType: 'player',
    strAutoPt: 'true',
    arrPlayerId: [],
    strPlayerId: 'all',
    strSplitArrPitch: [],
    arrWxTemperature: null,     // null, not []  ← FG rewrite is strict
    arrWxPressure:    null,
    arrWxAirDensity:  null,
    arrWxElevation:   null,
    arrWxWindSpeed:   null,
  };
  // Read URL fresh at call time so FG_ACTUALS_URL_OVERRIDE env var swap
  // takes effect without a process restart. Cheap — one env-var read
  // per split per attempt.
  const url = _actualUrl();
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({}, baseHeaders(cookieValue), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Capture body on non-ok. Pre-2026-08-02 this discarded the body —
    // we asked "does the 500 carry a message?" and couldn't answer
    // because the code threw only the status. Now the first 400 chars
    // of the response body (JSON.error field if present, else raw text)
    // land in the error. If FG has changed the contract, they typically
    // return a JSON body with { error: "unknown field X" } style;
    // Cloudflare bot-block returns HTML with "Ray ID". Either way,
    // the truncated body distinguishes the failure mode without
    // needing another round-trip.
    let body500 = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        body500 = j && j.error ? String(j.error) : t;
      } catch (_) { body500 = t; }
    } catch (_) { body500 = '<body read failed>'; }
    throw new Error('Actual fetch split=' + splitCode + ' pos=' + position
      + ' url=' + url
      + ' failed: HTTP ' + res.status + ' — ' + String(body500).slice(0, 400));
  }
  const json = await res.json();
  if (!json || !Array.isArray(json.data)) {
    throw new Error('Actual split=' + splitCode + ' pos=' + position + ' returned no data array. Top keys: ' + Object.keys(json||{}).join(','));
  }
  return jsonToCsv(json.data);
}

// --- Main orchestrator ---
// Serial, not parallel — 8 simultaneous authenticated requests could trip
// FanGraphs' rate limiter and put the user's Member account at risk. Serial
// runs in ~5–10s total which is fine for a manual button press. Each task
// has independent error handling so one failure doesn't block the others.
//
// Split into two task-list helpers so refreshFanGraphsActuals() can reuse
// the same serial runner + error contract without duplicating the loop.
// The bookmarklet's iframe-based actuals path was retired 2026-08-04 in
// favor of a POST to /jobs/refresh-fangraphs-actuals which calls the
// server-side path here — one implementation, one place to fix.
function _projTasks(cookieValue) {
  return [
    { name: 'bat-proj-lhp', fn: () => fetchProjection('rsteamer_vl_0', 'bat', cookieValue) },
    { name: 'bat-proj-rhp', fn: () => fetchProjection('rsteamer_vr_0', 'bat', cookieValue) },
    { name: 'pit-proj-lhb', fn: () => fetchProjection('rsteamer_vl_p_1', 'pit', cookieValue) },
    { name: 'pit-proj-rhb', fn: () => fetchProjection('rsteamer_vr_p_1', 'pit', cookieValue) },
  ];
}
function _actTasks(cookieValue) {
  return [
    { name: 'bat-act-lhp',  fn: () => fetchActualSplit(1, 'B', cookieValue) },
    { name: 'bat-act-rhp',  fn: () => fetchActualSplit(2, 'B', cookieValue) },
    { name: 'pit-act-lhb',  fn: () => fetchActualSplit(5, 'P', cookieValue) },
    { name: 'pit-act-rhb',  fn: () => fetchActualSplit(6, 'P', cookieValue) },
  ];
}
async function _runTasks(tasks) {
  const results = [];
  for (const t of tasks) {
    try {
      console.log('[fangraphs] fetching ' + t.name + '...');
      const csv = await t.fn();
      const rowCount = Math.max(0, csv.split('\n').length - 1);
      results.push({ name: t.name, key: t.name, success: true, rowCount, csv });
      console.log('[fangraphs]   OK ' + t.name + ': ' + rowCount + ' rows');
    } catch (e) {
      console.error('[fangraphs]   FAIL ' + t.name + ': ' + e.message);
      results.push({ name: t.name, key: t.name, success: false, error: e.message });
    }
  }
  return results;
}
async function refreshAllFanGraphs(cookieValue) {
  return _runTasks([..._projTasks(cookieValue), ..._actTasks(cookieValue)]);
}
async function refreshFanGraphsActuals(cookieValue) {
  return _runTasks(_actTasks(cookieValue));
}

// Team-aggregated baserunning leaderboard from FanGraphs.
//
// URL pinned (verified 200, returns 30 team-aggregated rows with
// BsR/UBR/wSB/wGDP/SB/CS — Mike's Network-tab capture 2026-06-15):
//
//   /api/leaders/major-league/data
//     ?age=&pos=all&stats=bat&lg=all&qual=0
//     &season=YYYY&season1=YYYY
//     &startdate=YYYY-03-01&enddate=YYYY-11-01
//     &month=0&hand=
//     &team=0%2Cts                    ← URL-ENCODED comma; raw comma 404s
//     &pageitems=30&pagenum=1         ← pagination required, even for 30 teams
//     &ind=0&rost=0&players=0
//     &type=8                          ← advanced view incl. baserunning
//     &postseason=&sortdir=default&sortstat=WAR
//
// The prior 404s came from an INCOMPLETE query string — missing
// startdate/enddate/pageitems/pagenum + sending a raw comma in
// team=0,ts. All present-even-if-empty params (age, hand, pos,
// postseason, sortdir, sortstat) are required by FG's API gate;
// dropping any one returns 404.
//
// AUTH: same baseHeaders(cookieValue) pattern as the projection
// scraper. Cookie must be configured at app_settings.
// fangraphs_session_cookie (paste via Model tab).
//
// FG abbr normalization mirrors the bat-proj CSV ingest at
// routes/api.js:155-157 (KCR→KC, SDP→SD, SFG→SF, TBR→TB, WSN→WAS,
// CHW→CWS). Any unmapped FG abbr passes through as-is.
//
// On non-OK: logs URL + cookie_present + selected CF/server response
// headers for diagnostics so a future FG regression is debuggable.
// Team-aggregate guard (1 row per Team) catches the case where FG
// accepts the request but the team aggregation didn't take effect.
async function fetchTeamBaserunning(season, cookieValue) {
  const yr = season || new Date().getFullYear();
  // season must be the FG-side year for both startdate/enddate. The
  // wide window (Mar 1 → Nov 1) safely covers regular season + most
  // postseason without overlapping into the next year.
  const startdate = yr + '-03-01';
  const enddate   = yr + '-11-01';
  // Order matches Mike's captured URL so the request bytes are
  // identical to what FG's own client sends — any param-order
  // sensitivity in their gate is sidestepped. team=0%2Cts is the
  // URL-encoded comma (raw comma 404s).
  const url = 'https://www.fangraphs.com/api/leaders/major-league/data'
    + '?age='
    + '&pos=all'
    + '&stats=bat'
    + '&lg=all'
    + '&qual=0'
    + '&season='     + yr
    + '&season1='    + yr
    + '&startdate='  + startdate
    + '&enddate='    + enddate
    + '&month=0'
    + '&hand='
    + '&team=0%2Cts'
    + '&pageitems=30'
    + '&pagenum=1'
    + '&ind=0'
    + '&rost=0'
    + '&players=0'
    + '&type=8'
    + '&postseason='
    + '&sortdir=default'
    + '&sortstat=WAR';

  const resp = await fetch(url, { headers: baseHeaders(cookieValue) });
  if (!resp.ok) {
    const respDiag = {};
    for (const h of ['cf-ray', 'server', 'content-type', 'x-amz-cf-id', 'cf-cache-status']) {
      const v = resp.headers.get(h);
      if (v) respDiag[h] = v;
    }
    console.warn('[fg-baserunning] HTTP ' + resp.status + ' ' + url
      + ' | cookie_present=' + !!cookieValue
      + ' | response_headers=' + JSON.stringify(respDiag));
    throw new Error('FG team baserunning fetch ' + resp.status
      + (resp.status === 403 ? ' (likely Cloudflare/Member-auth gate — verify fangraphs_session_cookie)'
       : resp.status === 404 ? ' (URL or query params drifted from the pinned shape; re-capture from Network tab)'
       : ''));
  }
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); }
  catch (e) {
    throw new Error('FG team baserunning returned non-JSON (first 200 chars): ' + text.slice(0, 200));
  }
  // FG wraps rows in { data: [...] } or returns the array directly.
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
  if (!rows || !rows.length) {
    throw new Error('FG team baserunning: zero rows | top-level keys: '
      + Object.keys(body || {}).join(','));
  }
  // Log FG's actual field keys on the first row so a capitalization
  // drift (BsR vs Bsr vs bsr) is visible in Render logs without a
  // re-deploy. If the upsert ends up with 30 rows but bsr columns
  // are all null, this line tells us why — the parser is looking for
  // 'BsR' but FG returned a slightly different field name.
  console.log('[fg-baserunning] FG response field keys (row 0): '
    + Object.keys(rows[0] || {}).slice(0, 60).join(','));
  // ---- FIELD NAMES (verified from Mike's captured response) ----
  // Team identity: r.TeamNameAbb is a clean abbr (e.g. "PIT").
  // Prefer it over r.Team, which the team=0,ts view returns as an
  // HTML anchor (<A HREF=...>LAD</A>). TeamNameAbb is plain text;
  // no regex stripping needed. r.TeamName is the full city name —
  // not used, kept here as fallback only.
  //
  // Baserunning columns:
  //   r.BaseRunning  → bsr   (total BsR, e.g. 5.965)
  //   r.wBsR         → wsb   (weighted; FG renamed from wSB)
  //   r.UBR          → ubr   (NULL at team-aggregate level on this
  //                            view — only populated at player level)
  //   r.GDPRuns      → wgdp  (NULL at team-aggregate level too)
  //   r.SB / r.CS    → sb / cs (raw counts, always populated)
  //   r.G            → g     (games played; ~1000+ at team level
  //                            since it's team-game-count summed
  //                            across all players)
  //
  // SHAPE NOTE — team=0,ts returns one PLAYER-LABELED row per team,
  // but the BaseRunning value is the TEAM TOTAL (not a single
  // player's). G of ~1000+ on each row confirms aggregate-across-
  // players-not-games. This is the right shape for the team-level
  // backtest. The future player-level variant (~700 individual
  // rows, each with their own BaseRunning) drops team=0,ts and uses
  // ind=1 instead — NOT built here.
  //
  // Team-aggregate sanity guard: with team=0,ts each TeamNameAbb
  // appears exactly once. >1 row per team = aggregation didn't take
  // effect.
  const teamCounts = new Map();
  for (const r of rows) {
    const t = String(r.TeamNameAbb || r.TeamName || '').trim().toUpperCase();
    if (t) teamCounts.set(t, (teamCounts.get(t) || 0) + 1);
  }
  let maxPerTeam = 0;
  for (const v of teamCounts.values()) if (v > maxPerTeam) maxPerTeam = v;
  if (maxPerTeam > 1) {
    throw new Error('FG team baserunning: per-player shape ('
      + rows.length + ' rows, ' + teamCounts.size + ' teams, max '
      + maxPerTeam + ' per team) — team aggregation selector failed');
  }
  const FG_MAP = { KCR: 'KC', SDP: 'SD', SFG: 'SF', TBR: 'TB', WSN: 'WAS', CHW: 'CWS' };
  const out = [];
  for (const r of rows) {
    const teamRaw = String(r.TeamNameAbb || r.TeamName || '').trim().toUpperCase();
    if (!teamRaw) continue;
    const team = FG_MAP[teamRaw] || teamRaw;
    const num = (v) => (v == null || v === '' ? null : Number(v));
    out.push({
      team,
      bsr:  num(r.BaseRunning),
      ubr:  num(r.UBR),
      wsb:  num(r.wBsR),
      wgdp: num(r.GDPRuns),
      sb:   num(r.SB),
      cs:   num(r.CS),
      g:    num(r.G),
    });
  }
  if (!out.length) throw new Error('FG team baserunning: parsed zero usable rows');
  console.log('[fg-baserunning] SUCCESS (' + out.length + ' team rows for season ' + yr + ')');
  return out;
}

// Player-level baserunning leaderboard from FanGraphs. Same pinned-URL
// shape as fetchTeamBaserunning but with team=0 (no aggregation) and
// ind=1 (individuals). Returns ~700-900 rows depending on how many
// non-qualified batters have appeared. PK is xMLBAMID (= statsapi
// person.id = our mlb_id).
//
// AGGREGATION across mid-season trade-window splits: a player traded
// mid-season appears with one row per team. We sum BsR/UBR/wSB/
// wGDP/SB/CS/G across all their rows so the result is season-
// cumulative per player. Final shape: one entry per mlbam_id with
// the player's total season skill.
//
// Field-name convention identical to team-level (verified from Mike's
// captured response): BaseRunning (not BsR), wBsR (not wSB), GDPRuns
// (not wGDP). UBR and GDPRuns are populated at player level (they
// were null at team-aggregate). xMLBAMID is the join key.
async function fetchPlayerBaserunning(season, cookieValue) {
  const yr = season || new Date().getFullYear();
  const startdate = yr + '-03-01';
  const enddate   = yr + '-11-01';
  // Mirror the team-level URL but: team=0 (no aggregation), ind=1
  // (individual players), pageitems=2000 (cover the full leaderboard
  // in one page — typical individual count is ~700-900).
  const url = 'https://www.fangraphs.com/api/leaders/major-league/data'
    + '?age='
    + '&pos=all'
    + '&stats=bat'
    + '&lg=all'
    + '&qual=0'
    + '&season='     + yr
    + '&season1='    + yr
    + '&startdate='  + startdate
    + '&enddate='    + enddate
    + '&month=0'
    + '&hand='
    + '&team=0'
    + '&pageitems=2000'
    + '&pagenum=1'
    + '&ind=1'
    + '&rost=0'
    + '&players=0'
    + '&type=8'
    + '&postseason='
    + '&sortdir=default'
    + '&sortstat=WAR';
  const resp = await fetch(url, { headers: baseHeaders(cookieValue) });
  if (!resp.ok) {
    const respDiag = {};
    for (const h of ['cf-ray', 'server', 'content-type', 'x-amz-cf-id', 'cf-cache-status']) {
      const v = resp.headers.get(h);
      if (v) respDiag[h] = v;
    }
    console.warn('[fg-player-baserunning] HTTP ' + resp.status + ' ' + url
      + ' | cookie_present=' + !!cookieValue
      + ' | response_headers=' + JSON.stringify(respDiag));
    throw new Error('FG player baserunning fetch ' + resp.status
      + (resp.status === 403 ? ' (Cloudflare/Member-auth gate — verify fangraphs_session_cookie)'
       : resp.status === 404 ? ' (URL or query params drifted — re-capture from Network tab)'
       : ''));
  }
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); }
  catch (e) { throw new Error('FG player baserunning returned non-JSON (first 200): ' + text.slice(0, 200)); }
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
  if (!rows || !rows.length) {
    throw new Error('FG player baserunning: zero rows | top-level keys: '
      + Object.keys(body || {}).join(','));
  }
  console.log('[fg-player-baserunning] FG response field keys (row 0): '
    + Object.keys(rows[0] || {}).slice(0, 60).join(','));

  // Aggregate per xMLBAMID (= our mlb_id). Mid-season trade splits
  // are summed. Skip rows without xMLBAMID — we can't join them later.
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const accByMlbam = new Map();
  let skippedNoId = 0;
  for (const r of rows) {
    const mlbamRaw = r.xMLBAMID || r.MLBAMID || r.xmlbamid;
    if (mlbamRaw == null || mlbamRaw === '') { skippedNoId++; continue; }
    const mlbam_id = Math.round(Number(mlbamRaw));
    if (!Number.isFinite(mlbam_id) || mlbam_id <= 0) { skippedNoId++; continue; }
    let agg = accByMlbam.get(mlbam_id);
    if (!agg) {
      agg = {
        mlbam_id,
        name: (r.PlayerName || r.PlayerNameRoute || r.Name || '').toString().trim() || null,
        bsr: 0, ubr: 0, wsb: 0, wgdp: 0, sb: 0, cs: 0, g: 0,
        _bsrHas: false, _ubrHas: false, _wsbHas: false, _wgdpHas: false,
        _sbHas: false, _csHas: false, _gHas: false,
      };
      accByMlbam.set(mlbam_id, agg);
    }
    const bsr  = num(r.BaseRunning);
    const ubr  = num(r.UBR);
    const wsb  = num(r.wBsR);
    const wgdp = num(r.GDPRuns);
    const sb   = num(r.SB);
    const cs   = num(r.CS);
    const g    = num(r.G);
    if (bsr  != null) { agg.bsr  += bsr;  agg._bsrHas  = true; }
    if (ubr  != null) { agg.ubr  += ubr;  agg._ubrHas  = true; }
    if (wsb  != null) { agg.wsb  += wsb;  agg._wsbHas  = true; }
    if (wgdp != null) { agg.wgdp += wgdp; agg._wgdpHas = true; }
    if (sb   != null) { agg.sb   += sb;   agg._sbHas   = true; }
    if (cs   != null) { agg.cs   += cs;   agg._csHas   = true; }
    if (g    != null) { agg.g    += g;    agg._gHas    = true; }
  }
  if (skippedNoId) {
    console.warn('[fg-player-baserunning] skipped ' + skippedNoId
      + ' row(s) with no xMLBAMID (can\'t join — likely minor-leaguers or non-MLB IDs)');
  }
  const out = [];
  for (const agg of accByMlbam.values()) {
    out.push({
      mlbam_id: agg.mlbam_id,
      name:     agg.name,
      bsr:  agg._bsrHas  ? agg.bsr  : null,
      ubr:  agg._ubrHas  ? agg.ubr  : null,
      wsb:  agg._wsbHas  ? agg.wsb  : null,
      wgdp: agg._wgdpHas ? agg.wgdp : null,
      sb:   agg._sbHas   ? agg.sb   : null,
      cs:   agg._csHas   ? agg.cs   : null,
      g:    agg._gHas    ? agg.g    : null,
    });
  }
  console.log('[fg-player-baserunning] SUCCESS (' + out.length
    + ' unique players, raw rows=' + rows.length
    + ', traded-or-split=' + (rows.length - out.length - skippedNoId) + ')');
  return out;
}

// Trailing-window player baserunning. Same shape as
// fetchPlayerBaserunning but with explicit startdate/enddate so the
// caller can span across season boundaries. Probe verified FG honors
// the custom range (top-10 G = 126-162, BsR ~8-10 = full trailing
// year, ~2x YTD-only).
//
// Aggregation by xMLBAMID is identical to fetchPlayerBaserunning —
// mid-season trade splits (Devers "2 Tms") summed to one row per
// player.
async function fetchPlayerBaserunningTrailing(startdate, enddate, cookieValue) {
  if (!startdate || !enddate) throw new Error('fetchPlayerBaserunningTrailing: startdate and enddate required (YYYY-MM-DD)');
  const startYear = Number(startdate.slice(0, 4));
  const endYear   = Number(enddate.slice(0, 4));
  const url = 'https://www.fangraphs.com/api/leaders/major-league/data'
    + '?age='
    + '&pos=all'
    + '&stats=bat'
    + '&lg=all'
    + '&qual=0'
    + '&season='   + endYear           // FG uses season as the "end" year of the range
    + '&season1='  + startYear         // season1 = start year
    + '&startdate=' + startdate
    + '&enddate='   + enddate
    + '&month=0'
    + '&hand='
    + '&team=0'
    + '&pageitems=2000'
    + '&pagenum=1'
    + '&ind=1'
    + '&rost=0'
    + '&players=0'
    + '&type=8'
    + '&postseason='
    + '&sortdir=default'
    + '&sortstat=WAR';
  const resp = await fetch(url, { headers: baseHeaders(cookieValue) });
  if (!resp.ok) {
    const respDiag = {};
    for (const h of ['cf-ray', 'server', 'content-type', 'x-amz-cf-id', 'cf-cache-status']) {
      const v = resp.headers.get(h);
      if (v) respDiag[h] = v;
    }
    console.warn('[fg-player-baserunning-trailing] HTTP ' + resp.status + ' ' + url
      + ' | cookie_present=' + !!cookieValue
      + ' | response_headers=' + JSON.stringify(respDiag));
    throw new Error('FG player BsR trailing fetch ' + resp.status);
  }
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); }
  catch (e) { throw new Error('FG player BsR trailing returned non-JSON (first 200): ' + text.slice(0, 200)); }
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
  if (!rows || !rows.length) {
    throw new Error('FG player BsR trailing: zero rows | top-level keys: ' + Object.keys(body || {}).join(','));
  }
  console.log('[fg-player-baserunning-trailing] FG response field keys (row 0): '
    + Object.keys(rows[0] || {}).slice(0, 60).join(','));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const accByMlbam = new Map();
  let skippedNoId = 0;
  for (const r of rows) {
    const mlbamRaw = r.xMLBAMID || r.MLBAMID || r.xmlbamid;
    if (mlbamRaw == null || mlbamRaw === '') { skippedNoId++; continue; }
    const mlbam_id = Math.round(Number(mlbamRaw));
    if (!Number.isFinite(mlbam_id) || mlbam_id <= 0) { skippedNoId++; continue; }
    let agg = accByMlbam.get(mlbam_id);
    if (!agg) {
      agg = {
        mlbam_id,
        name: (r.PlayerName || r.PlayerNameRoute || r.Name || '').toString().trim() || null,
        bsr: 0, ubr: 0, wsb: 0, wgdp: 0, sb: 0, cs: 0, g: 0, pa: 0, ab: 0,
        stint_count: 0,
        _bsrHas: false, _ubrHas: false, _wsbHas: false, _wgdpHas: false,
        _sbHas: false, _csHas: false, _gHas: false, _paHas: false, _abHas: false,
      };
      accByMlbam.set(mlbam_id, agg);
    }
    // Each raw FG row for the same xMLBAMID = one team-stint within
    // the window. Multi-team players (Devers "2 Tms") arrive as two
    // rows and aggregate to one output row with stint_count=2. The
    // backtest surfaces how many lineup slots are affected by the
    // multi-stint look-ahead caveat (player's full-window BsR used
    // regardless of which team's lineup he appeared in on a given day).
    agg.stint_count++;
    const bsr  = num(r.BaseRunning);
    const ubr  = num(r.UBR);
    const wsb  = num(r.wBsR);
    const wgdp = num(r.GDPRuns);
    const sb   = num(r.SB);
    const cs   = num(r.CS);
    const g    = num(r.G);
    // PA + AB for the per-PA BsR rate (pa_weighted construction).
    // FG type=8 leaderboard row carries `PA` and `AB`; sum across
    // stints the same way bsr/g aggregate.
    const pa   = num(r.PA);
    const ab   = num(r.AB);
    if (bsr  != null) { agg.bsr  += bsr;  agg._bsrHas  = true; }
    if (ubr  != null) { agg.ubr  += ubr;  agg._ubrHas  = true; }
    if (wsb  != null) { agg.wsb  += wsb;  agg._wsbHas  = true; }
    if (wgdp != null) { agg.wgdp += wgdp; agg._wgdpHas = true; }
    if (sb   != null) { agg.sb   += sb;   agg._sbHas   = true; }
    if (cs   != null) { agg.cs   += cs;   agg._csHas   = true; }
    if (g    != null) { agg.g    += g;    agg._gHas    = true; }
    if (pa   != null) { agg.pa   += pa;   agg._paHas   = true; }
    if (ab   != null) { agg.ab   += ab;   agg._abHas   = true; }
  }
  if (skippedNoId) {
    console.warn('[fg-player-baserunning-trailing] skipped ' + skippedNoId + ' row(s) with no xMLBAMID');
  }
  const out = [];
  let nMultiTeam = 0;
  for (const agg of accByMlbam.values()) {
    if (agg.stint_count > 1) nMultiTeam++;
    out.push({
      mlbam_id: agg.mlbam_id,
      name:     agg.name,
      bsr:  agg._bsrHas  ? agg.bsr  : null,
      ubr:  agg._ubrHas  ? agg.ubr  : null,
      wsb:  agg._wsbHas  ? agg.wsb  : null,
      wgdp: agg._wgdpHas ? agg.wgdp : null,
      sb:   agg._sbHas   ? agg.sb   : null,
      cs:   agg._csHas   ? agg.cs   : null,
      g:    agg._gHas    ? agg.g    : null,
      pa:   agg._paHas   ? agg.pa   : null,
      ab:   agg._abHas   ? agg.ab   : null,
      stint_count: agg.stint_count,
    });
  }
  console.log('[fg-player-baserunning-trailing] SUCCESS (' + out.length
    + ' unique players, raw rows=' + rows.length
    + ', multi-team players=' + nMultiTeam
    + ', window=' + startdate + '..' + enddate + ')');
  return out;
}

module.exports = { refreshAllFanGraphs, refreshFanGraphsActuals, fetchActualSplit, fetchTeamBaserunning, fetchPlayerBaserunning, fetchPlayerBaserunningTrailing, jsonToProjectionCsv, jsonToCsv };
