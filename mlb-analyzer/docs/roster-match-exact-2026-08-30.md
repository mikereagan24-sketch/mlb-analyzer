# Exact-name roster matching, and the edge-cap fixture (2026-08-30)

> **The surname match is fixed.** EXACT admits **249 — all 249 rostered RPs,
> 1:1.** Nothing relied on the fallback; its only effect was 22 phantoms.
>
> **Three copies, all fixed.** Two in `db/schema.js`, one in `routes/api.js`.
>
> **One priced number moves: CWS +0.0006.** 14 teams shed phantom candidates;
> **zero fallbacks introduced**, confirming no legitimate arm depended on the
> loose match.
>
> **`edge-sanity-cap` diagnosed and fixed.** Not a cap regression — the
> fixture's synthetic market was rejected by a sanity guard added *after* the
> test. The ML half of the edge cap had been unverified since, and one of its
> assertions was **passing vacuously**.

---

## Part 1 — the surname match

### Which rule does the data support?

Measured over all 30 teams (`scripts/measure-roster-match-rules.js`):

| Rule | Admits | Notes |
|---|---|---|
| **EXACT** (full normalised name) | **249** | = **all 249 rostered RPs, 1:1** |
| INITIAL (surname + first initial) | 250 | +1 — and that one is *also* a phantom |
| SURNAME (what we had) | 271 | +22 phantoms |

**The fallback rescued nothing.** Every rostered reliever already has an
exactly-matching projection row, so the loose match bought no coverage at all
— it only admitted strangers.

**First-initial is not enough.** Its single "rescue" over EXACT is
`SF / Darien Smith`, admitted off the roster's **Dylan** Smith. Darien Smith
is on no roster and has never pitched. A rule that still admits a phantom to
fix a problem that doesn't exist is worse than the strict rule.

**MLB ID is not available on this path.** Projection rows carry only a
`Name TEAM` string with no id, so ID matching would require a name resolver —
reintroducing the same problem one layer down. At 249/249 it buys nothing.

**So: exact normalised name.**

### Three copies, not one

| Location | What it did |
|---|---|
| `db/schema.js` pool filter | `activeRPSet.has(pn) \|\| [...activeRPSet].some(n => n.endsWith(' '+last))` — the pricing path |
| `db/schema.js` fallback injection | `if (rLast && representedLast.has(rLast)) continue;` — *"same surname = same person"* |
| `routes/api.js` `/debug/bullpen` | same surname test in role tagging |

The second one is worth naming: it could **silently drop a genuinely rostered
reliever** because an unrelated namesake was already in the pool — and unlike
the fatigue path, it recorded no `note()`. A silent exclusion, of exactly the
class this project has spent weeks removing.

### Measured impact

```
teams changed           : 14 of 30
teams whose wOBA moved  : 1        (CWS, +0.0006)
fallbacks introduced    : 0        <- nothing legitimate was relying on the fallback
smallest pool after fix : 5        <- pool<2 warning threshold not approached
```

The zero-fallbacks result is the important one: it independently confirms the
249/249 measurement. Had any real arm been getting in via surname, tightening
the rule would have pushed it into the fallback list.

`/debug/bullpen` now reads `Shane Smith → not_on_roster` instead of borrowing
Hagen Smith's `RP` role.

### Safe against name-format drift

EXACT is strict, and the obvious objection is that a spelling change between
the projection source and the roster source would start dropping arms. It
doesn't drop them **silently**: an unmatched roster RP falls through to
roster-fallback injection and appears in the `fallbacks` count and the report.
That path is asserted in the test.

### What this does *not* fix

Shane Smith carried an actuals sample **7.33×** his logged BF (338/278 against
84), where every current pitcher checked runs 0.6–1.2×. Removing him from the
pool closes the pricing exposure, but **it does not answer why a pitcher
carries actuals that are not from this season** — and that question may apply
to players who *are* correctly rostered. Recorded in the registry note as
still open.

---

## Part 2 — `edge-sanity-cap`: not a cap regression

12 failing assertions, and the pattern was the tell: **every moneyline
assertion failed while every Totals assertion passed.**

### The cause

The fixture priced its synthetic market at **`+100 / +100`**.
`utils/market-sanity` `checkMarketMLPairSanity` rejects that pair:

```
+100 / +100   implied sum 1.0000
  -> "impossible line pair: both sides positive — no favorite in a two-outcome market"
```

`getSignals` then sets `haveAnyML = false` and emits **no ML signal at all** —
not suppressed, absent. Totals use a separate gate, which is exactly why they
were unaffected.

Git history confirms the ordering:

```
05dc2ac  Edge-sanity cap on signal emission        <- the test
27f2ded  fix(odds): DH-assignment guard + market-sanity guard   <- broke its fixture
```

**The cap was never broken.** A guard added later made the fixture's market
structurally invalid.

### The part that mattered

Test 2's **"45pp signal NOT emitted" was passing — vacuously.** No ML signal
was emitted for *any* input, so that assertion could not fail. Which means the
ML half of the edge cap — hard cap, soft cap, `edge_suspect` — had been
**unverified since `27f2ded` shipped**.

A vacuous pass inside a failing suite is worse than the failure. The failure is
visible; the false coverage is not.

### The fix

Market is now `-110 / -110` (implied 0.5238 a side, sum 1.0476 — passes
sanity), and model lines are derived as `MARKET_P + the edge under test`
rather than hardcoded off a 0.500 baseline.

Added **Test 0**, which asserts the fixture's own market passes
`checkMarketMLPairSanity`. If a future sanity rule empties the ML path again,
it will say so by name instead of looking like a cap regression.

All 22 assertions now pass, and the suppression **actually fires**:

```
PASS  exactly one suppression recorded — got 1
PASS  suppression carries reason=edge_hard_cap
PASS  suppression has expected edge ~0.45 — edge=0.45
```

Verified the cap is what does the work, not the market gate:

```
hard cap 0.25 (test value)            emitted: no                 suppressions: 1
hard cap 0.99 (cap effectively off)   emitted: YES edge=0.450     suppressions: 0
```

---

## The baseline, after both

```
suites: 19   clean: 17   expected-failing: 2   NEW failures: 0   drifted: 0
```

From **4 failing suites / 21 assertions** to **2 / 2**, both fully explained
stale fixtures with next steps recorded:

- `sp-forecast-abbrev-resolver` — Arrighetti traded HOU→TOR, fixture pinned to
  his old team.
- `sp-weight-haircut` — Scherzer no longer short-leash; pinned to a **live
  player's rolling form**, so it will drift again. Re-pin to a frozen
  synthetic sequence.

Both of the fixed ones were found the same way: by refusing to accept a count.
`stint-weighted-neutralization` had been broken by our own park-source switch;
`edge-sanity-cap` by a sanity guard shipped two PRs later. Neither was a
regression, and **both had stopped testing anything** — which the count could
not distinguish from a hard test.

## Related

- `scripts/test-roster-match-exact.js` — 14 assertions; reverting the fix fails 7, including at the pool wOBA.
- `scripts/measure-roster-match-rules.js` — the three-rule comparison, re-runnable.
- `scripts/audit-lastname-fallback-roster.js` — the roster-freshness audit.
- `scripts/run-tests.js`, `scripts/test-baseline.json` — the baseline diff.
- `services/feature-gate-registry.js` — `bullpen_pool_lastname_fallback`, now `fixed_exact_name_match`.
