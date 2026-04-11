const cron = require('node-cron');
const { q, db } = require('../db/schema');
const { fetchLineups, fetchScores, fetchOddsAPI, makeGameId } = require('./scraper');
const { runModel, getSignals, calcPnl } = require('./model');

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function yesterdayET() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getSettings() {
  const rows = q.getAllSettings.all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  // Use Number() and ?? so 0 is valid (|| would replace 0 with default)
  const num = (key, def) => { const v = Number(s[key]); return isNaN(v) ? def : v; };
  return {
    RUN_MULT:       num('run_mult', 48),
    HFA_BOOST:      num('hfa_boost', 0.02),
    FAV_ADJ:        num('fav_adj', 0),
    DOG_ADJ:        num('dog_adj', 0),
    W_PIT:          num('w_pit', 0.5),
    W_BAT:          num('w_bat', 0.5),
    W_PROJ:         num('w_proj', 0.65),
    W_ACT:          num('w_act', 0.35),
    ML_VALUE_EDGE:  num('ml_value_edge', 40),
    ML_LEAN_EDGE:   num('ml_lean_edge', 20),
    TOT_VALUE_EDGE:  num('tot_value_edge',  0.08),
    ML_3STAR_EDGE:   num('ml_3star_edge',    60),
    TOT_3STAR_EDGE:  num('tot_3star_edge',   0.12),
    TOT_LEAN_EDGE:  num('tot_lean_edge', 0.5),
    SP_WEIGHT:      num('sp_weight', 0.77),
    RELIEF_WEIGHT:     num('relief_weight',     0.23),
    SP_PIT_WEIGHT:     num('sp_pit_weight',     0.80),
    RELIEF_PIT_WEIGHT: num('relief_pit_weight', 0.20),
  };
}

function getWobaIndex() {
  const rows = db.prepare('SELECT data_key, player_name, woba, sample_size FROM woba_data').all();
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    const key = r.player_name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    idx[r.data_key][key] = { woba: r.woba, sample: r.sample_size };
  }
  return idx;
}

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

function processGameSignals(gameRow, wobaIdx, settings) {
  const game = {
    ...gameRow,
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
  };
  const model = runModel(game, wobaIdx, settings);
  const signals = getSignals(game, model, settings);
  // If lineup is projected (not yet confirmed), save as proj_model snapshot
  const isProjected = !gameRow.away_lineup_status || gameRow.away_lineup_status === 'projected';
  const hasProjSnapshot = gameRow.proj_model_away_ml != null;
  if (isProjected && !hasProjSnapshot) {
    // First time running with projected lineup — save snapshot
    db.prepare(`UPDATE game_log SET proj_model_away_ml=?, proj_model_home_ml=?, proj_model_total=?, model_away_ml=?, model_home_ml=?, model_total=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);
  } else {
    // Confirmed lineup (or proj snapshot already saved) — update current model only
    db.prepare(`UPDATE game_log SET model_away_ml=?, model_home_ml=?, model_total=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`)
      .run(model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);
  }
  const gl = q.getGameById.get(gameRow.game_date, gameRow.game_id);
  if (!gl) return;
  q.deleteSignalsForGame.run(gameRow.game_date, gameRow.game_id);
  for (const sig of signals) {
    const { outcome, pnl } = (gl.away_score != null)
      ? calcPnl({type:sig.type, side:sig.side, marketLine:sig.type==='ML'?(sig.side==='away'?gl.market_away_ml:gl.market_home_ml):gl.market_total, over_price:gl.over_price, under_price:gl.under_price}, gl.away_score, gl.home_score, gl.market_total)
      : { outcome: 'pending', pnl: 0 };
    q.insertSignal.run({
      game_log_id: gl.id,
      game_date: gameRow.game_date,
      game_id: gameRow.game_id,
      signal_type: sig.type,
      signal_side: sig.side,
      signal_label: sig.label,
      category: sig.category,
      market_line: sig.type === 'ML'
        ? (sig.side === 'away' ? gl.market_away_ml : gl.market_home_ml)
        : gl.market_total,
      model_line: sig.type === 'ML'
        ? (sig.side === 'away' ? model.aML : model.hML)
        : parseFloat(model.estTot.toFixed(2)),
      edge_pct: sig.edge,
      outcome,
      pnl,
    });
  }
  return { model, signals };
}

async function runLineupJob(dateStr) {
  dateStr = dateStr || todayET();
  console.log('[lineup-job] Starting for ' + dateStr);
  let gamesUpdated = 0;
  try {
    const result = await fetchLineups(dateStr);

    // Handle skipped cases: past date, date mismatch, future beyond tomorrow
    if (result && result.skipped) {
      console.log('[lineup-job] Skipped: ' + result.message);
      q.logCron.run('lineups', dateStr, 'skipped', result.message, 0);
      return { success: false, skipped: true, reason: result.reason, message: result.message, date: dateStr };
    }

    const games = Array.isArray(result) ? result : [];
  // Normalize team codes — fix common scraper mistakes
  const TEAM_NORM = {'WSH':'WAS','OAK':'ATH','CWS':'CWS'};
  for (const g of games) {
    if (TEAM_NORM[g.away_team]) g.away_team = TEAM_NORM[g.away_team];
    if (TEAM_NORM[g.home_team]) g.home_team = TEAM_NORM[g.home_team];
    // Recompute game_id after normalization
    g.game_id = (g.away_team + '-' + g.home_team).toLowerCase();
  }
  // Deduplicate by game_id (keep last)
  const seen = {}; for (const g of games) seen[g.game_id] = g;
  games.length = 0; Object.values(seen).forEach(g => games.push(g));
    if (!games.length) {
      q.logCron.run('lineups', dateStr, 'error', 'No games returned from scraper', 0);
      return { success: false, error: 'No games returned', date: dateStr };
    }

    const settings = getSettings();
    const wobaIdx = getWobaIndex();
    const updateLineup = db.prepare(
    `UPDATE game_log SET away_lineup_json=?, home_lineup_json=?, away_lineup_status=?, home_lineup_status=?, updated_at=datetime('now') WHERE game_date=? AND game_id=?`
  );

    for (const g of games) {
      const gameId = g.game_id || makeGameId(g.away_team, g.home_team);
      const awayLU = (g.away_lineup || []).map(b => ({ name: b.name, hand: b.hand }));
      const homeLU = (g.home_lineup || []).map(b => ({ name: b.name, hand: b.hand }));
      const existingRow = q.getGameById.get(dateStr, gameId);
        // Lock odds 10min before game start — only for TODAY's games, never future dates
        const todayForLock = new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
        if (existingRow && !existingRow.odds_locked_at && existingRow.game_time && dateStr === todayForLock) {
          const tm = existingRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
          if (tm) {
            let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
            if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
            const nowET=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
            const minsToGame=(h*60+mn)-(nowET.getHours()*60+nowET.getMinutes());
            if(minsToGame<=10&&minsToGame>=-240){
              db.prepare("UPDATE game_log SET odds_locked_at=datetime('now') WHERE game_date=? AND game_id=? AND odds_locked_at IS NULL").run(dateStr,gameId);
              console.log('[odds] Locked '+gameId+' ('+minsToGame+'min)');
              // Auto-set closing lines on any ML signals for this game
              const gameForClose = q.getGameById.get(dateStr, gameId);
              if (gameForClose) {
                const mlSigs = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type='ML' AND closing_line IS NULL").all(dateStr, gameId);
                for (const sig of mlSigs) {
                  const closingLine = sig.signal_side === 'away' ? gameForClose.market_away_ml : gameForClose.market_home_ml;
                  let clv = null;
                  if (sig.bet_line != null && closingLine != null) {
                    const isFav = sig.bet_line < 0;
                    clv = isFav ? (closingLine - sig.bet_line) : (sig.bet_line - closingLine);
                  }
                  db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closingLine, clv, sig.id);
                }
              }
            }
          }
        }
        q.upsertGame.run({
        game_date: dateStr,
        game_id: gameId,
        away_team: g.away_team,
        home_team: g.home_team,
        game_time: g.time || null,
        away_sp: g.away_sp && g.away_sp.name,
        away_sp_hand: g.away_sp && g.away_sp.hand,
        home_sp: g.home_sp && g.home_sp.name,
        home_sp_hand: g.home_sp && g.home_sp.hand,
        // Lineup job NEVER overwrites odds — only the odds job writes market lines
      market_away_ml: existingRow ? (existingRow.market_away_ml||null) : (g.market_away_ml||null),
      market_home_ml: existingRow ? (existingRow.market_home_ml||null) : (g.market_home_ml||null),
      market_total:   existingRow ? existingRow.market_total   : g.market_total,
      park_factor: g.park_factor || 1.0,
        model_away_ml: existingRow ? existingRow.model_away_ml : null,
        model_home_ml: existingRow ? existingRow.model_home_ml : null,
        model_total:   existingRow ? existingRow.model_total   : null,
        lineup_source: 'auto',
          away_lineup_status: g.away_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected'),
      home_lineup_status: g.home_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected'),
      lineup_status: g.lineup_status || 'projected',
      });
      const awayStatus = g.away_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected');
    const homeStatus = g.home_lineup_status || (g.lineup_status==='confirmed'?'confirmed':'projected');
    updateLineup.run(JSON.stringify(awayLU), JSON.stringify(homeLU), awayStatus, homeStatus, dateStr, gameId);
      // Clear zeros — treat 0 same as null for market odds
      db.prepare("UPDATE game_log SET market_away_ml=CASE WHEN market_away_ml=0 THEN NULL ELSE market_away_ml END, market_home_ml=CASE WHEN market_home_ml=0 THEN NULL ELSE market_home_ml END, market_total=CASE WHEN market_total=0 THEN NULL ELSE market_total END WHERE game_date=? AND game_id=?").run(dateStr, gameId);
      const gameRow = q.getGameById.get(dateStr, gameId);
      if (gameRow) {
        processGameSignals({
          ...gameRow,
          away_lineup_json: JSON.stringify(awayLU),
          home_lineup_json: JSON.stringify(homeLU),
        }, wobaIdx, settings);
        gamesUpdated++;
      }
    }

    q.logCron.run('lineups', dateStr, 'success', 'Pulled ' + games.length + ' games (date verified)', gamesUpdated);
    console.log('[lineup-job] Done — ' + gamesUpdated + ' games processed');
    return { success: true, gamesUpdated, date: dateStr };

  } catch (err) {
    console.error('[lineup-job] Error:', err.message);
    q.logCron.run('lineups', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

async function runScoreJob(dateStr) {
  dateStr = dateStr || yesterdayET();
  console.log('[score-job] Starting for ' + dateStr);
  let gamesUpdated = 0;
  try {
    const scores = await fetchScores(dateStr);
    for (const s of scores) {
      const gameId = s.gameId || makeGameId(s.away || s.away_team, s.home || s.home_team);
      q.updateScores.run({
        game_date: dateStr,
        game_id: gameId,
        away_score: s.awayScore ?? s.away_score,
        home_score: s.homeScore ?? s.home_score,
        scores_source: 'mlb-api',
      });
      const gameRow = db.prepare(`SELECT * FROM game_log WHERE game_date=? AND game_id=?`).get(dateStr, gameId);
      if (gameRow) {
        const signals = q.getSignalsByDate.all(dateStr).filter(sig => sig.game_id === gameId);
        const updateSignal = db.prepare(`UPDATE bet_signals SET outcome=?, pnl=? WHERE id=?`);
        for (const sig of signals) {
          const { outcome, pnl } = calcPnl(
            { type: sig.signal_type, side: sig.signal_side, marketLine: sig.market_line, bet_line: sig.bet_line },
            s.awayScore ?? s.away_score, s.homeScore ?? s.home_score, gameRow.market_total
          );
          updateSignal.run(outcome, pnl, sig.id);
        }
        gamesUpdated++;
      }
    }
    q.logCron.run('scores', dateStr, 'success', 'Updated ' + scores.length + ' scores', gamesUpdated);
    console.log('[score-job] Done — ' + gamesUpdated + ' games updated');
    return { success: true, gamesUpdated, date: dateStr };
  } catch (err) {
    console.error('[score-job] Error:', err.message);
    q.logCron.run('scores', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

function startCronJobs() {
  // Lineups: 8AM ET, hourly noon-6PM ET, 11PM ET (all free RotoWire scrapes)
  // UTC: 8AM ET=13:00, noon=17:00, 1PM=18:00, 2PM=19:00, 3PM=20:00, 4PM=21:00, 5PM=22:00, 6PM=23:00, 11PM=04:00
  [
    [13,'8AM ET'],[17,'Noon ET'],[18,'1PM ET'],[19,'2PM ET'],
    [20,'3PM ET'],[21,'4PM ET'],[22,'5PM ET'],[23,'6PM ET']
  ].forEach(([h,label]) => {
    cron.schedule('0 '+h+' * * *', () => {
      console.log('[cron] '+label+' lineup pull');
      runLineupJob(todayET());
    }, { timezone: 'UTC' });
  });
  cron.schedule('0 4 * * *', () => {
    console.log('[cron] 11PM ET lineup pull');
    runLineupJob(todayET());
  }, { timezone: 'UTC' });
  // Scores: 7 AM ET (12:00 UTC)
    // Odds: 4 automated pulls per day — 8AM, 11AM, 3PM, 5PM PT
  // 8AM PT=15:00 UTC, 11AM PT=18:00 UTC, 3PM PT=22:00 UTC, 5PM PT=00:00 UTC
  ['0 15 * * *','0 18 * * *','0 22 * * *','0 0 * * *'].forEach((schedule,i) => {
    const labels = ['8AM PT','11AM PT','3PM PT','5PM PT'];
    cron.schedule(schedule, () => {
      console.log('[cron] '+labels[i]+' odds pull');
      runOddsJob(todayET());
    }, { timezone: 'UTC' });
  });

  cron.schedule('0 11 * * *', () => {
    console.log('[cron] 4AM PT score pull');
    runScoreJob(yesterdayET());
  }, { timezone: 'UTC' });
  console.log('[cron] Jobs scheduled — lineups 8AM ET + hourly noon-6PM ET + 11PM ET');
}

function gameHasStarted(gameRow, gameDate) {
  // Returns true if game start time has passed (game is live or finished)
  // Only games on TODAY's date can have started
  const todayET = new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
  if (!gameRow || !gameRow.game_time) return false;
  if (gameDate && gameDate !== todayET) return false; // future/past dates never "in progress"
  const tm = gameRow.game_time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!tm) return false;
  let h=parseInt(tm[1]),mn=parseInt(tm[2]),ap=tm[3].toUpperCase();
  if(ap==='PM'&&h!==12)h+=12; if(ap==='AM'&&h===12)h=0;
  const nowET=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const minsToGame=(h*60+mn)-(nowET.getHours()*60+nowET.getMinutes());
  return minsToGame < -5; // started more than 5 min ago
}

async function runOddsJob(dateStr) {
  dateStr = dateStr || todayET();
  try {
    const settings = getSettings();
    const apiKey = q.getSetting.get('odds_api_key')?.value || process.env.ODDS_API_KEY || '';
    if (!apiKey) return { success: false, error: 'No Odds API key. Add it in Model settings.' };
    const odds = await fetchOddsAPI(apiKey, dateStr);
    const wobaIdx = getWobaIndex();
    let updated = 0;
    for (const o of odds) {
      // Skip if locked OR game has already started
      const existing = q.getGameById.get(dateStr, o.game_id);
      if (existing && existing.odds_locked_at) { console.log('[odds] Skipping locked: '+o.game_id); continue; }
      if (existing && gameHasStarted(existing, dateStr)) {
        // Lock it now to prevent future updates
        db.prepare("UPDATE game_log SET odds_locked_at=datetime('now') WHERE game_date=? AND game_id=? AND odds_locked_at IS NULL").run(dateStr, o.game_id);
        console.log('[odds] Skipping started game: '+o.game_id);
        // Auto-set closing lines on ML signals
        const mlSigsO = db.prepare("SELECT * FROM bet_signals WHERE game_date=? AND game_id=? AND signal_type='ML' AND closing_line IS NULL").all(dateStr, o.game_id);
        for (const sig of mlSigsO) {
          const closingLine = sig.signal_side === 'away' ? o.market_away_ml : o.market_home_ml;
          let clv = null;
          if (sig.bet_line != null && closingLine != null) {
            const isFav = sig.bet_line < 0;
            clv = isFav ? (closingLine - sig.bet_line) : (sig.bet_line - closingLine);
          }
          db.prepare("UPDATE bet_signals SET closing_line=?, clv=? WHERE id=?").run(closingLine, clv, sig.id);
        }
        continue;
      }
      db.prepare(`UPDATE game_log SET
        market_away_ml=?, market_home_ml=?, market_total=?,
        over_price=?, under_price=?, updated_at=datetime('now')
        WHERE game_date=? AND game_id=?`)
        .run(o.market_away_ml, o.market_home_ml, o.market_total,
             o.over_price, o.under_price, dateStr, o.game_id);
      const gameRow = q.getGameById.get(dateStr, o.game_id);
      if (gameRow) { processGameSignals(gameRow, wobaIdx, settings); updated++; }
    }
    return { success: true, updated, date: dateStr };
  } catch(err) {
    console.error('[odds-job]', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { runLineupJob, runScoreJob, runOddsJob, processGameSignals, getWobaIndex, getSettings, startCronJobs };
