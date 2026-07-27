#!/usr/bin/env node
'use strict';

// One-shot backfill: populate sp_forecast_ip (+ n_priors, bulk, opener)
// for April-May 2026 game_log rows where they were left NULL because the
// forecaster landed mid-May.
//
// Also recomputes and persists *_sp_weight_used (game_log model columns
// only) so the persisted-value backtests aren't left stale. bet_signals
// is intentionally NOT touched — those are historical record and
// post-lock immutability applies.
//
// Scope: game_log rows with game_date BETWEEN 2026-04-01 AND 2026-05-31
// AND (away_sp_forecast_ip IS NULL OR home_sp_forecast_ip IS NULL).
//
// Reads settings, builds spStartIndex once, then for each row:
//   1. Resolve mlb_id for each SP name via rosterLookup / rosterByNorm
//      / abbreviation-fallback (mirrors services/jobs.js forecastForPitcher).
//   2. Call forecastSpIP for role='start' (and 'bulk'/'opener' where
//      the source name is populated).
//   3. UPDATE game_log with the resolved forecast + n_priors.
//   4. Recompute computeSpPitWeightFromForecast and UPDATE *_sp_weight_used.
//
// Emits a summary: rows scanned, rows updated, per-role resolution success,
// per-role null-reason breakdown (unresolved-name, index-fallback, etc).
//
// USAGE: node scripts/backfill-sp-forecast-ip-april-may.js
// USAGE: node scripts/backfill-sp-forecast-ip-april-may.js --dry-run

var q_db = require('../db/schema');
var db   = q_db.db;
var model = require('../services/model');
var jobs  = require('../services/jobs');
var utils = require('../utils/names');
var normName = utils.normName;
var stripSfx = utils.stripSfx;

var DRY_RUN = process.argv.indexOf('--dry-run') !== -1;
if (DRY_RUN) console.log('=== DRY RUN — no writes ===');
console.log('SP forecast_ip April-May 2026 backfill');
console.log('');

var settings = jobs.getSettings();
var spStartIndex = model.buildSpStartIndex(db, settings);
if (spStartIndex.buildError) {
  console.warn('[backfill] SP forecast index build failed: ' + spStartIndex.buildError + ' — abort');
  process.exit(1);
}

// Roster lookup — mirror services/jobs.js:1929-1952
var rosterLookup = db.prepare("SELECT mlb_id FROM team_rosters WHERE team=? AND player_name=?");
var rosterByNorm = new Map();
for (var row of db.prepare("SELECT team, player_name, mlb_id FROM team_rosters WHERE team IS NOT NULL AND player_name IS NOT NULL").all()) {
  var key = row.team + ':' + normName(row.player_name);
  if (!rosterByNorm.has(key)) rosterByNorm.set(key, row.mlb_id);
}
// Season-roster fallback for April-May (pitchers who since moved teams / were called up)
var rosterSeasonLookup = db.prepare("SELECT mlb_id FROM team_rosters_season WHERE team=? AND player_name=?");
var rosterSeasonByNorm = new Map();
for (var row2 of db.prepare("SELECT team, player_name, mlb_id FROM team_rosters_season WHERE team IS NOT NULL AND player_name IS NOT NULL").all()) {
  var key2 = row2.team + ':' + normName(row2.player_name);
  if (!rosterSeasonByNorm.has(key2)) rosterSeasonByNorm.set(key2, row2.mlb_id);
}

// forecastForPitcher — mirrors services/jobs.js 1970-2051, extended to also
// consult team_rosters_season on miss. Returns null on unresolved.
function forecastForPitcher(pitcherName, team, role, dateStr) {
  if (!pitcherName || !team) return { forecast: null, n_priors: null, reason: 'no-name-or-team' };
  var mlbId = null;
  var r = rosterLookup.get(team, pitcherName);
  if (r) mlbId = r.mlb_id;
  if (mlbId == null) {
    var key = team + ':' + normName(pitcherName);
    if (rosterByNorm.has(key)) mlbId = rosterByNorm.get(key);
  }
  // team_rosters_season fallback (historical roster; catches call-ups etc.)
  if (mlbId == null) {
    var r2 = rosterSeasonLookup.get(team, pitcherName);
    if (r2) mlbId = r2.mlb_id;
  }
  if (mlbId == null) {
    var key3 = team + ':' + normName(pitcherName);
    if (rosterSeasonByNorm.has(key3)) mlbId = rosterSeasonByNorm.get(key3);
  }
  // Abbreviation fallback (services/jobs.js:1996-2027 pattern)
  if (mlbId == null) {
    var norm = normName(pitcherName);
    var parts = norm.split(' ');
    var isAbbrev = parts.length >= 2 && parts[0].length === 1;
    if (isAbbrev) {
      var initial = parts[0];
      var last = parts[parts.length - 1];
      var prefix = team + ':';
      var matches = 0, matchId = null;
      // scan both maps
      for (var [k, v] of rosterByNorm.entries()) {
        if (!k.startsWith(prefix)) continue;
        var rn = k.slice(prefix.length);
        var p = stripSfx(rn).split(' ');
        if (p[p.length - 1] === last && p[0] && p[0][0] === initial) {
          matches++; matchId = v;
          if (matches > 1) break;
        }
      }
      if (matches !== 1) {
        matches = 0; matchId = null;
        for (var [k4, v4] of rosterSeasonByNorm.entries()) {
          if (!k4.startsWith(prefix)) continue;
          var rn4 = k4.slice(prefix.length);
          var p4 = stripSfx(rn4).split(' ');
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
  var out = model.forecastSpIP({
    index: spStartIndex,
    pitcherMlbId: mlbId,
    gameDate: dateStr,
    settings: settings,
    role: role || 'start',
  });
  if (out.source === 'fallback') return { forecast: null, n_priors: null, reason: 'index-fallback' };
  var nPriors = (out.components && out.components.total_clean_priors) || 0;
  return { forecast: out.forecast, n_priors: nPriors, reason: out.source };
}

// Scan
var scanRows = db.prepare(
  "SELECT game_date, game_id, away_team, home_team, away_sp, home_sp, " +
  "  bulk_guy_away, bulk_guy_home, is_opener_game_away, is_opener_game_home, " +
  "  away_sp_forecast_ip, home_sp_forecast_ip, " +
  "  away_sp_forecast_n_priors, home_sp_forecast_n_priors, " +
  "  away_bulk_forecast_ip, home_bulk_forecast_ip, " +
  "  away_opener_forecast_ip, home_opener_forecast_ip, " +
  "  away_sp_weight_used, home_sp_weight_used " +
  "FROM game_log " +
  "WHERE game_date >= '2026-04-01' AND game_date <= '2026-05-31'"
).all();

console.log('Scanning ' + scanRows.length + ' game_log rows in April-May 2026');
console.log('');

var stats = {
  scanned: 0,
  rows_needed_fill: 0,
  rows_updated: 0,
  sp_resolved: { away: 0, home: 0 },
  sp_unresolved: { away: 0, home: 0 },
  bulk_resolved: 0,
  opener_resolved: 0,
  unresolved_names: {},
  sp_weight_used_updates: 0,
};

// Track team from game_id (away-home format)
function teamsFromRow(r) {
  // Prefer explicit team columns if populated; else split game_id
  var away = r.away_team;
  var home = r.home_team;
  if (!away || !home) {
    var parts = (r.game_id || '').split('-');
    if (!away) away = (parts[0] || '').toUpperCase();
    if (!home) home = (parts[1] || '').toUpperCase();
  }
  return { away: away, home: home };
}

var updateSql = db.prepare(
  "UPDATE game_log SET " +
  "  away_sp_forecast_ip = COALESCE(?, away_sp_forecast_ip), " +
  "  home_sp_forecast_ip = COALESCE(?, home_sp_forecast_ip), " +
  "  away_sp_forecast_n_priors = COALESCE(?, away_sp_forecast_n_priors), " +
  "  home_sp_forecast_n_priors = COALESCE(?, home_sp_forecast_n_priors), " +
  "  away_bulk_forecast_ip = COALESCE(?, away_bulk_forecast_ip), " +
  "  home_bulk_forecast_ip = COALESCE(?, home_bulk_forecast_ip), " +
  "  away_opener_forecast_ip = COALESCE(?, away_opener_forecast_ip), " +
  "  home_opener_forecast_ip = COALESCE(?, home_opener_forecast_ip), " +
  "  away_sp_weight_used = COALESCE(?, away_sp_weight_used), " +
  "  home_sp_weight_used = COALESCE(?, home_sp_weight_used), " +
  "  updated_at = datetime('now') " +
  "WHERE game_date = ? AND game_id = ?"
);

var runTx = db.transaction(function (updates) {
  for (var u of updates) updateSql.run.apply(updateSql, u);
});

var batch = [];

for (var i = 0; i < scanRows.length; i++) {
  var r = scanRows[i];
  stats.scanned++;
  var needsFill = (r.away_sp_forecast_ip == null || r.home_sp_forecast_ip == null);
  if (!needsFill) continue;
  stats.rows_needed_fill++;

  var teams = teamsFromRow(r);

  var awayFc = null, awayNp = null, homeFc = null, homeNp = null;
  var awayBulk = null, homeBulk = null, awayOp = null, homeOp = null;
  var awaySpWU = null, homeSpWU = null;

  // Away SP forecast
  if (r.away_sp_forecast_ip == null && r.away_sp) {
    var a = forecastForPitcher(r.away_sp, teams.away, 'start', r.game_date);
    if (a.forecast != null) {
      awayFc = a.forecast; awayNp = a.n_priors;
      stats.sp_resolved.away++;
    } else {
      stats.sp_unresolved.away++;
      stats.unresolved_names[r.away_sp] = (stats.unresolved_names[r.away_sp] || 0) + 1;
    }
  }
  // Home SP forecast
  if (r.home_sp_forecast_ip == null && r.home_sp) {
    var h = forecastForPitcher(r.home_sp, teams.home, 'start', r.game_date);
    if (h.forecast != null) {
      homeFc = h.forecast; homeNp = h.n_priors;
      stats.sp_resolved.home++;
    } else {
      stats.sp_unresolved.home++;
      stats.unresolved_names[r.home_sp] = (stats.unresolved_names[r.home_sp] || 0) + 1;
    }
  }
  // Bulk / opener — only where the announced name is present
  if (r.away_bulk_forecast_ip == null && r.bulk_guy_away) {
    var ab = forecastForPitcher(r.bulk_guy_away, teams.away, 'bulk', r.game_date);
    if (ab.forecast != null) { awayBulk = ab.forecast; stats.bulk_resolved++; }
  }
  if (r.home_bulk_forecast_ip == null && r.bulk_guy_home) {
    var hb = forecastForPitcher(r.bulk_guy_home, teams.home, 'bulk', r.game_date);
    if (hb.forecast != null) { homeBulk = hb.forecast; stats.bulk_resolved++; }
  }
  if (r.away_opener_forecast_ip == null && r.away_sp && r.is_opener_game_away) {
    var ao = forecastForPitcher(r.away_sp, teams.away, 'opener', r.game_date);
    if (ao.forecast != null) { awayOp = ao.forecast; stats.opener_resolved++; }
  }
  if (r.home_opener_forecast_ip == null && r.home_sp && r.is_opener_game_home) {
    var ho = forecastForPitcher(r.home_sp, teams.home, 'opener', r.game_date);
    if (ho.forecast != null) { homeOp = ho.forecast; stats.opener_resolved++; }
  }

  // Recompute *_sp_weight_used using the same formula runModel uses:
  // computeSpPitWeightFromForecast(forecast_ip, settings, n_priors).
  // If we just backfilled a forecast_ip, compute the new sp_weight_used
  // and persist it (overrides the stale 0.62 low-conf value). This is
  // ONLY for standard non-opener games — for opener/bulk/bullpen games
  // the *_weight_used columns are computed differently and left alone.
  if (!r.is_opener_game_away) {
    var fc_a = awayFc != null ? awayFc : r.away_sp_forecast_ip;
    var np_a = awayNp != null ? awayNp : r.away_sp_forecast_n_priors;
    if (fc_a != null) {
      var newSW = model.computeSpPitWeightFromForecast(fc_a, settings, np_a);
      if (newSW != null && (r.away_sp_weight_used == null || Math.abs(newSW - r.away_sp_weight_used) > 0.001)) {
        awaySpWU = newSW;
        stats.sp_weight_used_updates++;
      }
    }
  }
  if (!r.is_opener_game_home) {
    var fc_h = homeFc != null ? homeFc : r.home_sp_forecast_ip;
    var np_h = homeNp != null ? homeNp : r.home_sp_forecast_n_priors;
    if (fc_h != null) {
      var newSW2 = model.computeSpPitWeightFromForecast(fc_h, settings, np_h);
      if (newSW2 != null && (r.home_sp_weight_used == null || Math.abs(newSW2 - r.home_sp_weight_used) > 0.001)) {
        homeSpWU = newSW2;
        stats.sp_weight_used_updates++;
      }
    }
  }

  // Any change to persist?
  var anyChange = awayFc != null || homeFc != null || awayBulk != null || homeBulk != null
                || awayOp != null || homeOp != null || awaySpWU != null || homeSpWU != null;
  if (anyChange) {
    batch.push([awayFc, homeFc, awayNp, homeNp, awayBulk, homeBulk, awayOp, homeOp, awaySpWU, homeSpWU, r.game_date, r.game_id]);
    stats.rows_updated++;
  }

  if ((i + 1) % 100 === 0) {
    process.stdout.write('\r  processed ' + (i+1) + '/' + scanRows.length);
  }
}
process.stdout.write('\r  processed ' + scanRows.length + '/' + scanRows.length + '\n\n');

if (!DRY_RUN && batch.length > 0) {
  runTx(batch);
  console.log('WROTE ' + batch.length + ' row updates in transaction');
} else if (DRY_RUN) {
  console.log('DRY RUN — would have written ' + batch.length + ' row updates');
}
console.log('');

console.log('=== SUMMARY ===');
console.log('  Rows scanned:            ' + stats.scanned);
console.log('  Rows needing fill:       ' + stats.rows_needed_fill);
console.log('  Rows updated:            ' + stats.rows_updated);
console.log('  SP forecast resolved:    away=' + stats.sp_resolved.away + ' home=' + stats.sp_resolved.home);
console.log('  SP forecast unresolved:  away=' + stats.sp_unresolved.away + ' home=' + stats.sp_unresolved.home);
console.log('  Bulk forecasts resolved:   ' + stats.bulk_resolved);
console.log('  Opener forecasts resolved: ' + stats.opener_resolved);
console.log('  sp_weight_used recomputed: ' + stats.sp_weight_used_updates);

var topUnresolved = Object.entries(stats.unresolved_names).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 20);
if (topUnresolved.length > 0) {
  console.log('');
  console.log('  Top unresolved SP names (name × games):');
  topUnresolved.forEach(function (kv) { console.log('    ' + kv[0] + ' × ' + kv[1]); });
}

console.log('');
console.log('=== DONE ===');
