# The totals edge: four steps, and what they found (2026-08-23)

> **It did not shrink on re-grading — it grew, 19.06% → 21.12% ROI.** The
> three defects were suppressing the number, not inflating it.
>
> **But the aggregate gap CI spans zero: +10.66pp [−1.91, +23.58], 1.30 SD
> on n=37.** The edge is not established.
>
> **The under subset is significant (+18.10pp, CI excludes zero) and does
> NOT survive on the unconditioned population (+1.10pp, spans zero).**
> Same sign, ~16× the magnitude. That is selection, not a model property.
>
> **And no mechanism was found.** The selection effect survives period and
> edge-band controls, but does not decompose into anything measurable.

## (1) Re-grade at struck prices — it grew

```
BEFORE (market price, flat-110 denominator) : +19.06% ROI, pnl +775.82
AFTER  (struck price, real denominator)     : +21.12% ROI, pnl +832.60
```

36 of 37 priced at the struck `bet_price`; one fell back to the market
price. **The expectation going in was shrinkage** — three defects that all
plausibly inflated the number. They did the opposite: grading at the
market's price rather than the operator's was *understating* the book,
consistent with the ~2pp offset already recorded.

Worth stating plainly because the prior was explicit and wrong.

## (2) `wageredFor()` fixed — in four places, not one

The flat 110 existed in **four** implementations:

| site | |
|---|---|
| `services/parameter-sweep.js` | → shared helper |
| `services/frv-backtest.js` | → shared helper |
| `public/index.html` `wageredForSignal` | → price-aware |
| `routes/api.js` SQL `CASE` | → `bet_price`, with a parity comment |

New `utils/wagered.js`. Price precedence for totals: `bet_price` (struck)
→ market over/under price → −110 genuinely last. ML unchanged — the line
*is* the price.

**Two things this surfaced that patching one site would have missed:**

**The SQL would have crashed.** My first version referenced
`over_price`/`under_price` in a query over `bet_signals` — those columns
live on `game_log`. Loading the module did not catch it; running the query
did. The SQL now uses `bet_price` only, with a comment recording the
deliberate divergence from the JS and why it is unreachable here (every
row is a logged bet, and logged totals carry `bet_price`).

**A corrupt price would have produced a $0.10 stake.** `game_log` carries
`over_price = 99900` on `lad-sf 2026-04-23` — the same game as the corrupt
ML sentinel. Unguarded, that gives `10000/99900 = $0.10` and silently
contributes a near-zero denominator to every totals ROI. It appeared as a
−109.9 outlier in the per-bet stake change. Now bounded by
`MAX_TOTAL_JUICE_ABS = 200`, reusing `unabated.js`'s existing constant
rather than inventing a second one.

Blast radius on the sweep engine: **−0.58%** on totals denominators
(per-bet −34.8 to +80.0). ML unaffected.

## (3) The gap, with a CI

```
23W-14L (n=37, 1 push)
realised win rate : 62.2%
price-implied     : 51.5%
GAP  : +10.66pp   95% CI [-1.91, +23.58]   SPANS 0
ROI  : +21.12%    95% CI [-3.19, +46.41]   SPANS 0
wins 23 vs expected 19.1  ->  1.30 SD
```

**Not established.** Exactly as the framing predicted — n=37 cannot answer
this, and 1.30 SD is the regime where the subset-sign-flip rule applies.

## (4) Against the Under-lean — and the decisive test

Split by side, the logged bets look striking:

```
over   n=17   9W-8L   gap  +1.92pp [-18.17, +25.23]   ROI  +3.97%
under  n=20  14W-6L   gap +18.10pp [ +6.20, +31.56]   ROI +35.24%   EXCLUDES 0
```

The edge lives entirely on the under side, which **matches** the
Under-lean's direction (the model over-projects Overs, so Unders should
carry the edge).

**Then the same measurement on the unconditioned population** — all 762
emitted totals signals, not just the 37 bet:

```
over   n=212  100W-112L   gap -4.16pp [-10.97, +2.54]  spans 0   ROI -7.96%
under  n=550  293W-257L   gap +1.10pp [ -2.81, +5.15]  spans 0   ROI +2.10%
```

**+18.10pp on 20 logged unders; +1.10pp on 550 unconditioned unders.**
Same sign, roughly sixteen times the magnitude, and the population figure
does not exclude zero.

Per the 2026-08-21 selection rule, a statistic on a hand-selected subset
is not a property of the model. **The Under-lean's direction survives; its
magnitude in the logged book does not.**

## Is it selection, or was that just a good month?

All 38 logged totals fall in **2026-04-09 .. 2026-05-08** — one month, 18
dates, entirely before the v7 cohort cutover. Comparing them to an
April–August population compares different periods and different model
versions. So: same-window comparison, logged vs not-logged.

```
SAME PERIOD (2026-04-09 .. 2026-05-08), n=89
  logged      n=37   gap +10.66pp   ROI +21.12%
  NOT logged  n=52   gap  +1.01pp   ROI  +3.47%

matched on edge band (>= 4pp, where the operator actually bet)
  logged      n=36   gap  +9.60pp
  NOT logged  n=52   gap  +1.01pp
```

**The selection effect survives both controls.** It is not a period
effect, and it is not explained by the operator simply taking bigger
claimed edges.

## The mechanism question — and an honest negative

The most promising lead: the operator picked **lower** totals (mean 8.12
vs 8.80). If the model were better on low totals, that would be an
actionable rule.

**It is not.** On the unconditioned population, by total band:

```
< 7.5     n= 18   +8.82pp  [-14.72, +32.00]
7.5-8     n=164   -2.73pp  [ -9.82,  +4.34]
8.5-9     n=328   -2.57pp  [ -7.92,  +2.66]
>= 9.5    n=252   +3.39pp  [ -2.72,  +9.65]
```

No monotone pattern, nothing excludes zero, and the band the operator
favoured (7.5–8) is **negative**. Under-only tells the same story: 7.5–8
is −8.34pp while ≥9.5 is +2.72pp — if anything the edge sits at *high*
totals, the opposite of what was selected.

Side mix points the wrong way too: the operator was **less** under-heavy
than the signal population (55% vs 73% unders), yet the outperformance
came from unders.

**So: no identifiable mechanism.** The selection effect is real in
direction and survives the controls available, but does not decompose into
edge band, period, total level, or side. It is either operator judgment
not captured in these fields, or noise on n=37 — and with the aggregate CI
spanning zero, the second remains entirely plausible.

## What I would and would not conclude

**Would:**
- The three grading defects are fixed, and fixing them made the book look
  *better*, not worse.
- `wageredFor` is now one implementation with a corrupt-price guard.
- The totals edge is **not established** at n=37.
- The logged under result is a **selection artifact** at the magnitude
  reported — it does not reproduce on 550 unconditioned signals.

**Would not:**
- Act on the +18.10pp under number.
- Claim the Under-lean is refuted. Its *direction* reproduces (+1.10pp
  under vs −4.16pp over on the full population); only the logged-book
  magnitude fails.
- Claim an actionable mechanism exists. None was found, and reporting one
  from a slice that survived three of my own tests would be exactly the
  multiple-comparisons trap this thread has been avoiding.

## Related

- `scripts/totals-edge-regrade.js` · `utils/wagered.js`
- `docs/fee-skew-and-the-record-2026-08-23.md` — where these four steps were scoped.
- `docs/totals-remeasure-2026-07-04.md` — the Under-lean, annotated P&L-only.
- `CLAUDE.md` §"Subset sign-flip rule" — why the unconditioned re-measurement was mandatory.
