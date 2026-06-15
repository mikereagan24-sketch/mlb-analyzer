'use strict';

// One-click refresh for the eight FanGraphs split CSVs the model depends on:
// four Steamer RoS projections (bat vs L/R, pit vs L/R) and four two-year
// trailing actuals (same four splits). Caller supplies a fangraphs.com
// Member session cookie value — user pastes it into the Model tab and the
// route pulls it from app_settings before invoking refreshAllFanGraphs.
// Cookie name is a stable WordPress COOKIEHASH, not a secret.

const PROJ_BASE  = 'https://www.fangraphs.com/api/projections';
const ACTUAL_URL = 'https://www.fangraphs.com/api/leaders/splits/splits-leaders';
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
  if (!res.ok) throw new Error('Projection fetch ' + type + '/' + stats + ' failed: HTTP ' + res.status);
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

function twoYearDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 2);
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

async function fetchActualSplit(splitCode, position, cookieValue) {
  const { start, end } = twoYearDateRange();
  // strType: 1 (number) for batters but "2" (STRING) for pitchers. This is
  // what FanGraphs' own front-end sends — do not "fix" it to 2 (number) or
  // the pitcher endpoint returns an empty data array.
  const body = {
    strSplitArr: [splitCode],
    strGroup: 'season',
    strPosition: position,
    strType: position === 'P' ? '2' : 1,
    strStartDate: start,
    strEndDate: end,
    strSplitTeams: false,
    dctFilters: [],
    strStatType: 'player',
    // strAutoPt is FG's body parameter for the API endpoint at line 11
    // (ACTUAL_URL). However, that endpoint is not called during normal
    // operation — actuals ingest happens via a browser bookmarklet that
    // hits FG's web URL with the analogous `autoPt` query parameter.
    // fetchActualSplit (and this strAutoPt setting) is reached only by
    // admin diagnostic endpoints. Kept at 'true' to match what FG would
    // return to non-authenticated browser sessions; the bookmarklet
    // independently sets autoPt=false for the actual ingest. See
    // docs/bookmarklet-actuals.txt for the canonical bookmarklet source.
    strAutoPt: 'true',
    arrPlayerId: [],
    strPlayerId: 'all',
    strSplitArrPitch: [],
    arrWxTemperature: [],
    arrWxPressure: [],
    arrWxAirDensity: [],
    arrWxElevation: [],
    arrWxWindSpeed: [],
  };
  const res = await fetch(ACTUAL_URL, {
    method: 'POST',
    headers: Object.assign({}, baseHeaders(cookieValue), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Actual fetch split=' + splitCode + ' pos=' + position + ' failed: HTTP ' + res.status);
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
async function refreshAllFanGraphs(cookieValue) {
  const tasks = [
    { name: 'bat-proj-lhp', fn: () => fetchProjection('rsteamer_vl_0', 'bat', cookieValue) },
    { name: 'bat-proj-rhp', fn: () => fetchProjection('rsteamer_vr_0', 'bat', cookieValue) },
    { name: 'pit-proj-lhb', fn: () => fetchProjection('rsteamer_vl_p_1', 'pit', cookieValue) },
    { name: 'pit-proj-rhb', fn: () => fetchProjection('rsteamer_vr_p_1', 'pit', cookieValue) },
    { name: 'bat-act-lhp',  fn: () => fetchActualSplit(1, 'B', cookieValue) },
    { name: 'bat-act-rhp',  fn: () => fetchActualSplit(2, 'B', cookieValue) },
    { name: 'pit-act-lhb',  fn: () => fetchActualSplit(5, 'P', cookieValue) },
    { name: 'pit-act-rhb',  fn: () => fetchActualSplit(6, 'P', cookieValue) },
  ];
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

module.exports = { refreshAllFanGraphs, fetchActualSplit, fetchTeamBaserunning };
