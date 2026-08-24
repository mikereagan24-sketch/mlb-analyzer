// Parameter sweep engine. Re-scores historical games under hypothetical
// settings combinations and aggregates ROI by bet direction. UI-less by
// design — intended to be driven by POST /api/admin/parameter-sweep,
// which streams the response back as one JSON blob.
//
// Snapshot-aware: each game's date determines which woba_data_snapshot
// row set we load — the slate is rescored under the wOBA that EXISTED
// on game day, not today's woba_data (which has hindsight bias). Games
// without a snapshot row (typically pre-2026-05-20, before snapshotting
// started) are skipped, counted, and reported in the response — falling
// back to current woba_data would defeat the purpose.

'use strict';

const {
  runModel,
  getSignals,
  calcPnl,
  buildWobaIndex,
  buildSpStartIndex,
  impliedP,
} = require('./model');

// Mapping from sweep parameter -> setting keys that should be flipped.
// W_PROJ_W_ACT and W_PIT_W_BAT are complementary pairs (the second
// half is 1 - sweep_value).
//   - W_PIT_W_BAT controls the headline pitcher-vs-hitter blend at
//     perBatterEW (services/model.js:195): every per-batter expected
//     wOBA is pitW * W_PIT + batW * W_BAT. Reaches BOTH the opener-aware
//     and standard branches — no forecast bypass, unlike the now-removed
//     SP_BULLPEN_MIX. Production runs at W_PIT=0.40 / W_BAT=0.60,
//     departed from the 0.5/0.5 seeded default. That setting was picked
//     by the offline grid-search in scripts/optimize-params.js (commit
//     3397c3b, April 2026) where w_bat=0.60 won the top-20 ROI ranking;
//     value lives in app_settings (no migration touched it). Adding it
//     to the in-server sweep so it can be retuned against the current
//     snapshot corpus alongside the other blend params.
// BAT_HAND_SP and BAT_HAND_RELIEF are independent scalars (the model
// passes them as separate args to perBatterEW — in production they're
// constrained near 1 via the settings-schema invariants, but the sweep
// deliberately allows out-of-schema values to probe the model's
// behavior at extremes).
//
// RUN_MULT and TOT_SLOPE were added in feat/totals-sweep. They are
// the two knobs most directly governing totals-pick edge:
//   - RUN_MULT (default 48) sets the magnitude of estTot via
//     (team_woba - WOBA_BASELINE) * RUN_MULT * park_factor. Scaling
//     all totals up/down by the same factor moves where the model
//     sits relative to market lines.
//   - TOT_SLOPE (default 0.08) converts (estTot - market_total) into
//     over probability via 0.5 + runDiff * TOT_SLOPE. It's the
//     edge-to-confidence dial. Orthogonal to RUN_MULT: RUN_MULT
//     changes WHERE estTot lands; TOT_SLOPE changes how aggressively
//     a given gap above/below market produces over/under signals.
//
// DELIBERATELY EXCLUDED, with reasons:
//   - SP_BULLPEN_MIX (formerly mapped to SP_PIT_WEIGHT /
//     RELIEF_PIT_WEIGHT): vestigial on the snapshot corpus.
//     model.js:632-633 uses computeSpPitWeightFromForecast(...) ??
//     SP_PIT_WEIGHT — i.e., SP_PIT_WEIGHT is only consulted when the
//     per-side F4 forecast IP is null. For non-opener standard-path
//     games with both forecasts populated (the dominant case post
//     2026-05-20), SP_PIT_WEIGHT is bypassed entirely. Opener-flagged
//     games never read it either (the openerOpts branch in
//     perBatterEW uses openerOpts.perPositionWeights). Empirically
//     produces byte-identical sweep results across 0.1..0.9. A
//     2026-05-20..06-04 sanity count found 10 standard-path games
//     with at least one null SP forecast — those would in theory
//     respond, but in practice their aggregate ROI delta fell below
//     0.01% rounding. Removed from the sweep on
//     chore/sweep-drop-sp-bullpen-mix; SP_PIT_WEIGHT /
//     RELIEF_PIT_WEIGHT remain real app_settings for any historical
//     game without a forecast.
//   - WOBA_BASELINE: near-collinear with RUN_MULT — both shift overall
//     run level. Sweeping both lets the engine trade them off arbitrarily
//     on a thin sample (the ~225-game snapshot corpus). Hold fixed and
//     sweep only RUN_MULT.
//   - WIND_SCALE: isolatable per-game by wind-direction bucket. Belongs
//     in the residual-diagnostic regression (a different tool), NOT this
//     ROI sweep. Adding it here just adds a noise dimension that the
//     thin sample can't constrain.
//   - HFA_BOOST / PYTH_EXP / FAV_ADJ / DOG_ADJ: ML-only knobs, do not
//     affect estTot. Out of scope for a totals sweep.
//   - BAT_DFLT_* / PIT_DFLT_* / UNKNOWN_PITCHER_WOBA / BULLPEN_AVG:
//     fallback defaults; sweeping them would just trade noise for noise
//     since they only fire on missing-data games.
const SWEEP_PARAMS = [
  'W_PROJ_W_ACT', 'W_PIT_W_BAT', 'BAT_HAND_SP', 'BAT_HAND_RELIEF',
  'BAT_HAND_SP_PAIRED',
  'RUN_MULT', 'TOT_SLOPE',
];

// Per-parameter sweep ranges for univariate mode. The blend params
// (W_PROJ_W_ACT, W_PIT_W_BAT, BAT_HAND_SP, BAT_HAND_RELIEF) use the
// original 0.1..0.9 step-0.1 grid. RUN_MULT and TOT_SLOPE get
// dedicated grids centered on their production defaults, with step
// sizes that are large enough to be distinguishable in ROI given the
// thin snapshot corpus but small enough that the optimum doesn't fall
// in a gap.
const BLEND_GRID    = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const RUN_MULT_GRID = [40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60];
const TOT_SLOPE_GRID = [0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.14];

function gridFor(param) {
  if (param === 'RUN_MULT')  return RUN_MULT_GRID;
  if (param === 'TOT_SLOPE') return TOT_SLOPE_GRID;
  return BLEND_GRID;
}

function applySweepOverrides(baseSettings, overrides) {
  const s = Object.assign({}, baseSettings);
  if ('W_PROJ_W_ACT' in overrides) {
    s.W_PROJ = overrides.W_PROJ_W_ACT;
    s.W_ACT  = 1 - overrides.W_PROJ_W_ACT;
  }
  if ('W_PIT_W_BAT' in overrides) {
    s.W_PIT = overrides.W_PIT_W_BAT;
    s.W_BAT = 1 - overrides.W_PIT_W_BAT;
  }
  if ('BAT_HAND_SP' in overrides) s.SP_WEIGHT     = overrides.BAT_HAND_SP;
  if ('BAT_HAND_RELIEF' in overrides) s.RELIEF_WEIGHT = overrides.BAT_HAND_RELIEF;
  // BAT_HAND_SP_PAIRED — sweep the platoon split while HOLDING THE TOTAL
  // BATTER WEIGHT AT 1.0 (2026-08-22).
  //
  // perBatterEW computes `batW = vsStart * spW + vsOpp * relW`, and
  // settings-schema.js requires sp_weight + relief_weight == 1.0. The two
  // keys above override each weight INDEPENDENTLY, so sweeping
  // BAT_HAND_SP alone silently changes the SUM: at BAT_HAND_SP=0.1 with
  // RELIEF_WEIGHT left at its production 0.20, batter wOBA is scaled by
  // 0.30 rather than re-split. That is a LEVEL SHIFT, not a platoon
  // reweight, and at the low end it drives aRuns/hRuns into their
  // Math.max(0, ...) floor so the model emits a constant probability.
  //
  // Observed directly: a BAT_HAND_SP calibration sweep returned log loss
  // 0.69261 at BOTH 0.10 and 0.20 — identical to the always-predict-the-
  // base-rate value — with ECE 0.0005, i.e. a degenerate constant model,
  // plus a non-monotone spike to 0.74418 at 0.40.
  //
  // Use this key to ask "what is the right platoon split?". Use the bare
  // BAT_HAND_SP only to probe out-of-schema level behaviour deliberately.
  if ('BAT_HAND_SP_PAIRED' in overrides) {
    s.SP_WEIGHT     = overrides.BAT_HAND_SP_PAIRED;
    s.RELIEF_WEIGHT = 1 - overrides.BAT_HAND_SP_PAIRED;
  }
  if ('RUN_MULT'  in overrides) s.RUN_MULT  = overrides.RUN_MULT;
  if ('TOT_SLOPE' in overrides) s.TOT_SLOPE = overrides.TOT_SLOPE;

  // FAIL LOUD on an unrecognised key. (2026-08-22)
  //
  // Every branch above is an explicit `if (KEY in overrides)`. A key that
  // matches none of them was silently DISCARDED, and the caller got
  // production settings back while believing it had swept something.
  //
  // That is not hypothetical. `calibration-sweep.js SP_WEIGHT 0.80` passes
  // { SP_WEIGHT: w }, which matches no branch -- the correct key is
  // BAT_HAND_SP_PAIRED, which sets SP_WEIGHT *and* its RELIEF_WEIGHT
  // complement. All nine grid points therefore scored the identical
  // production model and returned byte-identical log loss, Brier, ECE and
  // edge slope. Read naively that says "SP_WEIGHT is perfectly inert";
  // what it actually said is "the sweep never moved SP_WEIGHT".
  //
  // This is the third instance of one failure mode in this codebase: a
  // hand-maintained key list that FAILS OPEN on anything it does not
  // recognise. The other two were getSettings()'s whitelist (an unmapped
  // setting is invisible to the model) and calibration-ab.js's
  // CALLER_POPULATED_INPUTS guard (keyed by exact param name, so
  // CATCHER_FRAMING_MUTE skipped the check entirely). Failing open is the
  // shared defect; throwing is the fix.
  const KNOWN = ['W_PROJ_W_ACT', 'W_PIT_W_BAT', 'BAT_HAND_SP', 'BAT_HAND_RELIEF',
                 'BAT_HAND_SP_PAIRED', 'RUN_MULT', 'TOT_SLOPE'];
  const unknown = Object.keys(overrides).filter(k => KNOWN.indexOf(k) === -1);
  if (unknown.length) {
    throw new Error(
      'applySweepOverrides: unrecognised override key(s) ' + unknown.join(', ')
      + '. Known keys: ' + KNOWN.join(', ')
      + '. An unhandled key would be silently discarded and every grid point '
      + 'would score the identical production model -- which reads as "the '
      + 'parameter is inert" rather than "the sweep did nothing". '
      + (unknown.indexOf('SP_WEIGHT') !== -1
          ? 'For SP_WEIGHT use BAT_HAND_SP_PAIRED, which also sets the '
            + 'RELIEF_WEIGHT complement and preserves the sum invariant.'
          : 'Add an explicit branch above if this key should be sweepable.'));
  }
  return s;
}

// Compute the wagered amount per signal (mirrors the SQL in /backtest
// overall + the wageredForSignal helper in public/index.html so ROI is
// computed identically across sweep / backtest API / UI display).
// MOVED 2026-08-23 to utils/wagered.js. The old body returned a FLAT 110
// for totals regardless of price, making every totals ROI denominator an
// approximation -- and an asymmetric one, understating the stake on
// favourites and overstating it on dogs. The shared version uses the
// actual price, preferring bet_price (struck) then the market's
// over/under price, with -110 genuinely last.
const { wageredFor } = require('../utils/wagered');

// Bucket a single emitted signal into one of {favs, dogs, overs, unders}.
function categoryFor(signal) {
  if (signal.type === 'ML') return Number(signal.marketLine) < 0 ? 'favs' : 'dogs';
  return signal.side === 'over' ? 'overs' : 'unders';
}

// UI-highlight thresholds. These live in app_settings but aren't on
// the in-memory settings object that getSettings() builds — see the
// note in services/jobs.js:83-87 documenting that the model doesn't
// consume them. The sweep DOES consume them (so it can compute the
// "actually bet" aggregate alongside the full above-emit-floor set),
// so we load them once per run directly from the DB. Defaults match
// the schema at services/settings-schema.js:166-178.
function loadUiHighlightThresholds(db) {
  const rows = db.prepare(
    "SELECT key, value FROM app_settings WHERE key IN ("
    + "'ui_highlight_ml_fav_min_pp','ui_highlight_ml_dog_min_pp',"
    + "'ui_highlight_tot_under_min_pp','ui_highlight_tot_overs_enabled')"
  ).all();
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    fav_min_pp:    m['ui_highlight_ml_fav_min_pp']    != null ? Number(m['ui_highlight_ml_fav_min_pp'])    : 0.02,
    dog_min_pp:    m['ui_highlight_ml_dog_min_pp']    != null ? Number(m['ui_highlight_ml_dog_min_pp'])    : 0.045,
    under_min_pp:  m['ui_highlight_tot_under_min_pp'] != null ? Number(m['ui_highlight_tot_under_min_pp']) : 0.07,
    overs_enabled: m['ui_highlight_tot_overs_enabled'] === 'true',
  };
}

// Mirrors the UI's highlight gate (settings-schema.js:157-159 comment):
// "Comparison is against the ROUNDED 0.5pp score
// (Math.round(edge*100/0.5)*0.5/100), not the raw edge, so the UI
// display and highlight condition stay consistent." Math: edge×200,
// rounded to integer, divided by 200 → nearest 0.005pp. A raw
// edge=0.0445 rounds to 0.045 and clears the dog threshold; raw
// 0.0440 rounds to 0.045 too; raw 0.0424 rounds to 0.04 and does not.
// Production tot_overs_enabled=false → every over is excluded
// regardless of edge (backtest finding: "no edge in overs").
function isHighlightedSignal(signal, t) {
  const cat = categoryFor(signal);
  const rounded = Math.round(Number(signal.edge) * 200) / 200;
  if (cat === 'favs')   return rounded >= t.fav_min_pp;
  if (cat === 'dogs')   return rounded >= t.dog_min_pp;
  if (cat === 'unders') return rounded >= t.under_min_pp;
  if (cat === 'overs')  return !!t.overs_enabled;
  return false;
}

function emptyCategoryBucket() {
  return { bets: 0, wins: 0, losses: 0, pushes: 0, pnl: 0, wagered: 0 };
}
function emptyByCategory() {
  return {
    favs:   emptyCategoryBucket(),
    dogs:   emptyCategoryBucket(),
    overs:  emptyCategoryBucket(),
    unders: emptyCategoryBucket(),
  };
}

function rollUpRoi(byCategory) {
  for (const cat of Object.keys(byCategory)) {
    const b = byCategory[cat];
    b.pnl = Math.round(b.pnl * 100) / 100;
    b.wagered = Math.round(b.wagered * 100) / 100;
    b.roi_pct = b.wagered > 0 ? Math.round((b.pnl / b.wagered) * 10000) / 100 : null;
  }
  return byCategory;
}

// Capture a sweep's "all params at base" reference point so consumer
// reporting can show what each combo's effective full settings are.
function baseEffectiveSettings(baseSettings) {
  return {
    W_PROJ_W_ACT:    Number(baseSettings.W_PROJ),
    W_PIT_W_BAT:     Number(baseSettings.W_PIT),
    BAT_HAND_SP:     Number(baseSettings.SP_WEIGHT),
    BAT_HAND_RELIEF: Number(baseSettings.RELIEF_WEIGHT),
    RUN_MULT:        Number(baseSettings.RUN_MULT  != null ? baseSettings.RUN_MULT  : 48),
    TOT_SLOPE:       Number(baseSettings.TOT_SLOPE != null ? baseSettings.TOT_SLOPE : 0.08),
  };
}

// Build the full settings combinations for a sweep mode.
//   univariate: for each sweepable param, sweep its dedicated grid
//               with all other params at production base. RUN_MULT
//               and TOT_SLOPE each get their own 11-value grid; the
//               4 blend params share the original 0.1..0.9 grid.
//               Total: 4×9 + 11 + 11 = 58 combos.
//   joint:      cartesian product of 5 settings per param across the
//               THREE blend params (5^3 = 125). RUN_MULT, TOT_SLOPE,
//               and W_PIT_W_BAT are EXCLUDED from joint mode by design
//               — adding any of them simultaneously with the existing
//               blend params on the thin snapshot corpus (~225 games)
//               would overfit. W_PIT_W_BAT in particular is the
//               headline pitcher/hitter blend and warrants a clean
//               univariate read first. Run all four in univariate mode.
//               Joint was 5^4=625 pre-chore/sweep-drop-sp-bullpen-mix;
//               SP_BULLPEN_MIX was vestigial on the forecast-driven
//               path so dropping it took joint to 125 (~3.5h → ~42m).
function buildCombinations(mode, baseSettings) {
  const combos = [];
  if (mode === 'univariate') {
    for (const param of SWEEP_PARAMS) {
      const grid = gridFor(param);
      for (const v of grid) {
        const o = baseEffectiveSettings(baseSettings);
        o[param] = v;
        combos.push({ sweptParam: param, settings: o, override: { [param]: v } });
      }
    }
  } else if (mode === 'joint') {
    const settings = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const a of settings)
    for (const c of settings)
    for (const d of settings) {
      const o = baseEffectiveSettings(baseSettings);
      o.W_PROJ_W_ACT    = a;
      o.BAT_HAND_SP     = c;
      o.BAT_HAND_RELIEF = d;
      combos.push({
        sweptParam: null,
        settings: o,
        override: { W_PROJ_W_ACT: a, BAT_HAND_SP: c, BAT_HAND_RELIEF: d },
      });
    }
  } else {
    throw new Error('unknown sweep mode: ' + mode);
  }
  return combos;
}

// Estimated runtime of a sweep run, returned to the POST caller so the
// UI can show "expect ~20 min" vs "expect ~42 min" up front instead
// of the user discovering it via polling. Calibrated against the
// observed run_id 0bb9be83-window timings, then rescaled across
// chore/sweep-drop-sp-bullpen-mix + feat/sweep-add-w-pit-w-bat:
//   - Univariate: 58 originally (~20m) → 49 after SP_BULLPEN_MIX
//     drop (~17m) → 58 again after adding W_PIT_W_BAT (~20m). Net
//     wash on runtime, but coverage now includes the headline
//     pitcher/hitter blend.
//   - Joint: was 5^4=625 pre-drop (~3.5h); now 5^3=125 (~42m).
//     W_PIT_W_BAT intentionally left out of joint (univariate only).
// Per (combo × game) cost ≈ 0.09s on Render's standard instance; the
// constant is an empirical floor and may drift as the model gains
// features — refresh after any runModel cost change.
function estimateRuntimeSec(mode, fromDate, toDate, topN) {
  const combos    = mode === 'univariate' ? 58 : (mode === 'joint' ? 125 : 0);
  const days      = Math.max(1, daysBetween(fromDate, toDate) + 1);
  const games     = days * 14.5;             // ~14.5 MLB games/day avg
  const PER_CALL_SEC = 0.09;
  const trainShare = 0.7;
  const testShare  = 0.3;
  const comboWork    = combos * games * trainShare * PER_CALL_SEC;
  const baselineWork = games * PER_CALL_SEC;                          // train + test combined ≈ full
  const topKWork     = (topN || 10) * games * testShare * PER_CALL_SEC;
  return Math.round(comboWork + baselineWork + topKWork + 5);         // +5s setup (loadGames, snapshots)
}

function daysBetween(from, to) {
  const dFrom = new Date(from + 'T00:00:00Z');
  const dTo   = new Date(to   + 'T00:00:00Z');
  return Math.round((dTo - dFrom) / (24 * 3600 * 1000));
}

// Boot-time cleanup of orphaned 'running' rows in parameter_sweep_runs.
// Any row still 'running' at process start has lost its in-process
// async closure (the only thing that would ever transition it to
// 'done' or 'error') — the previous process died mid-sweep. Mark them
// 'error' with an abandonment message so /admin/parameter-sweep/latest
// stops hanging on them and the in-flight dedupe gate in the POST
// handler clears for the next legitimate run. Logs params_json for
// each orphan so the operator can tell which params were in-flight
// (e.g. whether the killed ML run was univariate ~20m or joint ~3.5h).
function cleanupOrphanedSweepRuns(q, nowPtIso) {
  const orphans = q.getRunningParameterSweepRuns.all();
  if (!orphans.length) {
    console.log('[sweep-cleanup] no orphaned running rows at boot');
    return { abandoned: 0, runs: [] };
  }
  const finishedAt = nowPtIso();
  const errMsg = 'abandoned: process restarted while sweep was in flight';
  const runs = [];
  for (const row of orphans) {
    let params = null;
    try { params = JSON.parse(row.params_json); } catch (e) { /* best-effort */ }
    console.warn('[sweep-cleanup] abandoning run_id=' + row.run_id
      + ' started_at=' + row.started_at
      + ' params=' + (params ? JSON.stringify(params) : row.params_json));
    q.markParameterSweepRunAbandoned.run(errMsg, finishedAt, row.run_id);
    runs.push({ run_id: row.run_id, started_at: row.started_at, params });
  }
  console.warn('[sweep-cleanup] marked ' + orphans.length + ' orphan(s) as error');
  return { abandoned: orphans.length, runs };
}

// Load all snapshot rows for a single date into a buildWobaIndex-shaped
// object. Returns null if the date has no snapshot rows. Cached by the
// caller — DO NOT call this in the inner combination loop.
function loadWobaSnapshot(db, snapshotDate) {
  const rows = db.prepare(
    "SELECT data_key, player_name, woba, sample_size FROM woba_data_snapshot WHERE snapshot_date=?"
  ).all(snapshotDate);
  if (!rows.length) return null;
  return buildWobaIndex(rows);
}

// Pre-load games + outcomes (game scores + market totals) once. The
// per-combination inner loop reuses this — only the model settings
// change between combos, not the game data.
// opts (2026-08-23, for the contamination re-run only):
//   includeMarketContaminated -- keep post-first-pitch-priced rows. ONLY for
//     measuring what the exclusion changed. Never for production analysis.
//   includeWeatherContaminated (2026-08-24) -- keep known-wrong-weather rows.
//     Added for the same reason and with the same restriction. It did not
//     exist for the 2026-08-23 re-run, and its absence made that re-run
//     misleading: the weather filter was UNCONDITIONAL, so arms A and B
//     were both already weather-filtered and the "full corpus" was not
//     full. Worse, only 27 games carried a weather tag at the time --
//     the corrected corpus has 797 -- so ~770 known-bad-weather games sat
//     silently in BOTH arms. An arm labelled "contaminated" that has had
//     one contamination class quietly removed cannot bound what exclusion
//     costs. Never for production analysis.
//   sampleN / seed -- deterministically downsample the returned set. Exists
//     so a POWER CONTROL can be built: a random n-matched subsample of the
//     CONTAMINATED corpus isolates "the delta moved because n dropped" from
//     "the delta moved because the contamination was removed". Without that
//     control, excluding 15.3% of games and observing a wider CI proves
//     nothing about contamination.
function loadGames(db, fromDate, toDate, opts) {
  opts = opts || {};
  // Contamination filter (2026-08-06): the parameter sweep reruns
  // runModel per combo on historical rows; a row whose persisted
  // weather is known-wrong feeds biased inputs into EVERY combo
  // equally, but the biased contribution can favor different combos
  // depending on how the weather term interacts with the parameter
  // being swept. Cleaner to exclude the rows entirely so the sweep
  // sees only trusted weather inputs.
  return db.prepare(
    "SELECT * FROM game_log WHERE game_date >= ? AND game_date <= ? "
    + "AND model_total IS NOT NULL "  // skip games the model never finished
    + (opts.includeWeatherContaminated ? "" : "AND weather_contamination_reason IS NULL ")
    // Same exclusion, same reasoning, different input: when the stored
    // market_*_ml moved after real first pitch it embeds the in-progress
    // score, so it is not a pre-game price. Leaving these in would let a
    // post-hoc market number act as the baseline the model is scored
    // against -- the market would look artificially sharp and the model
    // artificially bad, on exactly the games where the market "knew" the
    // result. See docs/first-pitch-timestamp-and-exposure-2026-08-22.md.
    + (opts.includeMarketContaminated ? "" : "AND market_contamination_reason IS NULL ")
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);
}

// Deterministic n-matched downsample. Separated from loadGames so the
// sampling is visible at the call site rather than hidden in a query.
function sampleGames(rows, n, seed) {
  if (!n || n >= rows.length) return rows;
  let a = (seed || 1) >>> 0;
  const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx.slice(0, n).sort((x, y) => x - y).map(i => rows[i]);
}

// Probe one game-shape to make sure runModel can consume it without
// blowing up on missing fields — returns true if usable (non-suppressed
// under the BASE settings). Done once per game in a pre-pass so the
// inner loop can skip cheaply.
function preScreenGame(game, wobaIdx, baseSettings) {
  try {
    // runModel reads game.awayLineup / game.homeLineup (camelCase)
    // from the per-batter EW loop. game_log stores the lineups as
    // TEXT (JSON) in *_lineup_json — parse and rebind under the names
    // the model expects. Other game fields (away_sp, away_team, etc.)
    // are read directly off the row in snake_case, so passing the
    // base row plus the two parsed lineup arrays is sufficient.
    const awayLineup = game.away_lineup_json ? safeJson(game.away_lineup_json) : [];
    const homeLineup = game.home_lineup_json ? safeJson(game.home_lineup_json) : [];
    const wrapped = Object.assign({}, game, { awayLineup, homeLineup });
    // quiet=true: the opener-model log lines are invariant under the
    // swept params (computeOpenerPitWeightFromForecast reads only
    // OPENER_WEIGHT_* settings, none of which are in SWEEP_PARAMS), so
    // they'd just spam ~30-40 noise lines per combo × N combos.
    const mr = runModel(wrapped, wobaIdx, baseSettings, 'opener_aware', true);
    if (mr && mr._suppressed) return null;
    return wrapped; // re-use the wrapped object across combos
  } catch (e) {
    return null;
  }
}

function safeJson(s) {
  try { return JSON.parse(s) || []; } catch (e) { return []; }
}

// Score ONE settings object against the supplied games. Returns the
// dual aggregate + per-signal log:
//   - by_category_emit:      every signal >= SIGNAL_EMIT_FLOOR_PP
//                            (current behavior; what the model "would
//                            persist" as a signal row in production).
//   - by_category_highlight: only signals the UI would surface as a
//                            highlighted pick — fav >= fav_min_pp,
//                            dog >= dog_min_pp, under >= under_min_pp,
//                            overs included only if overs_enabled.
//                            This is what the user actually bets.
//   - signals: [{game_id, category, edge_pp, outcome, pnl, highlighted}]
//              every emit-floor signal so completed runs can be
//              re-filtered to ANY threshold post-hoc (e.g. trying
//              fav_min=0.025 instead of 0.02 without re-running).
// Pure read — runModel doesn't mutate its inputs and getSignals/
// calcPnl are stateless. Used by both the combo loop AND the
// baseline / top-K re-score steps.
function scoreGames(settings, games, uiThresholds) {
  const byCatEmit      = emptyByCategory();
  const byCatHighlight = emptyByCategory();
  const signals        = [];
  for (const sg of games) {
    // quiet=true: see note in preScreenGame. Without this, a 58-combo
    // univariate sweep emits ~58 × 30-40 ≈ 2000+ identical opener-model
    // log lines, which was the visible 'runaway loop' symptom in run_id
    // 0bb9be83 (investigation: fix/sweep-runaway-loop).
    const mr = runModel(sg.game, sg.wobaIdx, settings, 'opener_aware', true);
    if (mr && mr._suppressed) continue;
    const sigs = getSignals(sg.game, mr, settings);
    for (const s of sigs) {
      const r = calcPnl(s, sg.game.away_score, sg.game.home_score, sg.game.market_total);
      if (r.outcome === 'pending') continue;
      const cat = categoryFor(s);
      const pnl = Number(r.pnl) || 0;
      const wagered = r.outcome !== 'push' ? wageredFor(s) : 0;
      const highlighted = uiThresholds ? isHighlightedSignal(s, uiThresholds) : false;

      const be = byCatEmit[cat];
      be.bets++;
      if (r.outcome === 'win')  be.wins++;
      if (r.outcome === 'loss') be.losses++;
      if (r.outcome === 'push') be.pushes++;
      be.pnl += pnl;
      be.wagered += wagered;

      if (highlighted) {
        const bh = byCatHighlight[cat];
        bh.bets++;
        if (r.outcome === 'win')  bh.wins++;
        if (r.outcome === 'loss') bh.losses++;
        if (r.outcome === 'push') bh.pushes++;
        bh.pnl += pnl;
        bh.wagered += wagered;
      }

      signals.push({
        game_id:     sg.game.game_id,
        // game_date is required by any consumer doing date-clustered
        // resampling or chronological folds — game_id alone is not
        // unique across dates (it is <away>-<home>, which repeats every
        // series). Added 2026-08-21 for the W_PROJ/W_ACT sweep harness
        // so it can score once per grid value and then resample the
        // signal table, instead of re-running runModel per bootstrap rep.
        game_date:   sg.snapshotDate,
        category:    cat,
        edge_pp:     Number(s.edge),
        outcome:     r.outcome,
        pnl:         Math.round(pnl * 100) / 100,
        wagered:     Math.round(wagered * 100) / 100,
        highlighted: !!highlighted,
      });
    }
  }
  rollUpRoi(byCatEmit);
  rollUpRoi(byCatHighlight);
  return { by_category_emit: byCatEmit, by_category_highlight: byCatHighlight, signals };
}

// ---------------------------------------------------------------------
// SELECTION-EFFECT DECOMPOSITION  (2026-08-21)
//
// A sweep of this design CANNOT measure pricing. calcPnl reads only the
// side bet, the market line and the final score — never the model's
// numbers — and wageredFor reads only the market line. So a signal
// emitted on the same side at two different parameter values has a
// BYTE-IDENTICAL pnl and stake at both. The only channels by which a
// swept parameter can move ROI are:
//
//   1. which signals clear SIGNAL_EMIT_FLOOR_PP   (composition)
//   2. which side gets bet                        (side flips)
//
// Both are SELECTION. Consequently the headline ROI delta of any combo
// is driven entirely by the near-floor signals churning in and out of
// the sample, which are the least reliable bets in it.
//
// These functions surface that on every run rather than leaving it to
// be rediscovered. See the "Sweep ROI measures selection, not pricing"
// rule in CLAUDE.md and docs/sweep-selection-effect-2026-08-21.md.
// ---------------------------------------------------------------------

// Market-type key. NOT category: in a tight game both sides can carry
// negative American odds, so a genuine away->home switch keeps
// category='favs' and would masquerade as the same bet.
function signalKey(s) {
  const bucket = (s.category === 'favs' || s.category === 'dogs') ? 'ML' : 'TOT';
  return s.game_date + '|' + s.game_id + '|' + bucket;
}

function roiOfSignals(arr) {
  let pnl = 0, wag = 0;
  for (const s of arr) { pnl += s.pnl; wag += s.wagered; }
  return wag > 0 ? Math.round((pnl / wag) * 10000) / 100 : null;
}

// Deterministic LCG — sweep output must reproduce across runs.
function _lcg(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

// Percentile bootstrap CI on ROI. Resamples SIGNALS, not dates: this is
// deliberately the NARROWER interval, because the point being made is
// that even the optimistic interval spans zero.
function roiBootstrapCI(arr, B, seed) {
  if (!arr || !arr.length) return null;
  const rnd = _lcg(seed || 20260821);
  const reps = [];
  for (let b = 0; b < (B || 1000); b++) {
    let pnl = 0, wag = 0;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[Math.floor(rnd() * arr.length)];
      pnl += s.pnl; wag += s.wagered;
    }
    if (wag > 0) reps.push((pnl / wag) * 100);
  }
  if (!reps.length) return null;
  reps.sort((a, b) => a - b);
  return {
    lo: Math.round(reps[Math.floor(0.025 * reps.length)] * 100) / 100,
    hi: Math.round(reps[Math.floor(0.975 * reps.length)] * 100) / 100,
  };
}

// Decompose one combo's signal set against the baseline's.
//   stay   — same game+market in both. A changed bet here is a side flip.
//   enter  — cleared the floor under the combo but not the baseline.
//   leave  — the reverse.
// d_stay is zero unless a side flipped; that is the arithmetic proof
// that the combo did not reprice anything it kept.
function decomposeVsBaseline(comboSignals, baselineSignals) {
  const cm = new Map(), bm = new Map();
  for (const s of (comboSignals || [])) cm.set(signalKey(s), s);
  for (const s of (baselineSignals || [])) bm.set(signalKey(s), s);
  const stayK = [...cm.keys()].filter(k => bm.has(k));
  const enter = [...cm.keys()].filter(k => !bm.has(k)).map(k => cm.get(k));
  const leave = [...bm.keys()].filter(k => !cm.has(k)).map(k => bm.get(k));
  const stayC = stayK.map(k => cm.get(k));
  const stayB = stayK.map(k => bm.get(k));
  let changed = 0;
  for (const k of stayK) {
    const a = cm.get(k), b = bm.get(k);
    if (a.category !== b.category || a.outcome !== b.outcome
      || a.pnl !== b.pnl || a.wagered !== b.wagered) changed++;
  }
  const rC = roiOfSignals(stayC), rB = roiOfSignals(stayB);
  return {
    n_stay: stayK.length,
    n_enter: enter.length,
    n_leave: leave.length,
    n_changed_bet: changed,
    roi_stay_combo: rC,
    roi_stay_baseline: rB,
    d_stay: (rC == null || rB == null) ? null : Math.round((rC - rB) * 100) / 100,
    roi_enter: roiOfSignals(enter),
    roi_enter_ci95: roiBootstrapCI(enter, 1000, 1001),
    roi_leave: roiOfSignals(leave),
    roi_leave_ci95: roiBootstrapCI(leave, 1000, 2002),
  };
}

// Core = signals emitted by the baseline AND every combo. A fixed bet
// set, so its ROI can only move if a side flipped. If core_roi_span is
// 0, every point of headline ROI movement in the whole sweep is
// composition.
function coreSignalStats(results, baselineSignals) {
  const base = baselineSignals || [];
  let core = new Set(base.map(signalKey));
  for (const r of results) {
    const ks = new Set(((r.train && r.train.signals) || []).map(signalKey));
    core = new Set([...core].filter(k => ks.has(k)));
  }
  const roiFor = (sigs) => {
    const m = new Map();
    for (const s of (sigs || [])) m.set(signalKey(s), s);
    return roiOfSignals([...core].map(k => m.get(k)).filter(Boolean));
  };
  const perCombo = results.map(r => roiFor((r.train && r.train.signals) || []));
  const vals = perCombo.filter(v => v != null);
  const span = vals.length ? Math.round((Math.max(...vals) - Math.min(...vals)) * 100) / 100 : null;
  return {
    core_n: core.size,
    baseline_n: base.length,
    core_share_pct: base.length ? Math.round(1000 * core.size / base.length) / 10 : null,
    core_roi_baseline: roiFor(base),
    core_roi_span: span,
    interpretation: span === 0
      ? 'core span is 0 — every point of headline ROI movement in this sweep is composition, not pricing'
      : 'core span is non-zero — check n_changed_bet; side flips are the only way this can happen',
  };
}

// Partition a date-sorted scoreableGames list into train (earlier
// fraction) and test (later) by DATE — never by game count within a
// date. A whole day's slate goes to one side or the other, so the
// same model-day behavior cannot leak between train and test.
// Returns { trainGames, testGames, splitDate } where splitDate is the
// LATEST date assigned to train (test begins the next day).
function splitTrainTest(scoreableGames, trainFraction) {
  if (!scoreableGames.length) return { trainGames: [], testGames: [], splitDate: null };
  // Build the date -> count map in chronological order.
  const dateCounts = new Map();
  for (const sg of scoreableGames) {
    dateCounts.set(sg.snapshotDate, (dateCounts.get(sg.snapshotDate) || 0) + 1);
  }
  const sortedDates = [...dateCounts.keys()].sort();
  const targetTrainN = scoreableGames.length * trainFraction;
  let running = 0;
  let splitDate = sortedDates[0];
  for (const d of sortedDates) {
    if (running + dateCounts.get(d) > targetTrainN && running > 0) break;
    running += dateCounts.get(d);
    splitDate = d;
  }
  const trainGames = [];
  const testGames  = [];
  for (const sg of scoreableGames) {
    if (sg.snapshotDate <= splitDate) trainGames.push(sg);
    else                              testGames.push(sg);
  }
  return { trainGames, testGames, splitDate };
}

// Buckets that constitute the optimize-target for each mode. The
// ranking pipeline reads from these directly so it is impossible for
// a non-target bucket's ROI to leak into the sort. The 'all' mode is
// the union of every bucket — intentionally distinct from 'totals'
// and 'ml' so a totals optimization run never sees favs/dogs ROI
// influence rank order.
function targetBucketsFor(optimizeFor) {
  if (optimizeFor === 'totals') return ['overs', 'unders'];
  if (optimizeFor === 'ml')     return ['favs', 'dogs'];
  return ['favs', 'dogs', 'overs', 'unders'];
}

// Compute the optimize-target ROI for a byCategory aggregate. For
// 'totals' the metric is combined overs+unders ROI; for 'ml' it's
// favs+dogs; for 'all' it's the union of all four buckets. The
// returned object is the SOLE input to ranking — sort code MUST NOT
// read roi_pct off byCat[<bucket>] or compute its own union.
function targetMetric(byCat, optimizeFor) {
  const buckets = targetBucketsFor(optimizeFor);
  let pnl = 0, wagered = 0, bets = 0;
  for (const k of buckets) {
    const b = byCat[k];
    pnl += b.pnl;
    wagered += b.wagered;
    bets += b.bets;
  }
  return {
    bets,
    pnl: Math.round(pnl * 100) / 100,
    wagered: Math.round(wagered * 100) / 100,
    roi_pct: wagered > 0 ? Math.round((pnl / wagered) * 10000) / 100 : null,
    buckets,
  };
}

// Sample-size check on the RANKED target's bucket count. Returns true
// when the target-bucket sample is too thin to trust the ROI signal.
// For 'totals' we threshold on overs+unders count, for 'ml' on
// favs+dogs count, for 'all' both bucket-pairs must individually clear
// their threshold — otherwise a 5-favs-bets hot streak in an 'all'
// run could float to the top off a +28% ML-side ROI just because the
// thin sample happened to combine favorably with mediocre totals ROI.
function isLowSample(byCat, optimizeFor, minTotalsSample, minMlSample) {
  const totalsBets = byCat.overs.bets + byCat.unders.bets;
  const mlBets     = byCat.favs.bets  + byCat.dogs.bets;
  if (optimizeFor === 'totals') return totalsBets < minTotalsSample;
  if (optimizeFor === 'ml')     return mlBets     < minMlSample;
  return (totalsBets < minTotalsSample) || (mlBets < minMlSample);
}

// Main entry. Caller provides db handle, base getSettings() output, a
// {from, to} date window, a mode, and tuning opts:
//   opts.optimizeFor      'totals' | 'ml' | 'all'   (default 'all')
//   opts.minTotalsSample  Number                     (default 30) —
//                         threshold on overs+unders bet count.
//   opts.minMlSample      Number                     (default 30) —
//                         threshold on favs+dogs bet count. Parallel
//                         to minTotalsSample; the one that applies is
//                         determined by optimizeFor (both for 'all').
//   opts.trainFraction    0 < x < 1                  (default 0.7)
//   opts.topN             Number                     (default 10) —
//                         how many top-ranked combos to re-score on TEST.
//   opts.betSelection     'emit_floor' | 'ui_highlight'  (default 'emit_floor')
//                         Which aggregate drives ranking. 'emit_floor'
//                         ranks by ROI over every signal >=
//                         SIGNAL_EMIT_FLOOR_PP (the old behavior).
//                         'ui_highlight' ranks by ROI over the UI-
//                         highlighted subset only — what the user
//                         actually bets. Both aggregates are computed
//                         and reported per combo regardless of choice.
async function runParameterSweep(db, baseSettings, opts) {
  const start = Date.now();
  const mode = opts.mode;
  const fromDate = opts.from;
  const toDate   = opts.to;
  const optimizeFor    = (opts.optimizeFor || 'all').toLowerCase();
  const minTotalsSample = (opts.minTotalsSample != null) ? Number(opts.minTotalsSample) : 30;
  const minMlSample     = (opts.minMlSample     != null) ? Number(opts.minMlSample)     : 30;
  const trainFraction  = (opts.trainFraction != null)  ? Number(opts.trainFraction)  : 0.7;
  const topN           = (opts.topN != null)           ? Number(opts.topN)           : 10;
  const betSelection   = (opts.betSelection || 'emit_floor').toLowerCase();
  if (!mode || (mode !== 'univariate' && mode !== 'joint')) {
    throw new Error('mode must be "univariate" or "joint"');
  }
  if (!fromDate || !toDate) throw new Error('from + to dates required');
  if (!['totals', 'ml', 'all'].includes(optimizeFor)) {
    throw new Error('optimizeFor must be one of "totals", "ml", "all"');
  }
  if (!['emit_floor', 'ui_highlight'].includes(betSelection)) {
    throw new Error('betSelection must be "emit_floor" or "ui_highlight"');
  }
  if (!(trainFraction > 0 && trainFraction < 1)) {
    throw new Error('trainFraction must be strictly between 0 and 1');
  }

  // UI-highlight thresholds: read once from app_settings at the top so
  // every combo's scoreGames call uses the same threshold definition.
  // Required input to the by_category_highlight aggregate even when
  // betSelection='emit_floor' — the highlight numbers ride along in
  // every result row regardless, since the brief mandates side-by-side
  // reporting of both selections.
  const uiThresholds = loadUiHighlightThresholds(db);
  console.log('[sweep] ui_highlight_thresholds: fav>=' + uiThresholds.fav_min_pp
    + ', dog>=' + uiThresholds.dog_min_pp + ', under>=' + uiThresholds.under_min_pp
    + ', overs_enabled=' + uiThresholds.overs_enabled);
  console.log('[sweep] bet_selection (drives ranking)=' + betSelection);

  // Yield once at the very top — under feat/totals-sweep-async this
  // function is called from a setImmediate inside the POST handler, so
  // the HTTP response is queued in the socket buffer but not flushed
  // until the event loop next idles. An immediate await lets Node
  // process the pending write before we monopolize the loop.
  await new Promise((r) => setImmediate(r));

  // Stage 1: load + snapshot + pre-screen (unchanged).
  const games = loadGames(db, fromDate, toDate);
  console.log('[sweep] loaded ' + games.length + ' games in window ' + fromDate + '..' + toDate);

  const wobaCache = new Map();
  const seenDates = new Set();
  for (const g of games) seenDates.add(g.game_date);
  let gamesNoSnapshot = 0;
  for (const date of seenDates) {
    const idx = loadWobaSnapshot(db, date);
    if (idx) wobaCache.set(date, idx);
  }
  const scoreableGames = [];
  for (const g of games) {
    const wobaIdx = wobaCache.get(g.game_date);
    if (!wobaIdx) { gamesNoSnapshot++; continue; }
    const wrapped = preScreenGame(g, wobaIdx, baseSettings);
    if (wrapped) scoreableGames.push({ game: wrapped, wobaIdx, snapshotDate: g.game_date });
  }
  console.log('[sweep] ' + scoreableGames.length + ' scoreable games (' + gamesNoSnapshot + ' missing snapshot, '
    + (games.length - scoreableGames.length - gamesNoSnapshot) + ' suppressed)');

  // Stage 1b: train/test split. Done in-engine so callers can't
  // accidentally fit on test data. trainFraction default 0.7 lines up
  // with the brief; whole-date partitioning avoids same-day signal
  // leak between train and test.
  const { trainGames, testGames, splitDate } = splitTrainTest(scoreableGames, trainFraction);
  console.log('[sweep] train/test split: ' + trainGames.length + ' train (≤ ' + splitDate
    + '), ' + testGames.length + ' test (> ' + splitDate + ')');

  // Stage 2: build sp-start index once (parameter-independent).
  let spStartIndex;
  try { spStartIndex = buildSpStartIndex(db, baseSettings); }
  catch (e) { spStartIndex = null; }

  const combos = buildCombinations(mode, baseSettings);
  console.log('[sweep] mode=' + mode + ' combinations=' + combos.length
    + ' optimizeFor=' + optimizeFor);

  // Stage 3: inner loop. Each combo's metrics on TRAIN only — the
  // expensive part. Test-set scoring is deferred to the top-K +
  // baseline stage below so the joint sweep doesn't pay for N test
  // re-scores too.
  const results = [];
  let cIdx = 0;
  // Progress cadence: floor(N/20) prints ~5% of the way through, scaled
  // by combo count. Univariate (58 combos) → every 2 combos; joint
  // (125) → every 6. The previous every-100 threshold never fired on
  // univariate, which made the sweep look frozen and was the root of
  // the fix/sweep-runaway-loop false alarm.
  const progressEvery = Math.max(1, Math.floor(combos.length / 20));
  for (const combo of combos) {
    const settings = applySweepOverrides(baseSettings, combo.override);
    const trainScored = scoreGames(settings, trainGames, uiThresholds);
    results.push({
      settings: combo.settings,
      swept_param: combo.sweptParam,
      train: {
        by_category_emit:      trainScored.by_category_emit,
        by_category_highlight: trainScored.by_category_highlight,
        signals:               trainScored.signals,
      },
    });
    cIdx++;
    if (cIdx % progressEvery === 0 || cIdx === combos.length) {
      const elapsedS  = (Date.now() - start) / 1000;
      const perCombo  = elapsedS / cIdx;
      const remaining = combos.length - cIdx;
      const etaS      = perCombo * remaining;
      console.log('[sweep] progress: ' + cIdx + '/' + combos.length
        + ' (' + Math.round(cIdx / combos.length * 100) + '%) — elapsed '
        + elapsedS.toFixed(1) + 's, ETA ' + etaS.toFixed(0) + 's ('
        + (etaS / 60).toFixed(1) + 'm) at ' + perCombo.toFixed(2) + 's/combo');
    }
    // Yield to the event loop every combo so the async POST handler's
    // HTTP response actually gets written to the client and any other
    // small requests (GET /admin/parameter-sweep/:run_id polls) can
    // be served while this sweep runs. The yield is ~0ms when nothing
    // else is queued; cost across 58/125 combos ~= negligible.
    await new Promise((r) => setImmediate(r));
  }

  // Stage 4: rank STRICTLY by the train target metric of the chosen
  // betSelection aggregate. For betSelection='emit_floor' we rank by
  // the same ROI the prior sweeps used (every signal >=
  // SIGNAL_EMIT_FLOOR_PP); for 'ui_highlight' we rank by the ROI of
  // the picks the user actually bets. Both aggregates are always
  // computed so the response can show emit vs highlight side-by-side
  // regardless of which one drove the rank.
  //
  // No other bucket's ROI may influence rank. Sample-size gating is
  // target-AND-selection-aware too: a combo whose ranked-aggregate
  // target-bucket bet count is under threshold (minTotalsSample for
  // totals, minMlSample for ml, both required for 'all') gets
  // low_sample=true and sorts to the bottom regardless of how
  // favourable its ROI looks. Under 'ui_highlight' selection this
  // matters more: many combos that look healthy under emit-floor
  // will have far fewer highlighted bets (the user's actual play
  // volume) and should not float to the top off a tiny n.
  for (const r of results) {
    r.train_target_emit      = targetMetric(r.train.by_category_emit,      optimizeFor);
    r.train_target_highlight = targetMetric(r.train.by_category_highlight, optimizeFor);
    const ranked = betSelection === 'ui_highlight' ? r.train.by_category_highlight : r.train.by_category_emit;
    r.train_target = betSelection === 'ui_highlight' ? r.train_target_highlight    : r.train_target_emit;
    r.low_sample   = isLowSample(ranked, optimizeFor, minTotalsSample, minMlSample);
  }
  results.sort((a, b) => {
    if (a.low_sample !== b.low_sample) return a.low_sample ? 1 : -1;
    const aR = a.train_target.roi_pct == null ? -Infinity : a.train_target.roi_pct;
    const bR = b.train_target.roi_pct == null ? -Infinity : b.train_target.roi_pct;
    if (bR !== aR) return bR - aR;
    // Tie-break: prefer the larger ranked-target sample so equal-ROI
    // ties resolve toward the more statistically grounded combo.
    return b.train_target.bets - a.train_target.bets;
  });

  // Stage 5: re-score top-K combos on TEST. Plus baseline (current
  // production settings) on train AND test for the compare-to-not-
  // changing reference point. Baseline is the same regardless of
  // mode — what's currently in app_settings. Dual aggregates +
  // signal logs on every row so the response stays self-describing
  // under whichever betSelection drove ranking.
  const baselineTrainScored = scoreGames(baseSettings, trainGames, uiThresholds);
  const baselineTestScored  = scoreGames(baseSettings, testGames,  uiThresholds);
  const baseline = {
    settings: baseEffectiveSettings(baseSettings),
    train: {
      by_category_emit:      baselineTrainScored.by_category_emit,
      by_category_highlight: baselineTrainScored.by_category_highlight,
      signals:               baselineTrainScored.signals,
      target_emit:           targetMetric(baselineTrainScored.by_category_emit,      optimizeFor),
      target_highlight:      targetMetric(baselineTrainScored.by_category_highlight, optimizeFor),
    },
    test: {
      by_category_emit:      baselineTestScored.by_category_emit,
      by_category_highlight: baselineTestScored.by_category_highlight,
      signals:               baselineTestScored.signals,
      target_emit:           targetMetric(baselineTestScored.by_category_emit,      optimizeFor),
      target_highlight:      targetMetric(baselineTestScored.by_category_highlight, optimizeFor),
    },
  };

  for (let i = 0; i < Math.min(topN, results.length); i++) {
    const r = results[i];
    const settings = applySweepOverrides(baseSettings, deriveOverrideFromCombo(r));
    const testScored = scoreGames(settings, testGames, uiThresholds);
    r.test = {
      by_category_emit:      testScored.by_category_emit,
      by_category_highlight: testScored.by_category_highlight,
      signals:               testScored.signals,
      target_emit:           targetMetric(testScored.by_category_emit,      optimizeFor),
      target_highlight:      targetMetric(testScored.by_category_highlight, optimizeFor),
    };
    await new Promise((rr) => setImmediate(rr));
  }

  const elapsedMs = Date.now() - start;
  const notes = [];
  if (mode === 'joint' && elapsedMs > 5 * 60 * 1000) {
    notes.push('joint mode took ' + (elapsedMs / 1000).toFixed(1) + 's — exceeds the 5-minute soft target; consider optimizing the inner loop or reducing settings count');
  }
  // Test-set sufficiency note keyed off the threshold that actually
  // governs ranking — minTotalsSample for totals, minMlSample for ml,
  // the larger of the two for 'all' (since both must clear).
  const targetMinSample = optimizeFor === 'totals' ? minTotalsSample
                        : optimizeFor === 'ml'     ? minMlSample
                        : Math.max(minTotalsSample, minMlSample);
  if (testGames.length < targetMinSample * 2) {
    notes.push('test-set has only ' + testGames.length + ' games — test-set ROI for the target bucket will be thin; treat top-K test numbers as directional only until the snapshot corpus grows');
  }
  // Selection-effect decomposition. Cheap (operates on already-scored
  // signal tables) and reported unconditionally, so no future sweep
  // repeats the W_PROJ/W_ACT mistake of reading a composition shift as
  // a pricing effect.
  const baseTrainSignals = baselineTrainScored.signals || [];
  for (const r of results) {
    r.vs_baseline_train = decomposeVsBaseline((r.train && r.train.signals) || [], baseTrainSignals);
    if (r.test && r.test.signals) {
      r.vs_baseline_test = decomposeVsBaseline(r.test.signals, baselineTestScored.signals || []);
    }
  }
  const selectionEffect = coreSignalStats(results, baseTrainSignals);
  console.log('[sweep] selection-effect: core_n=' + selectionEffect.core_n
    + '/' + selectionEffect.baseline_n + ' (' + selectionEffect.core_share_pct + '%)'
    + '  core_roi_span=' + selectionEffect.core_roi_span
    + ' -> ' + selectionEffect.interpretation);

  return {
    mode,
    selection_effect: selectionEffect,
    optimize_for: optimizeFor,
    bet_selection: betSelection,
    ui_highlight_thresholds: uiThresholds,
    target_buckets: targetBucketsFor(optimizeFor),
    min_totals_sample: minTotalsSample,
    min_ml_sample: minMlSample,
    train_fraction: trainFraction,
    date_window: { from: fromDate, to: toDate },
    train_test_split: {
      split_date: splitDate,
      train_window: { from: fromDate, to: splitDate },
      test_window:  { from: splitDate, to: toDate },   // 'from' here is the LAST train date; actual test starts the next day
      train_games: trainGames.length,
      test_games:  testGames.length,
    },
    base_settings_snapshot: baseEffectiveSettings(baseSettings),
    baseline,
    games_considered: games.length,
    games_no_snapshot: gamesNoSnapshot,
    games_scored: scoreableGames.length,
    elapsed_ms: elapsedMs,
    notes,
    results,
  };
}

// Recover the override object from a stored result row. The original
// combo's `override` is dropped after stage 3; reconstruct from the
// `settings` block + the swept_param flag (univariate) or all three
// blend params (joint).
function deriveOverrideFromCombo(r) {
  if (r.swept_param) {
    return { [r.swept_param]: r.settings[r.swept_param] };
  }
  // joint: blends-only
  return {
    W_PROJ_W_ACT:    r.settings.W_PROJ_W_ACT,
    BAT_HAND_SP:     r.settings.BAT_HAND_SP,
    BAT_HAND_RELIEF: r.settings.BAT_HAND_RELIEF,
  };
}

module.exports = {
  runParameterSweep,
  applySweepOverrides,
  buildCombinations,
  SWEEP_PARAMS,
  // exposed for the route + tests
  splitTrainTest,
  // Exposed 2026-08-21 so offline stats harnesses (rolling folds,
  // date-clustered bootstrap) can build the same scoreable-game corpus
  // the in-server sweep uses, rather than reimplementing the snapshot
  // binding and pre-screen and drifting from it.
  loadGames,
  sampleGames,
  loadWobaSnapshot,
  preScreenGame,
  targetMetric,
  targetBucketsFor,
  isLowSample,
  scoreGames,
  signalKey,
  decomposeVsBaseline,
  coreSignalStats,
  roiBootstrapCI,
  estimateRuntimeSec,
  cleanupOrphanedSweepRuns,
  loadUiHighlightThresholds,
  isHighlightedSignal,
};
