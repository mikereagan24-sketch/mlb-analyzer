# Park-neutralization extended to the bullpen (2026-08-31)

> **Level shift −0.0007 runs.** That is the ship/no-shift number and it is
> essentially nil, which is the safe shape: individual games move, the
> overall total does not.
>
> **821 of 821 games moved** — which is also the evidence the A/B is wired
> to the model rather than measuring itself.
>
> **It will never be resolvable by calibration.** Paired Δ log loss
> +0.000019 against a ±0.000217 interval; resolving that would take
> ~105,000 games. This is a **mechanism-only** change, permanently, and it
> is being shipped on that basis.

## 1. What changed

`q.getBullpenWoba` now neutralizes the **actuals** term of each reliever's
blend, exactly as `getBatterWoba` and `getPitcherWoba` do — same transform,
same `park_factors.woba_factor` table, same PA/TBF stint weighting for
traded relievers.

Before, within a single `perBatterEW` call:

```js
pitW = pitWvsBatter * spPitW + bullpenWoba * relPitW
```

blended a **neutralized** SP term with an **un-neutralized** bullpen term.

## 2. The layering, which is why this was never done

`db/schema.js` **cannot** require `services/park-factors-woba`: that module
requires `db/schema` to read the `park_factors` table, so the dependency
would be circular.

So the factor arrives as a **resolver function** passed in by the caller.
That keeps the direction one-way *and* reuses `model.js`'s
`resolveNeutralizationFactor` verbatim — including stint weighting —
instead of a fourth copy of the logic in the schema layer.

This confirms what the gate registry recorded before any code existed: the
reason the bullpen was never neutralized looks like **where the code
stopped**, not a judgement anyone made. `resolveNeutralizationFactor`
already carried an `isPitcher` flag.

## 3. Per-team impact

```
team   parkF     raw    neutral    d(wOBA)
COL   1.12      0.3259    0.3181    -0.0078
SEA   0.92      0.3055    0.3120    +0.0065
ATH   1.094     0.3230    0.3186    -0.0044
TEX   0.93      0.3048    0.3081    +0.0033
SD    0.97      0.2790    0.2818    +0.0028
...
mean |d| 0.0014     max |d| 0.0078
```

Direction is right: a hitter park's relievers **improve** once the
inflation is divided out; a pitcher park's **worsen**. Coors moves 0.0078,
which matches the magnitude and sign recorded in the registry before the
code existed.

### A false anomaly, and the check that produced it

The first version of the measurement flagged **LAA and WAS as moving the
wrong way**. They were not. `resolveNeutralizationFactor` applies PA/TBF
stint weighting, so a reliever traded in from a hitter park carries **his**
factor, not his current club's — LAA (home 0.99) has two such arms above
1.0; WAS (home 1.03) has three below. The pool moves with its members'
weighted factors, which is the feature working.

**The check was wrong, not the code.** It compared against the home park
when the pool-effective factor is what matters, and it now does. A check
that flags correct behaviour as a defect is worse than no check — it
invites someone to "fix" the stint weighting away.

## 4. Game-weighted impact

```
games scored both ways : 821
games whose total MOVED: 821  (100.0%)

d(model total), neutralized - raw, in RUNS:
  LEVEL (signed mean) -0.0007    median -0.0019
  mean |d| 0.0095    p90 0.0246   max 0.0572

d(p home win): mean |d| 0.00108   max 0.00684
```

**The level shift is −0.0007 runs.** The model already carries a −0.5752
total bias, so a change pushing every total one way would compound it. This
does not.

Smallest of the three park changes, and expectedly so:

```
run-factor switch        0.432  runs (mean |d total|)
wOBA source switch       0.0699
bullpen neutralization   0.0095
```

The bullpen term is scaled by `RELIEF_PIT_WEIGHT` (~0.29), then only its
actuals portion (`BULLPEN_W_ACT` 0.75) is touched, against factors already
compressed to ~0.50 of run scale. The effect compounds down.

## 5. Calibration cannot see it, and never will

```
paired d log loss over 804 decided games
  mean +0.000019    95% CI +/-0.000217
  interval spans zero
```

The observed effect is **1/11th of the interval**. Resolving it would need
**~105,000 games** — against the 979 that makes `park_neutral_inputs_enabled`
itself resolvable. For scale, a full season across all thirty clubs is
about 2,400.

So unlike the parent feature, this is not "underpowered today, resolvable
at N". It is **permanently unresolvable by calibration**, and the honest
resting state says so rather than implying a pending verdict.

**Which is exactly why it ships on the mechanism.** Neutralizing two of the
three wOBA inputs and leaving the third raw is internally inconsistent
regardless of measurement: park is otherwise divided out of the SP and
batter terms and left in the bullpen term, inside the same blend.

## 6. Safety

- **Inert without a resolver.** Omitting the argument, passing `null`, or
  passing a resolver that returns `null` (the flag-off production path) all
  leave the term byte-identical. Verified across 8 teams.
- **Actuals only.** With the actuals gate unreachable the change is a
  no-op, so projections stay raw — the double-count the 2026-07-02 audit
  removed from the batter path is not reintroduced.
- **Non-fatal.** A throwing resolver degrades to the raw actuals rather
  than failing the pool. The test caught that this guard was **missing**
  in the first version and it was added; removing it again fails the suite.

## 7. Related

- `services/feature-gate-registry.js` — `bullpen_woba_neutralization`, the open decision this closes.
- `docs/register-bullpen-open-items-2026-08-30.md` — where the asymmetry and its direction were recorded.
- `docs/park-neutral-resolvability-2026-08-30.md` — the parent feature's paired-floor work.
- `scripts/bullpen-neutral-ab.js` — this measurement, re-runnable.
