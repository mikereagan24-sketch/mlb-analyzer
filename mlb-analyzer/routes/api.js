const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { q, db } = require('../db/schema');
const { runLineupJob, runScoreJob, getWobaIndex, getSettings, processGameSignals } = require('../services/jobs');
const { runModel, getSignals } = require('../services/model');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const FILE_KEY_TESTS = [
  { key: 'bat-proj-lhp', test: n => /bat/i.test(n) && /proj|steam/i.test(n) && /lhp|_lh/i.test(n) },
  { key: 'bat-proj-rhp', test: n => /bat/i.test(n) && /proj|steam/i.test(n) && /rhp|_rh/i.test(n) },
  { key: 'pit-proj-lhb', test: n => /pit/i.test(n) && /proj|steam/i.test(n) && /lhb|_lh/i.test(n) },
  { key: 'pit-proj-rhb', test: n => /pit/i.test(n) && /proj|steam/i.test(n) && /rhb|_rh/i.test(n) },
  { key: 'bat-act-lhp', test: n => /bat/i.test(n) && /act|actual/i.test(n) && /lhp|_lh/i.test(n) },
  { key: 'bat-act-rhp', test: n => /bat/i.test(n) && /act|actual/i.test(n) && /rhp|_rh/i.test(n) },
  { key: 'pit-act-lhb', test: n => /pit/i.test(n) && /act|actual/i.test(n) && /lhb|_lh/i.test(n) },
  { key: 'pit-act-rhb', test: n => /pit/i.test(n) && /act|actual/i.test(n) && /rhb|_rh/i.test(n) },
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

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

router.post('/upload/:key?', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const key = req.params.key || detectKey(file.originalname);
    if (!key) return res.status(400).json({ error: 'Cannot detect CSV type from filename: ' + file.originalname });
    const isPitcher = key.startsWith('pit');
    const rows = parseCSV(file.buffer, isPitcher);
    if (!rows.length) return res.status(400).json({ error: 'No valid rows parsed. Check wOBA and Name columns.' });
    q.clearWobaKey.run(key);
    q.upsertWobaBatch(key, rows);
    q.logUpload.run(key, file.originalname, rows.length);
    res.json({ success: true, key, filename: file.originalname, rows: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/woba-status', (req, res) => {
  const rows = q.wobaKeySummary.all();
  const status = {};
  rows.forEach(r => { status[r.data_key] = { rows: r.row_count, uploadedAt: r.uploaded_at }; });
  res.json(status);
});

router.get('/games/:date', (req, res) => {
  try {
    const { date } = req.params;
    const games = q.getGamesByDate.all(date);
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

router.post('/games/:date/rerun', (req, res) => {
  try {
    const { date } = req.params;
    const games = q.getGamesByDate.all(date);
    const settings = getSettings();
    const wobaIdx = getWobaIndex();
    let updated = 0;
    for (const g of games) { processGameSignals(g, wobaIdx, settings); updated++; }
    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ââ BULK GAME UPSERT (historical backfill) ââââââââââââââââââââââââââââââââ
router.post('/games/upsert', async (req, res) => {
  try {
    const g = req.body;
    const gameId = g.game_id || (g.away_team + '-' + g.home_team).toLowerCase();
  q.upsertGame.run({
      game_date: g.game_date, game_id: gameId,
      away_team: g.away_team, home_team: g.home_team,
      game_time: g.game_time || null,
      away_sp: g.away_sp, away_sp_hand: g.away_sp_hand,
      home_sp: g.home_sp, home_sp_hand: g.home_sp_hand,
      market_away_ml: g.market_away_ml, market_home_ml: g.market_home_ml,
      market_total: g.market_total, park_factor: g.park_factor || 1.0,
      model_away_ml: null, model_home_ml: null, model_total: null,
      lineup_source: 'manual',
    });
    db.prepare(`UPDATE game_log SET away_lineup_json=?, home_lineup_json=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(JSON.stringify(g.away_lineup || []), JSON.stringify(g.home_lineup || []), g.game_date, gameId);
    if (g.away_score != null && g.home_score != null) {
      q.updateScores.run({ game_date: g.game_date, game_id: gameId, away_score: g.away_score, home_score: g.home_score, scores_source: 'manual' });
    }
    const gameRow = q.getGameById.get(g.game_date, gameId);
    if (gameRow) processGameSignals(gameRow, getWobaIndex(), getSettings());
    res.json({ success: true, game_id: gameId });
  } catch (err) {
    console.error('Upsert error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/dates', (req, res) => {
  const rows = q.getDates.all();
  res.json(rows.map(r => r.game_date));
});

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

router.get('/cron-log', (req, res) => {
  const rows = q.getRecentCronLogs.all();
  res.json(rows);
});

router.get('/settings', (req, res) => {
  const rows = q.getAllSettings.all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json(s);
});

router.post('/settings', (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) q.setSetting.run(key, String(value));
  res.json({ success: true });
});

router.get('/export/csv', (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '2026-01-01';
  const toDate = to || '2099-12-31';
  const rows = q.getSignalsByDateRange.all(fromDate, toDate);
  const headers = ['date','game_id','signal_type','side','label','category','market_line','model_line','edge_pct','outcome','pnl'];
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => r[h] ?? '').join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=mlb_backtest_' + fromDate + '_' + toDate + '.csv');
  res.send(csv);
});

// ââ DELETE GAME âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.delete('/games/:date/:gameId', (req, res) => {
  try {
    const { date, gameId } = req.params;
    db.prepare('DELETE FROM bet_signals WHERE game_date=? AND game_id=?').run(date, gameId);
    db.prepare('DELETE FROM game_log WHERE game_date=? AND game_id=?').run(date, gameId);
    res.json({ success: true, deleted: gameId });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ââ WOBA LOOKUP FOR MATCHUP TAB âââââââââââââââââââââââââââââââââââââââââââââ
router.get('/woba/game/:date/:gameId', (req, res) => {
  try {
    const { date, gameId } = req.params;
    const game = q.getGameById.get(date, gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const wobaIdx = getWobaIndex();
    const settings = getSettings();
    const W_PROJ = settings.W_PROJ || 0.65;
    const W_ACT  = settings.W_ACT  || 0.35;
    const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
    const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };
    function normName(n) { return (n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
    function lookupBatter(name, hand, oppSpHand) {
      const vsKey=oppSpHand==='R'?'bat-proj-rhp':'bat-proj-lhp';
      const actKey=oppSpHand==='R'?'bat-act-rhp':'bat-act-lhp';
      const dflt=BAT_DFLT[hand]||BAT_DFLT['R'];
      const dfltV=oppSpHand==='R'?dflt.vsRHP:dflt.vsLHP;
      const key=normName(name);
      const parts=key.split(' ');
      const isAbbrev=parts.length>=2&&parts[0].length===1;
      function stripJr(n){return n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();}
      function findIn(idx,k){
        if(!idx)return null;
        if(idx[k])return idx[k].woba;
        if(isAbbrev){
          const initial=parts[0],last=parts[parts.length-1];
          const matches=Object.entries(idx).filter(([n])=>{
            const p=stripJr(n).split(' ');
            return p[p.length-1]===last&&p[0]&&p[0][0]===initial;
          });
          if(matches.length===1)return matches[0][1].woba;
          // Multiple matches for abbreviated name — prefer highest wOBA (likely the star player)
          if(matches.length>1)return matches.reduce((best,e)=>e[1].woba>best[1].woba?e:best)[1].woba;
          return null;
        }
        const sk=stripJr(k);
        const matches2=Object.entries(idx).filter(([n])=>stripJr(n)===sk);
        if(matches2.length===1)return matches2[0][1].woba;
        // Multiple exact name matches — pick highest wOBA (the known star)
        if(matches2.length>1)return matches2.reduce((best,e)=>e[1].woba>best[1].woba?e:best)[1].woba;
        return null;
      }
      const proj=findIn(wobaIdx[vsKey],key);
      const act=findIn(wobaIdx[actKey],key);
      if(proj&&act)return{woba:+(W_PROJ*proj+W_ACT*act).toFixed(3),source:'blend'};
      if(proj)return{woba:+proj.toFixed(3),source:'proj'};
      if(act)return{woba:+act.toFixed(3),source:'act'};
      return{woba:+dfltV.toFixed(3),source:'default'};
    }
    function lookupPitcher(name, hand) {
      const dflt=PIT_DFLT[hand]||PIT_DFLT['R'];
      const key=normName(name);
      function bs(projKey,actKey,dfltV){
        const proj=wobaIdx[projKey]&&wobaIdx[projKey][key]?wobaIdx[projKey][key].woba:null;
        const act=wobaIdx[actKey]&&wobaIdx[actKey][key]?wobaIdx[actKey][key].woba:null;
        if(proj&&act) return{woba:+(W_PROJ*proj+W_ACT*act).toFixed(3),source:'blend'};
        if(proj) return{woba:+proj.toFixed(3),source:'proj'};
        if(act) return{woba:+act.toFixed(3),source:'act'};
        return{woba:+dfltV.toFixed(3),source:'default'};
      }
      return{vsLHB:bs('pit-proj-lhb','pit-act-lhb',dflt.vsLHB),vsRHB:bs('pit-proj-rhb','pit-act-rhb',dflt.vsRHB)};
    }
    const awayLineup=tryParse(game.away_lineup_json)||[];
    const homeLineup=tryParse(game.home_lineup_json)||[];
    res.json({
      game_id:gameId,
      away_sp_woba:lookupPitcher(game.away_sp,game.away_sp_hand||'R'),
      home_sp_woba:lookupPitcher(game.home_sp,game.home_sp_hand||'R'),
      away_batters:awayLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.home_sp_hand||'R')})),
      home_batters:homeLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.away_sp_hand||'R')})),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;


