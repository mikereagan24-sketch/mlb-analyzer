# Two bullpen items, registered not fixed (2026-08-30)

> **Neither is work. Both were living in prose in a doc, findable only by
> someone remembering they existed** — which is the failure the ARI roof
> scraper is the monument to.
>
> Registered in `services/feature-gate-registry.js` so the morning check
> carries them. **Deliberately quiet**: one informational line, not the
> attention list.

## Why quiet matters here

The obvious move is to register them as `needs_attention` so they show up
red every morning. That would be wrong, and the reason is already on the
record: `fielding_frv` sat at permanent CRITICAL for 44 rows nobody
intended to act on, and the lesson was that **a check which is always red
is a check people stop reading**. Same for the two `verify-commits-landed`
false positives, one of which had been wrong for three weeks.

So the split is:

- `open_decision` — criterion written, call not yet made. Prints one
  informational line every morning, **not** in the attention count.
- `decided` with `outcome: left_diverged_deliberately` — a real decision
  was made (to leave it), so it reports as decided and stays silent, with
  the conditions for revisiting in the note.

A new `OPEN_DECISION` status was needed because the registry's vocabulary
only had *"nobody ever wrote down a criterion"* (`no_criterion`, which is a
process bug and should be loud) and *"decided"*. **"Criterion written,
decision deliberately deferred" had no representation** — so anything in
that state either had to masquerade as a bug or vanish.

```
[gate-health] 1 open decision(s) on record (not blocking): bullpen_woba_neutralization
[gate-health] 5 of 25 gates need attention:
  ...
```

## 1. `bullpen_woba_neutralization` — open decision

**The asymmetry.** `getBatterWoba` and `getPitcherWoba` both call
`resolveNeutralizationFactor` and divide the *actuals* term by the park
factor. `q.getBullpenWoba` does neither — `db/schema.js` never imports
`park-factors-woba` at all.

So inside a single `perBatterEW` call:

```js
pitW = pitWvsBatter * spPitW + bullpenWoba * relPitW
```

a **neutralized** SP term is blended with an **un-neutralized** bullpen
term.

**Direction, recorded.** A Coors reliever's actuals are inflated by his
park and stay inflated, so **Colorado relievers look worse than they are**
— and the error scales with `RELIEF_PIT_WEIGHT`. Symmetrically, SF and SEA
relievers look better than they are.

**Mechanism, on the same footing as `park_neutral_inputs_enabled`
itself.** Neutralizing two of the three wOBA inputs and leaving the third
raw is internally inconsistent regardless of what calibration can see. It
does **not** wait on the park-neutral A/B or its n=979 trigger: the
argument is structural, exactly as it is for the feature it would extend.

**Why not fixed here.** It changes a live input on **every game**, so it
wants its own decision rather than a drive-by extension while adjacent code
was open.

**Worth knowing for whoever takes it.** The reason this was never extended
looks like a boundary, not a judgement: neutralization lives in
`services/model.js` and reaches everything computed there; the bullpen pool
is computed in `db/schema.js`, which has no access to the module.
`resolveNeutralizationFactor` already carries an `isPitcher` flag, so the
pitcher case was thought about — the bullpen simply isn't in that file.

## 2. `debug_bullpen_endpoint_divergence` — decided, left alone

`GET /api/debug/bullpen` is a **third** implementation of the bullpen pool.
It has **zero** references to `getFatiguedPitchers` and ignores the `date`
param the UI sends it, so it applies **no availability filter at all** —
not the doubleheader rule, and not the pre-existing 2-consecutive / 3in4 /
pitch-count rules either. The model pool and `/debug/bullpen-report` both
apply them.

**Why it was left.** It backs a pool-size *quality warning* in the UI
(`"bullpen: no wOBA data (pool=N) — pull rosters"`), not a pricing path.

**The thing not to lose.** If this is ever fixed, **re-measure the warning
threshold first.** The current trigger is `pool < 2`, chosen against
*un-excluded* pools. Measured pools run a median of 7, with fatigue
removing a median of 3 and up to 10 — so the same threshold applied to
*excluded* pools would fire on healthy bullpens and read as a data outage.

Fixing the divergence without re-measuring the threshold converts a silent
inconsistency into a noisy false alarm, which is the worse of the two.

## Related

- `services/feature-gate-registry.js` — both entries, with the direction and the threshold caveat in their notes.
- `docs/park-neutral-resolvability-2026-08-30.md` — the mechanism argument item 1 shares.
- `docs/consumer-producer-floor-sweep-2026-08-27.md` — the earlier duplicate-implementation sweep that found the framing and FRV cases.
