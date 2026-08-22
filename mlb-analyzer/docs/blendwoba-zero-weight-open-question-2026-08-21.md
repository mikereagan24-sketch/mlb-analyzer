# blendWoba silently ignores a zero weight (2026-08-21)

**Status:** logged, not fixed. Found during the W_PROJ/W_ACT sweep
pre-flight (`docs/wproj-wact-snapshot-sweep-2026-08-21.md`). Not
currently reachable by any live setting *value*, but the settings schema
explicitly permits the value that triggers it.

## The defect

`services/model.js:283-284`:

```js
function blendWoba(proj, act, minSample, wProj, wAct, wobaParkFactor) {
  const hp = proj && !isNaN(proj.woba);
  const ha = act && !isNaN(act.woba) && act.sample >= minSample;
  const wp = wProj || 0.65;      // <-- 0 is falsy
  const wa = wAct  || 0.35;      // <-- 0 is falsy
```

`0 || 0.65` is `0.65`. A caller asking for **zero weight** silently gets
the **legacy default** instead, and the two weights stop summing to 1:

| caller passes | blend actually uses | sum |
|---|---|---|
| W_PROJ=0.45, W_ACT=0.55 | 0.45 / 0.55 | 1.00 ✓ |
| W_PROJ=0.20, W_ACT=0.80 | 0.20 / 0.80 | 1.00 ✓ |
| **W_PROJ=0, W_ACT=1** | **0.65 / 1.00** | **1.65** ✗ |
| **W_PROJ=1, W_ACT=0** | **1.00 / 0.35** | **1.35** ✗ |

For a typical batter (projected 0.330, actual 0.345):

| setting | intended wOBA | actual wOBA | error |
|---|---|---|---|
| W_PROJ=0 (pure actuals) | 0.3450 | **0.5595** | +62% |
| W_PROJ=1 (pure projection) | 0.3300 | **0.4507** | +37% |

A 0.56 wOBA is roughly peak-Bonds for an entire lineup. Downstream this
runs through `(teamWoba − WOBA_BASELINE) × RUN_MULT`, so it would
produce grossly inflated run estimates on every game.

## Why it is not biting today

- Production runs `w_proj=0.45 / w_act=0.55`. Both truthy, so the live
  pricing path is correct and always has been.
- `BLEND_GRID` in `services/parameter-sweep.js:99` is
  `[0.1 … 0.9]` — the in-server sweep never probes the endpoints, so
  existing sweep results are unaffected.

## Why it is still worth fixing

**The schema permits the triggering value.** `services/settings-schema.js:146-151`:

```js
w_proj: { type: 'number', min: 0.0, max: 1.0, default: 0.70, ... },
w_act:  { type: 'number', min: 0.0, max: 1.0, default: 0.30,
          invariant: (v, all) => Math.abs(v + Number(all.w_proj) - 1.0) < 0.02, ... },
```

`w_proj = 0` with `w_act = 1` is **schema-legal** — `min` is 0.0 and the
sum invariant is satisfied. Anyone setting "pure actuals" through the
settings UI or API gets a silently mis-scaled model rather than a
rejection or the behavior they asked for.

It also blocks the most informative endpoint of any future blend
investigation. "What if we ignored projections entirely?" is the
natural first question about this weight, and it is currently
unaskable — the answer it returns is nonsense that superficially looks
like an enormous effect.

## Second-order: the two blend implementations disagree

`db/schema.js:3294-3304` — the bullpen blend — does it correctly:

```js
const W_PROJ = (wProj != null) ? wProj : 0.65;
const W_ACT  = (wAct  != null) ? wAct  : 0.35;
```

So `bullpen_w_proj = 0` behaves as asked, while `w_proj = 0` does not.
Same conceptual operation, two implementations, divergent at the
endpoints. `services/model.js:blendWoba` is also the shared path for
`getBatterWoba` **and** `getPitcherWoba`, so the defect covers batters,
starters, and bulk pitchers.

## Suggested fix

One-line, behavior-preserving for every value currently in use:

```js
const wp = (wProj != null && !isNaN(wProj)) ? Number(wProj) : 0.65;
const wa = (wAct  != null && !isNaN(wAct))  ? Number(wAct)  : 0.35;
```

Matches the `!= null` idiom `db/schema.js` already uses. Byte-identical
for all non-zero weights, so no re-scoring of historical rows is needed.

**Verification if it is taken up:** assert `blendWoba` is unchanged
across the full `0.1…0.9` grid (guarding every existing sweep result),
and that `W_PROJ=0` now returns exactly `act.woba` and `W_PROJ=1`
exactly `proj.woba`. A DB replay is unnecessary — no stored column is
computed from a zero weight.

## Not fixed here because

The sweep this was found in is a measurement pass that ships no
parameter change, and its grid deliberately stays inside `0.1…0.9`
where the defect is inert. Folding a pricing-path edit into a
measurement branch would have put a live-path change behind a
"chore/" review. It wants its own small `fix/` branch.

## Related

- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` — the sweep that found it.
- `services/model.js:280` — `blendWoba`.
- `db/schema.js:3294` — the bullpen blend that gets it right.
- `services/settings-schema.js:146` — the schema that allows `0.0`.
- `tmp/preflight-wproj-wact-leverage.js` — pre-flight; its grid comment
  records why the endpoints are avoided.
