# The fee skew, and what actually explains the record (2026-08-23)

> **(1) The fee skew is −0.011pp. Negligible, and in the opposite
> direction to what I claimed. Net stays ambiguous at −0.45pp.**
>
> **(2) The record question largely dissolves on contact.** The ML book is
> **0.26 standard deviations** from its own expectation, and the overall
> logged book is **+$355.35, profitable**. There is far less to explain
> than the framing assumed.

## (1) Quantifying the fee skew — I was wrong

I wrote that CLV is "fee-skewed upward… so true net sits below −0.45pp by
an unquantified amount." **That is incorrect**, and quantifying it shows
why.

The `jobs.js:2323` caveat is real but describes a *one-sided* adjustment.
Tracing what is actually stored:

| field | fee-adjusted? |
|---|---|
| `game_log.market_*_ml` | **yes** — venue winner's `net_american` (`jobs.js:1557-59`) |
| `bet_signals.market_line` | yes — from the above |
| `bet_signals.bet_line` | yes — operator entry defaults to `market_line` |
| `empirical_market_captures.*_price_ml` | **yes** — reads `market_*_ml` from `game_log` |
| `closing_line` (captured **or** re-derived) | yes — from one of the above |

**Both sides of `implied(close) − implied(bet)` carry the fee, so it
cancels:**

```
CLV = (C_close − C_bet) + [fee(C_close) − fee(C_bet)]
```

The residual is a *difference of fees*, not a fee. Measured by inverting
`A = C + 0.068·C·(1−C)` to recover raw prices and recomputing:

```
CLV as stored (both sides adjusted) : +1.999pp
CLV with the fee removed from both  : +2.010pp
SKEW (stored − raw)                 : -0.011pp   95% CI [-0.023, -0.001]

for contrast, if ONLY the close were adjusted : +1.649pp
```

**−0.011pp, not +1.6pp — and negative, not positive.** The 1.649pp figure
is what the caveat describes, and it does not apply because the bet side
carries the same adjustment.

```
net using stored CLV : -0.451pp  [-1.755, +0.778]
net using raw CLV    : -0.440pp  [-1.775, +0.782]
```

**So −0.45pp does not become clearly negative. It stays ambiguous.**

One further reason not to "correct" for this: the 2.45pp overround was
itself computed from fee-adjusted prices, so it embeds the fee too.
Removing it from CLV but not from the vig would double-count. The raw row
is an upper bound on the correction, not the corrected answer.

## (2) What explains the record

### The record is not what the framing assumed

```
ML     126W-142L    pnl  -420.47
Total   23W-14L-1P  pnl  +775.82
                    ----------------
TOTAL               pnl  +355.35   over 306 graded bets
```

**The logged book is profitable.** "The losing record" is the ML
sub-book specifically.

### The ML book is indistinguishable from zero-EV plus variance

```
126W-142L, n=268
actual win rate    : 47.015%
mean implied prob  : 46.967%      <- the break-even rate at the prices struck
gap                : +0.048pp

realised pnl       : -413.69
total wagered      : 24,786.87    ROI -1.67%
SD of realised     : 1,574.38     (ROI SD 6.35%)
realised is        : -0.26 SD from expectation
```

**The picks won at almost exactly the rate their prices implied**, and the
realised loss is a quarter of one standard deviation. On 268 bets at these
odds, −$414 is an ordinary outcome of a book with no edge and no deficit.

**There is almost nothing here for calibration, selection, or grading to
explain.** The three candidates were offered to explain a systematic
shortfall, and the data does not show one.

### A tautology I nearly reported as evidence

My first pass computed "EV at struck prices = 0.00" and it looked like a
finding. It is not. Under to-win-$100 staking, `stake = 100p/(1−p)`, so:

```
EV = p·100 − (1−p)·(100p/(1−p)) = 100p − 100p = 0
```

**identically, for every bet, at any price.** Verified across −200 to
+300: EV is 0.000000 in all cases. It says nothing about the picks.

The meaningful statistic is realised P&L against its own standard
deviation, which is the −0.26 SD above. Recorded because the tautological
version is more persuasive-looking and would have been wrong.

### Retiring the three candidates

| candidate | what the data says |
|---|---|
| **Weak-but-sound calibration** | Would predict a win rate *below* the implied rate. Observed gap is **+0.048pp** — if anything marginally above. Not supported as an explanation of the ML result. |
| **Selection within emitted signals** | Would also show as a win-rate shortfall on the logged subset. Same +0.048pp answer. It remains true that logged bets are a hand-picked subset and their stats are not model properties — but that cuts *for* the picks here, not against. |
| **Grading** | Worth a look, but it would have to be systematically biased and small: the ML gap is 0.048pp. There is no room for a large grading error in the ML book. |

## What genuinely remains open — the totals book, not the ML one

The surprising number is not −$420 on ML. It is **+$775.82 on 37 totals
bets with a +10.6pp gap** between the realised win rate (62.2%) and the
price-implied rate (51.6%).

That is a very large edge on a very small sample, and it sits on grading
machinery I already found defective:

- **Graded at the market's price, not the struck price** until
  2026-08-23 — the ~2pp offset already recorded. Correcting it makes the
  book *better* (24.09% vs 22.10% ROI), not worse.
- **`wageredFor()` returns a flat 110 for totals** regardless of price, so
  totals ROI denominators are approximations.
- **`bet_line` held the price on 37 of 38 rows** until yesterday's
  migration — anything computed from it before then was reading the juice
  as the line.
- **n=37, with one push.** A 10.6pp gap on 37 bets is roughly 1.3 SD.

**Scope for the real question, then, is not "why did the book lose" — it
is "is the totals edge real?"** That is answerable and worth answering:

1. **Re-grade the 37 totals bets at their struck prices** (`bet_price`,
   now captured) and recompute the gap. Cheap, and removes the known
   defect.
2. **Fix `wageredFor()` for totals** to use the actual price rather than a
   flat 110, so the ROI denominator is real.
3. **Compute the win-rate gap with a CI**, not a point estimate — 1.3 SD
   on n=37 is exactly the regime where a subset flips sign, per the
   subset-sign-flip rule.
4. **Check it against the Under-lean**, which is the same population seen
   from the model side and which currently rests on P&L alone.

**Explicitly not proposed:** any parameter sweep. Nothing above tunes a
constant, and the ML result says there is no systematic deficit for a
constant to fix.

## Related

- `scripts/quantify-fee-skew.js` — the fee measurement.
- `docs/clv-vs-overround-observed-2026-08-23.md` — the caveat this corrects.
- `docs/totals-bet-price-2026-08-23.md` — the ~2pp totals grading offset.
- `docs/totals-remeasure-2026-07-04.md` — the Under-lean, annotated as P&L-only.
