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
// never parsed whole; rows are validated one at a time and written in
// transactions of CHUNK rows, so memory stays flat whatever the file size.
// IDEMPOTENT: wallets are upserted by wallet_id, and the qualified set for the
// file's as_of date is replaced (deleted, then inserted) -- re-uploading the
// same file leaves the same table contents.
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
  const t0 = Date.now();
  const db = appDb();
  const upWallet = db.prepare(`INSERT INTO top_trader_wallets (wallet_id, addr, games, profit, volume, both_teams, as_of)
    VALUES (@wallet_id, @addr, @games, @profit, @volume, @both_teams, @as_of)
    ON CONFLICT(wallet_id) DO UPDATE SET addr = excluded.addr, games = excluded.games, profit = excluded.profit,
      volume = excluded.volume, both_teams = excluded.both_teams, as_of = excluded.as_of`);
  const insQual = db.prepare('INSERT OR IGNORE INTO top_trader_qualified (as_of, wallet_id) VALUES (?, ?)');
  const clearQual = db.prepare('DELETE FROM top_trader_qualified WHERE as_of = ?');
  const writeChunk = db.transaction((rows, clearFor) => {
    if (clearFor) clearQual.run(clearFor);
    for (const r of rows) {
      if (r.type === 'wallet') upWallet.run(r);
      else insQual.run(r.as_of, r.wallet_id);
    }
  });

  let lineNo = 0, asOf = null, cleared = false, headerOk = false;
  const counts = { wallet_rows_written: 0, qualified_rows_written: 0, rejected: 0 };
  const samples = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    writeChunk(pending, cleared ? null : asOf);
    cleared = true;
    for (const r of pending) counts[r.type === 'wallet' ? 'wallet_rows_written' : 'qualified_rows_written']++;
    pending = [];
  };
  try {
    const rl = readline.createInterface({ input: req, crlfDelay: Infinity });
    for await (const raw of rl) {
      lineNo++;
      const line = raw.replace(/\r$/, '');
      if (lineNo === 1) {
        if (line.replace(/^﻿/, '') !== HEADER) {
          rl.close();
          return res.status(400).json({ error: 'header must be exactly: ' + HEADER, rows_written: 0 });
        }
        headerOk = true;
        continue;
      }
      if (!line.trim()) continue;
      const p = parseRow(line, asOf);
      if (p.reason) {
        counts.rejected++;
        if (samples.length < MAX_REJECT_SAMPLES) samples.push({ line: lineNo, reason: p.reason });
        continue;
      }
      if (!asOf) asOf = p.row.as_of;
      pending.push(p.row);
      if (pending.length >= CHUNK) flush();
    }
    flush();
  } catch (e) {
    return res.status(500).json(Object.assign({ error: 'upload failed: ' + (e && e.message ? e.message : e) }, counts));
  }
  if (!headerOk) return res.status(400).json({ error: 'empty upload' });
  res.json(Object.assign({ ok: counts.rejected === 0, as_of: asOf, lines: lineNo }, counts,
    { rejected_samples: samples, duration_ms: Date.now() - t0 }));
});

// For tests: release the cached handle.
router._resetDb = () => { _db = null; };

module.exports = router;
module.exports.HEADER = HEADER;
module.exports.parseRow = parseRow;
