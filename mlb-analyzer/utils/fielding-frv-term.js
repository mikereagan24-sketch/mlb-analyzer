'use strict';

// THE fielding-run-value team term. ONE implementation (2026-09-12).
//
// It existed three times -- services/jobs.js (production),
// services/frv-backtest.js and services/baserunning-backtest.js -- and the
// copies had already drifted: production applied the ingest's FRV_MIN_OUTS
// floor while both harnesses admitted any row with `outs_total > 0`, about
// 100x looser. That was inert only because the table currently holds no
// sub-floor rows, and harness-inputs.js wires calibration-ab.js to the
// LOOSE copy -- so the gate's own evidence came from a term production
// does not compute. Three copies, one of them feeding the gate, is exactly
// the shape CLAUDE.md's duplicate-implementation and producer-floor rules
// describe.
//
// WHAT THE TERM IS. For each non-catcher fielding slot in the posted
// lineup, take that player's FRV AT THE POSITION HE IS PLAYING TONIGHT,
// convert to a per-opportunity rate, and scale to a game's opportunities:
//
//     slot value = (total_runs / outs_total) * DEFENSE_FRV_OPPS_PER_GAME
//
// Catcher is excluded because catcher defence is the framing feature; DH
// and pitcher are excluded.
//
// THREE THINGS THAT CHANGED WITH THE (mlb_id, position) SPLIT:
//
// 1. SLOT MATCHING. The row is looked up by (player, tonight's position).
//    Before the split there was one summed row per player and the lookup
//    ignored position entirely, so 26.6% of resolved slots over a 30-day
//    window were scored with a row for a position the player was not
//    playing, 228 of them crossing infield<->outfield.
//
// 2. FALLBACK, LOGGED. If the player has no row at tonight's position --
//    a genuine first start there, or a position Savant has him under 200
//    innings at -- his biggest-sample row is used instead and the
//    substitution is reported. That is a real approximation and it should
//    be visible, not silent.
//
// 3. MISSING PLAYERS CONTRIBUTE NULL, NOT ZERO. A rookie with no FRV row
//    used to be skipped, which made the sum behave as if he were an exactly
//    average defender -- a substantive claim about a player we have no data
//    on. 6.9% of slots (372 in 30 days) were in that state, all of them
//    genuinely absent from Savant rather than name-resolution failures.
//    The term now returns the resolved slots' mean scaled to the full
//    fielding complement, i.e. it assumes the unknown fielders look like
//    this team's known ones rather than like the league.
//
// WARNINGS PRINT REGARDLESS OF THE FEATURE GATE. They used to be behind
// DEFENSE_FRV_ENABLED, which is off, so the 372 zero-contribution slots
// produced no output anywhere. A diagnostic that only speaks when the
// feature is already on cannot tell you whether to turn it on.

// Lineup position string -> Savant position code.
const POS_CODE = { '1B': '3', '2B': '4', '3B': '5', 'SS': '6', 'LF': '7', 'CF': '8', 'RF': '9' };
const DEFAULT_OPPS_PER_GAME = 25;

function tryParse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

// opts:
//   q            db/schema query object (needs getFieldingFrvByIdPos,
//                getFieldingFrvPrimary)
//   team         team abbreviation, for the name->id resolver
//   lineupJson   the posted lineup, raw JSON string or array
//   settings     reads DEFENSE_FRV_OPPS_PER_GAME
//   resolveId    (team, name) -> mlb_id
//   onWarn       optional (msg, detail) sink; defaults to console.warn
//   label        optional prefix for warnings (game id, usually)
//
// Returns { value, fielders, resolved, exact, fallback, missing, details }
// with value === null when nothing resolved.
function fieldingRunsPerGame(opts) {
  const o = opts || {};
  const q = o.q;
  const settings = o.settings || {};
  const arr = Array.isArray(o.lineupJson) ? o.lineupJson : (tryParse(o.lineupJson) || []);
  const warn = o.onWarn || ((m) => console.warn(m));
  const label = o.label ? (o.label + ' ') : '';
  const team = o.team || '';
  const out = { value: null, fielders: 0, resolved: 0, exact: 0, fallback: 0, missing: 0, details: [] };
  if (!q || !q.getFieldingFrvByIdPos || !arr.length) return out;

  const { FRV_MIN_OUTS } = require('../services/scraper');   // lazy: one definition, no cycle
  const oppsPerGame = settings.DEFENSE_FRV_OPPS_PER_GAME != null
    ? Number(settings.DEFENSE_FRV_OPPS_PER_GAME) : DEFAULT_OPPS_PER_GAME;

  let sum = 0;
  for (const p of arr) {
    const code = POS_CODE[String(p && p.pos || '').toUpperCase()];
    if (!code) continue;                       // C, DH, P, or unparseable
    out.fielders++;
    const mlbId = o.resolveId ? o.resolveId(team, p.name) : null;
    if (!mlbId) {
      out.missing++;
      out.details.push({ name: p.name, pos: p.pos, why: 'unresolved_name' });
      warn('[defense] ' + label + team + ': fielder "' + p.name + '" (' + p.pos
        + ') did not resolve to an mlb_id — contributes nothing');
      continue;
    }
    let row = q.getFieldingFrvByIdPos.get(mlbId, code);
    let usedFallback = false;
    if (!row) {
      row = q.getFieldingFrvPrimary ? q.getFieldingFrvPrimary.get(mlbId) : null;
      usedFallback = !!row;
    }
    if (!row || !row.outs_total || row.outs_total < FRV_MIN_OUTS) {
      out.missing++;
      const why = !row ? 'no_frv_row'
        : (!row.outs_total ? 'zero_outs' : 'below_floor');
      out.details.push({ name: p.name, pos: p.pos, mlb_id: mlbId, why: why, outs: row && row.outs_total });
      warn('[defense] ' + label + team + ': fielder "' + p.name + '" (' + p.pos + ', id ' + mlbId
        + ') ' + (why === 'below_floor'
          ? ('FRV sample ' + row.outs_total + ' outs is below the ingest floor of ' + FRV_MIN_OUTS
            + ' — skipped, not extrapolated')
          : 'has no usable FRV row — contributes nothing, and the team value is scaled over the '
            + 'slots that did resolve rather than treating him as average'));
      continue;
    }
    if (usedFallback) {
      out.fallback++;
      out.details.push({ name: p.name, pos: p.pos, mlb_id: mlbId, why: 'position_fallback',
        used_position: row.position, outs: row.outs_total });
      warn('[defense] ' + label + team + ': fielder "' + p.name + '" has no FRV row at ' + p.pos
        + ' (code ' + code + ') — falling back to his biggest-sample row, position '
        + row.position + ' (' + row.outs_total + ' outs)');
    } else {
      out.exact++;
    }
    sum += (row.total_runs / row.outs_total) * oppsPerGame;
    out.resolved++;
  }

  if (!out.resolved) return out;
  // Scale the resolved slots' mean to the full fielding complement. With
  // every slot resolved this is exactly the old sum; with 5 of 7 it is the
  // 5-slot mean times 7, rather than the 5-slot sum (which silently asserts
  // the other two are league-average).
  out.value = (sum / out.resolved) * out.fielders;
  return out;
}

// Thin wrapper matching the old three-copy signature, so call sites read
// the same as before and only the internals moved.
function teamFieldingRunsPerGame(q, team, lineupJson, settings, resolveId, label, onWarn) {
  return fieldingRunsPerGame({ q, team, lineupJson, settings, resolveId, label, onWarn }).value;
}

module.exports = { fieldingRunsPerGame, teamFieldingRunsPerGame, POS_CODE, DEFAULT_OPPS_PER_GAME };
