# CLV against the vig, on observed closes only (2026-08-23)

> **This is the question the whole thread was originally about.**
>
> **CLV is +2.00pp [+0.67, +3.24] on n=86 — significantly positive.**
> **The vig is 2.45pp per side, measured. Net is −0.45pp [−1.73, +0.70]
> — not distinguishable from zero.**
>
> The earlier conclusion was net −1.47pp, "which explains 126W-142L
> without needing anything else." **That explanation no longer holds.**
> Roughly breakeven against the vig does not explain a losing record.

## The headline

```
                      n     CLV                    NET of vig             CLV>0
ALL observed         86   +2.00pp [+0.67, +3.24]  -0.45pp [-1.73, +0.70]   69%
```

**CLV excludes zero.** The picks genuinely beat the closing line.

**Net does not exclude zero.** Whether they beat it by enough to clear
the vig is unresolved — the interval spans from meaningfully losing
(−1.73pp) to slightly winning (+0.70pp).

## The overround was measured, not quoted

The 4.50pp figure came from an earlier pass. Recomputing from the same
closing captures the CLV is measured against — because quoting a
remembered constant against a freshly-measured CLV compares two different
markets:

```
games with a closing pair inside 60m : 392   (all games, not just bet ones)
total overround : +4.90pp   95% CI [+4.84, +4.95]
PER SIDE        : +2.45pp
```

**4.90pp, not 4.50pp.** Slightly worse than assumed, so the bar is
slightly higher.

Measured over **every** game with a closing pair, not just the 86 that
were bet. Overround is a property of the market, not of the selection —
restricting it to bet games gave n=11, which is both thin and needlessly
selected. That was a first-pass error, caught and fixed.

## Why the number moved: +0.78pp → +2.00pp

```
ALL ML rows incl. assumed closes : n=273   CLV +0.78pp [+0.30, +1.30]
OBSERVED closes only             : n= 86   CLV +2.00pp [+0.67, +3.24]
```

187 of the 273 had an **assumed** closing line (`closing_line =
market_line`, written by the old `GET /backtest`). On those, CLV
degenerates into `implied(market_line) − implied(bet_line)` — the bet
price against the **emit** price, not against a close. That is a
different quantity wearing the CLV label, it centres near zero, and there
were twice as many of them.

**So +0.78pp was never a closing-line figure.** It was a blend of real CLV
and a near-zero impostor.

## Day-before vs same-day

The split you asked for. `bet_locked_at` converted to PT and compared to
the game's calendar date, because "the day before" is a calendar notion,
not a lead-time threshold.

```
                        n     CLV                    NET of vig             CLV>0
day-before (or earlier) 60   +1.76pp [+0.21, +3.16]  -0.69pp [-2.23, +0.72]  73%
same-day                25   +2.70pp [+0.92, +4.44]  +0.25pp [-1.56, +1.99]  60%
unclassified             1
```

**Same-day looks better — and it is not a distinguishable difference.**

The point estimates separate (2.70 vs 1.76 CLV; +0.25 vs −0.69 net), and
same-day is the only cell with a positive net point estimate. But the
intervals overlap across almost their entire range, and n=25 is thin.
Reporting "betting same-day beats the vig and day-before does not" would
be reading a 0.94pp gap out of intervals three points wide.

The one shape worth noting, because it points the opposite way to the
means: **day-before wins the CLV coin-flip more often (73% vs 60%) while
same-day wins by more when it wins.** Both are small-sample observations,
neither is significant, and they are recorded as texture rather than
findings.

Lead-time distribution (n=66 with a first-pitch timestamp):

```
min -1.2h   p25 8.3h   median 25.1h   p75 28.8h   max 2062.6h
```

Median 25h confirms the day-before pattern. Two outliers are real data
problems rather than behaviour: **one bet locked 1.2h AFTER first pitch**,
and one at 2062h (86 days), which is the game-date mismatch already seen
in the first-pitch backfill. Neither is excluded — they are 2 of 66 and
excluding them would be tuning the sample.

## What this changes

The 2026-08-23 CLV doc concluded:

> *"You beat the close by 0.78pp and pay 2.25pp to do it… That single line
> explains 126W-142L and −$420.47 without needing anything else."*

**That is no longer supported.** On observed closes the net is −0.45pp
with an interval spanning zero. A roughly-breakeven CLV-vs-vig position
does not explain a materially losing record — something else is doing the
work, and the honest answer is that this analysis no longer identifies
what.

Candidates it cannot separate, all previously noted: variance on n=268
graded bets; the selection caveat (CLV is measured on hand-picked, manually
locked bets, which is a different population from the model's output); and
the fee-adjusted-Kalshi CLV skew recorded in `jobs.js` that inflates CLV
relative to a true closing line.

**The prior doc is annotated rather than rewritten.**

## Caveats that cut against the headline

- **n=86.** The observed subset is a third of the logged book.
- **Selection stands.** Per the 2026-08-21 rule, a statistic on a
  hand-selected subset is not a property of the model. These may be
  operator picks that beat the close; this cannot separate operator skill
  from model skill.
- **CLV here is fee-skewed upward** where `kalshi_direct_primary_enabled`
  was on — `services/jobs.js:2320` records that the stored price is
  fee-adjusted, so CLV computed against it is systematically inflated.
  That pushes the true net *below* −0.45pp by an unquantified amount.

~~That last one matters: it is the one caveat that moves the answer in a
consistent direction rather than widening the interval.~~

> **CORRECTION 2026-08-23 — the fee caveat is wrong, measured.**
> The `jobs.js` warning describes a **one-sided** adjustment. In fact
> `bet_line`, `closing_line` and the capture table all derive from
> `game_log.market_*_ml`, which is already fee-adjusted — so both sides of
> the CLV carry the fee and it cancels.
>
> Measured residual: **−0.011pp, 95% CI [−0.023, −0.001]** — negligible,
> and **negative**, i.e. the opposite direction to what I claimed. Net
> moves −0.451pp → −0.440pp. **It stays ambiguous; it does not become
> clearly negative.** (If only the close were adjusted the skew would be
> +1.649pp — that is the number the caveat describes, and it does not
> apply.)
>
> See `docs/fee-skew-and-the-record-2026-08-23.md`.

## Related

- `scripts/clv-vs-overround.js` — this analysis.
- `docs/rederived-ml-closing-lines-2026-08-23.md` — where the observed subset comes from.
- `docs/projected-state-calibration-and-clv-2026-08-23.md` — the superseded figure.
- `CLAUDE.md` §"Never open a second write connection" — the trap hit twice while producing this.
