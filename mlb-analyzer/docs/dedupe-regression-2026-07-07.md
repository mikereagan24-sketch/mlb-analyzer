# Signal duplication regression + fix — 2026-07-07

## Owner report

Backtest and slate showing signals duplicated 5-7× for 2026-07-06
games (NYM-ATL, ARI-SD, TOR-SF, COL-LAD). All duplicates have
identical lines and are all pending. Started after yesterday's
locked-bet-visibility PR deployed. HOU lock exists but was buried by
the duplicate flood — visibility problem was reachability, not the
lock itself.

## Diagnosis: today-only regression, not pre-existing

Duplicate scan against prod `/api/backtest?cohort=all` per date:

```
Date        n_signals  n_unique  n_dupe_rows  worst_dup_count
2026-07-07     9          9         0            1
2026-07-06    42         13        29            7   ← ONLY affected date
2026-07-05    20         20         0            1
2026-07-04    21         21         0            1
2026-07-03    10         10         0            1
2026-07-02     7          7         0            1
2026-06-30    18         18         0            1
2026-06-25     9          9         0            1
2026-06-15    10         10         0            1
2026-05-30    12         12         0            1
```

Every historical multi-rerun day: zero duplicates. Only 07-06.
Confirmed regression from yesterday's PR.

## Root cause

`docs/locked-bet-visibility-fix-2026-07-06.md` (yesterday) added
`AND bet_line IS NULL` to the dedupe DELETE in
`services/jobs.js:974`. Intent was "locked rows survive dedupe."
Effect was worse.

**Per-rerun sequence under the broken code:**

1. Capture `lockedLines` in memory (line 832).
2. DELETE unlocked (line 834). Locked rows survive.
3. INSERT new signals (line 855+). New row is unlocked.
4. DEDUPE with `AND bet_line IS NULL`:
   - Old locked row: `bet_line NOT NULL` → SKIPPED, survives.
   - New unlocked row: `id IN MAX(id)` → survives.
   - **Both rows now coexist.**
5. Restore-locks (line 977+) UPDATE all matching rows on
   `(game_date, game_id, type, side)`. Both rows get stamped with
   `bet_line/bet_locked_at` from `lockedLines`.
6. **End state: two locked rows with identical data.**

Each subsequent rerun adds one more row. 7 reruns → 7 rows.
Matches the 07-06 data exactly (created_at spread across 19:17 to
20:03; bet_locked_at identical to first lock event).

Old code (before yesterday's PR) had DEDUPE delete the old locked
row at step 4 (correct behavior — the invariant is that the newest
row wins, the restore-locks loop re-stamps it). Yesterday's guard
inverted that.

The restore-locks path was ALREADY the mechanism for preserving
lock stamps. My "extra safety" guard broke the invariant that ended
each rerun with one row per (type, side).

## HOU-was — visibility diagnosis (updated by owner)

The HOU-WAS lock DID land correctly (`away +128`, `bet_line=128`,
`bet_locked_at=2026-07-06 19:25:00`). Owner found it further down
the list; the visibility problem was **the duplicate flood burying
it**, not a missing lock. Item resolved by the dedupe cleanup —
after cleanup the HOU-WAS row moves back to its natural position.

Two-row grouping observed for hou-was ML/away:

```
id=86284  cohort=v5  is_active=0  bet_line=128  bet_locked=07-06 19:25:00  outcome=pending
id=86406  cohort=v7  is_active=1  bet_line=128  bet_locked=07-06 20:04:53  outcome=pending
```

The v5 row (86284) is the original manual log. It got `cohort=v3`
from the pre-fix manual-log endpoint, then the OLD v3→v4 (game_date >=
2026-05-12) migration cascaded it to v4, then v4→v5. There's no
existing v5→v6 or v5→v7 migration, so it stuck at v5. The
locked-bet-visibility PR's backfill migration only targeted
`WHERE cohort='v3'` and missed this v5-stuck row.

The v7 row (86406) came from a subsequent rerun's processGameSignals
using the shared `cohortForGameDate` helper (which correctly returns
v7 for 07-06 game_dates).

**After the cleanup migration in this PR**: the survivor is the
EARLIEST-locked row (86284, cohort=v5, bet_locked_at=19:25:00). It
will be visible in the backtest under `?cohort=v5`. Under the default
v7 filter, hou-was ML/away will NOT appear — the owner will need to
switch cohort or expand the migration to catch v5-stuck manual bets.

**Trade-off note**: keeping the earliest-locked row preserves the
original lock event (correct provenance) but tags it with the wrong
cohort (v5 instead of v7). Alternative would have been to keep the
NEWEST locked row (86406, v7) which would default-visible but loses
provenance. Chose provenance-correct over default-visible because:

- The v5 tag is a separate bug (v5-stuck manual bets) with its own
  documented fix path.
- The lock event's semantic truth is 19:25:00, not 20:04:53.
- Owner already found the row via the "further down the list" method,
  so default visibility isn't the highest-priority need for this
  specific row.

Follow-up (not this PR): extend the cohort-backfill migration to
catch `WHERE cohort='v5' AND bet_locked_at IS NOT NULL AND
game_date >= '2026-05-30'` — retag those to v6/v7 by the
`cohortForGameDate` ladder.

## Fix

**Code revert** in `services/jobs.js:987-1004`: removed
`AND bet_line IS NULL` from the dedupe DELETE. Behavior restored to
pre-2026-07-06. Comment explains the regression so future editors
don't re-introduce the guard.

**Cleanup migration** in `db/schema.js` (added after the cohort
backfills, before runline capture): finds all `(game_date, game_id,
signal_type, signal_side)` groups with COUNT > 1, keeps ONE
survivor per group using the rule:

1. Locked-first (`bet_locked_at IS NOT NULL` beats NULL).
2. Then earliest `bet_locked_at ASC` (preserves the original lock
   event, not later reruns' echo-stamps).
3. Then smallest `id` ASC as a tiebreaker.

Every deleted row gets a `bet_signal_audit` entry with
`action='dedupe_cleanup'`, `source='schema_boot_migration_2026-07-07'`,
`detail='kept_id=X, duplicate_group_size=N'` for reviewability.

**Idempotent**: subsequent boots find zero groups with COUNT > 1
and skip the entire block.

## Verification — 18/18 pass

`scripts/test-dedupe-idempotency.js` runs against an in-memory
SQLite DB with a schema mirroring `bet_signals` + `bet_signal_audit`.
Reproduces the 07-06 duplication pattern, applies the migration,
then simulates 4 successive reruns (mirroring
`processGameSignals`).

**Test 1** — cleanup migration collapses duplicates:
- Deletes 6 rows on first run.
- Survivor is the original-locked row (MIN(id) with earliest
  `bet_locked_at`).
- 6 audit rows written.

**Test 2** — cleanup is idempotent:
- Second run deletes 0 rows.
- No additional audit rows.

**Test 3** — reverted dedupe DELETE preserves the invariant:
- After each of 4 reruns on a game with an existing locked row:
  exactly 1 row for the game, still locked, `bet_line` preserved.

**Test 4** — deactivate branch (locked signal no longer qualifies):
- First "no signals produced" rerun: locked row preserved,
  `is_active=0` (visible in backtest due to yesterday's filter fix).
- Second rerun: still 1 row (no accumulation on the deactivate
  path either).

## Live-odds leak into venue flags (separate item, deferred)

Owner flagged live in-game odds (PHI-KC -426/+9601 mid-game)
leaking into venue-flag/odds displays. Distinct code path from
the signal-lifecycle bug; wants a separate small PR that suppresses
venue-flag refresh once a game starts. **Not addressed in this PR
per the owner's constraint (keep the dedupe fix bounded).**

## Post-deploy checklist

1. Merge → deploy → boot migration runs.
2. Check server logs for `[dedupe-cleanup] found N duplicate
   (game,type,side) groups` and `[dedupe-cleanup] deleted M
   duplicate rows`. N and M should be non-zero on first boot,
   zero on subsequent boots.
3. `curl /api/backtest?from=2026-07-06&to=2026-07-06&cohort=all` —
   confirm 13 distinct signals (was 42), no duplicates.
4. Trigger a rerun on 2026-07-07: `POST /api/games/2026-07-07/rerun`
   — signal count unchanged.
5. Second rerun on same date: signal count still unchanged
   (idempotency).
6. HOU-was ML/away visible under `?cohort=v5` (until follow-up
   v5-stuck manual-bet retag migration lands).

## Files

- `services/jobs.js` — revert `AND bet_line IS NULL` on dedupe DELETE.
- `db/schema.js` — dedupe cleanup migration with audit trail.
- `scripts/test-dedupe-idempotency.js` — 18-case in-memory
  reproduction test.
- `docs/dedupe-regression-2026-07-07.md` — this file.
