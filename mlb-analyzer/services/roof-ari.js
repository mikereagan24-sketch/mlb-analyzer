'use strict';

// D-backs roof-status ingest (Node, runs on Render).
//
// Mirrors scripts/scrape-ari-roof.sh + scripts/ingest_roof_status.py in
// one Node module so the prod app (Node-only on Render) can ingest the
// official D-backs roof page directly, before runWeatherJob fires.
//
// Flow per call (runRoofStatusIngest(date)):
//   1. fetch https://www.mlb.com/dbacks/ballpark/information/roof
//   2. parse the server-rendered <td> cells → rows of
//        { game_date: 'YYYY-MM-DD', opponent, status: 'open'|'closed', game_time }
//      Same parser logic as the shell script (matches a date cell of
//      shape "Sunday, Jun 19" → YYYY = current calendar year, then reads
//      time / opponent / status from the next cells; falls back to
//      scanning ±5 cells for status if the table column order shifts).
//   3. For each scraped row, UPDATE game_log SET roof_status,
//      roof_confidence='announced' WHERE venue_id=15 AND game_date=?.
//      A scraped row with no matching game_log entry is reported as
//      unmatched and NOT written — guards against wrong-year labels at
//      the off-season boundary.
//
// SAFETY (called from runWeatherJob — must never break the weather job):
//   - HTTP / parse failure → return { success: false, ... }. Do NOT throw.
//     No rows are touched on failure (no overwrite of a known-good
//     announced value with empty data).
//   - Empty scraped set → return { success: true, scraped: 0, updated: 0 }
//     with reason 'empty_scrape'. Existing roof_status preserved.
//   - Confidence guard: never DOWNGRADES. If a row already has
//     roof_confidence='actual' (post-game ground truth, hypothetically
//     a future enhancement) and the scrape would write 'announced',
//     the actual stays. Currently no upstream writes 'actual', so this
//     is purely defensive.
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

// Date-cell shape: "Sunday, Jun 19" — weekday, space-comma, mon abbr,
// day-of-month. Anchored so we don't false-match other table cells.
const DATE_CELL_RE = /^[A-Za-z]+,\s+[A-Z][a-z]+\s+[0-9]+$/;

function dateCellToIso(cell, year) {
  // cell shapes seen on prod: "Mon, June 15", "Tues, June 16",
  // "Sunday, Jun 19" — variable weekday abbr, variable month length.
  // Prefix-match the month to its first 3 chars to handle both
  // "Jun" and "June" (same approach as the shell script's awk).
  const after = cell.replace(/^[A-Za-z]+,\s+/, '');
  const parts = after.split(/\s+/);
  if (parts.length < 2) return null;
  const monKey = String(parts[0]).slice(0, 3);
  const mm = MONTH_NUM[monKey.charAt(0).toUpperCase() + monKey.slice(1).toLowerCase()];
  if (!mm) return null;
  const dd = String(parts[1]).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Parse the raw HTML response into structured rows. Same shape the
// shell script's awk stage produced. Order-preserving dedupe at the
// end (the roof table is embedded twice — hydrated DOM + JSON payload).
function parseRoofHtml(html, year) {
  if (!html) return [];
  // Unescape the JSON-hydration cells the same way the shell did so
  // both copies of the table parse identically.
  const unesc = html
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\u0026/g, '&');

  const cells = [];
  const td = /<td>([^<]*)<\/td>/g;
  let m;
  while ((m = td.exec(unesc)) !== null) cells.push(m[1]);
  if (!cells.length) return [];

  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const line = cells[i];
    if (!DATE_CELL_RE.test(line)) continue;
    const gdate = dateCellToIso(line, year);
    if (!gdate) continue;
    const gtime = cells[i + 1];
    const opp   = cells[i + 2];
    let status  = cells[i + 3];
    // Fallback scan: column order occasionally shifts; status is the
    // only cell that's ever exactly "Open" or "Closed", so search
    // forward up to 5 cells if the strict slot didn't hit.
    if (status !== 'Open' && status !== 'Closed') {
      for (let j = i + 1; j <= i + 5 && j < cells.length; j++) {
        if (cells[j] === 'Open' || cells[j] === 'Closed') { status = cells[j]; break; }
      }
    }
    if (status === 'Open' || status === 'Closed') {
      out.push({ game_date: gdate, opponent: opp, status: status.toLowerCase(), game_time: gtime });
    }
  }
  // Order-preserving dedupe on game_date — the table appears twice in
  // the page, identical rows collapse to one. Keeping order makes the
  // log output reproducible.
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
    console.warn('[roof-ari] empty scrape — leaving existing roof_status untouched');
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
