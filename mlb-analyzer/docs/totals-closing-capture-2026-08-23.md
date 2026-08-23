# Building the totals closing capture (2026-08-23)

> **The gap was bigger than "no capture". A read endpoint was actively
> manufacturing the data and wiping the CLV.**
>
> `GET /backtest` ran, on every request:
> `UPDATE bet_signals SET closing_line = market_line` for any resolved
> signal missing one, and `UPDATE bet_signals SET clv=NULL WHERE
> signal_type='Total'`.
>
> That is the real origin of 761-of-761 identical closing lines. They were
> not uncaptured — they were **backfilled from themselves**.

## What was actually wrong — four sites, not two

| # | site | defect |
|---|---|---|
| 1 | `jobs.js:2332` | closing capture filtered `signal_type='ML'` |
| 2 | `jobs.js:3874` | same filter in `processOddsArray` |
| 3 | `api.js` bulk endpoint | same filter |
| 4 | **`api.js` `GET /backtest`** | **manufactured `closing_line = market_line`, and nulled every totals CLV, on every request** |

Sites 1–3 were the ones scoped. **Site 4 was not, and it would have
silently undone the other three**: any totals row reaching
`outcome != 'pending'` without a closing line would have had one
fabricated equal to its emit line on the next page load, and any CLV
computed would have been wiped.

Worth stating plainly: a `GET` endpoint that mutates was already a known
outstanding item. It turns out to have been the load-bearing cause of the
finding that started this thread.

The comment on site 4 explained itself as *"Total signals stay clv=NULL —
bet_line is a total, not a price"* — the exact inverse of what `bet_line`
actually held before yesterday's fix, which is the same code-vs-data
inversion `model.js:1607` carried.

## (1) ML filters removed

Both `jobs.js` paths now select every unclosed signal. The two copies of
the write block were replaced by one shared writer so they cannot drift:

```js
function closingValuesFor(sig, gameRow) {
  if (String(sig.signal_type).toLowerCase() === 'total') {
    const isOver = String(sig.signal_side).toLowerCase() === 'over';
    return { closingLine: gameRow.market_total, closingPrice: isOver ? gameRow.over_price : gameRow.under_price };
  }
  return { closingLine: sig.signal_side === 'away' ? gameRow.market_away_ml : gameRow.market_home_ml,
           closingPrice: null };
}
```

`GET /backtest`'s backfill is now scoped to `signal_type='ML'` — ML
behaviour is byte-identical, and totals have exactly one writer: the real
capture.

## (2) Both quantities captured

New `bet_signals.closing_price INTEGER`, mirroring `bet_line`/`bet_price`:

| | line | price |
|---|---|---|
| bet | `bet_line` | `bet_price` |
| close | `closing_line` | `closing_price` |

One mental model covers both ends of a totals bet.

## (3) CLV extended, price as the primary term

`services/clv.js` gains `clvForSignal()` — one implementation for both
types:

- **ML** — unchanged; the line *is* the price.
- **Total** — CLV is `bet_price` vs `closing_price`. The line move is
  returned **separately** as `lineMove`, not folded in.

Two reasons the price leads:

- It moves in **97.4%** of games; the line in **39.9%**.
- A total going 7.5 → 8.5 and a price going −110 → −103 are different
  events. Averaging them into one number hides both.

`lineMove` is signed from the bettor's view — positive means the line
moved your way (up for an over, down for an under). Verified:

```
ML                          -> { clv: 4.1,  lineMove: null }
Total over,  8.5->9, -110->-120 -> { clv: 2.2,  lineMove: +0.5 }
Total under, 8.5->9, -110->-105 -> { clv: -1.2, lineMove: -0.5 }
Total, no bet_price (historical) -> { clv: null, lineMove: +0.5 }
```

That last case matters: historical totals return **null CLV, not a
fabricated zero.** They have no struck price, and inventing one is what
got us here.

The `api.js:5860` bet-line endpoint splices in the `bet_price` from the
same request, so logging a bet against an already-captured close yields
CLV immediately rather than on some later pass.

## (4) Verified — and the check would fail if the capture were still inert

`scripts/verify-totals-closing-capture.js` drives the real path against
completed games inside a **transaction that is rolled back**. Nothing is
written.

```
totals signals available to test : 500   (of which 35 carry a struck bet_price)
games missing a game_log row     : 0

1. totals selected by the capture       : 500
2. closing_price populated              : 499  (99.8%)
3. closing LINE differs from emit       : 26
4. CLV computable on every logged bet   : 37

PASS  totals are selected (ML filter gone)
PASS  closing_price is populated
PASS  at least one closing value differs from emit
PASS  CLV computable on every logged totals bet
=== PASS ===
```

Real captures that differ from emit:

```
2026-08-07 laa-mia  under  emit 9.5 -> close 8.5   closing_price +100
2026-08-06 mia-atl  over   emit 8.5 -> close 9.5   closing_price +113
2026-08-05 nym-cle  under  emit 8.5 -> close 7.5   closing_price -104
```

**Check 3 is the one that matters** — it is precisely the assertion that
761/761-identical would fail. A verification that only printed numbers
would have passed happily against the broken capture.

### One honest note on the numbers

Check 4 initially reported **0** and I nearly wrote it up as a defect. The
cause was sampling: the 400 most recent totals have no `bet_price`,
because every logged totals bet is from April–May. The check now
deliberately includes all rows carrying a struck price, and the comment
says why — otherwise the next person sees "CLV not computable" and blames
the capture.

Also recorded: **closing price differs from struck price: 0.** All 35
logged bets are April–May, and their `game_log` over/under prices are
frozen at the same values that were struck. That is not evidence the
price does not move — it is the same "no capture ever ran" artifact, one
layer down. It will resolve as new bets are logged.

## The Under-lean — annotated, not revised

`docs/totals-remeasure-2026-07-04.md` and `docs/audit-2026-07-02.md`
(finding 1.3) now carry a banner stating:

- The finding **rests on realised P&L alone.**
- It **cannot gain CLV support retroactively** — the closing values were
  never observed, so there is nothing to recover. Nulling the 761
  manufactured copies is an option; inventing closing prices for them is
  not.
- **Going forward it can**, from today.

Not a refutation. It does mean the Under lean stands on one leg where the
ML findings stand on two, and the second leg starts accumulating now.

## Not done

- **The 761 manufactured `closing_line` copies are left in place.** They
  are indistinguishable from real captures by inspection, which argues
  for nulling them — but that is destructive to a settled record and is
  your call. Until then, any totals CLV analysis should restrict to
  `closing_price IS NOT NULL`, which cleanly separates real captures from
  manufactured ones.
- **No backfill.** There is no source for a closing value that was never
  observed.
- `GET /backtest` still mutates on read. Now scoped to ML, so it can no
  longer manufacture totals data, but the underlying design issue stands.

## Related

- `docs/totals-closing-capture-scope-2026-08-23.md` — the scoping that led here.
- `docs/totals-bet-price-2026-08-23.md` — the `bet_price` half.
- `services/clv.js` `clvForSignal` · `services/jobs.js` `writeClosing` · `scripts/verify-totals-closing-capture.js`.
