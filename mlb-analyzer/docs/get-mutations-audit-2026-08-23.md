# Nulling the fabricated closing lines, and auditing GETs that write (2026-08-23)

> **762 fabricated totals closing lines nulled**, each preserved in the
> audit trail as fabricated rather than lost.
>
> **67 GET/HEAD handlers audited. Two mutate.** One was the fabrication.
> The other is a different class and is defensible.

## 1. The 762, nulled

### Why null rather than keep and filter

A fabricated value indistinguishable from a real one is **worse than an
absent value**, because every future analysis has to remember to exclude
it.

This codebase has a poor record with remembered filters. Three separate
hand-maintained key lists have already failed open:

- `getSettings()`'s whitelist — an unmapped setting is invisible to the model
- `calibration-ab`'s `CALLER_POPULATED_INPUTS` — keyed by exact name, so a
  sibling parameter skipped the guard entirely
- `parameter-sweep`'s `applySweepOverrides` — an unrecognised key silently ignored

**NULL is self-enforcing.** Every consumer already handles a missing
closing line, and none of them can mistake NULL for an observation.

### It is not data loss

Each nulled value is written to `bet_signal_audit` with
`action='null_fabricated_closing'`, the old value in `closing_line`, and a
detail string saying what it was:

```
closing_line=6.5 was a copy of market_line written by GET /backtest,
not an observed close. Nulled 2026-08-23; value preserved here.
```

**The live column stops asserting something false; the history keeps the
fact that it did.** 762 rows nulled, 762 audit rows written.

### Safety, and what was deliberately not touched

Only rows matching the fabrication signature were eligible:

```
signal_type = 'Total'
AND closing_price IS NULL        -- not written by the real capture
AND closing_line = market_line   -- the copy signature
```

All 762 matched cleanly; **0 rows were ambiguous** and none were skipped
for being unclassifiable. A row the new capture has written carries
`closing_price` and would be skipped automatically.

Verification:

```
totals with closing_line but no closing_price (must be 0) : 0
totals with non-null clv (must be 0 until real captures)  : 0
ML rows still carrying a closing_line                     : 993  (was 993)
ML rows with clv                                          : 273  (was 273)
audit rows recording the nulled values                    : 762
```

**ML is byte-identical.** The date span nulled is 2026-04-09 .. 2026-08-06.

### What this changes for analysis

Totals CLV is now **honestly empty** rather than dishonestly zero. Any
totals CLV figure from here is a real measurement or absent — there is no
third state to remember.

## 2. GET endpoints that write — 67 audited, 2 found

`scripts/audit-get-mutations.js`, kept as a re-runnable check rather than
a one-off.

### `GET /backtest` — the fabrication (already fixed)

```
LIVE  api.js:1454   db.prepare(`UPDATE bet_signals SET ...
```

This is the one that assigned `closing_line = market_line`. Now scoped to
`signal_type='ML'`, so it can no longer manufacture totals data. **The
underlying design issue stands**: a GET still writes on every request, and
the two now-commented `clv=NULL` statements above it are evidence of how
long the behaviour went unexamined.

### `GET /admin/odds-comparison` — a different class, and defensible

```
LIVE  api.js:3994   "INSERT OR REPLACE INTO venue_comparison_snapshot "
```

**This is not the same defect**, and the distinction matters:

| | `/backtest` | `/admin/odds-comparison` |
|---|---|---|
| what it wrote | a **copy of another column** | genuinely **live-fetched** Poly/Kalshi prices |
| where | `bet_signals`, the primary analysis table | a dedicated snapshot table |
| guards | none | skips locked rows; refuses partial rows carrying no venue pricing |
| documented | comment asserted the inverse of reality | documented against the 07-10 incident as a last-good fallback |

It persists an **observation**, not a derivation, and it is admin-gated.
Recorded as a known read-that-writes; **no change recommended.**

The lesson is not "no GET may ever write" — it is that a GET writing a
*derived* value into an analysis table is invisible fabrication, while a
GET caching a *fetched* value into a snapshot table is a design choice
with a stated reason.

### Second pass: delegated writes

Textual scanning misses a handler that calls a helper which writes, so a
second pass checks every GET body for calls to 16 known-mutating
functions (`runOddsJob`, `processOddsArray`, `refreshSignalBaselines`,
`writeClosing`, …).

**Result: none.**

### The blind spot, stated rather than papered over

`KNOWN_MUTATORS` is a hand-maintained list — the same shape of thing that
has failed open three times in this repo. A clean second pass means
**"nothing found", not "nothing there"**: a helper not on the list, or a
write two hops away, would not appear.

The first pass has the opposite bias by design: a mutating keyword inside
a comment counts as a hit. For an audit that is the safe direction — a
false positive costs a glance, a false negative costs another six months.

## 3. Not done

- **`GET /backtest` still mutates on read.** Scoped to ML so it cannot
  fabricate totals data, but a read endpoint that writes remains a
  standing design issue. Moving the backfill to the cron chain is the
  real fix and is a separate change.
- **No backfill of real closing values.** There is no source for a value
  never observed. Totals CLV starts accumulating from the next live lock.

## Related

- `docs/totals-closing-capture-2026-08-23.md` — where the fabrication was found.
- `scripts/null-fabricated-totals-closing.js` — the null, with its audit trail.
- `scripts/audit-get-mutations.js` — re-runnable; add to a review checklist rather than trusting one clean run.
