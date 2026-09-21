# Open question: 8 bet_signals rows have unreadable signal_label values

> **RESOLVED 2026-09-21.** Item (3) was done first, as this ticket asked, and
> it changed the answer: the damage is **wider than the 6 labels counted
> below** and the path that caused it is **dead**.
>
> `scripts/probe-mojibake-scan.js` sweeps every TEXT column in the DB (319
> columns, 49 tables) and found **30 distinct damaged values over 57 rows in
> four columns** — not 6 rows in one:
>
> | column | distinct | rows | recoverable |
> |---|---|---|---|
> | `bet_signal_audit.detail` | 6 | 29 | yes — em dash |
> | `bet_signals.notes` | 20 | 20 | yes — em dash |
> | `bet_signals.signal_label` | 3 | 6 | yes — star |
> | `pitcher_woba_override.reason` | 1 | 2 | **no** — U+FFFD, bytes gone |
>
> **All of it is 2026-04.** Zero damaged rows in 2026-05..09 against ~51,000
> clean ones, so the writer is dead and no constraint (item 2) is needed to
> stop an ongoing source. The `notes`/`detail` damage is a *double*
> double-decode of U+2014 in the deactivation message, not the star path.
>
> Item (1) then shipped as migration `v6-mojibake-repair-001`, widened to all
> three recoverable columns. Two deliberate non-repairs:
>
> - **`pitcher_woba_override.reason`** — U+FFFD means the bytes were lost
>   before the write. No deterministic inverse exists; left as-is.
> - **the 2 `unrated` rows** — left as-is, for the reason stated below:
>   NULLing them would move them out of the star era into the continuous-edge
>   era, where the emit thresholds would then apply. Both are April, inactive,
>   and carry a logged `bet_line`.
>
> **Post-lock carve-out:** 5 of the 6 label rows carry `bet_locked_at`, and
> `signal_label` is not on the whitelist of fields that may flow post-lock.
> The repair restores the value originally written rather than changing one,
> touches no baseline field, and writes a `bet_signal_audit` row per repaired
> signal. Owner-authorised.
>
> Verified by `node scripts/test-mojibake-repair.js`, which runs the real
> migration SQL against seeded real byte sequences and asserts idempotency.
> `scripts/test-highlight-gate.js` keeps its mojibake assertion as a
> defensive property: an unrecognised label must still fall through to
> not-highlighted.


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
