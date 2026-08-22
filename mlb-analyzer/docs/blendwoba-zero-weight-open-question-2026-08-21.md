# blendWoba silently ignores a zero weight (2026-08-21)

**Status: FIXED** on `fix/blendwoba-zero-weight` (2026-08-21). Found
during the W_PROJ/W_ACT sweep pre-flight
(`docs/wproj-wact-snapshot-sweep-2026-08-21.md`). Kept as the record of
what the defect was, what else it had spread to, and what the schema
bounds now are. See §6 for what shipped.

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

## 6. What shipped

**The resolution helper.** `services/model.js` gained `weightOr(v, dflt)`
— null/undefined/''/NaN fall back to the default, `0` is preserved. It
mirrors the `num` helper already inside `runModel` (line 627) and the
`!= null` idiom in `db/schema.js:3294`, so all three now agree.

**Three more copies of the same bug, found by grepping before declaring
the fix done.** `blendWoba` was not the only site:

| site | what it feeds |
|---|---|
| `services/model.js:283-284` | the pricing path |
| `routes/api.js:5093-5094` | `/woba/game/:date/:gameId` — the Matchups tab |
| `routes/api.js:6008` | `/debug/bullpen` |

The Matchups site is the one that mattered most: it defines a *correct*
`num` helper two lines below and then did not use it for the weights.
Fixing `model.js` alone would have made the tab display a different
blend than the model priced — trading a uniform error for a divergent
one. `weightOr` is exported and all three now call it, so there is one
implementation rather than four.

**Schema bounds tightened**, and made exact complements of each other:

| setting | before | after |
|---|---|---|
| `w_proj` | min 0.0, max 1.0 | **min 0.20**, max 1.0 |
| `w_act` | min 0.0, max 1.0 | min 0.0, **max 0.80** |

Under the unchanged sum invariant, `w_proj ∈ [0.20, 1.00]` implies
`w_act = 1 − w_proj ∈ [0.00, 0.80]` — precisely `w_act`'s new range. So
every bound-legal value of either weight has a bound-legal partner and
there is no dead zone at either end. Verified by sweeping `w_proj`
across its full range: 0 inconsistent pairs, both endpoints legal under
bounds *and* invariant, and production `0.45 / 0.55` unaffected.

**The asymmetry is deliberate.** `w_act = 0` (pure projection) *is* the
model's own behaviour — every batter below `MIN_PA` is priced off the
projection alone — so forbidding it in settings would contradict the
model. `w_proj = 0` (pure actuals) is never the model's behaviour at any
sample size, and actuals are the noisier input throughout: measured
spread of (actual − projection) wOBA is **SD 0.041 at 60-90 PA** and
still **0.017 at 450+ PA**. The floor fences off the region no
measurement supports and the model never uses. It is explicitly *not* an
empirical optimum — the 2026-08-21 sweep found ROI flat and
indistinguishable across 0.1…0.9.

No UI change was needed: `_applySettingsSchema` (`public/index.html:4393`)
overwrites `el.min` / `el.max` from the schema on load, so the bounds
propagate automatically and the hardcoded `min="0" max="1"` on the
bullpen inputs is already superseded by the schema.

**Deliberately NOT changed: the bullpen pair.** `bullpen_w_proj` /
`bullpen_w_act` keep `[0.0, 1.0]`. That blend
(`db/schema.js:3294`) uses `!= null` and never had the defect, so
`bullpen_w_proj = 0` behaves correctly there today. Applying the same
0.20 floor would constrain a documented design intent — the
actuals-heavy 0.25/0.75 tilt exists because Steamer over-regresses
relievers (`docs/bullpen-fix-steps-1-2-plus-blend-2026-07-07.md`) —
without any evidence that the low end is wrong. Flagged as a conscious
choice rather than an oversight; say the word if you want it symmetric.

## Verification

`tmp/verify-blendwoba-zero-weight.js` — 22 assertions, all passing:

- **byte-identity**: 540 combinations across every weight production or
  any sweep has used (`BLEND_GRID` 0.1…0.9, prod 0.45/0.55, the legacy
  0.65/0.35 defaults, the bullpen pair) — **0 values move**.
- missing weights (`null` / `undefined` / `''`) still fall back to the
  legacy 0.65 / 0.35.
- endpoints now correct: `W_PROJ=0` returns exactly the actuals wOBA
  (0.5595 → 0.3450), `W_PROJ=1` exactly the projection (0.4507 → 0.3300).
- weights sum to 1 across `0.00…1.00` step 0.01: 2 failures before, 0 after.
- same behaviour through the real `getBatterWoba` / `getPitcherWoba`
  entry points, batter and pitcher sides.

## Related

- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` — the sweep that found it.
- `services/model.js:280` — `blendWoba`.
- `db/schema.js:3294` — the bullpen blend that gets it right.
- `services/settings-schema.js:146` — the schema that allows `0.0`.
- `tmp/preflight-wproj-wact-leverage.js` — pre-flight; its grid comment
  records why the endpoints are avoided.
