# Totals bet price: captured, ignored, and now graded (2026-08-23)

> **Short answers:**
> 1. **The schema did store a price — in `bet_line` — and the grading code
>    ignored it**, because `model.js:1607` asserted `bet_line` on totals is
>    the *line*, not the price. Not a missing column; a semantic collision.
> 2. **Price is now an editable field on totals**, defaulting to the
>    displayed over/under price exactly as the total defaults to the line.
> 3. **Your logged totals bets were NOT graded at −110.** They were graded
>    at the *market's* price. Net effect on the 36 clean rows:
>    **ROI understated by 1.99pp** (22.10% shown vs 24.09% actual).
>    **CLV is null on all 38** and that is by design, not an accident.

## 1. Where the price actually lived

`bet_line` does double duty by signal type:

| type | what a bet needs | what `bet_line` held |
|---|---|---|
| ML | one number — the line **is** the price | the price ✓ |
| Total | **two** numbers — the total *and* the juice | **the price**, on 37 of 38 rows |

So a price was being captured. But `services/model.js:1607` read:

```js
const line = effectiveLine(price, null); // bet_line on totals is the line number, not the price
```

**The code and the data disagreed.** Grading therefore used
`game_log.over_price / under_price` — the *market's* price — and never
looked at what you actually got.

The one dissenting row is the tell: `2026-04-15 was-pit over` has
`bet_line = 9` and `market_line = 9`. That is a **total** in the price
field, and it is exactly what the current one-click button writes for a
totals bet — it defaults to `sig.market_line`, which for a Total is the
total. So the column was accumulating both quantities depending on which
path wrote it.

## 2. What your logged bets were graded against

**Not −110.** The fallback chain was market price → −110, and `game_log`
carried a price for **all 38** rows, so the −110 branch never fired.

But **36 of 38 were graded at a price different from the one logged**:

```
                                    pnl       wagered      ROI
as graded now (market price)     870.16      3936.71    22.10%
at the LOGGED price (bet_price)  926.94      3847.85    24.09%
                                              misstatement:  -1.99 pp
```

Real, and in the direction that flatters the market rather than you — but
**~2pp, not the catastrophe a blanket −110 assumption would have been.**

Two caveats, both stated because they cut against a clean number:

- **One row skews everything.** Included, the corrupted `bet_line = 9` row
  makes the gap look like **22.96pp** — because a "price" of +9 implies a
  $1,111 stake on a $100 win. That figure is an artifact, not a finding.
  The 1.99pp above excludes it.
- **n = 36.** This is a small sample of small price differences.

### CLV on totals is null by design

`routes/api.js:5860`:

```js
// CLV in implied-prob percentage points; ML only — Total signals stay clv=NULL.
const clv = (sig.signal_type === 'ML') ? calcCLV(bet_line, sig.closing_line) : null;
```

0 of 38 totals bets have CLV; 273 of 274 ML bets do. **Capturing the bet
price is necessary but not sufficient to fix this**, because
`closing_line` on totals holds the closing *total*, not a closing price —
its observed range is **−104 to 13.5**, i.e. the column is itself mixed.

Real totals CLV needs a `closing_price` column. **Filed, not built here.**

## 3. What changed

### Schema

New `bet_signals.bet_price INTEGER`. Settled semantics:

| type | `bet_line` | `bet_price` |
|---|---|---|
| ML | the price you got | NULL |
| Total | the **total** you got | the **juice** you got |

This resolves the collision in favour of the `model.js` comment and the
UI's existing behaviour, rather than inventing a third convention.

### Migration — 35 of 38 rows

`scripts/backfill-totals-bet-price.js`, dry-run by default. Price-shaped
`bet_line` (|v| ≥ 100) moves to `bet_price`; `bet_line` becomes
`market_line`, the emit-time total, which is post-lock immutable and
therefore is the total shown on the card when you logged.

**It refused three rows rather than coercing them**, which is the point of
classifying explicitly instead of by heuristic:

```
2026-04-15 was-pit  bet_line=9     market_line=9      already a total, price never captured
2026-04-14 nym-lad  bet_line=-103  market_line=NULL   no total to move into bet_line
2026-04-25 min-tb   bet_line=-104  market_line=-104   market_line holds a PRICE, not a total
```

The last two are separate pre-existing corruptions, surfaced by the
refusal. ML rows touched: **0**, verified after.

### Grading

```js
const price = (signal.bet_price != null && signal.bet_price !== '')
  ? Number(signal.bet_price)
  : (isOver ? (signal.overPrice || signal.over_price || -110)
            : (signal.underPrice || signal.under_price || -110));
```

Verified: `bet_price` −105 → graded −105; absent → market −130; neither →
−110.

### UI

- **One click still logs in one click.** The button now reads
  `Log 8.5 @ -115` — the price defaults to the displayed over/under price
  the same way the total defaults to the displayed line.
- **Adjust offers both fields**, total and price, side by side.
- A logged totals bet with **no** captured price renders an amber `@ ?`
  with a tooltip saying P&L falls back to the market price.
- ML is untouched: `Log -140`, one field.
- The total renders as `8.5`, not `+8.5` — the sign prefix is right for
  American odds and wrong for a line.
- The read-back guard now verifies the **price** landed too, not just the
  line. A partial write that silently kept the old juice is exactly what
  that guard exists to catch.

Handlers are bound after render rather than inlined as `onkeydown="..."`.
The inline form needs a quote escaped inside an attribute inside a JS
string literal — three levels of quoting, which I mis-escaped once while
writing this.

## 4. Not done

- **`closing_price` for totals CLV.** The blocker for totals CLV, and a
  schema change with its own backfill question (what closing price, from
  which source, as of when).
- **The two corrupted rows** (`nym-lad` with a null total, `min-tb` with a
  price in `market_line`) are left as-is and enumerated above. They are
  yours to decide on — one is missing data, the other needs the real total
  recovered from a snapshot.
- **No re-grading of historical P&L.** `pnl` on the 35 migrated rows still
  reflects the market-price basis. Re-running the grader would change
  recorded outcomes on bets you have already reconciled; that is a
  deliberate call, not a side effect of a schema fix.

## Related

- `services/model.js` — the totals P&L branch and its price precedence.
- `routes/api.js:5851` — the bet-line endpoint, now accepting `bet_price`.
- `scripts/backfill-totals-bet-price.js` — the migration and its refusals.
