/**
 * jobs.js — scheduled automation
 *
 * Lineup pull: 5:00 PM ET daily (22:00 UTC) — most lineups confirmed by then
 * Score pull:  7:00 AM ET daily (12:00 UTC) — all west coast games done
 *
 * Both jobs can also be triggered manually via the API.
 */

const cron = require('node-cron');
const { q, db } = require('../db/schema');
const { fetchLineups, fetchScores, makeGameId } = require('./scraper');
const { runModel, getSignals, calcPnl, buildWobaIndex } = require('./model');

// ── HELPERS ───────────────────────────────────────────────────────────────
function todayET() {
  // Get current date in US/Eastern time
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
  rows.forEach(r => { s[r.key] = parseFloat(r.value) || r.value; });
  return {
    RUN_MULT: s.run_mult || 48,
    HFA_BOOST: s.hfa_boost || 0.02,
    FAV_ADJ: s.fav_adj || 10,
    DOG_ADJ: s.dog_adj || 5,
    W_PIT: s.w_pit || 0.5,
    W_BAT: s.w_bat || 0.5,
    W_PROJ: s.w_proj || 0.65,
    W_ACT: s.w_act || 0.35,
    ML_VALUE_EDGE: s.ml_value_edge || 0.05,
    ML_LEAN_EDGE: s.ml_lean_edge || 0.02,
    TOT_VALUE_EDGE: s.tot_value_edge || 0.4,
    TOT_LEAN_EDGE: s.tot_lean_edge || 0.2,
  };
}

function getWobaIndex() {
  // Pull ALL woba data from DB and build lookup index
  const rows = db.prepare(`SELECT data_key, player_name, woba, sample_size FROM woba_data`).all();
  // buildWobaIndex expects array of {data_key, player_name, woba, sample_size}
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

// ── PROCESS SIGNALS FOR A GAME ────────────────────────────────────────────
function processGameSignals(gameRow, wobaIdx, settings) {
  // Build lineup arrays from the game's stored JSON or defaults
  const game = {
    ...gameRow,
    awayLineup: tryParse(gameRow.away_lineup_json) || [],
    homeLineup: tryParse(gameRow.home_lineup_json) || [],
  };

  const model = runModel(game, wobaIdx, settings);
  const signals = getSignals(game, model, settings);

  // Update model projections on the game record
  db.prepare(`
    UPDATE game_log SET
      model_away_ml = ?, model_home_ml = ?,
      model_total = ?, updated_at = datetime('now')
    WHERE game_date = ? AND game_id = ?
  `).run(model.aML, model.hML, parseFloat(model.estTot.toFixed(2)), gameRow.game_date, gameRow.game_id);

  // Get the game_log id
  const gl = q.getGameById.get(gameRow.game_date, gameRow.game_id);
  if (!gl) return;

  // Delete old signals for this game and reinsert
  q.deleteSignalsForGame.run(gameRow.game_date, gameRow.game_id);

  for (const sig of signals) {
    const { outcome, pnl } = (gl.away_score != null)
      ? calcPnl(sig, gl.away_score, gl.home_score, gl.market_total)
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
        : Math.round(model.estTot * 10),
      edge_pct: sig.edge,
      outcome,
      pnl,
    });
  }

  return { model, signals };
}

function tryParse(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

// ── JOB: PULL LINEUPS ─────────────────────────────────────────────────────
async function runLineupJob(dateStr) {
  dateStr = dateStr || todayET();
  console.log(`[lineup-job] Starting for ${dateStr}`);

  let gamesUpdated = 0;
  try {
    const games = await fetchLineups(dateStr);
    const settings = getSettings();
    const wobaIdx = getWobaIndex();

    const insertLineupJSON = db.prepare(`
      UPDATE game_log SET
        away_lineup_json = ?, home_lineup_json = ?, updated_at = datetime('now')
      WHERE game_date = ? AND game_id = ?
    `);

    for (const g of games) {
      const gameId = g.game_id || makeGameId(g.away_team, g.home_team);
      const awayLU = (g.away_lineup || []).map(b => ({ name: b.name, hand: b.hand }));
      const homeLU = (g.home_lineup || []).map(b => ({ name: b.name, hand: b.hand }));

      // Upsert game record
      q.upsertGame.run({
        game_date: dateStr,
        game_id: gameId,
        away_team: g.away_team,
        home_team: g.home_team,
        away_sp: g.away_sp?.name,
        away_sp_hand: g.away_sp?.hand,
        home_sp: g.home_sp?.name,
        home_sp_hand: g.home_sp?.hand,
        market_away_ml: g.market_away_ml,
        market_home_ml: g.market_home_ml,
        market_total: g.market_total,
        park_factor: g.park_factor || 1.0,
        model_away_ml: null,
        model_home_ml: null,
        model_total: null,
        lineup_source: 'auto',
      });

      // Store lineup JSON separately (not in upsert to avoid overwriting)
      insertLineupJSON.run(
        JSON.stringify(awayLU),
        JSON.stringify(homeLU),
        dateStr,
        gameId
      );

      // Run model and save signals
      const gameRow = q.getGameById.get(dateStr, gameId);
      if (gameRow) {
        processGameSignals({ ...gameRow, away_lineup_json: JSON.stringify(awayLU), home_lineup_json: JSON.stringify(homeLU) }, wobaIdx, settings);
        gamesUpdated++;
      }
    }

    q.logCron.run('lineups', dateStr, 'success', `Pulled ${games.length} games`, gamesUpdated);
    console.log(`[lineup-job] Done — ${gamesUpdated} games processed`);
    return { success: true, gamesUpdated, date: dateStr };

  } catch (err) {
    console.error('[lineup-job] Error:', err.message);
    q.logCron.run('lineups', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

// ── JOB: PULL SCORES ─────────────────────────────────────────────────────
async function runScoreJob(dateStr) {
  dateStr = dateStr || yesterdayET();
  console.log(`[score-job] Starting for ${dateStr}`);

  let gamesUpdated = 0;
  try {
    const scores = await fetchScores(dateStr);
    const settings = getSettings();
    const wobaIdx = getWobaIndex();

    for (const s of scores) {
      const gameId = makeGameId(s.away_team, s.home_team);

      // Update scores in game_log
      q.updateScores.run({
        game_date: dateStr,
        game_id: gameId,
        away_score: s.away_score,
        home_score: s.home_score,
        scores_source: 'rotowire',
      });

      // Recalculate signals with known outcomes
      const gameRow = db.prepare(`
        SELECT gl.*, gl.rowid FROM game_log gl WHERE game_date = ? AND game_id = ?
      `).get(dateStr, gameId);

      if (gameRow) {
        // Update signal outcomes
        const signals = q.getSignalsByDate.all(dateStr).filter(sig => sig.game_id === gameId);
        const updateSignal = db.prepare(`
          UPDATE bet_signals SET outcome = ?, pnl = ? WHERE id = ?
        `);

        for (const sig of signals) {
          const { outcome, pnl } = calcPnl(
            { type: sig.signal_type, side: sig.signal_side, marketLine: sig.market_line },
            s.away_score, s.home_score, gameRow.market_total
          );
          updateSignal.run(outcome, pnl, sig.id);
        }
        gamesUpdated++;
      }
    }

    q.logCron.run('scores', dateStr, 'success', `Updated ${scores.length} scores`, gamesUpdated);
    console.log(`[score-job] Done — ${gamesUpdated} games updated`);
    return { success: true, gamesUpdated, date: dateStr };

  } catch (err) {
    console.error('[score-job] Error:', err.message);
    q.logCron.run('scores', dateStr, 'error', err.message, 0);
    return { success: false, error: err.message, date: dateStr };
  }
}

// ── CRON SCHEDULER ────────────────────────────────────────────────────────
function startCronJobs() {
  // 5:00 PM Eastern = 22:00 UTC (21:00 UTC during EDT)
  // Using 22:00 UTC — covers both EST and EDT safely
  cron.schedule('0 17 ,22 * * *', () => {
    console.log('[cron] Triggering lineup pull');
    runLineupJob(todayET());
  }, { timezone: 'UTC' });

  // 7:00 AM Eastern = 12:00 UTC
  cron.schedule('0 12 * * *', () => {
    console.log('[cron] Triggering score pull for yesterday');
    runScoreJob(yesterdayET());
  }, { timezone: 'UTC' });

  console.log('[cron] Jobs scheduled — lineups at 17:00 and 22:00 UTC, scores at 12:00 UTC');
}

module.exports = {
  runLineupJob,
  runScoreJob,
  processGameSignals,
  getWobaIndex,
  getSettings,
  startCronJobs,
};
