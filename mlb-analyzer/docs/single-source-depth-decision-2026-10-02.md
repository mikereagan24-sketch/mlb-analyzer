# Single-source prices and book depth: record now, decide later (#484)

**Date:** 2026-10-02
**Status:** decision record. Nothing is blocked.

## Decision

Signals keep firing on single-source and thin-book prices exactly as before.
From 2026-10-02 every moneyline signal records, at signal time:

| column (`bet_signals`) | meaning |
|---|---|
| `ml_price_source` | venue the signal's price came from (`kalshi` / `polymarket`) |
| `ml_xcheck_status` | the game's moneyline cross-check: `cross-checked` / `single-source` / `no-market` |
| `ml_xcheck_source` | the second venue, when cross-checked |
| `ml_depth_usd` | dollars of asks at or better than the price the $100 fill reached, on that venue's book |
| `ml_depth_reason` | why `ml_depth_usd` is null |

`game_log.ml_xcheck_status` / `ml_xcheck_source` hold the odds job's answer
on its last unlocked pass, which is what a new signal copies.

**Whether to block (or down-weight) thin single-source signals will be
decided later, from this recorded data.** No threshold is chosen here.

## Why not block now

The #484 measurement (2026-10-02) could not answer the question:

- 57 logged ML bets were on games whose final record looked single-source:
  30-26, +$707, CLV +0.80. All ML bets averaged CLV +1.28. That is not
  evidence that single-source bets are bad, and the classification itself
  was approximate, because it came from the game's *last* state, not the
  state when the signal fired.
- Book depth was never recorded per signal. The venue snapshot kept only a
  simulated $100 fill, so "thin" could not be measured at all.
- 127 games (2026-08-04..09-16) were stored as cross-checked Polymarket vs
  Polymarket (see below), which polluted any split by cross-check.

A rule set on that data would be a guess. This change makes the next
measurement possible.

## What to measure before deciding

Once a few weeks of signals carry these columns:

1. Logged-bet W-L, P&L and CLV split by `ml_xcheck_status`, with medians
   and sign-split, not just means.
2. The same split by `ml_depth_usd` bands, e.g. under $250 / $250-1,000 /
   over $1,000, with the bands pre-registered before looking.
3. How often a bet's real fill was worse than the signal price, by depth.

Only then decide whether any gate is worth its cost in missed signals.

## The self-cross-check bug (fixed in the same change)

`processOddsArray` decided "single-source" by comparing the second venue
with **this pass's** `o.ml_source`.

- On a locked pass the price overrides skip the row, so `o.ml_source` was
  null, while the stored label (kept by COALESCE) said `polymarket`.
- Before 2026-09-17 the Unabated feed also supplied a cross-check labeled
  `polymarket`. `'polymarket' !== null` therefore read as two venues.

Result: 127 locked Polymarket-priced games stored with
`xcheck_ml_source = 'polymarket'`. 114 of them carry no single-source flag.

The rule now lives in `utils/price-source.js` `mlCrossCheck`: a cross-check
needs two distinct, known venues, both priced this pass. To keep signal
decisions identical, the old test still decides whether the divergence
comparison runs (its "disagree on favorite" result suppresses ML signals).
The new rule only adds the single-source text where the comparison was not
a real two-venue one.

**Historical rows are not rewritten.** They show "not recorded" for the new
columns, and their stored flags stay as captured, because the trends
reproduction tests read those flags.
