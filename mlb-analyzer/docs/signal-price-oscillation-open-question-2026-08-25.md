# Two writers ping-ponging the signal price — open question (2026-08-25)
> ---
> **UPDATED SAME DAY — QUESTION 2 IS ANSWERED, AND IT IS THE BID/ASK CASE.**
>
> The gap is **not** rounding. It is **directional and systematic**, and it
> reaches every price these writers touch — not only the ones that
> oscillate.
>
> ```
> writer               n      mean d(implied)   moved price DOWN (better)
> refresh            3648        +0.1769pp       1163  (31.9%)
> refresh_odds_tail  1845        -0.4430pp       1695  (91.9%)
>
> head-to-head on the same signal, implied(odds_tail) - implied(upsert):
>   n=1993   mean -0.4503pp   odds_tail cheaper on 1942 (97.4%)
>   sign-split z vs 50/50: -42.39
> ```
>
> **The two writers push in opposite directions with 97.4% consistency.**
> That is a spread side, not a rounding difference. Reprioritised
> accordingly: the cent gap is the symptom, the side is the problem.
> ---

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

---

# Question 2, answered: it is the spread side (2026-08-25, later)

## The test

Rounding and fee-adjustment are **symmetric** — they should push a price
up as often as down. A writer reading the wrong side of the spread is
**signed** — it pushes the same way every time. So: over every
`market_line` change, what is the mean change in implied probability, and
what fraction move the price down?

```
writer               n       mean d(implied)   median        moved DOWN (better)
refresh            3648         +0.1769pp      +0.2763pp     1163  (31.9%)
refresh_odds_tail  1845         -0.4430pp      -0.3814pp     1695  (91.9%)
```

A symmetric role sits near `0.0000pp` with a ~50% split. **Neither does.**
They push in **opposite** directions, consistently.

Head-to-head, restricted to the same signal in an immediate reversal so
the two prices describe the same market at the same moment:

```
implied(odds_tail) - implied(upsert)
  n = 1993
  mean   -0.4503pp      median  -0.3814pp
  odds_tail cheaper : 1942  (97.4%)
  odds_tail dearer  :   50  ( 2.5%)
  sign-split z vs 50/50: -42.39
```

**97.4% one-way.** That is not a rounding artifact at any sample size.

## Why this is bigger than the oscillation

The reversal count (2,728) was the visible part. The bias is on **all
5,493 changes**, so roughly **2,765 biased writes never oscillate at all**
and are invisible to any reversal-based analysis — including the analysis
that opened this ticket.

Whichever writer is on the wrong side is applying that offset to every
price it touches, and `market_line` is:

- the denominator of `edge_pct`, so the edge on those signals is
  systematically shifted;
- the price P&L grades against
  (`docs/one-click-bet-logging-design-2026-08-23.md`), so it moves
  realised ROI and not just the display.

A ~0.45pp offset is small against a 6–8pp emit band. It is **not** small
against the differences this project has been trying to measure all
month: the lineup-projection effect was 0.130 runs, catcher framing 0.048.
An 0.45pp systematic price offset is the same order as the things being
gated on.

## What is still open

**Which one is wrong.** The measurement establishes that they differ
systematically and by how much. It does not say which side is correct —
that needs the source definitions, not the audit trail:

- if `refreshSignalBaselines` reads a venue **bid** while
  `processGameSignals` reads the **ask**, the ask is the price actually
  available and the tail writer is optimistic by ~0.45pp;
- if one applies the Kalshi fee adjustment and the other does not, the
  fee-adjusted one is right and the gap is a missing transform;
- `price_venue` and `venue_stale` are on the signal row and should
  identify which source each pass landed on.

**The 2.5% that go the other way** are worth a look too — 50 of 1,993.
Either a second mechanism, or the sign of a genuine market move large
enough to overwhelm the offset.

## The fix must ship with a measurement, not a comment

`services/jobs.js` already asserts this was fixed by a lazy-fetch
fallback. The reversal rate is **51% in July and 48% in August**. That is
the third comment found in this repo claiming a resolution the data
contradicts (`fetchCatcherFraming`'s "the floor already governs",
`PARK_FACTORS`' "straight FanGraphs R factor").

So: `scripts/measure-price-oscillation.js`, run before and after, output
pasted into the PR.

**Success criterion — both, and the second matters more:**

1. reversal rate materially down from 49.7%;
2. **both writers near `0.0000pp` with a ~50% down-split.**

(2) is the one that catches the real defect. A fix that stops the
ping-pong by making one writer authoritative would take the reversal rate
to zero **while leaving the bias fully in place** — and would look like a
complete success by criterion (1) alone.

