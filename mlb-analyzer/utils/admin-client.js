/**
 * Read production through the admin query API. (2026-08-29)
 *
 * WHY THIS EXISTS. The analysis copy is a separately-evolved database, so
 * a question about production cannot be answered from it -- that mistake
 * cost a false outage report on 2026-08-24. The alternative was a 671MB
 * download every time a check ran, which is why the whitelisted admin
 * queries exist at all.
 *
 * Extracted from scripts/verify-capture-in-prod.js when a SECOND script
 * needed the same token loading and fetch. A third copy is how the
 * duplicate-implementation problem starts, and this repo has paid for that
 * more than once.
 *
 * TRUNCATION IS NEVER SILENT. The endpoint caps at MAX_ROWS (1000) and
 * reports `truncated`. A measurement computed on a silently-truncated set
 * is wrong in a way nothing downstream can detect, so fetchAll() pages
 * with a keyset and throws rather than returning a short answer.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = process.env.PROD_URL || 'https://mlb-analyzer.onrender.com';

// Token from the environment or a gitignored file. Never logged, never
// echoed -- callers get a boolean from hasToken(), not the value.
function token() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  const roots = [process.cwd(), path.join(__dirname, '..'), path.join(__dirname, '..', '..')];
  for (const r of roots) {
    try { return fs.readFileSync(path.join(r, '.admin-token'), 'utf8').trim(); } catch (e) { /* next */ }
  }
  return null;
}
const hasToken = () => !!token();

async function query(name, params, opts) {
  opts = opts || {};
  const tok = token();
  if (!tok) {
    throw new Error('no admin token. Set ADMIN_TOKEN or create a .admin-token file. '
      + 'It is the same value as the DB_DOWNLOAD_TOKEN env var on the server.');
  }
  const url = new URL((opts.base || DEFAULT_BASE) + '/api/admin/query/' + name);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { 'X-Admin-Token': tok } });
  const body = await r.text();
  if (r.status === 401) throw new Error('401 — the admin token was rejected. If DB_DOWNLOAD_TOKEN was rotated, this is the stale value.');
  if (r.status === 503) throw new Error('503 — the server has no DB_DOWNLOAD_TOKEN set, so the endpoint is disabled.');
  if (!r.ok) throw new Error(name + ' -> HTTP ' + r.status + ': ' + body.slice(0, 300));
  let j;
  try { j = JSON.parse(body); } catch (e) { throw new Error(name + ' -> unparseable response: ' + body.slice(0, 200)); }
  return j;
}

/**
 * Page a query to completion using a keyset column.
 *
 * The endpoint has no OFFSET, so paging is by a strictly-increasing key.
 * `keyParam` is the query's cursor parameter and `keyField` the column it
 * advances over. The LAST key group is dropped from each page and
 * re-fetched, because a page boundary can land inside one key's rows and a
 * caller that groups by that key (the oscillation reversal walk does)
 * would otherwise see a truncated group as a complete one.
 */
async function fetchAll(name, params, keyParam, keyField, opts) {
  opts = opts || {};
  const out = [];
  let cursor = null, pages = 0;
  const seen = new Set();
  for (;;) {
    const p = Object.assign({}, params);
    if (cursor != null) p[keyParam] = cursor;
    const res = await query(name, p, opts);
    const rows = res.rows || [];
    pages++;
    if (!rows.length) break;

    let take = rows;
    if (res.truncated) {
      // Drop the trailing partial key group and resume from it.
      const lastKey = rows[rows.length - 1][keyField];
      take = rows.filter(r => r[keyField] !== lastKey);
      if (!take.length) {
        throw new Error('cannot page ' + name + ': a single ' + keyField
          + ' (' + lastKey + ') fills an entire page, so no cursor can advance.');
      }
      cursor = take[take.length - 1][keyField];
    }
    for (const r of take) {
      // Belt and braces: a cursor that failed to advance would loop forever
      // and quietly duplicate rows into the measurement.
      const id = r[keyField] + '|' + (r.created_at || '') + '|' + (r.action || '');
      if (!seen.has(id)) { seen.add(id); out.push(r); }
    }
    if (!res.truncated) break;
    if (pages > (opts.maxPages || 200)) {
      throw new Error('paging ' + name + ' exceeded ' + (opts.maxPages || 200)
        + ' pages — refusing to keep going rather than report a partial measurement.');
    }
  }
  return { rows: out, pages };
}

module.exports = { token, hasToken, query, fetchAll, DEFAULT_BASE };
