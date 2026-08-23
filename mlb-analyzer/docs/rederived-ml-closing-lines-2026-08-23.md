# Re-deriving ML closing lines (2026-08-23)

> **Method validated first, on rows where the answer was already known:
> 91.5% exact, median error 0.**
>
> **131 of 601 resolved. 470 keep the assumed tag. Every one of the 993 ML
> closing lines now carries explicit provenance — 0 untagged.**
>
> **The headline is not the 131.** It is that assumed closes drag mean ML
> CLV from **2.00pp down to 0.78pp**, and that distortion was invisible
> before the rows were tagged.

## (4) Validation first — the method reproduces known captures

Run against the 304 rows where the real capture ran and the true closing
line is on record. If re-derivation reproduces those, it works.

```
known-captured rows (audit row + line moved)  : 304
... within the capture era (>= 2026-06-11)    : 269

window   resolved   exact   median|err|   % exact
  15m        59       57         0         96.6%
  30m        81       76         0         93.8%
  60m       165      151         0         91.5%
  90m       219      196         0         89.5%
 120m       246      217         0         88.2%
 180m       264      231         0         87.5%
```

**Median error is 0 at every window**, and "within 1" tracks "exact"
almost exactly — so errors are not small drifts. A row is either right or
the line genuinely moved after the capture.

## (1) The window: 60 minutes, chosen rather than asserted

Fidelity falls **monotonically** as the window widens, because an older
capture has had more time for the line to move after it. So maximising
fidelity picks 15m and resolves almost nothing — a degenerate choice.

The rule instead: **the widest window still holding ≥90% fidelity.**

That is **60 minutes**. 90m was rejected — it would add 54 rows at 89.5%.
This fixes the error rate we are willing to accept and then takes as much
coverage as that allows, rather than picking a round number and reporting
whatever fidelity falls out.

**A capture older than 60 minutes is a mid-day price, not a close, and is
refused rather than substituted.** That is the requirement, enforced in
code, not just stated.

## (2) Provenance tags — every row, no gaps

| tag | n | meaning |
|---|---|---|
| `set_closing_line` | 370 | the real capture ran |
| `backfilled_closing_line` | 470 | **assumed** — `closing_line = market_line`, not observed |
| `rederived_closing_line` | 131 | recovered from a capture, with its timestamp in the detail |
| `observed_no_audit` | 22 | line moved so it is real, but the capture predates `bet_signal_audit` |
| **untagged** | **0** | |

Each re-derived row records the capture it came from:

```
closing_line re-derived from empirical_market_captures at 2026-07-10 15:26:34 (PT),
within 60min of first pitch. Replaces the assumed 220. Method validated at 91.5%
exact against known captures.
```

The 22 were tagged separately rather than being folded into either
bucket. They are genuinely real — the line moved, so they cannot be
backfill copies — but calling them `set_closing_line` would fabricate an
audit of a capture I did not observe.

## (3) Before / after

```
target rows (indistinguishable from backfill)  : 601
  in the capture era (>= 2026-06-11)           : 266
  before it, unreachable by any method         : 335

resolved from a real capture   : 131  (21.8%)
unresolved, keep assumed tag   : 470
   no capture within 60m       : 378
   no first_pitch_utc          :  92
```

**Of the 131 resolved, 27 (20.6%) had a closing line that actually
moved** — i.e. the backfill's "the line did not move" assumption was
demonstrably wrong on one in five.

### How much did this move CLV? Almost nothing — and that is the finding

```
resolved rows carrying a CLV   : 5
... CLV moved >= 0.5pp         : 0
CLV delta (new - old)          : median 0.00pp, mean 0.00pp
```

Only **5** of the 131 resolved rows have a logged bet, so the direct CLV
correction is negligible. Re-derivation was worth doing for provenance,
not for the numbers it changed.

### The aggregate, which is where the real distortion lives

```
ALL ML rows with CLV   : n=273   mean 0.78pp
OBSERVED closes only   : n= 86   mean 2.00pp
ASSUMED closes only    : n=187   mean 0.22pp
```

**The assumed rows average 0.22pp and there are twice as many of them, so
they halve the reported figure.** That is arithmetically unsurprising once
stated: when `closing_line = market_line`, CLV becomes
`implied(market_line) − implied(bet_line)` — it measures the bet price
against the *emit* line, not against a close. It is a different quantity
wearing the CLV label, and it centres near zero.

**So "ML CLV averages 0.78pp over 273 bets" was never a closing-line
figure.** The defensible statement is **2.00pp over 86 bets** — a
stronger effect on a third of the sample.

## A finding I did not go looking for

Of the 27 corrections, **9 were on market-contaminated games** — the ones
tagged `priced_post_first_pitch`. On those, `market_line` itself is a
post-first-pitch price, so re-derivation is replacing a contaminated
value with a real pre-game one rather than correcting a close:

```
2026-07-11 mil-pit  away  assumed  411 -> real -132   cap@2026-07-11 08:41:55
2026-07-07 nyy-tb   away  assumed  432 -> real  108   cap@2026-07-07 15:00:52
```

`mil-pit` is the same row from the contamination trace (`−132 → +411`,
d=+543). Both corrections are improvements, but they are **different
things**, and reporting all 27 as "closing-line corrections" would have
been wrong. The other 18 are genuine closing-line movement on clean
games.

## Two method notes, recorded because both nearly cost a wrong conclusion

**The first `--apply` hung with nothing written.** The script opened its
own read-write SQLite handle while `q.insertBetSignalAudit` wrote through
`db/schema`'s handle — two writers, one file. Our transaction took the
write lock, the audit insert blocked on it, and the process sat forever.
Killed, DB verified clean (`integrity_check: ok`, 0 tags written, ML CLV
still 273), and the script switched to the shared connection.

**This is the second time connection-splitting has misled me today.** An
earlier test of `backfillMlClosingLines` reported "0 rows backfilled" and
looked like a broken function; it was the same mistake with a quieter
symptom. Any script in this repo that both reads and writes should take
`db` from `db/schema`, never open its own.

## What remains assumed

**470 rows still carry `backfilled_closing_line`**, and **187 of the 273
ML CLV values still rest on one.** They are not recoverable:

- **335** predate `empirical_market_captures` (before 2026-06-11) —
  no source exists.
- **378** have no capture within 60 minutes of first pitch — a mid-day
  price is not a close, and substituting one is the exact failure this
  work exists to undo.
- **92** have no `first_pitch_utc`, mostly games without a `game_pk`.

They are now **labelled**, which was the actual goal. Any CLV analysis can
restrict to observed closes with a tag test rather than a remembered
filter.

## Related

- `scripts/validate-rederived-closing.js` — the validation, run before anything was written.
- `scripts/rederive-ml-closing-lines.js` — the re-derivation and its refusals.
- `docs/backfill-moved-to-cron-2026-08-23.md` — where the 601 were characterised.
- `docs/post-start-pricing-tagged-2026-08-22.md` — the contamination overlapping 9 of the 27.
