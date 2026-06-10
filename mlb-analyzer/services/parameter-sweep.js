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
  if ('RUN_MULT'  in overrides) s.RUN_MULT  = overrides.RUN_MULT;
  if ('TOT_SLOPE' in overrides) s.TOT_SLOPE = overrides.TOT_SLOPE;
  return s;
}

// Compute the wagered amount per signal (mirrors the SQL in /backtest
// overall + the wageredForSignal helper in public/index.html so ROI is
// computed identically across sweep / backtest API / UI display).
function wageredFor(signal) {
  if (signal.type === 'ML') {
    const ln = Number(signal.marketLine);
    if (!ln) return 0;
    return ln > 0 ? (10000 / ln) : Math.abs(ln);
  }
  return 110;
}

// Bucket a single emitted signal into one of {favs, dogs, overs, unders}.
function categoryFor(signal) {
  if (signal.type === 'ML') return Number(signal.marketLine) < 0 ? 'favs' : 'dogs';
  return signal.side === 'over' ? 'overs' : 'unders';
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
function loadGames(db, fromDate, toDate) {
  return db.prepare(
    "SELECT * FROM game_log WHERE game_date >= ? AND game_date <= ? "
    + "AND model_total IS NOT NULL "  // skip games the model never finished
    + "ORDER BY game_date, game_id"
  ).all(fromDate, toDate);
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

// Score ONE settings object against the supplied games. Returns a
// fresh byCategory aggregate (favs/dogs/overs/unders). Pure read —
// runModel doesn't mutate its inputs and getSignals/calcPnl are
// stateless. Used by both the combo loop AND the baseline / top-K
// re-score steps.
function scoreGames(settings, games) {
  const byCat = emptyByCategory();
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
      const bucket = byCat[cat];
      bucket.bets++;
      if (r.outcome === 'win')  bucket.wins++;
      if (r.outcome === 'loss') bucket.losses++;
      if (r.outcome === 'push') bucket.pushes++;
      const pnl = Number(r.pnl) || 0;
      bucket.pnl += pnl;
      if (r.outcome !== 'push') bucket.wagered += wageredFor(s);
    }
  }
  rollUpRoi(byCat);
  return byCat;
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
  if (!mode || (mode !== 'univariate' && mode !== 'joint')) {
    throw new Error('mode must be "univariate" or "joint"');
  }
  if (!fromDate || !toDate) throw new Error('from + to dates required');
  if (!['totals', 'ml', 'all'].includes(optimizeFor)) {
    throw new Error('optimizeFor must be one of "totals", "ml", "all"');
  }
  if (!(trainFraction > 0 && trainFraction < 1)) {
    throw new Error('trainFraction must be strictly between 0 and 1');
  }

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
    const trainByCat = scoreGames(settings, trainGames);
    results.push({
      settings: combo.settings,
      swept_param: combo.sweptParam,
      train: { by_category: trainByCat },
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

  // Stage 4: rank STRICTLY by the train target metric — the combined
  // ROI of the optimize-target buckets ONLY. For optimizeFor='totals'
  // that is overs+unders; for 'ml' it is favs+dogs; for 'all' it is
  // the union of all four. No other bucket's ROI may influence rank.
  //
  // Sample-size gating is target-aware too: a combo whose target-bucket
  // bet count is under threshold (minTotalsSample for totals,
  // minMlSample for ml, both required for 'all') gets low_sample=true
  // and sorts to the bottom regardless of how favourable its ROI looks.
  // This prevents a 5-favs/+28% combo from outranking a 90-bet combo
  // near breakeven in an ML run, and equivalently for totals.
  for (const r of results) {
    r.train_target = targetMetric(r.train.by_category, optimizeFor);
    r.low_sample   = isLowSample(r.train.by_category, optimizeFor, minTotalsSample, minMlSample);
  }
  results.sort((a, b) => {
    if (a.low_sample !== b.low_sample) return a.low_sample ? 1 : -1;
    const aR = a.train_target.roi_pct == null ? -Infinity : a.train_target.roi_pct;
    const bR = b.train_target.roi_pct == null ? -Infinity : b.train_target.roi_pct;
    if (bR !== aR) return bR - aR;
    // Tie-break: prefer the larger target sample so equal-ROI ties
    // resolve toward the more statistically grounded combo.
    return b.train_target.bets - a.train_target.bets;
  });

  // Stage 5: re-score top-K combos on TEST. Plus baseline (current
  // production settings) on train AND test for the compare-to-not-
  // changing reference point. Baseline is the same regardless of
  // mode — what's currently in app_settings.
  const baselineByCatTrain = scoreGames(baseSettings, trainGames);
  const baselineByCatTest  = scoreGames(baseSettings, testGames);
  const baseline = {
    settings: baseEffectiveSettings(baseSettings),
    train: {
      by_category: baselineByCatTrain,
      target: targetMetric(baselineByCatTrain, optimizeFor),
    },
    test: {
      by_category: baselineByCatTest,
      target: targetMetric(baselineByCatTest, optimizeFor),
    },
  };

  for (let i = 0; i < Math.min(topN, results.length); i++) {
    const r = results[i];
    const settings = applySweepOverrides(baseSettings, deriveOverrideFromCombo(r));
    const testByCat = scoreGames(settings, testGames);
    r.test = {
      by_category: testByCat,
      target: targetMetric(testByCat, optimizeFor),
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
  return {
    mode,
    optimize_for: optimizeFor,
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
  targetMetric,
  targetBucketsFor,
  isLowSample,
  scoreGames,
  estimateRuntimeSec,
  cleanupOrphanedSweepRuns,
};
