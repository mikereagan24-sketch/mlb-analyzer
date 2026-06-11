// Empirical-spread ROI + CLV readout.
//
// Backs GET /api/admin/empirical-spread/roi-readout. Computes per-track
// ROI (morning vs gametime) and per-morning-play CLV against the
// Kalshi closing snapshot. Deliberately implemented in JS rather than
// pure SQL — the three collapse rules (batch-dedup, pair-collapse,
// track-separation) are easier to verify and inspect when each is its
// own pass over an array than wrapped in nested window functions, and
// the data volume is tiny (≤ ~3000 rows per month of plays).
//
// THE THREE COLLAPSE RULES (mandatory, all established earlier; see
// services/empirical-spread-edge.js for the write side):
//
//   1. Batch-dedup. empirical_spread_outcomes' PK includes
//      generated_at, so multiple intraday job passes against the same
//      market write separate rows. For ROI we want ONE row per
//      (game_date, game_id, spread_team, spread_line, side,
//      capture_track) — the LATEST generated_at, since each refresh
//      uses the freshest cell distribution + price.
//
//   2. Pair-collapse. Each market emits BOTH a 'lay' and a 'take' row
//      (see persistEmpiricalSpreadSignals — both sides are written
//      regardless of which has positive edge_pp). They share a pair_id.
//      Pair-collapse picks the SIGNALED side = the one with the
//      highest edge_pp. Summing both legs as separate plays would
//      double-count and inflate volume — and worse, the 'opposite'
//      leg always has the inverse outcome of the signaled leg, so
//      summed P&L would cancel out toward zero.
//
//   3. Track-separation. 'morning' and 'gametime' are the SAME play
//      at two entry points (different frozen prices). They grade
//      independently against their own prices, so each has its own
//      ROI. CLV = the implied-prob delta between the two prices for
//      the SAME play (same pair_id + side). NEVER sum the two
//      tracks' P&L — the bettor only bought one.
//
// CLOSING PRICE — the asymmetry that motivates the readout:
//   For a MORNING play, the closing price proxy is the
//   kalshi_spread_markets_snapshot row at snapshot_date = game_date
//   (the daily snapshot of kalshi_spread_markets — the writer is
//   q.snapshotKalshiSpreads which clears the date and re-inserts on
//   each odds-job pass, so the row reflects the LAST odds-job pass
//   for that PT day, which is effectively the closing print since
//   Kalshi closes spread markets at first pitch).
//
//   Critically: a play that morning-triggered but no longer triggers
//   at gametime has NO 'gametime' empirical_spread_outcomes row, yet
//   it absolutely has a closing snapshot row. Those plays are the
//   highest-CLV plays (the market moved away from us). The readout
//   must keep them — sourcing the close from kalshi snapshot rather
//   than the gametime signal track is what makes that possible.
//   Missing them would survivorship-bias CLV toward zero.
//
//   If the snapshot row is missing entirely (rare — pre-snapshotting
//   games, or a snapshot-write failure), CLV is reported as null with
//   a reason — never silently dropped or zero'd.

'use strict';

const { impliedP } = require('./model');

// ATH home games on these dates were captured before the
// VENUE_OVERRIDES PF=1.31 (Las Vegas Ballpark) override deployed on
// 2026-06-09 (commits 76d8deb / dc0a6fe). Model totals on those
// games used the stale PF and fed slightly biased run-distribution
// expectations into the empirical-spread cell lookup. We don't drop
// these plays — we flag them so aggregates can be reported both with
// and without the stale set. Hardcoded list rather than an
// inferred-from-commits check because the deploy timing is what
// matters operationally, and this list is short enough to encode.
const STALE_PF_DATES_FOR_ATH = new Set(['2026-06-08', '2026-06-09']);

// CLV reason codes — set on plays whose closing price could not be
// resolved. Distinct values so an operator scanning the report can
// tell why an individual play has clv: null without reverse-
// engineering the joins.
const CLV_NO_CLOSING_SNAPSHOT = 'no_kalshi_snapshot_for_game_date';
const CLV_SIDE_PRICE_NULL     = 'snapshot_row_present_but_side_price_null';

// ------------------------------------------------------------ SQL
// Pull all graded outcomes in the window, left-joined to game_log
// (home_team / away_team for the stale_park_factor flag) and to the
// closing snapshot (yes_ask_ml + no_ask_ml at snapshot_date =
// game_date). pair_id IS NULL rows are excluded — those are
// pre-feat/empirical-spread-plus-run legacy rows whose pair grouping
// is unrecoverable (see schema.js:1123-1125: backfilling pair_id was
// deemed not worth it because pair_id is only consumed by new code).
//
// We intentionally do NOT dedup or collapse in SQL — those passes
// happen below in JS so each rule is independently verifiable. The
// window function alternatives nest awkwardly with the EXISTS check
// for still_a_play_at_close.
function fetchGradedRows(db, fromDate, toDate) {
  return db.prepare(`
    SELECT
      e.game_date, e.game_id, e.spread_team, e.spread_line, e.side,
      e.capture_track, e.pair_id, e.yes_ask_ml, e.edge_pp,
      e.cell_sample_size, e.generated_at, e.actual_margin, e.outcome,
      e.pnl_per_100, e.graded_at,
      g.home_team, g.away_team,
      ks.yes_ask_ml AS close_yes_ask_ml,
      ks.no_ask_ml  AS close_no_ask_ml
    FROM empirical_spread_outcomes e
    LEFT JOIN game_log g
      ON g.game_date = e.game_date AND g.game_id = e.game_id
    LEFT JOIN kalshi_spread_markets_snapshot ks
      ON ks.snapshot_date = e.game_date
     AND ks.game_date     = e.game_date
     AND ks.game_id       = e.game_id
     AND ks.spread_team   = e.spread_team
     AND ks.spread_line   = e.spread_line
    WHERE e.outcome IS NOT NULL
      AND e.pair_id IS NOT NULL
      AND (? IS NULL OR e.game_date >= ?)
      AND (? IS NULL OR e.game_date <= ?)
    ORDER BY e.game_date, e.game_id, e.pair_id, e.capture_track,
             e.side, e.generated_at DESC
  `).all(fromDate || null, fromDate || null, toDate || null, toDate || null);
}

// ------------------------------------------------------------ pipeline
function buildReadout(db, fromDate, toDate, includeDetail) {
  const rows = fetchGradedRows(db, fromDate, toDate);

  // ---- Rule 1: batch-dedup. Latest generated_at per
  // (game_date, game_id, spread_team, spread_line, side, capture_track).
  // Rows arrive ordered by generated_at DESC within that grouping, so
  // the first row per key is the latest.
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const k = [r.game_date, r.game_id, r.spread_team, r.spread_line,
               r.side, r.capture_track].join('');
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  // ---- Rule 2: pair-collapse. Per
  // (game_date, game_id, pair_id, capture_track), keep the SIGNALED
  // side = highest edge_pp. Ties broken by side='lay' first
  // (arbitrary but deterministic).
  const bestPerPair = new Map();
  for (const r of deduped) {
    const k = [r.game_date, r.game_id, r.pair_id, r.capture_track].join('');
    const cur = bestPerPair.get(k);
    if (!cur
        || r.edge_pp > cur.edge_pp
        || (r.edge_pp === cur.edge_pp && r.side === 'lay' && cur.side !== 'lay')) {
      bestPerPair.set(k, r);
    }
  }
  const plays = Array.from(bestPerPair.values());

  // ---- still_a_play_at_close: a MORNING play whose (game_date,
  // game_id, pair_id, side) has a corresponding GAMETIME play in the
  // collapsed set. Built as a set lookup after pair-collapse so a
  // morning play matches against the gametime SIGNALED side, not
  // against any-side gametime rows that may have been pair-collapsed
  // away. Then attach close prices + CLV.
  const gametimeKeys = new Set();
  for (const p of plays) {
    if (p.capture_track === 'gametime') {
      gametimeKeys.add([p.game_date, p.game_id, p.pair_id, p.side].join(''));
    }
  }

  const enriched = plays.map((p) => enrichPlay(p, gametimeKeys));

  // ---- Aggregation
  const morningPlays  = enriched.filter((p) => p.capture_track === 'morning');
  const gametimePlays = enriched.filter((p) => p.capture_track === 'gametime');

  const morningAgg  = aggregateTrack(morningPlays,  /*withClv=*/true);
  const gametimeAgg = aggregateTrack(gametimePlays, /*withClv=*/false);

  // Morning-only split by still_a_play_at_close: shows whether the
  // plays the market moved away from (no longer signaling at gametime)
  // are actually winning. The hypothesis the readout exists to test.
  morningAgg.by_still_a_play = {
    still_signaling:    aggregateTrack(morningPlays.filter((p) =>  p.still_a_play_at_close), false),
    no_longer_signaling: aggregateTrack(morningPlays.filter((p) => !p.still_a_play_at_close), false),
  };

  // By side (lay vs take) on each track — same axis the brief asks
  // for under "by market type". side is the closest analogue;
  // spread_line is its own dimension and folded into the per-play
  // detail when ?detail=true.
  morningAgg.by_side  = {
    lay:  aggregateTrack(morningPlays.filter((p)  => p.side === 'lay'),  false),
    take: aggregateTrack(morningPlays.filter((p)  => p.side === 'take'), false),
  };
  gametimeAgg.by_side = {
    lay:  aggregateTrack(gametimePlays.filter((p) => p.side === 'lay'),  false),
    take: aggregateTrack(gametimePlays.filter((p) => p.side === 'take'), false),
  };

  // Stale-PF accounting: morning ATH-home rows on 2026-06-08/09 used
  // the pre-override park factor. Report aggregates BOTH with and
  // without the flagged rows so the operator can compare.
  morningAgg.flagged_stale_n          = morningPlays.filter((p) => p.flags.stale_park_factor).length;
  morningAgg.excluding_stale          = aggregateTrack(morningPlays.filter((p) => !p.flags.stale_park_factor), true);

  // CLV summary across morning plays whose close price resolved.
  morningAgg.clv_summary = summarizeClv(morningPlays);

  const out = {
    window:   { from: fromDate || null, to: toDate || null },
    morning:  morningAgg,
    gametime: gametimeAgg,
  };
  if (includeDetail) {
    out.plays = enriched.map(formatPlayForDetail);
  }
  return out;
}

// ------------------------------------------------------------ per-play
function enrichPlay(p, gametimeKeys) {
  const closeImpl = closeImpliedFor(p);
  const myImpl    = impliedP(p.yes_ask_ml);
  let clv_pp = null;
  let clv_reason = null;
  if (closeImpl == null) {
    // Distinguish "no snapshot row at all" from "row exists but the
    // side-specific price column is null" — operator can act on one
    // (re-snapshot the date) but not the other (Kalshi never posted
    // that side's price).
    clv_reason = (p.close_yes_ask_ml == null && p.close_no_ask_ml == null)
      ? CLV_NO_CLOSING_SNAPSHOT
      : CLV_SIDE_PRICE_NULL;
  } else if (Number.isFinite(myImpl)) {
    clv_pp = round2((closeImpl - myImpl) * 100);
  }

  const still = p.capture_track === 'morning'
    ? gametimeKeys.has([p.game_date, p.game_id, p.pair_id, p.side].join(''))
    : null;

  const flags = {
    stale_park_factor:
      p.home_team === 'ATH' && STALE_PF_DATES_FOR_ATH.has(p.game_date),
  };

  return {
    game_date:               p.game_date,
    game_id:                 p.game_id,
    away_team:               p.away_team,
    home_team:               p.home_team,
    pair_id:                 p.pair_id,
    spread_team:             p.spread_team,
    spread_line:             p.spread_line,
    side:                    p.side,
    capture_track:           p.capture_track,
    yes_ask_ml:              p.yes_ask_ml,
    edge_pp:                 round2(p.edge_pp),
    cell_sample_size:        p.cell_sample_size,
    generated_at:            p.generated_at,
    generated_at_pt:         toPtForLegacyUtc(p.generated_at, p.game_date),
    graded_at:               p.graded_at,
    actual_margin:           p.actual_margin,
    outcome:                 p.outcome,
    pnl_per_100:             p.pnl_per_100,
    close_price_ml:          closePriceFor(p),
    close_implied_pct:       closeImpl == null ? null : round2(closeImpl * 100),
    my_implied_pct:          Number.isFinite(myImpl) ? round2(myImpl * 100) : null,
    clv_pp,
    clv_reason,
    still_a_play_at_close:   still,
    flags,
  };
}

// Side-aware closing price selection. The Kalshi snapshot row carries
// BOTH yes_ask_ml (the lay-side price) and no_ask_ml (the take-side
// price) for the same (game_id, spread_team, spread_line). Our 'lay'
// row's price was yes_ask; our 'take' row's price was no_ask. Pick
// matching side.
function closePriceFor(p) {
  if (p.side === 'lay')  return p.close_yes_ask_ml == null ? null : p.close_yes_ask_ml;
  if (p.side === 'take') return p.close_no_ask_ml  == null ? null : p.close_no_ask_ml;
  return null;
}
function closeImpliedFor(p) {
  const ml = closePriceFor(p);
  if (ml == null) return null;
  const ip = impliedP(ml);
  return Number.isFinite(ip) ? ip : null;
}

// ------------------------------------------------------------ aggregates
function aggregateTrack(plays, withClv) {
  let bets = 0, wins = 0, losses = 0, pushes = 0, pnl = 0, wagered = 0;
  let clvSum = 0, clvCount = 0;
  for (const p of plays) {
    bets++;
    if (p.outcome === 'win')   wins++;
    else if (p.outcome === 'loss')  losses++;
    else if (p.outcome === 'push')  pushes++;
    const u = Number(p.pnl_per_100) || 0;
    pnl += u;
    // Stake basis: $100/play (matches pnl_per_100's semantics) on
    // non-push outcomes. Pushes contribute zero P&L and zero stake.
    if (p.outcome !== 'push') wagered += 100;
    if (withClv && p.clv_pp != null) { clvSum += p.clv_pp; clvCount++; }
  }
  const roi_pct = wagered > 0 ? round2((pnl / wagered) * 100) : null;
  const out = {
    bets,
    record:   wins + '-' + losses + '-' + pushes,
    wins, losses, pushes,
    pnl_units: round2(pnl),       // dollars on $100/play basis
    wagered_units: wagered,
    roi_pct,
  };
  if (withClv) {
    out.avg_clv_pp = clvCount > 0 ? round2(clvSum / clvCount) : null;
    out.clv_sample = clvCount;
  }
  return out;
}

// Summary CLV stats across all morning plays — separate from the
// per-track aggregate so we can report median + positive% which
// aren't natural to compute in the streaming sum above.
function summarizeClv(morningPlays) {
  const withClv = [];
  let missing = 0;
  for (const p of morningPlays) {
    if (p.clv_pp == null) { missing++; continue; }
    withClv.push(p.clv_pp);
  }
  if (!withClv.length) {
    return { avg_pp: null, median_pp: null, pct_positive: null,
             n_with_close: 0, n_missing_close: missing };
  }
  const sorted = withClv.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const positive = withClv.filter((v) => v > 0).length;
  return {
    avg_pp:           round2(withClv.reduce((a, b) => a + b, 0) / withClv.length),
    median_pp:        round2(median),
    pct_positive:     round2((positive / withClv.length) * 100),
    n_with_close:     withClv.length,
    n_missing_close:  missing,
  };
}

// ------------------------------------------------------------ misc
function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// Pre-tz-cutover rows (commits before eed193a on 2026-06-08) wrote
// generated_at in UTC; post-fix rows write PT. We don't rewrite the
// stored value (it's a PK component for empirical_spread_signals).
// For DISPLAY in detail mode, surface a PT-anchored copy alongside.
// Rule: if game_date <= '2026-06-08', the stored string is UTC and we
// shift -7h to display PT (PDT in June). If game_date is later, the
// stored string is already PT — pass through. game_date is PT
// throughout the schema so window-filtering is unaffected.
function toPtForLegacyUtc(generatedAt, gameDate) {
  if (!generatedAt) return null;
  if (!gameDate || gameDate > '2026-06-08') return generatedAt;
  // generated_at format is "YYYY-MM-DD HH:MM:SS" — parse, shift -7h,
  // reformat. Use UTC parsing so the input is interpreted as the
  // wall-clock UTC it was stored as.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(generatedAt);
  if (!m) return generatedAt;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  d.setUTCHours(d.getUTCHours() - 7);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
       + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
       + ' PT';
}

function formatPlayForDetail(p) {
  return {
    date:                   p.game_date,
    game:                   p.away_team + '@' + p.home_team,
    pair_id:                p.pair_id,
    market:                 p.spread_team + ' ' + (p.side === 'lay'
                              ? '-' + Math.abs(p.spread_line)
                              : '+' + Math.abs(p.spread_line)),
    side:                   p.side,
    track:                  p.capture_track,
    morning_or_gametime_price_ml: p.yes_ask_ml,
    close_price_ml:         p.close_price_ml,
    my_implied_pct:         p.my_implied_pct,
    close_implied_pct:      p.close_implied_pct,
    clv_pp:                 p.clv_pp,
    clv_reason:             p.clv_reason,
    still_a_play_at_close:  p.still_a_play_at_close,
    outcome:                p.outcome,
    pnl_per_100:            p.pnl_per_100,
    actual_margin:          p.actual_margin,
    edge_pp:                p.edge_pp,
    cell_sample_size:       p.cell_sample_size,
    generated_at:           p.generated_at,
    generated_at_pt:        p.generated_at_pt,
    graded_at:              p.graded_at,
    flags:                  p.flags,
  };
}

module.exports = {
  buildReadout,
  // Exposed for tests / hand-verification scripts.
  fetchGradedRows,
  aggregateTrack,
  summarizeClv,
  toPtForLegacyUtc,
  STALE_PF_DATES_FOR_ATH,
  CLV_NO_CLOSING_SNAPSHOT,
  CLV_SIDE_PRICE_NULL,
};
