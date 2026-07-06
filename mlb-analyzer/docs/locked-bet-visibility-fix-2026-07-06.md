# Locked-bet visibility fix — 2026-07-06

Diagnosis and fix for the HOU ML +128 (`hou-was`, 2026-07-06) not
appearing on the backtest page after the owner locked it.

## Part 1 — HOU ML signal state (from prod `/api/backtest?cohort=all`)

```
game_id:        hou-was
signal_type:    ML
signal_side:    away             (HOU = away in "hou-was")
market_line:    128
bet_line:       128              ← locked
bet_locked_at:  2026-07-06 19:25:00
is_active:      1                ← not deactivated
outcome:        pending
edge_pct:       0.0445           (4.45pp)
cohort:         v3               ← WRONG (root cause of invisibility)
```

**Cohort = `v3`, not `v6` or `v7`.**

This isn't a cutover-day judgment call. It's a persistent bug:
`routes/api.js:4754` (the manual-bet endpoint `POST /signals/manual`)
hardcoded `cohort='v3'` in the INSERT statement. **Every manually-
logged bet since the v3 era got tagged v3 regardless of the current
epoch.**

The owner never noticed because:
- Prior to my recent v6→v7 cutover PR, the backtest default was `v6`.
  v3 rows were invisible under default filter but the owner may not
  have relied on the backtest view for manual-log tracking.
- After PR #157 (cohort v7 cutover), the default is `v7`. v3 rows are
  still invisible. But the owner locked HOU today and needed it
  visible.

The 4.45pp edge on a locked signal is unrelated to the visibility bug.
It reflects the model's own preference at signal-emission time —
model_away_ml=+107 vs bet_line=+128 gives `iP(107) − iP(128) = 0.044`.

## Part 2 — What a rerun does to previously-emitted signals

Read from `services/jobs.js` around `processGameSignals`:

- **Unlocked signals** (`bet_line IS NULL`): DELETED entirely
  (`services/jobs.js:834`). Re-emitted fresh if they still qualify.
- **Locked signals** (`bet_line IS NOT NULL`): PRESERVED. Two sub-cases:
  - **Still qualifies**: bet_line/bet_locked_at/closing_line/clv
    re-stamped (`services/jobs.js:1024-1027`); is_active stays 1.
  - **No longer qualifies** (edge dropped below emit floor OR model
    output suppressed): `is_active` set to 0 with a
    `notes='Model ML at rerun: … — edge no longer meets threshold.'`.
    Row preserved; bet_line/bet_locked_at intact
    (`services/jobs.js:983-1021`).
- **Dedupe delete** (`services/jobs.js:974-976`): keeps `MAX(id)` per
  `(type, side)`, deletes older duplicates. **Not previously lock-immune** —
  see Part 3 (b).

**Preservation for grading**: because bet_line/bet_locked_at survive
even when is_active=0, `model.calcPnl()` at grading time can still
compute PnL from stored fields. Grading works.

## Part 3 — Invariant check: locked bets survive reruns, always visible

Owner's invariant: **"a signal with `bet_locked_at` set must never be
deactivated/deleted/excluded from backtest grading."**

Four places checked, three violations found and fixed:

**(a) Unlocked-only DELETE at line 834** — SAFE.
```sql
DELETE FROM bet_signals WHERE bet_line IS NULL OR bet_line = 0
```
Gated on `bet_line IS NULL`. Locked rows can't be deleted here.

**(b) Dedupe DELETE at line 974** — WAS UNSAFE, NOW FIXED.
```sql
DELETE FROM bet_signals WHERE id NOT IN (
  SELECT MAX(id) FROM bet_signals … GROUP BY signal_type, signal_side
)
```
If a locked row had a smaller id than an unlocked duplicate for the
same `(type, side)`, it got deleted purely on id ordering. Fixed by
adding `AND bet_line IS NULL` to the WHERE clause — locked rows are
now excluded from dedupe deletion. Duplicate handling remains for
unlocked rows.

**(c) `is_active=0` on locked-no-longer-qualifies at line 1000** — the
current row is preserved and bet_line/bet_locked_at stay intact, so
grading still works. But the backtest endpoint's WHERE filter at
`routes/api.js:1147` was:
```
AND (bs.is_active = 1 OR bs.outcome != 'pending')
```
For a locked-and-deactivated-and-pending signal, both clauses are false
→ row hidden from backtest until game grades. This IS an invariant
violation — the owner has money on it but can't see it.

**Fixed** by extending the filter:
```
AND (bs.is_active = 1 OR bs.outcome != 'pending' OR bs.bet_line IS NOT NULL)
```
Any locked signal is now always visible in backtest, regardless of
is_active or outcome.

**(d) Manual-bet endpoint hardcoded `cohort='v3'`** — the visibility
bug that surfaced today. Fixed by using `cohortForGameDate(game_date)`
shared helper from `services/jobs.js`.

## Part 4 — Making this specific HOU row visible

Two-step:

1. **Code fix**: manual-bet endpoint now uses `cohortForGameDate()`, so
   any NEW manual bets get the right tag. No help for the existing HOU
   row.
2. **One-shot backfill migration** (`db/schema.js` at line 1421):
   retag existing rows that were mistagged by the old hardcoded 'v3'.
   Scoped conservatively:
   ```sql
   UPDATE bet_signals SET cohort = CASE
     WHEN game_date >= '2026-07-06' THEN 'v7'
     WHEN game_date >= '2026-05-30' THEN 'v6'
     WHEN game_date >= '2026-05-20' THEN 'v5'
     WHEN game_date >= '2026-05-12' THEN 'v4'
     ELSE 'v3' END
   WHERE cohort = 'v3'
     AND bet_locked_at IS NOT NULL
     AND game_date >= '2026-05-12'
   ```
   Restrictions:
   - `bet_locked_at IS NOT NULL`: only manual-log rows (auto-emitted
     signals used the ladder correctly since they never went through
     `POST /signals/manual`).
   - `game_date >= '2026-05-12'`: preserves genuine v3-era rows
     (2026-04-24 to 2026-05-11). Anything older is left alone (the
     `SET cohort='v3-pretuning' WHERE game_date < '2026-04-24'`
     migration already handled that boundary).

**Cohort tag for the HOU signal after this migration: `v7`.**

Judgment call rationale (documented per the task's ask):

- The HOU manual-log occurred on 2026-07-06 (game_date = today) via a
  manual UI action after the v7 cutover.
- The ladder assigns cohort by game_date. game_date >= 2026-07-06 → v7.
- Consistency with the ladder is preferred over provenance-based tagging.
  The auto-emitted signals in this same game already got their cohort
  from the ladder; the manual bet should follow the same rule.
- Alternative would have been "keep v3 as historical marker" — rejected
  because the v3 tag was a bug, not a semantically-meaningful history
  marker.

## Also caught: dedupe lock-immunity

Beyond the HOU-specific visibility issue, this PR patches the dedupe
DELETE (Part 3 (b) above) — a distinct invariant violation the owner
would have hit eventually. Small guard added; behavior unchanged for
the common case (no duplicates).

## Verification (static, since I don't have prod DB write access)

1. **Cohort helper synthetic test** — reused from PR #157:

   ```
   2026-04-01 → v3-pretuning
   2026-04-24 → v3
   2026-05-12 → v4
   2026-05-20 → v5
   2026-05-30 → v6
   2026-07-05 → v6   (RUN_MULT=50 window stayed v6, no leak)
   2026-07-06 → v7   (HOU game_date lands here)
   2026-07-10 → v7
   ```
   9/9 pass.

2. **Manual-bet endpoint** now calls `cohortForGameDate(game_date)`.
   For `game_date='2026-07-06'` → 'v7'. Confirmed by diffing
   `routes/api.js:4755`.

3. **Backtest filter** now includes locked rows regardless of
   is_active/outcome. Confirmed by diffing `routes/api.js:1147`.

4. **Dedupe DELETE** now guarded by `AND bet_line IS NULL`. Confirmed
   by diffing `services/jobs.js:975`.

5. **Backfill migration** scoped to `cohort='v3' AND bet_locked_at IS
   NOT NULL AND game_date >= '2026-05-12'`. Won't touch:
   - Real v3 auto-signals (`bet_locked_at IS NULL`).
   - Genuine v3-era manual bets (game_date < '2026-05-12').
   - v4/v5/v6/v7 tagged rows.

## Post-merge check

Once this deploys, the owner should:

1. Refresh backtest page — HOU row should now appear (default filter v7).
2. Confirm cohort='v7' on the HOU row via
   `curl /api/backtest?from=2026-07-06&to=2026-07-06&cohort=v7`.
3. Any other historically-locked manual bets they logged should also
   surface in v4/v5/v6/v7 filters as appropriate to their game_date.

## Files

- `services/jobs.js`: hoisted `cohortForGameDate()` helper + export;
  replaced inline ladder in `processGameSignals`; lock-immune dedupe
  guard.
- `routes/api.js`: imported helper; used in `POST /signals/manual`;
  extended backtest filter to include locked-bet rows.
- `db/schema.js`: one-shot backfill migration for mistagged v3 manual
  bets.
- `docs/locked-bet-visibility-fix-2026-07-06.md`: this file.
