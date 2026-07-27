# Hand-conditional SP_WEIGHT — design 2026-07-26

> ## ⚠ SOFT HALT — updated 2026-07-27
>
> **Original halt (2026-07-26):** hand-split rolling-CV sweep on the
> full 2026-04-09 → 2026-07-22 universe showed R-facing DOWN and
> L-facing catastrophic across all SP_WEIGHT values — disconfirming
> the benchmark's UP-for-R / DOWN-for-L prediction.
>
> **Cohort-restricted rerun (2026-07-27,
> `docs/sp-weight-v6v7-hand-split-2026-07-27.md`) reversed this.**
> The v6→v7 direction FLIPPED, and the mixed-cohort DOWN was a
> pre-v6 artifact. The L-facing catastrophe was ~80% pre-v6 as well.
> Under v7 alone:
>
> - R-facing (n=36 at baseline): direction slight UP; best point at 0.90
>   (+18.51%), baseline at 0.80 (+11.72%). CI overlap YES.
> - L-facing (n=20 at baseline): direction UP; baseline at 0.80 (−7.10%)
>   is co-best. CI overlap YES.
>
> **This is directionally consistent with the corrected benchmark
> (0.86 R / 0.68 L predicted UP for R-facing).** Not confirmatory —
> just consistent.
>
> **Halt status:** design is un-halted as a principle, still halted
> in practice. v7 hand-subsets are n<40 per candidate; all CIs overlap
> baseline. Shipping now would be shipping point estimates in the
> presence of 70pp CIs.
>
> **Revive when:** v7 R-facing reaches n≥100 per candidate, roughly
> 6-8 more weeks of v7 accumulation at current signal rate. Re-run the
> v6/v7 sweep periodically to check.
>
> Phase 1 constants (0.86 R / 0.68 L) are no longer provably wrong,
> but not shippable either. Use them as the design target when v7
> accumulates enough n to test.
>
> ---

## Two-phase rollout

Ship the hand-conditional CONSTANT first (Phase 1). Add per-team
bullpen composition as a refinement (Phase 2). Each phase can ship
independently; Phase 2 uses the Phase 1 constants as its fallback.

## Phase 1: hand-conditional constant

### Change scope

Replace the single scalar `SP_WEIGHT` in `perBatterEW` with a
two-value lookup keyed on `pitcherHand`:

```js
const spW = pitcherHand === 'R' ? SP_WEIGHT_R : SP_WEIGHT_L;
const relW = 1 - spW;
```

### Constants (initial values from the benchmark)

- `SP_WEIGHT_R = 0.86` (was 0.80 — up 6pp)
- `SP_WEIGHT_L = 0.68` (was 0.80 — down 12pp)

These are the league-average handedness-exposure numbers from the
benchmark correction doc (0.54 SP_share + 0.46 RP_share × 0.69/0.31
same-hand RP fraction). They match the "compute exposure from what
actually happens" premise and require no per-game lookup.

### Fallback

**Not needed for Phase 1** — SP hand is always known (resolved from
`team_rosters` for both `away_sp` and `home_sp`). If it's ever null
(unresolved SP name, which is rare enough that the abbreviation-
fallback machinery in `services/jobs.js:1970` already handles most of
it), fall back to the current `SP_WEIGHT` scalar (0.80) with a warn
log. Track occurrences — if the null-hand rate is >1% of games, that's
a data-quality signal but not a shipping blocker.

### Schema changes

Add `sp_weight_r` and `sp_weight_l` to `services/settings-schema.js`,
gated behind a `use_hand_conditional_sp_weight` boolean:

```js
sp_weight_r: { type: 'number', min: 0.5, max: 0.95, default: 0.86,
  help: 'SP-hand-conditional weight when facing RHP starter. Benchmark: 0.86 (league-avg RP composition 69% R).' },
sp_weight_l: { type: 'number', min: 0.5, max: 0.95, default: 0.68,
  help: 'SP-hand-conditional weight when facing LHP starter. Benchmark: 0.68 (league-avg RP composition 31% L).' },
use_hand_conditional_sp_weight: { type: 'boolean', default: false,
  help: 'When true, perBatterEW uses sp_weight_r/l based on SP hand instead of the flat sp_weight scalar.' },
```

Keep `sp_weight` in place as the legacy flat scalar; the flag toggles
between paths. Enables clean rollback and A/B.

### Model code changes

Two touches in `services/model.js`:
1. `perBatterEW:498`: read the two new settings and branch on
   `pitcherHand` when the flag is on
2. The persisted `*_sp_weight_used` columns (`db/schema.js:1259`)
   record the ACTUAL scalar used per game — no schema change, just
   populate with the resolved value (0.86 or 0.68 or fallback 0.80).
   Downstream analysis continues to work.

### Rollout

1. Ship code + settings, flag OFF by default. Verify byte-identical
   model output when flag off.
2. Shadow-mode: compute both paths for every game in a scoped time
   window, log per-game deltas. Emit a summary of how much the model
   line moves on average, split by SP hand.
3. Backtest with `sweep-sp-weight-rolling-cv-by-hand.js` — swap grid
   for a binary flag comparison. If hand-conditional beats flat in
   ≥2/3 folds by any meaningful margin (Val ROI +1pp, CI lower bound
   > flat CI upper bound), flip default.
4. Otherwise keep off and treat as instrumentation only.

### Why this is likely the 80% win

- Two constants beat one because they align with a real structural
  asymmetry (bullpens are 69% R). The parameter genuinely wants
  different values for R and L opposing starters — the flat 0.80 is a
  volume-weighted average that's ~6pp too low for 70% of games and
  ~12pp too high for 30%.
- No per-game DB lookups, no roster-freshness dependencies, no new
  data sources.
- Rollback is a boolean flip.
- Directly testable via the hand-split sweep (already running).

## Phase 2: per-team bullpen composition

### Change scope

Replace the flat `SP_WEIGHT_R = 0.86` with a per-game formula:

```js
const oppTeam = pitcherIsAway ? homeTeam : awayTeam;  // batter's team is the opposing team
const bpMix = getOpposingBullpenHandMix(oppTeam, gameDate);  // { R: 0.72, L: 0.28, staleness: 'fresh' | 'stale' | 'missing' }
const sameHandFrac = pitcherHand === 'R' ? bpMix.R : bpMix.L;
const spW = SP_SHARE_BASELINE + (1 - SP_SHARE_BASELINE) * sameHandFrac;
// SP_SHARE_BASELINE ≈ 0.54 from PA-exposure math
```

The `getOpposingBullpenHandMix` helper reads from `team_rosters`
filtered to `role='P'` and pitcher_fg_role=`RP` for the specified team
as of the specified date. Returns per-team fractions and a staleness
label.

### Fallback (this is where the design gets interesting)

Two failure modes need explicit handling:

**Mode 1: opposing bullpen mix unknown or team_rosters returns 0 RPs.**
Fall back to the Phase 1 hand-conditional constant (0.86 R / 0.68 L).
Log `[sp-weight] bullpen-mix-fallback team=X reason=empty-roster
using=hand-const`. Not the flat 0.80 — the hand-conditional constant is
still meaningfully better than the flat scalar even without the per-
team refinement.

**Mode 2: roster is stale (>N days since `updated_at`).** Same fallback
— use the hand-conditional constant. Threshold to be tuned; probably
7 days (a bullpen doesn't turn over faster than that mid-season, but
by IL moves and callups it drifts within a few weeks).

**Never fall back to the flat 0.80.** The Phase 1 constants are always
available (SP hand is always known) and always better on the
volume-weighted benchmark. The flat 0.80 exists only as an emergency
kill-switch behind the flag.

### Additional data-quality gates

- If a team has <5 RPs on roster, treat as stale (small-sample noise
  in the mix estimate). Fallback = hand-conditional constant.
- If the same-hand fraction resolves to <0.10 or >0.90, log as
  suspicious but use the value — some teams do run extreme bullpens
  (bad-A's-era, etc.).
- Compare per-game resolved SP_WEIGHT to Phase 1 constant; log any
  game where the delta exceeds ±10pp for manual eyeball.

### Second-order refinement: pinch-hit adjustment

Not in Phase 2 scope. Noted in the benchmark correction doc as a
directional argument for weight not going lower than benchmark. Would
need a hitter-specific PH-vulnerability score (extreme-split hitters
who get lifted for a PH against the disfavored hand). Framework-level
change — separate design.

### Rollout

Same shape as Phase 1: shipping behind a second flag
`use_per_team_bullpen_mix`, shadow, backtest, flip. Requires Phase 1
to be live and stable (since Phase 2's fallback is the Phase 1
constant).

## Interaction with existing settings and features

### `sp_weight` scalar (legacy)

Kept in schema. Used only when `use_hand_conditional_sp_weight=false`
(current default). Once Phase 1 flips on by default, the scalar
becomes vestigial; deprecation vote happens after 3+ weeks stable.

### `RELIEF_WEIGHT` scalar (legacy)

Currently invariant-locked to `1 - sp_weight`. Once Phase 1 flips,
this invariant no longer applies (there's no single sp_weight). Two
options:
- Keep `relief_weight` in schema and enforce `1 - sp_weight_r` (or
  `_l`) at model runtime, not at settings-write time.
- Retire `relief_weight` and compute internally.

Recommend the latter — a scalar that's derived from another scalar
per-side is a footgun.

### `SP_PIT_WEIGHT` (pitching-side blend)

**Untouched by this feature.** SP_PIT_WEIGHT is the pitching-side
blend (SP vs RP) that DOES model innings share, gated by the
confidence haircut from `computeSpPitWeightFromForecast`. Same
mechanical argument as this design applies (should probably be
per-game from actual forecast), but sits behind the
`sp_forecast_ip` data-quality work in the blast-radius doc.
Explicitly out of scope here.

### Opener path

**Untouched.** The `openerOpts != null` branch in `perBatterEW` (line
482) never reaches the `SP_WEIGHT` line, so opener games don't need
special handling. They use `openerOpts.perPositionWeights` which is
already opener-aware and per-slot.

### `*_sp_weight_used` persistence columns

Populate with the actual resolved value per game. Phase 1: 0.86 / 0.68
/ 0.80 (fallback). Phase 2: whatever the per-team formula returned.
Backtests read this column as ground truth for what the model saw.

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Benchmark constants (0.86 / 0.68) are wrong on some second-order effect | Med | Sweep the hand-conditional design behind flag before default flip |
| Hand-split sweep (in-flight) shows no direction difference | Low | Phase 1 still ships — volume-weighted benchmark argues for two constants regardless. Just means the effect is smaller than expected |
| Hand-split sweep shows OPPOSITE direction (R prefers LOWER, L prefers HIGHER) | High | Halt. Something's wrong with the benchmark math. Investigate before shipping anything |
| Per-team roster is systematically stale for certain teams | Med | Phase 2 fallback catches it; monitor rate of hand-const fallback |
| `RELIEF_WEIGHT` legacy consumers exist outside model.js | Low | Grep pass before removing; likely safe to keep during transition |
| Pinch-hit adjustment turns out to matter a lot | Low | Post-Phase-2 design work; doesn't invalidate Phase 1 or 2 |

## What I need to know before building

1. **Wait for hand-split sweep results.** If direction is right
   (R-facing prefers higher, L-facing prefers lower), proceed. If
   opposite direction shows up, HALT and re-examine.

2. **Decision on `RELIEF_WEIGHT`** — keep as invariant-locked
   scalar during transition, or retire immediately? Recommend keep
   during Phase 1 (minimal disruption), retire when Phase 1 becomes
   default.

3. **Decision on the `SP_PIT_WEIGHT` follow-on** — flagged in the
   blast-radius doc but explicitly out of scope here. Ship this
   feature first, or wait until pitching-side is also cleaned up?
   Recommend ship this first — different code path, independent
   value. Blast-radius fix can proceed in parallel on its own timeline.

## Bottom line

- Phase 1 is 4-6 lines of code + 3 schema entries + shadow harness.
  Should be a few days of work, half of which is the shadow-mode
  observability.
- Phase 2 is one helper function + per-game lookup + fallback
  logic. Another few days.
- Both are low-risk (behind flags, backtested, rollback is a boolean).
- Estimated 80% of the theoretical win comes from Phase 1. Phase 2 is
  refinement.
