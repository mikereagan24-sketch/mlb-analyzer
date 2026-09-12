# FRV: split by position, one implementation, null instead of zero (2026-09-12)

Three defects in the fielding-run-value term, all found while answering
"how is this term built today". No new data source, no fetching change, and
the feature gate stays off.

## 1. The ingest was summing the split away

Savant serves FRV **per position**, and `fetchFieldingFrv` already issues
one request per position (3=1B … 9=RF). It then aggregated by `mlb_id`:
summed `total_runs`, summed `outs_total`, and labelled the row with
whichever position had the most outs. `fielding_frv` was keyed
`mlb_id PRIMARY KEY`, so one row per player.

The consumer looked players up **by id alone** — the lineup's position was
used only to decide whether a slot counted, never to choose the row.
Measured over 2026-08-13 → 09-10, 5,376 fielder slots:

```
resolved to a row                              5,004   93.1%
  row's position != tonight's slot             1,332   26.6% of resolved
    of which crossed infield <-> outfield        228
no usable row -> contributed 0                   372    6.9%
name resolution failures                           0
```

So a player in left tonight could be scored with his centre-field number,
and 228 slots in a month applied an infielder's rate to an outfield slot or
the reverse.

**Now:** `fielding_frv` is keyed `(mlb_id, position)`, the ingest keys its
aggregation the same way, and the term looks up `(player, tonight's
position)`. No extra requests — the same seven were already being made.

Every row Savant returns cleared `minInnings=200` **at that position**, so
each per-position row clears `FRV_MIN_OUTS` on its own. Splitting creates
no sub-floor rows and the job's floor prune is unchanged.

## 2. Missing fielders were being called average

A fielder with no usable row was skipped, and the team value was the sum
over whoever resolved. Skipping in a **sum** is not neutral: it asserts the
missing player is worth exactly zero runs, i.e. an exactly league-average
defender. That was 372 slots in 30 days — and they are not resolver bugs.
Name resolution was 100%; every one is a player Savant has no qualifying
row for, overwhelmingly rookies under the 200-inning three-season minimum
(Angel Genao 21 slots, Joshua Baez 20, Brock Rodden 18, Tommy White 17,
Jordan Lawlar 14).

**Now:** the term returns the resolved slots' **mean scaled to the full
fielding complement**. With every slot resolved that is arithmetically
identical to the old sum; it differs only for lineups with missing
fielders, where it assumes the unknowns look like this team's known
fielders rather than like the league. Both are assumptions — this one is at
least stated.

## 3. Three implementations, and the drifted one fed the gate

The term existed in `services/jobs.js`, `services/frv-backtest.js` and
`services/baserunning-backtest.js`. The copies had already diverged:
production applied `FRV_MIN_OUTS` (600); **both harnesses admitted any row
with `outs_total > 0`**, roughly 100x looser. Inert today only because the
table holds no sub-floor rows — and `harness-inputs.js:36` wires
`calibration-ab.js` to a harness copy, so the FRV gate's own recorded
evidence was produced by a term production does not compute.

**Now:** one implementation in `utils/fielding-frv-term.js`, used by all
three, importing the floor rather than restating it. The test asserts the
old inline arithmetic is gone from all three call sites.

Also: the warnings were behind `DEFENSE_FRV_ENABLED`, which is off — so the
372 zero-contribution slots printed nothing, anywhere. A diagnostic that
only speaks once the feature is on cannot help you decide whether to turn
it on. They now print unconditionally, and the term never reads the gate.

## The position fallback

If a player has no row at tonight's position — a genuine first start there,
or a position he is under 200 innings at — his **biggest-sample row** is
used and the substitution is logged by name and position. "Primary
position" is now a measured property (`ORDER BY outs_total DESC`) rather
than a stored label the old schema had to guess.

On the **legacy** table the term currently reports 68.3% exact matches,
24.8% fallbacks, 6.9% unresolved. The fallback share is what should drop
once the per-position ingest has run; measuring that is the first step of
any evaluation.

## Migration

SQLite cannot alter a primary key, so `db/schema.js` does a guarded
rebuild: create, copy, drop, rename, in one transaction, idempotent via a
`PRAGMA table_info` check. Verified on the local copy: **521 rows kept, PK
now `(mlb_id, position)`**.

Existing rows are **kept, not truncated**. They are cross-position sums
carrying the primary label — the old semantics — and the next
`runFieldingFrvJob` replaces each player's row with one per position. Until
then the consumer finds the legacy row under the primary position and
behaves exactly as before, so the migration is not a behaviour change on
its own; the ingest change is. Truncating would leave the term null until
the next fetch, and an empty table is the state the delete-missing guard
exists to prevent.

One pre-existing wart this does not fix: a player who drops off the
leaderboard entirely keeps a stale row, because the upsert never removes
and the floor prune only catches sub-floor rows.

## Registry

`defense_frv_enabled` **closes on its recorded evidence**, with a note
saying the term was redefined on 2026-09-12 and that its numbers do not
carry over — specifically not the −0.00087 delta or the "better on all five
metrics" claim, both of which were produced by the pre-split term through
the looser harness copy.

`defense_frv_split` **opens** against the same bar (`delta_log_loss` CI
excludes zero on the negative side, ≥ 1200 games), `corpus_size 1078`
(graded games 2026-06-16 → 09-10 with both lineups and
`weather_inputs_valid=1` — what a calibration run actually scores; 1976
season-wide, so the bar is reachable without waiting), `window_end
2026-10-31`, `decision: null`.

**No gate flipped and no measurement claimed.** The split does not take
effect until the ingest re-runs.

## Verification

```
node scripts/test-frv-term.js      # 25 checks, exit 0
```

Covers: all three call sites delegating and none retaining the arithmetic;
the floor imported not restated; a synthetic two-position player scored
+0.25 at CF and −0.25 at LF from the same id; fallback selection and its
log line; below-floor and no-row both contributing nothing; the scaled-mean
behaviour differing from the bare sum on a 3-slot lineup and agreeing with
it when all slots resolve; the term not referencing the gate in code; and
the live table's key, floor and NOT NULL position after migration.

Both harnesses smoke-tested on 2026-07-01..03 (34 games each) after the
delegation.
