# Oscillation guard: the post-deploy result (2026-08-29)

> **Bias criterion: PASSED.** Both writers symmetric; head-to-head sign-split
> z moved from **−42.39 to −0.58**. That was the criterion that mattered —
> a directional bias affects every price it touches, and it is gone.
>
> **Reversal rate: DIRECTIONALLY CONFIRMED, POINT ESTIMATE UNRESOLVED.**
> 11.2% observed against a ~5% projection, on n=98. The interval is roughly
> **6–19%**, so 5% sits just outside it. **This is not a hit**, and it is
> not recorded as one.
>
> **The two follow-ups both resolved, and the second one changes how the
> residual should be read.**

## 1. Did the projection method underestimate? Yes, by ~2.2×

**The check as posed cannot discriminate.** Replaying the guard over the
post-fix window drops **0 writes** — the guard already prevents exactly the
writes the projection deletes — so the replay is an identity and returns
11.3% trivially. It reproduces the observed rate while validating nothing.

Run against the window it was actually built from, the method's error is
visible:

```
--replay-guard on PRE-FIX data
  writes dropped (venue -> null)  : 2152
  market_line changes : 5634  ->  3482
  reversal rate       : 50.1%  ->   5.1%
```

**The mechanism: it models the guard as DELETING writes. The guard
preserves the prior venue and still writes the row.** Those two are not
the same operation, and the difference is super-linear:

- Deleting a write removes **both halves** of every reversal pair it
  participates in.
- In a sustained A→B→A→B ping-pong, removing one writer's writes collapses
  the **entire chain**, not just the pairs that writer appears in.
- Hence dropping 38% of writes cut reversals by 94% — a ratio that is
  impossible if each removal cost one reversal.

### The corrected method, and it validates

Classify each reversal by its `price_venue` transition. The guard covers
exactly one class — `venue -> null` — plus the `null -> venue`
re-acquisition that pairs with it. Both leave the write stream. Everything
else survives.

```
predicted = residual reversals / (writes - downgrade writes - acquire writes)

on PRE-FIX data:  152 / (5634 - 2152 - 2262) = 152 / 1220 = 12.5%
observed POST-FIX:                                          11.3%
```

**12.5% predicted against 11.3% observed** — inside the interval, and a
usable technique rather than a remembered number. Available as
`--classify`, which prints the projection with its inputs so it is
re-derivable.

**The rule this generalises to:** a counterfactual must model what the fix
*does*, not what it *prevents*. Suppression and deletion diverge whenever
the removed events are chained.

## 2. What are the 11? A floor, not a miss

```
POST-FIX                                PRE-FIX
  venue -> null   (guard covers) :  0     1299
  null -> venue   (its partner)  :  0     1374
  venue switch    (NOT covered)  :  7       90
  venue unchanged (NOT covered)  :  4       62

  guard-coverable share: 0.0%            94.6%
```

**Zero of the 11 are in a class the guard can act on.** Pre-fix, 94.6% of
reversals were guard-coverable; post-fix that is 0%. The guard eliminated
its entire target class, and what remains is:

- **7 venue switches** — the price legitimately moved from Kalshi to Poly
  or back, because the better venue changed. That is the venue-aware
  feature working, not oscillation.
- **4 venue unchanged** — genuine same-venue movement. **Two of these are
  totals lines flipping 7.5 ↔ 8.5**, a half-run market move, which is not
  noise at all.

So the residual is a floor, and the honest floor is probably *below* 11.2%
once real market movement is excluded. Chasing the reversal rate lower from
here would mean suppressing correct behaviour.

**Secondary effect worth recording:** write volume fell from **117/day to
25/day**. The guard did not only stop reversals, it stopped the churn —
8,848 pricing writes for ~2,000 signals was itself the symptom.

## 3. Scope and honesty

- **The headline figures (98 rows, 11.2%, z −0.58) are Mike's production
  run.** The composition breakdown in §2 and the method analysis in §1 were
  computed on the **local analysis copy** (97 rows, 11.3%) — close enough
  to develop against, and labelled rather than blurred. Re-run
  `--prod --classify` to confirm the composition on production; the
  conclusion depends on the *shape* (0% coverable), which a one-row
  difference cannot flip, but it has not been verified there.
- **The 5% projection was never a commitment to a point estimate.** It was
  labelled a projection over historical rows in the script that produced
  it. What is being recorded here is that the *method* was biased low, and
  by how much, and why.
- **n=98 over 3.8 days.** The interval will narrow on its own; nothing here
  needs re-running to get a better number, only more days.

## Related

- `scripts/measure-price-oscillation.js` — `--prod`, `--replay-guard`, `--classify`.
- `docs/signal-price-oscillation-open-question-2026-08-25.md` — the original.
- `CLAUDE.md` — "A counterfactual models what the fix does, not what it prevents".
