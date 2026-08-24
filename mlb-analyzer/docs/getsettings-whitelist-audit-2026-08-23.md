# getSettings whitelist audit, hand-conditional wiring, and a reachable gate standard (2026-08-23)

> ---
> **ANNOTATION 2026-08-23 — re-run on the decontaminated corpus.**
> Every figure on this page was computed on a corpus that retained 128
> games priced after real first pitch
> (`docs/post-start-pricing-tagged-2026-08-22.md`). Those are now excluded
> and everything here was re-run.
>
> **No verdict changed and no tier moved.** Absolute numbers shift because
> the corpus drops 790 -> 662 (16.2%); the shifts were checked against a
> 20-seed n-matched control drawn from the *contaminated* corpus, and
> **every one lands inside the control's p5..p95** — i.e. they are power
> effects, not contamination effects.
>
> Superseding numbers: `docs/decontaminated-rerun-2026-08-23.md`.
> Figures below are left as originally recorded rather than overwritten.
> ---


> Three items. **Nothing flipped.**

## 1. The whitelist audit — 3 defects, not 7

`services/jobs.js:getSettings()` returns a **hand-written object literal**.
A key that isn't explicitly mapped there is invisible to the model no
matter what `app_settings` or the UI say.

Cross-referencing schema (56 keys) × UI-wired (45) × stored (82) ×
actually-read-by-`getSettings` (72):

| | count |
|---|---|
| orphaned (present somewhere, never read) | **20** |
| — deliberate UI-only (`ui_highlight_*`) | 4 |
| — internal bookkeeping (cron ts, backfill flags, bookmarklet state) | 13 |
| **— GENUINE DEFECTS (tunable with no effect)** | **3** |

**The three are the ones already found:**
`use_hand_conditional_sp_weight`, `sp_weight_r`, `sp_weight_l`.

**Nothing else slipped through.** Every other tunable model setting is
wired. That is the reassuring answer to "what else have I tuned with no
effect" — nothing.

### Why the four `ui_highlight_*` are not defects

They are deliberately excluded, with the reason written at
`services/jobs.js:211`:

> *"The UI_HIGHLIGHT_* settings are read separately by the UI via
> /api/settings — the model does not consume them."*

And they are genuinely consumed — `services/frv-backtest.js:158-167`,
`parameter-sweep.js:loadUiHighlightThresholds`, and the UI itself read
them straight from `app_settings`. Correct by design.

### This is a recurring class, not a one-off

`getSettings()` already carries this note at line 294, about a *previous*
instance of the identical bug:

> *"Catcher framing run-environment adjustment. Previously NOT surfaced
> here, which left `settings.CATCHER_FRAMING_ENABLED` undefined — the
> feature could never actually activate."*

So this has now happened **twice**: framing, then hand-conditional. A
hand-maintained whitelist alongside a schema is a structure that
reproduces this defect. See §4.

### Side finding: two malformed rows

`app_settings` contains rows literally keyed **`key`** (value
`app_password`) and **`value`** — an insert that transposed the column
names instead of writing `app_password`. Consequences:

- The intended `app_password` setting was never stored under its own key.
- Nothing reads `app_password` anywhere in the codebase, so **this is
  inert — no auth bypass**.
- A credential-shaped plaintext value is sitting in `app_settings` doing
  nothing.

Recommend deleting both rows. Not done here — it is a prod data change,
and it is the owner's credential.

## 2. Hand-conditional wiring — done and verified

Three keys added to `getSettings()`, matching the existing
`CATCHER_FRAMING_ENABLED` boolean-coercion pattern.

**Verification that mattered: is this byte-identical on the live path?**

The comment claims wiring `SP_WEIGHT_L` cannot move prices while the
flag is off, because `model.js` uses the scalar `SP_WEIGHT` for the
chosen path and the hand-conditional values only for the shadow
comparison. Rather than assert it:

```
scripts/calibration-ab.js SP_WEIGHT_L 0.649 0.7
  → games where the flag changes p(home): 0 / 790 (0.0%)
```

**Confirmed byte-identical.** The stored 0.7 now takes effect where it
always should have — the shadow path — and nowhere else.

**And the flag is no longer dead:**

```
scripts/calibration-ab.js USE_HAND_CONDITIONAL_SP_WEIGHT false true
  → games where the flag changes p(home): 789 / 790 (99.9%)
```

Before wiring this was 0/790 — the flag could not be turned on at all.

### First evidence, offered but not acted on

| arm | log loss | Brier | ECE | AUC | edge slope |
|---|---|---|---|---|---|
| OFF | **0.68975** | **0.24829** | **0.0114** | **0.5494** | **−0.313** |
| ON | 0.68984 | 0.24834 | 0.0155 | 0.5484 | −0.319 |

Δ log loss **+0.00009**, CI [−0.00032, +0.00054] — not significant, but
**directionally worse on all five metrics**. It is the first flag
measured here that points the wrong way; park-neutral, FRV and BsR were
all directionally better.

**One caveat before anyone reads that as a verdict:** the ON arm used
`sp_weight_l = 0.7` (the stored value), not the empirical benchmark
**0.649** from `pitcher_game_log` BF data. The benchmark version is
untested. That should be run before hand-conditional is judged —
`scripts/calibration-ab.js SP_WEIGHT_L 0.7 0.649` with the flag on.

No flip criterion is written yet, per instruction: wiring is verified,
evidence is on the table, the criterion follows the standard in §3.

### Follow-up 2026-08-23: prod set to the benchmark, and a correction

**Correction to how this was characterised.** Wiring the key did *not*
put 0.7 into live pricing. With `use_hand_conditional_sp_weight` false,
`model.js:1210` sets `awayChosenOverride = null` and the live path uses
the scalar `SP_WEIGHT = 0.8`; only `awayAltOverride` — the **shadow**
comparison — reads the hand-conditional values. Verified: 0 of 790 games
change. So the wiring fix was already price-preserving.

What it *did* change is the **shadow record**: from the wiring fix
onward, shadow deltas were computed against 0.7 rather than the 0.649
the model had always used. Minor, but a real discontinuity in the series
the shadow watch is accumulating.

Separately, the "worse on all five metrics" result was the
`USE_HAND_CONDITIONAL_SP_WEIGHT false→true` A/B — **it measured the
flag, not 0.7 vs 0.649.** With the flag off, 0.7 vs 0.649 is a literal
zero-difference.

**Action taken.** Prod `sp_weight_l` set **0.7 → 0.649** (POST
`/api/settings`, verified after: `sp_weight_l = "0.649"`).
`sp_weight_r` was already 0.865 and needed no change. This makes the
wiring fix behaviour-preserving on **both** paths and keeps the shadow
series on one constant.

0.649 is also the empirical benchmark from `pitcher_game_log` BF data,
so this is a return to the documented value rather than a new choice.
**Moving to 0.7 is now a separate proposed change** to be evaluated on
its own merits under the §3 standard — not something that arrives as a
side effect of a wiring fix.

**Consequence for the pending evaluation:** the recorded
hand-conditional A/B used 0.7 in its ON arm and therefore no longer
describes prod. It needs re-running against 0.649 before hand-conditional
is judged.

## 3. A gate standard that can actually be met

**The problem, stated plainly.** Effects here run ~0.0005–0.001 log loss
against an SE of ~0.0006–0.001. A CI excluding zero needs roughly **4×
the data** — multiple seasons. A bar that cannot be met inside the
lifetime of a decision is a bar that guarantees permanent deferral,
which is how features end up dark by default rather than by choice.

**The instrument: a sign test over independent windows.** Split the
corpus into K non-overlapping chronological windows and ask only *which
arm wins each window*. It **discards magnitude, which is exactly where
the noise lives**, and accumulates evidence from consistency instead.

Under a null, P(≥k of n windows favourable):

| windows | favourable | p | reachable in |
|---|---|---|---|
| 4 | 4 | 0.0625 | ~0.8 season |
| **5** | **5** | **0.031** | **~1 season** |
| 8 | 7 | 0.035 | ~1.6 seasons |
| 10 | 9 | 0.011 | ~2 seasons |
| 12 | 10 | 0.019 | ~2.4 seasons |

**A unanimous 5-window season clears p ≤ 0.05.** That is a real bar,
and it is reachable.

### Proposed tiered standard

**Tier 1 — Established.** Pooled CI on Δ log loss excludes zero.
Keep as the gold standard for when an effect is large enough. Ship.

**Tier 2 — Consistent.** All of:
- sign test over accumulated windows at **p ≤ 0.05** (5/5 in one season,
  or 9/10 across two, etc. — windows accumulate across seasons);
- pooled point estimate favourable on **≥4 of 5** metrics;
- **bounded harm**: pooled CI upper bound < **+0.001** log loss.

Ship with review.

**Tier 3 — Mechanism + no-harm.** For changes argued from construction
rather than measured (the roof-canopy temp fix, the shrinkage cliff):
- a mechanism argument **pre-registered in the gate registry's
  `criterion` field before the evaluation runs**;
- pooled point estimate not worse;
- bounded harm as above;
- blast radius measured and reported.

Ship if the mechanism was prospective.

**Tier 4 — Reject or defer.** Directionally worse, or signs inconsistent.

### Two safeguards that make this honest

**Bounded harm, not merely "not significant."** "Not significant" alone
would license shipping something whose CI upper bound is +0.01 — a real
possible harm dressed as a null. Tier 2 and 3 require the *harmful* side
of the interval to be small, which is the claim that actually matters
when the point estimate can't be resolved.

**Pre-registration.** A mechanism argument written *after* seeing the
result is post-hoc rationalisation. The registry already has a
`criterion` field; requiring it to be filled before the run is what
separates Tier 3 from storytelling, and it is free to enforce.

### What the standard yields today

Window sign test, K=5, one season:

| feature | windows favourable | sign-test p | pooled Δ | tier |
|---|---|---|---|---|
| **FRV** | **4 / 5** | 0.188 | −0.00087 | no — fails the window test |
| park_neutral | 3 / 5 | 0.500 | −0.00055 | not yet |
| hand_conditional | 2 / 5 | 0.813 | +0.00009 | **Tier 4 — directionally worse** |

Per-window detail (negative = ON better):

```
FRV               W1 +0.00239  W2 -0.00124  W3 -0.00260  W4 -0.00187  W5 -0.00078
park_neutral      W1 +0.00011  W2 -0.00078  W3 -0.00059  W4 +0.00009  W5 -0.00145
hand_conditional  W1 -0.00044  W2 +0.00027  W3 -0.00043  W4 +0.00026  W5 +0.00070
```

**Nothing clears the bar yet — and that is the point.** The standard is
meetable but currently unmet, which is what a working gate looks like.
FRV is the unresolved candidate: it fails the window test, and it carries the largest
edge-slope improvement measured anywhere (−0.313 → −0.218). Under the
proposed standard it should be **re-evaluated after another ~500–600
games** rather than on a calendar date.

> *Softened 2026-08-24: this read "it needs roughly 3–4 more favourable
> windows". That quantifies a distance to the bar using a statistic that
> does not support it — same-n resamples give 2/5, 3/5 and 4/5 on this
> feature at n~350. The accumulate-more-games recommendation stands; the
> arithmetic of how many windows remain does not.*

**Recommended registry change:** replace `window_end` calendar dates
with **window counts**. A gate should close when the evidence is in, not
when the season ends. `defense_frv_enabled` currently reads
`window_end: 2026-09-30`; under this standard it becomes "re-evaluate at
n=10 accumulated windows."

*(Caveat carried in the tool output: windows inside one season are not
fully independent — same rosters, same model version, correlated market
regime — so treat 0.5^K as a floor on the p-value, not an exact one.
Windows spanning seasons are closer to genuinely independent.)*

## 4. The structural fix this all points at

Both the framing bug and the hand-conditional bug come from the same
place: **a hand-maintained whitelist in `getSettings()` that must be kept
in sync with `settings-schema.js` by memory.** It has now failed twice.

An assertion would close it permanently: every `settings-schema.js` key
that is not on an explicit UI-only allowlist must appear in
`getSettings()`'s output, checked at boot or in the gate health check.
That is the same shape as the known limit already recorded for the gate
registry (hand-seeded, so a new flag without an entry is invisible).

Not built here — flagged as the durable fix.

## Related

- `docs/feature-gate-inventory-2026-08-23.md` — the 22-gate inventory.
- `docs/gate-evaluations-2026-08-23.md` — park-neutral / FRV / BsR evaluations.
- `docs/component-signal-diagnostic-2026-08-23.md` — why every effect is small.
- `services/feature-gate-registry.js` — where criteria and windows live.
