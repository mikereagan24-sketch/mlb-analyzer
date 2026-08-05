'use strict';

// Backfill task: sp_forecast_ip (+ n_priors, bulk, opener) for game_log
// rows in a date window where the forecaster was still off/late.
//
// Ported from scripts/backfill-sp-forecast-ip-april-may.js so the same
// resolver + write shape runs inside the Render container (which has
// prod-writable DB), keyed by a caller-supplied {from, to} window
// instead of hardcoded April-May.
//
// Also recomputes and persists *_sp_weight_used (game_log model
// columns only) so the persisted-value backtests aren't left stale.
// bet_signals is intentionally NOT touched — those are historical
// record and post-lock immutability applies (per CLAUDE.md).
//
// Idempotency: WHERE filters restrict the scan to rows where the target
// column IS NULL (per side), and the UPDATE uses COALESCE so an
// already-populated cell is never overwritten. Re-running the same
// window is a no-op on the second pass.

const { registerBackfillTask, assertDateRange } = require('../backfill-jobs');

registerBackfillTask({
  name: 'sp_forecast_ip',
  run: async function ({ db, params, dryRun, onProgress }) {
    assertDateRange(params);

    // Lazy-require to sidestep the circular that would happen if
    // services/jobs.js ever ended up requiring backfill-jobs.js
    // (it currently doesn't, but the pattern is defensive).
    const model = require('../model');
    const jobs  = require('../jobs');
    const { normName, stripSfx } = require('../../utils/names');

    const settings = jobs.getSettings();
    const spStartIndex = model.buildSpStartIndex(db, settings);
    if (spStartIndex.buildError) {
      throw new Error('SP forecast index build failed: ' + spStartIndex.buildError);
    }

    // Roster lookup — mirrored from the one-shot script.
    const rosterLookup = db.prepare("SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?");
    const rosterByNorm = new Map();
    for (const row of db.prepare(
      "SELECT team, player_name, mlb_id FROM team_rosters WHERE team IS NOT NULL AND player_name IS NOT NULL"
    ).all()) {
      const key = row.team + ':' + normName(row.player_name);
      if (!rosterByNorm.has(key)) rosterByNorm.set(key, row.mlb_id);
    }
    const rosterSeasonLookup = db.prepare(
      "SELECT mlb_id FROM team_rosters_season WHERE team=? AND player_name=?"
    );
    const rosterSeasonByNorm = new Map();
    for (const row of db.prepare(
      "SELECT team, player_name, mlb_id FROM team_rosters_season WHERE team IS NOT NULL AND player_name IS NOT NULL"
    ).all()) {
      const key = row.team + ':' + normName(row.player_name);
      if (!rosterSeasonByNorm.has(key)) rosterSeasonByNorm.set(key, row.mlb_id);
    }

    function forecastForPitcher(pitcherName, team, role, dateStr) {
      if (!pitcherName || !team) return { forecast: null, n_priors: null, reason: 'no-name-or-team' };
      let mlbId = null;
      const r = rosterLookup.get(team, pitcherName);
      if (r) mlbId = r.mlb_id;
      if (mlbId == null) {
        const key = team + ':' + normName(pitcherName);
        if (rosterByNorm.has(key)) mlbId = rosterByNorm.get(key);
      }
      if (mlbId == null) {
        const r2 = rosterSeasonLookup.get(team, pitcherName);
        if (r2) mlbId = r2.mlb_id;
      }
      if (mlbId == null) {
        const key = team + ':' + normName(pitcherName);
        if (rosterSeasonByNorm.has(key)) mlbId = rosterSeasonByNorm.get(key);
      }
      if (mlbId == null) {
        // Abbreviation fallback (services/jobs.js:1996-2027 pattern).
        const norm = normName(pitcherName);
        const parts = norm.split(' ');
        const isAbbrev = parts.length >= 2 && parts[0].length === 1;
        if (isAbbrev) {
          const initial = parts[0];
          const last = parts[parts.length - 1];
          const prefix = team + ':';
          let matches = 0, matchId = null;
          for (const [k, v] of rosterByNorm.entries()) {
            if (!k.startsWith(prefix)) continue;
            const rn = k.slice(prefix.length);
            const p = stripSfx(rn).split(' ');
            if (p[p.length - 1] === last && p[0] && p[0][0] === initial) {
              matches++; matchId = v;
              if (matches > 1) break;
            }
          }
          if (matches !== 1) {
            matches = 0; matchId = null;
            for (const [k4, v4] of rosterSeasonByNorm.entries()) {
              if (!k4.startsWith(prefix)) continue;
              const rn4 = k4.slice(prefix.length);
              const p4 = stripSfx(rn4).split(' ');
              if (p4[p4.length - 1] === last && p4[0] && p4[0][0] === initial) {
                matches++; matchId = v4;
                if (matches > 1) break;
              }
            }
          }
          if (matches === 1) mlbId = matchId;
        }
      }
      if (mlbId == null) return { forecast: null, n_priors: null, reason: 'unresolved-name' };
      const out = model.forecastSpIP({
        index: spStartIndex,
        pitcherMlbId: mlbId,
        gameDate: dateStr,
        settings: settings,
        role: role || 'start',
      });
      if (out.source === 'fallback') return { forecast: null, n_priors: null, reason: 'index-fallback' };
      const nPriors = (out.components && out.components.total_clean_priors) || 0;
      return { forecast: out.forecast, n_priors: nPriors, reason: out.source };
    }

    const scanRows = db.prepare(
      "SELECT game_date, game_id, away_team, home_team, away_sp, home_sp, "
      + "  bulk_guy_away, bulk_guy_home, is_opener_game_away, is_opener_game_home, "
      + "  away_sp_forecast_ip, home_sp_forecast_ip, "
      + "  away_sp_forecast_n_priors, home_sp_forecast_n_priors, "
      + "  away_bulk_forecast_ip, home_bulk_forecast_ip, "
      + "  away_opener_forecast_ip, home_opener_forecast_ip, "
      + "  away_sp_weight_used, home_sp_weight_used "
      + "FROM game_log "
      + "WHERE game_date >= ? AND game_date <= ?"
    ).all(params.from, params.to);

    const stats = {
      scanned: 0,
      rows_needed_fill: 0,
      rows_updated: 0,
      sp_resolved: { away: 0, home: 0 },
      sp_unresolved: { away: 0, home: 0 },
      bulk_resolved: 0,
      opener_resolved: 0,
      sp_weight_used_updates: 0,
    };
    const unresolvedNames = Object.create(null);

    function teamsFromRow(r) {
      let away = r.away_team, home = r.home_team;
      if (!away || !home) {
        const parts = (r.game_id || '').split('-');
        if (!away) away = (parts[0] || '').toUpperCase();
        if (!home) home = (parts[1] || '').toUpperCase();
      }
      return { away: away, home: home };
    }

    const updateSql = db.prepare(
      "UPDATE game_log SET "
      + "  away_sp_forecast_ip = COALESCE(?, away_sp_forecast_ip), "
      + "  home_sp_forecast_ip = COALESCE(?, home_sp_forecast_ip), "
      + "  away_sp_forecast_n_priors = COALESCE(?, away_sp_forecast_n_priors), "
      + "  home_sp_forecast_n_priors = COALESCE(?, home_sp_forecast_n_priors), "
      + "  away_bulk_forecast_ip = COALESCE(?, away_bulk_forecast_ip), "
      + "  home_bulk_forecast_ip = COALESCE(?, home_bulk_forecast_ip), "
      + "  away_opener_forecast_ip = COALESCE(?, away_opener_forecast_ip), "
      + "  home_opener_forecast_ip = COALESCE(?, home_opener_forecast_ip), "
      + "  away_sp_weight_used = COALESCE(?, away_sp_weight_used), "
      + "  home_sp_weight_used = COALESCE(?, home_sp_weight_used), "
      + "  updated_at = datetime('now') "
      + "WHERE game_date = ? AND game_id = ?"
    );
    const runTx = db.transaction(function (updates) {
      for (const u of updates) updateSql.run.apply(updateSql, u);
    });

    const batch = [];
    for (let i = 0; i < scanRows.length; i++) {
      const r = scanRows[i];
      stats.scanned++;
      const needsFill = (r.away_sp_forecast_ip == null || r.home_sp_forecast_ip == null);
      if (!needsFill) continue;
      stats.rows_needed_fill++;

      const teams = teamsFromRow(r);
      let awayFc = null, awayNp = null, homeFc = null, homeNp = null;
      let awayBulk = null, homeBulk = null, awayOp = null, homeOp = null;
      let awaySpWU = null, homeSpWU = null;

      if (r.away_sp_forecast_ip == null && r.away_sp) {
        const a = forecastForPitcher(r.away_sp, teams.away, 'start', r.game_date);
        if (a.forecast != null) { awayFc = a.forecast; awayNp = a.n_priors; stats.sp_resolved.away++; }
        else { stats.sp_unresolved.away++; unresolvedNames[r.away_sp] = (unresolvedNames[r.away_sp] || 0) + 1; }
      }
      if (r.home_sp_forecast_ip == null && r.home_sp) {
        const h = forecastForPitcher(r.home_sp, teams.home, 'start', r.game_date);
        if (h.forecast != null) { homeFc = h.forecast; homeNp = h.n_priors; stats.sp_resolved.home++; }
        else { stats.sp_unresolved.home++; unresolvedNames[r.home_sp] = (unresolvedNames[r.home_sp] || 0) + 1; }
      }
      if (r.away_bulk_forecast_ip == null && r.bulk_guy_away) {
        const ab = forecastForPitcher(r.bulk_guy_away, teams.away, 'bulk', r.game_date);
        if (ab.forecast != null) { awayBulk = ab.forecast; stats.bulk_resolved++; }
      }
      if (r.home_bulk_forecast_ip == null && r.bulk_guy_home) {
        const hb = forecastForPitcher(r.bulk_guy_home, teams.home, 'bulk', r.game_date);
        if (hb.forecast != null) { homeBulk = hb.forecast; stats.bulk_resolved++; }
      }
      if (r.away_opener_forecast_ip == null && r.away_sp && r.is_opener_game_away) {
        const ao = forecastForPitcher(r.away_sp, teams.away, 'opener', r.game_date);
        if (ao.forecast != null) { awayOp = ao.forecast; stats.opener_resolved++; }
      }
      if (r.home_opener_forecast_ip == null && r.home_sp && r.is_opener_game_home) {
        const ho = forecastForPitcher(r.home_sp, teams.home, 'opener', r.game_date);
        if (ho.forecast != null) { homeOp = ho.forecast; stats.opener_resolved++; }
      }

      // Recompute *_sp_weight_used only for standard non-opener games —
      // opener/bulk/bullpen games compute their weight differently.
      if (!r.is_opener_game_away) {
        const fc_a = awayFc != null ? awayFc : r.away_sp_forecast_ip;
        const np_a = awayNp != null ? awayNp : r.away_sp_forecast_n_priors;
        if (fc_a != null) {
          const newSW = model.computeSpPitWeightFromForecast(fc_a, settings, np_a);
          if (newSW != null && (r.away_sp_weight_used == null || Math.abs(newSW - r.away_sp_weight_used) > 0.001)) {
            awaySpWU = newSW; stats.sp_weight_used_updates++;
          }
        }
      }
      if (!r.is_opener_game_home) {
        const fc_h = homeFc != null ? homeFc : r.home_sp_forecast_ip;
        const np_h = homeNp != null ? homeNp : r.home_sp_forecast_n_priors;
        if (fc_h != null) {
          const newSW = model.computeSpPitWeightFromForecast(fc_h, settings, np_h);
          if (newSW != null && (r.home_sp_weight_used == null || Math.abs(newSW - r.home_sp_weight_used) > 0.001)) {
            homeSpWU = newSW; stats.sp_weight_used_updates++;
          }
        }
      }

      const anyChange = awayFc != null || homeFc != null || awayBulk != null || homeBulk != null
                     || awayOp != null || homeOp != null || awaySpWU != null || homeSpWU != null;
      if (anyChange) {
        batch.push([awayFc, homeFc, awayNp, homeNp, awayBulk, homeBulk, awayOp, homeOp, awaySpWU, homeSpWU, r.game_date, r.game_id]);
        stats.rows_updated++;
      }

      if ((i + 1) % 100 === 0) {
        onProgress({
          phase: 'scanning',
          processed: i + 1,
          total: scanRows.length,
          rows_updated_so_far: stats.rows_updated,
        });
      }
    }

    let wrote = 0;
    if (!dryRun && batch.length > 0) {
      runTx(batch);
      wrote = batch.length;
    }

    const topUnresolved = Object.entries(unresolvedNames)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, games: count }));

    return {
      task: 'sp_forecast_ip',
      dry_run: dryRun,
      window: { from: params.from, to: params.to },
      scanned: stats.scanned,
      rows_needed_fill: stats.rows_needed_fill,
      rows_would_update: stats.rows_updated,   // projected count (same whether dry or live)
      rows_written: wrote,                      // 0 on dry_run
      sp_resolved: stats.sp_resolved,
      sp_unresolved: stats.sp_unresolved,
      bulk_forecasts_resolved: stats.bulk_resolved,
      opener_forecasts_resolved: stats.opener_resolved,
      sp_weight_used_updates: stats.sp_weight_used_updates,
      top_unresolved_names: topUnresolved,
    };
  },
});
