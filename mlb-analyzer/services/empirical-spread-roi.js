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

// CLV reason codes. Distinct values so an operator scanning the
// report can tell where each play's close came from (or why it's
// null) without reverse-engineering the joins.
//
// CLV close-price priority (set per fix/empirical-spread-clv-from-
// gametime-sibling — replaces the prior snapshot-equals-game-date
// scheme which missed every morning play because snapshots are day-
// ahead, not same-day):
//
//   1. GAMETIME SIBLING — for a morning play, the gametime-track row
//      for the SAME (game_date, game_id, spread_team, spread_line,
//      side). Latest generated_at if multiple batches. This row's
//      yes_ask_ml IS the close price for THIS side: gametime
//      captures fire as close as the odds-job pass before first
//      pitch, and the writer freezes both lay and take legs per
//      market (the 360 → 180 batch-dedup → pair-collapse funnel
//      proves both legs are present pre-collapse). clv_reason stays
//      null on this path — this is the canonical close.
//
//   2. DAY-AHEAD SNAPSHOT FALLBACK — only used when no gametime
//      sibling exists (e.g., a play that morning-triggered but the
//      empirical engine no longer found edge at gametime, so no
//      gametime row was written). Falls back to the latest
//      kalshi_spread_markets_snapshot row with snapshot_date <=
//      game_date. clv_reason = 'close_from_dayahead_snapshot' so the
//      stale source is visible — a same-evening snapshot of D-1's
//      capture can mark a morning play with clv ≈ 0 by
//      construction, so the flag matters.
//
//   3. NULL — neither source has a price. clv_reason carries the
//      specific failure.
//
// SIGN CONVENTION:
//   clv_pp = (close_implied - my_implied) * 100
//   Positive = beat the close (my purchase price had LOWER implied
//              prob than the close, i.e., the market moved toward
//              my position).
//   Negative = lost vs close (paid MORE implied than close — market
//              moved away from my position).
//   Worked example, ARI -1.5 lay 6/9: my +158 (38.76% implied),
//   close +198 (33.56% implied) → clv_pp = (33.56 - 38.76) = -5.20.
//   NEGATIVE because the lay-side bettor paid 38.76 cents of
//   implied prob on a market that closed at 33.56 — line widened
//   AGAINST the lay position.
const CLV_NO_CLOSE             = 'no_close_price_available';
const CLV_SNAPSHOT_PRICE_NULL  = 'dayahead_snapshot_present_but_side_price_null';
const CLV_FROM_DAYAHEAD_SNAP   = 'close_from_dayahead_snapshot';
// Kept exported for back-compat with the prior diagnostic field
// names — the new pipeline never sets these but consumers may.
const CLV_NO_CLOSING_SNAPSHOT  = 'no_kalshi_snapshot_for_game_date';
const CLV_SIDE_PRICE_NULL      = 'snapshot_row_present_but_side_price_null';

// ------------------------------------------------------------ SQL
// Pull all graded outcomes in the window, left-joined to game_log
// (home_team / away_team for the stale_park_factor flag) and to the
// LATEST pre-game-day kalshi_spread_markets_snapshot row as a
// fallback close source (the gametime-sibling close source is built
// in JS — see buildReadout below). pair_id IS NULL rows are excluded —
// those are pre-feat/empirical-spread-plus-run legacy rows whose pair
// grouping is unrecoverable (schema.js:1123-1125: backfilling pair_id
// was deemed not worth it because pair_id is only consumed by new
// code).
//
// Snapshot join: the writer (q.snapshotKalshiSpreads) clears
// snapshot_date before re-inserting, so each snapshot_date has at
// most one row per market. To pick the LATEST pre-game-day snapshot,
// the join needs ks.snapshot_date <= e.game_date AND no later
// snapshot exists. The NOT EXISTS subquery picks the maximum
// snapshot_date <= game_date per market — cheap because the snapshot
// table is indexed on snapshot_date and the per-market cardinality
// is small (a few snapshots per market at most before game day).
//
// Why <= rather than =: snapshots are written PT-daily; for a game
// on date D, the relevant odds-job passes happen at 8AM/11AM/3PM/5PM
// PT — but each PT day overwrites the prior. The most recent
// snapshot for a market on date D is typically the latest pass on
// D-1 evening (8PM/11PM cron) because by 8AM PT on D the odds-job
// hasn't fired yet; the morning-capture cron runs at 7:30AM. The
// equality predicate from the prior version missed every play
// because the snapshot_date for D's games was usually D-1, not D.
// The fallback is intentionally STALE for plays that lack a gametime
// sibling, and enrichPlay flags those with
// CLV_FROM_DAYAHEAD_SNAP — see the constant block above for the
// reason hierarchy.
//
// We intentionally do NOT dedup or collapse in SQL — those passes
// happen below in JS so each rule is independently verifiable.
function fetchGradedRows(db, fromDate, toDate) {
  return db.prepare(`
    SELECT
      e.game_date, e.game_id, e.spread_team, e.spread_line, e.side,
      e.capture_track, e.pair_id, e.yes_ask_ml, e.edge_pp,
      e.cell_sample_size, e.generated_at, e.actual_margin, e.outcome,
      e.pnl_per_100, e.graded_at,
      g.home_team, g.away_team,
      ks.yes_ask_ml   AS snap_yes_ask_ml,
      ks.no_ask_ml    AS snap_no_ask_ml,
      ks.snapshot_date AS snap_snapshot_date
    FROM empirical_spread_outcomes e
    LEFT JOIN game_log g
      ON g.game_date = e.game_date AND g.game_id = e.game_id
    LEFT JOIN kalshi_spread_markets_snapshot ks
      ON ks.game_date     = e.game_date
     AND ks.game_id       = e.game_id
     AND ks.spread_team   = e.spread_team
     AND ks.spread_line   = e.spread_line
     AND ks.snapshot_date <= e.game_date
     AND NOT EXISTS (
       SELECT 1 FROM kalshi_spread_markets_snapshot ks2
       WHERE ks2.game_date    = ks.game_date
         AND ks2.game_id      = ks.game_id
         AND ks2.spread_team  = ks.spread_team
         AND ks2.spread_line  = ks.spread_line
         AND ks2.snapshot_date <= e.game_date
         AND ks2.snapshot_date  > ks.snapshot_date
     )
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

  // ---- Gametime sibling map for CLV close-price lookup.
  // Built BEFORE pair-collapse from the deduped set so a morning
  // play can find its SAME-SIDE gametime row even when that row
  // would have been pair-collapsed away (e.g., gametime's signaled
  // side is the opposite leg). The empirical-spread writer emits
  // BOTH lay and take rows per market regardless of which has
  // positive edge — both legs carry their own frozen yes_ask_ml,
  // which IS the same-side close price for the morning row's CLV.
  // Key: (game_date, game_id, spread_team, spread_line, side).
  // capture_track is implicit (filtered to 'gametime' here).
  const gametimeSiblingByKey = new Map();
  for (const r of deduped) {
    if (r.capture_track !== 'gametime') continue;
    const k = [r.game_date, r.game_id, r.spread_team, r.spread_line, r.side].join('|');
    gametimeSiblingByKey.set(k, r);
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

  const enriched = plays.map((p) => enrichPlay(p, gametimeKeys, gametimeSiblingByKey));

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

  // Markets block (feat/morning-capture-ml-totals). Runs alongside
  // the spread aggregates above without touching them — spread
  // aggregates remain bit-identical pre/post this branch so an A/B
  // against a saved readout body confirms no regression. The new
  // section reports ML + totals from empirical_market_captures with
  // the same collapse semantics (batch-dedup per track per market;
  // no side-summing because each row already holds ONE play via
  // signaled_side; track-separation).
  try {
    out.markets = buildMarketsReadout(db, fromDate, toDate, includeDetail);
  } catch (e) {
    // Don't let a market-readout failure 500 the whole endpoint —
    // spread results are still useful. Surface the error in-band so
    // the operator sees it without grepping logs.
    out.markets = { error: e && e.message };
  }
  return out;
}

// ------------------------------------------------------------ per-play
//
// Close-price priority (see constant block at top of file for full
// rationale + sign convention):
//   1. Gametime sibling row's yes_ask_ml for the same side.
//      Canonical close. clv_reason null.
//   2. kalshi_spread_markets_snapshot row (latest snapshot_date <=
//      game_date) — side-appropriate column. Stale by construction
//      (typically D-1 evening for D's games). clv_reason =
//      CLV_FROM_DAYAHEAD_SNAP so operator can filter.
//   3. Neither — clv_reason carries the specific failure code.
//
// CLV is only computed for MORNING plays — gametime plays' "close"
// is their own price (nothing later to compare against).
function enrichPlay(p, gametimeKeys, gametimeSiblingByKey) {
  const myImpl = impliedP(p.yes_ask_ml);

  let close_price_ml  = null;
  let close_source    = null;
  let close_snap_date = null;
  let clv_pp     = null;
  let clv_reason = null;

  if (p.capture_track === 'morning') {
    const sibKey = [p.game_date, p.game_id, p.spread_team, p.spread_line, p.side].join('|');
    const sib = gametimeSiblingByKey ? gametimeSiblingByKey.get(sibKey) : null;
    if (sib && sib.yes_ask_ml != null) {
      close_price_ml = sib.yes_ask_ml;
      close_source   = 'gametime_sibling';
    } else {
      // Side-appropriate fallback from the day-ahead snapshot
      // joined in fetchGradedRows.
      const snapPrice = p.side === 'lay'  ? p.snap_yes_ask_ml
                      : p.side === 'take' ? p.snap_no_ask_ml
                      : null;
      if (snapPrice != null) {
        close_price_ml  = snapPrice;
        close_source    = 'dayahead_snapshot';
        close_snap_date = p.snap_snapshot_date || null;
        clv_reason      = CLV_FROM_DAYAHEAD_SNAP;
      } else if (p.snap_yes_ask_ml == null && p.snap_no_ask_ml == null) {
        clv_reason = CLV_NO_CLOSE;
      } else {
        clv_reason = CLV_SNAPSHOT_PRICE_NULL;
      }
    }
    if (close_price_ml != null && Number.isFinite(myImpl)) {
      const closeImpl = impliedP(close_price_ml);
      if (Number.isFinite(closeImpl)) {
        // SIGN CONVENTION: positive = beat the close (my implied
        // prob LOWER than close → market moved toward my position).
        clv_pp = round2((closeImpl - myImpl) * 100);
      }
    }
  }

  // close_implied_pct: derived from close_price_ml so the per-play
  // detail surfaces the close in the same %-implied form as
  // my_implied_pct, regardless of which branch (gametime sibling or
  // dayahead snapshot) set close_price_ml. Missing in the 17232dd
  // commit — return block referenced an undeclared identifier and
  // caused ReferenceError on first read.
  const close_implied_pct = close_price_ml != null
    ? round2(impliedP(close_price_ml) * 100)
    : null;

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
    close_price_ml,
    close_source,
    close_snap_date,
    close_implied_pct,
    my_implied_pct:          Number.isFinite(myImpl) ? round2(myImpl * 100) : null,
    clv_pp,
    clv_reason,
    still_a_play_at_close:   still,
    flags,
  };
}

// ------------------------------------------------------------ aggregates
// ------------------------------------------------------------ markets
// ML + totals readout. Built alongside the spread readout above —
// reads from empirical_market_captures (the new two-track table for
// markets without lay/take pairs). Same collapse rules apply except
// pair-collapse is a no-op here (one row per market_type, both
// sides' prices stored together, signaled_side identifies the play).
//
// CLV close source:
//   - Same gametime-sibling-first priority as spreads.
//   - For totals, additionally check market_line equality. If close
//     line != frozen line: clv_pp=null, clv_reason='line_moved',
//     line_delta (signed from bettor's side: positive = favorable
//     move, negative = unfavorable).
//   - No day-ahead snapshot fallback for ML/totals — there isn't a
//     kalshi snapshot equivalent for these market types (snapshots
//     are spread-only). clv_pp=null with reason 'no_gametime_sibling'
//     when no gametime row exists.
function buildMarketsReadout(db, fromDate, toDate, includeDetail) {
  const rows = fetchMarketRows(db, fromDate, toDate);

  // Batch-dedup per (game_date, game_id, market_type, capture_track).
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const k = [r.game_date, r.game_id, r.market_type, r.capture_track].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  // Gametime sibling map for CLV lookup. Key: (game_date, game_id,
  // market_type). Stores the LATEST gametime row per market.
  const gametimeSibling = new Map();
  for (const r of deduped) {
    if (r.capture_track !== 'gametime') continue;
    const k = [r.game_date, r.game_id, r.market_type].join('|');
    gametimeSibling.set(k, r);
  }

  const enriched = deduped.map((r) => enrichMarketPlay(r, gametimeSibling));

  // Top-level: by market_type (each contains morning + gametime + CLV).
  const out = { by_type: {} };
  for (const mt of ['ml', 'total']) {
    const morningPlays  = enriched.filter((p) => p.market_type === mt && p.capture_track === 'morning');
    const gametimePlays = enriched.filter((p) => p.market_type === mt && p.capture_track === 'gametime');
    const block = {
      morning:  aggregateTrack(morningPlays,  true),
      gametime: aggregateTrack(gametimePlays, false),
      clv_summary: summarizeMarketClv(morningPlays),
    };
    if (mt === 'total') {
      block.morning.line_moved_n = morningPlays.filter((p) => p.clv_reason === 'line_moved').length;
    }
    out.by_type[mt] = block;
  }
  if (includeDetail) {
    out.plays = enriched.map(formatMarketPlayForDetail);
  }
  return out;
}

function fetchMarketRows(db, fromDate, toDate) {
  // LEFT JOIN against kalshi_ml_markets_snapshot AND
  // kalshi_totals_markets_snapshot — same "latest snapshot_date <=
  // game_date" pattern the spreads readout uses (see fetchGradedRows
  // above). When the gametime sibling is absent for a morning row,
  // these snapshot prices act as the CLV close-price fallback.
  // Single-game PK on both snapshot tables means one row per
  // (game_date, game_id, snapshot_date) — the LEFT JOIN doesn't
  // multiply.
  return db.prepare(`
    SELECT
      e.game_date, e.game_id, e.market_type, e.capture_track,
      e.generated_at, e.market_line,
      e.away_price_ml, e.home_price_ml,
      e.over_price_ml, e.under_price_ml,
      e.signaled_side, e.signaled_edge_pp, e.signaled_price_ml,
      e.actual_total, e.away_score, e.home_score,
      e.outcome, e.pnl_per_100, e.graded_at,
      g.home_team, g.away_team,
      kms.away_ask_ml   AS snap_ml_away_ask_ml,
      kms.home_ask_ml   AS snap_ml_home_ask_ml,
      kms.snapshot_date AS snap_ml_snapshot_date,
      kts.market_line    AS snap_total_market_line,
      kts.over_price_ml  AS snap_total_over_price_ml,
      kts.under_price_ml AS snap_total_under_price_ml,
      kts.snapshot_date  AS snap_total_snapshot_date
    FROM empirical_market_captures e
    LEFT JOIN game_log g
      ON g.game_date = e.game_date AND g.game_id = e.game_id
    LEFT JOIN kalshi_ml_markets_snapshot kms
      ON  e.market_type    = 'ml'
      AND kms.game_date    = e.game_date
      AND kms.game_id      = e.game_id
      AND kms.snapshot_date <= e.game_date
      AND NOT EXISTS (
        SELECT 1 FROM kalshi_ml_markets_snapshot kms2
        WHERE kms2.game_date     = kms.game_date
          AND kms2.game_id       = kms.game_id
          AND kms2.snapshot_date <= e.game_date
          AND kms2.snapshot_date  > kms.snapshot_date
      )
    LEFT JOIN kalshi_totals_markets_snapshot kts
      ON  e.market_type    = 'total'
      AND kts.game_date    = e.game_date
      AND kts.game_id      = e.game_id
      AND kts.snapshot_date <= e.game_date
      AND NOT EXISTS (
        SELECT 1 FROM kalshi_totals_markets_snapshot kts2
        WHERE kts2.game_date     = kts.game_date
          AND kts2.game_id       = kts.game_id
          AND kts2.snapshot_date <= e.game_date
          AND kts2.snapshot_date  > kts.snapshot_date
      )
    WHERE e.outcome IS NOT NULL
      AND (? IS NULL OR e.game_date >= ?)
      AND (? IS NULL OR e.game_date <= ?)
    ORDER BY e.game_date, e.game_id, e.market_type, e.capture_track,
             e.generated_at DESC
  `).all(fromDate || null, fromDate || null, toDate || null, toDate || null);
}

function enrichMarketPlay(p, gametimeSibling) {
  let close_price_ml = null;
  let close_market_line = null;
  let close_source = null;
  let close_snap_date = null;
  let clv_pp = null;
  let clv_reason = null;
  let line_delta = null;

  if (p.capture_track === 'morning') {
    const sibKey = [p.game_date, p.game_id, p.market_type].join('|');
    const sib = gametimeSibling.get(sibKey);
    if (sib && sib.signaled_price_ml != null) {
      close_price_ml = sib.signaled_price_ml;
      close_market_line = sib.market_line;
      close_source = 'gametime_sibling';

      if (p.market_type === 'total'
          && p.market_line != null && sib.market_line != null
          && Number(p.market_line) !== Number(sib.market_line)) {
        // Line moved — price-vs-price comparison is not valid.
        // line_delta signed from bettor side: positive = favorable.
        // Over bettor: line UP is bad (need MORE runs), so favorable
        // move = line DOWN → bettor_delta = -(close - morning).
        // Under bettor: line UP is good → bettor_delta = (close - morning).
        const raw = Number(sib.market_line) - Number(p.market_line);
        if (p.signaled_side === 'over')  line_delta = round2(-raw);
        else if (p.signaled_side === 'under') line_delta = round2(raw);
        else line_delta = round2(raw);  // no signal: report raw delta unsigned-by-side
        clv_reason = 'line_moved';
        clv_pp = null;
      } else if (p.signaled_price_ml != null) {
        const myImpl    = impliedP(p.signaled_price_ml);
        const closeImpl = impliedP(close_price_ml);
        if (Number.isFinite(myImpl) && Number.isFinite(closeImpl)) {
          clv_pp = round2((closeImpl - myImpl) * 100);
        }
      } else {
        clv_reason = 'no_morning_signal';
      }
    } else {
      // No gametime sibling — try the day-ahead snapshot fallback.
      // Mirrors the spreads CLV second-prong at enrichPlay (above).
      // Snapshot rows are written from runOddsJob's Kalshi-direct
      // ML / totals override blocks (jobs.js), one row per game per
      // snapshot_date, with prices fee-adjusted on the same shift as
      // game_log — directly comparable to morning's frozen price.
      if (p.market_type === 'ml' && p.signaled_side != null) {
        const snapPrice = p.signaled_side === 'away' ? p.snap_ml_away_ask_ml
                        : p.signaled_side === 'home' ? p.snap_ml_home_ask_ml
                        : null;
        if (snapPrice != null) {
          close_price_ml  = snapPrice;
          close_source    = CLV_FROM_DAYAHEAD_SNAP;
          close_snap_date = p.snap_ml_snapshot_date || null;
        } else if (p.snap_ml_snapshot_date == null) {
          clv_reason = CLV_NO_CLOSING_SNAPSHOT;
        } else {
          clv_reason = CLV_SIDE_PRICE_NULL;
        }
      } else if (p.market_type === 'total' && p.signaled_side != null) {
        // Totals snapshot: must match morning's market_line. If the
        // snapshot's line differs, it's the same line-moved case as
        // the sibling branch — null CLV, line_moved reason.
        if (p.snap_total_market_line == null) {
          clv_reason = CLV_NO_CLOSING_SNAPSHOT;
        } else if (p.market_line != null
                && Number(p.market_line) !== Number(p.snap_total_market_line)) {
          const raw = Number(p.snap_total_market_line) - Number(p.market_line);
          if (p.signaled_side === 'over')  line_delta = round2(-raw);
          else if (p.signaled_side === 'under') line_delta = round2(raw);
          else line_delta = round2(raw);
          clv_reason = 'line_moved';
        } else {
          const snapPrice = p.signaled_side === 'over'  ? p.snap_total_over_price_ml
                          : p.signaled_side === 'under' ? p.snap_total_under_price_ml
                          : null;
          if (snapPrice != null) {
            close_price_ml    = snapPrice;
            close_market_line = p.snap_total_market_line;
            close_source      = CLV_FROM_DAYAHEAD_SNAP;
            close_snap_date   = p.snap_total_snapshot_date || null;
          } else {
            clv_reason = CLV_SIDE_PRICE_NULL;
          }
        }
      } else {
        // No signaled_side ⇒ no plays to compute CLV against. Same
        // as the no_morning_signal path above; surface a distinct
        // reason for visibility.
        clv_reason = 'no_morning_signal';
      }

      // If the snapshot path produced a close_price_ml, compute CLV
      // here (the sibling branch above did this inline; replicating
      // for the fallback so both prongs end at the same shape).
      if (close_price_ml != null && p.signaled_price_ml != null) {
        const myImpl    = impliedP(p.signaled_price_ml);
        const closeImpl = impliedP(close_price_ml);
        if (Number.isFinite(myImpl) && Number.isFinite(closeImpl)) {
          clv_pp = round2((closeImpl - myImpl) * 100);
        }
      } else if (clv_reason == null) {
        // No close from either prong, no other reason set.
        clv_reason = 'no_gametime_sibling';
      }
    }
  }

  return {
    market_type:     p.market_type,
    game_date:       p.game_date,
    game_id:         p.game_id,
    away_team:       p.away_team,
    home_team:       p.home_team,
    capture_track:   p.capture_track,
    generated_at:    p.generated_at,
    market_line:     p.market_line,
    away_price_ml:   p.away_price_ml,
    home_price_ml:   p.home_price_ml,
    over_price_ml:   p.over_price_ml,
    under_price_ml:  p.under_price_ml,
    signaled_side:   p.signaled_side,
    signaled_price_ml: p.signaled_price_ml,
    signaled_edge_pp: p.signaled_edge_pp == null ? null : round2(p.signaled_edge_pp * 100),
    outcome:         p.outcome,
    pnl_per_100:     p.pnl_per_100,
    actual_total:    p.actual_total,
    close_price_ml,
    close_market_line,
    close_source,
    close_snap_date,
    clv_pp,
    clv_reason,
    line_delta,
    flags: {
      stale_park_factor:
        p.home_team === 'ATH' && STALE_PF_DATES_FOR_ATH.has(p.game_date),
    },
  };
}

function summarizeMarketClv(morningPlays) {
  const withClv = [];
  let missing = 0;
  let lineMoved = 0;
  let nFromGametime = 0;
  let nFromSnapshot = 0;
  for (const p of morningPlays) {
    if (p.close_source === 'gametime_sibling')   nFromGametime++;
    if (p.close_source === CLV_FROM_DAYAHEAD_SNAP) nFromSnapshot++;
    if (p.clv_reason === 'line_moved') lineMoved++;
    if (p.clv_pp == null) { missing++; continue; }
    withClv.push(p.clv_pp);
  }
  if (!withClv.length) {
    return { avg_pp: null, median_pp: null, pct_positive: null,
             n_with_close: 0, n_missing_close: missing,
             n_line_moved: lineMoved,
             n_close_from_gametime_sibling: nFromGametime,
             n_close_from_dayahead_snapshot: nFromSnapshot };
  }
  const sorted = withClv.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const positive = withClv.filter((v) => v > 0).length;
  return {
    avg_pp:          round2(withClv.reduce((a, b) => a + b, 0) / withClv.length),
    median_pp:       round2(median),
    pct_positive:    round2((positive / withClv.length) * 100),
    n_with_close:    withClv.length,
    n_missing_close: missing,
    n_line_moved:    lineMoved,
    n_close_from_gametime_sibling:  nFromGametime,
    n_close_from_dayahead_snapshot: nFromSnapshot,
  };
}

function formatMarketPlayForDetail(p) {
  return {
    market_type:           p.market_type,
    date:                  p.game_date,
    game:                  p.away_team + '@' + p.home_team,
    track:                 p.capture_track,
    signaled_side:         p.signaled_side,
    signaled_price_ml:     p.signaled_price_ml,
    signaled_edge_pct:     p.signaled_edge_pp,
    market_line:           p.market_line,
    close_price_ml:        p.close_price_ml,
    close_market_line:     p.close_market_line,
    close_source:          p.close_source,
    close_snap_date:       p.close_snap_date,
    clv_pp:                p.clv_pp,
    clv_reason:            p.clv_reason,
    line_delta:            p.line_delta,
    outcome:               p.outcome,
    pnl_per_100:           p.pnl_per_100,
    actual_total:          p.actual_total,
    generated_at:          p.generated_at,
    flags:                 p.flags,
  };
}

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
  let nFromGametime = 0;
  let nFromSnapshot = 0;
  for (const p of morningPlays) {
    if (p.close_source === 'gametime_sibling') nFromGametime++;
    if (p.close_source === 'dayahead_snapshot') nFromSnapshot++;
    if (p.clv_pp == null) { missing++; continue; }
    withClv.push(p.clv_pp);
  }
  if (!withClv.length) {
    return {
      avg_pp: null, median_pp: null, pct_positive: null,
      n_with_close: 0, n_missing_close: missing,
      n_close_from_gametime_sibling: nFromGametime,
      n_close_from_dayahead_snapshot: nFromSnapshot,
    };
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
    n_close_from_gametime_sibling:  nFromGametime,
    n_close_from_dayahead_snapshot: nFromSnapshot,
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
    close_source:           p.close_source,           // 'gametime_sibling' | 'dayahead_snapshot' | null
    close_snap_date:        p.close_snap_date,        // populated only for 'dayahead_snapshot'
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

// ------------------------------------------------------------ debug funnel
// Diagnostic counter that runs each pipeline filter as its own COUNT
// and reports the survivor row counts stage by stage. The FIRST stage
// at which the count drops to zero pinpoints the bug. Triggered by
// ?debug=true on the route — no behavior change for production calls.
//
// Stage order mirrors buildReadout, so reading the debug output
// top-to-bottom corresponds to the same filters in the same order:
//   1. Total rows in empirical_spread_outcomes, grouped by capture_track.
//      Confirms the table is populated and shows both tracks' raw volume.
//   2. Rows with a graded outcome (outcome IS NOT NULL), by track. Plus
//      the DISTINCT outcome values present across the whole table, so
//      the aggregator's vocabulary check ('win'/'loss'/'push') can be
//      compared against reality.
//   2b. Layer the pair_id IS NOT NULL filter on top of 2. This isolates
//       the effect of the pair_id filter — legacy migration rows have
//       pair_id=NULL by design (schema.js:1156 explicitly sets NULL on
//       backfill), so a big drop between 2 and 2b means historical
//       rows are being filtered out by that clause.
//   3. After the date-window filter applies. Plus up to 3 sample
//      generated_at strings from each side of the 2026-06-08 cutover
//      so format/tz handling can be eyeballed.
//   4. After in-JS batch-dedup (latest generated_at per
//      game/market/side/track).
//   5. After in-JS pair-collapse (highest edge_pp per
//      game/pair_id/track).
function buildDebugFunnel(db, fromDate, toDate) {
  const out = { window: { from: fromDate || null, to: toDate || null } };

  // Stage 1: total rows by capture_track. Unfiltered.
  out.stage_1_total_by_track = db.prepare(
    "SELECT capture_track, COUNT(*) AS n "
    + "FROM empirical_spread_outcomes "
    + "GROUP BY capture_track"
  ).all();

  // Stage 2: graded by track + distinct outcome vocabulary.
  out.stage_2_graded_by_track = db.prepare(
    "SELECT capture_track, COUNT(*) AS n "
    + "FROM empirical_spread_outcomes "
    + "WHERE outcome IS NOT NULL "
    + "GROUP BY capture_track"
  ).all();
  out.stage_2_distinct_outcome_values = db.prepare(
    "SELECT DISTINCT outcome FROM empirical_spread_outcomes"
  ).all().map((r) => r.outcome);

  // Stage 2b: graded AND pair_id IS NOT NULL (current code's filter).
  // Compare against stage_2 to see if the pair_id clause is dropping
  // legacy migration rows (schema.js:1156: pair_id=NULL on backfill).
  out.stage_2b_graded_and_paired_by_track = db.prepare(
    "SELECT capture_track, COUNT(*) AS n "
    + "FROM empirical_spread_outcomes "
    + "WHERE outcome IS NOT NULL AND pair_id IS NOT NULL "
    + "GROUP BY capture_track"
  ).all();

  // Stage 3: date-window survivors. Mirrors the WHERE clauses in
  // fetchGradedRows so any window-related bug surfaces here.
  out.stage_3_after_window_by_track = db.prepare(
    "SELECT capture_track, COUNT(*) AS n "
    + "FROM empirical_spread_outcomes "
    + "WHERE outcome IS NOT NULL AND pair_id IS NOT NULL "
    + "  AND (? IS NULL OR game_date >= ?) "
    + "  AND (? IS NULL OR game_date <= ?) "
    + "GROUP BY capture_track"
  ).all(fromDate || null, fromDate || null, toDate || null, toDate || null);

  // Sample generated_at strings on each side of the tz cutover so the
  // operator can see whether pre-cutover strings look like UTC stamps
  // (likely "YYYY-MM-DDTHH:MM:SS.sssZ" or "YYYY-MM-DD HH:MM:SS") vs
  // post-cutover PT.
  out.stage_3_sample_generated_at_pre_cutover = db.prepare(
    "SELECT game_date, capture_track, generated_at "
    + "FROM empirical_spread_outcomes "
    + "WHERE game_date <= '2026-06-08' "
    + "ORDER BY game_date DESC, generated_at DESC "
    + "LIMIT 3"
  ).all();
  out.stage_3_sample_generated_at_post_cutover = db.prepare(
    "SELECT game_date, capture_track, generated_at "
    + "FROM empirical_spread_outcomes "
    + "WHERE game_date > '2026-06-08' "
    + "ORDER BY game_date ASC, generated_at ASC "
    + "LIMIT 3"
  ).all();

  // Stages 4-5: run the actual in-JS pipeline and count survivors.
  // Uses the same fetchGradedRows + dedup + pair-collapse code paths
  // as buildReadout so any divergence has to be in those passes.
  const rows = fetchGradedRows(db, fromDate, toDate);
  out.stage_3_after_fetch_total = rows.length;

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const k = [r.game_date, r.game_id, r.spread_team, r.spread_line,
               r.side, r.capture_track].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }
  out.stage_4_after_batch_dedup_by_track = countByTrack(deduped);

  const bestPerPair = new Map();
  for (const r of deduped) {
    const k = [r.game_date, r.game_id, r.pair_id, r.capture_track].join('|');
    const cur = bestPerPair.get(k);
    if (!cur
        || r.edge_pp > cur.edge_pp
        || (r.edge_pp === cur.edge_pp && r.side === 'lay' && cur.side !== 'lay')) {
      bestPerPair.set(k, r);
    }
  }
  const plays = Array.from(bestPerPair.values());
  out.stage_5_after_pair_collapse_by_track = countByTrack(plays);

  // ---- CLV-lookup diagnostic (bug investigation: every morning play
  // returns clv_reason 'no_kalshi_snapshot_for_game_date').
  // The readout LEFT JOINs kalshi_spread_markets_snapshot on
  //   ks.snapshot_date = e.game_date
  //   ks.game_date     = e.game_date
  //   ks.game_id       = e.game_id
  //   ks.spread_team   = e.spread_team
  //   ks.spread_line   = e.spread_line
  // and reports clv_reason on the null match. Surface enough data to
  // identify which dimension mismatches:
  //   (a) Total rows per snapshot_date — is the odds-job actually
  //       writing snapshots, and how recent are they?
  //   (b) Coverage by (snapshot_date, game_date) pair — same date,
  //       day-ahead, etc.
  //   (c) For one sample morning play, the lookup key construction
  //       side-by-side with the actual snapshot rows for that game_id
  //       on that game_date. Format mismatches (team case, line
  //       float, game_id shape) show up immediately.
  out.clv_diagnostic = buildClvLookupDiagnostic(db, plays);

  // ---- Cron-firing diagnostic (bug investigation: morning capture
  // cron never fires; all morning rows have the same manual-test
  // generated_at). Pull cron_log entries for the morning-capture job.
  // q.logCron is called at the end of runMorningCaptureJob (jobs.js
  // ~3150 success / ~3157 error), so a row exists iff the job ran.
  // No row since 2026-06-08 means the cron never invoked the job —
  // either the schedule didn't register, the process restarted with
  // a misconfigured startCronJobs, or something earlier in the chain
  // is throwing before logCron is reached. Also count cron_log
  // entries for OTHER jobs in the same window — if other crons fired
  // but morning-capture didn't, the issue is specific to this
  // schedule's registration or handler.
  out.cron_diagnostic = buildCronDiagnostic(db);

  return out;
}

// ------------------------------------------------------------ clv diag
function buildClvLookupDiagnostic(db, plays) {
  const diag = {};

  // (a) Snapshot row totals by snapshot_date — is the writer firing?
  diag.snapshot_rows_by_snapshot_date = db.prepare(
    "SELECT snapshot_date, COUNT(*) AS n "
    + "FROM kalshi_spread_markets_snapshot "
    + "GROUP BY snapshot_date "
    + "ORDER BY snapshot_date DESC "
    + "LIMIT 14"
  ).all();

  // (b) Coverage matrix: how often does snapshot_date = game_date?
  // The readout requires equality. If most rows have snapshot_date <
  // game_date (day-ahead captures), the equality predicate would
  // miss the relevant data.
  diag.snapshot_coverage_by_relationship = db.prepare(
    "SELECT CASE "
    + "    WHEN snapshot_date = game_date  THEN 'snap_date_equals_game_date' "
    + "    WHEN snapshot_date < game_date  THEN 'snap_date_before_game_date' "
    + "    WHEN snapshot_date > game_date  THEN 'snap_date_after_game_date' "
    + "  END AS relationship, "
    + "  COUNT(*) AS n "
    + "FROM kalshi_spread_markets_snapshot "
    + "GROUP BY relationship"
  ).all();

  // (c) Side-by-side: ONE sample morning play's lookup key + the
  // actual rows in the snapshot table for that play's game_id +
  // game_date (no team/line filter so we can see if the only
  // mismatch is line precision or team case). Pick the most recent
  // morning play so the user can cross-check against current Kalshi.
  const sample = plays.find((p) => p.capture_track === 'morning')
              || plays[0]
              || null;
  if (sample) {
    diag.sample_play_lookup_key = {
      from: 'empirical_spread_outcomes row',
      game_date:    sample.game_date,
      game_id:      sample.game_id,
      spread_team:  sample.spread_team,
      spread_line:  sample.spread_line,
      side:         sample.side,
      capture_track: sample.capture_track,
      generated_at: sample.generated_at,
    };
    diag.sample_play_join_predicates = [
      "ks.snapshot_date = '" + sample.game_date + "'",
      "ks.game_date     = '" + sample.game_date + "'",
      "ks.game_id       = '" + sample.game_id   + "'",
      "ks.spread_team   = '" + sample.spread_team + "'",
      "ks.spread_line   = "  + sample.spread_line,
    ];
    // Loose match: same game_id + game_date, ANY snapshot_date,
    // ANY team/line. Lets the user see what the snapshot table
    // actually has for this play's game and identify the mismatched
    // dimension by inspection.
    diag.sample_play_snapshot_rows_loose_match = db.prepare(
      "SELECT snapshot_date, game_date, game_id, spread_team, spread_line, "
      + "       yes_ask_ml, no_ask_ml "
      + "FROM kalshi_spread_markets_snapshot "
      + "WHERE game_id = ? AND game_date = ? "
      + "ORDER BY snapshot_date DESC, spread_team, spread_line "
      + "LIMIT 20"
    ).all(sample.game_id, sample.game_date);
    // Same as above but without game_date predicate — catches the
    // case where snapshot's game_date is formatted differently
    // (unlikely but cheap to surface).
    diag.sample_play_snapshot_rows_game_id_only = db.prepare(
      "SELECT snapshot_date, game_date, game_id, spread_team, spread_line "
      + "FROM kalshi_spread_markets_snapshot "
      + "WHERE game_id = ? "
      + "ORDER BY snapshot_date DESC "
      + "LIMIT 10"
    ).all(sample.game_id);
  } else {
    diag.sample_play_lookup_key = null;
    diag.note = 'no plays surfaced from pipeline — CLV diagnostic skipped';
  }

  return diag;
}

// ------------------------------------------------------------ cron diag
//
// NOTE on cron_log.ran_at: this column is UTC, NOT PT — it uses the
// schema-level DEFAULT (datetime('now')) at db/schema.js:221, which
// SQLite resolves to UTC. The rest of the codebase migrated to PT
// timestamps via nowPtIso() under fix/morning-capture-tz-anchor
// (services/jobs.js:47), but cron_log.ran_at was left UTC by
// pre-existing convention — not worth a schema migration because the
// column is observability-only (never read by user-facing aggregates,
// just shown in this diagnostic). When eyeballing these rows against
// Render log lines (which are also UTC), the timestamps align. When
// comparing against PT-anchored generated_at on
// empirical_spread_signals etc., add 7 hours mentally (PDT in June).
function buildCronDiagnostic(db) {
  const diag = {};
  diag.morning_capture_cron_log = db.prepare(
    "SELECT id, job_type, run_date, status, message, games_updated, ran_at "
    + "FROM cron_log "
    + "WHERE job_type = 'morning-capture' "
    + "ORDER BY ran_at DESC "
    + "LIMIT 14"
  ).all();
  diag.morning_capture_cron_log_count = db.prepare(
    "SELECT COUNT(*) AS n FROM cron_log WHERE job_type = 'morning-capture'"
  ).get().n;
  // Comparison baseline: did OTHER crons fire in the same window?
  // If yes, the process is alive, startCronJobs ran, but the
  // morning-capture schedule specifically has an issue.
  diag.other_crons_recent = db.prepare(
    "SELECT job_type, MAX(ran_at) AS last_ran, COUNT(*) AS total_rows "
    + "FROM cron_log "
    + "WHERE job_type != 'morning-capture' "
    + "GROUP BY job_type "
    + "ORDER BY last_ran DESC "
    + "LIMIT 10"
  ).all();
  diag.scheduled_pattern_in_code = {
    file:     'services/jobs.js',
    line:     '~2364',
    cron_expr: '30 7 * * *',
    tz:       'America/Los_Angeles',
    log_line_on_fire: '[cron] 7:30AM PT morning empirical-spread capture for <date>',
  };
  return diag;
}

function countByTrack(rows) {
  const map = new Map();
  for (const r of rows) {
    map.set(r.capture_track, (map.get(r.capture_track) || 0) + 1);
  }
  return Array.from(map, ([capture_track, n]) => ({ capture_track, n }));
}

module.exports = {
  buildReadout,
  buildDebugFunnel,
  // Exposed for tests / hand-verification scripts.
  fetchGradedRows,
  aggregateTrack,
  summarizeClv,
  toPtForLegacyUtc,
  STALE_PF_DATES_FOR_ATH,
  // CLV reason codes — new pipeline values first, legacy second.
  CLV_FROM_DAYAHEAD_SNAP,
  CLV_NO_CLOSE,
  CLV_SNAPSHOT_PRICE_NULL,
  CLV_NO_CLOSING_SNAPSHOT,
  CLV_SIDE_PRICE_NULL,
};
