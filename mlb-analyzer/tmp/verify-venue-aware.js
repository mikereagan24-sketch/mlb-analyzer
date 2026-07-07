// Verify SIGNAL_VENUE_AWARE_ENABLED: score today's slate both ways using the
// actual services/odds-comparison runComparison winner shape, and produce
// the side-by-side signal diff the PR brief requires. COL@LAD specifically
// gets highlighted so the +240-vs-+228 case the owner flagged is visible.
//
// This runs the actual code paths:
//   1. Load today's game_log rows + settings.
//   2. Call runComparison for today's date, build rowsByGid.
//   3. For each game: run runModel + getSignals under both scenarios:
//        A. Kalshi-only market_line (current behavior)
//        B. Venue-best market_line (this PR)
//      Diff the signal populations.
//   4. Print COL@LAD specifically with edges vs both market lines.
//
// Note: does NOT write bet_signals — read-only verification.

const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'mlb.db');
process.env.DB_PATH = dbPath;

const { q, db } = require('../db/schema');
const { runModel, getSignals } = require('../services/model');
const { runComparison } = require('../services/odds-comparison');

function fmt(n, d) { return n == null ? 'null' : Number(n).toFixed(d); }

function loadSettings() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  const num = (k, def) => { const v = Number(s[k]); return Number.isFinite(v) ? v : def; };
  return {
    RUN_MULT: num('run_mult', 45.5),
    HFA_BOOST: num('hfa_boost', 0.025),
    W_PIT: num('w_pit', 0.4),
    W_BAT: num('w_bat', 0.6),
    W_PROJ: num('w_proj', 0.45),
    W_ACT: num('w_act', 0.55),
    SP_WEIGHT: num('sp_weight', 0.80),
    RELIEF_WEIGHT: num('relief_weight', 0.20),
    SP_PIT_WEIGHT: num('sp_pit_weight', 0.75),
    RELIEF_PIT_WEIGHT: num('relief_pit_weight', 0.25),
    BP_STRONG_WEIGHT_R: num('bp_strong_weight_r', 0.55),
    BP_WEAK_WEIGHT_R:   num('bp_weak_weight_r',   0.45),
    BP_STRONG_WEIGHT_L: num('bp_strong_weight_l', 0.35),
    BP_WEAK_WEIGHT_L:   num('bp_weak_weight_l',   0.65),
    BULLPEN_AVG: num('bullpen_avg', 0.318),
    WOBA_BASELINE: num('woba_baseline', 0.230),
    PYTH_EXP: num('pyth_exp', 1.83),
    TOT_SLOPE: num('tot_slope', 0.08),
    MIN_PA: num('min_pa', 60),
    MIN_BF: num('min_bf', 100),
    BULLPEN_MIN_BF: num('bullpen_min_bf', 50),
    BULLPEN_W_PROJ: num('bullpen_w_proj', 0.25),
    BULLPEN_W_ACT:  num('bullpen_w_act',  0.75),
    UNKNOWN_PITCHER_WOBA: num('unknown_pitcher_woba', 0.335),
    WP_CLAMP_LO: num('wp_clamp_lo', 0.3),
    WP_CLAMP_HI: num('wp_clamp_hi', 0.7),
    TOT_PROB_LO: num('tot_prob_lo', 0.3),
    TOT_PROB_HI: num('tot_prob_hi', 0.7),
    MARKET_TOTAL_DFLT: num('market_total_dflt', 8.5),
    SIGNAL_EMIT_FLOOR_PP: num('signal_emit_floor_pp', 0.01),
    SIGNAL_EDGE_SOFT_CAP_PP: num('signal_edge_soft_cap_pp', 0.10),
    SIGNAL_EDGE_HARD_CAP_PP: num('signal_edge_hard_cap_pp', 0.25),
    BULLPEN_DOWNWEIGHT_STARTERS: s['bullpen_downweight_starters'] === 'true',
    PARK_NEUTRAL_INPUTS_ENABLED: s['park_neutral_inputs_enabled'] === 'true',
    SIGNAL_EDGE_CAP_ENABLED: s['signal_edge_cap_enabled'] === 'true',
    BAT_DFLT_R_VS_RHP: num('bat_dflt_r_vs_rhp', 0.305),
    BAT_DFLT_R_VS_LHP: num('bat_dflt_r_vs_lhp', 0.325),
    BAT_DFLT_L_VS_RHP: num('bat_dflt_l_vs_rhp', 0.330),
    BAT_DFLT_L_VS_LHP: num('bat_dflt_l_vs_lhp', 0.290),
    BAT_DFLT_S_VS_RHP: num('bat_dflt_s_vs_rhp', 0.322),
    BAT_DFLT_S_VS_LHP: num('bat_dflt_s_vs_lhp', 0.308),
    PIT_DFLT_R_VS_LHB: num('pit_dflt_r_vs_lhb', 0.320),
    PIT_DFLT_R_VS_RHB: num('pit_dflt_r_vs_rhb', 0.295),
    PIT_DFLT_L_VS_LHB: num('pit_dflt_l_vs_lhb', 0.285),
    PIT_DFLT_L_VS_RHB: num('pit_dflt_l_vs_rhb', 0.330),
  };
}

function pickBestML(row, side) {
  if (!row) return null;
  const P = row.poly && row.poly[side];
  const K = row.kalshi && row.kalshi[side];
  const polyOK = P && P.net_american != null && !P.partial;
  const kalOK  = K && K.net_american != null && !K.partial;
  if (!polyOK && !kalOK) return null;
  if (polyOK && !kalOK) return { ml: P.net_american, venue: 'poly' };
  if (kalOK && !polyOK) return { ml: K.net_american, venue: 'kalshi' };
  return P.net_american >= K.net_american
    ? { ml: P.net_american, venue: 'poly' }
    : { ml: K.net_american, venue: 'kalshi' };
}

function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function main() {
  const date = process.argv[2] || '2026-07-07';
  console.log('=== venue-aware signal diff — ' + date + ' ===');
  const games = db.prepare("SELECT * FROM game_log WHERE game_date=? ORDER BY game_id").all(date);
  console.log('games in log: ' + games.length);

  console.log('\nfetching venue comparison slate for ' + date + '...');
  const cmp = await runComparison(date, {});
  const rowsByGid = {};
  for (const r of (cmp.rows || [])) if (r.game_id) rowsByGid[r.game_id] = r;
  console.log('priced ' + Object.keys(rowsByGid).length + ' games');

  const settings = loadSettings();
  // wobaIdx isn't cheap to build; try to reuse the app's if available.
  const woba = require('../services/model');
  // getWobaIndex is often not exported; build a minimal one from woba_data.
  const wobaIdx = {};
  const KEYS = ['pit-proj-lhb','pit-proj-rhb','pit-act-lhb','pit-act-rhb','bat-proj-lhp','bat-proj-rhp','bat-act-lhp','bat-act-rhp'];
  for (const k of KEYS) {
    wobaIdx[k] = {};
    const rows = db.prepare("SELECT player_name, woba, sample_size, team_abbr FROM woba_data WHERE data_key=?").all(k);
    for (const r of rows) {
      const norm = r.player_name.toLowerCase().trim();
      wobaIdx[k][norm] = { woba: r.woba, sample: r.sample_size };
      if (r.team_abbr) wobaIdx[k][norm + ' ' + r.team_abbr.toLowerCase()] = { woba: r.woba, sample: r.sample_size };
    }
  }

  const diffs = [];
  const highlight = 'col-lad';

  for (const gl of games) {
    const rowForGame = rowsByGid[gl.game_id];
    const bestA = pickBestML(rowForGame, 'away');
    const bestH = pickBestML(rowForGame, 'home');

    const gameBase = {
      ...gl,
      awayLineup: tryParse(gl.away_lineup_json) || [],
      homeLineup: tryParse(gl.home_lineup_json) || [],
      awayBullpenWoba: 0.30,
      homeBullpenWoba: 0.30,
      awaySpProjIP: null, homeSpProjIP: null,
    };
    let modelA, modelB;
    try { modelA = runModel(gameBase, wobaIdx, settings, 'standard'); }
    catch (e) { continue; }

    const gameVenue = { ...gameBase };
    if (bestA) gameVenue.market_away_ml = bestA.ml;
    if (bestH) gameVenue.market_home_ml = bestH.ml;
    try { modelB = runModel(gameVenue, wobaIdx, settings, 'standard'); }
    catch (e) { continue; }

    const sigsA = getSignals(gameBase, modelA, settings, []);
    const sigsB = getSignals(gameVenue, modelB, settings, []);

    // Build maps by (type, side) for diffing
    const mapA = {}; for (const s of sigsA) mapA[s.type+'|'+s.side] = s;
    const mapB = {}; for (const s of sigsB) mapB[s.type+'|'+s.side] = s;
    const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);

    let changed = false;
    const rowDiffs = [];
    for (const key of keys) {
      const a = mapA[key]; const b = mapB[key];
      const stateA = a ? (a.edge*100).toFixed(2)+'pp' : '—';
      const stateB = b ? (b.edge*100).toFixed(2)+'pp' : '—';
      if (stateA !== stateB) {
        changed = true;
        rowDiffs.push({ key, kalshi: stateA, venue: stateB, delta: (b && a) ? ((b.edge - a.edge)*100).toFixed(2)+'pp' : (b ? '+NEW' : '−GONE') });
      }
    }
    if (changed) {
      diffs.push({ game_id: gl.game_id, mkt_kal: { away: gl.market_away_ml, home: gl.market_home_ml },
        mkt_ven: { away: bestA?.ml, home: bestH?.ml, venue_a: bestA?.venue, venue_h: bestH?.venue },
        rows: rowDiffs });
    }
  }

  console.log('\n=== side-by-side signal diff (games where venue-aware changes something) ===');
  console.log('games with any diff: ' + diffs.length + ' / ' + games.length);
  for (const d of diffs) {
    console.log('\n' + d.game_id.toUpperCase() + ':  kalshi mkt away/home = ' + d.mkt_kal.away + '/' + d.mkt_kal.home
      + '   venue best away/home = ' + (d.mkt_ven.away||'?') + '(' + (d.mkt_ven.venue_a||'?') + ')/' + (d.mkt_ven.home||'?') + '(' + (d.mkt_ven.venue_h||'?') + ')');
    for (const r of d.rows) {
      console.log('  ' + r.key.padEnd(14) + ' kalshi=' + r.kalshi.padEnd(8) + ' venue=' + r.venue.padEnd(8) + '  Δ=' + r.delta);
    }
  }

  // Highlight COL@LAD specifically
  const colGame = games.find(g => g.game_id === highlight);
  const colCmp = rowsByGid[highlight];
  console.log('\n=== COL@LAD highlight ===');
  if (!colGame) console.log('game not in log');
  if (!colCmp)  console.log('game not in comparison');
  if (colGame && colCmp) {
    console.log('Kalshi ML  away/home :', colGame.market_away_ml, '/', colGame.market_home_ml);
    console.log('Poly best  away/home :', colCmp.poly.away?.net_american, '(part=' + colCmp.poly.away?.partial + ')  /  ',
                                          colCmp.poly.home?.net_american, '(part=' + colCmp.poly.home?.partial + ')');
    console.log('Kal  best  away/home :', colCmp.kalshi.away?.net_american, '(part=' + colCmp.kalshi.away?.partial + ')  /  ',
                                          colCmp.kalshi.home?.net_american, '(part=' + colCmp.kalshi.home?.partial + ')');
    console.log('winner              :', colCmp.winner.away, '/', colCmp.winner.home);
    const bestA = pickBestML(colCmp, 'away');
    const bestH = pickBestML(colCmp, 'home');
    console.log('picked venue away   :', bestA ? bestA.venue + ' ml=' + bestA.ml : '— fallback');
    console.log('picked venue home   :', bestH ? bestH.venue + ' ml=' + bestH.ml : '— fallback');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
