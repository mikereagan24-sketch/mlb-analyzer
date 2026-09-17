'use strict';
/**
 * Caller-populated model inputs, in one place. (2026-08-22)
 *
 * THE PROBLEM THIS EXISTS TO STOP.
 * runModel() reads several fields off `game` that it does not compute.
 * In production jobs.js populates them before calling. Offline harnesses
 * build their own corpora via parameter-sweep.preScreenGame(), which
 * does NOT populate them -- so every such field silently arrives
 * `undefined` and the feature reading it is inert.
 *
 * That has now produced two false negatives:
 *   - DEFENSE_FRV_ENABLED reported 0/790 games changed ("FRV does
 *     nothing, leave it off forever") -- the opposite of the truth.
 *   - CATCHER_FRAMING_MUTE reported 0/790 ("the flag is inert").
 *
 * and one silent contamination: four standalone harnesses
 * (edge-honesty-scope, component-signal-diagnostic,
 * projected-vs-closing-calibration, calibration-sweep) scored a model
 * missing BOTH defensive inputs, so their absolute figures describe a
 * model that has never run in production.
 *
 * Patching each script separately is what produced five copies of
 * computeFramingRvPerGame. One helper, used by every harness, is the
 * only version of this fix that stays fixed.
 *
 * KEEP IN SYNC with the population block in services/jobs.js (~636-866).
 * If runModel starts reading a new caller-populated field, it goes in
 * FIELD_SOURCES below; scripts/test-harness-inputs-sources.js derives the
 * required set from runModel's own reads and fails when one is missing.
 */

let _frvForTeam = () => null;
let _frvDetailForTeam = null;
let _framingForTeam = () => null;
try {
  const fb = require('./frv-backtest');
  _frvForTeam = fb.computeTeamFieldingRunsPerGame || _frvForTeam;
  _frvDetailForTeam = fb.computeTeamFieldingRunsDetail || null;
  _framingForTeam = fb.computeFramingRvPerGame || _framingForTeam;
} catch (e) { /* harness still runs; populate() reports zero coverage */ }

// ── FRV READ MODE (2026-09-14) ─────────────────────────────────────────
//
// A harness replaying a past game must read the FRV that existed THEN.
// Until now every harness read current state, so a June game was priced
// with FRV that already knew how those fielders turned out; the horizon
// was 96-116 days in W1 of the 2026 season run. Production is unchanged
// and still reads current state, which for tonight IS the as-of value.
//
// THIS DEFAULT CHANGES EVERY HARNESS NUMBER, so the mode is echoed the
// way WEATHER_FILTER is: a delta quoted without its FRV vintage is not
// reproducible, and "asof" vs "current" is a regime boundary in the same
// sense as the 2026-08-05 weather boundary.
//
//   FRV_READ=asof              (default) snapshot as of each game date
//   FRV_READ=current           the pre-2026-09-14 behaviour, for comparison
//   FRV_READ=asof:YYYY-MM-DD   every game at ONE vintage. This is the
//                              hindsight-isolating arm: hold the term and
//                              the row set fixed, vary only the date.
//
// An unrecognised value THROWS rather than falling through to a default,
// because silently scoring current-state while the operator believes it is
// as-of is the exact failure this switch exists to make visible.
const _FRV_ASOF_DATE_RE = /^asof:(\d{4}-\d{2}-\d{2})$/;
function frvReadMode() {
  const v = String(process.env.FRV_READ || 'asof').trim().toLowerCase();
  if (v === 'current') return { mode: 'current', pinned: null };
  if (v === 'asof') return { mode: 'asof', pinned: null };
  const m = v.match(_FRV_ASOF_DATE_RE);
  if (m) return { mode: 'asof-pinned', pinned: m[1] };
  throw new Error('FRV_READ must be "asof", "current" or "asof:YYYY-MM-DD"; got "' + v + '"');
}

// Accumulated across a corpus build so a harness can print it. Reset by
// resetFrvAsOfStats() if a script builds more than one corpus.
let _frvStats = { sides: 0, asofMissing: 0, vintages: {} };
function resetFrvAsOfStats() { _frvStats = { sides: 0, asofMissing: 0, vintages: {} }; }
function frvAsOfStats() { return _frvStats; }
function frvAsOfLine() {
  const m = frvReadMode();
  let s = 'FRV read: ' + m.mode + (m.pinned ? ' @ ' + m.pinned : '');
  if (m.mode === 'current') return s + '   *** CURRENT STATE = HINDSIGHT for any past game ***';
  s += '   sides ' + _frvStats.sides + ', slots with no snapshot <= date (resolved MISSING) '
     + _frvStats.asofMissing;
  const vs = Object.keys(_frvStats.vintages).sort();
  if (vs.length) s += ', vintages ' + vs[0] + '..' + vs[vs.length - 1];
  return s;
}

// ── HARNESS INPUT MODE (2026-09-16) ────────────────────────────────────
//
// THIS IS A RE-BASELINE EVENT FOR EVERY HARNESS NUMBER. Until 2026-09-16
// populateCallerInputs set 4 of the 21 fields below -- FRV (as-of) and
// framing (RECOMPUTED from today's catcher_framing table). The bullpen
// term arrived undefined, so every calibration harness priced both
// bullpens at the league constant on both arms.
//
// MEASURED 2026-09-16, DEFENSE_FRV_ENABLED false/true, 2026-06-01..08-07,
// weather valid, FRV asof, 658 games, per arm (OFF / ON):
//
//   legacy              log loss 0.69010 / 0.68921   edge slope +0.009 / +0.130
//   + bullpen           log loss 0.68917 / 0.68848   edge slope +0.063 / +0.191
//   + framing persisted log loss 0.68972 / 0.68880   edge slope +0.061 / +0.180
//   + all four groups   log loss 0.68874 / 0.68800   edge slope +0.125 / +0.250
//   persisted (default) log loss 0.68877 / 0.68803   edge slope +0.120 / +0.245
//
// Opener and tandem reproduce legacy to every printed digit. The default
// differs from "all four groups" on exactly 46 games (92 of 92 differing
// game-arm pairs, 0 unexplained): 47 framing sides where emit recorded a
// state and a NULL rv. The group injection kept the recompute there; the
// default keeps the NULL production actually priced with. The level moves
// by more than most deltas this harness is asked to resolve, so numbers
// recorded under the old harness are about a different model, and the
// registry rows that quote them carry `evidence_predates`
// (services/feature-gate-registry.js).
// Re-run: node --max-old-space-size=1536 scripts/calibration-ab-inputs.js <none|bullpen|framing|all> DEFENSE_FRV_ENABLED false true 2026-06-01 2026-08-07
//
//   HARNESS_INPUTS=persisted  (default) every field with a persisted
//                             emit-time source is read FROM that source
//   HARNESS_INPUTS=legacy     the pre-2026-09-16 4-field harness, exactly.
//                             Use it to reproduce a figure recorded before
//                             the re-baseline, never for a new measurement.
//
// Echoed beside the FRV read and the weather filter, for the same reason:
// a number quoted without it is not reproducible. An unrecognised value
// THROWS.
function harnessInputsMode() {
  const v = String(process.env.HARNESS_INPUTS || 'persisted').trim().toLowerCase();
  if (v === 'persisted' || v === 'legacy') return v;
  throw new Error('HARNESS_INPUTS must be "persisted" or "legacy"; got "' + v + '"');
}

/**
 * The fields runModel reads but never computes -- all 21 of them, each with
 * where an offline replay gets it. Anything listed here is a field whose
 * absence silently disables a feature rather than raising.
 *
 *   column       game_log column holding the value the model used at emit.
 *                processGameSignals overwrites it on every scoring pass, so
 *                it is the LAST emit-time value, the same semantics the
 *                bullpen replay has used since 2026-09-03.
 *   stateColumn  framing only: non-null means the emit pass ran and wrote
 *                the rv, so a NULL rv beside it is a real "no framing"
 *                (no_roster_match / no_framing_data) and is kept as NULL.
 *   unavailable  no emit-time source exists. Left undefined and reported.
 *
 * OPENER AND TANDEM ARE ALREADY CARRIED. preScreenGame spreads the whole
 * game_log row, so these snake_case columns reached runModel before this
 * change too: over 2026-06-01..08-07 injecting them changed 0 values on 658
 * games. They are listed so the table is complete and so a harness that
 * does not start from a row spread still gets them.
 */
const FIELD_SOURCES = [
  { field: 'awayFieldingRunsPerGame', group: 'frv', source: 'fielding_frv_snapshot as of game_date (FRV_READ)' },
  { field: 'homeFieldingRunsPerGame', group: 'frv', source: 'fielding_frv_snapshot as of game_date (FRV_READ)' },
  { field: 'awayCatcherFramingRvPerGame', group: 'framing', column: 'away_catcher_framing_rv_per_game',
    stateColumn: 'away_catcher_framing_state' },
  { field: 'homeCatcherFramingRvPerGame', group: 'framing', column: 'home_catcher_framing_rv_per_game',
    stateColumn: 'home_catcher_framing_state' },
  { field: 'awayBullpenWoba', group: 'bullpen', column: 'away_bullpen_woba' },
  { field: 'awayBullpenVsL',  group: 'bullpen', column: 'away_bullpen_woba_vs_l' },
  { field: 'awayBullpenVsR',  group: 'bullpen', column: 'away_bullpen_woba_vs_r' },
  { field: 'homeBullpenWoba', group: 'bullpen', column: 'home_bullpen_woba' },
  { field: 'homeBullpenVsL',  group: 'bullpen', column: 'home_bullpen_woba_vs_l' },
  { field: 'homeBullpenVsR',  group: 'bullpen', column: 'home_bullpen_woba_vs_r' },
  { field: 'away_opener_forecast_ip', group: 'opener', column: 'away_opener_forecast_ip' },
  { field: 'home_opener_forecast_ip', group: 'opener', column: 'home_opener_forecast_ip' },
  { field: 'away_bulk_forecast_ip',   group: 'opener', column: 'away_bulk_forecast_ip' },
  { field: 'home_bulk_forecast_ip',   group: 'opener', column: 'home_bulk_forecast_ip' },
  { field: 'bulk_guy_away',           group: 'opener', column: 'bulk_guy_away' },
  { field: 'bulk_guy_home',           group: 'opener', column: 'bulk_guy_home' },
  { field: 'tandem_subtype_away', group: 'tandem', column: 'tandem_subtype_away' },
  { field: 'tandem_subtype_home', group: 'tandem', column: 'tandem_subtype_home' },
  { field: 'awayRosterSet', group: 'roster', unavailable: 'built from the live team_rosters table, '
      + 'which holds TODAY state and is not snapshotted per game date; nothing persists the set' },
  { field: 'homeRosterSet', group: 'roster', unavailable: 'built from the live team_rosters table, '
      + 'which holds TODAY state and is not snapshotted per game date; nothing persists the set' },
  { field: 'bullpenAvailability', group: 'availability', unavailable: 'derived at emit time from '
      + 'recent pitcher usage and never written to game_log' },
];
const CALLER_POPULATED_FIELDS = FIELD_SOURCES.map(f => f.field);
const INPUT_GROUPS = [...new Set(FIELD_SOURCES.map(f => f.group))];

// Per-source counters for the echo line. Reset with resetHarnessInputsStats().
let _inStats = null;
function resetHarnessInputsStats() {
  _inStats = { games: 0, framingPersisted: 0, framingRecomputed: 0, bullpenPersisted: 0, bullpenMissing: 0 };
}
resetHarnessInputsStats();
function harnessInputsStats() { return _inStats; }
function harnessInputsLine() {
  const mode = harnessInputsMode();
  if (mode === 'legacy') {
    return 'harness inputs: legacy   *** PRE-2026-09-16 4-FIELD HARNESS: bullpen at the league '
      + 'constant, framing recomputed from current state -- reproduction only ***';
  }
  const s = _inStats;
  const unavailable = FIELD_SOURCES.filter(f => f.unavailable).map(f => f.field);
  return 'harness inputs: persisted   games ' + s.games
    + ', bullpen sides persisted ' + s.bullpenPersisted + ' / missing ' + s.bullpenMissing
    + ', framing sides persisted ' + s.framingPersisted + ' / recomputed ' + s.framingRecomputed
    + ', no source: ' + unavailable.join(', ');
}

/**
 * Copy one group's persisted emit-time values onto `wrapped`. The single
 * implementation behind populateCallerInputs and scripts/calibration-ab-inputs.js.
 * FRV is computed (as-of), not copied, and roster/availability have no
 * source, so those groups are no-ops here. `tally` is optional: field ->
 * count of games it was set on.
 */
function injectGroup(wrapped, gameRow, group, tally) {
  const set = (field, v) => {
    wrapped[field] = v;
    if (tally && v != null) tally[field] = (tally[field] || 0) + 1;
  };
  if (group === 'bullpen') {
    for (const side of ['away', 'home']) {
      // q=null: persisted only. A row with no persisted bullpen stays
      // undefined and is counted, rather than recomputed from today's
      // woba_data -- which is the date defect the replay helper exists to
      // avoid. 1495 of 1495 graded games since 2026-05-20 carry it.
      const t = bullpenTermForReplay(null, gameRow, side, null, {});
      if (!t || t.woba == null) { _inStats.bullpenMissing++; continue; }
      _inStats.bullpenPersisted++;
      set(side + 'BullpenWoba', t.woba);
      set(side + 'BullpenVsL', t.vsLHB);
      set(side + 'BullpenVsR', t.vsRHB);
    }
    return wrapped;
  }
  for (const f of FIELD_SOURCES) {
    if (f.group !== group || !f.column) continue;
    if (!Object.prototype.hasOwnProperty.call(gameRow, f.column)) continue;
    if (f.stateColumn) {
      // Framing: persisted only where the emit pass recorded a state. With
      // no state the row predates the column, so the old recompute stands
      // in and is counted. States begin 2026-04-04, before any wOBA
      // snapshot, so no scorable game takes this branch today.
      if (gameRow[f.stateColumn] == null) continue;
      _inStats.framingPersisted++;
    }
    set(f.field, gameRow[f.column]);
  }
  return wrapped;
}

/**
 * Populate caller-computed inputs on a pre-screened game, the way prod
 * does. Mutates and returns `wrapped`.
 *
 * @param wrapped  the object preScreenGame() returned (passed to runModel)
 * @param gameRow  the raw game_log row (carries the lineup JSON)
 * @param settings getSettings() output
 */
function populateCallerInputs(wrapped, gameRow, settings) {
  if (!wrapped || !gameRow) return wrapped;
  const mode = harnessInputsMode();
  _inStats.games++;
  try {
    const rm = frvReadMode();
    const asOf = rm.mode === 'current' ? null : (rm.pinned || gameRow.game_date);
    if (_frvDetailForTeam) {
      for (const side of ['away', 'home']) {
        const d = _frvDetailForTeam(gameRow[side + '_team'], gameRow[side + '_lineup_json'],
          settings, asOf);
        wrapped[side + 'FieldingRunsPerGame'] = d ? d.value : null;
        if (d) {
          _frvStats.sides++;
          _frvStats.asofMissing += d.asofMissing || 0;
          for (const det of d.details || []) {
            if (det.vintage && det.vintage !== 'current_state') {
              _frvStats.vintages[det.vintage] = 1;
            }
          }
        }
      }
    } else {
      wrapped.awayFieldingRunsPerGame = _frvForTeam(gameRow.away_team, gameRow.away_lineup_json, settings, asOf);
      wrapped.homeFieldingRunsPerGame = _frvForTeam(gameRow.home_team, gameRow.home_lineup_json, settings, asOf);
    }
  } catch (e) { /* leave undefined; coverage() will report it */ }
  try {
    // Each team's OWN catcher. model.js crosses the sides deliberately (the
    // home catcher frames against the away offense), but that crossing
    // happens inside runModel -- mirroring jobs.js.
    //
    // LEGACY recomputes from the current catcher_framing table. Over
    // 2026-06-01..08-07 that differed from the emit-time value on 619 of 627
    // away and 623 of 630 home sides, by up to 0.196 runs/game.
    const persisted = {};
    if (mode === 'persisted') injectGroup(persisted, gameRow, 'framing');
    for (const side of ['away', 'home']) {
      const field = side + 'CatcherFramingRvPerGame';
      if (Object.prototype.hasOwnProperty.call(persisted, field)) {
        wrapped[field] = persisted[field];
      } else {
        wrapped[field] = _framingForTeam(gameRow[side + '_team'], gameRow[side + '_lineup_json'], settings);
        if (mode === 'persisted') _inStats.framingRecomputed++;
      }
    }
  } catch (e) { /* ditto */ }
  if (mode === 'persisted') {
    for (const g of ['bullpen', 'opener', 'tandem']) {
      try { injectGroup(wrapped, gameRow, g); } catch (e) { /* ditto */ }
    }
  }
  return wrapped;
}

/**
 * Coverage report over a built corpus. Harnesses should print this so a
 * silently-empty input is visible in the output rather than inferred
 * later from a suspicious null result.
 *
 * @param rows array of objects each exposing the wrapped game
 * @param pick fn(row) -> wrapped game (default: identity)
 */
function coverage(rows, pick) {
  const get = pick || (r => r);
  return CALLER_POPULATED_FIELDS.map(f => ({
    field: f,
    present: rows.filter(r => { const g = get(r); return g && g[f] != null; }).length,
    total: rows.length,
  }));
}

function coverageLine(rows, pick) {
  return coverage(rows, pick).map(c => c.field + '=' + c.present + '/' + c.total).join('  ');
}

/**
 * True when every listed field is null on every row -- i.e. the harness
 * is about to measure a model with the feature structurally disabled.
 * The default list skips fields with no source, which are absent by design.
 */
function missingEntirely(rows, fields, pick) {
  const get = pick || (r => r);
  const list = fields || FIELD_SOURCES.filter(f => !f.unavailable).map(f => f.field);
  return list.filter(f => !rows.some(r => { const g = get(r); return g && g[f] != null; }));
}

// ── SETTINGS THAT ACT THROUGH A PERSISTED INPUT (2026-09-16) ───────────
//
// Reading the bullpen and framing values the model used at emit FREEZES
// them: they were computed once, with production's settings, and no
// override reaches them. A calibration A/B or sweep on a setting whose
// entire effect goes through that computation therefore scores two
// identical arms and reports "no effect" for a harness reason.
//
// This was already silently true for every bullpen setting under the
// legacy harness, which did not populate the bullpen at all -- nothing
// guarded it then either. It is now guarded in both directions:
//
//   whole    the family's computation keys that runModel (and the modules
//            it requires) never read. The harness must refuse the run.
//   partial  keys read BOTH by runModel and by the frozen computation.
//            The run is valid for the runModel half only; say so.
//
// WHOLE is DERIVED, not listed: family prefix + absence from runModel's own
// source. A hand-maintained exact-name list is what let CATCHER_FRAMING_MUTE
// through the old guard. The partial list is explicit, and
// scripts/test-harness-inputs-sources.js asserts every entry really is read
// on both sides.
const FROZEN_FAMILIES = [
  { re: /^(BULLPEN_|BP_)/, group: 'bullpen' },
  { re: /^CATCHER_FRAMING_/, group: 'framing' },
];
const PARTIAL_FROZEN = {
  W_PROJ: 'bullpen', W_ACT: 'bullpen', MIN_BF: 'bullpen', UNKNOWN_PITCHER_WOBA: 'bullpen',
  PARK_NEUTRAL_INPUTS_ENABLED: 'bullpen',
};
let _runModelSrc = null;
function runModelSource() {
  if (_runModelSrc != null) return _runModelSrc;
  const fs = require('fs');
  const path = require('path');
  const modelPath = path.join(__dirname, 'model.js');
  let src = fs.readFileSync(modelPath, 'utf8');
  const reqs = src.match(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g) || [];
  for (const r of reqs) {
    const rel = r.match(/require\(['"]([^'"]+)['"]\)/)[1];
    for (const cand of [rel, rel + '.js']) {
      const p = path.join(__dirname, cand);
      try { if (fs.statSync(p).isFile()) { src += '\n' + fs.readFileSync(p, 'utf8'); break; } } catch (e) { /* next */ }
    }
  }
  // COMMENTS STRIPPED. A key MENTIONED in a comment is not read: scraper.js
  // (required by model.js) discusses CATCHER_FRAMING_MIN_PITCHES_2026 in two
  // comments, and the unstripped scan counted that as runModel reading it --
  // which silently exempted a whole-frozen key from the guard.
  _runModelSrc = stripJsComments(src);
  return _runModelSrc;
}

// ONE left-to-right pass, not two regexes. The two-regex version ran the
// block-comment pattern first, and model.js has a `//` line comment containing
// `/*` -- so it opened a "block" there and deleted 36,560 characters of real
// code up to the next `*/`, including `settings.BULLPEN_AVG`, and the guard
// then refused a key runModel reads. A single scan sees whichever opener comes
// first. String literals are skipped so `'http://'` or `'/*'` inside a string
// cannot open a comment, and REGEX literals are skipped so a quote inside one
// (`/['"]/`, which scraper.js has) cannot open a fake string that then swallows
// the comments after it -- the second failure the first fix exposed.
//
// A `/` begins a regex when the last significant character cannot end an
// expression (an operator, an opening bracket, a comma, start of input) or
// the last word is a keyword like `return`. That is the standard tokenizer
// heuristic; it is exact for the code on the scanned path.
const _REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const _REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|else|do)$/;
function stripJsComments(src) {
  let out = '', i = 0, q = null;
  let sig = '';   // code emitted since the last newline, for the keyword check
  const prevSig = () => { const t = out.replace(/\s+$/, ''); return t ? t[t.length - 1] : ''; };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '/') {
      const p = prevSig();
      const tail = out.slice(-12).replace(/\s+$/, '');
      if (p === '' || _REGEX_PREV.has(p) || _REGEX_KEYWORDS.test(tail)) {
        // Regex literal: copy through the closing `/`, honouring escapes and
        // character classes (a `/` inside [...] does not close it).
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n') {
          const d = src[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          j++;
        }
        if (j < src.length && src[j] === '/') {
          out += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        // Unterminated on this line: it was division after all.
      }
    }
    out += c;
    i++;
  }
  return out;
}
function persistedInputConflict(param) {
  if (harnessInputsMode() !== 'persisted' || !param) return null;
  const key = String(param).toUpperCase();
  if (PARTIAL_FROZEN[key]) {
    return { param: key, group: PARTIAL_FROZEN[key], whole: false,
      reason: key + ' is read by runModel AND by the ' + PARTIAL_FROZEN[key] + ' computation, whose '
        + 'output is now read from its persisted emit-time value. Only the runModel half varies '
        + 'between arms.' };
  }
  const fam = FROZEN_FAMILIES.find(f => f.re.test(key));
  if (fam && !new RegExp('\\b' + key + '\\b').test(runModelSource())) {
    return { param: key, group: fam.group, whole: true,
      reason: key + ' only acts inside the ' + fam.group + ' computation, which the harness now '
        + 'reads from its persisted emit-time value. Both arms see the same frozen number.' };
  }
  return null;
}


// ── the bullpen term for an OFFLINE REPLAY ─────────────────────────────
//
// MEASURED 2026-09-03 over 1,171 games / 2,340 sides, June-August:
//
//   do nothing (today)      signed +0.0066   mean |d| 0.0074   max 0.0294
//   pass all 17 args        signed +0.0009   mean |d| 0.0044   max 0.0255
//   read the persisted col  exact
//
//   2,329 of 2,340 sides differed. 60.3% by more than 0.005.
//
// TWO DEFECTS WERE STACKED, and they partially CANCEL, which is why
// neither shows up as an obvious outlier:
//
//   DATE   getBullpenWobaBlended reads woba_data, wiped and reloaded
//          daily. Replaying a June game prices its bullpen off today's
//          projections. The batter and SP terms ARE date-corrected via
//          getWobaIndexAsOf against woba_data_snapshot -- the bullpen
//          term was the one input that silently was not.
//   ARITY  the harnesses passed 10 of 17 parameters, so minBF defaulted
//          to 100 against production's 50, downweight-starters was off,
//          the blend fell back to the GLOBAL 0.45/0.55 instead of the
//          bullpen's 0.25/0.75, the DH nightcap rule was inert, and no
//          park neutralisation was applied.
//
// game_log already carries what the model actually used, on 1944/1944
// rows since 2026-04-04. Reading it is exact by construction and cannot
// drift again; recomputing can only ever approximate it.
//
// The recompute path is kept for rows without a persisted value, and it
// now passes ALL 17 arguments so that fallback is the +0.0009 shape
// rather than the +0.0066 one.
function bullpenTermForReplay(q, gameRow, side, settings, opts) {
  opts = opts || {};
  const persisted = side === 'away'
    ? { woba: gameRow.away_bullpen_woba,
        vsL:  gameRow.away_bullpen_woba_vs_l,
        vsR:  gameRow.away_bullpen_woba_vs_r }
    : { woba: gameRow.home_bullpen_woba,
        vsL:  gameRow.home_bullpen_woba_vs_l,
        vsR:  gameRow.home_bullpen_woba_vs_r };
  if (persisted.woba != null) {
    return { woba: persisted.woba, vsLHB: persisted.vsL, vsRHB: persisted.vsR,
             source: 'persisted' };
  }
  if (!q || !q.getBullpenWobaBlended) return null;
  const N = (v, d) => (v != null ? Number(v) : d);
  const s = settings || {};
  try {
    const r = q.getBullpenWobaBlended(
      opts.team, opts.starter || '', opts.lineup || [],
      N(s.BP_STRONG_WEIGHT_R, 0.55), N(s.BP_WEAK_WEIGHT_R, 0.45),
      N(s.BP_STRONG_WEIGHT_L, 0.35), N(s.BP_WEAK_WEIGHT_L, 0.65),
      N(s.W_PROJ, 0.65), N(s.W_ACT, 0.35), gameRow.game_date,
      N(s.UNKNOWN_PITCHER_WOBA, 0.335),
      N(s.BULLPEN_MIN_BF, N(s.MIN_BF, 100)),
      !!(s.BULLPEN_DOWNWEIGHT_STARTERS === true || s.BULLPEN_DOWNWEIGHT_STARTERS === 'true'),
      N(s.BULLPEN_W_PROJ, N(s.W_PROJ, 0.65)),
      N(s.BULLPEN_W_ACT, N(s.W_ACT, 0.35)),
      opts.gameNumber || 1);
    return r ? { woba: r.woba, vsLHB: r.vsLHB, vsRHB: r.vsRHB, source: 'recomputed' } : null;
  } catch (e) { return null; }
}

module.exports = {
  bullpenTermForReplay,
  FIELD_SOURCES,
  CALLER_POPULATED_FIELDS,
  INPUT_GROUPS,
  populateCallerInputs,
  injectGroup,
  coverage,
  coverageLine,
  missingEntirely,
  frvReadMode,
  frvAsOfStats,
  frvAsOfLine,
  resetFrvAsOfStats,
  harnessInputsMode,
  harnessInputsStats,
  harnessInputsLine,
  resetHarnessInputsStats,
  persistedInputConflict,
  stripJsComments,
};
