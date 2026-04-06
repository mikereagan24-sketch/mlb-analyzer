/**
 * Model service — pure functions, no DB access.
 * All weights/constants passed in from settings so they're adjustable.
 */

const PA_WEIGHTS = [4.60, 4.60, 4.60, 4.60, 4.30, 4.13, 4.01, 3.90, 3.77];

const BAT_DFLT = {
  R: { vsRHP: 0.305, vsLHP: 0.325 },
  L: { vsRHP: 0.330, vsLHP: 0.290 },
  S: { vsRHP: 0.322, vsLHP: 0.308 },
};
const PIT_DFLT = {
  R: { vsLHB: 0.320, vsRHB: 0.295 },
  L: { vsLHB: 0.285, vsRHB: 0.330 },
};

const MIN_PA = 60;
const MIN_BF = 100;

// ── NAME NORMALIZATION ────────────────────────────────────────────────────
function normName(n) {
  return (n || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// ── WOBA LOOKUP ───────────────────────────────────────────────────────────
/**
 * wobaDb: Map<dataKey, Array<{player_name, woba, sample_size}>>
 * Built once per request from DB rows.
 */
function buildWobaIndex(rows) {
  // rows is array of {data_key, player_name, woba, sample_size}
  const idx = {};
  for (const r of rows) {
    if (!idx[r.data_key]) idx[r.data_key] = {};
    idx[r.data_key][normName(r.player_name)] = { woba: r.woba, sample: r.sample_size };
  }
  return idx;
}

function fuzzyLookup(keyMap, name) {
  if (!keyMap) return null;
  const k = normName(name);
  if (keyMap[k]) return keyMap[k];
  const words = k.split(' ').filter(w => w.length > 2);
  if (!words.length) return null;
  const entry = Object.entries(keyMap).find(([key]) => words.every(w => key.includes(w)));
  return entry ? entry[1] : null;
}

function blendWoba(proj, act, minSample) {
  const hp = proj && !isNaN(proj.woba);
  const ha = act && !isNaN(act.woba) && act.sample >= minSample;
  if (hp && ha) return { woba: proj.woba * 0.65 + act.woba * 0.35, source: 'blend' };
  if (hp) return { woba: proj.woba, source: 'steamer' };
  if (ha) return { woba: act.woba, source: 'actual' };
  return null;
}

function getBatterWoba(idx, name, hand) {
  const bL = blendWoba(
    fuzzyLookup(idx['bat-proj-lhp'], name),
    fuzzyLookup(idx['bat-act-lhp'], name),
    MIN_PA
  );
  const bR = blendWoba(
    fuzzyLookup(idx['bat-proj-rhp'], name),
    fuzzyLookup(idx['bat-act-rhp'], name),
    MIN_PA
  );
  const eff = hand === 'S' ? 'R' : (hand || 'R');
  const d = BAT_DFLT[eff] || BAT_DFLT['R'];
  if (bL || bR) {
    const src = bL && bR ? (bL.source === bR.source ? bL.source : 'blend') : (bL?.source || bR?.source);
    return { vsLHP: bL?.woba ?? d.vsLHP, vsRHP: bR?.woba ?? d.vsRHP, source: src };
  }
  return { vsLHP: d.vsLHP, vsRHP: d.vsRHP, source: 'fallback' };
}

function getPitcherWoba(idx, name, hand) {
  const bL = blendWoba(
    fuzzyLookup(idx['pit-proj-lhb'], name),
    fuzzyLookup(idx['pit-act-lhb'], name),
    MIN_BF
  );
  const bR = blendWoba(
    fuzzyLookup(idx['pit-proj-rhb'], name),
    fuzzyLookup(idx['pit-act-rhb'], name),
    MIN_BF
  );
  const d = PIT_DFLT[hand] || PIT_DFLT['R'];
  const src = bL || bR
    ? (bL?.source === bR?.source ? bL?.source || 'steamer' : 'blend')
    : 'fallback';
  return { vsLHB: bL?.woba ?? d.vsLHB, vsRHB: bR?.woba ?? d.vsRHB, source: src };
}

// ── MODEL CORE ────────────────────────────────────────────────────────────
function effHand(bh, ph) {
  return bh === 'S' ? (ph === 'R' ? 'L' : 'R') : bh;
}

function perBatterEW(batter, pitcherHand, pitWvsL, pitWvsR, W_PIT, W_BAT) {
  const eff = effHand(batter.hand, pitcherHand);
  const pitW = eff === 'L' ? pitWvsL : pitWvsR;
  const batW = pitcherHand === 'R' ? (batter.vsRHP ?? 0.315) : (batter.vsLHP ?? 0.315);
  return pitW * W_PIT + batW * W_BAT;
}

function rawToML(wp) {
  const clamped = Math.min(Math.max(wp, 0.25), 0.75);
  return clamped >= 0.5
    ? -Math.round(clamped / (1 - clamped) * 100)
    : Math.round((1 - clamped) / clamped * 100);
}
function applySpread(aML, hML, FAV_ADJ, DOG_ADJ) {
  // Fav is whichever ML is more negative (lower value)
  const favIsAway = aML <= hML;
  const favML = favIsAway ? aML : hML;
  // Dog = fav * -1 - 15; if result < 100 (2 digits), add 10 and flip
  let dog = (favML * -1) - 15;
  if (Math.abs(dog) < 100) dog = -(dog + 10);
  return { adjA: favIsAway ? favML : dog, adjH: favIsAway ? dog : favML };
}
function impliedP(ml) {
  ml = parseFloat(ml);
  if (!ml || isNaN(ml)) return 0.5;
  return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100);
}

/**
 * Run the full model for one game.
 * settings: { RUN_MULT, HFA_BOOST, FAV_ADJ, DOG_ADJ, W_PIT, W_BAT }
 * lineups: { awayLineup, homeLineup } — arrays of {name, hand}
 * pitchers: { awaySP:{name,hand}, homeSP:{name,hand} }
 * wobaIdx: built from buildWobaIndex()
 */
function runModel(game, wobaIdx, settings) {
  const {
    RUN_MULT = 48, HFA_BOOST = 0.02,
    FAV_ADJ = 10, DOG_ADJ = 5,
    W_PIT = 0.5, W_BAT = 0.5,
  } = settings;

  const pwA = getPitcherWoba(wobaIdx, game.away_sp, game.away_sp_hand);
  const pwH = getPitcherWoba(wobaIdx, game.home_sp, game.home_sp_hand);

  const awayLU = (game.awayLineup || []).map(b => ({
    ...b,
    ...getBatterWoba(wobaIdx, b.name, b.hand),
  }));
  const homeLU = (game.homeLineup || []).map(b => ({
    ...b,
    ...getBatterWoba(wobaIdx, b.name, b.hand),
  }));

  // Away batters face HOME pitcher; home batters face AWAY pitcher
  let aWs = 0, aWp = 0;
  awayLU.forEach((b, i) => {
    const pa = PA_WEIGHTS[i] ?? 3.77;
    aWs += perBatterEW(b, game.home_sp_hand, pwH.vsLHB, pwH.vsRHB, W_PIT, W_BAT) * pa;
    aWp += pa;
  });

  let hWs = 0, hWp = 0;
  homeLU.forEach((b, i) => {
    const pa = PA_WEIGHTS[i] ?? 3.77;
    hWs += perBatterEW(b, game.away_sp_hand, pwA.vsLHB, pwA.vsRHB, W_PIT, W_BAT) * pa;
    hWp += pa;
  });

  const aTeamWoba = aWp > 0 ? aWs / aWp : 0.315;
  const hTeamWoba = hWp > 0 ? hWs / hWp : 0.315;
  const pf = game.park_factor || 1.0;
  const aRuns = Math.max(0, (aTeamWoba - 0.230) * RUN_MULT * pf);
  const hRuns = Math.max(0, (hTeamWoba - 0.230) * RUN_MULT * pf);
  const rawHW = (aRuns <= 0 && hRuns <= 0) ? 0.5 :
    hRuns <= 0 ? 0.25 :
    aRuns <= 0 ? 0.75 :
    hRuns ** 1.83 / (hRuns ** 1.83 + aRuns ** 1.83);
  const adjHW = Math.min(Math.max(rawHW + HFA_BOOST, 0.25), 0.75);
  const adjAW = 1 - adjHW;

  const rawAML = rawToML(adjAW);
  const rawHML = rawToML(adjHW);
  const { adjA: aML, adjH: hML } = applySpread(rawAML, rawHML, FAV_ADJ, DOG_ADJ);

  return {
    aTeamWoba, hTeamWoba, aRuns, hRuns,
    rawHW, adjHW, adjAW,
    aML, hML,
    estTot: aRuns + hRuns,
  };
}

// ── SIGNAL DETECTION ──────────────────────────────────────────────────────
function catKey(signalType, signalSide, signalLabel, marketLine) {
  if (signalType === 'ML') {
    const isFav = parseInt(marketLine) < 0;
    return `${signalLabel.toLowerCase()}-${isFav ? 'fav' : 'dog'}`;
  }
  return `${signalLabel.toLowerCase()}-${signalSide}`;
}

function getSignals(game, model, settings) {
  const {
    ML_VALUE_EDGE = 0.05, ML_LEAN_EDGE = 0.02,
    TOT_VALUE_EDGE = 0.4, TOT_LEAN_EDGE = 0.2,
  } = settings;

  const signals = [];
  const aEdge = model.adjAW - impliedP(game.market_away_ml);
  const hEdge = model.adjHW - impliedP(game.market_home_ml);
  const tEdge = model.estTot - (game.market_total || 8.5);

  if (aEdge >= ML_VALUE_EDGE)
    signals.push({ type: 'ML', side: 'away', label: 'Value', marketLine: game.market_away_ml, edge: aEdge });
  else if (aEdge >= ML_LEAN_EDGE)
    signals.push({ type: 'ML', side: 'away', label: 'Lean', marketLine: game.market_away_ml, edge: aEdge });

  if (hEdge >= ML_VALUE_EDGE)
    signals.push({ type: 'ML', side: 'home', label: 'Value', marketLine: game.market_home_ml, edge: hEdge });
  else if (hEdge >= ML_LEAN_EDGE)
    signals.push({ type: 'ML', side: 'home', label: 'Lean', marketLine: game.market_home_ml, edge: hEdge });

  if (tEdge >= TOT_VALUE_EDGE)
    signals.push({ type: 'Total', side: 'over', label: 'Value', marketLine: game.market_total, edge: tEdge });
  else if (tEdge >= TOT_LEAN_EDGE)
    signals.push({ type: 'Total', side: 'over', label: 'Lean', marketLine: game.market_total, edge: tEdge });

  if (tEdge <= -TOT_VALUE_EDGE)
    signals.push({ type: 'Total', side: 'under', label: 'Value', marketLine: game.market_total, edge: tEdge });
  else if (tEdge <= -TOT_LEAN_EDGE)
    signals.push({ type: 'Total', side: 'under', label: 'Lean', marketLine: game.market_total, edge: tEdge });

  return signals.map(s => ({
    ...s,
    category: catKey(s.type, s.side, s.label, s.marketLine),
  }));
}

// ── P&L CALCULATION ───────────────────────────────────────────────────────
function calcPnl(signal, awayScore, homeScore, marketTotal) {
  if (awayScore == null || homeScore == null) return { outcome: 'pending', pnl: 0 };
  const actualTotal = awayScore + homeScore;

  if (signal.type === 'ML') {
    if (awayScore === homeScore) return { outcome: 'push', pnl: 0 };
    const betTeamWon = signal.side === 'away'
      ? awayScore > homeScore
      : homeScore > awayScore;
    const ml = parseInt(signal.marketLine);
    const pnl = betTeamWon
      ? (ml > 0 ? ml : 100 / Math.abs(ml) * 100)
      : -100;
    return { outcome: betTeamWon ? 'win' : 'loss', pnl: parseFloat(pnl.toFixed(2)) };
  } else {
    const line = parseFloat(marketTotal);
    if (actualTotal === line) return { outcome: 'push', pnl: 0 };
    const hitOver = actualTotal > line;
    const betWon = signal.side === 'over' ? hitOver : !hitOver;
    return { outcome: betWon ? 'win' : 'loss', pnl: betWon ? 90.91 : -100 };
  }
}

module.exports = {
  normName, buildWobaIndex,
  getBatterWoba, getPitcherWoba,
  runModel, getSignals, calcPnl,
  impliedP,
};
