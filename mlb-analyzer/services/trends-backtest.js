'use strict';

// Trends backtest -- docs/trends-preregistration-2026-09-29.md, implemented.
//
// DISPLAY ONLY. Nothing here is read by runModel, getSignals or any bet path.
//
// Every rule below cites the pre-registration section it implements. Where
// the code had to make a choice the doc did not spell out, the choice is named
// in IMPLEMENTATION_NOTES and printed with every run, so a reader can see it
// was not a post-hoc adjustment (§9).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SCENARIOS, noVig, cents, profit } = require('../utils/trends/scenarios');
const { TEAM_TZ, DIVISION, leagueOf, isTeam, localParts } = require('../utils/trends/teams');

const PREREG_PATH = 'docs/trends-preregistration-2026-09-29.md';
const PREREG_COMMIT = '8865cba88d1201c1126f0453c83008f6da1036dc';   // PR #478
// sha256 of that commit's file content (CRLF normalised). A run whose doc no
// longer matches says so in its own output: a definition edited after the
// first run is a new pre-registration, not this one (§ header, §9).
const PREREG_SHA256 = '3dac9e1144994ba0dbfe3ad4c8bc6d6b1c9f7e836ad3dd9352e27f9c7b5693bd';
const WINDOW_FROM = '2026-04-09';
const WINDOW_TO = '2026-09-27';
const HOLDOUT_FROM = '2026-09-01';
const OPEN_FROM = '2026-06-11';          // §2: morning captures begin
const BOOT_N = 10000, BOOT_SEED = 20260929;

const IMPLEMENTATION_NOTES = [
  'All-Star Game (AL vs NL) dropped from the population and from history: it is not a team game.',
  'Previous game P is the nearest earlier game with a final score in the team\'s schedule, '
    + 'ordered by game_date, then first pitch (first_pitch_utc, else scheduled_start_utc), then game_id.',
  'A streak counts consecutive results backwards from P over scored, not-removed games.',
  'Win % and implied % are over decided rows; ROI and $ won divide by all rows (a push is $0).',
  'Totals implied % is the no-vig over/under split of the locked over_price / under_price.',
  'Bootstrap: one mulberry32 stream per (scenario, split, variant), each seeded 20260929.',
];

// ---------------------------------------------------------------- data
function loadGames(db) {
  return db.prepare(
    'SELECT game_date, game_id, away_team, home_team, away_score, home_score, '
    + 'market_away_ml, market_home_ml, ml_source, odds_locked_at, market_contamination_reason, '
    + 'market_total, over_price, under_price, total_source, '
    + 'first_pitch_utc, scheduled_start_utc, is_opener_game_away, is_opener_game_home '
    + 'FROM game_log WHERE COALESCE(is_removed, 0) = 0').all()
    .filter(g => isTeam(g.away_team) && isTeam(g.home_team));
}

function loadOpens(db) {
  const m = new Map();
  try {
    for (const r of db.prepare(
      "SELECT game_date, game_id, away_price_ml, home_price_ml, generated_at FROM empirical_market_captures "
      + "WHERE market_type = 'ml' AND capture_track = 'morning'").all()) {
      m.set(r.game_date + '|' + r.game_id, r);
    }
  } catch (e) { /* table absent -> no opens; S25/S26 simply have no rows */ }
  return m;
}

const scored = (g) => g.away_score != null && g.home_score != null;
const startUtc = (g) => g.first_pitch_utc || g.scheduled_start_utc || null;
const orderKey = (g) => g.game_date + '|' + (startUtc(g) || '') + '|' + g.game_id;
const key = (g) => g.game_date + '|' + g.game_id;

// §1
function inPopulation(g) {
  return scored(g) && g.odds_locked_at != null && g.market_contamination_reason == null
    && g.market_away_ml != null && g.market_home_ml != null
    && g.game_date >= WINDOW_FROM && g.game_date <= WINDOW_TO;
}

function prevDay(d) {
  const t = Date.parse(d + 'T12:00:00Z') - 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- rows
function buildRows(db) {
  const games = loadGames(db);
  const opens = loadOpens(db);
  const pop = new Set(games.filter(inPopulation).map(key));
  const local = new Map();                 // key -> local parts at the home ballpark
  for (const g of games) local.set(key(g), localParts(startUtc(g), TEAM_TZ[g.home_team]));

  // Per-team schedule (scored + scheduled) for series; per-team context per game.
  const byTeam = new Map();
  for (const g of games) for (const t of [g.away_team, g.home_team]) {
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(g);
  }
  const ctxByTeamGame = new Map();         // team|key -> { P, lossStreak, winStreak, seriesId, seriesFirst, seriesLast }
  for (const [t, list] of byTeam) {
    list.sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0));
    // §5 series: maximal run vs the same opponent at the same home ballpark.
    let sid = 0;
    const series = list.map((g, i) => {
      const opp = g.home_team === t ? g.away_team : g.home_team;
      const prev = list[i - 1];
      const same = prev && (prev.home_team === t ? prev.away_team : prev.home_team) === opp
        && prev.home_team === g.home_team;
      if (!same) sid++;
      return sid;
    });
    const hist = [];                         // scored games so far, in order
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      let P = null, lossStreak = 0, winStreak = 0;
      if (hist.length) {
        const h = hist[hist.length - 1];
        P = h;
        for (let j = hist.length - 1; j >= 0 && !hist[j].won; j--) lossStreak++;
        for (let j = hist.length - 1; j >= 0 && hist[j].won; j--) winStreak++;
      }
      ctxByTeamGame.set(t + '|' + key(g), {
        P, lossStreak, winStreak, seriesId: series[i],
        seriesFirst: i === 0 || series[i - 1] !== series[i],
        seriesLast: i === list.length - 1 || series[i + 1] !== series[i],
      });
      if (scored(g)) {
        const home = g.home_team === t;
        const rf = home ? g.home_score : g.away_score, ra = home ? g.away_score : g.home_score;
        const lp = local.get(key(g));
        const priced = pop.has(key(g));
        const nv = priced ? noVig(home ? g.market_home_ml : g.market_away_ml,
          home ? g.market_away_ml : g.market_home_ml) : null;
        hist.push({ won: rf > ra, margin: rf - ra, runsFor: rf, runsAgainst: ra, home, priced,
          fav: nv != null && nv > 0.5, dog: nv != null && nv < 0.5,
          opp: home ? g.away_team : g.home_team, seriesId: series[i],
          night: lp ? lp.hour >= 17 : null, localDate: lp ? lp.date : null,
          total: g.home_score + g.away_score });
      }
    }
  }

  const mlRows = [], totRows = [];
  const dayAfterNightFor = (g, P) => {
    const lp = local.get(key(g));
    if (!lp || !P || P.night == null || !P.localDate) return false;
    return lp.hour < 17 && P.night === true && P.localDate === prevDay(lp.date);
  };
  for (const g of games) {
    if (!pop.has(key(g))) continue;
    const split = g.game_date >= HOLDOUT_FROM ? 'out' : 'in';
    const open = opens.get(key(g));
    let dan = false, prev15 = false;
    for (const side of ['away', 'home']) {
      const T = side === 'home' ? g.home_team : g.away_team;
      const O = side === 'home' ? g.away_team : g.home_team;
      const x = ctxByTeamGame.get(T + '|' + key(g));
      const P = x.P ? Object.assign({}, x.P, { sameSeries: x.P.seriesId === x.seriesId }) : null;
      const mT = side === 'home' ? g.market_home_ml : g.market_away_ml;
      const mO = side === 'home' ? g.market_away_ml : g.market_home_ml;
      const nv = noVig(mT, mO);
      let moveCents = null;
      if (g.game_date >= OPEN_FROM && open) {
        const oT = side === 'home' ? open.home_price_ml : open.away_price_ml;
        if (oT != null) moveCents = cents(oT) - cents(mT);
      }
      const dAN = dayAfterNightFor(g, P);
      if (dAN) dan = true;
      if (P && P.total >= 15) prev15 = true;
      const c = {
        home: side === 'home', fav: nv > 0.5, dog: nv < 0.5, ml: mT, P,
        lossStreak: x.lossStreak, winStreak: x.winStreak,
        seriesFirst: x.seriesFirst, seriesLast: x.seriesLast,
        g2: /-g2$/.test(g.game_id),
        sameDivision: DIVISION[T] === DIVISION[O],
        interleague: leagueOf(T) !== leagueOf(O),
        ownOpener: (side === 'home' ? g.is_opener_game_home : g.is_opener_game_away) === 1,
        moveCents, dayAfterNight: dAN,
      };
      const rf = side === 'home' ? g.home_score : g.away_score;
      const ra = side === 'home' ? g.away_score : g.home_score;
      mlRows.push({ key: key(g), game_date: g.game_date, game_id: g.game_id, team: T, split, c,
        price: mT, p: nv, result: rf > ra ? 'W' : 'L',
        source: g.ml_source || 'unrecorded' });
    }
    if (g.market_total != null && g.over_price != null && g.under_price != null) {
      const tot = g.home_score + g.away_score;
      const x = { prevTotalGe15: prev15, dayAfterNight: dan };
      const pOver = noVig(g.over_price, g.under_price);
      for (const bet of ['over', 'under']) {
        const res = tot === g.market_total ? 'P'
          : ((bet === 'over') === (tot > g.market_total) ? 'W' : 'L');
        totRows.push({ key: key(g), game_date: g.game_date, game_id: g.game_id, split, bet, x,
          price: bet === 'over' ? g.over_price : g.under_price,
          p: bet === 'over' ? pOver : 1 - pOver, result: res,
          source: g.total_source || 'unrecorded' });
      }
    }
  }
  const noTime = games.filter(g => pop.has(key(g)) && !startUtc(g)).length;
  return { mlRows, totRows, populationGames: pop.size, gamesWithoutStartTime: noTime };
}

// ---------------------------------------------------------------- stats
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function wilson(w, n, z = 1.959964) {
  if (!n) return [null, null];
  const p = w / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [c - h, c + h];
}
function normTwoSided(z) {
  // Abramowitz-Stegun 7.1.26 on erfc; |error| < 1.5e-7, ample for a p-value.
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    * Math.exp(-x * x);
  return erfc;
}
function summarize(rows) {
  const n = rows.length;
  let W = 0, L = 0, Pu = 0, sp = 0, sv = 0, dollars = 0;
  const prof = new Float64Array(n);
  const mix = {};
  rows.forEach((r, i) => {
    mix[r.source] = (mix[r.source] || 0) + 1;
    if (r.result === 'P') { Pu++; prof[i] = 0; return; }
    sp += r.p; sv += r.p * (1 - r.p);
    if (r.result === 'W') { W++; prof[i] = profit(r.price); } else { L++; prof[i] = -100; }
    dollars += prof[i];
  });
  const dec = W + L;
  const winPct = dec ? W / dec : null;
  const implied = dec ? sp / dec : null;
  const z = sv > 0 ? (W - sp) / Math.sqrt(sv) : null;
  const [lo, hi] = wilson(W, dec);
  return { n, W, L, P: Pu, winPct, winLo: lo, winHi: hi, implied,
    edge: winPct != null ? winPct - implied : null,
    pValue: z != null ? normTwoSided(z) : null,
    roi: n ? dollars / (100 * n) : null, dollars, prof, mix };
}
// `seed` is optional and the trends runs never pass it, so they keep
// BOOT_SEED. It exists so another pre-registered test can reuse this
// bootstrap with its own registered seed instead of copying it (the
// Polymarket top-traders backtest: seed 20260930).
function bootRoi(prof, seed) {
  const n = prof.length;
  if (n < 2) return [null, null];
  const rnd = mulberry32(seed == null ? BOOT_SEED : seed);
  const out = new Float64Array(BOOT_N);
  for (let b = 0; b < BOOT_N; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += prof[(rnd() * n) | 0];
    out[b] = s / (100 * n);
  }
  out.sort();
  return [out[Math.floor(0.025 * BOOT_N)], out[Math.ceil(0.975 * BOOT_N) - 1]];
}
function bhQ(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(x => x[0] != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length, q = new Array(ps.length).fill(null);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const v = Math.min(prev, idx[k][0] * m / (k + 1));
    q[idx[k][1]] = v; prev = v;
  }
  return q;
}
function binomTailGe(k, n, p) {
  let s = 0, c = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = c * (n - i + 1) / i;
    if (i >= k) s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return s;
}

// ---------------------------------------------------------------- run
function preregHash(root) {
  const txt = fs.readFileSync(path.join(root, PREREG_PATH), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(txt).digest('hex');
}

function runTrendsBacktest(db, opts) {
  const root = (opts && opts.root) || path.join(__dirname, '..');
  const built = buildRows(db);
  const results = [];
  for (const s of SCENARIOS) {
    const rows = s.kind === 'ml'
      ? built.mlRows.filter(r => s.test(r.c))
      : built.totRows.filter(r => r.bet === s.bet && s.test(r.x));
    const variants = { primary: rows, recorded_source_only: rows.filter(r => r.source !== 'unrecorded') };
    if (s.id === 'S25' || s.id === 'S26') variants.kalshi_lock_only = rows.filter(r => r.source === 'kalshi');
    let both = 0;
    if (s.kind === 'ml') {
      const cnt = {};
      for (const r of rows) cnt[r.key] = (cnt[r.key] || 0) + 1;
      both = Object.values(cnt).filter(v => v > 1).length;
    }
    for (const [variant, vr] of Object.entries(variants)) {
      for (const split of ['in', 'out', 'all']) {
        const sr = split === 'all' ? vr : vr.filter(r => r.split === split);
        const st = summarize(sr);
        const [rLo, rHi] = bootRoi(st.prof);
        delete st.prof;
        results.push(Object.assign({ scenario: s.id, name: s.name, kind: s.kind, variant, split,
          roiLo: rLo, roiHi: rHi, bothTeamsGames: both, tooSmall: st.n < 30 }, st));
      }
    }
  }
  // §7 BH across the 31 in-sample primary p-values; §8 holdout flag.
  const inPrim = SCENARIOS.map(s => results.find(r => r.scenario === s.id && r.variant === 'primary' && r.split === 'in'));
  const q = bhQ(inPrim.map(r => r.pValue));
  inPrim.forEach((r, i) => { r.qValue = q[i]; });
  for (const r of inPrim) {
    const out = results.find(x => x.scenario === r.scenario && x.variant === 'primary' && x.split === 'out');
    let flag = null;
    if (r.pValue != null && r.pValue < 0.05) {
      if (!out || !out.n || out.edge == null) flag = 'NO_HOLDOUT_ROWS';
      else if (Math.sign(out.edge) !== Math.sign(r.edge) || out.roi <= 0) flag = 'FAILS_HOLDOUT';
      else flag = 'HOLDS';
    }
    r.holdout = flag;
  }
  const sig = inPrim.filter(r => r.pValue != null && r.pValue < 0.05).length;
  return {
    prereg: { path: PREREG_PATH, commit: PREREG_COMMIT, sha256: preregHash(root),
      matchesCommitted: preregHash(root) === PREREG_SHA256 },
    window: { from: WINDOW_FROM, to: WINDOW_TO, holdoutFrom: HOLDOUT_FROM },
    population: { games: built.populationGames, teamRows: built.mlRows.length,
      totalRows: built.totRows.length / 2, gamesWithoutStartTime: built.gamesWithoutStartTime },
    multipleComparisons: { tested: SCENARIOS.length, significantInSample: sig,
      expectedByChance: SCENARIOS.length * 0.05,
      pAtLeastThisManyByChance: binomTailGe(sig, SCENARIOS.length, 0.05),
      survivingBH10: inPrim.filter(r => r.qValue != null && r.qValue < 0.10).map(r => r.scenario) },
    notes: IMPLEMENTATION_NOTES,
    results,
  };
}

// Persist a run (trend_runs / trend_results). The caller passes a writable db.
function persistRun(db, run) {
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO trend_runs (created_at, prereg_path, prereg_commit, prereg_sha256, '
    + 'window_from, window_to, holdout_from, summary_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(now, run.prereg.path, run.prereg.commit, run.prereg.sha256, run.window.from, run.window.to,
      run.window.holdoutFrom, JSON.stringify({ population: run.population,
        multipleComparisons: run.multipleComparisons, notes: run.notes }));
  const ins = db.prepare('INSERT INTO trend_results (run_id, scenario_id, name, kind, variant, split, n, w, l, pushes, '
    + 'win_pct, win_lo, win_hi, implied_pct, edge, p_value, q_value, roi, roi_lo, roi_hi, dollars, '
    + 'both_teams_games, too_small, holdout, source_mix_json) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) ins.run(info.lastInsertRowid, r.scenario, r.name, r.kind, r.variant, r.split,
      r.n, r.W, r.L, r.P, r.winPct, r.winLo, r.winHi, r.implied, r.edge, r.pValue,
      r.qValue != null ? r.qValue : null, r.roi, r.roiLo, r.roiHi, r.dollars, r.bothTeamsGames,
      r.tooSmall ? 1 : 0, r.holdout || null, JSON.stringify(r.mix));
  });
  tx(run.results);
  return Number(info.lastInsertRowid);
}

module.exports = { runTrendsBacktest, persistRun, buildRows,
  _internals: { wilson, normTwoSided, bhQ, binomTailGe, summarize, bootRoi, mulberry32, inPopulation, prevDay } };
