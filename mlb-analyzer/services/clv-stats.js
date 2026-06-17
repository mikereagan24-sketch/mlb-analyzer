'use strict';

// CLV aggregation service. Reads graded picks from bet_signals (the
// canonical store: bet_line / closing_line / clv / outcome / bet_locked_at
// per row) and rolls up by market, timing, and date.
//
// CLV math comes from services/clv.js (single source of truth — same
// formula the per-row bet_signals.clv values were computed against).
// Noise band is 100/sqrt(n) per the trailing backtest convention,
// expressed in the same percentage-point units as the per-row clv.
//
// Kalshi-first source labeling: the bet_signals row doesn't carry a
// "where did closing_line come from" column. Per-pick source is
// inferred by looking up the same (game_date, game_id, market_type)
// in empirical_market_captures (capture_track='gametime') and
// kalshi_*_markets_snapshot — whichever matches the row's
// closing_line value first marks the source. Falls back to 'unknown'
// if no source matches (consensus / older grading).
//
// Read-only — no writes. No model or signal-generation changes here.

const { db, q } = require('../db/schema');
const { calcCLV } = require('./clv');

// ---------- helpers ----------

function noiseBandPp(n) {
  return n > 0 ? Number((100 / Math.sqrt(n)).toFixed(4)) : null;
}

function newAgg() {
  return { n_picks: 0, n_with_clv: 0, sumClv: 0, nPositive: 0,
           wins: 0, losses: 0, pushes: 0, pnl: 0 };
}
function pushPick(agg, row) {
  agg.n_picks++;
  if (row.clv != null) {
    agg.n_with_clv++;
    agg.sumClv += Number(row.clv);
    if (row.clv > 0) agg.nPositive++;
  }
  if (row.outcome === 'win')   agg.wins++;
  else if (row.outcome === 'loss') agg.losses++;
  else if (row.outcome === 'push') agg.pushes++;
  if (typeof row.pnl === 'number' && Number.isFinite(row.pnl)) agg.pnl += row.pnl;
}
function projectAgg(a) {
  return {
    n_picks:        a.n_picks,
    n_with_clv:     a.n_with_clv,
    avg_clv_pp:     a.n_with_clv > 0 ? Number((a.sumClv / a.n_with_clv).toFixed(4)) : null,
    pct_positive:   a.n_with_clv > 0 ? Number((100 * a.nPositive / a.n_with_clv).toFixed(2)) : null,
    noise_band_pp:  noiseBandPp(a.n_with_clv),
    wins:           a.wins,
    losses:         a.losses,
    pushes:         a.pushes,
    pnl:            Number(a.pnl.toFixed(2)),
  };
}

// Lock-timing bucket. day-before vs same-day from bet_locked_at vs
// game_date. ≥18 hours before game-day local midnight counts as
// day-before; anything later is same-day. Falls back to 'unknown' on
// missing lock-time.
function timingBucket(row) {
  if (!row.bet_locked_at || !row.game_date) return 'unknown';
  try {
    const locked = new Date(row.bet_locked_at);
    if (isNaN(locked.getTime())) return 'unknown';
    // game-day midnight in local time. Conservative: 18+ hours before
    // = day-before. Tighter than "calendar day prior" because
    // overnight (e.g. 2am same-day) is operationally morning-of-game.
    const gameDay = new Date(row.game_date + 'T12:00:00');
    const hoursBefore = (gameDay.getTime() - locked.getTime()) / 3600000;
    if (hoursBefore >= 18) return 'day_before';
    return 'same_day';
  } catch (e) { return 'unknown'; }
}

// Kalshi-first source detection. Per pick, look for a (game, market)
// match in empirical_market_captures gametime then kalshi_*_snapshot.
// Sourcing is best-effort: matches on closing_line value to be sure
// we're tagging the actual source not just an arbitrary close. Two
// passes per pick is fine at typical CLV-window pick counts (~100-500).
function detectClosingSource(row) {
  if (row.closing_line == null) return 'no_close';
  const mkt = (row.signal_type || '').toLowerCase();
  // Map signal_type → empirical_market_captures.market_type. Spreads
  // aren't in empirical_market_captures yet; skip Kalshi lookup for
  // them (will be 'unknown' fallback).
  const empMarketType = mkt === 'ml' ? 'ml' : (mkt === 'total' ? 'total' : null);
  if (empMarketType) {
    try {
      const gametime = db.prepare(
        "SELECT away_price_ml, home_price_ml, over_price_ml, under_price_ml "
        + "FROM empirical_market_captures "
        + "WHERE game_date=? AND game_id=? AND market_type=? AND capture_track='gametime' "
        + "ORDER BY generated_at DESC LIMIT 1"
      ).get(row.game_date, row.game_id, empMarketType);
      if (gametime) {
        const sidePrice = empMarketType === 'ml'
          ? (row.signal_side === 'home' ? gametime.home_price_ml : gametime.away_price_ml)
          : (row.signal_side === 'over' ? gametime.over_price_ml : gametime.under_price_ml);
        if (sidePrice != null && Number(sidePrice) === Number(row.closing_line)) {
          return 'kalshi_gametime';
        }
      }
    } catch (e) { /* fall through */ }
  }
  // ML kalshi snapshot fallback. Matches against away_ask_ml /
  // home_ask_ml at-or-before game_date.
  if (mkt === 'ml') {
    try {
      const snap = db.prepare(
        "SELECT away_ask_ml, home_ask_ml FROM kalshi_ml_markets_snapshot "
        + "WHERE game_date=? AND game_id=? AND snapshot_date <= ? "
        + "ORDER BY snapshot_date DESC LIMIT 1"
      ).get(row.game_date, row.game_id, row.game_date);
      if (snap) {
        const sidePrice = row.signal_side === 'home' ? snap.home_ask_ml : snap.away_ask_ml;
        if (sidePrice != null && Number(sidePrice) === Number(row.closing_line)) {
          return 'kalshi_snapshot';
        }
      }
    } catch (e) { /* fall through */ }
  }
  return 'unknown'; // consensus, manually filled, or older row
}

// ---------- main aggregation ----------

function loadRows(from, to) {
  if (!q.getSignalsByDateRange) return [];
  return q.getSignalsByDateRange.all(from, to) || [];
}

// Filter a row into the population that contributes to CLV stats:
// closing_line present (so CLV is defined) AND outcome graded (so
// PnL/wins/losses are meaningful).
function isGradedWithClose(r) {
  return r != null && r.closing_line != null && r.clv != null && r.outcome != null;
}

function buildClvStats(opts) {
  const from = opts.from;
  const to   = opts.to;
  const includeSourceDetection = opts.includeSourceDetection !== false;

  const rows = loadRows(from, to);
  const eligible = rows.filter(isGradedWithClose);

  // Headline aggregate
  const overall = newAgg();
  // By market_type
  const byMarket = { ml: newAgg(), total: newAgg(), spread: newAgg(), other: newAgg() };
  // By timing
  const byTiming = { day_before: newAgg(), same_day: newAgg(), unknown: newAgg() };
  // Source-detection counts (per-pick lookup is gated to avoid
  // hammering at large windows — capped at 1000 picks).
  const sourceCounts = { kalshi_gametime: 0, kalshi_snapshot: 0, unknown: 0, no_close: 0 };
  let sourceChecked = 0;

  for (const r of eligible) {
    pushPick(overall, r);
    const mkt = (r.signal_type || '').toLowerCase();
    if (byMarket[mkt]) pushPick(byMarket[mkt], r);
    else pushPick(byMarket.other, r);
    pushPick(byTiming[timingBucket(r)], r);
    if (includeSourceDetection && sourceChecked < 1000) {
      const src = detectClosingSource(r);
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      sourceChecked++;
    }
  }

  // Daily time series — sumClv / n per game_date, sorted ascending so
  // a UI chart can plot left-to-right. Surfaces both per-day CLV and
  // a running cumulative average for trend visibility.
  const byDate = new Map();
  for (const r of eligible) {
    let d = byDate.get(r.game_date);
    if (!d) { d = newAgg(); byDate.set(r.game_date, d); }
    pushPick(d, r);
  }
  const dates = Array.from(byDate.keys()).sort();
  let cumN = 0, cumSum = 0;
  const timeSeries = [];
  for (const d of dates) {
    const a = byDate.get(d);
    cumN += a.n_with_clv;
    cumSum += a.sumClv;
    timeSeries.push({
      date: d,
      n_picks: a.n_picks,
      n_with_clv: a.n_with_clv,
      avg_clv_pp: a.n_with_clv > 0 ? Number((a.sumClv / a.n_with_clv).toFixed(3)) : null,
      cumulative_avg_clv_pp: cumN > 0 ? Number((cumSum / cumN).toFixed(3)) : null,
      cumulative_n_with_clv: cumN,
    });
  }

  // Forward-honest BsR with/without — wired to call the existing
  // backtest harness in forward-honest mode. Right now the snapshot
  // table is fresh and may return effectively no data; we surface
  // that explicitly rather than show fake numbers.
  let bsrWithWithout = null;
  try {
    const { runBaserunningBacktest } = require('./baserunning-backtest');
    const bt = runBaserunningBacktest({
      fromDate: from, toDate: to,
      level: 'player', window: 'trailing', forwardHonest: true,
    });
    if (bt && bt.clv && bt.snapshot_coverage !== undefined) {
      bsrWithWithout = {
        without: bt.clv.without,
        with:    bt.clv.with,
        snapshot_coverage: bt.baserunning_coverage && bt.baserunning_coverage.snapshot_coverage,
        bet_set_diff:      bt.clv.bet_set_diff,
        status_note:       'Forward-honest snapshot mode. The snapshot clock starts at the first 6 AM PT capture after deploy; CLV typically needs 60-90 days to clear the noise band, given baserunning nudges only a few bets across the emit threshold per cycle.',
      };
    } else if (bt && bt.bias_warning && /snapshot/i.test(bt.bias_warning)) {
      bsrWithWithout = {
        empty: true,
        reason: bt.bias_warning,
        status_note: 'Forward-honest snapshot hook live but no data yet. Accumulating ~60-90 days.',
      };
    }
  } catch (e) {
    bsrWithWithout = { empty: true, reason: 'forward-honest hook failed: ' + e.message };
  }

  return {
    window: { from, to },
    description: 'CLV aggregation from bet_signals. CLV = (close_implied_prob − bet_implied_prob) × 100, in percentage points. Noise band = 100/sqrt(n_with_clv). Inside the band is not-yet-meaningful.',
    overall: projectAgg(overall),
    by_market: {
      ml:     projectAgg(byMarket.ml),
      total:  projectAgg(byMarket.total),
      spread: projectAgg(byMarket.spread),
      other:  projectAgg(byMarket.other),
    },
    by_timing: {
      day_before: projectAgg(byTiming.day_before),
      same_day:   projectAgg(byTiming.same_day),
      unknown:    projectAgg(byTiming.unknown),
      timing_basis: 'lock ≥18h before game_day noon = day_before; else same_day; missing bet_locked_at = unknown',
    },
    time_series: timeSeries,
    closing_line_source: includeSourceDetection ? {
      detected_picks: sourceChecked,
      counts: sourceCounts,
      precedence: 'Kalshi-first: empirical_market_captures (gametime) → kalshi_ml_markets_snapshot → unknown (consensus / older grading / spread market). Spread picks fall to unknown until empirical_market_captures gains a spread track.',
    } : null,
    bsr_with_without: bsrWithWithout,
    interpretation: 'Headline avg_clv_pp inside its noise_band_pp = not-yet-meaningful sample. Day-before timing is the live positive signal per the prior handoff (CLV up, ROI still negative). Use cumulative_avg_clv_pp in the time series to watch for turns.',
  };
}

module.exports = { buildClvStats, calcCLV, timingBucket, detectClosingSource };
