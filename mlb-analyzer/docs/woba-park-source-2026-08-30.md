# The wOBA park factors now come from Savant (2026-08-30)

> **Savant publishes `index_woba` in the same blob we already download.**
> The parser read only `index_runs`, regardless of the `stat` query param,
> so the field was always there and never used — while a separate 30-team
> hardcoded table supplied the wOBA factors instead.
>
> **Six parks were on the wrong side of neutral:** TEX, CHC, MIN, PIT, BAL,
> CWS. Mean |Δfactor| 0.0201.
>
> **Game-weighted, 821 games re-scored both ways: mean |Δ total| 0.0699
> runs, 87.9% of games moved, level shift +0.0016** — i.e. it moves
> individual games without pushing the overall total in either direction.

## 1. What was wrong

`services/park-factors-woba.js` held a 30-team literal described as
*"FanGraphs 5-year rolling wOBA park factors"*. Its own next line admitted
what they actually were: *"approximations calibrated so the owner's
expected spot-checks hold — COL hitter drops ~4-5%, SEA/SD hitters up
~2%"*. A table fitted to expectations, carrying a comment naming a source
it did not come from, with no timestamp and no way for
`pipeline-freshness.js` to see it.

That is the same shape as the `PARK_FACTORS` literal replaced on
2026-08-25 — **and it survived that work because nobody grepped for a
second copy.** The park-factor rebuild gave the run factors provenance, a
monthly cron, a boot assertion and freshness coverage, and left this one
standing eight weeks stale.

## 2. Savant already published it

The `statcast-park-factors` payload carries `index_runs`, `index_woba`,
`index_wobacon`, `index_xwobacon`, `index_obp`, `index_hr` and ten more.
`fetchSavantParkFactors` hardcoded `Number(r.index_runs)`.

**A trap worth recording:** the `stat` query param only drives which column
the *page* sorts by. It does not change the blob. Passing
`stat=index_wOBA` and re-reading `index_runs` returns the run factors, and
an earlier pass at this concluded — wrongly — that Savant's wOBA index
equalled its run index for all 30 teams. The fix is to read the field, not
to change the param.

## 3. Per-team impact

```
team  literal  sourced   d(factor)   neutral(lit)  neutral(src)   d(wOBA)
TEX     1.02    0.930     -0.090        0.3267        0.3420     +0.0152
CHC     1.03    0.970     -0.060        0.3251        0.3350     +0.0099
SEA     0.96    0.920     -0.040        0.3367        0.3438     +0.0070
MIN     0.99    1.030     +0.040        0.3317        0.3251     -0.0065
CIN     1.05    1.010     -0.040        0.3220        0.3284     +0.0064
SF      0.94    0.970     +0.030        0.3402        0.3350     -0.0052
...
mean |d factor| = 0.0201    mean |d wOBA| = 0.0033
CHANGED SIGN: 6 — TEX, CHC, MIN, PIT, BAL, CWS
```

Neutralized wOBA shown for a .330 actuals input. The literal had Texas at
1.02 (hitter-friendly) against Savant's 0.93 (strongly pitcher-friendly) —
not drift, an inverted sign on a fifth of the league.

## 4. Game-weighted impact

821 games re-scored both ways, everything but the factor source held
identical.

```
games whose total MOVED : 722 of 821  (87.9%)

d(model total), sourced - literal, in RUNS
  mean      +0.0016     <- level shift, essentially nil
  median    -0.0070
  mean |d|   0.0699     median |d| 0.0537   p90 0.1541   max 0.3573

d(p home win)
  mean |d|   0.00280    max 0.02339
```

**The level shift is the number to watch and it is ~zero.** The model
already carries a negative total bias (−0.5752 in the run-factor work), so
a switch that pushed every total one way would compound it. This moves
individual games and leaves the level alone.

For scale: the **run**-factor switch moved totals by a game-weighted mean
of 0.432 runs. This is 0.0699 — roughly a sixth — which is expected, since
neutralization touches only the *actuals* term and that term carries weight
`W_ACT`.

**Totals only**, for the reason `services/park-factors.js` already records
about the run factor and which applies identically here: neutralization
scales both teams' inputs, so it moves the run estimate and barely touches
the win-probability ratio. The measured mean |Δp(home)| of 0.0028 confirms
it — an ML A/B here would report "not significant" no matter how wrong the
factors were.

## 5. A defect in the first version of this measurement

The A/B originally swapped `pfw.getWobaParkFactor` — the module export.
**`services/model.js:54` destructures that function at require time**, so
the model kept calling the original. The A/B was comparing two identical
runs.

Had it completed it would have reported **0 games moved**, which reads
exactly like *"the change is safe to ship."* Same failure as the
model-trace blindness on 2026-08-29: an instrument wired *around* the thing
it claims to measure, returning a confident null.

Fixed by overriding the cache through a documented test seam, verified
against a destructured caller before being trusted:

```
sourced, via destructured ref : 0.93
after seam override           : 1.02   <- reaches a destructured caller
restored                      : 0.93
```

**The 87.9%-moved figure is itself the evidence the seam works** — the
broken version could only ever have produced 0%.

## 6. What shipped

- `index_woba` read from the existing blob. **Null, never a run-factor
  fallback** — the two scales differ by ~2x, so a silent substitution would
  over-neutralize.
- `woba_factor` and `woba_manual_reason` as **columns on the existing
  `park_factors` row**, not a second table: same park, same pull, same
  `pulled_at`. It inherits the monthly cron, boot assertion and freshness
  entry — a separate table would have needed its own of each and been free
  to drift, which is how the literal got here.
- **ATH manual override derived**, not invented:
  `1 + (1.19 − 1) × 0.497 = 1.094`, so the two manual values cannot drift
  apart. Its reason is persisted on the row.
- **Assertion extended** to the wOBA column. It fired during the build —
  29 teams unresolved — and refused the write. A team resolving its run
  factor while losing its wOBA factor would produce a *mixed* table, harder
  to spot than an empty one.
- `k = 0.497` documented as a fallback, exported as `WOBA_FROM_RUN_K`.
- Header corrected: the claimed **0.60–0.80 "park-dependent"** ratio is
  actually **0.497, mean |err| 0.0005** — near-deterministic. The stale
  FanGraphs source paragraph is removed rather than left contradicting.
- Literal marked **FROZEN FALLBACK**, kept so a cold table degrades to
  prior behaviour rather than to 1.00 (which would silently disable
  neutralization).

## 7. Not done here

**Ticket (2), the park-neutral A/B re-run against the actuals-only fix, is
deliberately not started.** Per the registry the feature rests on a
validation that (a) was ROI-based and therefore selection-contaminated, and
(b) predates the 2026-07-02 actuals-only correction. Running it before this
source change landed would have measured a configuration about to change.
It should now be run once, against the sourced factors.

**The bullpen neutralization asymmetry is also untouched** — the bullpen
pool takes no park factor at all, so a Coors reliever's inflated actuals
stay inflated. That is its own ticket and it depends on (2).

## Related

- `services/park-factors.js` — the parser, `WOBA_FROM_RUN_K`, the ATH override.
- `services/park-factors-woba.js` — the consumer and the frozen literal.
- `scripts/woba-park-source-ab.js` — this measurement, re-runnable.
- `docs/park-factors-fresh-pull-report-2026-08-25.md` — the run-factor rebuild that missed this copy.
