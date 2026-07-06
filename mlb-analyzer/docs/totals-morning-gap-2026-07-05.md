# Totals gap re-measured against morning line — 2026-07-05

Follow-up recommended in `docs/run-conversion-audit-2026-07-05.md`
final section. The stored `market_total` is the CLOSE line; the
owner bets at morning. `proj_market_total` (captured via COALESCE on
first write) is the morning-line snapshot.

**Two ways to bucket:**
1. By CLOSE (`market_total`) — matches earlier remeasure work.
2. By MORNING (`proj_market_total`) — owner's actual bet-time bucketing.

Both are reported here. The morning-bucketed view is what the owner
sees at bet time and is the honest calibration benchmark.

Data: fresh prod fetch 2026-04-01 → 2026-07-05, n=1,144 resolved
games, 1,064 with `proj_market_total` populated.

## Bucketing by CLOSE (comparison with prior remeasure)

```
bucket   n    meanClose    meanMorning    meanModel    meanActual    gap_close    gap_morning
LO       34   6.50         7.45 (n=30)    7.14         7.24          +0.641        -0.352
MID      838  8.07         8.20 (n=768)   7.90         8.65          -0.171        -0.321
HI       272  9.98         9.79 (n=266)   9.20         10.66         -0.781        -0.595
```

Key comparisons:
- **LO gap flips sign at morning**: +0.641 close vs -0.352 morning.
  Model looks OVER the close line but UNDER the morning line.
  Close moved DOWN from morning on LO games (7.45 → 6.50).
- **HI morning gap is smaller than close gap** (-0.595 vs -0.781).
  Books moved close UP on HI games; morning line was lower and
  closer to the model.
- **MID mostly stable**: gap -0.171 close → -0.321 morning.

Directional implication: for the owner betting morning-lines,
Under signals on close-HI games look less under-projected than they
did against close (gap smaller). Over signals on close-LO games look
worse (model is under the morning line, not over the close line).

## Bucketing by MORNING (owner-perspective)

The buckets shift when re-defined by the line the owner actually
sees:

```
bucket   n    meanClose    meanMorning    meanModel    meanActual    gap_close    gap_morning
LO       8    7.13         6.50           7.29         8.00          +0.160        +0.785
MID      815  8.13         8.16           7.90         8.60          -0.229        -0.257
HI       241  9.82         10.08          9.20         10.60         -0.623        -0.878
```

Population shifts vs close-bucketing:
- Morning LO is much smaller (8 games) vs close LO (34) — most
  close-LO games were classified as MID at morning line.
- Morning HI is smaller (241 vs 272) — some close-HI games were MID
  at morning line and then moved up.
- MID gains volume (815 vs 838).

**Morning-bucket HI gap = -0.878 runs.** That's LARGER than the
close-bucketed morning gap (-0.595). The owner's true HI-bucket
under-projection is more severe than the earlier audit implied.

**Every morning bucket under-projects actuals:**
- LO: model 7.29 vs actual 8.00 → err -0.71
- MID: model 7.90 vs actual 8.60 → err -0.70
- HI: model 9.20 vs actual 10.60 → err -1.40

Under-projection isn't concentrated in any bucket — the model runs
~0.7 runs cold in LO/MID and 1.4 runs cold in HI.

## Between-bucket spreads — the correction to the run-conversion audit

The run-conversion audit reported "model captures 86% of morning
market spread." That number was on CLOSE-bucketed data (close-LO
morning line 7.36 vs close-HI morning line 9.58, spread 2.22).

Re-measured on MORNING-bucketed data:

```
Morning market spread (LO → HI):  3.577
Model estTot spread (LO → HI):    1.913
Actual spread (LO → HI):          2.602

Model spread as % of morning:  53.5%    ← was reported as 86%
Model spread as % of actual:   73.5%
```

**The 86% figure was an artifact of close-bucketing selection.** When
the buckets are defined by the owner's actual line, the model
captures only 53% of the morning market's LO→HI variation.

This is a significant correction. The run-conversion audit's
follow-up-list conclusion — "against the morning line the model
would look UNDER by 0.28 runs at LO, not OVER" — was directionally
right but understated: the actual morning-LO gap is +0.79 runs
positive (model OVER morning line), and the morning-HI gap is
-0.88 runs negative. The LO → HI spread compression at the morning
level is 1.66 runs, not 0.32 runs as implied.

## Where this leaves the totals-calibration story

Three docs describe the same underlying compression from different
angles:

- `docs/totals-remeasure-2026-07-04.md`: gap by close bucket, park-neutral OFF.
- `docs/verify-measurement-session-2026-07-05.md` Part 3: gap by close bucket, park-neutral ON.
- `docs/opener-tandem-blend-audit-2026-07-05.md`: refuted opener-path as driver.
- `docs/woba-blend-compression-2026-07-05.md`: refuted blend inputs as driver.
- `docs/run-conversion-audit-2026-07-05.md`: identified park factor as biggest lever (+0.78 runs LO→HI), suggested morning-line grading might reduce apparent gap.
- **This doc**: morning-line grading actually WIDENS the apparent gap when combined with morning-bucketing.

The consistent finding across all six: **model estTot is 0.7-1.4 runs
below actuals across every market bucket.** Under-projection is
uniform, not concentrated. Slope-shape compression: model produces
LO/MID/HI spreads that are only 53-73% of what markets and actuals
produce.

## Implications

**For the non-linear runs term experiment (deferred):**
The target is the actual under-projection: model 8-9 runs vs
actuals 8.6-10.6 across buckets. A non-linear term needs to add ~0.7
runs at LO/MID and ~1.4 at HI. That's the 2× ratio a `Δ + Δ²` term
could produce with `Δ = wOBA − baseline`. Fitting on morning-bucketed
data (n=1,064) would give ~815 MID + 241 HI training points — decent
sample.

**For the signal-emit-floor recommendation:**
Every gap and error number in this doc is worse at morning than
close on HI. Under signals from the model at HI-market games will
lose harder than the close-graded stats suggest. This reinforces the
Task 2 conclusion that Totals aren't a viable signal type at any
floor.

**For any tuning recommendation:**
Morning-line grading is now the honest benchmark. Future
calibration docs should default to bucketing by `proj_market_total`
and grading Total outcomes against `proj_market_total` where
available. Close is what shows in game_log's `market_total` and is
convenient, but it systematically flatters the model's LO→HI
capture.

## Files

- Script: `tmp/morning-gap-remeasure.js`
