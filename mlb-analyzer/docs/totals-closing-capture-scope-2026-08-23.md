# Scoping `closing_price`: the defect is one layer up, as suspected (2026-08-23)

> **You were right, and it is worse than a missing column.**
>
> `closing_line` on totals is **not** mixed — that was one corrupt row,
> now fixed. But **761 of 761 totals rows have `closing_line` exactly
> equal to `market_line`. Zero moved.** The closing capture for totals
> does not exist; the column holds a copy of the emit-time total.
>
> **Adding `closing_price` on its own would be pointless.** The capture
> needs the same two-quantity split `bet_line` just got.

## 1. Correcting my own claim

I reported that `closing_line` on totals "holds mixed content (range −104
to 13.5)". **That was wrong.** The distribution:

```
total-shaped (4..20)    : 761
price-shaped (|v|>=100) :   1     <- id=13484, the corrupt row
neither                 :   0
```

The entire "mixed" appearance came from the single corrupt row that the
`bet_price` migration had refused. With it repaired, the range is
**6.5 .. 13.5** — uniformly totals.

So the column's *semantics* were never ambiguous. Its *content* is the
problem.

## 2. The real defect: the column carries no closing information

```
totals rows with closing_line set                  : 761
closing_line identical to market_line              : 761
closing_line different from market_line            :   0
```

**Not one totals bet has a closing line that differs from its emit-time
line.** That is not a market observation; it is a copy.

To confirm it is not simply that totals do not move, from
`empirical_market_captures` (739 games with multiple captures):

```
games where the TOTAL moved       : 295 / 739   (39.9%)
games where the OVER PRICE moved  : 720 / 739   (97.4%)
```

```
2026-06-12 chc-sf    7.5 -> 8.5        2026-06-12 chc-sf   -126 -> -103
2026-06-13 ari-cin   9   -> 12.5       2026-06-12 col-ath  -121 -> +100
```

Totals move in two games out of five. **Their prices move in ninety-seven
per cent of games.** A column that records zero movement across 761 bets
is recording nothing.

### Why totals were never captured

Both closing-capture paths filter to ML explicitly:

- `services/jobs.js:2331` — `WHERE ... signal_type='ML' AND closing_line IS NULL`
- `services/jobs.js:3817` — same filter in `processOddsArray`
- `routes/api.js:5941` (bulk endpoint) — `AND signal_type='ML'`

Only the single-signal endpoint `POST /signals/:id/closing-line`
(`routes/api.js:5925`) accepts any type, and it writes whatever it is
handed. The 761 values are consistent with a backfill that passed the
emit-time total.

**So totals were never in scope for closing capture at all.** The null CLV
is downstream of that, not of the missing price column.

## 3. What this means for the design

The price is the dominant term. A totals CLV built only on the closing
*total* would miss the movement in **97.4%** of games while capturing it
in 39.9%. **Both quantities are needed, and the price matters more.**

That is the same two-quantity split `bet_line` just received, one layer
up — exactly the shape you predicted.

### Proposed scope, not built

**Step 1 — make the capture real, before adding any column.**
Extend the two closing-capture paths to include `signal_type='Total'`.
Without this a new column simply stays NULL, and we would have shipped a
column and still had no CLV.

**Step 2 — split the two quantities.**

| column | holds | note |
|---|---|---|
| `closing_line` | the closing **total** | already exists; semantics already correct, content currently a copy |
| `closing_price` | the closing **juice** for the bet side | new |

Mirrors `bet_line` / `bet_price` exactly, so one mental model covers both
ends of the bet.

**Step 3 — compute totals CLV from the price**, with the total-line move
reported alongside rather than folded in. A total moving 7.5 → 8.5 and a
price moving −110 → −103 are different events and averaging them into one
number would hide both.

**Step 4 — do not backfill historical closing values.** They were never
captured; there is no source to recover them from, and the current 761
copies should arguably be **nulled** rather than left looking like data.
That is a destructive change to a settled record, so it is flagged for
your decision rather than done here.

### Consequence for the Under-lean finding

The Under-lean has **no CLV validation and cannot have had any** — every
totals CLV is null, and would have been zero even if computed, because
closing equals emit on every row. Whatever support that finding has comes
from realised P&L alone.

That is not a refutation. It does mean the Under-lean is currently
resting on one leg where ML findings rest on two, and Step 1–3 above is
what would give it the second.

## 4. The two corrupt rows — fixed

Both recovered from `game_log`; neither needed deleting.

**id=7458, 2026-04-14 nym-lad Total/under.** `market_line` was NULL and
`bet_line` held −103.

```
market_line  null -> 7.5     (game_log market_total)
bet_line     -103 -> 7.5
bet_price    null -> -103
edge_pct   0.0988 -> unchanged
```

`edge_pct` deliberately left alone: 0.0988 is inside the normal range
(totals average 0.103, legitimate max 0.455), and recomputing it today
yields 0.0232 — but `TOT_SLOPE` may have changed since April, so a
recomputation would **fabricate** rather than recover. An in-range
historical value we cannot verify is better left as recorded.

**id=13484, 2026-04-25 min-tb Total/under.** `market_line`, `bet_line`
*and* `closing_line` all held −104. This row was `is_active=1`.

```
market_line  -104 -> 8.5     (game_log 8.5, xcheck 8.5, proj 8.5 -- three sources agree)
bet_line     -104 -> 8.5
bet_price    null -> -104
closing_line -104 -> 8.5
edge_pct       42 -> NULL
```

`edge_pct = 42` was the **only value above 1.0 in the entire
`bet_signals` table** and impossible as a fraction; it was derived from
the corrupt `market_line`. Unlike row 1 there was no plausible recorded
value to preserve, so it is nulled rather than invented.

Both repairs were gated on two checks, and the script would have refused
and reported rather than written if either failed:

- `game_log.market_total` must confirm the recovered total;
- the recovered total must reproduce the **already-graded outcome**.
  Row 1: final 1–2 = 3 vs 7.5 → win, matches. Row 2: 1–6 = 7 vs 8.5 →
  win, matches.

Verification after applying:

```
Total rows with edge_pct > 1                   : 0
Total rows whose market_line is not a total    : 0
Total rows whose closing_line is a price       : 0
logged Total rows with no market_line          : 0
```

## 5. The ~2pp offset, recorded not rewritten

Per your instruction, historical totals P&L is **not** re-graded. The
known offset:

> **Totals ROI on bets logged before 2026-08-23 is understated by
> approximately 2 percentage points** (22.10% recorded vs 24.09% at the
> prices actually struck, n=36). Bets logged from 2026-08-23 onward carry
> `bet_price` and are graded at the struck price, so the offset applies to
> historical rows only and does not accumulate.

This is a reporting caveat, not a correction to apply. It is recorded here
and in `docs/totals-bet-price-2026-08-23.md` so any future totals ROI
figure can be read with it in mind.

## Related

- `docs/totals-bet-price-2026-08-23.md` — the `bet_price` split this mirrors.
- `scripts/fix-corrupt-totals-rows.js` — the repair, with its recoverability gates.
- `services/jobs.js:2331`, `:3817`, `routes/api.js:5941` — the ML-only closing-capture filters.
