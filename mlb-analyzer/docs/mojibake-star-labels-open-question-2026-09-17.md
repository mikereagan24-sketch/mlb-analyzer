# Open question: 8 bet_signals rows have unreadable signal_label values

Filed 2026-09-17, alongside the highlight-gate consolidation (which found
them but deliberately did not change their behaviour).

## What is in the data

`SELECT signal_label, COUNT(*) FROM bet_signals GROUP BY signal_label`:

| signal_label | n |
|---|---|
| NULL (continuous-edge era) | 2269 |
| `1★` | 314 |
| `2★` | 104 |
| `3★` | 37 |
| `1â` | 3 |
| `unrated` | 2 |
| `3â` | 2 |
| `2â` | 1 |

Six rows carry a mojibake label and two carry the string `unrated`.

The mojibake is the classic UTF-8-read-as-Latin-1 signature: `★` is
`E2 98 85`, and `â` is `E2` decoded as a single Latin-1 character with
the following two bytes lost. So `2â` was `2★` when it was written. These
are almost certainly star-era rows that passed through an encoding
boundary — the likely suspects are a CSV/bookmarklet import path or an
early backfill script, not the live write path, which produces clean
labels for the other 455 star rows.

## Why it matters, and how much

The display gate treats any non-null label as a legacy star row and
highlights only exact `2★` / `3★`:

```js
return n.label === '2★' || n.label === '3★';
```

So `2â` and `3â` (3 rows) render as legacy rows that never highlight,
and `1â` (3 rows) is correct by accident. `unrated` (2 rows) likewise
never highlights. Total affected: 3 rows that would highlight if their
labels were intact, out of 2,732.

The consolidated gate preserves this exactly — it was the behaviour
before, and a consolidation PR is the wrong place to change what rows
display. `scripts/test-highlight-gate.js` pins it:

```
PASS  a mojibake label falls through to NOT highlighted, as before
```

## The open question

Three things could be done, in increasing order of ambition:

1. **Repair the 6 labels.** A migration mapping `Nâ` → `N★` for exactly
   these rows. Idempotent by construction (the filter cannot re-match a
   repaired row). Safe, small, and makes 3 rows display as they were
   meant to. The `unrated` 2 are a separate decision: `unrated` may have
   been a deliberate value, and turning it into NULL would move those
   rows from the star era into the continuous-edge era, where the
   thresholds would then apply to them.

2. **Constrain the column.** The set of valid labels is closed
   (`1★`, `2★`, `3★`, NULL). A CHECK constraint or a write-path
   validation would have made this impossible. Worth it only if any
   write path still produces labels — post-cutover rows are all NULL, so
   this may be guarding a door nobody uses any more.

3. **Find the import path.** The interesting question is not the 6 rows,
   it is whether the path that mangled them still exists and touches
   anything else. If a bookmarklet or backfill script writes
   double-decoded text, other columns (team names, pitcher names) could
   carry the same damage in places where it is not as visible as a star.
   A scan for `â` across text columns in the DB would answer it.

Not urgent: 3 mis-displayed rows in the star era, which ended before the
continuous-edge cutover and is not being bet. Worth doing (3) before (1),
because repairing the symptom removes the evidence.

## Where the behaviour is defined

- `utils/highlight-gate.js` — `highlightsForDisplay`, the label branch
- `scripts/test-highlight-gate.js` — the pinning assertion
- `services/migrations.js` — where a repair migration would go, following
  the `v5-normalize-001` pattern (filter that cannot re-match +
  `migrations_applied` gate)
