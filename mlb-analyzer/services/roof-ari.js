'use strict';

// D-backs roof-status ingest (Node, runs on Render).
//
// Fetches the official D-backs roof page and writes per-game announced
// roof_status into game_log before runWeatherJob fires.
//
// Flow per call (runRoofStatusIngest(date)):
//   1. fetch https://www.mlb.com/dbacks/ballpark/information/roof
//   2. Extract the Next.js __NEXT_DATA__ JSON block from the raw HTML
//      and walk the tree to the Contentful entry with
//      slug='ari-table-roof-status'. rawData.tableHeadStrings names the
//      columns (Date | Time | Opponent | Roof); rawData.tableBodyStrings
//      is a <tr>-per-game HTML fragment. Parsed row-wise, header-indexed.
//   3. Roof values are UPPERCASE ("CLOSED"/"OPEN") for announced games
//      and "--" for not-yet-announced forward games in the homestand
//      table. "--" rows are DELIBERATELY SKIPPED — they fall through to
//      the ARI prior tier (which for venue 15 is null → default-open in
//      runWeatherJob, preserving the pre-scraper behavior). Writing "--"
//      as open would silently produce the same bug we're fixing.
//   4. For each recognized row (CLOSED/OPEN), UPDATE game_log SET
//      roof_status, roof_confidence='announced' WHERE venue_id=15 AND
//      game_date=?. Scraped rows with no matching game_log entry are
//      reported as unmatched and NOT written — guards against wrong-year
//      labels at the off-season boundary.
//
// Pre-2026-08 the page shipped server-rendered <td> cells and the
// scraper regex'd them directly. MLB rebuilt as a client-rendered
// Next.js app; the raw HTML now has one <td> and zero opponent names.
// The full table is still present, but only inside the __NEXT_DATA__
// hydration payload — hence the parse switches to JSON. See
// docs/roof-ari-nextdata-migration-2026-08 for the diagnosis.
//
// SAFETY (called from runWeatherJob — must never break the weather job):
//   - HTTP / parse failure → return { success: false, ... }. Do NOT throw.
//     No rows are touched on failure (no overwrite of a known-good
//     announced value with empty data).
//   - Empty scraped set → return { success: true, scraped: 0, updated: 0 }
//     with reason 'empty_scrape'. Existing roof_status preserved.
//     Health check (see empty-scrape branch below) escalates to
//     console.error with the '[roof-ari-health]' grep tag when there
//     are upcoming home games it should have covered.
//   - Confidence guard: never DOWNGRADES. If a row already has
//     roof_confidence='actual' (post-game ground truth, written by
//     roof-correct.js) and the scrape would write 'announced', the
//     actual stays.
//
// Returns a summary object with { success, scraped, updated, nochange,
// unmatched, errors }. Caller logs; nothing thrown.

const { db } = require('../db/schema');
const fetch = require('node-fetch');

const ROOF_URL = 'https://www.mlb.com/dbacks/ballpark/information/roof';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CHASE_VENUE_ID = 15;

const MONTH_NUM = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// Contentful slug of the roof-status table in the __NEXT_DATA__ tree.
// Stable across the last several editorial republishes; if MLB ever
// renames it, the walker returns null and the empty-scrape health check
// fires (which is the actionable signal).
const ROOF_TABLE_SLUG = 'ari-table-roof-status';

// "Mon, Aug. 3" | "Sunday, Jun 19" | "Tues, June 16" → "YYYY-MM-DD".
// Tolerates the trailing-period-on-month-abbr form the Next.js copy
// uses ("Aug.") as well as the plain form the old server-rendered
// copy used ("Aug"). Returns null when the cell doesn't parse.
function dateCellToIso(cell, year) {
  if (!cell) return null;
  const after = String(cell).trim().replace(/^[A-Za-z]+,\s+/, '');
  const parts = after.split(/\s+/);
  if (parts.length < 2) return null;
  const monRaw = String(parts[0]).replace(/\.$/, '');
  const monKey = monRaw.slice(0, 3);
  const mm = MONTH_NUM[monKey.charAt(0).toUpperCase() + monKey.slice(1).toLowerCase()];
  if (!mm) return null;
  const dayNum = parseInt(parts[1], 10);
  if (!(dayNum >= 1 && dayNum <= 31)) return null;
  return `${year}-${mm}-${String(dayNum).padStart(2, '0')}`;
}

// Locate the __NEXT_DATA__ <script>...</script> block and parse its
// JSON body. Returns null on any failure; caller falls through to
// empty-scrape handling.
function extractNextData(html) {
  if (!html) return null;
  const rx = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
  const m = html.match(rx);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// Walk the __NEXT_DATA__ tree for the first Contentful entry whose
// slug matches ROOF_TABLE_SLUG. The exact path is
// props.pageProps.page.slots["Left Rail"][1].slots["Main Column"][1]
// today, but slug-lookup is stable against layout reshuffles.
function findRoofTableEntry(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.slug === ROOF_TABLE_SLUG && node.rawData) return node;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRoofTableEntry(n); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(node)) {
    const r = findRoofTableEntry(node[k]);
    if (r) return r;
  }
  return null;
}

// Parse an HTML fragment like "<tr><td>..</td><td>..</td></tr>..." into
// an array of cell-arrays, one per <tr>. <td> bodies are trimmed;
// nested markup isn't expected (the table is pure text), so a simple
// [^<]* body match is safe.
function parseTableRows(fragment) {
  const rows = [];
  if (!fragment) return rows;
  const trRx = /<tr>([\s\S]*?)<\/tr>/g;
  const tdRx = /<td>([^<]*)<\/td>/g;
  let tm;
  while ((tm = trRx.exec(fragment)) !== null) {
    const cells = [];
    let cm;
    while ((cm = tdRx.exec(tm[1])) !== null) cells.push(cm[1].trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// Header row → { Date, Time, Opponent, Roof } → column indexes. Reading
// by header name makes us resilient to column reordering (any of the
// four columns can move without breaking us; a missing column returns
// -1 and the parser exits with 0 rows so the health check fires).
function parseHeaderIndexes(headerFragment) {
  const cols = [];
  if (!headerFragment) return { date: -1, time: -1, opponent: -1, roof: -1 };
  const thRx = /<th>([^<]*)<\/th>/g;
  let hm;
  while ((hm = thRx.exec(headerFragment)) !== null) cols.push(hm[1].trim().toLowerCase());
  return {
    date:     cols.indexOf('date'),
    time:     cols.indexOf('time'),
    opponent: cols.indexOf('opponent'),
    roof:     cols.indexOf('roof'),
  };
}

// Parse the raw HTML response into structured rows:
//   [{ game_date: 'YYYY-MM-DD', opponent, status: 'open'|'closed', game_time }, ...]
// Only rows with a recognized status ('open'/'closed', any case) are
// returned. "--" placeholders (forward-dated games the D-backs haven't
// announced yet) and blank / unknown values are DELIBERATELY skipped
// so they fall through to the prior tier — writing them as open would
// silently produce the same "closed reality, model reads open" bug.
// Signature preserved so callers/tests don't need to change; `year` is
// used to complete the month-day dates the page ships.
function parseRoofHtml(html, year) {
  const data = extractNextData(html);
  if (!data) return [];
  const entry = findRoofTableEntry(data);
  if (!entry || !entry.rawData) return [];
  const idx = parseHeaderIndexes(entry.rawData.tableHeadStrings);
  if (idx.date < 0 || idx.roof < 0) return [];
  const rows = parseTableRows(entry.rawData.tableBodyStrings);
  const maxIdx = Math.max(idx.date, idx.time, idx.opponent, idx.roof);
  const out = [];
  for (const cells of rows) {
    if (cells.length <= maxIdx) continue;
    const gdate = dateCellToIso(cells[idx.date], year);
    if (!gdate) continue;
    const roofRaw = String(cells[idx.roof] || '').trim().toLowerCase();
    let status;
    if (roofRaw === 'closed') status = 'closed';
    else if (roofRaw === 'open') status = 'open';
    else continue;  // "--" or anything else → skip, fall through to prior/default
    out.push({
      game_date: gdate,
      opponent:  idx.opponent >= 0 ? cells[idx.opponent] : '',
      status,
      game_time: idx.time >= 0 ? cells[idx.time] : '',
    });
  }
  // Order-preserving dedupe on game_date — belt-and-suspenders in case
  // MLB ever double-embeds the table (they historically did — old
  // scraper's DOM + hydration copies).
  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    if (seen.has(r.game_date)) continue;
    seen.add(r.game_date);
    dedup.push(r);
  }
  return dedup;
}

async function fetchRoofHtml() {
  // Short timeout — D-backs roof page is fast. Don't let a hung HTTP
  // request stall the weather job.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(ROOF_URL, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status, text: '' };
    const text = await resp.text();
    return { ok: true, status: resp.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Main entrypoint. `date` is informational only — the scrape returns
// the whole homestand, and every scraped row is matched against game_log
// independently. Passing date lets the caller scope the log output.
async function runRoofStatusIngest(date) {
  const summary = {
    job: 'roof-status-ari',
    target_date: date || null,
    success: false,
    scraped: 0,
    updated: 0,
    nochange: 0,
    unmatched: 0,
    rows: [],
    errors: [],
  };

  let resp;
  try {
    resp = await fetchRoofHtml();
  } catch (e) {
    summary.errors.push('fetch_failed: ' + e.message);
    console.warn('[roof-ari] fetch failed (non-fatal): ' + e.message);
    return summary;
  }
  if (!resp.ok) {
    summary.errors.push('http_' + resp.status);
    console.warn('[roof-ari] HTTP ' + resp.status + ' from ' + ROOF_URL);
    return summary;
  }

  const year = new Date().getFullYear();
  let scraped;
  try {
    scraped = parseRoofHtml(resp.text, year);
  } catch (e) {
    summary.errors.push('parse_failed: ' + e.message);
    console.warn('[roof-ari] parse failed (non-fatal): ' + e.message);
    return summary;
  }
  summary.scraped = scraped.length;
  if (!scraped.length) {
    summary.errors.push('empty_scrape');
    // Health check: an empty scrape is only actionable when there are
    // upcoming ARI home games it SHOULD have covered. Off-season / no-
    // slate windows return 0 scraped and 0 expected legitimately.
    // Do NOT tag upcoming rows as contaminated — that mutates the
    // scoring path; the right response is to fix the scraper. The
    // '[roof-ari-health]' tag is intentionally distinct from the
    // regular '[roof-ari]' log prefix so ops can grep the alert
    // without pulling in success-path noise.
    let expected = 0;
    try {
      const runDate = date || new Date().toISOString().slice(0, 10);
      const endDate = new Date(new Date(runDate).getTime() + 14 * 86400000)
        .toISOString().slice(0, 10);
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM game_log '
        + 'WHERE venue_id = ? AND game_date >= ? AND game_date <= ?'
      ).get(CHASE_VENUE_ID, runDate, endDate);
      expected = (row && row.n) || 0;
    } catch (e) {
      console.warn('[roof-ari-health] expected-count query failed (non-fatal): ' + e.message);
    }
    summary.expected_upcoming = expected;
    if (expected > 0) {
      console.error('[roof-ari-health] ALERT scraped=0 expected>=' + expected
        + ' upcoming ARI home games in next 14 days from ' + (date || 'today')
        + ' — scraper likely broken (roof_status left untouched)');
    } else {
      console.warn('[roof-ari] empty scrape (no upcoming ARI home games — likely off-season)');
    }
    return summary;
  }

  // Prepared statements — created lazily so a fresh DB without the
  // roof columns yet (shouldn't happen post-deploy; defensive) doesn't
  // crash on require. Caller wraps in try/catch anyway.
  const selectStmt = db.prepare(
    'SELECT game_id, roof_status, roof_confidence FROM game_log '
    + 'WHERE venue_id = ? AND game_date = ?'
  );
  const updateStmt = db.prepare(
    "UPDATE game_log SET roof_status = ?, roof_confidence = 'announced' "
    + 'WHERE venue_id = ? AND game_date = ? AND game_id = ?'
  );

  // One transaction per ingest run so a partial failure mid-batch
  // rolls back cleanly. Each scraped row may match 0, 1, or 2 game_log
  // rows (the latter for a doubleheader).
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const matched = selectStmt.all(CHASE_VENUE_ID, r.game_date);
      if (!matched.length) {
        summary.unmatched++;
        summary.rows.push({ game_date: r.game_date, opponent: r.opponent,
          scraped_status: r.status, result: 'unmatched' });
        continue;
      }
      for (const g of matched) {
        const curStatus = (g.roof_status || '').toLowerCase();
        const curConf   = (g.roof_confidence || '');
        // Confidence guard — never DOWNGRADE. 'actual' is the only
        // value above 'announced' (post-game ground truth); preserve
        // it if it ever lands here.
        if (curConf === 'actual') {
          summary.nochange++;
          summary.rows.push({ game_date: r.game_date, game_id: g.game_id,
            before: `${g.roof_status}/${curConf}`, after: 'unchanged (actual is canonical)',
            result: 'nochange' });
          continue;
        }
        if (curStatus === r.status && curConf === 'announced') {
          summary.nochange++;
          summary.rows.push({ game_date: r.game_date, game_id: g.game_id,
            before: `${g.roof_status}/announced`, after: 'unchanged (already correct)',
            result: 'nochange' });
          continue;
        }
        updateStmt.run(r.status, CHASE_VENUE_ID, r.game_date, g.game_id);
        summary.updated++;
        summary.rows.push({ game_date: r.game_date, game_id: g.game_id,
          before: `${g.roof_status || 'null'}/${curConf || 'null'}`,
          after: `${r.status}/announced`, result: 'updated' });
      }
    }
  });
  try {
    tx(scraped);
    summary.success = true;
  } catch (e) {
    summary.errors.push('db_tx_failed: ' + e.message);
    console.warn('[roof-ari] DB transaction failed (non-fatal): ' + e.message);
    return summary;
  }
  console.log('[roof-ari] scraped=' + summary.scraped
    + ' updated=' + summary.updated
    + ' nochange=' + summary.nochange
    + ' unmatched=' + summary.unmatched);
  return summary;
}

module.exports = { runRoofStatusIngest, parseRoofHtml };
