# Lineup accuracy and model impact — measured today, not in six weeks (2026-08-23)

> ---
> **CORRECTION 2026-08-24 — these numbers are the NEXT-DAY horizon only.**
> `proj_lineup_captured_at` has no horizon spread: median lead **32.2h**,
> p5 25.3h, p95 35.7h, captures at 14:00 UTC from
> `daily-lineups.php?date=tomorrow`. **Essentially zero same-day captures**
> (2 of 1357).
>
> So exact-slot 52.5%, roster 85.5% and the 0.130-run median impact are the
> **worst-case horizon**, not an average. Same-day has never been captured,
> which means forward capture IS still warranted for that horizon —
> correcting this page's conclusion that it was no longer a priority.
>
> Also corrected: the 18.1% coverage gap is a startup artifact. Coverage on
> completed games since capture began (2026-04-27) is **100.00%**.
> See `docs/lineup-horizon-coverage-and-a-stale-pipeline-2026-08-24.md`.
> ---


> **The historical comparison was already possible. Forward capture was
> not needed and is no longer the priority.**
>
> `game_log` persists `proj_away_lineup_json` / `proj_home_lineup_json`
> with a capture timestamp, alongside the confirmed lineups **and** the
> model scored at both states. **2,710 lineup-sides and 1,539 completed
> games**, spanning 2026-04-27 to 2026-08-22 — roughly **8×** what six
> weeks of forward capture would have produced.

## The headline: lineup error costs about a tenth of a run

```
|proj_model_total - model_total|, in RUNS   (n=1539 completed games)
  median 0.130   p75 0.270   p90 0.460   p99 1.080   max 2.400
  mean   0.199   95% CI [0.181, 0.217]

  0-0.05 runs     400  (26.0%)
  0.05-0.1        251  (16.3%)
  0.1-0.25        458  (29.8%)
  0.25-0.5        299  (19.4%)
  0.5-1           110  ( 7.1%)
  1+               21  ( 1.4%)
```

**Half of all games move less than 0.13 runs when the real lineup
arrives.** Only 8.5% move more than half a run. On the moneyline side the
median shift is **6 American odds points**, p90 **35**.

Against the emit floor and a ~2.45pp per-side vig, a 0.13-run median shift
is small. **Projected lineups are an adequate input**, and the case for
chasing a better lineup source is correspondingly weaker than it looked.

## And there is a real directional bias

```
SIGNED mean (confirmed - projected) = -0.069 runs   95% CI [-0.091, -0.044]
                                                     EXCLUDES ZERO
```

**The confirmed lineup scores systematically LOWER than the projected
one.** Projections over-estimate offense by about 0.07 runs per game, and
on 1,539 games that is statistically clear rather than marginal.

The mechanism is unsurprising once stated: a projected lineup assumes the
regulars play. Late scratches, rest days and defensive substitutions
replace them with weaker hitters, so reality is a little worse than the
projection almost every time.

**This points the same way as the Under lean** — the model over-projects
totals, and unders have carried what edge there is. That is a suggestive
connection and I am explicitly *not* claiming it explains the Under lean:
0.07 runs is small against a typical 8.5 total, the Under lean's own
magnitude collapsed on re-measurement
(`docs/totals-edge-four-steps-2026-08-23.md`), and this is one plausible
contributor among several. It is recorded as a lead, not a finding.

## Accuracy — and one metric I had wrong

```
exact-slot                52.5%   95% CI [50.6, 54.8]
roster (order ignored)    85.5%   95% CI [84.8, 86.3]
handedness (positional)   69.9%   95% CI [68.6, 71.5]
handedness (COMPOSITION)  92.1%   95% CI [91.7, 92.5]   <- what the model consumes

platoon composition exactly right : 1216/2710  (44.9%)
lineups exactly right, all 9 slots:  263/2710  ( 9.7%)
right nine, any order             :  595/2710  (22.0%)
```

**The exact-slot / roster gap is the whole point, and it is 33 points
wide.** Only 9.7% of projected lineups are exactly right slot-for-slot,
but 22% have the right nine players and 85.5% of individual slots hold a
player who is somewhere in the confirmed lineup. Your instinct that a 6/7
swap barely moves a total is exactly what the model-impact number confirms.

Wrong players per lineup:

```
0 wrong  595 (22.0%)    3 wrong  252 ( 9.3%)
1 wrong 1037 (38.3%)    4 wrong   44 ( 1.6%)
2 wrong  781 (28.8%)    5 wrong    1 ( 0.0%)
```

### The handedness metric I got wrong first

My first pass measured handedness **positionally** — same hand in the same
batting slot — and got 69.9%. That is the wrong quantity: a pure
batting-order shuffle breaks positional matching while leaving the platoon
mix identical, and **the model consumes the mix, not the ordering**.

Measured as composition — the multiset of L/R/S across the nine, invariant
to reordering — it is **92.1%**.

The two numbers differ by 22 points and would support opposite
conclusions. The positional figure would have read as "handedness is
unreliable"; the composition figure says the platoon input the model
actually reads is the *most* reliable of the three.

## Coverage

```
projected lineups present : 1375/1678  (81.9%)
confirmed lineups present : 1658/1678  (98.8%)
capture span              : 2026-04-27 .. 2026-08-22
```

The 18% of games without a projected lineup are the real coverage gap —
larger than any accuracy deficit and more actionable.

## Against the expectation recorded before measuring

Written before the numbers existed:

| predicted | actual | |
|---|---|---|
| model impact median < 0.30 runs | **0.130** | correct |
| p90 < 1.0 runs | **0.460** | correct |
| exact-slot 55–75% | **52.5%** | **slightly low** |
| roster 80–90% | **85.5%** | correct |
| handedness > 90% | **92.1%** composition / 69.9% positional | correct on the metric that matters, wrong on the one I first computed |

Recording it because it makes the exact-slot miss visible as a miss rather
than something to smooth over.

## What this changes

**Forward capture is no longer the time-critical item.** The argument for
building it immediately was that every unrun day is unrecoverable — true,
but only for data we do not already have, and we have four months of it.

The remaining case for forward capture is narrower:

- it is the only way to compare *sources*, which is currently blocked on
  access (`docs/lineup-source-recon-2026-08-23.md`);
- the 18.1% coverage gap might be improved by a second source, and that is
  a bigger lever than accuracy;
- `proj_lineup_captured_at` gives one horizon; a true next-day-vs-same-day
  split would need explicit horizon capture.

None of those is urgent at a 0.13-run median impact.

## Not done

- **Horizon split.** `proj_lineup_captured_at` exists but I have not
  checked whether captures cluster at one time of day or spread across
  horizons. If they spread, a same-day vs next-day accuracy split may be
  recoverable historically too — worth a look before building anything.
- **Per-source split.** `lineup_source` holds `manual` and `auto`; whether
  `auto` is exclusively RotoWire has not been verified.
- **Nothing acted on.** No parameter changed, no ingest built.

## Related

- `docs/lineup-source-recon-2026-08-23.md` — why the source comparison is blocked.
- `scripts/lineup-accuracy-historical.js` — this measurement.
- `docs/totals-edge-four-steps-2026-08-23.md` — the Under lean this bias points toward but does not explain.
