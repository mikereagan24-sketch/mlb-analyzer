# The bullpen report stops being a second implementation (2026-08-30)

> **Membership diff: 1 dropped, 1 added across 30 teams. Zero teams with a
> large (≥3 row) change.** The `in_pool` flag was never pool membership — it
> was *candidacy* — and correcting it moves almost nothing.
>
> **Team wOBA diff: mean |Δ| 0.0020, max 0.0100 (COL).** The displayed number
> now equals the model's, to the digit.
>
> **No pricing change.** The model's inputs are untouched; only what the
> report renders changes.
>
> **One thing found and deliberately not fixed:** the pool admits pitchers who
> are not on the roster, by surname. One was priced. Registered as
> `bullpen_pool_lastname_fallback`.

## 1. What the report was mirroring

The old `buildTeamReport` re-derived the pool and the blend from scratch. Its
own comments admitted it — *"mirrors q.getBullpenWoba"*, *"mirrors
q.getBullpenWobaBlended's primary branch"*. Six behaviours were duplicated.
**Four had already drifted:**

| Behaviour | In the model | In the report |
|---|---|---|
| Fatigue / DH-leg exclusions | yes | yes (fixed here **twice**) |
| Per-hand strong/weak weighting | yes | yes |
| No-lineup fallback branch | yes | **missing** |
| Downweight-starters weighting | yes | **missing** |
| Pool-selection rule (`qualified>=3` else `slice(0,8)`) | yes | **missing** |
| Park neutralization | yes (2026-08-31) | **missing** |

Every one is the same failure: a change to the model reaches the report only
if someone remembers. The doubleheader leg needed fixing in it twice, and the
COL `0.327 → 0.333` reading that started this was the fourth row of the table
showing up in the UI.

## 2. What replaced it

`q.getBullpenWoba` now returns the **pre-blend components** it was already
computing and discarding — `proj_woba`, `act_woba`, `act_sample`, `used_act`,
`act_woba_raw`, `act_woba_neutralized` — plus a `members` list carrying
`in_pool`. `getBullpenWobaBlended` merges those per hand.

That is what let the mirror be deleted rather than kept in sync: the only
reason a parallel implementation existed is that the shared function kept its
intermediate values to itself.

**34 lines of dead machinery were removed** (`KEYS`, `fullIdx`, `idx`,
`stripSfx`, `lookup`, `blend`, `mean`) once nothing called them.

### Requirement (1): can per-pitcher rows come from the shared function?

**Yes, for everything that is part of the calculation.** Projections,
actuals, samples, the blend, and the neutralized values all come from
`getBullpenWobaBlended` now.

**Two fields cannot, and should not:** `role` and `hand`. They are attributes
of the *player*, read from `team_rosters`, not products of the pool
calculation. Joining them in the route is not a second implementation of
anything — there is no logic to drift. They are the only fields the report
still sources itself.

## 3. Diff 1 — membership (the one to look at closely)

The old `in_pool` was `role === 'RP' && !isSP && !fatigued`. That is
**candidacy**: everything passing those three tests rendered as in-pool
whether or not the model actually averaged it. It never knew the
pool-selection rule existed.

```
team   old   new   delta   change
CWS      7     8      +1   ADDED: shane smith
SF      11    10      -1   dropped: seth lonsway
(28 other teams)          no change

totals: 1 dropped, 1 added across 30 teams
teams with a LARGE change (>=3 rows): 0
```

**A dropped row does not disappear from the table.** It is still listed, with
`in_pool=false` — the honest state it always had.

## 4. Diff 2 — displayed team wOBA

```
team    report(old)   model(new)    delta
COL        0.3281       0.3181   -0.0100
SEA        0.3060       0.3132   +0.0072
ATH        0.3264       0.3197   -0.0067
TEX        0.2973       0.3023   +0.0050
CHC        0.2985       0.3014   +0.0029
...
TOR        0.2891       0.2891   +0.0000

mean |delta| 0.0020   max 0.0100
```

The largest movers are the extreme parks, which is the neutralization the
report never had. **This is the report catching up to the model, not the
model changing.**

## 5. The table still shows everyone

Excluded arms are rendered as rows with `in_pool=false` and their reasons
attached, not omitted. BOS on 2026-08-30:

```
name                in_pool on_roster fatigued  reasons
Alec Gamboa         true    true      false
Aroldis Chapman     true    true      false
Brayan Bello        true    true      false
Erik Miller         true    true      false
Garrett Whitlock    true    true      false
Greg Weissert       true    true      false
Jovani Morán        true    true      false
Raymond Burgos      true    true      false
Jake Bennett        false   true      true      pitch-count
Jakson Gamboa       false   FALSE     false
Jose Bello          false   FALSE     false
Tyron Guerrero      false   true      true      2-consecutive
```

Twelve rows, eight pooled: two excluded for fatigue with reasons, two dropped
by the pool-selection rule, all four still visible.

## 6. What this surfaced: pool candidates who are not on the roster

`db/schema.js` `q.getBullpenWoba` filters projection rows against the roster
with a **surname fallback**: a candidate is admitted if any rostered RP's name
ends in a space plus the candidate's last name. It never checks the first name.

**Measured 2026-08-30: 22 non-roster pitchers admitted as candidates across 14
teams. One reached a priced pool.**

`CWS / Shane Smith` — admitted because `Hagen Smith` is a CWS reliever. He has
no roster row, and he carries **338/278 BF of actuals**, so he clears
`BULLPEN_MIN_BF=50` and takes the actuals-heavy 0.25/0.75 blend. He is moving
a priced number. CIN alone carries three separate phantom "Garcia" rows.

The other 21 were dropped by the pool-selection rule because their projections
were poor. That is luck, not a safeguard.

**Not fixed here, for two reasons.** It changes the *model's* number, and
folding a pricing change into a no-pricing-change PR is what makes a diff
unreviewable. And there is a confounder to resolve first: **Shane Smith is a
real CWS pitcher**, so the roster table may simply be stale rather than the
match being wrong. Tightening the surname match while the roster is stale
would drop a legitimate arm. Roster freshness for those 22 has to be checked
before the filter is touched.

Registered as `bullpen_pool_lastname_fallback` (`registered_unfixed`). In the
meantime the report renders a **"not on roster"** badge on those rows, so the
condition is visible while it sits open.

## 7. Two wiring defects caught while building this

Both would have shipped silently:

- **The weight slots were crossed.** `getBullpenWobaBlended(…, wProj, wAct, …,
  bullpenWProj, bullpenWAct, …)` takes the *global* weights in one pair and
  the *bullpen* weights in the other. In this handler `W_PROJ` is already the
  bullpen-scoped value, so passing it into the global slot double-applied it.
  Now `W_PROJ_GLOBAL`/`W_ACT_GLOBAL` go to the global pair.
- **`DOWNWEIGHT_STARTERS` had the wrong default.** `services/jobs.js:607` uses
  a strict opt-in (`=== true || === 'true'`); the first version here used
  `!== false`, an opt-out. Identical while the setting is present, opposite
  the moment it goes missing — i.e. a re-divergence of exactly the kind this
  PR deletes. It now mirrors `jobs.js` character for character.

The diff script had the same class of problem: it hardcoded `minBF=100` and
globals `0.65/0.35`, when production runs `50` and `0.45/0.55`. It reads the
real settings now and prints them, because a diff script that measures a
configuration nobody runs is not measuring the change.

## 8. A test that had to be rewritten, not satisfied

`scripts/test-bullpen-availability.js` asserted:

```js
apiSrc.includes('getFatiguedPitchers(teamU, date, gameNumber)')
```

Correct while the report was a mirror; **wrong afterwards** — the report no
longer calls `getFatiguedPitchers` at all, because the shared function does.
Satisfying that assertion would have meant re-creating the mirror it was
written to protect.

It is now a **behavioural** check on a seeded doubleheader: same team, same
date, two legs, and the nightcap must lose the arms that worked leg 1
(`leg1 pool=3, leg2 pool=1`, both leg-1 relievers in the exclusion list, and
the wOBA differs). A source assertion can only prove an argument is spelled
correctly; this proves it is honoured.

**A test written to protect a mirror will demand the mirror.**

## 9. Verification

- `scripts/test-bullpen-report-single-source.js` — **new**, 611 assertions.
  Asserts the *sourcing*, not the numbers: the report calls the shared
  function, contains no blend arithmetic, no copy of the pool rule, no fatigue
  lookup; `in_pool` count equals `pool_size` on every team; every excluded arm
  appears as a row; `on_roster` present on every row.
- `scripts/test-bullpen-availability.js` — 38 → **44 assertions**, 0 failed.
- `scripts/bullpen-report-source-diff.js` — both diffs, re-runnable.
- Full suite: no new failures. The four pre-existing failures
  (`edge-sanity-cap` 12, `stint-weighted-neutralization` 7,
  `sp-forecast-abbrev-resolver` 1, `sp-weight-haircut` 1) are unchanged from
  the pre-change baseline, confirmed by stashing.

## 10. Related

- `docs/bullpen-park-neutral-2026-08-31.md` — the neutralization the report was missing.
- `docs/register-bullpen-open-items-2026-08-30.md` — the earlier open items.
- `services/feature-gate-registry.js` — `bullpen_pool_lastname_fallback`, `debug_bullpen_endpoint_divergence`.
- `/api/debug/bullpen` remains a **third** implementation, still deliberately diverged.
