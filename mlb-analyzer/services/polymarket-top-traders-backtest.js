'use strict';

// Polymarket top-traders backtest -- docs/polymarket-top-traders-prereg-2026-09-30.md,
// implemented. Every rule cites the section it implements; nothing here decides
// what that document leaves open (§9).
//
// DISPLAY ONLY and LOCAL ONLY. Nothing in runModel, getSignals, the bet path,
// server.js, routes, jobs or index.html reads this module or its output, and
// scripts/test-polymarket-top-traders-backtest.js asserts it. Both databases
// are opened READ-ONLY by the caller.
//
// OUTCOME-BLIND FIRST. buildOutcomeBlind() never selects markets.winner_idx or
// any score. The caller compares its counts with §10 (Gate 1) BEFORE
// attachOutcomes() reads a single resolution.
//
// The statistics are the trends test's own (services/trends-backtest.js
// _internals), reused, not copied: Wilson, the two-sided normal p, BH,
// summarize, and the bootstrap with this pre-registration's seed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { _internals: TR } = require('./trends-backtest');
const { noVig } = require('../utils/trends/scenarios');
const { ptToUtcMs } = require('../utils/post-start-pricing');

const PREREG_PATH = 'docs/polymarket-top-traders-prereg-2026-09-30.md';
const PREREG_COMMIT = 'f23d86f28bcf2b168e193cd04056e06a2dd8c801';   // PR #489
// sha256 of that commit's file content, CRLF normalised (same convention as
// the trends pin). A different document is a different pre-registration:
// the run refuses (header, §9).
const PREREG_SHA256 = '1d67059c01621b40a90eca4255026c68eb3474507c49677f2953bcd1b13b9edc';

const EXCLUDED_DATES = new Set(['2026-04-04', '2026-04-05']);   // §2 (#486)
const SEASON_TO = '2026-09-27';                                  // §2 regular season
const IN_SAMPLE_TO = '2026-08-31';                               // §7
const MIN_GAMES = 40, MAX_VOL_PER_PROFIT = 50, BOTH_MAX = 0.20;  // §3
const MIN_QUALIFIED = 25, TOP_N = 25;                            // §3
const TIE_DOLLARS = 0.005;                                       // §4.5
const BOOT_SEED = 20260930;                                      // §6
const Q_SIGNIFICANT = 0.10;                                      // §6

// ---------------------------------------------------------------- pin
function preregHash(root, relPath) {
  const txt = fs.readFileSync(path.join(root, relPath || PREREG_PATH), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(txt).digest('hex');
}
// Refuses to run against any other document.
function assertPrereg(root, opts) {
  const o = Object.assign({ path: PREREG_PATH, sha256: PREREG_SHA256 }, opts || {});
  const h = preregHash(root, o.path);
  if (h !== o.sha256) {
    throw new Error('pre-registration mismatch: ' + o.path + ' hashes to ' + h + ', pinned ' + o.sha256
      + ' -- a changed definition is a new pre-registration (§9); refusing to run');
  }
  return h;
}

// ---------------------------------------------------------------- helpers
const parseUtc = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z'));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const splitOf = (d) => (d <= IN_SAMPLE_TO ? 'in' : 'hold');                 // §7

// §5: the trends price rule. -> { skip } | { lock }
function priceStep(g) {
  if (!g || g.odds_locked_at == null) return { skip: 'no_odds_locked_at' };
  if (g.market_contamination_reason != null) return { skip: 'contaminated' };
  if (g.market_away_ml == null || g.market_home_ml == null) return { skip: 'moneyline_missing' };
  return { lock: parseUtc(g.odds_locked_at) };
}

// §5 "Locks stamped at or after first pitch": the confirmed set.
// lastCapture(g, beforeUtcSec) -> {a, h} | null  (last empirical_market_captures
// ML row whose generated_at, PT via utils/post-start-pricing, is before it)
function confirmedStatus(g, lock, lastCapture) {
  const fp = parseUtc(g.first_pitch_utc);
  if (fp == null) return 'outside_no_first_pitch';
  if (lock < fp) return 'confirmed_lock_before_first_pitch';
  const c = lastCapture(g, fp);
  if (!c) return 'outside_no_capture';
  if (Number(c.a) === Number(g.market_away_ml) && Number(c.h) === Number(g.market_home_ml)) return 'confirmed_equals_capture';
  return 'outside_differs';
}
const isConfirmed = (s) => s.startsWith('confirmed_');

// §4 steps 4-5 for one wallet set, from accumulated per-outcome net dollars.
// -> { skip } | { leanOutcome, negLean }
function leanFrom(acc) {
  if (!acc.any) return { skip: 'no_qualified_money' };
  if (Math.abs(acc.net[0] - acc.net[1]) < TIE_DOLLARS) return { skip: 'tie' };
  return { leanOutcome: acc.net[0] > acc.net[1] ? 0 : 1, negLean: acc.net[0] <= 0 && acc.net[1] <= 0 };
}

// §3: qualified wallets from the running per-wallet history.
function qualified(cum) {
  const q = [];
  for (const [w, s] of cum) {
    if (s.games >= MIN_GAMES && s.profit > 0 && s.volume / s.profit <= MAX_VOL_PER_PROFIT && s.both / s.games < BOTH_MAX) {
      q.push({ w, profit: s.profit });
    }
  }
  return q;
}
// §3 top 25: profit descending, ties by wallets.id ascending.
const topN = (q) => [...q].sort((a, b) => b.profit - a.profit || a.w - b.w).slice(0, TOP_N);

// ---------------------------------------------------------------- phase 1: outcome-blind
// pm, mlb: READ-ONLY better-sqlite3 handles. opts.onTick(): memory sampling hook.
function buildOutcomeBlind(pm, mlb, opts) {
  const o = Object.assign({ onTick: () => {} }, opts || {});
  // NO winner_idx here (outcome-blind until Gate 1 passes).
  const markets = pm.prepare(`SELECT id, game_date, game_id, cutoff_utc, outcome0_is_home FROM markets
    WHERE status = 'done' ORDER BY game_date, cutoff_utc, id`).all();
  const gl = new Map();
  for (const g of mlb.prepare(`SELECT game_date, game_id, odds_locked_at, market_away_ml, market_home_ml,
      market_contamination_reason, ml_source, first_pitch_utc FROM game_log WHERE COALESCE(is_removed, 0) = 0`).iterate()) {
    gl.set(g.game_date + '|' + g.game_id, g);
  }
  const capStmt = mlb.prepare(`SELECT away_price_ml a, home_price_ml h, generated_at ga FROM empirical_market_captures
    WHERE market_type = 'ml' AND game_date = ? AND game_id = ? AND away_price_ml IS NOT NULL ORDER BY generated_at`);
  const lastCapture = (g, before) => {
    let last = null;
    for (const c of capStmt.iterate(g.game_date, g.game_id)) {
      const t = ptToUtcMs(c.ga);
      if (t != null && t / 1000 < before) last = c;
    }
    return last;
  };

  // §3 history inputs: wallet_game rows per market, and the both-teams-bought set.
  const wgByMarket = new Map();
  for (const r of pm.prepare('SELECT market_id, wallet_id, profit, volume FROM wallet_game').iterate()) {
    let a = wgByMarket.get(r.market_id);
    if (!a) wgByMarket.set(r.market_id, (a = []));
    a.push([r.wallet_id, r.profit, r.volume]);
  }
  const boughtBoth = new Set();
  for (const r of pm.prepare(`SELECT market_id, wallet_id FROM fills WHERE side = 1
      GROUP BY market_id, wallet_id HAVING COUNT(DISTINCT outcome) = 2`).iterate()) {
    boughtBoth.add(r.market_id + '|' + r.wallet_id);
  }
  o.onTick();
  const fillsStmt = pm.prepare('SELECT wallet_id, outcome, side, price * size usd FROM fills WHERE market_id = ? AND ts < ?');

  const zero = () => ({ eligible: 0, price_skip: { no_odds_locked_at: 0, contaminated: 0, moneyline_missing: 0 },
    lean_skip: { no_qualified_money: 0, tie: 0 }, tested: 0, neg_lean: 0,
    confirmed: { confirmed_lock_before_first_pitch: 0, confirmed_equals_capture: 0,
      outside_no_capture: 0, outside_no_first_pitch: 0, outside_differs: 0 } });
  const counts = { primary: { in: zero(), hold: zero() }, secondary: { in: zero(), hold: zero() } };
  const notEligible = { in: 0, hold: 0 };
  const qualifiedByMonth = {};
  let firstEligible = null;
  const rows = [];                                   // tested rows, no outcome yet
  const lockVsCutoff = { inScope: 0, atOrAfter: 0, minutesAfter: [], moreThan60Before: 0 };
  const sourceMixPrimary = { in: {}, hold: {} };
  // §5 measurement table: tested primary games locked at or after first pitch
  const lockAfterFp = { total: 0, exact: 0, differ: 0, noCapture: 0, noCaptureBeforeCaptures: 0, noCaptureInside: 0,
    diffPp: [], byMonth: {} };
  const firstCaptureDate = (mlb.prepare("SELECT MIN(substr(generated_at,1,10)) d FROM empirical_market_captures WHERE market_type='ml' AND away_price_ml IS NOT NULL").get() || {}).d;

  const cum = new Map();
  let i = 0;
  while (i < markets.length) {
    const date = markets[i].game_date;
    const day = [];
    while (i < markets.length && markets[i].game_date === date) day.push(markets[i++]);
    const q = qualified(cum);                        // as of D: history strictly before D (§3)
    const mon = date.slice(0, 7);
    if (!qualifiedByMonth[mon]) qualifiedByMonth[mon] = { first_date: date, first_qualified: q.length };
    qualifiedByMonth[mon].last_date = date; qualifiedByMonth[mon].last_qualified = q.length;
    const inScope = !EXCLUDED_DATES.has(date) && date <= SEASON_TO;
    if (inScope) {
      // §10 lock-vs-cutoff statistics over every in-scope done game
      for (const m of day) {
        lockVsCutoff.inScope++;
        const g = gl.get(m.game_date + '|' + m.game_id);
        const lk = g ? parseUtc(g.odds_locked_at) : null;
        if (lk == null) continue;
        if (lk >= m.cutoff_utc) { lockVsCutoff.atOrAfter++; lockVsCutoff.minutesAfter.push((lk - m.cutoff_utc) / 60); }
        else if ((m.cutoff_utc - lk) / 60 > 60) lockVsCutoff.moreThan60Before++;
      }
      const split = splitOf(date);
      const qSet = new Set(q.map(x => x.w));
      const topSet = new Set(topN(q).map(x => x.w));
      for (const m of day) {
        if (q.length < MIN_QUALIFIED) { notEligible[split]++; continue; }          // §3 eligibility
        if (!firstEligible) firstEligible = { date, qualified: q.length };
        const g = gl.get(m.game_date + '|' + m.game_id);
        const ps = priceStep(g);                                                   // §5 (before the lean, §2 order)
        for (const v of ['primary', 'secondary']) counts[v][split].eligible++;
        if (ps.skip) { for (const v of ['primary', 'secondary']) counts[v][split].price_skip[ps.skip]++; continue; }
        // §4 lean: one streamed pass over this market's fills before min(L, cutoff)
        const cut = Math.min(ps.lock, m.cutoff_utc);
        const acc = { primary: { any: false, net: [0, 0] }, secondary: { any: false, net: [0, 0] } };
        for (const f of fillsStmt.iterate(m.id, cut)) {
          if (qSet.has(f.wallet_id)) { acc.primary.any = true; acc.primary.net[f.outcome] += f.side * f.usd; }
          if (topSet.has(f.wallet_id)) { acc.secondary.any = true; acc.secondary.net[f.outcome] += f.side * f.usd; }
        }
        const conf = confirmedStatus(g, ps.lock, lastCapture);
        for (const v of ['primary', 'secondary']) {
          const c = counts[v][split];
          const ln = leanFrom(acc[v]);
          if (ln.skip) { c.lean_skip[ln.skip]++; continue; }
          c.tested++;
          if (ln.negLean) c.neg_lean++;
          c.confirmed[conf]++;
          const leanIsHome = (ln.leanOutcome === 0) === (m.outcome0_is_home === 1);
          const mL = leanIsHome ? g.market_home_ml : g.market_away_ml;
          const mO = leanIsHome ? g.market_away_ml : g.market_home_ml;
          const source = g.ml_source || 'unrecorded';
          if (v === 'primary') sourceMixPrimary[split][source] = (sourceMixPrimary[split][source] || 0) + 1;
          rows.push({ variant: v, split, market_id: m.id, game_date: m.game_date, game_id: m.game_id,
            lean_outcome: ln.leanOutcome, lean_is_home: leanIsHome, price: mL, p: noVig(mL, mO), source,
            confirmed: isConfirmed(conf), confirmed_status: conf });
          // §5 measurement table (primary tested games locked at/after first pitch)
          const fp = parseUtc(g.first_pitch_utc);
          if (v === 'primary' && fp != null && ps.lock >= fp) {
            const bm = lockAfterFp.byMonth[mon] || (lockAfterFp.byMonth[mon] = { total: 0, exact: 0, differ: 0, no_capture: 0 });
            lockAfterFp.total++; bm.total++;
            if (conf === 'confirmed_equals_capture') { lockAfterFp.exact++; bm.exact++; }
            else if (conf === 'outside_differs') {
              lockAfterFp.differ++; bm.differ++;
              const c2 = lastCapture(g, fp);
              const nvHome = (a, h) => noVig(h, a);
              lockAfterFp.diffPp.push(100 * Math.abs(nvHome(g.market_away_ml, g.market_home_ml) - nvHome(Number(c2.a), Number(c2.h))));
            } else {
              lockAfterFp.noCapture++; bm.no_capture++;
              if (firstCaptureDate && date < firstCaptureDate) lockAfterFp.noCaptureBeforeCaptures++; else lockAfterFp.noCaptureInside++;
            }
          }
        }
      }
    }
    // history: D's games join AFTER D is evaluated (strictly-before rule, §3);
    // §2's excluded dates never join.
    if (!EXCLUDED_DATES.has(date)) {
      for (const m of day) {
        for (const [w, profit, volume] of (wgByMarket.get(m.id) || [])) {
          let s = cum.get(w);
          if (!s) cum.set(w, (s = { games: 0, profit: 0, volume: 0, both: 0 }));
          s.games++; s.profit += profit; s.volume += volume;
          if (boughtBoth.has(m.id + '|' + w)) s.both++;
        }
      }
    }
    o.onTick();
  }
  const sorted = [...lockVsCutoff.minutesAfter].sort((a, b) => a - b);
  const pick = (p) => (sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null);
  const dp = [...lockAfterFp.diffPp].sort((a, b) => a - b);
  const dpick = (p) => (dp.length ? dp[Math.floor(p * (dp.length - 1))] : null);
  return {
    rows,
    feasibility: {
      done_markets: markets.length,
      excluded_dates_markets: markets.filter(m => EXCLUDED_DATES.has(m.game_date)).length,
      first_eligible: firstEligible,
      not_eligible: notEligible,
      qualified_by_month: qualifiedByMonth,
      counts,
      lock_vs_cutoff: { in_scope_games: lockVsCutoff.inScope, at_or_after_cutoff: lockVsCutoff.atOrAfter,
        minutes_after_median: pick(0.5), minutes_after_p90: pick(0.9), minutes_after_max: sorted.length ? sorted[sorted.length - 1] : null,
        more_than_60_before: lockVsCutoff.moreThan60Before },
      source_mix_tested_primary: sourceMixPrimary,
      lock_at_or_after_first_pitch: { total: lockAfterFp.total, exact: lockAfterFp.exact, differ: lockAfterFp.differ,
        no_capture: lockAfterFp.noCapture, no_capture_before_first_capture_date: lockAfterFp.noCaptureBeforeCaptures,
        no_capture_inside_capture_window: lockAfterFp.noCaptureInside, first_capture_date: firstCaptureDate,
        diff_pp_median: dpick(0.5), diff_pp_p90: dpick(0.9), diff_pp_max: dp.length ? dp[dp.length - 1] : null,
        diff_pp_under_1: dp.filter(x => x < 1).length, by_month: lockAfterFp.byMonth },
    },
  };
}

// ---------------------------------------------------------------- phase 2: outcomes (after Gate 1)
// Polymarket's resolution (§2). Reads winner_idx ONLY for the tested markets.
function attachOutcomes(pm, rows) {
  const st = pm.prepare('SELECT winner_idx FROM markets WHERE id = ?');
  const cache = new Map();
  for (const r of rows) {
    let w = cache.get(r.market_id);
    if (w === undefined) { w = st.get(r.market_id).winner_idx; cache.set(r.market_id, w); }
    if (w !== 0 && w !== 1) throw new Error('tested market ' + r.market_id + ' has no resolution');
    r.result = w === r.lean_outcome ? 'W' : 'L';
  }
  return rows;
}

// ---------------------------------------------------------------- phase 3: statistics (§6, §7)
function stats(rows) {
  const st = TR.summarize(rows);                     // n, W-L, win% + Wilson, implied, edge, p, ROI, $ won, source mix
  const [roiLo, roiHi] = TR.bootRoi(st.prof, BOOT_SEED);
  delete st.prof;
  return Object.assign(st, { roiLo, roiHi });
}
function computeResults(rows) {
  const out = [];
  for (const set of ['main', 'confirmed']) {          // confirmed = §5/§6 sensitivity run
    for (const variant of ['primary', 'secondary']) {
      for (const split of ['in', 'hold']) {
        const base = rows.filter(r => r.variant === variant && r.split === split && (set === 'main' || r.confirmed));
        out.push(Object.assign({ set, variant, split, sourceFilter: 'all' }, stats(base)));
        out.push(Object.assign({ set, variant, split, sourceFilter: 'recorded_only' },
          stats(base.filter(r => r.source !== 'unrecorded'))));
      }
    }
  }
  const pick = (set, variant, split) => out.find(r => r.set === set && r.variant === variant && r.split === split && r.sourceFilter === 'all');
  // §6: BH across the 2 MAIN in-sample p-values; significant = q < 0.10.
  const mainIn = ['primary', 'secondary'].map(v => pick('main', v, 'in'));
  TR.bhQ(mainIn.map(r => r.pValue)).forEach((q, k) => { mainIn[k].qValue = q; mainIn[k].significant = q != null && q < Q_SIGNIFICANT; });
  // §6: the sensitivity q is computed the same way, for display only; it sets no significance.
  const sensIn = ['primary', 'secondary'].map(v => pick('confirmed', v, 'in'));
  TR.bhQ(sensIn.map(r => r.pValue)).forEach((q, k) => { sensIn[k].qValue = q; sensIn[k].significant = null;
    sensIn[k].clearsQ10ForDisplayOnly = q != null && q < Q_SIGNIFICANT; });
  // §7: holdout labels for MAIN tests significant in-sample only; they gate nothing.
  for (const r of mainIn) {
    if (!r.significant) { r.holdout = null; continue; }
    const h = pick('main', r.variant, 'hold');
    const keeps = (a, b) => a != null && b != null && Math.sign(a) === Math.sign(b) && Math.sign(a) !== 0;
    r.holdout = keeps(h.edge, r.edge) && keeps(h.roi, r.roi) ? 'HOLDS' : 'FAILS_HOLDOUT';
  }
  return out;
}

module.exports = {
  PREREG_PATH, PREREG_COMMIT, PREREG_SHA256, BOOT_SEED,
  preregHash, assertPrereg, buildOutcomeBlind, attachOutcomes, computeResults,
  _internals: { priceStep, confirmedStatus, leanFrom, qualified, topN, splitOf, parseUtc, stats },
};
