# Pitcher batted-ball ingest (2026-09-12)

GB%/FB%/LD% per pitcher per handedness split, so the FRV interaction can be
measured. Nothing consumes it yet and no model behaviour changes.

## Through the existing client, not beside it

`fetchActualSplit(splitCode, position, cookieValue, opts)` gained two
optional fields, both defaulting to today's behaviour so every existing
caller is byte-identical:

- **`strType`** — overrides the FG stat panel. `'1'` Standard, `'2'`
  Advanced, `'3'` **Batted Ball** (GB%/FB%/Pull%/Hard%). The panel was
  already documented in a comment at the call site; this makes it
  reachable.
- **`raw`** — returns the parsed row objects instead of CSV. The consumer
  writes typed columns; round-tripping through CSV to re-split it would
  lose types for nothing.

Extended rather than duplicated because the auth, the strict body shape
(the 2026-08-03 rewrite is fussy about `arrWx*` being `null`, `strType`
being a string, `strSplitTeams` being a boolean) and the error handling are
the hard part, and must not exist twice. The test asserts this branch adds
**no new authenticated fetch site** — counted against `origin/main` rather
than compared to a guessed ceiling.

Split codes match `_actTasks`: **5 = vs LHB, 6 = vs RHB**. There is no
"overall" code in use, so the two are fetched and stored **separately**.
Blending them at ingest would need a weighting, and choosing that weighting
is the consumer's business — the interaction measurement should be free to
weight by the batter handedness actually in the lineup.

## Units are decided by an identity, not an assumption

FanGraphs may serve shares as `44.2` or `0.442` and the payload is not
available to check without a Member session. Rather than guess, the parser
uses the fact that **GB + FB + LD = 1 by construction**:

```
sum in [50, 150]  -> percent points, divide by 100
sum in [0.5, 1.5] -> already fractions
anything else     -> REJECT the row
```

Stored as fractions. A row whose three shares sum to neither is a row we do
not understand, and it is skipped rather than coerced.

## Fails loudly, because the payload shape is unverified

Reaching the endpoint needs an authenticated session, so this parser was
written against the documented panel and tested on synthetic rows. **The
live shape is not verified.** It is therefore built to throw — naming the
keys it actually found — rather than write nulls that look like data:

- no GB%/FB%/LD% column → throw, listing `Object.keys(row)`
- no BIP column **and** no GB/FB/LD counts to reconstruct it → throw.
  Sample size is most of the value of a rate; a row without it cannot be
  weighted, so its absence is fatal rather than null.
- 0 usable rows parsed → throw, reporting how many lacked an MLBAM id and
  how many had unusable shares

Several key spellings are accepted per field (`GB%`, `GBpct`, `gb_pct`, …)
because the exact casing is the part most likely to differ. Expect the
first live run to be the real test. That is deliberate — see below.

## Storage

```
pitcher_batted_ball            PK (mlb_id, split)                  current state
pitcher_batted_ball_snapshot   PK (snapshot_date, mlb_id, split)   dated
```

The dated copy exists for the same reason `woba_data_snapshot` does: the
interaction has to be measurable **as-of a game date**. A pitcher's GB% on
2026-05-01 is not his GB% now, and scoring an old game with the current
profile is hindsight. `q.getPitcherBattedBallAsOf` returns the newest
snapshot **at or before** a date.

One property worth naming: a missing snapshot date makes the as-of lookup
**reach further back**, so the measurement still runs, on a staler profile.
That is quieter than an absent row — which is exactly why the gap hook
below matters more here than it would for a current-state table.

## Cadence and blast radius

Runs inside `runFangraphsWobaSyncJob`, after the retry loop: same endpoint,
same Member session, same two-year window. A second schedule would double
the authenticated request load for data that changes at the same rate.

It is **awaited but cannot sink the wOBA sync** — wrapped in its own
try/catch, its result reported as `batted_ball` on the sync's return value
and nowhere in its success determination. wOBA feeds live pricing; this
feeds an unshipped measurement, and the dependency must only run one way.

It writes its own `cron_log` row (`fg-batted-ball`), because the snapshot
chain that wrote no cron rows for weeks is the reason 2026-09-03 went
unnoticed for a week.

## Freshness and the gap hook

`pitcher_batted_ball_snapshot` is declared in `PIPELINES` with the same
treatment `woba_data_snapshot` gets: last-arrival thresholds plus the
mid-era `gaps` hook from #388, using the shared `snapshotGapSql` builder
and the same recent-window policy (7 days, STALE at one gap, CRITICAL at
two).

**The check reports STALE, not CRITICAL, until the first successful sync.**
The module treats a table with no rows at all as CRITICAL — "a dropped
table looks identical to a stopped job downstream" — which is right for an
established capture and wrong for one that ships before its first cron
fires. Shipping it red would exit 1, mark `/health` critical and turn an
existing green test red, for a table nothing has had the chance to write.
That is a checker crying wolf, which is what trains people to stop reading
it.

So `PIPELINES` gained an optional **`awaitingFirstRun`** flag, consulted
**only** on the no-rows path. It self-disarms — once a first row lands the
normal thresholds apply and the flag is inert — and a **query error stays
CRITICAL** regardless, because a dropped table and a job that never ran are
not the same thing. Both halves are asserted in the test.

The STALE row is still the first-run verification for a parser that could
not be tested against the live endpoint: if it has not cleared after one
wOBA sync cycle, the fetch shape is wrong and the `cron_log` row says how.
The wOBA sync is currently healthy (`woba_data_snapshot` last arrival
2026-09-11), so the window should be one cadence.

## Verification

```
node scripts/test-pitcher-batted-ball.js     # 32 checks, exit 0
node scripts/pipeline-freshness.js           # new row STALE until first run, exit 0
```

Covers: the single fetcher and the unchanged default `strType`; no new
fetch site versus `origin/main`; the unit normalisation in both directions
plus two rejection cases; the two splits stored apart; the as-of lookup
returning the August profile in August and the September one in September,
nothing before the first snapshot, and reaching **back** never forward on a
missing date; both live tables and all four prepared statements; the job
being called from the sync, wrapped so it cannot propagate, logging its own
cron row, and adding no schedule; and the pipeline entry's gap hook coming
from the shared builder.

## Not in this PR

- **Nothing reads it.** `runModel` is untouched; there is no interaction
  term yet. That is the next measurement, and it needs at least one
  snapshot to exist first.
- **No backfill.** The snapshot series starts at the first run, so an as-of
  lookup for a game before that returns nothing. Historical batted-ball
  profiles would need a separate dated backfill, and the honest position is
  that the interaction can only be measured forward from the first capture
  unless that is built.
