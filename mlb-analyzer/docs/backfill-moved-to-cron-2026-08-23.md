# Moving the backfill out of the read path (2026-08-23)

> **`GET /backtest` no longer writes.** The ML closing-line backfill now
> runs in the morning cron.
>
> **And it turns out the backfill fabricates for ML too** — 601 of 993 ML
> closing lines are indistinguishable from backfill, and **192 of the 273
> live ML CLV values rest on one.** So the fix is not a relocation: every
> row the backfill touches is now audit-marked as an assumption rather
> than an observation.

## 1. The move

`GET /backtest` ran, on every request:

```sql
UPDATE bet_signals SET closing_line = market_line, clv = ...
WHERE closing_line IS NULL AND signal_type='ML' AND outcome != 'pending'
```

Now `services/jobs.js backfillMlClosingLines()`, called from the morning
cron chain, non-fatal by construction. The endpoint carries a comment
saying what was there, why it left, and not to put a write back — because
**widening this very query is how the totals fabrication happened.**

Verified behaviour-preserving on a real row inside a rolled-back
transaction:

```
victim id=5615   before: closing_line=169  clv=1.2
  -> blanked, backfill run
  after: closing_line=169  clv=1.2        <- identical
  audit: WRITTEN  action=backfilled_closing_line  closing_line=169
  ROLLBACK -> restored=true
```

The first attempt at this test reported **0 backfilled** and looked like
a broken function. It wasn't: the test opened its **own** SQLite
connection, so the uncommitted blank was invisible to the connection
`jobs.js` holds. Re-run on the shared connection it passes. Recorded
because "the function did nothing" was the wrong conclusion and I nearly
drew it.

## 2. What the audit found on the way — the backfill fabricates for ML as well

The totals case was obvious because **761 of 761** closing lines equalled
their emit line, which no real market produces. ML hides it better,
because an ML line genuinely not moving is common.

Splitting by provenance — a `set_closing_line` audit row means the real
capture ran:

```
captured + line moved         : 304   <- unambiguously real
captured + line did not move  :  66   <- real, market simply flat
NO audit  + line moved        :  22   <- real, audit predates the table
NO audit  + line == market    : 601   <- INDISTINGUISHABLE from backfill
                                993
ML rows carrying a CLV                          : 273
  ... sitting on an indistinguishable closing   : 192   (70%)
```

**This is not explained by missing audit history.** The audit table spans
2026-04-27 .. 2026-08-06, and within that window the pattern holds:

```
              no-audit rows    captured rows
2026-06            209               2
2026-07            120             244
```

In June, 209 ML rows received a closing line while **2** were genuinely
captured. That is the backfill running, not history missing.

### Why it was kept rather than deleted

Two reasons, and the second is the one that separates this from the
totals case:

1. Removing it would leave ML CLV coverage far thinner than today, on a
   metric already in use.
2. **For ML the guess is often right.** 66 genuinely-captured rows also
   show `closing == market` — a flat line is real and common. For totals
   the guess was *never* right, because no totals close was ever
   observed at all.

### What was fixed instead: provenance

Indistinguishability was the actual defect in the totals case, not the
backfill itself. So every row the cron backfill touches now gets:

```
action  = 'backfilled_closing_line'
detail  = 'closing_line set = market_line (169). This is an ASSUMPTION that
           the line did not move, not an observed close.'
```

**A backfilled close is now distinguishable from a captured one, forever
after.** Consumers needing real closes can require a `set_closing_line`
audit row, or `closing_line != market_line`. Both are decidable.

### Not done, and it is your call

**The 601 historical ML rows are untouched**, and so are the 192 CLV
values resting on them. Unlike the totals nulling, these are not
provably fabricated — some fraction are flat lines that genuinely did not
move, and there is no way to tell which from the data.

The options, none applied:

- **Leave them.** ML CLV keeps its current coverage; 70% of it rests on an
  assumption that is sometimes correct.
- **Null the 601.** Honest, and drops ML CLV from 273 to ~81 values.
- **Re-derive from `empirical_market_captures`** where a genuine closing
  price exists for those games. Recoverable for the June-onward subset;
  this is the only option that *adds* information rather than trading
  coverage for honesty.

I would not decide this silently. The totals nulling was safe because
those values were provably fabricated; these are not.

## 3. Checklist

`CLAUDE.md` gains **"Review checklist — re-run these, do not trust a past
clean result"**, covering the GET-mutation scan, the settings-schema sync
assertion, and the gate-window health check.

The GET scan is to be re-run on **any PR touching `routes/api.js`**. Its
expected output is now exactly one live hit:

```
handlers with LIVE mutations: 1
  GET /admin/odds-comparison
```

That one is known and accepted. **Anything else is a regression.**

The checklist entry also records the scan's own blind spot: its
`KNOWN_MUTATORS` list is hand-maintained — the same shape that has failed
open three times here — so a clean second pass means *"nothing found"*,
not *"nothing there"*. That is precisely why it is a checklist item to be
re-run rather than a gate to be trusted.

## Related

- `docs/get-mutations-audit-2026-08-23.md` — the audit and the 762 nulled totals rows.
- `docs/totals-closing-capture-2026-08-23.md` — where the fabrication was found.
- `services/jobs.js` `backfillMlClosingLines` · `scripts/audit-get-mutations.js`.
