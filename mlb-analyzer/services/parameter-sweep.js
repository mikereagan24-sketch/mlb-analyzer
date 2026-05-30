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
// W_PROJ_W_ACT and SP_BULLPEN_MIX are complementary pairs (the second
// half is 1 - sweep_value). BAT_HAND_SP and BAT_HAND_RELIEF are
// independent scalars (the model passes them as separate args to
// perBatterEW — in production they're constrained near 1 via the
// settings-schema invariants, but the sweep deliberately allows
// out-of-schema values to probe the model's behavior at extremes).
const SWEEP_PARAMS = ['W_PROJ_W_ACT', 'SP_BULLPEN_MIX', 'BAT_HAND_SP', 'BAT_HAND_RELIEF'];

function applySweepOverrides(baseSettings, overrides) {
  const s = Object.assign({}, baseSettings);
  if ('W_PROJ_W_ACT' in overrides) {
    s.W_PROJ = overrides.W_PROJ_W_ACT;
    s.W_ACT  = 1 - overrides.W_PROJ_W_ACT;
  }
  if ('SP_BULLPEN_MIX' in overrides) {
    s.SP_PIT_WEIGHT     = overrides.SP_BULLPEN_MIX;
    s.RELIEF_PIT_WEIGHT = 1 - overrides.SP_BULLPEN_MIX;
  }
  if ('BAT_HAND_SP' in overrides) s.SP_WEIGHT     = overrides.BAT_HAND_SP;
  if ('BAT_HAND_RELIEF' in overrides) s.RELIEF_WEIGHT = overrides.BAT_HAND_RELIEF;
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

// Build the full settings combinations for a sweep mode.
//   univariate: for each of the 4 params, sweep 0.1..0.9 step 0.1 with
//               all other params at their production base.
//   joint:      cartesian product of 5 settings per param across all
//               four params (5^4 = 625).
function buildCombinations(mode, baseSettings) {
  const combos = [];
  if (mode === 'univariate') {
    const settings = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    for (const param of SWEEP_PARAMS) {
      for (const v of settings) {
        // Record full effective values for ALL 4 params, with the swept
        // param at v and the others at their base — makes the response
        // self-describing without needing the caller to reconstruct.
        const o = {
          W_PROJ_W_ACT:    Number(baseSettings.W_PROJ),
          SP_BULLPEN_MIX:  Number(baseSettings.SP_PIT_WEIGHT),
          BAT_HAND_SP:     Number(baseSettings.SP_WEIGHT),
          BAT_HAND_RELIEF: Number(baseSettings.RELIEF_WEIGHT),
        };
        o[param] = v;
        // The swept-only override is what we actually apply to settings —
        // the others are reported but their base values flow through.
        combos.push({ sweptParam: param, settings: o, override: { [param]: v } });
      }
    }
  } else if (mode === 'joint') {
    const settings = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const a of settings)
    for (const b of settings)
    for (const c of settings)
    for (const d of settings) {
      const o = { W_PROJ_W_ACT: a, SP_BULLPEN_MIX: b, BAT_HAND_SP: c, BAT_HAND_RELIEF: d };
      combos.push({ sweptParam: null, settings: o, override: o });
    }
  } else {
    throw new Error('unknown sweep mode: ' + mode);
  }
  return combos;
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
    const mr = runModel(wrapped, wobaIdx, baseSettings, 'opener_aware');
    if (mr && mr._suppressed) return null;
    return wrapped; // re-use the wrapped object across combos
  } catch (e) {
    return null;
  }
}

function safeJson(s) {
  try { return JSON.parse(s) || []; } catch (e) { return []; }
}

// Main entry. Caller provides db handle, base getSettings() output, a
// {from, to} date window, and a mode. Returns the full response shape
// described in the brief.
async function runParameterSweep(db, baseSettings, opts) {
  const start = Date.now();
  const mode = opts.mode;
  const fromDate = opts.from;
  const toDate   = opts.to;
  if (!mode || (mode !== 'univariate' && mode !== 'joint')) {
    throw new Error('mode must be "univariate" or "joint"');
  }
  if (!fromDate || !toDate) throw new Error('from + to dates required');

  // Stage 1: load every game in the window once. Discard games whose
  // model_total is null (the model has never produced output for them —
  // typically pre-2026-04-09 or future games).
  const games = loadGames(db, fromDate, toDate);
  console.log('[sweep] loaded ' + games.length + ' games in window ' + fromDate + '..' + toDate);

  // Stage 2: build wOBA snapshot cache keyed by snapshot_date. One scan
  // per distinct date in the window — typically ~10 dates for a 2-week
  // window, ~30 for a month.
  const wobaCache = new Map();
  const seenDates = new Set();
  for (const g of games) seenDates.add(g.game_date);
  let gamesNoSnapshot = 0;
  for (const date of seenDates) {
    const idx = loadWobaSnapshot(db, date);
    if (idx) wobaCache.set(date, idx);
  }
  // Pre-screen games once with base settings to weed out _suppressed ones
  // (partial lineups, missing SP info). The same wrapped game object is
  // reused across combos — runModel doesn't mutate its inputs.
  const scoreableGames = [];
  for (const g of games) {
    const wobaIdx = wobaCache.get(g.game_date);
    if (!wobaIdx) { gamesNoSnapshot++; continue; }
    const wrapped = preScreenGame(g, wobaIdx, baseSettings);
    if (wrapped) scoreableGames.push({ game: wrapped, wobaIdx, snapshotDate: g.game_date });
  }
  console.log('[sweep] ' + scoreableGames.length + ' scoreable games (' + gamesNoSnapshot + ' missing snapshot, '
    + (games.length - scoreableGames.length - gamesNoSnapshot) + ' suppressed)');

  // Stage 3: build sp-start index once (snapshot-of-now; this is
  // parameter-independent and the model only reads it for IP forecasts
  // which don't affect the parameters we're sweeping).
  let spStartIndex;
  try { spStartIndex = buildSpStartIndex(db, baseSettings); }
  catch (e) { spStartIndex = null; }

  const combos = buildCombinations(mode, baseSettings);
  console.log('[sweep] mode=' + mode + ' combinations=' + combos.length);

  // Stage 4: inner loop. For each combination, walk scoreableGames,
  // re-run runModel under the overridden settings, derive signals via
  // getSignals (uses the SAME pp-edge math the production write path
  // uses; settings.SIGNAL_EMIT_FLOOR_PP defaults to 0.01 = 1pp), grade
  // each signal via calcPnl against the game's actual scores, and
  // bucket into favs/dogs/overs/unders.
  const results = [];
  let cIdx = 0;
  for (const combo of combos) {
    const settings = applySweepOverrides(baseSettings, combo.override);
    const byCat = emptyByCategory();
    for (const sg of scoreableGames) {
      const mr = runModel(sg.game, sg.wobaIdx, settings, 'opener_aware');
      if (mr && mr._suppressed) continue;
      const sigs = getSignals(sg.game, mr, settings);
      for (const s of sigs) {
        // Only count signals with a real outcome — calcPnl returns
        // 'pending' when the game isn't scored yet. The sweep window
        // is historical so most games are scored, but a forward-edge
        // pending tail is harmless.
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
    results.push({ settings: combo.settings, swept_param: combo.sweptParam, by_category: byCat });
    cIdx++;
    if (cIdx % 100 === 0) {
      console.log('[sweep] progress: ' + cIdx + '/' + combos.length
        + ' (' + Math.round(cIdx / combos.length * 100) + '%) — elapsed ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
    }
  }

  const elapsedMs = Date.now() - start;
  const notes = [];
  if (mode === 'joint' && elapsedMs > 5 * 60 * 1000) {
    notes.push('joint mode took ' + (elapsedMs / 1000).toFixed(1) + 's — exceeds the 5-minute soft target; consider optimizing the inner loop or reducing settings count');
  }
  return {
    mode,
    date_window: { from: fromDate, to: toDate },
    base_settings_snapshot: {
      W_PROJ:             Number(baseSettings.W_PROJ),
      W_ACT:              Number(baseSettings.W_ACT),
      SP_PIT_WEIGHT:      Number(baseSettings.SP_PIT_WEIGHT),
      RELIEF_PIT_WEIGHT:  Number(baseSettings.RELIEF_PIT_WEIGHT),
      SP_WEIGHT:          Number(baseSettings.SP_WEIGHT),
      RELIEF_WEIGHT:      Number(baseSettings.RELIEF_WEIGHT),
    },
    games_considered: games.length,
    games_no_snapshot: gamesNoSnapshot,
    games_scored: scoreableGames.length,
    elapsed_ms: elapsedMs,
    notes,
    results,
  };
}

module.exports = {
  runParameterSweep,
  applySweepOverrides,
  buildCombinations,
  SWEEP_PARAMS,
};
