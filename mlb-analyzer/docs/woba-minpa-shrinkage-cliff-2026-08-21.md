# wOBA MIN_PA gate: hard cliff → piecewise shrinkage (2026-08-21)

**Status:** shipped on `fix/woba-minpa-shrinkage-cliff`. Defensible by
construction, **not** empirically validated — see §5 for why that is the
only honest basis available and what it does and does not license.

Verification: `tmp/verify-minpa-shrinkage.js` (12 assertions, all pass).

## 1. The cliff

`services/model.js:blendWoba` gated season actuals on a hard threshold:

```js
const ha = act && !isNaN(act.woba) && act.sample >= minSample;
...
if (hp && ha) return { woba: proj.woba*wp + actWoba*wa, source:'blend' };
if (hp)       return { woba: proj.woba, source:'steamer' };
```

A batter at `MIN_PA − 1` PA was priced off the projection alone. At
`MIN_PA + 1` PA they jumped straight to the full `W_ACT` blend. At
production `MIN_PA=60`, `W_ACT=0.55`, that is a step of
`0.55 × (actual − projection)` **in a single plate appearance**.

Measured on a realistic disagreement (projection 0.330, actual 0.400):

| | PA=59 | PA=61 | step |
|---|---|---|---|
| **before** | 0.330000 | 0.368500 | **0.038500 wOBA** |
| **after** | 0.330000 | 0.330014 | 0.000014 wOBA |

0.0385 wOBA is roughly the gap between an average hitter and a good one,
applied on the strength of one PA. There is no mechanism that switches on
at 60 PA — information about a hitter accrues continuously.

Worse, the cliff hands **full** weight exactly where the actuals are
least trustworthy. Spread of `(actual − projection)` wOBA, pooled over
four mid-season snapshots (`bat-act-rhp`):

| PA bucket | n | SD(actual − projection) |
|---|---|---|
| **60-90** | 92 | **0.0409** ← full W_ACT granted here |
| 90-120 | 53 | 0.0404 |
| 120-150 | 69 | 0.0355 |
| **150-200** | 98 | **0.0269** ← knee; falls ~25% then flattens |
| 200-300 | 146 | 0.0272 |
| 300-450 | 202 | 0.0259 |
| 450+ | 793 | 0.0173 |

At the old gate the actuals are ~1.5× noisier than a settled sample and
~2.4× noisier than a full season, and they were being trusted at 0.55.

## 2. The fix

`blendWoba` takes an optional 7th argument, `shrinkFloor` — the sample
size at which actuals reach full weight. Omitted / null / `<= minSample`
reproduces the previous behaviour exactly.

```
s     = smoothstep((sample − minSample) / (shrinkFloor − minSample))
waEff = wa * s
wpEff = wp + wa * (1 − s)
```

Three properties, each by construction rather than arithmetic luck:

1. **At `s = 1` the caller's `wp` / `wa` are used untouched**, so the
   blend at or above the floor is bit-for-bit unchanged. This is why the
   code special-cases `s === 1` instead of computing `1 − waEff`:
   `1 − 0.55` is `0.44999999999999996`, **not** `0.45`. A tolerance-based
   test would have missed that; the harness asserts strict `===`.
2. **`wpEff + waEff == wp + wa` at every sample size.** The ramp can only
   move the split, never the total.
3. **At `s = 0`: `wpEff = wp + wa`, `waEff = 0`** — pure projection,
   which is exactly what the sub-`minSample` branch already returns. The
   join at `MIN_PA` is therefore continuous, which is the entire point.

Resulting weights at production `W_PROJ=0.45 / W_ACT=0.55`, floor 150:

| PA | wProj | wAct |
|---|---|---|
| 60 (gate) | 1.0000 | 0.0000 |
| 105 | 0.7250 | 0.2750 |
| **150 (floor)** | **0.4500** | **0.5500** |
| 300 | 0.4500 | 0.5500 |

Projection weight is floored at 0.45 and rises to 1.0 as the sample
shrinks toward the gate, per the design.

**Shape: smoothstep**, not linear. Continuous in value *and* first
derivative at both ends, so neither boundary introduces a kink — the
same shape argued for the wind deadband in
`docs/wind-deadband-cliff-open-question-2026-08-19.md`. Fixing two cliffs
with two different curve shapes would be arbitrary.

## 3. Picking the floor — on shape, not by sweeping

**150 PA.** From the SD table in §1, that is where the steep decline ends
and the curve flattens: 0.0355 at 120-150 → 0.0269 at 150-200 → 0.0272 at
200-300. Anything in 150-200 would serve equally well, and the constant is
deliberately **not tuned finer than the data can distinguish**.

It was explicitly **not** chosen by sweeping ROI. Per the 2026-08-21
W_PROJ/W_ACT null (`docs/wproj-wact-snapshot-sweep-2026-08-21.md`), an
ROI search over this constant would be fitting noise: that sweep moved
team wOBA by up to 0.0039 across its entire range and could not
distinguish any value from any other, and this change moves team wOBA by
**less** (§4). A sweep would return a "best" value and it would mean
nothing.

## 4. Blast radius

Measured over the snapshot corpus (859 games, 2026-06-01 → 2026-08-07),
comparing every lineup slot with and without the floor:

| | |
|---|---|
| lineup slots evaluated | 14,652 |
| **slots whose wOBA moves** | **267 (1.82%)** |
| games with ≥1 moved slot | 180 of 859 |
| \|wOBA delta\| on moved slots | p50 0.0056, p90 0.0255, **max 0.0579** |
| team-game \|wOBA delta\| | p50 0.00000, p90 0.00018, max 0.00643 |
| **team-game run delta** | **p90 0.008 runs, max 0.296 runs** |

So: a bounded, targeted change. Fewer than 2% of slots move at all — the
batters actually sitting in the 60-150 PA ramp — and the largest
team-level effect on any single game is 0.30 runs, with p90 at 0.008.
Nothing outside the ramp moves by a single float ULP.

## 5. What this is and is not

**Is:** removal of a discontinuity that has no mechanism behind it, in
the direction the noise data supports (trust the noisier input less),
with the previous behaviour preserved bit-for-bit everywhere the actuals
were already trustworthy.

**Is not:** a validated improvement. No ROI claim is made and none was
measured. The 2026-08-19 pooled sens fit and the 2026-08-21 blend sweep
together establish that effects of this magnitude are **not resolvable**
at current sample sizes — a ~0.008-run p90 team effect is far below a
0.18-run whole-range effect that already could not be distinguished from
zero. Demanding empirical validation here would mean the cliff can never
be fixed, since the evidence to justify it cannot exist.

That is the trade being made, and it should be reviewed as such.

## 6. Scope

**Batters only.** `getBatterWoba` passes the floor; `getPitcherWoba`
deliberately does not, and the pitcher path is byte-identical
everywhere. The pitcher curve has the same shape shifted right and has
**not** flattened by 150:

| BF bucket | SD(actual − projection) |
|---|---|
| 100-130 | 0.0537 |
| 130-160 | 0.0468 |
| 160-190 | 0.0421 |
| 150-200 | 0.0427 |
| 200-300 | 0.0364 |
| 300-450 | 0.0349 |
| 450+ | 0.0215 |

A pitcher floor would be ~300 BF, not 150. Applying the batter constant
to pitchers would have been unjustified, so it was not.

**Follow-up, not done here:** `db/schema.js:3314` — the bullpen per-RP
blend — has the same hard-gate structure (`sample_size >= minSample`,
`minBF=100`) and the same cliff. It is a separate blend implementation
with its own weights (`bullpen_w_proj` / `bullpen_w_act`, 0.25/0.75) and
would need the ~300 BF floor from the table above. Deliberately left
alone: folding a second blend path with a different constant into this
change would have made the byte-identity guarantee harder to state and
harder to verify.

**Shipped unflagged.** The repo's usual pattern — schema key defaulting
OFF until backtest-validated — presumes a validation path exists. Here it
does not (§5), so a dark flag would stay dark permanently. The change is
instead made maximally safe: byte-identical above the floor, continuous
at the join, and with the blast radius measured above so it can be judged
on inspection. If a flag is wanted anyway it is a small follow-up, and
per CLAUDE.md's UI-parity rule it would need its schema key and its
`public/index.html` control in the same PR.

## 7. Verification

`tmp/verify-minpa-shrinkage.js`, 12 assertions:

- **A** byte-identity at/above the floor — 288 combinations across 6
  projections × 6 actuals × 8 sample sizes, strict `===`, **0 move**.
  Also asserts `1 − wa !== wp` so the float trap stays documented in the
  test itself.
- **B** pitcher path byte-identical (no floor passed).
- **C** continuity: pure projection at the gate; step across the join
  0.000014 vs the old 0.038500.
- **D/E** weight total preserved at every sample size; projection weight
  within `[wp, wp+wa]`; actuals weight monotone non-decreasing; exactly
  `0.45 / 0.55` at the floor; exactly `1.0 / 0.0` at the gate.
- **F** blast radius on the real corpus (§4).

## Related

- `docs/wproj-wact-snapshot-sweep-2026-08-21.md` — the null that makes
  sweeping this constant inappropriate.
- `docs/wind-deadband-cliff-open-question-2026-08-19.md` — the sibling
  cliff, same smoothstep shape argument; still open.
- `docs/blendwoba-zero-weight-open-question-2026-08-21.md` — the
  `weightOr` fix this builds on.
- `services/model.js:BATTER_ACT_FULL_WEIGHT_PA` — the constant.
