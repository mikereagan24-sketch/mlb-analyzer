# Two writers ping-ponging the signal price — open question (2026-08-25)

> **Filed, not started.**
>
> **Half of all market-price changes on a signal are undoing the previous
> change.** 5,493 `market_line` changes in July–August; **2,728 of them
> (49.7%) immediately reverse the change before them**, and ~2,000 of
> those are one writer undoing the other.
>
> The two writers are `processGameSignals` (7,075 `refresh`) and
> `refreshSignalBaselines` (1,845 `refresh_odds_tail`). They disagree by
> **1–3 American odds points on 83% of reversals** — roughly a cent of
> implied probability.
>
> **This is benign only while both values are current.** It is
> last-writer-wins between two near-identical numbers, so the moment one
> writer's source goes stale, the price on the row is decided by cron
> ordering rather than by which number is right — and nothing reports it.

## The measurement

```
audit action          source                        rows
refresh               process_game_signals_upsert   7075
refresh_odds_tail     refreshSignalBaselines        1845

market_line changes (Jul-Aug)          5493
  immediate reversals                  2728   (49.7%)
  of which CROSS-writer                ~1993

  month     changes   reversals   cross-writer
  2026-07      2835   1458 (51%)      1043
  2026-08      2658   1270 (48%)       950
```

Most common oscillating pairs, and the gap in American odds:

```
  -104 <-> -102   143     gap 1   860 reversals
   105 <->  106   111     gap 2   982
   100 <->  102    87     gap 3   421
  -108 <-> -106    83     gap 4    69
  -104 <-> -103    71     gap 5    23
```

**83% of reversals are a 1–3 point disagreement.** That is the size of a
rounding or fee-adjustment difference, not a market move.

## This was already diagnosed once, and the fix did not take

`services/jobs.js` carries a comment describing exactly this:

> *"a ping-pong bug where `refreshSignalBaselines` wrote tier-1 (from its
> own live fetch) and the next `processGameSignals` pass wrote tier-3 (no
> venue), flipping the row back and forth on each cron cycle"*

— followed by a lazy-fetch fallback added to fix it: try
`opts.venueRowsByGid`, then the `runComparisonCached` shared cache, then
the per-game `venue_comparison_snapshot`.

**The reversal rate is 51% in July and 48% in August.** Whatever that
fallback fixed, it did not fix this.

## The questions

**1. Which two sources, exactly?** The two *writers* are known. What is
not established is which *price source* each one ends up using on a
reversing pass — venue-aware (`price_venue` set) versus Kalshi-direct
fallback is the obvious hypothesis given the comment, but it has not been
checked against the audit rows. `bet_signals.price_venue` and
`venue_stale` are recorded per signal and should settle it.

**2. Why exactly a cent?** A 1–2 point American gap is what you get from
a fee adjustment, a half-cent rounding, or a bid-vs-ask read of the same
book. Distinguishing those matters: a rounding difference is cosmetic, a
bid/ask difference means one writer is systematically recording the wrong
side of the spread.

**3. Which should win?** Currently neither — it is whichever cron ran
last. The candidates are "the venue-aware one, always", "the most recently
fetched one", or "the one whose source is not stale". Note the third is
not currently expressible: there is no per-source freshness on the signal
row, only `venue_stale` as a boolean.

## Why it matters despite being small

Two near-identical values overwriting each other is harmless arithmetic.
The failure mode is **when one of them stops being current**:

- the model's edge is computed against whichever price landed last, so a
  stale source silently sets the edge on every pass it wins;
- `market_line` is the price the P&L grades against
  (`docs/one-click-bet-logging-design-2026-08-23.md`), so a stale winner
  moves realised ROI, not just the display;
- **nothing reports it.** The audit records both writes as legitimate
  refreshes. There is no signal that distinguishes "the market moved 2
  points" from "the other writer won this cycle".

That is the same shape as the framing table's frozen rows: a value that
looks plausible, is written by a real code path, and is wrong for a reason
no consumer can see.

## Scope note

**Not a corrupt-feed problem.** Both values are sane prices from real
sources. This is separate from the post-first-pitch pricing hole closed on
2026-08-25 — that one wrote genuinely wrong prices, this one writes two
almost-right ones in alternation.

It was found while tracing that hole, which is the only reason it is
recorded: the audit table holds **8,848 pricing writes for roughly 2,000
signals**, and that ratio is what made it visible.

## Not scheduled

No trigger, no owner. Filed because the diagnosis is cheap — the audit
detail already carries `from`/`to` per write, and `price_venue` /
`venue_stale` are on the signal row — and because the previous fix
attempt is documented in code as having worked when it did not.

## Related

- `services/jobs.js` — `processGameSignals`, the lazy-fetch fallback comment.
- `refreshSignalBaselines` — the other writer.
- `docs/corrupt-feed-and-post-start-recheck-2026-08-25.md` — where this surfaced.
