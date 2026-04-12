const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { q, db } = require('../db/schema');
const { runLineupJob, runScoreJob, runOddsJob, getWobaIndex, getSettings, processGameSignals } = require('../services/jobs');
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
  const teamCol = Object.keys(records[0]).find(h => h.toLowerCase() === 'team');
  if (!wobaCol || !nameCol) return [];
  const rows = [];
  for (const r of records) {
    const name = r[nameCol];
    const woba = parseFloat(r[wobaCol]);
    const sample = sampleCol ? parseFloat(r[sampleCol]) || 0 : 0;
    // For batter CSVs: reject wOBA < 0.250 (filters pitchers accidentally in batter files)
    // For pitcher CSVs: allow as low as 0.05 (elite starters can allow very low wOBA)
    const minWoba = isPitcher ? 0.05 : 0.250;
    if (!name || isNaN(woba) || woba < minWoba || woba > 0.8) continue;
    // Normalize FanGraphs team abbr (KCR->KC, SDP->SD, etc.)
    const fgTeam = teamCol ? (r[teamCol]||'').trim().toUpperCase() : null;
    const FG_MAP={'KCR':'KC','SDP':'SD','SFG':'SF','TBR':'TB','WSN':'WAS','CHW':'CWS'};
    const team = fgTeam ? (FG_MAP[fgTeam]||fgTeam) : null;
    rows.push({ name, woba, sample, team });
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
    // Store each player twice: by name alone AND by "name|TEAM" for disambiguation
    const expandedRows = [];
    for (const r of rows) {
      expandedRows.push(r); // plain name
      if (r.team) {
        expandedRows.push({...r, name: r.name+' '+r.team}); // "Bobby Witt Jr. KC" -> "bobby witt jr kc"
        // Also store Jr/Sr-stripped + team so "bobby witt kc" matches "Bobby Witt" in lineup
        const stripped = r.name.replace(/\b(Jr\.|Sr\.|II|III|IV)\b/gi,'').replace(/\s+/g,' ').trim();
        if (stripped !== r.name) expandedRows.push({...r, name: stripped+' '+r.team});
      }
    }
    q.upsertWobaBatch(key, expandedRows);
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
    db.prepare(`UPDATE game_log SET away_lineup_json=?, home_lineup_json=? WHERE game_date=? AND game_id=?`)
      .run(JSON.stringify(g.away_lineup || []), JSON.stringify(g.home_lineup || []), g.game_date, gameId);
    if (g.away_score != null && g.home_score != null) {
      q.updateScores.run({ game_date: g.game_date, game_id: gameId, away_score: g.away_score, home_score: g.home_score, scores_source: 'manual' });
    }
    // Update over/under prices if provided
    if (g.over_price != null || g.under_price != null) {
      db.prepare("UPDATE game_log SET over_price=?, under_price=? WHERE game_date=? AND game_id=?")
        .run(g.over_price||null, g.under_price||null, g.game_date, gameId);
    }
    // If caller explicitly passes odds_locked_at: null, clear the lock
    if ('odds_locked_at' in g && g.odds_locked_at === null) {
      db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=? AND game_id=?").run(g.game_date, gameId);
    }
    // Update over/under prices if provided
    if (g.over_price != null || g.under_price != null) {
      db.prepare("UPDATE game_log SET over_price=?, under_price=? WHERE game_date=? AND game_id=?")
        .run(g.over_price||null, g.under_price||null, g.game_date, gameId);
    }
    // Clear odds lock if explicitly passed as null
    if ('odds_locked_at' in g && g.odds_locked_at === null) {
      db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=? AND game_id=?").run(g.game_date, gameId);
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
    // Auto-backfill closing_line from market_line for resolved signals that have none
    db.prepare(`UPDATE bet_signals SET
      closing_line = market_line,
      clv = CASE
        WHEN bet_line IS NOT NULL AND market_line IS NOT NULL THEN
          CASE WHEN market_line < 0
               THEN market_line - bet_line
               ELSE bet_line - market_line END
        ELSE NULL END
      WHERE closing_line IS NULL
        AND outcome != 'pending'
        AND market_line IS NOT NULL`).run();
    const byCategory = q.getSummaryByCategory.all(fromDate, toDate);
    const overall = q.getOverallSummary.get(fromDate, toDate);
    const signals = db.prepare(`
      SELECT bs.*,
        COALESCE(bs.market_line,
          CASE WHEN bs.signal_side='away' THEN gl.market_away_ml
               WHEN bs.signal_side='home' THEN gl.market_home_ml
               ELSE NULL END
        ) as market_line,
        gl.market_total, gl.away_score, gl.home_score
      FROM bet_signals bs
      LEFT JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
      WHERE bs.game_date BETWEEN ? AND ?
      ORDER BY bs.game_date, bs.id
    `).all(fromDate, toDate);
    res.json({ overall, byCategory, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual weather pull for a date
router.post('/jobs/weather', async (req, res) => {
  try {
    const { fetchParkWind } = require('../services/weather');
    const { processGameSignals, getWobaIndex, getSettings } = require('../services/jobs');
    const dateStr = req.body.date || new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
    const games = db.prepare('SELECT * FROM game_log WHERE game_date=?').all(dateStr);
    let updated = 0;
    for (const g of games) {
      const wind = await fetchParkWind(g.home_team, dateStr, g.game_time);
      if (wind) {
        q.updateWindData.run(wind.windSpeed, wind.windDir, wind.factor, dateStr, g.game_id);
        // Rerun model with new wind data
        const wobaIdx = getWobaIndex();
        const settings = getSettings();
        const latestRow = q.getGameById.get(dateStr, g.game_id);
        if (latestRow) processGameSignals(latestRow, wobaIdx, settings);
        updated++;
      }
    }
    res.json({success:true, updated, date:dateStr});
  } catch(e) { res.status(500).json({error:e.message}); }
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

router.post('/jobs/odds', async (req, res) => {
  const { date } = req.body;
  const result = await runOddsJob(date || null);
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
      const num = (v,d) => { const n=Number(v); return isNaN(n)?d:n; };
      const SP_WT  = num(settings.SP_WEIGHT,   0.77);
      const REL_WT     = num(settings.RELIEF_WEIGHT,     0.23);
      const SP_PIT_WT  = num(settings.SP_PIT_WEIGHT,     0.80);
      const REL_PIT_WT = num(settings.RELIEF_PIT_WEIGHT, 0.20);
    const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
    const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };
    function normName(n) { return (n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
    function lookupBatter(name, hand, oppSpHand, teamHint) {
        const vsKey  = oppSpHand==='R' ? 'bat-proj-rhp' : 'bat-proj-lhp';
        const actKey = oppSpHand==='R' ? 'bat-act-rhp'  : 'bat-act-lhp';
        const oppKey    = oppSpHand==='R' ? 'bat-proj-lhp' : 'bat-proj-rhp';
        const oppActKey = oppSpHand==='R' ? 'bat-act-lhp'  : 'bat-act-rhp';
        const dflt = BAT_DFLT[hand]||BAT_DFLT['R'];
        const dfltV    = oppSpHand==='R' ? dflt.vsRHP : dflt.vsLHP;
        const dfltVOpp = oppSpHand==='R' ? dflt.vsLHP : dflt.vsRHP;
        const key=normName(name);
        const parts=key.split(' ');
        const isAbbrev=parts.length>=2&&parts[0].length===1;
        function stripJr(n){return n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();}
        function findIn(idx,k,tHint){
          if(!idx)return null;
          const tl=tHint?tHint.toLowerCase():null;
          // 1. Exact team key: "bobby witt kc"
          if(tl&&idx[k+' '+tl])return idx[k+' '+tl].woba;
          // 2. Exact name
          if(idx[k])return idx[k].woba;
          // 3. Search index entries where stripJr(indexKey w/o team) === k, same team
          // Catches "bobby witt jr kc" when looking up "bobby witt" + "kc"
          if(tl){
            const jrEntry=Object.entries(idx).find(([n])=>{
              if(!n.endsWith(' '+tl))return false;
              const base=n.slice(0,n.length-tl.length-1).trim();
              return stripJr(base)===k;
            });
            if(jrEntry)return jrEntry[1].woba;
          }
          // 4. Abbreviated name (M. Busch style)
          if(isAbbrev){
            const initial=parts[0],last=parts[parts.length-1];
            if(tl){const e=Object.entries(idx).find(([n])=>{if(!n.endsWith(' '+tl))return false;const base=n.slice(0,n.length-tl.length-1).trim();const p=stripJr(base).split(' ');return p[p.length-1]===last&&p[0]&&p[0][0]===initial;});if(e)return e[1].woba;}
            const matches=Object.entries(idx).filter(([n])=>{if(/\s[a-z]{2,3}$/.test(n))return false;const p=stripJr(n).split(' ');return p[p.length-1]===last&&p[0]&&p[0][0]===initial;});
            if(matches.length===1)return matches[0][1].woba;
          }
          // 5. Jr-stripped exact key
          const sk=stripJr(k);
          if(tl&&idx[sk+' '+tl])return idx[sk+' '+tl].woba;
          const e2=Object.entries(idx).find(([n])=>!/\s[a-z]{2,3}$/.test(n)&&stripJr(n)===sk);
          return e2?e2[1].woba:null;
        }
        // Look up vs SP hand
        const projV    = findIn(wobaIdx[vsKey],  key, teamHint);
        const actV     = findIn(wobaIdx[actKey], key, teamHint);
        const wobaVsSP = (projV&&actV) ? +(W_PROJ*projV+W_ACT*actV).toFixed(3)
                       : projV ? +projV.toFixed(3) : actV ? +actV.toFixed(3) : +dfltV.toFixed(3);
        const srcVsSP  = (projV&&actV)?'blend':projV?'proj':actV?'act':'default';
        // Look up vs opposite hand (for bullpen blend)
        const projO    = findIn(wobaIdx[oppKey],    key, teamHint);
        const actO     = findIn(wobaIdx[oppActKey], key, teamHint);
        const wobaVsOpp = (projO&&actO) ? +(W_PROJ*projO+W_ACT*actO).toFixed(3)
                        : projO ? +projO.toFixed(3) : actO ? +actO.toFixed(3) : +dfltVOpp.toFixed(3);
        // Blended wOBA: SP_WT% vs SP hand + REL_WT% vs opposite
        const blended = +(wobaVsSP*SP_WT + wobaVsOpp*REL_WT).toFixed(3);
        return {woba:blended, wobaVsSP, wobaVsOpp, source:srcVsSP};
      }
    function lookupPitcher(name, hand) {
      // Use model.js getPitcherWoba which has full fuzzyLookup including compound surname fallback
      const { getPitcherWoba } = require('../services/model');
      const result = getPitcherWoba(wobaIdx, name, hand||'R', null, W_PROJ, W_ACT);
      return {
        vsLHB: { woba: result.vsLHB, rawWoba: result.vsLHB, source: result.source },
        vsRHB: { woba: result.vsRHB, rawWoba: result.vsRHB, source: result.source },
      };
    }
    const awayLineup=tryParse(game.away_lineup_json)||[];
    const homeLineup=tryParse(game.home_lineup_json)||[];
    res.json({
      game_id:gameId,
      away_sp_woba:lookupPitcher(game.away_sp,game.away_sp_hand||'R'),
      home_sp_woba:lookupPitcher(game.home_sp,game.home_sp_hand||'R'),
      away_batters:awayLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.home_sp_hand||'R',game.away_team)})),
      home_batters:homeLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.away_sp_hand||'R',game.home_team)})),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── PATCH GAME LINEUP / SP ────────────────────────────────────────────
router.patch('/games/:date/:gameId/lineup', (req, res) => {
  try {
    const { date, gameId } = req.params;
    const { away_sp, away_sp_hand, home_sp, home_sp_hand, away_lineup, home_lineup } = req.body;
    const sets = [], vals = [];
    if (away_sp      !== undefined) { sets.push('away_sp=?');       vals.push(away_sp); }
    if (away_sp_hand !== undefined) { sets.push('away_sp_hand=?');  vals.push(away_sp_hand); }
    if (home_sp      !== undefined) { sets.push('home_sp=?');       vals.push(home_sp); }
    if (home_sp_hand !== undefined) { sets.push('home_sp_hand=?');  vals.push(home_sp_hand); }
    if (away_lineup  !== undefined) { sets.push('away_lineup_json=?'); vals.push(JSON.stringify(away_lineup)); }
    if (home_lineup  !== undefined) { sets.push('home_lineup_json=?'); vals.push(JSON.stringify(home_lineup)); }
    if (!sets.length) return res.status(400).json({error:'No fields to update'});
    vals.push(date, gameId);
    db.prepare('UPDATE game_log SET '+sets.join(',')+' WHERE game_date=? AND game_id=?').run(...vals);
    const gameRow = q.getGameById.get(date, gameId);
    if (gameRow) processGameSignals(gameRow, getWobaIndex(), getSettings());
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── PATCH GAME ODDS (safe update — only touches columns provided) ─────
router.patch('/games/:date/:gameId/odds', (req, res) => {
  try {
    const { date, gameId } = req.params;
    const g = req.body;
    const sets = [];
    const vals = [];
    if (g.market_away_ml !== undefined) { sets.push('market_away_ml=?'); vals.push(g.market_away_ml); }
    if (g.market_home_ml !== undefined) { sets.push('market_home_ml=?'); vals.push(g.market_home_ml); }
    if (g.market_total    !== undefined) { sets.push('market_total=?');    vals.push(g.market_total); }
    if (g.over_price      !== undefined) { sets.push('over_price=?');      vals.push(g.over_price); }
    if (g.under_price     !== undefined) { sets.push('under_price=?');     vals.push(g.under_price); }
    if (g.away_score      !== undefined) { sets.push('away_score=?');      vals.push(g.away_score); }
    if (g.home_score      !== undefined) { sets.push('home_score=?');      vals.push(g.home_score); }
    if (g.wind_speed      !== undefined) { sets.push('wind_speed=?');      vals.push(g.wind_speed); }
    if (g.wind_dir        !== undefined) { sets.push('wind_dir=?');        vals.push(g.wind_dir); }
    if (g.wind_factor     !== undefined) { sets.push('wind_factor=?');     vals.push(g.wind_factor); }
    if (g.temp_f          !== undefined) { sets.push('temp_f=?');          vals.push(g.temp_f); }
    if (g.temp_run_adj    !== undefined) { sets.push('temp_run_adj=?');    vals.push(g.temp_run_adj); }
    if (g.roof_status     !== undefined) { sets.push('roof_status=?');     vals.push(g.roof_status); }
    if (g.roof_confidence !== undefined) { sets.push('roof_confidence=?'); vals.push(g.roof_confidence); }
    if (!sets.length) return res.status(400).json({error:'No fields to update'});
    vals.push(date, gameId);
    db.prepare('UPDATE game_log SET '+sets.join(',')+' WHERE game_date=? AND game_id=?').run(...vals);
    // Rerun signals for this game
    const gameRow = q.getGameById.get(date, gameId);
    if (gameRow) processGameSignals(gameRow, getWobaIndex(), getSettings());
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── BACKTEST RESET ────────────────────────────────────────────────────
// Unlock all odds for a date

// Update wind data for a game and rerun model
router.patch('/games/:date/:gameId/wind', (req, res) => {
  try {
    const { wind_speed, wind_dir, wind_factor } = req.body;
    const { date, gameId } = req.params;
    db.prepare('UPDATE game_log SET wind_speed=?, wind_dir=?, wind_factor=? WHERE game_date=? AND game_id=?')
      .run(wind_speed, wind_dir, wind_factor, date, gameId);
    // Rerun model with new wind factor
    const { processGameSignals, getWobaIndex, getSettings } = require('../services/jobs');
    const wobaIdx = getWobaIndex();
    const settings = getSettings();
    processGameSignals(date, gameId, wobaIdx, settings);
    res.json({success:true, wind_factor});
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post('/games/:date/unlock', (req, res) => {
  try {
    const r = db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=?").run(req.params.date);
    res.json({success:true, unlocked:r.changes});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/backtest/reset-date', (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({error:'date required'});
    const r = db.prepare("DELETE FROM bet_signals WHERE game_date=?").run(date);
    res.json({success:true, deleted:r.changes, date});
  } catch(err) { res.status(500).json({error:err.message}); }
});

router.delete('/backtest/reset', (req, res) => {
  try {
    const { from, to } = req.query;
    if (from && to) {
      db.prepare('DELETE FROM bet_signals WHERE game_date BETWEEN ? AND ?').run(from, to);
    } else {
      db.prepare('DELETE FROM bet_signals').run();
    }
    // Also reset model lines so rerun regenerates fresh signals
    if (from && to) {
      db.prepare("UPDATE game_log SET model_away_ml=NULL,model_home_ml=NULL,model_total=NULL WHERE game_date BETWEEN ? AND ?").run(from, to);
    } else {
      db.prepare("UPDATE game_log SET model_away_ml=NULL,model_home_ml=NULL,model_total=NULL").run();
    }
    res.json({ success: true, message: 'All backtest signals wiped' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/debug/woba-keys', (req, res) => {
  const q2 = req.query.q || '';
  const idx = getWobaIndex();
  const keys = {};
  for (const [dataKey, players] of Object.entries(idx)) {
    keys[dataKey] = Object.keys(players).filter(k => !q2 || k.includes(q2.toLowerCase())).slice(0,20);
  }
  res.json(keys);
});

// ── BET LINE TRACKING ─────────────────────────────────────────────────
// Lock your actual bet line for a signal
router.post('/signals/recalc', (req, res) => {
  try {
    // Recalculate pnl for all resolved signals using to-win-$100 logic
    // Use bet_line if available, else market_line
    const sigs = db.prepare(`SELECT * FROM bet_signals WHERE outcome IN ('win','loss')`).all();
    let updated = 0;
    const upd = db.prepare(`UPDATE bet_signals SET pnl=? WHERE id=?`);
    for (const sig of sigs) {
      const ml = parseFloat(sig.bet_line || sig.market_line);
      if (isNaN(ml) || ml === 0) continue;
      let pnl;
      if (sig.signal_type === 'ML') {
        // To win $100: +odds stake=10000/odds, -odds stake=abs(odds)
        const stake = ml > 0 ? parseFloat((10000/ml).toFixed(2)) : Math.abs(ml);
        pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
      } else {
        // Total: use bet_line as the vig price (e.g. -110), else -110
        const price = parseFloat(sig.bet_line) || -110;
        const stake = price > 0 ? parseFloat((10000/price).toFixed(2)) : Math.abs(price);
        pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
      }
      upd.run(parseFloat(pnl.toFixed(2)), sig.id);
      updated++;
    }
    res.json({success:true, updated});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/signals/manual', (req, res) => {
  try {
    // If recalc:true, recalculate all resolved signal P&L with to-win-100 math
    if (req.body.recalc) {
      const sigs = db.prepare("SELECT * FROM bet_signals WHERE outcome IN ('win','loss')").all();
      let updated = 0;
      const upd = db.prepare("UPDATE bet_signals SET pnl=? WHERE id=?");
      for (const sig of sigs) {
        const ml = parseFloat(sig.bet_line || sig.market_line);
        if (isNaN(ml) || ml === 0) continue;
        let pnl;
        if (sig.signal_type === 'ML') {
          const ml2 = parseFloat(sig.bet_line || sig.market_line);
          if (!isNaN(ml2) && ml2 !== 0) {
            const stake = ml2 > 0 ? parseFloat((10000/ml2).toFixed(2)) : Math.abs(ml2);
            pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
          }
        } else {
          // Total: bet_line is the line number not the price — use closing_line as price or -110
          const price = parseFloat(sig.closing_line) || -110;
          const stake = price < 0 ? Math.abs(price) : parseFloat((10000/price).toFixed(2));
          pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
        }
        upd.run(parseFloat(pnl.toFixed(2)), sig.id);
        updated++;
      }
      return res.json({success:true, recalculated:updated});
    }
    const { game_date, game_id, signal_type, signal_side, signal_label, market_line, bet_line, bet_price } = req.body;
    if (!game_date||!game_id||!signal_type||!signal_side||!signal_label||market_line==null)
      return res.status(400).json({error:'Missing required fields'});
    const gl = q.getGameById.get(game_date, game_id);
    if (!gl) return res.status(404).json({error:'Game not found: '+game_date+'/'+game_id});
    // category e.g. "2star-dog", "1star-over"
    const stars = {'1★':'1star','2★':'2star','3★':'3star','unrated':'0star'}[signal_label]||'0star';
    const sideKey = signal_type==='ML' ? (Number(market_line)>0?'dog':'fav') : signal_side;
    const category = stars+'-'+sideKey;
    // model line from current DB
    const model_line = signal_type==='ML'
      ? (signal_side==='away' ? gl.model_away_ml : gl.model_home_ml)
      : gl.model_total;
    // edge
    function iP(ml){ml=Number(ml);return ml<0?Math.abs(ml)/(Math.abs(ml)+100):100/(ml+100);}
    const edge_pct = model_line ? Math.round(Math.abs(iP(Number(market_line))-iP(Number(model_line)))*100) : null;
    // outcome if already scored
    const { calcPnl } = require('../services/model');
    let outcome='pending', pnl=0;
    if (gl.away_score!=null){
      const r=calcPnl({type:signal_type,side:signal_side,marketLine:Number(market_line)},gl.away_score,gl.home_score,gl.market_total);
      outcome=r.outcome; pnl=r.pnl;
    }
    const info = db.prepare(`INSERT INTO bet_signals
      (game_log_id,game_date,game_id,signal_type,signal_side,signal_label,category,
       market_line,model_line,edge_pct,outcome,pnl,bet_line,bet_locked_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
      .run(gl.id,game_date,game_id,signal_type,signal_side,signal_label,category,
           Number(market_line),model_line,edge_pct,outcome,pnl,
           bet_line!=null?Number(bet_line):null);
    res.json({success:true,id:info.lastInsertRowid,outcome,pnl,category});
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/signals/:id/bet-line', (req, res) => {
  try {
    const { id } = req.params;
    const { bet_line } = req.body;
    if (bet_line == null) return res.status(400).json({error:'bet_line required'});
    // Recalculate CLV if closing_line already exists
    const sig = db.prepare('SELECT * FROM bet_signals WHERE id=?').get(id);
    if (!sig) return res.status(404).json({error:'Signal not found'});
    let clv = null;
    if (sig.closing_line != null) {
      // CLV = how much better your line is vs closing
      // For ML: positive = you got a better price than closing
      const isFav = bet_line < 0;
      if (isFav) {
        // Less negative = better for favorite bettors
        clv = sig.closing_line - bet_line; // e.g. closed at -150, you got -130 → clv = +20
      } else {
        // More positive = better for underdog bettors
        clv = bet_line - sig.closing_line; // e.g. closed at +120, you got +135 → clv = +15
      }
    }
    db.prepare("UPDATE bet_signals SET bet_line=?, bet_locked_at=datetime('now'), clv=? WHERE id=?")
      .run(bet_line, clv, id);
    res.json({success:true, id, bet_line, clv});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Set closing line for a signal (called when odds lock fires)
router.post('/signals/:id/closing-line', (req, res) => {
  try {
    const { id } = req.params;
    const { closing_line } = req.body;
    if (closing_line == null) return res.status(400).json({error:'closing_line required'});
    const sig = db.prepare('SELECT * FROM bet_signals WHERE id=?').get(id);
    if (!sig) return res.status(404).json({error:'Signal not found'});
    // Recalculate CLV if bet_line exists
    let clv = null;
    if (sig.bet_line != null) {
      const isFav = sig.bet_line < 0;
      clv = isFav ? (closing_line - sig.bet_line) : (sig.bet_line - closing_line);
    }
    db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?")
      .run(closing_line, clv, id);
    res.json({success:true, id, closing_line, clv});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Bulk-set closing lines when odds lock fires (called from jobs.js)
router.post('/signals/closing-lines', (req, res) => {
  try {
    const { game_date, game_id, closing_line } = req.body;
    const sigs = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND closing_line IS NULL AND signal_type='ML'").all(game_date, game_id);
    let updated = 0;
    for (const sig of sigs) {
      let clv = null;
      if (sig.bet_line != null) {
        const isFav = sig.bet_line < 0;
        clv = isFav ? (closing_line - sig.bet_line) : (sig.bet_line - closing_line);
      }
      db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closing_line, clv, sig.id);
      updated++;
    }
    res.json({success:true, updated});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── LOOKUP DEBUG ───────────────────────────────────────────────────
router.get('/debug/lookup', (req, res) => {
  try {
    const name = req.query.name || 'S. Woods Richardson';
    const team = req.query.team || 'MIN';
    const { normName, getPitcherWoba } = require('../services/model');
    const wobaIdx = getWobaIndex();
    // Check what's in the index for this name
    const k = normName(name);
    const kTeam = k + ' ' + team.toLowerCase();
    const pitLhb = wobaIdx['pit-proj-lhb'] || {};
    const directHit = pitLhb[k];
    const teamHit = pitLhb[kTeam];
    // Run actual getPitcherWoba
    const { runModel } = require('../services/model');
    const result = getPitcherWoba(wobaIdx, name, 'R', team, 0.7, 0.3);
    // Also run full model for min-tor
    const gameRow = q.getGameById.get('2026-04-10', 'min-tor');
    let modelResult = null;
    if (gameRow) {
      const settings = getSettings();
      const gameObj = {...gameRow,
        awayLineup: gameRow.away_lineup_json ? JSON.parse(gameRow.away_lineup_json) : [],
        homeLineup: gameRow.home_lineup_json ? JSON.parse(gameRow.home_lineup_json) : [],
      };
      try { modelResult = runModel(gameObj, wobaIdx, settings); } catch(e) { modelResult = {error:e.message}; }
    }
    // Count keys in index
    const allKeys = Object.keys(pitLhb).filter(k2=>k2.includes(k.split(' ').pop()));
    res.json({name, k, kTeam, directHit:!!directHit, teamHit:!!teamHit,
      matchingKeys:allKeys.slice(0,10), result, modelResult});
  } catch(err) { res.status(500).json({error:err.message, stack:err.stack?.split('\n').slice(0,5)}); }
});

// ── SCORE DEBUG ENDPOINT ──────────────────────────────────────────────
router.get('/debug/scores', async (req, res) => {
  try {
    const date = req.query.date || '2026-04-08';
    const [year,month,day] = date.split('-');
    const fetch2 = require('node-fetch');
    const url = 'https://www.baseball-reference.com/boxes/index.fcgi?month='+parseInt(month)+'&day='+parseInt(day)+'&year='+year;
    const resp = await fetch2(url, {headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36','Accept':'text/html'}});
    const html = await resp.text();
    const status = resp.status;
    // Check if Final appears in text
    const hasFinal = html.includes('Final');
    const finalCount = (html.match(/Final/g)||[]).length;
    // Try to find team names
    const hasPadres = html.includes('San Diego Padres');
    // Get a 500 char snippet around first Final
    const finalIdx = html.indexOf('Final');
    const snippet = finalIdx > 0 ? html.substring(finalIdx-100, finalIdx+200) : 'Final not found';
    res.json({date, status, hasFinal, finalCount, hasPadres, textLength:html.length, snippet});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── KALSHI TEST ENDPOINT (sandbox/debug) ─────────────────────────

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
    // Store each player twice: by name alone AND by "name|TEAM" for disambiguation
    const expandedRows = [];
    for (const r of rows) {
      expandedRows.push(r); // plain name
      if (r.team) {
        expandedRows.push({...r, name: r.name+' '+r.team}); // "Bobby Witt Jr. KC" -> "bobby witt jr kc"
        // Also store Jr/Sr-stripped + team so "bobby witt kc" matches "Bobby Witt" in lineup
        const stripped = r.name.replace(/\b(Jr\.|Sr\.|II|III|IV)\b/gi,'').replace(/\s+/g,' ').trim();
        if (stripped !== r.name) expandedRows.push({...r, name: stripped+' '+r.team});
      }
    }
    q.upsertWobaBatch(key, expandedRows);
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
    db.prepare(`UPDATE game_log SET away_lineup_json=?, home_lineup_json=? WHERE game_date=? AND game_id=?`)
      .run(JSON.stringify(g.away_lineup || []), JSON.stringify(g.home_lineup || []), g.game_date, gameId);
    if (g.away_score != null && g.home_score != null) {
      q.updateScores.run({ game_date: g.game_date, game_id: gameId, away_score: g.away_score, home_score: g.home_score, scores_source: 'manual' });
    }
    // Update over/under prices if provided
    if (g.over_price != null || g.under_price != null) {
      db.prepare("UPDATE game_log SET over_price=?, under_price=? WHERE game_date=? AND game_id=?")
        .run(g.over_price||null, g.under_price||null, g.game_date, gameId);
    }
    // If caller explicitly passes odds_locked_at: null, clear the lock
    if ('odds_locked_at' in g && g.odds_locked_at === null) {
      db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=? AND game_id=?").run(g.game_date, gameId);
    }
    // Update over/under prices if provided
    if (g.over_price != null || g.under_price != null) {
      db.prepare("UPDATE game_log SET over_price=?, under_price=? WHERE game_date=? AND game_id=?")
        .run(g.over_price||null, g.under_price||null, g.game_date, gameId);
    }
    // Clear odds lock if explicitly passed as null
    if ('odds_locked_at' in g && g.odds_locked_at === null) {
      db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=? AND game_id=?").run(g.game_date, gameId);
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
    const signals = db.prepare(`
      SELECT bs.*,
        COALESCE(bs.market_line,
          CASE WHEN bs.signal_side='away' THEN gl.market_away_ml
               WHEN bs.signal_side='home' THEN gl.market_home_ml
               ELSE NULL END
        ) as market_line,
        gl.market_total, gl.away_score, gl.home_score
      FROM bet_signals bs
      LEFT JOIN game_log gl ON gl.game_date=bs.game_date AND gl.game_id=bs.game_id
      WHERE bs.game_date BETWEEN ? AND ?
      ORDER BY bs.game_date, bs.id
    `).all(fromDate, toDate);
    res.json({ overall, byCategory, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual weather pull for a date
router.post('/jobs/weather', async (req, res) => {
  try {
    const { fetchParkWind } = require('../services/weather');
    const { processGameSignals, getWobaIndex, getSettings } = require('../services/jobs');
    const dateStr = req.body.date || new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
    const games = db.prepare('SELECT * FROM game_log WHERE game_date=?').all(dateStr);
    let updated = 0;
    for (const g of games) {
      const wind = await fetchParkWind(g.home_team, dateStr, g.game_time);
      if (wind) {
        q.updateWindData.run(wind.windSpeed, wind.windDir, wind.factor, dateStr, g.game_id);
        // Rerun model with new wind data
        const wobaIdx = getWobaIndex();
        const settings = getSettings();
        const latestRow = q.getGameById.get(dateStr, g.game_id);
        if (latestRow) processGameSignals(latestRow, wobaIdx, settings);
        updated++;
      }
    }
    res.json({success:true, updated, date:dateStr});
  } catch(e) { res.status(500).json({error:e.message}); }
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

router.post('/jobs/odds', async (req, res) => {
  const { date } = req.body;
  const result = await runOddsJob(date || null);
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
      const num = (v,d) => { const n=Number(v); return isNaN(n)?d:n; };
      const SP_WT  = num(settings.SP_WEIGHT,   0.77);
      const REL_WT     = num(settings.RELIEF_WEIGHT,     0.23);
      const SP_PIT_WT  = num(settings.SP_PIT_WEIGHT,     0.80);
      const REL_PIT_WT = num(settings.RELIEF_PIT_WEIGHT, 0.20);
    const BAT_DFLT = { R:{vsRHP:0.305,vsLHP:0.325}, L:{vsRHP:0.330,vsLHP:0.290}, S:{vsRHP:0.322,vsLHP:0.308} };
    const PIT_DFLT = { R:{vsLHB:0.320,vsRHB:0.295}, L:{vsLHB:0.285,vsRHB:0.330} };
    function normName(n) { return (n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim(); }
    function lookupBatter(name, hand, oppSpHand, teamHint) {
        const vsKey  = oppSpHand==='R' ? 'bat-proj-rhp' : 'bat-proj-lhp';
        const actKey = oppSpHand==='R' ? 'bat-act-rhp'  : 'bat-act-lhp';
        const oppKey    = oppSpHand==='R' ? 'bat-proj-lhp' : 'bat-proj-rhp';
        const oppActKey = oppSpHand==='R' ? 'bat-act-lhp'  : 'bat-act-rhp';
        const dflt = BAT_DFLT[hand]||BAT_DFLT['R'];
        const dfltV    = oppSpHand==='R' ? dflt.vsRHP : dflt.vsLHP;
        const dfltVOpp = oppSpHand==='R' ? dflt.vsLHP : dflt.vsRHP;
        const key=normName(name);
        const parts=key.split(' ');
        const isAbbrev=parts.length>=2&&parts[0].length===1;
        function stripJr(n){return n.replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\s+/g,' ').trim();}
        function findIn(idx,k,tHint){
          if(!idx)return null;
          const tl=tHint?tHint.toLowerCase():null;
          // 1. Exact team key: "bobby witt kc"
          if(tl&&idx[k+' '+tl])return idx[k+' '+tl].woba;
          // 2. Exact name
          if(idx[k])return idx[k].woba;
          // 3. Search index entries where stripJr(indexKey w/o team) === k, same team
          // Catches "bobby witt jr kc" when looking up "bobby witt" + "kc"
          if(tl){
            const jrEntry=Object.entries(idx).find(([n])=>{
              if(!n.endsWith(' '+tl))return false;
              const base=n.slice(0,n.length-tl.length-1).trim();
              return stripJr(base)===k;
            });
            if(jrEntry)return jrEntry[1].woba;
          }
          // 4. Abbreviated name (M. Busch style)
          if(isAbbrev){
            const initial=parts[0],last=parts[parts.length-1];
            if(tl){const e=Object.entries(idx).find(([n])=>{if(!n.endsWith(' '+tl))return false;const base=n.slice(0,n.length-tl.length-1).trim();const p=stripJr(base).split(' ');return p[p.length-1]===last&&p[0]&&p[0][0]===initial;});if(e)return e[1].woba;}
            const matches=Object.entries(idx).filter(([n])=>{if(/\s[a-z]{2,3}$/.test(n))return false;const p=stripJr(n).split(' ');return p[p.length-1]===last&&p[0]&&p[0][0]===initial;});
            if(matches.length===1)return matches[0][1].woba;
          }
          // 5. Jr-stripped exact key
          const sk=stripJr(k);
          if(tl&&idx[sk+' '+tl])return idx[sk+' '+tl].woba;
          const e2=Object.entries(idx).find(([n])=>!/\s[a-z]{2,3}$/.test(n)&&stripJr(n)===sk);
          return e2?e2[1].woba:null;
        }
        // Look up vs SP hand
        const projV    = findIn(wobaIdx[vsKey],  key, teamHint);
        const actV     = findIn(wobaIdx[actKey], key, teamHint);
        const wobaVsSP = (projV&&actV) ? +(W_PROJ*projV+W_ACT*actV).toFixed(3)
                       : projV ? +projV.toFixed(3) : actV ? +actV.toFixed(3) : +dfltV.toFixed(3);
        const srcVsSP  = (projV&&actV)?'blend':projV?'proj':actV?'act':'default';
        // Look up vs opposite hand (for bullpen blend)
        const projO    = findIn(wobaIdx[oppKey],    key, teamHint);
        const actO     = findIn(wobaIdx[oppActKey], key, teamHint);
        const wobaVsOpp = (projO&&actO) ? +(W_PROJ*projO+W_ACT*actO).toFixed(3)
                        : projO ? +projO.toFixed(3) : actO ? +actO.toFixed(3) : +dfltVOpp.toFixed(3);
        // Blended wOBA: SP_WT% vs SP hand + REL_WT% vs opposite
        const blended = +(wobaVsSP*SP_WT + wobaVsOpp*REL_WT).toFixed(3);
        return {woba:blended, wobaVsSP, wobaVsOpp, source:srcVsSP};
      }
    function lookupPitcher(name, hand) {
      // Use model.js getPitcherWoba which has full fuzzyLookup including compound surname fallback
      const { getPitcherWoba } = require('../services/model');
      const result = getPitcherWoba(wobaIdx, name, hand||'R', null, W_PROJ, W_ACT);
      return {
        vsLHB: { woba: result.vsLHB, rawWoba: result.vsLHB, source: result.source },
        vsRHB: { woba: result.vsRHB, rawWoba: result.vsRHB, source: result.source },
      };
    }
    const awayLineup=tryParse(game.away_lineup_json)||[];
    const homeLineup=tryParse(game.home_lineup_json)||[];
    res.json({
      game_id:gameId,
      away_sp_woba:lookupPitcher(game.away_sp,game.away_sp_hand||'R'),
      home_sp_woba:lookupPitcher(game.home_sp,game.home_sp_hand||'R'),
      away_batters:awayLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.home_sp_hand||'R',game.away_team)})),
      home_batters:homeLineup.map(b=>({...b,...lookupBatter(b.name,b.hand,game.away_sp_hand||'R',game.home_team)})),
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── PATCH GAME LINEUP / SP ────────────────────────────────────────────
router.patch('/games/:date/:gameId/lineup', (req, res) => {
  try {
    const { date, gameId } = req.params;
    const { away_sp, away_sp_hand, home_sp, home_sp_hand, away_lineup, home_lineup } = req.body;
    const sets = [], vals = [];
    if (away_sp      !== undefined) { sets.push('away_sp=?');       vals.push(away_sp); }
    if (away_sp_hand !== undefined) { sets.push('away_sp_hand=?');  vals.push(away_sp_hand); }
    if (home_sp      !== undefined) { sets.push('home_sp=?');       vals.push(home_sp); }
    if (home_sp_hand !== undefined) { sets.push('home_sp_hand=?');  vals.push(home_sp_hand); }
    if (away_lineup  !== undefined) { sets.push('away_lineup_json=?'); vals.push(JSON.stringify(away_lineup)); }
    if (home_lineup  !== undefined) { sets.push('home_lineup_json=?'); vals.push(JSON.stringify(home_lineup)); }
    if (!sets.length) return res.status(400).json({error:'No fields to update'});
    vals.push(date, gameId);
    db.prepare('UPDATE game_log SET '+sets.join(',')+' WHERE game_date=? AND game_id=?').run(...vals);
    const gameRow = q.getGameById.get(date, gameId);
    if (gameRow) processGameSignals(gameRow, getWobaIndex(), getSettings());
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── PATCH GAME ODDS (safe update — only touches columns provided) ─────
router.patch('/games/:date/:gameId/odds', (req, res) => {
  try {
    const { date, gameId } = req.params;
    const g = req.body;
    const sets = [];
    const vals = [];
    if (g.market_away_ml !== undefined) { sets.push('market_away_ml=?'); vals.push(g.market_away_ml); }
    if (g.market_home_ml !== undefined) { sets.push('market_home_ml=?'); vals.push(g.market_home_ml); }
    if (g.market_total    !== undefined) { sets.push('market_total=?');    vals.push(g.market_total); }
    if (g.over_price      !== undefined) { sets.push('over_price=?');      vals.push(g.over_price); }
    if (g.under_price     !== undefined) { sets.push('under_price=?');     vals.push(g.under_price); }
    if (g.away_score      !== undefined) { sets.push('away_score=?');      vals.push(g.away_score); }
    if (g.home_score      !== undefined) { sets.push('home_score=?');      vals.push(g.home_score); }
    if (g.wind_speed      !== undefined) { sets.push('wind_speed=?');      vals.push(g.wind_speed); }
    if (g.wind_dir        !== undefined) { sets.push('wind_dir=?');        vals.push(g.wind_dir); }
    if (g.wind_factor     !== undefined) { sets.push('wind_factor=?');     vals.push(g.wind_factor); }
    if (g.temp_f          !== undefined) { sets.push('temp_f=?');          vals.push(g.temp_f); }
    if (g.temp_run_adj    !== undefined) { sets.push('temp_run_adj=?');    vals.push(g.temp_run_adj); }
    if (g.roof_status     !== undefined) { sets.push('roof_status=?');     vals.push(g.roof_status); }
    if (g.roof_confidence !== undefined) { sets.push('roof_confidence=?'); vals.push(g.roof_confidence); }
    if (!sets.length) return res.status(400).json({error:'No fields to update'});
    vals.push(date, gameId);
    db.prepare('UPDATE game_log SET '+sets.join(',')+' WHERE game_date=? AND game_id=?').run(...vals);
    // Rerun signals for this game
    const gameRow = q.getGameById.get(date, gameId);
    if (gameRow) processGameSignals(gameRow, getWobaIndex(), getSettings());
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── BACKTEST RESET ────────────────────────────────────────────────────
// Unlock all odds for a date

// Update wind data for a game and rerun model
router.patch('/games/:date/:gameId/wind', (req, res) => {
  try {
    const { wind_speed, wind_dir, wind_factor } = req.body;
    const { date, gameId } = req.params;
    db.prepare('UPDATE game_log SET wind_speed=?, wind_dir=?, wind_factor=? WHERE game_date=? AND game_id=?')
      .run(wind_speed, wind_dir, wind_factor, date, gameId);
    // Rerun model with new wind factor
    const { processGameSignals, getWobaIndex, getSettings } = require('../services/jobs');
    const wobaIdx = getWobaIndex();
    const settings = getSettings();
    processGameSignals(date, gameId, wobaIdx, settings);
    res.json({success:true, wind_factor});
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post('/games/:date/unlock', (req, res) => {
  try {
    const r = db.prepare("UPDATE game_log SET odds_locked_at=NULL WHERE game_date=?").run(req.params.date);
    res.json({success:true, unlocked:r.changes});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/backtest/reset-date', (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({error:'date required'});
    const r = db.prepare("DELETE FROM bet_signals WHERE game_date=?").run(date);
    res.json({success:true, deleted:r.changes, date});
  } catch(err) { res.status(500).json({error:err.message}); }
});

router.delete('/backtest/reset', (req, res) => {
  try {
    const { from, to } = req.query;
    if (from && to) {
      db.prepare('DELETE FROM bet_signals WHERE game_date BETWEEN ? AND ?').run(from, to);
    } else {
      db.prepare('DELETE FROM bet_signals').run();
    }
    // Also reset model lines so rerun regenerates fresh signals
    if (from && to) {
      db.prepare("UPDATE game_log SET model_away_ml=NULL,model_home_ml=NULL,model_total=NULL WHERE game_date BETWEEN ? AND ?").run(from, to);
    } else {
      db.prepare("UPDATE game_log SET model_away_ml=NULL,model_home_ml=NULL,model_total=NULL").run();
    }
    res.json({ success: true, message: 'All backtest signals wiped' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/debug/woba-keys', (req, res) => {
  const q2 = req.query.q || '';
  const idx = getWobaIndex();
  const keys = {};
  for (const [dataKey, players] of Object.entries(idx)) {
    keys[dataKey] = Object.keys(players).filter(k => !q2 || k.includes(q2.toLowerCase())).slice(0,20);
  }
  res.json(keys);
});

// ── BET LINE TRACKING ─────────────────────────────────────────────────
// Lock your actual bet line for a signal
router.post('/signals/recalc', (req, res) => {
  try {
    // Recalculate pnl for all resolved signals using to-win-$100 logic
    // Use bet_line if available, else market_line
    const sigs = db.prepare(`SELECT * FROM bet_signals WHERE outcome IN ('win','loss')`).all();
    let updated = 0;
    const upd = db.prepare(`UPDATE bet_signals SET pnl=? WHERE id=?`);
    for (const sig of sigs) {
      const ml = parseFloat(sig.bet_line || sig.market_line);
      if (isNaN(ml) || ml === 0) continue;
      let pnl;
      if (sig.signal_type === 'ML') {
        // To win $100: +odds stake=10000/odds, -odds stake=abs(odds)
        const stake = ml > 0 ? parseFloat((10000/ml).toFixed(2)) : Math.abs(ml);
        pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
      } else {
        // Total: use bet_line as the vig price (e.g. -110), else -110
        const price = parseFloat(sig.bet_line) || -110;
        const stake = price > 0 ? parseFloat((10000/price).toFixed(2)) : Math.abs(price);
        pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
      }
      upd.run(parseFloat(pnl.toFixed(2)), sig.id);
      updated++;
    }
    res.json({success:true, updated});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/signals/manual', (req, res) => {
  try {
    // If recalc:true, recalculate all resolved signal P&L with to-win-100 math
    if (req.body.recalc) {
      const sigs = db.prepare("SELECT * FROM bet_signals WHERE outcome IN ('win','loss')").all();
      let updated = 0;
      const upd = db.prepare("UPDATE bet_signals SET pnl=? WHERE id=?");
      for (const sig of sigs) {
        const ml = parseFloat(sig.bet_line || sig.market_line);
        if (isNaN(ml) || ml === 0) continue;
        let pnl;
        if (sig.signal_type === 'ML') {
          const ml2 = parseFloat(sig.bet_line || sig.market_line);
          if (!isNaN(ml2) && ml2 !== 0) {
            const stake = ml2 > 0 ? parseFloat((10000/ml2).toFixed(2)) : Math.abs(ml2);
            pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
          }
        } else {
          // Total: bet_line is the line number not the price — use closing_line as price or -110
          const price = parseFloat(sig.closing_line) || -110;
          const stake = price < 0 ? Math.abs(price) : parseFloat((10000/price).toFixed(2));
          pnl = sig.outcome === 'win' ? 100 : parseFloat((-stake).toFixed(2));
        }
        upd.run(parseFloat(pnl.toFixed(2)), sig.id);
        updated++;
      }
      return res.json({success:true, recalculated:updated});
    }
    const { game_date, game_id, signal_type, signal_side, signal_label, market_line, bet_line, bet_price } = req.body;
    if (!game_date||!game_id||!signal_type||!signal_side||!signal_label||market_line==null)
      return res.status(400).json({error:'Missing required fields'});
    const gl = q.getGameById.get(game_date, game_id);
    if (!gl) return res.status(404).json({error:'Game not found: '+game_date+'/'+game_id});
    // category e.g. "2star-dog", "1star-over"
    const stars = {'1★':'1star','2★':'2star','3★':'3star','unrated':'0star'}[signal_label]||'0star';
    const sideKey = signal_type==='ML' ? (Number(market_line)>0?'dog':'fav') : signal_side;
    const category = stars+'-'+sideKey;
    // model line from current DB
    const model_line = signal_type==='ML'
      ? (signal_side==='away' ? gl.model_away_ml : gl.model_home_ml)
      : gl.model_total;
    // edge
    function iP(ml){ml=Number(ml);return ml<0?Math.abs(ml)/(Math.abs(ml)+100):100/(ml+100);}
    const edge_pct = model_line ? Math.round(Math.abs(iP(Number(market_line))-iP(Number(model_line)))*100) : null;
    // outcome if already scored
    const { calcPnl } = require('../services/model');
    let outcome='pending', pnl=0;
    if (gl.away_score!=null){
      const r=calcPnl({type:signal_type,side:signal_side,marketLine:Number(market_line)},gl.away_score,gl.home_score,gl.market_total);
      outcome=r.outcome; pnl=r.pnl;
    }
    const info = db.prepare(`INSERT INTO bet_signals
      (game_log_id,game_date,game_id,signal_type,signal_side,signal_label,category,
       market_line,model_line,edge_pct,outcome,pnl,bet_line,bet_locked_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`)
      .run(gl.id,game_date,game_id,signal_type,signal_side,signal_label,category,
           Number(market_line),model_line,edge_pct,outcome,pnl,
           bet_line!=null?Number(bet_line):null);
    res.json({success:true,id:info.lastInsertRowid,outcome,pnl,category});
  } catch(e){res.status(500).json({error:e.message});}
});

router.post('/signals/:id/bet-line', (req, res) => {
  try {
    const { id } = req.params;
    const { bet_line } = req.body;
    if (bet_line == null) return res.status(400).json({error:'bet_line required'});
    // Recalculate CLV if closing_line already exists
    const sig = db.prepare('SELECT * FROM bet_signals WHERE id=?').get(id);
    if (!sig) return res.status(404).json({error:'Signal not found'});
    let clv = null;
    if (sig.closing_line != null) {
      // CLV = how much better your line is vs closing
      // For ML: positive = you got a better price than closing
      const isFav = bet_line < 0;
      if (isFav) {
        // Less negative = better for favorite bettors
        clv = sig.closing_line - bet_line; // e.g. closed at -150, you got -130 → clv = +20
      } else {
        // More positive = better for underdog bettors
        clv = bet_line - sig.closing_line; // e.g. closed at +120, you got +135 → clv = +15
      }
    }
    db.prepare("UPDATE bet_signals SET bet_line=?, bet_locked_at=datetime('now'), clv=? WHERE id=?")
      .run(bet_line, clv, id);
    res.json({success:true, id, bet_line, clv});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Set closing line for a signal (called when odds lock fires)
router.post('/signals/:id/closing-line', (req, res) => {
  try {
    const { id } = req.params;
    const { closing_line } = req.body;
    if (closing_line == null) return res.status(400).json({error:'closing_line required'});
    const sig = db.prepare('SELECT * FROM bet_signals WHERE id=?').get(id);
    if (!sig) return res.status(404).json({error:'Signal not found'});
    // Recalculate CLV if bet_line exists
    let clv = null;
    if (sig.bet_line != null) {
      const isFav = sig.bet_line < 0;
      clv = isFav ? (closing_line - sig.bet_line) : (sig.bet_line - closing_line);
    }
    db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?")
      .run(closing_line, clv, id);
    res.json({success:true, id, closing_line, clv});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Bulk-set closing lines when odds lock fires (called from jobs.js)
router.post('/signals/closing-lines', (req, res) => {
  try {
    const { game_date, game_id, closing_line } = req.body;
    const sigs = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND closing_line IS NULL AND signal_type='ML'").all(game_date, game_id);
    let updated = 0;
    for (const sig of sigs) {
      let clv = null;
      if (sig.bet_line != null) {
        const isFav = sig.bet_line < 0;
        clv = isFav ? (closing_line - sig.bet_line) : (sig.bet_line - closing_line);
      }
      db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closing_line, clv, sig.id);
      updated++;
    }
    res.json({success:true, updated});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── LOOKUP DEBUG ───────────────────────────────────────────────────
router.get('/debug/lookup', (req, res) => {
  try {
    const name = req.query.name || 'S. Woods Richardson';
    const team = req.query.team || 'MIN';
    const { normName, getPitcherWoba } = require('../services/model');
    const wobaIdx = getWobaIndex();
    // Check what's in the index for this name
    const k = normName(name);
    const kTeam = k + ' ' + team.toLowerCase();
    const pitLhb = wobaIdx['pit-proj-lhb'] || {};
    const directHit = pitLhb[k];
    const teamHit = pitLhb[kTeam];
    // Run actual getPitcherWoba
    const { runModel } = require('../services/model');
    const result = getPitcherWoba(wobaIdx, name, 'R', team, 0.7, 0.3);
    // Also run full model for min-tor
    const gameRow = q.getGameById.get('2026-04-10', 'min-tor');
    let modelResult = null;
    if (gameRow) {
      const settings = getSettings();
      const gameObj = {...gameRow,
        awayLineup: gameRow.away_lineup_json ? JSON.parse(gameRow.away_lineup_json) : [],
        homeLineup: gameRow.home_lineup_json ? JSON.parse(gameRow.home_lineup_json) : [],
      };
      try { modelResult = runModel(gameObj, wobaIdx, settings); } catch(e) { modelResult = {error:e.message}; }
    }
    // Count keys in index
    const allKeys = Object.keys(pitLhb).filter(k2=>k2.includes(k.split(' ').pop()));
    res.json({name, k, kTeam, directHit:!!directHit, teamHit:!!teamHit,
      matchingKeys:allKeys.slice(0,10), result, modelResult});
  } catch(err) { res.status(500).json({error:err.message, stack:err.stack?.split('\n').slice(0,5)}); }
});

// ── SCORE DEBUG ENDPOINT ──────────────────────────────────────────────
router.get('/debug/scores', async (req, res) => {
  try {
    const date = req.query.date || '2026-04-08';
    const [year,month,day] = date.split('-');
    const fetch2 = require('node-fetch');
    const url = 'https://www.baseball-reference.com/boxes/index.fcgi?month='+parseInt(month)+'&day='+parseInt(day)+'&year='+year;
    const resp = await fetch2(url, {headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36','Accept':'text/html'}});
    const html = await resp.text();
    const status = resp.status;
    // Check if Final appears in text
    const hasFinal = html.includes('Final');
    const finalCount = (html.match(/Final/g)||[]).length;
    // Try to find team names
    const hasPadres = html.includes('San Diego Padres');
    // Get a 500 char snippet around first Final
    const finalIdx = html.indexOf('Final');
    const snippet = finalIdx > 0 ? html.substring(finalIdx-100, finalIdx+200) : 'Final not found';
    res.json({date, status, hasFinal, finalCount, hasPadres, textLength:html.length, snippet});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── KALSHI TEST ENDPOINT (sandbox/debug) ─────────────────────────


    const data = await resp.json();
    res.json({status: resp.status, count: data.events?.length, sample: data.events?.slice(0,2)});
  } catch(e) { res.json({error: e.message}); }
});

// Team abbr → FanGraphs depth chart slug
const FG_SLUGS = {
  ari:'diamondbacks',phi:'phillies',mia:'marlins',det:'tigers',pit:'pirates',chc:'cubs',
  min:'twins',tor:'blue-jays',ath:'athletics',nym:'mets',cws:'white-sox',kc:'royals',
  laa:'angels',cin:'reds',nyy:'yankees',tb:'rays',was:'nationals',mil:'brewers',
  bos:'red-sox',stl:'cardinals',cle:'guardians',atl:'braves',sf:'giants',bal:'orioles',
  col:'rockies',sd:'padres',tex:'rangers',lad:'dodgers',hou:'astros',sea:'mariners'
};

router.get('/debug/bullpen-woba', async (req, res) => {
  try {
    const fetch2 = require('node-fetch');
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const W_PROJ = parseFloat(req.query.w_proj||'0.65');
    const W_ACT  = parseFloat(req.query.w_act ||'0.35');
    const MIN_BF = 50;

    // Get tonight's games + starters
    const gameRows = q.getGamesByDate(date);
    const starters = {}; // team → starterName
    gameRows.forEach(g => {
      const [a,h] = g.game_id.split('-');
      if (g.away_sp) starters[a] = g.away_sp.toLowerCase();
      if (g.home_sp) starters[h] = g.home_sp.toLowerCase();
    });
    const teams = Object.keys(starters);

    // Get full wOBA index
    const wobaRows = q.getAllWoba ? q.getAllWoba() : [];
    // Build index: { 'pit-act-rhb': { 'porter hodge': {woba, sample_size} } }
    const idx = {};
    wobaRows.forEach(r => {
      if (!idx[r.data_key]) idx[r.data_key] = {};
      idx[r.data_key][r.player_name.toLowerCase()] = { woba: r.woba, sample: r.sample_size||0 };
    });

    function normName(n){ return (n||'').toLowerCase().replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim(); }

    function fuzzyGet(keyMap, name) {
      if (!keyMap) return null;
      const k = normName(name);
      if (keyMap[k]) return keyMap[k];
      // Try last name match
      const last = k.split(' ').pop();
      const hits = Object.entries(keyMap).filter(([kk])=>kk.endsWith(' '+last)||kk===last);
      if (hits.length===1) return hits[0][1];
      return null;
    }

    function blendWoba(proj, act, wProj, wAct) {
      const hp = proj && !isNaN(proj.woba);
      const ha = act && !isNaN(act.woba) && act.sample >= MIN_BF;
      if (hp && ha) return { woba: proj.woba*wProj + act.woba*wAct, source:'blend' };
      if (hp) return { woba: proj.woba, source:'steamer' };
      if (ha) return { woba: act.woba, source:'actual' };
      return null;
    }

    function getPitcherWoba(name, hand) {
      const bL = blendWoba(fuzzyGet(idx['pit-proj-lhb'],name), fuzzyGet(idx['pit-act-lhb'],name), W_PROJ, W_ACT);
      const bR = blendWoba(fuzzyGet(idx['pit-proj-rhb'],name), fuzzyGet(idx['pit-act-rhb'],name), W_PROJ, W_ACT);
      const DFLT = hand==='L' ? {vsLHB:0.310,vsRHB:0.330} : {vsLHB:0.320,vsRHB:0.295};
      const vsLHB = (bL?.woba ?? DFLT.vsLHB);
      const vsRHB = (bR?.woba ?? DFLT.vsRHB);
      const src = bL||bR ? (bL?.source===bR?.source ? bL?.source||'steamer' : 'blend') : 'fallback';
      return { vsLHB, vsRHB, overall:(vsLHB+vsRHB)/2, source:src };
    }

    const results = {};

    for (const team of teams) {
      const slug = FG_SLUGS[team];
      if (!slug) { results[team]={error:'no FG slug'}; continue; }
      try {
        const html = await fetch2('https://www.fangraphs.com/roster-resource/depth-charts/'+slug,
          {headers:{'User-Agent':'Mozilla/5.0 (compatible; mlb-analyzer/1.0)'},timeout:10000}
        ).then(r=>r.text());

        // Parse bullpen section — find table after "Bullpen" heading
        // FG uses section headers like: <div class="depth-chart-section-header">Bullpen</div>
        // Pitcher rows: <a href="/players/...">Name</a> with hand and status
        const bullpenStart = html.indexOf('Bullpen');
        if (bullpenStart<0) { results[team]={error:'no Bullpen section found'}; continue; }

        // Extract text block after Bullpen heading up to next section
        const nextSection = html.indexOf('Bullpen', bullpenStart+10);
        const block = html.substring(bullpenStart, bullpenStart+8000);

        // Parse player names — look for href="/players/" links
        const nameRe = /href="\/players\/[^"]+">([^<]+)<\/a>/g;
        // Also look for IL/status markers: "IL-10", "IL-15", "IL-60", "AAA", "DTD"
        const ilRe = /\b(IL-\d+|IL60|AAA|DTD|Minors)\b/gi;

        // FG roster resource structure: each player row has name, throws (L/R), last 6 days
        // Let's parse more carefully using row structure
        // Rows look like: <tr class="depth-chart-player-row ...">
        const rowRe = /<tr[^>]*depth-chart[^>]*>(.*?)<\/tr>/gs;
        const pitchers = [];
        let m;
        // Simpler: extract all player links with context
        const playerRe = /<a[^>]+href="\/players\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
        while ((m=playerRe.exec(block))!==null) {
          const name = m[2].trim();
          if (name.length>2 && name.length<40 && /[A-Za-z]/.test(name)) {
            pitchers.push(name);
          }
        }

        // Also check for unavailable/IL markers near the bullpen section
        const statusBlock = block.substring(0, 6000);
        // Look for status spans: class containing "il" or "unavailable"
        const unavailRe = /class="[^"]*unavail[^"]*"[^>]*>([^<]*)/gi;
        const unavailNames = [];
        while((m=unavailRe.exec(statusBlock))!==null) unavailNames.push(m[1].trim());

        // Dedupe pitchers
        const uniquePitchers = [...new Set(pitchers)];

        // Look up wOBA for each, exclude starter
        const starterLast = (starters[team]||'').split(' ').pop();
        const bullpen = [];
        for (const name of uniquePitchers.slice(0,20)) {
          const nameLast = normName(name).split(' ').pop();
          if (nameLast && starterLast && nameLast===starterLast) continue; // skip starter
          // Guess hand from name lookup (default R if unknown)
          const pw = getPitcherWoba(name, 'R');
          bullpen.push({ name, ...pw });
        }

        // PA-weighted average (use source as proxy — fallback gets weight 30, steamer 50, blend/actual 100)
        const PA_PROXY = {blend:100, actual:100, steamer:50, fallback:30};
        const pool = bullpen.filter(p=>p.source!=='fallback'); // exclude fallback pitchers
        if (!pool.length) { results[team]={error:'no wOBA data for any bullpen pitcher',pitchers:bullpen}; continue; }
        const totalPA = pool.reduce((s,p)=>s+(PA_PROXY[p.source]||50),0);
        const bpWoba = pool.reduce((s,p)=>s+p.overall*(PA_PROXY[p.source]||50),0)/totalPA;

        results[team] = {
          bullpenWoba: parseFloat(bpWoba.toFixed(4)),
          pitcherCount: pool.length,
          starter: starters[team],
          pitchers: bullpen
        };
      } catch(e) {
        results[team] = {error: e.message};
      }
    }

    res.json(results);
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});


module.exports = router;


