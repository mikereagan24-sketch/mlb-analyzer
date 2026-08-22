# Two structural defects: framing duplication, and the `edge_pp` unit lie (2026-08-22)

> **Filed, not fixed.** Both were found while evaluating
> `CATCHER_FRAMING_MUTE` and the edge cap. Neither is urgent; both are
> the kind of thing that costs an hour every few weeks and will keep
> doing so.

## 1. `computeFramingRvPerGame` exists six times

Five verbatim copies plus a sixth structurally-different variant:

| location | form |
|---|---|
| `services/frv-backtest.js:51` | canonical-ish (now the one exported) |
| `services/baserunning-backtest.js:65` | verbatim copy |
| `services/runmult-totals-backtest.js:106` | verbatim copy |
| `services/temp-backtest.js:66` | verbatim copy |
| `services/under-selection-diagnostic.js:57` | verbatim copy |
| `services/jobs.js:~700` | **prod path**, state-aware (`no_framing_data`, `no_catcher`) |

**Any correction to framing has to be made in six places, and the one
that matters most — prod — has a different shape from the other five.**

### Why this is the expensive kind of duplication

The five backtest copies exist so each harness can score framing
offline. The prod copy additionally returns a *state* used for display
and audit. So they are not gratuitous — they diverged for a reason. But
the consequence is that **a fix validated in a backtest is not
necessarily the code prod runs**, which is precisely the failure mode
recorded in `feedback_duplicate_reimplementations`: the three-stack
same-bug incident where client, scripts, and a sibling service each hid
the next.

This is also not hypothetical here. The catcher-framing feature has
*already* been the subject of one silent-inertness bug
(`services/jobs.js:294` records it: `CATCHER_FRAMING_ENABLED` was never
surfaced, so the feature could not activate) and one harness false
negative (2026-08-22). A feature with six implementations and a history
of silently doing nothing is a feature that needs one implementation.

### Proposed fix

Extract to a single module — `services/framing.js` — exporting:

- `computeFramingRvPerGame(team, lineupJson, settings)` → `number|null`
- `computeFramingRvWithState(team, lineupJson, settings)` → `{ rv, state, catcherName }`

The first delegates to the second and discards the state, so there is
exactly one code path and prod's extra return values are additive rather
than a fork. Then delete the five copies and re-point `jobs.js`.

**Verification requirement:** this is a refactor of the pricing path, so
it must be proven byte-identical before merge — replay the corpus and
assert 0/790 games change, the same check used for the `SP_WEIGHT_L`
wiring. A refactor that *silently* changes a price is worse than the
duplication.

**Do not do this as part of a feature change.** Separate PR, byte-identity
asserted, nothing else in it.

## 2. `edge_pp` holds a fraction, not pp

`services/parameter-sweep.js:483`:

```js
edge_pp:     Number(s.edge),      // <- s.edge is a FRACTION. 0.08 = 8pp.
```

The field name asserts percentage points. The value is a fraction. Every
consumer must know to multiply by 100, and nothing enforces it.

### This has now cost two re-runs

1. **2026-08-22, edge-honesty scope** — banded `signal.edge` as pp when
   it is a fraction. All 742 signals collapsed into one bucket. Caught
   only because a single-bucket histogram is obviously wrong.
2. **2026-08-22, edge-cap analysis** — filtered on `s.edge` (the field
   is `edge_pp`), got **0 signals from 947 games**, and re-ran.

The second one is the more dangerous shape: **a units error that
produces an empty result looks exactly like a real null.** The first
caught itself because the output was absurd. A filter that silently
matches nothing does not.

### Proposed fix

Rename the field to `edge_frac`, or convert at the write site:

```js
edge_pp: Number(s.edge) * 100,
```

**Converting is the better fix but the more dangerous one** — it changes
the meaning of a field that consumers already read. Grep first:
`decomposeVsBaseline`, `coreSignalStats`, `targetBucketsFor`, the
`/backtest` route and `public/index.html` all touch signal edges, and
each needs checking for whether it already compensates by multiplying.
**A blind rename is safer than a blind conversion.**

Recommend: rename to `edge_frac`, fix the call sites the compiler-free
way (grep, then run the sweep and assert identical output), and leave the
value alone.

## Neither blocks anything

Both are recorded because they are cheap to fix deliberately and
expensive to rediscover. The framing duplication is the higher priority
of the two — it sits on the pricing path and the feature already has a
history of failing silently.

## Related

- `docs/three-targets-hfa-cap-framing-2026-08-22.md` §4 — where both were found.
- `services/harness-inputs.js` — the shared-helper fix applied to the *other* half of this problem (caller-populated inputs), and the model for what §1 should look like.
- `services/jobs.js:294` — the earlier framing silent-inertness bug.
