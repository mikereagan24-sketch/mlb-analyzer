# Poly totals write — queued follow-up

Owner: Mike, priority: low. Filed 2026-07-22 as an explicit follow-up
from PR `fix/complete-demote-seed-oddsraw-from-schedule`.

## Gap

After the demote-completion PR, Poly writes to `game_log.market_*_ml`
(ML) but NOT to `game_log.market_total` / `over_price` / `under_price`.
For any game where Kalshi has no totals coverage but Poly does, totals
stay NULL — same as pre-fix. This is a **pre-existing gap** (not a
regression from that PR) but it's the last known hole in the demote's
"Kalshi/Poly are the sole betting-path sources" invariant on the
Totals side.

Low priority because:

1. Kalshi typically covers totals across the slate reliably.
2. Downstream model already handles NULL market_total by suppressing
   the Totals signal (documented at jobs.js:3437-3443). No corrupt
   output — just a missing signal on a small number of games.
3. Recent Totals audit paused broader Totals work anyway.

The gap becomes visible in `/health` when `missing[]` contains a game
whose `ml_source` is populated but `total_source` is null — an ML-only
row where Poly could have filled totals but didn't.

## Design decisions to make before writing this

Two open questions blocking implementation. Neither has an obvious
right answer without a small design conversation.

### D1. Which strike do we pick from Poly's totals_ladder?

`getPolymarketMlbLines` returns `totals_ladder` per event — an array
of every strike Poly has a market on, with `over_token`, `under_token`,
`over_price_str`, `under_price_str`, and `market_liquidity_clob`.

Kalshi-direct totals picks the rung matching `o.unabated_total` (the
reference-only line the Unabated demote moved into unabated_*), falling
back to `k.line` (Kalshi's auto-picked rung — closest over_ask to
$0.50). Options for Poly:

- **Anchor to Kalshi's rung when Kalshi has any coverage.** Best when
  they agree on a line. Doesn't help our target case (Kalshi missing).
- **Anchor to `unabated_total` when present.** Same shape as
  Kalshi-direct's line matching, keeps sources consistent when Unabated
  did return a total. Frequently the case even when Kalshi doesn't
  cover.
- **Poly's own median-liquidity rung when neither reference is
  available.** No obvious anchor. Would need a "which strike do traders
  actually use" heuristic — highest `market_liquidity_clob` is defensible
  but may not be the mid-line. Alternative: pick the rung whose
  `over_price_str` is closest to 0.50 (matches Kalshi's own auto-pick
  behavior).

Suggested resolution: **cascade** — Kalshi rung → Unabated total →
highest-liquidity Poly rung. Log the anchor tier so we can grep for
"Poly-only totals: fallback to liquidity anchor" and audit whether that
tier's picks are reasonable.

### D2. Fee adjustment for Poly totals

Poly ML uses `polyTakerFeeRate(topAskPrice)` and stores the resulting
American as fee-adjusted (symmetric with Kalshi). For totals, each side
has its own top-of-book raw price, so fee adjustment is per-side —
straightforward, but note:

- Kalshi totals fee-adjusts via `feeAdjustAmericanFromC(over_ask)` /
  `feeAdjustAmericanFromC(under_ask)` at line 4018-4030 of jobs.js.
- Poly totals should mirror that shape via a new helper
  `polyFeeAdjustAmericanFromC` using `polyTakerFeeRate` in place of
  `kalshiTakerFeeRate`.

No open question here — just a symmetric write. D1 is the actual
design lift.

## Implementation sketch

Post-Poly-direct ML block, add:

```js
// Poly-direct TOTALS override. Same guardrails as ML: locked skipped,
// no-schedule skipped, Kalshi wins when both cover.
for (const p of polyRows) {
  const o = oddsById.get(p.game_id);
  if (!o) continue;                              // phantom
  if (existing && existing.odds_locked_at) continue;  // locked
  if (o.market_total != null) continue;          // Kalshi/Unabated already wrote
  if (!Array.isArray(p.totals_ladder) || p.totals_ladder.length === 0) continue;

  // D1: anchor selection cascade.
  let anchorTier;
  let picked = null;
  if (o.unabated_total != null) {
    picked = p.totals_ladder.find(r => Math.abs(r.strike - o.unabated_total) < 0.001);
    if (picked) anchorTier = 'unabated_exact';
    if (!picked) {
      // Nearest within 0.5.
      let best = null, bestDist = Infinity;
      for (const r of p.totals_ladder) {
        const d = Math.abs(r.strike - o.unabated_total);
        if (d < bestDist) { best = r; bestDist = d; }
      }
      if (best && bestDist <= 0.5) { picked = best; anchorTier = 'unabated_nearest'; }
    }
  }
  if (!picked) {
    // Fallback: highest-liquidity rung.
    let best = null, bestLiq = -1;
    for (const r of p.totals_ladder) {
      const liq = r.market_liquidity_clob != null ? r.market_liquidity_clob : 0;
      if (liq > bestLiq) { best = r; bestLiq = liq; }
    }
    picked = best;
    anchorTier = 'poly_liquidity_fallback';
  }
  if (!picked) continue;

  // D2: fee-adjust per side.
  const overAskC  = parseFloat(picked.over_price_str);
  const underAskC = parseFloat(picked.under_price_str);
  const overMl  = polyFeeAdjustAmericanFromC(overAskC);
  const underMl = polyFeeAdjustAmericanFromC(underAskC);
  if (overMl == null || underMl == null) continue;

  o.market_total  = picked.strike;
  o.over_price    = overMl;
  o.under_price   = underMl;
  o.total_source  = 'polymarket';
  totalsWrote++;
  console.log('[odds] Poly-direct totals: ' + p.game_id
    + ' anchor=' + anchorTier + ' strike=' + picked.strike
    + ' over/under=' + overMl + '/' + underMl);
}
```

Plus a new local helper `polyFeeAdjustAmericanFromC` mirroring
`feeAdjustAmericanFromC` — one-for-one with `polyTakerFeeRate`
substituted for `kalshiTakerFeeRate`.

## Test additions

Extend `tmp/verify-demote-completion.js` (or a new
`tmp/verify-poly-totals-write.js`):

- Poly totals write block writes `market_total` / `over_price` /
  `under_price` / `total_source='polymarket'` when Kalshi didn't cover.
- Anchor-tier cascade — assert the log line's anchor label for each of
  the three tiers on synthetic ladders.
- Fee adjustment produces integers in the expected range.

## Post-deploy verification

- `/health` should show `total_source` populated on any game where
  both `ml_source` is populated AND totals coverage exists on either
  Kalshi or Poly.
- `[odds] Poly-direct totals` log lines on the first slate where
  Kalshi has an ML-only game with Poly totals coverage.
