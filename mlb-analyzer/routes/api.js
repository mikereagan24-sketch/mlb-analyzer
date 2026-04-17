// @deployed 2026-04-12T18:07:38.335Z
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { q, db } = require('../db/schema');
const { runLineupJob, runScoreJob, runOddsJob, getWobaIndex, getSettings, processGameSignals, runRosterJob } = require('../services/jobs');
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
// Prevent browser caching on all API responses
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});

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

router.post('/jobs/fix-signals', (req, res) => {
  try {
    // 1. Remove duplicate signals — keep highest ID per game+type+side
    db.prepare(`DELETE FROM bet_signals WHERE id NOT IN (
      SELECT MAX(id) FROM bet_signals GROUP BY game_date, game_id, signal_type, signal_side
    )`).run();
    // 2. Backfill closing_line from market_line for all resolved signals
    db.prepare(`UPDATE bet_signals SET
      closing_line = market_line,
      clv = CASE
        WHEN bet_line IS NOT NULL AND market_line IS NOT NULL THEN
          CASE WHEN signal_type='ML' THEN
            CASE WHEN market_line < 0 THEN market_line - bet_line ELSE bet_line - market_line END
          ELSE bet_line - market_line END
        ELSE NULL END
      WHERE closing_line IS NULL AND outcome != 'pending' AND market_line IS NOT NULL`).run();
    const fixed = db.prepare('SELECT COUNT(*) as n FROM bet_signals WHERE closing_line IS NOT NULL').get();
    res.json({success:true, withClosingLine: fixed.n});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/backtest', (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || '2026-01-01';
    const toDate = to || '2099-12-31';
    // One-time: null out CLV for Total signals (CLV not meaningful — bet_line is a price, not a total)
    db.prepare("UPDATE bet_signals SET clv=NULL WHERE signal_type='Total' AND clv IS NOT NULL").run();
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
        AND (bs.is_active = 1 OR bs.bet_locked_at IS NOT NULL)
      ORDER BY bs.game_date, bs.id
    `).all(fromDate, toDate);
    res.json({ overall, byCategory, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// weather route: see below

router.post('/jobs/rosters', async (req, res) => {
  console.log('[api] roster job fired');
  try {
    const result = await runRosterJob();
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/rosters/:team', (req, res) => {
  try {
    const team = req.params.team.toUpperCase();
    const rows = db.prepare("SELECT player_name,role,hand,updated_at FROM team_rosters WHERE team=? ORDER BY role,player_name").all(team);
    const updatedAt = rows[0]?.updated_at||null;
    res.json({ team, updatedAt, pitchers: rows });
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
    if (sig.closing_line != null && sig.signal_type === 'ML') {
      // CLV = how much better your line is vs closing (ML only — not meaningful for totals)
      const isFav = bet_line < 0;
      if (isFav) {
        clv = sig.closing_line - bet_line; // e.g. closed at -150, you got -130 → clv = +20
      } else {
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
    // Recalculate CLV if bet_line exists (ML only — not meaningful for totals)
    let clv = null;
    if (sig.bet_line != null && sig.signal_type === 'ML') {
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
        q.updateWindData.run(
          wind.windSpeed, wind.windDir, wind.factor,
          wind.tempF, wind.tempAdj,
          g.roof_status || 'open', g.roof_confidence || 'estimated',
          dateStr, g.game_id
        );
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

// ── KALSHI TEST ENDPOINT (removed debug endpoint) ─────────────

// Team abbr → FanGraphs depth chart slug
const FG_SLUGS = {
  ari:'diamondbacks',phi:'phillies',mia:'marlins',det:'tigers',pit:'pirates',chc:'cubs',
  min:'twins',tor:'blue-jays',ath:'athletics',nym:'mets',cws:'white-sox',kc:'royals',
  laa:'angels',cin:'reds',nyy:'yankees',tb:'rays',was:'nationals',mil:'brewers',
  bos:'red-sox',stl:'cardinals',cle:'guardians',atl:'braves',sf:'giants',bal:'orioles',
  col:'rockies',sd:'padres',tex:'rangers',lad:'dodgers',hou:'astros',sea:'mariners'
};

router.get('/debug/bullpen', (req, res) => {
  try {
    const team = (req.query.team||'').toUpperCase();
    const sp   = req.query.sp||'';
    const hand = req.query.hand||'rhb';
    if (!team) return res.json({ error: 'team required' });
    const norm = n=>(n||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim();
    const projRows = db.prepare("SELECT player_name,woba,sample_size FROM woba_data WHERE data_key=? AND player_name LIKE ?").all('pit-proj-'+hand,'% '+team);
    const actRows  = db.prepare("SELECT player_name,woba,sample_size FROM woba_data WHERE data_key=?").all('pit-act-'+hand);
    const actIdx={}; for(const r of actRows) actIdx[norm(r.player_name)]=r;
    const sets=getSettings(); const WP=sets.W_PROJ||0.65, WA=sets.W_ACT||0.35;
    const starterLast=sp?norm(sp).split(' ').pop():'';
    const pitchers=projRows.map(proj=>{
      const nameClean=proj.player_name.replace(/ [A-Z]{2,3}$/,'');
      const pNorm=norm(nameClean); const lastName=pNorm.split(' ').pop();
      const isStarter=!!starterLast&&pNorm.includes(starterLast);
      const actExact=actIdx[pNorm];
      const actMatch=actExact||Object.entries(actIdx).find(([k])=>k.endsWith(' '+lastName))?.[1]||null;
      const blended=actMatch?WP*proj.woba+WA*actMatch.woba:proj.woba;
      return{name:nameClean,role:isStarter?'SP':'RP',proj_woba:+proj.woba.toFixed(4),proj_sample:+proj.sample_size.toFixed(1),act_woba:actMatch?+actMatch.woba.toFixed(4):null,act_sample:actMatch?+actMatch.sample_size:null,act_match:actMatch?norm(actMatch.player_name||''):null,blended_woba:+blended.toFixed(4),calc:actMatch?WP+'×'+proj.woba.toFixed(4)+' + '+WA+'×'+actMatch.woba.toFixed(4)+' = '+blended.toFixed(4):'proj only (no act match) = '+proj.woba.toFixed(4)};
    });
    const pool=pitchers.filter(p=>p.role==='RP'&&p.proj_sample>=5);
    const use=pool.length>=3?pool:pitchers.filter(p=>p.role==='RP').slice(0,8);
    const tw=use.reduce((s,p)=>s+p.proj_sample,0);
    const bpW=tw>0?+(use.reduce((s,p)=>s+p.blended_woba*p.proj_sample,0)/tw).toFixed(4):null;
    res.json({team,hand,sp,W_PROJ:WP,W_ACT:WA,total_pitchers:projRows.length,pitchers,bullpen_woba:bpW,pool_size:use.length,pool_pitchers:use.map(p=>p.name)});
  } catch(e){res.status(500).json({error:e.message,stack:e.stack});}
});


// ── MODEL COMPARISON: old params vs new params ───────────────────────────────
// GET /api/model-compare?from=2026-04-09&to=2026-04-12
// Re-simulates model totals/signals under configurable old vs new parameters
// and shows which signals would fire/disappear and record impact
router.get('/model-compare', (req, res) => {
  try {
    const from = req.query.from || new Date().toISOString().slice(0,10);
    const to   = req.query.to   || from;

    // Old params (baseline — what was hardcoded before today's changes)
    const OLD_PF  = { ATH:0.96, KC:0.97 }; // all others unchanged
    const oldTempAdj = t => t == null ? 0 :
      (t < 55 ? -0.5 : t < 70 ? 0 : t < 80 ? 0.3 : 0.6);

    // New params (today's changes)
    const NEW_PF  = { ATH:1.12, KC:1.00 };
    const newTempAdj = t => t == null ? 0 :
      Math.max(-1.3, Math.min(1.3, (t - 65) * 0.052));

    // Get resolved signals with game context
    const sigs = q.getSignalsInRange.all(from, to)
      .filter(s => s.outcome && s.outcome !== 'pending');

    const games = {};
    const gameRows = db.prepare(
      'SELECT * FROM game_log WHERE game_date >= ? AND game_date <= ?'
    ).all(from, to);
    gameRows.forEach(g => { games[g.game_date + '_' + g.game_id] = g; });

    // Signal threshold helpers (mirrors model.js getSignals)
    const settings = q.getSettings ? q.getSettings.all().reduce((a,r)=>{a[r.key]=r.value;return a;},{}) : {};
    const TOT_1STAR = Number(settings.tot_lean_edge  ?? 0.04);
    const TOT_2STAR = Number(settings.tot_value_edge ?? 0.08);
    const TOT_3STAR = Number(settings.tot_3star_edge ?? 0.12);
    const ML_1STAR  = Number(settings.ml_lean_edge   ?? 15);
    const ML_2STAR  = Number(settings.ml_value_edge  ?? 30);
    const ML_3STAR  = Number(settings.ml_3star_edge  ?? 60);

    function totLabel(edge) {
      if (edge >= TOT_3STAR) return '3★';
      if (edge >= TOT_2STAR) return '2★';
      if (edge >= TOT_1STAR) return '1★';
      return null;
    }
    function mlLabel(edge) {
      if (edge >= ML_3STAR) return '3★';
      if (edge >= ML_2STAR) return '2★';
      if (edge >= ML_1STAR) return '1★';
      return null;
    }
    function impliedP(price) {
      price = parseFloat(price);
      return price < 0 ? Math.abs(price)/(Math.abs(price)+100) : 100/(price+100);
    }
    function modelOverP(estTot, mkt) {
      return Math.min(Math.max(0.5 + (estTot - mkt) * 0.08, 0.20), 0.80);
    }

    const results = [];
    let oldW=0, oldL=0, oldPnl=0;
    let newW=0, newL=0, newPnl=0;
    const flipped = [];

    sigs.forEach(s => {
      const gm = games[s.game_date + '_' + s.game_id];
      if (!gm || !gm.model_total) return;

      const roofClosed = gm.roof_status === 'closed';
      const temp = gm.temp_f;

      // Old/new temp adjustments
      const oldTA = roofClosed ? 0 : oldTempAdj(temp);
      const newTA = roofClosed ? 0 : newTempAdj(temp);
      const tempDelta = newTA - oldTA;

      // Old/new park factor impact on run base
      const homePFchange = gm.home_team === 'ATH' ? (NEW_PF.ATH - OLD_PF.ATH)
                         : gm.home_team === 'KC'  ? (NEW_PF.KC  - OLD_PF.KC)  : 0;
      const windAdj = (gm.wind_factor || 0) * 2.0;
      const estRunsBase = gm.model_total - windAdj - oldTA;
      const pfRunDelta = homePFchange !== 0
        ? estRunsBase * (homePFchange / (gm.park_factor || 1.0)) : 0;

      const oldEst = gm.model_total;
      const newEst = oldEst + pfRunDelta + tempDelta;
      const mkt    = gm.market_total;
      const overP  = gm.over_price  || -110;
      const underP = gm.under_price || -110;
      const overImp  = impliedP(overP);
      const underImp = impliedP(underP);

      // Old label for this signal
      let oldLabel, newLabel;
      if (s.signal_type === 'Total') {
        const oldEdge = s.signal_side === 'over'
          ? modelOverP(oldEst, mkt) - overImp
          : (1 - modelOverP(oldEst, mkt)) - underImp;
        const newEdge = s.signal_side === 'over'
          ? modelOverP(newEst, mkt) - overImp
          : (1 - modelOverP(newEst, mkt)) - underImp;
        oldLabel = totLabel(oldEdge);
        newLabel = totLabel(newEdge);
      } else {
        // ML signals: only affected if park factor change is large enough to shift ML
        // For simplicity treat as unchanged (park factor affects totals much more than ML at these deltas)
        oldLabel = s.signal_label;
        newLabel = s.signal_label;
      }

      // PnL helper: to-win-$100
      function pnl(ml, won) {
        ml = parseFloat(ml); if (!ml) return 0;
        const stake = ml > 0 ? 10000/ml : Math.abs(ml);
        return parseFloat((won ? 100 : -stake).toFixed(2));
      }
      const actualWon = s.outcome === 'win';
      const betLine = parseFloat(s.bet_line) || parseFloat(s.market_line) || 0;
      const sigPnl = pnl(betLine, actualWon);

      // Old model: signal fired (it's in the DB) — count it
      if (oldLabel) { oldW += actualWon?1:0; oldL += actualWon?0:1; oldPnl += sigPnl; }

      // New model: signal fires only if newLabel is non-null
      if (newLabel) { newW += actualWon?1:0; newL += actualWon?0:1; newPnl += sigPnl; }

      const didFlip = oldLabel !== newLabel;
      if (didFlip || Math.abs(newEst - oldEst) > 0.05) {
        results.push({
          date: s.game_date, game: s.game_id.toUpperCase(),
          type: s.signal_type, side: s.signal_side,
          home: gm.home_team, temp: temp ? Math.round(temp) : null,
          roofClosed,
          mktTotal: mkt, oldModelTotal: parseFloat(oldEst.toFixed(2)),
          newModelTotal: parseFloat(newEst.toFixed(2)),
          totalDelta: parseFloat((newEst - oldEst).toFixed(3)),
          tempDelta: parseFloat(tempDelta.toFixed(3)),
          pfDelta: parseFloat(pfRunDelta.toFixed(3)),
          oldLabel, newLabel, flipped: didFlip,
          outcome: s.outcome, pnl: sigPnl
        });
      }
    });

    res.json({
      from, to,
      old: { wins: oldW, losses: oldL, pnl: parseFloat(oldPnl.toFixed(2)), record: oldW+'-'+oldL },
      new: { wins: newW, losses: newL, pnl: parseFloat(newPnl.toFixed(2)), record: newW+'-'+newL },
      flippedCount: results.filter(r=>r.flipped).length,
      changes: results,
      params: {
        old: { parkFactors: OLD_PF, tempFormula: 'step: <55→-0.5, <70→0, <80→+0.3, else +0.6' },
        new: { parkFactors: NEW_PF, tempFormula: 'continuous: clamp((T-65)*0.052, -1.3, +1.3)' }
      }
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});


// DELETE /api/signals/:id — hard delete a specific signal (bypasses bet_line protection)
router.delete('/signals/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if(isNaN(id)) return res.status(400).json({error:'invalid id'});
    const info = db.prepare('DELETE FROM bet_signals WHERE id=?').run(id);
    res.json({success: info.changes > 0, deleted: id, changes: info.changes});
  } catch(e) { res.status(500).json({error:e.message}); }
});


// Debug: show raw Kalshi+DK parse results
router.get('/debug/odds-raw', async (req, res) => {
  try {
    const { fetchOddsAPI } = require('../services/scraper');
    const { getSettings } = require('../services/jobs');
    const settings = getSettings();
    const results = await fetchOddsAPI(settings.odds_api_key, req.query.date || '2026-04-14');
    res.json({ count: results.length, results: results.map(r=>({
      game_id: r.game_id, away: r.market_away_ml, home: r.market_home_ml,
      total: r.market_total, source: r.source
    }))});
  } catch(e) { res.status(500).json({error: e.message}); }
});


// Debug: look up a player in woba_data
router.get('/debug/woba-lookup', (req, res) => {
  const { name, team, key } = req.query;
  const keys = key ? [key] : ['pit-proj-lhb','pit-proj-rhb','pit-act-lhb','pit-act-rhb'];
  const results = {};
  keys.forEach(k => {
    const rows = db.prepare(
      "SELECT player_name, woba, sample_size FROM woba_data WHERE data_key=? AND player_name LIKE ? LIMIT 5"
    ).all(k, '%'+(name||'')+'%');
    results[k] = rows;
  });
  res.json(results);
});

module.exports = router;


