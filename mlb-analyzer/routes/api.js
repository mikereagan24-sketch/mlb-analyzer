/**
 * API routes
 * POST /api/upload/:key          — upload a FanGraphs CSV
 * GET  /api/woba-status          — which files are loaded + row counts
 * GET  /api/games/:date          — games + signals for a date
 * GET  /api/dates                — list of dates with game data
 * GET  /api/backtest             — P&L summary across date range
 * POST /api/jobs/lineups         — manually trigger lineup pull
 * POST /api/jobs/scores          — manually trigger score pull
 * GET  /api/cron-log             — recent job history
 * GET  /api/settings             — get model settings
 * POST /api/settings             — update model settings
 * GET  /api/export/csv           — export backtest as CSV
 */

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { q } = require('../db/schema');
const { runLineupJob, runScoreJob, getWobaIndex, getSettings } = require('../services/jobs');
const { runModel, getSignals } = require('../services/model');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── CSV KEY DETECTION ─────────────────────────────────────────────────────
const FILE_KEY_TESTS = [
  { key: 'bat-proj-lhp', test: n => /bat/i.test(n) && /proj|steam/i.test(n) && /lhp|_lh/i.test(n) },
  { key: 'bat-proj-rhp', test: n => /bat/i.test(n) && /proj|steam/i.test(n) && /rhp|_rh/i.test(n) },
  { key: 'pit-proj-lhb', test: n => /pit/i.test(n) && /proj|steam/i.test(n) && /lhb|_lh/i.test(n) },
  { key: 'pit-proj-rhb', test: n => /pit/i.test(n) && /proj|steam/i.test(n) && /rhb|_rh/i.test(n) },
  { key: 'bat-act-lhp',  test: n => /bat/i.test(n) && /act|actual/i.test(n) && /lhp|_lh/i.test(n) },
  { key: 'bat-act-rhp',  test: n => /bat/i.test(n) && /act|actual/i.test(n) && /rhp|_rh/i.test(n) },
  { key: 'pit-act-lhb',  test: n => /pit/i.test(n) && /act|actual/i.test(n) && /lhb|_lh/i.test(n) },
  { key: 'pit-act-rhb',  test: n => /pit/i.test(n) && /act|actual/i.test(n) && /rhb|_rh/i.test(n) },
];

function detectKey(filename) {
  const n = filename.toLowerCase();
  for (const { key, test } of FILE_KEY_TESTS) if (test(n)) return key;
  return null;
}

function parseCSV(buffer, isPitcher) {
  const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const delim = text.includes('\t') ? '\t' : ',';
  const records = parse(text, { columns: true, skip_empty_lines: true, delimiter: delim, trim: true });
  if (!records.length) return [];

  const headers = Object.keys(records[0]).map(h => h.toLowerCase());
  const wobaCol = Object.keys(records[0]).find(h => h.toLowerCase() === 'woba');
  const nameCol = Object.keys(records[0]).find(h => ['name', 'player', 'playername'].includes(h.toLowerCase()));
  const sampleCols = isPitcher ? ['tbf', 'bf', 'batters faced'] : ['pa', 'plate appearances'];
  const sampleCol = Object.keys(records[0]).find(h => sampleCols.includes(h.toLowerCase()));

  if (!wobaCol || !nameCol) return [];

  const rows = [];
  for (const r of records) {
    const name = r[nameCol];
    const woba = parseFloat(r[wobaCol]);
    const sample = sampleCol ? parseFloat(r[sampleCol]) || 0 : 0;
    if (!name || isNaN(woba) || woba < 0.05 || woba > 0.8) continue;
    rows.push({ name, woba, sample });
  }
  return rows;
}

// ── UPLOAD CSV ────────────────────────────────────────────────────────────
router.post('/upload/:key?', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const key = req.params.key || detectKey(file.originalname);
    if (!key) return res.status(400).json({ error: `Cannot detect CSV type from filename: ${file.originalname}. Pass key as URL param.` });

    const isPitcher = key.startsWith('pit');
    const rows = parseCSV(file.buffer, isPitcher);
    if (!rows.length) return res.status(400).json({ error: 'No valid rows parsed. Check wOBA and Name columns.' });

    // Store in DB — replaces existing data for this key
    q.clearWobaKey.run(key);
    q.upsertWobaBatch(key, rows);
    q.logUpload.run(key, file.originalname, rows.length);

    res.json({ success: true, key, filename: file.originalname, rows: rows.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── WOBA STATUS ───────────────────────────────────────────────────────────
router.get('/woba-status', (req, res) => {
  const rows = q.wobaKeySummary.all();
  const status = {};
  rows.forEach(r => { status[r.data_key] = { rows: r.row_count, uploadedAt: r.uploaded_at }; });
  res.json(status);
});

// ── GAMES FOR DATE ────────────────────────────────────────────────────────
router.get('/games/:date', (req, res) => {
  try {
    const { date } = req.params;
    const games = q.getGamesByDate.all(date);

    // Attach signals to each game
    const signals = q.getSignalsByDate.all(date);
    const signalsByGame = {};
    signals.forEach(s => {
      if (!signalsByGame[s.game_id]) signalsByGame[s.game_id] = [];
      signalsByGame[s.game_id].push(s);
    });

    const result = games.map(g => ({
      ...g,
      away_lineup: tryParse(g.away_lineup_json) || [],
      home_lineup: tryParse(g.home_lineup_json) || [],
      signals: signalsByGame[g.game_id] || [],
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RE-RUN MODEL FOR A DATE ───────────────────────────────────────────────
router.post('/games/:date/rerun', (req, res) => {
  try {
    const { date } = req.params;
    const games = q.getGamesByDate.all(date);
    const settings = getSettings();
    const wobaIdx = getWobaIndex();
    const { processGameSignals } = require('../services/jobs');

    let updated = 0;
    for (const g of games) {
      processGameSignals(g, wobaIdx, settings);
      updated++;
    }
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DATES WITH DATA ───────────────────────────────────────────────────────
router.get('/dates', (req, res) => {
  const rows = q.getDates.all();
  res.json(rows.map(r => r.game_date));
});

// ── BACKTEST SUMMARY ──────────────────────────────────────────────────────
router.get('/backtest', (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || '2026-01-01';
    const toDate = to || '2099-12-31';

    const byCategory = q.getSummaryByCategory.all(fromDate, toDate);
    const overall = q.getOverallSummary.get(fromDate, toDate);
    const signals = q.getSignalsByDateRange.all(fromDate, toDate);

    res.json({ overall, byCategory, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL JOB TRIGGERS ───────────────────────────────────────────────────
router.post('/jobs/lineups', async (req, res) => {
  const { date } = req.body;
  const result = await runLineupJob(date || null);
  res.json(result);
});

router.post('/jobs/scores', async (req, res) => {
  const { date } = req.body;
  const result = await runScoreJob(date || null);
  res.json(result);
});

// ── CRON LOG ─────────────────────────────────────────────────────────────
router.get('/cron-log', (req, res) => {
  const rows = q.getRecentCronLogs.all();
  res.json(rows);
});

// ── SETTINGS ─────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const rows = q.getAllSettings.all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json(s);
});

router.post('/settings', (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    q.setSetting.run(key, String(value));
  }
  res.json({ success: true });
});

// ── EXPORT CSV ────────────────────────────────────────────────────────────
router.get('/export/csv', (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2026-01-01';
  const toDate = to || '2099-12-31';

  const rows = q.getSignalsByDateRange.all(fromDate, toDate);
  const headers = ['date','game_id','signal_type','side','label','category','market_line','model_line','edge_pct','outcome','pnl'];
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => r[h] ?? '').join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=mlb_backtest_${fromDate}_${toDate}.csv`);
  res.send(csv);
});

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

module.exports = router;
