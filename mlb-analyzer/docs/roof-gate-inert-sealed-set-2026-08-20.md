# Roof gate: the sealed-dome set was inert, and is still incomplete (2026-08-20)

**Status:** the dead branch is **fixed** on
`fix/unsealed-closed-temp-multiplier`. One live consequence remains
open — §3, mis-reported materiality in the season weather backfill.
Low severity, telemetry only.

Filed as the "same class of problem" ticket alongside
`docs/mil-sealed-dome-classification-2026-08-20.md`.

## 1. What the dead branch was

`services/weather.js:computeEffectiveWeather`, before this change:

```js
const roofMult = st === 'closed' ? 0 : st === 'partial' ? 0.5 : 1;
const sealedClosed = st === 'closed' && isSealedDome(venueId);
const windFactor = sealedClosed ? 0 : rawWindFactor * roofMult;
const tempRunAdj = sealedClosed ? 0 : rawTempAdjNum * roofMult;
```

When `st === 'closed'`, `roofMult` is already `0`, so both ternaries
evaluate to `0` on either branch: `sealedClosed ? 0 : raw * 0`. When
`st !== 'closed'`, `sealedClosed` is `false` by construction. **The
`sealedClosed` flag could not change either output under any input.**

`services/jobs.js` said as much in a comment — "the sealed vs unsealed
distinction only matters if that branch ever changed" — so this was
known and accepted rather than missed.

## 2. Why it mattered anyway

`services/roof-prior.js` carried a carefully argued, empirically
sourced justification for excluding SEA from `SEALED_DOME_VENUE_IDS`
("its roof covers but doesn't seal, so closed SEA games still report
real wind and outside-matching temps"). That reasoning was correct and
had **no effect on any output**. The config looked load-bearing, was
documented as load-bearing, and was inert.

That is the class of problem: *inert configuration that reads as
active*. It hides a real design decision behind a no-op, and the
decision only surfaces when someone changes the surrounding code — at
which point the set silently becomes load-bearing with whatever
membership it happens to have.

Fixed by `roofChannelMults`, where the canopy allowlist now genuinely
gates the temp channel. See
`docs/sea-canopy-roof-scope-2026-08-20.md` §7.

## 3. The live consequence that remains open

Because the set was inert, its membership was never pressure-tested.
It is **an enumeration of the seven retractable parks, not a registry
of sealed venues**:

```js
const SEALED_DOME_VENUE_IDS = new Set([15, 2392, 5325, 4169, 14, 32]);
//                                     ARI  HOU   TEX   MIA   TOR MIL
```

**Tropicana Field (venue_id 12) is absent** — it is a fixed dome, not a
retractable, so it was out of scope for the set's original purpose. The
DB holds 19 closed rows at venue 12 plus 4 more TB rows with a NULL
`venue_id`.

This nearly shipped a bug. The first draft of the per-channel gate
derived "unsealed" as *not in `SEALED_DOME_VENUE_IDS`*, which would
have given 19 closed Tropicana games and 7 NULL-venue games full
outdoor `temp_run_adj` inside climate-controlled buildings. The DB
replay in `tmp/verify-per-channel-roof-gate.js` caught it — 26 rows
changed, none of them SEA. Fixed by making the canopy set an explicit
allowlist that fails safe.

**Still open:** the set's one remaining consumer,
`services/backfill-tasks/weather-backfill-season.js` (lines ~232 and
~326), classifies a temp-bucket crossing as *material* like this:

```js
const isSealedClosed = (a.roof_status === 'closed') && isSealedDome(a.venue_id);
const isMaterial = !isSealedClosed;
```

For a closed Tropicana row, `isSealedDome(12)` is `false`, so the
crossing counts as material — but the temp is gated to 0 anyway, so it
cannot matter. Same for the 7 NULL-`venue_id` rows at genuinely sealed
parks. The backfill therefore **over-reports material crossings**.

Severity: low. This is progress/summary telemetry only — it does not
write `temp_run_adj`, `wind_factor`, or any scored column. Nothing in
the betting path reads it. It makes backfill dry-run projections look
slightly more consequential than they are.

## 4. Suggested fix (not done)

Have the materiality check ask the gate rather than re-derive it:

```js
const { roofChannelMults } = require('../weather');
const isMaterial = roofChannelMults(a.roof_status, a.venue_id).tempMult !== 0;
```

This is correct by construction for every venue including Tropicana,
NULL venues, and any future park, and removes the last independent
reimplementation of the roof gate. It also makes the backfill's
materiality track the gate automatically if the canopy allowlist ever
grows.

Deliberately left out of `fix/unsealed-closed-temp-multiplier` to keep
that change provably scoped to the temp channel — the verification
harness asserts zero stored rows move, and touching the backfill's
reporting would not have broken that but would have widened the diff
past what the harness covers.

## 5. Checklist if the canopy allowlist ever grows

- [ ] Add the venue to `UNSEALED_ROOF_VENUE_IDS` only, never by
      removing it from `SEALED_DOME_VENUE_IDS`.
- [ ] Justify with the ERA5 differential test: median(statsapi temp −
      ERA5 outdoor) on closed games near 0 means canopy; ≥+10°F means
      sealed. See `docs/mil-sealed-dome-classification-2026-08-20.md`
      for a worked negative case.
- [ ] Re-run `tmp/verify-per-channel-roof-gate.js` and confirm the
      changed-key set in section B is exactly the venues you intended.
- [ ] Confirm the wind channel still changes in 0 combinations, unless
      `docs/unsealed-roof-wind-multiplier-open-question-2026-08-20.md`
      has been resolved.

## Related

- `docs/sea-canopy-roof-scope-2026-08-20.md`
- `docs/mil-sealed-dome-classification-2026-08-20.md`
- `services/weather.js:roofChannelMults`
- `services/roof-prior.js` — both venue sets and why they are separate.
