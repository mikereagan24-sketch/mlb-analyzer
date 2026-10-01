'use strict';

// POST /api/upload/top-trader-seed -- seed the Polymarket top-traders card's
// production tables (docs/polymarket-top-traders-card-decisions-2026-10-01.md,
// decision 4) from the CSV written locally by scripts/export-top-trader-seed.js.
// (2026-10-01) DISPLAY ONLY: nothing in the pricing path reads these tables.
//
// ITS OWN ROUTER, NOT routes/api.js: that file sits in the pricing path's
// require graph (services/jobs.js requires it). Mounted in server.js BEFORE
// routes/api.js, whose catch-all POST /upload/:key? would otherwise take this
// path. Gated by the same X-Admin-Token check as the other admin uploads
// (utils/admin-auth.js -- one implementation, imported, not copied).
//
// STREAMED: the body is read line by line (readline over the request stream),
// never parsed whole; rows are validated one at a time and written to the
// staging tables (top_trader_seed_stage_*) in transactions of CHUNK rows, so
// memory stays flat whatever the file size.
// REPLACE, ALL OR NOTHING: once the whole file has staged with no rejected
// row, one transaction replaces top_trader_wallets with exactly the file's
// wallet rows and the file's as_of qualified set with exactly its qualified
// rows. A wallet or qualified row missing from the file is gone afterwards;
// changed values are updated. If ANY row is rejected (bad field, repeated
// wallet_id or address, a qualified wallet with no wallet row), nothing changes
// and the response is 422 with the rejected samples; a body cut off mid-upload
// also changes nothing.
// (2026-10-01: the first version upserted, so a wallet missing from a second
// upload stayed -- found by the seed-replace check before the first upload.)
// Re-uploading the same file leaves the same table contents.
//
// NO ROUTE EVER RETURNS A WALLET ADDRESS. The address is written to
// top_trader_wallets.addr and never selected or echoed: the response carries
// counts, and a rejected row is reported by line number and reason only.
// scripts/test-top-traders-card-a.js (check d) enforces this.

const readline = require('readline');
const express = require('express');
const { requireAdminToken } = require('../utils/admin-auth');
const { SEED_HEADER: HEADER } = require('../db/top-traders-ddl');
const CHUNK = 2000;               // rows per write transaction
const MAX_LINE = 512;             // bytes; a valid row is well under 200
const MAX_REJECT_SAMPLES = 20;

const router = express.Router();
let _db = null;
let busy = false;                 // one upload at a time: uploads share the staging tables
const appDb = () => (_db || (_db = require('../db/schema').db));   // the app's own handle, read-write

const isInt = (s) => /^\d+$/.test(s);
const isNum = (s) => /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s) && Number.isFinite(Number(s));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// -> { row } | { reason }   (a reason never quotes the address)
function parseRow(line, asOf) {
  if (line.length > MAX_LINE) return { reason: 'line too long' };
  const f = line.split(',');
  if (f.length !== 8) return { reason: 'expected 8 fields, got ' + f.length };
  const [type, id, addr, games, profit, volume, both, as_of] = f;
  if (!isInt(id) || Number(id) < 1) return { reason: 'wallet_id must be a positive integer' };
  if (!isDate(as_of)) return { reason: 'as_of must be YYYY-MM-DD' };
  if (asOf && as_of !== asOf) return { reason: 'as_of differs from the first row' };
  if (type === 'wallet') {
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return { reason: 'addr must be a 0x-prefixed 40-hex-digit lower-case address' };
    if (!isInt(games)) return { reason: 'games must be a non-negative integer' };
    if (!isNum(profit)) return { reason: 'profit must be a number' };
    if (!isNum(volume) || Number(volume) < 0) return { reason: 'volume must be a non-negative number' };
    if (!isInt(both) || Number(both) > Number(games)) return { reason: 'both_teams must be an integer between 0 and games' };
    return { row: { type, wallet_id: Number(id), addr, games: Number(games), profit: Number(profit), volume: Number(volume),
      both_teams: Number(both), as_of } };
  }
  if (type === 'qualified') {
    if (addr || games || profit || volume || both) return { reason: 'qualified rows carry only wallet_id and as_of' };
    return { row: { type, wallet_id: Number(id), as_of } };
  }
  return { reason: 'type must be wallet or qualified' };
}

router.post('/upload/top-trader-seed', requireAdminToken, async (req, res) => {
  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'text/csv' && ctype !== 'application/octet-stream') {
    return res.status(415).json({ error: 'send the CSV as text/csv' });
  }
  if (busy) return res.status(409).json({ error: 'another seed upload is in progress; nothing changed' });
  busy = true;
  const t0 = Date.now();
  const db = appDb();
  const clearStage = () => { db.prepare('DELETE FROM top_trader_seed_stage_wallets').run(); db.prepare('DELETE FROM top_trader_seed_stage_qualified').run(); };
  // The live tables are only touched by swap(), and only after the whole file has staged cleanly.
  const delWallets = db.prepare('DELETE FROM top_trader_wallets');
  const delQual = db.prepare('DELETE FROM top_trader_qualified WHERE as_of = ?');
  const goneWallets = db.prepare('SELECT COUNT(*) c FROM top_trader_wallets WHERE wallet_id NOT IN (SELECT wallet_id FROM top_trader_seed_stage_wallets)');
  const goneQual = db.prepare('SELECT COUNT(*) c FROM top_trader_qualified WHERE as_of = ? AND wallet_id NOT IN (SELECT wallet_id FROM top_trader_seed_stage_qualified)');
  const orphans = db.prepare(`SELECT q.line FROM top_trader_seed_stage_qualified q
    LEFT JOIN top_trader_seed_stage_wallets w ON w.wallet_id = q.wallet_id WHERE w.wallet_id IS NULL ORDER BY q.line`);
  const stageWallet = db.prepare(`INSERT OR IGNORE INTO top_trader_seed_stage_wallets (wallet_id, addr, games, profit, volume, both_teams, as_of)
    VALUES (@wallet_id, @addr, @games, @profit, @volume, @both_teams, @as_of)`);
  const stageQual = db.prepare('INSERT OR IGNORE INTO top_trader_seed_stage_qualified (wallet_id, line) VALUES (?, ?)');
  const copyWallets = db.prepare(`INSERT INTO top_trader_wallets (wallet_id, addr, games, profit, volume, both_teams, as_of)
    SELECT wallet_id, addr, games, profit, volume, both_teams, as_of FROM top_trader_seed_stage_wallets`);
  const copyQual = db.prepare('INSERT INTO top_trader_qualified (as_of, wallet_id) SELECT ?, wallet_id FROM top_trader_seed_stage_qualified');
  // -> the line numbers of rows that repeat an earlier row's wallet_id (or address)
  const stageChunk = db.transaction((rows) => {
    const dup = [];
    for (const r of rows) {
      const info = r.type === 'wallet' ? stageWallet.run(r) : stageQual.run(r.wallet_id, r.line);
      if (info.changes === 0) dup.push(r);
    }
    return dup;
  });
  const swap = db.transaction((asOf) => {
    delWallets.run();
    const w = copyWallets.run().changes;
    delQual.run(asOf);
    const q = copyQual.run(asOf).changes;
    return { w, q };
  });

  let lineNo = 0, asOf = null, headerOk = false;
  const counts = { wallet_rows_written: 0, qualified_rows_written: 0, rejected: 0 };
  const samples = [];
  const reject = (line, reason) => { counts.rejected++; if (samples.length < MAX_REJECT_SAMPLES) samples.push({ line, reason }); };
  let staged = 0, pending = [];
  const flush = () => {
    if (!pending.length) return;
    for (const r of stageChunk(pending)) {
      reject(r.line, r.type === 'wallet' ? 'wallet_id or addr repeats an earlier wallet row' : 'qualified wallet_id repeats an earlier qualified row');
    }
    staged += pending.length;
    pending = [];
  };
  try {
    clearStage();
    const rl = readline.createInterface({ input: req, crlfDelay: Infinity });
    for await (const raw of rl) {
      lineNo++;
      const line = raw.replace(/\r$/, '');
      if (lineNo === 1) {
        if (line.replace(/^﻿/, '') !== HEADER) {
          rl.close();
          return res.status(400).json({ error: 'header must be exactly: ' + HEADER + '; nothing changed', replaced: false });
        }
        headerOk = true;
        continue;
      }
      if (!line.trim()) continue;
      const p = parseRow(line, asOf);
      if (p.reason) { reject(lineNo, p.reason); continue; }
      if (!asOf) asOf = p.row.as_of;
      p.row.line = lineNo;
      pending.push(p.row);
      if (pending.length >= CHUNK) flush();
    }
    flush();
    if (!req.complete) return res.status(400).json({ error: 'upload ended before the whole file arrived; nothing changed', replaced: false });
    if (!headerOk) return res.status(400).json({ error: 'empty upload; nothing changed', replaced: false });
    if (!staged && !counts.rejected) return res.status(400).json({ error: 'the file has no rows; nothing changed', replaced: false });
    for (const o of orphans.iterate()) reject(o.line, 'qualified wallet_id has no wallet row in this file');
    const base = { as_of: asOf, lines: lineNo };
    if (counts.rejected) {
      return res.status(422).json(Object.assign({ ok: false, replaced: false, error: counts.rejected + ' row(s) rejected; nothing changed' },
        base, counts, { rejected_samples: samples, duration_ms: Date.now() - t0 }));
    }
    const removed = { wallets_removed: goneWallets.get().c, qualified_removed: goneQual.get(asOf).c };
    const n = swap(asOf);
    counts.wallet_rows_written = n.w; counts.qualified_rows_written = n.q;
    res.json(Object.assign({ ok: true, replaced: true }, base, counts, removed, { rejected_samples: samples, duration_ms: Date.now() - t0 }));
  } catch (e) {
    if (!res.headersSent) res.status(500).json(Object.assign({ error: 'upload failed; nothing changed: ' + (e && e.message ? e.message : e), replaced: false }, counts));
  } finally {
    try { clearStage(); } catch (e) { /* the next upload clears it first anyway */ }
    busy = false;
  }
});

// For tests: release the cached handle.
router._resetDb = () => { _db = null; };

module.exports = router;
module.exports.HEADER = HEADER;
module.exports.parseRow = parseRow;
